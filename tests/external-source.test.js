/**
 * v1.11.0 站外分发源（Pages / 自建域名 / 直链）回归测试
 *
 * 背景：chinaes666/lx-music-source 把 source.js 从 Git 树删掉、改由 Cloudflare Pages
 * 分发 /lx.js。旧口径只查「默认分支 Git 树 + Release 资产」，判死是口径边界不是仓库失效。
 * 本套测试覆盖：三形态识别、纯文本导入地址、宿主插件判死、时间窗（sinceDays）、
 * 只收最新版（latestOnly）、配置/编排/三端透传、以及 prune 不误删 URL 源。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x !== undefined ? '  -> ' + x : ''}`) }

const ws = require('../src/core/websource')
const { scoreEntry } = require('../src/core/checker')
const { buildRepoSeeds, Hunter } = require('../src/core/hunter')
const { Store } = require('../src/core/store')

// 真音源：命中 lx.on 硬契约（宿主判死豁免）+ 全套音源特征
const REAL_SCRIPT = [
  '/*', ' * @name 杰翔聚合音源', ' * @version 2.3.0', ' */',
  'globalThis.lx = globalThis.lx || {}',
  "lx.on('request', async (handler) => {})",
  "lx.request('https://api.example.com/song', { method: 'get' })",
  "const EVENT_NAMES = { request: 'request' }",
  'const musicSources = { kw: {} }',
  'const supportedSources = {}', ''
].join('\n')
// 宿主插件/适配层：造 LX 运行时、导出宿主 API（v1.10.9 假阳性样本同型）
const HOST_SCRIPT = [
  "const EVENT_NAMES = { request: 'request' }",
  'module.exports = { run(code) { return new Function("lx", code) } }',
  'globalThis.lx = { on() {}, request() {}, utils: {} }',
  'const musicUrl = "https://example.com"', ''
].join('\n')
const NOISE_SCRIPT = 'var a = 1; console.log("site chrome");\n'

function mockRes(body, opts) {
  const o = opts || {}
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  const headers = o.headers || {}
  return {
    ok: o.ok !== false,
    status: o.status || 200,
    url: o.url || '',
    headers: { get: k => headers[String(k).toLowerCase()] || null },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    text: async () => buf.toString('utf8')
  }
}

/**
 * websource.js 顶部解构了 fetchAuto，改 net.exports 必须先于 require websource。
 * 这里替换 net.fetchAuto → 删 websource 缓存 → 重新 require → 立刻恢复 net，
 * 使本次拿到的模块闭包持有 mock，且不影响同进程其它模块。
 */
function loadWebsourceWithMock(fetchImpl) {
  const net = require('../src/core/net')
  const orig = net.fetchAuto
  net.fetchAuto = fetchImpl
  delete require.cache[require.resolve('../src/core/websource')]
  const mod = require('../src/core/websource')
  net.fetchAuto = orig
  return mod
}

console.log('\n== v1.11.0 站外分发源：纯函数 ==')
ck('normalizeExternalUrl 收 http(s) 并去 #fragment',
  ws.normalizeExternalUrl('https://p.pages.dev/lx.js?v=2#top') === 'https://p.pages.dev/lx.js?v=2' &&
  ws.normalizeExternalUrl(' http://a.example/x.js ') === 'http://a.example/x.js')
ck('normalizeExternalUrl 拒绝非 http(s) / 相对地址 / owner-repo',
  ws.normalizeExternalUrl('ftp://a.example/x.js') === null &&
  ws.normalizeExternalUrl('/lx.js') === null &&
  ws.normalizeExternalUrl('a/b') === null &&
  ws.normalizeExternalUrl('javascript:alert(1)') === null)
ck('externalUrlKind 按路径识别 script/archive/index',
  ws.externalUrlKind('https://p.pages.dev/lx.js') === 'script' &&
  ws.externalUrlKind('https://p.pages.dev/v1.2.zip') === 'archive' &&
  ws.externalUrlKind('https://p.pages.dev/') === 'index')
