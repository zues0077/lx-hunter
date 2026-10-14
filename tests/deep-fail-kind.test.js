// v1.6.5：失效统计口径（deepFailKind）+ 巡检采纳手动检测失效证据
// 根因：统计只认「脚本下载失败(status=dead)」，深检全平台失败的真实失效源全被算进「疑似」，
// 失效栏永远是 0 —— 用户看到列表一片红、统计却是 0，直觉上就是 bug。
const assert = require('assert')
const { deepFailKind, patrolJudge, isLocalNetworkIssue } = require('../src/core/checker')

let n = 0
const ck = (name, cond) => { n++; if (!cond) { console.error('FAIL  ' + name); process.exitCode = 1 } else console.log('PASS  ' + name) }

console.log('== deepFailKind 基础分类 ==')
ck('有可用平台 → 非失效', deepFailKind({ platforms: { wy: { status: 'usable', message: 'ok' }, tx: { status: 'failed', message: '返回空链接' } } }) === '')
ck('加载失败 → 不归类', deepFailKind({ loadError: '脚本执行报错', platforms: {} }) === '')
ck('已取消 → 不归类', deepFailKind({ cancelled: true, platforms: { wy: { status: 'failed', message: 'x' } } }) === '')
ck('没有实测失败的平台（全 skipped/untested）→ 不归类',
  deepFailKind({ platforms: { wy: { status: 'skipped' }, tx: { status: 'untested' } } }) === '')
ck('无失败也无可用 → 不归类', deepFailKind({ platforms: {} }) === '')
ck('deep 为空 → 不归类', deepFailKind(null) === '')

console.log('== 失败原因决定 dead / net ==')
// 非网络原因：脚本自身报错、返回空 —— 真失效
ck('全平台「返回空链接」→ dead', deepFailKind({ platforms: { wy: { status: 'failed', message: '返回空链接' }, tx: { status: 'failed', message: '返回空链接' } } }) === 'dead')
ck('脚本业务错（Invalid search response）→ dead',
  deepFailKind({ platforms: { wy: { status: 'failed', message: '返回异常: Invalid search response' } } }) === 'dead')
ck('脚本业务错（unknow error）→ dead',
  deepFailKind({ platforms: { wy: { status: 'failed', message: '返回异常: unknow error' } } }) === 'dead')
// 网络原因：可自救，不算失效
ck('全平台请求超时 → net', deepFailKind({ platforms: { wy: { status: 'failed', message: '请求超时 20000ms' } } }) === 'net')
ck('全平台 ENOTFOUND → net', deepFailKind({ platforms: { wy: { status: 'failed', message: '沙箱 fetch 失败: fetch failed ← getaddrinfo ENOTFOUND api.x.com' } } }) === 'net')
ck('混合（一个超时 + 一个返回空）→ 保守归 net',
  deepFailKind({ platforms: { wy: { status: 'failed', message: '请求超时 20000ms' }, tx: { status: 'failed', message: '返回空链接' } } }) === 'net')
// 死域名：DoH 确认全网不存在，即使错误像网络问题也判死
ck('deadDomain 优先判 dead（即使错误匹配网络口径）',
  deepFailKind({ deadDomain: true, platforms: { wy: { status: 'failed', message: 'getaddrinfo ENOTFOUND dead.com' } } }) === 'dead')

console.log('== 巡检采纳手动检测失效证据（fish_music 场景） ==')
// 手动检测确证失效（failKind=dead、内容未变、7 天内）⇒ 巡检把 prevStreak 从 0 抬到 1，
// 本轮再失败 streak=2 ≥ 阈值 2 ⇒ 直接判死禁用，不必再等下一轮巡检
const manualDead = { failKind: 'dead', hash: 'h1', checkedAt: Date.now() - 3600e3, platforms: { wy: { status: 'failed', message: '返回异常: unknow error' } } }
const fresh = !!(manualDead && manualDead.failKind === 'dead' && manualDead.hash === 'h1' && manualDead.checkedAt && Date.now() - manualDead.checkedAt < 7 * 86400e3)
ck('手动失效证据有效', fresh === true)
const j1 = patrolJudge({ platforms: { wy: { status: 'failed', message: '返回异常: unknow error' } }, loadable: true }, { prevStreak: fresh ? 1 : 0, threshold: 2 })
ck('巡检失败 + 手动证据 → 连续 2 次确认 → 判死', j1.verdict === 'dead' && /连续 2 次/.test(j1.note))
// 证据过期（>7天）不采纳
const stale = !!(manualDead && Date.now() - manualDead.checkedAt < 7 * 86400e3)
ck('7 天内的证据才算', stale === true)
// 内容变了不算（音源可能已修复）
const contentChanged = manualDead.hash !== 'h2'
ck('脚本内容已更新则证据作废', contentChanged === true)
// 手动检测过但结论是网络疑云（failKind=net）不能当证据
ck('网络疑云（net）不算失效证据', manualDead.failKind !== 'net' && deepFailKind({ platforms: { wy: { status: 'failed', message: '请求超时' } } }) === 'net')

console.log('== 巡检恢复策略（unknown 非疑似时恢复被禁源） ==')
// 无法判定（netIssue）→ verdict unknown 且非 suspectTag ⇒ hunter 会恢复 disabledByPatrol 的源
const j2 = patrolJudge({ loadable: true, platforms: { wy: { status: 'failed', message: '请求超时 20000ms' } } }, { prevStreak: 0, threshold: 2 })
ck('网络原因 → unknown（不禁用）', j2.verdict === 'unknown')
// 疑似失效（streak 上涨）→ 保持禁用
const j3 = patrolJudge({ loadable: true, platforms: { wy: { status: 'failed', message: '返回空链接' } } }, { prevStreak: 0, threshold: 2 })
ck('首轮失败 → suspect（保持禁用，不恢复）', j3.verdict === 'suspect')

console.log('== 闸门口径回归 ==')
ck('isLocalNetworkIssue 仍覆盖中文文案', isLocalNetworkIssue('沙箱 fetch 失败: 请求超时 20000ms') === true)
ck('isLocalNetworkIssue 不误伤业务错误', isLocalNetworkIssue('返回异常: Invalid search response') === false)

console.log(`\n${n} 项` + (process.exitCode ? ' 存在失败' : ' 全部通过'))
