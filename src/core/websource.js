'use strict'
/**
 * 非 GitHub「站外分发源」采集（v1.10.0 网页音源站 → v1.11.0 扩展为完整站外分发源）
 *
 * 需求背景：很多音源作者不建 GitHub 仓库，或把脚本由 CI 部署到 GitHub Pages /
 * Cloudflare Pages / 自建域名，Git 树里根本没有 .js（实测 chinaes666/lx-music-source：
 * f2be2724 删掉 source.js、deploy.yml 改走 Cloudflare Pages，页面给 https://…/lx.js）。
 * 这类「站外分发」源在旧口径下永远采不到 —— verifyRepoHasSource 判死是口径边界，不是仓库失效。
 *
 * 本模块支持三种形态（以响应 Content-Type / 正文为准，URL 后缀只作提示）：
 *  ① script  直链脚本：URL 直接返回 .js 正文（Pages / 对象存储 / 自建域名最常见）
 *  ② archive 直链压缩包：URL 返回 zip，解压后挑真音源脚本
 *  ③ index   索引页：页面里列出若干 .js 链接（原 v1.10.0「网页音源站」能力）
 *     索引页除了 href/src，还补了「纯文本导入地址」提取（<code>/输入框 value/Markdown/裸文本），
 *     Pages 首页常把导入地址写成文本而不是超链接，旧正则会全漏。
 *
 * 验真闸门与 GitHub 通道完全同口径（2026-11-08 宿主插件假阳性复盘）：
 *  isHostAdapterScript 判死 + classifyEntry(scoreEntry>=4)；压缩包走 pickScriptsFromZip
 *  （内含 plugin.json 安装包拒收）。宁缺毋滥，不因为「网址里带 source」就放行。
 *
 * 时间窗（v1.11.0）：站外源没有 Git 提交/发布时间元数据，不能照搬「30 天内有无 commit」。
 *  改为「内容是否变化」判据：sinceDays>0 时记下本源上次采集的响应体指纹，
 *  指纹相同 = 没有新音源 → 整源跳过（不重复下载、不产新条目）；指纹变了才采。
 *  首次采集永远放行。日志明写口径，避免用户以为没生效。
 *  「同组只收最新版」(latestOnly) 对索引页多版本直链照旧生效；直链本身天然只有一版。
 *
 * 网络走 net.fetchAuto（第三方站点：配置了爬取代理就走代理、内网直连），
 * 不消耗 GitHub API 配额。
 */
const crypto = require('crypto')
const { fetchAuto } = require('./net')
const { unzip, isArchivePath } = require('./zip')
const { scoreEntry, classifyEntry, sha256Str, isHostAdapterScript, extractMeta } = require('./checker')
const { filterLatestOnly, pickScriptsFromZip } = require('./crawler')

const MAX_CANDIDATES_PER_SITE = 120   // 单站点最多解析的 .js 链接数（防超大页面拖死）
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024
const MAX_CONCURRENCY = 3             // 单站点下载并发（第三方站，压低些）
const MAX_EXTERNAL_BYTES = 20 * 1024 * 1024  // 站外主响应体上限（直链脚本/压缩包/首页共用）
const MAX_PLAIN_URLS = 60             // 「纯文本导入地址」最多提取条数
const MAX_PROBE_SCRIPTS = 12          // 探测（不入库）时最多下载验真的脚本数

/** 仓库条目是否为「网页/站外源」（URL 形态，与 owner/repo 相区分） */
function isWebRepo(repo) {
  return /^https?:\/\//i.test(String(repo || '').trim())
}

