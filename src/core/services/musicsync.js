'use strict'
/**
 * MusicSync 适配器（lincolnpark2000/MusicSync）
 *
 * 多用户 LX Music 同步服务端：自定义源（user api）走 /api/user-api。
 * 接入方式：以账号登录拿 token，再操作 user-api。
 *
 * 账号对象字段：{ url, username, password, timeoutMs }
 *   url       → MusicSync 站点地址，如 http://192.168.1.10:7926
 *   username / password → MusicSync 登录账号
 *
 * 能力边界（与 Songloft 类似）：
 *  - 音源按账号隔离（token 即身份），无公开/私有 owner 维度；
 *  - 没有平台级停用接口，停用/启用统一走 enabled 开关（setPlatforms 适配为 toggle）；
 *  - 没有公共音源清理接口（不提供 listPublic/removePublic 系列）。
 */
// 走模块对象调用而非解构：net.fetchWithTimeout 在测试里会被替换成桩，
// 解构会在加载时把原函数固化下来，导致打桩失效（owner-routing 等既有测试依赖这种打法）。
const net = require('../net')
const crypto = require('crypto')

function baseUrl(acct) { return String((acct && acct.url) || '').replace(/\/+$/, '') }

// 与 core/checker 的 contentHash 同一算法（sha256(脚本原文)）：
// MusicSync 的列表接口会回传脚本正文，据此可以在「灌入前」和服务端逐条比内容，
// 不必依赖本地账本 —— 用户手动删过、换过账号、账本丢了都拦不住重复，只有比内容才拦得住。
function sha256Str(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex') }

const tokenCache = new Map()
function cacheKey(acct) { return baseUrl(acct) + '|' + (acct.username || '') }
async function login(acct) {
  const key = cacheKey(acct)
  const hit = tokenCache.get(key)
  if (hit && Date.now() - hit.at < 9 * 60 * 1000) return hit.token
  const r = await net.fetchWithTimeout(baseUrl(acct) + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: acct.username || 'admin', password: acct.password || '' })
  }, (acct && acct.timeoutMs) || 20000)
  const text = await r.text()
  let j = null
  try { j = JSON.parse(text) } catch (e) {}
  if (!r.ok || !j) throw new Error('MusicSync 登录失败（HTTP ' + r.status + '）')
  const token = j.token || j.access_token
  if (!token) throw new Error('MusicSync 登录失败：' + String(j.msg || j.message || '未返回 token'))
  tokenCache.set(key, { token, at: Date.now() })
  return token
}

