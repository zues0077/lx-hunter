'use strict'
/**
 * 2026-11-10 21:01 用户拍板后的专项回归：
 *  - S1 统一版本算法（version.js）+ 三处口径一致
 *  - 用户口径 1/2/3：不同名直灌 / 同名同仓库留新删旧 / 同名跨仓库按质量留优删差
 *  - S2 配对键 / S3 状态重建 + 原子性 / S4 未实测 / S5 缺证据 / S6 报告有效期
 *  - identity.js 同源键、quality.js 分层判据
 */
const assert = require('assert')
const V = require('../src/core/version')
const I = require('../src/core/identity')
const Q = require('../src/core/quality')
const H = require('../src/core/hunter')
const C = require('../src/core/crawler')
const U = require('../src/core/sourceUpdate')

let pass = 0
function ok(name) { pass++; console.log('  ✓ ' + name) }
const decided = Object.create(H.Hunter.prototype)

console.log('\n== S1：统一版本算法与三处口径一致 ==')
{
  assert.ok(V.cmpVersion('v2.0', 'v1.9.9') > 0)
  assert.ok(V.cmpVersion('1.2.3.4.5', '1.2.3.4') > 0)
  assert.ok(V.cmpVersion('1.0.1.0', '1.0.0.1000') > 0)
  assert.ok(V.cmpVersion('v4.0.0', 'v3.1.1.1') > 0)
  assert.strictEqual(V.cmpVersion('v2.0', 'v2.0.0'), 0)
  assert.strictEqual(V.versionKey('无版本'), '')
  ok('逐段零填充键：无碰撞、不丢段、跨段数不反转')

  assert.strictEqual(H.versionNum('v2.0'), C.versionNumOf('v2.0'))
  assert.strictEqual(C.versionNumOf('v2.0'), U.versionNum('v2.0'))
  assert.strictEqual(V.cmpVersion('v2.0', 'v1.9.9') > 0, H.versionNum('v2.0') > H.versionNum('v1.9.9'))
  ok('hunter / crawler / sourceUpdate 三处版本函数完全同源')

  const f = C.filterLatestOnly([{ name: 'demo-v1.9.9.js' }, { name: 'demo-v2.0.js' }])
  assert.strictEqual(f.kept.length, 1)
  assert.strictEqual(f.kept[0].name, 'demo-v2.0.js')
  ok('只收最新版不再把 v2.0 丢掉、留 v1.9.9（历史生产 bug）')
}

console.log('\n== identity / quality：同源键与「质量更优」判据 ==')
{
  assert.strictEqual(I.repoKey({ url: 'https://raw.githubusercontent.com/foo/bar/main/x.js' }),
                     I.repoKey({ repository: 'https://github.com/foo/bar' }))
  assert.strictEqual(I.repoKey({ repository: 'https://github.com/your-repo/x' }), '')
  assert.notStrictEqual(I.repoKey({ repository: 'https://github.com/user/repo' }), '')
  ok('同源键归一（raw/github/简写），占位仓库不算证据，合法用户名不误拒')

  const a = { deep: { checkedAt: 1, platforms: { kw: { status: 'usable', verified: true }, kg: { status: 'usable' } } } }
  const b = { deep: { checkedAt: 2, platforms: { kw: { status: 'usable' } } } }
  assert.ok(Q.compareQuality(a, b) > 0, '可用平台多者优')
  assert.strictEqual(Q.isClearlyBetter(b, a), false)
  const srvDeclared = { supportedSources: ['kw', 'kg'] }
  assert.strictEqual(Q.compareQuality(a, srvDeclared), 0, '服务端只有声明值时判平手（未知证据不参与）')
  assert.ok(/声明 2 个支持平台/.test(Q.describeQuality(srvDeclared)))
  ok('质量分层：usable > verified > tested；服务端声明值不冒充实测，平手不删')
}

