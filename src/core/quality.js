'use strict'
/**
 * 同名音源「留优删差」判据
 *
 * 2026-11-10 23:28 用户口径（这一版据此重写）：
 *   「lx-hunter 是采集音源的容器，本身能正确检验音源能用就 ok，对于同名类的音源才需要打分检测」
 *   ⇒ 检测层只回答「能不能用」；比较层只在**同名冲突**时回答「留哪个」。
 *   所以这里不提供「综合质量分」，只提供**同名两项之间的优劣裁决**。
 *
 * === 为什么是字典序，不是加权求和 ===
 * 上一版用「平台数 0.35 + 成功率 0.25 + p50 0.25 + 音质档 0.15」加权求和，问题有三：
 *  1. **维度可互相补偿**：少 1 个可用平台（该平台所有歌都取不到链，是「质」的损失）
 *     可以被「延迟快 200ms」抵消，算出更高分后去删掉更可用的源 —— 这是错的。
 *  2. **权重没有客观依据**：按区分度（标准差）定权重只是把拍脑袋换成另一种拍脑袋，
 *     且权重一变，历史裁决全部翻案，无法复盘。
 *  3. **分差噪声带是补丁**：先加权求和再拿 0.08 当噪声带，本质是掩盖「分不可比」。
 * 字典序把「先比什么」显式写死：平台数不同就到此为止，根本不需要延迟/音质参与，
 * 既不会被补偿，也没有权重可调，每一条裁决都能一句话解释清楚。
 * 比较顺序（用户 2026-11-10 23:31 定）：
 *   ① 可用平台数  ② p50 延迟（噪声带 300ms）  ③ 最高可播音质档  ④ 全相同 = 平手不删
 *   注意：② ③ 的数据**只在「深度检测（打分）」里才作数**（metrics.depth==='full'）。
 *   初筛（快速模式）只回答「有没有可用平台」，不打分 —— 它的 p50 只来自 1 次请求。
 *   ③ 的数据**只在同名冲突、①②都打平时专项补测才产生**（qualityMax）。
 *   采集阶段按用户口径「全面检测不测音质」不产出该字段，故常规情况下比较到 ② 或 ③ 即平手不删。
 *
 * === 证据规则（沿用前几轮已确认的护栏）===
 *  - 声明值不能当实测证据：服务端 list 只有 supportedSources 声明值、没有正文/hash/metrics，
 *    因此它「无法与本地实测值比较」→ 判证据不足，不删任何一方。
 *  - 未测 ≠ 不可用：untested/pending 只是没测，不参与「平台更少」的判定。
 *  - 平手一律不动。删源不可逆，含糊就不删。
 */

/** 延迟噪声带：差值小于该值视为同档（17952 四轮 A/B：p50 200~264ms、p90 447~596ms，属网络抖动）。 */
const LATENCY_MARGIN_MS = 300

/** 音质档 → 能力分。命中顺序即优先级；自定义档位给保底分。 */
const TIERS = [
  [/hires|hi-?res|dsd|dolby|atmos|master|jymaster|sq|无损|母带/i, 1.00],
  [/flac|ape|wav|96k|192k|lossless|24bit/i, 0.85],
  [/320k|320|exhigh|极高/i, 0.70],
  [/192k|192|high|高品/i, 0.55],
  [/128k|128|standard|标准/i, 0.40]
]

function tierScore(q) {
  const s = String(q || '').trim()
  if (!s) return null
  for (const [re, v] of TIERS) if (re.test(s)) return { score: v, label: s, known: true }
  return { score: 0.30, label: s, known: false }
}

function bestTier(list) {
  // 兼容两种形态：聚合后的数组（deep.metrics.qualityMax）与单值字符串（专项补测写入）。
  // 旧实现只接受数组，导致「补测拿到 flac」写进去也读不出来，第三层永远是死代码。
  const arr = Array.isArray(list) ? list : (list ? [list] : [])
  let best = null
  for (const q of arr) {
    const t = tierScore(q)
    if (t && (!best || t.score > best.score)) best = t
  }
  return best
}

