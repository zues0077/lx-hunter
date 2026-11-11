'use strict'
/**
 * v1.13.0：hunter._refreshServerVeto —— 顺序与「读不到列表不清表」两条硬约束
 *
 * 这两条如果做错，后果都很直接：
 *  1) 先账本对账再冻结 → 「服务端已删除」被当成「从没灌过」，下一轮照样灌回去（功能白做）；
 *  2) 列表读失败时按「全部消失」算 → 一次网络抖动就把整库源冻死（比不修还糟）。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Hunter } = require('../src/core/hunter')
const { Store } = require('../src/core/store')
const { VETO_TYPES } = require('../src/core/serverVeto')

let pass = 0
function ok(name) { pass++; console.log('  ✓ ' + name) }

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-veto-'))
  return new Store(dir)
}
function mkHunter(store) {
  const h = Object.create(Hunter.prototype)
  h.store = store
  h.job = { running: false, cancel: false }
  h.emit = () => {}
  h.log = () => {}
  h.step = () => {}
  h.progress = () => {}
  return h
}
function seed(s, extra) {
  s.db.sources = Object.assign({
    e1: { id: 'e1', name: '测试源', contentHash: 'sha1' }
  }, extra || {})
  s.imported = { e1: { lxId: 'src.js', platformId: 'p1', contentHash: 'sha1' } }
  s.db.veto = {}
}
const plan = (serverList, isolateIds) => ({
  svc: {
    acct: { id: 'p1', type: 'lxserver', name: '主账号' },
    adapter: { listIsolations: async () => isolateIds || [] }
  },
  label: '主账号',
  serverList
})

async function main() {
  console.log('服务端处置冻结 · hunter 接入')

  {
    const s = mkStore(); seed(s)
    const h = mkHunter(s)
    await h._refreshServerVeto([plan([])], 'p1')   // 服务端列表里没有 src.js = 被删了
    assert.strictEqual(s.db.veto.e1.type, VETO_TYPES.REMOVED)
    assert.strictEqual(s.db.veto.e1.lxId, 'src.js')
    ok('服务端已删除 → 记为 removed')
  }

  {
    // 关键顺序：先冻结，再对账。对账会把记录摘掉，之后再算就只剩「从没灌过」。
    const s = mkStore(); seed(s)
    const h = mkHunter(s)
    await h._refreshServerVeto([plan([])], 'p1')
    const rc = h.reconcileImported('p1', [])
    assert.ok(rc.dropped >= 1, '对账确实摘掉了记录')
    assert.strictEqual(s.db.veto.e1.type, VETO_TYPES.REMOVED, '摘记录之后冻结仍在')
    ok('先冻结再对账：删除动作不会因为「记录被摘掉」而丢失')
  }

  {
    const s = mkStore(); seed(s)
    const h = mkHunter(s)
    s.db.veto = { e1: { type: VETO_TYPES.DISABLED, sha: 'sha1', since: 1 } }
    const before = JSON.stringify(s.db.veto)
    await h._refreshServerVeto([plan(null)], 'p1')   // 列表没读到
    assert.strictEqual(JSON.stringify(s.db.veto), before, '冻结表原样保留')
    ok('服务端列表未读到时不改冻结表（防一次抖动冻死全库）')
  }

  {
    const s = mkStore(); seed(s)
    const h = mkHunter(s)
    await h._refreshServerVeto([plan([{ id: 'src.js', enabled: true, supportedSources: ['kw'] }], ['src.js'])], 'p1')
    assert.strictEqual(s.db.veto.e1.type, VETO_TYPES.ISOLATED)
    ok('护栏隔离名单接入（enabled:true 也能识别）')
  }

  {
    // 内容更新后：旧冻结失效，不该再冻新版本
    const s = mkStore(); seed(s)
    const h = mkHunter(s)
    s.db.veto = { e1: { type: VETO_TYPES.DISABLED, sha: 'sha1', since: 1 } }
    s.db.sources.e1.contentHash = 'sha2'
    await h._refreshServerVeto([plan([{ id: 'src.js', enabled: false }])], 'p1')
    assert.strictEqual(s.db.veto.e1, undefined)
    ok('音源内容更新 → 自动解冻（下次可重灌）')
  }

  {
    // 多平台并集：删除最优先
    const s = mkStore(); seed(s)
    const h = mkHunter(s)
    const p2 = { svc: { acct: { id: 'p2' }, adapter: { listIsolations: async () => [] } }, label: '副账号', serverList: [{ id: 'src.js', enabled: false }] }
    await h._refreshServerVeto([plan([]), p2], 'p1')
    assert.strictEqual(s.db.veto.e1.type, VETO_TYPES.REMOVED)
    ok('多平台取并集，删除优先级最高')
  }

  console.log(`\n全部通过（${pass} 项）`)
}

main().catch(e => { console.error(e); process.exit(1) })
