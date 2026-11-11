'use strict'
/**
 * 定时爬取的「下一次什么时候跑」（v1.13.0）
 *
 * 修的问题：水位 `lastCrawl` 只在**成功**路径写，异常被 catch 吞掉 → 判据
 * `now - lastCrawl >= 24h` 永远成立 → 60 秒后定时器又跑一遍。爬取一挂就变成每分钟重跑，
 * 刷爆 GitHub 配额、刷屏日志（巡检侧早就有 lastAttempt + 退避，爬取一直没跟上）。
 *
 * 为什么不用「失败就退避 30 分钟」这种拍脑袋规则
 * ----------------------------------------------
 * 这里的失败有明确分层，优先级从高到低：
 *  1. **配额耗尽**：GitHub 会给 reset 时间，等到那个点最准（既不浪费配额也不瞎等）；
 *  2. **代理/镜像可用**：说明网络链路是通的，失败更可能是瞬时抖动/单仓库异常 ——
 *     用户口径是「镜像/代理已经能兜底」，那就先短重试（2 分钟）一次，不退避；
 *  3. **代理/镜像也不可用**：这才是真断网，指数退避 5→15→30→60 分钟封顶；
 *  4. 成功（含**部分成功**）= 正常节奏，按 crawlIntervalHours 推进。
 *
 * 纯函数：不读时间、不碰网络，全部入参由调用方给，方便单测。
 */

/** 网络真不通时的退避阶梯（分钟） */
const BACKOFF_MIN = [5, 15, 30, 60]
/** 代理/镜像健康时的短重试间隔（毫秒） */
const RETRY_SOON_MS = 2 * 60 * 1000
/** 配额重置后多等一点，避免刚好撞在边界上 */
const QUOTA_PAD_MS = 60 * 1000

/**
 * @param {object} p
 * @param {number} p.now                当前时间
 * @param {number} p.intervalHours      设置里的爬取间隔（小时）
 * @param {number} p.lastCrawl          上次**成功**完成时间（0 = 从没成功过）
 * @param {object|null} p.lastResult    {ok, attempts, error} 上一轮结果
 * @param {object|null} p.quota         checkQuota 结果 {ok:false, resetMin} 表示配额耗尽
 * @param {boolean} [p.proxyHealthy]    代理/镜像是否可用（getProxyHealth 的 cooldownRemainingMs===0）
 * @returns {{dueAt:number, kind:string, reason:string, delayMin:number}}
 */
function planNextCrawl(p) {
  const now = Number(p.now) || Date.now()
  const hours = Math.max(1, Number(p.intervalHours) || 24)
  const intervalMs = hours * 3600 * 1000
  const lastCrawl = Number(p.lastCrawl) || 0
  const lastResult = p.lastResult || null

  // ① 成功 / 从没跑过 → 正常节奏（从没成功过时 lastCrawl=0，dueAt 在过去，等于立刻可跑）
  if (!lastResult || lastResult.ok) {
    const dueAt = lastCrawl + intervalMs
    return {
      dueAt,
      kind: 'normal',
      delayMin: Math.max(0, Math.round((dueAt - now) / 60000)),
      reason: lastResult ? '上轮成功，按间隔推进' : '没有上轮记录，按间隔推进'
    }
  }

  // ② 配额耗尽：GitHub 给了准确的 reset 时间，按它算，最省也最准
  if (p.quota && p.quota.ok === false) {
    const mins = Math.max(1, Number(p.quota.resetMin) || 60)
    const dueAt = now + mins * 60000 + QUOTA_PAD_MS
    return {
      dueAt,
      kind: 'quota',
      delayMin: Math.round((dueAt - now) / 60000),
      reason: `GitHub API 配额耗尽（剩余 ${p.quota.remaining}），等配额重置`
    }
  }

  // ③ 网络类失败但代理/镜像健康 → 短重试一次，把这层兜底用起来
  if (p.proxyHealthy) {
    return {
      dueAt: now + RETRY_SOON_MS,
      kind: 'retry',
      delayMin: 2,
      reason: '代理/镜像可用，稍后短重试一次（不退避）'
    }
  }

  // ④ 链路确实不通 → 指数退避，封顶 60 分钟
  const attempts = Math.max(1, Number(lastResult.attempts) || 1)
  const mins = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)]
  return {
    dueAt: now + mins * 60000,
    kind: 'backoff',
    delayMin: mins,
    reason: `连续失败第 ${attempts} 次且代理/镜像不可用，退避 ${mins} 分钟`
  }
}

/** 人话：下次爬取时间（日志/面板共用） */
function describeNextCrawl(plan) {
  if (!plan) return ''
  if (plan.kind === 'normal') return plan.delayMin > 0 ? `${plan.delayMin} 分钟后` : '已到期'
  return `${plan.delayMin} 分钟后（${plan.reason}）`
}

module.exports = { planNextCrawl, describeNextCrawl, BACKOFF_MIN, RETRY_SOON_MS }