console.log('\n== 用户口径 1/2/3：同名裁决规则 ==')
{
  const mkE = o => Object.assign({
    id: 'e1', name: '同名源 v2.0', lxName: '同名源 v2.0', scriptName: '同名源 v2.0',
    repository: 'https://github.com/foo/bar', url: 'https://raw.githubusercontent.com/foo/bar/main/x.js',
    contentHash: 'h2', usable: true, stale: false,
    deep: { checkedAt: Date.now(), platforms: { kw: { status: 'usable' }, kg: { status: 'usable' } } }
  }, o || {})
  const mkS = o => Object.assign({
    id: 's1', name: '同名源 v1.0', repository: 'https://github.com/foo/bar',
    supportedSources: ['kw', 'kg'], size: 20
  }, o || {})
  const code = 'y'.repeat(30)   // 与 srv.size 不同，避免命中「同名同内容」

  // 口径 2：同名同仓库 + 版本有别 → 留新删旧
  let v = decided.sameNameVerdict(mkE(), mkS(), code, {})
  assert.strictEqual(v.act, 'replace')
  assert.ok(/留新删旧/.test(v.why), v.why)
  ok('2a 同仓库 + 本地版本更高 → 留新删旧（删旧装新）')

  v = decided.sameNameVerdict(mkE({ scriptName: '同名源 v0.9', lxName: '同名源 v0.9', name: '同名源 v0.9' }), mkS(), code, {})
  assert.strictEqual(v.act, 'skip')
  ok('2b 同仓库 + 服务端版本不低于本地 → 保留服务端')

  v = decided.sameNameVerdict(mkE(), mkS({ supportedSources: ['kw', 'kg', 'wy'] }), code, {})
  assert.strictEqual(v.act, 'skip')
  assert.ok(/质量降级/.test(v.why), v.why)
  ok('2c 同仓库版本更高但本地可用平台更少 → 不做质量降级替换（拍板时约定的保留保护）')

  // 17960 实机抓到：v1.0.0 → v1.1.0 是等长改动，服务端 list 不回传 hash/正文，
  // 旧规则用「字节长度相同」当同内容证据 → 把「留新删旧」误判成 synced 卡死。
  const equalLen = mkS({ size: Buffer.byteLength(code, 'utf-8') })
  v = decided.sameNameVerdict(mkE(), equalLen, code, {})
  assert.strictEqual(v.act, 'replace')
  assert.ok(!/同内容/.test(v.why), v.why)
  ok('2d 等长不同版本 + 服务端不回传 hash/正文 → 不误判 synced（17960 实机 bug）')

  v = decided.sameNameVerdict(mkE(), mkS({ script: code }), code, {})
  assert.strictEqual(v.act, 'synced')
  ok('2e 服务端回传脚本正文时按全文精确判同内容（精确证据优先于字节长度）')

  // 口径 3：跨仓库同名 → 按 lx-hunter 实测质量留优删差
  const cross = { repository: 'https://github.com/other/baz' }
  v = decided.sameNameVerdict(mkE(), mkS(Object.assign({}, cross, { supportedSources: ['kw'] })), code, {})
  assert.strictEqual(v.act, 'replace')
  assert.ok(/质量更优/.test(v.why), v.why)
  ok('3a 跨仓库 + 本地实测质量更优 → 留优删差')

  v = decided.sameNameVerdict(mkE(), mkS(Object.assign({}, cross, { supportedSources: ['kw', 'kg', 'wy'] })), code, {})
  assert.strictEqual(v.act, 'skip')
  ok('3b 跨仓库 + 服务端更优 → 保留服务端，本地不灌')

  v = decided.sameNameVerdict(mkE(), mkS(cross), code, {})
  assert.strictEqual(v.act, 'rename')
  assert.ok(/平手/.test(v.why), v.why)
  ok('3c 跨仓库 + 质量平手 → 不删任何一方，改名并存（撞名保护兜底）')

  v = decided.sameNameVerdict(mkE({ deep: null }), mkS(cross), code, {})
  assert.strictEqual(v.act, 'rename')
  assert.ok(/未实测/.test(v.why), v.why)
  ok('3d 跨仓库 + 本地未实测 → 无法裁决，改名并存（检测归 lx-hunter）')

  // 缺同源证据时不能猜仓库，沿用 v1.7.0 旧规则
  v = decided.sameNameVerdict(mkE({ repository: '', url: '' }), mkS({ repository: '' }), code, {})
  assert.strictEqual(v.act, 'replace')
  assert.ok(/本地版本更高/.test(v.why), v.why)
  ok('3e 两边都拿不到仓库键 → 不猜归属，沿用旧规则（17950 homepage 非空仅 28.9%）')
}

