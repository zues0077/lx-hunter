'use strict'
/**
 * v1.13.0：服务端动作 → 本地冻结（serverVeto）
 *
 * 用户口径（2026-11-11 拍板）：
 *  - lx-music 侧的「删除 / 整源禁用 / 单平台禁用」都算系统动作，hunter 收到后要打标记；
 *  - 标记后**所有服务端平台**都不再上传该音源；
 *  - 直到该音源有更新（contentHash 变化）才解冻。
 *
 * 这里只测纯函数：把服务端列表 + 本地账本翻译成冻结表，以及「内容变了自动解冻」这条规则。
 * 顺序约束（必须先冻结再账本对账、列表读不到不清表）在 hunter._refreshServerVeto 里，
 * 由 tests/server-veto-hunter.test.js 覆盖。
 */
const assert = require('assert')
const {
  computeVeto, isFrozen, vetoReason, splitFrozen, VETO_TYPES
} = require('../src/core/serverVeto')

let pass = 0
function ok(name, fn) {
  fn()
  pass++
  console.log('  ✓ ' + name)
}

const NOW = 1794400000000

/** 造一条「已灌入」的账本记录 */
const rec = (lxId, platformId) => ({ lxId, platformId: platformId || 'p1', contentHash: 'sha-old' })

console.log('服务端处置冻结（serverVeto）')

ok('整源禁用 → disabled，且冻结', () => {
  const r = computeVeto({
    imported: { e1: rec('src.js') },
    sources: { e1: { id: 'e1', contentHash: 'sha-old' } },
    serverList: [{ id: 'src.js', enabled: false, supportedSources: ['kw', 'wy'] }],
    activePlatformId: 'p1',
    prev: {},
    now: NOW
  })
  assert.strictEqual(r.veto.e1.type, VETO_TYPES.DISABLED)
  assert.strictEqual(isFrozen(r.veto, { id: 'e1', contentHash: 'sha-old' }), true)
  assert.ok(vetoReason(r.veto.e1).indexOf('禁用') >= 0)
})

ok('单平台禁用 → platform-disabled（同样整源冻结，因为同一份字节）', () => {
  const r = computeVeto({
    imported: { e1: rec('src.js') },
    sources: { e1: { id: 'e1', contentHash: 'sha-old' } },
    serverList: [{ id: 'src.js', enabled: true, supportedSources: ['kw', 'wy', 'mg'], disabledSources: ['mg'] }],
    activePlatformId: 'p1',
    prev: {},
    now: NOW
  })
  assert.strictEqual(r.veto.e1.type, VETO_TYPES.PLATFORM_DISABLED)
  assert.ok(/mg/.test(r.veto.e1.detail))
  assert.strictEqual(isFrozen(r.veto, { id: 'e1', contentHash: 'sha-old' }), true)
})

ok('全部平台被禁 → 仍然 platform-disabled，但原因写明「全部平台」', () => {
  const r = computeVeto({
    imported: { e1: rec('src.js') },
    sources: { e1: { id: 'e1', contentHash: 'sha-old' } },
    serverList: [{ id: 'src.js', enabled: true, supportedSources: ['kw', 'wy'], disabledSources: ['kw', 'wy'] }],
    activePlatformId: 'p1',
    prev: {},
    now: NOW
  })
  assert.ok(/全部平台/.test(r.veto.e1.detail))
})

ok('服务端已删除 → removed（优先级最高）', () => {
  const r = computeVeto({
    imported: { e1: rec('gone.js') },
    sources: { e1: { id: 'e1', contentHash: 'sha-old' } },
    serverList: [{ id: 'other.js', enabled: true }],
    activePlatformId: 'p1',
    prev: {},
    now: NOW
  })
  assert.strictEqual(r.veto.e1.type, VETO_TYPES.REMOVED)
})

ok('护栏隔离 → isolated，且压过 disabled', () => {
  const r = computeVeto({
    imported: { e1: rec('src.js') },
    sources: { e1: { id: 'e1', contentHash: 'sha-old' } },
    serverList: [{ id: 'src.js', enabled: false, supportedSources: ['kw'] }],
    isolatedIds: ['src.js'],
    activePlatformId: 'p1',
    prev: {},
    now: NOW
  })
  assert.strictEqual(r.veto.e1.type, VETO_TYPES.ISOLATED)
})

ok('内容更新（contentHash 变化）→ 自动解冻，不写冻结', () => {
  const r = computeVeto({
    imported: { e1: rec('src.js') },
    sources: { e1: { id: 'e1', contentHash: 'sha-new' } },
    serverList: [{ id: 'src.js', enabled: false }],
    activePlatformId: 'p1',
    prev: { e1: { type: VETO_TYPES.DISABLED, sha: 'sha-old', since: NOW - 86400000 } },
    now: NOW
  })
  assert.strictEqual(r.veto.e1, undefined)
  assert.strictEqual(r.cleared, 1)
})

ok('同一类型重复刷新保留 since（界面能显示「冻结了多久」）', () => {
  const prevSince = NOW - 3 * 86400000
  const r = computeVeto({
    imported: { e1: rec('src.js') },
    sources: { e1: { id: 'e1', contentHash: 'sha-old' } },
    serverList: [{ id: 'src.js', enabled: false }],
    activePlatformId: 'p1',
    prev: { e1: { type: VETO_TYPES.DISABLED, sha: 'sha-old', since: prevSince } },
    now: NOW
  })
  assert.strictEqual(r.veto.e1.since, prevSince)
  assert.strictEqual(r.kept, 1)
})

ok('没灌入过的音源不参与（没有账本就谈不上服务端动作）', () => {
  const r = computeVeto({
    imported: {},
    sources: { e9: { id: 'e9', contentHash: 'x' } },
    serverList: [],
    activePlatformId: 'p1',
    prev: {},
    now: NOW
  })
  assert.strictEqual(Object.keys(r.veto).length, 0)
})

ok('splitFrozen 只切出真正冻结的条目', () => {
  const veto = { a: { type: VETO_TYPES.DISABLED, sha: 'sha-a' } }
  const { keep, frozen } = splitFrozen(veto, [
    { id: 'a', contentHash: 'sha-a' },
    { id: 'b', contentHash: 'sha-b' },
    { id: 'a', contentHash: 'sha-changed' }
  ])
  assert.deepStrictEqual(keep.map(x => x.id + ':' + x.contentHash), ['b:sha-b', 'a:sha-changed'])
  assert.strictEqual(frozen.length, 1)
})

ok('多平台账本：importedTo 里的任一 lxId 都能作为判定依据', () => {
  const r = computeVeto({
    imported: { e1: { importedTo: [{ platformId: 'p1', lxId: 'x.js' }, { platformId: 'p2', lxId: 'y.js' }] } },
    sources: { e1: { id: 'e1', contentHash: '' } },
    serverList: [{ id: 'x.js', enabled: false }],
    activePlatformId: 'p1',
    prev: {},
    now: NOW
  })
  assert.strictEqual(r.veto.e1.type, VETO_TYPES.DISABLED)
  assert.strictEqual(r.veto.e1.lxId, 'x.js')
})

console.log(`\n全部通过（${pass} 项）`)
