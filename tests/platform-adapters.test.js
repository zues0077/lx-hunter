'use strict'
/**
 * v1.8.0：多平台 / 多账号适配层
 * 覆盖三件事，缺一不可：
 *  1) 路由层——按 activePlatformId 选中账号；无账号时不静默降级，而是给可诊断的错误；
 *     设置页「测试连接」走预览态（override），不要求先保存。
 *  2) 适配器层——Songloft / MusicSync 的列表映射与上传解析，字段必须与 lxserver 对齐，
 *     否则「已灌入」页会出现空白行 / 状态不同步。
 *  3) 配置迁移——旧版单账号配置（serverUrl/adminPassword/username）升级后必须自动
 *     变成 platforms 里的第一个 lxserver 账号，老用户不能丢配置。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('../src/core/net')
const svc = require('../src/core/services')
const { Store } = require('../src/core/store')

let pass = 0
function ok(name) { pass++; console.log('  ✓ ' + name) }

/**
 * 重载 lxservice + services/* （用于让后置的 net 打桩生效）。
 * 注意不能连带重载 net.js —— 桩打在 net 模块对象上，net 被重建就等于桩被丢掉，
 * 而新加载的 lxservice 又会解构到原函数，两头落空。
 */
function reloadServices() {
  for (const k of Object.keys(require.cache)) {
    const p = k.replace(/\\/g, '/')
    if (/\/src\/core\/(lxservice\.js|services\/)/.test(p)) delete require.cache[k]
  }
  return require('../src/core/services')
}

// ---------------------------------------------------------------- 路由层
function testRouting() {
  console.log('\n[路由层]')
  const accounts = [
    { id: 'a1', type: 'lxserver', url: 'http://lx:1', username: 'default', password: 'p1' },
    { id: 'a2', type: 'songloft', url: 'http://sl:2', username: 'u2', password: 'p2' },
    { id: 'a3', type: 'musicsync', url: 'http://ms:3', username: 'u3', password: 'p3' }
  ]

  // 选中谁就用谁
  const s1 = svc.getActiveService({ platforms: accounts, activePlatformId: 'a2' })
  assert.strictEqual(s1.acct.id, 'a2')
  assert.strictEqual(s1.type, 'songloft')
  assert.strictEqual(typeof s1.adapter.list, 'function')
  ok('activePlatformId=a2 → 解析到 songloft 账号')

  // activePlatformId 失效（指向已删除账号）时退回第一个，而不是返回 null 让操作莫名失败
  const s2 = svc.getActiveService({ platforms: accounts, activePlatformId: 'gone' })
  assert.strictEqual(s2.acct.id, 'a1')
  ok('activePlatformId 失效 → 回退到第一个账号')

  // 没配账号就返回 null，由调用方转成友好提示
  assert.strictEqual(svc.getActiveService({ platforms: [], activePlatformId: null }), null)
  assert.ok(typeof svc.NO_ACCOUNT_ERR === 'string' && svc.NO_ACCOUNT_ERR.length > 0)
  ok('无账号 → getActiveService 返回 null，且暴露 NO_ACCOUNT_ERR 文案')

  // 设置页「测试连接」用预览态：账号还没保存也应该能测
  const prev = svc.resolveService({ platforms: accounts, activePlatformId: 'a1' },
    { type: 'musicsync', url: 'http://new:9', username: 'n', password: 'p' })
  assert.strictEqual(prev.type, 'musicsync')
  assert.strictEqual(prev.acct.url, 'http://new:9')
  assert.strictEqual(prev.preview, true)
  ok('resolveService(override) → 预览态测试未保存的账号')

  // 无 override 时等同 getActiveService
  const cur = svc.resolveService({ platforms: accounts, activePlatformId: 'a3' }, null)
  assert.strictEqual(cur.acct.id, 'a3')
  assert.strictEqual(cur.preview, false)
  ok('resolveService(无 override) → 取当前选中账号')

  // 三种平台都注册了
  assert.deepStrictEqual(svc.SUPPORTED_TYPES.slice().sort(), ['lxserver', 'musicsync', 'songloft'])
  for (const t of svc.SUPPORTED_TYPES) assert.strictEqual(svc.getService(t).kind, t)
  ok('SUPPORTED_TYPES 三平台齐全，且 kind 自述正确')
}

