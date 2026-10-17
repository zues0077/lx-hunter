/**
 * v1.9.9 搜索发现（discoverReposViaSearch）+ 探针固化（applyProbeRecord）回归测试。
 *  - 搜索发现：关键词搜索新仓库、跳过已知、上限/star 门槛、限流不抛错
 *  - 探针固化：validTier(confirmed/probable/rejected) + probe.status + probeFailStreak 累积/清零
 * 用全局 fetch 桩模拟 GitHub 搜索 API，无需联网。
 */
const { discoverReposViaSearch } = require('../src/core/crawler')
const { applyProbeRecord } = require('../src/core/checker')

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }

const seenUrls = []
function mockFetch(items, failMessage) {
  return async (url) => {
    const u = String(url)
    seenUrls.push(u)
    if (/search\/repositories/.test(u)) {
      if (failMessage) return { ok: true, text: async () => JSON.stringify({ message: failMessage }) }
      return { ok: true, text: async () => JSON.stringify({ total_count: (items || []).length, items: items || [] }) }
    }
    return { ok: true, text: async () => '{}' }
  }
}
function mkDeep({ loadable = true, cancelled = false, platforms = {}, loadError = null, declaredSources = null, checkedAt = 1 } = {}) {
  return { loadable, cancelled, loadError, platforms, declaredSources, checkedAt }
}

