/**
 * v1.9.9 搜索发现（discoverReposViaSearch）+ 探针固化（applyProbeRecord）回归测试。
 *  - 搜索发现：关键词搜索新仓库、跳过已知、上限/star 门槛、限流不抛错
 *  - 探针固化：validTier(confirmed/probable/rejected) + probe.status + probeFailStreak 累积/清零
 * 用全局 fetch 桩模拟 GitHub 搜索 API，无需联网。
 */
const { discoverReposViaSearch } = require('../src/core/crawler')
const { applyProbeRecord } = require('../src/core/checker')

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }

function mockFetch(items, failMessage) {
  return async (url) => {
    const u = String(url)
    if (/search\/repositories/.test(u)) {
      if (failMessage) return { ok: true, text: async () => JSON.stringify({ message: failMessage }) }
      return { ok: true, text: async () => JSON.stringify({ total_count: (items || []).length, items: items || [] }) }
    }
    return { ok: true, text: async () => '{}' }
  }
}
function mkDeep({ loadable = true, cancelled = false, platforms = {}, loadError = null, declaredSources = null, checkedAt = 1 } = {}) {
  return { loadable, cancelled, loadError, platforms, declaredSources, checkedAt }
}

;(async () => {
  // ---------- 搜索发现 ----------
  const items = [
    { full_name: 'newrepo/abc', stargazers_count: 12 },
    { full_name: 'guoyue2010/lxmusic-', stargazers_count: 99 }, // 已知 -> 跳过
    { full_name: 'another/xyz', stargazers_count: 5 }
  ]
  globalThis.fetch = mockFetch(items)
  const r = await discoverReposViaSearch({ keywords: ['lx 音源'], known: new Set(['guoyue2010/lxmusic-']), maxReposPerKeyword: 20, maxTotal: 60, timeoutMs: 5000 })
  ck('搜索发现：跳过已知仓库，返回 2 个', r.repos.length === 2, r.repos.join(','))
  ck('搜索发现：不含已知仓库', !r.repos.includes('guoyue2010/lxmusic-'))
  ck('搜索发现：perKeyword.added=2', r.perKeyword['lx 音源'] && r.perKeyword['lx 音源'].added === 2)

  globalThis.fetch = mockFetch(Array.from({ length: 10 }, (_, i) => ({ full_name: `repo${i}/s${i}`, stargazers_count: 1 })))
  const r2 = await discoverReposViaSearch({ keywords: ['lx 音源'], known: new Set(), maxReposPerKeyword: 20, maxTotal: 3, timeoutMs: 5000 })
  ck('搜索发现：maxTotal 上限生效', r2.repos.length === 3, 'got ' + r2.repos.length)

  const items3 = [
    { full_name: 'low/star', stargazers_count: 1 },
    { full_name: 'high/star', stargazers_count: 50 },
    { full_name: 'mid/star', stargazers_count: 10 }
  ]
  globalThis.fetch = mockFetch(items3)
  const r3 = await discoverReposViaSearch({ keywords: ['lx 音源'], known: new Set(), maxReposPerKeyword: 20, maxTotal: 60, timeoutMs: 5000, skipStarsBelow: 10 })
  ck('搜索发现：star 门槛过滤低星', r3.repos.length === 2 && r3.repos.includes('high/star') && r3.repos.includes('mid/star') && !r3.repos.includes('low/star'), r3.repos.join(','))

  const r4 = await discoverReposViaSearch({ keywords: [], known: new Set() })
  ck('搜索发现：空关键词返回空', r4.repos.length === 0)

  globalThis.fetch = mockFetch(null, { failMessage: 'API rate limit exceeded' })
  const r5 = await discoverReposViaSearch({ keywords: ['lx 音源'], known: new Set() })
  ck('搜索发现：限流被记录为 error 且不抛错', r5.perKeyword['lx 音源'] && r5.perKeyword['lx 音源'].error && r5.repos.length === 0)

  // ---------- 探针固化 ----------
  const e1 = { suspected: true, contentHash: 'h1' }
  applyProbeRecord(e1, mkDeep({ platforms: { wy: { status: 'usable' }, tx: { status: 'failed' } } }))
  ck('探针：可用 -> confirmed', e1.validTier === 'confirmed', e1.validTier)
  ck('探针：可用 -> status=usable', e1.probe.status === 'usable')
  ck('探针：可用 -> failStreak 清零', e1.probeFailStreak === 0)

  const e2 = { suspected: true }
  applyProbeRecord(e2, mkDeep({ platforms: { wy: { status: 'failed', message: 'fetch 失败' } } }))
  ck('探针：网络失败 -> degraded', e2.probe.status === 'degraded', e2.probe.status)
  ck('探针：网络失败 -> probable', e2.validTier === 'probable', e2.validTier)
  ck('探针：网络失败 -> failStreak+1', e2.probeFailStreak === 1)

  const e3 = { suspected: false }
  applyProbeRecord(e3, mkDeep({ loadable: false, loadError: '脚本未调用 lx.send', platforms: {} }))
  ck('探针：不可加载 -> not_loadable', e3.probe.status === 'not_loadable')
  ck('探针：非音源 -> rejected', e3.validTier === 'rejected', e3.validTier)

  const e4 = { suspected: true, probeFailStreak: 2 }
  applyProbeRecord(e4, mkDeep({ platforms: { wy: { status: 'failed', message: 'HTTP 404' } } }))
  ck('探针：失败累积 failStreak=3', e4.probeFailStreak === 3, 'got ' + e4.probeFailStreak)
  const e4b = { suspected: true, probeFailStreak: 3 }
  applyProbeRecord(e4b, mkDeep({ platforms: { wy: { status: 'usable' } } }))
  ck('探针：恢复可用 failStreak 清零', e4b.probeFailStreak === 0)

  const e5 = { suspected: true }
  applyProbeRecord(e5, undefined)
  ck('探针：无深检 -> untested', e5.probe.status === 'untested', e5.probe.status)
  ck('探针：无深检且疑似 -> probable', e5.validTier === 'probable')

  if (bad) { console.error(`\n${bad} 个断言失败`); process.exit(1) }
  console.log('\n全部通过')
})()
