'use strict'
/**
 * v1.10.2 手动删除音源：按选中条目从本地库删除 + 「不再自动采集」名单。
 *
 * 背景：此前只有「清空音源库」（整库）与「已灌入」页的服务端删除，
 * 用户勾选了某条音源（例如私人音源）却没有任何入口能把它删掉。
 *
 * 四层验证：
 *  ① store.removeSources 的删除语义（含私人源、非法入参、账本保留、持久化）；
 *  ② 三个自动入库入口统一过滤删除名单，且带「旧实现必复活」的反向对照；
 *  ③ 三条恢复途径（导入音源库 / 重新导入同名私人源 / 清除名单）；
 *  ④ Web + 桌面 + 渲染层的接口/UI 契约（按钮就在截图那排工具栏里、
 *     必须二次确认、设置页有配套删除记录管理、缓存戳已 bump）。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Store } = require('../src/core/store')

const root = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8')
const html = read('src/renderer/index.html')
const app = read('src/renderer/app.js')
const bridge = read('src/renderer/web-bridge.js')
const preload = read('src/main/preload.js')
const main = read('src/main/index.js')
const web = read('src/server/web.js')
const hubfeed = read('src/core/hubfeed.js')
const pkg = JSON.parse(read('package.json'))

let pass = 0
const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log('  PASS', label) }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-delete-'))
const mk = id => ({ id, name: id, repo: '测试仓库', path: id + '.js', url: 'https://example.test/' + id + '.js' })
const store = new Store(dir)

console.log('--- ① 删除语义 ---')
store.addSources([mk('a'), mk('b'), mk('c')])
store.addPrivateSource('我的私人音源.js', '/* test */\nconst info={name:"p",version:"1.0"};module.exports={info};')
store.imported.a = { lxId: 'lx-a', name: 'a' }
store.imported.c = { lxId: 'lx-c', name: 'c' }
store.saveImported()
ok(store.getSources().length === 4, '前置：库里有 3 条普通源 + 1 条私人源')

const r1 = store.removeSources(['a', 'private::我的私人音源', 'not-there'])
ok(r1.deleted === 2, '只删库里真实存在的 2 条')
ok(r1.missing.length === 1 && r1.missing[0] === 'not-there', '不存在的 id 记入 missing 而不是报错')
ok(r1.blocked === 2, '返回累计删除记录数')
ok(!store.db.sources.a && !store.db.sources['private::我的私人音源'], '普通源与私人源都已从库里移除')
ok(!!store.db.sources.b && !!store.db.sources.c, '未选中的条目一条都没动')
ok(!!store.imported.a, 'imported 账本保留（它描述服务端状态，删本地条目不该抹掉）')
ok(JSON.stringify(r1) === JSON.stringify({ deleted: 2, missing: ['not-there'], blocked: 2, ledgerDropped: 0 }),
  '返回结构稳定（含占位账本清理计数；普通源为 0），渲染层可直接取字段')

ok(store.removeSources([]).deleted === 0, '空 ids 不删任何条目')
ok(store.removeSources(null).deleted === 0, 'null ids 被容错处理')
ok(store.removeSources(['b', 123, '', 'b']).deleted === 1, '过滤非法值、去重后只删 1 条')
ok(store.deletedIds().length === 3, '名单累计 3 条，没有重复写入')
const snapshot = store.deletedIds()
snapshot.push('fake')
ok(store.deletedIds().indexOf('fake') < 0, 'deletedIds() 返回副本，调用方改不动内部名单')
ok(store.isDeleted('a') && !store.isDeleted('zz'), 'isDeleted 判定正确')

const reload = new Store(dir)
ok(reload.isDeleted('a') && reload.isDeleted('private::我的私人音源'), '名单持久化到 sources.json')
ok(!reload.db.sources.a && !reload.db.sources['private::我的私人音源'], '删除结果持久化')

console.log('--- ② 自动入库统一过滤（带旧实现反向对照） ---')
// 对照：修复前的 addSources 只看「库里有没有」，删掉的源下一次采集必然复活。
const legacyAdd = (db, items) => { let n = 0; for (const it of items) if (!db[it.id]) { db[it.id] = it; n++ } return n }
const legacyDb = { c: mk('c') }
ok(legacyAdd(legacyDb, [mk('a')]) === 1 && !!legacyDb.a, '对照：旧实现确实会把删掉的 a 加回来')

ok(store.addSources([mk('a'), mk('d')]) === 1 && !!store.db.sources.d && !store.db.sources.a,
  'addSources（采集站走这里）跳过名单内的 a，只收新条目 d')
const inc = store.mergeSources([mk('a'), mk('d'), mk('e')], { incremental: true })
ok(inc.added === 1 && !store.db.sources.a && !!store.db.sources.e, 'mergeSources 增量模式不复活被删条目')
const full = store.mergeSources([mk('a'), mk('f')], { incremental: false })
ok(full.added === 1 && !store.db.sources.a && !!store.db.sources.f,
  'mergeSources 非增量模式（_addCount）同样不复活')
