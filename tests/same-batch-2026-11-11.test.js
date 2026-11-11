'use strict'
/**
 * 「同批多版本 / 巡检门槛 / 初筛不等于平手」回归（2026-11-11，对应 P-1411）
 *
 * 这一批修的是 alpha.4 一小时实机测试里查出来的 1 个 P0 + 4 个口径缺陷：
 *   P0  一次勾选同一音源的 v1.0.0 + v2.0.0 → 两条都去 replace 服务端同一条旧版 →
 *       第二条 remove 报 HTTP 500 → 退回改名上传 → 服务端并存「（副本2）」，留下的还是低版本。
 *   P1-1 巡检门槛用 `typeof e.code !== 'string'`，空串也能进巡检（灌入侧早就改成「非空」）。
 *   P1-2 本地只跑过初筛时判「质量平手」，文案把「没测过」写成「打平了」，本地新版永远灌不进。
 *   P1-3 深检但 0 样本（平台集为空）也算「已打分」。
 *   P1-4 _markImported 在非打分档时沿用上一版的 score 快照 → 旧画像代表新版。
 */
const assert = require('assert')
const { Hunter, buildPatrolItems } = require('../src/core/hunter')
const { baseNameKey } = require('../src/core/identity')
const Q = require('../src/core/quality')
const U = require('../src/core/sourceUpdate')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')) }
}
function eq(name, got, want) { ok(name, got === want, JSON.stringify(got) + ' ≠ ' + JSON.stringify(want)) }

/** 造一条「本地已深检」的音源条目 */
function mkE(o) {
  const name = o.name
  const plats = o.plats || ['kw']
  const platforms = {}
  for (const p of plats) platforms[p] = { status: 'usable', verified: true }
  if (o.failPlats) for (const p of o.failPlats) platforms[p] = { status: 'failed' }
  return {
    id: o.id, name, lxName: name, scriptName: name, scriptVersion: o.ver || '',
    repository: o.repo || 'https://github.com/a/b', url: 'https://x/' + o.id + '.js',
    contentHash: U.sha256(o.id + (o.pad || '')), code: '// ' + o.id + ' ' + (o.pad || ''),
    usable: o.usable !== false, stale: false, lastModified: o.lm || 1,
    deep: { checkedAt: 1, platforms, metrics: { depth: 'full', p50LatencyMs: 200, samples: plats.length } }
  }
}
function mkHunter(store) {
  return new Hunter(store || {
    config: {}, db: { sources: {} }, imported: {},
    saveDb() {}, saveImported() {}, archiveScript() { return true }, scriptDir() { return '' }, scriptSize() { return 0 }
  }, () => {})
}
function plan(h, targets, srv, cfgExtra) {
  const serverByBase = {}
  if (srv) serverByBase[baseNameKey(srv.name)] = srv
  const codeCache = {}
  for (const e of targets) codeCache[e.id] = e.code
  return h._planImportQueue(targets, Object.assign({
    cfg: Object.assign({ skipUnusable: true, replaceSameNameOnImport: true }, cfgExtra || {}),
    serverByName: {}, serverByBase, serverIds: srv ? new Set([srv.id]) : null,
    serverList: srv ? [srv] : [], codeCache, importedRecs: {}, ledger: {}
  }))
}

