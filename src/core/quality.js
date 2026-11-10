'use strict'
/**
 * 「质量更优」判据（2026-11-10 两轮拍板）
 *
 * 21:01 第一轮：把判据从「只有 usableCount 一个数」写成可测、可解释的分层
 *   （usable > verified > tested），并明确「证据不对称」时绝不擅自删。
 * 22:0x 第二轮（用户追加）：给公共音源做**综合性检测**，按
 *   「平台数 - 取链成功率 - p50 延迟 - 音质档」不同权重算综合分，选分高者为「质量更优」。
 *
 * === 科学性原则（改动前先读，别把评分写成拍脑袋） ===
 * 1. **每个维度都要有原始样本**。成功率的分母是真实发出的取链请求数（deep.metrics.attempts），
 *    不是平台数；p50 来自真实耗时数组。没有样本就是 UNKNOWN，不能填 0 也不能填猜测值。
 * 2. **缺证据的维度不参与加权**，按剩余有效权重重归一化；有效权重低于 minCoverage
 *    直接判 score=null（证据不足），绝不因为「有分」就比「没分」的更优。
 *    服务端 list 只有 supportedSources 声明值、没有 deep/metrics/hash/正文，
 *    因此它最多拿到「平台数」一个弱维度 → 必然判证据不足 → 平手不删。
 * 3. **分差阈值**：score 差在 scoreMargin 以内一律平手。评分是估计量，0.001 分差
 *    不构成删除一个可用音源的理由。
 * 4. **声明值打折**：声明平台数 w 折半、声明音质档 raw×0.9，实测成功档位优先。
 *    声明值来自脚本自己写的数组，天然虚高，不能与实测值等权。
 * 5. **回落分层**：任一侧证据不足时，退回 usable > verified > tested 的硬判据，
 *    且「未测」不等于「不可用」（沿用 S4 口径）。
 *
 * 返回：>0 a 更优，<0 b 更优，0 平手或证据不足。平手一律不动。
 */
const UNKNOWN = -1
const PLATFORM_COUNT = 5 // wy/tx/kw/kg/mg

/** 音质档 → 能力分。命中顺序即优先级；自定义档位给保底分但标记 unknownTier。 */
const TIERS = [
  [/hires|hi-?res|dsd|dolby|atmos|master|jymaster|sq|无损|母带/i, 1.00],
  [/flac|ape|wav|96k|192k|lossless/i, 0.85],
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
  let best = null
  for (const q of (Array.isArray(list) ? list : [])) {
    const t = tierScore(q)
    if (t && (!best || t.score > best.score)) best = t
  }
  return best
}

const DEFAULT_WEIGHTS = { platforms: 0.40, success: 0.25, latency: 0.15, quality: 0.20 }
const DEFAULT_OPTS = {
  weights: DEFAULT_WEIGHTS,
  minSamples: 3,        // 少于 3 个请求样本，成功率/p50 不作为证据
  // 依据 lx-music 17952 A/B 四轮实测：取链 p50 200~264ms、p90 447~596ms、
  // max 可达 12s 但 >8s 仅 1/800 周期。取 p90 的约 5 倍作上限，
  // 让 200ms 与 1000ms 能拉开差距；用 8000ms 会让所有源都接近满分、失去区分度。
  latencyCapMs: 3000,
  scoreMargin: 0.08,    // 分差噪声带
  minCoverage: 0.5      // 有效权重低于此判证据不足
}

