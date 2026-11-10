'use strict'
/* 音源猎手 PC 版 — 渲染进程 */

const PLAT = [
  { k: 'wy', t: '网易' }, { k: 'tx', t: 'QQ' }, { k: 'kw', t: '酷我' },
  { k: 'kg', t: '酷狗' }, { k: 'mg', t: '咪咕' }
]
const PAGE_SIZE = 50

// 表格排序（v1.7.3）：纯函数在 sorters.js，渲染进程与单测共用同一份口径。
// 注意：loadSort 会在下面的 state 字面量里调用，相关声明必须放在 state 之前——
// const 在声明执行前处于 TDZ，被 try/catch 吞掉后会静默丢失持久化排序（曾踩坑）。
const LXSort = window.LXSort
const { sortSources, SORT_DEFS, SORT_KEYS, isDeepDead, isCheckedNoSource } = LXSort

// ---------------- 排序（v1.7.3） ----------------
// 表头四列可排序：名称 / 平台可用性 / 来源仓库 / 状态；点表头切换，再点反向。
// 选择持久化到 localStorage（重启后保持）；key 为 null 时按入库顺序。
const SORT_STORE_KEY = 'lxh-sort'
function loadSort() {
  try {
    const s = JSON.parse(localStorage.getItem(SORT_STORE_KEY) || 'null')
    if (s && SORT_KEYS.includes(s.key) && (s.dir === 'asc' || s.dir === 'desc')) return { key: s.key, dir: s.dir }
  } catch (e) {}
  return { key: null, dir: 'asc' }
}
function saveSort() { try { localStorage.setItem(SORT_STORE_KEY, JSON.stringify(state.sort)) } catch (e) {} }

// ---------------- 第三方探针对照（v1.12.1）：列表行内徽章 ----------------

const state = {
  sources: [],
  imported: {},
  patrol: { lastRun: 0 },
  lastCrawl: 0,
  selected: new Set(),
  filter: 'all',
  query: '',
  hideDeprecated: true,
  page: 1,
  results: [],
  installed: [],
  // state.installed 是「哪个账号」的服务端列表（统计卡要据此判断口径，避免拿 A 的列表去显示 B）
  installedFor: null,
  // 断线时「已灌入」页保留上次成功读取的快照：installedAt 记读取时间，
  // installedStale=true 表示当前显示的是旧快照（禁止拿它发删除/停用请求）。
  installedAt: 0,
  installedStale: false,
  // 已灌入页排序：key 为空 = 服务端原顺序；目前只有「状态」一列可排（失效/停用排在前面好批量删）
  insSort: { key: '', dir: 1 },
  // 公共音源清理（v1.7.4）：服务端公开源列表 + 勾选池（只可能是公开源，私有源不在其中）
  pubList: [],
  pubSel: new Set(),
  // 已灌入列表多选删除（v1.8.0）：勾选池装的是服务端音源 id
  insSel: new Set(),
  config: null,
  // 当前账号推送服务端的连通结果（testConn 写）：null=还没测过，true/false=已测。
  // 断线时「已灌入」统计卡与音源库显示的都是本地数据，要给出可见提示，别让人当成实时状态。
  connOk: null,
  // 后端镜像清单（configGet 返回的 mirrors，populateMirrors 会写入），供镜像池变化时重建下拉
  mirrors: null,
  // 多平台多账号（v1.8.0）：平台账号列表与当前选中账号
  platforms: [],
  activePlatformId: null,
  editingAccountId: null,   // 正在编辑的账号 id（null=新建）
  busy: false,
  // 排序：{ key, dir }，key 为空 = 不排序；localStorage 持久化，重启后保持
  sort: loadSort()
}

const $ = id => document.getElementById(id)
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// ---------------- 「已灌入」判定（v1.8.0 按灌入目标算） ----------------
// 为什么不能只看「有没有本地记录」：配了 A、B 两个平台并同时灌入时，只灌过 A 的音源
// 如果一上来就被标成「已灌入」，它就会被「只选未灌入」「检测并灌入」整体排除，
// 永远进不了 B —— 用户看到的「批量灌入时部分音源没灌进去」就是这个。所以这里的口径是
// 「**所有**本次灌入目标账号是否都已有它」，只有全都有才算真的已灌入。

/** 本次灌入的目标账号 id（复用 batchImportTargets，保证与页面上显示的「灌入目标」同一口径） */
function importTargetIds() {
  return batchImportTargets().map(p => p.id)
}

/** 某条灌入记录是否覆盖指定账号（importedTo 优先，兼容 v1.8.0 前只有顶层 platformId 的老记录） */
function importedOn(rec, pid, activeId) {
  if (!rec) return false
  if (Array.isArray(rec.importedTo) && rec.importedTo.some(x => x && x.platformId === pid)) return true
  const top = rec.platformId == null ? activeId : rec.platformId
  return top === pid
}

/**
 * 已灌入状态：'' 没灌过 / 'part' 只灌了部分目标 / 'all' 所有目标都有。
 * 说明：这只是**本地账本**口径，用来提示和筛选；服务端上到底还在不在，由服务端列表决定
 * （核心层已改成「服务端上确实还有那条才跳过」，见 hunter._planImportQueue）。
 */
function importedState(e) {
  const rec = state.imported[e.id]
  if (!rec) return ''
  const t = importTargetIds()
  if (!t.length) return 'all'
  const active = state.activePlatformId
  const hit = t.filter(pid => importedOn(rec, pid, active)).length
  if (!hit) return ''
  return hit === t.length ? 'all' : 'part'
}

/** 给状态排序用的「真的已灌入」映射（只含所有目标账号都有的那些，垫底排序才准） */
function importedRankMap() {
  const out = {}
  for (const id in state.imported) if (importedState({ id })) out[id] = true
  return out
}

/** 已灌入状态徽章文案（part 要写清「还差哪个平台」才不会被误当成已灌完） */
function importedBadge(e) {
  const st = importedState(e)
  if (st === 'all') return '<span class="badge accent">已灌入</span>'
  if (st === 'part') {
    const t = importTargetIds()
    const active = state.activePlatformId
    const rec = state.imported[e.id]
    const miss = t.filter(pid => !importedOn(rec, pid, active))
      .map(pid => { const p = state.platforms.find(x => x.id === pid); return p ? (p.name || p.url) : pid })
    return `<span class="badge warn" title="只灌入到部分目标账号：还缺 ${esc(miss.join('、'))}。\n「只选未灌入」和「检测并灌入」仍会把它算作待灌入，勾选后会补灌到缺的平台。">已灌入 ${t.length - miss.length}/${t.length}</span>`
  }
  return ''
}

/** 本地账本里「在指定账号上有一份」的音源条数（与服务端列表口径对应，用于统计卡） */
function ledgerCountFor(pid) {
  if (!pid) return 0
  let n = 0
  for (const id in state.imported) if (importedOn(state.imported[id], pid, state.activePlatformId)) n++
  return n
}

/**
 * 把本地账本对齐到服务端现状（只做减法）：服务端已经不存在的灌入记录摘掉。
 *
 * 不这么做的话，「删空服务端 → 重新灌入」这条最常规的路会被走死：库里那枚「已灌入」标记
 * 一直挂着 → 「只选未灌入 / 检测并灌入」把它整体排除 → 用户点下去什么都没有发生。
 * list 必须是刚刚成功读到的服务端列表（读失败时不要调用，否则会把整库记录误删）。
 */
async function reconcileLedger(pid, list) {
  if (!pid || !Array.isArray(list)) return
  try {
    const r = await api.serviceReconcile(pid, list.map(s => s && s.id).filter(x => x != null))
    if (r && r.ok && r.data && r.data.changed) {
      state.imported = r.data.imported || state.imported
      renderStats()
      renderTable()   // 音源库里的「已灌入」徽章要跟着消失，否则用户还是选不中
    }
  } catch (e) { /* 对账失败不影响列表展示 */ }
}

/** 服务端音源 id → 本地灌入记录（把巡检结论挂到已灌入页每一行上） */
function ledgerByLxId() {
  const m = new Map()
  for (const rec of Object.values(state.imported || {})) {
    if (!rec) continue
    if (rec.lxId != null) m.set(String(rec.lxId), rec)
    for (const t of (rec.importedTo || [])) if (t && t.lxId != null) m.set(String(t.lxId), rec)
  }
  return m
}

/**
 * 已灌入行的健康状态（状态列排序 + 批量选中失效音源都用它）：
 *  rank 0 = 失效 / 异常（巡检判定不通过，或服务端自己报了非 success）
 *  rank 1 = 已停用（全局禁用，或平台级停用 —— 巡检自动禁用也归这里）
 *  rank 2 = 正常（已启用）
 * 「失效」以**巡检结论**为准：巡检就是专门对已灌入音源做服务端侧复测的那件事，
 * 本地主检的口径（库内那 153 条）不代表服务端上这一条还能不能用。
 */
function insRowState(s, byLxId) {
  const rec = byLxId ? byLxId.get(String(s && s.id)) : null
  const patrol = rec && rec.lastPatrol
  // 停用标记要**每种状态都算**：一条既被巡检判失效、又被巡检自动停用的源，
  // 状态徽章必须同时说清「失效」和「已停用」，不能因为排名靠前就只显示失效。
  const ds = Array.isArray(s && s.disabledSources) ? s.disabledSources : []
  const globalOff = !!(s && s.enabled === false)
  const platformOff = !globalOff && ds.length > 0
  const patrolBad = !!(patrol && patrol.at && !patrol.ok)
  const svcBad = !!(s && s.status && s.status !== 'success')
  const base = { patrol, patrolBad, svcBad, ds, globalOff, platformOff }
  if (patrolBad || svcBad) return Object.assign(base, { rank: 0, kind: 'bad' })
  if (globalOff || platformOff) return Object.assign(base, { rank: 1, kind: 'off' })
  return Object.assign(base, { rank: 2, kind: 'ok' })
}
const INS_RANK_LABEL = ['失效', '停用', '正常']

let toastTimer = null
function toast(msg, kind) {
  const el = $('toast')
  el.textContent = msg
  el.className = 'toast' + (kind ? ' ' + kind : '')
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, 3600)
}

// ---------------- 视图 ----------------
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'))
    $('view-' + btn.dataset.view).classList.add('active')
    if (btn.dataset.view === 'installed') refreshInstalled()
    if (btn.dataset.view === 'quarantine') renderQuarantine()
    if (btn.dataset.view === 'logs') { refreshLogModuleOptions(); applyLogFilter(); startLogPolling() }
    else stopLogPolling()
  })
})

$('themeBtn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = next
  localStorage.setItem('lxh-theme', next)
})
;(function initTheme() {
  const t = localStorage.getItem('lxh-theme')
  if (t) document.documentElement.dataset.theme = t
  else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) document.documentElement.dataset.theme = 'light'
})()

// ---------------- 配置 ----------------
async function loadConfig() {
  const r = await api.configGet()
  if (!r.ok) return toast('读取配置失败: ' + r.error, 'err')
  state.config = r.data.config
  const c = state.config
  // 注意：defaultRepos / mirrors 挂在 r.data 顶层，不在 config 里。
  // v1.9.13 曾误写成 c.mirrors / c.defaultRepos（永远 undefined）→ 镜像下拉只剩「自动/自定义」、
  // 「恢复默认仓库」点了没反应。这里统一从 meta 取。
  const meta = r.data || {}
  state.platforms = Array.isArray(c.platforms) ? c.platforms : []
  state.activePlatformId = c.activePlatformId || (state.platforms[0] && state.platforms[0].id) || null
  renderPlatforms()
  $('cfgToken').value = c.ghToken || ''
  populateMirrors(meta.mirrors, c.mirrorPool)
  $('cfgMirror').value = c.mirror || 'auto'
  // 配置里存了个当前清单没有的 id 时，<select> 会静默变成空值，回落到「自动」更安全
  if (!$('cfgMirror').value) $('cfgMirror').value = 'auto'
  $('cfgMirrorCustom').value = c.mirrorCustom || ''
  $('cfgMirrorCustom').parentNode.style.display = (c.mirror === 'custom') ? '' : 'none'
  $('cfgCrawlProxy').value = c.crawlProxy || ''
  $('cfgProxyPolicy').value = c.proxyPolicy || (c.forceProxy ? 'force' : 'auto')
  if (!$('cfgProxyPolicy').value) $('cfgProxyPolicy').value = 'auto'
  $('cfgUseJsdelivr').checked = c.useJsdelivr !== false
  $('cfgMaxCand').value = c.maxCandidatesPerRepo || 400
  $('cfgConc').value = c.concurrency || 8
  $('cfgTmo').value = c.timeoutMs || 15000
  $('cfgLinkTmo').value = c.linkTimeoutMs || 20000
  $('cfgEnableAfter').checked = c.enableAfterImport !== false
  $('cfgSkipUnusable').checked = c.skipUnusable !== false
  $('cfgExcludeObf').checked = !!c.excludeHighRiskObfuscated
  $('cfgAutoUnsafe').checked = !!c.autoAllowUnsafeVM
  $('cfgQuick').checked = c.quickCheck !== false
  $('cfgSkipChecked').checked = c.skipChecked !== false
  $('cfgHashDedupe').checked = c.hashDedupeAfterCrawl !== false
  $('cfgApiHostCheck').checked = !!c.apiHostCheck
  $('cfgApiHostBackfillMax').value = c.apiHostBackfillMax != null ? c.apiHostBackfillMax : 200
  $('cfgApiHostBackfillBudgetSec').value = Math.round((Number(c.apiHostBackfillBudgetMs) || 180000) / 1000)
  $('cfgPatrolOn').checked = !!c.patrolEnabled
  $('cfgPatrolHours').value = c.patrolIntervalHours || 12
  $('cfgPatrolRetryMinutes').value = c.patrolRetryMinutes || 15
  $('cfgPatrolDisable').checked = c.patrolAutoDisable !== false
  $('cfgPatrolAutoDelete').checked = !!c.patrolAutoDelete
  $('cfgPatrolDeleteAfter').value = c.patrolDeleteAfter || 3
  $('cfgCrawlOn').checked = !!c.crawlScheduleEnabled
  $('cfgCrawlAutoImport').checked = !!c.crawlAutoImport
  $('cfgCrawlHours').value = c.crawlIntervalHours || 24
  $('cfgCrawlSinceDays').value = Math.max(0, Number(c.crawlSinceDays) || 0)
  $('cfgCrawlLatestOnly').checked = c.crawlLatestOnly !== false
  $('cfgReplaceSame').checked = c.replaceSameNameOnImport !== false
  state.defaultRepos = Array.isArray(meta.defaultRepos) ? meta.defaultRepos
    : (Array.isArray(c.defaultRepos) ? c.defaultRepos : [])
  renderRepoList(c.repos, state.defaultRepos)
  renderHubList(c.hubs)
  renderExternalList(c.externalSources)
  renderMirrorPool(c.mirrorPool)
  $('cfgSearchEnabled').checked = !!c.searchEnabled
  $('cfgSearchKeywords').value = (c.searchKeywords || []).join('\n')
  $('cfgMaxReposPerKeyword').value = c.maxReposPerKeyword || 20
  $('cfgMaxSearchReposTotal').value = c.maxSearchReposTotal || 60
  $('cfgSearchMinStars').value = c.searchMinStars || 0
  $('cfgSearchVerify').checked = c.searchVerify !== false
  renderInstalledAccountInfo()
  testConn()
  refreshProxyHealth()
}

// v1.10.8：设置页与「采集源」页共用同一保存逻辑（按 ID 全局收集，两页输入框都在 DOM 里）
async function saveAllCfg() {
  const patch = {
    platforms: state.platforms,
    activePlatformId: state.activePlatformId,
    ghToken: $('cfgToken').value.trim(),
    mirror: $('cfgMirror').value || 'auto',
    mirrorCustom: $('cfgMirrorCustom').value.trim(),
    crawlProxy: $('cfgCrawlProxy').value.trim(),
    proxyPolicy: $('cfgProxyPolicy').value || 'auto',
    forceProxy: $('cfgProxyPolicy').value === 'force',
    useJsdelivr: $('cfgUseJsdelivr').checked,
    maxCandidatesPerRepo: parseInt($('cfgMaxCand').value, 10) || 400,
    concurrency: Math.max(1, Math.min(16, parseInt($('cfgConc').value, 10) || 8)),
    timeoutMs: parseInt($('cfgTmo').value, 10) || 15000,
    linkTimeoutMs: parseInt($('cfgLinkTmo').value, 10) || 20000,
    enableAfterImport: $('cfgEnableAfter').checked,
    skipUnusable: $('cfgSkipUnusable').checked,
    excludeHighRiskObfuscated: $('cfgExcludeObf').checked,
    autoAllowUnsafeVM: $('cfgAutoUnsafe').checked,
    quickCheck: $('cfgQuick').checked,
    skipChecked: $('cfgSkipChecked').checked,
    hashDedupeAfterCrawl: $('cfgHashDedupe').checked,
    apiHostCheck: $('cfgApiHostCheck').checked,
    apiHostBackfillMax: Math.max(0, Math.min(5000, parseInt($('cfgApiHostBackfillMax').value, 10) || 0)),
    apiHostBackfillBudgetMs: Math.max(5000, Math.min(3600000,
      (parseInt($('cfgApiHostBackfillBudgetSec').value, 10) || 180) * 1000)),
    patrolEnabled: $('cfgPatrolOn').checked,
    patrolIntervalHours: Math.max(1, Math.min(720, parseInt($('cfgPatrolHours').value, 10) || 12)),
    patrolRetryMinutes: Math.max(1, Math.min(1440, parseInt($('cfgPatrolRetryMinutes').value, 10) || 15)),
    patrolAutoDisable: $('cfgPatrolDisable').checked,
    patrolAutoDelete: $('cfgPatrolAutoDelete').checked,
    patrolDeleteAfter: Math.max(1, Math.min(20, parseInt($('cfgPatrolDeleteAfter').value, 10) || 3)),
    crawlScheduleEnabled: $('cfgCrawlOn').checked,
    crawlAutoImport: $('cfgCrawlAutoImport').checked,
    crawlIntervalHours: Math.max(1, Math.min(720, parseInt($('cfgCrawlHours').value, 10) || 24)),
    crawlSinceDays: Math.max(0, Math.min(365, parseInt($('cfgCrawlSinceDays').value, 10) || 0)),
    crawlLatestOnly: $('cfgCrawlLatestOnly').checked,
    replaceSameNameOnImport: $('cfgReplaceSame').checked,
    repos: state.config.repos || [],
    searchEnabled: $('cfgSearchEnabled').checked,
    searchKeywords: $('cfgSearchKeywords').value.split(/[\n,]/).map(s => s.trim()).filter(Boolean),
    maxReposPerKeyword: Math.max(1, Math.min(100, parseInt($('cfgMaxReposPerKeyword').value, 10) || 20)),
    maxSearchReposTotal: Math.max(1, Math.min(200, parseInt($('cfgMaxSearchReposTotal').value, 10) || 60)),
    searchMinStars: Math.max(0, parseInt($('cfgSearchMinStars').value, 10) || 0),
    searchVerify: $('cfgSearchVerify').checked
  }
  const r = await api.configSet(patch)
  if (!r.ok) return toast('保存失败: ' + r.error, 'err')
  state.config = r.data
  renderRepoList(state.config.repos, state.defaultRepos)
  renderHubList(state.config.hubs)
  renderExternalList(state.config.externalSources)
  renderInstalledAccountInfo()
  // 保存时把两处「看起来对、实际不会触发」的组合说明白，别让用户以为设好了却没动静：
  //  ① 自动灌入是从属于定时爬取的（没开定时爬取就不会有「爬取结束」这个时机）；
  //  ② 一个「参与批量灌入」都没勾时，自动灌入会回退到当前选中账号（这本身合理，但要说清）。
  const warnAuto = patch.crawlAutoImport && !patch.crawlScheduleEnabled
    ? '。注意：「爬取结束后自动灌入」需要上面「启用定时爬取」也勾上才会触发' : ''
  const warnTarget = patch.crawlAutoImport && !(state.platforms || []).some(p => p && p.batchImport === true)
    ? '。注意：没有账号勾选「参与批量灌入」，自动灌入只会灌到当前选中账号' : ''
  toast('设置已保存（仓库地址已自动规范为 owner/repo 格式）' + warnAuto + warnTarget,
    (warnAuto || warnTarget) ? 'warn' : 'ok')
  testConn()
  refreshProxyHealth()
}
$('btnSaveCfg').addEventListener('click', saveAllCfg)
$('btnSaveCfg2').addEventListener('click', saveAllCfg)

$('btnTestConn').addEventListener('click', () => testConn(true))