/**
 * 提取「可比三元组」。
 * declared=true 表示该侧**没有任何实测证据**，只有脚本自己写的声明值 —— 此时
 * usable/tier/p50 都不能拿去与别人的实测值比大小。
 */
function profile(entry) {
  const e = entry || {}
  const deep = e.deep || null
  const plats = deep && deep.platforms ? deep.platforms : null
  const metrics = (deep && deep.metrics) || e.metrics || null

  // 空平台集＝一个平台都没测过（脚本未注册平台 / 深检中断），不是「0 个可用」。
  // 若当成 0 去参与裁决，会把一个完好的服务端源判劣删掉 —— 未测永远不等于不可用。
  if (!plats || !Object.keys(plats).length) {
    const arr = Array.isArray(e.supportedSources) ? e.supportedSources : []
    return {
      usable: arr.length, verified: null, tested: null, untested: null, skipped: null,
      tier: null, tierLabel: '', p50: null, declared: true, scored: false, metrics,
      checkedAt: 0
    }
  }

  let usable = 0, verified = 0, tested = 0, untested = 0, skipped = 0
  for (const p of Object.values(plats)) {
    const o = p || {}
    const st = String(o.status || '')
    if (st === 'usable' || st === 'ok' || st === 'passed' || o.ok === true || o.pass === true) {
      usable++
      tested++
      // verified 只认「真把音频拉下来过」（魔数/content-type 校验通过），
      // 「已解析链接但本机没校验」不算 —— 这是 lx-music 播放侧的已知坑。
      if (o.verified === true) verified++
    } else if (st === 'untested' || st === 'pending') {
      untested++
    } else if (st === 'skipped') {
      // skipped = 脚本压根没注册该平台（已知事实），不是「没测过」的证据缺口。
      skipped++
    } else if (st === 'failed') {
      tested++
    }
  }

  // 「有没有打分」的唯一判据：这次检测是不是**深度检测（全平台真取链）**。
  // 2026-11-10 00:1x 用户口径：初筛（快速模式）只回答「有没有可用平台」，不打分；
  // 只有用户主动跑「深度检测（打分）」才产出可用于排序/比较的数据。
  // 没有 depth 标记的老记录（升级前的快速模式产物）一律视为「未打分」——
  // 它们同样只有 1 个平台样本，拿它的 p50 排序等于用一个样本冒充能力。
  // 2026-11-11 修正（P-1411 P1-3）：深检但 0 样本（平台集为空 / 全部 skipped，
  // 实测「野草音源」就是 depth=full + samples=0 + p50=null）不算「已打分」——
  // 拿一个空样本冒充能力，和初筛只有一个样本本质相同。
  // 只把「显式 0 样本」降级；老记录没有 samples 字段时保持原口径（不让升级把历史全翻案）。
  const zeroSamples = !!(metrics && Number(metrics.samples) === 0)
  const scored = !!(metrics && metrics.depth === 'full' && !zeroSamples)

  // 最高可播档位：**只认 qualityMax**（同名冲突时的专项补测产物）。
  // 绝不用 qualityUsed 兜底 —— 它是「脚本声明的档位顺序里第一个成功的那个」，
  // 取决于作者把 128k 还是 flac 写在前面，不代表真实能力：
  // 一个 qualitys 写 [128k, flac] 的强源会记成 128k，与真正的 128k 源同档，
  // 拿它做第三层裁决等于按作者的书写顺序删源。
  // 采集阶段（含全平台深检）按用户 2026-11-10 口径「全面检测不测音质」，不产出该字段，
  // 所以没有补测记录时 tier=null → 第三层自动跳过、判平手不删。
  const tier = (scored && bestTier(metrics && metrics.qualityMax)) || null

  // p50 只在打分档里才作数：初筛模式下「1 次成功请求的耗时」不是能力指标。
  const p50 = scored && metrics && Number.isFinite(Number(metrics.p50LatencyMs)) && Number(metrics.p50LatencyMs) > 0
    ? Number(metrics.p50LatencyMs) : null

  return {
    usable, verified, tested, untested, skipped,
    tier: tier ? tier.score : null,
    tierLabel: tier ? tier.label : '',
    tierFromMax: !!(metrics && metrics.qualityMax && [].concat(metrics.qualityMax).length),
    p50,
    declared: false,
    scored,
    metrics,
    checkedAt: Number(deep.checkedAt) || 0
  }
}

