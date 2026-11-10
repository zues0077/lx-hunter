'use strict'
/**
 * 「质量更优」判据（2026-11-10，用户 21:01 认同「必须把判据定义清楚」）
 *
 * 用户口径第 3 条：不同仓库获取到的同名音源，由 lx-hunter 检测，质量更优的留、差的删。
 * 之前只有 usableCount（可用平台数）一个数，平手时全靠兜底规则拍脑袋。这里把判据
 * 写成可测、可解释的分层，并明确「证据不对称」时绝不擅自删。
 *
 * 分层（只在同 normName 组内比较，前置条件由调用方保证）：
 *  1) usable   实测可用平台数（真实能解析出音频链接的平台）—— 主判据
 *  2) verified 其中「真校验通过」数（checker 的 verified===true，实际返回可播音频）
 *     —— 比「只是解析出 URL」更硬，作为平手时的次级判据
 *  3) tested   已实测平台数（证据覆盖度；untested/skipped 越少越可信）
 *  4) checkedAt 检测时间 —— **只用于展示排序，不单独触发删除**（避免按时间拍脑袋）
 *
 * 服务端 list 只有 supportedSources（声明值），没有 deep 实测，也没有 hash/正文。
 * 这类条目标记 declared=true、verified/tested=-1（未知）。未知项一律不参与比较，
 * 即「服务端声明 3 个平台 vs 本地实测 3 个平台」判平手 → 不删。
 *
 * 返回：>0 a 更优，<0 b 更优，0 平手或证据不足。平手一律不动。
 */
const UNKNOWN = -1

function qualityProfile(entry) {
  const e = entry || {}
  if (e.usable !== undefined && e.verified !== undefined) return e  // 已是 profile
  const deep = e.deep || null
  const plats = deep && deep.platforms ? deep.platforms : null
  if (!plats) {
    const arr = Array.isArray(e.supportedSources) ? e.supportedSources : []
    return { usable: arr.length, verified: UNKNOWN, tested: UNKNOWN, untested: UNKNOWN, checkedAt: 0, declared: true }
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
  return {
    usable, verified, tested, untested,
    checkedAt: Number(deep.checkedAt) || 0,
    declared: false
  }
}

/** 分层比较。任一侧为「未知」的层级跳过，不把未知当优势也不当劣势。 */
function compareQuality(a, b) {
  const pa = qualityProfile(a), pb = qualityProfile(b)
  if (pa.usable !== pb.usable) return pa.usable > pb.usable ? 1 : -1
  if (pa.verified !== UNKNOWN && pb.verified !== UNKNOWN && pa.verified !== pb.verified) {
    return pa.verified > pb.verified ? 1 : -1
  }
  if (pa.tested !== UNKNOWN && pb.tested !== UNKNOWN && pa.tested !== pb.tested) {
    return pa.tested > pb.tested ? 1 : -1
  }
  return 0
}

/** 只有主判据或硬判据真的分出高下，才算「明显更优」；平手/证据不足一律 false。 */
function isClearlyBetter(a, b) {
  return compareQuality(a, b) > 0
}

function describeQuality(entry) {
  const p = qualityProfile(entry)
  if (p.declared) return `声明 ${p.usable} 个支持平台（无实测证据）`
  return `实测可用 ${p.usable} 个平台` +
    (p.verified >= 0 ? ` / 真校验通过 ${p.verified} 个` : '') +
    (p.tested >= 0 ? ` / 已测 ${p.tested} 个` : '') +
    (p.untested > 0 ? ` / 未测 ${p.untested} 个` : '')
}

module.exports = { qualityProfile, compareQuality, isClearlyBetter, describeQuality, UNKNOWN }
