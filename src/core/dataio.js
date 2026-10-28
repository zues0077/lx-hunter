'use strict'
/**
 * 数据导入/导出（v1.9.20，设置页「数据」卡片）
 *
 * 把「仓库清单 / 音源采集站 / raw 加速镜像」三类配置做成可搬家的 JSON，
 * 与音源库导出（store.mergeFrom）互补：音源库搬「检测结果」，这里搬「采集范围与网络配置」。
 * Web 版（HTTP 附件下载/上传）与桌面版（保存/打开对话框）共用同一套合并逻辑，
 * 只是「文件从哪来、到哪去」不同。
 */

const { normalizeRepo } = require('./crawler')
const { makeHubId } = require('./hubfeed')
const { hostToId, applyConfig } = require('./net')

const SCOPES = ['repos', 'hubs', 'mirrors']
const SCOPE_LABELS = { repos: '仓库清单', hubs: '音源采集站', mirrors: 'raw 加速镜像' }

/** 采集站条目规范化（与 web.js 的 normHub 同一套字段口径） */
function normHub(h) {
  if (!h || !h.url) return null
  const url = String(h.url).trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(url)) return null
  return {
    id: String(h.id || makeHubId(url)),
    name: String(h.name || url).slice(0, 80),
    url,
    kind: String(h.kind || ''),
    enabled: h.enabled !== false,
    entriesUrl: String(h.entriesUrl || ''),
    detailUrl: String(h.detailUrl || ''),
    lastSync: h.lastSync || null,
    addedAt: h.addedAt || Date.now()
  }
}

/**
 * 组装导出 JSON（不含检测结果，体积小）。
 * mirrors 额外带上当前选中镜像与自定义基址，导入端原样恢复选择。
 */
function buildExport(store, scope) {
  const c = store.config || {}
  const base = {
    app: 'lx-hunter-pc',
    kind: 'lx-hunter-data',
    scope,
    exportedAt: Date.now()
  }
  if (scope === 'repos') {
    return Object.assign(base, { repos: Array.isArray(c.repos) ? c.repos : [] })
  }
  if (scope === 'hubs') {
    return Object.assign(base, { hubs: Array.isArray(c.hubs) ? c.hubs : [] })
  }
  if (scope === 'mirrors') {
    return Object.assign(base, {
      mirror: c.mirror || 'auto',
      mirrorCustom: c.mirrorCustom || '',
      mirrorPool: Array.isArray(c.mirrorPool) ? c.mirrorPool : []
    })
  }
  throw new Error('未知导出范围：' + scope)
}

/** 仓库清单合并：规范化 + 按小写去重；同仓库时保留本地条目的 builtin/origin，enabled 以导入为准 */
function mergeRepos(cur, incoming) {
  const out = Array.isArray(cur) ? cur.slice() : []
  const byKey = new Map()
  for (const r of out) {
    if (!r || !r.repo) continue
    byKey.set(String(r.repo).toLowerCase(), r)
  }
  let added = 0, updated = 0
  for (const it of Array.isArray(incoming) ? incoming : []) {
    if (!it || !it.repo) continue
    const n = normalizeRepo(it.repo)
    if (!n) continue
    const k = n.toLowerCase()
    const ex = byKey.get(k)
    if (ex) {
      const en = it.enabled === false ? false : true
      if (ex.enabled !== en) { ex.enabled = en; updated++ }
      continue
    }
    const item = { repo: n, enabled: it.enabled !== false, builtin: !!it.builtin, origin: it.origin || 'custom' }
    out.push(item)
    byKey.set(k, item)
    added++
  }
  return { list: out, added, updated }
}

/** 采集站合并：按规范化 url 去重，同名站点保留本地的 id/lastSync（采集状态不丢） */
function mergeHubs(cur, incoming) {
  const out = Array.isArray(cur) ? cur.slice() : []
  const byUrl = new Map()
  for (const h of out) {
    if (!h || !h.url) continue
    byUrl.set(String(h.url).replace(/\/+$/, ''), h)
  }
  let added = 0, updated = 0
  for (const it of Array.isArray(incoming) ? incoming : []) {
    const h = normHub(it)
    if (!h) continue
    const ex = byUrl.get(h.url)
    if (ex) {
      if (it.enabled != null && ex.enabled !== (it.enabled !== false)) { ex.enabled = it.enabled !== false; updated++ }
      continue
    }
    out.push(h)
    byUrl.set(h.url, h)
    added++
  }
  return { list: out, added, updated }
}

/**
 * 镜像池合并：按 id 去重。同 id 时本地实测数据（ms/failStreak/lastOk）优先，
 * 只在本地没有这条时才采纳导入的（导入的 ms 是别的机器测的，仅作参考）。
 * 顺带恢复 mirror / mirrorCustom 选择（下拉里有的才恢复）。
 */
function mergeMirrors(store, incoming) {
  const c = store.config || {}
  const cur = Array.isArray(c.mirrorPool) ? c.mirrorPool.slice() : []
  const byId = new Map()
  for (const m of cur) if (m && m.id) byId.set(m.id, m)
  let added = 0, updated = 0
  for (const it of Array.isArray(incoming.mirrorPool) ? incoming.mirrorPool : []) {
    if (!it || !it.id || !it.base || !/^https?:\/\//i.test(it.base)) continue
    const ex = byId.get(it.id)
    if (ex) {
      if (ex.enabled !== (it.enabled !== false) && it.enabled != null) { ex.enabled = it.enabled !== false; updated++ }
      continue
    }
    const m = {
      id: it.id || hostToId(it.base),
      label: it.label || it.base,
      base: String(it.base).replace(/\/+$/, ''),
      ms: Number(it.ms) || null,
      lastOk: it.lastOk || null,
      failStreak: 0,
      addedAt: it.addedAt || Date.now(),
      enabled: it.enabled !== false
    }
    cur.push(m)
    byId.set(m.id, m)
    added++
  }
  const patch = { mirrorPool: cur }
  if (incoming.mirror != null) patch.mirror = String(incoming.mirror)
  if (incoming.mirrorCustom != null) patch.mirrorCustom = String(incoming.mirrorCustom).trim()
  store.saveConfig(patch)
  applyConfig(patch) // 池子改动即时生效，不用等下一次 config:set
  return { added, updated, pool: cur }
}

/**
 * 导入入口（写回 store）。
 * @returns {{scope, added, updated, total}}
 */
function importData(store, scope, data) {
  if (!SCOPES.includes(scope)) throw new Error('未知导入范围：' + scope)
  if (!data || typeof data !== 'object') throw new Error('导入文件内容不是有效 JSON')
  if (data.kind && data.kind !== 'lx-hunter-data') throw new Error('这不是 lx-hunter 数据导出文件')
  const summary = { scope, label: SCOPE_LABELS[scope], added: 0, updated: 0 }
  if (scope === 'mirrors') {
    Object.assign(summary, mergeMirrors(store, data))
    summary.total = (store.config.mirrorPool || []).length
    return summary
  }
  const key = scope // repos / hubs
  const r = key === 'repos' ? mergeRepos(store.config.repos, data.repos) : mergeHubs(store.config.hubs, data.hubs)
  store.saveConfig({ [key]: r.list })
  summary.added = r.added
  summary.updated = r.updated
  summary.total = r.list.length
  return summary
}

module.exports = { SCOPES, SCOPE_LABELS, buildExport, importData, mergeRepos, mergeHubs, mergeMirrors, normHub }
