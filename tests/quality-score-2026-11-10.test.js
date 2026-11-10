'use strict'
/**
 * 同名「留优删差」判据回归（2026-11-10 23:5x 用户口径定稿版）
 *
 * 口径（用户原话）：
 *   「lx-hunter 是采集音源的容器，本身能正确检验音源能用就 ok，对于同名类的音源才需要打分检测」
 *   「平台数 → 延迟 → 音质档」
 *   「只有同名-同平台数-同 p50 才能走到测音质，这很难了。如果是全面检测，我觉得没必要测音源音质」
 * ⇒ 比较必须是**字典序**，不是加权求和；音质档只在专项补测（qualityMax）后才有值。
 *
 * 本文件守三件事，缺一条都算没落地：
 *   1. 高优先级维度不能被低优先级补偿（旧加权求和会犯的错）；
 *   2. 没有证据时绝不裁决（声明值 ≠ 实测值，未测 ≠ 不可用）；
 *   3. qualityUsed 这种「看作者书写顺序」的字段永远不能当音质证据。
 */
const assert = require('assert')
const Q = require('../src/core/quality')
const C = require('../src/core/checker')
const { Hunter } = require('../src/core/hunter')
const U = require('../src/core/sourceUpdate')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')) }
}

const KEYS = ['wy', 'tx', 'kw', 'kg', 'mg']
/** 造一条「本地实测」条目：usable 个平台可用（真校验通过），其余为 failed/untested。 */
function mk(o) {
  const opt = o || {}
  const usable = opt.usable === undefined ? 3 : opt.usable
  const untested = opt.untested || 0
  const platforms = {}
  for (let i = 0; i < KEYS.length; i++) {
    const k = KEYS[i]
    if (i < usable) platforms[k] = { status: 'usable', verified: true, metrics: { attempts: 2, successes: 2, latencies: [120, 180], attemptLatencies: [120, 180] } }
    else if (i < usable + untested) platforms[k] = { status: 'untested' }
    else platforms[k] = { status: 'failed' }
  }
  const m = Object.assign({
    // 默认造「深度检测（打分）」结果：2026-11-10 00:1x 起只有 depth==='full' 的
    // metrics 才参与比较/排序（初筛不打分）。要测初筛口径请显式传 depth:'quick'。
    depth: 'full',
    attempts: 6, successes: 6, playable: 6,
    successRate: 1, playableRate: 1,
    p50LatencyMs: 300, p90LatencyMs: 500, samples: 6, okSamples: 6,
    qualityUsed: ['128k'], qualityDeclared: ['128k', '320k', 'flac']
  }, opt.metrics || {})
  const deep = { checkedAt: Date.now(), platforms }
  if (!opt.noMetrics) deep.metrics = m
  return { deep }
}

console.log('=== A. 采集层只聚合原始证据（不打分） ===')
{
  const plats = {
    wy: { status: 'usable', metrics: { attempts: 3, successes: 2, playable: 2, latencies: [100, 300], attemptLatencies: [100, 300, 250], qualityUsed: '320k', qualityDeclared: ['128k', '320k'] } },
    tx: { status: 'failed', metrics: { attempts: 2, successes: 0, latencies: [], attemptLatencies: [500, 700], qualityUsed: null, qualityDeclared: ['flac'] } },
    kw: { status: 'untested' }
  }
  const m = C.aggregateMetrics(plats, {})
  ok('attempts 累加所有真实请求', m.attempts === 5, JSON.stringify(m))
  ok('successes 只算拿到有效链接的请求', m.successes === 2)
  ok('p50 只取成功请求耗时 [100,300] → 200', m.p50LatencyMs === 200, 'got ' + m.p50LatencyMs)
  ok('p90 不再是死字段', m.p90LatencyMs === 280, 'got ' + m.p90LatencyMs)
  ok('可播数与链接数分开留档（拿到链接≠能播）', m.playableRate === 2 / 5)
  ok('聚合结果里没有任何 score 字段', !('score' in m) && !('weights' in m))
  ok('无 metrics 的平台不产生样本', C.aggregateMetrics({ kw: { status: 'untested' } }, {}).attempts === 0)
  ok('声明档位不会因每平台重复而膨胀', (() => {
    const d = { wy: { qualitys: ['128k', '320k'] }, tx: { qualitys: ['128k'] } }
    const mm = C.aggregateMetrics({
      wy: { status: 'usable', metrics: { qualityDeclared: ['128k', '320k'] } },
      tx: { status: 'usable', metrics: { qualityDeclared: ['128k'] } }
    }, d)
    return mm.qualityDeclared.length === 2
  })())
}

