'use strict'
/**
 * v1.10.2 定时巡检「失败不推进水位」修复契约。
 *
 * 背景（2026-11-06 用户实测，246 日志截图）：用户把巡检间隔设成 24 小时，
 * 但推送服务端关闭后，日志每 60 秒就出现一对
 *   「定时巡检到期（间隔 1 天（24 小时））」+「定时巡检失败：… fetch failed」。
 * 根因：runPatrol 第一步读服务端音源列表就抛错，而 patrol.lastRun 只在
 * **成功收尾**才写；调度器每分钟拿这个永不前进的 lastRun 判「到期」，于是真跑 1440 次/天。
 *
 * 修复：调度水位改取 max(lastAttempt, lastRun)，触发前就写 lastAttempt；
 * 上一轮失败写 lastError 并按 patrolRetryMinutes（默认 15）退避，日志写明下次重试。
 *
 * 五层验证：① 纯函数边界；② 24 小时窗口模拟 + 旧实现反向对照；
 * ③ 双端源码与收尾合并契约；④ 设置项接线 + 启动日志端口文案；
 * ⑤ 服务端离线时的可读性（统计卡角标 / tooltip / 本地快照说明）。
 *
 * 同一批还回答用户的第二个疑问：断线后音源库里「来源仓库 = (服务端)」的占位条目
 * 与「已灌入」统计仍显示，属于本地快照 + 刻意保护（断线不清库），不是 bug；
 * 但离线时要给出可见提示，避免误读成服务端实时状态。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { patrolSchedule, formatIntervalHours } = require('../src/core/hunter')
const { DEFAULT_CONFIG } = require('../src/core/store')

const root = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8')
const hunt = read('src/core/hunter.js')
const storeSrc = read('src/core/store.js')
const main = read('src/main/index.js')
const web = read('src/server/web.js')
const html = read('src/renderer/index.html')
const app = read('src/renderer/app.js')
const css = read('src/renderer/styles.css')

let pass = 0
const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log('  PASS', label) }

const H = 3600 * 1000
const M = 60 * 1000
const T0 = 1700000000000
const cfg = { patrolIntervalHours: 24, patrolRetryMinutes: 15 }

console.log('--- ① patrolSchedule 边界 ---')
ok(typeof patrolSchedule === 'function', '纯函数已从 hunter.js 导出')
ok(formatIntervalHours(24) === '1 天（24 小时）', '间隔文案与用户截图一致')
ok(patrolSchedule(cfg, { lastRun: 0 }, T0).due === true, '首次启动（无记录）立即到期')
ok(patrolSchedule(cfg, { lastRun: T0 - M, lastAttempt: T0 - M }, T0).due === false,
  '刚触发完 1 分钟：不到期（主间隔 24 小时）')
ok(patrolSchedule(cfg, { lastRun: T0 - 24 * H, lastAttempt: T0 - 24 * H }, T0).dueByInterval === true,
  '成功轮满 24 小时：按主间隔到期')
ok(patrolSchedule(cfg, { lastRun: T0 - 24 * H, lastAttempt: T0 - M, lastError: 'fetch failed' }, T0).due === false,
  '失败轮 +1 分钟：不再每分钟重试（核心修复）')
ok(patrolSchedule(cfg, { lastRun: T0 - 24 * H, lastAttempt: T0 - 14 * M, lastError: 'fetch failed' }, T0).due === false,
  '失败轮 +14 分钟：仍不到期')
ok(patrolSchedule(cfg, { lastRun: T0 - 24 * H, lastAttempt: T0 - 15 * M, lastError: 'fetch failed' }, T0).dueByRetry === true,
  '失败轮 +15 分钟：按退避间隔重试')
ok(patrolSchedule(cfg, { lastRun: T0 - 15 * M, lastAttempt: T0 - 15 * M }, T0).due === false,
  '成功轮 +15 分钟不受退避影响（lastError 已清空）')
ok(patrolSchedule(cfg, { lastAttempt: T0 - 10 * M, lastRun: T0 - M }, T0).last === T0 - M,
  '水位取 max(lastAttempt, lastRun)：手动巡检成功也算「刚跑过」')
ok(patrolSchedule({ patrolIntervalHours: 24 }, { lastError: 'x', lastAttempt: T0 - M }, T0).retryMinutes === 15,
  '配置缺失时退避默认 15 分钟')
ok(patrolSchedule({ patrolIntervalHours: 24, patrolRetryMinutes: 0 }, { lastError: 'x' }, T0).retryMinutes === 15,
  '退避值 0 视为未配置，回退默认 15 分钟')
ok(patrolSchedule({ patrolIntervalHours: 24, patrolRetryMinutes: -5 }, { lastError: 'x' }, T0).retryMinutes === 1,
  '负数退避值收敛到下限 1 分钟')
ok(patrolSchedule({ patrolIntervalHours: 24, patrolRetryMinutes: 99999 }, { lastError: 'x' }, T0).retryMinutes === 1440,
  '退避值上限 1440 分钟')
ok(patrolSchedule({ patrolIntervalHours: 1, patrolRetryMinutes: 1440 }, { lastError: 'x', lastAttempt: T0 - 30 * M }, T0).gapMs === H,
  '退避间隔不超过主间隔（设 1 小时时不被 1440 分钟放大）')
ok(patrolSchedule({ patrolIntervalHours: 0 }, { lastAttempt: T0 - 2 * H }, T0).hours === 12,
  '巡检间隔 0 视为未配置，回退默认 12 小时')
ok(patrolSchedule({ patrolIntervalHours: -3 }, { lastAttempt: T0 - 2 * H }, T0).hours === 1,
  '巡检间隔负数收敛到下限 1 小时')

console.log('--- ② 24 小时窗口模拟：旧实现必刷屏，新实现按退避 ---')
/** 逐分钟模拟调度器；useNew=false 复刻旧实现「只在成功收尾写 lastRun」 */
function countTriggers(c, useNew, windowMin) {
  let patrol = { lastRun: 0 }
  let triggers = 0
  for (let min = 0; min <= windowMin; min++) {
    const now = T0 + min * M
    let due
    if (useNew) {
      const s = patrolSchedule(c, patrol, now)
      due = s.dueByInterval || s.dueByRetry
      if (due) {
        patrol = Object.assign({}, patrol, { lastAttempt: now, lastError: null })
        patrol = Object.assign({}, patrol, { lastError: 'fetch failed' }) // 模拟整轮失败
      }
    } else {
      const hours = Math.max(1, Number(c.patrolIntervalHours) || 12)
      due = now - (patrol.lastRun || 0) >= hours * H
      // 旧实现：runPatrol 抛错 → 不写 lastRun
    }
    if (due) triggers++
  }
  return triggers
}
const oldCount = countTriggers(cfg, false, 1440)
const newCount = countTriggers(cfg, true, 1440)
const longRetryCount = countTriggers({ patrolIntervalHours: 24, patrolRetryMinutes: 1440 }, true, 1440)
ok(oldCount >= 1400, '反向对照：旧实现 24 小时内每分钟真跑一次（实测 ' + oldCount + ' 次）')
ok(newCount <= 100, '新实现 24 小时内只按 15 分钟退避（实测 ' + newCount + ' 次）')
ok(newCount < oldCount / 10, '失败日志量至少降到旧实现的十分之一')
ok(longRetryCount <= 2, '把重试间隔设成 1440 分钟 ≈ 一天只试一次（实测 ' + longRetryCount + ' 次）')

