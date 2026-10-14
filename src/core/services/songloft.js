'use strict'
/**
 * Songloft 平台内 lxmusic 插件适配器（songloft-org/songloft）
 *
 * 接入方式：先以 Songloft 账号登录拿 token，再操作 lxmusic 插件提供的音源管理接口。
 * 插件路由挂在 /api/v1/jsplugin/<entryPath>/ 下（entryPath = lxmusic）。
 *
 * 账号对象字段：{ url, username, password, timeoutMs }
 *   url       → Songloft 站点地址，如 http://192.168.1.10:7975
 *   username / password → Songloft 登录账号（不是 LX 网页端账号）
 *
 * 能力边界：
 *  - 音源列表按账号隔离（token 即身份），无 lxserver 那种公开/私有 owner 概念；
 *  - 没有「平台级停用」接口，停用/启用统一走全局 toggle（setPlatforms 被适配为 toggle）；
 *  - 没有公共音源清理接口（适配器不提供 listPublic/removePublic 系列）。
 */
// 走模块对象调用而非解构：net.fetchWithTimeout 在测试里会被替换成桩，
// 解构会在加载时把原函数固化下来，导致打桩失效（owner-routing 等既有测试依赖这种打法）。
const net = require('../net')

function baseUrl(acct) { return String((acct && acct.url) || '').replace(/\/+$/, '') }
function pluginBase(acct) { return baseUrl(acct) + '/api/v1/jsplugin/lxmusic' }

function normName(s) {
  return String(s || '').toLowerCase().replace(/[\[\]【】（）()|｜:：、,，.。\s_\-·•]+/g, '')
}

// token 缓存（按 站点|账号 维度，10min 内复用，避免每次操作都登录）
const tokenCache = new Map()
function cacheKey(acct) { return baseUrl(acct) + '|' + (acct.username || '') }
async function login(acct) {
  const key = cacheKey(acct)
  const hit = tokenCache.get(key)
  if (hit && Date.now() - hit.at < 9 * 60 * 1000) return hit.token
  const r = await net.fetchWithTimeout(baseUrl(acct) + '/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: acct.username || 'admin', password: acct.password || '' })
  }, (acct && acct.timeoutMs) || 20000)
  const text = await r.text()
  let j = null
  try { j = JSON.parse(text) } catch (e) {}
  if (!r.ok || !j) throw new Error('Songloft 登录失败（HTTP ' + r.status + '）')
  const token = j.access_token || j.token
  if (!token) throw new Error('Songloft 登录失败：' + String(j.msg || j.message || '未返回 token'))
  tokenCache.set(key, { token, at: Date.now() })
  return token
}
function invalidateToken(acct) { tokenCache.delete(cacheKey(acct)) }

async function req(acct, method, path, opts) {
  opts = opts || {}
  const url = pluginBase(acct) + path
  const headers = {}
  if (!opts.isForm) headers['Content-Type'] = 'application/json'
  if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token
  const init = { method, headers }
  if (opts.body !== undefined) init.body = opts.body
  const res = await net.fetchWithTimeout(url, init, (acct && acct.timeoutMs) || 20000)
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch (e) {}
  return { ok: res.ok, status: res.status, data, text }
}

function errMsg(r) {
  return (r.data && (r.data.error || r.data.msg || r.data.detail)) || ('HTTP ' + r.status)
}

async function verify(acct) {
  if (!baseUrl(acct)) return { ok: false, msg: '未配置服务地址' }
  try {
    const token = await login(acct)
    return { ok: !!token, msg: token ? '已连接 Songloft，账号登录成功' : '登录失败' }
  } catch (e) {
    return { ok: false, msg: '无法连接：' + String((e && e.message) || e) }
  }
}

async function list(acct) {
  const token = await login(acct)
  const r = await req(acct, 'GET', '/api/sources', { token })
  if (!r.ok) throw new Error('Songloft 读取音源列表失败（HTTP ' + r.status + '）')
  const arr = (r.data && r.data.data && Array.isArray(r.data.data.list)) ? r.data.data.list : []
  return arr.map(s => ({
    id: s.id,
    name: s.name,
    enabled: s.enabled !== false,
    owner: undefined,            // Songloft 按账号隔离，无 owner 维度
    supportedSources: Array.isArray(s.platforms)
      ? s.platforms
      : (s.platforms && typeof s.platforms === 'object' ? Object.keys(s.platforms) : []),
    size: undefined,
    filename: s.filename,
    version: s.version,
    disabledSources: []           // Songloft 无平台级停用概念
  }))
}

