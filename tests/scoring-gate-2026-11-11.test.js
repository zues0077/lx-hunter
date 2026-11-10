'use strict'
/**
 * 「初筛不打分 / 深度检测才打分」+ 同名冲突音质专项补测 回归
 * （2026-11-10 00:1x 用户口径定稿）
 *
 * 用户原话：
 *   「初筛可用音源的时候快速模式就够了」
 *   「初筛检测出来可用音源时不打分……只有用户深度检测这些可用音源时才进行打分」
 *   「同名冲突的音质专项补测——做」
 *
 * 本文件守四件事：
 *  1. 快速模式产出的 metrics 必须被标成 depth='quick'，且 quality 层不拿它当证据；
 *  2. 深度检测（full）才产出可比数据；老记录（无 depth）应按「未打分」处理；
 *  3. 初筛/巡检**必须清分**（不继承上一轮深度检测的分数）——
 *     2026-11-11 00:38 用户拍板：评分只是「刚测出来的参考排序」，不长期留存；
 *     巡检默认 12h 一次，继承旧分会出现「2 平台（今天）+ 300ms/5 次全成功（昨天）」
 *     这种自相矛盾的成绩，源已经坏了却还挂着高分排序；
 *  4. 同名冲突时若本地已打分、只缺音质档 → 触发补测；未打分的条目不允许补测。
 */
const assert = require('assert')
const C = require('../src/core/checker')
const Q = require('../src/core/quality')
const { Hunter } = require('../src/core/hunter')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')) }
}

const KEYS = ['wy', 'tx', 'kw', 'kg', 'mg']
/** 造一条实测条目：usable 个平台可用，其余 failed。depth 缺省 = 老记录（无标记）。 */
function mk(o) {
  const opt = o || {}
  const usable = opt.usable === undefined ? 3 : opt.usable
  const platforms = {}
  for (let i = 0; i < KEYS.length; i++) {
    platforms[KEYS[i]] = i < usable ? { status: 'usable', verified: true } : { status: 'failed' }
  }
  const deep = { checkedAt: opt.checkedAt || Date.now(), platforms }
  if (opt.metrics !== undefined) deep.metrics = opt.metrics
  return { deep }
}
const proto = Object.create(Hunter.prototype)

console.log('=== A. 采集层：quick / full 必须分开标记 ===')
{
  const plats = {
    wy: { status: 'usable', metrics: { attempts: 1, successes: 1, playable: 1, latencies: [180], attemptLatencies: [180] } },
    tx: { status: 'untested' }
  }
  const q = C.aggregateMetrics(plats, {}, 'quick')
  const f = C.aggregateMetrics(plats, {}, 'full')
  ok('快速模式聚合结果被标成 depth=quick', q.depth === 'quick', JSON.stringify(q.depth))
  ok('全平台检测聚合结果标成 depth=full', f.depth === 'full', JSON.stringify(f.depth))
  ok('不传 depth 时默认 quick（保守：宁可不打分）', C.aggregateMetrics(plats, {}).depth === 'quick')
  ok('两种模式算出的原始证据本身一致（depth 只是标签）', q.p50LatencyMs === f.p50LatencyMs)
}

console.log('=== B. quality：只有 full 才算「有分」 ===')
{
  const quick = mk({ usable: 1, metrics: { depth: 'quick', p50LatencyMs: 180 } })
  const full = mk({ usable: 1, metrics: { depth: 'full', p50LatencyMs: 180 } })
  const legacy = mk({ usable: 1, metrics: { p50LatencyMs: 180 } })
  ok('初筛 → scored=false', Q.profile(quick).scored === false)
  ok('初筛的 p50 不算证据（profile.p50=null）', Q.profile(quick).p50 === null, JSON.stringify(Q.profile(quick).p50))
  ok('深度检测 → scored=true 且 p50 可用', Q.profile(full).scored === true && Q.profile(full).p50 === 180)
  ok('老记录（无 depth）→ 视为未打分', Q.profile(legacy).scored === false && Q.profile(legacy).p50 === null)

  const a = mk({ usable: 3, metrics: { depth: 'quick', p50LatencyMs: 100 } })
  const b = mk({ usable: 3, metrics: { depth: 'quick', p50LatencyMs: 3000 } })
  ok('两个初筛结果之间不比延迟（判平手）', Q.compareVerdict(a, b).by === 'tie', Q.compareVerdict(a, b).by)

  const c = mk({ usable: 3, metrics: { depth: 'full', p50LatencyMs: 100 } })
  const d = mk({ usable: 3, metrics: { depth: 'full', p50LatencyMs: 3000 } })
  ok('两个深度检测结果之间才比延迟', Q.compareVerdict(c, d).by === 'latency')

  const e1 = mk({ usable: 4, metrics: { depth: 'full', p50LatencyMs: 2000 } })
  const e2 = mk({ usable: 4, metrics: { depth: 'quick', p50LatencyMs: 100 } })
  ok('平台数仍优先于「有没有打分」（初筛只是缺证据，不是更差）', Q.compareVerdict(e1, e2).by === 'tie' || Q.compareVerdict(e1, e2).by === 'platforms')

  ok('描述里明确写出「未打分」而不是假装有结论', /未打分/.test(Q.describeQuality(quick)), Q.describeQuality(quick))
  ok('音质档也只在打分档里才认（初筛写进来的 qualityMax 不算）', (() => {
    const x = mk({ usable: 4, metrics: { depth: 'quick', p50LatencyMs: 100, qualityMax: 'flac' } })
    const y = mk({ usable: 4, metrics: { depth: 'full', p50LatencyMs: 100, qualityMax: 'flac' } })
    return Q.profile(x).tier === null && Q.profile(y).tier !== null
  })())
}

