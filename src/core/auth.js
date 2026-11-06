'use strict'
/**
 * 访问账号登录（v1.10.0，Web/Docker 版专用）
 *
 * 需求背景：lx-hunter Web 版跑在 NAS 容器里，局域网内任何人打开端口就能用全部功能
 * （爬取/灌入/删除服务端音源）。本模块给 Web 版加「用户名 + 密码多账号」登录：
 * 未登录时除 /api/health 与 /api/auth/* 外的全部接口一律 401。
 *
 * 设计约束（与 web.js 一致）：只用 Node 内置模块，零 npm 依赖。
 *  - 用户存储：<DATA_DIR>/users.json，口令存 PBKDF2-SHA256(salt, 12 万轮)，绝不存明文
 *  - 会话：内存 Map（重启后需重新登录，属可接受的安全取舍），token 经 HttpOnly Cookie 携带
 *  - 防爆破：同一 账号+IP 连续失败 8 次锁 5 分钟
 *  - 首个注册的用户自动成为管理员（admin），管理员可增删账号；用户可改自己的密码
 */
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const ITERATIONS = 120000
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000   // 会话 30 天（滑动续期）
const MAX_FAILS = 8                            // 连续失败上限
const LOCK_MS = 5 * 60 * 1000                  // 锁定时长

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), String(salt), ITERATIONS, 32, 'sha256').toString('hex')
}

function newSalt() {
  return crypto.randomBytes(16).toString('hex')
}

class Auth {
  constructor(dir) {
    this.dir = dir
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'users.json')
    this.data = { users: [] }
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (j && Array.isArray(j.users)) this.data = j } catch (e) {}
    // 会话与防爆破状态都是内存态：重启后重新登录（users.json 不存会话，减小泄露面）
    this.sessions = new Map()   // token -> { name, expires }
    this.fails = new Map()      // key -> { n, lockUntil }
  }

  _save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.data), 'utf8'); return true } catch (e) { return false }
  }

  hasUsers() { return this.data.users.length > 0 }

  find(name) {
    const n = String(name || '').trim().toLowerCase()
    return this.data.users.find(u => u.name.toLowerCase() === n) || null
  }

  /** 校验账号名/口令形态，返回错误文案或 null */
  static validate(name, password) {
    const n = String(name || '').trim()
    const p = String(password || '')
    if (!/^[A-Za-z0-9_\u4e00-\u9fa5.-]{2,32}$/.test(n)) return '账号名 2–32 位，仅限字母数字下划线中文点横线'
    if (p.length < 6) return '密码至少 6 位'
    if (p.length > 128) return '密码过长'
    return null
  }

  /** 首个用户注册（仅当用户表为空时允许；自动成为管理员） */
  registerFirst(name, password) {
    if (this.hasUsers()) throw new Error('已存在账号，请直接登录')
    const bad = Auth.validate(name, password)
    if (bad) throw new Error(bad)
    const salt = newSalt()
    const user = {
      name: String(name).trim(), salt, hash: hashPassword(password, salt),
      admin: true, createdAt: Date.now()
    }
    this.data.users.push(user)
    this._save()
    return user
  }

  /** 管理员添加账号（是否管理员由调用方把关） */
  addUser(name, password, admin) {
    if (this.find(name)) throw new Error('账号已存在')
    const bad = Auth.validate(name, password)
    if (bad) throw new Error(bad)
    const salt = newSalt()
    const user = {
      name: String(name).trim(), salt, hash: hashPassword(password, salt),
      admin: admin === true, createdAt: Date.now()
    }
    this.data.users.push(user)
    this._save()
    return user
  }

  deleteUser(name, actor) {
    const u = this.find(name)
    if (!u) throw new Error('账号不存在')
    if (u.name.toLowerCase() === String(actor || '').toLowerCase()) throw new Error('不能删除当前登录的账号')
    // 至少保留一个管理员
    const admins = this.data.users.filter(x => x.admin && x !== u)
    if (u.admin && !admins.length) throw new Error('至少保留一个管理员账号')
    this.data.users = this.data.users.filter(x => x !== u)
    // 该账号的会话全部失效
    for (const [t, s] of Array.from(this.sessions)) if (s.name.toLowerCase() === u.name.toLowerCase()) this.sessions.delete(t)
    this._save()
    return true
  }

  /** 用户改自己的密码（需验旧密码）；管理员重置他人密码走 adminReset */
  changePassword(name, oldPwd, newPwd) {
    const u = this.find(name)
    if (!u) throw new Error('账号不存在')
    if (hashPassword(oldPwd || '', u.salt) !== u.hash) throw new Error('原密码不正确')
    const bad = Auth.validate(u.name, newPwd)
    if (bad) throw new Error(bad)
    u.salt = newSalt()
    u.hash = hashPassword(newPwd, u.salt)
    this._save()
    return true
  }

  /** 管理员重置他人密码 */
  adminReset(name, newPwd) {
    const u = this.find(name)
    if (!u) throw new Error('账号不存在')
    const bad = Auth.validate(u.name, newPwd)
    if (bad) throw new Error(bad)
    u.salt = newSalt()
    u.hash = hashPassword(newPwd, u.salt)
    this._save()
    return true
  }

  /** 防爆破检查：锁定中抛错 */
  _throttle(name, ip) {
    const key = String(name || '').trim().toLowerCase() + '|' + String(ip || '')
    const rec = this.fails.get(key)
    if (rec && rec.lockUntil > Date.now()) {
      const mins = Math.max(1, Math.ceil((rec.lockUntil - Date.now()) / 60000))
      throw new Error(`失败次数过多，账号已临时锁定（约 ${mins} 分钟后可再试）`)
    }
    return key
  }
  _fail(key) {
    const rec = this.fails.get(key) || { n: 0, lockUntil: 0 }
    rec.n++
    if (rec.n >= MAX_FAILS) { rec.lockUntil = Date.now() + LOCK_MS; rec.n = 0 }
    this.fails.set(key, rec)
  }
  _pass(key) { this.fails.delete(key) }

  /** 登录校验。成功返回用户；失败抛错（含防锁定文案） */
  verify(name, password, ip) {
    const key = this._throttle(name, ip)
    const u = this.find(name)
    const okUser = u && hashPassword(password || '', u.salt) === u.hash
    if (!okUser) { this._fail(key); throw new Error('账号或密码不正确') }
    this._pass(key)
    return { name: u.name, admin: !!u.admin }
  }

  createSession(name) {
    const token = crypto.randomBytes(32).toString('hex')
    this.sessions.set(token, { name: String(name), expires: Date.now() + SESSION_TTL_MS })
    // 顺手清理过期会话，防内存缓慢膨胀
    const now = Date.now()
    for (const [t, s] of this.sessions) if (s.expires < now) this.sessions.delete(t)
    return token
  }

  /** 校验会话：有效返回 {name, admin}（并滑动续期），无效返回 null */
  checkSession(token) {
    if (!token) return null
    const s = this.sessions.get(String(token))
    if (!s) return null
    if (s.expires < Date.now()) { this.sessions.delete(token); return null }
    const u = this.find(s.name)
    if (!u) { this.sessions.delete(token); return null }   // 账号被删后会话即失效
    s.expires = Date.now() + SESSION_TTL_MS
    return { name: u.name, admin: !!u.admin }
  }

  destroySession(token) { if (token) this.sessions.delete(String(token)) }

  /** 列出账号（不含任何口令材料） */
  listUsers() {
    return this.data.users.map(u => ({ name: u.name, admin: !!u.admin, createdAt: u.createdAt }))
  }
}

module.exports = { Auth, SESSION_TTL_MS }