ok(/store\.addSources\(/.test(hubfeed), '采集站 hubfeed 走 addSources，因此自动被名单覆盖')
ok(store.getSources().filter(x => store.isDeleted(x.id)).length === 0, '库里不存在任何「已删但还在」的条目')

console.log('--- ③ 三条恢复途径 ---')
store.mergeFrom({ version: 2, sources: [mk('a')], imported: {} })
ok(!store.isDeleted('a') && !!store.db.sources.a, '导入音源库 JSON 会解除该条目的删除记录并恢复')
ok(store.addSources([mk('a')]) === 0, '恢复后重复采集只是 skipped，不会重复入库')
store.removeSources(['a'])
store.addPrivateSource('我的私人音源.js', '/* test2 */\nconst info={name:"p",version:"2.0"};module.exports={info};')
ok(!store.isDeleted('private::我的私人音源') && !!store.db.sources['private::我的私人音源'],
  '重新导入同名私人源 = 明确恢复，解除名单')
const cleared = store.clearDeletedIds()
ok(cleared.cleared > 0 && store.deletedIds().length === 0, 'clearDeletedIds 清空全部名单')
ok(store.addSources([mk('a')]) === 1 && !!store.db.sources.a, '清名单后 a 又能被自动采集收录')

console.log('--- ④ 双端接口 + 渲染层契约 ---')
ok(/route\('POST', '\/api\/db\/delete'/.test(web), 'Web 版有 /api/db/delete')
ok(/route\('POST', '\/api\/db\/deleted\/list'/.test(web) && /route\('POST', '\/api\/db\/deleted\/clear'/.test(web),
  'Web 版有删除记录查询 / 清除接口')
ok(/store\.removeSources\(ids\)/.test(web) && /pushLog\(/.test(web.split('/api/db/delete')[1].split("route('POST', '/api/db/deleted")[0]),
  '删除接口调用 store 并写运行日志')
ok(/ipcMain\.handle\('db:delete'/.test(main) && /ipcMain\.handle\('db:deleted:list'/.test(main) && /ipcMain\.handle\('db:deleted:clear'/.test(main),
  '桌面版三个 IPC 通道齐备')
ok(/dbDelete: \(ids\) => ipcRenderer\.invoke\('db:delete', ids\)/.test(preload), 'preload 暴露 dbDelete')
ok(/dbDeletedList: \(\) => ipcRenderer\.invoke\('db:deleted:list'\)/.test(preload), 'preload 暴露 dbDeletedList')
ok(/dbDelete: ids => call\('\/api\/db\/delete', \{ ids \}\)/.test(bridge), 'Web 桥接 dbDelete 与桌面同签名')
ok(/dbDeletedList/.test(bridge) && /dbDeletedClear/.test(bridge), 'Web 桥接也有名单查询 / 清除')

// 按钮必须在截图圈出的那一排批量工具栏里（btnFullPlat 与 btnClearSel 之间）
const bar = html.slice(html.indexOf('id="selInfo"'), html.indexOf('id="btnClearSel"'))
ok(/id="btnDeleteSel"/.test(bar), '「删除选中」按钮就在音源库批量工具栏里')
ok(/id="btnFullPlat"/.test(bar) && bar.indexOf('btnFullPlat') < bar.indexOf('btnDeleteSel'),
  '位置在「深度检测（打分）」之后、「清空选择」之前')
ok(/class="btn danger-ghost" id="btnDeleteSel"/.test(html), '危险操作用 danger-ghost 醒目样式')
ok(/title="[^"]*不影响服务端已灌入的脚本/.test(html), '按钮说明写清不影响服务端已灌入脚本')
const delFn = app.slice(app.indexOf('async function deleteSelected'), app.indexOf("$('btnDeleteSel').addEventListener"))
ok(/if \(!ids\.length\)/.test(delFn), '没勾选时只提示，不发请求')
ok(/confirm\(/.test(delFn), '删除前必须二次确认（不能点一下就删）')
ok(/其中 \$\{priv\} 条是私人音源/.test(delFn), '确认框里会点出私人音源数量')
ok(/api\.dbDelete\(ids\)/.test(delFn) && /await loadSources\(\)/.test(delFn), '确认后调删除接口并刷新列表')
ok(/state\.selected\.delete\(id\)/.test(delFn), '删完清掉勾选，避免残留跨筛选勾选')
ok(/\$\('btnDeleteSel'\)\.addEventListener\('click', deleteSelected\)/.test(app), '按钮已绑定到 deleteSelected')
ok(/function refreshDeletedInfo/.test(app) && /await refreshDeletedInfo\(\)/.test(app), '设置页删除记录计数在启动与删除后刷新')
ok(/id="deletedInfo"/.test(html) && /id="btnClearDeleted"/.test(html), '设置页有删除记录管理控件')
ok(/不会删除已灌入到服务平台上的脚本/.test(html), '设置页说明写清只删本地库')
ok(/app\.js\?v=(\d+)/.test(html) && Number(/app\.js\?v=(\d+)/.exec(html)[1]) >= 48, 'app.js 缓存戳已 bump')
ok(/web-bridge\.js\?v=(\d+)/.test(html) && Number(/web-bridge\.js\?v=(\d+)/.exec(html)[1]) >= 47,
  'web-bridge.js 缓存戳已 bump')
ok(pkg.scripts.test.includes('delete-sources.test.js'), '本测试已注册进 npm test')

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\ndelete-sources.test.js: PASS ${pass} / FAIL 0`)