console.log('=== C. 排序视图：未打分排在打分之后 ===')
{
  const scored = mk({ usable: 2, metrics: { depth: 'full', p50LatencyMs: 900 } })
  const unscored = mk({ usable: 2, metrics: { depth: 'quick', p50LatencyMs: 100 } })
  const order = [unscored, scored].sort(Q.compareSortKey)
  ok('同平台数时，已打分的排在未打分之前', order[0] === scored)
  ok('未打分的排序键 p50 位是 MAX（不参与比较）',
     Q.sortKey(unscored)[1] === Number.MAX_SAFE_INTEGER && Q.sortKey(scored)[1] === 900)
}

console.log('=== D. 初筛/巡检一律清分（不继承上一轮打分） ===')
{
  const S = require('../src/renderer/sorters.js')
  ok('Hunter 不再提供分数继承方法（防止旧行为被加回来）', typeof proto._keepScoredMetrics === 'undefined')

  // 场景：昨天深度检测 5 平台可用、p50=240ms；今天巡检只剩 2 平台可用。
  const prev = mk({ usable: 5, metrics: { depth: 'full', p50LatencyMs: 240, qualityMax: 'flac', samples: 8 } })
  const quick = mk({ usable: 2, metrics: { depth: 'quick', p50LatencyMs: 190, samples: 1 } })
  const entry = { deep: prev.deep }
  entry.deep = quick.deep          // 检测写回就是 e.deep = d，无任何继承
  const pr = Q.profile(entry)
  ok('巡检覆盖后回到「未打分」', pr.scored === false, JSON.stringify(pr))
  ok('旧 p50 不再参与计算', pr.p50 === null)
  ok('旧音质档不再参与计算', pr.tier === null)
  ok('平台数用本轮真实值（2 个，不是昨天的 5 个）', pr.usable === 2)
  ok('摘要显示「未打分」而不是昨天的 p50', /未打分/.test(S.qualityBriefHtml(entry)), S.qualityBriefHtml(entry))
  ok('排序沉到同平台数已打分的之后', Q.compareSortKey(entry, mk({ usable: 2, metrics: { depth: 'full', p50LatencyMs: 900 } })) > 0)

  // 巡检把源打成不可用（0 平台）时，也不能留下任何分数痕迹
  const dead = mk({ usable: 0, metrics: { depth: 'quick', p50LatencyMs: 120, samples: 1 } })
  const deadEntry = { deep: prev.deep }
  deadEntry.deep = dead.deep
  ok('打成不可用后 scored=false 且摘要为空', Q.profile(deadEntry).scored === false && S.qualityBriefHtml(deadEntry) === '')

  // 深度检测自己照常打分（清分只针对非 full 的检测）
  const full2 = mk({ usable: 5, metrics: { depth: 'full', p50LatencyMs: 120 } })
  ok('深度检测结果照常打分', Q.profile({ deep: full2.deep }).scored === true && Q.profile({ deep: full2.deep }).p50 === 120)
}

console.log('=== E. 服务端侧打分快照（同名比较的另一侧证据） ===')
{
  const h = Object.create(Hunter.prototype)
  h.store = { imported: {}, saveImported() {} }
  const svc = { type: 'lxserver', acct: { id: 'acc1', name: 'A' }, adapter: { baseUrl: () => 'http://x' } }
  const fullEntry = Object.assign({ id: 'e1', deep: mk({ usable: 4, metrics: { depth: 'full', p50LatencyMs: 240, qualityMax: 'flac', samples: 6 } }).deep }, {})
  h._markImported(fullEntry, svc, 'srv-1', '同名源', ['wy', 'tx'], true)
  const rec = h.store.imported.e1
  ok('灌入时把打分快照写进账本', !!(rec && rec.score && rec.score.metrics), JSON.stringify(rec && rec.score))
  ok('快照只记 full 档的结论', rec.score.metrics.depth === 'full' && rec.score.metrics.qualityMax === 'flac')

  const map = h._scoreByServerId('acc1', 'acc1')
  ok('按服务端 id 能取回快照（同名冲突时可回放成 qualityProxy）', !!map['srv-1'] && map['srv-1'].metrics.qualityMax === 'flac')
  ok('快照能直接构成 quality profile（不是死数据）', Q.profile({ deep: map['srv-1'] }).tier !== null)

  // 未打分的条目不得写快照（初筛的 1 样本没有任何比较价值）
  const h2 = Object.create(Hunter.prototype)
  h2.store = { imported: {}, saveImported() {} }
  h2._markImported({ id: 'e2', deep: mk({ usable: 1, metrics: { depth: 'quick', p50LatencyMs: 180 } }).deep }, svc, 'srv-2', '初筛源', [], false)
  ok('初筛结果不写打分快照', h2.store.imported.e2.score === null)

  // 过期快照不得当真（接口资质随时会变）
  h.store.imported.e1.score.at = Date.now() - 31 * 24 * 3600 * 1000
  const stale = h._scoreByServerId('acc1', 'acc1')
  ok('超过 30 天的快照标记 stale，不回放', stale['srv-1'] && stale['srv-1'].stale === true)
}