/**
 * 「这一侧为什么不能打分」——给 compareVerdict 的 insufficient 理由用。
 * 区分两种缺口：只跑过初筛（quick，1 个样本）/ 深检跑过但一个样本都没产出（0 样本）。
 */
function unscoredReason(p) {
  const d = p && p.metrics && p.metrics.depth
  if (d === 'full') return '深度检测没有产出任何可用样本（0 样本），不能当质量证据'
  return '只做过初筛（没有延迟/音质证据，需深度检测才能比较）'
}

/**
 * 字典序比较。返回 { cmp, by, reason, a, b }
 *  cmp: 1 = a 更优，-1 = b 更优，0 = 平手或证据不足（调用方必须按「不删」处理）
 *  by : platforms | tier | latency | tie | insufficient
 */
function compareVerdict(a, b) {
  const pa = profile(a), pb = profile(b)
  const wrap = (o) => Object.assign(o, { aDesc: describeQuality(a), bDesc: describeQuality(b) })

  // 任一侧没有实测证据 → 不比较。声明值不能拿去压实测值。
  if (pa.declared || pb.declared) {
    return wrap({
      cmp: 0, by: 'insufficient',
      reason: (pa.declared ? 'A' : 'B') + ' 侧无实测证据（只有声明值），不能与实测值比优劣',
      a: pa, b: pb
    })
  }

  // ① 可用平台数：硬门槛。少一个平台 = 该平台所有歌曲都取不到链，
  //    这是「质」的损失，不允许被音质或延迟补偿。
  if (pa.usable !== pb.usable) {
    const win = pa.usable > pb.usable ? 'A' : 'B'
    return wrap({
      cmp: pa.usable > pb.usable ? 1 : -1, by: 'platforms',
      reason: `可用平台数 ${pa.usable} vs ${pb.usable} → ${win} 侧更多`,
      a: pa, b: pb
    })
  }

  // ①.5) 没有打分档的一侧不参与第二、三层（2026-11-11，P-1411 P1-2）。
  // 原实现会让「本地只跑过初筛」一路走到最后，返回 `by:'tie'`（理由「平台数同为 N → 平手」）——
  // 把「没测过」写成「打平了」。跨仓库分支要求「质量必须更优」才替换，于是本地新版永远灌不进，
  // 而用户看到的理由是「质量平手」，完全误导。这里显式判证据不足，文案指明该去补跑深检。
  if (!pa.scored || !pb.scored) {
    const bad = []
    if (!pa.scored) bad.push('A 侧' + unscoredReason(pa))
    if (!pb.scored) bad.push('B 侧' + unscoredReason(pb))
    return wrap({
      cmp: 0, by: 'insufficient',
      reason: bad.join('，') + ' → 未比较延迟/音质（先做深度检测再裁决）',
      a: pa, b: pb
    })
  }

  // ② p50 延迟：平台数相同才看这个。延迟是每次播放都要付的体验成本，
  //    优先级高于音质档（用户 2026-11-10 23:31 明确：平台数 → 延迟 → 音质档）。
  //    差距按 A/B 实测噪声带处理 —— 17952 四轮数据 p50 200~264ms、p90 447~596ms，
  //    同档源之间差 300ms 以内属于网络抖动，不能据此删源。
  if (pa.p50 !== null && pb.p50 !== null && Math.abs(pa.p50 - pb.p50) >= LATENCY_MARGIN_MS) {
    const win = pa.p50 < pb.p50 ? 'A' : 'B'
    return wrap({
      cmp: pa.p50 < pb.p50 ? 1 : -1, by: 'latency',
      reason: `p50 ${pa.p50}ms vs ${pb.p50}ms → ${win} 侧更快（差 ${Math.abs(pa.p50 - pb.p50)}ms ≥ ${LATENCY_MARGIN_MS}ms）`,
      a: pa, b: pb
    })
  }

  // ③ 最高可播音质档：平台数与延迟都相同才看这个。
  if (pa.tier !== null && pb.tier !== null && Math.abs(pa.tier - pb.tier) > 1e-9) {
    const win = pa.tier > pb.tier ? 'A' : 'B'
    return wrap({
      cmp: pa.tier > pb.tier ? 1 : -1, by: 'tier',
      reason: `最高可播档位 ${pa.tierLabel || '?'} vs ${pb.tierLabel || '?'} → ${win} 侧更高`,
      a: pa, b: pb
    })
  }

  return wrap({
    cmp: 0, by: 'tie',
    reason: `平台数同为 ${pa.usable}` +
      (pa.p50 !== null ? `、p50 ${pa.p50}/${pb.p50}ms 差在噪声带内` : '') +
      (pa.tier !== null ? `、档位 ${pa.tierLabel || '?'}` : '') + ' → 平手，不删任何一方',
    a: pa, b: pb
  })
}