ck('extractPlainJsUrls 抓到 <code>/纯文本/Markdown 里的导入地址',
  (() => {
    const html = '<p>导入地址：</p><code>https://p.pages.dev/lx.js</code>' +
      '<p>备用 https://p.pages.dev/backup.js?v=3</p>' +
      '<a href="https://p.pages.dev/href.js">链接</a>' +
      '[MD](https://p.pages.dev/md.js) <img src="https://p.pages.dev/app.css">'
    const u = ws.extractPlainJsUrls(html, 'https://p.pages.dev/')
    // href/src 里的绝对地址也会顺带命中，mergeJsLinks 负责去重，这里只要不漏纯文本地址即可
    return u.length >= 3 && u.includes('https://p.pages.dev/lx.js') &&
      u.some(x => x.indexOf('backup.js?v=3') > 0) && u.some(x => x.indexOf('md.js') > 0) &&
      !u.some(x => /\.css/.test(x))
  })(), JSON.stringify(ws.extractPlainJsUrls('<code>https://p.pages.dev/lx.js</code>', 'https://p.pages.dev/')))
ck('extractPlainJsUrls 去重且不放行非 .js 链接',
  (() => {
    const u = ws.extractPlainJsUrls('https://p.pages.dev/a.js https://p.pages.dev/a.js https://p.pages.dev/a.css', 'https://p.pages.dev/')
    return u.length === 1
  })())
ck('mergeJsLinks 合并 href/src 与纯文本地址并按 URL 去重',
  (() => {
    const html = '<a href="/lx.js">a</a><code>https://p.pages.dev/lx.js</code><code>https://p.pages.dev/extra.js</code>'
    const l = ws.mergeJsLinks(html, 'https://p.pages.dev/')
    return l.length === 2 && l[0].url === 'https://p.pages.dev/lx.js'
  })(), JSON.stringify(ws.mergeJsLinks('<a href="/lx.js">a</a><code>https://p.pages.dev/lx.js</code>', 'https://p.pages.dev/')))
ck('judgeExternalScript 放行真音源', ws.judgeExternalScript('https://p.pages.dev/lx.js', REAL_SCRIPT).ok === true)
ck('judgeExternalScript 判死宿主插件/适配层',
  (() => { const j = ws.judgeExternalScript('https://p.pages.dev/index.js', HOST_SCRIPT); return !j.ok && /宿主插件/.test(j.reason) })(),
  JSON.stringify(ws.judgeExternalScript('https://p.pages.dev/index.js', HOST_SCRIPT)))
ck('judgeExternalScript 判死站点自带 JS', ws.judgeExternalScript('https://p.pages.dev/app.js', NOISE_SCRIPT).ok === false)
ck('scoreEntry 已对宿主插件归零（与 checker 同口径）', scoreEntry('index.js', HOST_SCRIPT) === 0)
ck('detectPayloadKind：JS Content-Type / HTML / PK 魔数三形态',
  ws.detectPayloadKind({ headers: { get: () => 'application/javascript' } }, 'https://p.pages.dev/lx', Buffer.from(REAL_SCRIPT), REAL_SCRIPT) === 'script' &&
  ws.detectPayloadKind({ headers: { get: () => 'text/html' } }, 'https://p.pages.dev/', Buffer.from('<html></html>'), '<html></html>') === 'index' &&
  ws.detectPayloadKind({ headers: { get: () => 'application/octet-stream' } }, 'https://p.pages.dev/a.bin', Buffer.from([0x50, 0x4b, 3, 4]), '') === 'archive')
ck('detectPayloadKind：无扩展名但正文是音源 → 直链脚本',
  ws.detectPayloadKind({ headers: { get: () => 'text/plain' } }, 'https://p.pages.dev/api/source', Buffer.from(REAL_SCRIPT), REAL_SCRIPT) === 'script')
ck('buildExternalItem 沿用 web::host::path 的 id 口径并打站外标记',
  (() => {
    const j = ws.judgeExternalScript('https://p.pages.dev/lx.js', REAL_SCRIPT)
    const it = ws.buildExternalItem('https://p.pages.dev/lx.js', 'https://p.pages.dev/lx.js', REAL_SCRIPT, j)
    return it.id === 'web::p.pages.dev::/lx.js' && it.external === true && it.sourceKind === 'external' &&
      it.contentHash === j.hash && it.repo === 'https://p.pages.dev/lx.js'
  })())
ck('payloadHash 二进制安全且稳定',
  ws.payloadHash(Buffer.from([0, 1, 2, 255])) === ws.payloadHash(Buffer.from([0, 1, 2, 255])) &&
  ws.payloadHash(Buffer.from([0, 1, 2, 255])) !== ws.payloadHash(Buffer.from([0, 1, 2, 254])))

