'use strict'
/**
 * 音源猎手 Web / Docker 版服务端（v1.7.3 新增）
 *
 * 与 Electron 桌面版（src/main/index.js）共用同一套 core 业务模块，
 * 区别只在「外壳」：这里用纯 Node HTTP 服务替代 Electron 主进程，
 * 把桌面版的 24 个 IPC 通道一对一映射为 HTTP 接口，日志/事件用 SSE 推送。
 *
 * 设计约束：
 *  - 只用 Node 内置模块（http/fs/path），零 npm 依赖 → 镜像无需 npm install
 *  - 所有接口沿用桌面版的 guard 包装，返回 { ok, data | error }，桥接层零转换
 *  - 长任务（爬取/检测/灌入）为「长轮询」语义：请求挂起到任务结束，
 *    进度经 SSE 实时推送；连接断开不影响服务端任务继续
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { Store } = require('../core/store')
const { Hunter, formatIntervalHours, patrolSchedule } = require('../core/hunter')
const { getActiveService, resolveService, TYPE_LABELS, NO_ACCOUNT_ERR } = require('../core/services')
const { DEFAULT_REPOS } = require('../core/crawler')
const { Auth, SESSION_TTL_MS } = require('../core/auth')

const PORT = Number(process.env.PORT || 7970)
// Docker 部署时浏览器访问的是宿主机映射端口（如 8191:7970 里的 8191），
// 只把容器内监听端口写进启动日志会让人以为「端口不对」。compose 里显式给 PUBLIC_PORT。
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT || 0)
const DATA_DIR = process.env.DATA_DIR || '/data'
const RENDERER_DIR = path.join(__dirname, '..', 'renderer')
const MAX_BODY = 192 * 1024 * 1024 // 导入音源库 JSON 可能几十 MB，放宽上限

// ---------------- 访问账号登录（v1.10.0） ----------------
// 需求：Web/Docker 版不再「局域网裸奔」——用户名+密码多账号登录，未登录一律 401。
// 除 /api/health 与 /api/auth/* 外的全部 API 都要求有效会话（HttpOnly Cookie 携带 token，
// SSE/静态页面同源自动带 Cookie，前端无需逐请求塞 header）。
// 桌面版（Electron）不经 HTTP，不受影响。
const auth = new Auth(DATA_DIR)

function readCookie(req, name) {
  const raw = req.headers.cookie || ''
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return null
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `lxh_token=${encodeURIComponent(token)}; Path=/; HttpOnly; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax`)
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'lxh_token=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax')
}

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || ''
}

function currentUser(req) {
  return auth.checkSession(readCookie(req, 'lxh_token'))
}

// ---------------- 基础状态（与桌面版主进程保持一致） ----------------
let store = null
let hunter = null
const logs = []
const MAX_LOGS = 3000
const sseClients = new Set()

// 音源脚本是不可信代码：沙箱内异步回调的个别异常不应打断服务进程
process.on('uncaughtException', err => {
  const first = String((err && err.stack) || err).split('\n')[0]
  console.error('[web] uncaughtException:', err)
  try { pushLog({ msg: '已捕获服务进程异常（不影响使用）：' + first.slice(0, 160), module: '系统', level: 'error', at: Date.now() }) } catch (e) {}
})
// 音源脚本自身未捕获的 Promise 异常非常多，同消息 10 秒内只报一次 + 计数
const rejSeen = new Map()
process.on('unhandledRejection', err => {
  const first = String((err && err.stack) || err).split('\n')[0].slice(0, 160)
  console.error('[web] unhandledRejection:', err)
  try {
    const now = Date.now()
    const prev = rejSeen.get(first)
    if (prev && now - prev.at < 10000) { prev.n++; return }
    if (prev && prev.n > 1) pushLog({ msg: `（另有 ${prev.n} 条同类脚本异常已合并，未逐条展开）`, module: '系统', level: 'warn', at: now })
    rejSeen.set(first, { at: now, n: 1 })
    if (rejSeen.size > 200) rejSeen.clear()
    const isScript = /沙箱|fetch|Failed to parse URL|__host_|vm:/i.test(first)
    pushLog({
      msg: (isScript ? '音源脚本内部未捕获异常（已忽略，不影响检测）：' : '已捕获未处理的 Promise 异常：') + first,
      module: '系统', level: 'warn', at: now
    })
  } catch (e) {}
})

function pushLog(e) {
  logs.push(e)
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS)
  broadcast('log', e)
}

function emitAll(type, payload) {
  if (type === 'log') { pushLog(payload); return }
  broadcast('event', { type, payload })
}

// ---------------- SSE 推送 ----------------
function broadcast(channel, payload) {
  const frame = 'data: ' + JSON.stringify({ channel, payload }) + '\n\n'
  for (const res of sseClients) {
    try { res.write(frame) } catch (e) { sseClients.delete(res) }
  }
}

function sseHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no' // 反代（含飞牛自带）不缓冲，事件即时到达
  })
  res.write(': connected\n\n')
  sseClients.add(res)
  // 25s 心跳，防中间设备掐断 idle 连接
  const ka = setInterval(() => { try { res.write(': ping\n\n') } catch (e) {} }, 25000)
  req.on('close', () => { clearInterval(ka); sseClients.delete(res) })
}

// ---------------- 静态文件（renderer） ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

function staticHandler(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname
  const file = path.normalize(path.join(RENDERER_DIR, rel))
  // 防目录穿越：解析后必须仍在 renderer 目录内
  if (!file.startsWith(RENDERER_DIR + path.sep)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { ok: false, error: 'not found: ' + rel })
    const ext = path.extname(file).toLowerCase()
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache' // 与桌面版一致：刷新即最新，避免升级后旧 UI
    })
    res.end(buf)
  })
}

// ---------------- 工具 ----------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error('请求体超过上限（' + Math.round(MAX_BODY / 1048576) + 'MB）')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function parseJsonBody(raw) {
  if (!raw || !raw.length) return {}
  const text = raw.toString('utf8')
  try { return JSON.parse(text) } catch (e) { throw new Error('请求体不是有效 JSON：' + String(e.message || e).slice(0, 80)) }
}

function guard(fn) {
  return async (req, res, ctx) => {
    try {
      const data = await fn(req, res, ctx)
      // 导出类接口（db/export、data/export）自行写完附件响应，这里不能二次写
      if (!res.writableEnded) sendJson(res, 200, { ok: true, data })
    } catch (e) {
      if (!res.writableEnded) sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
    }
  }
}

// ---------------- 业务路由（与桌面版 IPC 一一对应） ----------------
const routes = []
function route(method, pattern, handler) { routes.push({ method, pattern, handler }) }

route('GET', '/api/health', guard(() => ({ app: 'lx-hunter-pc', mode: 'web', version: require('../../package.json').version, dataDir: DATA_DIR })))

// mirrors：内置镜像清单（v1.9.13 起设置页下拉由它动态生成，新增镜像不用再改 HTML）
route('GET', '/api/config', guard(() => ({
  config: store.config,
  dataDir: DATA_DIR,
  defaultRepos: DEFAULT_REPOS,
  mirrors: require('../core/net').MIRROR_PRESETS.map(m => ({ id: m.id, label: m.label }))
})))

route('POST', '/api/config', guard(async (req, res, ctx) => {
  // 与桌面版一致：附加仓库做规范化（支持完整 URL）
  if (Array.isArray(ctx.body.customRepos)) {
    const { normalizeRepo } = require('../core/crawler')
    const out = []
    for (const r of ctx.body.customRepos) {
      const n = normalizeRepo(r)
      if (n && out.indexOf(n) === -1) out.push(n)
    }
    ctx.body.customRepos = out
    ctx.body._reposNormalized = out.length
  }
  // 统一仓库清单：每个条目规范化 + 去重（与桌面版 config:set 一致）
  if (Array.isArray(ctx.body.repos)) {
    const { normalizeRepo } = require('../core/crawler')
    const seen = new Set(); const out = []
    for (const it of ctx.body.repos) {
      if (!it || !it.repo) continue
      const n = normalizeRepo(it.repo)
      const k = n ? n.toLowerCase() : ''
      if (!k || seen.has(k)) continue // GitHub 仓库名大小写不敏感，按小写去重避免同一仓库存两份
      seen.add(k)
      out.push({ repo: n, enabled: it.enabled !== false, builtin: !!it.builtin, origin: it.origin || 'custom' })
    }
    ctx.body.repos = out
  }
  const prevProxy = store.config.crawlProxy
  const prevPolicy = store.config.proxyPolicy
  store.saveConfig(ctx.body)
  const netmod = require('../core/net')
  // 换了代理地址或策略，旧的失败计数/冷却不该继承
  if (store.config.crawlProxy !== prevProxy || store.config.proxyPolicy !== prevPolicy) netmod.resetProxyHealth()
  netmod.applyConfig(store.config) // 网络设置改动即时生效
  return store.config
}))

// 网络连通性测试（设置页「测试」按钮）：对探针 URL 跑一遍候选链
route('POST', '/api/net/test', guard(async (req, res, ctx) => {
  const { testNetwork } = require('../core/net')
  return await testNetwork(ctx.body || {})
}))

// 逐镜像测速（设置页「测速」按钮）：每个镜像单独计时，供挑最快的固定下来
route('POST', '/api/net/mirror-test', guard(async (req, res, ctx) => {
  const { testMirrorSpeeds } = require('../core/net')
  return await testMirrorSpeeds(ctx.body || {})
}))

// 加速镜像自动发现（v1.9.19）：实测一批公开反代域名，通的进池、池内连续失败自动剔除（直连不参与）
route('POST', '/api/net/mirror-discover', guard(async (req, res, ctx) => {
  const b = ctx.body || {}
  // force：走与定时爬取同一条路径（无视 24h 时间窗），并写入 mirrorDiscoverAt
  if (b.force) {
    const r = await hunter.refreshMirrorPool(true)
    return r || { ok: false, error: '自动发现未执行（已在设置里关闭）' }
  }
  const { discoverMirrors } = require('../core/net')
  const r = await discoverMirrors(b)
  store.saveConfig({ mirrorPool: r.pool, mirrorDiscoverAt: Date.now() })
  pushLog({
    msg: `镜像自动发现：候选 ${r.total} 个，新增 ${r.added} 个、剔除失效 ${r.removed} 个、保留 ${r.kept} 个`,
    module: '网络', level: 'info', at: Date.now()
  })
  return r
}))

// 镜像池手动维护：{remove:[id]} 或 {enable:{id:true/false}}
route('POST', '/api/net/mirror-pool', guard(async (req, res, ctx) => {
  const b = ctx.body || {}
  let pool = Array.isArray(store.config.mirrorPool) ? store.config.mirrorPool.slice() : []
  if (Array.isArray(b.remove) && b.remove.length) pool = pool.filter(m => !b.remove.includes(m.id))
  if (b.enable && typeof b.enable === 'object') {
    for (const m of pool) if (b.enable[m.id] != null) m.enabled = !!b.enable[m.id]
  }
  store.saveConfig({ mirrorPool: pool })
  require('../core/net').applyConfig({ mirrorPool: pool })
  return { ok: true, pool }
}))

// 爬取代理有效性检测（v1.9.20 设置页「测试代理」按钮）：只验证代理本身通不通、耗时多少
route('POST', '/api/net/proxy-test', guard(async (req, res, ctx) => {
  const { testProxy } = require('../core/net')
  return await testProxy(ctx.body || {})
}))

// 代理健康状态（v1.11.0）：设置页显示熔断/退避；测试代理成功会自动恢复，
// 这里也给一个手动重置入口（用户修好代理后想立刻恢复，不必等冷却）
route('GET', '/api/net/proxy-health', guard(() => require('../core/net').getProxyHealth()))
route('POST', '/api/net/proxy-health/reset', guard(() => {
  const netmod = require('../core/net')
  netmod.resetProxyHealth()
  return netmod.getProxyHealth()
}))

// ---------------- 数据导入/导出（v1.9.20，仓库/采集站/镜像三类配置搬家）----------------
const dataio = require('../core/dataio')

// 导出：浏览器直接触发文件下载（桌面版走保存对话框，同一个 buildExport）
route('POST', '/api/data/export', guard(async (req, res, ctx) => {
  const scope = String((ctx.body && ctx.body.scope) || '')
  const json = JSON.stringify(dataio.buildExport(store, scope), null, 2)
  const day = new Date().toISOString().slice(0, 10)
  const names = { repos: 'lx-hunter-repos', hubs: 'lx-hunter-hubs', mirrors: 'lx-hunter-mirrors' }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${names[scope] || 'lx-hunter-data'}-${day}.json"`
  })
  res.end(json)
  return undefined // 已自行写完响应
}))

// 导入：{scope, raw}（raw 为导出文件原文），合并逻辑见 core/dataio
route('POST', '/api/data/import', guard(async (req, res, ctx) => {
  const b = ctx.body || {}
  const data = typeof b.raw === 'string' ? parseJsonBody(Buffer.from(b.raw)) : b.raw
  const summary = dataio.importData(store, String(b.scope || ''), data)
  pushLog({
    msg: `导入${summary.label}：新增 ${summary.added}、更新 ${summary.updated}（现有 ${summary.total} 条）`,
    module: '数据', level: 'info', at: Date.now()
  })
  // 与桌面版 data:import 返回同构：{imported, summary}
  return { imported: true, summary }
}))

route('POST', '/api/service/test', guard(async (req, res, ctx) => {
  const svc = resolveService(store.config, ctx.body)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  return await svc.adapter.verify(svc.acct)
}))

route('GET', '/api/service/list', guard(async () => {
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  return await svc.adapter.list(svc.acct)
}))

// 账本对账：liveIds 由渲染层传（就是它刚展示的那份列表），核心层不再多打一次服务端
route('POST', '/api/service/reconcile', guard(async (req, res, ctx) =>
  hunter.reconcileImported(ctx.body.platformId, ctx.body.liveIds)))

route('GET', '/api/sources', guard(() => {
  // 旧库数据没有 failKind（v1.6.5 前的深检结果）：就地补算一次
  const { deepFailKind } = require('../core/checker')
  for (const s of store.getSources()) {
    if (s.deep && s.deep.failKind == null) s.deep.failKind = deepFailKind(s.deep)
  }
  return {
    sources: store.getSources(),
    imported: store.imported,
    lastCrawl: store.db.lastCrawl,
    patrol: store.db.patrol || { lastRun: 0 }
  }
}))

route('GET', '/api/logs', guard(() => logs.slice(-800)))
route('POST', '/api/logs/clear', guard(() => { logs.length = 0; return true }))

// ---------------- 音源采集站（v1.9.19）----------------
// 第三方音源筛选站（lxhub 类）挂进来后，lx-hunter 自己上去采「站点实测可用」的音源。
// 判重零下载：站点返回的 sha256 与 lx-hunter contentHash 同算法（实测一致），直接采信。
const hubfeed = require('../core/hubfeed')

function normHub(h) {
  if (!h || !h.url) return null
  const url = String(h.url).trim().replace(/\/+$/, '')
  return {
    id: String(h.id || hubfeed.makeHubId(url)),
    name: String(h.name || url).slice(0, 80),
    url,
    kind: String(h.kind || ''),
    enabled: h.enabled !== false,
    entriesUrl: String(h.entriesUrl || ''),
    detailUrl: String(h.detailUrl || ''),
    lastSync: h.lastSync || null,
    addedAt: h.addedAt || Date.now()
  }
}

function hubList() { return Array.isArray(store.config.hubs) ? store.config.hubs : [] }

route('GET', '/api/hubs', guard(() => ({ hubs: hubList() })))

// 添加前试探：识别站点类型、返回可用条目数（不入库）
route('POST', '/api/hubs/test', guard(async (req, res, ctx) => {
  const url = String((ctx.body && ctx.body.url) || '').trim()
  if (!url) throw new Error('缺少站点地址')
  return await hubfeed.detectHub(url, store.config.timeoutMs)
}))

route('POST', '/api/hubs', guard(async (req, res, ctx) => {
  const b = ctx.body || {}
  const url = String(b.url || '').trim()
  if (!url) throw new Error('缺少站点地址')
  // 前端若已探测过（/api/hubs/test）就把结果带过来，避免同一个站重复探测一轮
  // ——慢站点（如 Cloudflare 后的 lxhub.lllh.de）挨个试候选地址可能要几十秒
  const det = (b.detect && b.detect.ok) ? b.detect : await hubfeed.detectHub(url, store.config.timeoutMs)
  if (!det.ok) return { ok: false, error: '无法识别为音源采集站：' + det.error }
  const list = hubList().slice()
  const key = url.replace(/\/+$/, '')
  if (list.some(h => String(h.url).replace(/\/+$/, '') === key)) return { ok: false, error: '该站点已在列表中' }
  const h = normHub({
    id: hubfeed.makeHubId(url), name: b.name || url, url,
    kind: det.kind, entriesUrl: det.entriesUrl, detailUrl: det.detailUrl
  })
  list.push(h)
  store.saveConfig({ hubs: list })
  pushLog({ msg: `已添加音源采集站「${h.name}」（${det.kindLabel}，实测可用 ${det.usable}/${det.total} 条）`, module: '采集', level: 'info', at: Date.now() })
  return { ok: true, hub: h, detect: det, hubs: list }
}))

// 改名 / 启停（enabled）
route('POST', '/api/hubs/update', guard(async (req, res, ctx) => {
  const b = ctx.body || {}
  const list = hubList()
  const i = list.findIndex(h => h.id === b.id)
  if (i < 0) throw new Error('站点不存在')
  if (b.name != null) list[i].name = String(b.name).slice(0, 80)
  if (b.enabled != null) list[i].enabled = !!b.enabled
  if (b.url != null) list[i].url = String(b.url).trim().replace(/\/+$/, '')
  store.saveConfig({ hubs: list })
  return { ok: true, hubs: list }
}))

route('POST', '/api/hubs/remove', guard(async (req, res, ctx) => {
  const b = ctx.body || {}
  const list = hubList().filter(h => h.id !== b.id)
  store.saveConfig({ hubs: list })
  pushLog({ msg: '已移除音源采集站：' + String(b.id || ''), module: '采集', level: 'info', at: Date.now() })
  return { ok: true, hubs: list }
}))

// 站外分发源（v1.11.0）：Pages / 自建域名 / 对象存储直链。
// 添加前先探测（直链脚本 / 压缩包 / 索引页三形态 + 与 GitHub 通道同口径的验真），
// 验真不过不让加；采集仍走 /api/crawl（only:[url] 行级，或全量/定时自动带上）。
route('GET', '/api/externals', guard(() => ({ sources: hunter.listExternalSources() })))
route('POST', '/api/externals/probe', guard(async (req, res, ctx) => await hunter.probeExternal(String((ctx.body || {}).url || ''))))
route('POST', '/api/externals', guard(async (req, res, ctx) => {
  const b = ctx.body || {}
  // 前端探测过就带上结果，避免同一个站重复下载一轮
  const det = b.detect || await hunter.probeExternal(String(b.url || ''))
  return { ok: true, sources: hunter.addExternalSource(String(b.url || ''), det) }
}))
route('POST', '/api/externals/update', guard(async (req, res, ctx) => {
  const b = ctx.body || {}
  return { ok: true, sources: hunter.updateExternalSource(String(b.url || ''), b.patch || {}) }
}))
route('POST', '/api/externals/remove', guard(async (req, res, ctx) => {
  return { ok: true, sources: hunter.removeExternalSource(String((ctx.body || {}).url || '')) }
}))

// 立即采集一轮（不跑 GitHub 爬取）
route('POST', '/api/hubs/sync', guard(async (req, res, ctx) => await hunter.runHubSync(ctx.body || {})))

route('POST', '/api/crawl', guard(async (req, res, ctx) => await hunter.runCrawl(ctx.body || {})))
// v1.10.3 非音源仓库清理：验真非内置仓库 → 移除确定性失败的（播放器/管理器/网关）→
// 连带删除它贡献的脚本并拉黑，避免下次发现又混进来。limit 控制本轮最多验真几个（省配额）。
route('POST', '/api/repos/prune', guard(async (req, res, ctx) => await hunter.pruneNonSourceRepos({
  limit: Number((ctx.body || {}).limit) || 40
})))
// v1.10.7 仓库行快捷拉黑：移出清单 + 加入黑名单（搜索发现/社区精选不再回填）+ 清残留脚本
route('POST', '/api/repos/block', guard(async (req, res, ctx) => await hunter.blockRepo(String((ctx.body || {}).repo || ''))))
route('POST', '/api/repos/unblock', guard(async (req, res, ctx) => await hunter.unblockRepo(String((ctx.body || {}).repo || ''), (ctx.body || {}).reAdd)))
route('POST', '/api/check', guard(async (req, res, ctx) => await hunter.runCheck(ctx.body.ids, ctx.body.opts)))
// v1.12.0 第三方探针对照（报告层只读）：按 sha256 对齐库内 contentHash，产出「我们 vs 对方」差异报告
route('GET', '/api/quality/crosscheck', guard(async () => await hunter.runCrosscheck()))
// 混淆隔离：信任/取消信任（v1.10.7）——body {id, trust}
route('POST', '/api/sources/trust-obf', guard(async (req, res, ctx) => await hunter.trustObfSource(String((ctx.body || {}).id || ''), !!(ctx.body || {}).trust)))
route('POST', '/api/hash', guard(async (req, res, ctx) => await hunter.runHash(ctx.body.ids)))
// v1.8.0：body.platformIds 可显式指定灌入目标（不给则用设置里标记「参与批量灌入」的账号）
route('POST', '/api/import', guard(async (req, res, ctx) => await hunter.runImport(ctx.body.ids, { platformIds: ctx.body.platformIds })))
route('POST', '/api/server/sync', guard(async () => await hunter.runSyncServer()))
route('POST', '/api/job/cancel', guard(() => ({ cancelled: hunter.requestCancel() })))
route('GET', '/api/job/state', guard(() => ({ running: hunter.job.running, type: hunter.job.type, progress: hunter.job.progress, step: hunter.job.step })))
route('POST', '/api/patrol', guard(async () => await hunter.runPatrol()))
route('POST', '/api/revoke', guard(async (req, res, ctx) => await hunter.runRevoke(ctx.body.ids)))
route('POST', '/api/db/undedupe', guard(() => {
  if (hunter.job.running) return { restored: 0, busy: true }
  return Object.assign({ busy: false }, hunter.restoreDedupe())
}))
route('POST', '/api/db/clear', guard(() => { store.clearSources(); return { ok: true } }))

// 手动删除选中音源（v1.10.2）：只动本地音源库，不动服务端已灌入的脚本。
// 被删的 id 记入 store.deletedIds（不再自动采集名单），设置页可一键清除记录。
route('POST', '/api/db/delete', guard((req, res, ctx) => {
  const ids = (ctx.body || {}).ids
  if (!Array.isArray(ids) || !ids.length) throw new Error('没有选中要删除的音源')
  const r = store.removeSources(ids)
  pushLog({
    msg: `手动删除音源 ${r.deleted} 条${r.missing.length ? `（${r.missing.length} 条库里已不存在）` : ''}；累计 ${r.blocked} 条不再自动采集` +
      (r.ledgerDropped ? `；同步清理 ${r.ledgerDropped} 条占位灌入账本` : ''),
    module: '音源库', level: 'info', at: Date.now()
  })
  return r
}))
route('POST', '/api/db/deleted/list', guard(() => ({ ids: store.deletedIds() })))
route('POST', '/api/db/deleted/clear', guard(() => {
  const r = store.clearDeletedIds()
  pushLog({ msg: `已清除 ${r.cleared} 条音源删除记录，后续自动采集可重新收录这些音源`, module: '音源库', level: 'info', at: Date.now() })
  return r
}))

// 导出：浏览器直接触发文件下载（替代桌面版的保存对话框）
route('POST', '/api/db/export', guard(async (req, res, ctx) => {
  const sources = store.getSources().map(x => { const c = Object.assign({}, x); delete c.checking; return c })
  let list = sources
  let imported = store.imported
  if (Array.isArray(ctx.body.ids) && ctx.body.ids.length) {
    const set = new Set(ctx.body.ids)
    list = sources.filter(s => set.has(s.id))
    const imp = {}
    for (const [k, v] of Object.entries(store.imported)) if (set.has(k)) imp[k] = v
    imported = imp
  }
  const json = JSON.stringify({
    version: 2, app: 'lx-hunter-pc', exportedAt: Date.now(),
    sources: list, imported, lastCrawl: store.db.lastCrawl
  }, null, 2)
  const day = new Date().toISOString().slice(0, 10)
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="lx-hunter-sources-${day}.json"`,
    'X-Count': String(list.length)
  })
  res.end(json)
  return undefined // 已自行写完响应
}))

// 导入：接收网页上传的 JSON 原文（替代桌面版的打开对话框），合并检测结果
route('POST', '/api/db/import', guard(async (req, res, ctx) => {
  const data = parseJsonBody(ctx.raw)
  const summary = store.mergeFrom(data)
  return { imported: true, summary }
}))

route('POST', '/api/source/validate', guard(async (req, res, ctx) => {
  const entry = store.db.sources[ctx.body.id]
  if (!entry) throw new Error('音源不存在')
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  const { crawlFetch, readText } = require('../core/net')
  const { res: r } = await crawlFetch(entry.url, null, store.config.timeoutMs, store.config.mirror)
  if (!r || !r.ok) throw new Error('脚本下载失败')
  const code = await readText(r, store.config.timeoutMs)
  const out = await svc.adapter.validate(svc.acct, code)
  return { status: out.status, data: out.data, text: out.text }
}))

route('POST', '/api/import/url', guard(async (req, res, ctx) => {
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  const { crawlFetch, readText } = require('../core/net')
  const { url, name } = ctx.body
  let r = null
  const { res: fr } = await crawlFetch(url, null, store.config.timeoutMs, store.config.mirror)
  if (fr && fr.ok) {
    const code = await readText(fr, store.config.timeoutMs)
    r = await svc.adapter.upload(svc.acct, code, name)
  } else {
    r = await svc.adapter.importUrl(svc.acct, url, name)
  }
  if (r.success) {
    store.imported['manual:' + r.id] = {
      lxId: r.id, name: r.name || name || url, contentHash: '',
      serverUrl: svc.adapter.baseUrl(svc.acct), importedAt: Date.now(), platforms: r.platforms || [],
      platformId: svc.acct.id, platformType: svc.type, accountName: svc.acct.name
    }
    store.saveImported()
  }
  return r
}))

route('POST', '/api/service/toggle', guard(async (req, res, ctx) => {
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  return await svc.adapter.toggle(svc.acct, ctx.body.id, ctx.body.enabled, { owner: ctx.body.owner })
}))
route('POST', '/api/service/remove', guard(async (req, res, ctx) => {
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  return await svc.adapter.remove(svc.acct, ctx.body.id, { owner: ctx.body.owner })
}))
route('POST', '/api/service/platforms', guard(async (req, res, ctx) => {
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  return await svc.adapter.setPlatforms(svc.acct, ctx.body.id, ctx.body.disabledSources, { owner: ctx.body.owner })
}))

// 公共音源清理（v1.7.4，与桌面版 service:listPublic / service:removePublicBatch 对应）：
// 只删服务端公开源（_open），绝不碰各账号私有源；批删串行，逐条返回结果。
// 仅 LX Server / Geelonn LX Server 平台具备该能力，其他平台返回友好提示。
route('GET', '/api/service/list/public', guard(async () => {
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  if (svc.type !== 'lxserver' && svc.type !== 'geelonn') return { ok: false, error: '当前平台（' + TYPE_LABELS[svc.type] + '）不支持公共音源清理，仅 LX Server / Geelonn LX Server 支持' }
  return await svc.adapter.listPublic(svc.acct)
}))
// 批删串行且每个都要等服务端全量重载：逐个 pushLog（经 SSE 实时到达），
// 同时发 pub-delete 事件，渲染进程与桌面版一样能显示「第 n/N 个」进度
route('POST', '/api/service/remove/public', guard(async (req, res, ctx) => {
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  if (svc.type !== 'lxserver' && svc.type !== 'geelonn') return { ok: false, error: '当前平台（' + TYPE_LABELS[svc.type] + '）不支持公共音源清理，仅 LX Server / Geelonn LX Server 支持' }
  return await svc.adapter.removePublicBatch(svc.acct, ctx.body.ids, (done, total, item) => {
    pushLog({
      msg: `删除公共音源 ${done}/${total}：${item.id}${item.success ? '' : ' — 失败：' + item.message}`,
      module: '服务', level: item.success ? 'info' : 'warn', at: Date.now()
    })
    emitAll('pub-delete', { done, total, id: item.id, success: item.success })
  })
}))

// ---------------- 登录（v1.10.0） ----------------
// 当前会话状态：{ loggedIn, user, hasUsers } —— 前端据此显示登录页/注册首个管理员/正常界面
route('GET', '/api/auth/state', guard((req) => {
  const me = currentUser(req)
  return { loggedIn: !!me, user: me || null, hasUsers: auth.hasUsers() }
}))

// 首次使用：注册管理员（仅当用户表为空）
route('POST', '/api/auth/register', guard(async (req, res, ctx) => {
  const b = ctx.body || {}
  const user = auth.registerFirst(b.name, b.password)
  setSessionCookie(res, auth.createSession(user.name))
  pushLog({ msg: `已创建管理员账号「${user.name}」（首次使用注册）`, module: '登录', level: 'info', at: Date.now() })
  return { ok: true, user: { name: user.name, admin: true } }
}))

route('POST', '/api/auth/login', guard(async (req, res, ctx) => {
  const b = ctx.body || {}
  if (!auth.hasUsers()) throw new Error('还没有任何账号，请先注册管理员')
  const user = auth.verify(b.name, b.password, clientIp(req))
  setSessionCookie(res, auth.createSession(user.name))
  pushLog({ msg: `账号「${user.name}」已登录`, module: '登录', level: 'info', at: Date.now() })
  return { ok: true, user }
}))

route('POST', '/api/auth/logout', guard((req, res) => {
  auth.destroySession(readCookie(req, 'lxh_token'))
  clearSessionCookie(res)
  return { ok: true }
}))

// 账号管理（仅管理员）
route('GET', '/api/auth/users', guard((req) => {
  const me = currentUser(req)
  if (!me || !me.admin) throw new Error('仅管理员可查看账号列表')
  return { users: auth.listUsers() }
}))

route('POST', '/api/auth/users', guard(async (req, res, ctx) => {
  const me = currentUser(req)
  if (!me || !me.admin) throw new Error('仅管理员可添加账号')
  const b = ctx.body || {}
  const u = auth.addUser(b.name, b.password, b.admin === true)
  pushLog({ msg: `管理员「${me.name}」已添加账号「${u.name}」${u.admin ? '（管理员）' : ''}`, module: '登录', level: 'info', at: Date.now() })
  return { ok: true, users: auth.listUsers() }
}))

route('POST', '/api/auth/users/delete', guard(async (req, res, ctx) => {
  const me = currentUser(req)
  if (!me || !me.admin) throw new Error('仅管理员可删除账号')
  auth.deleteUser((ctx.body || {}).name, me.name)
  pushLog({ msg: `管理员「${me.name}」已删除账号「${String((ctx.body || {}).name || '')}」`, module: '登录', level: 'info', at: Date.now() })
  return { ok: true, users: auth.listUsers() }
}))

// 管理员重置他人密码
route('POST', '/api/auth/users/reset', guard(async (req, res, ctx) => {
  const me = currentUser(req)
  if (!me || !me.admin) throw new Error('仅管理员可重置密码')
  const b = ctx.body || {}
  auth.adminReset(b.name, b.password)
  pushLog({ msg: `管理员「${me.name}」已重置账号「${String(b.name || '')}」的密码`, module: '登录', level: 'info', at: Date.now() })
  return { ok: true }
}))

// 自己改密码（需验原密码）
route('POST', '/api/auth/password', guard(async (req, res, ctx) => {
  const me = currentUser(req)
  if (!me) throw new Error('未登录')
  const b = ctx.body || {}
  auth.changePassword(me.name, b.oldPassword, b.newPassword)
  pushLog({ msg: `账号「${me.name}」已修改自己的密码`, module: '登录', level: 'info', at: Date.now() })
  return { ok: true }
}))

// ---------------- 单个音源导入（v1.10.0，标记私人） ----------------
// 需求：音源库支持导入单个 .js 音源文件，导入即标「私人音源」——
// 不参与去重废弃、也不参与健康巡检（保护规则见 hunter.js buildPatrolItems / store.addPrivateSource）。
route('POST', '/api/source/import-single', guard(async (req, res, ctx) => {
  const b = ctx.body || {}
  const r = store.addPrivateSource(b.name, b.code)
  pushLog({
    msg: `${r.added ? '已导入私人音源' : '已更新私人音源（重新导入）'}「${r.entry.name}」（不参与去重与巡检，可手动检测 / 灌入）`,
    module: '音源库', level: 'info', at: Date.now()
  })
  return { imported: true, added: r.added, updated: r.updated, entry: Object.assign({}, r.entry, { code: undefined }) }
}))

// 打开数据目录：Web 版无「资源管理器」概念，返回路径供展示/复制
route('POST', '/api/datadir', guard(() => ({ path: DATA_DIR })))

// ---------------- HTTP 服务 ----------------
// 登录门禁（v1.10.0）：/api/health 与 /api/auth/* 公开，其余 /api/*（含 SSE）一律要求会话；
// 静态页面公开（登录界面就在 index.html 里，登录后才有数据可见）。
function isPublicApi(pathname) {
  if (pathname === '/api/health') return true
  if (pathname.startsWith('/api/auth/')) return true
  return false
}

const server = http.createServer(async (req, res) => {
  let pathname = '/'
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname) } catch (e) {}
  try {
    if (req.method === 'GET' && pathname === '/api/events') {
      if (!currentUser(req)) return sendJson(res, 401, { ok: false, error: '未登录或登录已过期', authRequired: true })
      return sseHandler(req, res)
    }
    if (pathname.startsWith('/api/')) {
      if (!isPublicApi(pathname) && !currentUser(req)) {
        return sendJson(res, 401, { ok: false, error: '未登录或登录已过期', authRequired: true })
      }
    }
    for (const r of routes) {
      if (r.method !== req.method || r.pattern !== pathname) continue
      let raw = null
      let body = {}
      if (req.method === 'POST' || req.method === 'PUT') {
        raw = await readBody(req)
        if (r.pattern !== '/api/db/import') body = parseJsonBody(raw) // 导入接口原文交给 mergeFrom 解析
      }
      return await r.handler(req, res, { body, raw })
    }
    if (req.method === 'GET' || req.method === 'HEAD') return staticHandler(req, res, pathname)
    return sendJson(res, 404, { ok: false, error: 'not found: ' + pathname })
  } catch (e) {
    return sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
  }
})

// 长任务为长轮询语义：关掉 Node 默认的请求超时（否则几分钟的爬取会被切断）
server.requestTimeout = 0
server.headersTimeout = 0
server.keepAliveTimeout = 75000

// ---------------- 启动 ----------------
store = new Store(DATA_DIR)
hunter = new Hunter(store, emitAll)
// 网络加速配置（爬取代理/强制代理/jsDelivr 开关/自定义镜像）在启动时同步到网络层
require('../core/net').applyConfig(store.config)

server.listen(PORT, '0.0.0.0', () => {
  const portNote = (PUBLIC_PORT && PUBLIC_PORT !== PORT)
    ? `外部访问端口 ${PUBLIC_PORT}（容器内监听 ${PORT}）`
    : `端口 ${PORT}（容器部署时请按宿主机映射端口访问）`
  pushLog({
    msg: `音源猎手 Web/Docker 版已启动：${portNote}，数据目录 ${DATA_DIR}（挂载卷迁移数据；界面功能与 PC 桌面版一致）`,
    module: '系统', level: 'info', at: Date.now()
  })
  console.log(`[web] lx-hunter-pc listening on :${PORT}${PUBLIC_PORT && PUBLIC_PORT !== PORT ? ` (public :${PUBLIC_PORT})` : ''}, dataDir=${DATA_DIR}`)

  // 定时巡检 / 定时爬取（与桌面版同一套逻辑，v1.9.0 起爬取可接自动灌入）
  // 「每分钟检查一次」是**轮询节奏**，不是**执行频率**：到期判据 = 距上次执行 ≥ 设置里的间隔，
  // 所以设 2 天就是每 2 天跑一次（最多晚 1 分钟），容器需保持运行。
  setInterval(() => {
    try {
      if (!store || !hunter) return
      const cfg = store.config
      if (!cfg.patrolEnabled || hunter.job.running) return
      const sched = patrolSchedule(cfg, store.db.patrol, Date.now())
      const last = sched.last
      const hours = sched.hours
      // 主判据仍是「距上次执行 ≥ 设定间隔」；上一轮失败时另按 patrolRetryMinutes 退避。
      // 关键：触发前就写 lastAttempt。旧代码只在 runPatrol 成功收尾写 lastRun，推送服务端一关，
      // 每分钟轮询都会判「到期」并真跑一轮，日志被 fetch failed 刷屏（2026-11-06 实测）。
      if (Date.now() - last >= hours * 3600 * 1000 || sched.dueByRetry) {
        store.db.patrol = Object.assign({}, store.db.patrol, { lastAttempt: Date.now(), lastError: null })
        store.saveDb()
        pushLog({
          msg: sched.failed
            ? `上次巡检未成功，按失败重试间隔 ${sched.retryMinutes} 分钟后重试…`
            : `定时巡检到期（间隔 ${formatIntervalHours(hours)}），开始重测已灌入音源…`,
          module: '巡检', level: 'info', at: Date.now()
        })
        hunter.runPatrol()
          .then(() => {
            store.db.patrol = Object.assign({}, store.db.patrol, { lastError: null })
            store.saveDb()
          })
          .catch(e => {
            const msg = String((e && e.message) || e)
            store.db.patrol = Object.assign({}, store.db.patrol, { lastError: msg })
            store.saveDb()
            pushLog({
              msg: `定时巡检失败：${msg}；已按 ${sched.retryMinutes} 分钟延后重试，不会每分钟重复尝试（可在设置里调整失败重试间隔，或关闭「启用定时巡检」）`,
              module: '巡检', level: 'error', at: Date.now()
            })
          })
      }
    } catch (e) {}
  }, 60 * 1000)

  setInterval(() => {
    try {
      if (!store || !hunter) return
      const cfg = store.config
      if (!cfg.crawlScheduleEnabled || hunter.job.running) return
      const last = store.db.lastCrawl || 0
      const hours = Math.max(1, Number(cfg.crawlIntervalHours) || 24)
      if (Date.now() - last < hours * 3600 * 1000) return
      const span = formatIntervalHours(hours)
      if (cfg.crawlAutoImport) {
        pushLog({ msg: `定时爬取到期（间隔 ${span}），开始「增量爬取 → 检测 → 自动灌入」…`, module: '爬取', level: 'info', at: Date.now() })
        hunter.runAutoPipeline().catch(e => pushLog({ msg: '定时任务失败：' + String((e && e.message) || e), module: '爬取', level: 'error', at: Date.now() }))
      } else {
        pushLog({ msg: `定时爬取到期（间隔 ${span}），开始增量爬取（文件树 + Releases 资产）…`, module: '爬取', level: 'info', at: Date.now() })
        hunter.runCrawl({ incremental: true }).catch(e => pushLog({ msg: '定时爬取失败：' + String((e && e.message) || e), module: '爬取', level: 'error', at: Date.now() }))
      }
    } catch (e) {}
  }, 60 * 1000)
})