function resolveOpts(opts) {
  const src = opts || {}
  // 关键（22:21 审计）：**undefined 不能覆盖默认值**。
  // 旧写法 Object.assign({}, DEFAULT_OPTS, src) 会把 optsFromConfig 里没设置的
  // minCoverage/scoreMargin/latencyCapMs 覆盖成 undefined，再被下面的 `|| 兜底`
  // 改成 0 / 0 / 8000 —— 于是生产路径下「覆盖度门槛」「分差噪声带」全部失效，
  // 服务端只有声明值也算得出综合分并参与删源，而单测（不传 opts）却全绿。
  // 现在：只接受「显式提供且是有限数字」的覆盖，其余一律保留 DEFAULT_OPTS。
  const o = Object.assign({}, DEFAULT_OPTS)
  for (const k of ['minSamples', 'latencyCapMs', 'scoreMargin', 'minCoverage']) {
    if (src[k] === undefined || src[k] === null || src[k] === '') continue
    const v = Number(src[k])
    if (Number.isFinite(v)) o[k] = v
  }
  const rawW = (src.weights && typeof src.weights === 'object' && !Array.isArray(src.weights)) ? src.weights : {}
  const w = Object.assign({}, DEFAULT_WEIGHTS, rawW)
  // 只接受有限非负权重；全 0 时退回默认，避免除零把所有条目判成一样
  let sum = 0
  for (const k of Object.keys(DEFAULT_WEIGHTS)) {
    const v = Number(w[k])
    w[k] = Number.isFinite(v) && v >= 0 ? v : DEFAULT_WEIGHTS[k]
    sum += w[k]
  }
  if (sum <= 0) return resolveOpts({})
  for (const k of Object.keys(DEFAULT_WEIGHTS)) w[k] = w[k] / sum
  o.weights = w
  o.minSamples = Math.max(1, o.minSamples)
  o.latencyCapMs = Math.max(500, o.latencyCapMs)
  o.scoreMargin = Math.max(0, Math.min(0.5, o.scoreMargin))
  o.minCoverage = Math.max(0, Math.min(1, o.minCoverage))
  return o
}

/** 把 store.config 的扁平设置项转成 opts（缺项走默认）。 */
function optsFromConfig(cfg) {
  const c = cfg || {}
  return resolveOpts({
    weights: c.qualityWeights,
    minSamples: c.qualityMinSamples,
    latencyCapMs: c.qualityLatencyCapMs,
    scoreMargin: c.qualityScoreMargin,
    minCoverage: c.qualityMinCoverage
  })
}

function qualityProfile(entry) {
  const e = entry || {}
  // 已是 profile 对象则原样返回（外部可直接传 qualityProfile 的结果）。
  // 真实条目虽有 e.usable 布尔，但不会同时有 verified 字段，故不会误命中。
  if (e.usable !== undefined && e.verified !== undefined) return e
  const deep = e.deep || null
  const plats = deep && deep.platforms ? deep.platforms : null
  const metrics = (deep && deep.metrics) || e.metrics || null
  if (!plats) {
    const arr = Array.isArray(e.supportedSources) ? e.supportedSources : []
    return {
      usable: arr.length, verified: UNKNOWN, tested: UNKNOWN, untested: UNKNOWN,
      checkedAt: 0, declared: true, metrics, __profile: true
    }
  }
  let usable = 0, verified = 0, tested = 0, untested = 0
  for (const p of Object.values(plats)) {
    const o = p || {}
    const st = String(o.status || '')
    if (st === 'usable' || st === 'ok' || st === 'passed' || o.ok === true || o.pass === true) {
      usable++
      tested++
      if (o.verified === true) verified++
    } else if (st === 'untested' || st === 'skipped' || st === 'pending') untested++
    else if (st === 'failed') tested++
  }
  return { usable, verified, tested, untested, checkedAt: Number(deep.checkedAt) || 0, declared: false, metrics, __profile: true }
}

const clamp01 = x => Math.max(0, Math.min(1, Number(x) || 0))

/**
 * 综合评分。返回 { score|null, coverage, parts, reasons, unknown }。
 * score=null 表示证据不足，调用方必须判平手，不得当成 0 分。
 */
