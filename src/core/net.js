'use strict'
/** 网络层：超时 fetch + 镜像/直连候选链（国内访问 GitHub raw 常常需要镜像） */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

/**
 * 宿主网络栈微调（只在纯 Node 侧生效 Electron 不需要）。
 *
 * Windows 上 Node 的 DNS 默认按「返回顺序」连（verbatim，通常 IPv6 优先）。
 * 很多音乐接口的 IPv6 记录不可用，直接表现为 connect ECONNREFUSED ::1:443，
 * 外层只看到一句 "fetch failed"。开启 Happy Eyeballs 后会自动落到 IPv4。
 */
function tuneHostNetwork() {
  try {
    const nodeNet = require('node:net')
    if (typeof nodeNet.setDefaultAutoSelectFamily === 'function') nodeNet.setDefaultAutoSelectFamily(true)
    // 每个地址族的尝试间隔：别让不可达的 IPv6 拖满整个超时窗口
    if (typeof nodeNet.setDefaultAutoSelectFamilyAttemptTimeout === 'function') nodeNet.setDefaultAutoSelectFamilyAttemptTimeout(750)
  } catch (e) {}
}
tuneHostNetwork()

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/**
 * DoH 公共 DNS 二次确认：本机解析失败时，问一问公共 DNS（阿里 → 腾讯）。
 *
 * 目的是把两种完全不同的失败分开：
 *  - 公共 DNS 也说「域名不存在」→ 域名真的注销/停用了，音源大概率已废弃，该删；
 *  - 公共 DNS 能解析 → 是本机 DNS 被污染/劫持/抽风，换 DNS 或开代理就能救活。
 * 过去这两种情况都显示同一句 ENOTFOUND，用户分不清是「检测坏了」还是「音源死了」。
 */
const dohCache = new Map()   // hostname -> { at, nx, ips }
async function dohLookup(hostname, timeoutMs) {
  const key = String(hostname || '').toLowerCase()
  if (!key) return { ok: false, nx: false, ips: [] }
  const hit = dohCache.get(key)
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit
  const qs = '?name=' + encodeURIComponent(key) + '&type=A'
  const endpoints = ['https://dns.alidns.com/resolve' + qs, 'https://1.12.12.12/resolve' + qs]
  let out = { ok: false, nx: false, ips: [] }
  for (const ep of endpoints) {
    try {
      const ac = new AbortController()
      const t = setTimeout(() => { try { ac.abort() } catch (e) {} }, timeoutMs || 6000)
      const res = await globalThis.fetch(ep, { signal: ac.signal, headers: { Accept: 'application/dns-json' } })
      clearTimeout(t)
      if (!res.ok) continue
      const j = await res.json()
      // Status 3 = NXDOMAIN（权威确认域名不存在）
      out = { ok: true, nx: j.Status === 3, ips: (j.Answer || []).filter(a => a.type === 1).map(a => a.data) }
      break
    } catch (e) { /* 下一个端点 */ }
  }
  dohCache.set(key, Object.assign({ at: Date.now() }, out))
  return out
}

/**
 * 优先使用 Electron 的 net.fetch（Chromium 网络栈），没有则回退 Node fetch。
 *
 * 为什么这件事很关键：音源脚本里的网络请求全走这里。Node 的 undici fetch
 *  1) 不读系统代理（开着代理就整片 "fetch failed"）；
 *  2) 对不规范的 HTTP / 老旧 TLS 更严格（很多音乐接口会被判失败）。
 * Chromium 网络栈两者都处理得更好，能显著提高「本机也能取到链」的比例。
 */
/** 连接级失败 = 请求压根没到服务器（DNS/连不上/代理/证书），此时换个通道重试是安全的；
 *  而响应级错误（HTTP 状态、解析失败）说明请求已经发出，再试一次可能造成重复提交 */
function isConnLevel(msg) {
  return /fetch failed|Failed to fetch|net::ERR_|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|socket|network|ERR_NETWORK|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_PROXY|ERR_CERT|certificate|证书|超时/i.test(String(msg || ''))
}

