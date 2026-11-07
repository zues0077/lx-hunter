/**
 * v1.7.0 爬取增强回归：
 *  ① Releases 资产通道 —— lx-ikun-music-sources 的 HYWmusic_.V1.2.0.js 只发在 release 里，
 *     旧版只读 git/trees 永远抓不到（用户实测漏抓）。
 *  ② 增量判重 —— blob sha / release 资产 key / 压缩包内容哈希三条判重线。
 *  ③ 可用度裁决 —— 同名内容更新的取舍以接口可用度为准（用户明确要求）。
 *  ④ 灌入同名裁决 —— 服务端同名不同内容：检测失效不替换；可用才先删后传。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { parseReleaseAssets, judgeFreshness, fetchRepoFreshness } = require('../src/core/crawler')
const { buildCandidates, isGhAssetUrl } = require('../src/core/net')
const { sha256Str, usableCount } = require('../src/core/checker')
const { Store } = require('../src/core/store')
const { Hunter } = require('../src/core/hunter')

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x !== undefined ? '  -> ' + x : ''}`) }

// ---------- ① parseReleaseAssets ----------
console.log('\n== releases 资产解析 ==')
const fakeReleases = [
  {
    tag_name: 'V261008',
    assets: [
      { name: 'HYWmusic_.V1.2.0.js', size: 12082, browser_download_url: 'https://github.com/o/r/releases/download/V261008/HYWmusic_.V1.2.0.js' },
      { name: 'checksums.txt', size: 200, browser_download_url: 'https://github.com/o/r/releases/download/V261008/checksums.txt' },
      { name: 'notes.md', size: 100, browser_download_url: 'https://github.com/o/r/releases/download/V261008/notes.md' }
    ]
  },
  {
    tag_name: '2026.08.17',
    assets: [
      { name: 'V260817.zip', size: 312 * 1024, browser_download_url: 'https://github.com/o/r/releases/download/2026.08.17/V260817.zip' }
    ]
  },
  {
    tag_name: 'old',
    assets: [
      { name: 'huge.zip', size: 40 * 1024 * 1024, browser_download_url: 'https://github.com/o/r/releases/download/old/huge.zip' },
      { name: 'only-old.js', size: 1000, browser_download_url: 'https://github.com/o/r/releases/download/old/only-old.js' }
    ]
  },
  {
    tag_name: 'newer',
    assets: [
      { name: 'known.js', size: 1000, browser_download_url: 'https://github.com/o/r/releases/download/newer/known.js' }
    ]
  }
]

const a1 = parseReleaseAssets(fakeReleases, {})
ck('只收 .js/.zip 资产（txt/md 跳过）', a1.every(a => /\.(js|zip)$/i.test(a.name)))
ck('release 直接 js 资产被识别', a1.some(a => a.name === 'HYWmusic_.V1.2.0.js' && a.kind === 'js'))
ck('release zip 资产被识别', a1.some(a => a.name === 'V260817.zip' && a.kind === 'zip'))
ck('超过 30MB 上限的资产被跳过', !a1.some(a => a.name === 'huge.zip'))
ck('资产 key = tag/文件名', a1.find(a => a.name === 'HYWmusic_.V1.2.0.js').key === 'V261008/HYWmusic_.V1.2.0.js')
ck('默认最多看 4 个 release', parseReleaseAssets(fakeReleases, {}).length === 4)
ck('skipKeys 命中已抓过的资产被跳过', (() => {
  const a2 = parseReleaseAssets(fakeReleases, { skipKeys: new Set(['V261008/HYWmusic_.V1.2.0.js', 'newer/known.js']) })
  return !a2.some(a => a.key === 'V261008/HYWmusic_.V1.2.0.js') && !a2.some(a => a.key === 'newer/known.js') && a2.some(a => a.name === 'V260817.zip')
})())
ck('空响应不炸', parseReleaseAssets(null, {}).length === 0 && parseReleaseAssets([], {}).length === 0)

// ---------- ② 镜像候选：github.com releases 资产也要有前缀镜像回退 ----------
console.log('\n== releases 资产下载镜像链 ==')
const relUrl = 'https://github.com/o/r/releases/download/V261008/HYWmusic_.V1.2.0.js'
ck('releases 资产 URL 被识别', isGhAssetUrl(relUrl))
ck('releases 资产 auto 模式含前缀镜像回退', (() => {
  const ids = buildCandidates(relUrl, 'auto').map(c => c.id)
  return ids[0] === 'direct' && ids.includes('ghproxy') && ids.includes('ghfast')
})(), buildCandidates(relUrl, 'auto').map(c => c.id).join(','))
ck('releases 资产不含 jsdelivr（服务不了）', !buildCandidates(relUrl, 'auto').some(c => c.id === 'jsdelivr'))
ck('raw URL 行为不变（仍含 jsdelivr）', buildCandidates('https://raw.githubusercontent.com/o/r/HEAD/a.js', 'auto').some(c => c.id === 'jsdelivr'))
ck('普通 http URL 只有直连', buildCandidates('https://example.com/a.js', 'auto').length === 1)

// ---------- ③ mergeSources 增量合并 ----------
console.log('\n== 增量合并（mergeSources） ==')
function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-crawl-'))
  return new Store(dir)
}
const mkTree = (id, sha, extra) => Object.assign({
  id, repo: 'o/r', path: id.replace('::', '/'), url: 'https://raw.githubusercontent.com/o/r/HEAD/' + id.split('::')[1],
  name: id.split('::')[1], blobSha: sha, status: 'unknown', suspected: null, usable: false, size: 0, addedAt: 1, lastCheck: 0, deep: null
}, extra || {})

const st1 = tmpStore()
let m = st1.mergeSources([mkTree('o/r::a.js', 'sha1')], { incremental: true })
ck('新条目入库（added）', m.added === 1 && st1.getSources().length === 1)
m = st1.mergeSources([mkTree('o/r::a.js', 'sha1')], { incremental: true })
ck('同 id 同 sha → skipped（已抓取不重抓）', m.skipped === 1 && m.added === 0 && !st1.getSources()[0].stale)
m = st1.mergeSources([mkTree('o/r::a.js', 'sha2')], { incremental: true })
ck('blob sha 变了 → 标 stale 待重下', st1.getSources()[0].stale === true && m.updated === 1)
m = st1.mergeSources([mkTree('o/r::a.js', 'sha1')], { incremental: false })
ck('非增量模式只新增不更新', m.added === 0 && m.skipped === 1)

// 带 code 的条目（压缩包内/release 资产）：内容哈希变了就地更新
const st2 = tmpStore()
const CODE_V1 = '/** @name 测试音源B @version v1 */\nlx.on("inited",()=>{});lx.send("inited",{sources:{}})'
const CODE_V2 = '/** @name 测试音源B @version v2 */\nlx.on("inited",()=>{});lx.send("inited",{sources:{}})'
const H1 = sha256Str(CODE_V1), H2 = sha256Str(CODE_V2)
const mkZip = (hash, code) => ({
  id: 'o/r::pkg.zip!inner/x.js', repo: 'o/r', path: 'pkg.zip!inner/x.js', url: 'u', archive: 'pkg.zip', archiveSha: 'as1',
  innerPath: 'inner/x.js', name: 'x', code, contentHash: hash, suspectScore: 8, status: 'unknown', suspected: true,
  usable: false, size: code.length, addedAt: 1, lastCheck: 0, deep: { platforms: {}, hash: 'old-hash', checkedAt: 5 }
})
st2.mergeSources([mkZip(H1, CODE_V1)], { incremental: true })
const zBefore = st2.getSources()[0]
m = st2.mergeSources([mkZip(H1, CODE_V1)], { incremental: true })
ck('压缩包条目内容没变 → skipped', m.skipped === 1 && !zBefore.updated)
m = st2.mergeSources([mkZip(H2, CODE_V2)], { incremental: true })
const zAfter = st2.getSources()[0]
ck('压缩包条目内容变了 → 就地更新+标 updated', m.updated === 1 && zAfter.contentHash === H2 && zAfter.updated === true)
ck('更新条目深检结果作废（等重测）', !zAfter.deep && zAfter.usable === false)
ck('归档内文件不覆盖非归档同 id 条目', (() => {
  const st3 = tmpStore()
  st3.mergeSources([mkTree('o/r::x.js', 's1')], { incremental: true })
  const r = st3.mergeSources([Object.assign(mkZip(H1, CODE_V1), { id: 'o/r::x.js', path: 'x.js', archive: null, innerPath: null })], { incremental: true })
  return r.added === 0 && st3.getSources().length === 1
})())

