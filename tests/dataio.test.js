'use strict'
/**
 * dataio（数据导入/导出）单测：不落盘、不联网，直接对合并逻辑断言。
 * 覆盖：仓库合并去重 / 采集站合并保留本地统计 / 镜像池合并保留本地实测 + 恢复选择 / 非法输入拒绝。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { buildExport, importData, mergeRepos, mergeHubs } = require('../src/core/dataio')

// ---- 最小 Store 桩：只实现 dataio 用到的面 ----
function makeStore(cfg) {
  return {
    config: JSON.parse(JSON.stringify(cfg)),
    saveConfig(patch) { this.config = Object.assign(this.config, patch); return true }
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-dataio-'))
const store = makeStore({
  repos: [
    { repo: 'Existing/One', enabled: true, builtin: true, origin: 'builtin' },
    { repo: 'disabled/repo', enabled: false, builtin: false, origin: 'custom' }
  ],
  hubs: [
    { id: 'hub-a', name: '站点A', url: 'https://a.example.com', enabled: true, lastSync: 123, addedAt: 1 }
  ],
  mirror: 'auto',
  mirrorCustom: '',
  mirrorPool: [
    { id: 'm-gh-proxy-org', label: 'https://gh-proxy.org', base: 'https://gh-proxy.org', ms: 400, lastOk: 42, failStreak: 1, enabled: true }
  ]
})

// 1) 导出结构
for (const scope of ['repos', 'hubs', 'mirrors']) {
  const d = buildExport(store, scope)
  assert.strictEqual(d.app, 'lx-hunter-pc')
  assert.strictEqual(d.kind, 'lx-hunter-data')
  assert.strictEqual(d.scope, scope)
}
assert.strictEqual(buildExport(store, 'repos').repos.length, 2)
assert.strictEqual(buildExport(store, 'mirrors').mirrorPool.length, 1)
let threw = false
try { buildExport(store, 'bogus') } catch (e) { threw = true }
assert.ok(threw, '未知 scope 必须抛错')

// 2) 仓库合并：规范化 URL、去重（大小写不敏感）、enabled 以导入为准、本地 builtin 保留
const r1 = mergeRepos(store.config.repos, [
  { repo: 'https://github.com/new/Repo', enabled: true },
  { repo: 'existing/one', enabled: false },          // 同仓库：不新增，只更新 enabled
  { repo: 'not a repo !!' },                          // 非法：跳过
  { repo: 'disabled/repo', enabled: true }            // 同仓库：恢复启用
])
assert.strictEqual(r1.added, 1, '只新增 1 个')
assert.strictEqual(r1.updated, 2, '更新 2 个的 enabled')
assert.strictEqual(r1.list.length, 3)
const ex = r1.list.find(x => x.repo.toLowerCase() === 'existing/one')
assert.strictEqual(ex.enabled, false)
assert.strictEqual(ex.builtin, true, '本地 builtin 标记不丢')
const dr = r1.list.find(x => x.repo === 'disabled/repo')
assert.strictEqual(dr.enabled, true)

// 3) 采集站合并：按 url 去重、保留本地 lastSync/id
const r2 = mergeHubs(store.config.hubs, [
  { url: 'https://a.example.com/', enabled: false },  // 同站：只更新启停
  { url: 'https://b.example.com', name: '站点B' }      // 新站
])
assert.strictEqual(r2.added, 1)
assert.strictEqual(r2.updated, 1)
assert.strictEqual(r2.list.length, 2)
const ha = r2.list.find(h => h.url === 'https://a.example.com')
assert.strictEqual(ha.lastSync, 123, '本地采集统计不丢')
assert.strictEqual(ha.enabled, false)
const hb = r2.list.find(h => h.url === 'https://b.example.com')
assert.ok(hb.id, '新站自动生成 id')

// 4) 镜像池合并（importData 全流程）：同 id 保留本地实测，新增恢复 mirror 选择
const store2 = makeStore(JSON.parse(JSON.stringify(store.config)))
const s4 = importData(store2, 'mirrors', {
  kind: 'lx-hunter-data',
  mirror: 'm-gh-proxy-org',
  mirrorCustom: 'https://my.example.com',
  mirrorPool: [
    { id: 'm-gh-proxy-org', base: 'https://gh-proxy.org', ms: 999, enabled: true }, // 同 id：本地 ms=400 优先
    { id: 'm-new-one', base: 'https://new.example.com', ms: 700, enabled: true }
  ]
})
assert.strictEqual(s4.added, 1)
assert.strictEqual(store2.config.mirrorPool.length, 2)
const kept = store2.config.mirrorPool.find(m => m.id === 'm-gh-proxy-org')
assert.strictEqual(kept.ms, 400, '本地实测耗时不被导入值覆盖')
assert.strictEqual(kept.failStreak, 1, '本地失败计数不丢')
assert.strictEqual(store2.config.mirror, 'm-gh-proxy-org', '镜像选择被恢复')
assert.strictEqual(store2.config.mirrorCustom, 'https://my.example.com')

// 5) 非法输入
threw = false
try { importData(store2, 'nope', {}) } catch (e) { threw = true }
assert.ok(threw, '未知 scope 拒绝')
threw = false
try { importData(store2, 'repos', null) } catch (e) { threw = true }
assert.ok(threw, '空数据拒绝')
threw = false
try { importData(store2, 'repos', { kind: 'other-app' }) } catch (e) { threw = true }
assert.ok(threw, '非本工具导出文件拒绝')

// 6) net.buildCandidates 支持直接选用镜像池里的镜像
const net = require('../src/core/net')
net.applyConfig({ mirrorPool: [{ id: 'm-pool-x', label: 'https://pool.example.com', base: 'https://pool.example.com', enabled: true }] })
const cands = net.buildCandidates('https://raw.githubusercontent.com/o/r/main/a.js', 'm-pool-x')
assert.ok(cands.some(c => c.id === 'm-pool-x' && c.url.startsWith('https://pool.example.com/')),
  '选中池内镜像时应生成对应候选 URL')

fs.rmSync(tmp, { recursive: true, force: true })
console.log('dataio.test: all assertions passed')
