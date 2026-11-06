'use strict'
/**
 * v1.10.2 回归：私人音源（「导入单个音源」入库）完全不参与健康巡检。
 *
 * 两层验证：
 *  ① buildPatrolItems 纯函数：队列层就排除 private:true，且不影响其它过滤口径；
 *     内含「旧实现反向对照」，防止断言恒真。
 *  ② runPatrol 集成：桩掉 checkBasic/deepCheck，验证私人源不被重测、不累计失效次数、
 *     不写 lastPatrol、不被自动禁用/删除、不计入巡检统计；非私人对照组必须照常巡检，
 *     避免把保护写成「所有源都不巡检」。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const checker = require('../src/core/checker')

const checkCalls = []
checker.checkBasic = async (e) => {
  checkCalls.push(e.id)
  e.status = 'ok'; e.suspected = true; e.error = ''
  return { code: 'SCRIPT_CODE' }
}
checker.deepCheck = async () => ({
  loadable: true, cancelled: false, loadError: null, deadDomain: true,
  platforms: { wy: { status: 'failed', message: '接口域名已失效（公共 DNS 确认不存在）' } },
  usable: 0, hash: 'h', checkedAt: Date.now()
})
// 让 hunter 捕获上面的桩（hunter.js 顶部是解构 require）
delete require.cache[require.resolve('../src/core/hunter')]
const { Hunter, buildPatrolItems } = require('../src/core/hunter')
const { Store, DEFAULT_CONFIG } = require('../src/core/store')

let pass = 0
const ok = (name, cond, extra) => {
  assert.ok(cond, name + (extra ? ' -> ' + extra : ''))
  pass++
  console.log('PASS  ' + name)
}

// ---------------- ① 纯函数：队列过滤 ----------------
const alive = new Set(['lx_p', 'lx_p2', 'lx_n1', 'lx_n2', 'lx_n3', 'lx_n4'])
const sources = {
  p:     { id: 'p',     name: '私人源（url 空 + 本地正文）', url: '', code: 'PRIVATE_CODE', private: true },
  p2:    { id: 'p2',    name: '私人源（有 url）',            url: 'https://example.com/p2.js', private: true },
  n1:    { id: 'n1',    name: '普通源',                      url: 'https://example.com/n1.js' },
  n2:    { id: 'n2',    name: '本地正文非私人源',            url: '', code: 'LOCAL_CODE' },
  n3:    { id: 'n3',    name: '无脚本地址源',                url: '' },
  n4:    { id: 'n4',    name: '显式 private:false',          url: 'https://example.com/n4.js', private: false },
  gone:  { id: 'gone',  name: '服务端已删',                  url: 'https://example.com/gone.js' },
  nolid: { id: 'nolid', name: '无 lxId',                     url: 'https://example.com/nolid.js' }
  // nolocal 故意不放进 sources（无本地记录）
}
const imported = {
  p:      { lxId: 'lx_p',     name: '私人源' },
  p2:     { lxId: 'lx_p2',    name: '带 url 私人源' },
  n1:     { lxId: 'lx_n1',    name: '普通源' },
  n2:     { lxId: 'lx_n2',    name: '本地正文源' },
  n3:     { lxId: 'lx_n3',    name: '无脚本地址源' },
  n4:     { lxId: 'lx_n4',    name: '显式非私人' },
  gone:   { lxId: 'lx_dead',  name: '服务端已删' },
  nolid:  { name: '无 lxId' },
  nolocal:{ lxId: 'lx_x',     name: '无本地记录' }
}

const ids = buildPatrolItems(imported, sources, alive).map(x => x.srcId)
ok('私人源（url 空 + 本地正文）不进巡检队列', !ids.includes('p'), ids.join(','))
ok('私人源即使有 url 也不进巡检队列', !ids.includes('p2'))
ok('普通源照常进队列（保护不放大化）', ids.includes('n1'))
ok('非私人、url 空但有本地正文的条目仍可复测（旧例外未被破坏）', ids.includes('n2'))
ok('显式 private:false 的条目照常进队列', ids.includes('n4'))
ok('无 url 且无正文的条目仍跳过', !ids.includes('n3'))
ok('服务端已不存在的条目仍跳过', !ids.includes('gone'))
ok('无 lxId 的条目仍跳过', !ids.includes('nolid'))
ok('无本地记录的条目仍跳过', !ids.includes('nolocal'))
ok('队列总数精确为 3', ids.length === 3, ids.join(','))
ok('返回结构含 srcId / e / rec', (() => {
  const it = buildPatrolItems(imported, sources, alive)[0]
  return !!(it && it.srcId && it.e && it.rec)
})())
ok('aliveLxIds 传数组也可用', buildPatrolItems(
  { n1: imported.n1 }, { n1: sources.n1 }, ['lx_n1']
).length === 1)
ok('空输入返回空数组', buildPatrolItems({}, {}, new Set()).length === 0)
ok('imported 为空返回空数组', buildPatrolItems(null, sources, alive).length === 0)

// 反向对照：把 v1.10.0 的旧队列构造逻辑原样复制一遍，它必然会把私人源放进队列。
// 若新实现忘了排除 private，下面这条就会失败 —— 防止断言恒真。
const legacy = []
for (const [srcId, rec] of Object.entries(imported)) {
  if (!rec || !rec.lxId || !alive.has(rec.lxId)) continue
  const e = sources[srcId]
  if (!e || (!e.url && typeof e.code !== 'string')) continue
  legacy.push(srcId)
}
ok('反向对照：旧实现确实会把私人源放进巡检队列', legacy.includes('p') && legacy.includes('p2'), legacy.join(','))

// ---------------- ② 集成：runPatrol 行为 ----------------
;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-private-patrol-'))
  const store = new Store(dir)
  store.config = Object.assign({}, DEFAULT_CONFIG, store.config, {
    patrolAutoDelete: true, patrolDeleteAfter: 1, patrolAutoDisable: true, serverDeleteIntervalMs: 5
  })
  const privId = 'private::我的私人源'
  const pubId = 'foo/bar::a.js'
  // 私人源故意设成「已连续失效 7 次」：若仍参与巡检，必然触发自动删除，构成强对照。
  store.imported[privId] = { lxId: 'lx_priv', name: '私人源', patrolFailStreak: 7 }
  store.imported[pubId] = { lxId: 'lx_pub', name: '普通源', patrolFailStreak: 2 }
  store.db.sources[privId] = {
    id: privId, name: '私人源', url: '', code: 'PRIVATE_CODE', private: true,
    status: 'ok', suspected: true, usable: false
  }
  store.db.sources[pubId] = {
    id: pubId, name: '普通源', url: 'https://example.com/a.js',
    status: 'ok', suspected: true, usable: false
  }
  store.saveImported(); store.saveDb()

  const removed = [], platformWrites = [], logs = []
  const fakeAdapter = {
    list: async () => [{ id: 'lx_priv', owner: 'open' }, { id: 'lx_pub', owner: 'open' }],
    remove: async (acct, id) => { removed.push(id); return { success: true } },
    setPlatforms: async (acct, id) => { platformWrites.push(id); return { success: true } },
    toggle: async () => ({ success: true })
  }
  const hunter = new Hunter(store, (t, p) => { if (t === 'log' && p && p.msg) logs.push(p.msg) })
  hunter._active = () => ({ adapter: fakeAdapter, acct: { id: 'p1', name: 't' } })

  const res = await hunter.runPatrol()

  ok('checkBasic 只被调用 1 次（仅非私人源）', checkCalls.length === 1, JSON.stringify(checkCalls))
  ok('checkBasic 从未收到私人源', !checkCalls.includes(privId))
  ok('巡检统计 total 不含私人源', res.total === 1, JSON.stringify(res))
  ok('私人源未被服务端删除', !removed.includes('lx_priv'), JSON.stringify(removed))
  ok('私人源未被自动禁用/启用写入', !platformWrites.includes('lx_priv'), JSON.stringify(platformWrites))
  ok('非私人对照组确实被巡检处置（删除或禁用）',
    removed.includes('lx_pub') || platformWrites.includes('lx_pub'),
    JSON.stringify({ removed, platformWrites }))
  ok('私人源 imported 记录仍在', !!store.imported[privId])
  ok('私人源失效次数未被巡检改动', store.imported[privId].patrolFailStreak === 7)
  ok('私人源未被写入 lastPatrol', !store.imported[privId].lastPatrol)
  ok('私人源条目仍在音源库', !!store.db.sources[privId])
  ok('私人源状态未被巡检重测改动', store.db.sources[privId].status === 'ok' && !store.db.sources[privId].checking)
  ok('日志明确提示已跳过私人音源', logs.some(m => /已跳过 1 个私人音源/.test(m)), JSON.stringify(logs))

  // 场景 B：库里只有私人源时，巡检应直接空队列返回，不产生任何检测/写操作
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-private-only-'))
  const store2 = new Store(dir2)
  store2.config = Object.assign({}, DEFAULT_CONFIG, store2.config, {
    patrolAutoDelete: true, patrolDeleteAfter: 1, patrolAutoDisable: true, serverDeleteIntervalMs: 5
  })
  const onlyId = 'private::只有我一个'
  store2.imported[onlyId] = { lxId: 'lx_only', name: '只有我一个', patrolFailStreak: 9 }
  store2.db.sources[onlyId] = {
    id: onlyId, name: '只有我一个', url: '', code: 'PRIVATE_CODE', private: true, status: 'ok', suspected: true
  }
  store2.saveImported(); store2.saveDb()
  const before = checkCalls.length
  const hunter2 = new Hunter(store2, () => {})
  hunter2._active = () => ({
    adapter: { list: async () => [{ id: 'lx_only', owner: 'open' }], remove: async () => ({ success: true }), setPlatforms: async () => ({ success: true }), toggle: async () => ({ success: true }) },
    acct: { id: 'p1', name: 't' }
  })
  const res2 = await hunter2.runPatrol()
  ok('只有私人源时巡检空队列返回', res2.total === 0, JSON.stringify(res2))
  ok('只有私人源时不产生任何检测调用', checkCalls.length === before)
  ok('只有私人源时 imported 记录完好', store2.imported[onlyId] && store2.imported[onlyId].patrolFailStreak === 9)

  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(dir2, { recursive: true, force: true })
  console.log(`\nprivate-patrol.test.js：${pass} 项断言全部通过`)
})().catch(e => { console.error('FAIL', e); process.exit(1) })
