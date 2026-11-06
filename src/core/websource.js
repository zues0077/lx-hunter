'use strict'
/**
 * 非 GitHub「网页音源站」采集（v1.10.0）
 *
 * 需求背景：很多音源作者不建 GitHub 仓库，只在自建网站上挂 .js 直链
 * （实测样例：https://zrcdy.dpdns.org/lx/vers.php「插件下载中心 - Xinghai JS」，
 * 页面里直接列着 xinghai-music-sourcev2.3.x.js 全版本直链）。
 * 原 crawler.js 只认 GitHub API（owner/repo），这类站点永远采不到。
 *
 * 通用解析方案：抓页面 HTML → 提取所有 .js 链接（绝对/相对均可）→
 * 逐个下载（≤2MB）→ scoreEntry ≥4 才入库（宁缺毋滥）。
 * 站点本身作为仓库清单里的一条 {repo:"https://…", origin:'custom'}，
 * 与 GitHub 仓库并列管理（可禁用/删除）。
 *
 * 网络走 net.fetchAuto（第三方站点：配置了爬取代理就走代理、内网直连），
 * 不消耗 GitHub API 配额。
 */
const { fetchAuto } = require('./net')
const { scoreEntry, sha256Str } = require('./checker')
const { filterLatestOnly } = require('./crawler')

const MAX_CANDIDATES_PER_SITE = 120   // 单站点最多解析的 .js 链接数（防超大页面拖死）
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024
const MAX_CONCURRENCY = 3             // 单站点下载并发（第三方站，压低些）

/** 仓库条目是否为「网页音源站」（URL 形态，与 owner/repo 相区分） */
function isWebRepo(repo) {
  return /^https?:\/\//i.test(String(repo || '').trim())
}

/**
 * 从 HTML 里提取 .js 直链：
 *  - href / src 属性里的 *.js（不带 query 的按原样；带 query 的也放行）
 *  - 相对路径按页面地址解析为绝对 URL
 *  - 返回 [{url, name}]，按出现顺序去重
 */
function extractJsLinks(html, baseUrl) {
  const out = []
  const seen = new Set()
  const re = /(?:href|src)\s*=\s*["']([^"']+\.js)(\?[^"']*)?["']/gi
  let m
  while ((m = re.exec(String(html || ''))) !== null) {
    const raw = (m[1] + (m[2] || '')).trim()
    let abs = null
    try { abs = new URL(raw, baseUrl).toString() } catch (e) { continue }
    if (!/^https?:/i.test(abs)) continue
    const key = abs.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    let name = ''
    try { name = decodeURIComponent(new URL(abs).pathname.split('/').pop() || '') } catch (e) { name = abs.split('/').pop() || '' }
    out.push({ url: abs, name: name.replace(/\.js$/i, '') })
    if (out.length >= MAX_CANDIDATES_PER_SITE) break
  }
  return out
}

/**
 * 采集一个网页音源站。返回 {found, collected, skipped, added, updated} 之外的条目数组
 * 由调用方 merge（与 GitHub 爬取的 'repo' 事件同构）。
 * @param {string} siteUrl 站点地址（仓库清单里的一条 repo 字段）
 * @param {object} opts {timeoutMs, latestOnly}
 * @param {function} onEvent (type, payload) —— 与 crawler.crawl 相同的事件约定
 * @param {function} shouldStop
 */
async function crawlWebSite(siteUrl, opts, onEvent, shouldStop) {
  const o = opts || {}
  const timeoutMs = Number(o.timeoutMs) || 15000
  const log = (level, msg) => onEvent && onEvent('log', { level, module: '爬取', msg })
  const stats = { links: 0, collected: 0, droppedOld: 0, failed: 0 }
  let html = ''
  try {
    const res = await fetchAuto(siteUrl, { headers: { 'Accept': 'text/html,*/*' } }, timeoutMs)
    if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '不可达'))
    html = await res.text()
  } catch (e) {
    log('warn', `${siteUrl}：页面抓取失败：${String((e && e.message) || e).slice(0, 100)}`)
    return stats
  }
  let links = []
  try { links = extractJsLinks(html, siteUrl) } catch (e) { links = [] }
  stats.links = links.length
  if (!links.length) { log('info', `${siteUrl}：页面里没有发现 .js 直链`); return stats }
  log('info', `${siteUrl}：发现 ${links.length} 个 .js 直链，开始下载甄别…`)

  // 「只收最新版」（v1.10.0 设定）：下载前先按文件名分组，跳过同组旧版本，省下载也省库位
  if (o.latestOnly) {
    const f = filterLatestOnly(links.map((l, i) => ({ _i: i, name: l.name, url: l.url })))
    stats.droppedOld = f.dropped.length
    if (f.dropped.length) {
      log('info', `${siteUrl}：按「只收最新版」跳过 ${f.dropped.length} 个旧版本直链`)
      const keepSet = new Set(f.kept.map(x => x.url))
      links = links.filter(l => keepSet.has(l.url))
    }
  }

  const items = []
  let idx = 0
  const worker = async () => {
    while (true) {
      if (shouldStop && shouldStop()) return
      const i = idx++
      if (i >= links.length) return
      const l = links[i]
      try {
        const res = await fetchAuto(l.url, {}, timeoutMs)
        if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '不可达'))
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length > MAX_SCRIPT_BYTES) throw new Error('文件过大')
        const text = buf.toString('utf8')
        const score = scoreEntry(l.url, text)
        if (score < 4) { stats.failed++; continue }   // 不像音源脚本（站点自带 JS 等），静默跳过
        let host = ''
        let path = ''
        try { const u = new URL(l.url); host = u.host; path = u.pathname } catch (e) { host = l.url; path = l.name }
        items.push({
          id: 'web::' + host + '::' + path,
          repo: siteUrl,
          path,
          url: l.url,
          name: l.name || path.split('/').pop().replace(/\.js$/i, ''),
          code: text,
          contentHash: sha256Str(text),
          suspectScore: score,
          status: 'unknown',
          suspected: true,
          usable: false,
          size: text.length,
          addedAt: Date.now(),
          lastCheck: 0,
          deep: null
        })
        stats.collected++
      } catch (e) {
        stats.failed++
        log('warn', `${siteUrl}：${l.name || l.url} 下载失败：${String((e && e.message) || e).slice(0, 80)}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, links.length) }, worker))
  if (shouldStop && shouldStop()) return stats
  if (items.length) onEvent && onEvent('repo', { repo: siteUrl, candidates: items.length, items })
  log('info', `${siteUrl}：采集完成，收入音源脚本 ${items.length} 个` +
    (stats.droppedOld ? `（旧版本跳过 ${stats.droppedOld} 个）` : '') +
    (stats.failed ? `，不像音源/失败 ${stats.failed} 个` : ''))
  return stats
}

module.exports = { isWebRepo, extractJsLinks, crawlWebSite, MAX_CANDIDATES_PER_SITE }