console.log('\n== sourceUpdate：S2 / S4 / S5 / S6 ==')
{
  const srv = o => Object.assign({
    id: 'srv1', name: '测试源 v1.0', version: '1.0', owner: 'open',
    repository: 'https://github.com/foo/bar', supportedSources: ['kw', 'kg'],
    hash: U.sha256('old'), size: 8, enabled: true, script: ''
  }, o || {})
  const cand = o => Object.assign({
    id: 'c1', lxName: '测试源 v1.1', scriptName: '测试源 v1.1', scriptVersion: '1.1',
    repository: 'https://github.com/foo/bar', url: 'https://raw.githubusercontent.com/foo/bar/main/x.js',
    contentHash: U.sha256('new'), code: '/*! @name 测试源 v1.1 @version 1.1 */',
    deep: { checkedAt: Date.now(), platforms: { kw: { status: 'usable' }, kg: { status: 'usable' } } },
    stale: false
  }, o || {})

  // S2：同名字主体下，跨仓库的 v9.0 不能把同源 v1.1 挤掉
  const noisy = cand({ id: 'c2', scriptVersion: '9.0', lxName: '测试源 v9.0', scriptName: '测试源 v9.0',
    repository: 'https://github.com/other/baz', url: '',
    code: '/*! @name 测试源 v9.0 */', deep: { checkedAt: Date.now(), platforms: { kw: { status: 'usable' } } } })
  let items = U.pairSources([srv()], [noisy, cand()], {})
  assert.strictEqual(items[0].evidence.relation, 'same-repo')
  assert.strictEqual(items[0].verdict, 'updatable')
  assert.strictEqual(items[0].evidence.candidateVersion, '1.1')
  ok('S2 同源候选优先：撞名的跨仓库高版本不再把真更新挤成 unmatched')

  // S4：hub 清单候选 deep:null 不得凭版本号直接判可更新
  const hub = { id: 'hub:abc', lxName: '测试源 v9.9', scriptName: '测试源 v9.9', scriptVersion: '9.9',
    repository: 'https://github.com/foo/bar', url: 'https://x/y.js', deep: null }
  items = U.pairSources([srv()], [hub], {})
  assert.strictEqual(items[0].verdict, 'unmatched')
  assert.strictEqual(items[0].evidence.via, 'need-check')
  assert.ok(/全平台检测/.test(items[0].reason))
  ok('S4 未经实测的候选（含采集站清单）→ need-check，只报告')

  // S5：缺证据 ≠ 没新版
  const rep = U.buildReport([srv({ repository: '' })], [cand({ repository: '' })], { now: Date.now() })
  assert.ok(rep.summary.withMissingEvidence >= 1)
  assert.ok(rep.items[0].evidence.missingEvidence.length >= 1)
  assert.ok(/不等于「没有新版」/.test(rep.items[0].reason))
  ok('S5 unmatched 带 missingEvidence，区分「证据链缺口」与「确实没新版」')

  // S6：外部传超大 maxAgeMs 不能让过期报告复活
  const stale = U.buildReport([srv()], [cand()], { now: Date.now() - 20 * 60 * 1000 })
  assert.throws(() => U.assertApplyAllowed(stale, ['srv1'], { apply: true, confirm: true, maxAgeMs: 1e15 }), /过期/)
  assert.strictEqual(U.MAX_REPORT_AGE_MS, 10 * 60 * 1000)
  ok('S6 maxAgeMs 服务端钳到 ≤10min，1e15 不能绕过过期校验')
}

