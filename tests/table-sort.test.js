'use strict'
/**
 * 表格排序单测（v1.7.3）：src/renderer/sorters.js 纯函数。
 * 覆盖：名称 / 平台可用性 / 来源仓库 / 状态四列排序、方向切换、状态权重口径
 * （已灌入垫底 = 「排除已灌入、只勾选未灌入灌入」的排序基础）、不改原数组。
 */
const assert = require('assert')
const {
  SORT_KEYS, SORT_DEFS, statusRank, platScore, sortSources,
  qualitySortKey, bestTierValue, qualityBriefHtml,
  isDeepDead, isCheckedNoSource
} = require('../src/renderer/sorters.js')

let n = 0
const ck = (name, cond) => { n++; if (!cond) { console.error('FAIL  ' + name); process.exitCode = 1 } else console.log('PASS  ' + name) }

const mk = (o) => Object.assign({ id: 'x', scriptName: 'x', name: 'x', repo: 'r/r' }, o)

// ---- 键定义 ----
ck('四列可排序：name/plat/repo/status', JSON.stringify(SORT_KEYS) === JSON.stringify(['name', 'plat', 'repo', 'status']))
ck('首选方向：名称/仓库/状态升序，平台可用性降序', SORT_DEFS.name.dir === 'asc' && SORT_DEFS.repo.dir === 'asc' && SORT_DEFS.status.dir === 'asc' && SORT_DEFS.plat.dir === 'desc')

// ---- 名称 ----
// 中文按拼音排序。注意：只用纯中文名互比 —— Node（small-ICU）与 Electron/Chromium
// （full-ICU）对「中文 vs 拉丁字母」的相对位置口径不同，混排序列的期望值在两边不一致，
// 不属于被测逻辑问题；纯中文拼音序、纯拉丁序在两者一致。
const names = [mk({ id: 'a', scriptName: '周深音乐' }), mk({ id: 'b', scriptName: '阿布音乐' }), mk({ id: 'c', scriptName: '星海音乐' })]
const byName = sortSources(names, { key: 'name', dir: 'asc' })
ck('名称升序：中文按拼音（阿布 < 星海 < 周深）', byName.map(e => e.id).join('') === 'bca')
ck('名称降序：再点反向', sortSources(names, { key: 'name', dir: 'desc' }).map(e => e.id).join('') === 'acb')
const latin = [mk({ id: 'l2', scriptName: 'beta' }), mk({ id: 'l1', scriptName: 'Alpha' })]
ck('拉丁名大小写不敏感', sortSources(latin, { key: 'name', dir: 'asc' }).map(e => e.id).join('') === 'l1l2')
const vers = [mk({ id: 'v2', scriptName: '音源 v1.2.0' }), mk({ id: 'v10', scriptName: '音源 v1.10.0' }), mk({ id: 'v1', scriptName: '音源 v1.1.0' })]
ck('版本号按数值排（v1.2.0 在 v1.10.0 前）', sortSources(vers, { key: 'name', dir: 'asc' }).map(e => e.id).join(',') === 'v1,v2,v10')

// ---- 来源仓库 ----
const repos = [mk({ id: 'r1', repo: 'guoyue2010/lxmusic-' }), mk({ id: 'r2', repo: 'Huibq/keep-alive' })]
ck('仓库升序（g < h）', sortSources(repos, { key: 'repo', dir: 'asc' }).map(e => e.id).join('') === 'r1r2')
ck('仓库降序', sortSources(repos, { key: 'repo', dir: 'desc' }).map(e => e.id).join('') === 'r2r1')