/** 站外源 URL 规范化：只收 http(s)，去掉 #fragment，返回绝对 URL；非法返回 null */
function normalizeExternalUrl(input) {
  const s = String(input || '').trim()
  if (!/^https?:\/\//i.test(s)) return null
  try {
    const u = new URL(s)
    if (!/^https?:$/i.test(u.protocol)) return null
    u.hash = ''
    return u.toString()
  } catch (e) { return null }
}

/** 仅按 URL 猜形态；真实判定一律以响应头/正文为准（见 detectPayloadKind） */
function externalUrlKind(url) {
  let p = ''
  try { p = new URL(String(url)).pathname } catch (e) { p = String(url || '') }
  if (/\.(zip|7z|rar)$/i.test(p)) return 'archive'
  if (/\.js$/i.test(p)) return 'script'
  return 'index'
}

/**
 * 首页「纯文本导入地址」提取（v1.11.0）。
 * Cloudflare Pages / 自建站常把 https://…/lx.js 放在 <code>、<input value>、
 * Markdown 链接或纯文本里，而不是 <a href>；extractJsLinks 只认 href/src，旧版全漏。
 * 只收绝对 http(s) 且以 .js 结尾（可带 query）的 URL，避免把页面里的任意链接都当音源。
 */
function extractPlainJsUrls(html, baseUrl) {
  const out = []
  const seen = new Set()
  const re = /https?:\/\/[^\s"'<>`\\\[\]()]+\.js(?:\?[^\s"'<>`\\\[\]()]*)?/gi
  let m
  while ((m = re.exec(String(html || ''))) !== null) {
    let abs = null
    try { abs = new URL(m[0], baseUrl).toString() } catch (e) { continue }
    if (!/^https?:/i.test(abs)) continue
    const key = abs.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(abs)
    if (out.length >= MAX_PLAIN_URLS) break
  }
  return out
}

/** 统一验真闸门：与 checker/crawler 同口径，返回 {ok, reason, score, hash, size, name} */
function judgeExternalScript(url, text) {
  const src = String(text == null ? '' : text)
  if (!src.trim()) return { ok: false, reason: '空内容', score: 0 }
  if (isHostAdapterScript(src)) return { ok: false, reason: '宿主插件/适配层（非音源脚本）', score: 0 }
  const score = scoreEntry(url, src)
  if (!classifyEntry(url, src)) return { ok: false, reason: `不像音源脚本（score=${score}<4）`, score }
  let meta = {}
  try { meta = extractMeta(src) || {} } catch (e) { meta = {} }
  return { ok: true, score, hash: sha256Str(src), size: src.length, name: meta.name || '' }
}

/** 响应体指纹（二进制安全），用于站外源时间窗的「内容是否变化」判定 */
function payloadHash(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 由 Content-Type / 魔数 / 正文判定三种形态 */
function detectPayloadKind(res, url, buf, text) {
  const ct = String((res && res.headers && res.headers.get && res.headers.get('content-type')) || '').toLowerCase()
  if (buf && buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) return 'archive'   // PK.. zip
  if (externalUrlKind(url) === 'archive' || isArchivePath(url)) return 'archive'
  // JS 类型 / .js 后缀一律按「直链脚本」处理，哪怕验真不过：
  // 否则宿主插件脚本会被当成 HTML 首页去解析，报「页面里没有发现 .js 直链」，
  // 把真正的判死原因（宿主插件/适配层）埋掉（2026-11-08 v1.11.0 实测踩中）。
  if (/javascript|ecmascript/.test(ct) || externalUrlKind(url) === 'script') return 'script'
  if (/text\/html/.test(ct)) return 'index'
  // 无扩展名 / text/plain / 未知类型：正文像音源就当直链脚本，否则当首页
  return judgeExternalScript(url, text).ok ? 'script' : 'index'
}

/** 构造与现有网页站条目同构的音源条目（id 口径不变，避免同一 URL 采出两条） */
function buildExternalItem(siteUrl, scriptUrl, text, j, extra) {
  let host = scriptUrl, path = scriptUrl
  try { const u = new URL(scriptUrl); host = u.host; path = u.pathname } catch (e) { /* 非法 URL 兜底 */ }
  const base = path.split('/').pop() || 'source.js'
  return Object.assign({
    id: 'web::' + host + '::' + path,
    repo: siteUrl,
    path,
    url: scriptUrl,
    name: (j && j.name) || base.replace(/\.js$/i, ''),
    code: text,
    contentHash: (j && j.hash) || sha256Str(text),
    suspectScore: (j && j.score) || scoreEntry(scriptUrl, text),
    status: 'unknown',
    suspected: true,
    usable: false,
    size: (j && j.size) || text.length,
    addedAt: Date.now(),
    lastCheck: 0,
    deep: null,
    external: true,          // v1.11.0：站外分发源标记，便于按来源筛选 / 回撤
    sourceKind: 'external'
  }, extra || {})
}

/** 合并索引页里的两类 .js 链接（href/src + 纯文本导入地址），保持出现顺序去重 */
function mergeJsLinks(html, baseUrl) {
  const out = []
  const seen = new Set()
  const push = (url, name) => {
    const key = String(url).toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ url, name: name || (() => {
      try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || '').replace(/\.js$/i, '') } catch (e) { return '' }
    })() })
  }
  try { for (const l of extractJsLinks(html, baseUrl)) push(l.url, l.name) } catch (e) { /* 解析失败不致命 */ }
  try { for (const u of extractPlainJsUrls(html, baseUrl)) push(u, '') } catch (e) { /* 同上 */ }
  return out.slice(0, MAX_CANDIDATES_PER_SITE)
}