// ---------- ④ 可用度裁决（betterKeeper 纯逻辑） ----------
console.log('\n== 同名可用度裁决（betterKeeper） ==')
// Hunter 依赖 store/net/lxservice，用最小桩绕开构造副作用
function mkHunter() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-keeper-'))
  const store = new Store(dir)
  const h = Object.create(Hunter.prototype)
  h.store = store
  h.emit = () => {}
  h.log = () => {}
  return h
}
const deepOf = (n, dead) => ({ checkedAt: Date.now(), platforms: n ? Object.fromEntries(Array.from({ length: n }, (_, i) => ['p' + i, { status: 'usable' }])) : Object.fromEntries(['kw', 'wy'].map(s => [s, { status: 'fail', reason: dead || 'dead' }])) })
const ent = (id, o) => Object.assign({ id, name: id, url: 'u', fromServer: false, status: 'ok', contentHash: 'h-' + id, deep: null, usable: false, updated: false, lastModified: 0, scriptVersion: '', deprecated: false }, o)

const H = mkHunter()
const eOldOk = ent('old-ok', { deep: deepOf(3), usable: true, lastModified: 100 })
const eNewDead = ent('new-dead', { deep: deepOf(0, 'dead'), usable: false, updated: true, lastModified: 200 })
ck('新版深检全失效、旧版可用 → 留旧版（可用度优先于更新）', !H.betterKeeper(eNewDead, eOldOk))

