'use strict'
/**
 * v1.9.0：定时爬取后的自动灌入（runAutoPipeline）+ 定时任务的配置与语义
 *
 * 这块最容易做错、也最容易被用户看出来的四点：
 *  1) 「该检测谁」不能拿整库去测 —— 每轮定时任务只该碰「本次新增 / 内容变化 / 从没测过」的条目，
 *     否则一轮下来把几百条老源全部重测一遍，用户会以为是 bug。
 *  2) 「该灌谁」要与手动「检测并灌入」口径一致：目标账号 = 勾了「参与批量灌入」的账号，
 *     一个都没勾时回退当前选中账号。自动任务不该另有一套目标规则。
 *  3) 已灌好的不能每轮重复走一遍裁决（粗筛），但「只灌过其中一个目标账号」的必须能进候选补灌。
 *  4) 「每分钟检查是否到期」只是轮询节奏，执行频率由间隔决定 —— 桌面版与 Web 版必须同款。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Hunter, formatIntervalHours } = require('../src/core/hunter')
const { Store } = require('../src/core/store')

let pass = 0
function ok(name) { pass++; console.log('  ✓ ' + name) }

function src(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8') }

/** 临时目录里的真 Store（配置/账本都走真实读写路径） */
function mkStore(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-auto-'))
  const store = new Store(dir)
  if (config) store.saveConfig(config)
  return store
}

/** 只借用原型方法的 Hunter（不装配真实网络层），日志全部静音 */
function mkHunter(store) {
  const h = Object.create(Hunter.prototype)
  h.store = store
  h.job = { running: false, cancel: false }
  h.emit = () => {}
  h.log = () => {}
  h.step = () => {}
  h.progress = () => {}
  return h
}

const P1 = { id: 'p1', type: 'lxserver', name: '主账号', url: 'http://a', enabled: true, batchImport: true }
const P2 = { id: 'p2', type: 'songloft', name: '副账号', url: 'http://b', enabled: true, batchImport: true }

// ---------------- 配置与语义 ----------------
console.log('\n== 配置与语义 ==')
{
  const s = mkStore()
  assert.strictEqual(s.config.crawlAutoImport, false, '默认关闭自动灌入')
  assert.strictEqual(s.config.crawlScheduleEnabled, false, '默认关闭定时爬取')
  ok('新配置项 crawlAutoImport 默认关闭（升级后行为不变）')

  assert.strictEqual(formatIntervalHours(48), '2 天（48 小时）')
  assert.strictEqual(formatIntervalHours(24), '1 天（24 小时）')
  assert.strictEqual(formatIntervalHours(12), '12 小时')
  assert.strictEqual(formatIntervalHours(0), '1 小时', '非法值兜底为 1 小时，不出现「0 小时」')
  ok('间隔小时数格式化成人话（48 → 2 天（48 小时））')

  // 「同名自动替换」只是同名裁决第 7 条的兜底，必须仍是默认开
  assert.strictEqual(s.config.replaceSameNameOnImport, true)
  ok('replaceSameNameOnImport 仍是默认开（兜底语义不变）')
}

// ---------------- 粗筛：_importedEverywhere ----------------
console.log('\n== 自动灌入候选粗筛 _importedEverywhere ==')
{
  const s = mkStore()
  const h = mkHunter(s)
  assert.strictEqual(h._importedEverywhere('x', ['p1'], 'p1'), false, '没记录 → 不是「哪儿都灌过」')
  ok('没有灌入记录 → 进候选')

  s.imported.x = { lxId: 'srv1', name: 'X', contentHash: 'h', platformId: 'p1', importedTo: [{ platformId: 'p1', lxId: 'srv1' }] }
  assert.strictEqual(h._importedEverywhere('x', ['p1'], 'p1'), true)
  assert.strictEqual(h._importedEverywhere('x', ['p1', 'p2'], 'p1'), false, '只灌过 p1 → 对 p1+p2 不算灌完')
  assert.strictEqual(h._importedEverywhere('x', [], 'p1'), false, '没有目标账号时不做判断（交给灌入阶段报错）')
  ok('只灌过其中一个目标账号 → 仍进候选（补灌到缺的那个）')

  s.imported.y = { lxId: 'srv2', name: 'Y', contentHash: 'h2', importedTo: [{ platformId: 'p1' }, { platformId: 'p2' }] }
  assert.strictEqual(h._importedEverywhere('y', ['p1', 'p2'], 'p1'), true)
  ok('两个目标账号都有 → 不进候选（避免每轮都走一遍裁决）')

  // v1.8.0 之前的老记录没有 platformId → 归当前选中账号
  s.imported.z = { lxId: 'srv3', name: 'Z', contentHash: 'h3' }
  assert.strictEqual(h._importedEverywhere('z', ['p1'], 'p1'), true, '老记录归当前选中账号')
  assert.strictEqual(h._importedEverywhere('z', ['p1'], 'p2'), false, '当前选中换成 p2 时老记录不算数')
  ok('老记录（无 platformId）按当前选中账号归属')
}

