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

/**
 * 内置 raw 加速镜像（2026-10-15 实测筛选，判据 = HTTP 200 **且返回内容确实是目标文件**）：
 *  - ✅ ghfast.top / gh-proxy.com / ghproxy.net / jsDelivr CDN 均返回正确文件内容；
 *  - ❌ ghproxy.cn 返回 HTML 页面（站点已变质）、gh-proxy.net 返回 JS 挑战页、
 *     FastGit（raw.fastgit.org）与 ghproxy.vvv.ee / gh1.lh1.one 域名已失效 —— 一律不内置，
 *    免得 auto 链每轮白等一次超时。
 * 只按状态码判断会误收「200 但不是文件」的站点，所以这里以实测内容为准定期复核。
 */
const MIRROR_PRESETS = [
  { id: 'direct', label: '直连 GitHub', prefix: true, build: u => u },
  { id: 'ghfast', label: 'ghfast.top', prefix: true, build: u => 'https://ghfast.top/' + u },
  { id: 'ghproxy', label: 'gh-proxy.com', prefix: true, build: u => 'https://gh-proxy.com/' + u },
  { id: 'ghproxy-net', label: 'ghproxy.net', prefix: true, build: u => 'https://ghproxy.net/' + u },
  { id: 'jsdelivr', label: 'jsDelivr CDN', gh: true, build: (owner, repo, ref, p) => `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${p}` }
]

/* ================= 爬取代理 / 候选链开关（v1.9.7，借鉴 songloft 版网络设置） =================
 * - crawlProxy：HTTP 代理（如 http://192.168.1.246:7890），仅作用于 GitHub 爬取链
 *   （仓库扫描 / 脚本 / 压缩包下载，全部走 crawlFetch），不影响音源检测的播放请求与灌入。
 * - forceProxy：把「经代理直连目标」排到候选链最前（代理稳定的环境省掉逐个镜像试错）。
 * - useJsdelivr：jsDelivr 是否参与候选链（默认参与；关掉可排除 CDN 缓存旧文件的干扰）。
 * - mirrorCustom：镜像下拉选「自定义…」时的前缀镜像基址。
 * 零依赖实现：http 目标走代理绝对 URI；https 目标走 CONNECT 隧道 + TLS。
 */
const NETCFG = { crawlProxy: '', forceProxy: false, useJsdelivr: true, mirrorCustom: '' }
function applyConfig(cfg) {
  if (!cfg) return
  if ('crawlProxy' in cfg) NETCFG.crawlProxy = String(cfg.crawlProxy || '').trim()
  if ('forceProxy' in cfg) NETCFG.forceProxy = !!cfg.forceProxy
  if ('useJsdelivr' in cfg) NETCFG.useJsdelivr = cfg.useJsdelivr !== false
  if ('mirrorCustom' in cfg) NETCFG.mirrorCustom = String(cfg.mirrorCustom || '').trim()
}

function parseProxyUrl(p) {
  const m = String(p || '').match(/^http:\/\/([^/:@]+)(?::(\d+))?\/?$/i)
  if (!m) return null
  return { host: m[1], port: Number(m[2] || 80) }
}

/** 把 chunked 传输编码解开（GitHub 大文件常用） */
function dechunk(buf) {
  const out = []
  let i = 0
  while (i < buf.length) {
    const nl = buf.indexOf('\r\n', i)
    if (nl < 0) break
    const n = parseInt(buf.slice(i, nl).toString('utf8').trim(), 16)
    if (!n) break
    out.push(buf.slice(nl + 2, nl + 2 + n))
    i = nl + 2 + n + 2
  }
  return Buffer.concat(out)
}

/** 解析手写 HTTP 响应：状态行 + headers + body */
function parseHttpResponse(buf) {
  const sep = buf.indexOf('\r\n\r\n')
  if (sep < 0) throw new Error('代理响应格式异常（缺少响应头）')
  const lines = buf.slice(0, sep).toString('utf8').split('\r\n')
  const status = parseInt((lines[0].split(' ')[1] || '0'), 10)
  const headers = {}
  for (let i = 1; i < lines.length; i++) {
    const m = lines[i].match(/^([^:]+):\s*(.*)$/)
    if (m) headers[m[1].toLowerCase()] = m[2]
  }
  let body = buf.slice(sep + 4)
  if (/chunked/i.test(headers['transfer-encoding'] || '')) body = dechunk(body)
  return { status, headers, body }
}

/**
 * 通过 HTTP 代理请求任意 URL（零依赖，手写 HTTP/1.1）：
 *  - https 目标：CONNECT 建隧道 → TLS → 明文 HTTP 写进加密通道；
 *  - http 目标：绝对 URI 直接发给代理；
 *  - 3xx 自动跟随（最多 5 跳），Connection: close 保证一次读全。
 * 实测要点：别用 https.request + createConnection（会被默认 agent 绕过隧道，
 * 表现为代理形同虚设 / ECONNRESET / 一直超时），手写请求最稳。
 */