console.log('=== A. P0：同批同 base 多版本只灌最高版本 ===')
{
  const h = mkHunter()
  const v1 = mkE({ id: 'c1', name: '同基源 v1.0.0', ver: 'v1.0.0' })
  const v2 = mkE({ id: 'c2', name: '同基源 v2.0.0', ver: 'v2.0.0' })
  const srv = { id: 'srv-x', name: '同基源 v0.9.0', version: 'v0.9.0', supportedSources: ['kw'], size: 100 }
  const q = plan(h, [v1, v2], srv)
  eq('规划仍是 2 条（不丢结果，便于用户看到为什么跳过）', q.length, 2)
  const repl = q.filter(x => x.replaceServer)
  eq('只有 1 条去替换服务端旧版（原来两条都会去删同一个 id）', repl.length, 1)
  eq('留下的是最高版本', repl[0] && repl[0].e.id, 'c2')
  const skipped = q.find(x => x.e.id === 'c1')
  ok('低版本被跳过并说明原因', !!skipped.skip && /只灌最高版本/.test(skipped.skip), skipped.skip)
  ok('理由里写出两个版本号', /v2\.0\.0/.test(skipped.skip) && /v1\.0\.0/.test(skipped.skip), skipped.skip)

  // 反过来勾选顺序不影响结果（排序必须可复现）
  const q2 = plan(h, [v2, v1], srv)
  const repl2 = q2.filter(x => x.replaceServer)
  eq('勾选顺序颠倒结果一致', repl2.length === 1 && repl2[0].e.id, 'c2')

  // 三个版本一起勾：只留最高的
  const v3 = mkE({ id: 'c3', name: '同基源 v3.0.0', ver: 'v3.0.0' })
  const q3 = plan(h, [v1, v2, v3], srv)
  eq('三个版本只留 1 条要替换', q3.filter(x => x.replaceServer).length, 1)
  eq('三个版本留下最高那个', q3.find(x => x.replaceServer).e.id, 'c3')
}

console.log('=== A2. 同版本/不可比版本：不去重（不同仓库转发的不同源要各自裁决） ===')
{
  const h = mkHunter()
  const a = mkE({ id: 'd1', name: '同基源B v1.0.0', ver: 'v1.0.0', repo: 'https://github.com/a/b' })
  const b = mkE({ id: 'd2', name: '同基源B v1.0', ver: 'v1.0', repo: 'https://github.com/c/d' })
  const q = plan(h, [a, b], null)
  eq('版本相同 → 两条都保留', q.filter(x => !x.skip).length, 2)

  // 单段版本号（v1 / v2）目前取不到版本（versionKey 要求 1.0 形态），一律不去重 ——
  // 这是已知缺口：宁可不去重，也不能按「猜出来的版本」删人家的源。
  const s1 = mkE({ id: 'e1', name: '单段源 v1', ver: 'v1' })
  const s2 = mkE({ id: 'e2', name: '单段源 v2', ver: 'v2' })
  const q2 = plan(h, [s1, s2], null)
  eq('单段版本不去重（不猜）', q2.filter(x => !x.skip).length, 2)
}

console.log('=== A3. 高版本本身不可用：不参与「只留最高版本」，别把唯一能用的也跳掉 ===')
{
  const h = mkHunter()
  const good = mkE({ id: 'f1', name: '同基源C v1.0.0', ver: 'v1.0.0' })
  const bad = mkE({ id: 'f2', name: '同基源C v2.0.0', ver: 'v2.0.0', usable: false, plats: [], failPlats: ['kw'] })
  const srv = { id: 'srv-y', name: '同基源C v0.9.0', version: 'v0.9.0', supportedSources: ['kw'], size: 100 }
  const q = plan(h, [good, bad], srv)
  const g = q.find(x => x.e.id === 'f1')
  ok('可用的低版本没有被「只灌最高版本」挡掉', !!g && !(g.skip && /只灌最高版本/.test(g.skip)), g && (g.skip || 'replace'))
  eq('它仍按裁决去替换服务端旧版', g && !!g.replaceServer, true)
  const bd = q.find(x => x.e.id === 'f2')
  ok('不可用的高版本照旧按「检测未通过」跳过', !!bd.skip && /未通过/.test(bd.skip), bd.skip)
}