// ---------------- 全链路：爬取 → 检测 → 灌入 ----------------
console.log('\n== runAutoPipeline 全链路 ==')

async function pipelineCase() {
  const s = mkStore({ platforms: [P1, P2], activePlatformId: 'p1', crawlAutoImport: true, crawlScheduleEnabled: true, crawlIntervalHours: 48 })
  // 库里一条「老源」：已检测、p1 与 p2 都已灌（干净快照，爬取不该动它，也不该再进灌入候选）
  s.db.sources.old1 = {
    id: 'old1', name: '老源', url: 'http://x/old.js', usable: true, contentHash: 'h-old',
    lxName: '老源', deep: { checkedAt: 1000, platforms: { kw: { status: 'usable' } } }
  }
  s.imported.old1 = {
    lxId: 'srv-old', name: '老源', contentHash: 'h-old', platformId: 'p1', importedAt: 1,
    importedTo: [{ platformId: 'p1', lxId: 'srv-old' }, { platformId: 'p2', lxId: 'srv-old-p2' }]
  }
  // 库里一条「半灌源」：p1 灌过、p2 没灌过 → 目标含 p2 时应补灌
  s.db.sources.half = {
    id: 'half', name: '半灌源', url: 'http://x/half.js', usable: true, contentHash: 'h-half',
    lxName: '半灌源', deep: { checkedAt: 1000, platforms: { kw: { status: 'usable' } } }
  }
  s.imported.half = { lxId: 'srv-half', name: '半灌源', contentHash: 'h-half', platformId: 'p1', importedTo: [{ platformId: 'p1', lxId: 'srv-half' }], importedAt: 1 }

  const h = mkHunter(s)
  const calls = []
  h.runCrawl = async (opts) => {
    calls.push({ what: 'crawl', opts: opts || null })
    // 模拟增量爬取的结果：新入库一条
    s.db.sources.new1 = { id: 'new1', name: '新源', url: 'http://x/new.js', contentHash: 'h-new', lxName: '新源' }
    return { added: 1, updated: 0, skipped: 5 }
  }
  h.runCheck = async (ids) => {
    calls.push({ what: 'check', ids: ids.slice() })
    s.db.sources.new1.usable = true
    s.db.sources.new1.deep = { checkedAt: 2000, platforms: { kw: { status: 'usable' } } }
    return { usable: 1, total: ids.length }
  }
  h.runImport = async (ids) => {
    calls.push({ what: 'import', ids: ids.slice() })
    return { results: [{ status: 'success' }], ok: 1, replaced: 0, synced: 0, skipped: 0 }
  }

  const out = await h.runAutoPipeline()
  assert.deepStrictEqual(calls.map(c => c.what), ['crawl', 'check', 'import'], '三步必须按顺序跑')
  ok('三步顺序：增量爬取 → 检测 → 灌入')

  assert.strictEqual(calls[0].opts && calls[0].opts.incremental, true, '定时爬取必须走增量模式')
  ok('爬取用增量模式（只收新音源，已抓的按指纹跳过）')

  assert.deepStrictEqual(calls[1].ids, ['new1'], '只检测本次新增/变化/从没测过的条目')
  ok('检测只覆盖新增条目，不重测整库（老源已检测且未变 → 不重测）')

  assert.deepStrictEqual(calls[2].ids.sort(), ['half', 'new1'], '新源 + 只灌过 p1 的半灌源（目标是 p1+p2）')
  ok('灌入候选 = 新源 + 只灌过部分目标账号的（补灌），已全灌好的不进候选')

  assert.deepStrictEqual(out.crawl, { added: 1, updated: 0, skipped: 5 })
  assert.strictEqual(out.detect.total, 1)
  assert.strictEqual(out.import.ok, 1)
  ok('返回值带回三步各自的结果，便于定时器记录')

  assert.strictEqual(s.db.sources.old1.stale, undefined, '老源未被无谓改动')
  ok('未新增/未变化的条目不被触碰')
}