/**
 * 双通道 fetch：优先 Chromium 网络栈，连接级失败时再用 Node fetch 重试一次。
 * 两条通道能覆盖的环境互补（系统代理 / 老旧 TLS / 不规范 HTTP），
 * 而「只在没发出请求的情况下重试」保证不会出现重复提交。
 */
function buildDualChannel(channels) {
  return async function (url, init) {
    let lastErr = null
    for (let i = 0; i < channels.length; i++) {
      try { return await channels[i](url, init) } catch (e) {
        lastErr = e
        if (i < channels.length - 1 && !isConnLevel(describeNetError(e))) throw e
      }
    }
    throw lastErr
  }
}

function resolveFetchImpl() {
  const channels = []
  try {
    const { net } = require('electron')
    if (net && typeof net.fetch === 'function') channels.push(net.fetch.bind(net))
  } catch (e) {}
  channels.push((u, o) => globalThis.fetch(u, o))
  return channels.length > 1 ? buildDualChannel(channels) : channels[0]
}
let FETCH_IMPL = null
function hostFetch() {
  if (!FETCH_IMPL) FETCH_IMPL = resolveFetchImpl()
  return FETCH_IMPL
}

/**
 * Node 的 fetch 失败只给一句 "fetch failed"，真正的原因（DNS / 证书 / 连接重置…）
 * 藏在 cause 链里。展开后用户才知道是该配代理、还是目标站挂了。
 */
function describeNetError(err) {
  const parts = []
  let cur = err
  let depth = 0
  while (cur && depth < 6) {
    const m = cur.message || cur.code
    if (m && !parts.includes(m)) parts.push(m)
    cur = cur.cause
    depth++
  }
  return parts.join(' ← ') || String(err)
}

/**
 * 统一的带超时 fetch：默认走双通道（Chromium 网络栈优先）。
 *
 * 超时用「AbortSignal + Promise.race」双保险：某些实现的 signal 支持不完整，
 * 有了 race，哪怕 signal 没生效也一定会在 ms 后抛错返回，不会把检测卡死。
 */
async function fetchAnyWithTimeout(url, options, timeoutMs) {
  const impl = hostFetch()
  const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : 15000
  const ac = new AbortController()
  const timers = []
  let timedOut = false
  // 到点了先让 fetch 自己优雅中断
  timers.push(setTimeout(() => { timedOut = true; try { ac.abort() } catch (e) {} }, ms))
  // 再留一点余量做硬超时：某些实现不认 signal，靠这个保证一定返回
  const timeout = new Promise((_, rej) => {
    timers.push(setTimeout(() => rej(new Error('请求超时 ' + ms + 'ms')), ms + 300))
  })
  try {
    let res
    try {
      res = await Promise.race([
        Promise.resolve(impl(url, Object.assign({}, options || {}, { signal: ac.signal }))),
        timeout
      ])
    } catch (e) {
      // 中断导致的 Various 错误统一翻译成「超时」，不然用户看到的是没头没尾的 aborted
      if (timedOut && !/请求超时/.test(String((e && e.message) || ''))) throw new Error('请求超时 ' + ms + 'ms')
      throw e
    }
    if (timedOut) throw new Error('请求超时 ' + ms + 'ms')
    return res
  } finally {
    timers.forEach(t => clearTimeout(t))
  }
}

/** 兼容旧调用名，语义与 fetchAnyWithTimeout 一致（同样默认走双通道） */
const fetchWithTimeout = fetchAnyWithTimeout

async function readText(res, timeoutMs) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs || 15000)
  try {
    return await res.text()
  } finally {
    clearTimeout(t)
  }
}

// raw.githubusercontent.com/{owner}/{repo}/{ref}/{path...}
function parseRaw(url) {
  const m = String(url).match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/)
  if (!m) return null
  return { owner: m[1], repo: m[2], ref: m[3], path: m[4] }
}

/** github.com 域名下的资产 URL（releases/download 等）：前缀型镜像能代理任意 URL，
 *  但 jsDelivr/FastGit 只认 raw 路径、服务不了这类地址。用户实测 30MB release 包
 *  直连失败而 gh-proxy 成功 —— auto 模式下也要给它们留镜像回退。 */
