'use strict'
/** v1.10.0 网页音源站采集（core/websource.js）：链接提取 + isWebRepo */
const assert = require('assert')
const { extractJsLinks, extractLinkMeta, isWebRepo } = require('../src/core/websource')

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

// v1.10.1 表格元数据解析：版本号列 + 更新时间列（模拟 zrcdy.dpdns.org/lx/vers.php 结构）
const tableHtml = `
<table>
  <tr><th>文件名</th><th>版本号</th><th>更新时间</th><th>操作</th></tr>
  <tr>
    <td><a href="https://zrcdy.dpdns.org/lx/xinghai-music-sourcev2.3.17.js">xinghai-music-sourcev2.3.17.js</a></td>
    <td>v3.2.17</td><td>2026-11-04 12:28</td>
    <td><a href="/lx/xinghai-music-sourcev2.3.17.js">下载</a> <button>复制地址</button></td>
  </tr>
  <tr>
    <td><a href="https://zrcdy.dpdns.org/lx/xinghai-music-sourcev3.2.6.js">xinghai-music-sourcev3.2.6.js</a></td>
    <td>v3.2.6</td><td>2026-10-20 09:00</td><td><a href="/lx/xinghai-music-sourcev3.2.6.js">下载</a></td>
  </tr>
</table>`
const meta = extractLinkMeta(tableHtml, 'https://zrcdy.dpdns.org/lx/vers.php')
const m17 = meta.get('https://zrcdy.dpdns.org/lx/xinghai-music-sourcev2.3.17.js')
assert.ok(m17, '表格行里的链接要能解析出元数据')
assert.strictEqual(m17.version, '3.2.17', '版本号取自版本列（不是文件名里的 2.3.17）')
assert.ok(m17.updatedAt >= Date.parse('2026-11-04') && m17.updatedAt < Date.parse('2026-11-05'), '更新时间取日期列')
const m26 = meta.get('https://zrcdy.dpdns.org/lx/xinghai-music-sourcev3.2.6.js')
assert.strictEqual(m26.version, '3.2.6')

console.log('websource.test.js：全部通过')