const eOldDead = ent('old-dead', { deep: deepOf(0, 'dead'), usable: false, lastModified: 100 })
const eNewOk = ent('new-ok', { deep: deepOf(5), usable: true, updated: true, lastModified: 200 })
ck('新版可用、旧版失效 → 留新版', H.betterKeeper(eNewOk, eOldDead))

const eNewUn = ent('new-un', { deep: null, updated: true, lastModified: 200 })
ck('旧版实测可用、新版未检测 → 留旧版（不凭更新废能用的）', !H.betterKeeper(eNewUn, eOldOk))
ck('旧版深检确认失效、新版未检测 → 留新版（等检测裁决）', H.betterKeeper(eNewUn, eOldDead))

const eBoth0a = ent('b0-old', { deep: deepOf(0, 'dead'), lastModified: 100 })
const eBoth0b = ent('b0-new', { deep: deepOf(0, 'dead'), updated: true, lastModified: 200 })
ck('双方都实测 0 平台 → 比新旧，更新者留', H.betterKeeper(eBoth0b, eBoth0a))

const e2ok = ent('a-ok', { deep: deepOf(2), usable: true })
const e5ok = ent('b-ok', { deep: deepOf(5), usable: true, updated: true })
ck('双方都可用 → 可用平台多者留（5 > 2，不看 updated）', H.betterKeeper(e5ok, e2ok))

const eNeither = ent('x', { lastModified: 100 })
const eNeitherUp = ent('y', { updated: true, lastModified: 200 })
ck('双方都未检测 → 按 updated 兜底留更新', H.betterKeeper(eNeitherUp, eNeither))
ck('deep 无 checkedAt（占位）不算实测', (() => {
  const ph = ent('ph', { deep: { platforms: { a: { status: 'usable' } } } })   // 无 checkedAt
  const un = ent('un', { deep: null })
  // 两者都按「未检测」处理 → 兜底链
  return H.betterKeeper(ph, un) === (String(ph.id) < String(un.id))
})())

// dedupe ②b 翻案：被废的更新版实测失效、保留版实测可用 → 翻案恢复
console.log('\n== dedupe 检测后翻案 ==')
const h1 = mkHunter()
const keepUpdatedDead = ent('upd-dead', { deep: deepOf(0, 'dead'), usable: false, updated: true, scriptName: '音源X' })
const oldOk = ent('old-ok2', { deep: deepOf(2), usable: true, scriptName: '音源X' })
// 先模拟检测前占位裁决：updated 优先 → 旧版被废
oldOk.deprecated = true; oldOk.dupOf = keepUpdatedDead.id; oldOk.dupReason = '同名旧版本（已有更新版本）'
h1.store.mergeSources([keepUpdatedDead, oldOk], { incremental: false })
const res = h1.dedupe()
const upd = h1.store.db.sources['upd-dead'], old = h1.store.db.sources['old-ok2']
ck('更新版深检失效 → 翻案恢复旧版', !old.deprecated && old.usable === true)
ck('翻案后旧版（实测可用）被废且原因=失效让位', upd.deprecated === true && upd.dupReason === '同名版本（此版本已失效）')

// ---------- ⑤ 灌入同名裁决（检测失效不替换） ----------
console.log('\n== 灌入同名裁决（_planImportQueue） ==')
const h2 = mkHunter()
const srvName = normN('同名源A')
function normN(s) { return String(s || '').toLowerCase().replace(/[\[\]【】（）()|｜:：、,，.。\s_\-·•]+/g, '') }
const srv = { id: 'srv-1', name: '同名源A', size: 100 }
const codeGood = 'x'.repeat(50)   // 与 srv.size 不同 → 内容不同
const mkT = (id, o) => Object.assign({ id, name: '同名源A', lxName: '同名源A', url: 'u', fromServer: false, deep: null, usable: false, contentHash: 'h-' + id, updated: false, stale: false }, o)
const ctx = { cfg: {}, serverByName: { [srvName]: srv }, codeCache: {}, importedHashes: {} }