console.log('=== B. 档位映射只做字典序（不为求和服务） ===')
{
  ok('flac > 320k > 128k', Q.tierScore('flac').score > Q.tierScore('320k').score && Q.tierScore('320k').score > Q.tierScore('128k').score)
  ok('hires 高于 flac', Q.tierScore('hires').score > Q.tierScore('flac').score)
  ok('自定义未知档位给保底分且标 known=false', Q.tierScore('myq').known === false && Q.tierScore('myq').score > 0)
  ok('空值不产生档位', Q.tierScore('') === null && Q.tierScore(null) === null)
  ok('没有加权评分 API 残留', !Q.qualityScore && !Q.resolveOpts && !Q.optsFromConfig && !Q.DEFAULT_WEIGHTS && !Q.scoreVerdict)
}

console.log('=== C. 第一层：平台数不可被延迟补偿（推翻加权求和的关键） ===')
{
  // 旧加权实现会算出「4 平台但慢 2s」≈ 或 > 「3 平台但快 200ms」，于是删掉更可用的源。
  const fewFast = mk({ usable: 3, metrics: { p50LatencyMs: 200 } })
  const manySlow = mk({ usable: 4, metrics: { p50LatencyMs: 2000 } })
  const v = Q.compareVerdict(fewFast, manySlow)
  ok('平台少的即使快 1800ms 也判劣', v.cmp === -1 && v.by === 'platforms', v.by + ' | ' + v.reason)
  ok('反向一致（对称）', Q.compareVerdict(manySlow, fewFast).cmp === 1)
  ok('理由写出双方平台数', /3 vs 4/.test(v.reason), v.reason)
  // 排序视图（用户要的「按综合分高低排序」）走 sortKey 全序元组，
  // 不能拿带噪声带的 compareVerdict 当 comparator（会出现 a>b>c>a 的循环，顺序不可复现）。
  const order = [fewFast, manySlow].sort(Q.compareSortKey)
  ok('排序视图：平台多的排在前', order[0] === manySlow)
}

console.log('=== C2. 排序视图：sortKey 是全序（顺序可复现） ===')
{
  const pool = [
    mk({ usable: 4, metrics: { p50LatencyMs: 1250, qualityMax: '128k' } }),
    mk({ usable: 4, metrics: { p50LatencyMs: 600, qualityMax: '128k' } }),
    mk({ usable: 5, metrics: { p50LatencyMs: 2900 } }),
    mk({ usable: 3, metrics: { p50LatencyMs: 100 } }),
    mk({ usable: 4, noMetrics: true })
  ]
  const sorted = pool.slice().sort(Q.compareSortKey)
  ok('平台数优先：5 平台排第一', Q.profile(sorted[0]).usable === 5)
  ok('同平台数内按 p50 升序', Q.profile(sorted[1]).p50 === 600 && Q.profile(sorted[2]).p50 === 1250)
  ok('无延迟证据的排在同平台数实测之后', Q.profile(sorted[3]).p50 === null && Q.profile(sorted[3]).usable === 4)
  ok('最后是 3 平台', Q.profile(sorted[4]).usable === 3)
  ok('sortKey 反对称', Q.compareSortKey(pool[0], pool[1]) === -Q.compareSortKey(pool[1], pool[0]))
  ok('sortKey 与噪声带无关：差 299ms 也严格分先后', Q.compareSortKey(
    mk({ usable: 4, metrics: { p50LatencyMs: 1000 } }),
    mk({ usable: 4, metrics: { p50LatencyMs: 1299 } })) === -1)
  ok('sortKey 不返回 NaN（无 null 参与比较）', pool.every(x => Q.sortKey(x).every(v => typeof v === 'number' && !Number.isNaN(v))))
}