// ---- 平台可用性 ----
const plat = (o) => mk(Object.assign({ deep: { platforms: { wy: { status: 'usable' }, tx: { status: 'usable' } } }, usable: true }, o))
const p1 = plat({ id: 'p1' })                                                    // 2 个可用平台
const p2 = plat({ id: 'p2', deep: { platforms: { wy: { status: 'usable' } } } })   // 1 个可用平台
const p3 = mk({ id: 'p3', deep: { platforms: { wy: { status: 'failed' } } } })     // 不可用
ck('平台可用性计分：可用平台数 + 整体可用 100', platScore(p1) === 102 && platScore(p2) === 101 && platScore(p3) === 0)
const byPlat = sortSources([p3, p2, p1], { key: 'plat', dir: 'desc' })
ck('平台可用性降序（默认首选）：可用多的在前', byPlat.map(e => e.id).join('') === 'p1p2p3')
ck('平台可用性升序（反向）：不可用在前', sortSources([p1, p3], { key: 'plat', dir: 'asc' }).map(e => e.id).join('') === 'p3p1')

// ---- 状态权重 ----
const usable = mk({ id: 'u', usable: true })
const suspected = mk({ id: 's', suspected: true, lastCheck: 1, status: 'ok' })
const unchecked = mk({ id: 'n' })
const deepBad = mk({ id: 'd', deep: { platforms: {}, failKind: 'net' } })
const dead = mk({ id: 'x', status: 'dead' })
const obfHigh = mk({ id: 'o', obfLevel: 'high', deep: { platforms: {}, failKind: 'net' } })
const merged = mk({ id: 'm', deprecated: true })
const importedOne = mk({ id: 'i', usable: true })
ck('状态权重：可用 10 / 疑似 20 / 未检测 25 / 不可用 30 / 失效 40 / 混淆高危 41 / 已合并 50',
  statusRank(usable, {}) === 10 && statusRank(suspected, {}) === 20 && statusRank(unchecked, {}) === 25 &&
  statusRank(deepBad, {}) === 30 && statusRank(dead, {}) === 40 && statusRank(obfHigh, {}) === 41 && statusRank(merged, {}) === 50)
ck('深检确证失效归 40（与徽章口径一致）', statusRank(mk({ deep: { platforms: {}, failKind: 'dead' } }), {}) === 40)
ck('status=dead 优先于疑似标记（徽章显示「失效」）', statusRank(mk({ status: 'dead', suspected: true }), {}) === 40)
ck('已灌入垫底（60）：即使本身可用也排最后', statusRank(importedOne, { i: { lxId: 'x' } }) === 60)
ck('未灌入的同名可用条不受 imported 影响', statusRank(importedOne, { other: {} }) === 10)

// ---- 状态排序 ----
const pool = [importedOne, merged, obfHigh, dead, deepBad, unchecked, suspected, usable]
const byStatus = sortSources(pool, { key: 'status', dir: 'asc' }, { i: { lxId: 'x' } })
ck('状态升序（默认）：可用→疑似→未检测→不可用→失效→混淆高危→已合并→已灌入',
  byStatus.map(e => e.id).join('') === 'usndxomi')
ck('状态降序（反向）：已灌入到最前', sortSources(pool, { key: 'status', dir: 'desc' }, { i: { lxId: 'x' } }).map(e => e.id).join('') === 'imoxdnsu')
// 「排除已灌入、只勾未灌入」的排序基础：已灌入全部聚在尾部
ck('已灌入项聚在列表尾部（可整段排除）', byStatus.slice(-1).every(e => e.id === 'i'))

// ---- 契约 ----
const orig = [p3, p1]
const sorted = sortSources(orig, { key: 'plat', dir: 'desc' })
ck('不改原数组', orig.map(e => e.id).join('') === 'p3p1' && sorted !== orig)
ck('key 为空按原序', sortSources(orig, { key: null, dir: 'asc' }).map(e => e.id).join('') === 'p3p1')
ck('非法 key 按原序', sortSources(orig, { key: 'bogus', dir: 'asc' }).map(e => e.id).join('') === 'p3p1')
ck('sort 为 null 不炸', sortSources(orig, null).length === 2)
ck('空列表不炸', sortSources([], { key: 'name', dir: 'asc' }).length === 0)
// 排序键相等时按名称兜底，顺序稳定可预期
const tie = [mk({ id: 't2', scriptName: 'b 源' }), mk({ id: 't1', scriptName: 'a 源' })]
ck('同分按名称兜底', sortSources(tie, { key: 'status', dir: 'asc' }, {}).map(e => e.id).join('') === 't1t2')