;(async () => {
  // ---------- 搜索发现 ----------
  const items = [
    { full_name: 'newrepo/lx-music-source', stargazers_count: 12, description: '洛雪音源' },
    { full_name: 'guoyue2010/lxmusic-', stargazers_count: 99 }, // 已知 -> 跳过
    { full_name: 'another/lxmusic-xyz', stargazers_count: 5 }
  ]
  globalThis.fetch = mockFetch(items)
  const r = await discoverReposViaSearch({ keywords: ['lx 音源'], known: new Set(['guoyue2010/lxmusic-']), maxReposPerKeyword: 20, maxTotal: 60, timeoutMs: 5000 })
  ck('搜索发现：跳过已知仓库，返回 2 个', r.repos.length === 2, r.repos.join(','))
  ck('搜索发现：不含已知仓库', !r.repos.includes('guoyue2010/lxmusic-'))
  ck('搜索发现：perKeyword.added=2', r.perKeyword['lx 音源'] && r.perKeyword['lx 音源'].added === 2)

  globalThis.fetch = mockFetch(Array.from({ length: 10 }, (_, i) => ({ full_name: `repo${i}/lxmusic-s${i}`, stargazers_count: 1 })))
  const r2 = await discoverReposViaSearch({ keywords: ['lx 音源'], known: new Set(), maxReposPerKeyword: 20, maxTotal: 3, timeoutMs: 5000 })
  ck('搜索发现：maxTotal 上限生效', r2.repos.length === 3, 'got ' + r2.repos.length)

  const items3 = [
    { full_name: 'low/lxmusic-star', stargazers_count: 1 },
    { full_name: 'high/lx-music-source', stargazers_count: 50 },
    { full_name: 'mid/lxmusic-star', description: '洛雪音源', stargazers_count: 10 }
  ]
  globalThis.fetch = mockFetch(items3)
  const r3 = await discoverReposViaSearch({ keywords: ['lx 音源'], known: new Set(), maxReposPerKeyword: 20, maxTotal: 60, timeoutMs: 5000, skipStarsBelow: 10 })
  ck('搜索发现：star 门槛过滤低星', r3.repos.length === 2 && r3.repos.includes('high/lx-music-source') && r3.repos.includes('mid/lxmusic-star') && !r3.repos.includes('low/lxmusic-star'), r3.repos.join(','))

  // ---------- 相关性闸门（v1.9.13）：无关仓库必须挡住 ----------
  const noise = [
    { full_name: 'x/ebooks', description: 'free ebooks collection' },
    { full_name: 'y/china-dictatorship', description: 'a list of things' },
    { full_name: 'z/gpt4o-image-prompts', description: 'prompt collection' },
    { full_name: 'ok/lx-music-source', description: '洛雪音源合集' },
    { full_name: 'ok2/some-repo', description: '', topics: ['lxmusic', '音源'] }
  ]
  globalThis.fetch = mockFetch(noise)
  const rn = await discoverReposViaSearch({ keywords: ['lx 音源'], known: new Set(), timeoutMs: 5000 })
  ck('相关性闸门：无关仓库被挡住，只留音源语义的',
    rn.repos.length === 2 && rn.repos.includes('ok/lx-music-source') && rn.repos.includes('ok2/some-repo'), rn.repos.join(','))
  ck('相关性闸门：perKeyword 记录被过滤数量', rn.perKeyword['lx 音源'] && rn.perKeyword['lx 音源'].filtered === 3, JSON.stringify(rn.perKeyword))
  ck('相关性闸门：topics 里的 lxmusic 也算命中', rn.repos.includes('ok2/some-repo'))
  // 查询不再带 in:readme（就是它把「正文提过音源」的无关仓库捞进来的）
  ck('搜索查询不再使用 in:readme', !seenUrls.some(u => /in%3Areadme|in:readme/.test(u)), seenUrls.filter(u => /search\/repositories/.test(u)).slice(-1)[0] || '')

  const r4 = await discoverReposViaSearch({ keywords: [], known: new Set() })
  ck('搜索发现：空关键词返回空', r4.repos.length === 0)

  // ---------- 内容验真（v1.9.14）：名字像 ≠ 里面真有音源 ----------
  // 一个只能「看文件树 + 抽 .js + 看 releases」的 GitHub API 桩。
  const SRC_TEXT = [
    'globalThis.lx = {}',
    "lx.on('request', () => {})",
    'const musicSources = {}',
    'const qualitys = {}'
  ].join('\n')
  const fixtures = {
    // 树里直接有音源脚本 —— 应当凭「含音源脚本」放行
    'a/lx-music-source': {
      branch: 'main',
      tree: [{ type: 'blob', path: 'source.js', size: 1200 }],
      files: { 'source.js': SRC_TEXT },
      releases: []
    },
    // 压缩包分发：树里只有一个构建脚本（不是音源）+ 一个 zip —— 这是用户特别强调不能误杀的类型
    'b/lx-source-pack': {
      branch: 'master',
      tree: [
        { type: 'blob', path: 'build.js', size: 800 },
        { type: 'blob', path: 'dist/洛雪音源合集.zip', size: 2 * 1024 * 1024 }
      ],
      files: { 'build.js': 'console.log("build")' },
      releases: []
    },
    // 名字很像音源、其实是安卓客户端 —— 树里有 .js 但都不是音源、也没有压缩包
    'c/lxmusic-android': {
      branch: 'main',
      tree: [{ type: 'blob', path: 'app.js', size: 900 }],
      files: { 'app.js': 'document.title = "lx music android"' },
      releases: []
    },
    // 只发 Release 资产：树是空的，靠 release 资产名放行
    'd/lx-source-release': {
      branch: 'main',
      tree: [],
      files: {},
      releases: [{ tag_name: 'v1', assets: [{ name: '洛雪音源集合.js' }] }]
    },
    // 「音源管理工具」类仓库：唯一像音源的只有测试夹具 → 不能当音源收进来
    'e/lx-music-source-manager': {
      branch: 'main',
      tree: [
        { type: 'blob', path: 'src/index.js', size: 300 },
        { type: 'blob', path: 'tests/fixtures/basic-source.js', size: 400 }
      ],
      files: { 'src/index.js': 'export const app = 1', 'tests/fixtures/basic-source.js': SRC_TEXT },
      releases: []
    },
    // 夹具之外还有真脚本：正常路径优先，不能被夹具带偏
    'f/lx-real-and-fixture': {
      branch: 'main',
      tree: [
        { type: 'blob', path: 'tests/fixtures/basic-source.js', size: 400 },
        { type: 'blob', path: 'real-source.js', size: 500 }
      ],
      files: { 'tests/fixtures/basic-source.js': SRC_TEXT, 'real-source.js': SRC_TEXT },
      releases: []
    },
    // 「有压缩包就算音源」太松：数学题库里 47 个 .rar（含「源代码.7z」）也不能放行
    'g/math-model': {
      branch: 'master',
      tree: Array.from({ length: 6 }, (_, i) => ({ type: 'blob', path: `2012${i}/MATLAB智能算法+源代码.7z`, size: 1000 })),
      files: {},
      releases: []
    },
    // Electron 客户端的发行包也是 zip/7z/dmg，不能当音源分发
    'h/lx-music-desktop': {
      branch: 'main',
      tree: [],
      files: {},
      releases: [
        { tag_name: 'v2.12.6', assets: [
          { name: 'lx-music-desktop-2.12.6-arm64.dmg', size: 128 * 1024 * 1024 },
          { name: 'lx-music-desktop-v2.12.6-win7_x64-green.7z', size: 143 * 1024 * 1024 },
          { name: 'latest.yml', size: 200 }
        ] },
        { tag_name: 'v2.12.5', assets: [{ name: 'lx-music-desktop-2.12.5-x64.dmg', size: 132 * 1024 * 1024 }] }
      ]
    }
  }
  const ghCalls = []
  globalThis.fetch = async (url) => {
    const u = String(url)
    ghCalls.push(u)
    const json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) })
    const info = u.match(/api\.github\.com\/repos\/([^/]+\/[^/?]+)(\/.*)?$/)
    if (!info) return json({})
    const fx = fixtures[info[1]]
    if (!fx) return { ok: false, status: 404, text: async () => '{"message":"Not Found"}' }
    const rest = (info[2] || '').split('?')[0].split('?')[0]
    if (/^\/git\/trees\//.test(rest)) return json({ tree: fx.tree })
    if (/^\/releases/.test(rest)) return json(fx.releases)
    if (/^\/contents\//.test(rest)) {
      const p = decodeURIComponent(rest.slice('/contents/'.length))
      if (fx.files[p] == null) return { ok: false, status: 404, text: async () => '{}' }
      return { ok: true, status: 200, text: async () => fx.files[p] }
    }
    return json({ default_branch: fx.branch })
  }
  const { verifyRepoHasSource } = require('../src/core/crawler')
  const va = await verifyRepoHasSource('a/lx-music-source', { timeoutMs: 3000 })
  ck('内容验真：树里有真音源脚本 -> 放行', va.ok === true && va.reason === '含音源脚本', JSON.stringify(va))
  const vb = await verifyRepoHasSource('b/lx-source-pack', { timeoutMs: 3000 })
  ck('内容验真：压缩包分发仓库必须放行（不因抽检的 .js 不是音源就判死）',
    vb.ok === true && vb.reason === '压缩包分发', JSON.stringify(vb))
  const vc = await verifyRepoHasSource('c/lxmusic-android', { timeoutMs: 3000 })
  ck('内容验真：名为音源实为客户端 -> 剔除', vc.ok === false && vc.reason === '无音源脚本（也无压缩包/发行资产）', JSON.stringify(vc))
  const vd = await verifyRepoHasSource('d/lx-source-release', { timeoutMs: 3000 })
  ck('内容验真：只发 Release 资产的仓库放行', vd.ok === true && vd.reason === 'Release 资产分发', JSON.stringify(vd))
  const ve = await verifyRepoHasSource('e/lx-music-source-manager', { timeoutMs: 3000 })
  ck('内容验真：只有测试夹具的「音源管理工具」被剔除',
    ve.ok === false && ve.reason === '仅测试/示例脚本', JSON.stringify(ve))
  const vf = await verifyRepoHasSource('f/lx-real-and-fixture', { timeoutMs: 3000 })
  ck('内容验真：真脚本优先于夹具（不被 tests/fixtures 带偏）',
    vf.ok === true && vf.reason === '含音源脚本' && vf.file === 'real-source.js', JSON.stringify(vf))
  const vg = await verifyRepoHasSource('g/math-model', { timeoutMs: 3000 })
  ck('内容验真：无关仓库的一堆压缩包不算音源分发',
    vg.ok === false && vg.reason === '压缩包不是音源（无音源脚本）', JSON.stringify(vg))
  const vh = await verifyRepoHasSource('h/lx-music-desktop', { timeoutMs: 3000 })
  ck('内容验真：客户端的 dmg/7z 发行包不算音源分发',
    vh.ok === false, JSON.stringify(vh))
  // 资产判据单测：真分发包 vs 客户端构建产物
  const { isSourceAsset } = require('../src/core/crawler')
  const assetsOk = [
    ['lxmusic.jsplugin.zip', 483 * 1024],
    ['LxMusicApi_1.0.0.0.zip', 30 * 1024 * 1024],
    ['HYWmusic_.V1.2.0.js', 200 * 1024],
    ['洛雪音源集合.zip', 3 * 1024 * 1024]
  ].every(([name, size]) => isSourceAsset({ name, size }))
  const assetsBad = [
    ['lx-music-desktop-v2.12.6-win7_x64-green.7z', 143 * 1024 * 1024],
    ['LX.Music.Server.2.1.3.arm64.Portable.exe', 104 * 1024 * 1024],
    ['Sollin-1.3.8-arm64-mac.zip', 129 * 1024 * 1024],
    ['BakaMusic-1.9.5-linux-amd64.AppImage', 144 * 1024 * 1024],
    ['latest-linux-arm64.yml', 0]
  ].every(([name, size]) => !isSourceAsset({ name, size }))
  ck('资产判据：音源分发包放行、客户端构建产物挡住', assetsOk && assetsBad)

  // verify 开关：默认不做内容验真（不额外打树接口）；开启后按验真结果裁剪
  const searchItems = Object.keys(fixtures).map(full_name => ({ full_name, description: '洛雪音源' }))
  ghCalls.length = 0
  globalThis.fetch = async (url) => {
    const u = String(url)
    ghCalls.push(u)
    if (/search\/repositories/.test(u)) return { ok: true, status: 200, text: async () => JSON.stringify({ items: searchItems }) }
    const json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) })
    const info = u.match(/api\.github\.com\/repos\/([^/]+\/[^/?]+)(\/.*)?$/)
    const fx = info && fixtures[info[1]]
    if (!fx) return { ok: false, status: 404, text: async () => '{}' }
    const rest = (info[2] || '').split('?')[0]
    if (/^\/git\/trees\//.test(rest)) return json({ tree: fx.tree })
    if (/^\/releases/.test(rest)) return json(fx.releases)
    if (/^\/contents\//.test(rest)) {
      const p = decodeURIComponent(rest.slice('/contents/'.length))
      if (fx.files[p] == null) return { ok: false, status: 404, text: async () => '{}' }
      return { ok: true, status: 200, text: async () => fx.files[p] }
    }
    return json({ default_branch: fx.branch })
  }
  const noVerify = await discoverReposViaSearch({ keywords: ['lx 音源'], known: new Set(), timeoutMs: 3000 })
  ck('内容验真：未开启时 8 个命中全收（不做额外请求）',
    noVerify.repos.length === 8 && !ghCalls.some(u => /\/git\/trees\//.test(u)), 'repos=' + noVerify.repos.length)
  const yesVerify = await discoverReposViaSearch({ keywords: ['lx 音源'], known: new Set(), timeoutMs: 3000, verify: true })
  ck('内容验真：开启后剔除客户端、测试夹具、题库与客户端发行仓库',
    yesVerify.repos.length === 4 &&
    ['c/lxmusic-android', 'e/lx-music-source-manager', 'g/math-model', 'h/lx-music-desktop'].every(x => !yesVerify.repos.includes(x)),
    yesVerify.repos.join(','))
  ck('内容验真：压缩包与 Release 分发型都被保住',
    yesVerify.repos.includes('b/lx-source-pack') && yesVerify.repos.includes('d/lx-source-release'), yesVerify.repos.join(','))
  ck('内容验真：droppedNoSource 计数与 details 对齐',
    yesVerify.droppedNoSource === 4 && yesVerify.discovered === 8 && yesVerify.details.length === 8,
    `dropped=${yesVerify.droppedNoSource} discovered=${yesVerify.discovered} details=${yesVerify.details.length}`)

  globalThis.fetch = mockFetch(null, { failMessage: 'API rate limit exceeded' })
  const r5 = await discoverReposViaSearch({ keywords: ['lx 音源'], known: new Set() })
  ck('搜索发现：限流被记录为 error 且不抛错', r5.perKeyword['lx 音源'] && r5.perKeyword['lx 音源'].error && r5.repos.length === 0)

  // ---------- 探针固化 ----------
  const e1 = { suspected: true, contentHash: 'h1' }
  applyProbeRecord(e1, mkDeep({ platforms: { wy: { status: 'usable' }, tx: { status: 'failed' } } }))
  ck('探针：可用 -> confirmed', e1.validTier === 'confirmed', e1.validTier)
  ck('探针：可用 -> status=usable', e1.probe.status === 'usable')
  ck('探针：可用 -> failStreak 清零', e1.probeFailStreak === 0)

  const e2 = { suspected: true }
  applyProbeRecord(e2, mkDeep({ platforms: { wy: { status: 'failed', message: 'fetch 失败' } } }))
  ck('探针：网络失败 -> degraded', e2.probe.status === 'degraded', e2.probe.status)
  ck('探针：网络失败 -> probable', e2.validTier === 'probable', e2.validTier)
  ck('探针：网络失败 -> failStreak+1', e2.probeFailStreak === 1)

  const e3 = { suspected: false }
  applyProbeRecord(e3, mkDeep({ loadable: false, loadError: '脚本未调用 lx.send', platforms: {} }))
  ck('探针：不可加载 -> not_loadable', e3.probe.status === 'not_loadable')
  ck('探针：非音源 -> rejected', e3.validTier === 'rejected', e3.validTier)

  const e4 = { suspected: true, probeFailStreak: 2 }
  applyProbeRecord(e4, mkDeep({ platforms: { wy: { status: 'failed', message: 'HTTP 404' } } }))
  ck('探针：失败累积 failStreak=3', e4.probeFailStreak === 3, 'got ' + e4.probeFailStreak)
  const e4b = { suspected: true, probeFailStreak: 3 }
  applyProbeRecord(e4b, mkDeep({ platforms: { wy: { status: 'usable' } } }))
  ck('探针：恢复可用 failStreak 清零', e4b.probeFailStreak === 0)

  const e5 = { suspected: true }
  applyProbeRecord(e5, undefined)
  ck('探针：无深检 -> untested', e5.probe.status === 'untested', e5.probe.status)
  ck('探针：无深检且疑似 -> probable', e5.validTier === 'probable')

  if (bad) { console.error(`\n${bad} 个断言失败`); process.exit(1) }
  console.log('\n全部通过')
})()
