// v1.9.13 raw 加速镜像：下拉项来自后端 MIRROR_PRESETS + 逐镜像测速 testMirrorSpeeds
// 用相对于本文件的路径解析，避免换工作区目录后 MODULE_NOT_FOUND
const path = require('path')
const net = require(path.join(__dirname, '..', 'src', 'core', 'net.js'))

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }

// mock 全局 fetch：按 URL 里的镜像域名给不同结果，模拟真实网络差异
const realFetch = globalThis.fetch
let calls = []
globalThis.fetch = async (url) => {
  const u = String(url)
  calls.push(u)
  if (u.includes('ghfast.top')) return { ok: true, status: 200 }
  if (u.includes('gh-proxy.com')) return { ok: false, status: 404 }
  if (u.includes('ghproxy.net')) return { ok: true, status: 200 }
  if (u.includes('gh1.lhl.one')) return { ok: true, status: 200 }
  if (u.includes('cdn.jsdelivr.net')) return { ok: true, status: 200 }
  if (u.includes('my-mirror.example')) return { ok: true, status: 200 }
  if (u.startsWith('https://raw.githubusercontent.com')) return { ok: true, status: 200 }
  throw new Error('ENOTFOUND 模拟不通')
}

;(async () => {
  // ---------- 1. 测速覆盖全部内置镜像 ----------
  net.applyConfig({ crawlProxy: '', forceProxy: false, useJsdelivr: true, mirrorCustom: '' })
  let r = await net.testMirrorSpeeds({})
  const ids = (r.results || []).map(x => x.id)
  ck('测速覆盖所有内置镜像（含直连）',
    ['direct', 'ghfast', 'ghproxy', 'ghproxy-net', 'lhlone', 'jsdelivr'].every(i => ids.includes(i)), ids.join(','))
  ck('每条结果都带耗时 ms', (r.results || []).every(x => typeof x.ms === 'number'))
  ck('每条结果都带 label 与 url', (r.results || []).every(x => x.label && x.url))

  // ---------- 2. 排序：能连通的排前面，不通的沉底 ----------
  const firstBad = (r.results || []).findIndex(x => x.status == null)
  const lastGood = (r.results || []).map(x => x.status != null).lastIndexOf(true)
  ck('不通的镜像排在能连通的之后', firstBad === -1 || firstBad > lastGood, `firstBad=${firstBad} lastGood=${lastGood}`)

  // ---------- 3. 404 视为「通道通」而非失败 ----------
  const gp = (r.results || []).find(x => x.id === 'ghproxy')
  ck('HTTP 404 记为有 status（通道本身是通的）', gp && gp.status === 404, gp ? String(gp.status) : 'missing')
  ck('404 不计入 ok（内容没取到）', gp && gp.ok === false)

  // ---------- 4. 开关联动：关掉 jsDelivr 就不测它 ----------
  r = await net.testMirrorSpeeds({ useJsdelivr: false })
  ck('关闭 jsDelivr 后测速不含它', !(r.results || []).some(x => x.id === 'jsdelivr'))
  r = await net.testMirrorSpeeds({ useJsdelivr: true })
  ck('开启 jsDelivr 后测速含它', (r.results || []).some(x => x.id === 'jsdelivr'))

  // ---------- 5. 自定义镜像：填了才测 ----------
  r = await net.testMirrorSpeeds({ mirrorCustom: '' })
  ck('未填自定义基址时不测自定义', !(r.results || []).some(x => x.id === 'custom'))
  r = await net.testMirrorSpeeds({ mirrorCustom: 'https://my-mirror.example.com' })
  const cs = (r.results || []).find(x => x.id === 'custom')
  ck('填了自定义基址后参与测速', !!cs, cs ? cs.url : 'missing')
  ck('自定义镜像 URL 用该基址拼出', !!cs && cs.url.startsWith('https://my-mirror.example.com'), cs ? cs.url : '')

  // ---------- 6. 不污染全局配置（测完还原） ----------
  net.applyConfig({ crawlProxy: '', forceProxy: true, useJsdelivr: true, mirrorCustom: '' })
  await net.testMirrorSpeeds({ useJsdelivr: false })
  ck('测速后 forceProxy 未被改写', net.buildCandidates('https://raw.githubusercontent.com/o/r/HEAD/a.js', 'auto').length > 0)

  // ---------- 7. 测速不让代理插队（内部强制 forceProxy=false） ----------
  calls = []
  await net.testMirrorSpeeds({ crawlProxy: 'http://127.0.0.1:7890' })
  ck('测速不产生 proxy 通道的绝对 URI 请求', !calls.some(u => /^http:\/\//.test(u)), calls.slice(0, 2).join(' | '))

  globalThis.fetch = realFetch
  console.log('\n' + (bad === 0 ? 'ALL PASS' : bad + ' FAILED'))
  process.exit(bad ? 1 : 0)
})()
