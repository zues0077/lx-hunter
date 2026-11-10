'use strict'
/**
 * 已添加源更新（T1 转 lx-hunter）回归测试 —— 2026-11-10
 *
 * 拍板口径：A（@name 主体 + @repository 同源 + @version）为唯一可判「可更新」的依据；
 * B（@updateUrl / @downloadUrl）只作补充信号，绝不单独触发动作；默认 dry-run。
 */
const assert = require('assert')
const U = require('../src/core/sourceUpdate')

let pass = 0
function ok(name) { pass++; console.log('  ✓ ' + name) }

function cand(o) {
  return Object.assign({
    id: 'c1', lxName: '测试源 v1.1', scriptName: '测试源 v1.1', scriptVersion: '1.1',
    repository: 'https://github.com/foo/bar',
    url: 'https://raw.githubusercontent.com/foo/bar/main/source.js',
    contentHash: U.sha256('new-code'),
    code: '/*! @name 测试源 v1.1 @version 1.1 */\nlx.on("musicUrl", () => {})',
    deep: { checkedAt: Date.now(), platforms: { kw: { status: 'ok' }, kg: { status: 'ok' } } },
    usable: true, stale: false
  }, o || {})
}
function srv(o) {
  return Object.assign({
    id: 'srv1', name: '测试源 v1.0', version: '1.0', owner: 'open',
    repository: 'https://github.com/foo/bar/tree/main',
    supportedSources: ['kw', 'kg'],
    hash: U.sha256('old-code'), size: 8, enabled: true, script: ''
  }, o || {})
}

console.log('\n== 基础纯函数 ==')
{
  assert.strictEqual(U.normName('聚合 API 接口（by lerd）'), '聚合api接口bylerd')
  assert.strictEqual(U.nameBody('测试源 v1.2'), U.nameBody('测试源 v1.3'))
  assert.notStrictEqual(U.normName('测试源 v1.2'), U.normName('测试源 v1.3'))
  ok('nameBody 去掉 @name 里的版本号尾巴，版本升级仍可配对')

  assert.ok(U.versionNum('1.2.3') > U.versionNum('1.2.0'))
  assert.strictEqual(U.versionNum('没有版本号'), 0)
  ok('versionNum 可比较、不可解析返回 0')

  assert.strictEqual(U.repoKey({ repository: 'https://github.com/Foo/Bar/tree/main' }), 'gh:foo/bar')
  // raw.github.com 也归到同一个 GitHub 仓库键：A 反查常拿 raw 直链当 repository
  assert.strictEqual(U.repoKey({ url: 'https://raw.github.com/foo/bar/main/x.js' }), 'gh:foo/bar')
  assert.strictEqual(U.repoKey({}), '')
  ok('repoKey 归一 GitHub 仓库（含 raw 链接）、缺信息返回空（不猜）')
}

console.log('\n== B 信号：只抽取、不判定 ==')
{
  const hints = U.extractUpdateHints('/*! @name x\n * @updateUrl https://a/u.json\n * @downloadUrl https://a/x.js */')
  assert.strictEqual(hints.length, 2)
  assert.strictEqual(hints[0].type, '@updateUrl')
  ok('extractUpdateHints 抽出 @updateUrl / @downloadUrl')

  const rep = U.buildReport(
    [srv({ script: '/*! @updateUrl https://a/u.json */', repository: '' })],
    [], { now: Date.now() }
  )
  assert.strictEqual(rep.items[0].verdict, 'unmatched')
  assert.strictEqual(rep.items[0].applyAllowed, false)
  assert.strictEqual(rep.items[0].signals.length, 1)
  assert.strictEqual(rep.summary.updatable, 0)
  ok('只有 B 信号、无 A 配对 → 仍判 unmatched，绝不单独触发更新')
}

