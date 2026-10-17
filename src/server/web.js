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
const { Hunter, formatIntervalHours } = require('../core/hunter')
const { getActiveService, resolveService, TYPE_LABELS, NO_ACCOUNT_ERR } = require('../core/services')
const { DEFAULT_REPOS } = require('../core/crawler')

const PORT = Number(process.env.PORT || 7970)
const DATA_DIR = process.env.DATA_DIR || '/data'
const RENDERER_DIR = path.join(__dirname, '..', 'renderer')
const MAX_BODY = 192 * 1024 * 1024 // 导入音源库 JSON 可能几十 MB，放宽上限

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
    try { sendJson(res, 200, { ok: true, data: await fn(req, res, ctx) }) }
    catch (e) { sendJson(res, 200, { ok: false, error: String((e && e.message) || e) }) }
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
  store.saveConfig(ctx.body)
  require('../core/net').applyConfig(store.config) // 网络设置改动即时生效
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

route('POST', '/api/crawl', guard(async () => await hunter.runCrawl()))
route('POST', '/api/check', guard(async (req, res, ctx) => await hunter.runCheck(ctx.body.ids, ctx.body.opts)))
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

// 打开数据目录：Web 版无「资源管理器」概念，返回路径供展示/复制
route('POST', '/api/datadir', guard(() => ({ path: DATA_DIR })))

// ---------------- HTTP 服务 ----------------
const server = http.createServer(async (req, res) => {
  let pathname = '/'
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname) } catch (e) {}
  try {
    if (req.method === 'GET' && pathname === '/api/events') return sseHandler(req, res)
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
  pushLog({
    msg: `音源猎手 Web/Docker 版已启动：端口 ${PORT}，数据目录 ${DATA_DIR}（挂载卷迁移数据；界面功能与 PC 桌面版一致）`,
    module: '系统', level: 'info', at: Date.now()
  })
  console.log(`[web] lx-hunter-pc listening on :${PORT}, dataDir=${DATA_DIR}`)

  // 定时巡检 / 定时爬取（与桌面版同一套逻辑，v1.9.0 起爬取可接自动灌入）
  // 「每分钟检查一次」是**轮询节奏**，不是**执行频率**：到期判据 = 距上次执行 ≥ 设置里的间隔，
  // 所以设 2 天就是每 2 天跑一次（最多晚 1 分钟），容器需保持运行。
  setInterval(() => {
    try {
      if (!store || !hunter) return
      const cfg = store.config
      if (!cfg.patrolEnabled || hunter.job.running) return
      const last = (store.db.patrol && store.db.patrol.lastRun) || 0
      const hours = Math.max(1, Number(cfg.patrolIntervalHours) || 12)
      if (Date.now() - last >= hours * 3600 * 1000) {
        pushLog({ msg: `定时巡检到期（间隔 ${formatIntervalHours(hours)}），开始重测已灌入音源…`, module: '巡检', level: 'info', at: Date.now() })
        hunter.runPatrol().catch(e => pushLog({ msg: '定时巡检失败：' + String((e && e.message) || e), module: '巡检', level: 'error', at: Date.now() }))
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