// 上传脚本内容（推荐路径）：先登录，再把内容以 multipart files 字段提交给插件导入接口。
// 命中插件解析失败的脚本（个别脚本会让插件内部 replace 抛错）会返回 500，这里如实透传。
async function upload(acct, content, filename) {
  const token = await login(acct)
  const fname = (filename || 'source.js').replace(/\.js$/i, '') + '.js'
  const fd = new FormData()
  fd.append('files', new Blob([content], { type: 'application/javascript' }), fname)
  const r = await req(acct, 'POST', '/api/sources/import', { token, body: fd, isForm: true })
  if (!r.ok) return { success: false, message: errMsg(r) }
  // 解析新来源 id：优先取响应里的 id；否则按上传文件名/名称回查列表（响应结构不稳定时兜底）
  let entry = resolveEntryFromResponse(r.data, fname)
  if (!entry) {
    try { entry = await findEntryByName(acct, fname, content) } catch (e) {}
  }
  if (!entry) return { success: true, message: '已上传（未能立即解析来源 id，刷新后可见）' }
  if (acct.enableAfterImport !== false) {
    try { await toggle(acct, entry.id, true, {}) } catch (e) {}
  }
  return { success: true, id: entry.id, name: entry.name || fname, platforms: entry.supportedSources || [] }
}

function resolveEntryFromResponse(data, fname) {
  if (!data) return null
  const cand = []
  if (data && data.id) cand.push(data)
  if (data && data.data && data.data.id) cand.push(data.data)
  if (Array.isArray(data)) data.forEach(x => cand.push(x))
  if (data && Array.isArray(data.data)) data.data.forEach(x => cand.push(x))
  if (data && data.data && Array.isArray(data.data.list)) data.data.list.forEach(x => cand.push(x))
  const base = normName(fname.replace(/\.js$/i, ''))
  for (const c of cand) {
    if (c && typeof c === 'object' && (c.id || c.name)) {
      const cb = normName((c.id || c.name || '').replace(/\.js$/i, ''))
      if (cb && (cb === base || cb.indexOf(base) >= 0 || base.indexOf(cb) >= 0)) {
        return {
          id: c.id, name: c.name,
          supportedSources: Array.isArray(c.platforms) ? c.platforms
            : (c.platforms && typeof c.platforms === 'object' ? Object.keys(c.platforms) : [])
        }
      }
    }
  }
  return null
}

async function findEntryByName(acct, fname, content) {
  const items = await list(acct)
  const base = normName(fname.replace(/\.js$/i, ''))
  let found = items.find(s => normName((s.filename || '').replace(/\.js$/i, '')) === base)
  if (!found) found = items.find(s => normName(s.id || '') === base)
  if (!found) found = items.find(s => normName(s.name || '') === base)
  return found || null
}

async function importUrl(acct, url, name) {
  // Songloft 插件导入接口是「上传文件」，不支持服务端自己出网拉 URL；
  // 这里由猎手下载内容后再走 upload（与 lxserver 适配器一致，规避服务端出网受限）。
  let content = null
  try {
    const res = await net.fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 20000)
    if (res.ok) content = await res.text()
  } catch (e) {}
  if (!content) return { success: false, message: '脚本下载失败（无法从 URL 拉取内容）' }
  return await upload(acct, content, name || 'source.js')
}

async function toggle(acct, id, enabled, opts) {
  const token = await login(acct)
  const r = await req(acct, 'PUT', '/api/sources/toggle', {
    token, body: JSON.stringify({ id, enabled: !!enabled })
  })
  if (!r.ok) return { success: false, message: errMsg(r) }
  if (r.data && r.data.success === false) return { success: false, message: errMsg(r) }
  return { success: true }
}

async function remove(acct, id, opts) {
  const token = await login(acct)
  const r = await req(acct, 'DELETE', '/api/sources?id=' + encodeURIComponent(id), { token })
  if (!r.ok) return { success: false, message: errMsg(r) }
  if (r.data && r.data.success === false) return { success: false, message: errMsg(r) }
  return { success: true }
}

// Songloft 无平台级停用接口：把「停用全部平台」适配为全局禁用，把「启用」适配为全局启用。
async function setPlatforms(acct, id, disabledSources, opts) {
  const doStop = Array.isArray(disabledSources) && disabledSources.length > 0
  return await toggle(acct, id, !doStop, {})
}

// Songloft 不支持单独脚本校验：插件在导入时自行校验，这里返回中性 ok，避免界面报错。
async function validate(acct, code) {
  return { status: 200, data: { ok: true, note: 'Songloft 平台不支持单独校验，灌入时由插件校验' }, text: '' }
}

module.exports = {
  kind: 'songloft',
  // 名字即 key：插件用脚本 @name 生成 id（实测「聚合API接口 (by lerd)」→ id「聚合api接口-by-lerd」），
  // 同名会撞 id，所以同名必须替换或改名。
  uniqueName: true,
  verify, list, upload, importUrl, toggle, remove, setPlatforms, validate, baseUrl
}