console.log('\n== A 配对主口径 ==')
{
  let items = U.pairSources([srv()], [cand()], {})
  assert.strictEqual(items[0].verdict, 'updatable')
  assert.strictEqual(items[0].applyAllowed, true)
  assert.strictEqual(items[0].evidence.via, 'repo-version')
  ok('同源同名 + 候选版本更高 → updatable')

  items = U.pairSources([srv({ version: '1.9', name: '测试源 v1.9' })], [cand()], {})
  assert.strictEqual(items[0].verdict, 'current')
  ok('服务端版本不低于候选 → current，不更新')

  items = U.pairSources([srv({ hash: U.sha256('new-code') })], [cand()], {})
  assert.strictEqual(items[0].verdict, 'current')
  assert.strictEqual(items[0].evidence.hashMatch, true)
  ok('sha256 同内容 → 已是同一版本，不重复上传')

  items = U.pairSources([srv({ repository: '' })], [cand({ repository: '' })], {})
  assert.strictEqual(items[0].verdict, 'unmatched')
  assert.strictEqual(items[0].applyAllowed, false)
  ok('缺 @repository 同源证据且未显式放行 → 只报告，不自动更新（A 不猜）')

  items = U.pairSources([srv({ repository: '' })], [cand({ repository: '' })], { allowVersionOnly: true })
  assert.strictEqual(items[0].verdict, 'updatable')
  assert.ok(/人工确认/.test(items[0].reason))
  ok('显式 allowVersionOnly 才放行版本-only，并标注需人工确认')

  items = U.pairSources([srv()], [cand({ scriptVersion: '', lxName: '测试源', scriptName: '测试源', code: '/*! @name 测试源 */' })], {})
  assert.strictEqual(items[0].verdict, 'unmatched')
  ok('两边版本号不可比 → 不猜，只报告')

  items = U.pairSources([srv()], [], {})
  assert.strictEqual(items[0].verdict, 'unmatched')
  assert.strictEqual(items[0].candidate, null)
  ok('候选池没有该源（出处不明）→ 只报告，不动')
}

console.log('\n== 四个护栏 ==')
{
  let items = U.pairSources([srv({ owner: 'admin' })], [cand()], { owner: 'open' })
  assert.strictEqual(items[0].verdict, 'unsafe')
  ok('owner 隔离：跨身份条目直接判 unsafe，不处理')

  items = U.pairSources([srv()], [cand({ code: '/*! @name 另一个源 v2.0 */' })], {})
  assert.strictEqual(items[0].verdict, 'unsafe')
  assert.ok(/新 id/.test(items[0].reason))
  ok('ID 稳定：脚本正文 @name 主体变了会生成新 id → 不删旧')

  items = U.pairSources([srv()], [cand({ deep: { checkedAt: Date.now(), platforms: {} } })], {})
  assert.strictEqual(items[0].verdict, 'unsafe')
  ok('沿用同名裁决：候选实测 0 平台 → 不替换')

  // 2026-11-10 实机：checker.js 写的是 status:'usable'，旧版只认 ok/passed →
  // 已深检且全平台可用的候选 usablePlatforms 恒为 0，A 覆盖率永远上不去。
  const realDeep = { checkedAt: Date.now(), platforms: {
    kw: { status: 'usable' }, tx: { status: 'usable' }, wy: { status: 'usable' },
    mg: { status: 'failed' }, kg: { status: 'untested' }
  } }
  assert.deepStrictEqual(U.candidateMeta(cand({ deep: realDeep })).usablePlatforms.sort(), ['kw', 'tx', 'wy'])
  ok("深检状态 'usable' 被识别（failed / untested 不计入）")

  items = U.pairSources([srv()], [cand({ deep: realDeep })], {})
  assert.notStrictEqual(items[0].verdict, 'unsafe', items[0].reason)
  assert.ok(!/0 个可用平台/.test(items[0].reason))
  ok("真实深检平台可用时不再误判「候选实测 0 平台」")

  items = U.pairSources([srv({ supportedSources: ['wy', 'mg'] })], [cand()], {})
  assert.strictEqual(items[0].verdict, 'unsafe')
  ok('平台零交集 → 疑似无关脚本撞名，改名并存不删旧')

  items = U.pairSources([srv({ supportedSources: ['kw', 'kg', 'wy'] })], [cand()], {})
  assert.strictEqual(items[0].verdict, 'unsafe')
  ok('服务端支持平台更多 → 保留服务端')
}