function qualityScore(entry, opts) {
  const o = resolveOpts(opts)
  const p = qualityProfile(entry)
  const m = p.metrics || {}
  const w = o.weights
  const parts = {}
  const reasons = []

  // ① 平台数：实测 usable 用满权重；服务端声明值折半（弱证据）
  const platformRaw = clamp01(p.usable / PLATFORM_COUNT)
  parts.platforms = {
    raw: platformRaw, w: p.declared ? w.platforms * 0.5 : w.platforms,
    valid: true, weak: !!p.declared,
    detail: p.declared ? `声明 ${p.usable} 个平台（弱证据）` : `实测可用 ${p.usable} 个平台`
  }

  // ② 取链成功率：必须有足够请求样本。
  //    lx-music 播放侧经验（A/B 四轮 + P-1387）：「脚本返回了 http 链接」不等于「能播」，
  //    已知噪声带有 HEAD 校验重定向失败 / content-type 非音频 / 试听片段拒绝 /
  //    1500ms·3000ms 超时；但 verifyUrl 失败也可能只是本机代理/CDN 403，不代表源坏。
  //    因此用 0.7×可播率 + 0.3×链接率 折中，既不把假可播当满分，也不因本机网络全盘否定。
  //    旧数据没有 playable 字段时退回原来的链接率，保持向后兼容。
  const attempts = Number(m.attempts) || 0
  const successes = Number(m.successes) || 0
  const hasPlayable = m.playable !== undefined || m.playableRate !== undefined
  // 兼容只落 playableRate（没有逐次计数）的历史/外部数据：按 attempts 反推个数，
  // 绝不把「有比率」当成「可播 0 次」。
  const playable = m.playable !== undefined && m.playable !== null
    ? Number(m.playable)
    : (typeof m.playableRate === 'number' ? m.playableRate * attempts : 0)
  const linkRate = attempts > 0 ? successes / attempts : (typeof m.successRate === 'number' ? m.successRate : null)
  const sr = hasPlayable && linkRate !== null
    ? 0.7 * (playable / attempts) + 0.3 * linkRate
    : linkRate
  const srOk = !p.declared && sr !== null && attempts >= o.minSamples
  parts.success = {
    raw: srOk ? clamp01(sr) : null, w: w.success, valid: srOk,
    detail: srOk
      ? (hasPlayable
          ? `取链 可播 ${Number(playable).toFixed(0)}/${attempts}、链接 ${successes}/${attempts} → ${(sr * 100).toFixed(0)}%`
          : `取链链接 ${successes}/${attempts} = ${(sr * 100).toFixed(0)}%（旧数据无可播计数）`)
      : `样本不足（${attempts}/${o.minSamples}）`
  }
  if (!srOk) reasons.push('取链成功率：样本不足')

  // ③ p50 延迟：只认成功请求耗时数组聚合出的 p50
  const p50 = Number(m.p50LatencyMs)
  const latOk = !p.declared && Number.isFinite(p50) && p50 > 0 && Number(m.samples || 0) >= o.minSamples
  parts.latency = {
    raw: latOk ? clamp01(1 - p50 / o.latencyCapMs) : null, w: w.latency, valid: latOk,
    detail: latOk ? `p50 ${p50}ms（上限 ${o.latencyCapMs}ms）` : '无延迟样本'
  }
  if (!latOk) reasons.push('p50 延迟：无样本')

  // ④ 音质档：实测成功档位优先；只有声明时打 7 折。
  //    lx-music 实测过「脚本声明 flac 但取链全败、只能靠服务端兜底解密」，
  //    声明档位天然虚高，尤其是从未成功取到任何档位时，折扣必须更重。
  const used = bestTier(Array.isArray(m.qualityUsed) ? m.qualityUsed : (m.qualityUsed ? [m.qualityUsed] : []))
  const declared = bestTier(m.qualityDeclared)
  const qScore = used ? used.score : (declared ? declared.score * 0.7 : null)
  parts.quality = {
    raw: qScore === null ? null : clamp01(qScore), w: w.quality, valid: qScore !== null,
    weak: !used,
    detail: used ? `实测档位 ${used.label}` : (declared ? `仅声明 ${declared.label}（×0.7，未实测成功）` : '无音质档信息')
  }
  if (qScore === null) reasons.push('音质档：无信息')

  let effective = 0, weighted = 0
  for (const k of Object.keys(parts)) {
    const d = parts[k]
    if (!d.valid || d.raw === null) continue
    effective += d.w
    weighted += d.raw * d.w
  }
  const coverage = clamp01(effective) // 总权重已归一化为 1
  const unknown = coverage < o.minCoverage
  return {
    score: unknown || effective <= 0 ? null : weighted / effective,
    coverage, parts, reasons, unknown,
    weights: w, opts: o
  }
}

