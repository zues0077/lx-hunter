'use strict'
/**
 * Geelonn LX Server（gefl24/lxserver）适配器
 *
 * ⚠ 该 fork 的鉴权与原版 XCQ0607/lxserver 完全不同（2026-10-15 对自建 v3.0.1 实测）：
 *  - 没有 POST /api/admin/verify（404），管理接口也不认 x-frontend-auth 明文密码（403）；
 *  - 走用户登录制：POST /api/user/login {username, password}
 *      → 200 {success:true, token:<64位>, username, role:'admin'}
 *      → 401 {success:false, message:'Invalid credentials'}
 *  - 之后所有管理类接口（validate/upload/import/toggle/delete/update-platforms）必须带：
 *      x-user-name:  <登录用户名>
 *      x-user-token: <登录返回的 token>
 *    （x-frontend-auth 在 fork 里只用于本地文件播放等场景，与音源管理无关）
 *  - GET /api/custom-source/list?username=xx 为公开读（无鉴权也返回 200）
 *  - admin 登录后即可写公开列表：upload body username='default' → owner=open（实测通过）
 *  - fork 的脚本沙箱不提供 module（validate 'module.exports={}' 报 "module is not defined"），
 *    灌入的音源脚本需按 LX 常规写法（顶层 const / export default），不要依赖 module
 *
 * 因此本适配器不复用 lxservice（那是 x-frontend-auth 明文密码制），独立实现同一组接口。
 * token 进程内缓存；任何请求遇 401/403 自动强制重登一次并重试（token 过期自愈）。
 *
 * 账号对象字段：{ url, username, password, timeoutMs }
 *   url       → 服务地址（如 http://192.168.x.x:8195）
 *   username  → 网页登录账号（必须真实存在，如 admin；default 用户不可登录）
 *   password  → 该账号的网页登录密码
 *   灌入落点沿用 lxserver 口径：body username=default → 公开源(owner=open)；
 *   具名 → 该账号私有列表。list 合并公开+私有视图，toggle/remove 按 owner 路由。
 */
const net = require('../net')

// 账号对象字段是 url，内部沿用法是 serverUrl —— 两者都认，避免映射遗漏
function baseUrl(cfg) { return String((cfg && (cfg.serverUrl || cfg.url)) || '').replace(/\/+$/, '') }

// token 缓存：key = baseUrl|登录用户名
const _tokens = new Map()

function toCfg(acct) {
  return {
    serverUrl: acct && acct.url || '',
    username: (acct && acct.username) || 'admin',
    password: acct && acct.password || '',
    serverTimeoutMs: (acct && acct.timeoutMs) || 25000
  }
}

/** 登录换 token（不读缓存，每次真登录） */
async function login(cfg) {
  if (!baseUrl(cfg)) return { ok: false, msg: '未配置服务地址' }
  const url = baseUrl(cfg) + '/api/user/login'
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: String(cfg.username || 'admin'), password: String(cfg.password || '') })
  }
  let res, text, data = null
  try {
    res = await net.fetchWithTimeout(url, init, cfg.serverTimeoutMs || 20000)
    text = await res.text()
    try { data = JSON.parse(text) } catch (e) { /* 非 JSON */ }
  } catch (e) {
    return { ok: false, msg: '无法连接：' + String((e && e.message) || e) }
  }
  if (res.ok && data && data.success && data.token) {
    return { ok: true, token: String(data.token), username: data.username || cfg.username, role: data.role || '' }
  }
  const bad = res.status === 401 || (data && /invalid credentials/i.test(String(data.message || '')))
  return { ok: false, status: res.status, bad, msg: bad ? '管理员账号或密码错误' : ((data && (data.message || data.error)) || `HTTP ${res.status}（服务异常）`) }
}

/** 取 token（带缓存；force=true 强制重登） */
async function getToken(cfg, force) {
  const key = baseUrl(cfg) + '|' + String(cfg.username || 'admin')
  if (!force) {
    const hit = _tokens.get(key)
    if (hit) return hit.token
  }
  const r = await login(cfg)
  if (!r.ok) {
    const e = new Error(r.msg)
    e.authFail = true
    throw e
  }
  _tokens.set(key, { token: r.token, ts: Date.now() })
  return r.token
}

/** 清空 token 缓存（账号改密后可调用；测试用） */
function clearTokenCache() { _tokens.clear() }

/**
 * 统一请求：自动带登录态；遇 401/403 强制重登一次并重试。
 * 返回 { ok, status, data, text }，与 lxservice.req 同形。
 */
async function req(cfg, method, path, bodyObj, timeoutMs) {
  const url = baseUrl(cfg) + path
  const tmo = timeoutMs || cfg.serverTimeoutMs || 20000
  let token
  try {
    token = await getToken(cfg)
  } catch (e) {
    return { ok: false, status: 0, data: null, text: String((e && e.message) || e) }
  }

  const once = async (tk) => {
    const headers = {
      'Content-Type': 'application/json',
      'x-user-name': String(cfg.username || 'admin'),
      'x-user-token': tk
    }
    const init = { method, headers }
    if (bodyObj !== undefined) init.body = JSON.stringify(bodyObj)
    const res = await net.fetchWithTimeout(url, init, tmo)
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch (e) { /* 非 JSON */ }
    return { ok: res.ok, status: res.status, data, text }
  }

  let r = await once(token)
  // token 过期/被踢/权限头失效：强制重登一次再试（仅一次，避免循环；
  // 真·无权限的 403 重登后仍会 403，多付一次登录代价但行为正确）
  if (r.status === 401 || r.status === 403) {
    try {
      token = await getToken(cfg, true)
      r = await once(token)
    } catch (e) { /* 重登失败：返回上一次响应 */ }
  }
  return r
}