// ---------------- 仓库清单管理（v1.9.12：内置/附加/发现三类全部可禁用/删除） ----------------
// 渲染端无法 require crawler，这里做一个等价的轻量规范化（owner/repo 小写、去协议/路径/.git）。
// v1.10.0：非 GitHub 的 http(s) 网址原样放行（网页音源站采集，与核心层 normalizeRepo 口径一致）。
function normRepo(s) {
  let t = String(s || '').trim()
  if (/^https?:\/\//i.test(t)) {
    t = t.replace(/\/+$/, '').replace(/\.git$/i, '')
    const m = t.replace(/^https?:\/\//i, '').match(/^github\.com[\/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/i)
    return m ? (m[1] + '/' + m[2]).toLowerCase() : t
  }
  t = t.toLowerCase().replace(/^https?:\/\//, '').replace(/^git@/, '').replace(/\.git$/, '')
    .replace(/github\.com[/:]/, '').replace(/[:/]+$/, '')
  const m = t.match(/^([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/)
  return m ? (m[1] + '/' + m[2]) : null
}

const ORIGIN_LABEL = { builtin: '内置', custom: '附加', discovered: '发现' }

function renderRepoList(repos, defaultRepos) {
  if (Array.isArray(repos)) state.config.repos = repos
  if (Array.isArray(defaultRepos)) state.defaultRepos = defaultRepos
  const all = (state.config.repos || [])
  const box = $('repoList')
  const cntEl = $('repoSearchCount')
  if (!all.length) { box.innerHTML = '<p class="hint" style="margin:0">清单为空 —— 点「恢复默认仓库」恢复内置 38 个，或在上方输入框添加。</p>'; if (cntEl) cntEl.textContent = ''; renderBlockedRepos(); return }
  // v1.10.3：仓库清单关键字过滤（按仓库名 / owner / 网址 子串匹配，不区分大小写）
  const kw = String(state.repoFilter || '').trim().toLowerCase()
  const list = kw ? all.filter(r => String(r.repo || '').toLowerCase().includes(kw)) : all
  if (cntEl) cntEl.textContent = kw ? `匹配 ${list.length} / 共 ${all.length}` : `共 ${all.length} 个`
  if (!list.length) { box.innerHTML = '<p class="hint" style="margin:0">没有匹配「' + esc(kw) + '」的仓库</p>'; return }
  // 排序：内置在前，其次附加，最后发现；同类按名称
  const order = { builtin: 0, custom: 1, discovered: 2 }
  const sorted = list.slice().sort((a, b) => (order[a.origin] || 3) - (order[b.origin] || 3) || String(a.repo).localeCompare(b.repo))
  box.innerHTML = sorted.map(r => {
    const on = r.enabled !== false
    const o = ORIGIN_LABEL[r.origin] || '附加'
    // v1.10.0：网址形态的条目是「网页音源站」，加绿色「网页」标记以区分 GitHub 仓库
    const isWeb = /^https?:\/\//i.test(String(r.repo))
    const kindTag = isWeb ? '<span class="repo-origin origin-web">网页</span>' : ''
    return `<div class="repo-row" data-repo="${esc(r.repo)}">
      <label class="repo-toggle"><input type="checkbox" class="repo-enabled" ${on ? 'checked' : ''}><span>${on ? '启用' : '已禁用'}</span></label>
      <span class="repo-name">${esc(r.repo)}</span>
      ${kindTag}<span class="repo-origin origin-${esc(r.origin)}">${o}</span>
      <button class="btn btn-sm repo-crawl" title="主动采集：只爬这一个${isWeb ? '网页音源站' : '仓库'}（采集策略按设置：时间窗 + 只收最新版）">采集</button>
      ${isWeb ? '' : `<button class="btn btn-sm danger-ghost repo-block" title="拉黑：移出清单 + 加入黑名单（搜索发现/社区精选不再自动回填）+ 清掉该仓库已采的脚本">拉黑</button>`}
      <button class="btn btn-sm danger-ghost repo-del" title="从清单移除（内置仓库可「恢复默认」找回）">删除</button>
    </div>`
  }).join('')
  renderBlockedRepos()
}

// 仓库黑名单（v1.10.7）：展示 blockedRepos + 一键解除（解除后自动加回清单）
// v1.10.8：<details> 默认收起，标题显示数量，点开才占空间
function renderBlockedRepos() {
  const box = $('blockedBox')
  if (!box) return
  const bl = Array.isArray(state.config.blockedRepos) ? state.config.blockedRepos : []
  if (!bl.length) { box.innerHTML = ''; return }
  const wasOpen = (() => { const d = box.querySelector('details.blocked-details'); return d && d.open })()
  box.innerHTML = `<details class="blocked-details"${wasOpen ? ' open' : ''}>
    <summary title="点开/收起黑名单">仓库黑名单（${bl.length}）——这些仓库已被拉黑：不在清单、搜索发现/社区精选不会自动回填；解除后会自动加回清单恢复采集</summary>
    <div style="margin-top:6px">` +
    bl.map(b => `<div class="repo-row blocked-row" data-repo="${esc(b)}">
      <span class="repo-origin" style="background:#3a2a2a;color:#e8b4b4">已拉黑</span>
      <span class="repo-name">${esc(b)}</span>
      <button class="btn btn-sm blk-unblock" title="解除拉黑：移出黑名单并自动加回仓库清单，恢复采集">解除拉黑</button>
    </div>`).join('') +
    `</div></details>`
}

// 持久化当前清单（就地改 state.config.repos 后调用）
async function persistRepos() {
  const r = await api.configSet({ repos: state.config.repos || [] })
  if (!r.ok) return toast('仓库清单保存失败: ' + r.error, 'err')
  state.config = r.data || state.config
  renderRepoList(state.config.repos, state.defaultRepos)
  return true
}

// 勾选启用/禁用
$('repoList').addEventListener('change', async (ev) => {
  const cb = ev.target.closest('.repo-enabled')
  if (!cb) return
  const row = cb.closest('.repo-row')
  const name = row && row.getAttribute('data-repo')
  const it = (state.config.repos || []).find(x => x.repo === name)
  if (!it) return
  it.enabled = cb.checked
  await persistRepos()
})

// 删除 / 主动采集
$('repoList').addEventListener('click', async (ev) => {
  const crawlBtn = ev.target.closest('.repo-crawl')
  if (crawlBtn) {
    // v1.10.6 主动采集：只爬这一行（GitHub 仓库或网页音源站）。
    // v1.10.7：行级按钮只改变「采哪些仓库」，采集策略仍按设置走（时间窗 / 只收最新版）。
    const row = crawlBtn.closest('.repo-row')
    const name = row && row.getAttribute('data-repo')
    if (!name) return
    if (crawlBtn.disabled) return
    crawlBtn.disabled = true; crawlBtn.textContent = '采集中…'
    setBusy(true)
    $('progStep').textContent = '主动采集 ' + name + ' …'
    try {
      const r = await api.crawlStart({ only: [name] })
      if (r.ok) {
        const d = r.data || {}
        if (!d.added && !d.updated && d.staleSkipped) {
          // 被设置的时间窗挡下：说清原因和改法，别让用户以为按钮失效
          toast(`「${name}」在 ${d.sinceDays} 天内无提交也无新发布，按设置跳过；如需强制采集，把「只爬近期更新的仓库」改为 0`, 'err')
        } else {
          const extra = d.staleSkipped ? `（另有 ${d.staleSkipped} 个仓库在 ${d.sinceDays} 天内无更新被跳过）` : ''
          toast(`「${name}」采集完成：新增 ${d.added} 条、更新 ${d.updated} 条、跳过 ${d.skipped} 条${extra}`, 'ok')
        }
        loadSources()
      } else toast('采集失败: ' + r.error, 'err')
    } finally {
      setBusy(false)
      crawlBtn.disabled = false; crawlBtn.textContent = '采集'
    }
    return
  }
  const btn = ev.target.closest('.repo-del')
  if (btn) {
    const row = btn.closest('.repo-row')
    const name = row && row.getAttribute('data-repo')
    if (!name) return
    state.config.repos = (state.config.repos || []).filter(x => x.repo !== name)
    await persistRepos()
    return
  }
  // v1.10.7 快捷拉黑：移出清单 + 加入黑名单（防搜索发现/社区精选回填）+ 清残留脚本
  const blkBtn = ev.target.closest('.repo-block')
  if (!blkBtn) return
  const row2 = blkBtn.closest('.repo-row')
  const repo = row2 && row2.getAttribute('data-repo')
  if (!repo) return
  if (!confirm('拉黑「' + repo + '」？\n\n'
    + '· 从仓库清单移除\n'
    + '· 加入黑名单（搜索发现/社区精选不会再把它加回来）\n'
    + '· 连带清掉该仓库已采集的脚本（不会自动采回）\n\n'
    + '如只想移出清单、保留回填可能，请用「删除」。')) return
  blkBtn.disabled = true
  try {
    const r = await api.reposBlock(repo)
    if (!r || r.ok === false) throw new Error((r && r.error) || '未知错误')
    const d = r.data || {}
    await loadConfig()
    if (typeof refreshInstalled === 'function') refreshInstalled()
    loadSources()
    toast(`已拉黑「${d.blocked || repo}」：黑名单${d.alreadyBlocked ? '原本就有' : '已加入'}、清理脚本 ${d.removedSources || 0} 条`, 'ok')
  } catch (e) {
    toast('拉黑失败: ' + String((e && e.message) || e), 'err')
    blkBtn.disabled = false
  }
})

// 黑名单「解除拉黑」（v1.10.7）：黑名单区块在 blockedBox 内，事件独立挂（repoList 的委托盖不到它）
document.getElementById('blockedBox').addEventListener('click', async (ev) => {
  const ub = ev.target.closest('.blk-unblock')
  if (!ub) return
  const row = ub.closest('.blocked-row')
  const repo = row && row.getAttribute('data-repo')
  if (!repo) return
  if (!confirm('解除拉黑「' + repo + '」？\n\n· 从黑名单移除\n· 自动加回仓库清单，恢复采集')) return
  ub.disabled = true
  try {
    const r = await api.reposUnblock(repo)
    if (!r || r.ok === false) throw new Error((r && r.error) || '未知错误')
    const d = r.data || {}
    await loadConfig()
    toast(`已解除拉黑「${d.unblocked || repo}」${d.reAdded ? '，已加回仓库清单' : ''}`, 'ok')
  } catch (e) {
    toast('解除拉黑失败: ' + String((e && e.message) || e), 'err')
  } finally {
    ub.disabled = false
  }
})

// 仓库清单关键字搜索（v1.10.3）
{
  const el = $('repoSearch')
  if (el) el.addEventListener('input', () => {
    state.repoFilter = el.value || ''
    renderRepoList()
  })
}

// 登录密码显示/隐藏切换（v1.10.3 小眼睛）
{
  const pwd = $('authPwd'), eye = $('authPwdEye')
  if (pwd && eye) eye.addEventListener('click', (ev) => {
    ev.preventDefault()
    const show = pwd.type === 'password'
    pwd.type = show ? 'text' : 'password'
    eye.textContent = show ? '🙈' : '👁'
    eye.title = show ? '隐藏密码' : '显示密码'
  })
}

// 添加（支持多行/逗号批量）
$('btnAddRepo').addEventListener('click', async () => {
  const raw = $('repoAddInput').value || ''
  const parts = raw.split(/[\n,，\s]+/).map(s => s.trim()).filter(Boolean)
  let added = 0
  const have = new Set((state.config.repos || []).map(x => x.repo))
  for (const p of parts) {
    const n = normRepo(p)
    if (n && !have.has(n)) { state.config.repos.push({ repo: n, enabled: true, builtin: false, origin: 'custom' }); have.add(n); added++ }
  }
  $('repoAddInput').value = ''
  if (!added) return toast('没有可添加的新仓库（可能格式不对或已存在）', 'warn')
  const ok = await persistRepos()
  if (ok) toast('已添加 ' + added + ' 个仓库', 'ok')
})

// ---------------- 站外分发源（v1.11.0）----------------
// Pages / 自建域名 / 对象存储直链。独立清单不进 repos（躲开「清理非音源仓库」的 GitHub 验真误删），
// 由核心层 buildRepoSeeds 并进爬取种子，全量 / 定时 / 行级采集自动覆盖。
function extKindLabel(k) {
  return ({ script: '直链脚本', archive: '直链压缩包', index: '索引页', unchanged: '内容未变' })[String(k || '')] || (k ? String(k) : '未探测')
}
function extStateText(s) {
  const lc = s.lastCrawl || null
  const lp = s.lastProbe || null
  if (!lc) {
    if (!lp) return '尚未采集'
    return lp.ok ? `探测通过：${extKindLabel(lp.kind)} / ${lp.scripts || 0} 个脚本`
      : `探测失败：${esc(String(lp.reason || '').slice(0, 40))}`
  }
  const at = lc.at ? new Date(lc.at).toLocaleString() : ''
  if (lc.mode === 'unchanged') return `上次采集：内容未变，按时间窗跳过（${at}）`
  if (lc.ok) return `上次采集：收入 ${lc.added || 0} 条${lc.skippedOld ? ` / 旧版跳过 ${lc.skippedOld}` : ''}（${at}）`
  return `上次采集失败：${esc(String(lc.reason || '').slice(0, 40))}`
}
function renderExternalList(sources) {
  if (Array.isArray(sources)) state.config.externalSources = sources
  const list = state.config.externalSources || []
  const box = $('externalList')
  if (!box) return
  if (!list.length) {
    box.innerHTML = '<p class="hint" style="margin:0">还没有站外分发源 —— 在下方填 Pages / 自建域名的 .js 直链、分发首页或压缩包地址，点「探测并添加」。</p>'
    return
  }
  box.innerHTML = list.map(s => {
    const on = s.enabled !== false
    const bad = (s.lastProbe && s.lastProbe.ok === false) || (s.lastCrawl && s.lastCrawl.ok === false)
    return `<div class="repo-row" data-ext="${esc(s.url)}">
      <label class="repo-toggle"><input type="checkbox" class="ext-enabled" ${on ? 'checked' : ''}><span>${on ? '启用' : '已禁用'}</span></label>
      <span class="repo-name" title="${esc(s.url)}">${esc(s.name || s.url)}</span>
      <span class="repo-origin origin-external">${esc(extKindLabel(s.kind))}</span>
      <span class="ext-state${bad ? ' is-bad' : ''}">${extStateText(s)}</span>
      <button class="btn btn-sm ext-probe" title="重新下载验真（不入库）">验真</button>
      <button class="btn btn-sm ext-crawl" title="主动采集：只采这一个站外源">采集</button>
      <button class="btn btn-sm danger-ghost ext-del" title="移出清单（已采回的音源保留在库中）">删除</button>
    </div>`
  }).join('')
}

$('externalList').addEventListener('change', async (ev) => {
  const cb = ev.target.closest('.ext-enabled')
  if (!cb) return
  const row = cb.closest('.repo-row')
  const url = row && row.getAttribute('data-ext')
  if (!url) return
  const r = await api.externalsUpdate(url, { enabled: cb.checked })
  if (!r.ok) return toast('站外源状态保存失败: ' + r.error, 'err')
  state.config.externalSources = (r.data && r.data.sources) || state.config.externalSources
  renderExternalList(state.config.externalSources)
})

$('externalList').addEventListener('click', async (ev) => {
  const row = ev.target.closest('.repo-row')
  const url = row && row.getAttribute('data-ext')
  if (!url) return
  const probeBtn = ev.target.closest('.ext-probe')
  if (probeBtn) {
    probeBtn.disabled = true; probeBtn.textContent = '验真中…'
    try {
      const r = await api.externalsProbe(url)
      const d = (r.ok && r.data) ? r.data : null
      if (!d) return toast('验真失败: ' + (r.error || '未知错误'), 'err')
      toast(d.ok ? `验真通过：${extKindLabel(d.kind)}，${(d.scripts || []).length} 个脚本` : '验真未通过：' + (d.reason || '未知原因'), d.ok ? 'ok' : 'err')
    } finally { probeBtn.disabled = false; probeBtn.textContent = '验真' }
    return
  }
  const crawlBtn = ev.target.closest('.ext-crawl')
  if (crawlBtn) {
    if (crawlBtn.disabled) return
    crawlBtn.disabled = true; crawlBtn.textContent = '采集中…'
    setBusy(true)
    $('progStep').textContent = '主动采集站外源 ' + url + ' …'
    try {
      const r = await api.crawlStart({ only: [url] })
      if (!r.ok) return toast('采集失败: ' + r.error, 'err')
      const d = r.data || {}
      toast(`站外源采集完成：新增 ${d.added || 0} 条、更新 ${d.updated || 0} 条、跳过 ${d.skipped || 0} 条`, 'ok')
      loadSources()
      loadConfig()
    } finally {
      setBusy(false)
      crawlBtn.disabled = false; crawlBtn.textContent = '采集'
    }
    return
  }
  const delBtn = ev.target.closest('.ext-del')
  if (!delBtn) return
  if (!confirm('移出站外分发源「' + url + '」？\n\n只移出清单并停止后续采集，已采回的音源保留在库中。')) return
  const r = await api.externalsRemove(url)
  if (!r.ok) return toast('移除失败: ' + r.error, 'err')
  state.config.externalSources = (r.data && r.data.sources) || []
  renderExternalList(state.config.externalSources)
  toast('已移出站外分发源', 'ok')
})

// 探测并添加：先验真（直链脚本 / 压缩包 / 索引页），不是音源不让加
$('btnAddExternal').addEventListener('click', async () => {
  const url = ($('externalAddInput').value || '').trim()
  if (!url) return toast('请填写站外源地址', 'warn')
  const btn = $('btnAddExternal')
  btn.disabled = true; btn.textContent = '探测中…'
  try {
    const t = await api.externalsProbe(url)
    const det = (t.ok && t.data) ? t.data : null
    if (!det) return toast('探测失败: ' + (t.error || '未知错误'), 'err')
    if (!det.ok) return toast('该地址不是可用音源：' + (det.reason || '验真未通过'), 'err')
    const r = await api.externalsAdd(url, det.name, det)
    if (!r.ok) return toast('添加失败: ' + r.error, 'err')
    $('externalAddInput').value = ''
    state.config.externalSources = (r.data && r.data.sources) || []
    renderExternalList(state.config.externalSources)
    toast(`已添加：${extKindLabel(det.kind)}，验真通过 ${(det.scripts || []).length} 个脚本`, 'ok')
  } finally {
    btn.disabled = false; btn.textContent = '探测并添加'
  }
})

// 立即采集全部：only 里只放 URL，runCrawl 会跳过 GitHub 通道，零 API 配额
$('btnCrawlExternals').addEventListener('click', async () => {
  const urls = (state.config.externalSources || []).filter(s => s && s.enabled !== false).map(s => s.url)
  if (!urls.length) return toast('没有启用的站外分发源', 'warn')
  const btn = $('btnCrawlExternals')
  btn.disabled = true; btn.textContent = '采集中…'
  setBusy(true)
  $('progStep').textContent = `采集 ${urls.length} 个站外分发源…`
  try {
    const r = await api.crawlStart({ only: urls })
    if (!r.ok) return toast('采集失败: ' + r.error, 'err')
    const d = r.data || {}
    toast(`站外源采集完成：新增 ${d.added || 0} 条、更新 ${d.updated || 0} 条、跳过 ${d.skipped || 0} 条`, 'ok')
    loadSources()
    loadConfig()
  } finally {
    setBusy(false)
    btn.disabled = false; btn.textContent = '立即采集全部'
  }
})

// ---------------- 音源采集站（v1.9.19）----------------
// 与仓库清单并列的一类音源来源：挂第三方筛选站，由 lx-hunter 自己去采「站点实测可用」的音源。
function hubKindLabel(k) {
  return ({ deerwan: 'deerwan 系', zlyon: 'zlyon 系', 'zlyon-flat': 'zlyon 系' })[String(k || '')] || (k ? String(k) : '未识别')
}

function renderHubList(hubs) {
  if (Array.isArray(hubs)) state.config.hubs = hubs
  const list = state.config.hubs || []
  const box = $('hubList')
  if (!box) return
  if (!list.length) {
    box.innerHTML = '<p class="hint" style="margin:0">还没有采集站 —— 在下方输入框填站点地址，点「探测并添加」。</p>'
    return
  }
  box.innerHTML = list.map(h => {
    const on = h.enabled !== false
    const ls = h.lastSync || null
    const stat = !ls ? '尚未采集'
      : (ls.ok ? `上次采集：新增 ${ls.added || 0} 条（可用 ${ls.usable || 0} / 共 ${ls.total || 0}，已有 ${ls.known || 0}）`
        : '上次采集失败：' + esc(String(ls.error || '').slice(0, 40)))
    return `<div class="repo-row" data-hub="${esc(h.id)}">
      <label class="repo-toggle"><input type="checkbox" class="hub-enabled" ${on ? 'checked' : ''}><span>${on ? '启用' : '已禁用'}</span></label>
      <span class="repo-name" title="${esc(h.url)}">${esc(h.name || h.url)}</span>
      <span class="repo-origin origin-custom">${hubKindLabel(h.kind)}</span>
      <span class="hint" style="flex:1;min-width:0">${stat}</span>
      <button class="btn btn-sm hub-sync" title="主动采集：只采这一个站点的可用音源（判重零下载，不耗 GitHub 配额）">采集</button>
      <button class="btn btn-sm danger-ghost hub-del" title="移除该采集站（已采回的音源保留在库中）">删除</button>
    </div>`
  }).join('')
}

$('hubList').addEventListener('change', async (ev) => {
  const cb = ev.target.closest('.hub-enabled')
  if (!cb) return
  const row = cb.closest('.repo-row')
  const id = row && row.getAttribute('data-hub')
  const r = await api.hubsUpdate({ id, enabled: cb.checked })
  if (!r.ok) return toast('采集站状态保存失败: ' + r.error, 'err')
  state.config.hubs = r.data.hubs
  renderHubList(state.config.hubs)
})

$('hubList').addEventListener('click', async (ev) => {
  const syncBtn = ev.target.closest('.hub-sync')
  if (syncBtn) {
    // v1.10.6 主动采集：只采这一行采集站（判重零下载，毫秒级到秒级）
    const row = syncBtn.closest('.repo-row')
    const id = row && row.getAttribute('data-hub')
    if (!id) return
    if (syncBtn.disabled) return
    syncBtn.disabled = true; syncBtn.textContent = '采集中…'
    setBusy(true)
    $('progStep').textContent = '主动采集采集站…'
    try {
      const r = await api.hubsSync({ id })
      if (r.ok) {
        toast(`采集站采集完成：新增 ${r.data.added || 0} 条`, 'ok')
        loadSources()
      } else toast('采集失败: ' + r.error, 'err')
    } finally {
      setBusy(false)
      syncBtn.disabled = false; syncBtn.textContent = '采集'
    }
    return
  }
  const btn = ev.target.closest('.hub-del')
  if (!btn) return
  const row = btn.closest('.repo-row')
  const id = row && row.getAttribute('data-hub')
  if (!id) return
  const r = await api.hubsRemove(id)
  if (!r.ok) return toast('移除失败: ' + r.error, 'err')
  state.config.hubs = r.data.hubs
  renderHubList(state.config.hubs)
  toast('已移除采集站', 'ok')
})

// 探测并添加：先试站点能否识别，识别成功才入库
$('btnAddHub').addEventListener('click', async () => {
  const url = ($('hubAddInput').value || '').trim()
  if (!url) return toast('请填写采集站地址', 'warn')
  const btn = $('btnAddHub')
  btn.disabled = true
  btn.textContent = '探测中…'
  try {
    // 先探测（拿到类型与可用条数），再把结果带给添加接口，避免同一个站探测两遍
    const t = await api.hubsTest(url)
    const det = (t.ok && t.data) ? t.data : null
    if (det && det.ok === false) return toast('无法识别为音源采集站：' + (det.error || '未知原因'), 'err')
    const r = await api.hubsAdd(url, '', det)
    if (!r.ok || !r.data || r.data.ok === false) {
      return toast('添加失败：' + ((r.data && r.data.error) || r.error || '未知原因'), 'err')
    }
    $('hubAddInput').value = ''
    state.config.hubs = r.data.hubs
    renderHubList(state.config.hubs)
    const d = r.data.detect || {}
    toast(`已添加：${hubKindLabel(d.kind)}，实测可用 ${d.usable}/${d.total} 条`, 'ok')
  } finally {
    btn.disabled = false
    btn.textContent = '探测并添加'
  }
})

// 立即采集一轮（不跑 GitHub 爬取）
$('btnSyncHubs').addEventListener('click', async () => {
  const btn = $('btnSyncHubs')
  btn.disabled = true
  btn.textContent = '采集中…'
  try {
    const r = await api.hubsSync()
    if (!r.ok) return toast('采集失败：' + r.error, 'err')
    const d = r.data || {}
    const hubs = (d.perHub || []).map(x => `${x.name || x.id}: +${x.added || 0}`).join('，')
    toast(d.added ? `采集完成：新增 ${d.added} 条（${hubs}）` : '采集完成：没有新增（都已在库中）', d.added ? 'ok' : 'warn')
    loadSources()
  } finally {
    btn.disabled = false
    btn.textContent = '立即采集'
  }
})

// 清除搜索发现的仓库（v1.9.14）：早期版本用了 in:readme 搜索，把一堆无关仓库（ebooks、
// awesome-*、教程类）收了进来，既浪费配额又占清单。这里一次性把它们移出清单。
// 只删 origin==='discovered' 的条目：内置与你自己添加的不受影响。
$('btnClearDiscovered').addEventListener('click', async () => {
  const all = state.config.repos || []
  const keep = all.filter(x => x.origin !== 'discovered')
  const removed = all.length - keep.length
  if (!removed) return toast('清单里没有搜索发现的仓库', 'warn')
  if (!confirm(`将移除 ${removed} 个「搜索发现」的仓库，内置仓库和你手动添加的不会动。继续？`)) return
  state.config.repos = keep
  const ok = await persistRepos()
  if (ok) toast('已清除 ' + removed + ' 个搜索发现的仓库', 'ok')
})

// 清理非音源仓库脚本（v1.10.3）：自动发现难免把「播放器 / 客户端 / 管理器 / 网关」混进清单，
// 它们夹带的 App 内置脚本（app/src/main/assets/**）、user-api-preload.js、docs 教程压缩包
// 都会被当成音源收进库（2026-11-07 实测 16 个仓库带来 695 条垃圾脚本）。此前没有清理手段。
// 这里一键：验真 → 移出仓库 → 连带删除它贡献的脚本（记入删除名单）→ 拉黑，避免下次又被发现加回。
$('btnPruneNonSource').addEventListener('click', async () => {
  const cand = (state.config.repos || []).filter(x => x.origin !== 'builtin').length
  if (!cand) return toast('清单里没有可验真的非内置仓库', 'warn')
  if (!confirm(`将逐个验真 ${cand} 个非内置仓库（消耗 GitHub 配额，可能需要一两分钟）：\n\n` +
    '· 把「播放器 / 客户端 / 管理器 / 网关」等非音源仓库移出清单\n' +
    '· 连带删除这些仓库贡献的脚本（删掉后不会再自动采回来）\n' +
    '· 内置仓库不动；限流 / 临时失败会跳过，不误删\n\n继续？')) return
  const btn = $('btnPruneNonSource')
  const old = btn.textContent
  btn.disabled = true
  btn.textContent = '验真中…'
  try {
    const r = await api.reposPrune({ limit: 60 })
    if (!r || r.ok === false) throw new Error((r && r.error) || '未知错误')
    const d = r.data || r
    // 后端已改过清单与音源库，重新拉一遍，避免前端旧 state 覆盖回去
    await loadConfig()
    if (typeof refreshInstalled === 'function') refreshInstalled()
    const renamed = d.renamedRepos || []
    toast(`清理完成：移除仓库 ${(d.removedRepos || []).length} 个、删除脚本 ${d.removedSources || 0} 条` +
      (renamed.length ? `；清理改名重复 ${renamed.length} 个（${renamed.slice(0, 3).map(x => `${x.from} → ${x.to}`).join('、')}${renamed.length > 3 ? '…' : ''}）` : '') +
      (d.skipped ? `（临时失败跳过 ${d.skipped} 个，可再点一次）` : '') +
      (d.unchecked ? `，还有 ${d.unchecked} 个未验真，可再点一次继续` : ''), 'ok')
  } catch (e) {
    toast('清理失败：' + String((e && e.message) || e), 'err')
  } finally {
    btn.disabled = false
    btn.textContent = old
  }
})

// 恢复默认仓库：把内置清单里缺失的重新加回并启用（已有的保留用户设置）
$('btnRestoreRepos').addEventListener('click', async () => {
  const defs = state.defaultRepos || []
  const have = new Set((state.config.repos || []).map(x => x.repo))
  let added = 0
  for (const d of defs) {
    const n = normRepo(d)
    if (!n || have.has(n)) continue
    state.config.repos.push({ repo: n, enabled: true, builtin: true, origin: 'builtin' }); have.add(n); added++
  }
  const ok = await persistRepos()
  if (ok) toast(added ? ('已恢复 ' + added + ' 个内置仓库') : '内置仓库已齐全，无需恢复', 'ok')
})

// raw 加速镜像选「自定义…」时才露出基址输入框
$('cfgMirror').addEventListener('change', () => {
  $('cfgMirrorCustom').parentNode.style.display = ($('cfgMirror').value === 'custom') ? '' : 'none'
})

// ---------------- raw 加速镜像下拉 + 测速（v1.9.13） ----------------
// 下拉项由后端 MIRROR_PRESETS 动态生成：以后新增/剔除镜像只改 net.js，不用再动 HTML。
// 兜底清单：后端没给 mirrors（旧服务端/接口异常）时也要能选，绝不让下拉变空
const MIRROR_FALLBACK = [
  { id: 'direct', label: '直连 GitHub' },
  { id: 'ghfast', label: 'ghfast.top' },
  { id: 'ghproxy', label: 'gh-proxy.com' },
  { id: 'ghproxy-net', label: 'ghproxy.net' },
  { id: 'lhlone', label: 'gh1.lhl.one' },
  { id: 'jsdelivr', label: 'jsDelivr CDN' }
]

function populateMirrors(list, pool) {
  const sel = $('cfgMirror')
  if (!sel) return
  const use = (Array.isArray(list) && list.length) ? list : MIRROR_FALLBACK
  state.mirrors = use
  // 保留首尾两个固定项（自动 / 自定义），中间整段替换为镜像清单
  const head = sel.querySelector('option[value="auto"]')
  const tail = sel.querySelector('option[value="custom"]')
  for (const o of Array.from(sel.options)) {
    if (o !== head && o !== tail) o.remove()
  }
  for (const g of Array.from(sel.querySelectorAll('optgroup'))) g.remove()
  const mk = (m) => {
    const op = document.createElement('option')
    op.value = m.id
    op.textContent = m.label
    return op
  }
  for (const m of use) {
    const op = mk(m)
    if (tail) sel.insertBefore(op, tail)
    else sel.appendChild(op)
  }
  // v1.9.20：自动发现的镜像池作为独立分组参与下拉，可像内置镜像一样固定选用
  const poolList = (Array.isArray(pool) ? pool : [])
    .filter(m => m && m.base && m.enabled !== false && /^https?:\/\//i.test(m.base))
    .sort((a, b) => (a.ms || 9e9) - (b.ms || 9e9))
  if (poolList.length && tail) {
    const g = document.createElement('optgroup')
    g.label = '自动发现（镜像池）'
    for (const m of poolList) {
      g.appendChild(mk({ id: m.id, label: (m.label || m.base) + (m.ms ? `（${m.ms}ms）` : '') }))
    }
    sel.insertBefore(g, tail)
  }
}

/** 渲染测速结果：每个镜像一行，含耗时/状态与「选用」按钮 */
function renderMirrorSpeeds(res) {
  const box = $('mirrorSpeedList')
  const tip = $('mirrorTestResult')
  if (!box) return
  const list = (res && res.results) || []
  if (!list.length) { box.hidden = true; box.innerHTML = ''; if (tip) tip.textContent = '没有可测的镜像（可能都已被开关排除）'; return }
  const fastest = list.find(r => r.status != null)
  box.innerHTML = list.map(r => {
    const good = r.status != null
    const st = good ? ('HTTP ' + r.status) : '不通'
    const detail = good ? '' : ('：' + esc(r.error || '连接失败'))
    const cls = !good ? 'ms-down' : (r.ok ? 'ms-up' : 'ms-warn')
    const pick = `<button class="btn sm" data-mirror="${esc(r.id)}">选用</button>`
    return `<div class="ms-row ${cls}">
        <span class="ms-name">${esc(r.label)}</span>
        <span class="ms-ms">${good ? r.ms + ' ms' : '—'}</span>
        <span class="ms-st">${st}${detail}</span>
        ${pick}
      </div>`
  }).join('')
  box.hidden = false
  box.querySelectorAll('button[data-mirror]').forEach(b => {
    b.addEventListener('click', () => {
      $('cfgMirror').value = b.getAttribute('data-mirror')
      $('cfgMirrorCustom').parentNode.style.display = ($('cfgMirror').value === 'custom') ? '' : 'none'
      toast('已选用「' + b.closest('.ms-row').querySelector('.ms-name').textContent + '」，记得点保存', 'ok')
    })
  })
  if (tip) {
    tip.textContent = fastest
      ? `测速完成：最快为「${fastest.label}」${fastest.ms}ms。点某行「选用」即可固定（选后需保存）。`
      : '测速完成：所有镜像均不通（可能是网络/代理问题，或镜像已失效）。'
  }
}

$('btnMirrorTest').addEventListener('click', async () => {
  const tip = $('mirrorTestResult')
  const btn = $('btnMirrorTest')
  if (tip) tip.textContent = '正在逐个镜像测速…（每个最多 8 秒）'
  if (btn) btn.disabled = true
  try {
    const r = await api.mirrorTest({
      mirrorCustom: $('cfgMirrorCustom').value.trim(),
      crawlProxy: $('cfgCrawlProxy').value.trim(),
      useJsdelivr: $('cfgUseJsdelivr').checked
    })
    if (!r.ok) { if (tip) tip.textContent = '测速失败：' + (r.error || '未知错误'); return }
    renderMirrorSpeeds(r.data)
  } catch (e) {
    if (tip) tip.textContent = '测速失败：' + String((e && e.message) || e)
  } finally {
    if (btn) btn.disabled = false
  }
})

// ---------------- 加速镜像自动发现（v1.9.19）----------------
// 内置镜像写死在代码里，第三方反代域名说关就关。这里实测一批公开反代域名：
// 通的自动进池作为兜底候选，池内连续失败 N 次的自动剔除（直连不参与，也不可能被删）。
function renderMirrorPool(pool) {
  const box = $('mirrorPoolList')
  if (!box) return
  const list = Array.isArray(pool) ? pool : []
  // 池子变化（发现/启停/移除/导入）后同步刷新镜像下拉的「自动发现（镜像池）」分组
  populateMirrors(state.mirrors, list)
  if (!list.length) { box.hidden = true; box.innerHTML = ''; return }
  box.innerHTML = list.slice().sort((a, b) => (a.ms || 9e9) - (b.ms || 9e9)).map(m => {
    const off = m.enabled === false
    const when = m.lastOk ? new Date(m.lastOk).toLocaleString('zh-CN', { hour12: false }) : '—'
    return `<div class="ms-row ${off ? 'ms-down' : 'ms-up'}" data-mp="${esc(m.id)}">
        <span class="ms-name" title="${esc(m.base)}">${esc(m.label || m.base)}</span>
        <span class="ms-ms">${m.ms ? m.ms + ' ms' : '—'}</span>
        <span class="ms-st">实测于 ${esc(when)}${m.failStreak ? `，连续失败 ${m.failStreak} 次` : ''}</span>
        <button class="btn sm" data-mp-toggle="${esc(m.id)}">${off ? '启用' : '禁用'}</button>
        <button class="btn sm" data-mp-del="${esc(m.id)}">移除</button>
      </div>`
  }).join('')
  box.hidden = false
  box.querySelectorAll('button[data-mp-toggle]').forEach(b => {
    b.addEventListener('click', async () => {
      const id = b.getAttribute('data-mp-toggle')
      const cur = (state.config.mirrorPool || []).find(x => x.id === id)
      const r = await api.mirrorPoolSet({ enable: { [id]: cur ? cur.enabled === false : false } })
      if (!r.ok) return toast('操作失败: ' + r.error, 'err')
      state.config.mirrorPool = r.data.pool
      renderMirrorPool(state.config.mirrorPool)
    })
  })
  box.querySelectorAll('button[data-mp-del]').forEach(b => {
    b.addEventListener('click', async () => {
      const r = await api.mirrorPoolSet({ remove: [b.getAttribute('data-mp-del')] })
      if (!r.ok) return toast('移除失败: ' + r.error, 'err')
      state.config.mirrorPool = r.data.pool
      renderMirrorPool(state.config.mirrorPool)
    })
  })
}

$('btnMirrorDiscover').addEventListener('click', async () => {
  const tip = $('mirrorDiscoverResult')
  const btn = $('btnMirrorDiscover')
  if (btn) { btn.disabled = true; btn.textContent = '发现中…' }
  if (tip) tip.textContent = '正在实测候选镜像（每个最多 8 秒）…'
  try {
    const r = await api.mirrorDiscover({ force: true })
    if (!r.ok) { if (tip) tip.textContent = '发现失败：' + (r.error || '未知错误'); return }
    const d = r.data || {}
    state.config.mirrorPool = d.pool || []
    renderMirrorPool(state.config.mirrorPool)
    if (tip) {
      const ok = (d.results || []).filter(x => x.ok).length
      tip.textContent = `实测 ${d.total} 个候选：可用 ${ok} 个，新入池 ${d.added} 个，剔除失效 ${d.removed} 个，保留 ${d.kept} 个`
    }
  } catch (e) {
    if (tip) tip.textContent = '发现失败：' + String((e && e.message) || e)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '自动发现镜像' }
  }
})

// 网络连通性测试：按当前表单里的设置（未保存也行）跑一遍完整候选链
$('btnNetTest').addEventListener('click', async () => {
  const el = $('netTestResult')
  el.textContent = '测试中…（依次尝试各通道，可能需要十几秒）'
  try {
    const r = await api.netTest({
      mirror: $('cfgMirror').value,
      mirrorCustom: $('cfgMirrorCustom').value.trim(),
      crawlProxy: $('cfgCrawlProxy').value.trim(),
      proxyPolicy: $('cfgProxyPolicy').value || 'auto',
      useJsdelivr: $('cfgUseJsdelivr').checked
    })
    if (!r.ok) { el.textContent = '测试失败：' + (r.error || '未知错误'); return }
    const d = r.data || {}
    const detail = (d.attempts || []).map(a => `${a.mirror}：${a.error ? '失败（' + a.error + '）' : 'HTTP ' + a.status} ${a.ms}ms`).join('；')
    // 404 特殊说明：能收到 404 说明这条通道本身是通的（连接、TLS、代理都正常），
    // 只是探针文件不存在；真正不通的通道报的是超时/连接错误
    const reached = (d.attempts || []).filter(a => a.status != null && a.status !== 404)
    const notFound = (d.attempts || []).filter(a => a.status === 404)
    const verdict = d.ok
      ? `可用：经「${d.via}」取到探针文件（HTTP ${d.status}）`
      : reached.length
        ? '未取到探针文件，但以下通道本身是通的（连接正常，被目标拒了内容）'
        : notFound.length
          ? '未取到探针文件，但收到 404 的通道本身是通的（连接正常，只是文件不在/仓库私有）'
          : '全部通道均失败（连接层面不通：超时/被拒/代理不可用）'
    el.textContent = verdict + (detail ? ' —— ' + detail : '')
    if (d.ok && d.via === 'proxy') toast('代理通道可用', 'ok')
  } catch (e) {
    el.textContent = '测试失败：' + String((e && e.message) || e)
  }
})

// 爬取代理有效性检测（v1.9.20）：只验证代理本身（隧道 + 取回响应 + 耗时），附直连对照
$('btnProxyTest').addEventListener('click', async () => {
  const el = $('proxyTestResult')
  const btn = $('btnProxyTest')
  if (!el) return
  const proxy = $('cfgCrawlProxy').value.trim()
  if (!proxy) { el.textContent = '请先填写爬取代理（格式 http://host:port）'; return }
  el.textContent = '正在测试代理…（最多 10 秒）'
  if (btn) btn.disabled = true
  try {
    const r = await api.proxyTest({ proxy })
    if (!r.ok) { el.textContent = '测试失败：' + (r.error || '未知错误'); return }
    const d = r.data || {}
    const via = d.ok
      ? `代理可用：HTTP ${d.status}，耗时 ${d.ms}ms`
      : `代理不可用：${d.error || '未知原因'}`
    const direct = d.directOk === true
      ? `；直连对照：可用（${d.directMs}ms）`
      : '；直连对照：不可用（此时开代理收益最大）'
    el.textContent = via + direct
    if (d.ok) toast('代理可用（' + d.ms + 'ms）', 'ok')
    else toast('代理不可用：' + (d.error || '未知原因'), 'err')
    refreshProxyHealth()   // 测试成功会清掉熔断，失败则把状态刷新给用户看
  } catch (e) {
    el.textContent = '测试失败：' + String((e && e.message) || e)
  } finally {
    if (btn) btn.disabled = false
  }
})

// ---------------- 代理健康状态（v1.11.0：熔断/退避可见、可手动恢复） ----------------
async function refreshProxyHealth() {
  const el = $('proxyHealthTip')
  const btn = $('btnProxyHealthReset')
  if (!el || !api.proxyHealth) return
  try {
    const r = await api.proxyHealth()
    if (!r.ok) { el.textContent = '代理状态：读取失败（' + (r.error || '未知错误') + '）'; return }
    const h = r.data || {}
    const mins = Math.ceil((Number(h.cooldownRemainingMs) || 0) / 60000)
    const map = {
      unset: ['未配置代理（任何链路都不会使用代理）', 'is-off'],
      off: ['策略「关闭」：任何链路都不用代理（地址保留）', 'is-off'],
      invalid: ['代理地址格式无效（应为 http://host:port）', 'is-warn'],
      healthy: ['正常（' + (h.policy || 'auto') + ' 策略，连续失败 0/' + (h.failThreshold || 3) + '）', 'is-ok'],
      degraded: ['可疑（连续失败 ' + h.fails + '/' + (h.failThreshold || 3) + '，失败自动回退直连）', 'is-warn'],
      cooldown: ['已临时停用：连续失败触发熔断，约 ' + mins + ' 分钟后半开重试（期间全部直连）', 'is-warn'],
      'half-open': ['半开重试中：正在验证代理是否恢复', 'is-warn']
    }
    const hit = map[h.state] || ['状态未知', 'is-off']
    el.textContent = '代理状态：' + hit[0] + (h.lastError ? '｜最后错误：' + h.lastError : '')
    el.className = 'hint proxy-health ' + hit[1]
    if (btn) btn.hidden = !(h.state === 'cooldown' || h.state === 'degraded' || h.state === 'half-open')
  } catch (e) {
    el.textContent = '代理状态：读取失败（' + String((e && e.message) || e) + '）'
  }
}

$('btnProxyHealthReset').addEventListener('click', async () => {
  const btn = $('btnProxyHealthReset')
  if (btn) btn.disabled = true
  try {
    const r = await api.proxyHealthReset()
    if (!r.ok) return toast('恢复失败：' + (r.error || '未知错误'), 'err')
    toast('已重置熔断状态，下次请求会重新尝试代理', 'ok')
    await refreshProxyHealth()
  } catch (e) {
    toast('恢复失败：' + String((e && e.message) || e), 'err')
  } finally {
    if (btn) btn.disabled = false
  }
})

// 设置页开着时低频刷新（30s）：采集过程中触发熔断也能及时显示，不做高频轮询
setInterval(() => { if (!document.hidden) refreshProxyHealth() }, 30000)

async function testConn(explicit) {
  const chip = $('connChip'), txt = $('connText')
  const active = state.platforms.find(p => p.id === state.activePlatformId)
  if (!active) {
    chip.className = 'conn err'
    txt.textContent = '未配置账号'
    chip.title = '尚未配置服务平台账号：音源库与统计卡显示的是本地数据'
    state.connOk = false
    renderStats()
    if (explicit) toast('请先在「服务平台账号」里添加并选中一个账号', 'err')
    return
  }
  chip.className = 'conn'
  txt.textContent = '连接中…'
  const r = await api.serviceTest(active)
  if (r.ok && r.data && r.data.ok) {
    chip.className = 'conn on'
    txt.textContent = '已连接'
    chip.title = '推送服务端已连接'
    state.connOk = true
    if (explicit) toast('连接成功：' + r.data.msg, 'ok')
  } else {
    chip.className = 'conn err'
    txt.textContent = '未连接'
    chip.title = '推送服务端未连接：音源库与「已灌入」统计显示的是本地数据 / 上次成功读取的列表，不代表服务端现状'
    state.connOk = false
    if (explicit) toast('连接失败：' + ((r.data && r.data.msg) || r.error), 'err')
  }
  renderStats()
}

// ---------------- 多平台账号管理（v1.8.0） ----------------
const PLATFORM_TYPES = {
  lxserver: 'LX Server（自建服务）',
  geelonn: 'Geelonn LX Server（gefl24/lxserver）',
  songloft: 'Songloft（lxmusic 插件）',
  musicsync: 'MusicSync（多用户同步）'
}

async function persistPlatforms() {
  const r = await api.configSet({ platforms: state.platforms, activePlatformId: state.activePlatformId })
  if (r.ok) state.config = r.data
  return r
}

function renderPlatforms() {
  const box = $('platformList')
  if (!box) return
  box.innerHTML = ''
  if (!state.platforms.length) {
    box.innerHTML = '<p class="muted">还没有配置任何服务平台账号。点下方「+ 添加账号」开始。</p>'
    return
  }
  for (const p of state.platforms) {
    const active = p.id === state.activePlatformId
    const row = document.createElement('div')
    row.className = 'acct-row' + (active ? ' active' : '')
    const typeLabel = PLATFORM_TYPES[p.type] || p.type
    row.innerHTML = `
      <div class="acct-main">
        <span class="acct-dot ${p.type}"></span>
        <div class="acct-meta">
          <div class="acct-name">${esc(p.name || p.url)} ${active ? '<span class="badge ok">当前</span>' : ''}${p.batchImport ? '<span class="badge accent" title="已勾选「参与批量灌入」：批量灌入时会同时灌到这个账号">批量灌入</span>' : ''}</div>
          <div class="acct-sub">${esc(typeLabel)} · ${esc(p.url || '（未填地址）')} · ${esc(acctSinkText(p))}</div>
        </div>
      </div>
      <div class="acct-ops">
        ${active ? '' : '<button class="btn sm" data-act="active" data-id="' + esc(p.id) + '">设为当前</button>'}
        <button class="btn sm" data-act="edit" data-id="${esc(p.id)}">编辑</button>
        <button class="btn sm danger-ghost" data-act="del" data-id="${esc(p.id)}">删除</button>
      </div>`
    box.appendChild(row)
  }
  box.querySelectorAll('button[data-act]').forEach(b => {
    b.addEventListener('click', () => {
      const id = b.dataset.id
      if (b.dataset.act === 'active') setActiveAccount(id)
      else if (b.dataset.act === 'edit') openAccountForm(id)
      else if (b.dataset.act === 'del') deleteAccount(id)
    })
  })
}

/** 账号列表副标题里的「落点」文案：留空/default → 公开源；具名 → 该账号私有 */
function acctSinkText(p) {
  if (!p) return ''
  const u = String(p.username || '').trim()
  if (p.type === 'geelonn' || p.type === 'lxserver') {
    return (!u || /^(default|open|_open)$/i.test(u)) ? '落点：公开源' : `落点：${u}（私有）`
  }
  return u ? `账号：${u}` : '未填账号'
}

/** 账号表单随平台类型切换的说明（用户名＝落点 & 登录账号的差别最容易踩坑，写清楚） */
function updateAccHint(type) {
  const el = $('accHint')
  if (!el) return
  const u = $('accUser')
  const lg = $('accLogin')
  if (type === 'geelonn') {
    u.placeholder = '留空或 default＝公开源；填 admin 等账号名＝该账号私有列表'
    lg.placeholder = 'Geelonn 登录账号；留空默认 admin'
    el.innerHTML = '<b>Geelonn LX Server 两个身份是分开的：</b>'
      + '<br>① <b>用户名＝灌入落点</b>：<b>留空或填 default → 灌到「公开源」</b>（所有 LX 客户端可见、网页端公开列表能看到）；<b>填 admin 等账号名 → 灌到该账号的「私有列表」</b>（只有该账号能用，网页端公开列表看不到）。'
      + '<br>② <b>登录账号 + 密码＝鉴权</b>：这个 fork 必须用<b>真实存在的账号</b>登录才能写音源（<code>default</code> 无法登录），所以留空时默认用 <code>admin</code>；只有当你的管理员账号不叫 <code>admin</code> 时才需要填。'
      + '<br>例：用户名留空 + 登录账号留空 + 密码 <code>你的后台密码</code> → 音源进公开源；用户名填 <code>admin</code> → 音源进 admin 私有列表。'
  } else if (type === 'lxserver') {
    u.placeholder = '留空或 default＝公开源；填账号名＝该账号私有列表'
    lg.placeholder = 'LX Server 不需要，留空即可'
    el.innerHTML = '<b>LX Server（原版）</b>：「用户名」＝灌入落点（留空或 <code>default</code> → 公开源；填账号名 → 该账号私有列表）；「密码」填服务端配置里的 <code>frontend.password</code>（<b>不是</b>网页登录密码）。「登录账号」对 LX Server 无效，可留空。'
  } else {
    u.placeholder = '填写该平台的登录账号'
    lg.placeholder = '该平台不需要，留空即可'
    el.innerHTML = '「用户名」+「密码」＝该平台的登录账号密码（如 Songloft / MusicSync 的站点登录）。「登录账号」字段仅 Geelonn 使用，此处可留空。'
  }
}

function openAccountForm(id) {
  const form = $('accountForm')
  form.hidden = false
  state.editingAccountId = id || null
  const acc = id ? state.platforms.find(p => p.id === id) : null
  $('accType').value = (acc && acc.type) || 'lxserver'
  $('accName').value = (acc && acc.name) || ''
  $('accUrl').value = (acc && acc.url) || ''
  $('accUser').value = (acc && acc.username) || ''
  $('accLogin').value = (acc && acc.loginUser) || ''
  $('accPwd').value = (acc && acc.password) || ''
  $('accTmo').value = (acc && acc.timeoutMs) || 25000
  updateAccHint($('accType').value)
  // 「参与批量灌入」：新建时默认勾上（多平台是本版主打用法，勾了才用得上），
  // 编辑已有账号时以存下来的值为准 —— 老账号没这个字段就不勾，行为与升级前一致。
  $('accBatch').checked = acc ? acc.batchImport === true : true
  $('accName').focus()
}

function closeAccountForm() {
  $('accountForm').hidden = true
  state.editingAccountId = null
}

function validateAccount() {
  const type = $('accType').value
  const url = $('accUrl').value.trim()
  const name = $('accName').value.trim()
  if (!url) { toast('请填写服务地址', 'err'); return null }
  return {
    id: state.editingAccountId || ('p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    type,
    name: name || url,
    url,
    // 用户名＝灌入落点（留空/default → 公开源；具名 → 该账号私有列表）
    username: $('accUser').value.trim(),
    // 登录账号：仅 Geelonn 需要（fork 必须用真实账号鉴权；留空默认 admin）
    loginUser: $('accLogin').value.trim(),
    password: $('accPwd').value,
    timeoutMs: parseInt($('accTmo').value, 10) || 25000,
    enabled: true,
    batchImport: !!$('accBatch').checked
  }
}

$('accType').addEventListener('change', () => updateAccHint($('accType').value))

$('btnAddAccount').addEventListener('click', () => openAccountForm(null))
$('btnAccCancel').addEventListener('click', closeAccountForm)
$('btnAccSave').addEventListener('click', async () => {
  const acc = validateAccount()
  if (!acc) return
  const idx = state.platforms.findIndex(p => p.id === acc.id)
  if (idx >= 0) state.platforms[idx] = acc
  else state.platforms.push(acc)
  if (!state.activePlatformId) state.activePlatformId = acc.id
  renderPlatforms()
  renderInstalledAccountInfo()
  closeAccountForm()
  const r = await persistPlatforms()
  if (r.ok) toast('账号已保存', 'ok')
  else toast('保存失败：' + r.error, 'err')
})
$('btnAccTest').addEventListener('click', async () => {
  const acc = validateAccount()
  if (!acc) return
  const chip = $('connChip'), txt = $('connText')
  chip.className = 'conn'; txt.textContent = '连接中…'
  const r = await api.serviceTest(acc)
  if (r.ok && r.data && r.data.ok) {
    chip.className = 'conn on'; txt.textContent = '已连接'
    chip.title = '推送服务端已连接'
    state.connOk = true
    toast('连接成功：' + r.data.msg, 'ok')
  } else {
    chip.className = 'conn err'; txt.textContent = '未连接'
    chip.title = '推送服务端未连接：音源库与「已灌入」统计显示的是本地数据，不代表服务端现状'
    state.connOk = false
    toast('连接失败：' + ((r.data && r.data.msg) || r.error), 'err')
  }
  renderStats()
})

async function setActiveAccount(id) {
  state.activePlatformId = id
  renderPlatforms()
  renderInstalledAccountInfo()
  await persistPlatforms()
  refreshInstalled()
  testConn()
}

async function deleteAccount(id) {
  const acc = state.platforms.find(p => p.id === id)
  if (!acc) return
  if (!confirm(`确定删除账号「${acc.name || acc.url}」？\n（仅删除本工具的配置记录，不影响服务端音源）`)) return
  state.platforms = state.platforms.filter(p => p.id !== id)
  if (state.activePlatformId === id) state.activePlatformId = state.platforms[0] ? state.platforms[0].id : null
  renderPlatforms()
  renderInstalledAccountInfo()
  await persistPlatforms()
  refreshInstalled()
}

// 已灌入页顶部「当前账号」信息 + 公共音源清理卡片可见性 + 灌入页的「灌入目标」提示
function renderInstalledAccountInfo() {
  const active = state.platforms.find(p => p.id === state.activePlatformId)
  const srv = $('srvUrl')
  if (srv) srv.textContent = active ? `${active.url}（${PLATFORM_TYPES[active.type] || active.type}）` : '（未配置）'
  const sel = $('insAccountSel')
  if (sel) renderAccountSelector(sel)
  const pubCard = $('pubCard')
  if (pubCard) pubCard.hidden = !(active && (active.type === 'lxserver' || active.type === 'geelonn'))
  renderImportTargets()
  // 音源库里的「已灌入」徽章与「只选未灌入」都是按「本次灌入目标」算的（见 importedState），
  // 所以切账号 / 改「参与批量灌入」勾选后必须重画表格，否则徽章会停留在旧口径上。
  if (state.sources.length) renderTable()
}

/**
 * 灌入页顶部显示本次会灌到哪些账号（v1.8.0 多平台）：
 * 与核心的约定保持一致 —— 勾了「参与批量灌入」的账号全上，一个都没勾就只灌当前账号。
 * 这里只是把同一套规则提前摆在用户眼前，避免「我以为是灌 A，结果灌到了 B」。
 */
function batchImportTargets() {
  const list = (state.platforms || []).filter(p => p && p.enabled !== false)
  const marked = list.filter(p => p.batchImport === true)
  if (marked.length) return marked
  const active = list.find(p => p.id === state.activePlatformId) || list[0]
  return active ? [active] : []
}

function renderImportTargets() {
  const el = $('importTargets')
  if (!el) return
  const t = batchImportTargets()
  if (!t.length) {
    el.textContent = '灌入目标：—（请先在「设置」里添加服务平台账号）'
    el.className = 'sub warn'
    return
  }
  const names = t.map(p => p.name || p.url).join('、')
  const multi = t.length > 1
  el.textContent = `灌入目标：${names}（${t.length} 个账号${multi ? '，同时灌入' : ''}）`
  el.className = 'sub'
  el.title = multi
    ? '这些账号在「设置 → 服务平台账号」里勾了「参与批量灌入」。同名音源会按哪边可用平台更多来裁决，留多的那个。'
    : '只灌这一个账号（没有其它账号勾了「参与批量灌入」）。在「设置 → 服务平台账号」里可勾选更多账号。'
}

function renderAccountSelector(sel) {
  const cur = state.activePlatformId
  sel.innerHTML = state.platforms.map(p =>
    `<option value="${esc(p.id)}"${p.id === cur ? ' selected' : ''}>${esc(p.name || p.url)} · ${esc(PLATFORM_TYPES[p.type] || p.type)}</option>`
  ).join('') || '<option value="">（未配置账号）</option>'
}

$('insAccountSel').addEventListener('change', async ev => {
  state.activePlatformId = ev.target.value || null
  renderPlatforms()
  renderInstalledAccountInfo()
  await persistPlatforms()
  refreshInstalled()
  testConn()
})

// ---------------- 音源库 ----------------
async function loadSources() {
  const r = await api.sourcesGet()
  if (!r.ok) return toast('读取音源库失败: ' + r.error, 'err')
  state.sources = r.data.sources || []
  state.imported = r.data.imported || {}
  state.patrol = r.data.patrol || { lastRun: 0 }
  state.lastCrawl = r.data.lastCrawl || 0
  clampPage()
  renderStats()
  renderTable()
  renderPatrolInfo()
  renderCrawlInfo()
}

/** 上次爬取时间（爬取页工具栏；启用定时爬取后会随增量爬取自动刷新） */
function renderCrawlInfo() {
  const el = $('crawlInfo')
  if (!el) return
  const t = state.lastCrawl
  if (!t) {
    el.textContent = '上次爬取：—'
    el.title = '还没有爬取过。点右上角「爬取仓库」开始；也可在设置页启用定时爬取'
    return
  }
  const d = new Date(t)
  const hh = n => String(n).padStart(2, '0')
  const s = `${d.getFullYear()}-${hh(d.getMonth() + 1)}-${hh(d.getDate())} ${hh(d.getHours())}:${hh(d.getMinutes())}`
  el.textContent = '上次爬取：' + s
  el.title = '上次爬取：' + s + '。启用定时爬取后（设置页），应用会按间隔自动增量爬取：只收新音源与内容更新，已抓取的不重抓'
}

function renderStats() {
  const s = state.sources.filter(e => !e.deprecated)
  $('stTotal').textContent = s.length
  $('stUsable').textContent = s.filter(e => e.usable).length
  // 「疑似音源」= 非典型脚本（缺洛雪接口特征）+ 深检全失败但原因像本机网络（可自救）；
  // 深检确证失效的不再混进疑似，计入下面的「失效」
  $('stSuspected').textContent = s.filter(e => !e.usable && e.status !== 'dead' && !isDeepDead(e) && (e.suspected || isCheckedNoSource(e))).length
  $('stDead').textContent = s.filter(e => e.status === 'dead' || isDeepDead(e)).length
  // 「已灌入」= **当前账号**口径（v1.8.0 用户要求：卡片上的数要和「已灌入」页对得上）。
  // 三个账号各有一份时，跨账号合计既不是任何单个账号的数、也不是任何一份服务端列表的长度，
  // 只会让人对不上号。所以：拿到过当前账号的服务端列表就显示它的真实条数；没拿到就退回
  // 账本里属于该账号的记录数（并在提示里说清这是本机记录，点「已灌入」页刷新可对账）。
  const impEl = $('stImported')
  const impCard = impEl.parentNode
  const lab = impCard.querySelector('.stat-label')
  const acct = (state.platforms || []).find(p => p.id === state.activePlatformId)
  const acctName = acct ? (acct.name || acct.url) : ''
  const totalLedger = Object.keys(state.imported || {}).length
  if (state.activePlatformId && state.installedFor === state.activePlatformId) {
    impEl.textContent = (state.installed || []).length
    impCard.title = `当前账号（${acctName}）服务端上的音源数 —— 与「已灌入」页显示的一致。\n`
      + `本地账本里属于该账号的记录 ${ledgerCountFor(state.activePlatformId)} 条，全部账号合计 ${totalLedger} 条`
  } else if (state.activePlatformId) {
    impEl.textContent = ledgerCountFor(state.activePlatformId)
    impCard.title = `本地账本里属于当前账号（${acctName}）的灌入记录 ${ledgerCountFor(state.activePlatformId)} 条；`
      + `全部账号合计 ${totalLedger} 条。\n进「已灌入」页刷新一次即可拉取服务端真实列表并自动对账`
  } else {
    impEl.textContent = totalLedger
    impCard.title = '未选择服务平台账号；这里显示的是本地账本里的灌入记录总数。\n到「设置」里选中一个账号后会按该账号显示'
  }
  if (lab) lab.textContent = state.activePlatformId ? '已灌入 · 当前账号' : '已灌入'
  // 服务端离线时，卡片上的数字只是「上次成功读取的服务端列表」或本地灌入账本。
  // 断线绝不清本地数据（否则一次网络抖动就会把整库记录误删，见 hunter.syncServer 的
  // 清理口径：只有成功读到服务端列表才对账），但必须让人一眼看出这不是实时状态。
  // 上面三个分支每次都会覆盖式重设 impCard.title，所以这里追加不会越叠越长。
  if (state.connOk === false) {
    impCard.classList.add('stat-offline')
    impCard.title = (impCard.title || '') +
      '\n\n当前未连接推送服务端：这里是上次成功读取的服务端列表或本地灌入账本，不是实时状态。' +
      '音源库里「来源仓库」为 (服务端) 的条目也是本地快照，不会因断线消失；连接恢复后刷新「已灌入」页即可对账。'
  } else {
    impCard.classList.remove('stat-offline')
  }
  // 音源库行级「离线快照」角标由 body class 控制：connOk 一变（连接测试 / 切账号）
  // 这里就会同步，不需要重建整张表，也不会打断正在进行的勾选与滚动。
  document.body.classList.toggle('conn-offline', state.connOk === false)
}

function matchFilter(e) {
  // 「已选」页签：只显示当前勾选的条目 —— 勾选是跨筛选/跨页全局的，
  // 用户在别的页签勾了若干条后回到列表经常"找不到勾哪去了"，这里给出唯一入口
  if (state.filter === 'selected') return state.selected.has(e.id) && !(state.hideDeprecated && e.deprecated)
  if (state.hideDeprecated && e.deprecated) return false
  const q = state.query.trim().toLowerCase()
  switch (state.filter) {
    case 'usable': if (!e.usable) return false; break
    case 'suspected': if (!(e.status !== 'dead' && !isDeepDead(e) && !e.usable && (e.suspected || isCheckedNoSource(e)))) return false; break
    case 'dead': if (!(e.status === 'dead' || isDeepDead(e))) return false; break
    // 「未检测」= 完全没跑过检测的；已检测但不是音源脚本的也算已检测
    // 已合并的重复项不算「未检测」：它不需要检测，是内容/名称与保留项重复
    case 'unchecked': if (e.deprecated || e.deep || e.status === 'dead' || e.status === 'quarantined' || isCheckedNoSource(e)) return false; break
    // 「已实测」= 真实探针通过（validTier=confirmed），即脚本已被沙箱实测能取到可播链接
    case 'confirmed': if (e.validTier !== 'confirmed') return false; break
    // 「已灌入」= 本次所有灌入目标账号都已有它（只灌过 A 的源，目标含 B 时不算已灌入）
    case 'imported': if (importedState(e) !== 'all') return false; break
  }
  if (!q) return true
  return [e.scriptName, e.name, e.author, e.repo, e.path].some(v => String(v || '').toLowerCase().includes(q))
}

function filtered() {
  const list = state.sources.filter(matchFilter)
  // 排序在筛选之后统一做：分页/全选/勾选池看到的都是同一顺序
  return sortSources(list, state.sort, importedRankMap())
}

/** id -> 条目，供「重复项指向保留项」查名 */
const srcIndex = new Map()
function indexSources() {
  srcIndex.clear()
  for (const e of state.sources) srcIndex.set(e.id, e)
}

/** 废弃重复项的去向说明：告诉用户它被合并到哪条、为什么 */
function mergeTip(e) {
  const keep = e.dupOf ? srcIndex.get(e.dupOf) : null
  const kn = keep ? (keep.lxName || keep.scriptName || keep.name) : ''
  return (kn ? '与「' + kn + '」重复，已合并' : '重复项，已合并') +
    (e.dupReason ? '（' + e.dupReason + '）' : '') +
    ' —— 检测结果以保留项为准；勾选「隐藏已废弃重复项」可不显示'
}

/** 混淆风险摘要（v1.7.1）：把检测记录的特征数据翻成人话，徽章 tooltip 用 */
function obfTip(e) {
  const h = e.obfHits
  if (!h) return e.obfLevel === 'high'
    ? '重度混淆脚本：混淆常用于隐藏恶意代码（木马/后门/统计上报），建议拒绝使用'
    : '含局部混淆：可能用于防和谐，也可能藏统计上报/后门，建议自行甄别'
  const parts = []
  if (h.perKb0x >= 2) parts.push(`_0x 变量名 ${Math.round(h.perKb0x)}/KB`)
  if (h.perKbUni >= 1) parts.push(`unicode 转义 ${h.perKbUni.toFixed(1)}/KB`)
  if (h.perKbExotic >= 2) parts.push(`异体字符 ${Math.round(h.perKbExotic)}/KB`)
  if (h.spinLoops) parts.push(`空转死循环 while(!![]){} ${h.spinLoops} 处（反调试套路，会持续吃满 CPU）`)
  if (h.selfSchedCalls) parts.push(`混淆自调度定时器 ${h.selfSchedCalls} 处（setTimeout/setInterval 经字符串数组间接调用）`)
  if (h.jsjiamiMarks) parts.push(`jsjiami 混淆器标识 ${h.jsjiamiMarks} 处`)
  if (h.evalCalls) parts.push(`动态执行 ${h.evalCalls} 处`)
  const detail = parts.length ? '（' + parts.join('、') + '）' : ''
  return e.obfLevel === 'high'
    ? `重度混淆脚本${detail}：音源没有混淆的必要，重度混淆常用于隐藏恶意代码，建议拒绝使用`
    : `含局部混淆${detail}：可能用于防和谐，也可能藏统计上报/后门，建议自行甄别`
}

// ---------------- 混淆隔离区（v1.10.7） ----------------
function qzHardHits(e) {
  const h = e.obfHits || {}
  return (h.spinLoops || 0) > 0 || (h.selfSchedCalls || 0) > 0 || (h.jsjiamiMarks || 0) > 0 || (h.evalCalls || 0) > 0
}

function qzDeepSummary(e) {
  if (!e.deep || !e.deep.checkedAt) return '尚未深度体检（信任放行后可跑「检测」确认实际可用性）'
  const plats = e.deep.platforms || {}
  const usableN = Object.values(plats).filter(p => p && p.status === 'usable').length
  return `深度体检：${e.deep.loadable ? '可加载' : '不可加载'}，实测可用平台 ${usableN} 个`
}

function renderQuarantine() {
  const list = (state.sources || []).filter(e => e.status === 'quarantined' || e.quarantined)
  $('qzCount').textContent = list.length + ' 条被隔离'
  $('qzEmpty').hidden = list.length > 0
  $('qzList').innerHTML = list.map(e => {
    const hard = qzHardHits(e)
    const size = e.size ? Math.max(1, Math.round(e.size / 1024)) + 'KB' : ''
    return `<div class="qz-row" data-id="${esc(e.id)}">
      <div class="qz-main">
        <span class="qz-name">${esc(e.lxName || e.scriptName || e.name || e.id)}</span>
        <span class="qz-meta">${esc(e.repo || '')}${size ? ' · ' + size : ''} · ${esc(obfTip(e))}</span>
        <span class="qz-deep">${esc(qzDeepSummary(e))}</span>
      </div>
      ${hard
        ? `<button class="btn btn-sm ghost" disabled title="命中反调试/混淆器硬特征（空转死循环/混淆自调度定时器/jsjiami/eval），属于真恶意特征，不允许信任">不可信任</button>`
        : `<button class="btn btn-sm qz-trust" title="信任后按内容指纹放行，正常检测与灌入；脚本内容一有更新就自动重新隔离">信任放行</button>`}
    </div>`
  }).join('')
}

$('qzList').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.qz-trust')
  if (!btn || btn.disabled) return
  const row = btn.closest('.qz-row')
  const id = row && row.getAttribute('data-id')
  if (!id) return
  btn.disabled = true; btn.textContent = '处理中…'
  const r = await api.sourcesTrustObf(id, true)
  if (r.ok) {
    toast('已信任放行：可正常检测与灌入（内容更新会重新隔离）', 'ok')
    await loadSources()
    renderQuarantine()
  } else {
    toast('信任失败: ' + r.error, 'err')
    btn.disabled = false; btn.textContent = '信任放行'
  }
})
$('btnQzRefresh').addEventListener('click', async () => {
  await loadSources()
  renderQuarantine()
})

function platCells(e) {
  // 去重废弃的重复条目从没单独跑过检测，画五个灰格子会让人以为「检测没生效」。
  // 直接说明它被合并了，别让人对着一片「未检测」猜。
  if (e.deprecated && !e.deep) {
    return `<span class="plat skipped" title="${esc(mergeTip(e))}">已合并</span>`
  }
  const p = (e.deep && e.deep.platforms) || {}
  const declared = (e.deep && e.deep.declaredSources) || []
  return PLAT.map(x => {
    const cell = p[x.k]
    const st = cell ? cell.status : ''
    // usable=实测可用（绿）；failed=实测失败（红）；untested=快速模式没测（虚线灰，≠不支持）；skipped=脚本未提供
    const cls = st === 'usable'
      // 已解析链接但本机没下载校验通过：算可用，但用浅色+波浪号区分于「实测可播」
      ? (cell.verified === false ? 'weak' : 'usable')
      : (st === 'failed' ? 'failed' : (st === 'untested' ? 'untested' : (st ? 'skipped' : '')))
    let title
    if (!cell) title = x.t + '：未检测'
    else if (st === 'untested') title = x.t + '：未测（快速模式命中即停，非不支持）—— 点「补全平台覆盖」可实测'
    else if (st === 'usable' && cell.verified === false) {
      title = x.t + '：可用 —— 脚本已解析出播放链接，本机未下载校验（常见于需 Referer / 有地域或时效限制的 CDN，导入洛雪后通常可正常播放）\n' + (cell.message || '')
    } else title = x.t + '：' + (cell.message || st)
    if (declared.includes(x.k)) title += '｜脚本声明支持'
    return `<span class="plat ${cls}" title="${esc(title)}">${x.t}</span>`
  }).join('')
}

function statusCell(e) {
  if (e.checking) return '<span class="badge accent">检测中…</span>'
  const im = importedBadge(e)
  if (im) return im
  // 去重废弃的条目一律显示「重复·已合并」——不管它有没有历史检测结果。
  // 旧逻辑只在无深检结果时显示，带历史结果的会落进「疑似」分支，让人误判成检测失败。
  // 它的真实状态是「已合并到保留项」，必须这么说。
  if (e.deprecated) return `<span class="badge gray" title="${esc(mergeTip(e))}">重复·已合并</span>`
  // 内容有更新（定时爬取发现上游换了内容，检测结果已重置）—— 不能显示成普通「未检测」
  if (e.updated && !e.deep) return '<span class="badge warn" title="上游内容已变更（定时爬取发现），检测结果已重置：重新检测后生效；灌入时会自动替换服务端上的同名旧版">有更新·待检测</span>'
  // v1.12.0 质量守门：疑似回归标记（软拦截——自动灌入跳过，手动不受限）。
  // 回归条目通常仍可用，所以放在「可用」判定之前，两个徽章并列展示。
  if (e.regression && e.regression.suspected) {
    const tip = `版本回归对比：上一版通过 [${(e.regression.prevPassed || []).join('/') || '—'}]，` +
      `本版通过 [${(e.regression.passed || []).join('/') || '—'}]（丢失 ${(e.regression.lost || []).join('/') || '—'}）。` +
      `定时任务不会自动灌入这个版本；手动检测/灌入不受限，复测恢复后徽章自动消失。`
    const base = e.usable ? '<span class="badge ok">可用</span> ' : ''
    return base + `<span class="badge warn" title="${esc(tip)}">疑似回归</span>`
  }
  if (e.usable) return '<span class="badge ok">可用</span>'
  if (e.status === 'quarantined') return `<span class="badge warn" title="${esc(obfTip(e))}">混淆隔离</span>`
  if (e.status === 'dead') return '<span class="badge fail">失效</span>'
  // 缺少洛雪音源接口特征的脚本与疑似音源合并显示（都归入「疑似音源」），但 tooltip 区分
  if (e.suspected) return '<span class="badge warn">疑似</span>'
  if (isCheckedNoSource(e)) return '<span class="badge warn" title="疑似音源：脚本缺少洛雪音源接口特征，未进入深度检测">疑似</span>'
  // 混淆风险标注（v1.7.1，依据 lx-ikun issue#8 科普）：检测时评估，重危红/局部黄
  if (e.obfLevel === 'high') {
    return `<span class="badge fail" title="${esc(obfTip(e))}">⚠混淆高危</span>`
  }
  if (e.obfLevel === 'mid' && !e.usable) {
    return `<span class="badge warn" title="${esc(obfTip(e))}">含混淆</span>`
  }
  if (e.deep) {
    // 抢救回来的脚本（init 报错但仍注册了取链能力）：告知用户「有初始化报错，但实测能取链」
    if (e.deep.initWarning) {
      return `<span class="badge gray" title="脚本初始化有报错，但已注册取链能力，按实测结果判定：${esc(e.deep.initWarning)}">不可用</span>`
    }
    if (e.deep.loadError) return `<span class="badge gray" title="加载失败：${esc(e.deep.loadError)}">不可用</span>`
    // 深检确证失效：无可用平台且失败原因不像本机网络 —— 直接标红「失效」，与统计卡口径一致
    if (!e.usable && e.deep.failKind === 'dead') {
      const tip = e.deep.hint || '已检测，各平台真实取链全部失败（失败原因不像本机网络问题），判定为失效'
      return `<span class="badge fail" title="${esc(tip)}">失效</span>`
    }
    // 全平台同因失败：区分「音源真死了」（域名已失效，该删）和「本机网络问题」（可自救）。
    // 这条提示光放 tooltip 里没人看得到，必须带可见标记。
    if (e.deep.hint) {
      const dead = e.deep.deadDomain === true || /已失效|建议删除/.test(String(e.deep.hint))
      const mark = dead ? '⚠失效' : '⚠网络'
      return `<span class="badge gray" title="${esc(e.deep.hint)}">不可用 <b title="${esc(e.deep.hint)}">${mark}</b></span>`
    }
    return '<span class="badge gray" title="已检测，五个平台都取不到播放链接">不可用</span>'
  }
  return '<span class="badge gray">未检测</span>'
}

/** validTier 中文标签（v1.9.10，对齐 lxhub 的 confirmed/probable 两级置信） */
function vtLabel(t) {
  return t === 'confirmed' ? '已实测' : (t === 'probable' ? '疑似未测' : (t === 'rejected' ? '已排除' : ''))
}

function apiAliveBadge(e) {
  const a = e.apiAlive
  if (!a || typeof a !== 'object' || !Object.keys(a).length) return ''
  const vals = Object.values(a)
  const up = vals.filter(v => v === 'up' || String(v).startsWith('http_')).length
  const down = vals.filter(v => v === 'down').length
  const cls = down && !up ? 'vt-down' : (up ? 'vt-up' : 'vt-warn')
  const txt = up ? `后端${up}在线` : (down ? `后端失效×${down}` : '后端未知')
  return `<span class="vt ${cls}" title="接口域名存活（v1.9.11 遥测）：${esc(JSON.stringify(a))}">${txt}</span>`
}

function rowHtml(e) {
  const vt = e.validTier ? `<span class="vt vt-${e.validTier}" title="探针置信：${vtLabel(e.validTier)}">${vtLabel(e.validTier)}</span>` : ''
  const al = apiAliveBadge(e)
  // 私人音源：手动导入的个人源，不参与去重废弃，也不参与健康巡检（可手动检测/灌入）
  const priv = e.private ? '<span class="badge private" title="私人音源：手动导入，不参与去重废弃，也不参与健康巡检（不会被自动重测、禁用或删除）；可在音源库手动检测 / 灌入">私人</span>' : ''
  // (服务端) 占位条目是本地快照，不是服务端实时视图。断线时给一个灰色行级角标，
  // 免得用户拿它当成「服务端上还挂着」去做删除决策（显隐由 body.conn-offline 控制，
  // connOk 变化时不必整表重建）。
  const snap = (e.fromServer || e.repo === '(服务端)')
    ? '<span class="snap-tag" title="这是上次连接成功时同步进本地音源库的占位快照，不代表推送服务端现状；连接恢复后到「已灌入」页点「刷新」即可对账。要删除服务端上的脚本，请到「已灌入」页操作。">离线快照</span>'
    : ''
  return `
    <td class="c-chk"><input type="checkbox" data-id="${esc(e.id)}" ${state.selected.has(e.id) ? 'checked' : ''}></td>
    <td><span class="nm">${esc(e.scriptName || e.name)}</span>${priv}
        <span class="nm-sub">${esc([e.scriptVersion, e.author].filter(Boolean).join(' · ') || e.name)}</span>${vt}${al}</td>
    <td class="c-plat"><div class="plats">${platCells(e)}</div></td>
    <td class="c-repo"><span class="repo">${esc(e.repo)}</span>${snap}</td>
    <td class="c-status">${statusCell(e)}</td>
    <td class="c-op">
      <button class="btn sm" data-act="check" data-id="${esc(e.id)}">检测</button>
      <button class="btn sm" data-act="import" data-id="${esc(e.id)}">灌入</button>
    </td>`
}

const rowMap = new Map() // id -> <tr>

/** 已选页签徽章：显示勾选数量；0 条时置灰提示（点击仍可进入空视图，方便反选） */
function updateSelectedSeg() {
  const seg = $('segSelected')
  if (!seg) return
  const n = state.selected.size
  seg.textContent = n ? `已选 ${n}` : '已选'
  seg.title = n ? `查看当前勾选的 ${n} 个音源` : '没有勾选任何音源'
}

function renderTable() {
  indexSources()   // 行内要按 id 查「合并到哪条」，先建索引
  updateSelectedSeg()
  renderSortHeads()
  const list = filtered()
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
  if (state.page > totalPages) state.page = totalPages
  const start = (state.page - 1) * PAGE_SIZE
  const show = list.slice(start, start + PAGE_SIZE)

  const body = $('srcBody')
  body.innerHTML = ''
  rowMap.clear()
  const frag = document.createDocumentFragment()
  for (const e of show) {
    const tr = document.createElement('tr')
    tr.innerHTML = rowHtml(e)
    rowMap.set(e.id, tr)
    frag.appendChild(tr)
  }
  body.appendChild(frag)

  $('emptyTip').hidden = list.length > 0
  $('selInfo').textContent = selInfoText(`筛选结果 ${list.length} 条`)
  $('chkAll').checked = show.length > 0 && show.every(e => state.selected.has(e.id))
  $('pgInfo').textContent = `${state.page} / ${totalPages}`
  $('pgPrev').disabled = state.page <= 1
  $('pgNext').disabled = state.page >= totalPages
}

/** 实时更新单行（检测线程每完成一条推送一次） */
function patchRow(e) {
  const tr = rowMap.get(e.id)
  if (!tr) return
  if (!matchFilter(e)) {
    // 该行已不匹配当前筛选（如「未检测」视图里检测完成/失效的行），
    // 必须移除陈旧行，否则看起来像「检测过了却还显示未检测」
    tr.remove()
    rowMap.delete(e.id)
    scheduleTableRefresh()
    return
  }
  const fresh = document.createElement('tr')
  fresh.innerHTML = rowHtml(e)
  rowMap.set(e.id, fresh)
  tr.replaceWith(fresh)
  // 按「状态 / 平台可用性」排序时，一次检测完成会改变行的排序位置（如变成「可用」）：
  // 行内替换只更新内容，位置交给节流全表刷新重排
  if (state.sort.key === 'status' || state.sort.key === 'plat') scheduleTableRefresh()
}

/** 表头排序箭头与 aria-sort（renderTable 时同步，保证翻页/刷新后不丢状态） */
function renderSortHeads() {
  document.querySelectorAll('#srcTable th.sortable').forEach(th => {
    const on = state.sort.key === th.dataset.k
    th.classList.toggle('sorted', on)
    th.setAttribute('aria-sort', on ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none')
    const ar = th.querySelector('.sort-arrow')
    if (ar) ar.textContent = on ? (state.sort.dir === 'asc' ? '▲' : '▼') : ''
  })
}

// 表头点击排序（v1.7.3）：首次点击用该列的首选方向，再点反向
document.querySelectorAll('#srcTable th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const k = th.dataset.k
    if (!SORT_DEFS[k]) return
    if (state.sort.key === k) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc'
    else { state.sort.key = k; state.sort.dir = SORT_DEFS[k].dir }
    saveSort()
    state.page = 1
    renderSortHeads()
    renderTable()
  })
})

// 检测过程中行会跨筛选视图进出（进入「可用/失效」、离开「未检测」），
// 用节流的全表刷新修正分页计数与当页内容（每页 50 行，重建开销很小）
let tableRefreshTimer = null
function scheduleTableRefresh() {
  if (tableRefreshTimer) return
  tableRefreshTimer = setTimeout(() => {
    tableRefreshTimer = null
    renderTable()
  }, 800)
}

let statsTimer = null
function scheduleStats() {
  if (statsTimer) return
  statsTimer = setTimeout(() => {
    statsTimer = null
    renderStats()
    const list = filtered()
    $('selInfo').textContent = selInfoText(`筛选结果 ${list.length} 条`)
  }, 400)
}

$('srcBody').addEventListener('click', ev => {
  const btn = ev.target.closest('button[data-act]')
  if (!btn) return
  const id = btn.dataset.id
  if (btn.dataset.act === 'check') startCheck([id])
  else startImport([id])
})
$('srcBody').addEventListener('change', ev => {
  const cb = ev.target.closest('input[data-id]')
  if (!cb) return
  if (cb.checked) state.selected.add(cb.dataset.id)
  else state.selected.delete(cb.dataset.id)
  syncExportScope()
  // 「已选」视图里取消勾选的行要立即消失；其他视图只更新计数徽章
  if (state.filter === 'selected') renderTable()
  else { updateSelectedSeg(); $('selInfo').textContent = selInfoText('筛选结果见上') }
})

/**
 * 同步「导出范围」下拉与当前勾选：
 * 勾选条目后自动切到「选中项」，用户勾了却不生效是最容易被当成 bug 的地方；
 * 清空勾选后回落到当前筛选页签。
 */
function syncExportScope() {
  const ef = $('expFilter')
  if (!ef) return
  const opt = ef.querySelector('option[value="selected"]')
  const n = state.selected.size
  if (opt) {
    opt.textContent = n ? `导出：选中项（${n}）` : '导出：选中项'
    opt.disabled = !n
  }
  if (n) { ef.value = 'selected'; return }
  // 用户手动选过某个范围（且此刻没有勾选）→ 尊重手动选择，不覆盖（已选页签除外：空了自动离开）
  if (ef.value !== 'selected' && state.filter !== 'selected' && ef.querySelector(`option[value="${ef.value}"]`)) return
  // 否则跟随当前筛选页签
  ef.value = ef.querySelector(`option[value="${state.filter === 'selected' ? 'all' : state.filter}"]`) ? (state.filter === 'selected' ? 'all' : state.filter) : 'all'
}

$('chkAll').addEventListener('change', () => {
  const list = filtered()
  const start = (state.page - 1) * PAGE_SIZE
  // 「已选」视图里的表头全选框语义反转：勾上=保留本页（本页本来就已勾选），取消=批量反选本页
  for (const e of list.slice(start, start + PAGE_SIZE)) {
    if ($('chkAll').checked) state.selected.add(e.id); else state.selected.delete(e.id)
  }
  syncExportScope()
  renderTable()
})
$('btnSelectAll').addEventListener('click', () => {
  const list = filtered()
  for (const e of list) state.selected.add(e.id)
  syncExportScope()
  renderTable()
  // 点这之前往往已有一批跨筛选勾选的残留（例如先在「全部」勾了一堆再切到「可用」），
  // 提示总数 = 筛选结果 + 此前残留，用户才知道勾选池里实际有多少
  toast(`已勾选本筛选全部 ${list.length} 条；勾选池共 ${state.selected.size} 条（含其他筛选下的历史勾选，点「已选」页签可查看）`, 'ok')
})
// 只选未灌入（v1.7.3）：与状态排序（已灌入垫底）配套——一键排除已灌入/已合并项，
// 只把当前筛选下的未灌入音源加进勾选池，直接灌入，不用逐条手动勾。
// v1.8.0：口径改成「所有灌入目标账号都有它」才算已灌入 —— 只灌过 A 的源在目标含 B 时
// 仍会被勾上，否则加了第二个平台后这批源永远补灌不进去。
$('btnSelUnimported').addEventListener('click', async () => {
  // 先按服务端现状对账再谈「未灌入」：用户可能刚在服务端网页端把源删了，
  // 本地那枚「已灌入」标记还挂着的话，这里会把该重灌的源整体排除（点了像没反应）。
  await syncInstalledQuiet(true)
  const all = filtered()
  const list = all.filter(e => importedState(e) !== 'all' && !e.deprecated)
  if (!list.length) return toast('当前筛选下没有未灌入的音源（已灌入/已合并项已被排除）', 'info')
  state.selected.clear()
  for (const e of list) state.selected.add(e.id)
  syncExportScope()
  renderTable()
  const skipped = all.length - list.length
  const partial = list.filter(e => importedState(e) === 'part').length
  toast(`已勾选未灌入 ${list.length} 条` + (partial ? `（含 ${partial} 条仅灌入部分平台的，会补灌到缺的平台）` : '') +
    (skipped ? `；排除已灌入/已合并 ${skipped} 条` : '') + '，点「灌入选中的音源」即可', 'ok')
})
$('btnClearSel').addEventListener('click', () => {
  const n = state.selected.size
  state.selected.clear()
  syncExportScope()
  renderTable()
  if (n) toast(`已清空全部勾选（${n} 条）`, 'ok')
})

// ---------------- 手动删除选中音源（v1.10.2） ----------------
// 此前只有「清空音源库」（整库）与「已灌入」页的服务端删除，删不掉本地指定的某几条。
// 语义：只删本地条目；服务端已灌入脚本不动；删掉的 id 记入「不再自动采集」名单，
// 避免下一轮爬取 / 采集站同步立刻把它们加回来（名单可在设置页清除）。
async function deleteSelected() {
  const ids = [...state.selected]
  if (!ids.length) return toast('先在表格里勾选要删除的音源，再点「删除选中」', 'info')
  const picked = state.sources.filter(e => ids.indexOf(e.id) >= 0)
  const priv = picked.filter(e => e.private).length
  const snapN = picked.filter(e => e.fromServer || e.repo === '(服务端)').length
  const names = picked.slice(0, 4).map(e => e.scriptName || e.name || e.id).join('、')
  const more = picked.length > 4 ? ` 等 ${picked.length} 条` : ''
  const extra = priv ? `（其中 ${priv} 条是私人音源）` : ''
  // 占位快照最容易被误解成「服务端上还挂着的脚本」，把这句放到确认框最前面
  const snapWarn = snapN
    ? `注意：其中 ${snapN} 条是「(服务端)」本地占位快照 —— 删除只影响本地，服务端上的脚本不会消失。要撤掉服务端脚本，请到「已灌入」页删除。\n\n`
    : ''
  if (!confirm(
    `确定从本地音源库删除 ${ids.length} 条音源${extra}？\n\n` +
    `${names}${more}\n\n` +
    snapWarn +
    '· 只删本地记录，服务端上已灌入的脚本不会被删除（要撤掉请用「已灌入」页的删除）；\n' +
    (snapN ? '· 占位条目的「已灌入」账本会一并清除，之后不再参与巡检与灌入判定；\n' : '') +
    '· 删掉的条目会记入「不再自动采集」名单，后续爬取 / 采集站不会立刻加回；\n' +
    '· 想恢复：设置 → 数据 → 清除删除记录后重新爬取，或导入含该条目的音源库 JSON。\n\n' +
    '此操作不可撤销（导出的备份文件不受影响）。'
  )) return
  const r = await api.dbDelete(ids)
  if (!r.ok) return toast('删除失败：' + r.error, 'err')
  const d = r.data || {}
  for (const id of ids) state.selected.delete(id)
  state.page = 1
  await loadSources()
  await refreshDeletedInfo()
  toast(`已删除 ${d.deleted || 0} 条音源${d.missing && d.missing.length ? `（${d.missing.length} 条库里已不存在）` : ''}；累计 ${d.blocked || 0} 条不再自动采集` +
    (d.ledgerDropped ? `；同步清理 ${d.ledgerDropped} 条灌入账本` : ''), 'ok')
}
$('btnDeleteSel').addEventListener('click', deleteSelected)

/** 设置页「删除记录」计数：Web 与桌面版各有同名 api 实现 */
async function refreshDeletedInfo() {
  const el = $('deletedInfo')
  if (!el) return
  if (!api.dbDeletedList) { el.textContent = '删除记录：当前版本不支持'; return }
  const r = await api.dbDeletedList()
  if (!r.ok) { el.textContent = '删除记录：读取失败'; return }
  const n = (r.data && Array.isArray(r.data.ids)) ? r.data.ids.length : 0
  el.textContent = n ? `删除记录：${n} 条音源（后续自动采集不再加回）` : '删除记录：暂无'
  const btn = $('btnClearDeleted')
  if (btn) btn.disabled = !n
}
$('btnClearDeleted').addEventListener('click', async () => {
  if (!confirm('清除全部删除记录？\n\n之后下一轮自动爬取 / 采集站同步时，这些音源可能被重新收录（不会立刻出现）。')) return
  const r = await api.dbDeletedClear()
  if (!r.ok) return toast('清除失败：' + r.error, 'err')
  await refreshDeletedInfo()
  toast(`已清除 ${(r.data && r.data.cleared) || 0} 条删除记录`, 'ok')
})
$('searchBox').addEventListener('input', e => { state.query = e.target.value; state.page = 1; renderTable() })
$('hideDeprecated').addEventListener('change', e => { state.hideDeprecated = e.target.checked; state.page = 1; renderTable() })
document.querySelectorAll('#filterSeg .seg-btn').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#filterSeg .seg-btn').forEach(x => x.classList.remove('active'))
    b.classList.add('active')
    state.filter = b.dataset.f
    state.page = 1
    syncExportScope()          // 有勾选时保持「选中项」，否则跟随页签
    renderTable()
  })
})
$('pgPrev').addEventListener('click', () => { if (state.page > 1) { state.page--; renderTable() } })
$('pgNext').addEventListener('click', () => { state.page++; renderTable() })