// ---------------------------------------------------------------- Songloft
async function testSongloft() {
  console.log('\n[Songloft 适配器]')
  const acct = { id: 'x', type: 'songloft', url: 'http://sl:7975/', username: 'u', password: 'p', timeoutMs: 20000 }
  const seen = []
  net.fetchWithTimeout = async (url, init) => {
    seen.push({ url: String(url), init })
    const u = String(url)
    if (u.endsWith('/api/v1/auth/login')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'TK' }) }
    }
    if (u.includes('/api/sources') && init.method === 'GET') {
      return {
        ok: true, status: 200, text: async () => JSON.stringify({
          code: 0, msg: 'success',
          data: {
            list: [
              // platforms 数组形态
              { id: 'a.js', name: '源A', enabled: true, platforms: ['tx', 'wy'] },
              // 服务端也可能给对象形态，必须一并兼容，否则平台徽章全空
              { id: 'b.js', name: '源B', enabled: false, platforms: { kg: 1, kw: 1 } },
              { id: 'c.js', name: '源C' }
            ]
          }
        })
      }
    }
    return { ok: false, status: 500, text: async () => '{}' }
  }

  const a = svc.getService('songloft')
  // 登录必须带 Bearer：插件接口用 token 识别身份，没有就是 401
  assert.strictEqual(a.baseUrl(acct), 'http://sl:7975')
  const v = await a.verify(acct)
  assert.strictEqual(v.ok, true)
  assert.ok(seen.some(s => s.url.endsWith('/api/v1/auth/login')))
  ok('verify：先登录拿 token（baseUrl 已去掉末尾斜杠）')

  const list = await a.list(acct)
  assert.strictEqual(list.length, 3)
  // 字段必须与 lxserver 对齐，否则「已灌入」页会渲染出空白行
  assert.strictEqual(list[0].id, 'a.js')
  assert.strictEqual(list[0].name, '源A')
  assert.strictEqual(list[0].enabled, true)
  assert.deepStrictEqual(list[0].supportedSources, ['tx', 'wy'])
  assert.deepStrictEqual(list[0].disabledSources, [])
  ok('list：数组形态 platforms → supportedSources')

  assert.deepStrictEqual(list[1].supportedSources, ['kg', 'kw'])
  assert.strictEqual(list[1].enabled, false)
  ok('list：对象形态 platforms → 取键（兼容两种服务端写法）')

  assert.strictEqual(list[2].enabled, true)   // 缺 enabled 视为启用，不能默认成禁用
  assert.deepStrictEqual(list[2].supportedSources, [])
  ok('list：字段缺失时 enabled 默认 true，不误判为已停用')

  // Songloft 无平台级停用接口 → setPlatforms 必须降级为全局 toggle，而不是报错
  seen.length = 0
  const sp = await (async () => {
    net.fetchWithTimeout = async (url, init) => {
      seen.push({ url: String(url), init })
      if (String(url).endsWith('/api/v1/auth/login')) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'TK' }) }
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) }
    }
    return await a.setPlatforms(acct, 'a.js', ['tx'])
  })()
  assert.strictEqual(sp.success, true)
  const body = JSON.parse(seen[seen.length - 1].init.body)
  assert.strictEqual(body.id, 'a.js')
  assert.strictEqual(body.enabled, false)   // 有停用平台 → 全局禁用
  ok('setPlatforms：无平台级停用接口 → 降级为全局 toggle(enabled=false)')
}

