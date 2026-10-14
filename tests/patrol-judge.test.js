/**
 * 巡检判定回归：
 * 1) 根因回归 —— usableCount 必须同时接受「音源库条目」和「深检结果」两种入参。
 *    过去巡检把 deepCheck 的返回值 d 直接传入，函数只认 entry.deep ⇒ 永远返回 0 ⇒
 *    所有已灌入源被判死并自动禁用（包括主检明明可用的）。
 * 2) patrolJudge 策略 —— 一次失败不判死：铁证立即判死，其余连续 threshold 次才升级。
 */
const { usableCount, patrolJudge } = require('../src/core/checker')

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }

const deepUsable = { loadable: true, platforms: { wy: { status: 'usable' }, tx: { status: 'failed', message: 'HTTP 403' } } }
const deepAllFail = { loadable: true, hint: '', platforms: {
  wy: { status: 'failed', message: '未匹配到歌曲' },
  tx: { status: 'failed', message: '未匹配到歌曲' },
  kw: { status: 'failed', message: '未匹配到歌曲' },
  kg: { status: 'failed', message: '未匹配到歌曲' },
  mg: { status: 'failed', message: '未匹配到歌曲' }
} }
const deepNetFail = { loadable: true, platforms: {} , __fill: true }
for (const k of ['wy', 'tx', 'kw', 'kg', 'mg']) deepNetFail.platforms[k] = { status: 'failed', message: '沙箱 fetch 失败: fetch failed ← getaddrinfo ENOTFOUND api.x.com' }

// ---------- 1. usableCount 双形态（根因回归） ----------
ck('条目形态：counts entry.deep.platforms', usableCount({ deep: deepUsable }) === 1)
ck('深检结果形态：counts d.platforms（根因回归）', usableCount(deepUsable) === 1, String(usableCount(deepUsable)))
ck('全失败两种形态都是 0', usableCount(deepAllFail) === 0 && usableCount({ deep: deepAllFail }) === 0)
ck('空入参不抛且为 0', usableCount(null) === 0 && usableCount({}) === 0)

// ---------- 2. patrolJudge 策略 ----------
let j = patrolJudge(deepUsable, {})
ck('有可用平台 → ok', j.verdict === 'ok' && /可用平台 1 个/.test(j.note), j.note)

j = patrolJudge(deepAllFail, { prevStreak: 0, threshold: 2 })
ck('首次全失败（非网络原因）→ suspect 不判死', j.verdict === 'suspect' && j.streak === 1, j.note)
ck('suspect 提示说明需连续确认', /连续第 1 次/.test(j.note) && /连续 2 次确认/.test(j.note), j.note)

j = patrolJudge(deepAllFail, { prevStreak: 1, threshold: 2 })
ck('连续第 2 次 → dead', j.verdict === 'dead' && j.streak === 2, j.note)

j = patrolJudge(deepNetFail, { prevStreak: 0, threshold: 2 })
ck('网络原因 → unknown 不禁用', j.verdict === 'unknown' && /网络\/限流/.test(j.note), j.note.slice(0, 60))

j = patrolJudge({ loadable: true, deadDomain: true, platforms: deepAllFail.platforms }, { prevStreak: 0, threshold: 2 })
ck('域名已注销（铁证）→ 立即 dead', j.verdict === 'dead' && j.fatal === true, j.note)

j = patrolJudge({ loadable: false, loadError: '脚本执行报错: xx' }, {})
ck('加载失败 → unknown 不动服务端', j.verdict === 'unknown' && /无法验证/.test(j.note), j.note)

j = patrolJudge(deepAllFail, { prevStreak: 0, threshold: 2, updated: true })
ck('note 可带「内容已更新」上下文', patrolJudge(deepUsable, { updated: true }).note.includes('内容已更新'))

// 阈值可配：threshold=1 时首次即判死
j = patrolJudge(deepAllFail, { prevStreak: 0, threshold: 1 })
ck('阈值=1 时首次全失败即 dead', j.verdict === 'dead', j.note)

console.log('\n' + (bad === 0 ? 'ALL PASS' : bad + ' FAILED'))
process.exit(bad ? 1 : 0)