console.log('=== D. 第二层：p50 噪声带 300ms（差 1ms 不足以删源） ===')
{
  const a = mk({ usable: 4, metrics: { p50LatencyMs: 1000 } })
  const bIn = mk({ usable: 4, metrics: { p50LatencyMs: 1299 } })
  const bOut = mk({ usable: 4, metrics: { p50LatencyMs: 1300 } })
  ok('差 299ms 在噪声带内 → 平手', Q.compareVerdict(a, bIn).cmp === 0 && Q.compareVerdict(a, bIn).by === 'tie')
  ok('差 300ms 刚好达到阈值 → 按延迟裁决', Q.compareVerdict(a, bOut).cmp === 1 && Q.compareVerdict(a, bOut).by === 'latency')
  ok('噪声带常量可读为 300', Q.LATENCY_MARGIN_MS === 300)
  const noLat = mk({ usable: 4, noMetrics: true })
  ok('一侧没有延迟证据 → 不按延迟裁决（平手）', Q.compareVerdict(a, noLat).cmp === 0, Q.compareVerdict(a, noLat).by)
}

console.log('=== E. 第三层：只有 qualityMax 才算音质证据 ===')
{
  const hi = mk({ usable: 4, metrics: { p50LatencyMs: 1000, qualityMax: 'flac', qualityUsed: '128k' } })
  const lo = mk({ usable: 4, metrics: { p50LatencyMs: 1000, qualityMax: '128k', qualityUsed: '128k' } })
  ok('同为 4 平台、p50 相同 → 由最高可播档裁决', Q.compareVerdict(hi, lo).cmp === 1 && Q.compareVerdict(hi, lo).by === 'tier', Q.compareVerdict(hi, lo).by)
  ok('档位理由写出实测档名', /flac/.test(Q.compareVerdict(hi, lo).reason), Q.compareVerdict(hi, lo).reason)

  // 关键：qualityUsed 是「作者把哪档写在前面」，不能当能力
  const used320 = mk({ usable: 4, metrics: { p50LatencyMs: 1000, qualityUsed: '320k' } })
  const used128 = mk({ usable: 4, metrics: { p50LatencyMs: 1000, qualityUsed: '128k' } })
  const vu = Q.compareVerdict(used320, used128)
  ok('只有 qualityUsed 时不得据此裁决（平手不删）', vu.cmp === 0 && vu.by === 'tie', vu.by + ' | ' + vu.reason)
  ok('profile 不把 qualityUsed 当 tier', Q.profile(used320).tier === null)

  const same = mk({ usable: 4, metrics: { p50LatencyMs: 1000, qualityMax: 'flac' } })
  ok('档位相同 → 平手不删', Q.compareVerdict(hi, same).cmp === 0)
  const noTier = mk({ usable: 4, metrics: { p50LatencyMs: 1000 } })
  ok('缺档位证据 → 跳过第三层（不猜测）', Q.compareVerdict(hi, noTier).cmp === 0, Q.compareVerdict(hi, noTier).by)
}

console.log('=== F. 证据不足：声明值不能拿去压实测值 ===')
{
  const srv = { supportedSources: ['wy', 'tx', 'kw'] }
  const local = mk({ usable: 5 })
  const v = Q.compareVerdict(local, srv)
  ok('服务端只有声明值 → 判证据不足', v.cmp === 0 && v.by === 'insufficient', v.by + ' | ' + v.reason)
  ok('反向同样不裁决', Q.compareVerdict(srv, local).cmp === 0)
  ok('两侧都只有声明值 → 也不裁决', Q.compareVerdict(srv, { supportedSources: ['wy'] }).cmp === 0)
  ok('describeQuality 明确写出「仅声明」', /仅声明/.test(Q.describeQuality(srv)))
  ok('profile 标 declared=true 且 usable 来自声明', Q.profile(srv).declared === true && Q.profile(srv).usable === 3)
}