// ---------------------------------------------------------------- MusicSync
async function testMusicSync() {
  console.log('\n[MusicSync 适配器]')
  const acct = { id: 'y', type: 'musicsync', url: 'http://ms:7926/', username: 'u', password: 'p', timeoutMs: 20000 }
  const a = svc.getService('musicsync')
  assert.strictEqual(a.baseUrl(acct), 'http://ms:7926')

  // 三类真实脚本写法都要解析出平台（实测 14 条线上音源覆盖前两档）
  const scripts = [
    { name: 'v1式', script: "const supportedSources = ['tx','wy']\n", want: ['tx', 'wy'] },
    { name: 'v2式MUSIC_QUALITY', script: "const MUSIC_QUALITY = {\n  kw: ['128k'],\n  kg: ['128k'],\n  tx: ['128k'],\n}\nconst MUSIC_SOURCE = Object.keys(MUSIC_QUALITY)\n", want: ['kw', 'kg', 'tx'] },
    { name: 'MUSIC_SOURCE数组', script: "const MUSIC_SOURCE = ['kg','mg']\n", want: ['kg', 'mg'] },
    { name: '混淆到无法解析', script: 'var _0x1=[1,2,3];function f(){return _0x1}\n', want: [] }
  ]
  for (const s of scripts) {
    net.fetchWithTimeout = async (url) => {
      const u = String(url)
      if (u.endsWith('/api/auth/login')) return { ok: true, status: 200, text: async () => JSON.stringify({ token: 'TK' }) }
      return { ok: true, status: 200, text: async () => JSON.stringify({ apis: [{ id: 'u1', name: s.name, script: s.script, enabled: true }] }) }
    }
    const list = await a.list(acct)
    assert.deepStrictEqual(list[0].supportedSources, s.want, '解析失败：' + s.name)
  }
  ok('list：supportedSources / MUSIC_QUALITY / MUSIC_SOURCE 三档解析，混淆脚本不谎报')

  // 上传：服务端返回解析好的 sources 就直接用（比本地正则准）
  net.fetchWithTimeout = async (url, init) => {
    const u = String(url)
    if (u.endsWith('/api/auth/login')) return { ok: true, status: 200, text: async () => JSON.stringify({ token: 'TK' }) }
    if (u.endsWith('/api/user-api') && init.method === 'POST') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, id: 'u9', name: 'n9', sources: { tx: 1, wy: 1, kg: 1, kw: 1, mg: 1 } }) }
    }
    return { ok: false, status: 500, text: async () => '{}' }
  }
  const up = await a.upload(acct, 'code', 'demo.js')
  assert.strictEqual(up.success, true)
  assert.strictEqual(up.id, 'u9')
  assert.deepStrictEqual(up.platforms, ['tx', 'wy', 'kg', 'kw', 'mg'])
  ok('upload：优先采用服务端解析的 sources（本地正则只作兜底）')

  // 关闭「灌入后自动启用」时要显式禁用：MusicSync 创建接口默认启用
  let toggled = null
  net.fetchWithTimeout = async (url, init) => {
    const u = String(url)
    if (u.endsWith('/api/auth/login')) return { ok: true, status: 200, text: async () => JSON.stringify({ token: 'TK' }) }
    if (u.endsWith('/api/user-api') && init.method === 'POST') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, id: 'u9', name: 'n9', sources: { tx: 1 } }) }
    }
    if (init.method === 'PUT') { toggled = { url: u, body: JSON.parse(init.body) }; return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) } }
    return { ok: false, status: 500, text: async () => '{}' }
  }
  await a.upload(Object.assign({}, acct, { enableAfterImport: false }), 'code', 'demo.js')
  assert.ok(toggled, '未发出禁用请求')
  assert.strictEqual(toggled.body.enabled, false)
  ok('upload：enableAfterImport=false → 创建后显式禁用')
}

