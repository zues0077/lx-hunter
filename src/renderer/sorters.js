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

  /**
   * 每列的首选排序方向与「升序比较器」（cmp 恒为升序：A→Z / 权重低→高；
   * dir=desc 时在 sortSources 里整体取反，实现「再点反向」）。
   */
  const SORT_DEFS = {
    name: { dir: 'asc', label: '名称', cmp: nameCmp },
    plat: { dir: 'desc', label: '平台可用性', cmp: (a, b) => platScore(a) - platScore(b) || nameCmp(a, b) },
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

  return { SORT_KEYS, SORT_DEFS, statusRank, platScore, sortSources, isDeepDead, isCheckedNoSource }
})