async function req(acct, method, path, opts) {
  opts = opts || {}
  const url = baseUrl(acct) + path
  const headers = { 'Content-Type': 'application/json' }
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

// MusicSync 列表接口只回 script 正文，不回服务端解析出的平台，只能本地静态解析。
// 按 lxmusic-source 脚本的实际写法逐层降级（实测 14 条真实音源都能命中前两档）：
//   1) supportedSources: ['tx','wy']        —— 老式 v1 脚本直接声明
//   2) MUSIC_QUALITY = { kw:[…], kg:[…] }   —— v2 脚本的事实标准（MUSIC_SOURCE = Object.keys(MUSIC_QUALITY)）
//   3) MUSIC_SOURCE = ['tx','wy']           —— 直接写数组
// 混淆到连键名都改掉的脚本解析不出来，返回空（界面显示「—」，不猜、不谎报）。
const PLAT_KEYS = ['tx', 'wy', 'kg', 'kw', 'mg', 'qsvip', 'xm', 'bd', 'others']

function parseStrArray(raw) {
  try {
    const arr = JSON.parse(String(raw).replace(/'/g, '"'))
    if (Array.isArray(arr)) return arr.map(String).filter(k => PLAT_KEYS.indexOf(k) >= 0)
  } catch (e) {}
  const out = []
  const re = /['"]([a-zA-Z]+)['"]/g
  let m
  while ((m = re.exec(raw))) if (PLAT_KEYS.indexOf(m[1]) >= 0 && out.indexOf(m[1]) < 0) out.push(m[1])
  return out
}

// 从对象字面量的「第一层键」里挑已知平台：startIdx 指向 '{'，按括号配对找结尾
function keysFromObjectLiteral(src, startIdx) {
  let depth = 0
  let end = src.length - 1
  const limit = Math.min(src.length - 1, startIdx + 20000)
  for (let i = startIdx; i <= limit; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth <= 0) { end = i; break } }
  }
  const slice = src.slice(startIdx, end + 1)
  const out = []
  const re = /['"]?(tx|wy|kg|kw|mg|qsvip|xm|bd|others)['"]?\s*:/g
  let m
  while ((m = re.exec(slice))) if (out.indexOf(m[1]) < 0) out.push(m[1])
  return out
}

function extractSources(script) {
  if (!script) return []
  const s = String(script)
  let m = s.match(/supportedSources\s*[:=]\s*(\[[^\]]*\])/)
  if (m) { const a = parseStrArray(m[1]); if (a.length) return a }
  m = s.match(/MUSIC_QUALITY\s*=\s*\{/)
  if (m) { const a = keysFromObjectLiteral(s, m.index + m[0].length - 1); if (a.length) return a }
  m = s.match(/MUSIC_SOURCE\s*=\s*(\[[^\]]*\])/)
  if (m) { const a = parseStrArray(m[1]); if (a.length) return a }
  return []
}

/** 服务端解析出的平台（sources 可能是 {tx:…} 对象，也可能是 ['tx'] 数组） */
function platKeysOf(sources) {
  if (!sources) return null
  if (Array.isArray(sources)) return sources.map(String).filter(k => PLAT_KEYS.indexOf(k) >= 0)
  if (typeof sources === 'object') return Object.keys(sources).filter(k => PLAT_KEYS.indexOf(k) >= 0)
  return null
}

async function verify(acct) {
  if (!baseUrl(acct)) return { ok: false, msg: '未配置服务地址' }
  try {
    const token = await login(acct)
    return { ok: !!token, msg: token ? '已连接 MusicSync，账号登录成功' : '登录失败' }
  } catch (e) {
    return { ok: false, msg: '无法连接：' + String((e && e.message) || e) }
  }
}

async function list(acct) {
  const token = await login(acct)
  const r = await req(acct, 'GET', '/api/user-api', { token })
  if (!r.ok) throw new Error('MusicSync 读取音源列表失败（HTTP ' + r.status + '）')
  const arr = Array.isArray(r.data) ? r.data : (r.data && Array.isArray(r.data.apis) ? r.data.apis : [])
  return arr.map(s => ({
    id: s.id,
    name: s.name,
    enabled: s.enabled !== false,
    owner: undefined,
    // 服务端自己解析出的平台优先（sources 是 {tx:{...}} 形式）；没解析出来再退回本地静态解析
    supportedSources: platKeysOf(s.sources) || extractSources(s.script),
    // 有了这两个字段，核心层就能在灌入前做「服务端已有同内容 → 不重复灌」的判断（见 hunter._planImportQueue）
    size: typeof s.script === 'string' ? Buffer.byteLength(s.script, 'utf8') : undefined,
    hash: typeof s.script === 'string' && s.script ? sha256Str(s.script) : undefined,
    disabledSources: []
  }))
}

async function upload(acct, content, filename) {
  const token = await login(acct)
  const name = (filename || 'source').replace(/\.js$/i, '')
  const r = await req(acct, 'POST', '/api/user-api', {
    token, body: JSON.stringify({ script: content, name })
  })
  if (!r.ok) return { success: false, message: errMsg(r) }
  const d = r.data || {}
  if (d.success === false) return { success: false, message: errMsg(r) }
  const id = d.id
  const platforms = (d.sources && typeof d.sources === 'object') ? Object.keys(d.sources) : extractSources(content)
  // 创建接口默认即启用（enabled=true）；若用户关闭了「灌入后自动启用」，则显式禁用
  if (acct.enableAfterImport === false && id) {
    try { await toggle(acct, id, false, {}) } catch (e) {}
  }
  return { success: true, id, name: d.name || name, platforms }
}

async function importUrl(acct, url, name) {
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
  const r = await req(acct, 'PUT', '/api/user-api/' + encodeURIComponent(id) + '/enabled', {
    token, body: JSON.stringify({ enabled: !!enabled })
  })
  if (!r.ok) return { success: false, message: errMsg(r) }
  if (r.data && r.data.success === false) return { success: false, message: errMsg(r) }
  return { success: true }
}

async function remove(acct, id, opts) {
  const token = await login(acct)
  const r = await req(acct, 'DELETE', '/api/user-api/' + encodeURIComponent(id), { token })
  if (!r.ok) return { success: false, message: errMsg(r) }
  if (r.data && r.data.success === false) return { success: false, message: errMsg(r) }
  return { success: true }
}

// MusicSync 无平台级停用：把「停用全部平台」适配为全局禁用，把「启用」适配为全局启用。
async function setPlatforms(acct, id, disabledSources, opts) {
  const doStop = Array.isArray(disabledSources) && disabledSources.length > 0
  return await toggle(acct, id, !doStop, {})
}

// MusicSync 不支持单独脚本校验：返回中性 ok。
async function validate(acct, code) {
  return { status: 200, data: { ok: true, note: 'MusicSync 平台不支持单独校验，灌入时由服务端校验' }, text: '' }
}

module.exports = {
  kind: 'musicsync',
  // 名字不是 key：服务端 id 是 user_api_<时间戳>，同名音源可以共存（实测连传两次同名都成功）。
  // 含义仅此一条 —— 同名**不需要改名**（改了也白改，还可能把脚本改坏）。
  // 但同名/同内容**仍然要按统一规则裁决**：同内容不重复灌、本地更好才删旧装新，
  // 否则同一个音源灌几轮就会在服务端堆出好几份一模一样的（用户反馈的问题）。
  uniqueName: false,
  verify, list, upload, importUrl, toggle, remove, setPlatforms, validate, baseUrl
}