function proxyFetchRaw(url, options, timeoutMs, proxyUrl, redirects) {
  const proxy = parseProxyUrl(proxyUrl)
  if (!proxy) return Promise.reject(new Error('爬取代理格式无效（应为 http://host:port）'))
  return new Promise((resolve, reject) => {
    const net = require('node:net')
    const http = require('node:http')
    const tls = require('node:tls')
    const u = new URL(url)
    const isHttps = u.protocol === 'https:'
    const ms = timeoutMs || 15000
    const hops = Number(redirects || 0)
    let settled = false
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v) } }
    const timer = setTimeout(() => done(reject, new Error('请求超时 ' + ms + 'ms（经代理）')), ms)
    const socks = []

    // hop-by-hop 头不该透传给代理；Connection: close 让我们能靠 'end' 收全响应
    // （注意顺序：先清 hop-by-hop，最后再补 Connection，否则会被自己删掉 → 一直等不到 end）
    const headers = Object.assign({ Host: u.host }, (options && options.headers) || {})
    delete headers['connection']; delete headers['Connection']
    delete headers['proxy-connection']; delete headers['Proxy-Connection']
    headers.Connection = 'close'
    const method = (options && options.method) || 'GET'
    const reqHead = `${method} ${isHttps ? (u.pathname + u.search) : url} HTTP/1.1\r\n`
      + Object.keys(headers).map(k => `${k}: ${headers[k]}`).join('\r\n') + '\r\n\r\n'

    const collect = (sock) => {
      const chunks = []
      sock.on('data', c => chunks.push(c))
      sock.on('end', () => {
        try {
          const r = parseHttpResponse(Buffer.concat(chunks))
          if (r.status >= 300 && r.status < 400 && r.headers.location && hops < 5) {
            const next = new URL(r.headers.location, url).toString()
            proxyFetchRaw(next, options, timeoutMs, proxyUrl, hops + 1).then(v => done(resolve, v)).catch(e => done(reject, e))
            return
          }
          done(resolve, {
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            headers: r.headers,
            text: () => Promise.resolve(r.body.toString('utf8')),
            arrayBuffer: () => Promise.resolve(r.body.buffer.slice(r.body.byteOffset, r.body.byteOffset + r.body.byteLength))
          })
        } catch (e) { done(reject, e) }
      })
      sock.on('error', e => done(reject, e))
      sock.write(reqHead)
    }

    if (isHttps) {
      const creq = http.request({
        host: proxy.host, port: proxy.port, method: 'CONNECT',
        path: u.hostname + ':' + (u.port || 443),
        headers: { Host: u.hostname + ':' + (u.port || 443) }
      })
      socks.push(creq)
      creq.on('connect', (res2, socket) => {
        if (res2.statusCode !== 200) { try { socket.destroy() } catch (e) {} return done(reject, new Error('代理 CONNECT 失败 HTTP ' + res2.statusCode)) }
        const t = tls.connect({ socket, servername: u.hostname }, () => collect(t))
        socks.push(t)
        t.on('error', e => done(reject, e))
      })
      creq.on('error', e => done(reject, e))
      creq.end()
    } else {
      const s = net.connect(proxy.port, proxy.host, () => collect(s))
      socks.push(s)
      s.on('error', e => done(reject, e))
      s.setTimeout(ms, () => { try { s.destroy(new Error('请求超时 ' + ms + 'ms（经代理）')) } catch (e) {} })
    }
  })
}

/** 自定义镜像（用户填的前缀基址，如 https://my-mirror.example.com） */
function customPreset() {
  const base = String(NETCFG.mirrorCustom || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) return null
  return { id: 'custom', label: '自定义镜像', prefix: true, build: u => base + '/' + u }
}

function jsdelivrAllowed() { return NETCFG.useJsdelivr !== false }

/**
 * 生成候选 URL 列表：
 *  - 开了强制代理且配了爬取代理 → 「经代理直连目标」排最前（省去逐个镜像试错）；
 *  - 用户指定镜像（含自定义）其次；然后直连，最后其余镜像兜底。
 *  - useJsdelivr=false 时 jsDelivr 不参与（FastGit 仅 raw 路径，保留）。
 */