// ---------------- 任务事件 ----------------
function setBusy(on) {
  state.busy = on
  $('btnCrawl').disabled = on
  $('btnCheck').disabled = on
  $('btnImportSelected').disabled = on
  $('btnImportUsable').disabled = on
  $('btnCancel').disabled = !on
  $('btnCancelImport').disabled = !on
  $('progWrap').hidden = !on
  if (!on) {
    $('btnCancel').textContent = '取消'
    $('btnCancelImport').textContent = '取消'
    $('progStep').textContent = ''
    $('progFill').style.width = '0%'
  }
}

let lastProgAt = 0
// 选择集里可能残留已废弃条目（去重后失效），统计时分开报
function selCounts() {
  let invalid = 0
  for (const id of state.selected) {
    const e = state.sources.find(x => x.id === id)
    if (!e || e.deprecated) invalid++
  }
  return { valid: state.selected.size - invalid, invalid }
}
function selInfoText(suffix) {
  const { valid, invalid } = selCounts()
  return invalid > 0 ? `已选 ${valid} 条（另有 ${invalid} 条已废弃失效） · ${suffix}` : `已选 ${valid} 条 · ${suffix}`
}
api.onEvent(ev => {
  const { type, payload } = ev
  if (type === 'source-updated') {
    const e = payload
    const i = state.sources.findIndex(x => x.id === e.id)
    if (i >= 0) state.sources[i] = e
    else state.sources.unshift(e)
    patchRow(e)
    scheduleStats()
    // 非全部视图时行会进出筛选结果，节流刷新修正列表
    if (state.filter !== 'all' || state.query) scheduleTableRefresh()
    return
  }
  // 公共音源批删进度：删除是串行的，没有这个反馈用户会以为卡死
  if (type === 'pub-delete') {
    const el = $('pubInfo')
    if (el) el.textContent = `正在删除 ${payload.done}/${payload.total} …${payload.success ? '' : '（' + payload.id + ' 失败）'}`
    return
  }
  if (type === 'progress' || type === 'step') {
    const p = payload || {}
    if (type === 'step') $('progStep').textContent = p.text || ''
    else {
      const now = Date.now()
      const isFinal = p.done != null && p.total != null && p.done >= p.total
      if (!isFinal && now - lastProgAt < 180) return   // 节流，避免高频重排
      lastProgAt = now
      if (p.step) $('progStep').textContent = p.step
      const done = p.done != null ? p.done : p.reposDone
      const total = p.total != null ? p.total : p.repoTotal
      if (done != null && total) {
        $('progNum').textContent = `${done}/${total}`
        $('progFill').style.width = Math.min(100, (done / total) * 100) + '%'
      }
    }
    return
  }
  // 多平台灌入（v1.8.0）：任务开始时后端会先把本次目标账号推过来，
  // 用它覆盖页面上的静态提示 —— 后端可能因「账号连不上」而少灌几个，这才是实际情况。
  if (type === 'import-targets') {
    const el = $('importTargets')
    if (el) {
      const t = payload || []
      el.textContent = t.length
        ? `灌入目标：${t.map(x => x.name).join('、')}（${t.length} 个账号${t.length > 1 ? '，同时灌入' : ''}）`
        : '灌入目标：—'
      el.className = 'sub'
    }
    return
  }
  if (type === 'import-item') {
    state.results.push(payload)
    renderImportResults()
    return
  }
  if (type === 'job') {
    if (payload.running) {
      // 兜底：定时巡检/定时爬取等由主进程启动的任务也要进入忙碌态
      setBusy(true)
      return
    }
    setBusy(false)
    loadSources()
    if (payload.cancelled) toast('任务已取消（已完成的结果已保留）', 'warn')
    if (payload.type === 'import') refreshInstalled()
    if (payload.type === 'patrol') {
      refreshInstalled()
      const s = payload.summary || {}
      if (!payload.cancelled) toast(`巡检完成：正常 ${s.ok || 0}、失效禁用 ${s.disabled || 0}、无法判定 ${s.unknown || 0} / 共 ${s.total || 0}`, 'ok')
    }
    if (payload.type === 'crawl' && payload.summary && !payload.cancelled) {
      const s = payload.summary
      toast(s.incremental
        ? `定时爬取完成：新增 ${s.added || 0}、内容更新 ${s.updated || 0}、跳过已抓取 ${s.skipped || 0}`
        : `爬取完成：新增 ${s.added || 0} 条`, 'ok')
    }
  }
})

