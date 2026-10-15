// v1.9.7 网络加速：爬取代理 / 强制代理 / jsDelivr 开关 / 自定义镜像 / 内置镜像实测筛选
// 用相对于本文件的路径解析，避免换工作区目录后 MODULE_NOT_FOUND
const net = require(require('path').join(__dirname, '..', 'src', 'core', 'net.js'))
const http = require('http')
const { Store } = require(require('path').join(__dirname, '..', 'src', 'core', 'store.js'))

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }

const RAW = 'https://raw.githubusercontent.com/owner/repo/HEAD/a/b.js'
const ASSET = 'https://github.com/owner/repo/releases/download/v1/x.zip'

// ---------- 1. 内置镜像：实测可用的留下，失效的必须剔除 ----------
const ids = net.MIRROR_PRESETS.map(m => m.id)
ck('内置镜像含 ghfast/ghproxy/ghproxy-net/jsdelivr',
  ['ghfast', 'ghproxy', 'ghproxy-net', 'jsdelivr'].every(i => ids.includes(i)), ids.join(','))
ck('不再内置已失效的 FastGit', !ids.includes('fastgit'))
ck('不再内置已失效的 ghproxy.vvv.ee / gh1.lh1.one', !ids.includes('ghproxy-vvv') && !ids.includes('gh1'))
ck('不内置返回 HTML 页面的 ghproxy.cn',
  !net.MIRROR_PRESETS.some(m => /ghproxy\.cn|gh-proxy\.net/.test(m.label)), net.MIRROR_PRESETS.map(m => m.label).join(','))

// ---------- 2. 默认（未配置）行为：与旧版一致 ----------
net.applyConfig({ crawlProxy: '', forceProxy: false, useJsdelivr: true, mirrorCustom: '' })
let c = net.buildCandidates(RAW, 'auto')
ck('默认首候选是直连', c[0].id === 'direct', c[0].id)
ck('默认包含 jsDelivr', c.some(x => x.id === 'jsdelivr'))

// ---------- 3. 自定义镜像 ----------
net.applyConfig({ mirrorCustom: 'https://my.example.com/' })
c = net.buildCandidates(RAW, 'custom')
ck('选自定义时首候选是 custom 且基址去尾斜杠',
  c[0].id === 'custom' && c[0].url === 'https://my.example.com/' + RAW, c[0].url)
net.applyConfig({ mirrorCustom: 'not-a-url' })
ck('自定义基址非法时不产生候选', !net.customPreset())
net.applyConfig({ mirrorCustom: '' })

// ---------- 4. jsDelivr 开关 ----------
net.applyConfig({ useJsdelivr: false })
c = net.buildCandidates(RAW, 'auto')
ck('关闭 jsDelivr 后候选链不含它', !c.some(x => x.id === 'jsdelivr'), c.map(x => x.id).join(','))
net.applyConfig({ useJsdelivr: true })

// ---------- 5. 爬取代理 / 强制代理 ----------
net.applyConfig({ crawlProxy: 'http://192.168.1.1:7890', forceProxy: true })
c = net.buildCandidates(RAW, 'auto')
ck('强制代理时代理排最前', c[0].id === 'proxy', c[0].id)
ck('代理候选的 URL 就是原始 raw 地址（经代理直连，不加镜像前缀）', c[0].url === RAW)
net.applyConfig({ forceProxy: false })
c = net.buildCandidates(RAW, 'auto')
ck('未勾强制代理时首候选仍是直连', c[0].id === 'direct', c[0].id)
net.applyConfig({ crawlProxy: 'socks5://127.0.0.1:7891' })
c = net.buildCandidates(RAW, 'auto')
ck('非 http 代理（socks）不进候选链', !c.some(x => x.id === 'proxy'))
net.applyConfig({ crawlProxy: '' })