// ---- 平台可用性列 = 综合质量字典序（2026-11-10：平台数 → p50 → 音质档） ----
// 用户口径：「按综合分高低排序后，方便我手动灌入综合评分高的音源」。
// 排序键不带 300ms 噪声带（噪声带只用于「删不删」，排序要顺序可复现）。
{
  const q = (n, p50, tier, id) => {
    const platforms = {}
    ;['wy', 'tx', 'kw', 'kg', 'mg'].forEach((k, i) => { platforms[k] = i < n ? { status: 'usable' } : { status: 'failed' } })
    const metrics = { depth: 'full', p50LatencyMs: p50 }
    if (tier) metrics.qualityMax = tier
    return { id, scriptName: id, deep: { checkedAt: 1, platforms, metrics } }
  }
  const pool = [q(4, 1200, '320k', 'A'), q(4, 600, '128k', 'B'), q(5, 2900, null, 'C'), q(3, 100, null, 'D')]
  const desc = sortSources(pool, { key: 'plat', dir: 'desc' }).map(e => e.id).join('')
  ck('平台列降序 = 综合质量从高到低：5平台 → 4平台600ms → 4平台1200ms → 3平台', desc === 'CBAD')
  ck('再点反向 = 质量从低到高', sortSources(pool, { key: 'plat', dir: 'asc' }).map(e => e.id).join('') === 'DABC')
  ck('同平台数时延迟决定先后（600ms 在 1200ms 前）', desc.indexOf('B') < desc.indexOf('A'))
  const noMetrics = { id: 'E', scriptName: 'E', deep: { checkedAt: 1, platforms: { wy: { status: 'usable' }, tx: { status: 'usable' } } } }
  const withMetrics = q(2, 900, null, 'F')
  ck('无延迟证据的排在同平台数实测之后', sortSources([noMetrics, withMetrics], { key: 'plat', dir: 'desc' }).map(e => e.id).join('') === 'FE')
  ck('qualitySortKey 返回纯数字三位（可直接比较、无 NaN）', qualitySortKey(pool[0]).every(v => typeof v === 'number' && !Number.isNaN(v)))
  ck('qualitySortKey 与 core/quality.sortKey 口径一致（同一数据逐位相同）', (() => {
    const Q = require('../src/core/quality')
    return pool.concat([noMetrics, withMetrics]).every(e => JSON.stringify(qualitySortKey(e)) === JSON.stringify(Q.sortKey(e)))
  })())
  // 注意方向语义：core.compareSortKey 的键是「小者优先」，升序即「质量高在前」；
  // sortSources 的 cmp 约定是升序比较器、dir=desc 取反，所以对齐的是 dir='desc'。
  ck('两份实现排序结果逐位一致（sorters desc ↔ core 升序）', (() => {
    const Q = require('../src/core/quality')
    const a = sortSources(pool, { key: 'plat', dir: 'desc' }).map(e => e.id).join('')
    const b = pool.slice().sort(Q.compareSortKey).map(e => e.id).join('')
    return a === b && a === 'CBAD'
  })())
  ck('音质档：单值 qualityMax 可读，flac 胜过 128k', bestTierValue('flac') > bestTierValue('128k') && bestTierValue(['128k', 'flac']) === 0.85)
  ck('音质档：没有 qualityMax 时为 null（qualityUsed 不冒充）', bestTierValue(undefined) === null)
}

