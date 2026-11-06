'use strict'
/** v1.10.0 网页音源站采集（core/websource.js）：链接提取 + isWebRepo */
const assert = require('assert')
const { extractJsLinks, isWebRepo } = require('../src/core/websource')

// isWebRepo：网址 vs owner/repo
assert.strictEqual(isWebRepo('https://zrcdy.dpdns.org/lx/vers.php'), true)
assert.strictEqual(isWebRepo('http://example.com/x.js'), true)
assert.strictEqual(isWebRepo('a/b'), false)
assert.strictEqual(isWebRepo(''), false)

// 链接提取：绝对/相对/带 query、去重、按 base 解析
const html = `
<div>
  <a href="https://zrcdy.dpdns.org/lx/xinghai-music-sourcev2.3.17.js">最新版</a>
  <a href="https://zrcdy.dpdns.org/lx/xinghai-music-sourcev2.3.16.js">上一版</a>
  <a href="https://zrcdy.dpdns.org/lx/xinghai-music-sourcev2.3.17.js">重复链接</a>
  <a href="/lx/relative-source.js">相对路径</a>
  <script src="/static/site.js?v=9"></script>
  <a href="mailto:x@y.z">信箱</a>
  <a href="/docs/readme.md">文档</a>
</div>`
const links = extractJsLinks(html, 'https://zrcdy.dpdns.org/lx/vers.php')
assert.strictEqual(links.length, 4, '绝对+相对+query 去重后 4 条（重复链接合并）')
const urls = links.map(l => l.url)
assert.ok(urls.includes('https://zrcdy.dpdns.org/lx/xinghai-music-sourcev2.3.17.js'))
assert.ok(urls.includes('https://zrcdy.dpdns.org/lx/relative-source.js'))
assert.ok(urls.includes('https://zrcdy.dpdns.org/static/site.js?v=9'))
// 名字解析
const latest = links.find(l => l.url.includes('v2.3.17'))
assert.strictEqual(latest.name, 'xinghai-music-sourcev2.3.17')

// 空输入
assert.strictEqual(extractJsLinks('', 'https://x.com/').length, 0)
assert.strictEqual(extractJsLinks('<p>无链接</p>', 'https://x.com/').length, 0)

console.log('websource.test.js：全部通过')