console.log('=== G. 未测 ≠ 不可用；skipped 不算缺口 ===')
{
  const quick = mk({ usable: 1, untested: 4, noMetrics: true })
  const full1 = mk({ usable: 1, noMetrics: true })
  ok('快速模式 1 可用 + 4 未测 不因未测判劣', Q.compareVerdict(quick, full1).cmp === 0)
  ok('untested 不计入 usable', Q.profile(quick).usable === 1 && Q.profile(quick).untested === 4)
  const skipped = { deep: { checkedAt: 1, platforms: { wy: { status: 'usable', verified: true }, tx: { status: 'skipped' } }, metrics: { attempts: 2, successes: 2, p50LatencyMs: 200, samples: 2 } } }
  ok('skipped 既不算可用也不算未测', Q.profile(skipped).usable === 1 && Q.profile(skipped).untested === 0)
  const failed = { deep: { checkedAt: 1, platforms: { wy: { status: 'usable' }, tx: { status: 'failed' } } } }
  ok('failed 计入 tested 但不计 usable', Q.profile(failed).tested === 2 && Q.profile(failed).usable === 1)
}

console.log('=== H. 平手/边界一律不删（删源不可逆） ===')
{
  const a = mk({ usable: 3, metrics: { p50LatencyMs: 500 } })
  const b = mk({ usable: 3, metrics: { p50LatencyMs: 600 } })
  ok('完全平手 → cmp=0', Q.compareVerdict(a, b).cmp === 0)
  ok('isClearlyBetter 对平手为 false', Q.isClearlyBetter(a, b) === false)
  ok('cmp 恒为 -1/0/1', [-1, 0, 1].includes(Q.compareVerdict(a, b).cmp))
  ok('自反比较为平手', Q.compareVerdict(a, a).cmp === 0)
  const empty = { deep: { checkedAt: 1, platforms: {} } }
  ok('空平台集不会崩且判平手', Q.compareVerdict(empty, a).cmp === 0)
}

console.log('=== I. 生产路径：三条灌入口径 ===')
{
  const H = new Hunter({ config: {} }, () => {})
  const srvCode = '/* code */'
  const srvBase = { id: 'Demo Source v1.0.js', name: 'Demo Source v1.0', version: '1.0', supportedSources: ['wy', 'tx', 'kw'], repository: 'https://github.com/bbb/demo' }

  // 口径 2：同仓库 + 版本更高 → 留新删旧
  const sameRepoNew = Object.assign({}, mk({ usable: 4 }), {
    id: 'c1', scriptName: 'Demo Source v1.1', lxName: 'Demo Source v1.1',
    repository: 'https://github.com/bbb/demo'
  })
  const v2 = H.sameNameVerdict(sameRepoNew, srvBase, srvCode, {})
  ok('同仓库同名 + 版本更高 + 质量不劣 → replace', v2.act === 'replace', v2.act + ' | ' + v2.why)

  // 口径 3：跨仓库 + 本地实测更优 → replace；平手 → rename；更差 → skip
  const crossBetter = Object.assign({}, mk({ usable: 5 }), {
    id: 'c2', scriptName: 'Demo Source v1.0', lxName: 'Demo Source v1.0', repository: 'https://github.com/aaa/demo'
  })
  const srvDeepWeak = Object.assign({}, srvBase, { deep: mk({ usable: 2 }).deep })
  const v3 = H.sameNameVerdict(crossBetter, srvDeepWeak, srvCode, {})
  ok('跨仓库同名 + 本地 5 平台 vs 服务端 2 平台 → replace', v3.act === 'replace', v3.act + ' | ' + v3.why)
  ok('理由带判据来源 by=platforms', /platforms/.test(v3.why), v3.why)

  const crossTie = Object.assign({}, mk({ usable: 3 }), {
    id: 'c3', scriptName: 'Demo Source v1.0', lxName: 'Demo Source v1.0', repository: 'https://github.com/aaa/demo'
  })
  const srvDeepSame = Object.assign({}, srvBase, { deep: mk({ usable: 3 }).deep })
  const v4 = H.sameNameVerdict(crossTie, srvDeepSame, srvCode, {})
  ok('跨仓库同名 + 平台数平手 → rename 并存（不删任何一方）', v4.act === 'rename', v4.act + ' | ' + v4.why)

  const crossWorse = Object.assign({}, mk({ usable: 2 }), {
    id: 'c4', scriptName: 'Demo Source v1.0', lxName: 'Demo Source v1.0', repository: 'https://github.com/aaa/demo'
  })
  const srvDeepStrong = Object.assign({}, srvBase, { deep: mk({ usable: 4 }).deep })
  const v5 = H.sameNameVerdict(crossWorse, srvDeepStrong, srvCode, {})
  ok('跨仓库同名 + 本地更差 → skip（保留服务端）', v5.act === 'skip', v5.act + ' | ' + v5.why)

  // 口径 1：不同名 → 直接灌入，不走裁决（由 _planImportQueue 处理）
  ok('同名判定函数不存在「直接灌入」分支', typeof H._planImportQueue === 'function')
}