// ---- 质量摘要展示（与排序键同源，杜绝「排一套、显示另一套」） ----
{
  const b = qualityBriefHtml({ deep: { platforms: { wy: { status: 'usable' }, tx: { status: 'usable' }, kw: { status: 'failed' } }, metrics: { depth: 'full', p50LatencyMs: 321.6 } } })
  ck('质量摘要显示「2平台 · 322ms」（四舍五入）', /2平台 · 322ms/.test(b), b)
  ck('摘要带 title 说明排序依据', /排序依据：可用平台 2 个/.test(b))
  ck('无 deep 时不出摘要（不显示假数据）', qualityBriefHtml({ deep: null }) === '' && qualityBriefHtml({}) === '')
  ck('0 个可用平台不出摘要', qualityBriefHtml({ deep: { platforms: { wy: { status: 'failed' } }, metrics: { depth: 'full', p50LatencyMs: 300 } } }) === '')
  // 口径变更（2026-11-10 00:1x）：有可用平台但没打分 → 显示「未打分」，不再什么都不显示。
  // 什么都不显示会让人以为这条没有质量信息，实际是「还没测」，必须区分开。
  ck('未打分的可用源显示「未打分」而不是编造延迟', /未打分/.test(qualityBriefHtml({ deep: { platforms: { wy: { status: 'usable' } } } })))
  ck('深度检测过但没有成功计时样本 → 「无延迟样本」', /无延迟样本/.test(qualityBriefHtml({
    deep: { platforms: { wy: { status: 'usable' } }, metrics: { depth: 'full', p50LatencyMs: null } }
  })))
  ck('初筛（quick）的 p50 不显示（1 样本不算能力）', /未打分/.test(qualityBriefHtml({
    deep: { platforms: { wy: { status: 'usable' } }, metrics: { depth: 'quick', p50LatencyMs: 180 } }
  })))
  ck('升级前的老记录（无 depth）按未打分处理', /未打分/.test(qualityBriefHtml({
    deep: { platforms: { wy: { status: 'usable' } }, metrics: { p50LatencyMs: 180 } }
  })))
  ck('摘要内容只有数字，无 HTML 注入面', /^<span class="qbrief" title="[^<]*">\d+平台 · \d+ms<\/span>$/.test(b), b)
  ck('摘要的平台数与排序键第一位一致', (() => {
    const e = { deep: { platforms: { wy: { status: 'usable' }, tx: { status: 'usable' } }, metrics: { depth: 'full', p50LatencyMs: 200 } } }
    return qualitySortKey(e)[0] === -2 && /2平台/.test(qualityBriefHtml(e))
  })())
}

// ---- 渲染层引用完整性（防「页面用到未导出的方法」运行时 undefined） ----
{
  const fs = require('fs')
  const path = require('path')
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8')
  const used = new Set()
  const re = /LXSort\.([A-Za-z_$][\w$]*)/g
  let m
  while ((m = re.exec(appSrc))) used.add(m[1])
  const api = require('../src/renderer/sorters.js')
  const missing = [...used].filter(k => typeof api[k] === 'undefined')
  ck('app.js 引用的 LXSort 方法全部已导出', missing.length === 0, missing.join(','))
  // 反向：qualityBriefHtml 必须真的被页面用上（否则排序依据看不见）
  ck('app.js 确实在平台列调用 qualityBriefHtml', /LXSort\.qualityBriefHtml\(e\)/.test(appSrc))
  // 表头排序 key 与 SORT_DEFS 一一对应（点了没反应的列不要出现在 sortable 上）
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8')
  const keys = []
  const kre = /id="srcTable"[\s\S]*?<\/thead>/.exec(html)
  const tre = /data-k="([^"]+)"/g
  let km
  const scope = kre ? kre[0] : ''
  while ((km = tre.exec(scope))) keys.push(km[1])
  ck('srcTable 可排序列都有对应 SORT_DEFS 定义', keys.length > 0 && keys.every(k => !!SORT_DEFS[k]), keys.join(','))
}

// ---- 谓词（与状态徽章口径一致） ----
ck('isCheckedNoSource：已检测+ok+无疑似+无深检', isCheckedNoSource(mk({ lastCheck: 1, status: 'ok' })) && !isCheckedNoSource(mk({ lastCheck: 1, status: 'ok', deep: {} })))
ck('isDeepDead：深检+不可用+failKind=dead', isDeepDead(mk({ deep: { failKind: 'dead' } })) && !isDeepDead(mk({ deep: { failKind: 'net' } })))

console.log('\n' + (process.exitCode ? 'FAILED' : `ALL PASS（${n} 项）`))
process.exit(process.exitCode || 0)
