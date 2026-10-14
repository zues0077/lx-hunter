'use strict'
/**
 * v1.7.4：公共音源清理 —— 只删 lxserver 公开源（_open），绝不碰账号私有源
 *
 * 背景（PC 版实践发现的问题）：lxserver 音源分两套存储：
 *  - 公开源 owner=open（_open 目录）：LX 网页端音源管理页可见，猎手灌入落点
 *  - 私有源 owner=<用户名>：只对该账号可用，网页端看不到
 * 用户要「清掉网页端那一堆公共音源重新灌入」的能力，且绝不能误删私有源。
 *
 * lxserver handleDelete 口径：username=default ⇒ targetOwner='open' 只查 _open，
 * 且「回退 open」兜底只在 targetOwner≠open 时触发 —— default 删除物理上
 * 不可能碰私有目录。本测试逐条断言这个口径。
 */
const assert = require('assert')
const net = require('../src/core/net')

const seen = []
let mode = 'ok'
// 注意：lxservice 在 require 时就以解构方式捕获了 fetchWithTimeout，
// 之后替换 net.fetchWithTimeout 对它无效 —— 所有失败场景都要靠这同一个桩的开关控制
const failAt = new Set()    // 指定第几次（1-based）请求返回「业务失败」
const netErrAt = new Set()  // 指定第几次请求抛「网络级错误」（超时/连接被拒）
net.fetchWithTimeout = async (url, init) => {
  seen.push({ url: String(url), init })
  const n = seen.length
  if (netErrAt.has(n)) throw new Error('The operation was aborted due to timeout')
  if (mode === 'deleteFail' || failAt.has(n)) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: false, error: '源不存在' }) }
  }
  return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) }
}

const lx = require('../src/core/lxservice')
const cfg = { serverUrl: 'http://srv.test:7968', adminPassword: 'pw', username: 'admin' }

let pass = 0
function ck(name, cond, extra) {
  assert.ok(cond, name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''))
  pass++
}

