'use strict'
/**
 * 音源采集站（Hub Feed）—— v1.9.19
 *
 * 做什么：把第三方「音源筛选站」当成一种音源来源，像 GitHub 仓库一样挂进 lx-hunter，
 * 由 lx-hunter 自己去这些站点上把「实测可用」的音源采回来。
 *
 * 为什么不干脆每个都下载下来验一遍：
 *   采集站自己已经对每条音源做过实机探测（能不能加载、平台能不能用），
 *   并且**它们返回的 sha256 经实测与 lx-hunter 的 contentHash 完全同算法**
 *   （= sha256(脚本文本.encode('utf-8'))，实测 deerwan 系 4/4、zlyon 系 3/3 一致）。
 *   所以判重阶段可以直接采信上游 sha256 —— 零下载、零请求。
 *   只有真正新增的条目，才会在后续检测/巡检时由 lx-hunter 自己下载一次。
 *
 * 支持的站点形态（自动识别，不用用户手选类型）：
 *   deerwan 系  /export.json 或 /api/sources → { sources:[{name,url,sha256,size,probe_status,...}] }
 *   zlyon 系    /api/entries → { items:[{id,name,platStatus,...}] }，详情 /api/source/detail?id=
 *   zlyon 系(扁平) /data.json → { items:[{name,url,sha256,platStatus,...}] }（自带直链，无需详情请求）
 *
 * 设计约束：
 *  - 只用 Node 内置模块 + ./net 的 fetchAuto（代理优先、内网直连，零 npm 依赖）
 *  - 采集站标 usable 的才收；判定信任上游，本地巡检（patrol/runCheck）负责复检
 *  - 全程零脚本下载，失败只影响该站点，不中断整体
 */
const { fetchAuto, readText, UA } = require('./net')

const JSON_HEADERS = { 'User-Agent': UA, Accept: 'application/json' }
const KIND_LABELS = { deerwan: 'deerwan 系', zlyon: 'zlyon 系', 'zlyon-flat': 'zlyon 系（扁平）' }

/** 站点类型探测顺序：先试结构最全的，命中即停 */
function buildProbeUrls(base) {
  const b = String(base || '').trim().replace(/\/+$/, '')
  if (!b) return []
  // 直接给了 JSON 地址（如 https://xxx/data.json）：按内容自动判别
  if (/\.json(\?.*)?$/i.test(b)) return [{ url: b, kind: 'auto', detailUrl: '' }]
  return [
    { url: b + '/export.json', kind: 'deerwan', detailUrl: '' },
    { url: b + '/api/export', kind: 'deerwan', detailUrl: '' },
    { url: b + '/api/sources', kind: 'deerwan', detailUrl: '' },
    { url: b + '/api/entries', kind: 'zlyon', detailUrl: b + '/api/source/detail' },
    { url: b + '/data.json', kind: 'zlyon-flat', detailUrl: '' }
  ]
}

function pickArray(d) {
  if (Array.isArray(d)) return d
  if (!d || typeof d !== 'object') return null
  return Array.isArray(d.sources) ? d.sources : (Array.isArray(d.items) ? d.items : (Array.isArray(d.entries) ? d.entries : null))
}

function guessKind(sample) {
  if (!sample || typeof sample !== 'object') return 'deerwan'
  if (sample.platStatus || sample.scriptType || sample.originRepo) return 'zlyon'
  if ('probe_status' in sample || 'script_type' in sample || 'sha256' in sample) return 'deerwan'
  return 'deerwan'
}

/**
 * 探测一个站点地址，识别类型并返回可用条目数。
 * @returns {{ok:boolean, kind?:string, kindLabel?:string, entriesUrl?:string, detailUrl?:string, total?:number, usable?:number, error?:string}}
 */
async function detectHub(base, timeoutMs) {
  const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : 15000
  const tried = []
  for (const p of buildProbeUrls(base)) {
    let res = null
    try {
      res = await fetchAuto(p.url, { headers: JSON_HEADERS }, ms)
      if (!res || !res.ok) { tried.push(p.url + ' → HTTP ' + (res ? res.status : '不可达')); continue }
      const d = JSON.parse(await readText(res, ms))
      const arr = pickArray(d)
      if (!arr || !arr.length) { tried.push(p.url + ' → 空清单'); continue }
      const kind = p.kind === 'auto' ? guessKind(arr[0]) : p.kind
      const usable = arr.filter(it => isUsable(it, kind)).length
      return {
        ok: true, kind, kindLabel: KIND_LABELS[kind] || kind, entriesUrl: p.url,
        detailUrl: p.detailUrl || '', total: arr.length, usable
      }
    } catch (e) {
      tried.push(p.url + ' → ' + String((e && e.message) || e).slice(0, 40))
    }
  }
  return { ok: false, error: tried.length ? tried.join('；').slice(0, 200) : '地址为空' }
}