console.log('=== B. P0-B：执行期校验服务端旧版还在不在（不许再出现「（副本2）」） ===')
let pendingB = Promise.resolve()
{
  const removed = [], uploaded = []
  const store = {
    config: {}, db: { sources: {} }, imported: {}, saveDb() {}, saveImported() {},
    archiveScript() { return true }, scriptDir() { return '' }, scriptSize() { return 0 }
  }
  const h = mkHunter(store)
  const e = mkE({ id: 'g1', name: '同基源D v2.0.0', ver: 'v2.0.0' })
  const svc = {
    acct: { id: 'acc1', name: 'demo', url: 'http://srv' }, type: 'lxserver',
    adapter: {
      baseUrl: () => 'http://srv',
      remove: async (acct, id) => { removed.push(id); return { success: true } },
      upload: async (acct, code, name) => { uploaded.push(name); return { success: true, id: 'new-1', name, platforms: ['kw'] } },
      importUrl: async () => ({ success: false, message: 'no' })
    }
  }
  const p = { svc, label: 'demo', serverIds: new Set(['other-id']), serverByName: {}, usedRename: new Set() }
  const item = { e, replaceServer: { id: 'gone-id', name: '同基源D v0.9.0' }, baseName: '同基源D v2.0.0', why: '' }

  pendingB = (async () => {
    const r = await h._runImportItem(p, item, { g1: e.code }, false)
    eq('旧版已不在 → 不再发 remove 请求（原来必报 HTTP 500）', removed.length, 0)
    eq('直接按原名上传 1 次', uploaded.length, 1)
    eq('结果算成功（不是 replaced，因为没删过东西）', r.status, 'success')
    ok('文案说明「旧版已不存在」', /已不存在/.test(r.message), r.message)
    ok('文案不再出现「已替换」「已改名」这类误导', !/已替换|已改名/.test(r.message), r.message)

    // 对照：旧版确实还在 → 走正常「先删后传」
    removed.length = 0; uploaded.length = 0
    const p2 = { svc, label: 'demo', serverIds: new Set(['live-id']), serverByName: {}, usedRename: new Set() }
    const item2 = { e, replaceServer: { id: 'live-id', name: '同基源D v0.9.0' }, baseName: '同基源D v2.0.0', why: '' }
    const r2 = await h._runImportItem(p2, item2, { g1: e.code }, false)
    eq('旧版在 → 正常删旧', removed.join(','), 'live-id')
    eq('结果标 replaced', r2.status, 'replaced')
  })()
}

console.log('=== C. P1-1：巡检门槛与灌入同口径（空串 code 不进巡检） ===')
{
  const imported = {
    a: { lxId: 'lx-a' }, b: { lxId: 'lx-b' }, c: { lxId: 'lx-c' }, d: { lxId: 'lx-d' }
  }
  const sources = {
    a: { url: 'https://x/a.js' },                       // 有地址 → 巡检
    b: { url: '', code: '// real code' },                // 有正文 → 巡检
    c: { url: '', code: '' },                            // 空串正文 → 不巡检（本次修复点）
    d: { url: '', private: true, code: '// private' }    // 私人源 → 不巡检
  }
  const items = buildPatrolItems(imported, sources, new Set(['lx-a', 'lx-b', 'lx-c', 'lx-d']))
  eq('巡检条目数', items.length, 2)
  eq('入选的是有地址 + 有正文的两条', items.map(x => x.srcId).sort().join(','), 'a,b')
}

console.log('=== D. P1-2/P1-3：初筛不等于平手；0 样本不算已打分 ===')
{
  const quick = mkE({ id: 'q1', name: 'X v1.0.0', ver: 'v1.0.0' })
  quick.deep.metrics = { depth: 'quick' }
  const full = mkE({ id: 'q2', name: 'X v2.0.0', ver: 'v2.0.0' })
  const v = Q.compareVerdict(quick, full)
  ok('一侧只跑初筛 → 判证据不足（不是「平手」）', v.by === 'insufficient', v.by + ' | ' + v.reason)
  ok('理由点明是哪一侧、该怎么做', /A 侧/.test(v.reason) && /初筛/.test(v.reason), v.reason)
  eq('仍返回 cmp=0（不删任何一方）', v.cmp, 0)

  const zero = mkE({ id: 'q3', name: 'Y v1.0.0', ver: 'v1.0.0', plats: [], failPlats: ['kw'] })
  zero.deep.metrics = { depth: 'full', samples: 0, p50LatencyMs: null }
  eq('深检 0 样本 → 不算已打分', Q.profile(zero).scored, false)
  eq('0 样本时 p50 不参与比较', Q.profile(zero).p50, null)
  // 0 样本 + 平台数相同（两边都是 0 个可用）→ 必须在第二层挡住，理由说明是「0 样本」
  const zero2 = mkE({ id: 'q5', name: 'Y2 v1.0.0', ver: 'v1.0.0', plats: [], failPlats: ['kw'] })
  zero2.deep.metrics = { depth: 'full', samples: 0 }
  const v2 = Q.compareVerdict(zero, zero2)
  ok('0 样本侧 → 证据不足，理由说明是「0 样本」', v2.by === 'insufficient' && /0 样本/.test(v2.reason), v2.reason)
  // 0 样本 vs 有样本：平台数差异仍按第一层裁决（0 个可用就是真的更差，不是「平手」）
  const v3 = Q.compareVerdict(full, zero)
  ok('0 可用 vs 1 可用 → 仍由平台数说话', v3.by === 'platforms' && v3.cmp === 1, v3.by + ' | ' + v3.reason)

  const noSamplesField = mkE({ id: 'q4', name: 'Z v1.0.0', ver: 'v1.0.0' })
  delete noSamplesField.deep.metrics.samples
  eq('老记录没有 samples 字段 → 不降级（不让升级把历史全翻案）', Q.profile(noSamplesField).scored, true)
}