function buildCandidates(rawUrl, mirrorId) {
  mirrorId = mirrorId || NETCFG.mirror || 'auto'
  const out = []
  // 按「通道 + URL」去重，而不是只按 URL：经代理直连与直连的 URL 相同但通道不同，
  // 只按 URL 去重会把其中一条吃掉（测试模式下就只报一条，看不出第二条通不通）
  const push = (id, url) => { if (url && out.every(o => !(o.id === id && o.url === url))) out.push({ id, url }) }
  if (NETCFG.forceProxy && NETCFG.crawlProxy && parseProxyUrl(NETCFG.crawlProxy)) push('proxy', rawUrl)
  const p = parseRaw(rawUrl)
  const pickPreset = (id) => id === 'custom' ? customPreset() : MIRROR_PRESETS.find(m => m.id === id)
  if (mirrorId && mirrorId !== 'auto' && mirrorId !== 'direct') {
    const pre = pickPreset(mirrorId)
    if (pre && p) push(pre.id, pre.gh ? pre.build(p.owner, p.repo, p.ref, p.path) : pre.build(rawUrl))
    else if (pre) push(pre.id, pre.build(rawUrl))
  }
  push('direct', rawUrl)
  if (p) {
    for (const m of MIRROR_PRESETS) {
      if (m.id === 'direct' || (m.id === 'jsdelivr' && !jsdelivrAllowed())) continue
      try { push(m.id, m.gh ? m.build(p.owner, p.repo, p.ref, p.path) : m.build(rawUrl)) } catch (e) {}
    }
    const cp = customPreset()
    if (cp && mirrorId !== 'custom') { try { push(cp.id, cp.build(rawUrl)) } catch (e) {} }
  } else if (isGhAssetUrl(rawUrl)) {
    // github.com releases 资产：只有前缀型镜像能代理（jsdelivr/fastgit 仅服务 raw 路径）
    for (const m of MIRROR_PRESETS) {
      if (m.id === 'direct' || m.gh) continue
      try { push(m.id, m.build(rawUrl)) } catch (e) {}
    }
    const cp = customPreset()
    if (cp && mirrorId !== 'custom') { try { push(cp.id, cp.build(rawUrl)) } catch (e) {} }
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
      const res = c.id === 'proxy' && NETCFG.crawlProxy
        ? await proxyFetchRaw(c.url, Object.assign({ headers: { 'User-Agent': UA } }, options || {}), timeoutMs, NETCFG.crawlProxy)
        : await fetchWithTimeout(c.url, Object.assign({ headers: { 'User-Agent': UA } }, options || {}), timeoutMs)
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

/** 网络连通性测试（设置页「测试」按钮）：对探针 URL 跑一遍候选链，报告每条通道的耗时/结果 */
async function testNetwork(opts) {
  const o = opts || {}
  // 探针必须用公开仓库文件：私有仓库的 raw 未授权返回 404，会被误判成「通道失败」
  const probe = String(o.url || 'https://raw.githubusercontent.com/zlyon/lx-hunter/main/plugin.json')
  // 测试时用传入的配置快照，而不是全局 NETCFG（便于「保存前」先试）
  const saved = Object.assign({}, NETCFG)
  try {
    applyConfig({ crawlProxy: o.crawlProxy != null ? o.crawlProxy : saved.crawlProxy, forceProxy: o.forceProxy != null ? o.forceProxy : saved.forceProxy, useJsdelivr: o.useJsdelivr != null ? o.useJsdelivr : saved.useJsdelivr, mirrorCustom: o.mirrorCustom != null ? o.mirrorCustom : saved.mirrorCustom })
    // 测试与真实爬取不同：404 也继续测下一条通道，把每条通道的真实状态都报告出来
    const cands = buildCandidates(probe, o.mirror || 'auto')
    const attempts = []
    let hit = null
    for (const c of cands) {
      const t0 = Date.now()
      try {
        const res = c.id === 'proxy' && NETCFG.crawlProxy
          ? await proxyFetchRaw(c.url, Object.assign({ headers: { 'User-Agent': UA } }, o.headers || {}), o.timeoutMs || 12000, NETCFG.crawlProxy)
          : await fetchWithTimeout(c.url, Object.assign({ headers: { 'User-Agent': UA } }, o.headers || {}), o.timeoutMs || 12000)
        attempts.push({ mirror: c.id, url: c.url, status: res.status, ms: Date.now() - t0 })
        if (res.ok && !hit) hit = { status: res.status, mirror: c.id, res }
      } catch (e) {
        attempts.push({ mirror: c.id, url: c.url, error: String(e && e.message || e), ms: Date.now() - t0 })
      }
    }
    return { ok: !!hit, status: hit ? hit.status : (attempts.find(a => a.status != null) || {}).status || null, via: hit ? hit.mirror : null, attempts }
  } finally {
    Object.assign(NETCFG, saved)
  }
}

module.exports = {
  fetchWithTimeout, fetchAnyWithTimeout, readText, buildCandidates, crawlFetch, sleep, UA, MIRROR_PRESETS,
  hostFetch, describeNetError, isConnLevel, buildDualChannel, dohLookup, isGhAssetUrl,
  applyConfig, testNetwork, proxyFetchRaw, customPreset
}