console.log('=== G. 补测的档位选择：只探最高两档，且从高到低 ===')
{
  ok('声明 4 档 → 只探最高两档（无损）', JSON.stringify(C.planTierProbe(['128k', '320k', 'flac', 'flac24bit']).sort()) ===
     JSON.stringify(['flac', 'flac24bit']), JSON.stringify(C.planTierProbe(['128k', '320k', 'flac', 'flac24bit'])))
  ok('声明顺序被打乱也不影响（不按作者书写顺序探测）', C.planTierProbe(['flac', '128k', '320k'])[0] === 'flac')
  ok('只有两档时全探，最高在前', JSON.stringify(C.planTierProbe(['128k', '320k'])) === JSON.stringify(['320k', '128k']))
  ok('只声明一档 → 就探这一档', JSON.stringify(C.planTierProbe(['128k'])) === JSON.stringify(['128k']))
  ok('没有声明档位 → 不探（返回空，不猜 128k/320k）', C.planTierProbe([]).length === 0)
  ok('未知档位排在已知档位之后（不给未知档优先权）', (() => {
    const r = C.planTierProbe(['zzz-custom', '128k'], 2)
    return r[0] === '128k'
  })(), JSON.stringify(C.planTierProbe(['zzz-custom', '128k'], 2)))
  ok('探测列表长度受 max 限制（默认 2）', C.planTierProbe(['128k', '320k', 'flac', 'flac24bit']).length === 2 &&
     C.planTierProbe(['128k', '320k', 'flac'], 1).length === 1)
}

console.log('=== F. 音质专项补测的触发条件 ===')
{
  // 无脚本正文 → 明确说明，而不是 silent 成功
  C.probeTopTier({ id: 'x' }, '', {}, {}).then(r => {
    ok('没有脚本正文时不补测，并给出原因', r.ok === false && /没有脚本正文/.test(r.reason), r.reason)

    // 未做深度检测的条目：不允许补测（连平台数都没测过，比音质是瞎比）
    const h = Object.create(Hunter.prototype)
    h.job = { cancel: false }        // cancelRequested 是 getter（读 job.cancel），不能直接赋值
    h.logged = []
    h.log = (msg) => h.logged.push(msg)
    const item = { e: { id: 'n1', deep: mk({ usable: 1, metrics: { depth: 'quick', p50LatencyMs: 100 } }).deep }, renameServer: { id: 's1', name: 'n1' }, baseName: 'n1', why: '平手' }
    const plan = { queue: [item] }
    return h._probeTierForConflicts([plan], { n1: '"dummy"' }, {}).then(() => {
      ok('未打分的条目不补测，只在理由里留痕', /未做深度检测/.test(item.why), item.why)
      ok('未打分条目不会被改成 replace/skip', !item.replaceServer && !item.skip)
      ok('没有脚本正文的条目不补测（codeCache 为空）', (() => {
        const h2 = Object.create(Hunter.prototype)
        h2.job = { cancel: false }
        h2.log = () => {}
        const it = { e: { id: 'n2', deep: mk({ usable: 4, metrics: { depth: 'full', p50LatencyMs: 100 } }).deep }, renameServer: { id: 's2' }, baseName: 'n2', why: '平手' }
        return h2._probeTierForConflicts([{ queue: [it] }], {}, {}).then(() =>
          !it.skip && !it.replaceServer && /没有脚本正文/.test(it.why))
      })())
      ok('没有 renameServer 的条目完全不进入补测流程', (() => {
        const h3 = Object.create(Hunter.prototype)
        h3.job = { cancel: false }
        h3.log = () => {}
        const it = { e: { id: 'n3' }, baseName: 'n3', why: 'w' }
        return h3._probeTierForConflicts([{ queue: [it] }], {}, {}).then(() => it.why === 'w')
      })())
    })
  }).then(() => {
    console.log('')
    console.log(`RESULT ${pass} PASS / ${fail} FAIL`)
    if (fail) process.exitCode = 1
  }).catch(e => {
    console.error('测试自身异常:', e && e.stack || e)
    process.exitCode = 1
  })
}
