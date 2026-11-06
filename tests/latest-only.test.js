'use strict'
/** v1.10.0「只收最新版」过滤（crawler.filterLatestOnly）+ 网址仓库规范化测试 */
const assert = require('assert')
const { filterLatestOnly, latestBaseName, versionNumOf, normalizeRepo } = require('../src/core/crawler')

// 版本号解析
assert.strictEqual(versionNumOf('xinghai-music-sourcev2.3.17.js'), 2 * 1000000 + 3 * 1000 + 17)
assert.strictEqual(versionNumOf('HYWmusic_.V1.2.0'), 1002000)
assert.strictEqual(versionNumOf('no-version-here'), 0)
assert.strictEqual(versionNumOf('源2'), 0)

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

console.log('latest-only.test.js：全部通过')
