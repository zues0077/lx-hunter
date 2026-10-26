/**
 * v1.9.18 社区精选订阅（parseCommunityFeed / fetchCommunityRepos）回归测试。
 *  - 解析：schema 字段、type=repo 提取、page/js 忽略、去重、URL 形态规范化
 *  - 容错：非法 JSON、缺 sources、空清单、repo 字段缺失
 *  - 拉取：crawlFetch 走全局 fetch 桩（镜像链第一条命中），失败抛错由调用方降级
 * 用真实 feed（zlyon/lx-hunter-market/data/community.json）的精简样例，无需联网。
 */
const { parseCommunityFeed, fetchCommunityRepos, COMMUNITY_FEED_URL } = require('../src/core/community')

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }

// 真实 feed 精简样例（2026-10-20 版，16 条里挑代表性 5 条）
const REAL_SAMPLE = {
  schema: 1,
  updatedAt: '2026-10-20T03:42:47.231Z',
  count: 5,
  sources: [
    { name: 'pdone/lx-music-source', url: 'https://github.com/pdone/lx-music-source', repo: 'pdone/lx-music-source', type: 'repo', submitter: 'zlyon', issue: 2, approvedAt: '2026-10-17T15:01:14Z', stats: { usable: 2, source: 18, jsTotal: 26 } },
    { name: 'Qian-Ning/LX-Music-Source', url: 'https://github.com/Qian-Ning/LX-Music-Source', repo: 'Qian-Ning/LX-Music-Source', type: 'repo', submitter: 'zlyon', issue: 2, approvedAt: '2026-10-17T15:01:14Z', stats: { usable: 2, source: 13, jsTotal: 13 } },
    { name: 'zrcdy.dpdns.org', url: 'https://zrcdy.dpdns.org/', repo: '', type: 'page', submitter: 'chrisdong', issue: 3, approvedAt: '2026-10-20T01:43:07Z', stats: { usable: 0, source: 0, jsTotal: 1 } },
    { name: '星澜聚合音源 stellarwave-v4.0.0', url: 'https://github.com/lick563/Xinglan-aggregate-sound-sources/releases/download/4.0.0/stellarwave-v4.0.0.js', repo: 'lick563/Xinglan-aggregate-sound-sources', type: 'js', submitter: 'chrisdong', issue: 3, approvedAt: '2026-10-20T02:59:52Z', stats: { usable: 1, source: 1, jsTotal: 1 } },
    { name: 'cdyUuu/lx-music-xinghai-source', url: 'https://github.com/cdyUuu/lx-music-xinghai-source', repo: 'cdyUuu/lx-music-xinghai-source', type: 'repo', submitter: 'chrisdong', issue: 3, approvedAt: '2026-10-20T01:43:07Z', stats: { usable: 2, source: 3, jsTotal: 3, via: 'tree' } }
  ]
}

;(async () => {
  // ---------- 解析：真实样例 ----------
  const r = parseCommunityFeed(JSON.stringify(REAL_SAMPLE))
  ck('真实样例：解析成功', r.ok === true)
  ck('真实样例：只提取 type=repo 的 3 条', r.repos.length === 3, JSON.stringify(r.repos))
  ck('真实样例：page/js 类型不进仓库列表', !r.repos.some(x => /zrcdy|Xinglan/i.test(x)))
  ck('真实样例：updatedAt 透传', r.updatedAt === '2026-10-20T03:42:47.231Z')
  ck('真实样例：total=原始条目数', r.total === 5)

  // ---------- 解析：规范化与去重 ----------
  const messy = {
    schema: 1, updatedAt: '2026-10-20T00:00:00.000Z',
    sources: [
      { repo: 'https://github.com/A/B.git', type: 'repo' },
      { repo: 'https://github.com/a/b/tree/main', type: 'repo' },   // 同仓库不同写法 → 去重
      { repo: 'git@github.com:C/D.git', type: 'repo' },
      { repo: '', type: 'repo' },                                    // 空 repo → 排除
      { repo: 'not a repo', type: 'repo' },                          // 规范化失败 → 排除
      { type: 'repo' },                                              // 无 repo 字段 → 排除
      { repo: 'E/F' }                                                // 缺 type → 排除（防御：非 repo 类不收）
    ]
  }
  const r2 = parseCommunityFeed(JSON.stringify(messy))
  ck('规范化：URL/.git/树链接都归一为 owner/repo', r2.repos.includes('A/B') && r2.repos.includes('C/D'), JSON.stringify(r2.repos))
  ck('去重：同一仓库不同写法只留一条', r2.repos.filter(x => /^a\/b$/i.test(x)).length === 1)
  ck('防御：空/非法/缺 type 条目全部排除', r2.repos.length === 2, JSON.stringify(r2.repos))

  // ---------- 解析：容错 ----------
  const e1 = parseCommunityFeed('not json at all')
  ck('容错：非法 JSON 返回 ok=false', e1.ok === false && /JSON/.test(e1.error))
  const e2 = parseCommunityFeed('{"schema":1}')
  ck('容错：缺 sources 数组返回 ok=false', e2.ok === false && /sources/.test(e2.error))
  const e3 = parseCommunityFeed('{"schema":1,"sources":[]}')
  ck('容错：空清单 ok=true 且 repos 为空', e3.ok === true && e3.repos.length === 0)
  const e4 = parseCommunityFeed('')
  ck('容错：空文本按非法 JSON 处理', e4.ok === false)

  // ---------- 拉取：fetch 桩走候选链 ----------
  const originFetch = globalThis.fetch
  let asked = 0
  globalThis.fetch = async (url) => {
    asked++
    const u = String(url)
    if (u.includes('community.json')) {
      return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(REAL_SAMPLE) }
    }
    return { ok: false, status: 404, headers: new Map(), text: async () => '' }
  }
  try {
    const f1 = await fetchCommunityRepos({ timeoutMs: 5000 })
    ck('拉取：官方 feed 地址拉到 repo 列表', f1.ok === true && f1.repos.length === 3, JSON.stringify(f1.repos || []))
    ck('拉取：默认走内置官方订阅地址', asked >= 1)
    const f2 = await fetchCommunityRepos({ timeoutMs: 5000 })
    ck('拉取：30 分钟缓存内不重复请求', asked === 1, 'asked=' + asked)
    // 自定义订阅地址独立缓存
    const f3 = await fetchCommunityRepos({ timeoutMs: 5000, communityFeedUrl: 'https://example.com/my-community.json' })
    ck('拉取：自定义 communityFeedUrl 生效', f3.ok === true && f3.repos.length === 3)
  } finally {
    globalThis.fetch = originFetch
  }

  // ---------- 拉取：网络失败抛错（调用方记 warn 降级） ----------
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  try {
    try {
      await fetchCommunityRepos({ timeoutMs: 3000, communityFeedUrl: 'https://unreachable.example.com/x.json' })
      ck('拉取失败：应抛错而非静默返回', false)
    } catch (e) {
      ck('拉取失败：抛错且信息可读', /拉取失败|不可达|ECONNREFUSED/i.test(String(e.message)), e.message)
    }
  } finally {
    globalThis.fetch = originFetch
  }

  // ---------- 常量 ----------
  ck('常量：默认订阅地址指向 lx-hunter-market', COMMUNITY_FEED_URL === 'https://raw.githubusercontent.com/zlyon/lx-hunter-market/main/data/community.json')

  console.log(bad ? `\n${bad} FAILED` : '\nALL PASS')
  process.exit(bad ? 1 : 0)
})()