const tDead = mkT('t-dead', { deep: { checkedAt: Date.now(), platforms: { wy: { status: 'fail', reason: 'dead' } } }, usable: false })
let q = h2._planImportQueue([tDead], Object.assign({}, ctx, { codeCache: { 't-dead': codeGood } }))
ck('同名不同内容 + 本地检测失效 → 拦下不灌（skipUnusable 前置门禁）', !!q[0].skip, q[0].skip)
const tOk = mkT('t-ok', { deep: { checkedAt: Date.now(), platforms: { wy: { status: 'usable' } } }, usable: true })
q = h2._planImportQueue([tOk], Object.assign({}, ctx, { codeCache: { 't-ok': codeGood } }))
ck('同名不同内容 + 本地检测可用 → replaceServer（先删后传）', !!q[0].replaceServer)
const tUn = mkT('t-un', { deep: null })
q = h2._planImportQueue([tUn], Object.assign({}, ctx, { codeCache: { 't-un': codeGood } }))
ck('同名不同内容 + 未检测 → 仍按默认替换（用户没要求拦截）', !!q[0].replaceServer)
const tStale = mkT('t-stale', { deep: { checkedAt: Date.now(), platforms: {} }, usable: false, stale: true })
q = h2._planImportQueue([tStale], Object.assign({}, ctx, { codeCache: { 't-stale': codeGood } }))
ck('stale 条目的旧检测不作为失效依据 → 仍替换', !!q[0].replaceServer)
// skipUnusable 关闭时，失效条目走到同名裁决也不替换（可用度门禁独立生效）
// v1.8.0：这条门禁被收进 sameNameVerdict（规则集中管理），措辞从「已失效」改成
// 「本地实测 0 个可用平台」，判定本身没变 —— 断言里两种说法都认。
q = h2._planImportQueue([tDead], Object.assign({}, ctx, { cfg: { skipUnusable: false }, codeCache: { 't-dead': codeGood } }))
ck('skipUnusable 关闭 + 检测失效 → 同名裁决仍拦下（0 平台不替换）', !!q[0].skip && /0 个可用平台|已失效/.test(q[0].skip), q[0].skip)
const tSame = mkT('t-same', {})
ctx.codeCache = { 't-same': 'y'.repeat(100) }   // 与 srv.size 相同 → 同内容
q = h2._planImportQueue([tSame], ctx)
ck('同名同内容（字节相等）→ sameContentServer 不重传', !!q[0].sameContentServer)
ctx.codeCache = {}
const tNoReplace = mkT('t-nr', {})
q = h2._planImportQueue([tNoReplace], Object.assign({}, ctx, { cfg: { replaceSameNameOnImport: false }, codeCache: { 't-nr': codeGood } }))
ck('关闭 replaceSameNameOnImport → 改名上传（旧行为）', !!q[0].renameServer)

// ---------- ⑥ 时间窗过滤（v1.7.2：只爬近期更新的仓库/资产） ----------
console.log('\n== 时间窗过滤（sinceTs / sinceDays） ==')
const DAY = 86400 * 1000
const NOW = Date.now()
const relsTime = [
  { tag_name: 'r-new', published_at: new Date(NOW - 5 * DAY).toISOString(), assets: [{ name: 'new.js', size: 100, browser_download_url: 'u-new' }] },
  { tag_name: 'r-old', published_at: new Date(NOW - 90 * DAY).toISOString(), assets: [{ name: 'old.js', size: 100, browser_download_url: 'u-old' }] },
  { tag_name: 'r-nodate', assets: [{ name: 'nodate.js', size: 100, browser_download_url: 'u-nodate' }] }
]
const tAll = parseReleaseAssets(relsTime, {})
ck('不开启时间窗：全部资产照收', tAll.length === 3)
const t60 = parseReleaseAssets(relsTime, { sinceTs: NOW - 60 * DAY })
ck('60 天窗：老 release 资产被过滤', t60.length === 2 && !t60.some(a => a.tag === 'r-old'))
ck('无 published_at 的 release 不误杀', t60.some(a => a.tag === 'r-nodate'))
const t0 = parseReleaseAssets(relsTime, { sinceTs: 0 })
ck('sinceTs=0 表示不限', t0.length === 3)
ck('资产携带 publishedAt 供日志', tAll[0].publishedAt > 0)
const crSrcT = fs.readFileSync(path.join(__dirname, '../src/core/crawler.js'), 'utf8')
ck('fetchRepoFreshness：commits?since 整仓探测', crSrcT.includes('fetchRepoFreshness') && crSrcT.includes('/commits?per_page=1&since='))
ck('API 异常保守放行（不漏爬）', crSrcT.includes('fresh: true, empty: true'))
ck('静默仓库整仓跳过（提交与发布都陈旧）', crSrcT.includes('整仓跳过') && crSrcT.includes('无新发布'))
ck('新鲜度探测补查 Releases（修复只靠 Release 推更新的仓库被漏爬）', crSrcT.includes('fetchReleases') && crSrcT.includes('lastReleaseAt'))

