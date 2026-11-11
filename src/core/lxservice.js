'use strict'
/**
 * 自建 LX MUSIC 服务（XCQ0607/lxserver）客户端
 * 灌入走 /api/custom-source/* ，鉴权头 x-frontend-auth = frontend.password
 */
const { fetchWithTimeout } = require('./net')

function baseUrl(cfg) { return String(cfg.serverUrl || '').replace(/\/+$/, '') }

async function req(cfg, method, path, bodyObj, timeoutMs) {
  const url = baseUrl(cfg) + path
  const headers = { 'Content-Type': 'application/json' }
  if (cfg.adminPassword) headers['x-frontend-auth'] = cfg.adminPassword
  const init = { method, headers }
  if (bodyObj !== undefined) init.body = JSON.stringify(bodyObj)
  const res = await fetchWithTimeout(url, init, timeoutMs || cfg.serverTimeoutMs || 20000)
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch (e) { data = null }
  return { ok: res.ok, status: res.status, data, text }
}

/** 连通性 / 密码校验 */
async function verify(cfg) {
  if (!baseUrl(cfg)) return { ok: false, msg: '未配置服务地址' }
  try {
    const r = await req(cfg, 'POST', '/api/admin/verify', {})
    if (r.ok && r.data && r.data.success) return { ok: true, msg: '已连接，管理员密码正确' }
    return { ok: false, msg: (r.data && r.data.error) || `HTTP ${r.status}（管理员密码错误或服务异常）` }
  } catch (e) {
    return { ok: false, msg: '无法连接：' + String((e && e.message) || e) }
  }
}

/**
 * 服务端已有音源列表（合并视图）
 *
 * 身份口径（v1.6.6/v1.6.7）：平台停用状态按身份分文件存。读回以 default（→_open）
 * 视角为主 —— 这正是 LX 网页端音源管理页读的口径，保证猎手「已灌入」页的停用徽章
 * 与网页端显示一致；若配置了具名用户（如 admin），再把其私有源按 id 补充进来
 * （公开源优先，同 id 时以公开源条目为准，与网页端去重逻辑一致）。
 * 私有源（owner=admin 等）带 owner 字段返回，停用写入时按它路由身份（见 setPlatforms）。
 */
async function list(cfg) {
  const user = String((cfg && cfg.username) || 'default').trim()
  const openList = await listAs(cfg, 'default')
  if (!user || user === 'default' || user === 'open' || user === '_open') return openList
  let privateList = []
  try { privateList = await listAs(cfg, user) } catch (e) { /* 私有源读失败不致命 */ }
  const byId = new Map(openList.map(s => [s && s.id, s]))
  for (const s of privateList) {
    if (s && s.id && !byId.has(s.id)) byId.set(s.id, s)
  }
  return Array.from(byId.values())
}

/** 按指定身份拉取服务端音源列表 */
async function listAs(cfg, username) {
  const r = await req(cfg, 'GET', `/api/custom-source/list?username=${encodeURIComponent(username)}`)
  if (!r.ok) throw new Error((r.data && r.data.error) || `HTTP ${r.status}`)
  return Array.isArray(r.data) ? r.data : []
}

/**
 * 服务端自检护栏的隔离名单（v1.13.0）
 *
 * 隔离 ≠ 禁用：服务端只是把脚本从沙箱里卸载了，列表里仍然 enabled=true，
 * 所以光看 /custom-source/list 发现不了「服务端已经否定过它」。灌入前必须读这份名单。
 * 老版本服务端没有这个接口（404）→ 返回 []，不影响既有灌入流程。
 */
async function listIsolations(cfg) {
  try {
    const r = await req(cfg, 'GET', '/api/source-guard/isolations')
    if (!r.ok || !r.data || !Array.isArray(r.data.list)) return []
    return r.data.list.map(x => (x && (x.id || x.sourceId)) || '').filter(Boolean)
  } catch (e) {
    return []
  }
}

/** 校验脚本（不落盘），返回元信息与支持平台（身份与灌入口径一致） */
async function validate(cfg, script) {
  const r = await req(cfg, 'POST', '/api/custom-source/validate', {
    script,
    username: targetUsername(cfg),
    allowUnsafeVM: !!cfg.allowUnsafeVM
  })
  return r
}

