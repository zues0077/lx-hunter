'use strict'
/**
 * 音源库表格排序（v1.7.3）—— 纯函数，渲染进程（window.LXSort）与 Node 单测共用。
 *
 * 表头四列可排序：音源（名称）/ 平台可用性 / 来源仓库 / 状态，点击表头切换，再点反向。
 * 状态排序口径与状态徽章（statusCell）一致，并把「已灌入」排到最后：
 * 配合工具栏「只选未灌入」按钮，实现「排除已灌入、只勾选未灌入部分灌入」。
 */
;(function (root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.LXSort = api
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const SORT_KEYS = ['name', 'plat', 'repo', 'status']

  /** 已下载检测过、但内容不是洛雪音源脚本（疑似度不足，未进入深度检测） */
  const isCheckedNoSource = e => !!e.lastCheck && e.status === 'ok' && !e.suspected && !e.deep
  /** 深检失效：无可播放平台、有实测失败、失败原因不像本机网络 */
  const isDeepDead = e => !!e.deep && !e.usable && e.deep.failKind === 'dead'

  const nameOf = e => String(e.scriptName || e.name || '')

  /** 名称比较：中文按 locale，数字段按数值（v1.2.0 排在 v1.10.0 前） */
  function nameCmp(a, b) {
    return nameOf(a).localeCompare(nameOf(b), 'zh-Hans-CN', { numeric: true })
  }

  /**
   * 状态排序权重（升序 = 越靠前），口径与状态徽章（statusCell）逐条对应：
   *   10 可用 → 20 疑似 → 25 未检测 → 30 不可用（已检测）→ 40 失效 → 41 混淆高危
   *   → 50 重复·已合并 → 60 已灌入（垫底：先处理未灌入的，已灌入的聚在最后好排除）
   * 「有更新·待检测」的条目检测结果已重置（deep=null），按「未检测」同权，不再单列。
   */
  function statusRank(e, imported) {
    if (imported && imported[e.id]) return 60
    if (e.deprecated && !e.deep) return 50
    if (e.usable) return 10
    if (e.status === 'dead') return 40
    if (e.suspected || isCheckedNoSource(e)) return 20
    if (e.obfLevel === 'high') return 41
    if (e.deep) return isDeepDead(e) ? 40 : 30
    return 25
  }

  /** 平台可用性权重：实测可用平台数（含「已取链未校验」档），整体可用另加 100 */
  function platScore(e) {
    const p = (e.deep && e.deep.platforms) || {}
    let n = 0
    for (const k in p) if (p[k] && p[k].status === 'usable') n++
    return (e.usable ? 100 : 0) + n
  }

  // ---------------- 质量排序口径（2026-11-10 用户拍板：平台数 → p50 → 音质档） ----------------
  // 渲染进程 nodeIntegration=false，无法 require 主进程的 src/core/quality.js，
  // 所以这里必须自带一份。**口径一致性由 tests/table-sort.test.js 锁死**（同一批数据
  // 分别喂给本文件与 core/quality.sortKey，排序结果必须逐位相同），改一边不改另一边会直接红。
  const TIER_RE = [
    [/hires|hi-?res|dsd|dolby|atmos|master|jymaster|sq|无损|母带/i, 1.00],
    [/flac|ape|wav|96k|192k|lossless|24bit/i, 0.85],
    [/320k|320|exhigh|极高/i, 0.70],
    [/192k|192|high|高品/i, 0.55],
    [/128k|128|standard|标准/i, 0.40]
  ]
  function tierValue(q) {
    const v = String(q || '').trim()
    if (!v) return null
    for (let i = 0; i < TIER_RE.length; i++) if (TIER_RE[i][0].test(v)) return TIER_RE[i][1]
    return 0.30
  }
  function bestTierValue(list) {
    const arr = Array.isArray(list) ? list : (list ? [list] : [])
    let best = null
    for (let i = 0; i < arr.length; i++) {
      const v = tierValue(arr[i])
      if (v !== null && (best === null || v > best)) best = v
    }
    return best
  }
  /**
   * 综合质量排序键（升序小者优先）：[-可用平台数, p50, -档位]。
   * 与 core/quality.sortKey 完全同口径；不带 300ms 噪声带（噪声带只用于「删不删」的二元裁决，
   * 排序要求顺序可复现，差 1ms 也要能分出先后）。
   *
   * 打分门控（2026-11-10 00:1x 用户口径）：只有「深度检测（打分）」产生的 metrics
   * （depth==='full'）才参与排序。初筛/快速模式的 p50 只来自 1 次成功请求，
   * 拿它排序等于用一个样本冒充能力；这类条目 p50 记为 MAX、排在打分过的之后。
   */
  function qualitySortKey(e) {
    const p = (e.deep && e.deep.platforms) || {}
    let n = 0
    for (const k in p) if (p[k] && p[k].status === 'usable') n++
    const m = (e.deep && e.deep.metrics) || null
    const scored = !!(m && m.depth === 'full')
    const raw = scored ? Number(m.p50LatencyMs) : NaN
    const p50 = raw > 0 ? raw : null
    const tier = scored ? bestTierValue(m && m.qualityMax) : null
    return [-n, p50 === null ? Number.MAX_SAFE_INTEGER : p50, tier === null ? -1 : -tier]
  }
  /**
   * 质量摘要 HTML（「3平台 · 320ms」）——排序依据的可读化。
   * 与 qualitySortKey 同文件实现，避免「排序按一套值、显示另一套值」的错位。
   * 最高可播档当前无数据（采集不测音质，只有同名冲突专项补测写 qualityMax），
   * 所以不显示档位；有值时补第三段，绝不能拿 qualityUsed 冒充。
   */
  function qualityBriefHtml(e) {
    const p = (e && e.deep && e.deep.platforms) || {}
    let n = 0
    for (const k in p) if (p[k] && p[k].status === 'usable') n++
    if (!n) return ''   // 一个可用平台都没有：不编造摘要
    const m = (e && e.deep && e.deep.metrics) || null
    const scored = !!(m && m.depth === 'full')
    if (!scored) {
      // 初筛出来的可用源：明确告诉用户「还没打分」，而不是显示一个 1 样本的 p50 冒充能力
      return '<span class="qbrief unscored" title="初筛只确认「有可用平台」，不打分。' +
        '点工具栏「深度检测（打分）」跑五平台真取链后，这里会显示「N平台 · XXms」并参与排序">未打分</span>'
    }
    const raw = Number(m.p50LatencyMs)
    if (!(raw > 0)) return '<span class="qbrief unscored" title="深度检测已完成，但没有取到可用于计时的成功请求">无延迟样本</span>'
    // 不再有「p50 来自上次深度检测」这种继承：初筛/巡检一律清分（2026-11-11 00:38 拍板），
    // 能显示出来的 p50 一定是这一轮深度检测测出来的。
    return '<span class="qbrief" title="排序依据：可用平台 ' + n + ' 个 → p50 延迟 ' +
      Math.round(raw) + 'ms → 最高可播档（需专项补测）">' + n + '平台 · ' + Math.round(raw) + 'ms</span>'
  }

  /** 质量排序键 → 比较器；全等时按名称兜底，保证顺序稳定。 */
  function qualityCmp(a, b) {
    const ka = qualitySortKey(a), kb = qualitySortKey(b)
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1
    return 0
  }

  /**
   * 每列的首选排序方向与「升序比较器」（cmp 恒为升序：A→Z / 权重低→高；
   * dir=desc 时在 sortSources 里整体取反，实现「再点反向」）。
   */
  const SORT_DEFS = {
    name: { dir: 'asc', label: '名称', cmp: nameCmp },
    // 首选降序 = 综合质量高的在前（平台数多 → 延迟低 → 档位高）。
    // 旧口径只比「可用平台数 + 整体可用」，同平台数时全是平手、顺序随列表变；
    // 现在同平台数会继续比 p50 与音质档，方便用户照着从高到低手动灌入。
    // 注意参数顺序：SORT_DEFS 的 cmp 统一约定为「升序比较器」，本列 dir=desc 会在
    // sortSources 里整体取反；qualitySortKey 本身是「小者优先（好在前）」，
    // 所以这里用 qualityCmp(b, a) 抵消取反，最终仍是「质量高的在前」。
    plat: { dir: 'desc', label: '平台可用性', cmp: (a, b) => qualityCmp(b, a) || nameCmp(a, b) },
    repo: { dir: 'asc', label: '来源仓库', cmp: (a, b) => String(a.repo || '').localeCompare(String(b.repo || ''), 'zh-Hans-CN', { numeric: true }) },
    status: { dir: 'asc', label: '状态', cmp: (a, b, imp) => statusRank(a, imp) - statusRank(b, imp) || nameCmp(a, b) }
  }

  /**
   * 排序（返回新数组，不改原列表）。
   * @param list 条目数组
   * @param sort { key, dir }；key 为空/非法时按原序返回
   * @param imported 已灌入映射（id -> 记录），状态排序用
   */
  function sortSources(list, sort, imported) {
    const arr = Array.prototype.slice.call(list)
    const def = sort && SORT_DEFS[sort.key]
    if (!def) return arr
    const dir = sort.dir === 'desc' ? -1 : 1
    return arr.sort((a, b) => dir * def.cmp(a, b, imported))
  }

  return { SORT_KEYS, SORT_DEFS, statusRank, platScore, sortSources, qualitySortKey, qualityCmp, tierValue, bestTierValue, qualityBriefHtml, isDeepDead, isCheckedNoSource }
})