// ---------- ⑦ judgeFreshness：提交或发布任一新鲜即新鲜（v1.10.3 修复点） ----------
console.log('\n== judgeFreshness（时间窗新鲜度判定，纯函数可单测） ==')
const DAY7 = 86400 * 1000
const T = Date.now()
ck('sinceTs<=0：不设窗口永远新鲜', judgeFreshness([], [], 0).fresh === true)
ck('时间窗内有提交 → 新鲜', judgeFreshness([{ commit: { committer: { date: new Date(T - 5 * DAY7).toISOString() } } }], [], T - 60 * DAY7).fresh === true)
ck('仅 Release 新鲜（无提交）→ 仍新鲜（修复点）', judgeFreshness([], [{ published_at: new Date(T - 5 * DAY7).toISOString() }], T - 60 * DAY7).fresh === true)
ck('提交与发布都陈旧 → 不新鲜', judgeFreshness([], [{ published_at: new Date(T - 90 * DAY7).toISOString() }], T - 60 * DAY7).fresh === false)
ck('返回最新发布时间用于日志', (() => { const r = judgeFreshness([], [{ published_at: new Date(T - 5 * DAY7).toISOString() }], T - 60 * DAY7); return r.lastReleaseAt > 0 && r.lastReleaseAt === Date.parse(new Date(T - 5 * DAY7).toISOString()); })())
ck('无 published_at 的 release 不误判新鲜', judgeFreshness([], [{ tag_name: 'r-nodate' }], T - 60 * DAY7).fresh === false)
ck('crawl 接受 sinceDays 选项', crSrcT.includes('opts.sinceDays'))
ck('hunter 透传 crawlSinceDays 配置', fs.readFileSync(path.join(__dirname, '../src/core/hunter.js'), 'utf8').includes('cfg.crawlSinceDays'))
ck('设置页有时间窗输入', fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8').includes('cfgCrawlSinceDays'))

// ---------- ⑧ v1.10.3 新增：失效仓库自动清理 / 搜索发现节流 / 清单搜索 ----------
console.log('\n== v1.10.3 新增能力 ==')
ck('crawl 统计含 deadRepos', crSrcT.includes('deadRepos: []') && crSrcT.includes('stats.deadRepos.push'))
ck('fetchRepoFreshness 标记 404 失效', crSrcT.includes('notFound: res.status === 404'))
const hSrc = fs.readFileSync(path.join(__dirname, '../src/core/hunter.js'), 'utf8')
ck('hunter 自动清理失效仓库（非内置、可关闭）', hSrc.includes('autoCleanDeadRepos') && hSrc.includes('失效仓库自动清理'))
ck('hunter 搜索发现节流（满 N 小时才跑）', hSrc.includes('searchDiscoverHours') && hSrc.includes('searchDiscoverAt'))
const stSrc = fs.readFileSync(path.join(__dirname, '../src/core/store.js'), 'utf8')
ck('store 默认配置含新键', stSrc.includes('autoCleanDeadRepos: true') && stSrc.includes('searchDiscoverHours'))
const htmlSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8')
ck('仓库清单有搜索框', htmlSrc.includes('id="repoSearch"'))
const appSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8')
ck('app renderRepoList 支持关键字过滤', appSrc.includes('state.repoFilter') && appSrc.includes('repoSearchCount'))

// ---------- ⑨ v1.10.3 非音源仓库：验真收紧 + 一键清理机制 ----------
// 实锤（2026-11-07 246 实测）：自动发现把播放器客户端混进清单——
//   OuterTune/AnhePlayer/PixelPlayerOLX：app/src/main/assets/**/user-api-preload.js（score 8）
//   CeruMusic/Zhou1019-1/AnniePlayer：docs/public/plugins/tutorial/*.zip、macos wrapper-pkg.zip(49MB)
//   MusicBox-1：src/utils/lx-sandbox.js（score 11）
// 16 个仓库共带来 695 条垃圾脚本（占全库 27%）。
console.log('\n== v1.10.3 非音源仓库清理 ==')
ck('验真把应用工程/文档站点目录列为弱路径', crSrcT.includes('/^(app|android|ios|macos|windows|linux|electron)\\//i') && crSrcT.includes('src\\/android)\\/assets\\/'))
ck('验真把 App 内置脚本垫片列为弱路径', crSrcT.includes('sandbox|preload|bridge|userscript|sdk'))
ck('压缩包按文件名匹配音源语义（不再看目录名）', crSrcT.includes("String(p.path).split('/').pop()"))
ck('压缩包体积按 MAX_ASSET_BYTES 封顶', /\(t\.size \|\| 0\) <= MAX_ASSET_BYTES/.test(crSrcT))
ck('hunter 提供 pruneNonSourceRepos 一键清理', hSrc.includes('async pruneNonSourceRepos'))
ck('清理只处理确定性失败（限流/临时失败跳过）', hSrc.includes('const isTransient') && hSrc.includes('ECONN'))
ck('清理连带删除这些仓库贡献的脚本', hSrc.includes('deadSet') && hSrc.includes('removeSources(srcIds)'))
ck('清理后写入 blockedRepos 黑名单', hSrc.includes('blockedRepos'))
ck('发现器丢弃黑名单仓库（不再回填）', hSrc.includes('blockedRepos.has'))
ck('store 默认含 blockedRepos', stSrc.includes('blockedRepos: []'))
ck('Web 暴露 /api/repos/prune', fs.readFileSync(path.join(__dirname, '../src/server/web.js'), 'utf8').includes("'/api/repos/prune'"))
ck('桌面端有对应 IPC', fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf8').includes("'repos:prune'"))
ck('清单页有清理按钮与确认文案', htmlSrc.includes('id="btnPruneNonSource"') && appSrc.includes('btnPruneNonSource'))

// ---------- ⑩ v1.10.6 行级主动采集：仓库/网页站/采集站都可单独采 ----------
// 用户诉求：清单页每行加「采集」按钮，只采这一行，而不是点「爬取仓库」全量跑一遍。
console.log('\n== v1.10.6 行级主动采集 ==')
ck('runCrawl 支持 opts.only 定向采集', hSrc.includes('onlyRepos') && hSrc.includes("opts && opts.only"))
ck('定向采集优先级高于 reposOverride', /onlyRepos\.length\)[\s\S]{0,220}reposOverride/.test(hSrc))
ck('定向采集不再绕过 crawlSinceDays 时间窗（v1.10.7）', !hSrc.includes('onlyRepos.length ? 0 :') && /const sinceDays = Math\.max\(0, Number\(cfg\.crawlSinceDays\) \|\| 0\)/.test(hSrc))
ck('定向采集仍读 crawlLatestOnly（只收最新版）', /const latestOnly = cfg\.crawlLatestOnly !== false/.test(hSrc))
ck('定向采集为空时报错而非全量跑', hSrc.includes("没有可识别的仓库"))
ck('采集站支持单站采集（onlyId）', fs.readFileSync(path.join(__dirname, '../src/core/hubfeed.js'), 'utf8').includes('o.onlyId'))
ck('runHubSync 支持按 id 采单个站点', hSrc.includes('opts.id') && hSrc.includes("采集站不存在或已禁用"))
ck('Web /api/crawl 透传 body（only）', fs.readFileSync(path.join(__dirname, '../src/server/web.js'), 'utf8').includes('hunter.runCrawl(ctx.body || {})'))
ck('Web /api/hubs/sync 透传 body（id）', fs.readFileSync(path.join(__dirname, '../src/server/web.js'), 'utf8').includes('hunter.runHubSync(ctx.body || {})'))
ck('桌面 IPC crawl:start/hubs:sync 透传 opts', fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf8').includes('hunter.runCrawl(opts || {})') && fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf8').includes('hunter.runHubSync(opts || {})'))
const wbSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/web-bridge.js'), 'utf8')
ck('bridge crawlStart/hubsSync 支持传参', wbSrc.includes('crawlStart: (opts)') && wbSrc.includes('hubsSync: (opts)'))
ck('清单每行有「采集」按钮', appSrc.includes('repo-crawl') && appSrc.includes('主动采集：只爬这一个'))
ck('采集站每行有「采集」按钮', appSrc.includes('hub-sync') && appSrc.includes('只采这一个站点'))
ck('行级采集走定向参数 only', appSrc.includes("crawlStart({ only: [name] })"))
ck('单站采集走 id 参数', appSrc.includes('hubsSync({ id })'))