/**
 * 灌入目标身份（v1.7.5）：设置里「用户名」填谁，就灌到谁的音源列表里。
 *  - default / open / 空 → 公开源（owner=open，落 _open：所有账号可用、LX 网页端可见可管）
 *  - 具名账号（如 admin）→ 该账号的私有源列表（网页端公共列表看不到，该账号登录后可见可用）
 * 历史：v1.6.8 曾固定 default（当时诉求是"灌入即公开"）；v1.7.5 按用户要求改为跟随用户名路由，
 * 与 Docker 版设置口径一致。公开音源清理（listPublic/removePublic）仍恒为 default，绝不碰私有源。
 */
function targetUsername(cfg) {
  const u = String((cfg && cfg.username) || 'default').trim()
  if (!u || u === 'open' || u === '_open' || u.toLowerCase() === 'default') return 'default'
  return u
}

/**
 * 上传脚本内容（推荐路径）
 * PC 端已用镜像候选链把脚本下载下来，直接把内容交给服务端落盘，
 * 服务端就不需要自己访问 GitHub —— 自建服务通常出网受限，这条路径成功率远高于 import。
 */
async function upload(cfg, content, filename) {
  const body = {
    filename: filename || 'source.js',
    content,
    username: targetUsername(cfg),
    allowUnsafeVM: !!cfg.allowUnsafeVM
  }
  let r = await req(cfg, 'POST', '/api/custom-source/upload', body)
  if (!r.ok) return { success: false, message: (r.data && r.data.error) || `HTTP ${r.status}` }
  const d = r.data || {}
  if (d.success === false) {
    if (d.requireUnsafe && cfg.autoAllowUnsafeVM && !body.allowUnsafeVM) {
      const r2 = await req(cfg, 'POST', '/api/custom-source/upload', Object.assign({}, body, { allowUnsafeVM: true }))
      const d2 = r2.data || {}
      if (d2.success) return await afterImport(cfg, d2)
      return { success: false, requireUnsafe: true, message: d2.message || d2.error || '需要 VM 模式且重试失败' }
    }
    return { success: false, requireUnsafe: !!d.requireUnsafe, message: d.message || d.error || '上传失败' }
  }
  return await afterImport(cfg, d)
}

/**
 * 让服务端自己从 URL 拉脚本（服务端出网受限时会超时，仅作备选）
 * 身份口径同 upload：跟随设置里的「用户名」（v1.7.5）。
 */
async function importUrl(cfg, url, filename) {
  const body = {
    url,
    filename: filename || undefined,
    username: targetUsername(cfg),
    allowUnsafeVM: !!cfg.allowUnsafeVM
  }
  let r = await req(cfg, 'POST', '/api/custom-source/import', body)
  if (!r.ok) {
    return { success: false, message: (r.data && r.data.error) || `HTTP ${r.status}` }
  }
  const d = r.data || {}
  if (d.success === false) {
    // 需要原生 VM 模式：若用户允许，带 allowUnsafeVM 重试一次
    if (d.requireUnsafe && cfg.autoAllowUnsafeVM && !body.allowUnsafeVM) {
      const r2 = await req(cfg, 'POST', '/api/custom-source/import', Object.assign({}, body, { allowUnsafeVM: true }))
      const d2 = r2.data || {}
      if (d2.success) {
        return await afterImport(cfg, d2, url)
      }
      return { success: false, requireUnsafe: true, message: d2.message || d2.error || '需要 VM 模式且重试失败' }
    }
    return { success: false, requireUnsafe: !!d.requireUnsafe, message: d.message || d.error || '导入失败' }
  }
  return await afterImport(cfg, d, url)
}

async function afterImport(cfg, d, url) {
  const id = d.id
  const info = { success: true, id, name: (d.metadata && d.metadata.name) || d.filename || '', platforms: d.supportedSources || [], owner: d.owner || 'open' }
  if (id && cfg.enableAfterImport !== false) {
    const t = await toggle(cfg, id, true, { owner: info.owner })
    info.enabled = t.success
    if (!t.success) info.message = '已导入但启用失败：' + t.message
  }
  return info
}

