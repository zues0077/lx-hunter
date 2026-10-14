// 验证网络层修复：错误原因展开 + 双通道回退 + 响应级错误不重复请求
// 全部使用 net.js 里的真实实现（不是复制一份逻辑来测），通过注入假的 electron 模块控制通道行为
// 用相对于本文件的路径解析：写死绝对路径会在换工作区目录后直接 MODULE_NOT_FOUND
const NET = require('path').join(__dirname, '..', 'src', 'core', 'net.js')
const Module = require('module')
const EP = require.resolve('electron')

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }

/** 注入一个假 electron（指定 Chromium 通道行为），拿到一份全新加载的 net 模块 */
function loadNet(chromiumImpl) {
  const prevCache = require.cache[EP]
  const prevHad = Object.prototype.hasOwnProperty.call(require.cache, EP)
  require.cache[EP] = {
    id: EP, filename: EP, loaded: true, children: [], paths: [],
    exports: chromiumImpl ? { net: { fetch: chromiumImpl } } : {}
  }
  delete require.cache[require.resolve(NET)]
  const mod = require(NET)
  // 注意：必须在拿到 mod 之后、真正发起请求之后再恢复，否则 hostFetch() 惰性解析时会取到真 electron
  const restore = () => { if (prevHad) require.cache[EP] = prevCache; else delete require.cache[EP] }
  return { mod, restore }
}

// ---------- 1. describeNetError：把藏在 cause 里的真因挖出来 ----------
const { describeNetError, isConnLevel, buildDualChannel } = loadNet(null).mod

const dnsErr = new TypeError('fetch failed')
dnsErr.cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.xxx.com'), { code: 'ENOTFOUND' })
const d1 = describeNetError(dnsErr)
ck('DNS 失败能展开出 ENOTFOUND', /fetch failed/.test(d1) && /ENOTFOUND/.test(d1), d1)

const tlsErr = new TypeError('fetch failed')
tlsErr.cause = new Error('unable to get local issuer certificate')
const d2 = describeNetError(tlsErr)
ck('证书错误能展开出来', /certificate/.test(d2), d2)

const proxyErr = new TypeError('fetch failed')
proxyErr.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7890'), { code: 'ECONNREFUSED' })
proxyErr.cause.cause = new Error('代理没开')
const d3 = describeNetError(proxyErr)
ck('三层 cause 链能串起来', /代理没开/.test(d3) && (d3.match(/←/g) || []).length >= 2, d3)

ck('普通错误原样返回', describeNetError(new Error('请求超时 8000ms')) === '请求超时 8000ms')

ck('连接级判定: fetch failed 算连接级', isConnLevel(describeNetError(dnsErr)) === true)
ck('连接级判定: HTTP 500 不算连接级', isConnLevel('HTTP 500 Internal Server Error') === false)
ck('连接级判定: 超时算连接级', isConnLevel('请求超时 8000ms') === true)

// ---------- 2. buildDualChannel：只在「请求没发出去」时换通道 ----------
;(async () => {
  const mk = (via, behavior) => async function () {
    if (behavior === 'connFail') { const e = new TypeError('fetch failed'); e.cause = new Error('connect ECONNREFUSED 127.0.0.1:7890'); throw e }
    if (behavior === 'httpFail') return { ok: false, status: 500, headers: { get: () => 'text/plain' } }
    return { ok: true, status: 200, __via: via, headers: { get: () => 'audio/mpeg' } }
  }

  const a = await buildDualChannel([mk('chromium', 'ok'), mk('node', 'ok')])()
  ck('首选通道可用 -> 直接用它', a.__via === 'chromium', String(a.__via))

  const b = await buildDualChannel([mk('chromium', 'connFail'), mk('node', 'ok')])()
  ck('连接级失败 -> 回退到 Node 通道', b.__via === 'node', String(b.__via))

  let nodeCalls = 0
  const counting = async () => { nodeCalls++; return { ok: true, __via: 'node' } }
  const r500 = await buildDualChannel([mk('chromium', 'httpFail'), counting])()
  ck('HTTP 500 响应 -> 不重复请求第二条通道', nodeCalls === 0 && r500.status === 500,
    'node 通道调用 ' + nodeCalls + ' 次')

  let rejected = false
  try { await buildDualChannel([mk('chromium', 'connFail'), mk('node', 'connFail')])() } catch (e) { rejected = true }
  ck('两条通道都失败 -> 最终抛错', rejected)

  // ---------- 3. hostFetch 真的优先拿 electron.net.fetch ----------
  let chromiumUsed = 0
  const c1 = loadNet(async () => { chromiumUsed++; return { ok: true, __via: 'chromium' } })
  const r = await c1.mod.fetchAnyWithTimeout('https://example.com/x.mp3', {}, 5000)
  c1.restore()
  ck('有 net.fetch 时走 Chromium 网络栈', chromiumUsed === 1 && r.__via === 'chromium',
    chromiumUsed + ' 次 / via=' + r.__via)

  const c2 = loadNet(null) // 没有 electron.net.fetch 的环境（如纯 Node）
  let fell = false
  const savedGlobal = globalThis.fetch
  globalThis.fetch = async () => { fell = true; return { ok: true, __via: 'node' } }
  const r2 = await c2.mod.fetchAnyWithTimeout('https://example.com/y.mp3', {}, 5000)
  c2.restore()
  globalThis.fetch = savedGlobal
  ck('无 net.fetch 时回退 Node fetch', fell && r2.__via === 'node')

  // ---------- 4. 超时确实生效，且报的是「超时」而不是 aborted ----------
  const c3 = loadNet(null)
  globalThis.fetch = (u, o) => new Promise((res, rej) => {
    const t = setTimeout(() => res({ ok: true }), 5000)
    o.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')) })
  })
  const t0 = Date.now()
  let msg = ''
  try { await c3.mod.fetchAnyWithTimeout('https://example.com/slow', {}, 800) } catch (e) { msg = e.message }
  c3.restore()
  globalThis.fetch = savedGlobal
  const dt = Date.now() - t0
  ck('慢请求在超时后返回', /超时/.test(msg) && dt < 2000, dt + 'ms / ' + msg)

  // ---------- 5. 完全不响应 signal 的实现，硬超时也能收场 ----------
  const c4 = loadNet(null)
  globalThis.fetch = () => new Promise(() => {})
  const t1 = Date.now()
  let msg2 = ''
  try { await c4.mod.fetchAnyWithTimeout('https://example.com/hang', {}, 600) } catch (e) { msg2 = e.message }
  c4.restore()
  globalThis.fetch = savedGlobal
  const dt2 = Date.now() - t1
  ck('不认 signal 的实现也有硬超时兜底', /超时/.test(msg2) && dt2 < 2000, dt2 + 'ms / ' + msg2)

  console.log('\n' + (bad === 0 ? 'ALL PASS' : bad + ' FAILED'))
  process.exit(bad === 0 ? 0 : 1)
})().catch(e => { console.error('ERR', e); process.exit(1) })