api.onLog(e => appendLog(e))

// ---------------- 日志（缓冲渲染，切页时一次性刷入；v1.10.8 加筛选/去重/自动刷新） ----------------
const logBuf = []
let logFlushTimer = null
const logKeys = new Set()          // 已渲染行去重（实时推送与轮询可能重叠）
const logKeyOf = e => (e.at || 0) + '|' + (e.module || '') + '|' + (e.msg || '')
function appendLog(e) {
  logBuf.push(e)
  if (logBuf.length > 600) logBuf.splice(0, logBuf.length - 600)
  if (!$('view-logs').classList.contains('active')) return   // 后台页不碰 DOM
  if (logFlushTimer) return
  logFlushTimer = setTimeout(flushLogs, 120)
}
function flushLogs() {
  logFlushTimer = null
  if (!logBuf.length) return
  const box = $('logBox')
  const frag = document.createDocumentFragment()
  for (const e of logBuf) {
    const k = logKeyOf(e)
    if (logKeys.has(k)) continue
    logKeys.add(k)
    frag.appendChild(logLine(e))
  }
  logBuf.length = 0
  if (!frag.childNodes.length) return
  box.appendChild(frag)
  trimLogDom(box)
  applyLogFilter()
  box.scrollTop = box.scrollHeight
}
function trimLogDom(box) {
  while (box.childElementCount > 1500) {
    const first = box.firstChild
    logKeys.delete(first.dataset.key)
    box.removeChild(first)
  }
  if (logKeys.size > 4000) logKeys.clear()
}
function logLine(e) {
  const d = new Date(e.at || Date.now())
  const hh = n => String(n).padStart(2, '0')
  const div = document.createElement('div')
  div.className = 'log-line' + (e.level === 'warn' ? ' warn' : e.level === 'error' ? ' error' : '')
  div.dataset.key = logKeyOf(e)
  div.dataset.module = e.module || ''
  div.dataset.level = e.level || 'info'
  div.innerHTML = `<span class="log-time">${hh(d.getHours())}:${hh(d.getMinutes())}:${hh(d.getSeconds())}</span>` +
    `<span class="log-mod">${esc(e.module || '')}</span><span class="log-msg">${esc(e.msg)}</span>`
  return div
}
// —— 日志筛选 + 自动刷新（v1.10.8）：模块下拉动态收集、级别过滤、进入本页每 5s 拉增量 ——
function logFilterState() {
  return { module: $('logFilterModule').value || '', level: $('logFilterLevel').value || '' }
}
function applyLogFilter() {
  const { module: fm, level: fl } = logFilterState()
  const box = $('logBox')
  let shown = 0
  for (const line of box.children) {
    const ok = (!fm || line.dataset.module === fm) && (!fl || line.dataset.level === fl)
    line.hidden = !ok
    if (ok) shown++
  }
  $('logShownCount').textContent = `显示 ${shown} / ${box.childElementCount} 条`
}
function refreshLogModuleOptions() {
  const sel = $('logFilterModule')
  const cur = sel.value
  const mods = new Set()
  for (const line of $('logBox').children) if (line.dataset.module) mods.add(line.dataset.module)
  sel.innerHTML = '<option value="">全部</option>' + Array.from(mods).sort().map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('')
  sel.value = cur && (cur === '' || mods.has(cur)) ? cur : ''
}
let logPollTimer = null
async function pollLogsOnce() {
  refreshJobChip()
  if (!$('view-logs').classList.contains('active')) return
  if (!$('logAutoRefresh').checked) return
  const r = await api.logsGet()
  if (!r.ok) return
  const box = $('logBox')
  const frag = document.createDocumentFragment()
  for (const e of (r.data || [])) {
    const k = logKeyOf(e)
    if (logKeys.has(k)) continue
    logKeys.add(k)
    frag.appendChild(logLine(e))
  }
  if (!frag.childNodes.length) { applyLogFilter(); return }
  box.appendChild(frag)
  trimLogDom(box)
  refreshLogModuleOptions()
  applyLogFilter()
  box.scrollTop = box.scrollHeight
}
async function refreshJobChip() {
  try {
    const r = await api.jobState()
    if (!r.ok) return
    const d = r.data || {}
    const chip = $('jobChip')
    if (d.running) {
      chip.hidden = false
      chip.textContent = '⏳ ' + (d.step || (d.type === 'crawl' ? '爬取中' : d.type || '任务运行中'))
    } else {
      chip.hidden = true
    }
  } catch (e) { /* 掉线不打扰 */ }
}
function startLogPolling() {
  stopLogPolling()
  pollLogsOnce()
  logPollTimer = setInterval(pollLogsOnce, 5000)
}
function stopLogPolling() {
  if (logPollTimer) { clearInterval(logPollTimer); logPollTimer = null }
}
$('logFilterModule').addEventListener('change', applyLogFilter)
$('logFilterLevel').addEventListener('change', applyLogFilter)