/**
 * 启用 / 禁用（服务端正式开关，会触发全量重载，超时给足 120s —— 20s 就放弃会让
 * 用户以为操作失败，而服务端其实还在忙。）
 *
 * 身份路由（v1.6.8）：按源 owner——私有源写归属身份，公开源走 default（服务端映射
 * _open）。不传 owner 时按公开源处理；传错身份时服务端有「找不到就回退 open」的逻辑，
 * 但公开源开关需要管理员密码，猎手请求已带 x-frontend-auth，因此不会被拒。
 */
async function toggle(cfg, id, enabled, opts) {
  const owner = opts && opts.owner
  const username = (owner && owner !== 'open' && owner !== '_open' && owner !== 'default') ? owner : 'default'
  const r = await req(cfg, 'POST', '/api/custom-source/toggle', {
    id, enabled: !!enabled, username
  }, 120000)
  if (!r.ok) return { success: false, message: (r.data && r.data.error) || `HTTP ${r.status}` }
  if (r.data && r.data.success === false) return { success: false, message: (r.data && (r.data.error || r.data.message)) || '切换失败' }
  return { success: true }
}

/**
 * 停用 / 启用（按平台禁用的方式，不触发服务端全量脚本重载）
 *
 * 这是规避 LX 服务端假死的关键：服务端的 toggle 结束后会 initUserApis() 全量串行重载
 * 所有脚本，任何脚本顶层 await 卡住都会把整轮重载拖死，服务端从此无响应。
 * 而 handleUpdatePlatforms 只写 states.json 后立即返回，**完全不重载脚本**，
 * 取歌时会读取该 states 过滤对应平台，效果等同于停用 —— 且永远不会卡死服务端。
 *
 * 身份口径（v1.6.6）：lxserver 的平台停用按身份分文件存（users/source/<身份>/states.json）。
 * LX 网页端音源管理页固定读 default→_open 那份（前端取 currentListData?.username，
 * 而歌单接口返回里没有 username 字段，恒为 default，与实际登录账号无关）；
 * 用户管理的源都是公开源（owner=open），其停用状态网页端只认 _open 这份。
 * 因此这里固定以 username='default' 写入（服务端映射到 _open），
 * 保证 LX 网页端音源管理页立即可见，与猎手「已灌入」页读回的口径也一致。
 *
 * @param disabledSources 要停用的平台键数组；传空数组表示恢复启用
 */
/**
 * 停用 / 启用（按平台禁用的方式，不触发服务端全量脚本重载）
 *
 * 这是规避 LX 服务端假死的关键：服务端的 toggle 结束后会 initUserApis() 全量串行重载
 * 所有脚本，任何脚本顶层 await 卡住都会把整轮重载拖死，服务端从此无响应。
 * 而 handleUpdatePlatforms 只写 states.json 后立即返回，**完全不重载脚本**，
 * 取歌时会读取该 states 过滤对应平台，效果等同于停用 —— 且永远不会卡死服务端。
 *
 * 身份口径（v1.6.6→v1.6.7）：lxserver 把平台停用按身份分文件存
 * （users/source/<身份>/states.json），而 update-platforms 的身份来自 username 参数：
 *  - default/open → 写 `_open/states.json`：这正是 LX 网页端音源管理页读的那份，
 *    公开源（owner=open）必须写这里，网页端才看得见；
 *  - 具名身份 → 写 `<身份>/states.json`：admin 私有源（owner=admin）只以 admin
 *    身份参与取歌，停用必须写 admin 那份才生效。
 * v1.6.6 曾一律写 default，对私有源是无效写入（写进 _open 的文件它根本不读）。
 * v1.6.7 起按源的 owner 路由：私有源写其归属身份，公开源写 default。
 *
 * @param opts.owner 源的归属身份（list 接口返回的 owner 字段）；不传按公开源处理
 */
