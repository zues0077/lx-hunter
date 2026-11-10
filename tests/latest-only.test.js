'use strict'
/** v1.10.0「只收最新版」过滤（crawler.filterLatestOnly）+ 网址仓库规范化测试 */
const assert = require('assert')
const { filterLatestOnly, latestBaseName, versionNumOf, normalizeRepo } = require('../src/core/crawler')
const { cmpVersion } = require('../src/core/version')

// 版本号解析：2026-11-10 起统一为逐段零填充字符串键（src/core/version.js）。
// 旧断言是数值累加（v*1000 逐段），会碰撞 / 丢段，已按新口径改写。
assert.strictEqual(versionNumOf('xinghai-music-sourcev2.3.17.js'), '00000002.00000003.00000017.00000000')
assert.strictEqual(versionNumOf('HYWmusic_.V1.2.0'), '00000001.00000002.00000000.00000000')
assert.strictEqual(versionNumOf('no-version-here'), '')
assert.strictEqual(versionNumOf('源2'), '')

// S1 科学性复核：数值累加方案的三个已知缺陷必须在统一算法里消失
assert.ok(cmpVersion('v2.0', 'v1.9.9') > 0, 'v2.0 必须高于 v1.9.9（旧算法会反过来）')
assert.ok(cmpVersion('1.2.3.4.5', '1.2.3.4') > 0, '5 段版本号不能被截断')
assert.ok(cmpVersion('1.0.1.0', '1.0.0.1000') > 0, '段值 >=1000 不能与相邻段碰撞')
assert.strictEqual(cmpVersion('v2.0', 'v2.0.0'), 0, '补零段等价')
const f0 = filterLatestOnly([{ name: 'demo-v1.9.9.js' }, { name: 'demo-v2.0.js' }])
assert.strictEqual(f0.kept.length, 1)
assert.strictEqual(f0.kept[0].name, 'demo-v2.0.js', '只收最新版不能把 v2.0 丢掉、留 v1.9.9')
console.log('  ✓ S1：统一版本算法消除碰撞 / 丢段 / v2.0 被误判旧版')

// 组名归一化
assert.strictEqual(latestBaseName('xinghai-music-sourcev2.3.17.js'), 'xinghai-music-source')
assert.strictEqual(latestBaseName('Foo-Bar_v1.8.JS'), 'foo-bar')
assert.strictEqual(latestBaseName('test-v2.3.0'), 'test')

// vers.php 场景：同组多版本只留最高
const items = [
  { name: 'xinghai-music-sourcev2.3.15', url: 'a15' },
  { name: 'xinghai-music-sourcev2.3.17', url: 'a17' },
  { name: 'xinghai-music-sourcev2.3.16', url: 'a16' },
  { name: 'xinghai-music-source.js', url: 'a00' }   // 无版本号 → 也算同组，版本 0，被 2.3.17 淘汰
]
const f1 = filterLatestOnly(items)
assert.strictEqual(f1.kept.length, 1)
assert.strictEqual(f1.kept[0].url, 'a17')
assert.strictEqual(f1.dropped.length, 3)

// 后缀风格：-v1.8 / _v1.0.0
const f2 = filterLatestOnly([
  { name: 'foo-v1.7' }, { name: 'foo_v1.8' }, { name: 'foo-v1.10' }
])
assert.strictEqual(f2.kept.length, 1, '1.10 应高于 1.8（按数字逐段比较）')
assert.strictEqual(f2.kept[0].name, 'foo-v1.10')

// 全组无版本号 → 全保留
const f3 = filterLatestOnly([{ name: 'abc' }, { name: 'abc' }])
assert.strictEqual(f3.kept.length, 2)

// 弱名（剥完版本号为空/过短）→ 全保留
const f4 = filterLatestOnly([{ name: 'v1.2' }, { name: 'v1.3' }, { name: '6-v2.0' }])
assert.strictEqual(f4.kept.length, 3, 'v1.2/v1.3/6 剥完版本号后组名为空或过短，不能误杀')

// 不同组互不影响
const f5 = filterLatestOnly([{ name: 'aaa-v1.0' }, { name: 'bbb-v1.0' }])
assert.strictEqual(f5.kept.length, 2)

// normalizeRepo：网址放行（GitHub 归一化，其他原样）
assert.strictEqual(normalizeRepo('https://zrcdy.dpdns.org/lx/vers.php'), 'https://zrcdy.dpdns.org/lx/vers.php')
assert.strictEqual(normalizeRepo('https://github.com/a/b/tree/main'), 'a/b')
assert.strictEqual(normalizeRepo('git@github.com:a/b.git'), 'a/b')
assert.strictEqual(normalizeRepo('a/b'), 'a/b')
assert.strictEqual(normalizeRepo(''), null)

// v1.10.1 关键修正：文件名版本不可信（v2.3.17.js 实际是 v3.2.17），显式版本号优先
const f6 = filterLatestOnly([
  { name: 'xinghai-music-sourcev3.2.6', version: '3.2.6' },
  { name: 'xinghai-music-sourcev2.3.17', version: '3.2.17' },   // 站点表格标注的真实版本
  { name: 'xinghai-music-sourcev2.3.16', version: '3.2.16' }
])
assert.strictEqual(f6.kept.length, 1)
assert.strictEqual(f6.kept[0].name, 'xinghai-music-sourcev2.3.17', '显式版本 3.2.17 > 3.2.6，文件名不是判断依据')

// 都无版本号但有时间 → 更新时间新的赢
const f7 = filterLatestOnly([
  { name: 'foo', updatedAt: 1700000000000 },
  { name: 'foo', updatedAt: 1800000000000 }
])
assert.strictEqual(f7.kept[0].updatedAt, 1800000000000)

console.log('latest-only.test.js：全部通过')
