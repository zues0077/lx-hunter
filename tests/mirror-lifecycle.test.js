/**
 * v1.9.11 镜像实测（gh1.lhl.one）+ 生命周期遥测（apiDownStreak / apiDownVerdict）。
 * 借鉴 lxhub 的 api_down_streak：后端域名连续全部不可达时累计，达阈值即判死，提前退役。
 */
const net = require(require('path').join(__dirname, '..', 'src', 'core', 'net.js'))
const { probeApiHosts, apiDownVerdict } = require(require('path').join(__dirname, '..', 'src', 'core', 'checker.js'))

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }

;(async () => {
  // ---------- 1. gh1.lhl.one 镜像预设 ----------
  const ids = net.MIRROR_PRESETS.map(m => m.id)
  ck('内置镜像含 gh1.lhl.one（lhlone）', ids.includes('lhlone'), ids.join(','))
  const pre = net.MIRROR_PRESETS.find(m => m.id === 'lhlone')
  ck('gh1.lhlone 是前缀型镜像且基址正确', pre && pre.prefix === true && pre.build('https://raw.githubusercontent.com/o/r/HEAD/a.js') === 'https://gh1.lhl.one/https://raw.githubusercontent.com/o/r/HEAD/a.js', pre && pre.build('https://raw.githubusercontent.com/o/r/HEAD/a.js'))
  const raw = 'https://raw.githubusercontent.com/owner/repo/HEAD/a/b.js'
  ck('buildCandidates 含 lhlone', net.buildCandidates(raw, 'auto').some(c => c.id === 'lhlone'))
  // 与旧失效域名区分：gh1.lh1.one（数字1）仍不在列
  ck('仍不含旧失效域名 gh1.lh1.one', !ids.includes('gh1'))

  // ---------- 2. probeApiHosts 生命周期遥测（apiDownStreak） ----------
  // 全部不可达 → 累计 +1
  globalThis.fetch = async () => { throw new Error('ENOTFOUND') }
  const eDown = { apiHosts: ['api.dead.com', 'cdn.dead.net'] }
  await probeApiHosts(eDown, { apiHostCheck: true })
  ck('全部不可达：apiDownStreak 累计为 1', eDown.apiDownStreak === 1, 'streak=' + eDown.apiDownStreak)
  ck('全部不可达：apiAlive 全标 down', eDown.apiAlive && eDown.apiAlive['api.dead.com'] === 'down', JSON.stringify(eDown.apiAlive))

  // 再跑一次仍全挂 → 累计 2
  await probeApiHosts(eDown, { apiHostCheck: true })
  ck('连续全不可达：apiDownStreak 累计为 2', eDown.apiDownStreak === 2, 'streak=' + eDown.apiDownStreak)

  // 恢复一个可达（http_403 视为可达）→ 清零
  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => '' })
  const eMixed = { apiHosts: ['api.dead.com', 'api.alive.com'], apiDownStreak: 5 }
  await probeApiHosts(eMixed, { apiHostCheck: true })
  ck('有可达域名：apiDownStreak 清零', eMixed.apiDownStreak === 0, 'streak=' + eMixed.apiDownStreak)
  ck('有可达域名：apiAlive 标 up（403 视为可达）', eMixed.apiAlive['api.alive.com'] === 'up', JSON.stringify(eMixed.apiAlive))

  // 关闭不写
  const eOff = { apiHosts: ['x.com'] }
  await probeApiHosts(eOff, { apiHostCheck: false })
  ck('apiHostCheck 关闭：不写 apiDownStreak/apiAlive', eOff.apiDownStreak === undefined && eOff.apiAlive === undefined)

  // ---------- 3. apiDownVerdict 判定 ----------
  const cfg = { apiHostCheck: true, patrolDisableAfter: 2 }
  ck('未开启 apiHostCheck → 返回 null', apiDownVerdict({ apiDownStreak: 3 }, { apiHostCheck: false }) === null)
  ck('streak=0 → 返回 null', apiDownVerdict({ apiDownStreak: 0 }, cfg) === null)
  const v1 = apiDownVerdict({ apiDownStreak: 1 }, cfg)
  ck('streak<阈值 → suspect', v1 && v1.verdict === 'suspect', v1 && v1.verdict)
  const v2 = apiDownVerdict({ apiDownStreak: 2 }, cfg)
  ck('streak≥阈值 → dead', v2 && v2.verdict === 'dead', v2 && v2.verdict)

  if (bad) { console.error(`\n${bad} 个断言失败`); process.exit(1) }
  console.log('\n全部通过')
})()