// ---------- 6. store 默认值 ----------
const tmp = require('fs').mkdtempSync(require('os').tmpdir() + require('path').sep + 'lxn-')
const store = new Store(tmp)
ck('store 默认 crawlProxy 为空', store.config.crawlProxy === '', String(store.config.crawlProxy))
ck('store 默认 forceProxy 为 false', store.config.forceProxy === false)
ck('store 默认 useJsdelivr 为 true', store.config.useJsdelivr === true)
ck('store 默认 mirrorCustom 为空', store.config.mirrorCustom === '')

// ---------- 7. 代理端到端：真起一个本地转发代理 + 本地目标站 ----------
function startEcho() {
  const s = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('PROXYED-BODY' + req.url) })
  return new Promise(r => s.listen(0, '127.0.0.1', () => r(s)))
}
function startProxy() {
  const s = http.createServer((req, res) => {
    // 只处理绝对 URI 形式（http 代理语义）
    const u = new URL(req.url)
    // 真实代理会带上客户端请求头转发，这里保持一致（否则本机回环的行为与线上不同）
    const h = Object.assign({}, req.headers)
    delete h['proxy-connection']
    const p = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: h }, (up) => {
      res.writeHead(up.statusCode, up.headers)
      up.pipe(res)
    })
    p.on('error', () => { res.writeHead(502); res.end('bad') })
    req.pipe(p)
  })
  return new Promise(r => s.listen(0, '127.0.0.1', () => r(s)))
}

;(async () => {
  const echo = await startEcho()
  const proxy = await startProxy()
  const target = 'http://127.0.0.1:' + echo.address().port + '/some/script.js'
  const proxyUrl = 'http://127.0.0.1:' + proxy.address().port
  try {
    const res = await net.proxyFetchRaw(target, { headers: { 'User-Agent': 'lx-test' } }, 6000, proxyUrl)
    const txt = await res.text()
    ck('http 代理能取到目标内容', res.ok && res.status === 200 && txt === 'PROXYED-BODY/some/script.js', txt)
  } catch (e) {
    ck('http 代理能取到目标内容', false, String(e && e.message || e))
  }
  try {
    await net.proxyFetchRaw(target, null, 3000, 'socks5://127.0.0.1:1080')
    ck('代理格式非法时明确报错', false, '竟然没抛错')
  } catch (e) {
    ck('代理格式非法时明确报错', /格式无效/.test(String(e.message)), e.message)
  }
  // v1.9.8 回归：探针 404 时也要把全部通道测完（此前复用 crawlFetch，遇 404 提前返回只报一条）
  const nf = http.createServer((req, res) => { res.writeHead(404); res.end('no') })
  await new Promise(r => nf.listen(0, '127.0.0.1', r))
  const t404 = await net.testNetwork({ url: 'http://127.0.0.1:' + nf.address().port + '/x', crawlProxy: proxyUrl, forceProxy: true, timeoutMs: 5000 })
  ck('404 探针仍测完全部通道且逐条报状态',
    t404.ok === false && (t404.attempts || []).length >= 2 && t404.attempts.every(a => a.status === 404),
    JSON.stringify(t404.attempts))
  nf.close()
  echo.close(); proxy.close()

  // ---------- 8. testNetwork：用传入快照测试，测完恢复全局配置 ----------
  net.applyConfig({ crawlProxy: 'http://127.0.0.1:1', forceProxy: true })
  const before = net.buildCandidates(RAW, 'auto')[0].id
  const r = await net.testNetwork({ url: RAW, crawlProxy: '', forceProxy: false, timeoutMs: 3000 })
  const after = net.buildCandidates(RAW, 'auto')[0].id
  ck('testNetwork 返回结构化结果', typeof r.ok === 'boolean' && Array.isArray(r.attempts), JSON.stringify(r.attempts && r.attempts.length))
  ck('testNetwork 不污染全局配置', before === 'proxy' && after === 'proxy', before + '/' + after)

  console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
  process.exit(bad ? 1 : 0)
})()
