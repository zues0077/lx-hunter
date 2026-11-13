'use strict'
/**
 * 服务端动作 → 本地「冻结」标记（v1.13.0）
 *
 * 要解决的问题
 * ------------
 * lx-music 侧对灌进去的音源做处置（整源禁用 / 单平台禁用 / 自检护栏隔离 / 删除）之后，
 * hunter 这一侧完全不知情：账本对账只会「把记录摘掉」，于是下一轮定时灌入又把它灌回去，
 * 用户在网页上删三次，它回来三次。
 *
 * 这里把「服务端的动作」翻译成本地冻结标记，冻结期间**任何灌入目标都不再上传该音源**，
 * 直到音源内容（contentHash）发生变化 —— 上游发了新版本才值得再试一次。
 *
 * 「部分平台被禁」为什么不冻结（2026-11-12 用户纠正）
 * ------------------------------------------------
 * 只禁了 mg 的源，kw/wy 照样能出歌 —— 它是**还能用的源**。整源冻结会连它的更新都不许推，
 * 那是把「用户嫌 mg 不通」误当成「这个源废了」。
 * 所以只做**展示标记**（partial=true，界面上告诉用户「它在 mg 上被你关掉了」），
 * 不参与灌入拦截；只有「整源禁用 / 全部平台都禁 / 删除 / 护栏隔离」才是真的判死。
 *
 * 冻结只针对「同一份字节」：上游改了内容（sha 变了）就自动解冻。
 *
 * 纯函数设计：不读写文件、不碰 store，方便单测（tests/server-veto.test.js）。
 */

/** 冻结类型（写进 db.veto[eid].type，供界面与服务端动作对应展示） */
const VETO_TYPES = {
  DISABLED: 'disabled',                    // 整源被禁用（服务端 enabled=false）
  PLATFORM_DISABLED: 'platform-disabled',  // 单平台 / 部分平台被禁用
  REMOVED: 'removed',                      // 服务端已删除（手动删除或巡检移除）
  ISOLATED: 'isolated'                     // 自检护栏隔离（CPU 热点等）
}

const TYPE_LABEL = {
  disabled: '服务端已禁用该音源',
  'platform-disabled': '服务端已禁用它的部分平台',
  removed: '服务端已删除该音源',
  isolated: '被服务端自检护栏隔离'
}

/** 多平台取并集时的优先级：删除 > 隔离 > 整源禁用 > 单平台禁用（越"重"越优先） */
const VETO_PRIORITY = { removed: 4, isolated: 3, disabled: 2, 'platform-disabled': 1 }

/**
 * 从「服务端列表 + 本地账本 + 上一层冻结表」算出新的冻结表。
 *
 * @param {object} p
 * @param {object} p.imported            本地账本 store.imported（eid → rec）
 * @param {object} p.sources             本地音源库 store.db.sources（eid → entry），只用来取 contentHash
 * @param {Array}  p.serverList          服务端音源列表（含 id/enabled/disabledSources）
 * @param {string} p.activePlatformId    当前账号 id（老记录归当前选中账号）
 * @param {object} [p.prev]              上一层冻结表 db.veto
 * @param {string[]} [p.isolatedIds]     被服务端护栏隔离的服务端条目 id
 * @param {number} [p.now]
 * @returns {{veto:object, added:number, updated:number, cleared:number, kept:number}}
 */