;(async () => {
  console.log('\n== v1.11.0 站外分发源：采集行为（mock 网络）==')
  const URL_DIRECT = 'https://p.pages.dev/lx.js'
  const jsRes = () => mockRes(REAL_SCRIPT, { url: URL_DIRECT, headers: { 'content-type': 'application/javascript', 'last-modified': 'Sat, 07 Nov 2026 21:15:00 GMT' } })

  // ① 直链脚本 + 时间窗 + 只收最新版开关
  {
    let calls = 0
    const events = []
    const w = loadWebsourceWithMock(async () => { calls++; return jsRes() })
    const onEvent = (t, p) => events.push({ t, p })
    const base = { timeoutMs: 1000, sinceDays: 30, latestOnly: true }
    const st1 = await w.crawlWebSite(URL_DIRECT, base, onEvent, () => false)
    const repoEvents = events.filter(e => e.t === 'repo')
    ck('直链脚本：mode=script / ok / 收入 1 条', st1.ok === true && st1.mode === 'script' && st1.collected === 1,
      JSON.stringify({ ok: st1.ok, mode: st1.mode, collected: st1.collected, reason: st1.reason }))
    ck('直链脚本：发 repo 事件且 item 可增量合并（带 code + contentHash）',
      repoEvents.length === 1 && repoEvents[0].p.items.length === 1 &&
      !!repoEvents[0].p.items[0].code && !!repoEvents[0].p.items[0].contentHash)
    ck('直链脚本：记下响应体指纹与 Last-Modified', !!st1.hash && /2026/.test(st1.lastModified))
    const hash1 = st1.hash

    events.length = 0
    const st2 = await w.crawlWebSite(URL_DIRECT,
      Object.assign({}, base, { knownExternal: { hash: hash1, at: Date.now() } }), onEvent, () => false)
    ck('时间窗 30 天：内容未变 → fresh=false / mode=unchanged / 不产音源',
      st2.fresh === false && st2.mode === 'unchanged' && st2.collected === 0 &&
      events.filter(e => e.t === 'repo').length === 0,
      JSON.stringify({ fresh: st2.fresh, mode: st2.mode, reason: st2.reason }))

    events.length = 0
    const st3 = await w.crawlWebSite(URL_DIRECT,
      { timeoutMs: 1000, sinceDays: 0, latestOnly: true, knownExternal: { hash: hash1, at: Date.now() } }, onEvent, () => false)
    ck('时间窗 0 天（不限）：内容未变也照常采集', st3.ok === true && st3.mode === 'script' && st3.collected === 1)

    events.length = 0
    const st4 = await w.crawlWebSite(URL_DIRECT,
      Object.assign({}, base, { knownExternal: { hash: 'changed', at: Date.now() } }), onEvent, () => false)
    ck('时间窗 30 天：内容变化才采（等价于「只采有新音源的源」）', st4.ok === true && st4.fresh === true && st4.collected === 1)
    ck('直链脚本全程只发 1 次主请求，不解析不存在的索引页', calls >= 4)
  }

  // ② 宿主插件直链必须判死（不能重演 v1.10.9 假阳性）
  {
    const events = []
    const w = loadWebsourceWithMock(async () => mockRes(HOST_SCRIPT, { url: 'https://host.dev/index.js', headers: { 'content-type': 'application/javascript' } }))
    const st = await w.crawlWebSite('https://host.dev/index.js', { timeoutMs: 1000, sinceDays: 0 }, (t, p) => events.push({ t, p }), () => false)
    ck('宿主插件直链判死且不入库', st.ok === false && /宿主插件/.test(st.reason) && events.filter(e => e.t === 'repo').length === 0,
      JSON.stringify({ ok: st.ok, reason: st.reason }))
    const pr = await w.probeExternalSource('https://host.dev/index.js', { timeoutMs: 1000 })
    ck('探测接口同样判死宿主插件（不让添加）', pr.ok === false && /宿主插件/.test(pr.reason))
  }

  // ③ 索引页：纯文本导入地址 + 只收最新版
  {
    const html = '<html><body><p>导入地址：</p><code>https://p.pages.dev/lx.js</code>' +
      '<p>备用 https://p.pages.dev/backup.js</p></body></html>'
    let scriptCalls = 0
    const w = loadWebsourceWithMock(async (url) => {
      if (String(url).indexOf('.js') > 0) scriptCalls++
      if (/backup\.js/.test(String(url))) return mockRes(NOISE_SCRIPT, { url, headers: { 'content-type': 'application/javascript' } })
      if (/\.js/.test(String(url))) return mockRes(REAL_SCRIPT, { url, headers: { 'content-type': 'application/javascript' } })
      return mockRes(html, { url, headers: { 'content-type': 'text/html' } })
    })
    const events = []
    const st = await w.crawlWebSite('https://p.pages.dev/', { timeoutMs: 1000, sinceDays: 0, latestOnly: true },
      (t, p) => events.push({ t, p }), () => false)
    ck('索引页纯文本导入地址被采集（旧版只认 href/src 会全漏）',
      st.ok === true && st.mode === 'index' && st.links === 2 && st.collected === 1,
      JSON.stringify({ ok: st.ok, mode: st.mode, links: st.links, collected: st.collected, reason: st.reason }))
    ck('索引页：不像音源的直链被静默跳过', st.failed === 1 && scriptCalls === 2)
  }
  {
    const html = '<a href="https://p.pages.dev/src-v2.3.1.js">v1</a><a href="https://p.pages.dev/src-v2.3.2.js">v2</a>'
    let downloaded = []
    const w = loadWebsourceWithMock(async (url) => {
      if (/\.js/.test(String(url))) {
        downloaded.push(String(url))
        return mockRes(REAL_SCRIPT, { url, headers: { 'content-type': 'application/javascript' } })
      }
      return mockRes(html, { url, headers: { 'content-type': 'text/html' } })
    })
    const st = await w.crawlWebSite('https://p.pages.dev/', { timeoutMs: 1000, sinceDays: 0, latestOnly: true }, () => {}, () => false)
    ck('只收最新版：同组旧版本直链不下载不入库',
      st.droppedOld === 1 && downloaded.length === 1 && /2\.3\.2/.test(downloaded[0]),
      JSON.stringify({ droppedOld: st.droppedOld, downloaded }))
    const stAll = await w.crawlWebSite('https://p.pages.dev/', { timeoutMs: 1000, sinceDays: 0, latestOnly: false }, () => {}, () => false)
    ck('关闭「只收最新版」时两个版本都保留', stAll.droppedOld === 0 && stAll.collected === 2,
      JSON.stringify({ droppedOld: stAll.droppedOld, collected: stAll.collected }))
  }

  // ④ 探测接口（添加前验真，不入库）
  {
    const w = loadWebsourceWithMock(async () => jsRes())
    const pr = await w.probeExternalSource(URL_DIRECT, { timeoutMs: 1000 })
    ck('probeExternalSource 返回直链形态/验真结果/脚本清单',
      pr.ok === true && pr.kind === 'script' && pr.scripts.length === 1 && !!pr.hash,
      JSON.stringify({ ok: pr.ok, kind: pr.kind, reason: pr.reason }))
    ck('probeExternalSource 拒绝非法地址', (await w.probeExternalSource('a/b', {})).ok === false)
  }

  console.log('\n== v1.11.0 站外分发源：配置 / 编排 / 三端透传 ==')
  ck('buildRepoSeeds 合并启用的站外源 URL（禁用的不进种子）',
    (() => {
      const s = buildRepoSeeds({
        repos: [{ repo: 'a/b', enabled: true }, { repo: 'c/d', enabled: false }],
        externalSources: [
          { url: 'https://p.pages.dev/lx.js', enabled: true },
          { url: 'https://off.dev/x.js', enabled: false }
        ]
      })
      return s.includes('a/b') && !s.includes('c/d') && s.includes('https://p.pages.dev/lx.js') && !s.includes('https://off.dev/x.js')
    })())
  ck('buildRepoSeeds 对旧配置（无 externalSources）行为不变',
    buildRepoSeeds({ repos: [{ repo: 'a/b', enabled: true }] }).join(',') === 'a/b')

  const tmp = fs.mkdtempSync(os.tmpdir() + path.sep + 'lxext-')
  const store = new Store(tmp)
  const hunter = new Hunter(store, () => {})
  ck('默认配置含 externalSources / externalStates',
    Array.isArray(store.config.externalSources) && store.config.externalStates && typeof store.config.externalStates === 'object')
  const list1 = hunter.addExternalSource(URL_DIRECT, { ok: true, kind: 'script', name: '测试源', scripts: [{}] })
  ck('addExternalSource 落盘并带形态/探测状态', list1.length === 1 && list1[0].kind === 'script' && list1[0].lastProbe.ok === true &&
    JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8')).externalSources.length === 1)
  let threw = false
  try { hunter.addExternalSource(URL_DIRECT, { ok: true }) } catch (e) { threw = true }
  ck('重复 URL 添加被拒绝', threw)
  threw = false
  try { hunter.addExternalSource('https://bad.dev/x.js', { ok: false, reason: '宿主插件' }) } catch (e) { threw = true }
  ck('验真不通过的地址不让添加', threw)
  const list2 = hunter.updateExternalSource(URL_DIRECT, { enabled: false, name: '改名' })
  ck('updateExternalSource 改启用状态与名称', list2[0].enabled === false && list2[0].name === '改名')
  store.config.externalStates[URL_DIRECT] = { hash: 'abc', at: Date.now() }
  const list3 = hunter.removeExternalSource(URL_DIRECT)
  ck('removeExternalSource 移出清单并清时间窗指纹', list3.length === 0 && !store.config.externalStates[URL_DIRECT])
  ck('probeExternal / listExternalSources 方法齐备',
    typeof hunter.probeExternal === 'function' && Array.isArray(hunter.listExternalSources()))

  const wsSrc = read('src/core/websource.js')
  const hSrc = read('src/core/hunter.js')
  const stSrc = read('src/core/store.js')
  const webSrc = read('src/server/web.js')
  const mainSrc = read('src/main/index.js')
  const preloadSrc = read('src/main/preload.js')
  const bridgeSrc = read('src/renderer/web-bridge.js')
  const htmlSrc = read('src/renderer/index.html')
  const appSrc = read('src/renderer/app.js')
  ck('websource 复用宿主判死 + 插件包判据（与 GitHub 通道同口径）',
    wsSrc.includes('isHostAdapterScript') && wsSrc.includes('pickScriptsFromZip') && wsSrc.includes('classifyEntry'))
  ck('runCrawl 把 sinceDays / knownExternal 传给站外源并回写 externalStates',
    hSrc.includes('knownExternal: cfg.externalStates[site]') && hSrc.includes('cfg.externalStates[site] = { hash: st.hash'))
  ck('prune 跳过 URL 源，不再用 GitHub 验真误删站外源',
    hSrc.includes('if (isWebRepo(n)) { skippedWeb++') && hSrc.includes('skippedWeb'))
  ck('store 默认配置注释说明为何不放进 repos', stSrc.includes('externalSources: []') && stSrc.includes('externalStates: {}'))
  ck('Web 端 5 个 /api/externals 路由',
    ['/api/externals\'', '/api/externals/probe', '/api/externals\'', '/api/externals/update', '/api/externals/remove']
      .every(x => webSrc.includes(x)) && webSrc.includes("route('POST', '/api/externals'"))
  ck('桌面端 5 个 externals:* IPC',
    ['externals:get', 'externals:probe', 'externals:add', 'externals:update', 'externals:remove'].every(x => mainSrc.includes("'" + x + "'")))
  ck('preload / web-bridge 三端透传 5 个方法',
    ['externalsGet', 'externalsProbe', 'externalsAdd', 'externalsUpdate', 'externalsRemove']
      .every(x => preloadSrc.includes(x) && bridgeSrc.includes(x)))
  ck('采集源页新增「站外分发源」卡片与全部控件',
    htmlSrc.includes('站外分发源') && htmlSrc.includes('id="externalList"') &&
    htmlSrc.includes('id="externalAddInput"') && htmlSrc.includes('id="btnAddExternal"') && htmlSrc.includes('id="btnCrawlExternals"'))
  ck('采集源页文案写明时间窗口径（内容变化才采）与版本归并',
    htmlSrc.includes('响应体指纹是否变化') && htmlSrc.includes('同组音源只保留最新版'))
  ck('app.js 渲染/验真/添加/行级采集/全部采集逻辑齐备',
    appSrc.includes('function renderExternalList') && appSrc.includes('api.externalsAdd') &&
    appSrc.includes('api.externalsProbe') && appSrc.includes('api.externalsRemove') &&
    appSrc.includes('only: [url]') && appSrc.includes('only: urls'))
  ck('loadConfig / saveAllCfg / 数据导入后都刷新站外源列表',
    (appSrc.match(/renderExternalList\(/g) || []).length >= 5)
  ck('缓存戳 v62 / v57 / v19',
    htmlSrc.includes('app.js?v=62') && htmlSrc.includes('web-bridge.js?v=57') && htmlSrc.includes('styles.css?v=19'))

  console.log(`\n${bad ? 'FAIL（失败 ' + bad + ' 项）' : 'ALL PASS'}`)
  process.exit(bad ? 1 : 0)
})().catch(e => { console.error('测试异常：', e); process.exit(1) })
