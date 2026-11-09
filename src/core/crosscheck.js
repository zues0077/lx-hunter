'use strict'
/**
 * 第三方探针对照（v1.12.0，报告层，只读）。
 *
 * 定位：shellsec/lx-music-source 维护了一套独立的五平台探针体系
 * （每平台一个 128k 样本、下载 ~8KB 验 HTTP 状态与音频魔数，结果落在
 * tests/latest-probe.json，含每个脚本的 sha256）。把它当**对照信号源**而不是数据源：
 * 按 sha256 对齐我们库内的 contentHash（两边算法相同，hubfeed 已实测同算法），
 * 产出「我们判可用 vs 第三方探针判某平台通过/失败」的差异报告。
 *
 * 红线（三方评估结论，2026-11-09）：
 *  - 该仓库无 LICENSE → 只读取它的**探针结论 JSON**，不复制、不分发任何音源脚本；
 *  - 证据强度有限（单样本 + 8KB 头部验证 + 模拟环境），**只做报告层对照，
 *    绝不进自动决策链**（不参与可用性改写、不参与灌入/退役判断）；
 *  - 历史批次结果不回写，latest-probe.json 是按文件保留的最近快照，报告带上
 *    它的 testedAt 供判断新鲜度。
 */
const { crawlFetch } = require('./net')
const { passedPlatforms } = require('./checker')

const CROSSCHECK_URL = 'https://raw.githubusercontent.com/shellsec/lx-music-source/master/tests/latest-probe.json'
const CACHE_TTL_MS = 10 * 60 * 1000   // 内存缓存 10 分钟：报告是手动触发/巡检工具用，不必每次都拉

let cache = null   // { at, report }

/**
 * 拉取第三方探针快照并与库内音源按 sha256 对齐。
 * @param {object} store Store 实例（只读 getSources()）
 * @param {object} [opts] { url, timeoutMs, mirror, mirrorPref, log(msg, level) }
 * @returns {object} 报告（结构见下）
 */
async function runCrosscheck(store, opts) {
  const o = opts || {}
  const url = o.url || CROSSCHECK_URL
  const log = o.log || (() => {})
  if (cache && (Date.now() - cache.at) < CACHE_TTL_MS) return cache.report

  const got = await crawlFetch(url, { headers: { Accept: 'application/json' } }, o.timeoutMs || 20000, o.mirror != null ? o.mirror : 'auto', o.mirrorPref)
  if (!got.res || got.res.status !== 200) {
    const st = got.attempts.map(a => a.error ? (a.mirror + ':' + a.error) : (a.mirror + ':HTTP ' + a.status)).join('；')
    throw new Error('第三方探针快照拉取失败（' + url + '）——' + (st || '全部候选通道未命中'))
  }
  const text = await got.res.text()
  let snap
  try { snap = JSON.parse(text) } catch (e) {
    throw new Error('第三方探针快照不是合法 JSON（' + String(e && e.message || e).slice(0, 80) + '）')
  }
  if (!snap || !Array.isArray(snap.results)) throw new Error('第三方探针快照格式不正确：缺少 results 数组')

  // 解析他们的结论：attempts[].resolved && audio === true 即该平台通过（他们自己的口径）
  const their = new Map()   // sha256 -> { id, name, passed, failed }
  for (const r of snap.results) {
    if (!r || !r.sha256) continue
    const passed = []
    const failed = []
    for (const a of (Array.isArray(r.attempts) ? r.attempts : [])) {
      if (!a || !a.source) continue
      if (a.resolved === true && a.audio === true) passed.push(a.source)
      else if (a.error) failed.push(a.source)
    }
    their.set(String(r.sha256).toLowerCase(), {
      id: r.id || '', name: r.name || r.file || '', passed, failed,
      initialized: r.initialized !== false
    })
  }

  // 与库内按 contentHash 对齐（同一条内容可能在库里有多条，取非 deprecated 的那条）
  const byHash = new Map()
  for (const e of store.getSources()) {
    if (!e.contentHash) continue
    if (e.deprecated) continue
    if (!byHash.has(e.contentHash)) byHash.set(e.contentHash, e)
  }

  const matched = []
  let deadDrift = 0, platformDrift = 0, agree = 0
  for (const [sha, t] of their) {
    const e = byHash.get(sha)
    if (!e) continue
    const ourPassed = passedPlatforms(e.deep && e.deep.hash === e.contentHash ? e.deep : null)
    const ourUsable = !!e.usable
    const theirOk = t.passed.length > 0
    let drift = null
    let driftNote = ''
    if (ourUsable && !theirOk) {
      drift = 'dead'; deadDrift++
      driftNote = '我们判可用，但对方最近一次探针全平台未通过（可能对方样本/环境差异，也可能接口在波动）'
    } else if (ourUsable && theirOk) {
      const tp = new Set(t.passed)
      const lost = ourPassed.filter(s => !tp.has(s))
      const tf = new Set(t.failed)
      const realLost = lost.filter(s => tf.has(s))
      if (realLost.length) {
        drift = 'platform'; platformDrift++
        driftNote = '平台 ' + realLost.join('/') + ' 我们判可用、对方实测失败（两边都可能是单样本波动）'
      } else agree++
    } else if (!ourUsable && theirOk) {
      drift = 'platform'; platformDrift++
      driftNote = '对方探针仍通过（' + t.passed.join('/') + '），我们最近检测未通过（可复测确认）'
    } else agree++
    matched.push({
      sha256: sha, theirId: t.id, theirName: t.name,
      ourId: e.id, ourName: e.lxName || e.scriptName || e.name || e.id,
      ourUsable, ourValidTier: e.validTier || null, ourPassed,
      theirPassed: t.passed, theirFailed: t.failed,
      theirTestedAt: snap.testedAt || null,
      drift, driftNote
    })
  }

  const report = {
    ok: true,
    url,
    via: got.mirror,
    fetchedAt: Date.now(),
    theirTestedAt: snap.testedAt || null,
    theirScope: String(snap.scope || '').slice(0, 300),
    theirTotal: their.size,
    matchedCount: matched.length,
    unmatchedCount: their.size - matched.length,
    summary: { deadDrift, platformDrift, agree },
    matched: matched.sort((a, b) => (a.drift ? 0 : 1) - (b.drift ? 0 : 1) || a.theirName.localeCompare(b.theirName))
  }
  cache = { at: Date.now(), report }
  log(`第三方探针对照完成：对方 ${their.size} 条，对上 ${matched.length} 条，强漂移 ${deadDrift} / 平台漂移 ${platformDrift} / 一致 ${agree}`, driftSummaryLevel(report))
  return report
}

function driftSummaryLevel(report) {
  const s = report.summary || {}
  return (s.deadDrift > 0) ? 'warn' : undefined
}

/** 清掉内存缓存（测试用） */
function resetCrosscheckCache() { cache = null }

module.exports = { runCrosscheck, resetCrosscheckCache, CROSSCHECK_URL }
