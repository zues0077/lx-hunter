'use strict'
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const { Store } = require('../core/store')
const { Hunter, formatIntervalHours } = require('../core/hunter')
const { getActiveService, resolveService, TYPE_LABELS, NO_ACCOUNT_ERR } = require('../core/services')

let win = null
let store = null
let hunter = null
const logs = []
const MAX_LOGS = 3000

// ---- 主进程异常兜底 ----
// 音源脚本是不可信代码，沙箱内异步回调的极个别异常不应打断主进程（弹系统错误框）。
process.on('uncaughtException', err => {
  const first = String((err && err.stack) || err).split('\n')[0]
  console.error('[main] uncaughtException:', err)
  try { pushLog({ msg: '已捕获主进程异常（不影响使用）：' + first.slice(0, 160), module: '系统', level: 'error', at: Date.now() }) } catch (e) {}
})
// 音源脚本自身未捕获的 Promise 异常非常多（脚本质量参差不齐），同一个脚本可能刷出几十条。
// 这里做「同消息 10 秒内只报一次 + 计数」，避免日志被脚本噪声淹没。
const rejSeen = new Map()
process.on('unhandledRejection', err => {
  const first = String((err && err.stack) || err).split('\n')[0].slice(0, 160)
  console.error('[main] unhandledRejection:', err)
  try {
    const now = Date.now()
    const prev = rejSeen.get(first)
    if (prev && now - prev.at < 10000) {
      prev.n++
      return
    }
    if (prev && prev.n > 1) {
      pushLog({ msg: `（另有 ${prev.n} 条同类脚本异常已合并，未逐条展开）`, module: '系统', level: 'warn', at: now })
    }
    rejSeen.set(first, { at: now, n: 1 })
    if (rejSeen.size > 200) rejSeen.clear()
    // 脚本内部异常不是本工具的故障，明确标注来源，避免误以为程序出错
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
  if (win && !win.isDestroyed()) win.webContents.send('hunter:log', e)
}

function emitAll(type, payload) {
  if (type === 'log') { pushLog(payload); return }
  if (win && !win.isDestroyed()) win.webContents.send('hunter:event', { type, payload })
}

// ---- 便携数据目录（v1.7.3）：数据与软件同目录 ----
// 需求：软件数据与软件本身在同一文件夹，拷贝整个软件目录到 B 电脑，数据不丢。
// 便携根目录的识别逻辑与旧数据迁移在 src/core/portable.js（纯函数，有单测）。
// 目标目录不可写（如装进 Program Files）时回退系统用户目录（旧版行为），功能不受影响。
let dataDir = null
function getDataDir() {
  if (!dataDir) dataDir = path.join(app.getPath('userData'), 'data')
  return dataDir
}
function setupPortableMode() {
  const { resolvePortableRoot, migrateLegacyData } = require('../core/portable')
  // 开发模式（electron .）下模块顶层拿不到 app.getPath —— 此时 app 尚未就绪，
  // 取 path 会抛 TypeError 并让整个主进程挂掉。开发模式没有便携意图，直接跳过。
  if (!app.isPackaged) return null
  const legacyUserData = app.getPath('userData')
  const portableRoot = resolvePortableRoot(process.env, path.dirname(app.getPath('exe')))
  if (!portableRoot) return null
  const newUserData = path.join(portableRoot, 'userData')
  try {
    fs.mkdirSync(newUserData, { recursive: true })
    const probe = path.join(newUserData, '.write-probe')
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    app.setPath('userData', newUserData)
    const migrated = migrateLegacyData(path.join(legacyUserData, 'data'), path.join(newUserData, 'data'))
    return { root: newUserData, migrated }
  } catch (e) {
    console.warn('[portable] 数据目录不可写，回退系统用户目录：', (e && e.message) || e)
    return { error: String((e && e.message) || e) }
  }
}
// 必须在 new Store / app.whenReady 之前重定向 userData，后续所有 getPath('userData') 才一致
const portableInfo = setupPortableMode()

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: '音源猎手 PC 版',
    backgroundColor: '#14161c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
}

app.whenReady().then(() => {
  if (portableInfo && portableInfo.root) {
    pushLog({
      msg: `便携模式：数据目录 ${getDataDir()}（与软件同目录；拷贝整个软件文件夹即可迁移到其他电脑）` +
        (portableInfo.migrated ? `；已从旧数据目录迁移 ${portableInfo.migrated} 个文件（原文件保留作备份）` : ''),
      module: '系统', level: 'info', at: Date.now()
    })
  } else if (portableInfo && portableInfo.error) {
    pushLog({ msg: '便携数据目录不可写，已回退系统用户目录：' + portableInfo.error, module: '系统', level: 'warn', at: Date.now() })
  }
  store = new Store(getDataDir())
  hunter = new Hunter(store, emitAll)
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  // ---- 定时任务：巡检 / 爬取（v1.7.0 起，v1.9.0 起爬取可接自动灌入）----
  // 「每分钟检查一次」是**轮询节奏**，不是**执行频率**：到期判据 = 距上次执行 ≥ 设置里的间隔，
  // 所以设 2 天就是每 2 天跑一次（最多晚 1 分钟），应用需保持运行。
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
  // 定时爬取：到期后跑增量爬取（文件树 + Releases），已抓取的按 blob sha / 资产标识判重跳过，
  // 只收新音源；内容有变化的就地更新并重置检测结果。
  // 勾了「爬取结束后自动灌入」则走 runAutoPipeline：爬取 → 检测新增/变化音源 → 灌入可用音源。
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

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// ---------------- IPC ----------------
function guard(fn) {
  return async (event, ...args) => {
    try { return { ok: true, data: await fn(event, ...args) } }
    catch (e) { return { ok: false, error: String((e && e.message) || e) } }
  }
}

ipcMain.handle('config:get', guard(() => ({ config: store.config, dataDir: getDataDir() })))

ipcMain.handle('config:set', guard((e, patch) => {
  // 附加仓库做规范化（支持完整 URL），避免 Not Found
  if (Array.isArray(patch.customRepos)) {
    const { normalizeRepo } = require('../core/crawler')
    const out = []
    for (const r of patch.customRepos) {
      const n = normalizeRepo(r)
      if (n && out.indexOf(n) === -1) out.push(n)
    }
    patch.customRepos = out
    patch._reposNormalized = patch.customRepos.length
  }
  store.saveConfig(patch)
  return store.config
}))

ipcMain.handle('service:test', guard(async (e, cfgOverride) => {
  const svc = resolveService(store.config, cfgOverride)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  return await svc.adapter.verify(svc.acct)
}))

ipcMain.handle('service:list', guard(async () => {
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  return await svc.adapter.list(svc.acct)
}))

// 账本对账：渲染层刚读到该账号的服务端列表，把「服务端已不存在」的灌入记录摘掉。
// liveIds 由渲染层传（就是它刚展示的那份列表），核心层不再多打一次服务端。
ipcMain.handle('service:reconcile', guard(async (e, platformId, liveIds) => {
  return hunter.reconcileImported(platformId, liveIds)
}))

ipcMain.handle('sources:get', guard(() => {
  // 旧库数据没有 failKind（v1.6.5 前的深检结果）：就地补算一次，
  // 失效统计/筛选/徽章立即生效，并在下次落库时持久化
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

ipcMain.handle('logs:get', guard(() => logs.slice(-800)))

ipcMain.handle('logs:clear', guard(() => { logs.length = 0; return true }))

ipcMain.handle('crawl:start', guard(async () => {
  const r = await hunter.runCrawl()
  return r
}))

ipcMain.handle('check:start', guard(async (e, ids, opts) => {
  return await hunter.runCheck(ids, opts)
}))

// 快速去重：只下载 + 内容哈希，不进沙箱
ipcMain.handle('hash:start', guard(async (e, ids) => {
  return await hunter.runHash(ids)
}))

// v1.8.0：opts.platformIds 可显式指定灌入目标（不给则用设置里标记「参与批量灌入」的账号）
ipcMain.handle('import:start', guard(async (e, ids, opts) => {
  return await hunter.runImport(ids, opts)
}))

// 同步服务端已有音源 → 全部纳入管理，算作「已灌入」
ipcMain.handle('server:sync', guard(async () => await hunter.runSyncServer()))

ipcMain.handle('job:cancel', guard(() => ({ cancelled: hunter.requestCancel() })))

ipcMain.handle('job:state', guard(() => ({ running: hunter.job.running, type: hunter.job.type, progress: hunter.job.progress, step: hunter.job.step })))

ipcMain.handle('patrol:start', guard(async () => await hunter.runPatrol()))

ipcMain.handle('revoke', guard(async (e, ids) => await hunter.runRevoke(ids)))

ipcMain.handle('db:undedupe', guard(() => {
  if (hunter.job.running) return { restored: 0, busy: true }
  const r = hunter.restoreDedupe()
  return Object.assign({ busy: false }, r)
}))

ipcMain.handle('db:clear', guard(() => {
  store.clearSources()
  return { ok: true }
}))

ipcMain.handle('db:export', guard(async (e, ids) => {
  const res = await dialog.showSaveDialog(win, {
    title: '导出音源库（含检测结果，可导入到其他机器）',
    defaultPath: `lx-hunter-sources-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (res.canceled || !res.filePath) return { exported: false }
  const sources = store.getSources().map(x => { const c = Object.assign({}, x); delete c.checking; return c })
  let list = sources
  let imported = store.imported
  if (Array.isArray(ids) && ids.length) {
    const set = new Set(ids)
    list = sources.filter(s => set.has(s.id))
    const imp = {}
    for (const [k, v] of Object.entries(store.imported)) if (set.has(k)) imp[k] = v
    imported = imp
  }
  fs.writeFileSync(res.filePath, JSON.stringify({
    version: 2, app: 'lx-hunter-pc', exportedAt: Date.now(),
    sources: list, imported, lastCrawl: store.db.lastCrawl
  }, null, 2), 'utf8')
  return { exported: true, path: res.filePath, count: list.length }
}))

// 导入音源库：按 id / contentHash 合并检测结果，换机迁移不用重跑
ipcMain.handle('db:import', guard(async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '导入音源库（合并检测结果）',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  })
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { imported: false }
  const raw = fs.readFileSync(res.filePaths[0], 'utf8')
  let data
  try { data = JSON.parse(raw) } catch (e) { throw new Error('文件不是有效的 JSON：' + String(e.message || e).slice(0, 80)) }
  const summary = store.mergeFrom(data)
  return { imported: true, summary, path: res.filePaths[0] }
}))

// 对单条音源做「校验脚本」：提交给服务端 validate（不落盘）
ipcMain.handle('source:validate', guard(async (e, id) => {
  const entry = store.db.sources[id]
  if (!entry) throw new Error('音源不存在')
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  const { crawlFetch, readText } = require('../core/net')
  const { res } = await crawlFetch(entry.url, null, store.config.timeoutMs, store.config.mirror)
  if (!res || !res.ok) throw new Error('脚本下载失败')
  const code = await readText(res, store.config.timeoutMs)
  const r = await svc.adapter.validate(svc.acct, code)
  return { status: r.status, data: r.data, text: r.text }
}))

// 手动填 URL 灌入（PC 端下载后直传内容，服务端无需出网）
ipcMain.handle('import:url', guard(async (e, url, name) => {
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  const { crawlFetch, readText } = require('../core/net')
  let r = null
  const { res } = await crawlFetch(url, null, store.config.timeoutMs, store.config.mirror)
  if (res && res.ok) {
    const code = await readText(res, store.config.timeoutMs)
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

ipcMain.handle('service:toggle', guard(async (e, id, enabled, owner) => {
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  return await svc.adapter.toggle(svc.acct, id, enabled, { owner })
}))
ipcMain.handle('service:remove', guard(async (e, id, owner) => {
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  return await svc.adapter.remove(svc.acct, id, { owner })
}))
// 停用/启用（走 update-platforms，不触发服务端全量重载，不会假死）
// owner：源的归属身份，私有源（owner=admin 等）的停用必须写其身份那份 states 才生效
ipcMain.handle('service:platforms', guard(async (e, id, disabledSources, owner) => {
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  return await svc.adapter.setPlatforms(svc.acct, id, disabledSources, { owner })
}))

// 公共音源清理（v1.7.4）：只删服务端公开源（_open），绝不碰各账号私有源；
// 仅 LX Server 平台具备该能力，其他平台（Songloft / MusicSync）返回友好提示。
ipcMain.handle('service:listPublic', guard(async () => {
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  if (svc.type !== 'lxserver') return { ok: false, error: '当前平台（' + TYPE_LABELS[svc.type] + '）不支持公共音源清理，仅 LX Server 支持' }
  return await svc.adapter.listPublic(svc.acct)
}))
// 批量删除：服务端每次 delete 都会全量重载脚本（几十秒），串行执行并逐个上报进度
ipcMain.handle('service:removePublicBatch', guard(async (e, ids) => {
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  if (svc.type !== 'lxserver') return { ok: false, error: '当前平台（' + TYPE_LABELS[svc.type] + '）不支持公共音源清理，仅 LX Server 支持' }
  return await svc.adapter.removePublicBatch(svc.acct, ids, (done, total, item) => {
    emitAll('log', {
      msg: `删除公共音源 ${done}/${total}：${item.id}${item.success ? '' : ' — 失败：' + item.message}`,
      module: '服务', level: item.success ? 'info' : 'warn', at: Date.now()
    })
    emitAll('event', { type: 'pub-delete', payload: { done, total, id: item.id, success: item.success } })
  })
}))

ipcMain.handle('app:openDataDir', guard(() => {
  shell.openPath(getDataDir())
  return true
}))
