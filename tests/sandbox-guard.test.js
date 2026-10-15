// 沙箱防护（v1.9.1）：
//  1) 资源配额闸门：请求总量 / 并发超限时快速失败，不拖垮进程；
//  2) 未处理的 Promise 拒绝兜底：模拟 bug 脚本 `fetch(u).then(r=>r.json()).then(cb)` 不接 catch，
//     验证进程不再因 unhandledRejection 被 SIGKILL（全局兜底已注册）。
const http = require('http')
const { Sandbox } = require('../src/core/sandbox')

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? ' -> ' + x : ''}`) }

function listen(s) { return new Promise(r => s.listen(0, '127.0.0.1', r)) }
function base(s) { return 'http://127.0.0.1:' + s.address().port }

;(async () => {
  // 注：沙箱内的 fetch 是 vm 上下文里的闭包（非 Sandbox 实例方法），通过 sb.context.fetch 访问
  const fetchOf = sb => sb.context.fetch

  // ---------- 1. 总量配额：第 2 次请求被拒 ----------
  const srv = http.createServer((q, r) => { r.writeHead(200); r.end('ok') })
  await listen(srv)
  {
    const sb = new Sandbox({ id: 'q', maxTotalFetches: 1, onLog: () => {} })
    let m1 = ''
    try { await fetchOf(sb)(base(srv)) } catch (e) { m1 = String(e.message || e) }
    ck('首次请求通过（未触发总量上限）', !m1, m1)
    let m2 = ''
    try { await fetchOf(sb)(base(srv)) } catch (e) { m2 = String(e.message || e) }
    ck('第 2 次请求被总量上限拒绝', /请求数超限/.test(m2), m2)
    sb.destroy()
  }

  // ---------- 2. 并发配额：第 2 个并发请求被拒 ----------
  const slow = http.createServer((q, r) => { setTimeout(() => { r.writeHead(200); r.end('ok') }, 200) })
  await listen(slow)
  {
    const sb = new Sandbox({ id: 'qi', maxInflight: 1, onLog: () => {} })
    const a = fetchOf(sb)(base(slow))     // 进入即 inflight=1，200ms 后才 settle
    const b = fetchOf(sb)(base(slow))     // inflight(1) >= maxInflight(1) → 立即拒绝
    let mb = ''
    try { await b } catch (e) { mb = String(e.message || e) }
    ck('并发超上限被拒绝', /并发请求超限/.test(mb), mb)
    await a.catch(() => {})               // 排空，避免干扰
    ck('配额拒绝计数已记录', sb.rejectedByQuota >= 1, 'rejectedByQuota=' + sb.rejectedByQuota)
    sb.destroy()
  }

  // ---------- 3. 未处理拒绝兜底：进程不退出 ----------
  const before = process.__lxUnhandledCount || 0
  {
    const sb = new Sandbox({ id: 'gu', onLog: () => {} })
    // 复现事故：fetch 一个必死地址，且只 .then 不 catch
    const pf = fetchOf(sb)('http://127.0.0.1:1/dead')
    pf.then(r => r.text()).then(t => t)   // 故意不接 catch
    // 再制造一个纯进程级未处理拒绝
    Promise.reject(new Error('沙箱 fetch 失败: 测试用未处理拒绝'))
    await new Promise(r => setTimeout(r, 120))
    ck('全局兜底捕获未处理拒绝、进程未退出', (process.__lxUnhandledCount || 0) > before, 'count=' + (process.__lxUnhandledCount || 0))
    sb.destroy()
  }

  srv.close(); slow.close()
  console.log('\n' + (bad === 0 ? 'ALL PASS' : bad + ' FAILED'))
  process.exit(bad ? 1 : 0)
})().catch(e => { console.error('ERR', e); process.exit(1) })