function compareQuality(a, b) {
  return compareVerdict(a, b).cmp
}

function isClearlyBetter(a, b) {
  return compareVerdict(a, b).cmp > 0
}

/**
 * 排序视图专用：显式排序键（**不含噪声带**）。
 *
 * 为什么不能拿 compareVerdict 当 sort comparator：噪声带会让
 * 「a≈b（差 200ms）、b≈c（差 200ms）」两个都判平手，而 a 与 c 差 400ms 又按延迟/档位分出胜负，
 * 一旦第三层（音质档）介入就会出现 a>b>c>a 的循环 → sort 结果依赖初始顺序，表每刷一次顺序就变。
 * 所以分工写死：
 *   - **删不删**（二元裁决）→ compareVerdict：带噪声带，宁可判平手也不删；
 *   - **谁排前面**（全库排序）→ sortKey：完整字典序元组，天然全序、可复现。
 * 两者维度顺序一致（平台数 → p50 → 档位），所以排序结果与裁决方向不会互相打脸。
 */
function sortKey(entry) {
  const p = profile(entry)
  return [
    -p.usable,                                        // 平台数多的在前
    p.p50 === null ? Number.MAX_SAFE_INTEGER : p.p50,  // 没有延迟证据的排在实测之后
    p.tier === null ? -1 : -p.tier                    // 档位高的在前（取负统一成「小者优先」）
  ]
}

function compareSortKey(a, b) {
  const ka = sortKey(a), kb = sortKey(b)
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1
  return 0
}

/** 给报告/日志用的一句话描述。 */
function describeQuality(entry) {
  const p = profile(entry)
  if (p.declared) return `仅声明支持 ${p.usable} 个平台（无实测证据，不参与优劣裁决）`
  const parts = [`实测可用 ${p.usable} 个平台`]
  if (!p.scored) parts.push('未打分（初筛模式，需跑深度检测才能比较延迟/音质）')
  if (p.verified !== null && p.verified > 0) parts.push(`真校验 ${p.verified} 个`)
  if (p.tierLabel) parts.push(`最高可播 ${p.tierLabel}`)
  if (p.p50 !== null) parts.push(`p50 ${p.p50}ms`)
  if (p.untested > 0) parts.push(`未测 ${p.untested} 个`)
  return parts.join(' / ')
}

module.exports = {
  profile, tierScore, bestTier,
  compareVerdict, compareQuality, isClearlyBetter, describeQuality,
  sortKey, compareSortKey,
  LATENCY_MARGIN_MS
}
