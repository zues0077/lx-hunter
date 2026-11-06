'use strict'
/** v1.10.0 私人音源：入库（store.addPrivateSource）+ 去重/巡检保护（hunter） */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Store } = require('../src/core/store')
const { Hunter } = require('../src/core/hunter')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-private-'))
const store = new Store(dir)
const hunter = new Hunter(store, () => {})

// ① 入库：private 标记 + id 约定 + scoreEntry 过滤
const code1 = fs.readFileSync(path.join(__dirname, 'fixtures', '_real_小熊猫音源1.1.2.js'), 'utf8')
const r1 = store.addPrivateSource('我的私人音源.js', code1)
assert.strictEqual(r1.added, true)
assert.strictEqual(r1.entry.private, true)
assert.strictEqual(r1.entry.id, 'private::我的私人音源')
assert.strictEqual(r1.entry.repo, '私人音源')
assert.ok(r1.entry.contentHash)
assert.strictEqual(r1.entry.status, 'unknown')
assert.ok(r1.entry.suspected, '标准音源脚本应被判为疑似/像音源（score>=4）')

// ② 重复导入 = 更新：hash 变化、检测结果重置、addedAt 保留
r1.entry.deep = { checkedAt: 123, hash: r1.entry.contentHash }
r1.entry.usable = true
store.saveDb()
const r2 = store.addPrivateSource('我的私人音源.js', code1.replace('v1.0.0', 'v2.0.0'))
assert.strictEqual(r2.updated, true)
assert.strictEqual(r2.entry.usable, false)
assert.strictEqual(r2.entry.deep, null)
assert.ok(Math.abs(r2.entry.addedAt - r1.entry.addedAt) < 50, 'addedAt 应保留首次导入时间')

// ③ 去重保护：私人源不参与去重（与爬取库同内容/同名也不会被废弃）
const crawled = {
  id: 'foo/bar::我的私人音源.js', repo: 'foo/bar', path: '我的私人音源.js',
  url: 'https://raw.githubusercontent.com/foo/bar/HEAD/xxx.js', name: '我的私人音源',
  code: code1, contentHash: r2.entry.contentHash,
  status: 'ok', suspected: true, usable: false, size: code1.length,
  addedAt: Date.now(), lastCheck: 0, deep: null
}
store.db.sources[crawled.id] = crawled
hunter.dedupe()
assert.ok(!store.db.sources[r2.entry.id].deprecated, '私人源绝不因同内容/同名被废弃')

// ③b 对照组：两个「非私人」同内容条目仍会被正常去重（保护不放大化）
const c1 = Object.assign({}, crawled, { id: 'x/y::a.js', name: '同内容源', private: false })
const c2 = Object.assign({}, crawled, { id: 'x/y::b.js', name: '同内容源' })
store.db.sources[c1.id] = c1
store.db.sources[c2.id] = c2
const dup = hunter.dedupe()
assert.ok(dup.dupContent >= 1, '非私人同内容项照常废弃')

// ④ 巡检「自动删除」阈值函数不变（私人源豁免在 runPatrol 的 !e.private 守卫里）
const { patrolAutoDeleteWanted } = require('../src/core/hunter')
assert.strictEqual(patrolAutoDeleteWanted({ patrolAutoDelete: true, patrolDeleteAfter: 1 }, 3), true)
assert.strictEqual(patrolAutoDeleteWanted({ patrolAutoDelete: false }, 3), false)

// ⑤ 空文本/超限拒绝
assert.throws(() => store.addPrivateSource('x.js', '   '), /脚本文本为空/)

fs.rmSync(dir, { recursive: true, force: true })
console.log('private-source.test.js：全部通过')