// ---------------- 空转场景：不该白跑检测与灌入 ----------------
console.log('\n== runAutoPipeline 空转与异常 ==')
async function edgeCases() {
  // ① 本次爬取没有任何新增/变化（库里也没有从未检测过的）
  {
    const s = mkStore({ platforms: [P1], activePlatformId: 'p1', crawlAutoImport: true })
    s.db.sources.old1 = { id: 'old1', name: '老源', url: 'http://x/o.js', usable: true, contentHash: 'h1', deep: { checkedAt: 1 } }
    const h = mkHunter(s)
    let checked = 0, imported = 0
    h.runCrawl = async () => ({ added: 0, updated: 0, skipped: 3 })
    h.runCheck = async () => { checked++; return {} }
    h.runImport = async () => { imported++; return {} }
    const out = await h.runAutoPipeline()
    assert.strictEqual(out.skipped, 'no-new-sources')
    assert.strictEqual(checked, 0, '没有新条目就不该跑检测（省时间也省服务端）')
    assert.strictEqual(imported, 0)
    ok('没有新增/变化 → 直接收工，不跑检测也不跑灌入')
  }

  // ② 有新条目但检测后没有可灌入的
  {
    const s = mkStore({ platforms: [P1], activePlatformId: 'p1', crawlAutoImport: true })
    const h = mkHunter(s)
    let imported = 0
    h.runCrawl = async () => { s.db.sources.n1 = { id: 'n1', name: '坏源', url: 'http://x/n.js', contentHash: 'hn' }; return { added: 1 } }
    h.runCheck = async () => { s.db.sources.n1.usable = false; s.db.sources.n1.deep = { checkedAt: 5 }; return { usable: 0, total: 1 } }
    h.runImport = async () => { imported++; return {} }
    const out = await h.runAutoPipeline()
    assert.strictEqual(out.skipped, 'nothing-to-import')
    assert.strictEqual(imported, 0, '检测不通过的源不该进灌入')
    ok('新源检测不通过 → 不调用灌入')
  }

  // ③ 已有任务在跑 → 直接抛错，不叠任务
  {
    const s = mkStore({ platforms: [P1], activePlatformId: 'p1', crawlAutoImport: true })
    const h = mkHunter(s)
    h.job.running = true
    let threw = false
    try { await h.runAutoPipeline() } catch (e) { threw = /已有任务/.test(e.message) }
    assert.ok(threw)
    ok('已有任务运行时拒绝叠加（定时器不会把同一时刻点成两个任务）')
  }

  // ④ 检测中途抛错：不能把任务锁卡死，否则紧随其后的灌入会被自己挡住
  {
    const s = mkStore({ platforms: [P1], activePlatformId: 'p1', crawlAutoImport: true })
    const h = mkHunter(s)
    let imported = 0
    h.runCrawl = async () => { s.db.sources.n2 = { id: 'n2', name: '新源2', url: 'http://x/n2.js', usable: true, contentHash: 'hn2' }; return { added: 1 } }
    h.runCheck = async () => { h.job.running = true; throw new Error('沙箱炸了') }
    h.runImport = async (ids) => { imported++; return { results: ids.map(() => ({ status: 'success' })), ok: ids.length, skipped: 0 } }
    const out = await h.runAutoPipeline()
    assert.strictEqual(imported, 1, '检测失败不应连累灌入')
    assert.ok(out.import, '检测失败后仍继续灌入')
    ok('检测抛错不中断整体（且会放开任务锁），已可用的音源照样灌')
  }
}

