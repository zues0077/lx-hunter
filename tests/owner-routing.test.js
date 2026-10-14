'use strict'
/**
 * v1.6.7：停用写入按源的 owner 路由身份
 *  - 公开源（owner=open/undefined）→ username=default（写 _open，网页端可见）
 *  - 私有源（owner=admin 等）→ username=admin（写该身份 states，否则对它不生效）
 * 背景：HYWmusic_beta_公益测试 是 admin 私有源，v1.6.6 一律写 default 对它无效。
 */
const assert = require('assert')
const net = require('../src/core/net')

let mode = 'open'
const seen = []
net.fetchWithTimeout = async (url, init) => {
  seen.push({ url: String(url), init })
  if (mode === 'fail') return { ok: false, status: 500, text: async () => JSON.stringify({ success: false, error: 'boom' }) }
  if (mode === 'list') {
    const u = String(url)
    if (u.includes('username=default')) {
      return { ok: true, status: 200, text: async () => JSON.stringify([
        { id: 'open1.js', name: '公开源A', owner: 'open', supportedSources: ['wy'], disabledSources: [] }
      ]) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify([
      { id: 'priv1.js', name: '私有源', owner: 'admin', supportedSources: ['kw'], disabledSources: ['wy'] }
    ]) }
  }
  return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, disabledSources: [] }) }
}
const lx = require('../src/core/lxservice')

const cfg = { serverUrl: 'http://srv.test:7968', adminPassword: 'pw', username: 'admin' }
let pass = 0
function ck(name, cond, extra) {
  assert.ok(cond, name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''))
  pass++
}

;(async () => {
  // 1) 公开源：不传 owner → default
  seen.length = 0
  const r1 = await lx.setPlatforms(cfg, 'open1.js', ['wy'], {})
  ck('公开源写入成功', r1.success === true, r1)
  ck('公开源 username=default（网页端可见）', /username=default/.test(seen[0].init.body) || JSON.parse(seen[0].init.body).username === 'default', seen[0].init.body)

  // 2) 公开源显式 owner=open → 仍 default
  seen.length = 0
  await lx.setPlatforms(cfg, 'open2.js', ['tx'], { owner: 'open' })
  ck('owner=open 也走 default', JSON.parse(seen[0].init.body).username === 'default', seen[0].init.body)

  // 3) 私有源 owner=admin → username=admin（HYWmusic_beta_公益测试 场景）
  seen.length = 0
  const r3 = await lx.setPlatforms(cfg, 'HYWmusic_beta_公益测试.js', ['wy', 'tx', 'kw', 'kg', 'mg'], { owner: 'admin' })
  ck('私有源写入成功', r3.success === true, r3)
  ck('私有源 username=admin（写 admin 身份 states）', JSON.parse(seen[0].init.body).username === 'admin', seen[0].init.body)
  ck('私有源停用平台完整透传', JSON.stringify(JSON.parse(seen[0].init.body).disabledSources) === JSON.stringify(['wy', 'tx', 'kw', 'kg', 'mg']), seen[0].init.body)

  // 4) 私有源恢复启用：空数组也要写对身份
  seen.length = 0
  const r4 = await lx.setPlatforms(cfg, 'HYWmusic_beta_公益测试.js', [], { owner: 'admin' })
  ck('私有源恢复启用写 admin 身份', r4.success === true && JSON.parse(seen[0].init.body).username === 'admin' && JSON.parse(seen[0].init.body).disabledSources.length === 0, seen[0].init.body)

  // 5) 不传 opts（老调用方）不炸，按公开源处理
  seen.length = 0
  const r5 = await lx.setPlatforms(cfg, 'legacy.js', ['kw'])
  ck('缺少 opts 时按公开源处理', r5.success === true && JSON.parse(seen[0].init.body).username === 'default', seen[0].init.body)

  // 6) 失败透传
  mode = 'fail'
  const r6 = await lx.setPlatforms(cfg, 'x.js', ['wy'], { owner: 'admin' })
  ck('服务端失败时不谎报 success', r6.success === false && /boom/.test(r6.message || ''), r6)
  mode = 'open'

  // 7) list 合并视图保留 owner 字段（停用按钮要拿它路由）
  mode = 'list'
  const list = await lx.list(cfg)
  const priv = list.find(s => s.id === 'priv1.js')
  ck('合并列表包含私有源', !!priv, list.map(s => s.id))
  ck('私有源带 owner 字段（供写入路由）', priv && priv.owner === 'admin', priv)
  ck('公开源优先', list.filter(s => s.id === 'open1.js').length === 1)
  mode = 'open'

  // 8) v1.7.5 灌入身份路由：用户名填谁就灌到谁的列表
  const upBody = () => JSON.parse(seen[0].init.body)
  seen.length = 0
  await lx.upload({ serverUrl: 'http://srv.test', username: 'admin' }, '//src', 'a.js')
  ck('upload username=admin → 灌入 admin 私有列表', upBody().username === 'admin', upBody())
  seen.length = 0
  await lx.upload({ serverUrl: 'http://srv.test', username: 'default' }, '//src', 'b.js')
  ck('upload username=default → 灌入公开源', upBody().username === 'default', upBody())
  seen.length = 0
  await lx.upload({ serverUrl: 'http://srv.test', username: '' }, '//src', 'c.js')
  ck('upload 用户名为空 → 兜底公开源', upBody().username === 'default', upBody())
  seen.length = 0
  await lx.upload({ serverUrl: 'http://srv.test', username: 'open' }, '//src', 'd.js')
  ck('upload username=open → 归一为 default（公开源）', upBody().username === 'default', upBody())
  seen.length = 0
  await lx.upload({ serverUrl: 'http://srv.test', username: '  Admin  ' }, '//src', 'e.js')
  ck('upload 用户名首尾空白被裁剪、大小写保留', upBody().username === 'Admin', upBody())
  seen.length = 0
  await lx.importUrl({ serverUrl: 'http://srv.test', username: 'admin' }, 'http://x/y.js', 'y.js')
  ck('importUrl 同样跟随用户名路由', upBody().username === 'admin', upBody())
  seen.length = 0
  await lx.validate({ serverUrl: 'http://srv.test', username: 'admin' }, '//src')
  ck('validate 身份与灌入一致', upBody().username === 'admin', upBody())
  ck('targetUsername 纯函数：default/open/空 归一', lx.targetUsername({ username: 'default' }) === 'default' && lx.targetUsername({ username: 'open' }) === 'default' && lx.targetUsername({}) === 'default' && lx.targetUsername({ username: 'zhang3' }) === 'zhang3')
  // 公开清理恒为 default，绝不随用户名漂移（安全底线）
  seen.length = 0
  mode = 'list'
  await lx.listPublic({ serverUrl: 'http://srv.test', username: 'admin' })
  ck('listPublic 恒以 default 视角（只读公开源）', String(seen[0].url).includes('username=default'), seen[0].url)
  mode = 'open'

  console.log(`owner-routing: ${pass} 项断言全部通过`)
})().catch(e => { console.error('FAIL:', e.message); process.exit(1) })
