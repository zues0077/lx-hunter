'use strict'
/**
 * v1.12.0 质量守门 + 第三方探针对照回归测试。
 *
 * 质量守门（借鉴 shellsec/lx-music-source 的 previousPassed/passed 回归对比）：
 *  - 深检收尾把「实测通过平台集合」存 passSnapshot；
 *  - 内容变化后做回归对比：丢失平台只认「上一版通过 ∧ 新版实测失败」，
 *    untested/skipped 是未定证据（快速模式/未声明平台），不判回归；
 *  - 判「疑似回归」→ 软标记 e.regression + 自动灌入跳过，手动不受限；
 *  - 复测恢复后自动解除。
 *
 * 第三方探针对照：只读报告层，按 sha256 对齐库内 contentHash，绝不改库内状态。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')
const checker = require('../src/core/checker')
const { passedPlatforms, regressionJudge } = checker

let pass = 0
function ok(name) { pass++; console.log('  ✓ ' + name) }

// ---------------- 纯函数 ----------------
console.log('\n== passedPlatforms / regressionJudge 纯函数 ==')
{
  const d = { platforms: { kw: { status: 'usable' }, kg: { status: 'failed' }, mg: { status: 'untested' }, wy: { status: 'skipped' } } }
  assert.deepStrictEqual(passedPlatforms(d), ['kw'])
  assert.deepStrictEqual(passedPlatforms(null), [])
  ok('passedPlatforms 只收 usable（untested/skipped/failed 不算通过）')

  // 上一版 [kw,kg] → 新版 kw 通过、kg 实测失败：范围缩小 = 回归
  let j = regressionJudge(['kw', 'kg'], ['kw'], ['kg'])
  assert.strictEqual(j.suspect, true)
  assert.deepStrictEqual(j.lost, ['kg'])
  ok('实测失败的丢失平台 → 判疑似回归')

  // 上一版 [kw,kg] → 新版 kw 通过、kg untested（快速模式没测）：未定证据，不判回归
  j = regressionJudge(['kw', 'kg'], ['kw'], [])
  assert.strictEqual(j.suspect, false, 'kg 没实测失败只是没测，不能算回归')
  ok('快速模式 untested 不判回归（证据口径保守）')

  // 新版通过更多平台：不算回归
  j = regressionJudge(['kw'], ['kw', 'kg', 'mg'], ['wy'])
  assert.strictEqual(j.suspect, false)
  assert.deepStrictEqual(j.gained, ['kg', 'mg'])
  ok('通过范围扩大 → 不判回归（gained 记录新增平台）')

  // 丢了一个但又补回来总数不变（换平台）：不算回归
  j = regressionJudge(['kw', 'kg'], ['kw', 'mg'], ['kg'])
  assert.strictEqual(j.suspect, false, '总数没变小，只是平台此消彼长')
  ok('平台此消彼长但总数不减 → 不判回归')
}

// ---------------- 守门集成：走真实 runCheck（mock 网络） ----------------
const net = require('../src/core/net')
net.crawlFetch = async (url) => ({ res: { status: 200, text: async () => '[]' }, url, mirror: 'direct', attempts: [] })

let deepScript = null   // 每个场景动态指定 deepCheck 返回值
checker.checkBasic = async (e) => { e.status = 'ok'; e.suspected = true; e.error = ''; return { code: 'SCRIPT_' + e.contentHash } }
checker.deepCheck = async (e) => {
  const d = typeof deepScript === 'function' ? deepScript(e) : deepScript
  return Object.assign({ loadable: true, cancelled: false, loadError: null, hash: e.contentHash, checkedAt: Date.now() }, d)
}
delete require.cache[require.resolve('../src/core/hunter')]
const { Hunter } = require('../src/core/hunter')
const { Store, DEFAULT_CONFIG } = require('../src/core/store')

function mkHunterReal(store) {
  const h = new Hunter(store)
  return h
}

function deepOf(perPlatform, extra) {
  const platforms = {}
  for (const [k, st] of Object.entries(perPlatform)) platforms[k] = { status: st, message: st }
  return Object.assign({ platforms }, extra)
}

async function gateScenario() {
  console.log('\n== 质量守门集成（runCheck → applyQualityGate）==')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-qgate-'))
  const store = new Store(dir)
  store.config = Object.assign({}, DEFAULT_CONFIG, store.config, { skipChecked: false, apiHostCheck: false, excludeHighRiskObfuscated: false, concurrency: 4 })
  const h = mkHunterReal(store)

  // 版本 1：kw+kg 通过
  const e = { id: 's1', name: '回归源', url: 'https://example.com/s1.js', contentHash: 'v1' }
  store.db.sources.s1 = e
  deepScript = deepOf({ kw: 'usable', kg: 'usable' })
  await h.runCheck(['s1'])
  assert.strictEqual(e.usable, true)
  assert.deepStrictEqual(e.passSnapshot, { sha: 'v1', passed: ['kw', 'kg'], at: e.passSnapshot.at })
  assert.strictEqual(e.regression == null || e.regression === undefined || !e.regression.suspected, true)
  ok('首检通过 [kw,kg] → passSnapshot 记录、无回归标记')

  // 版本 2：内容变化，kg 实测失败 → 疑似回归 + 自动灌入被闸
  e.contentHash = 'v2'
  e.deep = null; e.usable = false
  deepScript = deepOf({ kw: 'usable', kg: 'failed' })
  await h.runCheck(['s1'])
  assert.strictEqual(e.regression && e.regression.suspected, true, 'kg 实测失败且范围缩小 → 疑似回归')
  assert.deepStrictEqual(e.regression.lost, ['kg'])
  assert.deepStrictEqual(e.regression.prevPassed, ['kw', 'kg'])
  assert.strictEqual(e.regression.sha, 'v2')
  assert.strictEqual(h._autoImportBlocked(e), true, '自动灌入闸门要拦下这个版本')
  assert.strictEqual(e.passSnapshot.sha, 'v1', '回归期间快照不推进（保留上一版基线）')
  ok('版本缩水（kg 实测失败）→ 疑似回归标记 + 自动灌入被拦 + 快照保留旧基线')

  // 复测同内容恢复：kg 又通了 → 解除标记、快照推进
  deepScript = deepOf({ kw: 'usable', kg: 'usable' })
  await h.runCheck(['s1'])
  assert.strictEqual(e.regression == null || !e.regression.suspected, true, '复测恢复 → 解除')
  assert.strictEqual(e.passSnapshot.sha, 'v2', '解除后快照推进到新版本')
  assert.strictEqual(h._autoImportBlocked(e), false)
  ok('同内容复测恢复 [kw,kg] → 回归解除、恢复自动灌入资格、快照推进')

  // 版本 3：全平台失败而上一版有通过 → 回归标记 passed=[]（可用性本来也拦灌入，标记为了可见）
  e.contentHash = 'v3'
  e.deep = null; e.usable = false
  deepScript = deepOf({ kw: 'failed', kg: 'failed' })
  await h.runCheck(['s1'])
  assert.strictEqual(e.regression && e.regression.suspected, true)
  assert.deepStrictEqual(e.regression.passed, [])
  assert.deepStrictEqual(e.regression.lost, ['kw', 'kg'])
  ok('新版本全平台未过 → 回归标记（passed=[]、lost=上一版全量）')

  // 版本 4：通过更多平台 → 无回归、快照推进、旧回归清掉
  e.contentHash = 'v4'
  e.deep = null; e.usable = false
  deepScript = deepOf({ kw: 'usable', kg: 'usable', mg: 'usable' })
  await h.runCheck(['s1'])
  assert.strictEqual(e.regression == null || !e.regression.suspected, true, '范围扩大清掉回归')
  assert.strictEqual(e.passSnapshot.sha, 'v4')
  assert.deepStrictEqual(e.passSnapshot.passed, ['kw', 'kg', 'mg'])
  ok('新版通过更多平台 → 无回归、快照推进')

  // 版本 5：快速模式证据不足（kg untested）→ 不判回归；快照不回退
  e.contentHash = 'v5'
  e.deep = null; e.usable = false
  deepScript = deepOf({ kw: 'usable', kg: 'untested' })
  await h.runCheck(['s1'])
  assert.strictEqual(e.regression == null || !e.regression.suspected, true, 'untested 不判回归')
  assert.strictEqual(e.passSnapshot.sha, 'v4', '通过数变小时快照不回退（防基线越记越低）')
  ok('快速模式 kg 未测 → 不判回归、快照基线不缩水')

  // 平台此消彼长：丢 kg 但新过 wy，总数不变 → 不判回归
  e.contentHash = 'v6'
  e.deep = null; e.usable = false
  deepScript = deepOf({ kw: 'usable', kg: 'failed', mg: 'usable', wy: 'usable' })
  await h.runCheck(['s1'])
  assert.strictEqual(e.regression == null || !e.regression.suspected, true, '总数不减不算回归')
  assert.strictEqual(e.passSnapshot.sha, 'v6', '总数不减 → 快照推进')
  ok('丢一补一总数不变 → 不判回归、快照推进')
}

// ---------------- 自动灌入过滤：疑似回归版本不进定时灌入 ----------------
async function pipelineFilterCase() {
  console.log('\n== runAutoPipeline 自动灌入质量闸 ==')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-qgate-pipe-'))
  const store = new Store(dir)
  store.saveConfig({ platforms: [{ id: 'p1', type: 'lxserver', name: '主账号', url: 'http://a', enabled: true, batchImport: true }], activePlatformId: 'p1', crawlAutoImport: true })
  // clean：正常可用；gated：带疑似回归；fresh：无 deep（要进检测）
  store.db.sources.clean = { id: 'clean', name: '正常源', url: 'http://x/c.js', usable: true, contentHash: 'hc', lxName: '正常源', deep: { checkedAt: 1000, hash: 'hc', platforms: { kw: { status: 'usable' } } } }
  store.db.sources.gated = { id: 'gated', name: '回归源', url: 'http://x/g.js', usable: true, contentHash: 'hg', lxName: '回归源', deep: { checkedAt: 1000, hash: 'hg', platforms: { kw: { status: 'usable' } } }, regression: { suspected: true, sha: 'hg', prevSha: 'hg0', prevPassed: ['kw', 'kg'], passed: ['kw'], lost: ['kg'], gained: [], at: 1 } }
  const h = Object.create(Hunter.prototype)
  h.store = store
  h.job = { running: false, cancel: false }
  h.emit = () => {}
  const logs = []
  h.log = (msg, mod, lv) => logs.push({ msg, mod, lv })
  h.step = () => {}
  h.progress = () => {}
  let importIds = null
  h.runCrawl = async () => { store.db.sources.fresh = { id: 'fresh', name: '新源', url: 'http://x/f.js', contentHash: 'hf', lxName: '新源' }; return { added: 1, updated: 0, skipped: 0 } }
  h.runCheck = async (ids) => {
    const e = store.db.sources[ids[0]]
    e.usable = true
    e.deep = { checkedAt: 2000, hash: 'hf', platforms: { kw: { status: 'usable' } } }
    return { usable: 1, total: ids.length }
  }
  h.runImport = async (ids) => { importIds = ids.slice(); return { results: [], ok: 0, skipped: 0 } }
  const out = await h.runAutoPipeline()
  assert.ok(out.import, '管线应走到灌入')
  assert.deepStrictEqual(importIds && importIds.slice().sort(), ['clean', 'fresh'], '疑似回归版本不进自动灌入')
  assert.ok(logs.some(l => /质量守门/.test(l.msg) && /回归源/.test(l.msg)), '要有守门日志点名被拦条目')
  ok('定时灌入跳过疑似回归版本并写守门日志（clean/fresh 正常进候选）')
}

// ---------------- 第三方探针对照（报告层，只读） ----------------
async function crosscheckCase() {
  console.log('\n== 第三方探针对照（报告层）==')
  const { runCrosscheck, resetCrosscheckCache, CROSSCHECK_URL } = require('../src/core/crosscheck')
  assert.ok(/raw\.githubusercontent\.com\/shellsec\/lx-music-source/.test(CROSSCHECK_URL), '默认对照对象是 shellsec/lx-music-source 的探针快照')
  ok('对照源固定为 shellsec/lx-music-source tests 快照（只读结论，不下脚本）')

  const SNAP = {
    testedAt: '2026-11-09T02:07:15.043Z',
    results: [
      { id: 'same', name: '一致源', sha256: 'sha-same', attempts: [
        { source: 'kw', resolved: true, audio: true }, { source: 'kg', resolved: true, audio: true } ] },
      { id: 'theirdead', name: '对方全挂', sha256: 'sha-theirdead', attempts: [
        { source: 'kw', error: 'no stream' }, { source: 'kg', error: 'no stream' } ] },
      { id: 'theirfail1', name: '对方单平台失败', sha256: 'sha-theirfail1', attempts: [
        { source: 'kw', error: 'no stream' }, { source: 'kg', resolved: true, audio: true } ] },
      { id: 'ourdead', name: '我们未过', sha256: 'sha-ourdead', attempts: [
        { source: 'kw', resolved: true, audio: true } ] }
    ]
  }
  // 打桩 crawlFetch（模块在 require 时解构引用，需先改 net 再清缓存重进）
  const origFetch = net.crawlFetch
  net.crawlFetch = async (url) => ({ res: { status: 200, text: async () => JSON.stringify(SNAP) }, url, mirror: 'direct', attempts: [] })
  delete require.cache[require.resolve('../src/core/crosscheck')]
  const cc = require('../src/core/crosscheck')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-qgate-cc-'))
  const store = new Store(dir)
  const mk = (id, name, hash, usable, plats) => { store.db.sources[id] = { id, name, lxName: name, usable, contentHash: hash, deep: { checkedAt: 1, hash, platforms: plats } } }
  mk('a1', '一致源', 'sha-same', true, { kw: { status: 'usable' }, kg: { status: 'usable' } })
  mk('a2', '对方全挂', 'sha-theirdead', true, { kw: { status: 'usable' }, kg: { status: 'usable' } })
  mk('a3', '对方单平台失败', 'sha-theirfail1', true, { kw: { status: 'usable' }, kg: { status: 'usable' } })
  mk('a4', '我们未过', 'sha-ourdead', false, { kw: { status: 'failed' } })

  resetCrosscheckCache()
  const rep = await cc.runCrosscheck(store)
  assert.strictEqual(rep.ok, true)
  assert.strictEqual(rep.theirTotal, 4)
  assert.strictEqual(rep.matchedCount, 4)
  assert.strictEqual(rep.theirTestedAt, SNAP.testedAt, '报告要带对方的 testedAt 供判新鲜度')
  const byId = {}
  for (const m of rep.matched) byId[m.theirId] = m
  assert.strictEqual(byId.same.drift, null, '两边一致 → 无漂移')
  assert.strictEqual(byId.theirdead.drift, 'dead', '我们可用、对方全挂 → 强漂移')
  assert.strictEqual(byId.theirfail1.drift, 'platform', '对方单平台实测失败 → 平台漂移')
  assert.strictEqual(byId.ourdead.drift, 'platform', '对方仍通过、我们未过 → 平台漂移（提示可复测）')
  assert.strictEqual(rep.summary.deadDrift, 1)
  assert.strictEqual(rep.summary.platformDrift, 2)
  assert.strictEqual(rep.summary.agree, 1)
  ok('对照报告：强漂移/平台漂移/一致 分类正确，summary 计数正确')

  // 只读红线：跑完对照库内条目不得被改写
  assert.strictEqual(store.db.sources.a2.usable, true)
  assert.strictEqual(store.db.sources.a4.usable, false)
  assert.strictEqual(store.db.sources.a2.validTier, undefined)
  ok('对照不写库：usable/validTier 等库内状态零改动')

  // 缓存：第二次调用不重新拉取
  let pulls = 0
  net.crawlFetch = async () => { pulls++; return { res: { status: 200, text: async () => JSON.stringify(SNAP) }, url: '', mirror: 'x', attempts: [] } }
  delete require.cache[require.resolve('../src/core/crosscheck')]
  const cc2 = require('../src/core/crosscheck')
  await cc2.runCrosscheck(store)
  const pullsAfterFirst = pulls
  await cc2.runCrosscheck(store)
  assert.strictEqual(pulls, pullsAfterFirst, '10 分钟内存缓存内不重复拉取')
  ok('报告带内存缓存（10 分钟 TTL），不反复打对方仓库')

  net.crawlFetch = origFetch
}

// ---------------- 跑异步用例 ----------------
gateScenario()
  .then(() => pipelineFilterCase())
  .then(() => crosscheckCase())
  .then(() => console.log('\n=== quality-gate 测试通过：' + pass + ' 项 ==='))
  .catch(e => { console.error('\n[FAIL] ' + ((e && e.stack) || e)); process.exit(1) })
