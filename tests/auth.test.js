'use strict'
/** v1.10.0 登录模块测试（core/auth.js） */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Auth } = require('../src/core/auth')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-auth-'))

// ① 首个注册 = 管理员；重复注册被拒
const a = new Auth(dir)
const u = a.registerFirst('admin', 'secret123')
assert.strictEqual(u.admin, true)
assert.throws(() => a.registerFirst('evil', 'secret123'), /已存在账号/)

// ② 会话：创建/校验/滑动续期/销毁
const token = a.createSession('admin')
const s = a.checkSession(token)
assert.ok(s && s.admin === true && s.name === 'admin')
assert.strictEqual(a.checkSession('bogus'), null)
a.destroySession(token)
assert.strictEqual(a.checkSession(token), null)

// ③ 登录验证：对/错密码、防爆破锁定
assert.strictEqual(a.verify('admin', 'secret123', 'ip1').name, 'admin')
assert.throws(() => a.verify('admin', 'wrong', 'ip2'), /账号或密码不正确/)
for (let i = 0; i < 8; i++) { try { a.verify('admin', 'wrong', 'ip3') } catch (e) {} }
assert.throws(() => a.verify('admin', 'secret123', 'ip3'), /临时锁定/, '连续 8 次失败后即使密码正确也锁定')

// ④ 管理员加账号 / 删除保护
a.addUser('alice', 'pwd456', false)
assert.throws(() => a.addUser('alice', 'x77777', false), /账号已存在/)
assert.throws(() => a.addUser('bob', '123', false), /至少 6 位/)
assert.throws(() => a.deleteUser('admin', 'admin'), /不能删除当前登录/)
a.deleteUser('alice', 'admin')
assert.strictEqual(a.hasUsers(), true)

// ⑤ 改密码：验旧密码；管理员重置
a.changePassword('admin', 'secret123', 'newpass99')
assert.strictEqual(a.verify('admin', 'newpass99', 'ip9').name, 'admin')
assert.throws(() => a.changePassword('admin', 'secret123', 'zzzzzz'), /原密码不正确/)
a.adminReset('admin', 'reset888')
assert.strictEqual(a.verify('admin', 'reset888', 'ipX').name, 'admin')

// ⑥ 持久化：新实例读到同一份用户表（口令材料不外显）
const b = new Auth(dir)
assert.strictEqual(b.listUsers().length, 1)
assert.strictEqual(b.listUsers()[0].admin, true)
assert.strictEqual(b.listUsers()[0].hash, undefined)
assert.strictEqual(b.verify('admin', 'reset888', 'ipY').name, 'admin')
// 新实例的内存会话为空（重启需重新登录）
assert.strictEqual(b.checkSession(token), null)

fs.rmSync(dir, { recursive: true, force: true })
console.log('auth.test.js：全部通过')