/** 采集站单条是否「实测可用」 */
function isUsable(it, kind) {
  if (!it || typeof it !== 'object') return false
  // deerwan 系：probe 实测
  if (it.probe_status) return it.probe_status === 'usable'
  // zlyon 系：任一平台实测可用
  const plat = it.platStatus
  if (plat && typeof plat === 'object') {
    for (const k of Object.keys(plat)) {
      const p = plat[k]
      if (p && p.status === 'usable') return true
    }
    return false
  }
  return it.status === 'ok' || it.status === 'usable'
}

/** 只收真音源脚本，跳过榜单/歌词之类（两种 schema 字段名不同，都兼容） */
function isSourceScript(it) {
  const t = it.script_type || it.scriptType
  return !t || t === 'source'
}

function toCandidate(it, kind) {
  return {
    name: String(it.name || '').trim() || '未命名音源',
    url: String(it.url || it.rawUrl || '').trim(),
    mirrors: Array.isArray(it.mirrors) ? it.mirrors.filter(x => typeof x === 'string') : [],
    sha256: String(it.sha256 || '').trim().toLowerCase(),
    size: Number(it.size) || 0,
    platforms: Array.isArray(it.platforms) ? it.platforms.slice(0, 12) : []
  }
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length)
  let i = 0
  const workers = new Array(Math.min(limit, list.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++
      if (idx >= list.length) return
      out[idx] = await fn(list[idx], idx)
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * 拉取一个采集站的可用候选（零脚本下载）。
 * @returns {{ok:boolean, entries:Array, total:number, usable:number, noHash:number, error?:string}}
 */
async function fetchHubCandidates(hub, timeoutMs, onLog) {
  const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : 15000
  const base = String((hub && hub.url) || '').trim()
  const kind = (hub && hub.kind) && hub.kind !== 'auto' ? hub.kind : null
  const log = onLog || function () {}
  let entriesUrl = (hub && hub.entriesUrl) || ''
  let detailUrl = (hub && hub.detailUrl) || ''
  let resolvedKind = kind

  // 没存过探测结果就先探一次（首次添加时 /api/hubs/test 已经探过，通常会带上）
  if (!entriesUrl) {
    const det = await detectHub(base, ms)
    if (!det.ok) return { ok: false, entries: [], total: 0, usable: 0, noHash: 0, error: det.error }
    entriesUrl = det.entriesUrl
    detailUrl = det.detailUrl
    resolvedKind = det.kind
  }

  let arr = null
  try {
    const res = await fetchAuto(entriesUrl, { headers: JSON_HEADERS }, ms)
    if (!res || !res.ok) return { ok: false, entries: [], total: 0, usable: 0, noHash: 0, error: 'HTTP ' + (res ? res.status : '不可达') }
    arr = pickArray(JSON.parse(await readText(res, ms)))
  } catch (e) {
    return { ok: false, entries: [], total: 0, usable: 0, noHash: 0, error: String((e && e.message) || e).slice(0, 120) }
  }
  if (!Array.isArray(arr)) return { ok: false, entries: [], total: 0, usable: 0, noHash: 0, error: '返回结构无法识别' }
  if (!resolvedKind) resolvedKind = guessKind(arr[0])

  const usable = arr.filter(it => isSourceScript(it) && isUsable(it, resolvedKind))
  // zlyon 自部署站：列表里没有 url/sha256，要按 id 拉详情补（演示站的 data.json 自带，跳过）
  const needDetail = []
  const entries = []
  for (const it of usable) {
    const c = toCandidate(it, resolvedKind)
    if (c.url && c.sha256.length === 64) { entries.push(c); continue }
    if (detailUrl && it.id) needDetail.push({ id: String(it.id), name: c.name })
  }
  if (needDetail.length) {
    log(`采集站 ${base}：${needDetail.length} 条需拉详情取直链`, '采集', 'info')
    const got = await mapLimit(needDetail, 4, async d => {
      try {
        const r = await fetchAuto(detailUrl + '?id=' + encodeURIComponent(d.id), { headers: JSON_HEADERS }, ms)
        if (!r || !r.ok) return null
        const dd = JSON.parse(await readText(r, ms))
        const c = toCandidate(dd, resolvedKind)
        if (!c.url) return null
        if (!c.name || c.name === '未命名音源') c.name = d.name
        return c
      } catch (e) { return null }
    })
    for (const c of got) if (c) entries.push(c)
  }

  const noHash = entries.filter(c => c.sha256.length !== 64).length
  return { ok: true, entries, total: arr.length, usable: usable.length, noHash, kind: resolvedKind, entriesUrl, detailUrl }
}

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '·').replace(/::/g, '·').trim()
}

/**
 * 候选 → lx-hunter 音源记录（零下载：直接用上游 sha256 当 contentHash）
 * @param {Array} entries fetchHubCandidates 的产出
 * @param {object} hub 采集站配置
 * @param {Set} knownHashes 库内已有的 contentHash
 * @param {Set} usedIds 库内已有的 id（避免同名撞车）
 */