;(async () => {
  // ---- planPublicCleanup 纯函数 ----
  const serverList = [
    { id: 'openA.js', name: '公开A', owner: 'open' },
    { id: 'openB.js', name: '公开B', owner: '_open' },
    { id: 'openC.js', name: '公开C' },                       // owner 缺省 = 公开
    { id: 'privA.js', name: '私有A', owner: 'admin' },
    { id: 'privB.js', name: '私有B', owner: 'default-user' },
    { id: null }
  ]
  const plan = lx.planPublicCleanup(serverList)
  ck('公开源三种 owner 形态都纳入清理', JSON.stringify(plan.publicIds) === JSON.stringify(['openA.js', 'openB.js', 'openC.js']), plan)
  ck('私有源全部排除（绝不触碰）', JSON.stringify(plan.privateIds) === JSON.stringify(['privA.js', 'privB.js']), plan)
  ck('空列表/坏输入不炸', lx.planPublicCleanup(null).publicIds.length === 0 && lx.planPublicCleanup(undefined).privateIds.length === 0)

  // ---- listPublic ----
  mode = 'ok'
  const list = await lx.listPublic(cfg)
  ck('listPublic 返回数组', Array.isArray(list))

  // ---- removePublic：身份恒 default，请求体与 URL 正确 ----
  seen.length = 0
  const r1 = await lx.removePublic(cfg, 'openA.js')
  ck('删除公开源成功', r1.success === true, r1)
  const body1 = JSON.parse(seen[0].init.body)
  ck('删除请求 username=default（只可能删到 _open）', body1.username === 'default', seen[0].init.body)
  ck('删除请求带对 id', body1.id === 'openA.js', seen[0].init.body)
  ck('删除打到 /api/custom-source/delete', /\/api\/custom-source\/delete$/.test(seen[0].url), seen[0].url)
  ck('删除带 x-frontend-auth 管理员头', seen[0].init.headers['x-frontend-auth'] === 'pw', seen[0].init.headers)

  // ---- removePublic：服务端失败映射 ----
  mode = 'deleteFail'
  const r2 = await lx.removePublic(cfg, 'gone.js')
  ck('服务端删失败返回 success=false 与原因', r2.success === false && /源不存在/.test(r2.message), r2)
  mode = 'ok'

  // ---- removePublicBatch：串行、逐条请求、失败不中断 ----
  seen.length = 0
  failAt.clear()
  failAt.add(2)   // 第二条故意失败（模拟网页端已手动删掉），第三、四条必须继续
  const batch = await lx.removePublicBatch(cfg, ['a.js', 'b.js', 'c.js', 'd.js'])
  ck('批删共 4 次请求（串行逐个删）', seen.length === 4, seen.length)
  ck('每个请求都是 username=default', seen.every(s => JSON.parse(s.init.body).username === 'default'), seen.map(s => s.init.body))
  ck('批删按传入顺序执行', seen.map(s => JSON.parse(s.init.body).id).join(',') === 'a.js,b.js,c.js,d.js', seen.map(s => s.init.body))
  ck('批删计数：3 成 1 败', batch.total === 4 && batch.ok === 3 && batch.failed === 1, batch)
  ck('批删逐条结果含失败项', batch.results.filter(r => !r.success).length === 1 && batch.results[1].id === 'b.js', batch.results)
  ck('批删结果顺序与输入一致', batch.results.map(r => r.id).join(',') === 'a.js,b.js,c.js,d.js')
  ck('批删单条失败不抛异常', true)

  // ---- 过滤脏 id ----
  seen.length = 0
  const batch2 = await lx.removePublicBatch(cfg, ['x.js', null, '', 123, 'y.js'])
  ck('批删过滤非字符串/空 id', batch2.total === 2 && seen.length === 2, batch2)

  // ---- 连续删除保护（README v1.6.8 教训：12 连删把服务端拖到假死）----
  seen.length = 0
  failAt.clear(); netErrAt.clear()
  const t0 = Date.now()
  const batch3 = await lx.removePublicBatch(Object.assign({}, cfg, { serverDeleteIntervalMs: 60 }), ['a.js', 'b.js', 'c.js'])
  const elapsed = Date.now() - t0
  ck('每个删除之间留间隔（2 个间隔 ≈120ms）', elapsed >= 100, { elapsed })
  ck('间隔不影响删除结果', batch3.ok === 3 && seen.length === 3, batch3)
  seen.length = 0
  await lx.removePublicBatch(Object.assign({}, cfg, { serverDeleteIntervalMs: 0 }), ['a.js', 'b.js'])
  ck('间隔可配置为 0（关闭保护）', seen.length === 2)

  // ---- 网络级失败：立即中止整批，剩余项不动 ----
  seen.length = 0
  failAt.clear(); netErrAt.clear()
  netErrAt.add(2)
  const batch4 = await lx.removePublicBatch(cfg, ['a.js', 'b.js', 'c.js', 'd.js'])
  ck('网络级失败中止整批（不再继续施压服务端）', batch4.aborted === true, batch4)
  ck('中止后剩余项记进 skipped', JSON.stringify(batch4.skipped) === JSON.stringify(['c.js', 'd.js']), batch4)
  ck('中止后不再发请求（只发了 2 次）', seen.length === 2, seen.length)
  ck('中止仍对账：1 成 1 败', batch4.ok === 1 && batch4.failed === 1, batch4)
  ck('网络错误消息透传（timeout）', /abort/i.test(batch4.results[1].message), batch4.results[1])

  // ---- 业务失败（源不存在）不算网络故障，不中止 ----
  seen.length = 0
  failAt.clear(); netErrAt.clear()
  failAt.add(2)
  const batch5 = await lx.removePublicBatch(Object.assign({}, cfg, { serverDeleteIntervalMs: 0 }), ['a.js', 'b.js', 'c.js'])
  ck('「源不存在」不中止整批', batch5.aborted === false && seen.length === 3, batch5)

  console.log(`public-cleanup: ${pass} assertions ALL PASS`)
})().catch(e => { console.error('FAIL:', e.message); process.exit(1) })