// ---------------- 定时器接线：桌面版与 Web 版同款 ----------------
console.log('\n== 定时器接线 ==')
{
  const mainSrc = src('src/main/index.js')
  const webSrc = src('src/server/web.js')
  assert.ok(/cfg\.crawlAutoImport/.test(mainSrc), '桌面版定时器要读 crawlAutoImport')
  assert.ok(/runAutoPipeline\(\)/.test(mainSrc), '桌面版要调 runAutoPipeline')
  assert.ok(/cfg\.crawlAutoImport/.test(webSrc), 'Web 版定时器要读 crawlAutoImport')
  assert.ok(/runAutoPipeline\(\)/.test(webSrc), 'Web 版要调 runAutoPipeline')
  ok('桌面版 + Web/Docker 版都按 crawlAutoImport 分流到 runAutoPipeline')

  // 两边的到期判据必须仍是「距上次执行 ≥ 间隔」，而不是「每分钟跑一次」
  for (const [label, s] of [['桌面版', mainSrc], ['Web 版', webSrc]]) {
    assert.ok(/Date\.now\(\) - last >= hours \* 3600 \* 1000/.test(s), label + ' 到期判据必须是间隔比较')
    assert.ok(/Date\.now\(\) - last < hours \* 3600 \* 1000/.test(s), label + ' 未到期要直接 return')
  }
  ok('两处都是「每分钟核对一次、够了间隔才跑」（间隔 ≠ 轮询节奏）')
}

// ---------------- 设置页接线：开关位置与文案 ----------------
console.log('\n== 设置页接线 ==')
{
  const html = src('src/renderer/index.html')
  const app = src('src/renderer/app.js')

  assert.ok(/id="cfgCrawlAutoImport"/.test(html), '要有自动灌入开关')
  assert.ok(/cfgCrawlAutoImport/.test(app), 'app.js 要读写该开关')
  assert.ok(/crawlAutoImport: \$\('cfgCrawlAutoImport'\)\.checked/.test(app), '保存时要落盘')
  ok('「爬取结束后自动灌入」开关已接线（读取 / 保存）')

  // 关键：灌入规则必须从「定时爬取」卡片里搬出来，放进独立的「灌入规则」卡片
  const iRules = html.indexOf('灌入规则（同名音源怎么处理）')
  const iReplace = html.indexOf('id="cfgReplaceSame"')
  const iCrawlCard = html.indexOf('定时爬取（增量发现新音源）')
  const iPatrolCard = html.indexOf('健康巡检（已灌入音源定期重测）')
  assert.ok(iRules >= 0, '要有「灌入规则」卡片')
  assert.ok(iReplace > iRules, '同名替换开关要在「灌入规则」卡片里')
  assert.ok(iReplace < iCrawlCard, '同名替换开关不该再留在「定时爬取」卡片里')
  assert.ok(iRules < iCrawlCard, '「灌入规则」卡片排在定时爬取之前')
  assert.ok(iRules < iPatrolCard, '「灌入规则」卡片紧跟爬取设置之后、在健康巡检之前')
  ok('「同名自动替换」已从定时爬取卡片搬进独立的「灌入规则」卡片')

  // 原来散在爬取卡片里的两个灌入开关也一并收进「灌入规则」
  for (const id of ['cfgEnableAfter', 'cfgSkipUnusable']) {
    const i = html.indexOf('id="' + id + '"')
    assert.ok(i > iRules && i < iCrawlCard, id + ' 应归入「灌入规则」卡片')
  }
  ok('灌入后自动启用 / 跳过未通过 也归入「灌入规则」，灌入相关的不再散着放')

  // 文案：得把「每分钟 vs 间隔」和「这个开关只管第 7 条」说清楚
  assert.ok(/每分钟/.test(html) && /总开关/.test(html), '要说明「每分钟只是核对节奏」')
  assert.ok(/只在第 7 条生效|只在第 7 条/.test(html), '要说明同名替换开关只管兜底那条')
  assert.ok(/<ol class="rules">/.test(html), '要把 7 条同名裁决顺序印在界面上')
  ok('文案把「每分钟检查是否到期」与「48 小时间隔」的关系讲清（不矛盾）')

  // 「参与批量灌入」的说明要提到自动灌入也用它
  assert.ok(/自动灌入/.test(html.slice(html.indexOf('id="accBatch"'), html.indexOf('id="accBatch"') + 400)))
  ok('账号的「参与批量灌入」说明已覆盖定时自动灌入')
}

// 异步用例最后跑，跑完再汇总，否则计数会漏掉异步里那些 ok()
pipelineCase()
  .then(() => edgeCases())
  .then(() => console.log('\n=== auto-pipeline 测试通过：' + pass + ' 项 ==='))
  .catch(e => { console.error('\n[FAIL] ' + ((e && e.stack) || e)); process.exit(1) })
