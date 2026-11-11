'use strict'
/**
 * v1.13.1：GitHub 配额优化的可验证部分
 *
 * 用户 2026-11-11：先对照代码评测，再决定做哪几项。评测结论是做 1/2/3/5，不做 4（pushed_at 会漏
 * release-only 仓库）和 6（hunter 根本没有 HTTP 5xx 重试）。
 *
 * 这里用**本地 HTTP 服务**真跑一遍，不 mock：
 *   - 第 1 项 ETag：304 时返回缓存内容、且不再解析 body（GitHub 规则：304 不计配额）
 *   - 第 3 项 404 记忆：3 天内跳过，过期后重探，恢复后自动回来
 *   - 第 5 项 分支快捷路径：给了 branch 就不再请求 /repos/{repo}（每仓库省 1 次配额）
 */
const assert = require('assert')
const http = require('http')
const { ghGetJson, filterDeadRepos, DEAD_REPO_TTL_MS } = require('../src/core/crawler')

let pass = 0
function ok(name) { pass++; console.log('  ✓ ' + name) }

function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler)
    srv.listen(0, '127.0.0.1', async () => {
      const port = srv.address().port
      try { await fn('http://127.0.0.1:' + port) } catch (e) { reject(e) } finally { srv.close() }
      resolve()
    })
  })
}

async function main() {
  console.log('== 1. ETag / 304（304 不计入 GitHub 配额） ==')
  await withServer((req, res) => {
    const etag = '"abc"'
    req.__hits = (req.__hits || 0) + 1
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag })
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag })
    res.end(JSON.stringify([{ sha: 'x1' }]))
  }, async (base) => {
    const url = base + '/repos/a/b/releases?per_page=5'
    const r1 = await ghGetJson(url, '', 5000)
    assert.strictEqual(r1.ok, true)
    assert.strictEqual(r1.notModified, false)
    assert.deepStrictEqual(r1.json, [{ sha: 'x1' }])

    const r2 = await ghGetJson(url, '', 5000)
    assert.strictEqual(r2.notModified, true, '第二次带 If-None-Match → 304')
    assert.deepStrictEqual(r2.json, r1.json, '304 时用缓存内容，不重复解析')
    ok('200 → 存 ETag；再次请求命中 304 并复用缓存')

    const r3 = await ghGetJson(base + '/other', '', 5000)
    assert.strictEqual(r3.notModified, false, '不同 URL 不串缓存')
  })

  console.log('\n== 3. 404 仓库记忆（3 天内跳过） ==')
  {
    const now = 1794400000000
    const dead = { 'a/gone': { at: now - 3600 * 1000, hits: 2 } }
    const r = filterDeadRepos(['a/gone', 'a/alive'], dead, now)
    assert.deepStrictEqual(r.keep, ['a/alive'])
    assert.deepStrictEqual(r.skipped, ['a/gone'])
    ok('TTL 内的 404 仓库被跳过，活的照常探')

    const old = filterDeadRepos(['a/gone'], dead, now + DEAD_REPO_TTL_MS + 1000)
    assert.deepStrictEqual(old.keep, ['a/gone'], '过期后允许重探（组织改名/恢复后能自己回来）')
    ok('超过 TTL 自动重探')

    const none = filterDeadRepos(['b/x'], null, now)
    assert.deepStrictEqual(none.keep, ['b/x'])
    assert.deepStrictEqual(none.skipped, [])
    ok('没有死亡名单时原样放行')
  }

  console.log('\n== 5. 验真分支快捷路径（省掉 /repos 那次请求） ==')
  {
    // 直接读源码做结构断言：给了 branch 时不能再发 /repos/{repo} 请求
    const fs = require('fs')
    const path = require('path')
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'crawler.js'), 'utf8')
    const fn = src.slice(src.indexOf('async function verifyRepoHasSource'), src.indexOf('async function verifyRepoHasSource') + 1600)
    assert.ok(/let branch = String\(\(o && o\.branch\) \|\| ''\)\.trim\(\)/.test(fn), '先取调用方给的分支')
    assert.ok(/if \(!branch\) \{[\s\S]*?api\.github\.com\/repos\/\$\{repo\}`\)/.test(fn), '只有缺失分支时才请求 /repos')
    ok('有 branch 就跳过 /repos/{repo}，每候选仓库省 1 次配额')
  }

  console.log(`\n全部通过（${pass} 项）`)
}

main().catch(e => { console.error(e); process.exit(1) })
