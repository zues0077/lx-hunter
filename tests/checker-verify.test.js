// checker.verifyUrl：链接是否真的能拉到音频（本地转 IPv6 回环地址绕开私有地址判定）
const http = require('http')
const { verifyUrl, looksAudioForTest } = require('../src/core/checker')

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }

const MP3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x03, 0, 0, 0, 0]), Buffer.alloc(2048, 1)])
const FLAC = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(512, 2)])

const routes = {
  '/ok.mp3': { ct: 'audio/mpeg', body: MP3 },
  '/blank-ct.mp3': { ct: '', body: MP3 },              // 奇葩 CDN：content-type 为空
  '/wrong-ct.mp3': { ct: 'text/plain', body: MP3 },    // 更奇葩：content-type 写错但内容是真的
  '/json.mp3': { ct: 'application/json', body: Buffer.from('{"code":404}') }
}
const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0]
  if (path === '/403') { res.writeHead(403); return res.end('no') }
  const r = routes[path]
  if (!r) { res.writeHead(404); return res.end('nope') }
  const h = { 'Content-Type': r.ct || 'application/octet-stream' }
  if (req.headers.range) { res.writeHead(206, Object.assign({ 'Content-Range': 'bytes 0-' + (r.body.length - 1) + '/' + r.body.length }, h)); return res.end(r.body) }
  res.writeHead(200, h)
  res.end(r.body)
})

;(async () => {
  await new Promise(r => server.listen(0, '::1', r))
  const port = server.address().port
  const base = 'http://[::1]:' + port

  const a = await verifyUrl(base + '/ok.mp3')
  ck('真音频 -> 可用', a.ok === true, JSON.stringify(a))

  const b = await verifyUrl(base + '/blank-ct.mp3')
  ck('content-type 为空但有音频魔数 -> 仍判可用', b.ok === true, JSON.stringify(b))

  const c = await verifyUrl(base + '/wrong-ct.mp3')
  ck('content-type 写错但有音频魔数 -> 仍判可用', c.ok === true, JSON.stringify(c))

  const d = await verifyUrl(base + '/json.mp3')
  ck('返回 JSON -> 判失效', d.ok === false && /json/.test(d.reason), JSON.stringify(d))

  const e = await verifyUrl(base + '/403')
  ck('HTTP 403 -> 报状态码', e.ok === false && /403/.test(e.reason), JSON.stringify(e))

  const f = await verifyUrl('http://127.0.0.1:8080/x.mp3')
  ck('私有地址 -> 不联网直接否掉', f.ok === false && /私有|本地/.test(f.reason), JSON.stringify(f))

  const g = await verifyUrl('不是个URL')
  ck('非法 URL -> 直接否掉', g.ok === false && /无效/.test(g.reason), JSON.stringify(g))

  const h = await verifyUrl('https://this-host-definitely-not-exists-zzz.example/x.mp3')
  ck('域名解析失败 -> 原因可辨认（不再是裸 fetch failed）',
    h.ok === false && /ENOTFOUND|EAI_AGAIN|解析|操作|getaddrinfo|fetch failed ←/i.test(h.reason) && !/^\s*fetch failed\s*$/.test(h.reason),
    JSON.stringify(h))

  server.close()
  console.log('\n' + (bad === 0 ? 'ALL PASS' : bad + ' FAILED'))
  process.exit(bad === 0 ? 0 : 1)
})().catch(e => { console.error('ERR', e); process.exit(1) })
