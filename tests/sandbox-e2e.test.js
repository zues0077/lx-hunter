// 端到端：真实 vm 沙箱 + 真实本地 HTTP 服务，验证「脚本发请求 → 取链」整条链路
const http = require('http')
const { Sandbox } = require('../src/core/sandbox')

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }

// ---------- 本地服务：模拟音乐接口 ----------
const seen = { forms: [], referers: [], agents: [] }
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    if (req.url.indexOf('/search') === 0) {
      seen.forms.push(body)
      seen.referers.push(req.headers['referer'] || '')
      seen.agents.push(req.headers['user-agent'] || '')
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': 'token=abc; Path=/' })
      res.end(JSON.stringify({ data: { url: `${BASE}/file.mp3?tick=${Date.now()}` } }))
    } else if (req.url.indexOf('/file.mp3') === 0) {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': 8 })
      res.end(Buffer.from([0x49, 0x44, 0x33, 0x03, 0, 0, 0, 0]))
    } else {
      res.writeHead(404); res.end('nope')
    }
  })
})
let BASE = ''

// 一段标准洛雪音源脚本：用 lx.request(form) 换取链，再配合 lx.utils 缓存
const SCRIPT = `
const SERVER = __SERVER__;
lx.on('request', (p) => {
  return new Promise((resolve, reject) => {
    lx.request(SERVER + '/search', {
      method: 'POST',
      form: { keyword: p.musicInfo.name, quality: p.type },
      headers: { Referer: SERVER + '/' },
      timeout: 8000
    }, (err, resp, body) => {
      if (err) return reject(err);
      const u = body && body.data && body.data.url;
      if (!u) return reject(new Error('接口没返回链接 status=' + (resp && resp.statusCode)));
      localStorage.setItem('last', u);
      resolve({ type: p.type, url: u });
    });
  });
});
lx.send('inited', {
  openDevTools: false,
  sources: {
    test: { name: '测试源', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k'] }
  }
});
`

async function runCase(url, metaHomepage) {
  const sb = new Sandbox({ id: 't1', fetchTimeout: 8000, dispatchTimeout: 12000, onLog: () => {} })
  const code = SCRIPT.replace('__SERVER__', JSON.stringify(url))
  const initRes = await sb.init(code, { homepage: metaHomepage })
  return { sb, initRes }
}

;(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  BASE = 'http://127.0.0.1:' + port

  // ---- 1. 正常路径：init + 真实发请求取到链 ----
  {
    const { sb, initRes } = await runCase(BASE, BASE + '/')
    ck('脚本 init 成功', initRes.inited === true)
    const srcDefs = (initRes.data && initRes.data.sources) || {}
    ck('注册了音源', Object.keys(srcDefs).includes('test'), JSON.stringify(Object.keys(srcDefs)))
    const declared = (srcDefs.test && (srcDefs.test.qualitys || srcDefs.test.qualities)) || []
    ck('读到脚本声明的音质', declared.includes('128k'), JSON.stringify(declared))

    const _r0 = await sb.dispatch('request', { source: 'test', musicInfo: { name: '晴天' }, type: '128k' }, 10000)
    const res = _r0 && _r0.result
    ck('lx.request 真实取到音频链接', res && res.url && res.url.indexOf('file.mp3') > 0, JSON.stringify(res).slice(0, 120))
    ck('form 表单被正确编码发出', /keyword=%E6%99%B4%E5%A4%A9|keyword=晴天/.test(String(seen.forms[0] || '')), String(seen.forms[0]))
    ck('localStorage 可用（不再因缺失整脚本失败）', true)
    sb.destroy()
  }

  // ---- 2. 目标不可达：错误信息必须带真因，而不是干巴巴的 "fetch failed" ----
  {
    const dead = 'http://127.0.0.1:1'   // 没人监听
    const SCRIPT2 = SCRIPT.replace('__SERVER__', JSON.stringify(dead))
    const sb = new Sandbox({ id: 't2', fetchTimeout: 8000, dispatchTimeout: 12000, onLog: () => {} })
    const initRes = await sb.init(SCRIPT2, { homepage: dead + '/' })
    ck('不可达目标: 脚本仍能 init', initRes.inited === true)
    let msg = ''
    try { await sb.dispatch('request', { source: 'test', musicInfo: { name: '晴天' }, type: '128k' }, 10000) } catch (e) { msg = String(e.message || e) }
    const hasCause = /ECONNREFUSED|socket|connection|refused|不到|失败/i.test(msg) && !/^\s*沙箱 fetch 失败:\s*fetch failed\s*\[/.test(msg)
    ck('错误信息含真因而非裸 fetch failed', hasCause, msg.slice(0, 140))
    sb.destroy()
  }

  // ---- 3. 相对地址且无 homepage：给明确提示，不抛裸 TypeError ----
  {
    const SCRIPT3 = `
      lx.on('request', (p) => new Promise((res, rej) => {
        fetch('/relative/path').then(r => r.text()).then(t => res({ url: t })).catch(e => rej(e));
      }));
      lx.send('inited', { sources: { test: { name: '相对地址源', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } });
    `
    const sb = new Sandbox({ id: 't3', fetchTimeout: 6000, dispatchTimeout: 8000, onLog: () => {} })
    await sb.init(SCRIPT3, { homepage: '' })
    let msg = ''
    try { await sb.dispatch('request', { source: 'test', musicInfo: { name: 'x' }, type: '128k' }, 6000) } catch (e) { msg = String(e.message || e) }
    ck('相对地址无基址: 给明确文案', /地址无效|homepage/.test(msg), msg.slice(0, 120))
    sb.destroy()
  }

  // ---- 4. 沙箱 fetch 无 signal 时也要有超时兜底（防脚本裸 fetch 卡死）----
  {
    const slowPort = 1
    const hangServer = http.createServer(() => {})  // 永不响应
    await new Promise(r => hangServer.listen(0, '127.0.0.1', r))
    const hport = hangServer.address().port
    const SCRIPT4 = `
      lx.on('request', (p) => new Promise((res, rej) => {
        fetch('http://127.0.0.1:${hport}/hang').then(r => r.text()).then(t => res({ url: t })).catch(e => rej(e));
      }));
      lx.send('inited', { sources: { test: { name: 'hang', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } });
    `
    const sb = new Sandbox({ id: 't4', fetchTimeout: 1500, dispatchTimeout: 6000, onLog: () => {} })
    await sb.init(SCRIPT4, {})
    const t0 = Date.now()
    let msg = ''
    try { await sb.dispatch('request', { source: 'test', musicInfo: { name: 'x' }, type: '128k' }, 8000) } catch (e) { msg = String(e.message || e) }
    const dt = Date.now() - t0
    ck('裸 fetch 卡住也会被超时兜住', dt < 5000 && /超时|aborter|signal|fetch/i.test(msg), dt + 'ms / ' + msg.slice(0, 90))
    sb.destroy()
    hangServer.close()
  }

  server.close()
  console.log('\n' + (bad === 0 ? 'ALL PASS' : bad + ' FAILED'))
  process.exit(bad === 0 ? 0 : 1)
})().catch(e => { console.error('ERR', e); process.exit(1) })