function hubEntriesToSources(entries, hub, knownHashes, usedIds) {
  const hubId = String((hub && hub.id) || 'hub').replace(/[^A-Za-z0-9_-]/g, '')
  const hubName = String((hub && hub.name) || hubId)
  const repo = 'hub/' + hubId
  const now = Date.now()
  const items = []
  const seen = new Set()
  let skippedKnown = 0, skippedDup = 0, skippedNoHash = 0

  for (const c of entries) {
    if (!c.url) { skippedNoHash++; continue }
    if (c.sha256.length !== 64) { skippedNoHash++; continue }   // 免下载的前提是有可信哈希
    if (seen.has(c.sha256)) { skippedDup++; continue }
    seen.add(c.sha256)
    if (knownHashes && knownHashes.has(c.sha256)) { skippedKnown++; continue }

    const base = safeName(c.name) || ('音源-' + c.sha256.slice(0, 6))
    let id = repo + '::' + base + '.js'
    if (usedIds && usedIds.has(id)) id = repo + '::' + base + '-' + c.sha256.slice(0, 8) + '.js'
    if (usedIds) usedIds.add(id)
    items.push({
      id,
      repo,
      path: base + '.js',
      url: c.url,
      name: c.name,
      contentHash: c.sha256,
      size: c.size || 0,
      status: 'unknown',
      suspected: false,
      usable: false,          // 本地尚未检测；由巡检/检测复检后写入真实结果
      addedAt: now,
      lastCheck: 0,
      deep: null,
      // 采集站来源标记：UI 可据此显示「站点已实测」，且便于按来源筛选/回撤
      fromHub: true,
      hubId,
      hubName,
      hubUsable: true,        // 上游实测可用（信任采集站判定，本地复检后置为真实结果）
      hubCheckedAt: now,
      platforms: c.platforms && c.platforms.length ? c.platforms : undefined
    })
  }
  return { items, skippedKnown, skippedDup, skippedNoHash }
}

/**
 * 批量采集：遍历 cfg.hubs 里启用的站点，全部并入音源库。
 * 单个站点失败只记日志，不影响其它站点与整体流程。
 *
 * @param {{store:object, cfg:object, timeoutMs?:number, onLog?:Function, shouldStop?:Function}} o
 * @returns {{added:number, perHub:Array, hubsDone:number, hubTotal:number}}
 */
async function collectFromHubs(o) {
  const store = o.store
  const cfg = o.cfg || {}
  const hubs = Array.isArray(cfg.hubs) ? cfg.hubs.filter(h => h && h.enabled !== false && h.url) : []
  const log = o.onLog || function () {}
  const perHub = []
  let added = 0
  if (!hubs.length) return { added: 0, perHub, hubsDone: 0, hubTotal: 0 }

  const knownHashes = new Set()
  const usedIds = new Set()
  for (const e of store.getSources()) {
    if (e && e.contentHash) knownHashes.add(e.contentHash)
    if (e && e.id) usedIds.add(e.id)
  }

  for (const hub of hubs) {
    if (o.shouldStop && o.shouldStop()) break
    const r = await fetchHubCandidates(hub, o.timeoutMs, log)
    if (!r.ok) {
      log(`采集站「${hub.name || hub.url}」拉取失败：${r.error}`, '采集', 'warn')
      hub.lastSync = { at: Date.now(), ok: false, error: String(r.error || '').slice(0, 120) }
      perHub.push({ id: hub.id, ok: false, error: r.error })
      continue
    }
    const conv = hubEntriesToSources(r.entries, hub, knownHashes, usedIds)
    if (conv.items.length) {
      const n = store.addSources(conv.items)
      for (const it of conv.items) knownHashes.add(it.contentHash)
      added += n
    }
    hub.lastSync = {
      at: Date.now(), ok: true, total: r.total, usable: r.usable,
      added: conv.items.length, known: conv.skippedKnown, dup: conv.skippedDup, noHash: conv.skippedNoHash
    }
    if (r.entriesUrl) hub.entriesUrl = r.entriesUrl
    if (r.detailUrl) hub.detailUrl = r.detailUrl
    if (r.kind) hub.kind = r.kind
    perHub.push({ id: hub.id, name: hub.name, ok: true, total: r.total, usable: r.usable, added: conv.items.length, known: conv.skippedKnown })
    log(`采集站「${hub.name || hub.url}」：可用 ${r.usable} 条，新增 ${conv.items.length} 条（已有 ${conv.skippedKnown}，站内重复 ${conv.skippedDup}，无哈希 ${conv.skippedNoHash}）`, '采集')
  }
  if (store.saveDb) store.saveDb()
  if (store.saveConfig) store.saveConfig({ hubs: cfg.hubs })
  return { added, perHub, hubsDone: hubs.length, hubTotal: hubs.length }
}

/** 生成采集站 id：站点域名 + 短随机，保证唯一且可读 */
function makeHubId(url) {
  let host = ''
  try { host = new URL(String(url)).hostname.replace(/^www\./, '') } catch (e) { host = 'hub' }
  const slug = String(host || 'hub').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 24)
  return slug + '-' + Math.random().toString(36).slice(2, 6)
}

module.exports = {
  detectHub, fetchHubCandidates, hubEntriesToSources, collectFromHubs,
  makeHubId, isUsable, isSourceScript, KIND_LABELS
}