async function fetchExternal(url, timeoutMs, extraHeaders) {
  const headers = Object.assign({ 'Accept': '*/*', 'User-Agent': 'lx-hunter-pc/1.0' }, extraHeaders || {})
  const res = await fetchAuto(url, { headers }, timeoutMs)
  if (!res) throw new Error('不可达')
  return res
}

function shortErr(e) { return String((e && e.message) || e).slice(0, 100) }

/**
 * 从 HTML 表格行里解析每个 .js 链接的「版本号 / 更新时间」（v1.10.1 关键修正）：
 * 站点文件名里的版本号不可信（实测 zrcdy.dpdns.org/lx/vers.php：文件名
 * xinghai-music-sourcev2.3.17.js 对应的真实版本是 v3.2.17，页面表格另有版本号列）。
 * 只认「不含链接文件名的单元格」里的版本号，更新时间取 yyyy-mm-dd。
 * 返回 Map(小写绝对URL -> {version, updatedAt})
 */
function extractLinkMeta(html, baseUrl) {
  const meta = new Map()
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let m
  while ((m = rowRe.exec(String(html || ''))) !== null) {
    const row = m[1]
    const hrefM = row.match(/(?:href|src)\s*=\s*["']([^"']+\.js)(\?[^"']*)?["']/i)
    if (!hrefM) continue
    let abs = null
    try { abs = new URL(hrefM[1] + (hrefM[2] || ''), baseUrl).toString() } catch (e) { continue }
    const tds = []
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
    let tm
    while ((tm = tdRe.exec(row)) !== null) {
      tds.push(tm[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    }
    let fname = ''
    try { fname = decodeURIComponent(new URL(abs).pathname.split('/').pop() || '') } catch (e) { fname = abs }
    let version = null
    let updatedAt = 0
    for (const t of tds) {
      if (t && fname && t.includes(fname)) continue   // 文件名单元格自带的版本号不可信
      if (version == null) {
        const vm = t.match(/[vV]?\d+(?:\.\d+)+/)
        if (vm) version = vm[0].replace(/^v/i, '')
      }
      const dm = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)
      if (dm) {
        const ts = Date.parse(dm[0].replace(/-(\d{1,2})-(\d{1,2})$/, (s, a, b) => '-' + a.padStart(2, '0') + '-' + b.padStart(2, '0')))
        if (!Number.isNaN(ts)) updatedAt = ts
      }
    }
    meta.set(abs.toLowerCase(), { version, updatedAt })
  }
  return meta
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
 * 采集一个站外分发源。返回 stats（含 mode/ok/reason/hash/fresh/collected），
 * 由调用方 merge（与 GitHub 爬取的 'repo' 事件同构）。
 * @param {string} siteUrl 站点/直链地址（站外源清单里的一条 url）
 * @param {object} opts {timeoutMs, latestOnly, sinceDays, knownExternal:{hash,at}}
 * @param {function} onEvent (type, payload) —— 与 crawler.crawl 相同的事件约定
 * @param {function} shouldStop
 */
async function crawlWebSite(siteUrl, opts, onEvent, shouldStop) {
  const o = opts || {}
  const timeoutMs = Number(o.timeoutMs) || 15000
  const log = (level, msg) => onEvent && onEvent('log', { level, module: '爬取', msg })
  const stats = { links: 0, collected: 0, droppedOld: 0, failed: 0,
    mode: '', ok: false, reason: '', hash: '', scripts: 0, fresh: true, lastModified: '' }
  let res = null, buf = null, finalUrl = siteUrl
  try {
    res = await fetchExternal(siteUrl, timeoutMs)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    finalUrl = res.url || siteUrl
    buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_EXTERNAL_BYTES) throw new Error('文件过大（' + Math.round(buf.length / 1048576) + 'MB）')
  } catch (e) {
    stats.reason = '页面/脚本抓取失败：' + shortErr(e)
    log('warn', `${siteUrl}：${stats.reason}`)
    return stats
  }
  try { stats.lastModified = (res.headers && res.headers.get && res.headers.get('last-modified')) || '' } catch (e) { /* 忽略 */ }
  stats.hash = payloadHash(buf)
  const text = buf.toString('utf8')

  // 时间窗（v1.11.0）：站外源无 Git 时间元数据，用「响应体指纹未变」等价判定「没有新音源」。
  // 只在 sinceDays>0 且已有上次指纹时启用；首次采集永远放行，0 天=不限（每轮全采）。
  const sinceDays = Number(o.sinceDays) > 0 ? Number(o.sinceDays) : 0
  const prev = o.knownExternal || null
  if (sinceDays && prev && prev.hash && prev.hash === stats.hash) {
    stats.fresh = false
    stats.ok = true
    stats.mode = 'unchanged'
    stats.reason = `内容未变，${sinceDays} 天内无新音源（按时间窗整源跳过）`
    log('info', `${siteUrl}：${stats.reason}`)
    return stats
  }

  const kind = detectPayloadKind(res, finalUrl, buf, text)
  stats.mode = kind

  // ① 直链脚本（Pages / 对象存储 / 自建域名最常见形态）
  if (kind === 'script') {
    const j = judgeExternalScript(finalUrl, text)
    if (!j.ok) {
      stats.reason = j.reason
      log('warn', `${siteUrl}：直链脚本未通过验真：${j.reason}`)
      return stats
    }
    const item = buildExternalItem(siteUrl, finalUrl, text, j)
    stats.links = 1; stats.collected = 1; stats.scripts = 1; stats.ok = true
    onEvent && onEvent('repo', { repo: siteUrl, candidates: 1, items: [item] })
    log('info', `${siteUrl}：站外直链音源「${item.name}」已收入（score=${j.score}，sha256=${String(j.hash).slice(0, 12)}…）`)
    return stats
  }

  // ② 直链压缩包：与 GitHub 压缩包通道同判据（含 plugin.json 安装包拒收）
  if (kind === 'archive') {
    let items = []
    try {
      const files = unzip(buf)
      let archPath = finalUrl
      try { archPath = new URL(finalUrl).pathname } catch (e) { /* 原样 */ }
      items = pickScriptsFromZip(files, archPath, siteUrl, finalUrl, 50)
        .map(it => Object.assign({}, it, { external: true, sourceKind: 'external' }))
    } catch (e) {
      stats.reason = '压缩包解析失败：' + shortErr(e)
      log('warn', `${siteUrl}：${stats.reason}`)
      return stats
    }
    if (!items.length) {
      stats.reason = '压缩包内没有音源脚本（或为宿主插件安装包）'
      log('warn', `${siteUrl}：${stats.reason}`)
      return stats
    }
    stats.collected = items.length; stats.scripts = items.length; stats.ok = true
    onEvent && onEvent('repo', { repo: siteUrl, candidates: items.length, items })
    log('info', `${siteUrl}：站外压缩包解出 ${items.length} 个音源脚本`)
    return stats
  }

  // ③ 索引页：href/src + 纯文本导入地址，按「只收最新版」筛选后逐个下载验真
  let links = mergeJsLinks(text, finalUrl)
  stats.links = links.length
  if (!links.length) {
    stats.reason = '页面里没有发现 .js 直链'
    log('info', `${siteUrl}：${stats.reason}`)
    return stats
  }
  log('info', `${siteUrl}：发现 ${links.length} 个 .js 直链（含纯文本导入地址），开始下载甄别…`)
  let meta = new Map()
  try { meta = extractLinkMeta(text, finalUrl) } catch (e) { meta = new Map() }

  if (o.latestOnly) {
    const enriched = links.map(l => {
      const mt = meta.get(l.url.toLowerCase()) || {}
      return Object.assign({}, l, { version: mt.version || null, updatedAt: mt.updatedAt || 0 })
    })
    const f = filterLatestOnly(enriched)
    stats.droppedOld = f.dropped.length
    if (f.dropped.length) {
      log('info', `${siteUrl}：按「只收最新版」跳过 ${f.dropped.length} 个旧版本直链`)
      const keepSet = new Set(f.kept.map(x => x.url))
      links = enriched.filter(l => keepSet.has(l.url))
    } else {
      links = enriched
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
        const r = await fetchExternal(l.url, timeoutMs)
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const sbuf = Buffer.from(await r.arrayBuffer())
        if (sbuf.length > MAX_SCRIPT_BYTES) throw new Error('文件过大')
        const code = sbuf.toString('utf8')
        const j = judgeExternalScript(l.url, code)
        if (!j.ok) { stats.failed++; continue }   // 站点自带 JS / 宿主插件适配层，静默跳过
        items.push(buildExternalItem(siteUrl, l.url, code, j, { name: l.name || j.name }))
        stats.collected++
      } catch (e) {
        stats.failed++
        log('warn', `${siteUrl}：${l.name || l.url} 下载失败：${shortErr(e)}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, links.length) }, worker))
  if (shouldStop && shouldStop()) return stats
  if (items.length) onEvent && onEvent('repo', { repo: siteUrl, candidates: items.length, items })
  stats.scripts = items.length
  stats.ok = items.length > 0
  if (!stats.ok) stats.reason = '所有直链都未通过音源验真'
  log('info', `${siteUrl}：采集完成，收入音源脚本 ${items.length} 个` +
    (stats.droppedOld ? `（旧版本跳过 ${stats.droppedOld} 个）` : '') +
    (stats.failed ? `，不像音源/失败 ${stats.failed} 个` : '') +
    (sinceDays ? `；时间窗 ${sinceDays} 天：内容有变化才采` : ''))
  return stats
}

/**
 * 探测一个站外分发源（只验真、不入库），供「探测并添加」与「重新验真」使用。
 * 返回 {ok, url, finalUrl, kind, reason, scripts:[{url,name,score,hash,size}], name, hash, size, score}
 */
async function probeExternalSource(url, opts) {
  const o = opts || {}
  const timeoutMs = Number(o.timeoutMs) || 15000
  const norm = normalizeExternalUrl(url)
  if (!norm) return { ok: false, url: String(url || ''), reason: '只支持 http(s) 开头的网址' }
  let res = null, buf = null, finalUrl = norm
  try {
    res = await fetchExternal(norm, timeoutMs)
    if (!res.ok) return { ok: false, url: norm, reason: 'HTTP ' + res.status }
    finalUrl = res.url || norm
    buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_EXTERNAL_BYTES) return { ok: false, url: norm, reason: '文件过大' }
  } catch (e) {
    return { ok: false, url: norm, reason: shortErr(e) }
  }
  const text = buf.toString('utf8')
  const hash = payloadHash(buf)
  const kind = detectPayloadKind(res, finalUrl, buf, text)
  const base = { url: norm, finalUrl, kind, hash, scripts: [] }

  if (kind === 'script') {
    const j = judgeExternalScript(finalUrl, text)
    if (!j.ok) return Object.assign({}, base, { ok: false, reason: j.reason, score: j.score })
    const name = j.name || (finalUrl.split('/').pop() || '').replace(/\.js$/i, '') || '站外音源'
    return Object.assign({}, base, { ok: true, reason: '', name, score: j.score, size: j.size,
      scripts: [{ url: finalUrl, name, score: j.score, hash: j.hash, size: j.size }] })
  }
  if (kind === 'archive') {
    try {
      const files = unzip(buf)
      let archPath = finalUrl
      try { archPath = new URL(finalUrl).pathname } catch (e) { /* 原样 */ }
      const picked = pickScriptsFromZip(files, archPath, norm, finalUrl, 50)
      if (!picked.length) return Object.assign({}, base, { ok: false, reason: '压缩包内没有音源脚本（或为宿主插件安装包）' })
      return Object.assign({}, base, { ok: true, reason: '', name: picked[0].name, size: buf.length,
        scripts: picked.slice(0, MAX_PROBE_SCRIPTS).map(p => ({ url: p.url, name: p.name, score: p.suspectScore, hash: p.contentHash, size: p.size })) })
    } catch (e) {
      return Object.assign({}, base, { ok: false, reason: '压缩包解析失败：' + shortErr(e) })
    }
  }
  const links = mergeJsLinks(text, finalUrl)
  if (!links.length) return Object.assign({}, base, { ok: false, reason: '页面里没有发现 .js 直链' })
  const scripts = []
  for (const l of links.slice(0, MAX_PROBE_SCRIPTS)) {
    try {
      const r = await fetchExternal(l.url, timeoutMs)
      if (!r.ok) continue
      const sbuf = Buffer.from(await r.arrayBuffer())
      if (sbuf.length > MAX_SCRIPT_BYTES) continue
      const code = sbuf.toString('utf8')
      const j = judgeExternalScript(l.url, code)
      if (j.ok) scripts.push({ url: l.url, name: l.name || j.name, score: j.score, hash: j.hash, size: j.size })
    } catch (e) { /* 单条失败不影响整站探测 */ }
  }
  return Object.assign({}, base, {
    ok: scripts.length > 0,
    reason: scripts.length ? '' : '页面里的直链都未通过音源验真',
    name: scripts[0] ? scripts[0].name : '',
    size: buf.length,
    total: links.length,
    scripts
  })
}

module.exports = {
  isWebRepo, extractJsLinks, extractPlainJsUrls, extractLinkMeta, mergeJsLinks,
  crawlWebSite, probeExternalSource, normalizeExternalUrl, externalUrlKind,
  detectPayloadKind, judgeExternalScript, buildExternalItem, payloadHash,
  MAX_CANDIDATES_PER_SITE, MAX_EXTERNAL_BYTES
}
