'use strict'
/** 社区精选订阅（v1.9.18，借鉴 lx-hub 的 fetchMarketList / community.json）：
 *  数据源 zlyon/lx-hunter-market 维护的 data/community.json —— 社区提交、维护者人工审核
 *  （sources[].submitter / issue / approvedAt）的精选清单。sources[].type 分三类：
 *   - repo：GitHub 音源仓库（owner/repo），直接并入种子爬取（人工审核过，跳过内容验真省配额）
 *   - page：聚合页 URL（如 zrcdy.dpdns.org），lx-hub 侧用于前端展示，本工具爬取管道暂不消费
 *   - js  ：直链脚本（多为 release 资产），后续可接「种子直链」通道，本轮不消费
 *  拉取走 crawlFetch（直连 → 前缀镜像链）：raw.githubusercontent.com 直连不通的环境也能拿到。
 *  结果带 30 分钟内存缓存；拉取/解析失败抛错由调用方记 warn，绝不中断爬取流程——
 *  种子仍按原清单跑，社区精选永远只是增量补充。
 */
const { crawlFetch, readText } = require('./net')
const { normalizeRepo } = require('./crawler')

const COMMUNITY_FEED_URL = 'https://raw.githubusercontent.com/zlyon/lx-hunter-market/main/data/community.json'
const CACHE_MS = 30 * 60 * 1000
// 模块级缓存按 URL 区分（用户自定义 communityFeedUrl 与官方地址互不串）
const cache = new Map() // url -> { at, result }

/**
 * 解析 feed 文本（纯函数，便于测试）。
 * @param {string} text feed JSON 文本
 * @param {function} [normFn] 仓库规范化函数（默认 crawler.normalizeRepo，测试可注入）
 * @returns {{ok:boolean, repos:string[], total:number, updatedAt:string, error:string}}
 *  repos 为去重后的 owner/repo 列表（仅 type=repo 且规范化成功的条目）。
 */
function parseCommunityFeed(text, normFn) {
  const norm = normFn || normalizeRepo
  let j
  try { j = JSON.parse(String(text || '')) } catch (e) {
    return { ok: false, repos: [], total: 0, updatedAt: '', error: 'feed 不是合法 JSON' }
  }
  if (!j || !Array.isArray(j.sources)) {
    return { ok: false, repos: [], total: 0, updatedAt: '', error: 'feed 缺少 sources 数组' }
  }
  const seen = new Set()
  const repos = []
  for (const s of j.sources) {
    if (!s || s.type !== 'repo') continue
    const n = norm(s.repo || '')
    // GitHub 仓库大小写不敏感：A/B.git 与 a/b/tree/main 是同一仓库，按小写键去重，
    // 输出保留 feed 里第一次出现的写法
    const key = n ? n.toLowerCase() : ''
    if (!key || seen.has(key)) continue
    seen.add(key)
    repos.push(n)
  }
  return { ok: true, repos, total: j.sources.length, updatedAt: String(j.updatedAt || '') }
}

/**
 * 拉取社区精选 feed（30 分钟缓存）。
 * @param {object} cfg 配置（communityFeedUrl 自定义订阅源、timeoutMs、mirror 镜像链）
 * @returns {{ok:boolean, repos:string[], total:number, updatedAt:string, error?:string}}
 * @throws 网络失败时抛错（HTTP 状态 / 不可达），由调用方降级处理
 */
async function fetchCommunityRepos(cfg) {
  const url = String((cfg && cfg.communityFeedUrl) || '').trim() || COMMUNITY_FEED_URL
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result
  const timeoutMs = Number(cfg && cfg.timeoutMs) || 15000
  const dl = await crawlFetch(url, null, timeoutMs, cfg && cfg.mirror)
  if (!dl || !dl.res || !dl.res.ok) {
    throw new Error('feed 拉取失败 ' + (dl && dl.res ? 'HTTP ' + dl.res.status : '（全部线路不可达）'))
  }
  const text = await readText(dl.res, timeoutMs)
  const result = parseCommunityFeed(text)
  if (result.ok) cache.set(url, { at: Date.now(), result })
  return result
}

module.exports = { COMMUNITY_FEED_URL, parseCommunityFeed, fetchCommunityRepos }
