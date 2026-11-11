'use strict'
/**
 * 性能三项回归（2026-11-11）：
 *  1) `/api/sources` 剥掉脚本正文 code（实测 14.3MB → 2.7MB，code 占 81%）
 *  2) 采集层候选预过滤（客户端源码目录 / 空文件 / 超 2MB），少建条目 = 少下载少排队
 *  3) 同名替换「删旧后上传」由固定 sleep(2500) 改为轮询（撞「已存在」才退避，预算 3s）
 */
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const { Hunter, replaceRetryDelay, REPLACE_UPLOAD_POLL_MS } = require('../src/core/hunter')
const SV = require('../src/core/sourceView')
const { extractCandidates } = require('../src/core/crawler')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')) }
}
function eq(name, got, want) { ok(name, got === want, JSON.stringify(got) + ' ≠ ' + JSON.stringify(want)) }

function mkEntry(o) {
  const o2 = o || {}
  return {
    id: o2.id || 'e1', name: o2.name || '源A', lxName: o2.name || '源A', scriptName: o2.name || '源A',
    scriptVersion: o2.ver || '', repository: o2.repo || 'https://github.com/a/b',
    url: 'https://x/' + (o2.id || 'e1') + '.js', contentHash: 'h' + (o2.id || 'e1'),
    code: o2.code != null ? o2.code : '// 正文 ' + (o2.id || 'e1'),
    usable: o2.usable !== false, size: (o2.code || '').length || 100,
    deep: { checkedAt: 1, platforms: { kw: { status: 'usable', verified: true } }, metrics: { depth: 'full', p50LatencyMs: 200, samples: 1 } }
  }
}
function mkHunter() {
  return new Hunter({
    config: {}, db: { sources: {} }, imported: {},
    saveDb() {}, saveImported() {}, archiveScript() { return true }, scriptDir() { return '' }, scriptSize() { return 0 }
  }, () => {})
}

console.log('=== A. 列表接口剥离脚本正文（载荷 14.3MB → 2.7MB） ===')
{
  const e = mkEntry({ id: 'a1', code: 'x'.repeat(5000) })
  const v = SV.publicSourceView(e)
  eq('剥掉 code', v.code, undefined)
  ok('其余元信息一个不丢（id/url/deep/hash/usable/size）',
    v.id === e.id && v.url === e.url && !!v.deep && v.contentHash === e.contentHash && v.usable === e.usable && v.size === e.size)
  ok('不修改原条目（store 里仍要留正文给检测/灌入用）', typeof e.code === 'string' && e.code.length === 5000)

  const list = [mkEntry({ id: 'a1', code: 'y'.repeat(4096) }), mkEntry({ id: 'a2', code: 'z'.repeat(4096) })]
  const view = SV.publicSourceList(list)
  eq('列表长度不变', view.length, 2)
  ok('列表里没有任何正文', view.every(x => x.code === undefined))
  const rawSize = Buffer.byteLength(JSON.stringify(list))
  const viewSize = Buffer.byteLength(JSON.stringify(view))
  ok('载荷显著变小（>90%）', viewSize < rawSize * 0.1, rawSize + ' → ' + viewSize)
  ok('null/异常入参不抛', SV.publicSourceView(null) === null && SV.publicSourceView(undefined) === undefined)

  // 两个入口都必须真的用上（防「写了工具没人调」）
  const webSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'web.js'), 'utf8')
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8')
  // v1.13.0 起 /api/sources 先把 publicSourceList 的结果存进 list（要在返回前补 veto 标记），
  // 断言相应放宽成「先剥正文、再按 list 返回」，仍然守住「写了工具必须真的被调用」这个目的。
  ok('/api/sources 走 publicSourceList',
    /publicSourceList\(store\.getSources\(\)\)/.test(webSrc) && /sources:\s*list\b/.test(webSrc))
  ok('桌面版 sources:get 也剥正文', /publicSourceList\(store\.getSources\(\)\)/.test(mainSrc))
}

console.log('=== B. 采集层候选预过滤（路径 + 体积） ===')
{
  const tree = { tree: [
    // 客户端本体源码：实测 0 条可用，纯堆量
    { type: 'blob', path: 'src/renderer/utils/musicSdk/wy/musicSearch.js', size: 3000, sha: 's1' },
    { type: 'blob', path: 'src/utils/index.js', size: 3000, sha: 's2' },
    { type: 'blob', path: 'server/routes/foo.js', size: 3000, sha: 's3' },
    // 真空音源候选：不同目录都要留
    { type: 'blob', path: '音源/聚合API.js', size: 20000, sha: 's4' },
    { type: 'blob', path: 'lx-source.js', size: 30000, sha: 's5' },
    { type: 'blob', path: 'src/plugins/mysource.js', size: 12000, sha: 's6' },
    { type: 'blob', path: 'dist/打包音源.js', size: 15000, sha: 's7' },
    // 体积不可用
    { type: 'blob', path: '空文件.js', size: 0, sha: 's8' },
    { type: 'blob', path: '巨无霸.js', size: 3 * 1024 * 1024, sha: 's9' },
    // 老规则继续生效
    { type: 'blob', path: 'node_modules/x/a.js', size: 3000, sha: 's10' },
    { type: 'blob', path: 'webpack.config.js', size: 3000, sha: 's11' },
    // 非 js 不算
    { type: 'blob', path: 'readme.md', size: 3000, sha: 's12' }
  ] }
  const r = extractCandidates(tree, 400)
  const kept = r.items.map(x => x.path)
  eq('保留 4 条真候选', kept.length, 4)
  ok('保留的是音源/打包目录，不是客户端源码', kept.join('|') === '音源/聚合API.js|lx-source.js|src/plugins/mysource.js|dist/打包音源.js', kept.join('|'))
  eq('按路径拦掉 3 条客户端源码', r.filtered.path, 3)
  eq('按体积拦掉 2 条（空 + 超限）', r.filtered.size, 2)
  ok('候选带 sha 与体积（下游增量判重、列表先显示大小）',
    r.items.every(x => x.sha && x.size > 0) && r.items[1].size === 30000)

  // 没有 size 字段（老接口/测试桩）不能被一刀切掉
  const noSize = extractCandidates({ tree: [{ type: 'blob', path: 'x/音源.js', sha: 'q' }] }, 10)
  eq('缺 size 的候选照常保留', noSize.items.length, 1)

  // 上限仍然生效
  const many = { tree: Array.from({ length: 30 }, (_, i) => ({ type: 'blob', path: 'p' + i + '.js', size: 5000, sha: 'k' + i })) }
  eq('maxPerRepo 上限仍然生效', extractCandidates(many, 10).items.length, 10)

  const crawlSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'crawler.js'), 'utf8')
  ok('预过滤数量写进爬取日志（可见、可审计）', /预过滤 \$\{cand\.filtered\.path \+ cand\.filtered\.size\} 个非音源候选/.test(crawlSrc))
}