// ---------------------------------------------------------------- lxserver 薄包装
async function testLxserver() {
  console.log('\n[lxserver 薄包装]')
  const acct = { id: 'z', type: 'lxserver', url: 'http://lx:7968/', username: 'admin', password: 'pw', timeoutMs: 25000 }
  const seen = []
  net.fetchWithTimeout = async (url, init) => {
    seen.push({ url: String(url), init })
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, list: [] }) }
  }
  // lxserver 只是 lxservice 的薄包装，而 lxservice 保持零改动（18 个既有测试依赖它的原样行为），
  // 它内部是加载时解构 fetchWithTimeout —— 所以这里装好桩之后再重载一次才能打进去。
  const a = reloadServices().getService('lxserver')
  await a.verify(acct)
  const first = seen[0]
  // 账号字段 → 旧版 cfg 字段的映射必须正确，否则老 lxservice 会连错地址/用错身份
  assert.strictEqual(first.url, 'http://lx:7968/api/admin/verify')
  assert.strictEqual(first.init.headers['x-frontend-auth'], 'pw')
  ok('verify：账号字段正确映射为 lxservice 的 cfg（url 去斜杠 + x-frontend-auth）')

  seen.length = 0
  await a.list(acct)
  // lxserver 的 list 是「公开源 + 该身份私有源」的合并视图：会先拉 default 再拉账号身份，
  // 所以断言「有任一请求带上账号身份」，而不是「第一条就是它」
  assert.ok(seen.some(s => String(s.url).includes('username=admin')),
    '未按账号身份拉取：' + seen.map(s => s.url).join(' , '))
  ok('list：按账号 username 拉取（保留 lxserver 公开+私有合并的口径）')

  // 只有 lxserver 有公共音源清理能力
  assert.strictEqual(typeof a.listPublic, 'function')
  assert.strictEqual(typeof a.removePublicBatch, 'function')
  assert.strictEqual(svc.getService('songloft').listPublic, undefined)
  assert.strictEqual(svc.getService('musicsync').listPublic, undefined)
  ok('公共音源清理仅 lxserver 提供（songloft/musicsync 不暴露，避免误删）')
}

// ---------------------------------------------------------------- 配置迁移
function testMigration() {
  console.log('\n[旧配置迁移]')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-'))
  const cfgFile = path.join(dir, 'config.json')

  // 旧版配置：只有单账号三件套
  fs.writeFileSync(cfgFile, JSON.stringify({
    serverUrl: 'http://old:7968',
    adminPassword: 'oldpw',
    username: 'admin',
    serverTimeoutMs: 30000
  }))
  const st = new Store(dir)
  assert.strictEqual(st.config.platforms.length, 1)
  const p = st.config.platforms[0]
  assert.strictEqual(p.type, 'lxserver')
  assert.strictEqual(p.url, 'http://old:7968')
  assert.strictEqual(p.password, 'oldpw')
  assert.strictEqual(p.username, 'admin')
  assert.strictEqual(p.timeoutMs, 30000)
  assert.strictEqual(st.config.activePlatformId, p.id)
  ok('旧版单账号字段 → 自动迁移为第一个 lxserver 账号并设为当前')

  // 迁移必须落盘，否则下次启动又迁一遍
  const reread = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  assert.strictEqual((reread.platforms || []).length, 1)
  ok('迁移结果已写回 config.json')

  // 已是多平台配置的：不要覆盖
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-'))
  fs.writeFileSync(path.join(dir2, 'config.json'), JSON.stringify({
    serverUrl: 'http://old:7968',
    platforms: [
      { id: 'p1', type: 'songloft', url: 'http://sl:1' },
      { id: 'p2', type: 'musicsync', url: 'http://ms:2' }
    ],
    activePlatformId: 'p2'
  }))
  const st2 = new Store(dir2)
  assert.strictEqual(st2.config.platforms.length, 2)
  assert.strictEqual(st2.config.activePlatformId, 'p2')
  // 缺字段的老账号要补齐默认值
  assert.strictEqual(st2.config.platforms[0].timeoutMs, 25000)
  assert.strictEqual(st2.config.platforms[0].enabled, true)
  ok('已有多平台配置 → 原样保留，仅补齐缺失默认字段')

  // 空配置：不凭空造账号（UI 会提示先添加）
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-'))
  const st3 = new Store(dir3)
  assert.deepStrictEqual(st3.config.platforms, [])
  assert.strictEqual(st3.config.activePlatformId, null)
  ok('全新安装 → platforms 为空，不凭空造账号')

  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(dir2, { recursive: true, force: true })
  fs.rmSync(dir3, { recursive: true, force: true })
}

;(async () => {
  testRouting()
  await testSongloft()
  await testMusicSync()
  await testLxserver()
  testMigration()
  console.log(`\n全部通过：${pass} 项断言组`)
})().catch(e => { console.error('\n✗ 失败：', e && e.message); process.exit(1) })