const GH_ASSET_RE = /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/releases\/download\//i
function isGhAssetUrl(url) { return GH_ASSET_RE.test(String(url || '')) }

const MIRROR_PRESETS = [
  { id: 'direct', label: '直连 GitHub', prefix: true, build: u => u },
  { id: 'ghfast', label: 'ghfast.top', prefix: true, build: u => 'https://ghfast.top/' + u },
  { id: 'ghproxy', label: 'gh-proxy.com', prefix: true, build: u => 'https://gh-proxy.com/' + u },
  { id: 'ghproxy-net', label: 'ghproxy.net', prefix: true, build: u => 'https://ghproxy.net/' + u },
  { id: 'jsdelivr', label: 'jsDelivr CDN', gh: true, build: (owner, repo, ref, p) => `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${p}` },
  { id: 'fastgit', label: 'FastGit', gh: true, build: (owner, repo, ref, p) => `https://raw.fastgit.org/${owner}/${repo}/${ref}/${p}` }
]

/**
 * 生成候选 URL 列表：用户指定镜像优先，其次「直连 → 其余镜像」
 */
function buildCandidates(rawUrl, mirrorId) {
  const out = []
  const p = parseRaw(rawUrl)
  const push = (id, url) => { if (url && out.every(o => o.url !== url)) out.push({ id, url }) }
  if (mirrorId && mirrorId !== 'auto' && mirrorId !== 'direct') {
    const pre = MIRROR_PRESETS.find(m => m.id === mirrorId)
    if (pre && p) push(pre.id, pre.gh ? pre.build(p.owner, p.repo, p.ref, p.path) : pre.build(rawUrl))
    else if (pre) push(pre.id, pre.build(rawUrl))
  }
  push('direct', rawUrl)
  if (p) {
    for (const m of MIRROR_PRESETS) {
      if (m.id === 'direct') continue
      try { push(m.id, m.gh ? m.build(p.owner, p.repo, p.ref, p.path) : m.build(rawUrl)) } catch (e) {}
    }
  } else if (isGhAssetUrl(rawUrl)) {
    // github.com releases 资产：只有前缀型镜像能代理（jsdelivr/fastgit 仅服务 raw 路径）
    for (const m of MIRROR_PRESETS) {
      if (m.id === 'direct' || m.gh) continue
      try { push(m.id, m.build(rawUrl)) } catch (e) {}
    }
  }
  return out
}

/** 依次尝试候选，返回 {res, url, mirror, attempts}
 *  preferredId：本次运行中上一个成功过的镜像（auto 模式下优先尝试，避免每条都把失败的直连/镜像重试一遍） */
async function crawlFetch(rawUrl, options, timeoutMs, mirrorId, preferredId) {
  let cands = buildCandidates(rawUrl, mirrorId)
  if (preferredId && (!mirrorId || mirrorId === 'auto')) {
    const i = cands.findIndex(c => c.id === preferredId)
    if (i > 0) cands = [cands[i]].concat(cands.slice(0, i), cands.slice(i + 1))
  }
  const attempts = []
  for (const c of cands) {
    const t0 = Date.now()
    try {
      const res = await fetchWithTimeout(c.url, Object.assign({ headers: { 'User-Agent': UA } }, options || {}), timeoutMs)
      attempts.push({ mirror: c.id, url: c.url, status: res.status, ms: Date.now() - t0 })
      if (res.ok) return { res, url: c.url, mirror: c.id, attempts }
      if (res.status === 404) { // 404 说明镜像工作正常但文件不在，继续试下一个没意义
        return { res, url: c.url, mirror: c.id, attempts }
      }
    } catch (e) {
      attempts.push({ mirror: c.id, url: c.url, error: String(e && e.message || e), ms: Date.now() - t0 })
    }
  }
  return { res: null, url: rawUrl, mirror: null, attempts }
}

module.exports = {
  fetchWithTimeout, fetchAnyWithTimeout, readText, buildCandidates, crawlFetch, sleep, UA, MIRROR_PRESETS,
  hostFetch, describeNetError, isConnLevel, buildDualChannel, dohLookup, isGhAssetUrl
}