// ---------- ⑪ v1.10.7 行级采集遵循设置页策略（时间窗 / 只收最新版） ----------
// 用户诉求：点单个仓库的「采集」也要按设置走，不能无条件整仓全采。
console.log('\n== v1.10.7 行级采集遵循设置 ==')
const cSrc2 = fs.readFileSync(path.join(__dirname, '../src/core/crawler.js'), 'utf8')
ck('crawler 记录被时间窗跳过的仓库名', cSrc2.includes('staleRepos') && /stats\.staleRepos\.push\(repo\)/.test(cSrc2))
ck('runCrawl 回传 staleSkipped/staleRepos/sinceDays', hSrc.includes('staleSkipped: (crawlStats && crawlStats.staleSkipped) || 0') && hSrc.includes('staleRepos: (crawlStats && crawlStats.staleRepos) || []'))
ck('主动采集日志打印生效策略', hSrc.includes('主动采集遵循设置'))
ck('被时间窗挡下时给出改法提示', hSrc.includes('把设置页「只爬近期更新的仓库」改为 0'))
ck('前端 0 条且被时间窗跳过时说明原因', appSrc.includes('天内无提交也无新发布，按设置跳过'))
ck('采集按钮不再宣称绕过过滤', !appSrc.includes('绕过 30 天新鲜度过滤'))
ck('设置页标注时间窗对单个采集生效', htmlSrc.includes('单个「采集」同样生效'))
ck('缓存戳不低于 v54（v1.10.7 基线）', /app\.js\?v=(5[4-9]|[6-9]\d)/.test(htmlSrc))