// ---------------- 爬取 / 检测 ----------------
$('btnCrawl').addEventListener('click', async () => {
  setBusy(true)
  $('progStep').textContent = '开始爬取…'
  const r = await api.crawlStart()
  setBusy(false)
  if (r.ok) { toast(`爬取完成，新增 ${r.data.added} 条`, 'ok'); loadSources() }
  else toast('爬取失败: ' + r.error, 'err')
})

$('btnCheck').addEventListener('click', () => {
  const ids = [...state.selected]
  if (!ids.length) return toast('请先勾选要检测的音源（或点表格里的「检测」）')
  // 勾选池是跨筛选全局的：当前筛选下看不到的条目也会被检测（例如先在「全部」勾了一堆
  // 再切到「可用」）。数量对不上时明确告知，避免「我勾的明明是 41 却检了 57」的困惑
  const visible = filtered().length
  const n = ids.length
  if (state.filter !== 'all' && state.filter !== 'selected' && n > visible) {
    if (!confirm(`当前勾选 ${n} 条，但本筛选下只能看到 ${visible} 条（其余是其他筛选页签下的历史勾选）。\n\n「检测选中」会检测全部 ${n} 条。点「已选」页签可先查看/整理勾选。\n\n是否继续？`)) return
  }
  startCheck(ids)
})

