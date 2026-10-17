/**
 * v1.9.16 「检测选中强制重测 + 跳过分支补写探针徽章」回归测试。
 * 实测反馈：勾 36 条点「检测选中」，秒完成、徽章一条不变——批量走「跳过已检测」全被跳过，
 * 而探针记录（probe/validTier）是 v1.9.9 才加的，老条目身上没有，跳过分支也不补。
 * 修复后：手动勾选带 force 强制重测；跳过分支对缺 probe 的条目本地补写（纯计算，无网络）。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const checker = require('../src/core/checker')

let basicCalls = 0
checker.checkBasic = async (e) => { basicCalls++; e.status = 'ok'; e.suspected = true; e.error = ''; return { code: 'SCRIPT_' + e.id } }
checker.deepCheck = async (e) => ({
  loadable: true, cancelled: false, loadError: null,
  platforms: { wy: { status: 'usable', message: 'ok' } },
  usable: 1, hash: e.contentHash, checkedAt: Date.now()
})
delete require.cache[require.resolve('../src/core/hunter')]
const { Hunter } = require('../src/core/hunter')
const { Store, DEFAULT_CONFIG } = require('../src/core/store')

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-check-force-'))
  const store = new Store(dir)
  store.config = Object.assign({}, DEFAULT_CONFIG, store.config, {
    skipChecked: true, apiHostCheck: false, excludeHighRiskObfuscated: false, concurrency: 4
  })
  // 造 3 条「已检测过、内容未变」的可用音源：deep.hash === contentHash（跳过分支的命中条件）
  const ids = []
  for (let i = 1; i <= 3; i++) {
    const id = 's' + i
    ids.push(id)
    store.db.sources[id] = {
      id, name: '源' + i, url: 'https://example.com/' + i + '.js',
      status: 'ok', usable: true,
      contentHash: 'hash' + i,
      deep: { loadable: true, cancelled: false, platforms: { wy: { status: 'usable', message: 'ok' } }, usable: 1, hash: 'hash' + i, checkedAt: Date.now() }
      // 注意：故意不写 probe / validTier —— 模拟 v1.9.9 之前检测的老条目
    }
  }
  store.saveDb()

  const hunter = new Hunter(store)

  // ---------- 场景 1：批量无 force（爬取后自动检测的路径）→ 跳过 + 本地补写探针 ----------
  basicCalls = 0
  await hunter.runCheck(ids)
  ck('跳过分支生效：已检测未变的条目不重新下载', basicCalls === 0, 'checkBasic 调用 ' + basicCalls + ' 次')
  ck('跳过时本地补写探针记录（无网络）',
    store.db.sources.s1.probe && store.db.sources.s1.probe.status === 'usable',
    JSON.stringify(store.db.sources.s1.probe))
  ck('补写后 validTier = confirmed（显示「已实测」）', store.db.sources.s1.validTier === 'confirmed')

  // ---------- 场景 2：批量 + force（「检测选中」的新行为）→ 真正重新检测 ----------
  basicCalls = 0
  const r2 = await hunter.runCheck(ids, { force: true })
  ck('force 批量：每条都重新下载检测', basicCalls === 3, 'checkBasic 调用 ' + basicCalls + ' 次')
  ck('force 批量：结果照常汇总', r2 && r2.usable === 3 && r2.total === 3, JSON.stringify({ usable: r2.usable, total: r2.total }))

  // ---------- 场景 3：单条（旧行为保留）→ 天然强制 ----------
  basicCalls = 0
  await hunter.runCheck([ids[0]])
  ck('单条检测仍是强制重测', basicCalls === 1, 'checkBasic 调用 ' + basicCalls + ' 次')

  // ---------- 场景 4：跳过分支不改写已有探针 ----------
  const before = store.db.sources.s1.probe.checkedAt
  await new Promise(x => setTimeout(x, 5))
  await hunter.runCheck(ids)
  ck('已有探针记录不被跳过分支覆盖', store.db.sources.s1.probe.checkedAt === before)

  if (bad) { console.error(`\n${bad} 个断言失败`); process.exit(1) }
  console.log('\n全部通过')
})().catch(e => { console.error('测试异常:', e); process.exit(1) })
