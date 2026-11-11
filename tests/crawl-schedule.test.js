'use strict'
/**
 * v1.13.0：定时爬取的「下一次什么时候跑」
 *
 * 修的 bug：`lastCrawl` 只在成功路径写，异常被 catch 吞掉 → 定时器判据 `now-lastCrawl>=24h`
 * 永远成立 → 爬取一挂就每分钟重跑一次（刷爆 GitHub 配额 + 刷屏日志）。
 *
 * 用户口径（2026-11-11）：「镜像、代理很大程度已经能兜底，退避只能作为补充，但一定要科学」。
 * 所以优先级是：配额（有准确 reset 时间）> 代理/镜像可用（短重试）> 真不通（指数退避）。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { planNextCrawl, describeNextCrawl } = require('../src/core/crawlSchedule')
const { Hunter } = require('../src/core/hunter')
const { Store } = require('../src/core/store')

let pass = 0
function ok(name) { pass++; console.log('  ✓ ' + name) }
const MIN = 60 * 1000
const HOUR = 60 * MIN

console.log('== 纯函数 planNextCrawl ==')
{
  const now = 1794400000000
  // 从没跑过 → dueAt 在过去，等于立刻可跑（保持升级前的首跑行为）
  const p0 = planNextCrawl({ now, intervalHours: 24, lastCrawl: 0, lastResult: null })
  assert.strictEqual(p0.kind, 'normal')
  assert.ok(p0.dueAt < now)
  ok('没有上轮记录 → 立刻可跑（不改变首跑语义）')

  const p1 = planNextCrawl({ now, intervalHours: 24, lastCrawl: now - HOUR, lastResult: { ok: true } })
  assert.strictEqual(p1.dueAt, now - HOUR + 24 * HOUR)
  ok('上一轮成功 → 按间隔推进（lastCrawl + 24h）')

  // 配额耗尽优先于其他判据：GitHub 给的 reset 最准
  const p2 = planNextCrawl({
    now, intervalHours: 24, lastCrawl: now - 30 * HOUR,
    lastResult: { ok: false, attempts: 3 }, quota: { ok: false, remaining: 0, resetMin: 42 }, proxyHealthy: true
  })
  assert.strictEqual(p2.kind, 'quota')
  assert.strictEqual(p2.dueAt, now + 42 * MIN + MIN)
  ok('配额耗尽 → 按 reset 精确退避（优先于代理/指数）')

  // 代理/镜像健康 → 短重试，不退避（用户要求"兜底优先"）
  const p3 = planNextCrawl({ now, intervalHours: 24, lastCrawl: now - 30 * HOUR, lastResult: { ok: false, attempts: 5 }, quota: { ok: true }, proxyHealthy: true })
  assert.strictEqual(p3.kind, 'retry')
  assert.strictEqual(p3.dueAt, now + 2 * MIN)
  ok('失败但代理/镜像可用 → 2 分钟后短重试（不退避）')

  // 链路确实不通 → 指数退避，封顶 60 分钟
  const steps = [1, 2, 3, 4, 9].map(a => planNextCrawl({
    now, intervalHours: 24, lastCrawl: 0, lastResult: { ok: false, attempts: a }, quota: { ok: true }, proxyHealthy: false
  }))
  assert.deepStrictEqual(steps.map(x => x.delayMin), [5, 15, 30, 60, 60])
  assert.ok(steps.every(x => x.dueAt > now))
  ok('代理也不可用 → 5/15/30/60 分钟指数退避（封顶 60）')

  assert.ok(/分钟后/.test(describeNextCrawl(p3)))
  assert.strictEqual(describeNextCrawl({ kind: 'normal', delayMin: 0 }), '已到期')
  ok('人话文案（日志/面板共用）')
}

console.log('\n== hunter._finishCrawlSchedule 落库 ==')
function mkStore() { return new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-crawl-'))) }
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

async function main() {
  {
    const s = mkStore()
    s.saveConfig({ crawlIntervalHours: 24 })
    s.db.lastCrawl = Date.now() - 3600 * 1000
    const h = mkHunter(s)
    await h._finishCrawlSchedule(null)
    assert.strictEqual(s.db.crawlLastResult.ok, true)
    assert.strictEqual(s.db.crawlNextAt, s.db.lastCrawl + 24 * 3600 * 1000)
    ok('成功收尾：crawlNextAt = lastCrawl + 间隔，并清掉失败态')
  }

  {
    const s = mkStore()
    s.saveConfig({ crawlIntervalHours: 24 })
    s.db.lastCrawl = Date.now() - 30 * 3600 * 1000   // 上次成功是 30 小时前
    s.db.crawlLastResult = { ok: false, attempts: 1 }
    const h = mkHunter(s)
    h.quotaProbe = async () => ({ ok: false, remaining: 0, resetMin: 30 })
    await h._finishCrawlSchedule(new Error('HTTP 403 rate limit'))
    assert.strictEqual(s.db.crawlLastResult.attempts, 2, '连续失败次数累加')
    assert.ok(s.db.crawlNextAt > Date.now() + 25 * 60 * 1000, '按配额 reset 退避，不是 60 秒后再跑')
    ok('失败收尾：写 crawlLastAttempt/crawlNextAt，失败不再「每分钟重跑」')
  }

  {
    const s = mkStore()
    s.saveConfig({ crawlIntervalHours: 24 })
    s.db.crawlLastResult = { ok: false, attempts: 9 }
    const h = mkHunter(s)
    h.quotaProbe = async () => ({ ok: true, remaining: 4000 })
    // 代理健康度读不到 → 按可用处理（宁可早重试）
    await h._finishCrawlSchedule(new Error('boom'))
    assert.ok(s.db.crawlNextAt - Date.now() <= 3 * 60 * 1000)
    ok('代理健康度未知时按「可用」短重试（保守不拖延）')
  }

  console.log(`\n全部通过（${pass} 项）`)
}

main().catch(e => { console.error(e); process.exit(1) })