console.log('=== C. 替换上传的重试间隔（纯策略） ===')
{
  eq('首撞名等 200ms', replaceRetryDelay(0, 0), 200)
  eq('第二次 300ms', replaceRetryDelay(1, 200), 300)
  eq('第三次 450ms', replaceRetryDelay(2, 500), 450)
  eq('上限封顶 800ms', replaceRetryDelay(9, 100), 800)
  eq('超预算返回 null（交给改名兜底）', replaceRetryDelay(0, REPLACE_UPLOAD_POLL_MS), null)
  eq('预算可注入（单测/现场调参）', replaceRetryDelay(1, 100, { budgetMs: 400, baseMs: 100 }), 150)
  ok('总预算默认 3 秒量级（不是旧的 2.5s×N 硬等）', REPLACE_UPLOAD_POLL_MS === 3000, String(REPLACE_UPLOAD_POLL_MS))
}

console.log('=== D. 删旧后上传：轮询而不是固定硬等 ===')
let pending = Promise.resolve()
{
  const h = mkHunter()
  const mkSvc = (uploadImpl) => ({
    acct: { id: 'acc1', name: 'demo', url: 'http://srv' }, type: 'lxserver',
    adapter: {
      baseUrl: () => 'http://srv',
      remove: async () => ({ success: true }),
      upload: uploadImpl,
      importUrl: async () => ({ success: false, message: 'no' })
    }
  })

  pending = (async () => {
    // ① 前两次撞名、第三次成功 → 应重试而不是直接改名；总耗时远小于旧的 2500ms
    let calls = 0
    const t0 = Date.now()
    const svc1 = mkSvc(async () => {
      calls++
      if (calls < 3) return { success: false, message: '已存在同名音源' }
      return { success: true, id: 'new1', name: '源A v2', platforms: ['kw'] }
    })
    const e1 = mkEntry({ id: 'r1', name: '源A v2.0.0', ver: 'v2.0.0' })
    const p1 = { svc: svc1, label: 'demo', serverIds: new Set(['old1']), serverByName: {}, usedRename: new Set() }
    const item1 = { e: e1, replaceServer: { id: 'old1', name: '源A v1.0.0' }, baseName: '源A v2.0.0', why: '' }
    const res1 = await h._runImportItem(p1, item1, { r1: e1.code }, false)
    const cost1 = Date.now() - t0
    eq('撞名两次后上传成功，共试 3 次', calls, 3)
    eq('结果仍是 replaced', res1.status, 'replaced')
    ok('总耗时 < 1500ms（旧实现光等待就 2500ms）', cost1 < 1500, cost1 + 'ms')

    // ② 非「已存在」错误不重试（重试没意义，还拖慢批量）
    let calls2 = 0
    const svc2 = mkSvc(async () => { calls2++; return { success: false, message: 'HTTP 500 服务器错误' } })
    const e2 = mkEntry({ id: 'r2', name: '源B v2.0.0', ver: 'v2.0.0' })
    const p2 = { svc: svc2, label: 'demo', serverIds: new Set(['old2']), serverByName: {}, usedRename: new Set() }
    const item2 = { e: e2, replaceServer: { id: 'old2', name: '源B v1.0.0' }, baseName: '源B v2.0.0', why: '' }
    await h._runImportItem(p2, item2, { r2: e2.code }, false)
    eq('非撞名错误只试 1 次', calls2, 1)

    // ③ 预算耗尽 → 返回最后一次失败，调用方据此退化为改名上传（这里直接测 helper 行为）
    let calls3 = 0
    const svc3 = mkSvc(async () => { calls3++; return { success: false, message: '已存在同名音源' } })
    const r3 = await h._uploadAfterReplace(svc3, '// code', '源C', { budgetMs: 300, baseMs: 50, maxMs: 120 })
    ok('预算内反复撞名 → 返回失败（不无限重试）', r3 && r3.success === false)
    ok('重试次数有界（预算 300ms 内 ≤ 6 次）', calls3 >= 2 && calls3 <= 6, String(calls3))
  })()
}

pending.then(() => {
  console.log('\nRESULT ' + pass + ' PASS / ' + fail + ' FAIL')
  process.exit(fail ? 1 : 0)
}).catch((err) => {
  console.error('UNCAUGHT', err && err.stack || err)
  process.exit(1)
})