console.log('=== E. P1-4：非打分档灌入不继承上一版质量快照 ===')
{
  const store = {
    config: {}, db: { sources: {} }, imported: {}, saveDb() {}, saveImported() {},
    archiveScript() { return true }, scriptDir() { return '' }, scriptSize() { return 0 }
  }
  const h = mkHunter(store)
  const svc = { acct: { id: 'acc1', name: 'demo' }, type: 'lxserver', adapter: { baseUrl: () => 'http://srv' } }

  const fullE = mkE({ id: 'm1', name: 'M v1.0.0', ver: 'v1.0.0' })
  h._markImported(fullE, svc, 'lx-1', 'M v1.0.0', ['kw'], false, fullE.code)
  ok('打分档灌入 → 写入质量快照', !!(store.imported.m1 && store.imported.m1.score), JSON.stringify(store.imported.m1.score))

  const quickE = mkE({ id: 'm1', name: 'M v1.1.0', ver: 'v1.1.0' })
  quickE.deep.metrics = { depth: 'quick' }
  h._markImported(quickE, svc, 'lx-1', 'M v1.1.0', ['kw'], false, quickE.code)
  eq('只跑初筛就灌新版 → 快照清空（不许旧画像代表新版）', store.imported.m1.score, null)

  const zeroE = mkE({ id: 'm2', name: 'N v1.0.0', ver: 'v1.0.0' })
  zeroE.deep.metrics = { depth: 'full', samples: 0 }
  h._markImported(zeroE, svc, 'lx-2', 'N v1.0.0', [], false, zeroE.code)
  eq('深检 0 样本 → 也不写快照', store.imported.m2.score, null)
}

console.log('=== F. 同仓库版本更高 + 本地未打分：文案不能指错方向 ===')
{
  const h = mkHunter()
  const e = mkE({ id: 'n1', name: 'P v2.0.0', ver: 'v2.0.0', repo: 'https://github.com/a/b' })
  e.deep.metrics = { depth: 'quick' }
  const srv = {
    id: 'srv-p', name: 'P v1.0.0', version: 'v1.0.0', repository: 'https://github.com/a/b',
    supportedSources: ['kw'],
    qualityProxy: { checkedAt: Date.now(), platforms: { kw: { status: 'usable', verified: true } }, metrics: { depth: 'full', p50LatencyMs: 200, samples: 3 } }
  }
  const v = h.sameNameVerdict(e, srv, e.code, { skipUnusable: true, replaceSameNameOnImport: true }, { ledger: null })
  eq('同源版本更高 + 质量不可比 → 仍留新删旧', v.act, 'replace')
  ok('理由写「证据不足」而不是「质量相当」', /证据不足/.test(v.why), v.why)
  ok('不再把缺口一口咬定成服务端侧', !/服务端侧质量证据不足/.test(v.why), v.why)
  ok('也不再出现「平手，不删」这种自相矛盾', !/平手，不删/.test(v.why), v.why)
  ok('理由里给出可执行提示（先做深度检测）', /深度检测|初筛/.test(v.why), v.why)
}

pendingB.then(() => {
  console.log('\nRESULT ' + pass + ' PASS / ' + fail + ' FAIL')
  process.exit(fail ? 1 : 0)
})
