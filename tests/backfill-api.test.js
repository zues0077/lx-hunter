/**
 * v1.9.15 接口域名「批量补探」回归测试。
 * 背景：探活开关是后加的，库里几千条历史音源没有 apiAlive；而主检测开着「跳过已检测」
 * 时不重新拉代码，探测永远补不上 → 音源库的「后端N在线/失效×N」徽章一直空着。
 * 本文件验证收尾补探的四个约束：只在开关开启时跑、只挑缺结果的、每轮限量、有预算与取消保护。
 */
const { Hunter } = require('../src/core/hunter')

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }

// 极简宿主：_backfillApiAlive 只用到 cancelRequested / log / step / emit / store.saveDb
function host() {
  const h = {
    cancelRequested: false,
    logs: [],
    updated: [],
    steps: [],
    log(m) { this.logs.push(String(m)) },
    step(t) { this.steps.push(String(t)) },
    emit(t, p) { if (t === 'source-updated') this.updated.push(p) },
    store: { saveDb() {} }
  }
  return h
}
const call = (h, list, cfg, opts) => Hunter.prototype._backfillApiAlive.call(h, list, cfg, opts)

// mock：按域名决定可达性，并统计请求数
let hits = []
function mockFetch(delayMs) {
  hits = []
  globalThis.fetch = async (u, init) => {
    const url = String(u && u.url ? u.url : u)
    hits.push(url)
    if (delayMs) await new Promise(r => setTimeout(r, delayMs))
    if (/dead\.invalid|down\.test/.test(url)) throw new Error('getaddrinfo ENOTFOUND')
    return { ok: true, status: 200, text: async () => '', headers: { get: () => null } }
  }
}

const mk = (n, opts) => Object.assign({
  id: 'e' + n, name: '源' + n, apiHosts: ['api' + n + '.test']
}, opts || {})

;(async () => {
  mockFetch(0)

  // ---------- 开关与前置条件 ----------
  {
    const h = host()
    const r = await call(h, [mk(1)], { apiHostCheck: false, apiHostBackfillMax: 200 })
    ck('探活开关关闭时不补探', r === null && h.logs.length === 0)
  }
  {
    const h = host()
    const r = await call(h, [mk(1)], { apiHostCheck: true, apiHostBackfillMax: 0 })
    ck('每轮上限为 0 时不补探（用户可关掉）', r === null)
  }
  {
    const h = host()
    const r = await call(h, [mk(1, { apiAlive: { 'api1.test': 'up' } })], { apiHostCheck: true, apiHostBackfillMax: 200 })
    ck('已有探活结果的条目不重复探', r === null && hits.length === 0, 'hits=' + hits.length)
  }
  {
    const h = host()
    const r = await call(h, [mk(1, { deprecated: true }), mk(2, { apiHosts: [] })], { apiHostCheck: true, apiHostBackfillMax: 200 })
    ck('已废弃 / 无接口域名的条目跳过', r === null)
  }

  // ---------- 每轮限量 ----------
  {
    const h = host()
    const list = []
    for (let i = 1; i <= 10; i++) list.push(mk(i))
    const r = await call(h, list, { apiHostCheck: true, apiHostBackfillMax: 3, apiHostBackfillConcurrency: 2 })
    ck('每轮限量：10 条待补只探 3 条', r && r.done === 3, JSON.stringify(r))
    ck('限量后 pending 报剩余数量', r && r.pending === 7, 'pending=' + (r && r.pending))
    const probed = list.filter(e => e.apiAlive && Object.keys(e.apiAlive).length)
    ck('只有被选中的 3 条写入 apiAlive', probed.length === 3, 'got ' + probed.length)
    ck('补探结果逐条推送到界面', h.updated.length >= 3, 'updated=' + h.updated.length)
    ck('日志说明还剩多少待补', h.logs.some(m => /库内还有 7 条待补/.test(m)), h.logs.join(' | '))
  }

  // ---------- 排序：可用的优先 ----------
  {
    mockFetch(0)
    const h = host()
    const a = mk(1, { usable: false })
    const b = mk(2, { usable: true })
    const c = mk(3, { usable: true })
    const r = await call(h, [a, b, c], { apiHostCheck: true, apiHostBackfillMax: 1, apiHostBackfillConcurrency: 1 })
    ck('可用的音源优先补探', r && r.done === 1 && (b.apiAlive || c.apiAlive) && !a.apiAlive,
      `a=${!!a.apiAlive} b=${!!b.apiAlive} c=${!!c.apiAlive}`)
  }

  // ---------- 存活/失效统计 ----------
  {
    mockFetch(0)
    const h = host()
    const up = mk(1)
    const down = mk(2, { apiHosts: ['down.test'] })
    const r = await call(h, [up, down], { apiHostCheck: true, apiHostBackfillMax: 10, apiHostBackfillConcurrency: 2 })
    ck('统计后端可达与全不可达条数', r && r.up === 1 && r.down === 1, JSON.stringify(r))
    ck('可达写 up、不可达写 down',
      up.apiAlive && up.apiAlive['api1.test'] === 'up' && down.apiAlive && down.apiAlive['down.test'] === 'down',
      JSON.stringify({ u: up.apiAlive, d: down.apiAlive }))
  }

  // ---------- 时间预算 ----------
  {
    mockFetch(60)
    const h = host()
    const list = []
    for (let i = 1; i <= 40; i++) list.push(mk(i))
    const t0 = Date.now()
    const r = await call(h, list, { apiHostCheck: true, apiHostBackfillMax: 40, apiHostBackfillConcurrency: 1 }, { budgetMs: 150 })
    const dt = Date.now() - t0
    ck('达到时间预算即停（不探满限量）', r && r.done > 0 && r.done < 40, `done=${r && r.done} ${dt}ms`)
    ck('预算截止不会明显超时', dt < 1500, dt + 'ms')
    ck('日志说明剩余留到下轮', h.logs.some(m => /达到 .* 预算/.test(m)), h.logs.join(' | '))
  }

  // ---------- 取消 ----------
  {
    mockFetch(20)
    const h = host()
    const list = []
    for (let i = 1; i <= 30; i++) list.push(mk(i))
    const p = call(h, list, { apiHostCheck: true, apiHostBackfillMax: 30, apiHostBackfillConcurrency: 1 })
    setTimeout(() => { h.cancelRequested = true }, 30)
    const r = await p
    ck('取消后立刻收尾并如实上报', r && r.done < 30, 'done=' + (r && r.done))
    ck('取消时日志说明下轮继续', h.logs.some(m => /已取消/.test(m)), h.logs.join(' | '))
  }

  if (bad) { console.error(`\n${bad} 个断言失败`); process.exit(1) }
  console.log('\n全部通过')
})()