async function setPlatforms(cfg, id, disabledSources, opts) {
  const owner = opts && opts.owner
  const username = (owner && owner !== 'open' && owner !== '_open' && owner !== 'default') ? owner : 'default'
  const r = await req(cfg, 'POST', '/api/custom-source/update-platforms', {
    id,
    disabledSources: Array.isArray(disabledSources) ? disabledSources : [],
    username
  }, 30000)
  if (!r.ok) return { success: false, message: (r.data && r.data.error) || `HTTP ${r.status}` }
  if (r.data && r.data.success === false) return { success: false, message: (r.data && (r.data.error || r.data.message)) || '更新平台失败' }
  return { success: true, disabledSources: r.data && r.data.disabledSources }
}

/**
 * 删除（触发服务端全量重载，超时 120s）。
 * 身份路由（v1.6.8）：按源 owner——私有源删归属身份目录下的那份；公开源走 default。
 * 服务端 handleDelete 同样有「指定身份找不到就回退 open」的兜底，但同 id 同时存在
 * 私有+公开两份时（历史重复灌入），指定身份删的就是私有那份，不会误删公开版。
 */
async function remove(cfg, id, opts) {
  const owner = opts && opts.owner
  const username = (owner && owner !== 'open' && owner !== '_open' && owner !== 'default') ? owner : 'default'
  const r = await req(cfg, 'POST', '/api/custom-source/delete', {
    id, username
  }, 120000)
  if (!r.ok) return { success: false, message: (r.data && r.data.error) || `HTTP ${r.status}` }
  if (r.data && r.data.success === false) return { success: false, message: (r.data && (r.data.error || r.data.message)) || '删除失败' }
  return { success: true }
}

/**
 * 回收站（2026-11-10，S3 原子性配套）：
 * lxserver 的 delete 默认把脚本移进 .trash/，配 /api/custom-source/trash(list) 与
 * /trash/restore。删旧灌新若 upload 最终失败，可用它把旧脚本自动放回去，
 * 避免留下「已删未装」的空窗；旧脚本正文服务端不回传，这是唯一可靠的回滚来源。
 */
async function listTrash(cfg, owner) {
  const username = (owner && owner !== 'open' && owner !== '_open' && owner !== 'default')
    ? owner : targetUsername(cfg)
  const r = await req(cfg, 'GET', `/api/custom-source/trash?username=${encodeURIComponent(username)}`)
  if (!r.ok) return []
  const d = r.data || {}
  return Array.isArray(d.items) ? d.items : []
}

async function restoreTrash(cfg, owner, file) {
  if (!file) return { success: false, message: '缺回收站文件名' }
  const username = (owner && owner !== 'open' && owner !== '_open' && owner !== 'default')
    ? owner : targetUsername(cfg)
  const r = await req(cfg, 'POST', '/api/custom-source/trash/restore', { username, file }, 120000)
  if (!r.ok) return { success: false, message: (r.data && r.data.error) || `HTTP ${r.status}` }
  if (r.data && r.data.success === false) return { success: false, message: (r.data && (r.data.error || r.data.message)) || '恢复失败' }
  return { success: true }
}

// ================= 公共音源清理（v1.7.4） =================
// PC 版实践发现的问题：lxserver 的音源分两套存储——
//  公开源（owner=open，落在 _open 目录）：所有账号可用、LX 网页端音源管理页可见可管，
//    这也是猎手自 v1.6.8 起灌入的落点（username=default）；
//  账号私有源（owner=<用户名>）：只对该账号可用，网页端公开列表里看不到。
// 用户要的清理能力是「只删服务端公开源」——比如清掉网页端音源管理页里那一堆，
// 重新灌入筛选后的结果；各账号内的私有源绝不触碰。
//
// lxserver handleDelete 的身份口径保证了一路安全：username 为 default/open/空时
// targetOwner 恒为 'open'，只查 _open 目录；而「指定身份找不到就回退 open」的兜底
// 只在 targetOwner≠open 时触发 —— 也就是说 username=default 的删除在物理上
// 不可能删到私有目录。这里仍按 owner 再过滤一道（双保险）。

/** 公开源判定：owner 为 open/_open 或缺省（LX 网页端音源管理页可见的那批） */
function isPublicSource(s) {
  return !!s && (!s.owner || s.owner === 'open' || s.owner === '_open')
}

