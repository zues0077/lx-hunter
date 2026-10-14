/**
 * 异步 init 抢救：脚本把 lx.send('inited') 放在网络回调里（先拉远端平台配置）。
 * 网络慢于 init 宽限 ⇒ 原先直接判「脚本未调用 lx.send('inited')」，五个平台全灰「未检测」。
 * 这是用户反馈「检测完还是显示未检测」的主因。
 */
const http = require('http')
const { Sandbox } = require('../src/core/sandbox')
const { deepCheck } = require('../src/core/checker')

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }

// 慢服务端：_DELAY_ms 后才返回平台配置；/url 返回音频链接
let DELAY = 6000
const AUDIO = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4096, 7)])
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/url/')) {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(AUDIO.length) })
    return res.end(AUDIO)
  }
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('kw|128k,320k&wy|128k,320k&tx|128k')
  }, DELAY)
})

// 模拟「先拉远端配置，再在回调里注册」的一类脚本（野花/野草就是这种模式）
const ASYNC_SCRIPT = `
lx.on('request', (payload) => new Promise((resolve, reject) => {
  var mi = (payload.info && payload.info.musicInfo) || {};
  lx.request('__SERVER__/url/' + payload.source + '/' + (mi.songmid || mi.hash || 'x') + '/' + ((payload.info && payload.info.type) || '128k'),
    { method: 'GET' }, (err, resp, body) => {
      if (err) return reject(err);
      resolve({ url: '__SERVER__/url/file.mp3?src=' + payload.source });
    });
}));
lx.request('__SERVER__/config', { method: 'GET' }, (err, resp, body) => {
  if (err) return;
  var sources = {};
  String(body).split('&').forEach(function (seg) {
    var kv = seg.split('|');
    if (!kv[0]) return;
    sources[kv[0]] = { name: kv[0], type: 'music', actions: ['musicUrl'], qualitys: String(kv[1] || '128k').split(',') };
  });
  lx.send('inited', { sources: sources });
});
`

;(async () => {
  // 用 127.0.0.2：链接校验会否决 127.0.0.1/localhost（假链接常见指向），
  // 但 127.0.0.2 属正常回环地址、不在否决名单内，端到端才跑得通。
  await new Promise(r => server.listen(0, '127.0.0.2', r))
  const base = 'http://127.0.0.2:' + server.address().port
  const code = ASYNC_SCRIPT.split('__SERVER__').join(base)

  // ---------- 1. 慢于宽限（6s > 4s 默认宽限）时仍要等到 inited ----------
  let sb = new Sandbox({ id: 'async', fetchTimeout: 15000, dispatchTimeout: 15000 })
  let r = await sb.init(code, { name: '异步init源', homepage: base + '/' })
  ck('慢网络异步 init: 仍能拿到 inited', r.inited === true, JSON.stringify(r).slice(0, 120))
  ck('慢网络异步 init: 拿到完整平台声明', !!r.data && ['kw', 'wy', 'tx'].every(k => r.data.sources[k]),
    r.data ? Object.keys(r.data.sources).join(',') : 'null')

  // ---------- 2. 服务端比硬上限还慢：拿不到 inited，但必须抢救而不是判死 ----------
  DELAY = 60000
  sb = new Sandbox({ id: 'async2', fetchTimeout: 60000, dispatchTimeout: 15000, initGraceMs: 1000, initGraceMaxMs: 3000 })
  r = await sb.init(code, { name: '极慢init源', homepage: base + '/' })
  ck('超硬上限: 抢救为可测而非判死', r.inited === true && r.recovered === true, JSON.stringify(r).slice(0, 140))
  ck('超硬上限: 标记 guessedSources（未拿到平台声明）', r.guessedSources === true)
  ck('超硬上限: 提示说明是「未在宽限内 inited」', /未在 [\d]+ms 内发出 inited/.test(String(r.runError || '')), String(r.runError || '').slice(0, 90))
  sb.destroy()

  // ---------- 3. 抢救出来的脚本要真的能测出可用平台（而不是全灰「未检测」） ----------
  DELAY = 60000
  const d = await deepCheck({ id: 'x', name: '异步init源', url: 'local' }, code,
    { linkTimeoutMs: 12000, platformBudgetMs: 20000, retryBudgetMs: 8000, quickCheck: false, initGraceMs: 1000, initGraceMaxMs: 3000 },
    () => {}, () => false)
  const plats = Object.entries(d.platforms || {})
  console.log('   平台结果:', plats.map(([k, v]) => k + ':' + v.status + '(' + String(v.message||'').slice(0,50) + ')').join(' '))
  ck('抢救后不再「平台全空」', plats.length > 0, '平台数 ' + plats.length)
  ck('抢救后至少实测出一个可用平台', plats.some(([, v]) => v.status === 'usable'),
    plats.map(([k, v]) => k + ':' + v.status).join(','))
  ck('记录 guessedSources 供 UI 措辞', d.guessedSources === true)

  server.close()
  console.log('\n' + (bad === 0 ? 'ALL PASS' : bad + ' FAILED'))
  process.exit(bad ? 1 : 0)
})().catch(e => { console.error('ERR', e); process.exit(1) })
