'use strict'
/**
 * v1.10.2 离线快照三项改进回归：
 *  ①「已灌入」页断线保留上次成功读取的列表 + 黄条 + 快照态禁写；
 *  ② 音源库 (服务端) 占位行的「离线快照」行级灰标；
 *  ③ 删除占位时同步摘掉 imported 账本，且 runSyncServer 不把它复活。
 *
 * ①② 是渲染层契约（带「修复前必败」对照，防切片退化成恒真），
 * ③ 用真实 Store + 真实 Hunter.runSyncServer 跑一遍，不是只读源码。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Store } = require('../src/core/store')
const { Hunter } = require('../src/core/hunter')

const root = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8')
const html = read('src/renderer/index.html')
const app = read('src/renderer/app.js')
const css = read('src/renderer/styles.css')
const hunterSrc = read('src/core/hunter.js')
const web = read('src/server/web.js')
const main = read('src/main/index.js')
const pkg = JSON.parse(read('package.json'))

let pass = 0
const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log('  PASS', label) }

console.log('--- ① 已灌入页：断线保留快照，不清空、不对账、禁写 ---')
const insCard = html.indexOf('id="insCard"')
const banner = html.indexOf('id="insSnapshot"')
const toolbar = html.indexOf('id="patrolInfo"')
ok(insCard > 0 && banner > insCard && toolbar > banner, '黄条就在已灌入卡片内、工具栏上方')
ok(/id="insSnapshot"[^>]*hidden/.test(html), '黄条默认隐藏，只有断线时才显示')
const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, '')
ok(/\.snap-banner\s*\{/.test(cssRules), '黄条有独立样式')
ok(/\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css), '全局 [hidden] 规则能盖住卡片布局')

const fn = app.slice(app.indexOf('async function refreshInstalled'), app.indexOf('function applyInstalledStale'))
ok(fn.length > 200, '前置：成功切出 refreshInstalled 函数体')
const failBranch = fn.slice(fn.indexOf('if (!r.ok) {'), fn.indexOf('state.installed = r.data'))
const okBranch = fn.slice(fn.indexOf('state.installed = r.data'))
const legacyFail = "if (!r.ok) { body.innerHTML = ''; $('insInfo').textContent = '读取失败'; $('insEmpty').hidden = false; return }"
ok(/body\.innerHTML\s*=\s*''/.test(legacyFail), '对照：旧实现失败分支确实会清空列表（断言非空转）')
ok(!/body\.innerHTML\s*=\s*''/.test(failBranch), '新失败分支不再清空 tbody')
ok(/state\.installedStale\s*=\s*true/.test(failBranch), '失败时进入快照态')
ok(/state\.insSel\.clear\(\)/.test(failBranch), '失败时清掉勾选池，避免拿旧快照去删')
ok(/renderInstalledRows\(\)/.test(failBranch) && /applyInstalledStale\(\)/.test(failBranch), '失败时保留并重渲染上次列表 + 应用快照态')
ok(!/reconcileLedger/.test(failBranch), '失败分支绝不做账本对账（对账只认刚成功读到的列表）')
ok(!/loadPublic/.test(failBranch), '失败分支不拿旧数据刷新公共清理面板')
ok(/state\.installedAt\s*=\s*Date\.now\(\)/.test(okBranch) && /state\.installedStale\s*=\s*false/.test(okBranch),
  '成功读取时记快照时间并退出快照态')
ok(/reconcileLedger/.test(okBranch) && /loadPublic\(\)/.test(okBranch), '成功读取时照常对账 + 刷新公共清理')
ok(/installedAt:\s*0/.test(app) && /installedStale:\s*false/.test(app), 'state 里有快照时间与快照态初值')
ok(/上次成功读取的快照/.test(app) && /请勿据此删除或停用/.test(app), '黄条写明是快照、且明确别据此删除')
ok(/installedAt\s*\?\s*new Date\(state\.installedAt\)/.test(app), '黄条带上次成功读取的时间')

const staleFn = app.slice(app.indexOf('function applyInstalledStale'), app.indexOf("const insCardEl = $('insCard')"))
ok(/el\.disabled\s*=\s*true/.test(staleFn), '快照态禁用服务端写按钮')
ok(/button\[data-del\]/.test(staleFn) && /btnInsDelSel/.test(staleFn) && /btnRevokeSelected/.test(staleFn),
  '禁用范围覆盖行内删除、批量删除、撤回全部')
ok(/renderInsSelInfo\(\)/.test(staleFn), '恢复时按勾选数重算按钮启用条件')
const guardSnippet = app.slice(app.indexOf("const insCardEl = $('insCard')"))
const guard = guardSnippet.slice(0, guardSnippet.indexOf('/**'))
ok(/addEventListener\('click',[\s\S]*true\)/.test(guard), '另有捕获阶段的兜底守卫')
ok(/stopImmediatePropagation/.test(guard), '兜底守卫能挡住被别处重新启用的按钮 / 键盘触发')
ok(/installedStale/.test(guard), '兜底守卫只在快照态生效')

console.log('--- ② 音源库 (服务端) 行的离线快照角标 ---')
const rowFn = app.slice(app.indexOf('function rowHtml(e)'), app.indexOf('const rowMap'))
ok(/e\.fromServer\s*\|\|\s*e\.repo\s*===\s*'\(服务端\)'/.test(rowFn), '角标只给占位快照行')
ok(/class="snap-tag"/.test(rowFn) && /离线快照/.test(rowFn), '行内输出灰色「离线快照」小标')
ok(/到「已灌入」页点「刷新」即可对账/.test(rowFn), 'tooltip 说清恢复后怎么对账')
ok(/\$\{snap\}/.test(rowFn), '角标确实插进 repo 单元格而不是只定义了变量')
ok(/\.snap-tag\s*\{[^}]*display:\s*none/.test(cssRules), '默认隐藏角标')
ok(/body\.conn-offline\s+\.snap-tag\s*\{[^}]*display:\s*inline-block/.test(cssRules), '仅推送服务端离线时显示')
ok(/document\.body\.classList\.toggle\('conn-offline',\s*state\.connOk\s*===\s*false\)/.test(app),
  'connOk 变化时由 renderStats 同步 body class（不必整表重建）')
ok(Number(/app\.js\?v=(\d+)/.exec(html)[1]) >= 51, 'app.js 缓存戳已 bump')
ok(Number(/styles\.css\?v=(\d+)/.exec(html)[1]) >= 14, 'styles.css 缓存戳已 bump')
ok(/ledgerDropped/.test(web) && /ledgerDropped/.test(main), '双端删除日志都报告账本清理数')
ok(pkg.scripts.test.includes('offline-snapshot.test.js'), '本测试已注册进 npm test')

console.log('--- ③ 真实 Store：删占位连账本一起摘，同步不复活 ---')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-snap-'))
const store = new Store(dir)
store.db.sources['srv:lx-1'] = { id: 'srv:lx-1', name: '服务端占位', repo: '(服务端)', fromServer: true, url: '' }
store.db.sources['local-1'] = { id: 'local-1', name: '本地候选', repo: '测试仓库', url: 'https://example.test/a.js' }
store.imported['srv:lx-1'] = { lxId: 'lx-1', name: '服务端占位', serverSynced: true, serverNative: true, platformId: 'p1' }
store.imported['local-1'] = { lxId: 'lx-2', name: '本地候选', platformId: 'p1' }
store.saveDb(); store.saveImported()

const r = store.removeSources(['srv:lx-1', 'local-1'])
ok(r.deleted === 2 && r.ledgerDropped === 1, '删 2 条，其中 1 条占位账本被清理')
ok(!store.imported['srv:lx-1'] && !!store.imported['local-1'], '只摘占位账本，普通候选账本保留（服务端上确实还有一份）')
const reload = new Store(dir)
ok(!reload.imported['srv:lx-1'], '账本清理已落盘，不留孤儿记录')
ok(reload.isDeleted('srv:lx-1'), '占位 id 记入不再自动采集名单')
const syncSnippet = hunterSrc.slice(hunterSrc.indexOf("const pid = 'srv:' + s.id"))
ok(/isDeleted\(pid\)/.test(syncSnippet.slice(0, 500)) && /continue/.test(syncSnippet.slice(0, 500)),
  'runSyncServer 的占位分支尊重删除名单')

;(async () => {
  const hunter = new Hunter(reload, () => {})
  hunter._active = () => ({
    acct: { id: 'p1', name: '测试账号' }, type: 'lxserver',
    adapter: {
      verify: async () => ({ ok: true, msg: 'ok' }),
      list: async () => [{ id: 'lx-1', name: '服务端占位' }],
      baseUrl: () => 'http://127.0.0.1:7970'
    }
  })
  await hunter.runSyncServer()
  ok(!reload.db.sources['srv:lx-1'] && !reload.imported['srv:lx-1'],
    '真实同步一轮：手动删过的占位不会「删了又长回来」')
  reload.clearDeletedIds()
  await hunter.runSyncServer()
  ok(!!reload.db.sources['srv:lx-1'] && !!reload.imported['srv:lx-1'],
    '清除删除记录后，同步可正常重新纳入该占位（恢复途径没被堵死）')

  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`\noffline-snapshot.test.js: PASS ${pass} / FAIL 0`)
})().catch(err => { console.error(err); process.exit(1) })