// 一键「检测并灌入」：先检测，再把通过的音源批量灌入服务端
$('btnCheckImport').addEventListener('click', async () => {
  const ids = [...state.selected]
  if (!ids.length) return toast('请先勾选要检测的音源')
  setBusy(true)
  $('progStep').textContent = '开始检测…'
  const r = await api.checkStart(ids, { force: true })
  if (!r.ok) { setBusy(false); return toast('检测失败: ' + r.error, 'err') }
  await loadSources()
  // 对账后再算「还该灌谁」：服务端上已经被删掉的那条，本地「已灌入」标记必须先摘掉，
  // 否则「删空服务端再重灌」会被整体排除、点了什么都不发生（用户反馈的「没办法再次灌入」）
  await syncInstalledQuiet(true)
  // 同上：只灌过 A 的源在目标含 B 时仍要进等灌入清单（补灌到 B），不能整体排除
  const okIds = state.sources.filter(e => ids.includes(e.id) && e.usable && !e.deprecated && importedState(e) !== 'all').map(e => e.id)
  if (!okIds.length) {
    setBusy(false)
    return toast(`检测完成：可用 ${r.data.usable} / ${r.data.total}，但本次没有新增可灌入的音源`, 'warn')
  }
  state.results = []
  renderImportResults()
  $('progStep').textContent = '检测完成，开始灌入…'
  const ir = await api.importStart(okIds)
  setBusy(false)
  if (ir.ok) {
    toast(`检测并灌入完成：灌入 ${importSummaryText(ir.data)}（检测可用 ${r.data.usable}）` + (ir.data.replaced ? `，其中替换服务端同名旧版 ${ir.data.replaced} 个` : ''), 'ok')
    loadSources()
    refreshInstalled()
  } else toast('灌入失败: ' + ir.error, 'err')
})

// 快速去重：只下载算哈希（不进沙箱），先按内容去重，检测时直接跳过重复项
$('btnHashDedupe').addEventListener('click', async () => {
  if (state.busy) return toast('已有任务在运行', 'warn')
  setBusy(true)
  $('progStep').textContent = '开始快速去重…'
  const r = await api.hashStart([...state.selected])
  setBusy(false)
  if (r.ok) {
    toast(`去重完成：${r.data.hashed} 条已建立指纹，累计废弃 ${r.data.depTotal} 条重复项`, 'ok')
    loadSources()
  } else toast('去重失败: ' + r.error, 'err')
})

// 撤销去重（v1.12.2）：有勾选 → 只恢复勾选的废弃条目；没勾选 → 恢复全部
$('btnUndedupe').addEventListener('click', async () => {
  if (state.busy) return toast('已有任务在运行', 'warn')
  const selDep = state.sources.filter(e => e.deprecated && state.selected.has(e.id))
  const scoped = selDep.length > 0
  const ids = scoped ? selDep.map(e => e.id) : null
  const scopeTxt = scoped
    ? `撤销勾选的 ${selDep.length} 条废弃条目（其余废弃项不受影响）`
    : '把所有被判为重复的条目恢复为候选'
  if (!confirm(scopeTxt + '。\n\n检测结果和已灌入记录都会保留；恢复后如与同名条目冲突，下次去重按「先测后判」重新裁决。确定继续？')) return
  const r = await api.dbUndedupe(ids)
  if (r.restored > 0) {
    toast(`已恢复 ${r.restored} 条候选（库内共 ${r.total} 条）`, 'ok')
    loadSources()
  } else if (r.busy) toast('已有任务在运行', 'warn')
  else toast(scoped ? '勾选的条目里没有已废弃的重复项' : '当前没有已废弃的重复项', 'info')
})

// 补全平台覆盖：只对「已可用」的条目跑全平台完整检测（关闭快速模式，逐个平台真取链）
$('btnFullPlat').addEventListener('click', async () => {
  if (state.busy) return toast('已有任务在运行', 'warn')
  const pool = state.sources.filter(e => !e.deprecated && e.usable)
  const picked = pool.filter(e => state.selected.has(e.id))
  const targets = (picked.length ? picked : pool).map(e => e.id)
  if (!targets.length) return toast('还没有已可用的音源，先跑一次检测', 'warn')
  if (!confirm(`将对 ${targets.length} 条已可用音源跑全平台完整检测：\n` +
    '五平台逐个真实取链（关闭快速模式），把「未测(?)」的平台补齐为「实测可用/实测失败」，\n' +
    '并对「已取链未校验(~)」的平台重新尝试本机下载校验。\n\n' +
    `耗时约 ${Math.ceil(targets.length * 5 * 3 / 60)} 分钟内（并发取链），确定继续？`)) return
  setBusy(true)
  $('progStep').textContent = '开始全平台完整检测…'
  const r = await api.checkStart(targets, { full: true })
  setBusy(false)
  if (r.ok) {
    toast(`平台覆盖已补全：可用 ${r.data.usable} / ${r.data.total}`, 'ok')
    loadSources()
  } else toast('检测失败: ' + r.error, 'err')
})


async function startCheck(ids) {
  setBusy(true)
  $('btnCheck').textContent = '检测中…'
  $('progStep').textContent = '开始检测…'
  // v1.9.16：手动勾选 = 明确要重测，必须带 force —— 否则「跳过已检测」会把勾选的条目全部
  // 秒跳过，徽章一条不变，用户只会以为批量检测没生效（实测反馈）
  const r = await api.checkStart(ids, { force: true })
  setBusy(false)
  $('btnCheck').textContent = '检测选中'
  if (r.ok) {
    const extra = r.data.notSource ? `，非音源 ${r.data.notSource} 条（已标灰）` : ''
    toast(`检测完成：可用 ${r.data.usable} / ${r.data.total}${extra}`, 'ok')
    loadSources()
  }
  else toast('检测失败: ' + r.error, 'err')
}

function doCancel() {
  $('btnCancel').textContent = '取消中…'
  $('btnCancelImport').textContent = '取消中…'
  api.jobCancel().then(r => {
    if (r.ok && !r.data.cancelled) toast('当前没有正在运行的任务')
  })
}
$('btnCancel').addEventListener('click', doCancel)
$('btnCancelImport').addEventListener('click', doCancel)

// ---------------- 灌入 ----------------
$('btnImportSelected').addEventListener('click', () => {
  const ids = [...state.selected]
  if (!ids.length) return toast('请先勾选要灌入的音源')
  startImport(ids)
})
$('btnImportUsable').addEventListener('click', () => {
  const ids = state.sources.filter(e => e.usable && !e.deprecated).map(e => e.id)
  if (!ids.length) return toast('库里还没有检测通过的音源，先跑一次检测')
  startImport(ids)
})

/** 灌入结果的一句话汇总（多平台时按账号拆开报，否则「有的平台没灌」看起来像失败） */
function importSummaryText(d) {
  const s = (d && d.summary) || {}
  let msg = `成功 ${d.ok} / ${d.results.length}`
  if (s.synced) msg += `、同名已存在 ${s.synced}`
  if (s.skipped) msg += `、跳过 ${s.skipped}`
  const bp = s.byPlatform
  if (bp && Object.keys(bp).length > 1) {
    msg += '（' + Object.entries(bp).map(([k, v]) => `${k} ${v.ok}/${v.total}`).join('；') + '）'
  }
  return msg
}

async function startImport(ids) {
  setBusy(true)
  $('progStep').textContent = '开始灌入…'
  state.results = []
  renderImportResults()
  const r = await api.importStart(ids)
  setBusy(false)
  if (r.ok) {
    toast('灌入完成：' + importSummaryText(r.data), r.data.ok ? 'ok' : 'warn')
    loadSources()
    refreshInstalled()
  } else toast('灌入失败: ' + r.error, 'err')
}

function renderImportResults() {
  const body = $('impBody')
  body.innerHTML = ''
  for (const r of state.results) {
    const cls = (r.status === 'success' || r.status === 'replaced') ? 'ok' : r.status === 'failed' ? 'fail' : (r.status === 'synced' ? 'ok' : 'warn')
    const label = r.status === 'success' ? '成功' : r.status === 'replaced' ? '已替换' : r.status === 'failed' ? '失败' : (r.status === 'synced' ? '已同步' : '跳过')
    const tr = document.createElement('tr')
    // 多平台灌入时补一列「账号」：同名音源在不同平台结果不同，没有这列看不出是谁失败了
    const acct = r.accountName ? `<span class="badge plat-tag" title="${esc(r.platformType || '')}">${esc(r.accountName)}</span>` : ''
    tr.innerHTML = `<td>${esc(r.name)}</td><td class="repo">${esc(r.lxId || '')}</td>` +
      `<td>${acct}</td>` +
      `<td><span class="badge ${cls}">${label}</span></td><td class="nm-sub">${esc(r.message || '')}</td>`
    body.appendChild(tr)
  }
  $('impEmpty').hidden = state.results.length > 0
}

$('btnManualImport').addEventListener('click', async () => {
  const url = $('manualUrl').value.trim()
  if (!url) return toast('请填写音源脚本 URL')
  const r = await api.importUrl(url, $('manualName').value.trim())
  if (r.ok && r.data && r.data.success) {
    toast('已灌入：' + (r.data.name || url), 'ok')
    state.results.push({ name: r.data.name || url, status: 'success', lxId: r.data.id, message: r.data.message || '' })
    renderImportResults()
    refreshInstalled()
  } else toast('灌入失败：' + (((r.data && r.data.message)) || r.error), 'err')
})

// ---------------- 已灌入 ----------------
async function refreshInstalled() {
  const active = state.platforms.find(p => p.id === state.activePlatformId)
  const body = $('insBody')
  if (!active) {
    body.innerHTML = ''
    const info = $('insInfo')
    if (info) info.textContent = '未配置服务平台账号'
    const empty = $('insEmpty')
    if (empty) { empty.hidden = false; empty.textContent = '请先在「设置 → 服务平台账号」里添加并选中一个账号，再管理其音源' }
    const pubCard = $('pubCard')
    if (pubCard) pubCard.hidden = true
    return
  }
  const r = await api.serviceList()
  if (!r.ok) {
    // v1.10.2：断线不再清空「已灌入」页。读失败只说明链路断了，不等于服务端上没有
    // 这些脚本；把整页抹掉既丢信息，又让人误以为服务端被清空。保留上次成功读取的
    // 列表 + 黄条标注，同时清勾选池并禁止一切写操作 —— 旧快照绝不能拿去发删除请求。
    if (state.installedFor !== active.id) state.installed = []   // 别拿别的账号的列表顶替
    state.installedStale = true
    state.insSel.clear()
    renderInstalledRows()
    applyInstalledStale()
    const info = $('insInfo')
    if (info) info.textContent = `读取失败：${r.error} · 当前显示的是本地快照（非实时）`
    const empty = $('insEmpty')
    if (empty && !(state.installed || []).length) empty.textContent = '尚未成功读取过该账号的服务端音源列表'
    return
  }
  state.installed = r.data || []
  state.installedFor = active.id
  state.installedAt = Date.now()
  state.installedStale = false
  // 账本对账：服务端已经删掉的音源，本地那条灌入记录跟着摘掉。不做的话，「删空服务端再重灌」
  // 会被库里那枚「已灌入」标记整体排除 —— 表现为「点了灌入但什么都没发生」（用户实测反馈）。
  // 只在刚刚成功读到列表时才对账（上面的失败分支绝不能走到这里）。
  await reconcileLedger(active.id, state.installed)
  renderInstalledRows()
  applyInstalledStale()
  // 顺带刷新「公共音源清理」面板：两者读的是同一份服务端数据，避免要用户点两次
  loadPublic()
}

/**
 * 快照态的可见提示与禁写（v1.10.2）。
 * 保留列表本身会带来一个新风险：旧快照被当成实时列表拿去删。所以显示快照的同时
 * 必须清勾选池、禁用所有服务端写按钮；恢复成功后 refreshInstalled 会关掉这个状态。
 */
function applyInstalledStale() {
  const on = !!state.installedStale
  const banner = $('insSnapshot')
  if (banner) {
    banner.hidden = !on
    if (on) {
      const has = (state.installed || []).length > 0
      const when = state.installedAt
        ? new Date(state.installedAt).toLocaleString('zh-CN', { hour12: false })
        : '时间未知'
      banner.textContent = has
        ? `当前未连接推送服务端：以下为上次成功读取的快照（${when}），列表可能已过期，请勿据此删除或停用音源。连接恢复后点「刷新」即可与服务端对账。`
        : '当前未连接推送服务端：还没有成功读取过该账号的服务端列表，无法判断服务端现状。连接恢复后点「刷新」再操作。'
    }
  }
  const card = $('insCard')
  if (card) card.classList.toggle('stale', on)
  const sels = '#insBody button[data-t], #insBody button[data-del], #insBody input[data-ins], #insChkAll, #btnInsDelSel, #btnInsSelFailed, #btnEnableAll, #btnRevokeSelected, #btnPubDelSel, #btnPubDelAll'
  document.querySelectorAll(sels).forEach(el => {
    if (on) { el.dataset.staleOff = '1'; el.disabled = true }
    else if (el.dataset.staleOff === '1') { delete el.dataset.staleOff; el.disabled = false }
  })
  if (!on) renderInsSelInfo()   // btnInsDelSel / 全选框的启用条件要按勾选数重算
}

// 捕获阶段兜底：即使别处（如 setInsBusy(false)）把按钮重新启用，快照态也不允许
// 拿旧列表发任何服务端写请求；键盘触发同样拦得住。
const insCardEl = $('insCard')
if (insCardEl) {
  insCardEl.addEventListener('click', ev => {
    if (!state.installedStale) return
    if (ev.target.closest('button[data-t], button[data-del], #btnInsDelSel, #btnInsSelFailed, #btnEnableAll, #btnRevokeSelected, #btnPubDelSel, #btnPubDelAll')) {
      ev.preventDefault(); ev.stopImmediatePropagation()
      toast('当前显示的是离线快照：请先连接推送服务端并点「刷新」对账，再执行删除 / 停用', 'err')
    }
  }, true)
  insCardEl.addEventListener('change', ev => {
    if (!state.installedStale) return
    if (ev.target.closest('input[data-ins], #insChkAll')) {
      ev.preventDefault(); ev.stopImmediatePropagation(); ev.target.checked = false
    }
  }, true)
}

/** 一行已灌入音源（纯 DOM 构造，排序时复用，不重新拉服务端） */
// 平台徽章两态（v1.9.17，对齐 LX 管理页的显示方式）：
//   启用 = 绿 / 被停用（disabledSources 里有，LX 端删除线置灰）= 红；
//   **音源不支持的平台照旧不显示**（用户明确要求：不要补灰的占位）。
// 数据来自服务端 list 已返回的 supportedSources + disabledSources，不需要额外请求。
// 之前只按 supportedSources 全渲染成绿色，lx-music 端停用了某平台完全看不出来。
function platBadges(s) {
  const sup = Array.isArray(s && s.supportedSources) ? s.supportedSources : []
  const ds = new Set(Array.isArray(s && s.disabledSources) ? s.disabledSources : [])
  // 按五平台固定顺序展示，脚本自报的非标准平台附加在后（顺序稳定才方便横向对比）
  const known = PLAT.map(x => x.k).filter(k => sup.includes(k))
  const extra = sup.filter(k => !PLAT.some(x => x.k === k))
  return known.concat(extra).map(k => {
    const t = PLAT.find(x => x.k === k)
    const label = t ? t.t : esc(k)
    return ds.has(k)
      ? `<span class="plat off" title="${label}：已停用（LX 端删除线置灰，取歌时跳过该平台）">${label}</span>`
      : `<span class="plat usable" title="${label}：启用">${label}</span>`
  }).join('')
}

function installedRow(s, st, active) {
  const tr = document.createElement('tr')
  tr.dataset.rank = st.rank
  const plats = platBadges(s) || '<span class="nm-sub">—</span>'
  // 停用分两种，必须分开说清（v1.6.5 前「已停用」一个词混用两者，用户对照 LX 管理页显示
  // 「已启用」会以为状态不同步）：
  //  - 平台级停用（disabledSources）：本工具/巡检写的，只写服务端 states.json，
  //    LX 管理页里该音源的平台徽章会置灰（删除线）——即网页端可见的停用；
  //    全局开关仍显示「已启用」是正常的，取歌时这些平台会被跳过
  //  - 全局禁用（enabled=false）：服务端正式开关，LX 管理页也显示禁用
  const ds = st.ds || []
  const globalOff = !!st.globalOff
  const platformOff = !!st.platformOff
  const stopped = globalOff || platformOff
  // 私有源（owner 非 open）：只对同名账号可用，LX 网页端公开列表里根本看不到它 ——
  // 用户拿着猎手里的停用状态去网页端对不上，就是因为它（v1.6.7 明确标注）
  const isPrivate = !!(s.owner && s.owner !== 'open' && s.owner !== '_open')
  const privBadge = isPrivate
    ? `<span class="badge gray" title="私有音源（归属「${esc(s.owner)}」账号）：只对该账号可用，LX 网页端公开列表里看不到、也管不了——这是正常现象，不是状态不同步。\n停用状态按「${esc(s.owner)}」身份存储，猎手显示与服务端一致。">私有·${esc(s.owner)}</span>`
    : ''
  const badge = globalOff
    ? '<span class="badge gray" title="服务端全局开关为禁用（与 LX 管理页显示一致）">已禁用</span>'
    : platformOff
      ? `<span class="badge gray" title="平台级停用（${esc(ds.join(' / '))}）：取歌时这些平台会被跳过。\n${isPrivate ? '私有源：停用按「' + esc(s.owner) + '」身份写入，仅对该身份取歌生效；网页端公开列表看不到此源。' : 'LX 网页端音源管理页该音源的平台徽章会同步置灰（删除线）；全局开关仍显示「已启用」是正常的。'}点「启用」即可恢复。">已停用</span>`
      : '<span class="badge ok">已启用</span>'
  // 巡检结论（只有巡检跑过的音源才有）：这是判断「这条还能不能用」最直接的依据，
  // 直接摆到状态列上，用户点表头把失效排到最前就能批量挑出来删掉
  let patrolBadge = ''
  const p = st.patrol
  if (p && p.at) {
    const when = new Date(p.at).toLocaleString('zh-CN', { hour12: false })
    patrolBadge = p.ok
      ? `<span class="badge ok" title="巡检通过（${esc(when)}）">巡检正常</span>`
      : `<span class="badge dead" title="巡检判定失效（${esc(when)}）：${esc(p.note || '')}\n通常已被巡检自动停用；确认不需要了就勾选删除。可点「健康巡检」重测一次。">巡检失效</span>`
  }
  const svcBadge = s.status && s.status !== 'success' ? `<span class="badge warn">${esc(s.status)}</span>` : ''
  // 私有源也要能勾（本页删的是「服务端上该账号可见的音源」，公共清理才只碰公开源）；
  // 但删除时按各自的 owner 路由身份，否则对私有源不生效
  tr.innerHTML = `
    <td><input type="checkbox" data-ins="${esc(s.id)}"${state.insSel.has(s.id) ? ' checked' : ''} title="勾选后可点上方「删除选中」批量删除"></td>
    <td><span class="nm">${esc(s.name || s.id)}</span><span class="nm-sub">${esc([s.version, s.author].filter(Boolean).join(' · '))}</span><br><span class="badge plat-tag" title="所属平台账号（当前选中）">${esc(active.name || active.url)}</span></td>
    <td class="repo">${esc(s.id)}</td>
    <td class="c-plat"><div class="plats">${plats}</div></td>
    <td>${privBadge}${patrolBadge}${badge}${svcBadge}</td>
    <td class="c-op">
      <button class="btn sm" data-t="${esc(s.id)}" data-stop="${stopped ? 0 : 1}" data-goff="${globalOff ? 1 : 0}" title="${stopped ? '恢复该音源参与解析' : '让该音源不参与解析（不触发服务端重载）'}">${stopped ? '启用' : '停用'}</button>
      <button class="btn sm" data-del="${esc(s.id)}">删除</button>
    </td>`
  return tr
}

/**
 * 已灌入列表渲染（排序 + 勾选收敛）。
 * 排序只重排本地数组，不再打服务端 —— 点表头来回切不会一次次触发全量脚本重载。
 */
