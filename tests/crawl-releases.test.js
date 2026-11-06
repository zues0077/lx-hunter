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

// ---------- 汇总 ----------
console.log(`\n${bad ? 'FAIL' : 'ALL PASS'}（失败 ${bad} 项）`)
process.exit(bad ? 1 : 0)