/**
 * 清理计划（纯函数，便于单测）：
 * 从服务端全量列表里挑出公开源 id；私有源一律排除 —— 这是「只删公共、不碰私有」
 * 的第一道闸门（UI 勾选池也只会出现公开源）。
 */
function planPublicCleanup(serverList) {
  const publicIds = []
  const privateIds = []
  for (const s of (Array.isArray(serverList) ? serverList : [])) {
    if (!s || !s.id) continue
    if (isPublicSource(s)) publicIds.push(s.id)
    else privateIds.push(s.id)
  }
  return { publicIds, privateIds }
}

/** 只读公开源列表（username=default ⇒ 服务端只返回 _open 的源，不带任何私有源） */
async function listPublic(cfg) {
  const r = await listAs(cfg, 'default')
  // 双保险：服务端若混入私有条目（不应发生），按 owner 再过滤一次
  return r.filter(isPublicSource)
}

/**
 * 删除单个公开源。身份恒为 default ⇒ 服务端只可能删到 _open，
 * 绝不路由到任何账号私有目录。
 */
async function removePublic(cfg, id) {
  const r = await req(cfg, 'POST', '/api/custom-source/delete', {
    id, username: 'default'
  }, 120000)
  if (!r.ok) return { success: false, message: (r.data && r.data.error) || `HTTP ${r.status}` }
  if (r.data && r.data.success === false) return { success: false, message: (r.data && (r.data.error || r.data.message)) || '删除失败' }
  return { success: true }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/** 网络级失败：说明服务端正在重载/已经假死，继续发删除只会把它拖得更死 */
const NET_ERR_RE = /abort|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|network|超时|无响应/i

/**
 * 批量删除公开源。
 *
 * 服务端没有批量接口，且每次 delete 都会触发 initUserApis 全量重载脚本，因此串行执行。
 * 两条 PC 版踩坑经验必须落实（README v1.6.8「经验教训」）：
 *  1. **连续多次删除会把服务端拖到假死**（12 连删曾导致 Docker 重启）⇒ 每个删除之间
 *     留出间隔（cfg.serverDeleteIntervalMs，默认 5s），让服务端先完成这一轮重载；
 *  2. 出现网络级失败（超时/连接被拒）说明服务端已经扛不住 ⇒ **立即中止整批**，
 *     剩余项记进 skipped，不再继续施压。
 * 单条业务失败（如「源不存在」）不中断——那通常只是网页端已手动删过。
 */
async function removePublicBatch(cfg, ids, onProgress) {
  const list = (Array.isArray(ids) ? ids : []).filter(x => typeof x === 'string' && x)
  const rawGap = cfg && cfg.serverDeleteIntervalMs != null ? Number(cfg.serverDeleteIntervalMs) : 5000
  const gap = Number.isFinite(rawGap) && rawGap > 0 ? rawGap : 0
  const out = { total: list.length, ok: 0, failed: 0, aborted: false, skipped: [], results: [] }
  let done = 0
  for (let i = 0; i < list.length; i++) {
    const id = list[i]
    let item
    try {
      const r = await removePublic(cfg, id)
      if (r.success) out.ok++
      else out.failed++
      item = { id, success: !!r.success, message: r.message || '' }
    } catch (e) {
      out.failed++
      item = { id, success: false, message: String((e && e.message) || e) }
    }
    out.results.push(item)
    done++
    // 逐个上报：每个删除都要等服务端全量重载，没有进度反馈用户会以为卡死
    if (typeof onProgress === 'function') {
      try { onProgress(done, list.length, item) } catch (e) {}
    }
    // 服务端已经在重载/假死：停止施压，剩下的交给用户确认后再来
    if (!item.success && NET_ERR_RE.test(item.message || '')) {
      out.aborted = true
      out.skipped = list.slice(i + 1)
      break
    }
    if (gap && i < list.length - 1) await sleep(gap)
  }
  return out
}

module.exports = { verify, list, importUrl, upload, toggle, remove, setPlatforms, validate, baseUrl, listTrash, restoreTrash, listPublic, removePublic, removePublicBatch, planPublicCleanup, isPublicSource, targetUsername, listIsolations }