/** 硬判据回落：只在两侧证据不对称或综合分都不可用时用，且「未测 ≠ 不可用」。 */
function layeredCompare(a, b) {
  const pa = qualityProfile(a), pb = qualityProfile(b)
  if (pa.usable !== pb.usable) return pa.usable > pb.usable ? 1 : -1
  if (pa.verified !== UNKNOWN && pb.verified !== UNKNOWN && pa.verified !== pb.verified) {
    return pa.verified > pb.verified ? 1 : -1
  }
  // tested 只代表「证据覆盖度」，不是质量优势：一个源测了 5 个平台全挂，
  // 不比另一个只测 1 个但确实可用的更优。过去拿它当次级判据会误删好源，
  // 因此这里一律判平手，交给「平手不删」兜底。
  return 0
}

/**
 * 比较入口（保持旧签名兼容）：两侧都有综合分时按分差+噪声带裁决；
 * 任一侧证据不足则回落分层硬判据，绝不因为「一侧有分」就判它赢。
 */
function compareQuality(a, b, opts) {
  const o = resolveOpts(opts)
  const sa = qualityScore(a, o), sb = qualityScore(b, o)
  if (sa.score !== null && sb.score !== null) {
    const d = sa.score - sb.score
    if (Math.abs(d) <= o.scoreMargin) return 0
    return d > 0 ? 1 : -1
  }
  return layeredCompare(a, b)
}

function isClearlyBetter(a, b, opts) {
  return compareQuality(a, b, opts) > 0
}

/** 给报告/日志用的可解释输出。 */
function describeQuality(entry, opts) {
  const p = qualityProfile(entry)
  const s = qualityScore(entry, opts)
  const base = p.declared
    ? `声明 ${p.usable} 个支持平台（无实测证据）`
    : `实测可用 ${p.usable} 个平台` +
      (p.verified >= 0 ? ` / 真校验通过 ${p.verified} 个` : '') +
      (p.tested >= 0 ? ` / 已测 ${p.tested} 个` : '') +
      (p.untested > 0 ? ` / 未测 ${p.untested} 个` : '')
  if (s.score === null) return `${base}；综合分：证据不足（覆盖度 ${(s.coverage * 100).toFixed(0)}%）`
  const seg = Object.keys(s.parts).filter(k => s.parts[k].valid)
    .map(k => `${k} ${(s.parts[k].raw * 100).toFixed(0)}×${s.parts[k].w.toFixed(2)}`).join(' + ')
  return `${base}；综合分 ${s.score.toFixed(3)}（覆盖度 ${(s.coverage * 100).toFixed(0)}%｜${seg}）`
}

/** 裁决明细，供 17960 实机报告逐条打印，避免「按分拍脑袋」无法复盘。 */
function scoreVerdict(a, b, opts) {
  const o = resolveOpts(opts)
  const sa = qualityScore(a, o), sb = qualityScore(b, o)
  const cmp = compareQuality(a, b, o)
  return {
    cmp, margin: o.scoreMargin,
    a: { score: sa.score, coverage: sa.coverage, reasons: sa.reasons, desc: describeQuality(a, o) },
    b: { score: sb.score, coverage: sb.coverage, reasons: sb.reasons, desc: describeQuality(b, o) },
    mode: sa.score !== null && sb.score !== null ? 'composite' : 'layered-fallback'
  }
}

module.exports = {
  qualityProfile, qualityScore, compareQuality, isClearlyBetter, describeQuality,
  scoreVerdict, optsFromConfig, resolveOpts, tierScore, bestTier,
  DEFAULT_WEIGHTS, DEFAULT_OPTS, UNKNOWN
}