console.log('--- ③ 双端源码与收尾合并契约 ---')
for (const [label, s] of [['桌面版', main], ['Web/Docker 版', web]]) {
  ok(/patrolSchedule\(/.test(s), label + ' 调度器调用共享纯函数')
  ok(/lastAttempt: Date\.now\(\)/.test(s), label + ' 触发前写 lastAttempt 水位')
  ok(/lastError: msg/.test(s), label + ' 失败时写 lastError 触发退避')
  ok(/sched\.dueByRetry/.test(s), label + ' 失败按退避间隔到期')
  ok(/patrolRetryMinutes|retryMinutes/.test(s), label + ' 日志/配置体现重试间隔')
  ok(/Date\.now\(\) - last >= hours \* 3600 \* 1000/.test(s), label + ' 主判据仍是「距上次执行 ≥ 间隔」')
  ok(/Date\.now\(\) - last < hours \* 3600 \* 1000\) return/.test(s), label + ' 定时爬取未到期仍直接 return（既有契约不破坏）')
  ok(/不会每分钟重复尝试/.test(s), label + ' 失败日志明确告知不会每分钟刷屏')
}
ok(/Object\.assign\(\{\}, this\.store\.db\.patrol, \{/.test(hunt) && /lastAttempt: Date\.now\(\), lastError: null/.test(hunt),
  'runPatrol 成功收尾用合并写法，不会整体覆盖 lastAttempt / lastError')
ok(!/this\.store\.db\.patrol = \{ lastRun: Date\.now\(\), total:/.test(hunt),
  '对照：旧的整体赋值写法已移除')
ok(/module\.exports = \{[^}]*patrolSchedule/.test(hunt), 'patrolSchedule 已导出供双端与测试复用')

console.log('--- ④ 设置项接线与启动日志端口 ---')
ok(DEFAULT_CONFIG.patrolRetryMinutes === 15, '默认配置 patrolRetryMinutes = 15 分钟')
ok(/patrolRetryMinutes: 15/.test(storeSrc), 'store 默认值有注释说明来由')
ok(/id="cfgPatrolRetryMinutes"/.test(html), '设置页有「失败后的重试间隔（分钟）」输入项')
ok(/cfgPatrolRetryMinutes.*min="1" max="1440"/.test(html), '输入范围 1–1440 分钟')
ok(/\$\('cfgPatrolRetryMinutes'\)\.value = c\.patrolRetryMinutes \|\| 15/.test(app), 'app.js 读取该配置')
ok(/patrolRetryMinutes: Math\.max\(1, Math\.min\(1440, parseInt\(\$\('cfgPatrolRetryMinutes'\)\.value, 10\) \|\| 15\)\)/.test(app),
  'app.js 保存时做 1–1440 收敛')
ok(/推送服务端没开时，不会再一分钟试一次/.test(html), '设置页说明失败退避行为')
ok(/巡检只<strong>重测<\/strong>已灌入的音源，不会灌入新音源/.test(html), '说明巡检不灌入（澄清「尝试灌入」的误解）')
ok(/const PUBLIC_PORT = Number\(process\.env\.PUBLIC_PORT \|\| 0\)/.test(web), '启动日志支持 PUBLIC_PORT')
ok(/外部访问端口 \$\{PUBLIC_PORT\}（容器内监听 \$\{PORT\}）/.test(web), '内/外端口同时说明，不再只显示 7970')
ok(/app\.js\?v=50/.test(html), 'app.js 缓存戳已 bump')
ok(/styles\.css\?v=13/.test(html), 'styles.css 缓存戳已 bump（离线角标样式）')

console.log('--- ⑤ 服务端离线时的可读性（断线不清库，但要说清是本地快照）---')
ok(/connOk: null/.test(app), 'state 记录推送服务端连通结果，初始为未知')
ok(/state\.connOk = true/.test(app) && /state\.connOk = false/.test(app),
  'testConn / 账号测试都会更新连通结果')
ok(/function testConn\([\s\S]*?renderStats\(\)/.test(app),
  '连通检测结束后刷新统计卡，离线角标即时生效')
ok(/stat-offline/.test(app) && /classList\.add\('stat-offline'\)/.test(app),
  '离线时给「已灌入」统计卡加角标 class')
ok(/classList\.remove\('stat-offline'\)/.test(app), '连接恢复后移除角标')
ok(/card\.stat\.stat-offline::after/.test(css) && /content: '服务端离线'/.test(css),
  'CSS 有可见的「服务端离线」角标')
ok(/当前未连接推送服务端：这里是上次成功读取的服务端列表或本地灌入账本，不是实时状态/.test(app),
  'tooltip 说清数字是上次列表 / 本地账本，不是实时状态')
ok(/「来源仓库」为 \(服务端\) 的条目也是本地快照，不会因断线消失/.test(app),
  'tooltip 解释 (服务端) 占位条目为何断线后仍在')
ok(/已灌入 · 当前账号/.test(app), '保留既有统计卡标签文案（不破坏 dist-selfcheck 契约）')
ok(/id="connChip" title="推送服务端连接状态/.test(html), '左下角连接状态有静态说明')
ok(/连接恢复后刷新「已灌入」页即可对账/.test(app), 'tooltip 给出恢复后的对账动作')

console.log('\n巡检调度 + 服务端离线可读性契约全部通过：' + pass + ' 条断言')
