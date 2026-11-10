'use strict'
/**
 * 综合评分专项回归（2026-11-10 22:0x 拍板）
 * 重点不是「能算出分」，而是「证据不足/噪声带/声明值虚高时不会误删一个可用音源」。
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
function mk(opts) {
  const o = opts || {}
  const usable = o.usable === undefined ? 3 : o.usable
  const platforms = {}
  for (let i = 0; i < KEYS.length; i++) {
    const k = KEYS[i]
    if (i < usable) platforms[k] = { status: 'usable', verified: true, metrics: { attempts: 2, successes: 2, latencies: [120, 180], attemptLatencies: [120, 180] } }
    else if (o.untested && i < usable + o.untested) platforms[k] = { status: 'untested' }
    else platforms[k] = { status: 'failed' }
  }
  const m = Object.assign({
    attempts: 6, successes: 5, successRate: 5 / 6,
    p50LatencyMs: 300, p90LatencyMs: null, samples: 5, okSamples: 5,
    qualityUsed: o.qualityUsed || ['320k'],
    qualityDeclared: o.qualityDeclared || ['128k', '320k']
  }, o.metrics || {})
  if (o.noMetrics) return { deep: { checkedAt: Date.now(), platforms } }
  return { deep: { checkedAt: Date.now(), platforms, metrics: m } }
}

console.log('=== A. checker 采样聚合（原始证据） ===')
{
  const plats = {
    wy: { status: 'usable', metrics: { attempts: 3, successes: 2, latencies: [100, 300], attemptLatencies: [100, 300, 250], qualityUsed: '320k', qualityDeclared: ['128k', '320k'] } },
    tx: { status: 'failed', metrics: { attempts: 2, successes: 0, latencies: [], attemptLatencies: [500, 700], qualityUsed: null, qualityDeclared: ['flac'] } },
    kw: { status: 'untested' }
  }
  const m = C.aggregateMetrics(plats, {})
  ok('attempts 累加所有真实请求', m.attempts === 5, JSON.stringify(m))
  ok('successes 只算拿到有效链接的请求', m.successes === 2)
  ok('p50 只取成功请求耗时 [100,300] → 200', m.p50LatencyMs === 200, 'got ' + m.p50LatencyMs)
  ok('音质档聚合实测 320k + 声明 flac', m.qualityUsed.includes('320k') && m.qualityDeclared.includes('flac'))
  ok('没有 metrics 的平台不产生样本', C.aggregateMetrics({ kw: { status: 'untested' } }, {}).attempts === 0)
}

console.log('=== B. 权重与档位映射 ===')
{
  const o = Q.resolveOpts({ weights: { platforms: 2, success: 1, latency: 1, quality: 0 } })
  ok('权重归一化后总和为 1', Math.abs(Object.values(o.weights).reduce((a, b) => a + b, 0) - 1) < 1e-9)
  const z = Q.resolveOpts({ weights: { platforms: 0, success: 0, latency: 0, quality: 0 } })
  ok('全 0 权重回退默认，不除零', z.weights.platforms === Q.DEFAULT_WEIGHTS.platforms)
  ok('flac 档位分 > 320k > 128k', Q.tierScore('flac').score > Q.tierScore('320k').score && Q.tierScore('320k').score > Q.tierScore('128k').score)
  ok('自定义未知档位给保底分且标 known=false', Q.tierScore('myq').known === false && Q.tierScore('myq').score > 0)
}

console.log('=== C. 综合分与证据门槛（核心） ===')
{
  const strong = mk({ usable: 5, metrics: { p50LatencyMs: 100 } })
  const weak = mk({ usable: 1, metrics: { attempts: 6, successes: 2, successRate: 2 / 6, p50LatencyMs: 7000, samples: 5 } })
  const s1 = Q.qualityScore(strong), s2 = Q.qualityScore(weak)
  ok('证据齐全时算出 0..1 的分', s1.score !== null && s1.score > 0 && s1.score <= 1, JSON.stringify(s1.score))
  ok('覆盖度 = 1（四维全有效）', Math.abs(s1.coverage - 1) < 1e-9)
  ok('5 平台 + 快 + 高成功率 > 1 平台 + 慢 + 低成功率', s1.score > s2.score)
  ok('compareQuality 判强者为优', Q.compareQuality(strong, weak) === 1)
  ok('isClearlyBetter 同向', Q.isClearlyBetter(strong, weak) === true && Q.isClearlyBetter(weak, strong) === false)

  const few = mk({ usable: 3, metrics: { attempts: 2, successes: 2, successRate: 1, p50LatencyMs: 300, samples: 2 } })
  const fs = Q.qualityScore(few)
  ok('样本 < minSamples 时成功率维度失效', fs.parts.success.valid === false)
  ok('样本 < minSamples 时延迟维度失效', fs.parts.latency.valid === false)
  ok('两个维度失效但覆盖度仍达标时只按剩余维度重归一化', fs.score !== null && fs.coverage < 1)

  const srv = { supportedSources: ['wy', 'tx', 'kw'] }  // lxserver list：无 deep、无 hash、无正文
  const ss = Q.qualityScore(srv)
  ok('服务端声明条目平台权重折半（弱证据）', ss.parts.platforms.weak === true && ss.parts.platforms.w < Q.DEFAULT_WEIGHTS.platforms)
  ok('服务端声明条目判证据不足 score=null', ss.score === null, 'score=' + ss.score + ' coverage=' + ss.coverage)
  ok('本地实测 vs 服务端声明：证据不对称不得判本地赢（回落分层）', Q.compareQuality(mk({ usable: 3 }), srv) === 0)
  ok('服务端声明 3 平台 vs 本地实测 3 平台 → 平手不删', Q.compareQuality(srv, mk({ usable: 3 })) === 0)
}

console.log('=== D. 分差噪声带（不许 0.001 分差就删源） ===')
{
  const a = mk({ usable: 4, metrics: { p50LatencyMs: 1000 } })
  const b = mk({ usable: 4, metrics: { p50LatencyMs: 1050 } })
  const sa = Q.qualityScore(a).score, sb = Q.qualityScore(b).score
  ok('两个近似音源都算出分', sa !== null && sb !== null)
  ok('微小分差判平手', Q.compareQuality(a, b) === 0, 'diff=' + (sa - sb))
  const wide = Q.resolveOpts({ scoreMargin: 0 })
  ok('把 margin 设为 0 时才按分差裁决', Q.compareQuality(a, b, wide) !== 0)
  ok('scoreVerdict 给出可解释模式与明细', Q.scoreVerdict(a, b).mode === 'composite' && /综合分/.test(Q.scoreVerdict(a, b).a.desc))
}

console.log('=== E2. lx-music 播放侧经验：可播率、延迟上限、声明档位虚高 ===')
{
  // 同样「拿到 6 个链接」，但一个 6 个都真可播、一个只有 1 个真可播
  const playableOK = mk({ usable: 3, metrics: { attempts: 6, successes: 6, playable: 6, p50LatencyMs: 200, samples: 6 } })
  const linkOnly = mk({ usable: 3, metrics: { attempts: 6, successes: 6, playable: 1, p50LatencyMs: 200, samples: 6 } })
  ok('拿到链接≠能播：可播率低的综合分更低',
    Q.qualityScore(playableOK).score > Q.qualityScore(linkOnly).score)
  ok('理由里同时写出可播数与链接数', /可播/.test(Q.qualityScore(linkOnly).parts.success.detail) && /链接/.test(Q.qualityScore(linkOnly).parts.success.detail))
  const legacy = mk({ usable: 3, metrics: { attempts: 6, successes: 6, p50LatencyMs: 200, samples: 6 } })
  ok('旧数据无 playable 字段时退回链接率，不误判为 0', Q.qualityScore(legacy).score !== null && Q.qualityScore(legacy).score > 0)

  // A/B 实测 p90 447~596ms：200ms 应接近满分，3000ms 应归零
  const fast = mk({ usable: 3, metrics: { p50LatencyMs: 200, samples: 6 } })
  const slow = mk({ usable: 3, metrics: { p50LatencyMs: 3000, samples: 6 } })
  ok('p50 200ms 延迟分接近满分', Q.qualityScore(fast).parts.latency.raw > 0.9)
  ok('p50 3000ms 延迟分归零（上限取 A/B p90 的约 5 倍）', Q.qualityScore(slow).parts.latency.raw === 0)
  ok('默认上限 3000ms', Q.DEFAULT_OPTS.latencyCapMs === 3000)

  // 声明 flac 但从未实测成功（lx-music 实测 flac 脚本全败需服务端兜底）
  const declaredFlac = mk({ usable: 3, qualityUsed: [], metrics: { qualityDeclared: ['flac'], p50LatencyMs: 200, samples: 6 } })
  ok('仅声明高档位标 weak 且折扣可解释', Q.qualityScore(declaredFlac).parts.quality.weak === true && /×0\.7/.test(Q.qualityScore(declaredFlac).parts.quality.detail))
  ok('声明 flac 的分数低于实测 320k', Q.qualityScore(declaredFlac).parts.quality.raw < Q.tierScore('320k').score)
}

console.log('=== E. 声明值打折与四维独立影响 ===')
{
  const declaredOnly = mk({ usable: 3, qualityUsed: [], metrics: { qualityDeclared: ['flac'] } })
  const usedLow = mk({ usable: 3, qualityUsed: ['128k'], metrics: { qualityDeclared: ['flac'] } })
  ok('实测成功档位优先于声明最高档', Q.qualityScore(declaredOnly).score > Q.qualityScore(usedLow).score)
  ok('只有声明档位时该维度标 weak', Q.qualityScore(declaredOnly).parts.quality.weak === true)

  const base = mk({ usable: 3, metrics: { attempts: 6, successes: 6, successRate: 1, p50LatencyMs: 200, samples: 6 } })
  const slow = mk({ usable: 3, metrics: { attempts: 6, successes: 6, successRate: 1, p50LatencyMs: 7000, samples: 6 } })
  const lowSr = mk({ usable: 3, metrics: { attempts: 6, successes: 1, successRate: 1 / 6, p50LatencyMs: 200, samples: 6 } })
  ok('只改 p50：慢的分数更低', Q.qualityScore(base).score > Q.qualityScore(slow).score)
  ok('只改成功率：低的分数更低', Q.qualityScore(base).score > Q.qualityScore(lowSr).score)
  const morePlats = mk({ usable: 5, metrics: { attempts: 6, successes: 6, successRate: 1, p50LatencyMs: 200, samples: 6 } })
  ok('只改平台数：多的分数更高', Q.qualityScore(morePlats).score > Q.qualityScore(base).score)
}

console.log('=== F. 快速模式「未测 ≠ 不可用」与旧分层兼容 ===')
{
  const quick = mk({ usable: 1, untested: 4, noMetrics: true })
  const qs = Q.qualityScore(quick)
  ok('无 metrics 的深检结果不产生成功率/延迟证据', qs.parts.success.valid === false && qs.parts.latency.valid === false)
  ok('快速模式 1 可用 vs 全测 1 可用不因「未测 4 个」误判更优', Q.compareQuality(quick, mk({ usable: 1 })) === 0)
  const a = mk({ usable: 4, noMetrics: true }), b = mk({ usable: 2, noMetrics: true })
  ok('两侧都无综合分时回落硬判据（平台数）', Q.compareQuality(a, b) === 1)
  ok('describeQuality 明确写出「证据不足」', /证据不足/.test(Q.describeQuality({ supportedSources: ['wy'] })))
}

console.log('=== G. 设置项透传 ===')
{
  const cfg = { qualityWeights: { platforms: 0.7, success: 0.1, latency: 0.1, quality: 0.1 }, qualityMinSamples: 5, qualityScoreMargin: 0.2 }
  const o = Q.optsFromConfig(cfg)
  ok('config 权重生效并归一化', Math.abs(o.weights.platforms - 0.7) < 1e-9)
  ok('minSamples / margin 透传', o.minSamples === 5 && o.scoreMargin === 0.2)
  ok('空 config 走默认', Q.optsFromConfig({}).minSamples === Q.DEFAULT_OPTS.minSamples)
}

console.log('=== H. 生产路径回归：optsFromConfig 不能用 undefined 毁掉默认值（22:21 审计根因） ===')
{
  // 旧 bug：optsFromConfig({}) 把 minCoverage/scoreMargin/latencyCapMs 传成 undefined，
  // Object.assign 覆盖 DEFAULT_OPTS 后被 `||` 兜底改成 0 / 0 / 8000，
  // 于是「服务端只有声明值」也能算出综合分并参与删源。单测若只测不传 opts 的路径就全绿。
  const o = Q.optsFromConfig({})
  ok('部分 config 下 minCoverage 仍为 0.5', o.minCoverage === 0.5, 'got ' + o.minCoverage)
  ok('部分 config 下 scoreMargin 仍为 0.08', o.scoreMargin === 0.08, 'got ' + o.scoreMargin)
  ok('部分 config 下 latencyCapMs 仍为 3000', o.latencyCapMs === 3000, 'got ' + o.latencyCapMs)
  ok('部分 config 下 minSamples 仍为 3', o.minSamples === 3)
  const srv = { supportedSources: ['wy', 'tx', 'kw'] }
  ok('生产 opts 下服务端声明条目判证据不足（score=null）', Q.qualityScore(srv, o).score === null)
  ok('生产 opts 下微小分差仍判平手', Q.compareQuality(mk({ usable: 4, metrics: { p50LatencyMs: 1000 } }), mk({ usable: 4, metrics: { p50LatencyMs: 1050 } }), o) === 0)
  ok('显式 scoreMargin=0 仍可覆盖（0 是合法值）', Q.optsFromConfig({ qualityScoreMargin: 0 }).scoreMargin === 0)
  ok('weights 传字符串不会污染权重键', Object.keys(Q.optsFromConfig({ qualityWeights: 'oops' }).weights).length === 4)
  ok('只给 playableRate 时不会被算成可播 0 次', Q.qualityScore({
    deep: { checkedAt: 1, platforms: { wy: { status: 'usable' } }, metrics: { attempts: 6, successes: 6, playableRate: 0.5, p50LatencyMs: 200, samples: 6, qualityDeclared: ['320k'] } }
  }).parts.success.raw > 0.5)
}

console.log('=== I. 三条裁决在生产 opts 下的护栏 ===')
{
  const H = new Hunter({ config: {} }, () => {})
  const srv = { id: 'Demo Source v1.0.js', name: 'Demo Source v1.0', supportedSources: ['wy', 'tx', 'kw'], version: '1.0', repository: 'https://github.com/bbb/demo' }
  const quick = {
    id: 'c1', scriptName: 'Demo Source v1.0', lxName: 'Demo Source v1.0', name: 'Demo Source v1.0',
    repository: 'https://github.com/aaa/demo',
    deep: {
      checkedAt: Date.now(),
      platforms: { wy: { status: 'usable', verified: true }, tx: { status: 'untested' }, kw: { status: 'untested' }, kg: { status: 'untested' }, mg: { status: 'untested' } },
      metrics: { attempts: 2, successes: 2, playable: 2, p50LatencyMs: 150, samples: 2, qualityUsed: ['320k'], qualityDeclared: ['320k'] }
    }
  }
  const v = H.sameNameVerdict(quick, srv, '/* code */', {})
  ok('跨仓库 + 快速模式未实测 → rename 改名并存（绝不删任何一方）', v.act === 'rename', v.act + ' | ' + v.why)
  ok('理由明确提示全平台检测', /全平台/.test(v.why))

  const full = Object.assign({}, quick, { deep: Object.assign({}, quick.deep, {
    platforms: { wy: { status: 'usable', verified: true }, tx: { status: 'usable', verified: true }, kw: { status: 'failed' }, kg: { status: 'failed' }, mg: { status: 'skipped' } },
    metrics: { attempts: 6, successes: 6, playable: 6, p50LatencyMs: 200, samples: 6, qualityUsed: ['320k'], qualityDeclared: ['320k'] }
  }) })
  const v2 = H.sameNameVerdict(full, srv, '/* code */', {})
  ok('全平台实测（skipped 不算缺证据）→ 进入质量裁决而非被未测护栏挡下', v2.act !== 'rename', v2.act + ' | ' + v2.why)
  ok('服务端只有声明值时保守不删（skip 或平手改名，绝不 replace）', v2.act !== 'replace', v2.act + ' | ' + v2.why)

  const cross = U.pairSources(
    [{ id: 'Demo Source v1.0.js', name: 'Demo Source v1.0', version: '1.0', repository: 'https://github.com/aaa/demo', supportedSources: ['wy', 'tx'], enabled: true }],
    [{ id: 'c1', name: 'Demo Source v1.0', scriptName: 'Demo Source v1.0', scriptVersion: '1.0', repository: 'https://github.com/ccc/demo', deep: full.deep }],
    {}
  )[0]
  ok('跨仓库巡检不再被 fewer-platforms 提前拦死', cross.evidence.quality !== undefined, cross.evidence.via + ' | ' + cross.reason.slice(0, 80))
  ok('跨仓库巡检如实标记 layered-fallback', cross.evidence.quality && cross.evidence.quality.mode === 'layered-fallback')
}

console.log('\nRESULT ' + pass + ' PASS / ' + fail + ' FAIL')
if (fail) process.exit(1)