console.log('\n== dry-run 报告与 apply 准入 ==')
{
  const rep = U.buildReport([srv(), srv({ id: 's2', name: '陌生源', repository: '' })], [cand()], { now: Date.now() })
  assert.strictEqual(rep.dryRun, true)
  assert.strictEqual(rep.summary.total, 2)
  assert.strictEqual(rep.summary.updatable, 1)
  assert.strictEqual(rep.summary.unmatched, 1)
  assert.strictEqual(rep.notes.length >= 5, true)
  ok('buildReport 只出报告、dryRun=true、四态计数正确')

  assert.throws(() => U.assertApplyAllowed(rep, ['srv1'], {}), /未显式确认/)
  assert.throws(() => U.assertApplyAllowed(rep, ['srv1'], { apply: true }), /未显式确认/)
  ok('apply 未同时传 apply:true + confirm:true → 拒绝（默认 dry-run）')

  const r = U.assertApplyAllowed(rep, ['srv1', 's2', 'nope'], { apply: true, confirm: true })
  assert.strictEqual(r.allowed.length, 1)
  assert.strictEqual(r.rejected.length, 2)
  assert.ok(/判定为 unmatched/.test(r.rejected[0].reason))
  ok('只允许 updatable 条目，其余与不存在 id 一律拒绝')

  const stale = U.buildReport([srv()], [cand()], { now: Date.now() - 20 * 60 * 1000 })
  assert.throws(() => U.assertApplyAllowed(stale, ['srv1'], { apply: true, confirm: true }), /过期/)
  ok('扫描报告过期 → 必须重新 dry-run')

  assert.throws(() => U.assertApplyAllowed(null, ['srv1'], { apply: true, confirm: true }), /请先执行/)
  ok('无报告时 apply 直接拒绝')
}

console.log('\n== 编排层：scan 只读 / apply 顺序与失败保护 ==')
{
  const calls = []
  const adapter = {
    list: async () => { calls.push('list'); return [srv()] },
    validate: async () => { calls.push('validate'); return { ok: true, data: { success: true, metadata: { name: '测试源 v1.1' } } } },
    remove: async () => { calls.push('remove'); return { success: true } },
    upload: async () => { calls.push('upload'); return { success: true, id: 'srv1' } },
    toggle: async () => ({ success: true })
  }
  const upd = U.createUpdater({ adapter, acct: {}, getCandidates: () => [cand()], fetchCode: async () => '/*! @name 测试源 v1.1 */' })

  ;(async () => {
    const rep = await upd.scan({})
    assert.deepStrictEqual(calls, ['list'])
    assert.strictEqual(rep.summary.updatable, 1)
    ok('scan 只调 list（只读），未触发任何写操作')

    await assert.rejects(() => upd.apply(['srv1'], {}), /未显式确认/)
    assert.deepStrictEqual(calls, ['list'])
    ok('apply 未确认时连 validate 都不会发生')

    const out = await upd.apply(['srv1'], { apply: true, confirm: true })
    assert.strictEqual(out.applied, 1)
    assert.deepStrictEqual(calls, ['list', 'validate', 'remove', 'upload'])
    ok('实际更新顺序 = validate → delete → upload（先验证后删）')

    // validate 失败：绝不删旧
    const bad = U.createUpdater({
      adapter: Object.assign({}, adapter, {
        validate: async () => ({ ok: false, data: { success: false } })
      }),
      acct: {}, getCandidates: () => [cand()], fetchCode: async () => 'code'
    })
    await bad.scan({})
    const r2 = await bad.apply(['srv1'], { apply: true, confirm: true })
    assert.strictEqual(r2.failed, 1)
    assert.ok(!r2.results[0].steps.includes('delete(旧脚本进服务端回收站，可回滚)'))
    ok('validate 未通过 → 保留旧条目，不执行 delete')

    // requireUnsafe 不降级放行
    const unsafe = U.createUpdater({
      adapter: Object.assign({}, adapter, {
        validate: async () => ({ ok: true, data: { success: false, requireUnsafe: true } })
      }),
      acct: {}, getCandidates: () => [cand()], fetchCode: async () => 'code'
    })
    await unsafe.scan({})
    const r3 = await unsafe.apply(['srv1'], { apply: true, confirm: true })
    assert.ok(/不降级/.test(r3.results[0].error))
    ok('安全不降级：requireUnsafe 脚本不因「是更新」而放行')

    // upload 失败给出回收站回滚提示
    const failUp = U.createUpdater({
      adapter: Object.assign({}, adapter, { upload: async () => ({ success: false, message: 'disk full' }) }),
      acct: {}, getCandidates: () => [cand()], fetchCode: async () => 'code'
    })
    await failUp.scan({})
    const r4 = await failUp.apply(['srv1'], { apply: true, confirm: true })
    assert.strictEqual(r4.failed, 1)
    assert.ok(/回收站/.test(r4.results[0].rollback))
    ok('upload 失败 → 明确提示旧脚本在服务端回收站可恢复')

    console.log('\n' + pass + ' PASS / source-update.test.js')
  })().catch(e => { console.error('FAILED:', e); process.exitCode = 1 })
}