/** 连通性 / 账号校验：直接走登录（fork 没有独立 verify 端点） */
async function verify(cfg) {
  if (!baseUrl(cfg)) return { ok: false, msg: '未配置服务地址' }
  const r = await login(cfg)
  if (r.ok) {
    _tokens.set(baseUrl(cfg) + '|' + String(cfg.username || 'admin'), { token: r.token, ts: Date.now() })
    return { ok: true, msg: `已连接，账号 ${r.username || cfg.username} 验证通过` + (r.role ? `（${r.role}）` : '') }
  }
  return { ok: false, msg: r.msg }
}

/** 按指定身份拉取服务端音源列表（fork 的 list 为公开读） */
async function listAs(cfg, username) {
  const r = await req(cfg, 'GET', `/api/custom-source/list?username=${encodeURIComponent(username)}`)
  if (!r.ok) throw new Error((r.data && r.data.error) || `HTTP ${r.status}`)
  return Array.isArray(r.data) ? r.data : []
}

/**
 * 服务端已有音源列表（合并视图）——口径与 lxserver 一致：
 * 公开源（default → _open）为主，再按配置的具名身份补充其私有源。
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

/** 灌入目标身份（与 lxserver 口径一致）：default/open/空 → 公开源；具名 → 私有列表 */
function targetUsername(cfg) {
  const u = String((cfg && cfg.username) || 'default').trim()
  if (!u || u === 'open' || u === '_open' || u.toLowerCase() === 'default') return 'default'
  return u
}

/** 校验脚本（不落盘），返回 { ok, status, data, text } */
async function validate(cfg, script) {
  const r = await req(cfg, 'POST', '/api/custom-source/validate', {
    script,
    username: targetUsername(cfg),
    allowUnsafeVM: !!cfg.allowUnsafeVM
  })
  return r
}

/** 上传脚本内容（猎手已下载好脚本，交给服务端落盘） */
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

/** 让服务端自己从 URL 拉脚本（服务端出网受限时会超时，仅作备选） */
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
    if (d.requireUnsafe && cfg.autoAllowUnsafeVM && !body.allowUnsafeVM) {
      const r2 = await req(cfg, 'POST', '/api/custom-source/import', Object.assign({}, body, { allowUnsafeVM: true }))
      const d2 = r2.data || {}
      if (d2.success) return await afterImport(cfg, d2, url)
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

/** 启用 / 禁用（触发服务端全量重载，超时给足 120s；按 owner 路由身份，与 lxserver 一致） */
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

/** 按平台停用 / 恢复（写 states 不重载脚本；按 owner 路由身份，与 lxserver 一致） */
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

/** 删除（按 owner 路由身份，与 lxserver 一致） */
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

// ================= 公共音源清理（与 lxserver 同口径） =================

/** 公开源判定：owner 为 open/_open 或缺省 */
function isPublicSource(s) {
  return !!s && (!s.owner || s.owner === 'open' || s.owner === '_open')
}

/** 清理计划（纯函数）：只挑公开源，私有源一律排除 */
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

/** 只读公开源列表 */
async function listPublic(cfg) {
  const r = await listAs(cfg, 'default')
  return r.filter(isPublicSource)
}

/** 删除单个公开源（身份恒为 default ⇒ 物理上删不到私有目录） */
async function removePublic(cfg, id) {
  const r = await req(cfg, 'POST', '/api/custom-source/delete', {
    id, username: 'default'
  }, 120000)
  if (!r.ok) return { success: false, message: (r.data && r.data.error) || `HTTP ${r.status}` }
  if (r.data && r.data.success === false) return { success: false, message: (r.data && (r.data.error || r.data.message)) || '删除失败' }
  return { success: true }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

const NET_ERR_RE = /abort|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|network|超时|无响应/i

/** 批量删除公开源（串行 + 间隔 + 网络级失败即中止，与 lxserver 同口径） */
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
    if (typeof onProgress === 'function') {
      try { onProgress(done, list.length, item) } catch (e) {}
    }
    if (!item.success && NET_ERR_RE.test(item.message || '')) {
      out.aborted = true
      out.skipped = list.slice(i + 1)
      break
    }
    if (gap && i < list.length - 1) await sleep(gap)
  }
  return out
}

module.exports = {
  kind: 'geelonn',
  // 名字即 key：服务端按脚本 @name 生成 id，重名会被拒（README「灌入提示已存在」即此）。
  uniqueName: true,
  verify, list, upload, importUrl, toggle, remove, setPlatforms, validate, baseUrl,
  listPublic, removePublic, removePublicBatch, planPublicCleanup, isPublicSource, targetUsername,
  // 仅供测试/高级用法
  clearTokenCache
}