// ---------- ⑫ v1.10.8 混淆隔离区 + 单条信任 ----------
// 用户诉求：混淆源被自动排除后在界面上"看不见"；要求加一个「混淆隔离」页（已灌入与设置之间），
// 隔离的源可在该页点「信任放行」正常使用；命中反调试硬特征的仍不允许放行。
{
  const storeSrc = fs.readFileSync(path.join(__dirname, '../src/core/store.js'), 'utf8')
  const webSrc = fs.readFileSync(path.join(__dirname, '../src/server/web.js'), 'utf8')
  const mainSrc = fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf8')
  const preloadSrc = fs.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf8')
  const bridgeSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/web-bridge.js'), 'utf8')
  console.log('\n== v1.10.8 混淆隔离区 ==')
  ck('store 默认 trustedObfHashes 空名单', storeSrc.includes('trustedObfHashes: []'))
  ck('隔离闸：quarantined 状态取代直接判死', hSrc.includes("e.status = 'quarantined'") && !hSrc.includes("重度混淆脚本，已按设置剔除"))
  ck('检测/灌入两道闸共用 applyObfGate', (hSrc.match(/this\.applyObfGate\(/g) || []).length >= 2)
  ck('trustObfSource 按 contentHash 信任', hSrc.includes('trustObfSource(id, trust)') && hSrc.includes('trustedObfHashes'))
  ck('硬特征条目不允许信任', hSrc.includes('不允许信任') && /spinLoops \|\| 0[\s\S]{0,120}evalCalls \|\| 0/.test(hSrc))
  ck('信任后 status 恢复 ok 且 usable 按 deep', hSrc.includes("if (e.status === 'quarantined') e.status = 'ok'") && hSrc.includes('usableCount(e) > 0'))
  ck('隔离 API 路由 /api/sources/trust-obf', webSrc.includes('/api/sources/trust-obf'))
  ck('桌面 IPC sources:trustObf', mainSrc.includes("'sources:trustObf'") && preloadSrc.includes('sourcesTrustObf'))
  ck('bridge sourcesTrustObf', bridgeSrc.includes('sourcesTrustObf: (id, trust)'))
  ck('导航含「混淆隔离」且位于已灌入与设置之间', /data-view="installed"[\s\S]{0,200}data-view="quarantine"[\s\S]{0,200}data-view="settings"/.test(htmlSrc))
  ck('隔离区视图与渲染函数', htmlSrc.includes('id="view-quarantine"') && htmlSrc.includes('id="qzList"') && appSrc.includes('function renderQuarantine'))
  ck('硬特征条目按钮禁用', appSrc.includes('不可信任'))
  ck('音源库徽章显示混淆隔离', appSrc.includes("status === 'quarantined'") && appSrc.includes('混淆隔离</span>'))
  ck('隔离条目不落入「未检测」筛选', appSrc.includes("e.status !== 'quarantined'"))
  ck('设置页文案改为隔离表述', htmlSrc.includes('自动隔离') && htmlSrc.includes('「混淆隔离」页'))
  ck('缓存戳提升到 app.js v56 / web-bridge v51 / styles v16', htmlSrc.includes('app.js?v=56') && htmlSrc.includes('web-bridge.js?v=51') && htmlSrc.includes('styles.css?v=16'))

  // —— v1.10.8 改名检测（prune 301 识别）+ 仓库行快捷拉黑 ——
  {
    const crSrc = fs.readFileSync(path.join(__dirname, '../src/core/crawler.js'), 'utf8')
    const webSrc = fs.readFileSync(path.join(__dirname, '../src/server/web.js'), 'utf8')
    const mainSrc = fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf8')
    const preloadSrc = fs.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf8')
    const bridgeSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/web-bridge.js'), 'utf8')
    console.log('\n== v1.10.8 改名检测 + 快捷拉黑 ==')
    ck('crawler 提供 resolveRepoRename（跟随重定向比对 full_name）', crSrc.includes('async function resolveRepoRename') && crSrc.includes('full_name') && crSrc.includes('opaqueredirect'))
    ck('改名探测失败宁漏不误（moved=false）', /catch \(e\) \{[\s\S]{0,120}moved: false/.test(crSrc))
    ck('prune 集成改名检测并对批内逐仓探测', hSrc.includes('resolveRepoRename') && hSrc.includes('renamedRepos'))
    ck('改名重复（新名已在清单）自动清理旧名条目', hSrc.includes('haveNew ? renamedRepos : renameHints') && hSrc.includes('dupSet'))
    ck('新名不在清单只提示不自动改', hSrc.includes('新名不在清单，未自动处理'))
    ck('改名清理保留历史音源且不进黑名单', hSrc.includes('历史音源保留') && !/renamedRepos[\s\S]{0,400}blk\.add/.test(hSrc))
    ck('清理结果返回 renamedRepos/renameHints', (hSrc.match(/renamedRepos, renameHints/g) || []).length >= 2)
    ck('hunter 提供 blockRepo 快捷拉黑', hSrc.includes('blockRepo(repo)') && hSrc.includes('jobGate(\'拉黑仓库\''))
    ck('拉黑三件事：移出清单+黑名单+清残留脚本', /cfg\.blockedRepos = Array\.from\(blk\)[\s\S]{0,400}removeSources\(ids\)/.test(hSrc))
    ck('拉黑拒绝网页形态与非法仓库名', hSrc.includes('请提供 owner/repo 形态的仓库名'))
    ck('Web 暴露 /api/repos/block', webSrc.includes("'/api/repos/block'"))
    ck('桌面 IPC repos:block + preload + bridge', mainSrc.includes("'repos:block'") && preloadSrc.includes('reposBlock') && bridgeSrc.includes('reposBlock: repo'))
    ck('仓库行有「拉黑」按钮且网页源不显示', appSrc.includes('repo-block') && appSrc.includes("isWeb ? '' :"))
    ck('拉黑确认文案说明与「删除」的区别', appSrc.includes('请用「删除」'))
    ck('prune toast 显示改名清理结果', appSrc.includes('清理改名重复'))
  }

  // —— v1.10.8 日志全面优化（任务被拒落日志 / 单条硬超时 / 日志筛选+自动刷新+任务chip） ——
  console.log('\n== v1.10.8 日志优化 ==')
  ck('忙时拒绝落日志（jobGate）', hSrc.includes('jobGate(kind, detail)') && hSrc.includes('任务被拒绝：已有任务在运行'))
  ck('8 个任务入口全部走 jobGate', (hSrc.match(/this\.jobGate\(/g) || []).length >= 8)
  ck('指纹单条硬超时兜底', hSrc.includes('单条处理硬超时') && hSrc.includes('Math.max(45000'))
  ck('日志页有模块/级别筛选与自动刷新', htmlSrc.includes('id="logFilterModule"') && htmlSrc.includes('id="logFilterLevel"') && htmlSrc.includes('id="logAutoRefresh"'))
  ck('导航栏任务状态 chip', htmlSrc.includes('id="jobChip"') && appSrc.includes('refreshJobChip'))
  ck('日志增量轮询 + 行去重', appSrc.includes('pollLogsOnce') && appSrc.includes('logKeyOf'))
  ck('筛选统计显示条数', appSrc.includes('logShownCount') && appSrc.includes('applyLogFilter'))

  // —— v1.10.8 jobGate 竞态修复（246 实测双全量爬取并发） ——
  console.log('\n== v1.10.8 jobGate 竞态修复 ==')
  ck('runCrawl 在 jobGate 后同步占位（防搜索发现 await 窗口抢入）', /this\.job = \{ running: true, type: 'crawl', cancel: false, progress: \{\}, step: '准备中' \}\s*const cfg = this\.store\.config/.test(hSrc))
  ck('占位注释说明竞态成因', hSrc.includes('jobGate 竞态修复'))
  ck('runPatrol 占位 + 服务端列表失败回滚', hSrc.includes("type: 'patrol', cancel: false, progress: {}, step: '准备中'") && /this\.job = \{ running: false, type: '', cancel: false, progress: \{\}, step: '' \}\s*throw new Error\('无法读取服务端音源列表/.test(hSrc))
  ck('巡检空清单提前返回也回滚占位', hSrc.includes('占位回滚（提前返回路径）'))
  ck('prune 包装占位 + finally 回滚（此前完全无任务位）', hSrc.includes("_pruneNonSourceRepos(opts)") && /pruneNonSourceRepos\(opts\) \{[\s\S]{0,400}type: 'prune'[\s\S]{0,400}finally[\s\S]{0,200}running: false/.test(hSrc))
}

// ---------- 汇总 ----------
console.log(`\n${bad ? 'FAIL' : 'ALL PASS'}（失败 ${bad} 项）`)
process.exit(bad ? 1 : 0)