function renderInstalledRows() {
  const body = $('insBody')
  if (!body) return
  const active = state.platforms.find(p => p.id === state.activePlatformId) || { name: '', url: '' }
  const byLxId = ledgerByLxId()
  const rows = (state.installed || []).map((s, i) => ({ s, i, st: insRowState(s, byLxId) }))
  if (state.insSort.key === 'istatus') {
    const dir = state.insSort.dir === 'desc' ? -1 : 1
    rows.sort((a, b) => (a.st.rank - b.st.rank) * dir || a.i - b.i)
  }
  body.innerHTML = ''
  for (const { s, st } of rows) body.appendChild(installedRow(s, st, active))
  const list = state.installed || []
  $('insEmpty').hidden = list.length > 0
  const privN = list.filter(s => s.owner && s.owner !== 'open' && s.owner !== '_open').length
  const insUser = $('insUser')
  if (insUser) {
    insUser.textContent = privN ? `· 含 ${privN} 个私有音源` : ''
    insUser.title = privN
      ? `有 ${privN} 个音源是私有源（归属某个账号）：只对该账号可用，LX 网页端公开列表里看不到、也管不了——这是正常现象。其停用状态按归属身份存储，猎手显示与服务端一致`
      : ''
  }
  const badN = rows.filter(r => r.st.rank === 0).length
  const offN = rows.filter(r => r.st.rank === 1).length
  $('insInfo').textContent = `共 ${list.length} 个自定义音源`
    + (badN ? ` · 巡检失效 ${badN} 个` : '')
    + (offN ? ` · 已停用 ${offN} 个` : '')
  // 勾选池收敛：服务端已经删掉的 id 要跟着消失（否则会重复删、报一堆失败）
  const liveIds = new Set(list.map(s => s.id))
  for (const id of Array.from(state.insSel)) if (!liveIds.has(id)) state.insSel.delete(id)
  renderInsSelInfo()
  renderInsSortHeads()
  renderStats()   // 「已灌入 · 当前账号」卡片跟着这份列表走
}

/**
 * 静默同步当前账号的服务端列表（启动时调用）：只更新统计卡与账本对账，不打扰用户。
 * 已经有该账号的列表就不重复拉（切到「已灌入」页 / 同步服务端时自然会刷新）。
 */
async function syncInstalledQuiet(force) {
  const active = state.platforms.find(p => p.id === state.activePlatformId)
  if (!active) return
  if (!force && state.installedFor === active.id) return
  const r = await api.serviceList()
  if (!r || !r.ok) return
  state.installed = r.data || []
  state.installedFor = active.id
  state.installedAt = Date.now()
  state.installedStale = false
  await reconcileLedger(active.id, state.installed)
  renderInstalledRows()
  applyInstalledStale()
}

/** 已灌入页表头排序箭头（只有「状态」一列可排） */
function renderInsSortHeads() {
  document.querySelectorAll('#insTable th.sortable').forEach(th => {
    const on = state.insSort.key === th.dataset.k
    th.classList.toggle('sorted', on)
    th.setAttribute('aria-sort', on ? (state.insSort.dir === 'asc' ? 'ascending' : 'descending') : 'none')
    const ar = th.querySelector('.sort-arrow')
    if (ar) ar.textContent = on ? (state.insSort.dir === 'asc' ? '▲' : '▼') : ''
  })
}

/** 已灌入列表的勾选状态：计数文案 + 全选框三态 */
function renderInsSelInfo() {
  const total = (state.installed || []).length
  const n = state.insSel.size
  const info = $('insSelInfo')
  if (info) {
    let extra = ''
    if (n) {
      const byLxId = ledgerByLxId()
      let bad = 0, off = 0
      for (const s of (state.installed || [])) {
        if (!state.insSel.has(s.id)) continue
        const st = insRowState(s, byLxId)
        if (st.rank === 0) bad++
        else if (st.rank === 1) off++
      }
      const parts = []
      if (bad) parts.push(`巡检失效 ${bad}`)
      if (off) parts.push(`已停用 ${off}`)
      if (parts.length) extra = `（${parts.join('、')}）`
    }
    info.textContent = n ? `已勾选 ${n} 个${extra}` : ''
    info.title = n ? '点上方「删除选中」批量删除（串行执行，服务端逐个重载脚本）' : '勾选左侧复选框后可批量删除'
  }
  const btn = $('btnInsDelSel')
  if (btn) btn.disabled = n === 0
  const chkAll = $('insChkAll')
  if (chkAll) {
    chkAll.checked = total > 0 && n === total
    chkAll.indeterminate = n > 0 && n < total
    chkAll.disabled = total === 0
  }
}

// 勾选/取消 + 全选（事件委托，避免每行重复绑定）
$('insBody').addEventListener('change', ev => {
  const cb = ev.target.closest('input[data-ins]')
  if (!cb) return
  if (cb.checked) state.insSel.add(cb.dataset.ins)
  else state.insSel.delete(cb.dataset.ins)
  renderInsSelInfo()
})
$('insChkAll').addEventListener('change', ev => {
  const on = ev.target.checked
  state.insSel.clear()
  if (on) for (const s of (state.installed || [])) state.insSel.add(s.id)
  // 重渲染一次让每行的勾选态跟上（全选后行内 checkbox 也要打勾）
  document.querySelectorAll('#insBody input[data-ins]').forEach(cb => { cb.checked = on })
  renderInsSelInfo()
})

// 已灌入页「状态」列排序（v1.8.0）：默认把失效/停用排在最前面，方便一眼看出哪些该清掉。
// 只重排本地数组、不重新拉服务端 —— 来回点表头不会一次次触发服务端的全量脚本重载。
document.querySelectorAll('#insTable th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const k = th.dataset.k
    if (!k) return
    if (state.insSort.key === k) state.insSort.dir = state.insSort.dir === 'asc' ? 'desc' : 'asc'
    else { state.insSort.key = k; state.insSort.dir = 'asc' }
    renderInstalledRows()
  })
})

// 一键勾选「失效 / 停用」的音源：用户拿它批量清掉服务端上已经用不了的已灌入音源
$('btnInsSelFailed').addEventListener('click', () => {
  const byLxId = ledgerByLxId()
  const hit = (state.installed || []).filter(s => insRowState(s, byLxId).rank <= 1)
  state.insSel.clear()
  if (hit.length) for (const s of hit) state.insSel.add(s.id)
  document.querySelectorAll('#insBody input[data-ins]').forEach(cb => { cb.checked = state.insSel.has(cb.dataset.ins) })
  renderInsSelInfo()
  if (!hit.length) return toast('当前账号没有失效 / 停用的音源', 'info')
  const bad = hit.filter(s => insRowState(s, byLxId).rank === 0).length
  const off = hit.length - bad
  toast(`已勾选 ${hit.length} 个` + (bad || off ? `（${[bad ? `巡检失效 ${bad}` : '', off ? `已停用 ${off}` : ''].filter(Boolean).join('、')}）` : '')
    + '，确认后点「删除选中」', 'ok')
})

// 已灌入页操作在途锁：这些操作都会触发服务端「整轮脚本重载」，旧版服务端可能长时间无响应。
// 没有忙态保护时用户连点会叠加多次全量重载，把服务端进一步拖垮（表现为只能重启容器）。
let insBusy = false
function setInsBusy(on) {
  insBusy = !!on
  document.querySelectorAll('#insBody button[data-t], #insBody button[data-del], #insBody input[data-ins], #insChkAll, #btnInsDelSel, #btnInsSelFailed, #btnPubRefresh, #btnPubDelSel, #btnPubDelAll').forEach(el => { el.disabled = !!on })
}
// 超时/中断类错误给出可诊断的提示（而不是冷冰冰一句 abort）
function serverErrHint(msg) {
  const m = String(msg || '')
  return /abort|timeout|timed out|超时/i.test(m)
    ? `${m}（服务端长时间无响应，通常是 LX 服务端正在全量重载脚本卡住；请看服务端日志，必要时重启容器）`
    : m
}

/**
 * 平台侧「业务态」卡住导致的失败：给可操作指引。
 * 实测（Songloft lxmusic 插件）：脚本初始化失败的音源会一直停在「音源正在检测」，
 * 此时删除和切换状态都会被拒 —— 用户看到这句原始报错只会一头雾水。
 */
function delBizHint(msg) {
  const m = String(msg || '')
  if (/正在检测/.test(m)) {
    return `${m}（该平台正在检测这个音源，稍后重试；一直失败就到平台的音源管理页手动删除，或重启该平台的服务/容器）`
  }
  if (/plugin execution failed|初始化失败/i.test(m)) {
    return `${m}（脚本在服务端初始化失败。常见原因：脚本内部校验自身名称，改名后失效 —— 用「同名自动替换」重新灌入原版脚本可恢复）`
  }
  return m
}

// 让某个音源彻底不参与解析，需要把它支持的每个平台都写进 disabledSources。
// 取「音源自报支持列表」与「本工具已知全部平台」的并集 —— 避免脚本实际注册的平台
// 与入库时记录的列表不一致时，出现停用不干净的情况。
function allPlatforms(s) {
  const own = Array.isArray(s && s.supportedSources) ? s.supportedSources : []
  return Array.from(new Set(own.concat(PLAT.map(x => x.k))))
}

// ---------------- 公共音源清理（v1.7.4） ----------------
// 需求：只删服务端「公共音源」（owner=open，即 LX 网页端音源管理页看得到的那批，
// 猎手灌入的音源都落在这里），各账号内的私有音源绝不触碰。
// 思路沿用「已灌入」页踩过的坑：
//  1. 删除必触发服务端全量重载 → 串行执行、在途锁（复用 insBusy）、逐条进度反馈；
//  2. 结果要对账（哪个其实已不在服务端），不能只报一个总数；
//  3. 危险操作强确认，明说「删除」与「停用」的代价差异（停用不重载、秒级）。
/** 拉取服务端公共音源列表（服务端侧已按 owner 过滤，私有源不会进来） */
async function loadPublic() {
  const r = await api.serviceListPublic()
  if (!r.ok) {
    const el = $('pubInfo')
    if (el) el.textContent = '读取失败：' + r.error
    return false
  }
  state.pubList = r.data || []
  // 勾选池收敛：服务端已经删掉的 id 要跟着消失（否则会重复删、报一堆失败）
  const ids = new Set(state.pubList.map(s => s.id))
  for (const id of Array.from(state.pubSel)) if (!ids.has(id)) state.pubSel.delete(id)
  renderPublic()
  return true
}

function renderPublic() {
  const body = $('pubBody')
  if (!body) return
  body.innerHTML = ''
  for (const s of state.pubList) {
    const tr = document.createElement('tr')
    const plats = platBadges(s) || '<span class="nm-sub">—</span>'
    const ds = Array.isArray(s.disabledSources) ? s.disabledSources : []
    const badge = s.enabled === false
      ? '<span class="badge gray">已禁用</span>'
      : ds.length
        ? `<span class="badge gray" title="平台级停用：${esc(ds.join(' / '))}">已停用</span>`
        : '<span class="badge ok">已启用</span>'
    tr.innerHTML = `
      <td><input type="checkbox" data-pub="${esc(s.id)}"${state.pubSel.has(s.id) ? ' checked' : ''}></td>
      <td><span class="nm">${esc(s.name || s.id)}</span><span class="nm-sub">${esc([s.version, s.author].filter(Boolean).join(' · '))}</span></td>
      <td class="repo">${esc(s.id)}</td>
      <td class="c-plat"><div class="plats">${plats}</div></td>
      <td>${badge}</td>`
    body.appendChild(tr)
  }
  const empty = $('pubEmpty')
  if (empty) {
    empty.hidden = state.pubList.length > 0
    empty.textContent = state.pubList.length ? '' : '服务端暂无公共音源（公共音源 = LX 网页端音源管理页可见的那批）'
  }
  const info = $('pubInfo')
  if (info) info.textContent = `共 ${state.pubList.length} 个公共音源，已勾选 ${state.pubSel.size} 个`
  // 私有源提示：讲清「不在本列表、也不会被删」，避免用户误以为漏了
  const privN = (state.installed || []).filter(s => s.owner && s.owner !== 'open' && s.owner !== '_open').length
  const priv = $('pubPriv')
  if (priv) {
    priv.textContent = privN ? `· 另有 ${privN} 个私有音源不在本列表` : ''
    priv.title = privN
      ? `这 ${privN} 个音源归属具体账号（私有源），只对该账号可用、LX 网页端公开列表看不到。\n本功能只删公共音源，不会触碰它们。`
      : ''
  }
  const chkAll = $('pubChkAll')
  if (chkAll) {
    chkAll.checked = state.pubList.length > 0 && state.pubSel.size === state.pubList.length
    chkAll.indeterminate = state.pubSel.size > 0 && state.pubSel.size < state.pubList.length
    chkAll.disabled = state.pubList.length === 0
  }
}

/**
 * 批量删除公共音源（串行；服务端每个删除都要全量重载脚本，数量多时很慢）
 * @param ids 要删的公共源 id（调用方保证是公共源）
 * @param title 确认框标题
 */
async function runPubDelete(ids, title) {
  if (!ids.length) return toast('没有选中任何公共音源', 'info')
  if (insBusy) return toast('上一个服务端操作仍在处理中，请稍候…')
  const names = ids.map(id => {
    const s = (state.pubList || []).find(x => x.id === id)
    return (s && (s.name || s.id)) || id
  })
  const preview = '  · ' + names.slice(0, 8).join('\n  · ') + (names.length > 8 ? `\n  · …等共 ${names.length} 个` : '')
  // 耗时估算：每个删除 = 服务端全量重载（约 30s）+ 保护间隔（默认 5s）
  const gapMs = (state.config && state.config.serverDeleteIntervalMs != null) ? Number(state.config.serverDeleteIntervalMs) : 5000
  const mins = Math.max(1, Math.round(ids.length * (30 + gapMs / 1000) / 60))
  const risk = ids.length > 10
    ? `\n- 数量较多：lxserver 连续重载脚本有假死风险，已自动在每个删除之间留 ${Math.round(gapMs / 1000)} 秒；中途若出现网络超时会自动停止，未删的可稍后重删。`
    : ''
  if (!confirm(
    `${title}\n\n将删除 ${ids.length} 个公共音源：\n${preview}\n\n` +
    `- 只删公共音源，各账号私有音源不受影响；\n` +
    `- 每删一个都会让 LX 服务端全量重载脚本，${ids.length} 个约需 ${mins} 分钟以上，期间服务端可能无响应；\n` +
    `- 若只是不想让它们参与解析，请用上方「停用」（不触发重载，秒级完成）。${risk}\n\n确定删除？`
  )) return
  setInsBusy(true)
  const info = $('pubInfo')
  if (info) info.textContent = `正在删除 0/${ids.length} …（服务端逐个重载，请耐心等待）`
  try {
    const r = await api.serviceRemovePublicBatch(ids)
    if (!r.ok) { toast('删除失败：' + serverErrHint(r.error), 'err'); return }
    const d = r.data || {}
    const failed = (d.results || []).filter(x => !x.success)
    if (d.aborted) {
      // 服务端已经在重载/假死：整批中止，剩余项不动（继续删只会更糟）
      toast(`服务端响应异常，已中止：成功 ${d.ok || 0}、失败 ${failed.length}，剩余 ${(d.skipped || []).length} 个未删。请先在服务端确认状态（必要时重启容器），稍后重删剩余项`, 'err')
    } else if (!failed.length) {
      toast(`已删除 ${d.ok || 0} 个公共音源`, 'ok')
    } else {
      // 对账：逐条说明失败原因（最常见是网页端已经手动删过）
      const first = failed.slice(0, 3).map(x => `${x.id}（${x.message || '失败'}）`).join('；')
      toast(`删除完成：成功 ${d.ok || 0}、失败 ${failed.length}。失败项：${first}${failed.length > 3 ? ' 等' : ''}（可能是网页端已手动删除）`, 'warn')
    }
    state.pubSel.clear()
    await loadPublic()
    refreshInstalled()
    // 库内「已灌入」标记按服务端现状刷新一次（删掉的不再算已灌入）
    try { await api.serverSync(); await loadSources() } catch (e) {}
  } finally {
    setInsBusy(false)
    renderPublic()
  }
}

$('pubBody').addEventListener('change', ev => {
  const cb = ev.target.closest('input[data-pub]')
  if (!cb) return
  if (cb.checked) state.pubSel.add(cb.dataset.pub)
  else state.pubSel.delete(cb.dataset.pub)
  renderPublic()
})

$('pubChkAll').addEventListener('change', ev => {
  if (ev.target.checked) for (const s of state.pubList) state.pubSel.add(s.id)
  else state.pubSel.clear()
  renderPublic()
})

$('btnPubRefresh').addEventListener('click', async () => {
  if (insBusy) return toast('上一个服务端操作仍在处理中，请稍候…')
  const ok = await loadPublic()
  if (ok) toast(`已读取服务端公共音源 ${state.pubList.length} 个`, 'ok')
})

$('btnPubDelSel').addEventListener('click', async () => {
  await runPubDelete(Array.from(state.pubSel), '删除选中的公共音源')
})

$('btnPubDelAll').addEventListener('click', async () => {
  await runPubDelete((state.pubList || []).map(s => s.id), '清空服务端全部公共音源')
})

$('insBody').addEventListener('click', async ev => {
  if (insBusy) { toast('上一个服务端操作仍在处理中，请稍候…'); return }
  const t = ev.target.closest('button[data-t]')
  if (t) {
    const id = t.dataset.t
    const doStop = t.dataset.stop === '1'          // 1=本次要停用，0=本次要启用
    const globalOff = t.dataset.goff === '1'       // 服务端全局 disabled（非平台级）
    // 全局禁用的源只能靠 toggle 恢复，而 toggle 会触发服务端全量重载脚本（有假死风险），先说清楚
    if (!doStop && globalOff) {
      if (!confirm('该音源当前是「全局禁用」状态。\n\n恢复启用必须调用服务端的正式开关接口，该接口会让 LX 服务端全量重新加载所有脚本（期间可能几十秒无响应，极端情况需重启容器）。\n\n是否仍要继续？')) return
      setInsBusy(true)
      try {
        const target0 = (state.installed || []).find(x => x.id === id)
        const r = await api.serviceToggle(id, true, target0 && target0.owner)
        if (r.ok && r.data.success) { toast('已启用', 'ok'); refreshInstalled() }
        else toast('启用失败：' + serverErrHint((r.data && r.data.message) || r.error), 'err')
      } finally { setInsBusy(false) }
      return
    }
    // 其余一律走「平台级」停用/启用：只写服务端 states.json，不重载脚本 —— 不会把服务端拖垮
    const target = (state.installed || []).find(x => x.id === id)
    const list = doStop ? allPlatforms(target) : []
    setInsBusy(true)
    try {
      // owner：私有源（owner=admin 等）的停用必须写其归属身份那份 states，否则对它不生效
      const r = await api.servicePlatforms(id, list, target && target.owner)
      if (r.ok && r.data && r.data.success) {
        const priv = target && target.owner && target.owner !== 'open' && target.owner !== '_open'
        toast(priv ? (doStop ? `已停用（按 ${target.owner} 身份写入，网页端公开列表看不到此私有源）` : '已启用')
          : (doStop ? '已停用（LX 网页端同步生效）' : '已启用（LX 网页端同步生效）'), 'ok')
        refreshInstalled(); return
      }
      // 老版本服务端没有 update-platforms 接口：退回 toggle，保证功能仍可用
      const msg = (r.data && r.data.message) || r.error || ''
      if (/HTTP 40[0-9]|不存在|not found/i.test(msg)) {
        const r2 = await api.serviceToggle(id, !doStop, target && target.owner)
        if (r2.ok && r2.data.success) { toast(doStop ? '已停用' : '已启用', 'ok'); refreshInstalled() }
        else toast('操作失败：' + serverErrHint((r2.data && r2.data.message) || r2.error), 'err')
        return
      }
      toast('操作失败：' + serverErrHint(msg), 'err')
    } finally { setInsBusy(false) }
    return
  }
  const d = ev.target.closest('button[data-del]')
  if (d) {
    if (!confirm('确定从服务端删除该音源？\n\n注意：删除会让 LX 服务端全量重载所有脚本，期间可能几十秒无响应。\n\n若只是不想让它参与解析，建议改用左侧「停用」（不触发重载，秒级完成且不会卡死服务端）。')) return
    setInsBusy(true)
    try {
      const target = (state.installed || []).find(x => x.id === d.dataset.del)
      const r = await api.serviceRemove(d.dataset.del, target && target.owner)
      if (r.ok && r.data.success) { toast('已删除', 'ok'); refreshInstalled() }
      else toast('删除失败：' + delBizHint(serverErrHint((r.data && r.data.message) || r.error)), 'err')
    } finally { setInsBusy(false) }
  }
})

/**
 * 批量删除已灌入列表里勾选的音源（v1.8.0）
 *
 * 与单行删除的差别只在「批量」，风险处理方式完全沿用公共音源清理踩过的坑：
 *  1. 串行执行 —— 服务端每删一个就全量重载脚本，并发会把服务端拖到假死；
 *  2. 在途锁（insBusy）+ 逐条进度，用户看得到第 n/N 个，不会以为卡死；
 *  3. 失败不中断，最后对账（成功/失败逐条），已不在服务端的算「无需删除」；
 *  4. 删除前强确认，明说「删除」与「停用」的代价差异。
 * 删除按每条音源各自的 owner 路由身份 —— 私有源若按 default 身份删会删不掉。
 */
$('btnInsDelSel').addEventListener('click', async () => {
  if (insBusy) return toast('上一个服务端操作仍在处理中，请稍候…')
  const picked = (state.installed || []).filter(s => state.insSel.has(s.id))
  if (!picked.length) return toast('还没有勾选任何音源', 'info')

  const active = state.platforms.find(p => p.id === state.activePlatformId)
  const isLx = active && (active.type === 'lxserver' || active.type === 'geelonn')
  const privN = picked.filter(s => s.owner && s.owner !== 'open' && s.owner !== '_open').length

  const preview = '  · ' + picked.slice(0, 8).map(s => s.name || s.id).join('\n  · ') +
    (picked.length > 8 ? `\n  · …等共 ${picked.length} 个` : '')
  // lxserver 每删一个都要全量重载（约 30s）+ 保护间隔；其余平台是秒级，别按这个吓唬人
  const gapMs = isLx
    ? ((state.config && state.config.serverDeleteIntervalMs != null) ? Number(state.config.serverDeleteIntervalMs) : 5000)
    : 200
  const mins = isLx ? Math.max(1, Math.round(picked.length * (30 + gapMs / 1000) / 60)) : 0
  const cost = isLx
    ? `- 每删一个都会让 LX 服务端全量重载脚本，${picked.length} 个约需 ${mins} 分钟以上，期间服务端可能无响应；`
    : `- 当前平台（${active ? (PLATFORM_TYPES[active.type] || active.type) : '—'}）删除较快，逐个串行执行；`
  const risk = (isLx && picked.length > 10)
    ? `\n- 数量较多：连续重载有假死风险，已自动在每个删除之间留 ${Math.round(gapMs / 1000)} 秒；中途出现网络超时会自动停止，未删的可稍后重删。`
    : ''
  if (!confirm(
    `将从服务端删除 ${picked.length} 个音源（账号：${active ? (active.name || active.url) : '—'}）：\n${preview}\n\n` +
    `${cost}\n` +
    `- 若只是不想让它们参与解析，请用「停用」（不触发重载，秒级完成）；\n` +
    `- 删除不可撤销，音源脚本会真正从服务端移除。${risk}\n\n确定删除？`
  )) return

  setInsBusy(true)
  const info = $('insSelInfo')
  const say = t => { if (info) info.textContent = t }
  const done = [], failed = [], gone = []
  try {
    for (let i = 0; i < picked.length; i++) {
      const s = picked[i]
      say(`正在删除 ${i + 1}/${picked.length}：${s.name || s.id}`)
      let r
      try {
        r = await api.serviceRemove(s.id, s.owner)
      } catch (e) {
        r = { ok: false, error: String((e && e.message) || e) }
      }
      const okDel = r.ok && r.data && r.data.success
      const msg = (r.data && r.data.message) || r.error || ''
      // 服务端已无此源（比如页面上 stale 或并发删过）：不算失败，算「无需删除」
      if (okDel) done.push(s)
      else if (/不存在|not found|404/i.test(msg)) gone.push(s)
      else failed.push({ s, msg: delBizHint(msg) })
      // 网络级故障（超时/连接被拒）说明服务端已经在重载或假死，继续删只会更糟 —— 中止
      if (!okDel && /abort|timeout|timed out|超时|ECONNREFUSED|fetch failed/i.test(msg)) {
        const rest = picked.length - i - 1
        say(`中止：服务端响应异常，剩余 ${rest} 个未删`)
        toast(`服务端响应异常，已中止：成功 ${done.length}、失败 ${failed.length}，剩余 ${rest} 个未删。请先在服务端确认状态（必要时重启容器），稍后重删剩余项`, 'err')
        break
      }
      if (i < picked.length - 1) await new Promise(res => setTimeout(res, gapMs))
    }
    if (done.length + gone.length + failed.length === picked.length) {
      const parts = [`成功 ${done.length}`]
      if (gone.length) parts.push(`无需删除 ${gone.length}（服务端已无此源）`)
      if (failed.length) parts.push(`失败 ${failed.length}`)
      toast(`删除完成：${parts.join('、')}`, failed.length ? 'warn' : 'ok')
      if (failed.length) {
        console.warn('[已灌入] 批量删除失败明细：', failed.map(f => ({ id: f.s.id, name: f.s.name, msg: f.msg })))
      }
    }
    // 无论成败都刷新：勾选池会在 refreshInstalled 里按服务端现状收敛
    state.insSel.clear()
    await refreshInstalled()
    loadSources()
  } finally {
    setInsBusy(false)
    renderInsSelInfo()
  }
})