function computeVeto(p) {
  const imported = p.imported || {}
  const sources = p.sources || {}
  const serverList = Array.isArray(p.serverList) ? p.serverList : []
  const activeId = p.activePlatformId || null
  const prev = p.prev && typeof p.prev === 'object' ? p.prev : {}
  const isolated = new Set((p.isolatedIds || []).filter(x => x != null).map(String))
  const now = p.now || Date.now()

  const byServerId = new Map()
  for (const s of serverList) {
    if (s && s.id != null) byServerId.set(String(s.id), s)
  }

  const veto = {}
  let added = 0
  let updated = 0
  let kept = 0
  let cleared = 0

  for (const [eid, rec] of Object.entries(imported)) {
    if (!rec) continue
    const pid = p.platformId || activeId
    const lxId = recLxIdOn(rec, pid, activeId)
    if (lxId == null) continue                    // 该账号上没灌入过 → 谈不上「服务端动作」
    const e = sources[eid]
    if (!e) continue                              // 本地条目已删 → 不用冻结
    const sha = e.contentHash || ''

    const old = prev[eid] || null
    // 内容变了 = 上游发了新版：旧的处置结论作废（用户口径「直到该音源有更新为止」）
    if (old && old.sha && sha && old.sha !== sha) { cleared++; continue }

    const srv = byServerId.get(String(lxId))
    let type = ''
    let detail = ''
    let partial = false
    let offList = []

    if (!srv) {
      type = VETO_TYPES.REMOVED
      detail = '服务端列表里已找不到这条音源（手动删除或巡检移除）'
    } else if (isolated.has(String(lxId))) {
      type = VETO_TYPES.ISOLATED
      detail = '服务端自检护栏隔离了它（多为 CPU 占用异常）'
    } else if (srv.enabled === false) {
      // 「灌入后停用」（disableReason=after-import，2026-11-13 与 lxserver 联动）不冻结：
      // 这是灌入落盘时的默认停用，等 lxserver 停用源复检验证后自动启用 ——
      // 不是用户的处置意图。把它当处置打标会锁死「验证→启用」的闭环。
      // 复检判死升级的 probe-dead、用户手动停用的 manual/无标签 照旧冻结。
      if (srv.disableReason === 'after-import') { continue }
      type = VETO_TYPES.DISABLED
      detail = srv.disableReason === 'probe-dead'
        ? '服务端停用源复检连续判定它无效（检测后停用）'
        : '服务端把它关掉了（enabled=false）'
    } else {
      const off = Array.isArray(srv.disabledSources) ? srv.disabledSources.filter(Boolean) : []
      const all = Array.isArray(srv.supportedSources) ? srv.supportedSources.filter(Boolean) : []
      if (off.length && all.length && all.every(x => off.indexOf(x) !== -1)) {
        // 全部平台都被关 = 实际等于整源不可用 → 冻结
        type = VETO_TYPES.PLATFORM_DISABLED
        detail = `服务端把它的全部平台都关掉了（${off.join('/')}）`
      } else if (off.length) {
        // 只关了部分平台：源还能用，**不冻结**，只做展示标记
        type = VETO_TYPES.PLATFORM_DISABLED
        partial = true
        offList = off
        detail = `服务端关掉了它的 ${off.join('/')} 平台（其余平台仍可用，不冻结）`
      }
    }

    if (!type) continue
    veto[eid] = {
      type,
      detail,
      // partial=true：只关了部分平台，源仍可用 → isFrozen 会返回 false（只展示不拦截）
      partial: !!partial,
      platforms: offList,
      lxId: String(lxId),
      sha,
      since: old && old.type === type && old.since ? old.since : now,
      at: now
    }
    if (!old) added++
    else if (old.type !== type || old.sha !== sha) updated++
    else kept++
  }

  return { veto, added, updated, cleared, kept }
}

/** 该记录在**指定账号**上的服务端 id（importedTo 优先，退回顶层；老记录归当前选中账号） */
function recLxIdOn(rec, pid, activeId) {
  if (!rec) return null
  // 必须按账号取：同一条音源可能只灌进了 A、还没进 B。拿 A 的 lxId 去 B 的列表里找，
  // 会把「B 还没灌过」误判成「B 上被删了」→ 反向把整条源冻死（multi-import 单测抓过）。
  if (Array.isArray(rec.importedTo)) {
    const hit = rec.importedTo.find(x => x && x.platformId === pid && x.lxId != null)
    if (hit) return hit.lxId
  }
  const top = rec.platformId == null ? activeId : rec.platformId
  if (top === pid && rec.lxId != null) return rec.lxId
  return null
}

/**
 * 该条目此刻是否处于冻结（决定「要不要灌」的唯一判据）。
 * 内容变了（sha 不一致）→ 自动视为解冻，不需要人工操作。
 */
function isFrozen(vetoMap, entry) {
  if (!vetoMap || !entry) return false
  const v = vetoMap[entry.id]
  if (!v) return false
  // 只关了部分平台 → 源还能用，不拦截灌入（2026-11-12 用户纠正）
  if (v.partial) return false
  const sha = entry.contentHash || ''
  if (v.sha && sha && v.sha !== sha) return false
  return true
}

/** 人话原因（日志 / 界面提示共用） */
function vetoReason(v) {
  if (!v) return ''
  const head = TYPE_LABEL[v.type] || v.type
  return v.detail ? head + '：' + v.detail : head
}

/** 批量：把一批条目按冻结状态分成 {keep, frozen}，供灌入队列过滤与日志统计 */
function splitFrozen(vetoMap, entries) {
  const keep = []
  const frozen = []
  for (const e of entries || []) {
    if (!e) continue
    if (isFrozen(vetoMap, e)) frozen.push({ entry: e, veto: vetoMap[e.id] })
    else keep.push(e)
  }
  return { keep, frozen }
}

module.exports = { VETO_TYPES, VETO_PRIORITY, TYPE_LABEL, computeVeto, isFrozen, vetoReason, splitFrozen, recLxIdOn }