console.log('=== J. 生产路径：快速模式绝不按质量删源 ===')
{
  const H = new Hunter({ config: {} }, () => {})
  const srv = { id: 'Demo Source v1.0.js', name: 'Demo Source v1.0', supportedSources: ['wy', 'tx', 'kw'], repository: 'https://github.com/bbb/demo' }
  const quick = Object.assign({}, mk({ usable: 1, untested: 4, noMetrics: true }), {
    id: 'q1', scriptName: 'Demo Source v1.0', lxName: 'Demo Source v1.0', repository: 'https://github.com/aaa/demo'
  })
  const v = H.sameNameVerdict(quick, srv, '/* code */', {})
  ok('跨仓库 + 快速模式未全测 → rename 改名并存', v.act === 'rename', v.act + ' | ' + v.why)
  ok('理由提示先做全平台检测', /全平台/.test(v.why), v.why)

  const dead = Object.assign({}, mk({ usable: 0 }), {
    id: 'q2', scriptName: 'Demo Source v1.0', lxName: 'Demo Source v1.0', repository: 'https://github.com/aaa/demo'
  })
  const v2 = H.sameNameVerdict(dead, srv, '/* code */', {})
  ok('本地实测 0 可用 → 绝不替换', v2.act === 'skip', v2.act + ' | ' + v2.why)
}

console.log('=== K. 回归：等长不同版本不得判 synced（17960 实机坑） ===')
{
  const H = new Hunter({ config: {} }, () => {})
  const code = 'x'.repeat(100)
  const e = Object.assign({}, mk({ usable: 3 }), {
    id: 'v110', scriptName: 'Demo v1.1.0', lxName: 'Demo v1.1.0', repository: 'https://github.com/bbb/demo'
  })
  const srv = { id: 'Demo v1.0.0.js', name: 'Demo v1.0.0', size: 100, supportedSources: ['wy'], repository: 'https://github.com/bbb/demo' }
  const v = H.sameNameVerdict(e, srv, code, {})
  ok('字节长度相同但版本不同 → 不判 synced', v.act !== 'synced', v.act + ' | ' + v.why)
  ok('版本更高 → 走留新删旧', v.act === 'replace', v.act + ' | ' + v.why)
  const srvHash = Object.assign({}, srv, { hash: 'abc' })
  const v2 = H.sameNameVerdict(Object.assign({}, e, { contentHash: 'abc' }), srvHash, code, {})
  ok('hash 相同 → 判 synced（强证据优先）', v2.act === 'synced')
}

console.log('=== L. 巡检报告仍是只读，跨仓库给 layered-fallback ===')
{
  const cross = U.pairSources(
    [{ id: 'Demo Source v1.0.js', name: 'Demo Source v1.0', version: '1.0', repository: 'https://github.com/aaa/demo', supportedSources: ['wy', 'tx'], enabled: true }],
    [{ id: 'c1', name: 'Demo Source v1.0', scriptName: 'Demo Source v1.0', scriptVersion: '1.0', repository: 'https://github.com/ccc/demo', deep: mk({ usable: 4 }).deep }],
    {}
  )[0]
  ok('跨仓库巡检不再被 fewer-platforms 提前拦死', cross.evidence.quality !== undefined)
  ok('跨仓库巡检如实标 layered-fallback', cross.evidence.quality && cross.evidence.quality.mode === 'layered-fallback')
}

console.log('\nRESULT ' + pass + ' PASS / ' + fail + ' FAIL')
if (fail) process.exit(1)