$('btnRefreshInstalled').addEventListener('click', refreshInstalled)

// 一键恢复全部平台级停用的音源：清掉服务端 disabledSources（不触发脚本重载，秒级）。
// 主要用于清理历史误禁（如旧版本巡检误禁后一直没遇到「确认可用」的机会）。
$('btnEnableAll').addEventListener('click', async () => {
  if (insBusy) return toast('上一个服务端操作仍在处理中，请稍候…')
  const stoppedList = (state.installed || []).filter(s => s.enabled !== false && Array.isArray(s.disabledSources) && s.disabledSources.length > 0)
  if (!stoppedList.length) return toast('没有平台级停用的音源，无需恢复', 'info')
  if (!confirm(`将把 ${stoppedList.length} 个平台级停用的音源全部恢复启用（只清平台停用，不动全局开关，不触发服务端重载），继续？`)) return
  setInsBusy(true)
  let okN = 0
  try {
    for (const s of stoppedList) {
      try {
        const r = await api.servicePlatforms(s.id, [], s.owner)
        if (r.ok && r.data && r.data.success) okN++
      } catch (e) { /* 单个失败不中断整批 */ }
    }
  } finally { setInsBusy(false) }
  toast(`已恢复启用 ${okN} / ${stoppedList.length} 个音源`, okN === stoppedList.length ? 'ok' : 'warn')
  refreshInstalled()
})

// ---------------- 健康巡检 ----------------
function renderPatrolInfo() {
  const p = state.patrol || {}
  const el = $('patrolInfo')
  if (!el) return
  if (!p.lastRun) { el.textContent = '尚未巡检'; return }
  const d = new Date(p.lastRun)
  const hh = n => String(n).padStart(2, '0')
  el.textContent = `上次巡检 ${d.getFullYear()}-${hh(d.getMonth() + 1)}-${hh(d.getDate())} ${hh(d.getHours())}:${hh(d.getMinutes())}：正常 ${p.ok || 0}、失效禁用 ${p.disabled || 0}、无法判定 ${p.unknown || 0}${p.cancelled ? '（已取消）' : ''}`
}

$('btnSyncServer').addEventListener('click', async () => {
  if (state.busy) return toast('已有任务在运行', 'warn')
  setBusy(true)
  $('progStep').textContent = '同步服务端音源…'
  const r = await api.serverSync()
  setBusy(false)
  if (r.ok) {
    toast(`已同步：匹配 ${r.data.matched} 个、新增占位 ${r.data.added} 个（清理失效 ${r.data.pruned} 个），共 ${r.data.imported} 条算作已灌入`, 'ok')
    loadSources()
    refreshInstalled()
  } else toast('同步失败: ' + r.error, 'err')
})

$('btnPatrol').addEventListener('click', async () => {
  if (state.busy) return toast('已有任务在运行', 'warn')
  setBusy(true)
  $('progStep').textContent = '开始巡检…'
  const r = await api.patrolStart()
  setBusy(false)
  if (r.ok) {
    loadSources()
    refreshInstalled()
  } else toast('巡检失败: ' + r.error, 'err')
})

/** 启动后静默把服务端已有音源纳入「已灌入」管理（已连接才执行） */
async function autoSyncServer() {
  try {
    const r = await api.serverSync()
    if (r.ok) { await loadSources(); refreshInstalled() }
  } catch (e) { /* 静默：没连上服务端不影响本地使用 */ }
}

$('btnRevokeSelected').addEventListener('click', async () => {
  const active = state.platforms.find(p => p.id === state.activePlatformId)
  if (!active) return toast('请先在「服务平台账号」里选中一个账号', 'err')
  // 撤回只针对「当前账号」灌入的记录（按 importedTo / platformId 归类），不误删其他账号的音源。
  // 判定口径必须和核心层 runRevoke 一致，否则这里点得到、那边却说「不属于当前账号」。
  const ids = Object.keys(state.imported).filter(id => {
    const rec = state.imported[id]
    return rec && (rec.platformId == null ||
      rec.platformId === active.id ||
      (Array.isArray(rec.importedTo) && rec.importedTo.some(x => x && x.platformId === active.id)))
  })
  if (!ids.length) return toast('当前账号没有本工具灌入的记录', 'info')
  if (!confirm(`将撤回本工具在账号「${active.name || active.url}」灌入的 ${ids.length} 个音源（从服务端删除），继续？`)) return
  const r = await api.revoke(ids)
  if (!r.ok) return toast('撤回失败: ' + r.error, 'err')
  const ok = (r.data || []).filter(x => x.status === 'success').length
  toast(`撤回完成：成功 ${ok} 个`, 'ok')
  loadSources(); refreshInstalled()
})

// ---------------- 其他 ----------------
$('btnClearLogs').addEventListener('click', async () => { await api.logsClear(); $('logBox').innerHTML = ''; logKeys.clear() })
$('btnOpenData').addEventListener('click', () => api.openDataDir())
$('btnExport').addEventListener('click', async () => {
  const scope = $('expFilter') ? $('expFilter').value : 'all'
  if (scope === 'selected' && !state.selected.size) {
    return toast('还没有勾选音源：勾选表格左侧复选框后，导出范围会自动切到「选中项」', 'warn')
  }
  const known = new Set(state.sources.map(e => e.id))
  const ids = exportIds(scope).filter(id => known.has(id))
  if (!ids.length) return toast(`当前范围没有可导出的音源（${scopeLabel(scope)}）`, 'warn')
  const r = await api.dbExport(ids)
  if (r.ok && r.data && r.data.exported) toast(`已导出 ${r.data.count} 条（${scopeLabel(scope)}，含检测结果）到 ${r.data.path}`, 'ok')
  else if (r.ok && !r.data.exported) toast('已取消导出', 'info')
  else toast('导出失败: ' + r.error, 'err')
})

/** 按筛选范围收集要导出的音源 id（忽略搜索词，整范围导出） */
function matchScope(e, k) {
  switch (k) {
    case 'usable': return !!e.usable
    case 'suspected': return !e.usable && e.status !== 'dead' && (e.suspected || isCheckedNoSource(e))
    case 'dead': return e.status === 'dead' || isDeepDead(e)
    // 已合并的重复项不该出现在「导出未检测」里：它们不是漏检，是重复
    case 'unchecked': return !e.deprecated && !e.deep && e.status !== 'dead' && e.status !== 'quarantined' && !isCheckedNoSource(e)
    // 导出「已灌入」同样按灌入目标口径：只灌过 A 的源在目标含 B 时不算已灌入（还需补灌）
    case 'imported': return importedState(e) === 'all'
    default: return true
  }
}
function scopeLabel(k) {
  if (k === 'selected') return `选中 ${state.selected.size} 条`
  return { all: '全部', usable: '可用', suspected: '疑似', dead: '失效', unchecked: '未检测', imported: '已灌入' }[k] || k
}
function exportIds(scope) {
  // 「选中项」严格按用户勾选导出（保持勾选顺序），其余按整体范围导出
  if (scope === 'selected') return [...state.selected]
  return state.sources.filter(e => matchScope(e, scope)).map(e => e.id)
}
$('btnImport').addEventListener('click', async () => {
  const r = await api.dbImport()
  if (!r.ok) return toast('导入失败: ' + r.error, 'err')
  if (!r.data || !r.data.imported) return
  const s = r.data.summary || {}
  toast(`导入完成：新增 ${s.added}、更新 ${s.updated}、按内容补检测结果 ${s.copied}、并入灌入记录 ${s.importedAdded}（共 ${s.total} 条）`, 'ok')
  state.selected.clear()
  state.page = 1
  loadSources()
})

// 导入单个音源（v1.10.0）：选 .js 文件入库并标记「私人音源」
// （Web 版浏览器选文件上传；桌面版走打开对话框，签名一致无参数）
$('btnImportSingle').addEventListener('click', async () => {
  if (!api.sourceImportSingle) return toast('当前版本不支持单个音源导入', 'warn')
  const r = await api.sourceImportSingle()
  if (!r.ok) return toast('导入失败: ' + (r.error || '未知错误'), 'err')
  if (!r.data || !r.data.imported) return
  const d = r.data
  toast(`${d.updated ? '已更新私人音源' : '已导入私人音源'}「${d.entry ? d.entry.name : d.name}」（不参与去重与巡检），可在音源库里手动检测 / 灌入`, 'ok')
  state.selected.clear()
  state.page = 1
  loadSources()
})
$('btnClearDb').addEventListener('click', async () => {
  if (!confirm('清空本地音源库（不影响服务端已灌入的音源）？')) return
  await api.dbClear(); state.selected.clear(); state.page = 1; loadSources(); toast('已清空', 'ok')
})

// ---------------- 数据导入/导出（v1.9.20，仓库/采集站/镜像三类配置搬家）----------------
// 「导出有效音源」复用音源库导出通道（含检测结果与内容指纹），只是范围固定为检测可用项
$('btnExportUsable').addEventListener('click', async () => {
  const ids = state.sources.filter(e => e.usable).map(e => e.id)
  if (!ids.length) return toast('库里还没有「检测可用」的音源', 'warn')
  const r = await api.dbExport(ids)
  if (r.ok && r.data && r.data.exported) toast(`已导出 ${r.data.count} 条有效音源（含检测结果）到 ${r.data.path}`, 'ok')
  else if (r.ok && r.data && !r.data.exported) toast('已取消导出', 'info')
  else toast('导出失败: ' + r.error, 'err')
})

const DATA_SCOPE_LABELS = { repos: '仓库清单', hubs: '音源采集站', mirrors: 'raw 加速镜像' }

async function handleDataExport(scope) {
  const r = await api.dataExport(scope)
  if (r.ok && r.data && r.data.exported) toast(`已导出${DATA_SCOPE_LABELS[scope]}到 ${r.data.path || '浏览器下载'}`, 'ok')
  else if (r.ok && r.data && r.data.exported === false) toast('已取消导出', 'info')
  else toast('导出失败: ' + (r.error || '未知错误'), 'err')
}

async function handleDataImport(scope) {
  const r = await api.dataImport(scope)
  if (!r.ok) return toast('导入失败: ' + (r.error || '未知错误'), 'err')
  if (!r.data || !r.data.imported) return // 用户取消了文件选择
  const s = r.data.summary || {}
  toast(`导入${DATA_SCOPE_LABELS[scope]}完成：新增 ${s.added}、更新 ${s.updated}（现有 ${s.total} 条）`, 'ok')
  // 重新拉配置并整体刷新相关区块（仓库/采集站/镜像池/下拉选择）
  const cr = await api.configGet()
  if (!cr.ok) return
  state.config = cr.data.config
  const c = state.config
  renderRepoList(c.repos, state.defaultRepos)
  renderHubList(c.hubs)
  renderExternalList(c.externalSources)
  renderMirrorPool(c.mirrorPool)
  if (scope === 'mirrors') {
    populateMirrors(state.mirrors, c.mirrorPool)
    $('cfgMirror').value = c.mirror || 'auto'
    if (!$('cfgMirror').value) $('cfgMirror').value = 'auto'
    $('cfgMirrorCustom').value = c.mirrorCustom || ''
    $('cfgMirrorCustom').parentNode.style.display = (c.mirror === 'custom') ? '' : 'none'
  }
}

$('btnReposExport').addEventListener('click', () => handleDataExport('repos'))
$('btnReposImport').addEventListener('click', () => handleDataImport('repos'))
$('btnHubsExport').addEventListener('click', () => handleDataExport('hubs'))
$('btnHubsImport').addEventListener('click', () => handleDataImport('hubs'))
$('btnMirrorsExport').addEventListener('click', () => handleDataExport('mirrors'))
$('btnMirrorsImport').addEventListener('click', () => handleDataImport('mirrors'))

function clampPage() {
  const total = Math.max(1, Math.ceil(filtered().length / PAGE_SIZE))
  if (state.page > total) state.page = total
}

// ---------------- 启动（v1.10.0 登录门控，仅 Web/Docker 版） ----------------
// Web 版：未登录时盖住整个应用的登录层；首个用户注册管理员；会话过期自动重弹登录。
// 桌面版（window.api 由 preload 注入，无 window.LXH_WEB）：本地使用，直接进主界面。
let authMe = null

function showAuth(mode, errText) {
  const layer = $('authLayer')
  if (!layer) return
  layer.hidden = false
  $('authLoginBox').hidden = mode !== 'login'
  $('authRegBox').hidden = mode !== 'register'
  const err = $('authErr')
  if (errText) { err.textContent = errText; err.hidden = false } else err.hidden = true
  setTimeout(() => { const el = mode === 'login' ? $('authName') : $('regName'); if (el) el.focus() }, 50)
}

function hideAuth() { const layer = $('authLayer'); if (layer) layer.hidden = true }

async function renderAuthCard() {
  if (!window.LXH_WEB || !api.authState) return
  const st = await api.authState()
  if (!st.ok) return
  const me = st.data && st.data.loggedIn ? st.data.user : null
  authMe = me
  // 侧边栏与设置页各有一个退出按钮（id 不可重复），两者都要跟着登录态显隐
  for (const id of ['btnLogout', 'btnLogoutTop']) { const b = $(id); if (b) b.hidden = !me }
  $('btnPwdOpen').hidden = !me
  $('pwdForm').hidden = true
  const card = $('userList')
  const addRow = $('userAddRow')
  if (!me) { card.innerHTML = '<p class="muted">未登录</p>'; addRow.hidden = true; return }
  if (!me.admin) {
    card.innerHTML = `<p class="muted">当前账号：${esc(me.name)}（如需管理账号请联系管理员）</p>`
    addRow.hidden = true
    return
  }
  const r = await api.authUsers()
  const users = (r.ok && r.data && r.data.users) ? r.data.users : []
  card.innerHTML = users.map(u => `<div class="acct-row">
      <div class="acct-main"><div class="acct-meta"><div class="acct-name">${esc(u.name)} ${u.admin ? '<span class="badge ok">管理员</span>' : ''}${u.name === me.name ? '<span class="badge accent">当前</span>' : ''}</div></div></div>
      <div class="acct-ops">${u.name !== me.name
        ? `<button class="btn sm" data-reset="${esc(u.name)}">重置密码</button><button class="btn sm danger-ghost" data-udel="${esc(u.name)}">删除</button>`
        : ''}</div>
    </div>`).join('') || '<p class="muted">没有其他账号</p>'
  addRow.hidden = false
  card.querySelectorAll('button[data-udel]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(`确定删除账号「${b.dataset.udel}」？该账号的登录会话立即失效（其灌入记录不受影响）。`)) return
    const r2 = await api.authUserDelete(b.dataset.udel)
    if (!r2.ok) return toast('删除失败: ' + r2.error, 'err')
    toast('已删除账号', 'ok')
    renderAuthCard()
  }))
  card.querySelectorAll('button[data-reset]').forEach(b => b.addEventListener('click', async () => {
    const np = prompt(`为账号「${b.dataset.reset}」设置新密码（至少 6 位）：`)
    if (np == null) return
    const r2 = await api.authUserReset(b.dataset.reset, np)
    if (!r2.ok) return toast('重置失败: ' + r2.error, 'err')
    toast('已重置密码', 'ok')
  }))
}

$('btnUserAdd').addEventListener('click', async () => {
  const name = $('userNewName').value.trim()
  const pwd = $('userNewPwd').value
  if (!name || !pwd) return toast('请填写账号名与密码', 'warn')
  const r = await api.authUserAdd(name, pwd, $('userNewAdmin').checked)
  if (!r.ok) return toast('添加失败: ' + r.error, 'err')
  $('userNewName').value = ''; $('userNewPwd').value = ''; $('userNewAdmin').checked = false
  toast(`已添加账号「${name}」`, 'ok')
  renderAuthCard()
})

// 侧边栏（btnLogoutTop）与设置页（btnLogout）两个退出按钮都要绑定
for (const id of ['btnLogout', 'btnLogoutTop']) {
  const b = $(id)
  if (!b) continue
  b.addEventListener('click', async () => {
    if (!window.LXH_WEB || !api.authLogout) return // 桌面版无登录体系
    await api.authLogout()
    toast('已退出登录', 'ok')
    showAuth('login')
  })
}

$('btnPwdOpen').addEventListener('click', () => { $('pwdForm').hidden = false })
$('btnPwdCancel').addEventListener('click', () => { $('pwdForm').hidden = true })
$('btnPwdChange').addEventListener('click', async () => {
  const oldPwd = $('pwdOld').value, newPwd = $('pwdNew').value
  if (!oldPwd || !newPwd) return toast('请填写原密码与新密码', 'warn')
  const r = await api.authPasswordChange(oldPwd, newPwd)
  if (!r.ok) return toast('修改失败: ' + r.error, 'err')
  $('pwdOld').value = ''; $('pwdNew').value = ''
  $('pwdForm').hidden = true
  toast('密码已修改', 'ok')
})

// 登录 / 注册按钮（含回车提交）
async function doAuthLogin() {
  const name = $('authName').value.trim(), pwd = $('authPwd').value
  if (!name || !pwd) { showAuth('login', '请输入账号与密码'); return }
  const r = await api.authLogin(name, pwd)
  if (!r.ok) { showAuth('login', r.error || '登录失败'); return }
  hideAuth()
  renderAuthCard()
  await boot()
}
async function doAuthRegister() {
  const name = $('regName').value.trim(), pwd = $('regPwd').value
  if (!name || !pwd) { showAuth('register', '请填写管理员账号与密码'); return }
  const r = await api.authRegister(name, pwd)
  if (!r.ok) { showAuth('register', r.error || '注册失败'); return }
  hideAuth()
  renderAuthCard()
  await boot()
}
$('btnAuthLogin').addEventListener('click', doAuthLogin)
$('btnAuthReg').addEventListener('click', doAuthRegister)
for (const [inp, fn] of [[$('authName'), doAuthLogin], [$('authPwd'), doAuthLogin], [$('regName'), doAuthRegister], [$('regPwd'), doAuthRegister]]) {
  if (inp) inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') fn() })
}

// 会话过期：任意接口返回 401（authRequired）时重弹登录层
window.addEventListener('lxh-auth-expired', () => showAuth('login', '登录已过期，请重新登录'))

async function boot() {
  await loadConfig()
  await loadSources()
  await refreshDeletedInfo() // 设置页「手动删除音源」的名单计数
  syncExportScope()      // 初始化导出范围下拉（首次进入默认跟随页签）
  await autoSyncServer() // 静默同步服务端已有音源 → 纳入「已灌入」管理
  await syncInstalledQuiet()  // 静默对账：统计卡的「已灌入」要显示当前账号服务端上的真实条数
  const lr = await api.logsGet()
  if (lr.ok) {
    const box = $('logBox')
    const frag = document.createDocumentFragment()
    for (const e of (lr.data || [])) {
      const k = logKeyOf(e)
      if (logKeys.has(k)) continue
      logKeys.add(k)
      frag.appendChild(logLine(e))
    }
    box.appendChild(frag)
    refreshLogModuleOptions()
    applyLogFilter()
    box.scrollTop = box.scrollHeight
  }
  refreshJobChip()
  setInterval(refreshJobChip, 10000)   // 全局任务状态 chip（导航栏），10s 轮询
}

;(async function start() {
  if (window.LXH_WEB && api.authState) {
    const st = await api.authState()
    const d = (st.ok && st.data) ? st.data : { loggedIn: false, hasUsers: true }
    if (d.loggedIn) {
      hideAuth()
      renderAuthCard()
      await boot()
    } else if (d.hasUsers) {
      showAuth('login')
    } else {
      showAuth('register')
    }
  } else {
    await boot()
  }
})()

// ---------------- 已添加源更新（dry-run，2026-11-10） ----------------
// 只在 Web/Docker 版启用：桌面版没有 /api/source-update/* 路由。
// 全部只读：扫描只调服务端 list，不执行 validate / delete / upload。
;(function () {
  if (!window.LXH_WEB) return
  const card = document.getElementById('updCard')
  const btn = document.getElementById('btnScanUpdates')
  const refresh = document.getElementById('btnUpdRefresh')
  const hubs = document.getElementById('updIncludeHubs')
  const box = document.getElementById('updResult')
  const sum = document.getElementById('updSummary')
  const notes = document.getElementById('updNotes')
  if (!card || !btn || !box) return
  const LABEL = { updatable: '可更新', current: '已是最新', unmatched: '出处不明', unsafe: '不建议动' }
  const COLOR = { updatable: '#5DCAA5', current: '#B4B2A9', unmatched: '#FAC775', unsafe: '#F09595' }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }
  async function scan() {
    card.hidden = false
    box.textContent = '扫描中（只读，未写入任何数据）…'
    btn.disabled = true
    try {
      const r = await fetch('/api/source-update/scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeHubs: !!(hubs && hubs.checked) })
      })
      const j = await r.json()
      if (!j.ok) { box.textContent = '扫描失败：' + (j.error || '未知错误'); return }
      const d = j.data || {}
      const s = d.summary || {}
      sum.textContent = `共 ${s.total || 0} 条 · 可更新 ${s.updatable || 0} · 已是最新 ${s.current || 0} · 出处不明 ${s.unmatched || 0} · 不建议动 ${s.unsafe || 0} · B 信号 ${s.bSignals || 0}（dry-run，未写入）`
      const rows = (d.items || []).map(it => {
        const c = it.candidate || {}
        const sig = (it.signals || []).map(x => x.type).join(' / ')
        return '<div style="padding:7px 0;border-bottom:1px solid rgba(128,128,128,.25)">' +
          '<span style="color:' + (COLOR[it.verdict] || '#B4B2A9') + '">[' + (LABEL[it.verdict] || it.verdict) + ']</span> ' +
          '<b>' + esc(it.name || it.id) + '</b> ' +
          '<span class="muted">owner=' + esc(it.owner) + ' · ' + esc(it.evidence && it.evidence.serverVersion || '-') +
          ' → ' + esc(it.evidence && it.evidence.candidateVersion || '-') +
          ' · ' + esc(it.evidence && it.evidence.via || '-') + '</span>' +
          '<div class="muted" style="font-size:12px">' + esc(it.reason || '') +
          (sig ? ' ｜ B 信号（仅提示）：' + esc(sig) : '') +
          (c.id ? ' ｜ 候选 ' + esc(c.id) : '') + '</div></div>'
      }).join('')
      box.innerHTML = rows || '<span class="muted">服务端没有已添加音源</span>'
      notes.textContent = (d.notes || []).join(' ')
    } catch (e) {
      box.textContent = '扫描失败：' + String((e && e.message) || e)
    } finally { btn.disabled = false }
  }
  btn.addEventListener('click', scan)
  if (refresh) refresh.addEventListener('click', scan)
})()