console.log('\n== S3：换 id 状态重建 + 失败自动回滚 ==')
;(async () => {
  const srv = {
    id: 'srv1', name: '测试源 v1.0', version: '1.0', owner: 'open',
    repository: 'https://github.com/foo/bar', supportedSources: ['kw', 'kg'],
    hash: U.sha256('old'), size: 8, enabled: false, disabledSources: ['tx'], script: ''
  }
  const cand = {
    id: 'c1', lxName: '测试源 v1.1', scriptName: '测试源 v1.1', scriptVersion: '1.1',
    repository: 'https://github.com/foo/bar', url: 'https://raw.githubusercontent.com/foo/bar/main/x.js',
    contentHash: U.sha256('new'), code: '/*! @name 测试源 v1.1 @version 1.1 */',
    deep: { checkedAt: Date.now(), platforms: { kw: { status: 'usable' }, kg: { status: 'usable' } } },
    stale: false
  }
  const calls = []
  const base = {
    list: async () => [srv],
    validate: async () => ({ ok: true, data: { success: true, metadata: { name: '测试源 v1.1' } } }),
    remove: async () => { calls.push('remove'); return { success: true } },
    upload: async () => { calls.push('upload'); return { success: true, id: 'srvNEW' } },
    setPlatforms: async (a, id, dis) => { calls.push('setPlatforms:' + id + ':' + dis.join(',')); return { success: true } },
    toggle: async (a, id, en) => { calls.push('toggle:' + id + ':' + en); return { success: true } },
    listTrash: async () => [{ id: 'srv1', file: 'srv1.js' }],
    restoreTrash: async () => { calls.push('restore'); return { success: true } }
  }
  const upd = U.createUpdater({ adapter: base, acct: {}, getCandidates: () => [cand], fetchCode: async () => cand.code })
  await upd.scan({})
  const out = await upd.apply(['srv1'], { apply: true, confirm: true })
  assert.strictEqual(out.applied, 1)
  assert.ok(calls.includes('setPlatforms:srvNEW:tx'), calls.join('|'))
  assert.ok(calls.includes('toggle:srvNEW:false'), calls.join('|'))
  assert.strictEqual(out.results[0].stateMigration.platforms, true)
  ok('S3-B 删旧前读出 disabledSources/enabled，upload 后按新 id 重建（lxserver 零改动）')

  // S3-C：适配器无迁移能力 → 不自动放行
  const noMigrate = U.createUpdater({
    adapter: Object.assign({}, base, { setPlatforms: undefined, toggle: undefined }),
    acct: {}, getCandidates: () => [cand], fetchCode: async () => cand.code
  })
  await noMigrate.scan({})
  const r2 = await noMigrate.apply(['srv1'], { apply: true, confirm: true })
  assert.strictEqual(r2.applied, 0)
  assert.ok(/状态迁移/.test(r2.rejected[0].reason))
  ok('S3-C 状态迁移接口缺失 → 全部拒绝，不自动放行（兜底）')

  // 原子性：upload 失败 → 从回收站自动恢复旧脚本，并留下定位信息
  const failUp = U.createUpdater({
    adapter: Object.assign({}, base, { upload: async () => ({ success: false, message: 'disk full' }) }),
    acct: {}, getCandidates: () => [cand], fetchCode: async () => cand.code
  })
  await failUp.scan({})
  const r3 = await failUp.apply(['srv1'], { apply: true, confirm: true })
  assert.strictEqual(r3.failed, 1)
  assert.strictEqual(r3.results[0].restored, true)
  assert.strictEqual(r3.results[0].trashFile, 'srv1.js')
  assert.ok(/回收站/.test(r3.results[0].rollback))
  ok('原子性：已删未装时自动恢复旧脚本；trash 定位信息写进结果')

  console.log('\n' + pass + ' PASS / decision-2026-11-10.test.js')
})().catch(e => { console.error('FAILED:', e); process.exitCode = 1 })
