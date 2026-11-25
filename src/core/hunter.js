'use strict'
/** 任务编排：爬取 / 检测 / 灌入 / 撤回 */
const crawlerMod = require('./crawler')
const { crawl, checkQuota, filterDeadRepos, DEFAULT_REPOS, setCrawlBlockPatterns, normalizeRepo, discoverReposViaSearch, verifyRepoHasSource, resolveRepoRename } = crawlerMod
const { crawlWebSite, isWebRepo, probeExternalSource, normalizeExternalUrl } = require('./websource')
const { fetchCommunityRepos } = require('./community')
const { collectFromHubs } = require('./hubfeed')
const { checkBasic, deepCheck, extractMeta, sha256Str, usableCount, stoppable, isLocalNetworkIssue, patrolJudge, obfuscationRisk, obfuscationTip, obfDomains, obfDomainVerdict, applyProbeRecord, probeApiHosts, apiDownVerdict, passedPlatforms, regressionJudge, probeTopTier, classifyQuarantineTrust, isProbeOnlyDeep } = require('./checker')
const { crawlFetch, readText, sleep, resolveHostIps } = require('./net')
// 阶段A：追更策略（纯规则，不接 AI），按 updateTip.msg 过滤纯催更/广告，供 _followUpdateTips 使用
const { shouldFollowUpdateTip } = require('./updateTipPolicy')
const { getActiveService, getService, getBatchImportAccounts, getIsolations, NO_ACCOUNT_ERR, resolveEnableAfterImport } = require('./services')
const { Store } = require('./store')
// 2026-11-10 科学性复核：版本算法 / 身份键 / 质量判据统一到单一来源，
// 不再各写一份（详见 src/core/version.js 顶部说明）。
const { versionKey: versionNum, cmpVersion, verLabel } = require('./version')
const { normName, candidateRepo, serverRepo, baseNameKey, pickHighestVersion, weakNameKey } = require('./identity')
// v1.13.0：服务端动作（禁用 / 单平台禁用 / 隔离 / 删除）→ 本地冻结标记，防止「删了又灌回来」
const { computeVeto, isFrozen, vetoReason, splitFrozen, VETO_PRIORITY, profileServerFleet, VETO_TYPES } = require('./serverVeto')
// v1.13.0：定时爬取的下次允许时间（配额 → 代理/镜像 → 指数退避，纯函数）
const { planNextCrawl, describeNextCrawl } = require('./crawlSchedule')
const { compareVerdict, describeQuality, profile: qualityProfile, compareImportQuality } = require('./quality')
// R9（v1.13.15）：追更链（updateTip.url）的出站域名校验。
// 复用 outbound-policy.js 的私网/回环判据（checkOutbound），不自写一套——
// 那里是「私网/回环硬阻断、普通域名只审计不阻断」的唯一来源。
const { checkOutbound, auditDomain, normalizeHost } = require('./outbound-policy')
// 2026-11-23 恶意源治理 + Q3 404 收敛的单一真值来源（纯函数，零副作用）
const maliciousGuard = require('./maliciousGuard')
const { guardImport, filterImportCandidates, isMaliciousHash, allGone } = maliciousGuard
// 静态情报（2026-11-24）：域名 IOC 观察模式（只审计不改行为）+ hash 永不信任硬否决
const { matchDomainIoc, MALICIOUS_API_DOMAINS } = maliciousGuard

/**
 * dupReason 取值（去重废弃原因）——**唯一来源**（v1.13.13）。
 *
 * 背景：这 6 个字符串原先散在 8 处硬编码（dedupe / 翻案 / runCheck 即时去重 / hash 分组 /
 * 不变量补写），措辞相近但含义不同，读代码时很难看出「哪个是哪个」。
 * 现在收敛成下面 4 个语义码，一处定义、多处引用。
 *
 * ⚠️ **这些字符串参与逻辑判断，不是纯展示文案。改字之前先看这里的依赖清单**：
 *
 *   SAME_CONTENT     '同内容重复'           ← hunter.js `sameContent = /同内容/`（判 dupOf 指向是否合规）
 *   SAME_REPO_NAME   '同仓库同名重复'        ← 不命中 /同内容/，走「同名」路径（允许跨 contentHash 指向）
 *   OLD_VERSION      '同名旧版本'            ← **没有人读**，纯展示
 *   OLD_VERSION_NEW  '同名旧版本（已有更新版本）'
 *        ← ① hunter.js:1467 **严格等值**：只有它才允许 dedupe ②b「保留方失效 → 翻案恢复旧版」
 *        ← ② hunter.js `/已有更新版本/` 正则：命中才改写为 OLD_VERSION_KEEPER_DEAD
 *        （所以改字必须保留「已有更新版本」这五个字，且不能改成别的括号写法）
 *   OLD_VERSION_KEEPER_DEAD  '同名旧版本（保留方已失效）'
 *        ← 只能由上面两条正则改写产出；生产无人读，tests/dedupe-invariant.test.js 断言 /保留方已失效/
 *   VERSION_DEAD     '同名版本（此版本已失效）'
 *        ← 生产无人读；tests/crawl-releases.test.js 等值断言、tests/dist-selfcheck.js 断言源码含此串
 *
 * 措辞口径（用户要求：界面大白话、日志留技术细节）：
 *   这几个字符串会**原样拼进**前端 tooltip（renderer/app.js mergeTip），所以它们本身必须是人话。
 *   「此版本已失效」「保留方已失效」这种半术语保留，是因为要区分两个方向（被废方失效 / 保留方失效），
 *   换成更口语的说法会让两个方向读起来一样，反而更糊涂。
 */
const DUP_REASON = {
  SAME_CONTENT: '同内容重复',
  SAME_REPO_NAME: '同仓库同名重复',
  OLD_VERSION: '同名旧版本',
  OLD_VERSION_NEW: '同名旧版本（已有更新版本）',
  OLD_VERSION_KEEPER_DEAD: '同名旧版本（保留方已失效）',
  VERSION_DEAD: '同名版本（此版本已失效）'
}

/**
 * 参与逻辑判断的**关键子串**，与上面的取值一一对应。
 *
 * 为什么要单独列：这些子串被 `indexOf` / 正则用来做分支判断（如「是不是同内容」、
 * 「是不是因为已有更新版本」）。如果散在各处写成中文字面量，一旦有人改 DUP_REASON
 * 里的措辞，判断就静默失效——不报错、不告警，只在某个条目该翻案没翻案时才看得出。
 * 集中在这里，改措辞时编译器帮不了你，但至少只有一处要改、且能一眼看到绑定关系。
 */
const DUP_REASON_MARK = {
  SAME_CONTENT: '同内容',      // SAME_CONTENT 独有，SAME_REPO_NAME 不含
  UPDATED: '已有更新版本'        // OLD_VERSION_NEW 独有
}

/**
 * 追更链入库条目的 id 前缀（v1.13.15 / R9）。
 *
 * 这类条目的**全部内容都来自不可信来源**：地址是沙箱里脚本自报的 updateUrl，
 * 文本是那个地址下载回来的东西，name/lxName 取自文本里的 @name（攻击者可控）。
 * 所以它在同名裁决里必须被当成「次等条目」——见 betterKeeper 顶部的 R9 硬规则。
 */
const UPDATE_URL_ID_PREFIX = 'updateurl::'

/** 这个条目是不是追更链拉回来的（不可信）条目 */
function isUpdateUrlEntry (e) {
  return !!(e && String(e.id || '').indexOf(UPDATE_URL_ID_PREFIX) === 0)
}

/**
 * 在「同名对决」的双方里挑出该保留的那一方（R9 硬规则的单一实现点）。
 *
 * 规则：**非追更链条目（真音源）无条件胜出**。
 *  - 双方都是真音源 → 返回 null（交给 betterKeeper 的版本/质量裁决）
 *  - 双方都是追更链条目 → 返回 null（同类相残，沿用原裁决）
 *  - 一真一追更 → 返回真音源那一方
 *
 * @param {object} a
 * @param {object} b
 * @returns {object|null} 该保留的那一方；null = 无硬规则倾向
 */
function preferRealSource (a, b) {
  const au = isUpdateUrlEntry(a), bu = isUpdateUrlEntry(b)
  if (au === bu) return null
  return au ? b : a
}


/**
 * 构建本次爬取的仓库种子列表（v1.9.12，纯函数便于测试）。
 * 优先用统一仓库清单 cfg.repos：只取 enabled 的（用户可单独禁用任一仓库，含内置）。
 * 未迁移（repos 非数组）时回退到旧逻辑（DEFAULT_REPOS + customRepos），保证兼容。
 * @param {object} cfg store.config
 * @returns {string[]} owner/repo 列表
 */
function buildRepoSeeds(cfg) {
  const c = cfg || {}
  const rl = Array.isArray(c.repos) ? c.repos : null
  let out
  if (rl) out = rl.filter(r => r && r.enabled !== false).map(r => normalizeRepo(r.repo)).filter(Boolean)
  else {
    out = DEFAULT_REPOS.slice()
    for (const r of (c.customRepos || [])) {
      const n = normalizeRepo(r)
      if (n && out.indexOf(n) === -1) out.push(n)
    }
  }
  // v1.11.0 站外分发源：与仓库清单并列的一类采集源（Pages / 自建域名 / 对象存储直链）。
  // URL 原样保留，由 isWebRepo 分流到 crawlWebSite；不放进 repos 是为了躲开
  // 「清理非音源仓库」的 GitHub 验真（URL 拼进 api.github.com/repos/… 必然 404 → 误删）。
  for (const s of (Array.isArray(c.externalSources) ? c.externalSources : [])) {
    if (!s || s.enabled === false || !s.url) continue
    const n = normalizeExternalUrl(s.url) || normalizeRepo(s.url)
    if (n && out.indexOf(n) === -1) out.push(n)
  }
  return out
}

/**
 * P1-2 仓库采集排序（纯函数，只改采集先后，不改判重/验真/时间窗）。
 *
 * score = 历史 usable 产出 + 新鲜度（仓内最新源 addedAt 越近越高）
 *         + hub 加权 − deadRepos.hits×权重。全部来自本地 db，0 新请求。
 *
 * 防饥饿（方案采纳前置条件，二者叠加）：
 *   ①冷启动保底分 = 当前有历史仓的中位数 score（无历史仓视为该分，不按 0）；
 *   ③每轮强制 N 名额（默认 2）轮转给「无历史产出」的新仓/未采过仓，排在有历史仓之前。
 * 这样即使老仓 score 都 >0，新仓每轮也必拿到采集机会，不会被永久压在队尾。
 *
 * @param {string[]} repos 已定稿的 owner/repo 或站点 URL
 * @param {object} ctx { sources, deadRepos, hubRepos, now, newQuota }
 * @returns {{ordered:string[], scores:object}}
 */
function rankRepoSeeds(repos, ctx) {
  const c = ctx || {}
  const now = Number(c.now) || Date.now()
  const sources = Array.isArray(c.sources) ? c.sources : []
  const dead = c.deadRepos && typeof c.deadRepos === 'object' ? c.deadRepos : {}
  const hub = c.hubRepos && typeof c.hubRepos === 'object' ? c.hubRepos : {}
  const norm = r => { try { return normalizeRepo(r) || String(r || '') } catch (e) { return String(r || '') } }

  // 按仓库聚合本地历史：产出数（usable）、最新入库时间（新鲜度代理）
  const stat = {}
  for (const e of sources) {
    const repo = e && e.repo ? norm(e.repo) : ''
    if (!repo) continue
    const s = stat[repo] || (stat[repo] = { usable: 0, latest: 0, total: 0 })
    s.total++
    if (e.usable === true) s.usable++
    const at = Number(e.addedAt) || 0
    if (at > s.latest) s.latest = at
  }
  const scored = repos.filter(r => stat[norm(r)] && stat[norm(r)].total > 0)
  const rawScore = r => {
    const k = norm(r), s = stat[k]
    if (!s) return null                              // 无历史仓：走保底/轮转，不按 0
    const freshness = s.latest ? Math.max(0, 30 - (now - s.latest) / 86400000) : 0 // 30 天内线性衰减
    const hubBonus = hub[k] ? 3 : 0
    const deadPenalty = Number(dead[k] && dead[k].hits) || 0
    return s.usable * 2 + freshness + hubBonus - deadPenalty * 2
  }
  // ①冷启动保底分 = 有历史仓 score 的中位数（无历史仓不入池）
  const histScores = scored.map(rawScore).filter(v => v !== null).sort((a, b) => a - b)
  const median = histScores.length
    ? histScores[Math.floor((histScores.length - 1) / 2)]
    : 0
  const finalScore = r => { const v = rawScore(r); return v === null ? median : v }

  const withSrc = repos.map((r, i) => ({ r, i, hasHist: !!(stat[norm(r)] && stat[norm(r)].total > 0) }))
  // 有历史的按 score 降序；同分按原顺序（稳定）。无历史的单独成组。
  const old = withSrc.filter(x => x.hasHist).sort((a, b) => finalScore(b.r) - finalScore(a.r) || a.i - b.i)
  const fresh = withSrc.filter(x => !x.hasHist).sort((a, b) => a.i - b.i)
  // ③每轮强制 N 名额轮转给新仓：把前 N 个无历史仓提到最前
  const quota = Math.max(0, Number(c.newQuota) || 2)
  const promote = fresh.slice(0, quota)
  const restFresh = fresh.slice(quota)
  const ordered = promote.concat(old, restFresh).map(x => x.r)
  const scores = {}
  for (const x of withSrc) scores[x.r] = finalScore(x.r)
  return { ordered, scores }
}

// 「弱文件名」：纯数字 / 通用名 / 过短。这类名字在不同目录下几乎必然是不同内容
// （实测 pdone/lx-music-source 的 ikun/6.js 与 lx/6.js 内容完全不同），
// 不能靠文件名跨目录判重，必须留给内容指纹去确认。
const WEAK_BASE_NAMES = new Set([
  'index', 'main', 'test', 'new', 'old', 'demo', 'tmp', 'temp', 'backup', 'config',
  'readme', 'default', 'example', 'sample', 'update', 'fix', 'app', 'src', 'util',
  'utils', 'api', 'music', 'source', 'lx', 'js', 'v1', 'v2', 'v3'
])
function isWeakBaseName(nm) {
  if (!nm) return true
  if (/^\d+$/.test(nm)) return true      // 纯数字：6.js / 120.js
  if (nm.length <= 2) return true        // 过短：kw.js / kg.js
  return WEAK_BASE_NAMES.has(nm)
}

/**
 * 「删旧后上传」的轮询重试间隔（纯函数，便于单测）。
 *
 * 背景（2026-11-11 性能项 3）：旧实现删完固定 `sleep(2500)` 再传，撞名再等 2500ms ——
 * 每个同名替换白等 2.5 秒，批量更新 20 条就是 50 秒纯等待；而实测服务端重载通常几百毫秒
 * 就完成，等的是「平均情况」而不是「真实就绪」。
 * 新口径：删完立刻试传，撞名就按 200→300→450→675ms 退避轮询，总预算 3 秒；
 * 3 秒还撞名才退化成「改名上传」兜底（原逻辑最后一步，不变）。
 *
 * @param attempt 已重试次数（0 = 第一次撞名后）
 * @param waitedMs 从删成功起已等待的毫秒数
 * @returns 下次等待毫秒数；null = 超出预算，别再等
 */
const REPLACE_UPLOAD_POLL_MS = Number(process.env.LXH_REPLACE_POLL_MS) || 3000
function replaceRetryDelay(attempt, waitedMs, opts) {
  const o = opts || {}
  const budget = Number(o.budgetMs) || REPLACE_UPLOAD_POLL_MS
  const waited = Number(waitedMs) || 0
  if (waited >= budget) return null
  const base = Number(o.baseMs) || 200
  const cap = Number(o.maxMs) || 800
  const delay = Math.min(cap, base * Math.pow(1.5, Math.max(0, Number(attempt) || 0)))
  // 剩余预算不够下一档就别硬等：让调用方立刻用最后结果收尾
  return (waited + delay > budget + cap) ? null : Math.round(delay)
}
// versionNum 已统一到 src/core/version.js 的逐段零填充键（versionKey）。
// 返回字符串而不是数字：调用点一律用 cmpVersion() 比较，禁止做减法。
// 顶部 require 以别名 versionNum 引入，module.exports 继续导出同名符号。

/**
 * 把「间隔小时数」说成人话（定时任务的日志用）：48 → 「2 天（48 小时）」。
 * 桌面版与 Web 版共用，免得用户看到「48 小时」还要自己换算，也别两边各写一份格式化。
 */
function formatIntervalHours(h) {
  const n = Math.max(1, Number(h) || 1)
  return n % 24 === 0 ? `${n / 24} 天（${n} 小时）` : `${n} 小时`
}

/**
 * 定时巡检的到期判定（v1.10.2 抽成纯函数，桌面版与 Web/Docker 版共用）。
 *
 * 背景（2026-11-06 用户实测）：推送服务端关闭时，runPatrol 第一步读服务端音源列表
 * 就抛错，而旧代码**只在 runPatrol 成功收尾**才写 patrol.lastRun，于是 lastRun 永远停在
 * 很早以前，每分钟的轮询每次都判定「到期」→ 每分钟真的跑一轮、刷一屏失败日志。
 * 用户设的「间隔 1 天」在失败场景完全失效。
 *
 * 现在调度水位取 max(lastAttempt, lastRun)：
 *  - lastRun：runPatrol 成功完成时间（保留给界面「上次巡检」展示与统计）
 *  - lastAttempt：定时器每次真正触发前写入（含失败轮），保证失败也推进水位
 *  - lastError：上一轮失败原因；存在时改用较短的 patrolRetryMinutes 退避（默认 15 分钟），
 *    既不会每分钟刷屏，服务端恢复后也不用等满一整天；退避上限不超过主间隔。
 *
 * @param {object} cfg 配置（patrolIntervalHours / patrolRetryMinutes）
 * @param {object} patrol store.db.patrol
 * @param {number} now 当前时间戳（便于测试注入）
 * @returns {{last:number,hours:number,retryMinutes:number,failed:boolean,
 *            gapMs:number,dueByInterval:boolean,dueByRetry:boolean,due:boolean}}
 */
function patrolSchedule(cfg, patrol, now) {
  const p = patrol || {}
  const t = Number(now) || Date.now()
  const hours = Math.max(1, Number(cfg && cfg.patrolIntervalHours) || 12)
  const retryMinutes = Math.max(1, Math.min(1440, Number(cfg && cfg.patrolRetryMinutes) || 15))
  const last = Math.max(Number(p.lastAttempt) || 0, Number(p.lastRun) || 0)
  const failed = !!p.lastError
  const intervalMs = hours * 3600 * 1000
  const retryMs = Math.min(intervalMs, retryMinutes * 60 * 1000)
  const gapMs = failed ? retryMs : intervalMs
  const elapsed = t - last
  return {
    last, hours, retryMinutes, failed, gapMs,
    dueByInterval: elapsed >= intervalMs,
    dueByRetry: failed && elapsed >= retryMs,
    due: elapsed >= gapMs
  }
}

// 注：原先这里的规则只认英文 "fetch failed"，而沙箱抛的是中文「沙箱 fetch 失败」，
// 导致全平台网络失败会被判死并自动禁用。现统一改由 checker.isLocalNetworkIssue 判定。

/** 是否为「本地真实候选」：服务端原生占位 / 无脚本地址的条目不参与检测与去重 */
function isLocalSource(e) {
  return !!e && !e.fromServer && !e.deprecated && !!e.url
}

/**
 * 本地深检里「实测可用」的平台键列表（v1.8.0）。
 * 用于同名裁决时判断两个脚本的平台是否有交集（完全不交集的视为无关脚本）。
 */
function usableKeys(e) {
  const p = e && e.deep && e.deep.platforms
  if (!p || typeof p !== 'object') return []
  return Object.keys(p).filter(k => p[k] && p[k].status === 'usable')
}

/**
 * 改名安全阀（v1.8.0）：有些脚本会**校验自己的名字**——实测 `_real_聚合API接口.js` 里有
 * `scriptInfo.name !== "聚合API接口 (by lerd)" ||` 这种断言，只改 `@name` 注释不改这处，
 * 脚本初始化就会失败（在 MusicSync 上表现为「初始化失败」，在别处可能是静默不可用）。
 * 只改注释而让脚本变成坏源，比不改名严重得多，所以这里先判断能不能安全改名。
 *
 * 判据：脚本里出现「原始名字」的次数，减去两处**可以一起改写**的地方
 * （`@name` 注释行、`lx.send('inited',{name:...})`）之后还有剩余 → 说明脚本自己也在用这个名字
 * （自检断言、拼接、路由判断等），改名有风险。
 *
 * @param {string} code 脚本源码
 * @param {string} name 脚本当前的 @name（不是要改成的那个）
 * @returns {boolean} true = 改名会让脚本失效，不能改
 */
function renameSelfCheck(code, name) {
  const n = String(name || '').trim()
  if (!n) return false
  const s = String(code || '')
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const all = s.split(n).length - 1
  if (all <= 1) return false
  let rewritable = 0
  if (new RegExp('@name\\s+' + esc).test(s)) rewritable++
  if (new RegExp('lx\\.send\\(\\s*["\']inited["\']\\s*,\\s*\\{\\s*name\\s*:\\s*["\']' + esc + '["\']').test(s)) rewritable++
  return all - rewritable > 0
}

/**
 * 改写脚本的展示名（@name 与 lx.send('inited',{name})），
 * 让服务端 generateId 生成不同文件名、避免与同名音源冲突。
 * 即便脚本没有 @name，upload 也会用 filename 兜底，因此改名后必不撞 id。
 */
function renameScriptContent(code, newName) {
  let out = code.replace(/(@name\s+)([^\n\r]+)/, (m, p, rest) => p + newName)
  out = out.replace(/(lx\.send\(\s*["']inited["']\s*,\s*\{\s*name\s*:\s*["'])([^"']+)(["'])/i,
    (m, p, old, q) => p + newName + q)
  return out
}

/**
 * 「查看身份」口径说明（v1.6.6）：
 * lxserver 的平台级停用（disabledSources）按身份分文件存储：
 *  - 公开源（owner=open，所有账号可用、仅 admin 可管理）→ _open/states.json
 *  - admin 私有源 → admin/states.json
 * LX 网页端音源管理页固定读 _open 那份（前端取 currentListData?.username，而歌单接口
 * 返回里没有 username 字段，恒为 default，与实际登录账号无关）。
 * v1.6.6 起猎手读写停用状态都固定走公开(_open)口径：写入即网页端所见，
 * 「已灌入」页徽章也与网页端一致。历史单写残留（admin 侧有值、_open 侧没有）会在
 * 下次巡检/手动停用启用时自然覆盖对齐。
 */
/**
 * 「查看身份」一致性检查（v1.6.7）：
 * lxserver 的平台级停用按身份分文件存，LX 网页端音源管理页固定读 _open 那份。
 * v1.6.7 起猎手按源的 owner 路由写入：公开源写 _open（网页端可见），admin 私有源
 * 写 admin 那份（私有源只以 admin 身份取歌，且网页端公开列表根本看不到它）。
 * 私有源在网页端「找不到」是正常现象，这里给用户说清，避免误以为不同步。
 */
function identityMismatch(cfg, serverList) {
  const privates = (serverList || []).filter(s => s && s.owner && s.owner !== 'open' && s.owner !== '_open')
  if (!privates.length) return null
  const owners = Array.from(new Set(privates.map(s => s.owner))).join('、')
  return `服务端有 ${privates.length} 个私有音源（归属 ${owners}）：它们只对同名账号可用，LX 网页端公开列表里看不到（也管不了），属正常现象。其停用状态按 ${owners} 身份存储，猎手显示与服务端一致`
}

/**
 * 巡检「自动删除」决策（纯函数，便于测试与复用，v1.9.1）。
 * 只在开启 patrolAutoDelete 且连续失效次数达到 patrolDeleteAfter（默认 3）时返回 true。
 * 注意：本地未灌入服务端（无 lxId）的音源不该走删除（runPatrol 已用 aliveLxIds 过滤），
 * 这里只负责「阈值判定」，不负责「能不能删」。
 *
 * v1.18 批次D：新增 minThreshold —— 本轮 patrolJudge **实际使用的判死阈值**。
 * 版权/会员类失败会把判死阈值从 2 放宽到 4，而 patrolDeleteAfter 默认仍是 3；若只看配置值，
 * streak=4 判死时 4>=3 会**跳过禁用直接删除**（不可逆），违反「禁用先于删除」这条红线
 * （index.html 巡检设置区明示）。删除线因此必须 ≥ 判死线，故取两者较大值。
 * @param {object} cfg 配置（含 patrolAutoDelete / patrolDeleteAfter）
 * @param {number} streak 连续失效次数（rec.patrolFailStreak）
 * @param {number} [minThreshold] 本轮实际判死阈值（j.need）；缺省时退回只看 patrolDeleteAfter
 */
function patrolAutoDeleteWanted(cfg, streak, minThreshold) {
  if (!cfg || cfg.patrolAutoDelete !== true) return false
  const deleteThreshold = Number(cfg.patrolDeleteAfter) > 0 ? Number(cfg.patrolDeleteAfter) : 3
  const need = Number(minThreshold) > 0 ? Number(minThreshold) : 0
  return Number(streak) >= Math.max(deleteThreshold, need)
}

/**
 * 同批「同名不同版本」去重（2026-11-11，P-1411 P0）。
 *
 * 场景：一次勾选同一音源的 v1.0.0 + v2.0.0 两个文件。原来的规划只按**精确名**去重，
 * 版本号写在名字里 → 两个名字不同 → 两条都通过，且都对着服务端**同一条**旧版规划 replace。
 * 执行期第一条删掉旧版装入 v1，第二条再 remove 同一个 id 必然失败（HTTP 500），
 * 退回改名上传 → 服务端并存两条（`…v1.0.0.js` + `…_v2.0.0（副本2）.js`），
 * 留下的还是低版本；下次灌 v3 只会删 v2，v1 永久成僵尸（17960 实机复现）。
 *
 * 规则（刻意写窄，避免误伤）：
 *  - 只有「剥掉版本号后同名」（baseNameKey 相同）**且版本可比、且互不相同**才去重；
 *    同版本/取不到版本的同名多源，多半是不同仓库转发的不同脚本，保持原样交给逐条裁决。
 *  - 只在「本来就能灌」的条目里挑（服务端原生 / 无正文 / 本地实测不可用的不参与），
 *    否则可能挑中一条永远不会被灌的，把唯一能灌的那条也一起跳过。
 *  - 保留顺序：版本高 → 可用平台多 → 修改时间新 → id 字典序（结果可复现）。
 *
 * @returns {Object<string, object>} 被跳过的条目 id → 本次保留的那条
 */
function planBaseDedupe(targets, cfg) {
  const c = cfg || {}
  const groups = {}
  for (const e of (targets || [])) {
    if (!e || e.fromServer) continue
    if (!e.url && !(typeof e.code === 'string' && e.code)) continue
    if (c.skipUnusable !== false && !e.usable && e.deep && !e.stale) continue
    const bk = baseNameKey(e.lxName || e.scriptName || e.name)
    if (!bk) continue
    ;(groups[bk] = groups[bk] || []).push(e)
  }
  const skip = {}
  for (const bk of Object.keys(groups)) {
    const g = groups[bk]
    if (g.length < 2) continue
    const rows = g.map(e => ({ e, v: versionNum(verLabel(e.scriptVersion || e.lxName || e.scriptName || e.name)) }))
    if (rows.some(r => !r.v)) continue                        // 有取不到版本的 → 不猜
    if (new Set(rows.map(r => r.v)).size < 2) continue         // 版本全同 → 不是「多版本」，不去重
    rows.sort((x, y) => -cmpVersion(x.v, y.v) ||
      compareImportQuality(x.e, y.e) ||
      (y.e.lastModified || 0) - (x.e.lastModified || 0) ||
      String(x.e.id).localeCompare(String(y.e.id)))
    const win = rows[0].e
    for (const r of rows.slice(1)) skip[r.e.id] = win
  }
  return skip
}

/**
 * 构建本次健康巡检的队列（v1.10.2 抽成纯函数，便于回归测试）。
 *
 * 私人音源（private:true，用户「导入单个音源」入库的个人脚本）**完全不参与巡检**：
 * 不下载/沙箱重测、不累计 patrolFailStreak、不写 lastPatrol、不自动禁用/删除/恢复，
 * 也不计入巡检统计。理由：私人脚本没有可信远端地址，系统定期重测既不必要，
 * 还可能因临时网络/接口波动把它误判失效并自动禁用。用户仍可在音源库手动点
 * 「检测 / 检测并灌入」主动验证自己的脚本（那是用户显式发起，不属巡检）。
 *
 * 其余过滤口径保持不变：只巡检「本工具灌入 / 同步纳入、服务端仍存在、
 * 本地有脚本地址」的音源；服务端原生音源（无本地记录或 url 为空且无本地正文）跳过。
 *
 * @param {object} imported store.imported（srcId -> { lxId, ... }）
 * @param {object} sources store.db.sources（srcId -> entry）
 * @param {Set<string>|Array<string>} aliveLxIds 服务端现存的 lxId
 * @param {string} [platformId] 当前巡检账号 id（多账号时按账号取 lxId，见 _recLxIdOn）
 * @param {string} [activeId] 当前选中账号 id（老记录 platformId 为空时归它）
 * @returns {Array<{srcId:string, e:object, rec:object, lxId:string}>}
 */
function buildPatrolItems(imported, sources, aliveLxIds, platformId, activeId) {
  const alive = aliveLxIds instanceof Set ? aliveLxIds : new Set(aliveLxIds || [])
  const items = []
  for (const [srcId, rec] of Object.entries(imported || {})) {
    if (!rec) continue
    // T2-4：多账号不能只看顶层 rec.lxId —— 顶层指向的是「最近一次灌入的账号」，
    // 巡检针对的是当前账号（aliveLxIds 来自它的列表），要按账号取对应那份 lxId。
    // 不传 platformId/activeId 时退回顶层 lxId（老调用/单测口径不变）。
    const lxId = platformId ? recLxIdOn(rec, platformId, activeId) : rec.lxId
    if (lxId == null || !alive.has(String(lxId))) continue   // 服务端已不在（被手动删除）
    const e = (sources || {})[srcId]
    if (!e) continue
    if (e.private) continue                                   // v1.10.2：私人音源不参与巡检
    // 无脚本地址的跳过：手动灌入无本地记录，或服务端原生音源未留存 sourceUrl。
    // 本地存有正文（code）的非私人条目仍可直接复测，不跳过。
    // 2026-11-11（P-1411 P1-1）：与灌入门槛（_planImportQueue）同口径 —— 必须是**非空** code。
    // 原来只判 `typeof e.code !== 'string'`，空串也能过（`typeof '' === 'string'`），
    // 结果那条音源进了巡检却永远测不出东西，白占每轮预算。
    if (!e.url && !(typeof e.code === 'string' && e.code)) continue
    items.push({ srcId, e, rec, lxId: String(lxId) })
  }
  return items
}

/** 记录在当前账号上那份的服务端 id（与 Hunter._recLxIdOn 同口径；buildPatrolItems 是模块级纯函数故在此复用） */
function recLxIdOn(rec, pid, activeId) {
  if (!rec) return null
  const to = Array.isArray(rec.importedTo) ? rec.importedTo.find(x => x && x.platformId === pid) : null
  if (to) return to.lxId == null ? null : to.lxId
  const top = rec.platformId == null ? (activeId || pid) : rec.platformId
  if (top === pid) return rec.lxId == null ? null : rec.lxId
  // 老记录没有账号字段、也没有 importedTo，且当前巡检账号与 activeId 不一致时：
  // 它本就是「按服务端 lxId 记账」的单账号旧数据，沿用顶层 lxId（向后兼容）。
  if (rec.platformId == null && !Array.isArray(rec.importedTo)) return rec.lxId == null ? null : rec.lxId
  return null
}

/**
 * ============================================================================
 * R9（v1.13.15）：追更链（updateTip.url）的域名校验
 * ============================================================================
 *
 * 背景（已确认的攻击链）：
 *   沙箱里的音源脚本能通过 lx.send('updateAlert') / lx.request 响应上报 **updateTip**，
 *   sandbox.js 的 __host_emit 把它们收集进 self.updateTips；
 *   checker 把它写回条目 → hunter._mergeUpdateTips 存进 e.updateTips →
 *   hunter._followUpdateTips **按 tip.url 下载内容并 store.addSources() + saveDb()**。
 *   也就是说：**沙箱里的恶意脚本能让 hunter 往用户的音源库里注入任意内容**。
 *
 * 分两层拦（纵深）：
 *   ① checkUpdateTipUrl —— 与具体音源无关的**硬校验**（协议 / 域名格式 / 私网回环）。
 *      零维护、零误伤、闭集。写入（_mergeUpdateTips）与下载（_followUpdateTips）都过这一层。
 *   ② knownHostsForEntry —— 「这个域名是不是**这个音源自己**的」：
 *      取该条目的 apiHosts（沙箱实测到的外联域名）+ obfDomains + homepage/脚本地址的域名，
 *      再加上同主机名（去掉端口后相同）与之同域（父域相同）的域名。
 *      不在集合里的陌生域名 → 记日志跳过这一条，**不中断整轮**。
 *
 * 为什么第②层必须「按音源自己的已知域名」而不是公共 CDN 白名单：
 *   outbound-policy.js 的设计是「普通域名只审计不阻断」——理由是生产库 1713 条音源
 *   有 239 个唯一域名，其中约 150 个是第三方聚合站，**换域名是常态**。
 *   若照抄一份「公共 CDN 白名单」去挡陌生域名，生产音源换个域名就会**静默失效**
 *   （表现为「音源坏了」，用户看到的是功能故障而不是安全提示）——
 *   这正是 outbound-policy.js 里明确写下来「曾计划做、已否决」的做法。
 *   所以这里只认「这个音源自己已经表现出来的域名」，不臆造任何公共清单。
 *
 * 判定「同域」的规则（保守、够用即可）：
 *   - host 完全相同（忽略大小写与端口）→ 同域
 *   - host 是 known host 的**子域**（known.example.com ⊇ a.b.example.com）→ 同域
 *   - host 是 known host 的**父域**（a.example.com ⊇ example.com）→ 同域
 *   其它（example.com vs other.net）→ 不同域
 */
const UPDATE_TIP_ALLOWED_PROTOCOLS = ['http:', 'https:']

/**
 * 判断一个域名是否「格式合法」——只查形状，不查是否公网可达。
 * 规则（刻意保守，宁可多拒一个畸形域名，也不放行奇怪的）：
 *   - 长度 1..253
 *   - 允许 字母/数字/点/连字符；不允许下划线、其它符号、空格
 *   - 至少含一个点（单标签主机名只能是内网/本机名，见 outbound-policy 的说明）
 *   - 每一段 label 非空、长度 <=63、不以连字符开头/结尾
 *   - TLD 必须是纯字母（>=2 位）——**除非整个 host 是 IPv4 字面量**
 *     （生产库 apiHosts 里确实有 175.27.166.236 这类直连 IP；
 *      它的私网/回环由 outbound-policy.checkOutbound 判，这里不重复判）
 * @param {string} host 已归一化的小写主机名（无端口、无方括号）
 * @returns {boolean}
 */
function isValidPublicHostShape (host) {
  if (!host || host.length > 253) return false
  if (!/^[a-z0-9.-]+$/.test(host)) return false
  const labels = host.split('.')
  if (labels.length < 2) return false
  for (const l of labels) {
    if (!l || l.length > 63) return false
    if (l.startsWith('-') || l.endsWith('-')) return false
  }
  // IPv4 字面量：形状合法（私网/回环由 checkOutbound 判）
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return labels.every(l => /^\d{1,3}$/.test(l) && Number(l) <= 255)
  }
  const tld = labels[labels.length - 1]
  if (!/^[a-z]{2,}$/.test(tld)) return false
  return true
}

/**
 * R9 第①层：updateTip.url 的硬校验（协议 / 域名格式 / 私网回环 / userinfo）。
 *
 * 私网/回环判据**直接复用** outbound-policy.checkOutbound（不另写一套）：
 *   那里是「私网/回环硬阻断」的唯一来源，规则封闭、零维护，
 *   并且已经处理了 127.1 / 0x7f000001 / [::ffff:127.0.0.1] 这些等价写法。
 *
 * 2026-11-19 新增「拒绝 userinfo」：带 userinfo 的 URL（https://evil.com@real.com/a.js）
 *   在浏览器/URL 解析器眼里 host 是 real.com，但肉眼扫过去只看到 evil.com，
 *   攻击者可用它骗过人工审核与任何基于「字符串包含」的日志检查。
 *
 * @param {string} rawUrl 待校验的地址
 * @returns {{ok: boolean, why: string, host: string, url: string}}
 *   ok=false 时 why 是人话原因（供日志用）；ok=true 时 url 是归一化后的 URL 字符串。
 */
function checkUpdateTipUrl (rawUrl) {
  const s = String(rawUrl == null ? '' : rawUrl).trim()
  if (!s) return { ok: false, why: '地址为空', host: '', url: '' }
  if (s.length > 2048) return { ok: false, why: '地址过长', host: '', url: '' }
  let u
  try { u = new URL(s) } catch (e) {
    return { ok: false, why: '不是合法 URL', host: '', url: '' }
  }
  if (UPDATE_TIP_ALLOWED_PROTOCOLS.indexOf(u.protocol) === -1) {
    return { ok: false, why: '协议不是 http(s)（' + u.protocol + '）', host: '', url: '' }
  }
  // userinfo（用户名/密码）一律拒绝：`https://evil.com@real.com/` 这类地址
  // 的真正 host 是 real.com，但字符串里带了个骗人的域名。任何时候都没必要用它。
  if (u.username || u.password) {
    return { ok: false, why: '地址里带用户名/密码（userinfo）', host: '', url: '' }
  }
  const host = normalizeHost(u.hostname)
  if (!host) return { ok: false, why: '没有主机名', host: '', url: '' }
  // 私网/回环：复用 outbound-policy 的封闭规则（checkOutbound 内部已做 IPv4 映射还原）
  const out = checkOutbound(u.href)
  if (out && out.blocked) {
    return { ok: false, why: '指向私网/回环地址（' + (out.why || '') + '）', host, url: '' }
  }
  if (!isValidPublicHostShape(host)) {
    return { ok: false, why: '域名格式不合法', host, url: '' }
  }
  return { ok: true, why: '', host, url: u.href }
}

/**
 * R9：通配 DNS 服务（wildcard DNS）域名黑名单。
 *
 * 这些服务把**任意**子域名解析到固定 IP（典型是 127.0.0.1）：
 *   localtest.me / lvh.me  → 127.0.0.1
 *   nip.io / sslip.io / xip.io → 127.0.0.1（当前容器 DNS 未配这些，但随时可能配上）
 * 所以 `http://foo.localtest.me/x.js` 的域名形状完全合法、TLD 也是真字母，
 * 只靠域名形状校验挡不住——只能显式封掉这些后缀。
 *
 * 为什么不能靠「DNS 解析结果」兜底：域名解析失败（NXDOMAIN）时没有 IP 可判，
 * 而攻击者换一个没被解析到的子域就绕过去了（实测 anything.nip.io 当前就是 ENOTFOUND，
 * 但那是本机 DNS 的状态，不是规则）。**显式拒绝后缀**才是稳定规则。
 *
 * ⚠️ 残余风险（明确接受）：攻击者自建一个 A 记录指向 127.0.0.1 的域名，
 *   不在这个名单里 → 只能靠「解析后 IP 私网判定」拦（见 checkUpdateTipResolvedIp）。
 *   那条判据依赖 DNS 应答，仍有 rebinding 窗口（见 R9 说明块）。
 */
const WILDCARD_DNS_SUFFIXES = [
  'localtest.me',
  'lvh.me',
  'nip.io',
  'sslip.io',
  'xip.io',
  'vcap.me',
  'loca.lt',
  '127.0.0.0.nip.io'
]

/**
 * 判断 host 是否落在通配 DNS 服务后缀下。
 * @param {string} host 归一化主机名（小写）
 */
function isWildcardDnsHost (host) {
  const h = String(host || '').trim().toLowerCase()
  if (!h) return false
  for (const suf of WILDCARD_DNS_SUFFIXES) {
    if (h === suf) return true
    if (h.length > suf.length && h.endsWith('.' + suf)) return true
  }
  return false
}

/**
 * R9 第①层补充：解析后 IP 的私网/回环判定（同步版，供纯函数测试用）。
 *
 * @param {string} host 归一化主机名
 * @param {string[]} ips 解析出的 IP 列表
 * @returns {{ok:boolean, why:string}}
 */
function checkUpdateTipResolvedIp (host, ips) {
  if (isWildcardDnsHost(host)) {
    return { ok: false, why: '域名属于通配 DNS 服务（任意子域都能解析到本机/内网）' }
  }
  const list = Array.isArray(ips) ? ips : []
  for (const ip of list) {
    // 用 checkOutbound 判「这个 IP 是不是私网/回环」——复用同一套封闭规则，不另写一份。
    // 拼成 http://IP/ 让它走 URL 解析路径（IPv6 映射还原也在里面）。
    const o = checkOutbound('http://' + String(ip).replace(/^\[|\]$/g, '') + '/')
    if (o && o.blocked) {
      return { ok: false, why: '域名解析到私网/回环地址（' + (o.why || '') + '：' + ip + '）' }
    }
  }
  return { ok: true, why: '' }
}

/**
 * host 是否与 known 里的某个 host「同域」。
 *
 * 2026-11-19 收紧（原实现是**双向任意深度**的父域/子域判定）：
 *   - 完全相等 → 属于；
 *   - host 是 known 的**一层**子域（a.b.k）→ 属于；
 *   - host 是 known 的**父域**（k 是 host 的子域）→ **不再属于**。
 *   - host 是 known 的**多层**子域（a.b.c.k）→ 不再属于。
 *
 * 为什么父域方向必须断：known 里有 `raw.githubusercontent.com`（脚本托管域）时，
 * 父域方向会让 `github.com` 也算「自己的域名」——
 * 而 github.com 上任何人都有仓库，能放任意内容。
 * 同理 known 里有 `example.com` 时，旧口径下 `com` 都不算（域名形状会挡住），
 * 但 `a.b.example.com` 这种多层子域会把信任范围放大到攻击者能注册的一层。
 *
 * 实测（2026-11-19 生产库）：43 条 tip 收紧前后放行数 **22 → 22**，差异 0；
 * 27 条 followedUpdateUrls 红线 **10 → 10**，差异 0。零误伤。
 *
 * @param {string} host 归一化主机名
 * @param {Set<string>} known 已知主机名集合（小写）
 */
function isSameSiteHost (host, known) {
  if (!host || !known || !known.size) return false
  if (known.has(host)) return true
  for (const k of known) {
    if (!k || k.length >= host.length) continue
    // host 是 k 的子域：只允许**一层**（a.k），a.b.k 这种多层不放行
    if (host.endsWith('.' + k)) {
      const mid = host.slice(0, host.length - k.length - 1)
      if (mid && mid.indexOf('.') === -1) return true
    }
  }
  return false
}

/**
 * R9 第②层：取「这个音源自己已经表现出来的域名」集合。
 *
 * 来源（都是该条目**自身**的客观记录，不是公共白名单）：
 *   - e.apiHosts  ：沙箱实测到的外联域名（checker.extractApiHosts 产出）
 *   - e.homepage  ：脚本 @homepage 声明的站点（checker.extractMeta 产出）
 *   - e.url       ：这条音源脚本本身的下载地址（checker 用它拉脚本）
 *   - e.fetchUrl  : 实际拉取成功的镜像地址
 *
 * 2026-11-19 移除 e.obfDomains：那是**静态扫描**猜出来的「疑似外联域名」，
 *   不是这个音源实际表现出来的归属证据；扫描误报时会把陌生域塞进信任集合。
 *   实测（生产库）：43 条 tip 移除前后放行数 22 → 22、27 条红线 10 → 10，差异 0。
 *
 * ⚠️ 保留 e.url / e.fetchUrl 是**有代价的**（已知残余风险，未解决）：
 *   脚本托管域通常是共享的（raw.githubusercontent.com / gitee.com），
 *   攻击者只要能让自己的脚本被下载过一次（e.url 指向托管域），
 *   同一个托管域上的**任意路径**都会被判成「该音源自己的域名」（闸门②形同虚设）。
 *   实测收紧口径（把 url/fetchUrl 移出 known）会让放行数 22 → 19，
 *   掉的三条是真实追更（Free listen ×2、小熊猫）——按「误伤好源代价远大于漏判」
 *   的准则，**保留 url/fetchUrl**，把这条作为已知残余风险记录在案。
 *
 * @param {object} e 音源条目
 * @returns {Set<string>} 小写主机名集合（不含端口）
 */
function knownHostsForEntry (e) {
  const out = new Set()
  if (!e) return out
  const addUrl = (u) => {
    if (!u) return
    const h = auditDomain(u)
    if (h) out.add(normalizeHost(h))
  }
  const addHost = (h) => {
    const s = String(h || '').trim().toLowerCase()
    if (!s) return
    // apiHosts 里可能带端口（rare），取主机部分
    const noPort = s.replace(/:\d+$/, '')
    if (noPort) out.add(normalizeHost(noPort))
  }
  for (const h of (Array.isArray(e.apiHosts) ? e.apiHosts : [])) addHost(h)
  addUrl(e.homepage)
  addUrl(e.url)
  addUrl(e.fetchUrl)
  // 去掉空串
  for (const k of Array.from(out)) if (!k) out.delete(k)
  return out
}

/**
 * R9 第②层判定：tip.url 的域名是否属于「这个音源自己」。
 * @param {object} e 音源条目
 * @param {string} host 归一化主机名
 * @param {Set<string>} known knownHostsForEntry(e) 的结果
 * @returns {{ok: boolean, why: string}}
 */
function checkUpdateTipHostBelongsTo (e, host, known) {
  if (!known || !known.size) {
    return { ok: false, why: '该音源没有任何已知的自有域名可核对（无法证明这个更新地址属于它）' }
  }
  if (isSameSiteHost(host, known)) return { ok: true, why: '' }
  return { ok: false, why: '域名 ' + host + ' 不在该音源已知的域名集合内（' + Array.from(known).slice(0, 4).join('、') + '）' }
}

/**
 * 阶段B：判断一个 host 是否被多个音源共享（共享域名是**正常常见现象，不是危险信号**，
 * 仅供 AI 作弱参考）。只读遍历，不改 known 集合 / rebinding / 任何库字段。
 */
function updateTipHostIsShared (host, sources, selfId) {
  if (!host) return false
  let n = 0
  for (const x of (Array.isArray(sources) ? sources : [])) {
    if (!x || x.id === selfId) continue
    const hs = knownHostsForEntry(x)
    if (hs.has(host)) { n++; if (n >= 2) return true }
  }
  return false
}

/**
 * v1.16：在 blockedMeta 里按仓库名查找键（大小写不敏感 + 兼容老数据原形 key）。
 * 新数据写入用小写 key；老数据可能是原形（含大写），故遍历比对。返回实际命中的 key 或 null。
 */
function findBlockedMetaKey (meta, name) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const low = String(name || '').toLowerCase()
  if (Object.prototype.hasOwnProperty.call(meta, low)) return low
  for (const k of Object.keys(meta)) {
    if (String(k).toLowerCase() === low) return k
    const mk = meta[k] && meta[k].repo ? String(meta[k].repo).toLowerCase() : ''
    if (mk && mk === low) return k
  }
  return null
}

// 2026-11-22：同项目改名识别（豆包定制 / doujs 等同一脚本在 lx-music-source 与
// backend-api 间迁移）。判断「同 owner + 同名脚本资产」，收窄到不足以误判两条不同源。
function repoOwner (repo) {
  const m = /^([^/]+)\//.exec(String(repo || '').trim())
  return m ? m[1].toLowerCase() : ''
}
function sameAssetName (a, b) {
  const fname = e => String((e && (e.path || e.assetKey || e.name)) || '').split('/').pop().split(':').pop().replace(/\.js$/i, '').toLowerCase()
  const fa = fname(a), fb = fname(b)
  return !!fa && fa === fb
}

class Hunter {
  constructor(store, emit) {
    this.store = store
    this.emit = emit || function () {}
    this.job = { running: false, type: '', cancel: false, progress: {}, step: '' }
    // AI 旁路在途去重集合（C 复核 §2 缺陷④）：键 `kind:id`（kind=cold|tips），
    // 只表示"这条源当前正在判"，**不持久化、重启即空**；worker 结算（finally）时必删。
    // 说明：字段（sourceAiClass/updateTipsAiClass）仍是"要不要判"的唯一依据，
    // 本集合只挡"在途窗口内重复入队"，不改变幂等语义。
    this._bypassInFlight = new Set()
    // 长任务循环内的进度写盘节流（性能优化 v1.13.10）：17MB sources.json 全量同步写盘很贵，
    // 循环内不再每 10/20 条就写，改为距上次写 ≥60s 才写一次；任务收尾仍同步 saveDb 保证落盘。
    this._lastThrottledSave = 0
  }

  /**
   * 静态情报·域名 IOC【观察模式】（2026-11-24，用户拍板：先审计不拦截）。
   * 对脚本文本/URL 命中恶意 API 域名时，只写只读审计字段 e.domainIocHits 与一条日志；
   * 绝不改 status/usable/suspected/quarantined/灌入判定——现有消费方不读该字段 ⇒ 零倒退。
   * 归一化域名清单在 maliciousGuard.MALICIOUS_API_DOMAINS，观察期结束再决定是否升级硬拦截。
   */
  _noteDomainIoc(e, code, phase) {
    if (!e || typeof e !== 'object' || e.fromServer) return
    const hits = matchDomainIoc(code, (e.deep && e.deep.platforms && Object.values(e.deep.platforms)
      .map(p => p && p.url).filter(Boolean)) || e.apiHosts)
    if (!hits.length) return
    e.domainIocHits = Array.from(new Set((Array.isArray(e.domainIocHits) ? e.domainIocHits : []).concat(hits)))
    this.log(`静态情报观察：${phase || '检测'}命中恶意 API 域名 IOC（${hits.join('、')}）→ 仅记录，不改变判定/灌入：${e.lxName || e.scriptName || e.name || e.id}`, '安全', 'warn')
  }

  /** 长任务进度写盘：节流版，收尾请仍用 store.saveDb() 保证最终落盘。 */
  _saveDbThrottled() {
    const now = Date.now()
    if (now - this._lastThrottledSave < 60000) return
    this._lastThrottledSave = now
    this.store.saveDb()
  }

  /**
   * 巡检进度写盘：db + imported 一起节流（性能优化 v1.13.10）。
   * 巡检每条都双写这两个 17MB 级文件是头号写盘瓶颈；服务端动作（禁用/删除/恢复）
   * 已由 _patrolEnqueueServerWrite await 生效，本地账本写盘延后只会延后「disabledByPatrol」
   * 标记的持久化时机（保守方向），不影响服务端实际状态。收尾仍强制写，删除成功后立即写。
   */
  _savePatrolProgressThrottled() {
    const now = Date.now()
    if (now - this._lastThrottledSave < 60000) return
    this._lastThrottledSave = now
    this.store.saveImported()
    this.store.saveDb()
  }

  // ---------------- AI 复检旁路钩子（v1.14.0，纯旁路） ----------------
  // 红线：本段所有方法只写 db 里的 ai* 旁路容器（aiReviewLedger / aiEvalLog / aiSuggestions），
  // 绝不改 verdict.act / queue / 任何业务字段；全程 try/catch 静默，不阻塞主链路。
  /** 惰性取 AI 复检单例（仿 main/index.js 的 ai() 写法），失败返回 null。 */
  _ai() {
    try {
      if (!this._aiInstance || this._aiInstance.store !== this.store) {
        const { AIReview } = require('../core/aiReview')
        this._aiInstance = new AIReview(this.store)
      }
      return this._aiInstance
    } catch (_) {
      return null
    }
  }

  /**
   * 后台调度钩子（可注入，供测试同步执行）：默认微任务调度，测试注入 `fn => fn()` 并可 await。
   * 用于把 AI 旁路分类推到主流程之外，避免主链路等待。
   */
  _aiBackground(fn) {
    if (typeof this._aiBackgroundImpl === 'function') return this._aiBackgroundImpl(fn)
    return Promise.resolve().then(fn)
  }

  /**
   * 把本批的两处 AI 旁路分类（项①阶段2 冷启动 + 项② R4 更新语义）入后台执行，runImport 不再等。
   *
   * C 终审 §4 加固五件套：
   *  1) 按 id 重取引用再写字段：worker 完成时 `db.sources[id]` 重取，源已删除则不写回（不复活条目）；
   *  2) worker 自行 await saveDb()：主流程早已 saveDb 完，晚到字段需自己落盘（tmp+rename 原子，并发安全）；
   *  3) this.log 记录一条结果日志（不碰 UI/缓存戳）；
   *  4) 队列不持久化：仅内存，进程重启即丢——靠"字段没写 → 下次 !e.sourceAiClass/===undefined 命中自动重算"天然幂等；
   *  5) 通过 _aiBackground 可注入同步执行，测试可 await，避免 sleep 赌运气。
   *
   * **本方法同步返回、不 await 后台**（否则就不算转后台）。后台 job 由 _aiBackground 调度。
   * 旁路铁律不变：只写独立字段（sourceAiClass/updateTipsAiClass），不进判定链/act/三锁/gold/默认安全态。
   * @param {Array} targets 本批 entry 引用（仅用于取 id 与输入快照，写回时按 id 重取）
   * @returns {Promise} 仅供测试 await 的 job 句柄（生产调用方勿 await）
   */
  _queueBypassClassify(targets) {
    const list = Array.isArray(targets) ? targets : []
    const a = this._ai()
    if (!a || !a.cfg.enabled) return Promise.resolve()   // 总开关关 → 零调用、零入队
    // 入队前过滤在途项：同一条源正在判（字段还没写、worker 没结算）→ 本次不再排队，避免重复调 AI 花钱。
    // 键 `kind:id` 让项①(cold) 与项②(tips) 各自独立：同一 id 两种 kind 互不干扰，可各自排队。
    const inFlight = this._bypassInFlight || (this._bypassInFlight = new Set())
    // 入队时快照输入（id + 名字 + apiHosts + tips），不持有后续会变的引用内容
    const coldItems = list.filter(e => e && e.id != null && !e.sourceAiClass && !inFlight.has('cold:' + e.id)).map(e => ({
      id: String(e.id), name: e.lxName || e.scriptName || e.name, apiHosts: e.apiHosts,
      platformCount: Array.isArray(e.supportedSources) ? e.supportedSources.length : 0
    }))
    const tipItems = list.filter(e => e && e.id != null && Array.isArray(e.updateTips) && e.updateTips.length &&
      e.updateTipsAiClass === undefined && !inFlight.has('tips:' + e.id)).map(e => ({
      id: String(e.id), name: e.lxName || e.scriptName || e.name,
      tips: e.updateTips.map(t => String((t && t.msg) || '')).filter(Boolean)
    }))
    if (!coldItems.length && !tipItems.length) return Promise.resolve()
    // 标记在途（必须在调度 worker 之前同步加入）
    const inFlightKeys = coldItems.map(it => 'cold:' + it.id).concat(tipItems.map(it => 'tips:' + it.id))
    for (const k of inFlightKeys) inFlight.add(k)

    const worker = async () => {
      try {
        let coldDone = 0, tipDone = 0
        // stats 由 classify* 的返回值带出（withStats），不读实例属性 → 并发 worker 不会互相覆盖
        const acc = { retries: 0, retriedOk: 0, dropped: 0, droppedIds: 0, throttled: 0 }
        const takeStats = s => {
          if (!s) return
          acc.retries += s.retries || 0
          acc.retriedOk += s.retriedOk || 0
          acc.dropped += s.dropped || 0
          acc.droppedIds += s.droppedIds || 0
          acc.throttled += s.throttled || 0
        }
        if (coldItems.length) {
          try {
            const res = await a.classifyColdStart(coldItems, 'source', { withStats: true })
            takeStats(res && res.stats)
            const cls = (res && res.map) || {}
            for (const it of coldItems) {
              const c = cls && cls[it.id]
              if (!c) continue
              const e = this.store.db.sources[it.id]      // 按 id 重取（不持旧引用）
              if (!e) continue                             // 源已删除 → 不写回、不复活
              e.sourceAiClass = c.class; e.sourceAiReason = c.reason
              coldDone++
            }
          } catch (_) { /* 单批失败：该批不写，其余照常 */ }
        }
        if (tipItems.length) {
          try {
            const res = await a.classifyUpdateTips(tipItems, { withStats: true })
            takeStats(res && res.stats)
            const cls = (res && res.map) || {}
            for (const it of tipItems) {
              const c = cls && cls[it.id]
              if (!c) continue
              const e = this.store.db.sources[it.id]
              if (!e) continue
              if (c.substantive !== 'uncertain') { e.updateTipsAiClass = c.substantive; e.updateTipsAiReason = c.reason }
              else { e.updateTipsAiClass = 'uncertain'; e.updateTipsAiReason = c.reason }
              tipDone++
            }
          } catch (_) {}
        }
        if (coldDone || tipDone) {
          try { await this.store.saveDb() } catch (_) {}   // worker 自行落盘
        }
        // 重试/放弃情况一并进日志（真实实测：4 批连跑 45-50s 时必断一批，重试后仍有放弃要可见）
        const hasRetry = acc.dropped || acc.retries
        const retryNote = hasRetry
          ? `（重试 ${acc.retries} 次、救回 ${acc.retriedOk} 批` +
            (acc.dropped ? `、放弃 ${acc.dropped} 批 ${acc.droppedIds} 条` : '') +
            (acc.throttled ? `、限流 ${acc.throttled} 批` : '') + '）'
          : ''
        if (coldDone || tipDone || hasRetry) {
          this.log(`AI 旁路预判完成：项① 冷启动 ${coldDone} 条 / 项② 更新语义 ${tipDone} 条${retryNote}（已落盘，下批排序生效）`, 'AI旁路', 'info')
        }
      } finally {
        // 无论成功/失败/异常，都在结算时移除在途标记——否则失败的 id 会永久卡住、再也不重判
        for (const k of inFlightKeys) inFlight.delete(k)
      }
    }
    // 关键：用 _aiBackground 调度，**不 await**；捕获异常不外泄到主流程。
    let handle
    try {
      handle = Promise.resolve(this._aiBackground(worker)).catch(() => {})
    } catch (_) {
      // 调度器本身同步抛错（worker 从未执行 → 其 finally 不会跑）：这里兜住清理，避免永久卡住
      for (const k of inFlightKeys) inFlight.delete(k)
      handle = Promise.resolve()
    }
    return handle
  }

  /**
   * 突破项①阶段1：新仓验真前的冷启动语义预判（只排序，不删不拉黑）。
   * 返回「原集合的重排」；AI 未启用/失败/解析失败 → 原序（旁路降级）。
   * @param {string[]} repos 原始仓库名数组
   * @param {object} meta repo -> {id,name,description,topics}
   */
  async _coldStartPrioritizeRepos(repos, meta) {
    const arr = Array.isArray(repos) ? repos.slice() : []
    if (arr.length < 2) return arr
    try {
      const a = this._ai()
      if (!a || !a.cfg.enabled) return arr                 // 总开关关 → 零 AI、零副作用
      const items = arr.map(r => (meta && meta[r]) || { id: r, name: r })
      // Step1（C 终审 §2）：全兜底态（没有任何仓库带 description/topics，只有仓库名）→
      // 预判无区分度、白花钱零收益，直接原序、不调用 AI。真实搜索链路凡入列必写 meta，此为防御保险。
      const usable = items.some(it => it && (it.description || (Array.isArray(it.topics) && it.topics.length)))
      if (!usable) return arr
      const cls = await a.classifyColdStart(items, 'repo')
      if (!cls || !Object.keys(cls).length) return arr      // 不预判 → 原序
      // v1.16 建议层：把 AI 明确判 'tool' 的仓库持久化到 cfg.repoAiHints，供 UI 建议层展示
      //（复用本次现成结论，零新增 AI 调用）。uncertain/real 一律不存、不提示——避免打扰。
      // 旁路写入：失败静默，绝不影响排序主链路；绝不据此自动拉黑（拉黑只能人工确认或走 R10 门控）。
      try {
        const cfg = this.store.config
        if (!cfg.repoAiHints || typeof cfg.repoAiHints !== 'object' || Array.isArray(cfg.repoAiHints)) cfg.repoAiHints = {}
        let changed = false
        for (const r of arr) {
          const c = cls[r]
          if (!c || c.class !== 'tool') continue
          const prev = cfg.repoAiHints[r]
          // 同一仓库已有同结论就不重复写，避免每轮爬取都刷 saveConfig
          if (prev && prev.cls === 'tool' && prev.reason === (c.reason || '')) continue
          cfg.repoAiHints[r] = { cls: 'tool', reason: String(c.reason || '').slice(0, 120), at: Date.now() }
          changed = true
        }
        if (changed) this.store.saveConfig()
      } catch (_) { /* 建议层旁路失败静默 */ }
      const { classifyReposPure } = require('./coldStart')
      return classifyReposPure(arr, cls)                    // 稳定重排，元素一个不少（low-value 延后不拉黑）
    } catch (e) { return arr }
  }

  /**
   * R2 裁决解释旁路：把 sameNameVerdict 的规则裁决解释成人话，落一条只读建议。
   * 只产出建议（aiSuggestions），不改裁决结果、不碰 queue。
   */
  _aiExplainVerdict(entryId, verdict, ctx) {
    try {
      const a = this._ai()
      if (!a || !a.cfg.enabled) return          // 总开关关闭 → 零副作用
      const { act, why, whyAi } = a.explainVerdict(verdict, ctx)
      const db = this.store.db
      if (!db.aiReviewLedger) db.aiReviewLedger = {}
      const fp = String(entryId) + '|' + String(act) + '|' + String(why)
      if (db.aiReviewLedger[fp]) return          // 同一指纹不重复建议
      a.suggest(entryId, 'R2', whyAi, [], {
        detail: a.makeDetail('R2', act, '同名裁决自动解释（不改裁决结果）'),
        trigger: 'event'
      })
      db.aiReviewLedger[fp] = true
    } catch (_) { /* 旁路失败静默，绝不影响主链路 */ }
  }

  /**
   * 影子评测旁路：只记录规则裁决的分区快照，本轮不调用 AI（aiAct 留空），零 provider 成本。
   * 真正的 AI 对拍留给离线评测脚本；此处仅写 db.aiEvalLog 审计容器。
   */
  _aiShadowEval(e, srv, code, verdict, cfg, opt) {
    try {
      const a = this._ai()
      if (!a || !a.cfg.enabled || !a.cfg.shadowEval) return   // 影子开关关闭 → 零副作用
      const snap = require('./evalSnapshot')
      const entry = e || {}
      const service = srv || {}
      const v = verdict || {}
      const snapshot = typeof snap.buildEvalSnapshot === 'function'
        ? snap.buildEvalSnapshot(entry, service, code, cfg, opt) : {}
      // 必须传 ruleAct：否则 danger 恒为 D0，最高危格 GREY×D1 无法被识别。
      const zone = typeof snap.evidenceClass === 'function'
        ? snap.evidenceClass(snapshot, v.act) : {}
      const zoneCodes = zone && zone.codes
      // 保留 'D0'/'D1' 字符串语义，不能 !! 塌成布尔——否则 makeEvalLog 收 true 会落非预期值。
      const danger = (zone && zone.danger) || 'D0'
      const db = this.store.db
      if (!db.aiEvalLog) db.aiEvalLog = {}
      const rec = (typeof snap.makeEvalLog === 'function')
        ? snap.makeEvalLog({
          phase: 'shadow', entryId: entry.id, srvId: service.id,
          ruleAct: v.act, ruleWhy: v.why,
          zone: zone && zone.zone, zoneCodes, danger, executed: false
        })
        : {
          phase: 'shadow', entryId: entry.id, srvId: service.id,
          ruleAct: v.act, ruleWhy: v.why,
          zone: zone && zone.zone, zoneCodes, danger,
          aiAct: '', executed: false, at: Date.now()
        }
      db.aiEvalLog[entry.id + '|' + String(rec.at || Date.now()) + '|' + Math.random().toString(36).slice(2, 8)] = rec
    } catch (_) { /* 旁路失败静默，绝不影响主链路 */ }
  }

  /**
   * P-1434 采集特征库·自动学习：判定「缺少洛雪音源特征」的非音源脚本，
   * 把文件名主干自动加入 crawlerBlockPatterns（去重、上限 300 条防膨胀）。
   * 手动清单与自动学习共用同一份列表（设置→采集源可编辑可删）。
   */
  _autoLearnBlockPattern(e) {
    const cfg = this.store.config
    if (!Array.isArray(cfg.crawlerBlockPatterns)) cfg.crawlerBlockPatterns = []
    const list = cfg.crawlerBlockPatterns
    const stem = String(e.scriptName || e.name || '').replace(/\.js$/i, '').trim()
    if (!stem || stem.length < 2 || stem.length > 60) return
    // P-1434 护栏：重度混淆正文的特征提取不可靠（jsjiami 加密后 lx 特征全变密文，
    // 可能实为真源被误判）——自动学习宁缺毋滥，混淆条目不入册（下次下载成功会重算）
    if (e.obfLevel === 'high') return
    if (list.some(x => String(x || '').toLowerCase() === stem.toLowerCase())) return
    if (list.length >= 300) {
      this.log(`特征库已达自动学习上限（300 条），本次不自动新增：${stem}`, '采集', 'warn')
      return
    }
    list.push(stem)
    this.store.saveConfig()
    this.log(`特征库自动学习：新增「${stem}」（判定非音源脚本，后续不再采集）`, '采集', 'info')
  }

  log(msg, module, level) {
    // P-1434：日志带轮次 batchId（runCheck/runImport/runPatrol/runCrawl 入口生成），
    // /api/logs?batch= 可按轮过滤，事后取证不再靠时间窗猜。
    this.emit('log', { msg, module: module || '任务', level: level || 'info', at: Date.now(), batch: this.batchId || undefined })
  }
  step(text) {
    this.job.step = text
    this.emit('step', { text })
  }
  progress(patch) {
    Object.assign(this.job.progress, patch)
    this.emit('progress', Object.assign({ step: this.job.step }, this.job.progress))
  }

  get cancelRequested() { return !!this.job.cancel }
  requestCancel() {
    if (!this.job.running) return false
    this.job.cancel = true
    this.log('收到取消请求，正在停止…', '任务', 'warn')
    return true
  }

  /**
   * 取当前选中的平台账号 { adapter, acct, type }（v1.8.0 多平台）。
   * 没有任何平台账号或没选中 → 抛清晰错误，避免后续服务端调用拿着空配置瞎跑。
   */
  _active() {
    const svc = getActiveService(this.store.config)
    if (!svc) throw new Error('未配置或未选择服务平台账号：请先在「设置」里添加并选中一个平台账号')
    return svc
  }

  // ---------------- 爬取 ----------------
  /**
   * @param {object} [opts] {incremental} —— 定时爬取传 true：
   *  已抓取的默认不重抓（blob sha / release 资产 key 判重），只收新音源；
   *  内容有变化的就地更新（压缩包/release 资产）或标记待重下（树内 .js）。
   */
  /**
   * 加速镜像自动维护（v1.9.19）：爬取前刷新一次镜像池，低频（默认 24 小时一次）。
   * 实测候选域名，通的入池、池内连续失败的剔除 —— 第三方反代域名经常整站下线，
   * 靠发版手工增删跟不上。force=true 时无视时间窗（设置页「自动发现镜像」按钮走它）。
   */
  async refreshMirrorPool(force) {
    const cfg = this.store.config
    if (!force && cfg.mirrorAutoDiscover === false) return null
    const hours = Math.max(1, Number(cfg.mirrorDiscoverHours) || 24)
    const last = Number(cfg.mirrorDiscoverAt) || 0
    if (!force && last && Date.now() - last < hours * 3600 * 1000) return null
    try {
      const { discoverMirrors } = require('./net')
      const r = await discoverMirrors({ timeoutMs: Math.min(8000, Number(cfg.timeoutMs) || 15000) })
      this.store.saveConfig({ mirrorPool: r.pool, mirrorDiscoverAt: Date.now() })
      const ok = (r.results || []).filter(x => x.ok).length
      this.log(`镜像自动发现：实测 ${r.total} 个候选，可用 ${ok} 个，新入池 ${r.added} 个、剔除失效 ${r.removed} 个`, '网络')
      return r
    } catch (e) {
      this.log('镜像自动发现失败：' + String((e && e.message) || e).slice(0, 80), '网络', 'warn')
      return null
    }
  }

  // 任务入口守卫（v1.10.8）：忙时拒绝必须落日志——过去只把「已有任务在运行」抛给前端 toast，
  // 日志页毫无痕迹（246 实测：用户点「采集」被拒，日志页只有登录记录，以为功能坏了）。
  // 请求本身也在这里留痕：哪怕被拒，日志里能看到「谁在什么时候想跑什么」。
  jobGate(kind, detail) {
    if (this.job.running) {
      const cur = `${this.job.type || '未知'}${this.job.step ? '（' + this.job.step + '）' : ''}`
      this.log(`任务被拒绝：已有任务在运行——${cur}；本次「${kind}${detail ? '：' + detail : ''}」未执行。可等当前任务结束，或在音源库页点停止`, '任务', 'warn')
      throw new Error(`已有任务在运行：${cur}（本次「${kind}」未执行，详见日志）`)
    }
  }

  /**
   * v1.17（配额优化 #5）：判断「上一轮爬取是不是刚开始就被进程杀掉」。
   *
   * 为什么需要：`crawlLastAttempt` 在 runCrawl 开跑时立刻写（hunter.js:1330），而
   * `crawlNextAt` 只在 finally 的 _finishCrawlSchedule 里写（:1526）。进程在两者之间被杀
   * （8197 实测每天重启 8~25 次）→ 下一轮启动时 crawlNextAt 仍是**上一轮之前**的值 →
   * 定时器判「已到期」→ 立刻重跑一整轮，白花约 62 次配额（实测 11-18 有两轮相隔 2 分钟）。
   *
   * 判据（两个条件同时成立才算「被打断」）：
   *   ① crawlLastAttempt 距今 < 10 分钟（刚开跑不久）
   *   ② crawlNextAt 落后于 crawlLastAttempt（说明那轮没算出下一轮 = 没正常收尾）
   * 只影响**定时器**触发；用户手动点采集不受影响（那是明确意图，应照跑）。
   *
   * @param {number} [now]
   * @param {number} [windowMs] 默认 10 分钟
   * @returns {{interrupted:boolean, ageMs:number, lastAttempt:number, nextAt:number}}
   */
  crawlAttemptInterrupted(now, windowMs) {
    const t = Number(now) || Date.now()
    const win = Number(windowMs) > 0 ? Number(windowMs) : 10 * 60 * 1000
    const lastAttempt = Number(this.store.db && this.store.db.crawlLastAttempt) || 0
    const nextAt = Number(this.store.db && this.store.db.crawlNextAt) || 0
    const ageMs = lastAttempt ? t - lastAttempt : Infinity
    const interrupted = !!lastAttempt && ageMs >= 0 && ageMs < win && nextAt < lastAttempt
    return { interrupted, ageMs, lastAttempt, nextAt }
  }

  async runCrawl(opts) {
    this.batchId = Date.now().toString(36).slice(-6)
    this.jobGate(opts && Array.isArray(opts.only) && opts.only.length ? '主动采集' : (opts && opts.incremental ? '定时增量爬取' : '全量爬取'), opts && Array.isArray(opts.only) && opts.only.length ? opts.only.join('、') : '')
    // v1.10.8 jobGate 竞态修复：jobGate 与下方正式 job 初始化之间隔着镜像池刷新/搜索发现等
    // await（网络调用可达数十秒，246 实测窗口内第二个全量爬取抢入并发），先同步占位，
    // 正式初始化处再覆盖完整进度；占位到初始化之间全部 await 均有内部 try/catch，无逃逸路径。
    this.job = { running: true, type: 'crawl', cancel: false, progress: {}, step: '准备中' }
    const cfg = this.store.config
    const incremental = !!(opts && opts.incremental)
    // v1.10.6 主动采集：opts.only 非空时只爬这几个仓库/网页站（清单页每行「采集」按钮）。
    // 定向模式只跳过「搜索发现 / 社区精选 / 采集站附加阶段」这些会扩面到别的仓库的环节，
    // **采集策略一律按设置走**（v1.10.7）：crawlSinceDays 时间窗、crawlLatestOnly 只收最新版
    // 与全量爬取完全一致——行级按钮只改变「采哪些仓库」，不改变「怎么采」。
    const onlyRepos = Array.isArray(opts && opts.only) ? opts.only.map(x => String(x || '').trim()).filter(Boolean) : []
    // 爬取前顺手刷新镜像池（低频，失败不影响爬取）
    try { await this.refreshMirrorPool(false) } catch (e) {}
    // 合并计数提前声明（v1.10.0 修复）：下面的采集站阶段会引用 merge/total，
    // 原先声明在 try 块前一行，TDZ 引用直接 ReferenceError —— 有采集站配置时爬取必炸。
    const merge = { added: 0, updated: 0, skipped: 0 }
    let total = 0
    // v1.10.7：爬取统计提到 try 外，返回给前端（行级采集要回报「被时间窗跳过」的原因）
    let crawlStats = null
    // reposOverride 非空时只爬这些仓库（省 GitHub 配额，也便于定向补源）
    let repos
    if (onlyRepos.length) {
      // v1.10.6 主动采集：优先级最高，明确覆盖 reposOverride（用户点行级按钮的意图最具体）
      repos = this._normRepos(onlyRepos, '主动采集')
      if (!repos.length) throw new Error('主动采集：没有可识别的仓库（应为 owner/repo、GitHub 网址或网页站网址）')
    } else if (Array.isArray(cfg.reposOverride) && cfg.reposOverride.length) {
      repos = this._normRepos(cfg.reposOverride, '定向仓库')
    } else {
      // v1.9.12：优先用统一仓库清单 cfg.repos（内置/附加/发现三类，可禁用/删除）。
      // 未迁移（repos 非数组）时回退到旧逻辑（DEFAULT_REPOS + customRepos），保证兼容。
      const rl = Array.isArray(cfg.repos) ? cfg.repos : null
      repos = buildRepoSeeds(cfg)
      // knownRepos 含全部 cfg.repos（含被禁用的）与库内已有仓库——
      // 搜索发现（v1.9.9）与社区精选（v1.9.18）共用：已禁用的不会被重新发现并启用。
      const knownRepos = new Set()
      if (rl) for (const r of rl) { const n = normalizeRepo(r.repo); if (n) knownRepos.add(n) }
      for (const e of this.store.getSources()) if (e && e.repo) knownRepos.add(normalizeRepo(e.repo) || e.repo)
      // v1.10.3 黑名单：被「非音源仓库清理」判定删除的仓库（播放器/管理器/网关等），
      // 即使名字/描述仍像音源仓库，也不再由搜索发现或社区精选加回清单。
      const blockedRepos = new Set((Array.isArray(cfg.blockedRepos) ? cfg.blockedRepos : [])
        .map(x => String(x || '').toLowerCase()).filter(Boolean))
      // v1.9.9 搜索发现：用关键词在 GitHub 搜索新仓库，作为种子的增量补充（不替换种子）。
      // 仅在非定向爬取（reposOverride 为空）且用户开启 searchEnabled 时触发。
      if (cfg.searchEnabled && Array.isArray(cfg.searchKeywords) && cfg.searchKeywords.length) {
        // v1.10.3：搜索发现节流——距上次满 searchDiscoverHours 小时才跑，避免每轮都白烧搜索/验真配额
        const dHours = Math.max(0, Number(cfg.searchDiscoverHours) || 0)
        const dLast = Number(cfg.searchDiscoverAt) || 0
        const dDue = !dHours || (Date.now() - dLast >= dHours * 3600000)
        if (!dDue) {
          this.log(`搜索发现：距上次不足 ${dHours} 小时，本轮跳过以省配额（可在设置调整节流时长或填 0 关闭）`, '爬取')
        } else {
        try {
          const d = await discoverReposViaSearch({
            keywords: cfg.searchKeywords, token: cfg.ghToken,
            maxReposPerKeyword: Number(cfg.maxReposPerKeyword) || 20,
            maxTotal: Number(cfg.maxSearchReposTotal) || 60,
            timeoutMs: cfg.timeoutMs, known: knownRepos,
            skipStarsBelow: Number(cfg.searchMinStars) || 0,
            // v1.9.14 内容验真：搜索命中只保证「名字/描述像音源仓库」，不保证真有脚本。
            // 逐个拉文件树抽检 .js（scoreEntry>=4），并放行压缩包分发与 Release 资产分发的仓库。
            verify: cfg.searchVerify !== false,
            verifyConcurrency: 4,
            // v1.17 负缓存（配额优化 #1）：7 天内确定性判死的仓库不再重验。
            // 实测单轮 150~190 次配额几乎全花在「46 个名字像音源、实际无音源」的重复验真上。
            negativeCache: (cfg.ghNegativeCache && typeof cfg.ghNegativeCache === 'object') ? cfg.ghNegativeCache : null,
            negativeTtlMs: Number(cfg.ghNegativeTtlDays) > 0 ? Number(cfg.ghNegativeTtlDays) * 86400000 : undefined,
            // 突破项①阶段1：验真前批量语义预判，只把像真音源仓的排前面（低价值只延后不拉黑）
            prioritize: (repos, meta) => this._coldStartPrioritizeRepos(repos, meta)
          })
          // v1.17：把本轮验真结论并进负缓存（null=验真通过→删；对象=确定性判死→记 7 天）
          this._mergeNegativeCache(d && d.negNew)
          if (d && Array.isArray(d.negHits) && d.negHits.length) {
            this.log(`搜索发现：${d.negHits.length} 个仓库 7 天内已确认无音源，跳过重验（省约 ${d.negHits.length * 3} 次配额）`, '爬取')
          }
          // 黑名单里的仓库（曾判定为非音源后被清理）直接丢弃，不再回填清单
          const dReposNew = d.repos.filter(n => !blockedRepos.has(String(normalizeRepo(n) || n).toLowerCase()))
          const blockedNow = d.repos.length - dReposNew.length
          d.repos = dReposNew
          if (d.repos.length) {
            repos = repos.concat(d.repos)
            // v1.9.12：把搜索发现的新仓库持久化进仓库清单，使其可被用户单独禁用/删除、且后续记住。
            if (rl) {
              const have = new Set(rl.map(r => normalizeRepo(r.repo)))
              let changed = false
              for (const nr of d.repos) {
                const k = normalizeRepo(nr)
                if (k && !have.has(k)) { rl.push({ repo: k, enabled: true, builtin: false, origin: 'discovered' }); have.add(k); changed = true }
              }
              if (changed) this.store.saveConfig()
            }
            const dropped = Object.values(d.perKeyword || {}).reduce((n, x) => n + (Number(x.filtered) || 0), 0)
            const noSrc = Number(d.droppedNoSource) || 0
            this.log(`搜索发现新增 ${d.repos.length} 个仓库（来自 ${d.searched} 个关键词，跳过已收录` +
              (dropped ? `，过滤无关 ${dropped} 个` : '') +
              (noSrc ? `，验真剔除 ${noSrc} 个无音源内容` : '') + '）', '爬取')
          } else {
            const dropped = Object.values(d.perKeyword || {}).reduce((n, x) => n + (Number(x.filtered) || 0), 0)
            const noSrc = Number(d.droppedNoSource) || 0
            this.log('搜索发现：本轮未找到可用新仓库（可能都已收录或搜索受限' +
              (dropped ? `；已过滤 ${dropped} 个无关仓库` : '') +
              (blockedNow ? `；黑名单拦截 ${blockedNow} 个` : '') +
              (noSrc ? `；验真剔除 ${noSrc} 个无音源内容` : '') + '）', '爬取')
          }
        } catch (e) {
          this.log('搜索发现失败：' + String((e && e.message) || e).slice(0, 100), '爬取', 'warn')
        }
        // 记录本次发现时间（无论是否命中都算跑过一轮），用于节流
        this.store.config.searchDiscoverAt = Date.now()
        this.store.saveConfig()
        }
      }
      // v1.9.18 社区精选订阅（借鉴 lx-hub 的 community.json market）：
      // 拉取人工审核过的精选清单，type=repo 的条目并入种子（origin=community）。
      // 与搜索发现互补——搜索靠关键词自动发掘，精选是社区实打实验证过的活跃源。
      // 人工审核过 → 跳过 verifyRepoHasSource 省配额；拉取失败只记 warn，不影响爬取。
      if (cfg.communityEnabled !== false) {
        try {
          const cf = await fetchCommunityRepos(cfg)
          if (cf.ok) {
            // 仓库大小写不敏感，与已知清单/清单内已有条目都按小写比对，避免同仓不同写法重复入库
            const knownLower = new Set(Array.from(knownRepos).map(x => String(x).toLowerCase()))
            const fresh = cf.repos.filter(n => !knownLower.has(n.toLowerCase()) && !blockedRepos.has(n.toLowerCase()))
            if (fresh.length) {
              for (const n of fresh) { knownRepos.add(n); knownLower.add(n.toLowerCase()) }
              repos = repos.concat(fresh)
              if (rl) {
                const have = new Set(rl.map(r => { const k = normalizeRepo(r.repo); return k ? k.toLowerCase() : '' }))
                let changed = false
                for (const n of fresh) {
                  const k = normalizeRepo(n)
                  if (k && !have.has(k.toLowerCase())) { rl.push({ repo: k, enabled: true, builtin: false, origin: 'community' }); have.add(k.toLowerCase()); changed = true }
                }
                if (changed) this.store.saveConfig()
              }
              this.log(`社区精选新增 ${fresh.length} 个仓库（订阅源更新于 ${cf.updatedAt || '未知时间'}，精选共 ${cf.total} 条）`, '爬取')
            } else {
              this.log('社区精选：暂无新增（精选仓库均已收录）', '爬取')
            }
          } else {
            this.log('社区精选：feed 格式异常（' + (cf.error || '未知') + '），本轮跳过', '爬取', 'warn')
          }
        } catch (e) {
          this.log('社区精选拉取失败：' + String((e && e.message) || e).slice(0, 100), '爬取', 'warn')
        }
      }
      // v1.9.19 音源采集站：挂进来的第三方筛选站，在爬取时一并采回「站点实测可用」的音源。
      // 判重零下载——站点返回的 sha256 与 lx-hunter contentHash 同算法，直接采信（见 hubfeed.js）。
      // 站点标 usable 的信任其判定入库，本地检测/巡检负责复检。失败只记日志，不影响 GitHub 爬取。
      if (Array.isArray(cfg.hubs) && cfg.hubs.length) {
        try {
          const hr = await collectFromHubs({
            store: this.store, cfg, timeoutMs: cfg.timeoutMs,
            onLog: (msg, module, level) => this.log(msg, module || '采集', level),
            shouldStop: () => this.cancelRequested
          })
          if (hr.hubTotal) {
            if (hr.added) { merge.added += hr.added; total = merge.added }
            this.log(`采集站：${hr.hubTotal} 个站点，新增 ${hr.added} 条`, '采集')
            this.progress({ added: total })
          }
        } catch (e) {
          this.log('采集站采集失败：' + String((e && e.message) || e).slice(0, 100), '采集', 'warn')
        }
      }
    }
    // v1.13.0（配额优化第 3 项）：3 天内已确认 404 的仓库直接跳过。
    // 以前 deadRepos 只活在当轮 stats，内置仓库（autoClean 不动它们）和组织改名后被 404 的仓库
    // 每轮都要重新探一次 —— 明知死了还天天问。行级主动采集不过滤（用户点了就是想要一次重试机会）。
    if (!onlyRepos.length) {
      const dead = this.store.db.deadRepos && typeof this.store.db.deadRepos === 'object' ? this.store.db.deadRepos : null
      if (dead) {
        const fr = filterDeadRepos(repos, dead)
        if (fr.skipped.length) {
          this.log(`跳过 ${fr.skipped.length} 个 3 天内已确认 404 的仓库（省探测配额；仓库恢复或被改名后会自动回来）`, '爬取', 'warn')
          repos = fr.keep
        }
      }
      // P1-2：按本地历史产出/新鲜度/健康度排序，并强制防饥饿（新仓每轮保底名额）。
      // onlyRepos / reposOverride 定向分支不排序；deadRepos TTL 过滤已在上方完成、此处不碰。
      if (!(Array.isArray(cfg.reposOverride) && cfg.reposOverride.length)) {
        const ranked = rankRepoSeeds(repos, {
          sources: this.store.getSources(),
          deadRepos: dead,
          hubRepos: (Array.isArray(cfg.hubs) ? cfg.hubs : []).reduce((m, h) => { if (h && h.url) m[normalizeRepo(h.url) || h.url] = h; return m }, {}),
          now: Date.now()
        })
        repos = ranked.ordered
      }
    }
    this.job = { running: true, type: 'crawl', cancel: false, progress: { reposDone: 0, repoTotal: repos.length, added: 0, linksFound: 0 }, step: '' }
    this.emit('job', { running: true, type: 'crawl' })
    this.log((onlyRepos.length ? '主动采集' : incremental ? '定时增量爬取' : '开始爬取') + ` ${repos.length} 个仓库（文件树 + Releases）…`, '爬取')
    // v1.13.0：水位推进放到「开始」而不是「成功」—— 失败也要留痕，否则定时器永远判「到期」
    this.store.db.crawlLastAttempt = Date.now()
    this.store.saveDb()
    let crawlError = null
    // v1.17：开跑前把落盘的 ETag 缓存灌回内存（跨重启复用 304）。失败只当没缓存。
    this._loadGhEtagCache()
    try {
      const known = this._knownMaps()   // 手动/定时爬取都用判重地图：压缩包 sha 未变不解压、release 资产已抓不重下
      // crawlSinceDays（v1.7.2）：只爬 N 天内有更新的仓库（0=不限）。静默仓库整仓跳过，
      // 新发布的 release 资产也按发布时间过滤——树内文件不受影响（sha 判重已覆盖）。
      // v1.10.7：行级主动采集同样吃这个时间窗（只改变采哪些仓库，不改变怎么采）。
      const sinceDays = Math.max(0, Number(cfg.crawlSinceDays) || 0)
      // v1.10.0：仓库清单里可能有「网页音源站」（http(s) 网址，非 owner/repo）。
      // 两类分流：GitHub 仓库走 crawl()（API 配额），网页站走 crawlWebSite()（纯 HTTP，零配额）。
      const ghRepos = repos.filter(r => !isWebRepo(r))
      const webRepos = repos.filter(r => isWebRepo(r))
      if (webRepos.length) {
        this.log(`其中 ${webRepos.length} 个为网页音源站（非 GitHub），走通用网页解析采集`, '爬取')
      }
      const latestOnly = cfg.crawlLatestOnly !== false
      // v1.10.7：行级主动采集同样按设置走，把生效策略明写进日志，
      // 避免用户点了「采集」却以为是「无条件整仓全采」。
      if (onlyRepos.length) {
        this.log(`主动采集遵循设置：${sinceDays ? `只爬 ${sinceDays} 天内有更新的仓库` : '时间窗不限（0 天）'}；${latestOnly ? '同组只收最新版' : '保留全部版本'}`, '爬取')
      }
      // 爬取事件的统一处理（GitHub 爬取与网页站采集共用一套合并逻辑）
      const onCrawlEvent = (type, payload) => {
        if (type === 'repo') {
          // 统一走增量合并（v1.7.0）：手动爬取与定时爬取行为一致——
          // 已抓取的不重抓（blob sha/资产 key/内容哈希判重），内容变了标 updated/stale 待重下。
          const m = this.store.mergeSources(payload.items, { incremental: true })
          merge.added += m.added; merge.updated += m.updated; merge.skipped += m.skipped
          total = merge.added
          this.progress({ added: total, linksFound: (this.job.progress.linksFound || 0) + payload.candidates })
        } else if (type === 'log') {
          this.log(payload.msg, payload.module, payload.level)
        } else if (type === 'progress') {
          this.step(payload.step)
          this.progress({ reposDone: payload.reposDone, repoTotal: payload.repoTotal })
        }
      }
      if (ghRepos.length) {
        setCrawlBlockPatterns(cfg.crawlerBlockPatterns)
        crawlStats = await crawl({ repos: ghRepos, token: cfg.ghToken, maxCandidatesPerRepo: cfg.maxCandidatesPerRepo, timeoutMs: cfg.timeoutMs, mirror: cfg.mirror, known, sinceDays, latestOnly },
          onCrawlEvent,
          () => this.cancelRequested)
      } else if (webRepos.length) {
        this.log('仓库清单中没有 GitHub 仓库，跳过 GitHub 爬取（不消耗 API 配额）', '爬取')
      }
      // v1.10.7：行级主动采集被设置的时间窗挡下时，必须如实说明原因——
      // 否则用户看到「新增 0 条」会以为按钮坏了，而不是「该仓库在设置的时间窗内没有更新」。
      if (onlyRepos.length && crawlStats && crawlStats.staleSkipped) {
        const names = (crawlStats.staleRepos || []).slice(0, 5).join('、')
        this.log(`主动采集：${names}${(crawlStats.staleRepos || []).length > 5 ? ' 等' : ''} 在 ${sinceDays} 天内无提交且无新发布，按设置整仓跳过；如需强制采集，把设置页「只爬近期更新的仓库」改为 0`, '爬取', 'warn')
      }
      // 网页音源站 / 站外分发源采集（v1.10.0 → v1.11.0）：与 GitHub 爬取并列的一类来源
      if (webRepos.length) {
        let stateDirty = false
        if (!cfg.externalStates || typeof cfg.externalStates !== 'object') cfg.externalStates = {}
        for (let wi = 0; wi < webRepos.length; wi++) {
          if (this.cancelRequested) break
          const site = webRepos[wi]
          this.step(`采集站外源 ${wi + 1}/${webRepos.length} ${site}`)
          this.progress({ reposDone: ghRepos.length + wi + 1, repoTotal: repos.length })
          try {
            // 时间窗：把上次响应体指纹带进去，内容未变即「sinceDays 天内无新音源」整源跳过。
            // externalStates 按 URL 独立存，覆盖从旧「网页音源站」入口加进 repos 的 URL。
            const st = await crawlWebSite(site, {
              timeoutMs: cfg.timeoutMs, latestOnly, sinceDays,
              knownExternal: cfg.externalStates[site] || null
            }, onCrawlEvent, () => this.cancelRequested)
            if (st && st.hash) {
              cfg.externalStates[site] = { hash: st.hash, at: Date.now() }
              stateDirty = true
            }
            const rec = (Array.isArray(cfg.externalSources) ? cfg.externalSources : [])
              .find(x => x && (normalizeExternalUrl(x.url) || x.url) === site)
            if (rec) {
              rec.lastCrawl = {
                at: Date.now(), ok: !!(st && st.ok), mode: (st && st.mode) || '',
                hash: (st && st.hash) || '', added: (st && st.collected) || 0,
                skippedOld: (st && st.droppedOld) || 0, reason: (st && st.reason) || '',
                lastModified: (st && st.lastModified) || ''
              }
              if (st && st.ok && st.mode && st.mode !== 'unchanged') rec.kind = st.mode
              stateDirty = true
            }
          } catch (e) {
            this.log(`站外源 ${site} 采集异常：` + String((e && e.message) || e).slice(0, 100), '爬取', 'warn')
          }
        }
        if (stateDirty) this.store.saveConfig()
      }
      // v1.13.0（配额优化第 3 项）：把 404 结果持久化，供下一轮直接跳过。
      // 只记确定性 404（crawl 里只有 404 才进 deadRepos），临时失败/限流不会进这张表。
      if (crawlStats && Array.isArray(crawlStats.deadRepos)) {
        const dead = this.store.db.deadRepos && typeof this.store.db.deadRepos === 'object' ? this.store.db.deadRepos : {}
        const deadSet = new Set(crawlStats.deadRepos.map(r => normalizeRepo(r) || r))
        for (const r of deadSet) dead[r] = { at: Date.now(), hits: ((dead[r] && dead[r].hits) || 0) + 1 }
        // 本轮探到活的 → 从死亡名单摘掉（组织改名修好/仓库恢复后自动回来）
        for (const r of repos) {
          const n = normalizeRepo(r) || r
          if (!deadSet.has(n) && dead[n]) delete dead[n]
        }
        this.store.db.deadRepos = dead
      }
      // v1.10.3：失效仓库自动清理（仅非内置；只删确定性 404，不误删临时失败/限流）
      if (crawlStats && Array.isArray(crawlStats.deadRepos) && crawlStats.deadRepos.length && cfg.autoCleanDeadRepos !== false) {
        const deadSet = new Set(crawlStats.deadRepos.map(r => normalizeRepo(r) || r))
        const rl = Array.isArray(this.store.config.repos) ? this.store.config.repos : null
        if (rl) {
          const removed = []
          this.store.config.repos = rl.filter(x => {
            if (x && x.origin === 'builtin') return true   // 内置不自动删（可用「恢复默认」找回）
            const n = normalizeRepo(x && x.repo) || (x && x.repo)
            if (deadSet.has(n)) { removed.push(x.repo); return false }
            return true
          })
          if (removed.length) {
            this.store.saveConfig()
            this.log(`失效仓库自动清理：移除 ${removed.length} 个 404 仓库（${removed.slice(0, 8).join('、')}${removed.length > 8 ? '…' : ''}）`, '爬取', 'warn')
          }
        }
      }
      this.store.db.lastCrawl = Date.now()
      this.store.saveDb()
      this.log(`${incremental ? '定时爬取' : '爬取'}完成：新增 ${merge.added} 条、内容更新 ${merge.updated} 条、跳过已抓取 ${merge.skipped} 条。库内共 ${Object.keys(this.store.db.sources).length} 条`, '爬取')
      // 只给「没有指纹 + 内容可能变了（stale）」的条目建指纹，不做全库重扫
      const needHash = this.store.getSources().filter(e => !e.deprecated && !e.fromServer && (e.contentHash == null || e.stale))
      if (needHash.length && !this.cancelRequested) {
        this.step('增量指纹：为新条目与内容变化条目建立指纹…')
        const hr = await this._hashPass(needHash.map(e => e.id))
        this.log(`增量指纹完成：${hr.hashed} 条已下载校验`, '去重')
      }
      await this.dedupe()
    } catch (e) {
      crawlError = e || new Error('未知爬取错误')
      this.log('爬取异常：' + String((e && e.message) || e), '爬取', 'error')
    } finally {
      this.job.running = false
      // v1.17：每轮结束把 ETag 缓存落盘（节流写盘：一轮只写一次，避免频繁 IO）。
      // 放在 job 状态复位后、调度计算前：写盘失败也只丢缓存，不影响调度。
      this._saveGhEtagCache()
      this.emit('job', {
        running: false, type: 'crawl', done: true,
        summary: Object.assign({ incremental }, merge)
      })
      // v1.13.0：算下一次什么时候允许再跑（配额 → 代理/镜像 → 指数退避），
      // 读盘失败也不能影响任务收尾，所以整体 try 包住
      try { await this._finishCrawlSchedule(crawlError) } catch (e) { /* 调度计算失败不影响本轮结果 */ }
    }
    return {
      added: total, updated: merge.updated, skipped: merge.skipped,
      // v1.10.7：把「被设置的时间窗跳过」如实带回前端，行级采集才能解释「为什么 0 条」
      staleSkipped: (crawlStats && crawlStats.staleSkipped) || 0,
      staleRepos: (crawlStats && crawlStats.staleRepos) || [],
      sinceDays: Math.max(0, Number(cfg.crawlSinceDays) || 0),
      latestOnly: cfg.crawlLatestOnly !== false
    }
  }

  /**
   * v1.17：带缓存的仓库验真（配额优化 #3）。R10（pruneAiRepos）与「清理非音源仓库」
   * （_pruneNonSourceRepos）共用同一份缓存 —— 两个入口在近轮重复验同一批仓时只花一次配额。
   * 只缓存确定性结论；临时失败（403/429/5xx/网络/超时）不缓存，下轮可重试。
   * @param {string} repo
   * @param {object} cfg store.config
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async _verifyRepoCached(repo, cfg) {
    const VERIFY_TTL = 30 * 60 * 1000
    if (!this._repoVerifyCache) this._repoVerifyCache = new Map()
    const key = String(repo).toLowerCase()
    const hit = this._repoVerifyCache.get(key)
    if (hit && Date.now() - hit.at < VERIFY_TTL) return hit.v
    let v
    try {
      v = await verifyRepoHasSource(repo, { token: cfg.ghToken, timeoutMs: cfg.timeoutMs })
    } catch (e) {
      v = { ok: false, reason: 'ERR ' + String((e && e.message) || e) }
    }
    if (!v || !crawlerMod.isTransientVerifyReason(v.reason)) {
      this._repoVerifyCache.set(key, { at: Date.now(), v })
    }
    return v
  }

  /**
   * v1.17：把本轮搜索验真的结论并进 cfg.ghNegativeCache（配额优化 #1）。
   *  - 值 = {at, reason} → 确定性判死，记下 TTL（默认 7 天）后重验；
   *  - 值 = null → 本轮验真通过，删除旧结论（仓库补了音源，不能被旧结论压制）。
   * 临时失败上游已过滤，这里不再判断。写盘失败静默（绝不影响采集）。
   * @param {object} negNew { 'owner/repo': {at,reason}|null }
   */
  _mergeNegativeCache(negNew) {
    if (!negNew || typeof negNew !== 'object') return
    const keys = Object.keys(negNew)
    if (!keys.length) return
    try {
      const cfg = this.store.config
      if (!cfg.ghNegativeCache || typeof cfg.ghNegativeCache !== 'object' || Array.isArray(cfg.ghNegativeCache)) cfg.ghNegativeCache = {}
      const cache = cfg.ghNegativeCache
      let added = 0, removed = 0
      for (const k of keys) {
        if (!k) continue
        if (negNew[k] === null) { if (cache[k]) { delete cache[k]; removed++ } continue }
        cache[k] = negNew[k]
        added++
      }
      // 容量上限：超 2000 条按 at 淘汰最旧（防止长期积累把 config 撑大）
      const all = Object.keys(cache)
      if (all.length > 2000) {
        all.sort((a, b) => (Number(cache[a] && cache[a].at) || 0) - (Number(cache[b] && cache[b].at) || 0))
        for (const k of all.slice(0, all.length - 2000)) delete cache[k]
      }
      if (added || removed) this.store.saveConfig()
    } catch (e) { /* 旁路：负缓存写失败不影响采集 */ }
  }

  /**
   * v1.17：ETag 缓存落盘（配额优化 #2）。
   * 为什么需要：8197 实测每天重启 8~25 次，纯内存 ETag 缓存每次冷启清空 →
   * v1.13.0 的 304 优化命中率 ≈ 0（每轮只命中 1 次）。落盘后跨重启复用，304 才真正生效。
   * 降级：读/写任何异常都只当「没缓存 / 这次没存」，最坏退化为旧行为（全量 200），绝不影响采集。
   */
  _loadGhEtagCache() {
    try {
      const snap = this.store.db.ghEtagCache
      if (!snap) return 0
      const n = crawlerMod.hydrateEtagCache ? crawlerMod.hydrateEtagCache(snap) : 0
      if (n) this.log(`GitHub ETag 缓存：从本地恢复 ${n} 条（跨重启复用 304，省全量请求）`, '爬取')
      return n
    } catch (e) { return 0 }
  }

  _saveGhEtagCache() {
    try {
      if (!crawlerMod.etagCacheSnapshot) return
      const snap = crawlerMod.etagCacheSnapshot()
      const n = snap && snap.items ? Object.keys(snap.items).length : 0
      if (!n) return
      this.store.db.ghEtagCache = snap
      this.store.saveDb()
    } catch (e) { /* 写盘失败只丢缓存，不影响采集 */ }
  }


  /**
   * 收尾：算出「下一次定时爬取最早什么时候允许跑」并落库（v1.13.0）
   *
   * 为什么必须有这一步：`lastCrawl` 只在成功路径写，失败时定时器判据恒为「到期」，
   * 于是 60 秒后又跑一轮 —— 爬取一挂就变成每分钟重跑。这里把失败也纳入调度：
   *   配额耗尽 → 按 GitHub 的 reset 时间；代理/镜像可用 → 2 分钟短重试；
   *   链路确实不通 → 5/15/30/60 分钟指数退避。
   *
   * @param {Error|null} error 本轮抛出的异常（null = 成功，含部分成功）
   */
  async _finishCrawlSchedule(error) {
    const db = this.store.db
    const cfg = this.store.config || {}
    const prev = db.crawlLastResult || null
    const attempts = error ? (Number(prev && prev.attempts) || 0) + 1 : 0

    let quota = null
    if (error) {
      // 可注入（单测用）：默认走真实 checkQuota，避免测试打 GitHub
      const probe = typeof this.quotaProbe === 'function' ? this.quotaProbe : checkQuota
      try { quota = await probe(1, cfg.ghToken) } catch (e) { quota = null }
    }
    // 代理在冷却期 = 这层兜底也不可用；读不到健康度时按"可用"处理（宁可早重试）
    let proxyHealthy = true
    try {
      const h = require('./net').getProxyHealth()
      proxyHealthy = !(h && Number(h.cooldownRemainingMs) > 0)
    } catch (e) { /* 保持 true */ }

    const plan = planNextCrawl({
      now: Date.now(),
      intervalHours: cfg.crawlIntervalHours,
      lastCrawl: db.lastCrawl || 0,
      lastResult: error ? { ok: false, attempts } : { ok: true },
      quota,
      proxyHealthy
    })

    db.crawlLastResult = error
      ? { ok: false, attempts, error: String((error && error.message) || error).slice(0, 300), at: Date.now() }
      : { ok: true, attempts: 0, at: Date.now() }
    db.crawlNextAt = plan.dueAt
    this.store.saveDb()

    if (error) {
      this.log(`定时爬取本轮失败（连续第 ${attempts} 次）：${plan.reason}；下次在 ${describeNextCrawl(plan)} 重试`, '爬取', 'warn')
    } else if (attempts === 0 && prev && prev.ok === false) {
      this.log(`定时爬取已恢复正常，下次按间隔 ${Math.max(1, Number(cfg.crawlIntervalHours) || 24)} 小时执行`, '爬取')
    }
  }

  /**
   * 单独跑一轮「音源采集站」采集（v1.9.19）：不动 GitHub 爬取，只从已添加的站点采可用音源。
   *
   * 与 runCrawl 内嵌的采集站阶段共用 collectFromHubs，之所以再开一个入口：
   *  1. 采集站是纯 JSON 抓取（毫秒级），没必要等一轮完整爬取（几十个仓库的文件树 + 资产）；
   *  2. 用户添加新站点后想立刻看效果，点一下就能验；
   *  3. 判重零下载，所以这一轮几乎不消耗 GitHub 配额，可以放心反复点。
   *
   * @returns {{added:number, perHub:Array, hubTotal:number}}
   */
  async runHubSync(opts) {
    this.jobGate('采集站同步', opts && opts.id ? String(opts.id) : '')
    const cfg = this.store.config
    // v1.10.6 主动采集：opts.id 非空时只采这一个站点（采集站列表每行「采集」按钮）
    const onlyId = (opts && opts.id) || null
    const hubs = Array.isArray(cfg.hubs) ? cfg.hubs.filter(h => h && h.enabled !== false && h.url && (!onlyId || h.id === onlyId)) : []
    if (onlyId && !hubs.length) throw new Error('采集站不存在或已禁用')
    if (!hubs.length) return { added: 0, perHub: [], hubTotal: 0 }
    this.job = { running: true, type: 'crawl', cancel: false, progress: { hubsDone: 0, hubTotal: hubs.length, added: 0 }, step: '采集站' }
    this.emit('job', { running: true, type: 'crawl' })
    this.log((onlyId ? '主动采集' : '采集') + ` ${hubs.length} 个音源采集站的可用音源（判重零下载）…`, '采集')
    let out = { added: 0, perHub: [], hubTotal: hubs.length }
    try {
      out = await collectFromHubs({
        store: this.store, cfg, timeoutMs: cfg.timeoutMs, onlyId,
        onLog: (msg, module, level) => this.log(msg, module || '采集', level),
        shouldStop: () => this.cancelRequested
      })
      out.hubTotal = hubs.length
      this.log(`采集站采集完成：新增 ${out.added} 条`, '采集')
      // 新增条目可能与库内已有内容重复（同一脚本被多个仓库搬运）→ 交给去重裁决
      if (out.added && !this.cancelRequested) await this.dedupe()
    } catch (e) {
      this.log('采集站采集异常：' + String((e && e.message) || e), '采集', 'error')
    } finally {
      this.job.running = false
      this.emit('job', { running: false, type: 'crawl', done: true, summary: { hubs: out.perHub.length, added: out.added } })
    }
    return out
  }

  /**
   * 质量守门（v1.12.0）：版本回归对比 + 软拦截。
   *
   * 背景：定时管线「增量爬取 → 检测 → 自动灌入」只看可用性，上游发布一个
   * 「能加载但平台通过范围缩水」的回归版本也会被原样灌进服务端（此前唯一维度
   * 是 contentHash 去重，内容变了就是「新版本」，没有质量维度）。
   *
   * 做法（借鉴 shellsec/lx-music-source 的 previousPassed/passed 回归对比，证据口径更保守）：
   *  - 每次深检收尾，把「实测通过平台集合」连内容指纹存成 passSnapshot；
   *  - 内容指纹变化（新版本）且上一版有通过记录时做回归对比：
   *    丢失的平台只认「上一版通过 ∧ 新版实测失败」，untested/skipped 算未定证据；
   *  - 判定「疑似回归」→ 写 e.regression（软标记，不改 usable），
   *    自动灌入跳过该版本（runAutoPipeline 过滤），手动检测/灌入不受限；
   *  - 复测恢复到不小于上一版范围 → 自动解除标记并更新快照。
   *
   * @param {object} e 音源条目（deep 已写入、applyProbeRecord 已跑过）
   * @returns {boolean} 是否标记了疑似回归
   */
  applyQualityGate(e) {
    if (!e || e.deprecated || e.fromServer) return false
    const fresh = !!(e.deep && e.deep.hash && e.contentHash && e.deep.hash === e.contentHash)
    const passed = fresh ? passedPlatforms(e.deep) : []
    const failed = fresh
      ? Object.keys(e.deep.platforms || {}).filter(s => e.deep.platforms[s] && e.deep.platforms[s].status === 'failed')
      : []
    const snap = e.passSnapshot
    const name = e.lxName || e.scriptName || e.name || e.id
    const now = Date.now()

    // ① 结果不新鲜（下载失败/取消等）：不动快照，也不判定
    if (!fresh) return false

    // ② 新版本全平台未过而上一版有通过记录：可用性本来就会挡住灌入，
    //    但这里补一个回归标记，让「这版比上版差」在界面上可见
    if (!passed.length) {
      if (snap && snap.sha && snap.sha !== e.contentHash && Array.isArray(snap.passed) && snap.passed.length) {
        e.regression = { suspected: true, sha: e.contentHash, prevSha: snap.sha, prevPassed: snap.passed, passed: [], lost: snap.passed.slice(), gained: [], at: now }
        this.log(`疑似回归：${name} 新版本五平台全未通过（上一版通过 ${snap.passed.join('/')}），已标记并停止自动灌入`, '质量', 'warn')
        return true
      }
      return false
    }

    // ③ 内容变化 + 上一版有通过记录 → 回归对比
    if (snap && snap.sha && snap.sha !== e.contentHash && Array.isArray(snap.passed) && snap.passed.length) {
      const j = regressionJudge(snap.passed, passed, failed)
      if (j.suspect) {
        e.regression = { suspected: true, sha: e.contentHash, prevSha: snap.sha, prevPassed: snap.passed, passed, lost: j.lost, gained: j.gained, at: now }
        this.log(`疑似回归：${name} 平台通过从 [${snap.passed.join('/')}] 缩小到 [${passed.join('/')}]（丢失 ${j.lost.join('/')}），先不自动灌入；手动检测/灌入不受限，复测恢复后自动解除`, '质量', 'warn')
        return true
      }
      // 新版本通过范围没有缩小：解除旧标记、快照推进到新版本
      // （推进仍守「只增不减」：新版只是没测全（快速模式）时别把基线记小）
      if (e.regression) e.regression = null
      if (passed.length >= snap.passed.length) e.passSnapshot = { sha: e.contentHash, passed, at: now }
      return false
    }

    // ④ 同内容复测：若带着疑似回归且本轮实测恢复到不小于上一版范围 → 解除
    if (e.regression && e.regression.suspected && e.regression.sha === e.contentHash) {
      const j = regressionJudge(e.regression.prevPassed || [], passed, failed)
      if (!j.suspect) {
        e.regression = null
        this.log(`回归解除：${name} 复测通过 [${passed.join('/')}]，不再小于上一版范围，恢复自动灌入资格`, '质量')
      }
    }

    // ⑤ 快照只增不减（同内容复测时通过数变小多为快速模式/波动，别把基线越记越低）
    if (!snap || !Array.isArray(snap.passed) || !snap.passed.length || passed.length >= snap.passed.length) {
      e.passSnapshot = { sha: e.contentHash, passed, at: now }
    }
    return false
  }

  /** 自动灌入候选的质量闸：带疑似回归标记（且标记对应当前内容）的版本不进自动灌入 */
  _autoImportBlocked(e) {
    return !!(e && e.regression && e.regression.suspected && e.regression.sha === e.contentHash)
  }

  /**
   * 定时任务全链路（v1.9.0）：增量爬取 → 检测新增/内容变化的音源 → 灌入可用音源。
   *
   * 为什么把三步串成一个方法，而不是在定时器里连着调三次：
   *  1. 「该检测谁」「该灌谁」都依赖「本次爬取动了哪些条目」，这个信息只有在爬取跑完那一刻才拿得到；
   *  2. job.running 是全局单任务锁，散着调会出现「爬取刚结束、检测还没起」的空窗，
   *     定时器下一轮 tick 可能又挤进来；
   *  3. 桌面版与 Web 版共用同一段逻辑，避免两边行为漂移。
   *
   * 灌入目标沿用与手动「检测并灌入」**完全一致**的口径（getBatchImportAccounts：设置里勾了
   * 「参与批量灌入」的账号；一个都没勾时回退当前选中账号）——自动任务不该另有一套目标选择规则，
   * 否则用户看到的设置和实际灌进去的地方会对不上。
   *
   * 任何一步失败都不中断整体收尾（只记日志），用户点取消则立刻停。
   *
   * @returns {{crawl:object|null, detect:object|null, import:object|null, skipped:string|null}}
   */
  async runAutoPipeline() {
    this.jobGate('自动流水线')
    const cfg = this.store.config
    const out = { crawl: null, detect: null, import: null, skipped: null }

    // ① 爬取前给库内每条拍个快照（指纹 + stale），跑完 diff 出「本次新增 / 内容变化」的条目。
    //    只比这两个字段：可用性、检测结果会被检测流程改写，拿它们做 diff 会把「本来就该重测」
    //    的条目全算成变化，白扩大检测范围。
    const before = new Map()
    for (const e of this.store.getSources()) before.set(e.id, { hash: e.contentHash || '', stale: !!e.stale })

    this.log('定时任务：开始增量爬取…', '定时')
    out.crawl = await this.runCrawl({ incremental: true })
    if (this.cancelRequested) { out.skipped = 'cancelled'; return out }

    // ② 待检测 = 本次新增 + 内容变化（指纹变了或标了 stale）+ 从未检测过的可本地检测条目
    const need = []
    for (const e of this.store.getSources()) {
      if (e.deprecated) continue
      if (e.fromServer && !e.url) continue          // 服务端原生且无脚本地址 → 本地检不了
      const prev = before.get(e.id)
      const isNew = !prev
      const changed = !!prev && (prev.hash !== (e.contentHash || '') || e.stale)
      const never = !(e.deep && e.deep.checkedAt)
      if (isNew || changed || never) need.push(e.id)
    }
    if (!need.length) {
      out.skipped = 'no-new-sources'
      this.log('定时任务：本次没有新增或内容变化的音源，跳过检测与灌入', '定时')
      return out
    }
    this.log(`定时任务：检测 ${need.length} 条新增/内容变化的音源…`, '定时')
    try { out.detect = await this.runCheck(need) } catch (e) {
      this.log('自动检测失败：' + String((e && e.message) || e), '定时', 'error')
      // runCheck 中途抛错可能没走到收尾，先把任务锁放开，否则紧接着的灌入会被自己挡住
      this.job.running = false
    }
    if (this.cancelRequested) { out.skipped = 'cancelled'; return out }

    // ③ 灌入 = 可用 ∧ 有脚本地址（或正文已随条目保存，如私人音源） ∧ 灌入目标账号里还有没灌过的。
    //    粗筛用本地账本挡掉「每个目标都灌过了」的，避免每轮定时任务都拿整库走一遍裁决；
    //    服务端上那条到底还在不在，交给 runImport 内部的服务端列表 + 账本对账去发现。
    //    v1.12.0 质量守门：带「疑似回归」标记的版本不进自动灌入（软拦截——手动检测/灌入
    //    不受限，复测恢复后 applyQualityGate 会自动解除标记）。
    const targets = getBatchImportAccounts(cfg)
    const tids = targets.map(a => a && a.id).filter(Boolean)
    const activeId = cfg.activePlatformId || null
    const all = this.store.getSources()
      .filter(e => !e.deprecated && e.usable && (e.url || typeof e.code === 'string'))
      .filter(e => !this._importedEverywhere(e.id, tids, activeId, e.contentHash))
    // v1.13.0 服务端处置冻结：服务端禁用 / 单平台禁用 / 护栏隔离 / 删除过的音源，
    // 同一份内容不再自动灌回（内容更新后 computeVeto 会自然解冻）。
    const { keep: allLive, frozen } = splitFrozen(this.store.db.veto, all)
    if (frozen.length) {
      this.log(`服务端处置冻结：${frozen.length} 条不参与本轮自动灌入（` +
        frozen.slice(0, 5).map(x => x.entry.lxName || x.entry.scriptName || x.entry.name || x.entry.id).join('、') +
        (frozen.length > 5 ? ' 等' : '') + `）；这些音源内容更新后自动解冻`, '灌入', 'warn')
    }
    const gated = allLive.filter(e => this._autoImportBlocked(e))
    if (gated.length) {
      this.log(`质量守门：${gated.length} 条疑似回归版本本轮不自动灌入（` +
        gated.slice(0, 5).map(e => e.lxName || e.scriptName || e.name || e.id).join('、') +
        (gated.length > 5 ? ' 等' : '') + `）；音源库带「疑似回归」徽章，人工复测通过后自动解除`, '质量', 'warn')
    }
    const ids = allLive.filter(e => !this._autoImportBlocked(e)).map(e => e.id)
    if (!ids.length) {
      out.skipped = 'nothing-to-import'
      this.log('定时任务：新增音源里没有可灌入的（检测未通过，或灌入目标账号都已有），本轮结束', '定时')
      return out
    }
    const label = targets.map(a => a.name || a.url).filter(Boolean).join('、') || '当前选中账号'
    this.log(`定时任务：把 ${ids.length} 条可用音源灌入目标账号（${label}）…`, '定时')
    try { out.import = await this.runImport(ids) } catch (e) {
      this.log('自动灌入失败：' + String((e && e.message) || e), '定时', 'error')
    }
    if (out.import) this.log(`定时任务完成：灌入成功 ${out.import.ok} / ${out.import.results.length}` +
      (out.import.skipped ? `、跳过 ${out.import.skipped}` : ''), '定时')
    return out
  }

  /**
   * 该音源是否已经在**所有**灌入目标账号上都有灌入记录（v1.9.0，定时自动灌入的粗筛）。
   * 用来挡掉「每个目标账号都灌过了」的音源，避免每轮定时任务都拿整库去走一遍裁决。
   * 只灌过其中一部分账号、或从没灌过 → 返回 false，让它进候选去补灌（与「检测并灌入」
   * 的 `importedState(e) !== 'all'` 口径一致）。
   *
   * 注意这只是**粗筛**，不是最终判定：服务端上那条是不是真的还在，由 runImport 内部
   * 的服务端列表 + 账本对账负责（用户手动删过服务端时，只有那边才能发现）。
   */
  _importedEverywhere(eid, targetIds, activeId, currentHash) {
    if (!targetIds || !targetIds.length) return false
    const rec = this.store.imported[eid]
    if (!rec) return false
    // 音源换了新版（contentHash 变了）→ 账本里那份是旧内容，不算「灌过这一版」，
    // 让它进候选重新灌（否则按名字/id 记账的源换版后永远进不了自动灌入队列）。
    // 老账本没有 contentHash、或本地这次没算出 hash → 维持原逻辑，避免误判。
    if (rec.contentHash && currentHash && rec.contentHash !== currentHash) return false
    const got = new Set()
    if (rec.platformId) got.add(rec.platformId)
    for (const x of (Array.isArray(rec.importedTo) ? rec.importedTo : [])) if (x && x.platformId) got.add(x.platformId)
    if (rec.platformId == null && activeId) got.add(activeId)   // 老记录（v1.8.0 前）归当前选中账号
    return targetIds.every(id => got.has(id))
  }

  /** 增量判重地图：树内压缩包 sha（仓库::路径 → 上次见到的 blob sha）与 release 资产 key 集合 */
  _knownMaps() {
    const archiveSha = {}
    const assetKeys = new Set()
    for (const e of this.store.getSources()) {
      if (e.archive && e.archiveSha) archiveSha[e.repo + '::' + e.archive] = e.archiveSha
      if (e.assetKey) assetKeys.add(e.assetKey)
    }
    return { archiveSha, assetKeys }
  }

  /** 规范化用户输入的仓库列表（支持完整 URL），无效项告警 */
  _normRepos(list, label) {
    const out = []
    for (const r of list || []) {
      const n = normalizeRepo(r)
      if (!n) { this.log(`无法识别的${label}格式：${r}（应为 owner/repo 或 GitHub 仓库网址）`, '爬取', 'warn'); continue }
      if (out.indexOf(n) === -1) out.push(n)
    }
    return out
  }

  // ---------------- 去重 ----------------
  dedupe() {
    const all = this.store.getSources()
    const res = { dupContent: 0, oldVersion: 0, dupFile: 0 }
    let weakSkipped = 0   // 弱文件名（纯数字/通用名/过短）：不参与按名判重
    const dep = (d, kept, kind) => {
      d.deprecated = true; d.dupOf = kept.id
      // 同名裁决：如果被废的一方实测 0 平台、保留方有可用平台，把原因说成「已失效」
      // 而不是「旧版本」——用户关心的是为什么留那个废这个
      if (kind === 'oldVersion' || kind === 'oldVersionUpdated') {
        const dropDead = d.deep && d.deep.checkedAt && usableCount(d) === 0
        const keepOk = usableCount(kept) > 0
        d.dupReason = dropDead && keepOk ? DUP_REASON.VERSION_DEAD
          : kind === 'oldVersionUpdated' ? DUP_REASON.OLD_VERSION_NEW
            : DUP_REASON.OLD_VERSION
      } else {
        d.dupReason = kind === 'dupContent' ? DUP_REASON.SAME_CONTENT : DUP_REASON.SAME_REPO_NAME
      }
      d.usable = false
    }
    // ① 同内容（已下载过的才有哈希，最可靠）。私人音源（v1.10.0）不参与：用户手动导入的
    //    个人源不因内容与爬取库撞车而被废弃。
    const checked = all.filter(e => !e.deprecated && !e.fromServer && !e.private && e.status === 'ok' && e.contentHash)
    const byHash = {}
    for (const e of checked) {
      const k = e.contentHash
      if (!byHash[k]) { byHash[k] = e; continue }
      const keep = this.betterKeeper(e, byHash[k]) ? e : byHash[k]
      const drop = keep === e ? byHash[k] : e
      dep(drop, keep, 'dupContent'); res.dupContent++
      byHash[k] = keep
    }
    // ② 同名裁决（v1.12.2「先测后判」，用户 2026-11-10 定稿）：同名不同内容是「质量对决」，
    //    只要有一方还没深检（且已检方不是确认失效），就不按名字/占位规则废弃任何一方，
    //    双方都留作候选，交给真实检测的可用度裁决（runCheck 收尾 dedupe 按实测平台数择优，
    //    平手才比版本号新旧）。此前 v1.7.0 的占位规则会凭「实测可用 > 未检测」把新版
    //    直接废掉（doujs 8.10.12-r1 误废实测），先测后判彻底消除这类误杀。
    //    弱文件名守卫不变：「6」「index」这类名字不构成音源身份，不能拿来判版本。
    const byName = {}
    let pendingDuel = 0
    const checkedDeep = x => (x.deep && x.deep.checkedAt ? x.deep : null)
    for (const e of all) {
      if (e.deprecated || e.fromServer || e.private || !e.contentHash) continue
      const nm = normName(e.lxName || e.scriptName || e.name)
      if (!nm) continue
      if (isWeakBaseName(nm)) { weakSkipped++; continue }
      if (!byName[nm]) { byName[nm] = e; continue }
      const cur = byName[nm]
      const dc = checkedDeep(cur), dn = checkedDeep(e)
      // P-1432：深检「不完整」（含 untested/pending，如实测报告的上游限流熔断场景）
      // 视同未完成——不参与质量对决定胜负，双方留待完整证据。否则限流一瞬间的
      // 3/5 vs 5/5 会把本可救回的产物当场废掉（doujs r2 实测）。
      if (!dc || !dn || this._deepIncomplete(cur) || this._deepIncomplete(e)) {
        if (dc && usableCount({ deep: dc }) === 0) {
          // 已检方深检 0 平台（确认失效）→ 让位给未检测方，这条例外维持不变
          // ⚠️ R9 硬规则：让位方向不能是「真音源 → 追更链条目」。
          //   旧口径下「已检方失效就让位」不看对方是谁，攻击者只要让自己的
          //   updateurl:: payload 深检出 0 平台，真音源就被判失效让位给它。
          //   反向（追更链让位给真音源）是对的，要保留。
          const real = preferRealSource(cur, e)
          if (real && real !== cur) {
            // cur 是真音源、e 是追更链条目 → 不让位（真音源即使失效也不交给追更链裁决）
            pendingDuel++
            continue
          }
          dep(cur, e, 'oldVersion'); res.oldVersion++
          byName[nm] = e
        } else {
          pendingDuel++   // 先测后判：双方都留，等检测裁决
        }
        continue
      }
      const keep = this.betterKeeper(e, cur) ? e : cur
      const drop = keep === e ? cur : e
      // v1.12.1：保留方是真版本迭代（有更新标记 / 同仓库更高版本）→ 标「已有更新版本」，
      // 这样被废的旧版在保留方深检全失效时能被 ②b 翻案恢复
      dep(drop, keep, this._isNewerIteration(keep, drop) ? 'oldVersionUpdated' : 'oldVersion'); res.oldVersion++
      byName[nm] = keep
    }
    // ②b 检测后的同名二次裁决（v1.7.0 按用户要求：同名内容更新以接口可用度选择）：
    //    检测前的占位裁决可能凭「有更新」留了新版、废了旧版；若新版深检确认失效，
    //    这里翻案——恢复旧版为候选、废弃新版。旧版若已有实测可用结果则同时恢复 usable。
    //    （检测只跑非 deprecated 条目，所以旧版是否真能用要看它既有 deep；
    //      没有实测就先恢复成候选，下轮检测再定。）
    for (const e of all) {
      // 2026-11-22 放宽：原严格等值门禁只认 OLD_VERSION_NEW，但生产上大量误废裁决
      // （豆包 v12.0→v1.4、doujs 9.1.5-r1→9.1.1-r1）理由是 plain OLD_VERSION「同名旧版本」，
      // 永远翻不回来。现在 plain OLD_VERSION 也进通道，但只在「证据悬殊」时翻案（见下）。
      if (!e.deprecated || e.fromServer || e.private || !e.contentHash) continue
      if (!/^同名旧版本/.test(String(e.dupReason || ''))) continue
      const keeper = e.dupOf ? all.find(x => x.id === e.dupOf) : null
      if (!keeper || keeper.deprecated || keeper.private || !keeper.contentHash || keeper.contentHash === e.contentHash) continue
      // 证据悬殊才翻案：被废方有实测可用平台，且 keeper 实测 0 平台或未深检、可用平台明显更少。
      // 双方都有实测且差距 < 2 → 含糊，不动（误伤代价远大于漏判）。
      const ue = usableCount(e), uk = usableCount(keeper)
      if (!e.deep || !e.deep.checkedAt || ue < 1) continue
      if (keeper.deep && keeper.deep.checkedAt && ue - uk < 2) continue
      // ⚠️ R9 硬规则：翻案不能把「真音源」翻案成「追更链条目」。
      //   翻案通道的前提是「保留方（新版）实测失效 → 恢复旧版」。
      //   若被翻案回来的是真音源、而要把废弃的是追更链条目，方向反了——不能做。
      //   注意 preferRealSource 双方同类（都真/都追更）时返回 null（无硬规则倾向），
      //   此时必须放行翻案；只有它明确指定了「该保留的另一方」才跳过。
      //   （曾写成 `preferRealSource(e,keeper) !== e`，null!==e 恒真导致所有
      //     双真音源翻案被吞——crawl-releases 两条断言回归。）
      const pref = preferRealSource(e, keeper)
      if (pref && pref !== e) continue
      e.deprecated = false; e.dupOf = null; e.dupReason = null
      e.usable = !!(e.deep && e.deep.checkedAt && usableCount(e) > 0)
      keeper.deprecated = true; keeper.dupOf = e.id
      // 理由如实反映：keeper 实测 0 平台才是「已失效」，否则是「同名旧版本」让位给更优者
      keeper.dupReason = (keeper.deep && keeper.deep.checkedAt && uk === 0)
        ? DUP_REASON.VERSION_DEAD : DUP_REASON.OLD_VERSION
      keeper.usable = false
      res.oldVersion++   // 计入同名裁决翻案数
      this.emit('source-updated', e)
      this.emit('source-updated', keeper)
    }
    // ③ 同仓库同名文件（还没下载、无哈希：爬虫常把同一脚本在仓库里复制多份，
    //    规范化文件名后一致即视为重复，不必等检测就能砍掉一大截。
    //    注意：跨目录判重对「弱文件名」不可靠，跳过，留给内容指纹确认）
    const byFile = {}
    for (const e of all) {
      if (e.deprecated || e.fromServer || e.private || e.contentHash || e.status === 'dead') continue
      const base = String(e.path || (e.name + '.js')).split('/').pop().replace(/\.js$/i, '')
      const nm = normName(base)
      if (!nm) continue
      if (isWeakBaseName(nm)) { weakSkipped++; continue }
      const k = (e.repo || '') + '::' + nm
      if (!byFile[k]) { byFile[k] = e; continue }
      const keep = this.betterKeeper(e, byFile[k]) ? e : byFile[k]
      const drop = keep === e ? byFile[k] : e
      dep(drop, keep, 'dupFile'); res.dupFile++
      byFile[k] = keep
    }
    res.weakSkipped = weakSkipped
    res.pendingDuel = pendingDuel
    // ④ 收尾一致性（v1.13.10）：①②③ 三处都只「写自己那条」，谁也管不了
    //    「我这条成了别人的 keeper，但我自己后来也被废了」。于是库里会长出
    //    指向废弃条目的 dupOf 链、互指成环、甚至整组同内容副本全灭（活跃 0 = 内容丢失）。
    //    这里在保存之前一次性抹平，三条不变量按顺序恢复：
    //      a) 指针归一：dupOf 只能指向「终局存活者」（同内容重复还须同 contentHash）
    //      b) 组内兜底：每个 contentHash 组活跃副本数必须 ≥ 1（全灭则择优复活一条）
    //      c) 矛盾态修正：已废弃条目不得对外宣称 usable
    //    顺序不可调换：b 要在 c 之前——b 复活的那条必须按 deep 证据重算 usable，
    //    c 才能把「组里已有活跃副本」的其余副本正确置为不可用。
    const fix = this._dedupeInvariants(all)
    res.revived = fix.revived
    res.repointed = fix.repointed
    res.usableFixed = fix.usableFixed
    if (res.dupContent || res.oldVersion || res.dupFile || pendingDuel || fix.changed) {
      this.store.saveDb()
      this.log(`去重完成：废弃同内容 ${res.dupContent} 条、同名旧版本 ${res.oldVersion} 条、同仓库同名 ${res.dupFile} 条` +
        (pendingDuel ? `（同名待测对决 ${pendingDuel} 对留待真实检测裁决）` : '') +
        (weakSkipped ? `（弱文件名 ${weakSkipped} 条不按名判重，留待指纹确认）` : '') +
        (fix.changed ? `；一致性收尾：指针改写 ${fix.repointed} 条、复活 ${fix.revived} 条（其中无深检证据 ${fix.unusableRevived} 条）、usable 矛盾态修正 ${fix.usableFixed} 条` : ''), '去重')
    }
    return res
  }

  /**
   * 去重不变量的收尾修复（v1.13.10）。
   *
   * 背景：dedupe() 的 ①②③ 与 runCheck 的即时去重共 5 处写 deprecated，全部都是
   * 「标记我自己并记下 dupOf」的单向写入，没有任何一处会回头修正「指向我的那些条目」。
   * 一旦某条 keeper 因任何原因（同名裁决②、mergeFrom 导入、restoreDedupe 部分撤销、
   * 内容换版）变成废弃，指向它的条目就永久悬空；最坏情况是一组同内容副本全部废弃，
   * 这份内容从活跃库中彻底消失（8197 实测 100 组 / 480 条）。
   *
   * 判据口径（用户 2026-11-19 裁定）：成环或超深时**复活**而不是留着不动。
   * 代价不对称——复活是可逆的（下轮检测会重新判），丢内容不可逆。
   *
   * 复活只清 deprecated/dupOf/dupReason + 按 deep 证据重算 usable：
   * 废弃期间 usable 已被置 false，若只摘废弃标记，深检有可用平台的真音源会以
   * 「不可用」状态复活（sorters.js:41 归进不可用档），属于误伤好源。所以有深检证据
   * 就按证据重算 usable；没有深检证据的不预设可用，交给下一次检测裁决。
   * deep/status 一律不动。
   *
   * @param {Array} all store.getSources() 的结果（就地修改条目）
   * @returns {{revived:number, repointed:number, usableFixed:number, unusableRevived:number, changed:boolean}}
   */
  _dedupeInvariants(all) {
    const out = { revived: 0, repointed: 0, brokenPointers: 0, usableFixed: 0, unusableRevived: 0, changed: false }
    if (!Array.isArray(all) || !all.length) return out
    const byId = {}
    for (const e of all) if (e && e.id) byId[e.id] = e
    // 指针改写按「条目」计数：a/b/d 三段都可能改同一条的 dupOf，
    // 用累加的 ++ 会重复计入（日志报 529、实际变化 477）。这里用 Set 去重。
    const repointSet = new Set()
    const setDupOf = (e, v) => { repointSet.add(e.id); e.dupOf = v }

    // ★ R9（v1.13.15）：硬规则收口——「真音源被废弃、而废弃它的 keeper 是追更链条目」
    //   这一状态必须在保存前纠正过来。
    //
    //   为什么需要这一步（其它几处规则都拦不住它）：
    //   - betterKeeper 的硬规则只在**裁决那一刻**生效；
    //   - 但库里可能已经存在旧数据/其它路径留下的「真音源被废、keeper 是 updateurl::」；
    //   - 组内兜底 b) 看到「组里还有活的」（活的是追更链条目）就不复活真音源。
    //   净效果：真音源永久躺在废弃区，追更链的 payload 反而是活跃条目。
    //
    //   口径：**同一「同名组」**内，废弃方是真音源、keeper 是追更链条目 → 互换：
    //   真音源复活（按 deep 证据重算 usable），追更链条目改为废弃并指向真音源。
    //   同内容重复（dupContent）不在此列——内容一样时保留谁都无所谓。
    {
      const nameOf = (e) => normName((e && (e.lxName || e.scriptName || e.name)) || '')
      const byNameGroup = {}
      for (const e of all) {
        if (!e) continue
        const nm = nameOf(e)
        if (!nm) continue
        ;(byNameGroup[nm] = byNameGroup[nm] || []).push(e)
      }
      for (const nm of Object.keys(byNameGroup)) {
        const g = byNameGroup[nm]
        for (const e of g) {
          if (!e || !e.deprecated || isUpdateUrlEntry(e)) continue
          const keeper = e.dupOf ? byId[e.dupOf] : null
          if (!keeper || keeper.deprecated || !isUpdateUrlEntry(keeper)) continue
          // 同内容重复不互换（内容相同，保留谁无差别）
          if (e.contentHash && keeper.contentHash && e.contentHash === keeper.contentHash) continue
          // 互换：真音源复活、追更链条目被废
          e.deprecated = false; e.dupOf = null; e.dupReason = null
          e.usable = !!(e.deep && e.deep.checkedAt && usableCount(e) > 0)
          if (!e.usable) out.unusableRevived++
          out.revived++
          keeper.deprecated = true; keeper.dupOf = e.id
          keeper.dupReason = DUP_REASON.SAME_REPO_NAME; keeper.usable = false
          setDupOf(keeper, e.id)
          this.log(`dedupe: R9 硬规则——真音源「${e.lxName || e.name}」曾被追更链条目挤掉，已互换回来（追更链条目 id=${keeper.id}）`, '去重', 'warn')
          this.emit('source-updated', e)
          this.emit('source-updated', keeper)
        }
      }
    }

    // a) 指针归一：沿 dupOf 走到第一个未废弃者；成环/悬空/超深 → 交给 b 的组内兜底裁决
    //
    //    两个设计要点（都是实测踩出来的）：
    //    1) 断链时**不直接复活**。一条副本的 dupOf 断了不代表它该复活——它所在的组里
    //       可能已有活的 keeper（那它就是多余副本，复活会导致同内容留两份。原方案
    //       「断链即复活」在 8197 真实库上实测确实让 5 个组各留了 2 份）。
    //    2) 判定与落盘分两轮。必须先把所有条目的目标算完再统一改，否则就地清 dupOf 会
    //       让后面遍历到的条目误判成 dangling（实测把 B→C 这种本该重定向的记错了）。
    const MAX_HOPS = 32
    const plan = []   // { e, target|null, broken }
    for (const e of all) {
      if (!e || !e.deprecated || !e.dupOf) continue
      let cur = e
      let hops = 0
      let target = null
      let broken = ''
      const seen = new Set([e.id])
      while (cur && cur.dupOf) {
        if (hops >= MAX_HOPS) { broken = 'over-depth'; break }
        const next = byId[cur.dupOf]
        if (!next) { broken = 'dangling'; break }
        if (seen.has(next.id)) { broken = 'cycle'; break }
        if (!next.deprecated) { target = next; break }
        seen.add(next.id)
        cur = next
        hops++
      }
      if (target) plan.push({ e, target, broken: '' })
      else if (broken) plan.push({ e, target: null, broken })
    }
    const brokenIds = []
    for (const p of plan) {
      if (p.target) {
        if (p.e.dupOf !== p.target.id) setDupOf(p.e, p.target.id)
        continue
      }
      // 指不到终局存活者：记下来，由 b/d 按组形态决定去哪
      if (brokenIds.indexOf(p.e.id) === -1) brokenIds.push(p.e.id)
    }
    out.brokenPointers = brokenIds.length

    // b) 同内容多副本组兜底：每个 contentHash 组的活跃副本数必须恰好 1
    //
    //    ★ 只处理「多副本组」（g.length >= 2）。单条组被废弃几乎都是同名裁决/手动废弃
    //    造成的（它是那个内容的唯一副本，不存在「内容丢失」），绝不能当内容丢失复活——
    //    原实现漏了这个约束，在 crawl-releases 的 ②b 翻案用例上把「新版实测失效被废弃」
    //    这条唯一副本又复活了，造成同名去重当场失效（实测回归 3 项）。
    const groups = {}
    for (const e of all) {
      if (!e || !e.contentHash) continue
      ;(groups[e.contentHash] = groups[e.contentHash] || []).push(e)
    }
    const brokenSet = new Set(brokenIds)
    for (const hash of Object.keys(groups)) {
      const g = groups[hash]
      if (g.length < 2) continue                     // 单条组不是「内容丢失」，不兜底
      if (g.some(e => !e.deprecated)) continue       // 组里还有活的，无需兜底
      // 全灭：择优复活一条。口径 = 实测可用 > 有深检 > 更新时间 > 版本号 > id 小者
      let pick = null
      for (const e of g) {
        if (!pick) { pick = e; continue }
        const en = usableCount({ deep: e.deep }), pn = usableCount({ deep: pick.deep })
        if (en !== pn) { if (en > pn) pick = e; continue }
        if (this.betterKeeper(e, pick)) pick = e
      }
      if (!pick) continue
      pick.deprecated = false
      if (pick.dupOf !== null) setDupOf(pick, null)
      pick.dupReason = null
      // ★ P0：废弃期间 usable 已被 `dep()` 置 false，只摘废弃标记会把这个 false 原样带出来，
      //   于是「深检明明有可用平台」的真音源复活后仍显示成不可用（sorters.js:41 归进不可用档），
      //   违背「绝不误伤好源」。这里按 deep 证据重算：有深检且可用平台 > 0 才算可用，
      //   没有深检证据的不会被预设可用（交给下一次检测裁决）。
      pick.usable = !!(pick.deep && pick.deep.checkedAt && usableCount({ deep: pick.deep }) > 0)
      if (!pick.usable) out.unusableRevived++
      out.revived++
      this.log(`dedupe: revive hash=${String(hash).slice(0, 12)} id=${pick.id} reason=group-all-deprecated copies=${g.length} usable=${pick.usable}`, '去重', 'warn')
      // 组内其余副本：把指针补到刚复活的代表上，保证「dupOf 必须指向活跃条目」
      for (const e of g) {
        if (e === pick || !e.deprecated) continue
        if (e.dupOf !== pick.id) setDupOf(e, pick.id)
      }
    }

    // c) 矛盾态修正：已废弃条目不得对外宣称可用（b 之后跑，复活的那条已不再 deprecated）
    for (const e of all) {
      if (!e || !e.deprecated || e.usable !== true) continue
      e.usable = false
      out.usableFixed++
    }

    // d) 收尾：所有「dupOf 指不到活跃条目」的（成环/悬空/指向废弃），按「谁是本组代表」
    //    统一改写指针。只跑一次、只改指针，不复活任何东西。
    //
    //    为什么必须放在最后：a 只处理了「能走到活跃目标」的重定向，2 元环互指
    //    （A→B、B→A）在 a 里会被判成 cycle 而搁置，b 又因为组里已有活副本不介入，
    //    结果环原样留下（生产库实测残留 15 条）。这里用「每个 contentHash 组选定一个
    //    活跃代表」的事实做最终归一，成环必然被打散。
    //
    //    ★ P1：「合规」不能只看目标活不活，还要看理由对不对得上。
    //    「同名旧版本」跨 contentHash 指向是**必须**的（旧版指向新版，内容必然不同）；
    //    但「同内容重复」跨 contentHash 指向是**错**的——同 contentHash 才叫同内容。
    //    实测生产库有 6 条「同内容重复」指到了别组的活跃条目（其中 4 条是 probe /
    //    health-daily / source-audit / lx-source 这类伪重复），会被误当成真重复副本。
    const sameContent = (reason) => String(reason || '').indexOf(DUP_REASON_MARK.SAME_CONTENT) !== -1
    const liveRepByHash = {}
    for (const e of all) {
      if (!e || !e.contentHash || e.deprecated) continue
      if (!liveRepByHash[e.contentHash]) liveRepByHash[e.contentHash] = e
    }
    for (const e of all) {
      if (!e || !e.deprecated) continue
      const t = e.dupOf != null ? byId[e.dupOf] : null
      const okTarget = !!(t && !t.deprecated && t.id !== e.id &&
        (!sameContent(e.dupReason) || t.contentHash === e.contentHash))
      if (okTarget) continue   // 已指向合规目标（活着 + 理由与目标类型匹配）
      const rep = e.contentHash ? liveRepByHash[e.contentHash] : null
      if (rep && rep.id !== e.id) {
        if (e.dupOf !== rep.id) setDupOf(e, rep.id)
        if (!e.dupReason) e.dupReason = DUP_REASON.SAME_CONTENT
      } else {
        // 组内没有别的活跃代表（单条组 / 组内就它自己）：清指针，不能指向自己或死人
        if (e.dupOf != null) setDupOf(e, null)
        // 原因如实化：保留方已不在，还写「已有更新版本」是假话
        // 用 DUP_REASON.OLD_VERSION_NEW 里的关键子串判断，不用硬编码中文，
        // 这样将来改措辞只要改常量，「改写条件」自动跟着走，不会一处改了一处没改。
        if (String(e.dupReason || '').indexOf(DUP_REASON_MARK.UPDATED) !== -1) {
          e.dupReason = DUP_REASON.OLD_VERSION_KEEPER_DEAD
        } else if (!e.dupReason) e.dupReason = DUP_REASON.SAME_CONTENT
      }
    }

    out.repointed = repointSet.size
    out.changed = !!(out.revived || out.repointed || out.usableFixed)
    return out
  }

  /**
   * 撤销去重（v1.12.2 支持单条）：把被判为重复的条目恢复为候选（不删检测结果，不删已灌入记录）。
   * - 传 ids → 只恢复指定的废弃条目（勾选单条撤销的场景）；
   * - 不传 → 恢复全部（旧行为，误杀复查）。
   * 恢复后如与同名条目再次冲突，下次 dedupe 按「先测后判」重新裁决。
   */
  restoreDedupe(ids) {
    const all = this.store.getSources()
    const want = (Array.isArray(ids) && ids.length) ? new Set(ids.map(String)) : null
    let n = 0
    for (const e of all) {
      if (!e.deprecated) continue
      if (want && !want.has(String(e.id))) continue
      e.deprecated = false
      e.dupOf = null
      e.dupReason = null
      n++
    }
    if (n) {
      this.store.saveDb()
      this.log(`已撤销去重：恢复 ${n} 条候选${want ? `（勾选范围 ${want.size} 条）` : '（全部废弃条目）'}（检测结果与已灌入记录均保留，可重新去重或重新检测）`, '去重', 'info')
    }
    return { restored: n, total: all.length }
  }

  /**
   * v1.12.1：keep 是否是 drop 的「真版本迭代」。
   *  - 弱判定（_isNewerIteration，只用于废弃归类/翻案入口）：keep 带有更新标记，
   *    或同仓库且 keep 版本号严格更高；
   *  - 强判定（_isSameRepoNewerVersion，用于 betterKeeper 让位例外）：必须同仓库
   *    且版本号严格更高——release 资产已预填 tag 版本，未检测的新版也能比。
   *    `updated` 单独不构成让位理由（旧规则：不能凭「有更新」废掉能用版）；
   *    跨仓库同名不算迭代——那可能是两个不同脚本撞名。
   */
  _isSameRepoNewerVersion(keep, drop) {
    if (!keep || !drop || !keep.repo || !drop.repo) return false
    const same = keep.repo === drop.repo || (repoOwner(keep.repo) && repoOwner(keep.repo) === repoOwner(drop.repo) && sameAssetName(keep, drop))
    if (!same) return false
    const vk = versionNum(keep.scriptVersion || keep.scriptName || keep.name)
    if (!vk) return false
    return cmpVersion(keep.scriptVersion || keep.scriptName || keep.name,
                      drop.scriptVersion || drop.scriptName || drop.name) > 0
  }

  _isNewerIteration(keep, drop) {
    if (!keep || !drop) return false
    if (keep.updated) return true
    return this._isSameRepoNewerVersion(keep, drop)
  }

  /**
   * 同名/同内容条目的取舍（v1.7.0 按用户要求改为「接口可用度优先」）：
   *  - 双方都深检过 → 可用平台多者留（同为 0 再比新旧，此时更新时间才有意义）
   *  - 一方实测可用、另一方没检测过 → 留实测可用的（不能凭「有更新」废掉能用版）；
   *    **例外（v1.12.1）**：未检测方与实测方同仓库、且版本号严格更高 → 这是上游
   *    真发了新版（「只收最新版」设置的本意就是跟进新版），留新版进检测队列，
   *    旧版废为「同名旧版本（已有更新版本）」。旧版不是直接丢：dedupe ②b 翻案
   *    兜底——新版深检全失效时会自动恢复旧版，可用性不会凭空丢失。
   *  - 一方实测确认失效（深检 0 平台）、另一方没检测过 → 让位给未检测的（可能是
   *    可用的新版本，等它检测完自然裁决；旧版确认死了留着也没意义）
   *  - 都没检测过 → 按「有更新 > 时间 > 版本号 > id」兜底（检测前先临时占位，
   *    检测完成后 runCheck 的同名即时去重会按上面三条重新裁决）
   */
  /**
   * P-1432：深检完整性判定。quick 模式的条目天然含 untested（首个可用即停），
   * 上游限流熔断也会让 full 深检留下 untested——这两种状态都算「深检未完成」，
   * 不参与质量对决定胜负（_dedupe 与 runCheck 本批内同名去重共用此口径）。
   */
  _deepIncomplete(x) {
    const dd = x && x.deep && x.deep.checkedAt ? x.deep : null
    if (!dd) return true
    const vals = Object.values(dd.platforms || {})
    if (vals.length === 0) return true
    // 2026-11-22：quick 模式下「首个可用即停，其余按设计未测」是正常的完整证据，
    // 不应再当作「深检未完成」而把质量对决无限期挂起（豆包 v12.0 被 v1.4 占位的根因）。
    // 只有真·未完成才拦：upstream 限流/熔断留下的 untested，或 pending 状态。
    const depth = (dd.metrics && dd.metrics.depth) || (x && x.deep && x.deep.metrics && x.deep.metrics.depth) || ''
    for (const pl of vals) {
      if (!pl) return true
      if (pl.status === 'pending') return true
      if (pl.status === 'untested') {
        const msg = String(pl.message || pl.msg || pl.error || '')
        if (/限流|RATE_LIMIT|RATE.?LIMIT|熔断|已知失败|upstream/i.test(msg)) return true
        // quick 模式按设计停止留下的未测（含明确「快速模式」字样的消息）→ 视为完整
        if (/快速模式|已确认可用即停止|quick/i.test(msg)) continue
        // 其余无消息的 untested：仅在 quick 模式下视为完整（绝大多数 quick 产物无消息）
        if (depth === 'quick') continue
        return true
      }
    }
    return false
  }

  betterKeeper(a, b) {
    // ★ R9 硬规则（2026-11-19）：updateurl:: 条目**永远不能挤掉**真音源。
    //
    // 背景：updateurl:: 是「追更链」拉回来的脚本（来自沙箱里脚本自报的 updateUrl）。
    // 攻击者能让沙箱里的脚本报出一个任意地址，那个地址的内容就是攻击者写的，
    // 而入库条目的 name/lxName 直接取自攻击者脚本里的 @name
    // ⇒ 攻击者可以造出一个**与真音源同名**的条目。
    //
    // 旧裁决口径的漏洞：betterKeeper 的「一方已深检、另一方未深检 → 让位给未检测方」
    // 这条分支，会让**未深检的真音源**输给**已深检的恶意条目**——
    // 攻击者只要让 payload 深检出 1 个可用平台，真音源就被判废弃（dupOf 指向恶意条目）。
    // 代价不对称：真音源被废 = 用户少一个能用的源；恶意条目留下 = 用户多一个被投毒的源。
    //
    // 所以这里加一条**无条件**规则：一方是 updateurl::、另一方不是 → 永远保留非 updateurl:: 那方。
    // 双方都是 updateurl:: → 沿用原来的版本/质量裁决（它们都是追更来的，同类相残）。
    //
    // ⚠️ 这条规则**只**作用于「同名裁决」。同内容重复（dupContent）另有口径：
    //   内容一样时保留谁都无所谓（脚本功能完全相同），不在这条规则管辖范围内。
    if (isUpdateUrlEntry(a) !== isUpdateUrlEntry(b)) {
      return !isUpdateUrlEntry(a)
    }
    const da = a && a.deep && a.deep.checkedAt ? a.deep : null
    const db = b && b.deep && b.deep.checkedAt ? b.deep : null
    if (da && db) {
      // 2026-11-10 23:28 用户口径修正：本地同名去重只在「同名」时比优劣，
      // 且用**字典序**（可用平台数 → 最高可播档 → p50 延迟），不做加权综合分。
      // 平台数少一个是「质」的损失（该平台所有歌都取不到链），不允许被延迟快补偿。
      // 字典序判平手（cmp=0）时绝不靠微小差异删条目，退回下面的原有硬判据。
      // 私人音源（用户手动导入）不参与自动质量淘汰，保持原来的可用性口径。
      if (!a.private && !b.private) {
        const v = compareVerdict(a, b)
        if (v.cmp !== 0) return v.cmp > 0
      }
      const na = usableCount({ deep: da }), nb = usableCount({ deep: db })
      if (na !== nb) return na > nb
    } else if (da || db) {
      // 只有一方检测过：可用 > 未检测 > 确认失效
      const checked = da ? a : b, other = da ? b : a
      const checkedOk = usableCount(da ? { deep: da } : { deep: db }) > 0
      if (checkedOk) {
        // v1.12.1 例外：同仓库严格更高版本的真版本迭代 → 让位给未检测的新版（②b 翻案兜底）
        if (this._isSameRepoNewerVersion(other, checked)) return other === a
        return checked === a
      }
      if (other.updated || !other.deep) return other === a   // 未检测方优先
      return checked === a                                    // 对方也只是旧结果，保持
    }
    // 兜底：有更新的优先（用户要求的更新添加），其次时间、版本号、id
    if (!!a.updated !== !!b.updated) return !!a.updated
    const la = a.lastModified || 0, lb = b.lastModified || 0
    if (la !== lb) return la > lb
    const vc = cmpVersion(a.scriptVersion || a.scriptName || a.name,
                          b.scriptVersion || b.scriptName || b.name)
    if (vc !== 0) return vc > 0
    return String(a.id) < String(b.id)
  }

  // ---------------- 非音源仓库清理（v1.10.3） ----------------
  /**
   * 自动发现难免把「播放器 / 管理器 / 网关」这类仓库混进清单：它们夹带的
   * app/src/main/assets 下脚本副本、user-api-preload.js、docs 教程 zip 都会被当成音源收进库
   * （2026-11-07 实测：16 个仓库带来 695 条垃圾脚本，占全库 27%）。此前平台没有任何清理手段，
   * 只能逐条手删，而且删了下次发现还会加回来。
   *
   * 这里做成可重复执行的一键清理：验真非内置仓库 → 移除确定性失败的仓库 →
   * 连带删掉它贡献的脚本（记入 deletedIds，不会被重新采集）→ 写入 cfg.blockedRepos 黑名单
   * （发现器与社区精选都不再加回）。
   * 只处理确定性失败；HTTP 403/429/5xx、网络异常一律跳过，留待下次再验，避免误删。
   */
  async pruneNonSourceRepos(opts) {
    this.jobGate('清理失效仓库')
    // v1.10.8 修复：清理失效仓库此前完全不占任务位（验真+改名探测可达数分钟），
    // 期间其他任务入口可并发启动。包一层同步占位 + finally 回滚。
    this.job = { running: true, type: 'prune', cancel: false, progress: {}, step: '验真非音源仓库' }
    this.emit('job', { running: true, type: 'prune' })
    try {
      return await this._pruneNonSourceRepos(opts)
    } finally {
      this.job = { running: false, type: '', cancel: false, progress: {}, step: '' }
      this.emit('job', { running: false, type: '' })
    }
  }

  async _pruneNonSourceRepos(opts) {
    const o = opts || {}
    const cfg = this.store.config
    let rl = Array.isArray(cfg.repos) ? cfg.repos : null
    if (!rl || !rl.length) return { checked: 0, removedRepos: [], removedSources: 0, skipped: 0 }
    // 内置仓库是人工维护的种子，不动；只查附加/发现/社区三类
    const cands = []
    const seen = new Set()
    let skippedWeb = 0
    for (const x of rl) {
      if (!x || x.origin === 'builtin') continue
      const n = normalizeRepo(x.repo)
      if (!n || seen.has(n)) continue
      // v1.11.0：URL 形态的网页音源站 / 站外源不走 GitHub 验真。
      // verifyRepoHasSource 会把 URL 原样拼进 https://api.github.com/repos/<url> → 必然 404，
      // 旧逻辑会据此把好好的站外源判成「非音源仓库」移出清单并拉黑（误删）。
      // 站外源由 websource 自己验真，临时失败一律不删，这里直接跳过。
      if (isWebRepo(n)) { skippedWeb++; continue }
      seen.add(n); cands.push(n)
    }
    if (skippedWeb) this.log(`非音源仓库清理：跳过 ${skippedWeb} 个网页/站外 URL 源（不走 GitHub 验真，避免误删）`, '音源库')
    // ⓪ 先清黑名单仓库的残留脚本：上一次清理只删了 active 条目，版本废弃（deprecated）的旧副本
    //    会留下来（246 实测：首轮删 297 条、残留 398 条 deprecated）。再点一次即可清干净，幂等。
    const blkSet = new Set((Array.isArray(cfg.blockedRepos) ? cfg.blockedRepos : [])
      .map(x => String(x || '').toLowerCase()).filter(Boolean))
    let removedSources = 0
    if (blkSet.size) {
      const resIds = []
      for (const e of this.store.getSources()) {
        if (!e) continue
        const r = normalizeRepo(e.repo)
        if (r && blkSet.has(r.toLowerCase())) resIds.push(e.id)
      }
      if (resIds.length) {
        const rr = this.store.removeSources(resIds)
        removedSources += (rr && rr.deleted) || 0
      }
    }
    const limit = Math.max(1, Number(o.limit) || 40)
    const batch = cands.slice(0, limit)
    if (!batch.length) {
      if (removedSources) this.log(`非音源仓库清理：清理黑名单仓库残留脚本 ${removedSources} 条`, '音源库', 'warn')
      return { checked: 0, removedRepos: [], removedSources, skipped: 0, unchecked: 0 }
    }
    this.log(`非音源仓库清理：开始验真 ${batch.length} 个仓库（清单共 ${rl.length} 个，内置跳过）`, '音源库')

    const results = new Array(batch.length)
    let i = 0
    await Promise.all(Array.from({ length: Math.min(4, batch.length) }, async () => {
      while (true) {
        const k = i++
        if (k >= batch.length) return
        const repo = batch[k]
        try {
          // v1.17：走共享验真缓存（与 R10 同一份，TTL 30min）
          results[k] = { repo, v: await this._verifyRepoCached(repo, cfg) }
        } catch (e) {
          results[k] = { repo, v: { ok: false, reason: 'ERR ' + String((e && e.message) || e) } }
        }
      }
    }))
    // 临时失败（限流/权限/网络）不算判定结果，绝不据此删东西
    const isTransient = (r) => crawlerMod.isTransientVerifyReason(r)
    const dead = results.filter(x => !x.v.ok && !isTransient(x.v.reason))
    const skipped = results.filter(x => !x.v.ok && isTransient(x.v.reason)).length

    // ①' 改名检测（v1.10.7）：GitHub 改名返回 301，旧名经重定向仍「能用」，验真判不死
    //    → 旧名条目会永远留在清单里重复爬取、白烧 API 配额（246 实测：luanmuc/lx-music-source
//    改名 backend-api 后新旧两条并存）。这里对每个候补做一次轻量探测（1~2 次调用）：
    //    新名已在清单（重复旧名）→ 自动移出旧名条目，历史音源保留不删脚本、不进黑名单；
    //    新名不在清单 → 只提示不自动改（避免误判）。任何探测失败都当没改名（宁漏不误）。
    //
    // v1.17（配额优化 #4）：**已判死（dead）的仓跳过改名探测**。dead 的仓会被拉黑并移出清单，
    // 探测它是否改名没有意义（改名了也不该留在清单里）；只有「验真通过」的活仓才需要区分
    // 「旧名重复」。每次 prune 因此省下 dead.length 次 GET /repos/{repo}（实测约 15 次）。
    const deadSet = new Set(dead.map(x => String(x.repo).toLowerCase()))
    const renameTargets = batch.filter(r => !deadSet.has(String(r).toLowerCase()))
    const renameSkipped = batch.length - renameTargets.length
    if (renameSkipped) this.log(`改名探测：跳过 ${renameSkipped} 个已判死的仓库（它们会被拉黑，探改名无意义；省 ${renameSkipped} 次配额）`, '音源库')
    const renameResults = new Array(renameTargets.length)
    let ri = 0
    await Promise.all(Array.from({ length: Math.min(4, renameTargets.length) }, async () => {
      while (true) {
        const k = ri++
        if (k >= renameTargets.length) return
        try {
          renameResults[k] = await resolveRepoRename(renameTargets[k], { token: cfg.ghToken, timeoutMs: cfg.timeoutMs })
        } catch (e) {
          renameResults[k] = { moved: false, to: '', error: String((e && e.message) || e) }
        }
      }
    }))
    const renamedRepos = []   // {from,to} 新名已在清单 → 已自动清理旧名条目
    const renameHints = []    // {from,to} 新名不在清单 → 仅提示
    for (let k = 0; k < renameTargets.length; k++) {
      const rr = renameResults[k]
      if (!rr || !rr.moved || !rr.to) continue
      const from = renameTargets[k]
      const to = String(rr.to)
      if (to.toLowerCase() === String(from).toLowerCase()) continue
      const haveNew = rl.some(x => {
        const n = normalizeRepo(x && x.repo)
        return n && n.toLowerCase() === to.toLowerCase()
      })
      ;(haveNew ? renamedRepos : renameHints).push({ from, to })
    }
    if (renamedRepos.length) {
      const dupSet = new Set(renamedRepos.map(x => String(x.from).toLowerCase()))
      this.store.config.repos = rl.filter(x => {
        const n = normalizeRepo(x && x.repo)
        return !(n && dupSet.has(n.toLowerCase()))
      })
      rl = this.store.config.repos
    }
    for (const h of renameHints) {
      this.log(`发现仓库改名：${h.from} → ${h.to}（新名不在清单，未自动处理；确认后可在仓库清单手动更新）`, '音源库')
    }

    if (!dead.length) {
      if (renamedRepos.length) {
        this.store.saveConfig()
        this.log(`改名重复清理：${renamedRepos.map(x => `${x.from} → ${x.to}`).join('、')}；旧名条目已移出清单（历史音源保留）`, '音源库', 'warn')
      }
      this.log(`非音源仓库清理：${batch.length} 个仓库全部通过验真（临时失败跳过 ${skipped} 个）` +
        (removedSources ? `；另清理黑名单残留脚本 ${removedSources} 条` : ''), '音源库')
      return { checked: batch.length, removedRepos: [], removedSources, skipped, unchecked: Math.max(0, cands.length - batch.length), renamedRepos, renameHints }
    }
    // ①~③ v1.16：改为逐仓走 blockRepo 单一写路径（移出清单 + 加入黑名单 + 清脚本 + 写 blockedMeta/snapshot），
    //   与仓库行「拉黑」完全等价，不再自己维护 blockedRepos（避免两套写路径、且让 prune 也能回滚）。
    //   by:'user'——prune 是用户点按钮触发的；_internal 跳过 jobGate（本方法已在任务位内）。
    const removedRepos = []
    for (const x of dead) {
      const n = normalizeRepo(x && x.repo)
      if (!n) continue
      try {
        const br = this.blockRepo(n, { by: 'user', reason: '清理非音源仓库（验真确认无音源脚本）', _internal: true })
        removedRepos.push(br.blocked)
        removedSources += Number(br.removedSources) || 0
      } catch (e) {
        this.log(`非音源仓库清理：拉黑「${n}」失败（${String((e && e.message) || e).slice(0, 60)}），已跳过`, '音源库', 'warn')
      }
    }
    this.store.saveConfig()
    this.store.saveDb()
    this.log(`非音源仓库清理完成：移除仓库 ${removedRepos.length} 个、连带删除脚本 ${removedSources} 条` +
      (skipped ? `（临时失败跳过 ${skipped} 个，可再点一次继续）` : '') +
      (renamedRepos.length ? `；另清理改名重复 ${renamedRepos.length} 个` : '') +
      `；${removedRepos.slice(0, 6).join('、')}${removedRepos.length > 6 ? '…' : ''}`, '音源库', 'warn')
    return { checked: batch.length, removedRepos, removedSources, skipped, unchecked: Math.max(0, cands.length - batch.length), renamedRepos, renameHints }
  }

  /**
   * 仓库行快捷拉黑（v1.10.7）：仓库清单每行的「拉黑」一键完成三件事——
   *  ① 移出仓库清单；② 加入 blockedRepos 黑名单（搜索发现/社区精选不再回填，
   *     否则只删不加黑，过几天自动回流）；③ 连带清掉该仓库贡献的全部脚本
   *     （记入 deletedIds，后续不会自动加回，与 prune 同语义）。
   * 与「删除」按钮的区别：删除只移出清单，会被搜索发现/社区精选重新加回。
   * 返回 {blocked, removedSources}；内置仓库也允许拉黑（用户明确点名即尊重）。
   */
  blockRepo(repo, opts) {
    const o = opts && typeof opts === 'object' ? opts : {}
    // 内部批量迁移（_pruneNonSourceRepos / pruneAiRepos 已在任务位内）跳过 jobGate，避免自锁
    if (!o._internal) this.jobGate('拉黑仓库', String(repo || ''))
    const by = o.by === 'ai' ? 'ai' : 'user'
    const reason = String(o.reason || '').slice(0, 200)
    const name = normalizeRepo(String(repo || ''))
    if (!name || /^https?:\/\//i.test(String(repo || ''))) throw new Error('请提供 owner/repo 形态的仓库名')
    const cfg = this.store.config
    const before = Array.isArray(cfg.repos) ? cfg.repos.length : 0
    cfg.repos = (Array.isArray(cfg.repos) ? cfg.repos : []).filter(x => {
      const n = normalizeRepo(x && x.repo)
      return !(n && n.toLowerCase() === name.toLowerCase())
    })
    const removedFromList = cfg.repos.length < before
    const blk = new Set((Array.isArray(cfg.blockedRepos) ? cfg.blockedRepos : [])
      .map(x => String(x || '').toLowerCase()).filter(Boolean))
    const alreadyBlocked = blk.has(name.toLowerCase())
    blk.add(name.toLowerCase())
    cfg.blockedRepos = Array.from(blk)
    // ③ 清残留脚本（含 deprecated 旧副本），与 prune 黑名单清理同语义
    const ids = []
    for (const e of this.store.getSources()) {
      if (!e) continue
      const r = normalizeRepo(e.repo)
      if (r && r.toLowerCase() === name.toLowerCase()) ids.push(e.id)
    }
    let removedSources = 0
    if (ids.length) removedSources = (this.store.removeSources(ids) || {}).deleted || 0
    // v1.16 旁路表：记来源 + 被删脚本快照（供 UI 来源徽章 + 解除时按快照还原）。
    // ⚠️ 只写 cfg.blockedMeta（旁路），绝不动 blockedRepos 的字符串结构。
    // ② key 统一用小写，与 blockedRepos 口径一致（否则解除时按原形取不到 → snapshot 静默丢失）。
    if (!cfg.blockedMeta || typeof cfg.blockedMeta !== 'object' || Array.isArray(cfg.blockedMeta)) cfg.blockedMeta = {}
    const metaKey = name.toLowerCase()
    const prevMeta = cfg.blockedMeta[metaKey]
    // ③ 同 key 重复拉黑时 snapshot **合并**（不覆盖），避免"拉黑→解除→再拉黑"丢第一次记录
    const snapSet = new Set(Array.isArray(prevMeta && prevMeta.snapshot) ? prevMeta.snapshot : [])
    for (const id of ids) snapSet.add(id)
    cfg.blockedMeta[metaKey] = {
      repo: name,   // 保留原始大小写形态，供 UI 展示
      by,
      reason: reason || (by === 'ai' ? 'AI 判定非音源仓库' : '手动拉黑'),
      at: Date.now(),
      snapshot: Array.from(snapSet)   // 本次 + 历史被清掉的脚本 id；解除时按此还原「不再采集」记录
    }
    this.store.saveConfig()
    this.store.saveDb()
    this.log(`已拉黑仓库 ${name}（来源：${by === 'ai' ? 'AI 建议' : '手动'}）：${removedFromList ? '移出清单' : '本就不在清单'}、${alreadyBlocked ? '原本已在黑名单' : '加入黑名单'}、清理脚本 ${removedSources} 条（后续搜索发现/社区精选不再回填）`, '音源库', 'warn')
    return { blocked: name, removedFromList, alreadyBlocked, removedSources, by, snapshot: Array.from(snapSet) }
  }

  // 解除拉黑（v1.10.7）：从 blockedRepos 移除；可选同步回仓库清单（默认回，一键恢复采集）
  // v1.16：按 blockedMeta 里的 snapshot 撤销「不再采集」记录，让被清掉的脚本能重新被采集回来
  //（修复旧版「解了黑名单但脚本永远回不来」的缺陷）。不用 clearDeletedIds 核弹。
  unblockRepo(repo, reAdd) {
    this.jobGate('解除拉黑', String(repo || ''))
    const name = normalizeRepo(String(repo || ''))
    if (!name || /^https?:\/\//i.test(String(repo || ''))) throw new Error('请提供 owner/repo 形态的仓库名')
    const cfg = this.store.config
    const blk = new Set((Array.isArray(cfg.blockedRepos) ? cfg.blockedRepos : [])
      .map(x => String(x || '').toLowerCase()).filter(Boolean))
    const wasBlocked = blk.has(name.toLowerCase())
    if (!wasBlocked) throw new Error(`仓库 ${name} 不在黑名单中`)
    blk.delete(name.toLowerCase())
    cfg.blockedRepos = Array.from(blk)
    // v1.16：按快照还原被删脚本的「不再采集」记录（②大小写不敏感查找，兼容老原形 key）
    let restoredIds = 0
    let metaFound = false
    const metaKey = findBlockedMetaKey(cfg.blockedMeta, name)
    const meta = metaKey ? cfg.blockedMeta[metaKey] : null
    if (meta && Array.isArray(meta.snapshot) && meta.snapshot.length) {
      metaFound = true
      const r = this.store.removeDeletedIds(meta.snapshot)
      restoredIds = (r && r.removed) || 0
    }
    if (metaKey) delete cfg.blockedMeta[metaKey]
    let reAdded = false
    const wantReAdd = reAdd === undefined ? true : !!reAdd
    if (wantReAdd) {
      const has = (Array.isArray(cfg.repos) ? cfg.repos : []).some(x => {
        const n = normalizeRepo(x && x.repo)
        return n && n.toLowerCase() === name.toLowerCase()
      })
      if (!has) { cfg.repos = (Array.isArray(cfg.repos) ? cfg.repos : []).concat([{ repo: name, enabled: true, builtin: false, origin: 'unblocked' }]); reAdded = true }
    }
    this.store.saveConfig()
    this.log(`已解除拉黑仓库 ${name}：移出黑名单${reAdded ? '、已加回仓库清单' : ''}${restoredIds ? `、按快照恢复 ${restoredIds} 条脚本的采集记录（下次爬取可重新采回）` : ''}`, '音源库', 'info')
    return { unblocked: name, wasBlocked, reAdded, restoredIds, metaFound }
  }

  /**
   * v1.16 第二步：AI 判非音源仓库的门控自动拉黑（默认关，必须三重旁证 AND 全过才动手）。
   *
   * 与建议层的分工：建议层只把 AI 的 tool 判定写进 cfg.repoAiHints 供人确认；本方法才真正
   * 走 gate('R10')（总闸 + autoActions.R10 + allowIrreversible 不可逆双锁 + 评测达标 + 证据 AND），
   * 全过才对**已在 repoAiHints 里判 tool、且仍在仓库清单**的仓逐条 blockRepo(by:'ai')。
   * 任一环节不过：该仓留在建议层等人工确认，绝不自动动手。
   *
   * 复用现成 AI 结论（repoAiHints 来自 coldStart 旁路），**不新增任何 AI prompt 调用**。
   * 客观旁证②（验真无音源）走**真实 verifyRepoHasSource**（不是"库内有无条目"），
   * 限流/网络失败视为"不确定"→旁证不成立→不拉黑（保守，绝不误伤）；
   * 客观旁证③（可用音源数）按 deep.platforms 实测累加（不用 e.usable，两者有历史不一致）。
   *
   * @param {object} [opts] { dryRun:true } 只算不写（默认 false）
   * @returns {Promise<{checked:number, blocked:string[], skipped:Array, gateReason:string}>}
   */
  async pruneAiRepos(opts) {
    const o = opts && typeof opts === 'object' ? opts : {}
    // 占任务位：本方法含真实网络验真（≤20 仓 × 1~2 次 GitHub 请求），不能与爬取/巡检并发。
    // 已在任务位内（自动挡循环调用）时用 opts._internal 跳过，避免自锁。
    if (!o._internal) this.jobGate('AI 评估非音源仓库')
    const ownJob = !o._internal
    if (ownJob) {
      this.job = { running: true, type: 'prune-ai', cancel: false, progress: {}, step: '验真 AI 判定的非音源仓库' }
      this.emit('job', { running: true, type: 'prune-ai' })
    }
    try {
      return await this._pruneAiRepos(o)
    } finally {
      if (ownJob) {
        this.job = { running: false, type: '', cancel: false, progress: {}, step: '' }
        this.emit('job', { running: false, type: '' })
      }
    }
  }

  async _pruneAiRepos(o) {
    const cfg = this.store.config
    const hints = (cfg.repoAiHints && typeof cfg.repoAiHints === 'object') ? cfg.repoAiHints : {}
    const inList = Array.isArray(cfg.repos) ? cfg.repos : []
    const listNames = new Set(inList.map(x => String(normalizeRepo(x && x.repo) || '').toLowerCase()).filter(Boolean))
    // 候选：AI 判 tool 且仍在清单（不在清单的已被处理，无需重复）
    const cands = Object.keys(hints).filter(r => hints[r] && hints[r].cls === 'tool' && listNames.has(String(r).toLowerCase()))
    const out = { checked: 0, blocked: [], skipped: [], gateReason: '' }
    if (!cands.length) return out
    // 预算保护：单次最多处理 20 个仓，避免一次拉黑过多（也控制验真配额：≤20×2 次请求）
    const batch = cands.slice(0, 20)
    const a = this._ai()
    if (!a) { out.gateReason = 'AI 复检未初始化'; return out }
    // 评测凭证：R10 属需评测达标的功能（gate 硬门，且不可逆类缺省即拒）。当前无线上评测结论时
    // 如实传 '未评测' → gate 拒绝自动（只能走建议层人工确认）。将来接入 R10 评测后换真实结论即可。
    const evalVerdict = String((cfg.aiReview && cfg.aiReview.evalVerdictR10) || '未评测')
    const isTransient = (why) => crawlerMod.isTransientVerifyReason(why)
    // v1.17：验真走共享缓存 _verifyRepoCached（与 _pruneNonSourceRepos 同一份，TTL 30min）
    const verifyRepo = (repo) => this._verifyRepoCached(repo, cfg)
    // 该仓贡献的「实测可用音源数」：按 deep.platforms 逐条判 usable，不用 e.usable（历史不一致）
    const countUsableByDeep = (low) => {
      let n = 0
      for (const e of this.store.getSources()) {
        if (!e || !e.deep) continue
        const r = normalizeRepo(e.repo)
        if (!r || r.toLowerCase() !== low) continue
        const plats = e.deep.platforms
        const arr = Array.isArray(plats) ? plats : (plats && typeof plats === 'object' ? Object.values(plats) : [])
        if (arr.some(p => p && (p.status === 'usable' || p.usable === true))) n++
      }
      return n
    }
    for (const repo of batch) {
      out.checked++
      try {
        const low = String(repo).toLowerCase()
        const usable = countUsableByDeep(low)
        // 客观验真②：v.ok===true → 有音源；v.ok===false 且非临时失败 → 确认无音源；
        // 其余（临时失败/异常）→ 不确定（传 undefined，使 verifyHasSource===false 不成立 → 不拉黑）
        const vr = await verifyRepo(repo)
        let verified
        if (vr && vr.ok === true) verified = true
        else if (vr && vr.ok === false && !isTransient(vr.reason)) verified = false
        else verified = undefined
        // 三重旁证：AI 判 tool + 客观验真确无音源 + 可用音源数 0（三者真 AND）
        const facts = { aiClass: 'tool', verifyHasSource: verified, usableSourceCount: usable }
        const signals = a.collectSignals(facts, 'R10')
        const g = a.gate('R10', { signals, evalVerdict })
        if (!g.auto) { out.skipped.push({ repo, reason: g.reason || '门控未通过' }); continue }
        if (o.dryRun) { out.blocked.push(repo); continue }
        const r = this.blockRepo(repo, { by: 'ai', reason: (hints[repo] && hints[repo].reason) || 'AI 判定非音源仓库（三重旁证）', _internal: true })
        out.blocked.push(repo)
        // 审计留痕（供事后复核；blockedRepos 不在 undo 白名单，故此处只做记录不冒充可 undo）
        try {
          a.audit('repo:' + repo, 'blocklist', { targets: [{ path: 'config.blockedRepos', before: null, after: repo }] }, { targets: [{ path: 'config.blockedRepos', before: null, after: repo }] },
            'ai', { scope: { sandbox: false, gateEval: { pass: true }, repo, snapshot: (r && r.snapshot) || [], reason: 'R10 三重旁证' } })
          a.store.saveDb()
        } catch (_) {}
      } catch (err) {
        out.skipped.push({ repo, reason: String((err && err.message) || err).slice(0, 120) })
      }
    }
    if (out.blocked.length) this.log(`AI 自动拉黑非音源仓库：${out.blocked.length} 个（三重旁证齐全、门控全过）→ ${out.blocked.slice(0, 6).join('、')}${out.blocked.length > 6 ? '…' : ''}`, '音源库', 'warn')
    else if (out.skipped.length) this.log(`AI 自动拉黑：${out.skipped.length} 个候选未过门控（默认关/缺证据），已留建议层待人工确认`, '音源库', 'info')
    return out
  }

  // ---------------- 站外分发源（v1.11.0）----------------
  // Pages / 自建域名 / 对象存储直链。独立清单而非塞进 repos 的原因见 store.js 注释：
  // repos 规范化只留 4 个字段，且清理非音源仓库会对每条做 GitHub 验真（URL 必然 404）。
  // 这些是配置管理，不占任务位（与 blockRepo/unblockRepo 一致的轻量操作）。
  _externalList() {
    const cfg = this.store.config
    if (!Array.isArray(cfg.externalSources)) cfg.externalSources = []
    return cfg.externalSources
  }

  listExternalSources() { return this._externalList().slice() }

  async probeExternal(url) {
    const norm = normalizeExternalUrl(url)
    if (!norm) return { ok: false, reason: '只支持 http(s) 开头的网址' }
    const r = await probeExternalSource(norm, { timeoutMs: this.store.config.timeoutMs })
    this.log(`站外源探测 ${norm}：${r.ok ? `可用（${r.kind}，验真通过 ${r.scripts.length} 个脚本）` : '失败：' + r.reason}`, '采集', r.ok ? 'info' : 'warn')
    return r
  }

  addExternalSource(url, detect) {
    const norm = normalizeExternalUrl(url)
    if (!norm) throw new Error('站外源地址必须是 http(s) 网址')
    if (detect && detect.ok === false) throw new Error('该地址不是可用音源：' + (detect.reason || '验真未通过'))
    const list = this._externalList()
    if (list.some(x => x && (normalizeExternalUrl(x.url) || x.url) === norm)) throw new Error('该站外源已在清单中')
    const d = detect || {}
    const rec = {
      url: norm,
      name: String(d.name || '').slice(0, 80) || (norm.split('/').pop() || '站外源'),
      enabled: true,
      origin: 'external',
      kind: d.kind || 'index',
      addedAt: Date.now(),
      lastProbe: { at: Date.now(), ok: !!d.ok, kind: d.kind || '', reason: d.reason || '', scripts: (d.scripts || []).length },
      lastCrawl: null
    }
    list.push(rec)
    this.store.saveConfig()
    this.log(`已添加站外分发源「${rec.name}」（${norm}，${rec.kind}）；后续全量/定时/行级采集会自动覆盖`, '采集')
    return this.listExternalSources()
  }

  removeExternalSource(url) {
    const norm = normalizeExternalUrl(url)
    if (!norm) throw new Error('站外源地址必须是 http(s) 网址')
    const cfg = this.store.config
    const before = this._externalList().length
    cfg.externalSources = this._externalList().filter(x => !x || (normalizeExternalUrl(x.url) || x.url) !== norm)
    if (cfg.externalSources.length === before) throw new Error('该站外源不在清单中')
    if (cfg.externalStates && typeof cfg.externalStates === 'object') delete cfg.externalStates[norm]
    this.store.saveConfig()
    // 与采集站一致：只移出清单，已采回的音源保留在库里（不会自动加回，但也不会误删数据）
    this.log(`已移除站外分发源 ${norm}（已采回的音源保留在库中）`, '采集')
    return this.listExternalSources()
  }

  updateExternalSource(url, patch) {
    const norm = normalizeExternalUrl(url)
    if (!norm) throw new Error('站外源地址必须是 http(s) 网址')
    const rec = this._externalList().find(x => x && (normalizeExternalUrl(x.url) || x.url) === norm)
    if (!rec) throw new Error('该站外源不在清单中')
    const p = patch || {}
    if (p.enabled !== undefined) rec.enabled = !!p.enabled
    if (p.name !== undefined) rec.name = String(p.name || '').slice(0, 80) || rec.name
    this.store.saveConfig()
    return this.listExternalSources()
  }

  // ---------------- 检测 ----------------
  // 混淆隔离闸门（v1.10.7）：high 级混淆不再直接判死，而是移入「混淆隔离」区（status=quarantined），
  // 条目仍留在音源库中可见。用户在隔离页对「无恶意硬特征」的脚本点「信任」后，按 contentHash
  // 记入 cfg.trustedObfHashes，检测/灌入两道闸共用本函数放行；内容一变哈希就变，重新被隔离
  // ——信任不跟随未知的新版本。返回 {rejected, trusted}；codeOf 返回空串/null 表示拿不到脚本正文（放行）。
  //
  // 【为什么拿不到正文就放行】本函数是「按内容判安全」的闸门，没有内容就没有判据可依，
  // 此时放行不是「跳过检查」而是「此题无解」：条目若真要被使用，必须先有正文（下载/重爬），
  // 而正文落库后一定会再走一次本函数重评。因此隔离态在无正文时无法成立——对历史残留的
  // quarantined 状态，这里会主动清回 ok 并要求重新检测（见下方 !code 分支），避免出现
  // 「既没法复评、也没法信任」的死条目。
  applyObfGate(list, codeOf, phase) {
    const cfg = this.store.config
    if (!cfg.excludeHighRiskObfuscated) return { rejected: 0, trusted: 0 }
    // P-1431 规则制：trustedHashes 必须挂回 cfg，否则首次自动信任 push 到临时数组会丢
    if (!Array.isArray(cfg.trustedObfHashes)) cfg.trustedObfHashes = []
    const trustedHashes = cfg.trustedObfHashes
    const kept = []
    let rejected = 0
    let trusted = 0
    let autoTrusted = 0
    for (const e of list) {
      const code = codeOf(e)
      // P-1430：正文拿不到的条目不隔离，且要清掉历史残留的隔离状态。
      // 实测隔离区有 10 条「有 url/hash、code 为空」的残缺条目（旧版爬取/瘦身遗留），
      // status 卡在 quarantined 既无法复评也没法信任，一直挂在隔离区。
      // 清回音源库后，下次检测/巡检会重新下载正文并用本闸门重评（真混淆的会再进来）。
      if (!code) {
        if (e.status === 'quarantined' || e.quarantined) {
          e.status = 'ok'
          e.quarantined = false
          e.usable = false
          e.error = '隔离状态已解除：条目正文缺失，待重新检测后按内容重评'
          this.emit('source-updated', e)
        }
        kept.push(e)
        continue
      }
      const risk = obfuscationRisk(code)
      if (risk.level === 'high') {
        e.obfLevel = 'high'
        e.obfHits = risk.hits
        // v1.13.7：外联域名画像（静态扫描参考画像，非安全结论），隔离页展示供信任决策
        e.obfDomains = obfDomains(code)
        // 静态情报·硬否决（2026-11-24）：恶意指纹即使用户/历史信任过也不放行，落回隔离。
        if (e.contentHash && !isMaliciousHash(e.contentHash) && trustedHashes.includes(e.contentHash)) {
          e.obfTrusted = true
          e.quarantined = false
          if (e.status === 'quarantined') e.status = 'ok'
          trusted++
          kept.push(e)
          continue
        }
        // P-1431 规则制自动信任（v1.13.7）：纯密度型（无空转死循环/混淆自调度/jsjiami/eval
        // 等硬特征）+ 沙箱已实测（deep 存在）+ 实测取链域名与静态外联域名全部落在
        // 音乐生态白名单（内置 + config.trustedObfDomains 自定义）→ 自动写入信任指纹放行。
        // 局限如实：混淆脚本可条件触发恶意行为，沙箱一轮实测看不见——自动信任是初筛
        // 自动化而非安全结论，条目打 obfAutoTrust 标注可追溯，内容更新自动重新隔离。
        // ⚠️ 试跑（probeOnly）产出的 deep 必须视为「没有 deep」，绝不能进自动信任。
        // 否则「隔离区点一次试跑 → 下次扫描自动写入 trustedObfHashes → 永久放行」，
        // 用户全程没确认过，与「不自动帮用户启用」的红线直接冲突。
        // 这个条件是本条自动信任路径的**唯一入口闸门**，不要因为「反正是 allow 档」删掉它。
        // 静态情报·硬否决（2026-11-24）：恶意指纹永不自动信任（保持隔离，跳过自动信任分支）。
        if (cfg.autoTrustCleanObf !== false && e.contentHash && !isMaliciousHash(e.contentHash) && !trustedHashes.includes(e.contentHash) && e.deep && e.deep.checkedAt && !isProbeOnlyDeep(e)) {
          // P-1432 OPT-1 / v1.10.8：判据收敛到 checker.classifyQuarantineTrust 单一来源，
          // 不再在这里抄第三份「spin/selfSched/eval 任一命中」的字面量。
          // 自动信任是**无人确认**的自动化路径，因此只认 allow 档（零可疑特征）——
          // risky/block 一律留给用户在隔离页看过 AI 意见后自己决定。
          const trustLevel = classifyQuarantineTrust(e, cfg).level
          if (trustLevel === 'allow') {
            const urls = []
            for (const p of Object.values(e.deep.platforms || {})) {
              if (p && p.url) urls.push(String(p.url))
            }
            const verdict = obfDomainVerdict(obfDomains(code).concat(urls), cfg.trustedObfDomains)
            if (verdict.clean) {
              trustedHashes.push(e.contentHash)
              e.obfTrusted = true
              e.obfAutoTrust = true
              e.quarantined = false
              if (e.status === 'quarantined') e.status = 'ok'
              e.error = '自动信任：无硬特征，沙箱实测外联域名全部为音乐生态白名单'
              autoTrusted++
              trusted++
              kept.push(e)
              continue
            }
            e.obfHoldReason = '白名单外域名：' + verdict.suspect.slice(0, 4).join('、')
          }
        }
        e.status = 'quarantined'
        e.quarantined = true
        e.usable = false
        e.error = '混淆隔离：重度混淆脚本，已移入「混淆隔离」区（可在该页点「试跑一次」看实测，或直接信任后放行）'
        rejected++
        this.emit('source-updated', e)
        continue
      }
      kept.push(e)
    }
    if (rejected) {
      list.length = 0
      list.push(...kept)
      this.log(`${phase}隔离 ${rejected} 条重度混淆脚本（已移入「混淆隔离」区，可在该页「试跑一次」看实测或直接信任后放行）`, '安全', 'warn')
      this.store.saveDb()
    }
    if (autoTrusted) {
      this.log(`自动信任 ${autoTrusted} 条重度混淆脚本（规则制：无硬特征 + 沙箱实测外联全为音乐生态白名单；内容更新会重新隔离）`, '安全', 'info')
      this.store.saveDb()
    }
    return { rejected, trusted }
  }

  // 混淆隔离：信任 / 取消信任（v1.10.7）。
  // 信任 = 把条目的 contentHash 记入设置 trustedObfHashes（按内容豁免，内容更新自动失效），
  // 并把条目恢复 ok；usable 仍按深度体检结果。仅无恶意硬特征（空转死循环/混淆自调度/
  // jsjiami 标识/eval）的脚本允许信任——命中硬特征的真恶意脚本没有放行通道。
  trustObfSource(id, trust) {
    const e = this.store.db.sources[id]
    if (!e || e.deprecated) throw new Error('音源不存在或已废弃')
    const cfg = this.store.config
    const hashes = Array.isArray(cfg.trustedObfHashes) ? cfg.trustedObfHashes.slice() : []
    const name = e.lxName || e.scriptName || e.name || id
    if (trust) {
      if (!e.contentHash) throw new Error('该条目没有内容指纹（contentHash），无法按内容信任')
      // 静态情报·硬否决（2026-11-24）：恶意指纹条目即使用户点信任也拒绝放行（永不信任）。
      if (isMaliciousHash(e.contentHash)) {
        throw new Error('安全硬否决：该条目命中恶意脚本指纹黑名单，永不信任，无法放行')
      }
      // P-1432 OPT-1 / v1.10.8：判据收敛到 checker.classifyQuarantineTrust 单一来源。
      // 旧写法在这里抄了「spin/selfSched/eval 任一命中 → 抛错拒绝」，导致隔离页 4/6 条灰死。
      //
      // ⚠️ 这里**不再对 block 档抛错**：用户拍板「6 条全部可点、0 条灰死」，block 档也应保留
      // 用户的最终决定权（终审 §1.1「block 仍可点，二次确认」）。若后端硬拒，前端过了两道确认
      // 依然失败，等于变相灰死，与拍板冲突。真恶意的兜底不靠这里拦，而靠三件事：
      //   ① contentHash 绑定——放行只对这一份内容有效，脚本一更新就重新隔离；
      //   ② 沙箱执行 + CPU 护栏——eval 真去胡来时仍在沙箱里跑，烧 CPU 被自动隔离；
      //   ③ 前端两道确认 + AI 必须先出意见（见 renderer/app.js qz-trust 点击流程）。
      // 因此 block 档改为**放行但留高风险审计日志**，把处置权交给用户、把痕迹留给自己。
      const cls = classifyQuarantineTrust(e, cfg)
      if (cls.level === 'block') {
        // 用户拍板：block 档也保留最终决定权（不硬拒）。但必须在日志里留下可追查的完整痕迹，
        // 否则「真恶意也能点」就成了无人负责的缺口。日志字段：命中项逐条 + 内容指纹前缀。
        const ev = cls.evidence || {}
        const hit = []
        if (ev.spin) hit.push(`空转死循环 ${ev.spin} 处`)
        if (ev.evalN) hit.push(`eval ${ev.evalN} 处`)
        if (ev.schedTimer) hit.push(`定时器调用 ${ev.schedTimer} 处`)
        if (!ev.deepDone) hit.push('从未深度实测')
        else if (!ev.usableN) hit.push(`实测 ${ev.testedN} 个平台全不可用`)
        if (ev.suspect >= 4) hit.push(`可疑外联 ${ev.suspect} 个`)
        this.log(`用户确认放行 block 级条目「${name}」（命中：${hit.join('、') || '真恶意形态'}；`
          + `内容指纹 ${String(e.contentHash).slice(0, 12)}…）。已按内容指纹信任，脚本内容一更新会自动重新隔离；`
          + '沙箱执行与 CPU 护栏照常生效。', '安全', 'warn')
      }
      if (!hashes.includes(e.contentHash)) {
        hashes.push(e.contentHash)
        this.store.saveConfig({ trustedObfHashes: hashes })
      }
      e.obfTrusted = true
      e.quarantined = false
      if (e.status === 'quarantined') e.status = 'ok'
      e.error = ''
      e.usable = !!(e.deep && e.deep.checkedAt && usableCount(e) > 0)
      this.log(`已信任混淆脚本「${name}」，从隔离区放行（内容变更会重新隔离；深度体检可用性照常执行）`, '安全', 'info')
    } else {
      const i = e.contentHash ? hashes.indexOf(e.contentHash) : -1
      if (i >= 0) {
        hashes.splice(i, 1)
        this.store.saveConfig({ trustedObfHashes: hashes })
      }
      e.obfTrusted = false
      if (e.obfLevel === 'high' && cfg.excludeHighRiskObfuscated) {
        e.status = 'quarantined'
        e.quarantined = true
        e.usable = false
        e.error = '混淆隔离：重度混淆脚本，已移入「混淆隔离」区（可在该页点「试跑一次」看实测，或直接信任后放行）'
      }
      this.log(`已取消信任「${name}」${(e.obfLevel === 'high' && cfg.excludeHighRiskObfuscated) ? '，重新移入混淆隔离区' : ''}`, '安全', 'info')
    }
    this.emit('source-updated', e)
    this.store.saveDb()
    return { id: e.id, trusted: !!trust, status: e.status, usable: e.usable, trustedHashes: hashes.length }
  }

  /**
   * 隔离区「试跑一次」（v1.13.12）——**只实测，不信任**。
   *
   * ============================================================================
   * 解决的是什么问题
   * ============================================================================
   * 混淆闸门把高危脚本移入隔离区后会 `continue` 跳过深检（hunter.js 的 applyObfGate），
   * 而 R6 判 trust 的硬门槛是「深检可用平台数 >= 1」，深检又只在 `status === 'ok'` 时触发。
   * 于是：要信任 → 需 R6 判 trust → 需有实测 → 需先信任。永久成环。
   * 更荒唐的是这条环把举证责任全推给用户：**先信任才能验证，而验证本该是信任的前提**。
   *
   * 这个入口就是拆环的那一下：让用户在**不签字**的前提下看到「这个脚本到底能不能出链接」。
   *
   * ============================================================================
   * 三条硬约束（改这个函数前务必读懂，否则会造出绕过用户确认的暗道）
   * ============================================================================
   *   ① 绝不改 `status` / `quarantined` / `usable` / `obfTrusted` —— 试跑完条目仍在隔离区；
   *   ② 绝不写 `trustedObfHashes` —— 这是「用户签字」的落点，只有 trustObfSource 能碰；
   *   ③ 绝不调 `dedupe()` —— 试跑不参与裁决，不推动任何自动流程。
   *
   * 产出 `deep.probeOnly = true`，配合 checker.isProbeOnlyDeep 做到数据层隔离：
   *   - `classifyQuarantineTrust` 把 probeOnly 的 deep 当「没有 deep」→ 档位不会被降级；
   *   - `applyObfGate` 的自动信任路径同样跳过 probeOnly；
   *   - R6 会看到这份实测，但 prompt 里会明确标注「这是试跑，不代表已信任」。
   * 三者缺一，就会出现「试跑一次 → 下一轮自动放行」。
   *
   * @param {string} id 条目 id
   * @param {object} [opts] { confirmBlock:boolean, budget:object } 由调用方（IPC 层）负责确认与配额
   * @returns {Promise<object>} 试跑结果摘要（供 UI 展示，不含任何状态变更）
   */
  async probeQuarantined(id, opts) {
    const o = opts || {}
    const e = this.store.db.sources[id]
    if (!e || e.deprecated) throw new Error('音源不存在或已废弃')
    const code = typeof e.code === 'string' ? e.code : ''
    if (!code) throw new Error('该条目没有本地脚本正文，无需试跑：直接点检测即可')
    // 只对隔离中的条目开放。非隔离条目走常规检测，避免这里变成第二个检测入口
    const inQuarantine = e.status === 'quarantined' || e.quarantined === true
    if (!inQuarantine) throw new Error('该条目不在隔离区，请直接使用常规检测')

    const cfg = this.store.config
    const cls = classifyQuarantineTrust(e, cfg)
    // block 档（有 CPU 空转死循环特征等）必须二次确认：这类脚本试跑可能吃满一个核。
    // 判档仍走 classifyQuarantineTrust 单一来源，这里不抄字面量。
    if (cls.level === 'block' && !o.confirmBlock) {
      const err = new Error('该脚本有空转死循环特征，试跑可能吃满 CPU。需要二次确认后再试跑。')
      err.code = 'NEED_CONFIRM_BLOCK'
      err.qzLevel = cls.level
      err.qzReasons = cls.reasons
      throw err
    }

    const started = Date.now()
    const name = e.lxName || e.scriptName || e.name || id
    this.emit('probe-start', { id, name, qzLevel: cls.level })
    let deep
    try {
      deep = await deepCheck(e, code, cfg, (t, p) => this.emit(t, p), () => this.cancelRequested)
    } catch (err) {
      this.emit('probe-done', { id, name, ok: false, error: String(err && err.message || err) })
      throw err
    }
    // 打标记：这份 deep 是试跑产出，任何自动化判定都必须当它不存在
    deep.probeOnly = true
    deep.probeAt = Date.now()

    // 只落 deep 这一个字段。status/quarantined/usable/obfTrusted 一个都不碰。
    e.deep = deep
    e.probe = {
      at: deep.probeAt,
      usableN: usableCount(e),
      qzLevel: cls.level,
      ms: Date.now() - started
    }
    this.store.saveDb()

    const usableN = usableCount(e)
    const plats = deep.platforms || {}
    const summary = {
      id: e.id,
      name,
      probeOnly: true,
      qzLevel: cls.level,
      loadable: !!deep.loadable,
      inited: !!deep.inited,
      usableN,
      platforms: Object.keys(plats).map(k => ({
        platform: k,
        status: (plats[k] && plats[k].status) || 'unknown',
        message: String((plats[k] && plats[k].message) || '').slice(0, 200)
      })),
      ms: Date.now() - started,
      // 明确告诉 UI：试跑没有改变任何状态，条目仍在隔离区
      stillQuarantined: true,
      trustedHashesUnchanged: true
    }
    this.log(`隔离区试跑「${name}」完成：实测可用平台 ${usableN} 个（仅查看，未信任、未放行）`, '安全', 'info')
    this.emit('probe-done', summary)
    this.emit('source-updated', e)
    return summary
  }

  async runCheck(ids, opts) {
    this.batchId = Date.now().toString(36).slice(-6)
    this.jobGate('检测', (ids && ids.length ? ids.length + ' 条' : '全部候选'))
    const opt = opts || {}
    // full=true：深度检测（打分）—— 关掉快速模式、全平台逐个真取链并强制重测，
    // 只有这条路径产出的 metrics 才带 depth='full'，才是可参与比较/排序的分数。
    const cfg = opt.full ? Object.assign({}, this.store.config, { quickCheck: false }) : this.store.config
    // 单条手动检测 = 强制重测；批量时默认跳过「已检测且脚本内容未变」的条目。
    // v1.9.16：UI 的「检测选中 / 检测并灌入」带 opts.force=true —— 手动勾选就是明确要重测，
    // 再走跳过逻辑会让用户以为批量检测没生效（实测反馈：勾 36 条点检测，秒完成、徽章全不变）。
    // 「跳过已检测」只对不指定条目的调用生效（爬取后自动检测 / 巡检 / 定时管线）。
    const force = opt.full || opt.force || !ids || ids.length <= 1
    const picked = (ids && ids.length ? ids.map(i => this.store.db.sources[i]).filter(Boolean) : this.store.getSources())
    // 服务端原生音源：服务端 list 会带 sourceUrl（当年经 URL 导入时留存的原始脚本地址），
    // 有地址的同样可以下载 + 沙箱真实取链检测 —— 过去一律跳过，用户点「检测」毫无反应
    // P-1432（W3）：排除明细进返回体（谁、为何被排除）；opts.force=true 时把
    // deprecated 条目也纳入检测（音源库的「强制重测」），检测收尾 dedupe 按新证据重评。
    const excludedList = []
    const list = picked.filter(e => {
      if (!(opts && opts.force) && e.deprecated) {
        excludedList.push({ id: e.id, name: e.lxName || e.scriptName || e.name || e.id,
          reason: '已废弃（同名旧版本），点条目的「强制重测」可纳入检测' })
        return false
      }
      if (e.fromServer && !e.url) {
        excludedList.push({ id: e.id, name: e.lxName || e.scriptName || e.name || e.id,
          reason: '服务端原生音源且无原始脚本地址，不参与本地检测' })
        return false
      }
      return true
    })
    // 静默过滤是「点了检测却毫无反应」的根源：重复合并项/无脚本地址的服务端音源本来就不该本地检测，
    // 但用户不知道，只会以为功能坏了。这里必须说清楚跳过了多少、为什么。
    let excluded = picked.length - list.length
    // 混淆剔除（v1.7.1 引入，默认开；v1.9.5 扩充判级）：开启后检测阶段直接拒绝高危脚本——
    // 音源脚本没有混淆的必要，重度混淆常用于藏木马/后门（lx-ikun issue#8 科普）；
    // v1.9.5 起判级还包含反调试硬特征（while(!![]){} 空转死循环 / 混淆自调度定时器 /
    // jsjiami 标识），依据 2026-10-15 NAS 实测：jsjiami.com.v7 混淆的脚本独吞 60%+ CPU。
    // 只剔 high（密度超高阈值或命中硬特征），mid 级标注不剔除，由用户自行判断。
    // v1.10.7 起 high 不再直接判死（status=dead），而是移入「混淆隔离」区（status=quarantined）：
    // 用户可在隔离页对无恶意硬特征的脚本点「信任」，按 contentHash 放行。
    // 注意：灌入阶段（runImport）还有一道同样的闸门，兜住「开关前检测的老条目」与「手动直灌」。
    const obfGate = this.applyObfGate(list, (e) => (typeof e.code === 'string' && e.code ? e.code : null), '检测')
    const obfRejected = obfGate.rejected
    if (obfRejected) excluded += obfRejected
    if (ids && ids.length && !list.length) {
      this.log(`所选 ${picked.length} 条全部无需本地检测（已合并的重复项 / 无原始脚本地址的服务端音源 / 高危混淆剔除），未执行检测`, '检测', 'warn')
      return { usable: 0, total: 0, excluded, excludedReasons: excludedList.slice(0, 50), notSource: 0, depInline: 0 }
    }
    this.job = { running: true, type: 'check', cancel: false, progress: { done: 0, total: list.length, usable: 0 }, step: '' }
    this.emit('job', { running: true, type: 'check' })
    this.log(`开始检测 ${list.length} 条候选（下载 + 沙箱真实取链，并发 ${Math.max(1, Math.min(16, cfg.concurrency || 8))}${cfg.quickCheck !== false ? '，快速模式（首个平台可用即停，其余标记未测）' : '，全平台完整检测'}${force && ids && ids.length > 1 ? '，勾选强制重测（忽略跳过已检测）' : ''}）…`, '检测')

    const conc = Math.max(1, Math.min(16, cfg.concurrency || 8))
    let idx = 0
    let usable = 0
    let skippedChecked = 0
    let depInline = 0
    let notSource = 0
    let staleResults = 0
    const obfSeen = {}   // 混淆分级计数（deep 结果写回时汇总）
    this.mirrorPref = null
    // 同内容只深检一次：
    //  - 种子来自库内已有检测结果（跨批次复用：重新爬取/新入库的同内容文件不必再深检）
    //  - 本批内先检完的作为 keeper，后来的孪生条目「即时废弃」
    //  即时废弃让「可用」计数全程真实，不再出现运行中虚高、结束时去重回落
    const deepByHash = {}
    for (const s of this.store.getSources()) {
      if (s.deprecated || !s.deep || !s.deep.hash || !s.contentHash || s.contentHash !== s.deep.hash) continue
      // 隔离区「试跑一次」产出的 deep（probeOnly）只给人看、不参与任何自动化决策。
      // 若让它进种子，同内容的正常条目会命中它当「已深检」而跳过/被判重复 —— 等于
      // 用户没确认信任就拿到了试跑结论，构成绕过确认的信任暗道。复用统一判据，不另写口径。
      if (isProbeOnlyDeep(s)) continue
      if (!deepByHash[s.contentHash]) deepByHash[s.contentHash] = { entry: s, deep: s.deep }
    }
    const nameByNorm = {}
    // 同因失败不再遮遮掩掩：deep 里只存 tooltip，多数人根本不会 hover。
    // 这里把同一类建议汇总成一条日志写进面板，用户一眼能看到「不是音源废了，是本机网络问题」。
    // 同一条建议只报一次，避免几十条音源刷屏。
    const hintSeen = new Set()
    const noteHint = e => {
      const h = e && e.deep && e.deep.hint
      if (!h || e.usable) return
      if (hintSeen.has(h)) return
      hintSeen.add(h)
      this.log((e.lxName || e.scriptName || e.name || '音源') + '：' + h, '网络')
    }
    // 预约占位：拿到哈希就立刻占坑（此时还没深检），
    // 否则并发生成的孪生条目会同时错过孪生判断、各自深检一遍（结束去重时可用数又回落）
    const reserve = e => {
      let resolve = null
      const ready = new Promise(r => { resolve = r })
      const rec = { entry: e, deep: null, ready, resolve }
      deepByHash[e.contentHash] = rec
      return rec
    }

    const worker = async () => {
      while (true) {
        if (this.cancelRequested) return
        const i = idx++
        if (i >= list.length) return
        const e = list[i]
        // 跳过：已有深度结果且脚本内容未变（旧版本结果没有内容指纹，会重测一次补记）
        if (!force && cfg.skipChecked !== false && e.deep && e.deep.checkedAt && e.contentHash) {
          if (e.deep.hash === e.contentHash) {
            skippedChecked++
            if (e.usable) usable++
            // v1.9.16：探针记录（probe/validTier）是 v1.9.9 才加的，老版本检测过的条目身上没有，
            // 跳过分支原来什么都不补 → 明明深检可用，音源库里却一直挂「未检测/疑似未测」徽章。
            // applyProbeRecord 是纯本地计算（只读已有 deep 结果，不发任何网络请求），缺就立即补齐，
            // 让「已实测/已排除」徽章与真实检测状态对齐。
            if (!e.probe && e.deep && !e.deep.cancelled) applyProbeRecord(e, e.deep)
            // v1.9.13：接口域名探活开关是后开的，已检测过的音源身上没有 apiAlive，
            // 而跳过分支不重新拉代码（code 为空，下面那段探测不会触发），
            // 结果就是「音源库」里一直没有后端在线/失效徽章。这里对缺结果的小批量补探一次。
            // 仅限本次检测条目很少时（用户手动勾几条）即时补探，让用户立刻看到徽章；
            // 大批量的补探交给收尾的 _backfillApiAlive（限量 + 并发 + 时间预算）。
            if (cfg.apiHostCheck && list.length <= 20 &&
                Array.isArray(e.apiHosts) && e.apiHosts.length &&
                (!e.apiAlive || !Object.keys(e.apiAlive).length)) {
              try { await probeApiHosts(e, cfg); this.emit('source-updated', e) } catch (_) {}
            }
            this.progress({ done: i + 1, total: list.length, usable })
            continue
          }
          staleResults++
        }
        e.checking = true
        this.emit('source-updated', e)
        this.step(`检测 ${i + 1}/${list.length} ${e.name}`)
        try {
          const { code } = await checkBasic(e, cfg, (t, p) => this.emit(t, p), this.mirrorPref)
          if (e.fetchMirror) this.mirrorPref = e.fetchMirror   // 镜像学习：成功的镜像后续优先
          // v1.9.10：可选接口域名存活探测（默认关，避免每个音源都打网络请求）
          if (cfg.apiHostCheck && e.status === 'ok' && code) {
            try { await probeApiHosts(e, cfg) } catch (_) {}
          }
          // 注意：单条手动检测（force）必须绕过「疑似度」门禁。
          // 否则打分偏低的真实音源连沙箱都进不去，用户点「检测」毫无反应，
          // 会被当成「检测有问题」。深检自身有并发与预算保护，放行不会拖垮速度。
          if (e.status === 'ok' && code && (e.suspected || force)) {
            if (this.cancelRequested) { delete e.checking; this.emit('source-updated', e); return }
            const twin = e.contentHash ? deepByHash[e.contentHash] : null
            // 服务端原生音源不参与去重合并（它代表服务端上的一个真实条目，废弃它没有意义）
            if (twin && twin.entry.id !== e.id && !e.fromServer) {
              // 同内容孪生：keeper 还在深检就等它的结果（省掉整次深检），然后即时废弃
              if (!twin.deep && twin.ready && !this.cancelRequested) {
                try { await stoppable(twin.ready, () => this.cancelRequested) } catch (err) {}
              }
              e.deprecated = true
              e.dupOf = twin.entry.id
              e.dupReason = DUP_REASON.SAME_CONTENT
              e.usable = false
              depInline++
            } else {
              const rec = e.contentHash ? (deepByHash[e.contentHash] || reserve(e)) : null
              const d = await deepCheck(e, code, cfg, (t, p) => this.emit(t, p), () => this.cancelRequested)
              if (d.cancelled) {
                // 取消：绝不覆盖旧的好结果；旧结果不存在但部分平台已可用时才采用部分结果
                if (!e.deep && usableCount(d) > 0) e.deep = d
              } else {
                // 非打分档检测（初筛）**直接覆盖**，不继承上一轮的分数。
                // 2026-11-11 00:38 用户拍板：评分只是「刚测出来的参考排序」，不长期留存。
                // 之前的 _keepScoredMetrics 会把旧 metrics（5 次全成功、旧 p50）拼到新
                // platforms（可能只剩 2 个可用）上 ⇒ 出现「2 平台 · 300ms（来自昨天）」
                // 这种自相矛盾的成绩，源明明已经坏了却还挂着高分排序。
                e.deep = d
                this._mergeUpdateTips(e, d.updateTips)
              }
              if (rec) { rec.deep = e.deep || d; if (rec.resolve) { rec.resolve(rec.deep); rec.resolve = null } }
              e.usable = usableCount(e) > 0
              // v1.13.10：已废弃条目被「强制重测」时会走到这里（runCheck 的 force 分支
              // 把 deprecated 纳入检测名单）。重测写出 usable=true 但没人动 deprecated，
              // 于是库里长出「实测可用却标记废弃」的矛盾态（8197 实测 96 条，界面显示
              // 「可用平台 N 个」但该源根本不参与候选/灌入/排序，比直接显示不可用更误导）。
              // 这里不解除废弃：是否复活由 dedupe 收尾的组内兜底按「组里还有没有活的副本」
              // 统一裁决（组内已有活跃副本 → 它是多余副本；组内已全灭 → 它会被复活）。
              if (e.deprecated) e.usable = false
              applyProbeRecord(e, e.deep)   // v1.9.9：把深检结论固化为可记录的探针/validTier
              this.applyQualityGate(e)      // v1.12.0：版本回归对比（质量守门，软标记）
              // 混淆标注（v1.7.1）：checkBasic 已把 obfLevel/obfHits 写到条目上，
              // 重度/局部混淆都在状态徽章可见；这里只汇总日志。
              if (e.obfLevel) obfSeen[e.obfLevel] = (obfSeen[e.obfLevel] || 0) + 1
              noteHint(e)
              if (e.usable) usable++
              // 同名即时去重（本批内）：内容不同视为版本迭代，只留更好的一条
              // （服务端原生音源不参与，理由同上）
              const nmKey = normName(e.lxName || e.scriptName || e.name)
              if (nmKey && !e.deprecated && !e.fromServer) {
                const prev = nameByNorm[nmKey]
                if (prev && prev.entry.id !== e.id) {
                  // P-1432：任一方深检不完整（quick 的 untested / 上游限流熔断）→ 不当场废弃，
                  // 双方留待检测收尾的「同名并存自动深检」收敛（doujs r2 实测：限流瞬间的
                  // 3/5 vs 5/5 会被 quick 证据当场废掉可救产物）
                  if (this._deepIncomplete(prev.entry) || this._deepIncomplete(e)) continue
                  // ⚠️ R9 硬规则：真音源不因同名对决被追更链条目挤掉
                  //   （betterKeeper 内部已有该规则，这里是「即时去重」这条独立路径的兜底）
                  const hardKeep = preferRealSource(prev.entry, e)
                  const keep = hardKeep || (this.betterKeeper(prev.entry, e) ? prev.entry : e)
                  const drop = keep === prev.entry ? e : prev.entry
                  delete drop.checking   // P-1432：被废条目若残留检测中标记一并清掉，避免状态卡「检测中…」
                  if (drop.usable) usable--
                  drop.usable = false
                  drop.deprecated = true
                  drop.dupOf = keep.id
                  // 可用度裁决的措辞：被废方实测失效而保留方可用 → 说明是「失效让位」
                  drop.dupReason = (drop.deep && drop.deep.checkedAt && usableCount(drop) === 0 && usableCount(keep) > 0)
                    ? DUP_REASON.VERSION_DEAD : DUP_REASON.OLD_VERSION
                  depInline++
                  nameByNorm[nmKey] = { entry: keep, deep: keep.deep }
                  this.emit('source-updated', drop)
                } else if (!prev) {
                  nameByNorm[nmKey] = { entry: e, deep: e.deep }
                }
              }
            }
          } else if (e.status === 'ok' && !e.suspected && code) {
            notSource++   // 下载成功但缺少洛雪音源特征（归入疑似，不进深度检测）
            this._autoLearnBlockPattern(e)   // P-1434：特征库自动学习——非音源脚本后续不再采集
          }
        } catch (err) {
          const msg = String((err && err.message) || err)
          if (msg !== '已取消') { e.status = 'dead'; e.error = msg.slice(0, 120) }
        } finally {
          // 无论正常结束、异常、还是 try 内任何 continue/return（尤其 :3374 同名对决证据不完整
          // 时那条 continue），都必须清掉 checking —— 否则条目永久卡「检测中…」（用户实测
          // v9.1.2 一直转圈）。store 启动清扫只能治重启，运行期残留靠这里根治。
          if (e.checking) { delete e.checking; this.emit('source-updated', e) }
        }
        this.progress({ done: i + 1, total: list.length, usable })
        this._saveDbThrottled()
      }
    }
    await Promise.all(Array.from({ length: conc }, () => worker()))
    this.store.saveDb()
    const bf = await this._backfillApiAlive(list, cfg)
    const dup = this.dedupe()
    // P-1432（R3 用户裁决）：同名并存组自动深检跟进——系统主动把 quick 证据升级成 full，
    // 让 _dedupe 的质量对决定胜负，同名条目不再长期并存堆积。
    if (cfg.autoDeepPendingDuels !== false && !this.cancelRequested) {
      await this._autoDeepPendingDuels(cfg)
    }
    // P-1432（v1.13.8）：脚本更新信号追更（updateUrl 指向的新版脚本入库走全管线）
    if (cfg.autoFollowScriptUpdate !== false && !this.cancelRequested) {
      await this._followUpdateTips(cfg)
    }
    // P-1434 ④：逐源一行摘要（平台级结果一目了然）；usable=0 用 error 级
    for (const e of list) {
      const dp = e.deep && e.deep.platforms
      if (!dp || e.deprecated) continue
      const parts = []
      let bad = 0
      for (const [pl, x] of Object.entries(dp)) {
        const st = (x || {}).status
        if (st === 'usable') { parts.push(pl + '✓'); continue }
        if (st === 'failed') { bad++; parts.push(pl + '✗(' + String((x || {}).message || '').slice(0, 12) + ')'); continue }
        parts.push(pl + '…')
      }
      if (!parts.length) continue
      const nm = e.lxName || e.scriptName || e.name || e.id
      this.log(`「${nm}」 ${parts.join(' ')}`, '检测', bad && !usableCount(e) ? 'error' : 'info')
    }

    if (this.cancelRequested) this.log('检测已取消（已完成的检测结果全部保留）', '检测', 'warn')
    else this.log(`检测完成：可用 ${usable} 条 / 共 ${list.length} 条` +
      (skippedChecked ? `，跳过已检测 ${skippedChecked} 条` : '') +
      (depInline ? `，即时去重废弃 ${depInline} 条` : '') +
      (excluded ? `，跳过重复合并项/服务端原生 ${excluded} 条` : '') +
      (notSource ? `，非典型音源 ${notSource} 条` : '') +
      (bf ? `，补探接口域名 ${bf.done} 条（后端可达 ${bf.up} / 全不可达 ${bf.down}）` : '') +
      (obfSeen.high ? `，重度混淆 ${obfSeen.high} 条（状态栏有标记，建议拒绝使用）` : '') +
      (obfSeen.mid ? `，局部混淆 ${obfSeen.mid} 条（可能防和谐，自行甄别）` : '') +
      ((dup.dupFile || dup.dupContent || dup.oldVersion) ? `，收尾去重 ${dup.dupFile + dup.dupContent + dup.oldVersion} 条` : ''), '检测')
    this.job.running = false
    this.emit('job', { running: false, type: 'check', done: true, cancelled: this.cancelRequested, usable, total: list.length, notSource, depInline, obfHigh: obfSeen.high || 0, obfMid: obfSeen.mid || 0, backfill: bf || null })
    return { usable, total: list.length, notSource, depInline, obfHigh: obfSeen.high || 0, obfMid: obfSeen.mid || 0, backfill: bf || null , excludedReasons: excludedList.slice(0, 50) }
  }

  /**
   * v1.9.15：批量补探接口域名存活（主检测收尾后单跑一段）。
   * 背景：「接口域名存活探测」是后加的开关，库里几千条历史音源身上根本没有 apiAlive；
   * 而主检测开着「跳过已检测」，这些条目不重新拉代码，探测条件不成立 → 音源库里的
   * 「后端N在线 / 后端失效×N」徽章一条都出不来。
   * 做法：主循环结束后单独挑缺结果的条目补探，每轮限量 + 并发 + 时间预算三重保护，
   * 多跑几轮自然把全库补齐，不会把单轮检测拖成几小时。
   * @returns {null|{done:number,up:number,down:number,pending:number}}
   */
  async _backfillApiAlive(list, cfg, opts) {
    const o = opts || {}
    if (!cfg || !cfg.apiHostCheck) return null
    const max = Math.max(0, Number(cfg.apiHostBackfillMax))
    if (!max) return null
    const need = (list || []).filter(e => e && !e.deprecated &&
      Array.isArray(e.apiHosts) && e.apiHosts.length &&
      (!e.apiAlive || !Object.keys(e.apiAlive).length))
    if (!need.length) return null
    // 先补「用户真在用」的（深检可用），其次最近检测过的，让有价值的先出结果
    need.sort((a, b) => (b.usable ? 1 : 0) - (a.usable ? 1 : 0) ||
      Number((b.deep && b.deep.checkedAt) || 0) - Number((a.deep && a.deep.checkedAt) || 0))
    const picked = need.slice(0, max)
    const conc = Math.max(1, Math.min(8, Number(cfg.apiHostBackfillConcurrency) || 6))
    // 时间预算：域名不可达时每条要等到 5s 超时，限量之外再加一道墙
    const budget = Math.max(1000, Number(o.budgetMs != null ? o.budgetMs : cfg.apiHostBackfillBudgetMs) || 180000)
    const t0 = Date.now()
    let idx = 0, done = 0, up = 0, down = 0
    const worker = async () => {
      while (true) {
        if (this.cancelRequested) return
        if (Date.now() - t0 > budget) return
        const i = idx++
        if (i >= picked.length) return
        const e = picked[i]
        try {
          await probeApiHosts(e, cfg)
          const vs = Object.values(e.apiAlive || {})
          if (vs.some(v => v === 'up' || String(v).startsWith('http_'))) up++
          else if (vs.length) down++
          this.emit('source-updated', e)
        } catch (_) {}
        done++
        if (done % 20 === 0) this.step(`补探接口域名 ${done}/${picked.length}`)
        this._saveDbThrottled()
      }
    }
    this.log(`补探接口域名存活：本轮 ${picked.length} 条（库内待补 ${need.length} 条，并发 ${conc}，预算 ${Math.round(budget / 1000)}s）…`, '检测')
    await Promise.all(Array.from({ length: conc }, () => worker()))
    this.store.saveDb()
    const stopped = done < picked.length
    this.log(`接口域名补探完成：新增 ${done} 条结果（后端可达 ${up} 条 / 全不可达 ${down} 条）` +
      (stopped ? (this.cancelRequested ? '（已取消，未探完的下轮继续）' : `（达到 ${Math.round(budget / 1000)}s 预算，剩余留到下轮）`) : '') +
      (need.length > done ? `，库内还有 ${need.length - done} 条待补` : ''), '检测')
    return { done, up, down, pending: need.length - done }
  }

  // ---------------- 快速指纹去重（爬取后先跑，检测就跳过重复） ----------------
  /**
   * 只下载 + 算 sha256 + 正则提取元信息（不进沙箱，非常快），
   * 然后按内容哈希、@name 去重。检测阶段直接跳过被废弃的孪生条目，
   * 省掉最贵的沙箱取链耗时。
   */
  async runHash(ids) {
    this.jobGate('指纹去重', (ids && ids.length ? ids.length + ' 条' : '全部'))
    const cfg = this.store.config
    const list = (ids && ids.length ? ids.map(i => this.store.db.sources[i]).filter(Boolean) : this.store.getSources())
      .filter(e => !e.deprecated && !e.fromServer)
    this.job = { running: true, type: 'hash', cancel: false, progress: { done: 0, total: list.length }, step: '' }
    this.emit('job', { running: true, type: 'hash' })
    this.log(`开始快速指纹去重：下载 ${list.length} 条并计算内容哈希（不进沙箱）…`, '去重')
    const r = await this._hashPass(ids)
    this.job.running = false
    this.emit('job', { running: false, type: 'hash', done: true, cancelled: this.cancelRequested, summary: r })
    return r
  }

  /** 指纹去重核心（不含任务状态管理，爬取后可内联调用） */
  async _hashPass(ids) {
    const cfg = this.store.config
    const list = (ids && ids.length ? ids.map(i => this.store.db.sources[i]).filter(Boolean) : this.store.getSources())
      .filter(e => !e.deprecated && !e.fromServer)
    this.mirrorPref = null

    const conc = Math.max(4, Math.min(16, (cfg.concurrency || 8) + 4))
    let idx = 0, hashed = 0, failed = 0, noSource = 0
    const byHash = {}
    const worker = async () => {
      while (true) {
        if (this.cancelRequested) return
        const i = idx++
        if (i >= list.length) return
        const e = list[i]
        // stale = 增量爬取发现上游 blob sha 变了（raw 链接指向 HEAD）→ 必须重下比对，
        // 不能因「已有指纹」跳过 —— 否则树内 .js 的内容更新永远检测不到
        if (e.contentHash && e.suspected != null && !e.stale) {
          // 已有指纹（之前跑过），直接参与分组
          groupHash(e)
          this.progress({ done: i + 1, total: list.length })
          continue
        }
        e.checking = true
        this.emit('source-updated', e)
        this.step(`指纹 ${i + 1}/${list.length} ${e.name}`)
        try {
          // 单条硬超时（v1.10.8）：镜像候选链（多轮尝试）+ 慢读取可能把单条拖到几分钟，
          // 而 cancel 只在条目间检查——246 实测一条 agg-source 下载卡住整个指纹阶段，
          // 期间用户点「采集」全部被「已有任务在运行」拒绝且日志无痕迹。超时按失败跳过，任务绝不卡死。
          const hardTmo = Math.max(45000, (cfg.timeoutMs || 15000) * 4)
          const { code } = await new Promise((resolve, reject) => {
            const tm = setTimeout(() => reject(new Error(`单条处理硬超时（${Math.round(hardTmo / 1000)}s，已跳过）`)), hardTmo)
            checkBasic(e, cfg, (t, p) => this.emit(t, p), this.mirrorPref).then(
              (r) => { clearTimeout(tm); resolve(r) },
              (err) => { clearTimeout(tm); reject(err) })
          })
          if (e.fetchMirror) this.mirrorPref = e.fetchMirror
          if (e.status === 'ok' && code) {
            hashed++
            this._noteDomainIoc(e, code, '指纹检测')   // 观察模式：仅审计，不改行为
            if (!e.suspected) { noSource++; this._autoLearnBlockPattern(e) }   // P-1434：非音源自动入特征库
            if (e.stale) { e.stale = false; e.staleAt = 0 }   // 已重新下载校验，清除待重下标记
            // 检测完还没深检：先清掉旧的深检结果标记（内容已变则旧结果作废）
            if (e.deep && e.deep.hash && e.deep.hash !== e.contentHash) {
              e.deep = null; e.usable = false
              e.updated = true; e.updatedAt = Date.now()   // 内容确实变了：标「有更新」，灌入时走同名替换
              // v1.13.10：内容已换版 = 旧的「与谁重复」这个结论已经不成立，必须一并撤销，
              // 否则库里会留着「标着同内容重复、实际 hash 早已不同」的陈旧 dupReason
              // （8197 实测 14 条）。清标记后交给下一次 dedupe 按新内容重新裁决。
              if (e.deprecated) { e.deprecated = false; e.dupOf = null; e.dupReason = null }
            }
            groupHash(e)
          } else failed++
        } catch (err) {
          const msg = String((err && err.message) || err)
          if (msg !== '已取消') { e.status = 'dead'; e.error = msg.slice(0, 120) }
          failed++
        }
        delete e.checking
        this.emit('source-updated', e)
        this.progress({ done: i + 1, total: list.length })
        this._saveDbThrottled()
      }
    }
    // 同内容分组：后到的直接废弃（保留更好的一条：可用 > 新 > id 小）
    // 用箭头函数以拿到 hunter 实例的 this
    const groupHash = e => {
      if (!e.contentHash) return
      const prev = byHash[e.contentHash]
      if (!prev) { byHash[e.contentHash] = e; return }
      const keep = this.betterKeeper(prev, e) ? prev : e
      const drop = keep === prev ? e : prev
      drop.deprecated = true
      drop.dupOf = keep.id
      drop.dupReason = DUP_REASON.SAME_CONTENT
      drop.usable = false
      byHash[e.contentHash] = keep
      this.emit('source-updated', drop)
    }
    await Promise.all(Array.from({ length: conc }, () => worker()))
    this.store.saveDb()
    const dup = this.dedupe()
    const depTotal = Object.values(this.store.db.sources).filter(e => e.deprecated).length
    this.log(this.cancelRequested
      ? '指纹去重已取消'
      : `指纹去重完成：下载 ${hashed} 条、失败 ${failed} 条、非典型音源 ${noSource} 条，废弃重复 ${dup.dupContent + dup.dupFile} 条、同名旧版本 ${dup.oldVersion} 条。库内共 ${Object.keys(this.store.db.sources).length} 条 → 累计废弃 ${depTotal} 条 → 剩 ${this.store.getSources().filter(e => !e.deprecated).length} 条唯一候选`, '去重', this.cancelRequested ? 'warn' : 'info')
    return { hashed, failed, noSource, depTotal, total: list.length }
  }

  // ---------------- 已灌入列表 ----------------
  // 说明（v1.8.0）：列表**只看当前选中账号**（= 该账号在服务端上真实存在的音源）。
  // 不同平台账号的音源本来就是不同的两套，合并显示反而会让人以为「没灌成功」，
  // 所以这里保持单账号视图；多平台只体现在「灌入」时一次灌多个目标账号。

  // ---------------- 灌入 ----------------
  /**
   * 解析本次灌入的目标平台账号（v1.8.0 多平台同时灌入）。
   * - opts.platformIds 显式指定 → 用它（UI 里临时勾选的场景）；
   * - 否则用「设置了『参与批量灌入』的账号」；一个都没标记 → 只灌当前选中账号（旧行为）。
   */
  _importTargets(opts) {
    const cfg = this.store.config
    const all = (cfg && cfg.platforms) || []
    const wanted = opts && Array.isArray(opts.platformIds) && opts.platformIds.length ? opts.platformIds : null
    // P-1433（联动测试报告问题 3）：platformIds 分支此前直接 filter，账号没过
    // resolveEnableAfterImport —— acct.enableAfterImport 恒 undefined → lxserver 适配器
    // 透传不触发 → afterImport 里 undefined !== false 成立【恒 toggle 启用】，全局/账号
    // 开关在这条路径失效（与 P-1429 #6 同类 bug 换路径复发）。补齐与
    // getBatchImportAccounts 相同的解析口径：账号覆盖 → 回退全局。
    const accts = wanted
      ? all.filter(p => p && p.type && wanted.indexOf(p.id) >= 0)
          .map(p => Object.assign({}, p, { enableAfterImport: resolveEnableAfterImport(p, cfg) }))
      : getBatchImportAccounts(cfg)
    return accts.map(a => ({ adapter: getService(a.type), acct: a, type: a.type }))
  }

  /**
   * 灌入（支持多平台同时灌入）
   * @param {string[]} ids 音源 id
   * @param {object} [opts] { platformIds?: string[] }
   *
   * 多平台要点：
   *  1. 脚本内容只下载一次（共享 codeCache），各账号各自读列表、各自裁决 —— 同名
   *     冲突必须按「那个服务端自己的现状」判，拿 A 的列表去裁决 B 会误判；
   *  2. 各账号互不影响：某个账号连不上只跳过它，其它账号继续灌；
   *  3. 「已灌入」记录按平台分类（platformId + importedTo[]），撤回按当前账号过滤。
   */
  async runImport(ids, opts) {
    this.batchId = Date.now().toString(36).slice(-6)
    this.jobGate('灌入', (ids && ids.length ? ids.length + ' 条' : '全部待灌'))
    const cfg = this.store.config
    let targets = (ids || []).map(i => this.store.db.sources[i]).filter(Boolean)
    // 2026-11-23 恶意源治理：恶意 hash / szyshr 整仓拉黑 / 存疑源，灌入前置闸门直接拒绝。
    // 只按元数据（contentHash/repo/id）判定，绝不读取/执行脚本正文。
    {
      const g = filterImportCandidates(targets)
      if (g.blocked.length) {
        for (const b of g.blocked) {
          this.log(`安全闸门拒绝灌入：${b.entry.name || b.entry.id}（${b.reason}）`, '灌入', 'warn')
        }
        targets = g.keep
      }
    }
    // 突破项①②：把本批两处 AI 旁路分类（项①阶段2 冷启动 + 项② R4 更新语义）**转后台**执行，
    // runImport 不再等待（AI 开启时省 ~90s 持锁等待）。结果滞后一轮参与排序（AI 仅第 6-7 级 tie-break，
    // 客观指标全并列才生效，影响面极窄）。加固五件套见 _queueBypassClassify 注释。
    // 旁路铁律不变：只写独立字段，不进判定链/act/三锁/gold/默认安全态；失败静默、不中断灌入。
    if (targets.length && (!opts || opts.noQualitySort !== true)) {
      try { this._queueBypassClassify(targets) } catch (e) { /* 入队失败：不预判、原序，不中断灌入 */ }
    }
    // P1-1：灌入队列接质量排序键（只改执行先后，不改任何裁决/skip/删旧兜底）。
    // 向后兼容：opts.noQualitySort=true 时保持原勾选顺序（测试/回退用）。
    if (!opts || opts.noQualitySort !== true) {
      targets = targets.slice().sort((a, b) => compareImportQuality(a, b) ||
        String(a.id).localeCompare(String(b.id)))
    }
    if (!targets.length) throw new Error('没有选中任何音源')

    const svcs = this._importTargets(opts)
    if (!svcs.length) throw new Error(NO_ACCOUNT_ERR)
    const multi = svcs.length > 1

    // 存量正文补档：本地库里已经存着正文的条目，按 contentHash 复制一份到副本目录。
    // 纯本地搬运、零网络，用于「服务端那条是不是我们灌的」的 size 对账；
    // 每次灌入前跑一遍，保证新采集到的脚本下次也能参与对账。
    try {
      const bf = this.store.backfillScripts ? this.store.backfillScripts() : null
      if (bf && bf.archived) this.log(`补档脚本正文副本 ${bf.archived} 份（用于服务端条目对账）`, '灌入', 'info')
    } catch (e) { /* 补档失败不影响灌入 */ }

    this.job = { running: true, type: 'import', cancel: false, progress: { done: 0, total: targets.length * svcs.length }, step: '' }
    this.emit('job', { running: true, type: 'import' })
    this.emit('import-targets', svcs.map(s => ({ id: s.acct.id, name: s.acct.name || s.acct.url, type: s.type })))
    if (multi) this.log(`多平台灌入：目标 ${svcs.length} 个账号（${svcs.map(s => s.acct.name || s.acct.url).join('、')}）`, '灌入')

    // Top3：从占用 job 锁到结果收尾整体包 try/finally —— 任何异常（网络/适配器/裁决抛错）
    // 都必须解锁并发 done 事件，否则任务永久卡在 running（与其他入口 crawl/hub 同构）。
    let importError = null
    let obfRejected = 0
    let finalSummary = null
    try {
    // ---- 阶段 1：逐个账号连通性校验 + 读取服务端现有列表 ----
    this.step(multi ? '校验各平台账号并读取服务端音源…' : '连接服务平台…')
    const plans = []
    for (const svc of svcs) {
      const label = svc.acct.name || svc.acct.url
      let v
      try { v = await svc.adapter.verify(svc.acct) } catch (e) { v = { ok: false, msg: String((e && e.message) || e) } }
      if (!v.ok) {
        this.log(`平台「${label}」不可用，本次跳过：${v.msg}`, '灌入', 'warn')
        continue
      }
      this.log(`已连接平台「${label}」（${svc.type}）：${v.msg}`, '灌入')
      // serverIds 必须区分「读到了但为空」和「压根没读到」：
      // 前者说明服务端确实一条都没有（该重灌就重灌），后者说明我们不知道现状 ——
      // 不知道时只能相信本地账本，否则服务端一抖动就会把整库重复灌一遍。
      let serverByName = {}
      let serverByBase = {}
      let serverIds = null
      let serverList = null
      try { serverList = await svc.adapter.list(svc.acct) } catch (e) {
        this.log(`读取「${label}」音源列表失败：${String((e && e.message) || e)}（同名保护与「是否已灌入」判定将退回本地记录）`, '灌入', 'warn')
      }
      if (Array.isArray(serverList)) {
        serverIds = new Set()
        const baseCand = {}
        for (const s of serverList) {
          if (!s) continue
          if (s.id != null) serverIds.add(s.id)
          if (s.name) serverByName[normName(s.name)] = s
          // 基准名分组：作者把版本写进 @name 时靠它配对（见 identity.baseNameKey）
          const bk = baseNameKey(s.name)
          if (bk) (baseCand[bk] = baseCand[bk] || []).push(s)
        }
        // 同一个基准名在服务端有多条（v1、v2 并存）→ 只拿 @version 最高的那条配对，
        // 其余原样留着交给用户处理。都不带可解析版本则不配：宁可新增，也不猜着删。
        let multi = 0
        for (const bk of Object.keys(baseCand)) {
          const arr = baseCand[bk]
          if (arr.length > 1) multi++
          const pick = pickHighestVersion(arr)
          if (pick) serverByBase[bk] = pick
        }
        this.log(`「${label}」服务端现有音源 ${serverList.length} 个` +
          (multi ? `（其中 ${multi} 组「删版本号后同名」并存，配对时只取版本最高那条）` : ''), '灌入')
      }
      plans.push({ svc, label, serverByName, serverByBase, serverIds, serverList })
    }
    if (!plans.length) {
      this.job.running = false
      this.emit('job', { running: false, type: 'import', done: true })
      throw new Error('所有灌入目标平台都不可用：' + svcs.map(s => s.acct.name || s.acct.url).join('、'))
    }

    // 预处理：下载脚本内容（灌入走 upload，服务端无需自己出网）+ 补哈希 / @name
    // 小并发池下载（4），并做镜像学习
    this.step('预处理：下载脚本内容…')
    const codeCache = {}
    this.mirrorPref = null
    let dlIdx = 0
    const dlWorker = async () => {
      while (dlIdx < targets.length) {
        if (this.cancelRequested) return
        const e = targets[dlIdx++]
        // 压缩包内脚本：内容爬取时已就地保存，无需再按 raw 链接下载
        if (typeof e.code === 'string' && e.code) {
          codeCache[e.id] = e.code
          if (!e.contentHash) e.contentHash = sha256Str(e.code)
          continue
        }
        try {
          const { res, mirror } = await crawlFetch(e.url, null, cfg.timeoutMs, cfg.mirror, this.mirrorPref)
          if (res && res.ok) {
            if (mirror) this.mirrorPref = mirror
            const text = await readText(res, cfg.timeoutMs)
            // 静态情报·硬否决（2026-11-24）：下载后若补算出的 hash 命中恶意指纹，
            // 立即丢弃正文并标记该条跳过——堵「入库时无 hash、下载后才命中」的绕过面。
            if (isMaliciousHash(e.contentHash) || isMaliciousHash(sha256Str(text))) {
              e.contentHash = sha256Str(text)
              delete codeCache[e.id]
              this.log(`安全硬否决：灌入下载后命中恶意脚本指纹，拒绝灌入：${e.name}（sha=${String(e.contentHash).slice(0, 12)}）`, '安全', 'warn')
              e.skip = '命中恶意脚本指纹（永不信任），拒绝灌入'
              continue
            }
            this._noteDomainIoc(e, text, '灌入下载')   // 观察模式：仅审计，不改行为
            codeCache[e.id] = text
            if (!e.contentHash) e.contentHash = sha256Str(text)
            const meta = extractMeta(text)
            if (!e.lxName) e.lxName = meta.name || ''
            if (!e.scriptName) e.scriptName = meta.name || e.name
            if (!e.lastModified) {
              try { const lm = res.headers.get('last-modified'); if (lm) e.lastModified = Date.parse(lm) || 0 } catch (err) {}
            }
          } else {
            this.log(`脚本下载失败：${e.name}（HTTP ${res ? res.status : '不可达'}）`, '灌入', 'warn')
          }
        } catch (err) {
          this.log(`脚本下载失败：${e.name} — ${String((err && err.message) || err)}`, '灌入', 'warn')
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, () => dlWorker()))

    // 混淆隔离闸门（v1.9.5 引入，v1.10.7 改为隔离+可信任）：灌入前按当前设置再过一遍高危混淆/反调试特征。
    // 检测阶段（runCheck）已经过一轮，但有两条路径会绕开它：
    //  ① 库里的老条目 —— 当初检测时这个开关还没开（或从没重新检测过）；
    //  ② 用户手动勾选直接灌入 —— 压根没过检测。
    // 用户要求「勾选后每次灌入都自动隔离」，所以这里兜底，判级与检测阶段完全同一标准
    // （obfuscationRisk：密度超高阈值，或命中空转死循环/混淆自调度/jsjiami 标识）。
    // 「混淆隔离」页信任过的条目（trustedObfHashes 按 contentHash）在这里放行。
    //
    // 【已知边界·不检查的情形】上面 2674-2711 的下载步骤是 best-effort：crawlFetch 遇到
    // 超时/断网/404 时只记一条 warn，不中断灌入。因此「这次下载失败 + 本地也没有存量正文」
    // 的条目会带着空 code 走到这里，被 applyObfGate 的 !code 分支放行（见 :1969）。
    // 这不算跳过检查：条目本身没有可灌的内容，applyObfGate 对这类条目还会顺手清掉历史残留的
    // 隔离态（:1970-1976）；真正要灌必须等正文成功下载后重走本闸门。换句话说
    // 「每次灌入都过闸门」在**有正文的条目**上恒成立；无正文条目不构成灌入动作。
    const obfGate = this.applyObfGate(targets, (e) => codeCache[e.id] || (typeof e.code === 'string' && e.code ? e.code : '') || '', '灌入前')
    obfRejected = obfGate.rejected
    if (!targets.length) {
      finalSummary = { ok: 0, replaced: 0, synced: 0, skipped: 0, total: 0, obfRejected }
      return { results: [], ok: 0, replaced: 0, synced: 0, skipped: 0, total: 0, obfRejected }
    }

    // 去重与同名裁决规划（纯函数 _planImportQueue，便于单测）——每个账号各规划一份：
    // 同名冲突取决于该服务端自己的现状，改名池也要按账号分开（否则第二个平台会
    // 以为名字已被占用而继续往后加后缀）
    const activeId = cfg.activePlatformId || (plans[0] && plans[0].svc.acct.id)

    // ---- 服务端动作冻结（v1.13.0）----
    // 在账本对账 / 队列规划之前刷新一次「服务端处置」冻结表：lx-music 侧禁用、单平台禁用、
    // 自检护栏隔离、删除过的音源，同一份内容不再灌回任何目标平台（用户口径：直到该音源有更新为止）。
    // 顺序很关键：必须在 reconcileImported 之前，否则对账先把记录摘掉，就再也看不出
    // 「这条曾经在服务端上、现在被删了」，删除动作会被误当成「从没灌过」而重灌。
    await this._refreshServerVeto(plans, activeId)

    let total = 0
    let frozenTotal = 0
    for (const p of plans) {
      // 账本对账（只在该账号的列表确实读到时才做）：服务端已经删掉的条目，本地记录跟着摘掉。
      // 不这么做的话，用户「删空服务端再重灌」会被本地那枚「已灌入」标记整体排除，表现为「灌不进去」。
      if (p.serverIds) {
        const rc = this.reconcileImported(p.svc.acct.id, Array.from(p.serverIds))
        if (rc.changed) this.log(`「${p.label}」账本对账：摘除 ${rc.dropped} 条服务端已不存在的灌入记录`, '灌入', 'info')
      }
      p.importedRecs = this._importedRecsFor(p.svc.acct.id, activeId)
      p.serverScore = this._scoreByServerId(p.svc.acct.id, activeId, p.serverList)
      p.ledger = this._ledgerByEntry(p.svc.acct.id, activeId)
      p.queue = this._planImportQueue(targets, {
        cfg, serverByName: p.serverByName, serverByBase: p.serverByBase,
        serverIds: p.serverIds, serverList: p.serverList,
        codeCache, importedRecs: p.importedRecs, serverScore: p.serverScore, ledger: p.ledger,
        noQualitySort: opts && opts.noQualitySort === true,
        // 该平台名字是不是 key：不是（MusicSync）则同名不需要改名，直接新增为独立条目
        uniqueName: p.svc.adapter.uniqueName !== false
      })
      p.usedRename = new Set()
      // 服务端处置冻结：被判过的音源不再灌（同一份内容）。转成 skip 项而不是直接从队列里
      // 抹掉 —— 结果面板要能说清「为什么没灌」，否则用户会以为漏了。
      const vetoNow = this.store.db.veto || {}
      let frozenHere = 0
      p.queue = p.queue.map(item => {
        if (!item || !item.e) return item
        // 冻结判断优先于任何 skip 标记（2026-11-13 联动测试发现）：同名同内容会先在
        // _planImportQueue 里被标成「同内容已存在，无需重复灌入」，旧行为 `item.skip` 直接
        // return 会把这个文案盖在冻结之上 —— 用户明明在服务端停用了这条源，结果面板却说
        // 「已存在」，看不出「被冻结了」。冻结命中时一律改写成冻结文案（含已 skip 的项）。
        if (item.frozen || !isFrozen(vetoNow, item.e)) return item
        frozenHere++
        return {
          e: item.e,
          skip: `服务端已处置过该音源（${vetoReason(vetoNow[item.e.id])}）→ 冻结，不重复灌入；该音源内容更新后自动解冻`,
          frozen: true
        }
      })
      if (frozenHere) {
        frozenTotal += frozenHere
        this.log(`「${p.label}」${frozenHere} 条按服务端处置冻结跳过（禁用/隔离/删除过的音源，内容未变不重灌）`, '灌入', 'warn')
      }
      total += p.queue.length
    }
    // 同名冲突第二层半（v1.13.7，P-1508 doujs 案例规则化）：quick 证据不足（实测平台数 < 服务端声明）
    // 时先用灌入阶段已下载的正文跑一次全平台深检补齐证据，再重新裁决——不再需要人肉 POST /api/check。
    // 放在第三层（音质档补测）之前：平台数证据便宜且常直接定胜负。
    await this._supplementConflicts(plans, codeCache, cfg)
    // 同名冲突第三层：平台数、p50 都打平且本地还没有音质档证据时，为**这一条**补测最高可播档。
    // 放在规划之后、执行之前：补测结果可能把「改名并存」翻成「留优删差 / 保留服务端」。
    await this._probeTierForConflicts(plans, codeCache, cfg)
    this.job.progress.total = total

    const results = []
    let n = 0
    outer:
    for (const p of plans) {
      if (this.cancelRequested) break
      if (multi) this.log(`开始灌入平台「${p.label}」（${p.queue.length} 项）`, '灌入')
      for (let i = 0; i < p.queue.length; i++) {
        if (this.cancelRequested) { this.log('用户取消灌入', '灌入', 'warn'); break outer }
        n++
        const item = p.queue[i]
        const nm = item.e.scriptName || item.e.lxName || item.e.name
        this.step(multi ? `[${p.label}] 灌入 ${i + 1}/${p.queue.length} ${nm}` : `灌入 ${i + 1}/${p.queue.length} ${nm}`)
        const r = await this._runImportItem(p, item, codeCache, multi)
        results.push(r)
        this.emit('import-item', r)
        this.progress({ done: n, total })
        await sleep(150)   // 轻微节流，避免打爆服务端；批量灌入时几乎无感
      }
    }
    // P1-3：服务端画像落盘（纯统计，只读展示；serverList=null 跳过保留旧值）。
    // 严禁反哺采集/灌入排序或降权——本画像只被 UI 读取。
    {
      const mainList = plans.find(p => Array.isArray(p.serverList)) // 主账号列表
      const prof = mainList ? profileServerFleet(mainList.serverList, this.store.imported, this.store.db.veto) : null
      if (prof) this.store.db.serverFleetProfile = prof
    }
    // 灌入收尾落盘：写失败必须留痕。原来丢弃返回值，界面照报「灌入完成 N 条」，
    // 但重启后这些灌入记录（imported / 账本 hash）全没了，用户看到的是「明明灌过又变未灌入」。
    if (this.store.saveDb() === false) {
      this.log('灌入结果写盘失败（磁盘空间或目录权限不足）：本轮记录可能在重启后丢失，请检查数据目录', '灌入', 'error')
    }
    const ok = results.filter(r => r.status === 'success' || r.status === 'replaced').length
    const replaced = results.filter(r => r.status === 'replaced').length
    const synced = results.filter(r => r.status === 'synced').length
    const skipped = results.filter(r => r.status === 'skipped').length
    const summary = { ok, replaced, synced, skipped, total: results.length, obfRejected }
    if (multi) {
      const byPlat = {}
      for (const r of results) {
        const k = r.accountName || '—'
        byPlat[k] = byPlat[k] || { ok: 0, total: 0 }
        byPlat[k].total++
        if (r.status === 'success' || r.status === 'replaced') byPlat[k].ok++
      }
      this.log('各平台结果：' + Object.entries(byPlat).map(([k, v]) => `${k} ${v.ok}/${v.total}`).join('；'), '灌入')
      summary.byPlatform = byPlat
    }
    this.log(`灌入完成：成功 ${ok} / 共 ${results.length}` +
      (synced ? `、同名已存在 ${synced}` : '') + (skipped ? `、跳过 ${skipped}` : '') +
      (replaced ? `（其中替换同名旧版 ${replaced} 个）` : '') +
      (obfRejected ? `、高危混淆剔除 ${obfRejected} 条` : ''), '灌入')
    finalSummary = summary
    return { results, ok, replaced, synced, skipped, obfRejected }
    } catch (e) {
      importError = e || new Error('未知灌入错误')
      this.log('灌入异常：' + String((importError && importError.message) || importError), '灌入', 'error')
      throw importError
    } finally {
      // 统一收尾：正常路径用 finalSummary，异常路径给同构零值 summary（前端读字段不炸）。
      this.job.running = false
      this.emit('job', {
        running: false, type: 'import', done: true,
        summary: finalSummary || { ok: 0, replaced: 0, synced: 0, skipped: 0, total: 0, obfRejected, error: String((importError && importError.message) || importError) },
        error: importError ? String((importError && importError.message) || importError) : undefined
      })
    }
  }

  /** 单条音源灌入单个平台账号（返回结果对象，含平台归属信息） */
  async _runImportItem(p, item, codeCache, multi) {
    const svc = p.svc
    const e = item.e
    const name = e.scriptName || e.lxName || e.name
    // 结果统一带上平台归属：多平台灌入时 UI 才能分清哪条落在哪个账号
    const base = () => ({
      id: e.id, name, platformId: svc.acct.id, platformType: svc.type,
      accountName: svc.acct.name || svc.acct.url
    })
    // 静态情报·硬否决（2026-11-24）最后一道：任何进入灌入执行的条目，只要当前内容 hash
    // 命中恶意指纹，一律拒绝（覆盖同名裁决 replace / 缓存刷新 / 伪装优质源等绕过面）。
    if (isMaliciousHash(e.contentHash) || isMaliciousHash(codeCache && codeCache[e.id] ? sha256Str(codeCache[e.id]) : '')) {
      this.log(`安全硬否决：灌入执行前拦截恶意指纹条目：${name}（sha=${String(e.contentHash).slice(0, 12)}）`, '安全', 'warn')
      return Object.assign(base(), { status: 'skipped', reason: '命中恶意脚本指纹（永不信任），拒绝灌入', hardVeto: true })
    }
    const tag = multi ? `[${p.label}] ` : ''
    if (item.skip) {
      this.log(tag + '跳过：' + name + ' — ' + item.skip, '灌入', 'warn')
      return Object.assign(base(), { status: 'skipped', message: item.skip })
    }
    try {
      let r = null
      // S3 / 原子性：删旧灌新过程的状态存档与回滚信息（写入本轮灌入结果，便于审计）
      let replaceInfo = null
      // P-1411 P0-B（执行期兜底）：规划是一次性快照，执行期服务端可能已经变了。
      // 同一批里前一条若已把这条服务端旧版删掉（同 base 多版本、或两条同名），这里再 remove
      // 必然失败（HTTP 500），旧实现会退回改名上传，于是服务端并存「（副本2）」条并列条目。
      // 以 p.serverIds（本轮开始时真实存在的 id）为准：旧版已不在 → 名字已空出来，直接按原名上传；
      // 仍撞名（例如前面刚装了同名）再退回改名上传。
      let replaceGone = false
      if (item.replaceServer && p.serverIds && !p.serverIds.has(item.replaceServer.id)) {
        replaceGone = true
        this.log(tag + `服务端旧版「${item.replaceServer.name || name}」已不在（本轮前面已替换/删除），改为直接上传新版本`, '灌入', 'warn')
        item = Object.assign({}, item, { replaceServer: null })
      }
      if (item.sameContentServer) {
        // 服务端已有一份内容相同的音源（同名命中，或按脚本内容指纹比对命中）：不重复上传，
        // 直接把本地这条挂到服务端那一条上，标记为「已灌入」。
        const srv = item.sameContentServer
        this._markImported(e, svc, srv.id, srv.name || name, srv.supportedSources || [], true, codeCache[e.id])
        this.log(tag + '服务端已有同内容音源，已标记已灌入（跳过上传）：' + name, '灌入', 'info')
        await sleep(80)
        return Object.assign(base(), { status: 'synced', lxId: srv.id, message: item.why || '服务端已有内容相同的音源，已标记为已灌入（未重复上传）', platforms: srv.supportedSources || [] })
      }
      if (item.replaceServer) {
        // 同名 + 内容不同 + 开启自动替换（默认）：先删服务端旧版，再传新版本 ——
        // 这正是 LX 网页端「同名要先删旧才能传新」的操作，猎手自动完成（v1.7.0）。
        // 删除会触发服务端全量脚本重载，等 2.5s 再传，规避「已存在」。
        const srv = item.replaceServer
        const code = codeCache[e.id]
        // S3：lxserver 按 @name 生成 id，版本写进名字时删旧灌新必然换 id，
        // states.json（平台开关）/ order.json（排序）按 id 存会全丢 → 删前先存档。
        const oldState = {
          id: srv.id, name: srv.name || name, owner: srv.owner,
          enabled: srv.enabled !== false,
          disabledSources: Array.isArray(srv.disabledSources) ? srv.disabledSources.slice() : []
        }
        replaceInfo = { oldState, deleted: false, migration: null, trash: null, restored: null }
        const rm = await svc.adapter.remove(svc.acct, srv.id, { owner: srv.owner })
        if (!rm.success) {
          this.log(tag + `替换失败：服务端旧版「${srv.name || name}」删除失败（${rm.message}），退回改名上传`, '灌入', 'warn')
          r = await this._uploadRenamed(svc, code, item.baseName, p.serverByName, p.usedRename)
          if (r && r.success) r.replacedFallback = 'renamed'
        } else {
          replaceInfo.deleted = true
          // 轻量 B：旧版已删、新版未装。记一笔持久化中间态，避免本轮异常退出后
          // 下一轮把「自己删的」当「用户删的」冻成 removed（旧版再也回不来）。
          this._setPendingReplace(e.id, srv.id, svc.acct.id)
          this.log(tag + `已删除服务端旧版「${srv.name || name}」（id=${srv.id}），轮询上传新版本…`, '灌入')
          // 轮询上传：等服务端重载完成（撞「已存在」就退避重试），不再固定硬等 2.5 秒
          r = await this._uploadAfterReplace(svc, code, name)
          if (!r.success && r.message && /已存在/.test(r.message)) {
            // 预算内仍撞名（极少见）：退回改名上传，保证音源至少能进去
            this.log(tag + '替换上传仍撞名，退回改名上传', '灌入', 'warn')
            r = await this._uploadRenamed(svc, code, item.baseName, p.serverByName, p.usedRename)
            if (r && r.success) r.replacedFallback = 'renamed'
          }
        }
        if (r && r.success) {
          // 新版已装上 → 清掉替换中间态（无论兜底改名还是正常灌入）
          this._clearPendingReplace(e.id, srv.id)
          // S3-B：按新 id 重建平台开关与启用态（lxserver 零改动，状态也由 lx-hunter 主导）
          const ad = svc.adapter
          const canMigrate = typeof ad.setPlatforms === 'function' || typeof ad.toggle === 'function'
          if (canMigrate && r.id && r.id !== srv.id) {
            const mig = {}
            try {
              if (oldState.disabledSources.length && typeof ad.setPlatforms === 'function') {
                const m = await ad.setPlatforms(svc.acct, r.id, oldState.disabledSources, { owner: r.owner || srv.owner })
                mig.platforms = !!(m && m.success !== false)
              }
              if (oldState.enabled === false && typeof ad.toggle === 'function') {
                const t = await ad.toggle(svc.acct, r.id, false, { owner: r.owner || srv.owner })
                mig.enabled = !!(t && t.success !== false)
              }
              this.log(tag + `已按新 id=${r.id} 重建旧状态（禁用平台 ${oldState.disabledSources.join('/') || '无'}，启用态 ${oldState.enabled}）`, '灌入', 'info')
            } catch (me) {
              mig.error = String((me && me.message) || me)
              this.log(tag + '状态重建失败（新版已装上，请手动恢复平台开关）：' + mig.error, '灌入', 'warn')
            }
            replaceInfo.migration = mig
          } else if (!canMigrate) {
            // S3-C：适配器不支持迁移时只提示，不阻断已成功的灌入（sourceUpdate.apply 则直接拒绝）
            replaceInfo.migration = { unsupported: true }
            this.log(tag + '当前平台不支持状态迁移：新版已装上，平台开关/排序可能按新 id 重置', '灌入', 'warn')
          }
          // 清理本地「已灌入」里指向被替换音源的旧记录（服务端那份已不存在）
          let purged = 0
          for (const [k, rec] of Object.entries(this.store.imported)) {
            if (rec && rec.lxId === srv.id) { this._dropPlatformFromImported(k, svc.acct.id); purged++ }
          }
          if (purged) { this.store.saveImported(); this.log(tag + `已清理 ${purged} 条指向被替换音源的本地灌入记录`, '灌入', 'info') }
        } else if (replaceInfo.deleted) {
          // 灌入明确失败：无论回收站恢复成功与否，这次「已删未装」中间态都结束了 ——
          // 恢复了 → 旧版还在服务端，无需豁免；没恢复 → 旧版确实没了，该冻就冻。
          this._clearPendingReplace(e.id, srv.id)
          // 原子性：已删未装 → 自动从服务端回收站恢复旧脚本；并把 trash 定位信息写进结果
          replaceInfo.trash = {
            owner: oldState.owner, id: oldState.id, name: oldState.name,
            at: new Date().toISOString()
          }
          const ad = svc.adapter
          if (typeof ad.listTrash === 'function' && typeof ad.restoreTrash === 'function') {
            try {
              const items = await ad.listTrash(svc.acct, oldState.owner)
              const hit = (items || []).find(t => String(t.id) === String(oldState.id))
              if (hit) {
                replaceInfo.trash.file = hit.file
                const rr = await ad.restoreTrash(svc.acct, oldState.owner, hit.file)
                replaceInfo.restored = !!(rr && rr.success !== false)
              } else replaceInfo.restored = false
            } catch (re) {
              replaceInfo.restored = false
              replaceInfo.trash.error = String((re && re.message) || re)
            }
          }
          this.log(tag + (replaceInfo.restored
            ? '灌入失败，已自动从服务端回收站恢复旧脚本（避免已删未装空窗）'
            : '灌入失败且旧脚本已删除：请先到服务端回收站恢复，trash 定位信息见本轮结果'), '灌入', 'warn')
        }
      } else if (item.renameServer) {
        // 同名 + 内容不同 + 用户关闭了自动替换：改名后上传，规避服务端「已存在」
        const code = codeCache[e.id]
        r = code
          ? await this._uploadRenamed(svc, code, item.baseName, p.serverByName, p.usedRename)
          : await svc.adapter.importUrl(svc.acct, e.url, (e.lxName || e.scriptName || e.name))
      } else {
        const code = codeCache[e.id]
        r = code
          ? await svc.adapter.upload(svc.acct, code, (e.lxName || e.scriptName || e.name))
          : await svc.adapter.importUrl(svc.acct, e.url, (e.lxName || e.scriptName || e.name))
        // 旧版已消失但名字仍被占（本轮前面刚装过同名）：退回改名上传，至少保证这条能进去
        if (replaceGone && code && r && !r.success && r.message && /已存在/.test(r.message)) {
          this.log(tag + '旧版已不在但名字仍被占用，退回改名上传', '灌入', 'warn')
          r = await this._uploadRenamed(svc, code, (e.lxName || e.scriptName || e.name), p.serverByName, p.usedRename)
          if (r && r.success) r.replacedFallback = 'renamed'
        }
      }
      if (r && r.success) {
        // v1.14.2（2026-11-24）：upload 成功 ≠ 服务端真的启用了。
        // afterImport 里那次 toggle 很可能因 requireUnsafe 被服务端回滚（enabled 回到 false），
        // 这种情形必须把 needUnsafeVM 一起记进账本，否则 computeVeto 只会看到 enabled=false
        // 而判成 disabled（用户主动停用），冻 24h —— 实测就是这个坑。
        this._markImported(e, svc, r.id, r.name || name, r.platforms || [], false, codeCache[e.id],
          r.needUnsafeVM ? { needUnsafeVM: true, vmGloballyEnabled: r.vmGloballyEnabled } : null)
        // 把裁决理由带上：用户最常问的就是「为什么这次是替换、那次是改名」
        const note = replaceGone
          ? '（服务端同名旧版已不存在，直接上传）' + (r.replacedFallback === 'renamed' ? '（原名仍被占用，已改名上传）' : '')
          : item.replaceServer
            ? (r.replacedFallback === 'renamed'
              ? '（同名替换失败，已改名上传）'
              : '（已替换服务端同名旧版：先删后传）' + (item.why ? ' — ' + item.why : ''))
            : item.renameServer ? '（已改名并存，未删服务端旧版）' + (item.why ? ' — ' + item.why : '')
              : (item.why ? '（' + item.why + '）' : '')
        // 靠「删版本号后同名」配上的，明确标出来：用户看日志能分清是精确同名还是基准名配对
        const baseNote = item.matchedByBase ? '（按删版本号后同名配对）' : ''
        const st = item.replaceServer && r.replacedFallback !== 'renamed' ? 'replaced' : 'success'
        this.log(tag + `已灌入：${name}${baseNote}${note}（id=${r.id}）`, '灌入')
        return Object.assign(base(), {
          status: st, lxId: r.id, message: (r.message || '') + baseNote + note, platforms: r.platforms || [],
          matchedByBase: !!item.matchedByBase,
          needUnsafeVM: !!r.needUnsafeVM,
          stateMigration: replaceInfo ? replaceInfo.migration : null
        })
      }
      this.log(tag + '灌入失败：' + name + ' — ' + ((r && r.message) || '导入失败'), '灌入', 'warn')
      // v1.14.2：upload 本身就失败但服务端已报了 requireUnsafe / VM_DISABLED 时，
      // 若已有服务端 id 就照样记账（无 id 说明没落库，记不了）。
      if (r && r.id && r.needUnsafeVM) {
        try {
          this._markImported(e, svc, r.id, r.name || name, r.platforms || [], false, codeCache[e.id],
            { needUnsafeVM: true, vmGloballyEnabled: r.vmGloballyEnabled })
        } catch (e2) { /* 记账失败不连累灌入结论 */ }
      }
      return Object.assign(base(), {
        status: 'failed', message: (r && r.message) || '导入失败',
        requireUnsafe: !!(r && (r.requireUnsafe || r.needUnsafeVM)),
        needUnsafeVM: !!(r && r.needUnsafeVM),
        trash: replaceInfo ? replaceInfo.trash : null,
        restored: replaceInfo ? replaceInfo.restored : null
      })
    } catch (err) {
      const msg = String((err && err.message) || err)
      this.log(tag + '灌入失败：' + name + ' — ' + msg, '灌入', 'warn')
      return Object.assign(base(), { status: 'failed', message: msg.slice(0, 160) })
    }
  }

  /**
   * 写「已灌入」记录（v1.8.0 多平台）：顶层的 platformId/accountName 指向最近一次
   * 灌入的平台，importedTo[] 保留全部平台，撤回时按账号精确摘除而不是整条删掉。
   */
  _markImported(e, svc, lxId, name, platforms, synced, code, extra) {
    // 正文副本落档：服务端不回正文，本地这份是「服务端那条到底是不是我们灌的」的唯一凭据
    // （size 对账、按需复测都靠它）。同 contentHash 只写一次。
    if (e.contentHash && typeof code === 'string' && code && this.store.archiveScript) {
      this.store.archiveScript(e.contentHash, code)
    }
    const prev = this.store.imported[e.id]
    const list = (prev && Array.isArray(prev.importedTo) ? prev.importedTo : [])
      .filter(x => x && x.platformId !== svc.acct.id)
    list.push({ platformId: svc.acct.id, platformType: svc.type, accountName: svc.acct.name || svc.acct.url, lxId, at: Date.now() })
    this.store.imported[e.id] = {
      lxId, name: name || (prev && prev.name) || e.name, contentHash: e.contentHash || '',
      serverUrl: svc.adapter.baseUrl(svc.acct), importedAt: Date.now(),
      platforms: platforms || [], serverSynced: !!synced,
      platformId: svc.acct.id, platformType: svc.type, accountName: svc.acct.name || svc.acct.url,
      importedTo: list,
      // v1.14.2（2026-11-24）：服务端「因需要原生 VM 把启用回滚了」的原因标记。
      // 来源：hunter 自己 toggle 时服务端响应里的 requireUnsafe / VM_DISABLED（lxservice.toggle 透传）。
      // 覆盖范围：**只覆盖 hunter 发起的启用**；用户在 lxserver 网页手动加白拿不到这个响应，
      // 那种情况仍按 disabled 处理 —— 这里如实标注，不当成完备信号。
      // 用途：computeVeto 据此判 vm-blocked（独立 type，走短复查自愈），而不是 disabled 冻 24h。
      needUnsafeVM: extra && extra.needUnsafeVM ? true : (prev && prev.needUnsafeVM ? true : undefined),
      needUnsafeVMAt: extra && extra.needUnsafeVM ? Date.now() : (prev && prev.needUnsafeVMAt) || undefined,
      vmGloballyEnabled: extra && extra.needUnsafeVM ? !!extra.vmGloballyEnabled : (prev && prev.vmGloballyEnabled),
      // 打分快照：服务端不回传脚本正文/hash/metrics（17950 实测 38 条全无），
      // 下次同名冲突时「服务端那条」本该拿不出任何实测证据 ⇒ 只能一律改名并存。
      // 这是我们自己刚灌进去的脚本，本地有它的实测画像，按服务端 id 存一份最小快照，
      // 下次就能回放成 qualityProxy，让「同名留优」真正能比，而不是靠声明值猜。
      // 只存打分档（depth==='full' 且真有样本）的结果：初筛的 1 样本 p50 不值得存。
      // 2026-11-11（P-1411 P1-4）：之前非 full 时沿用 `prev.score`，等于让这份快照「世袭」——
      // 用户只做初筛就把新版灌进去，账本里仍挂着上一版的质量画像，下次同名裁决拿旧画像
      // 代表新版去比，结论必然是错的（旧版质量 ≠ 新版质量）。现在不满足打分档就写 null，
      // 宁可让下一次裁决落到「证据不足」，也不用错证据。
      score: (e.deep && e.deep.metrics && e.deep.metrics.depth === 'full' &&
              Number(e.deep.metrics.samples) !== 0) ? {
        at: Date.now(),
        checkedAt: e.deep.checkedAt || null,
        platforms: e.deep.platforms || {},
        metrics: {
          depth: 'full',
          p50LatencyMs: e.deep.metrics.p50LatencyMs,
          samples: e.deep.metrics.samples,
          playableRate: e.deep.metrics.playableRate,
          successRate: e.deep.metrics.successRate,
          qualityMax: e.deep.metrics.qualityMax || null
        }
      } : null
    }
    this.store.saveImported()
  }

  /**
   * 记下「服务端因需要原生 VM 把启用回滚了」这件事（v1.14.2，2026-11-24）。
   *
   * 为什么需要它：`/api/service/toggle`（网页）与 `service:toggle`（桌面 IPC）只是把
   * lxservice.toggle 的结果原样返回，**从不碰账本**；而「源已在服务端、用户点启用 →
   * 被 requireUnsafe 回滚」恰恰是 vm-blocked 最常见的场景。没有这一步，
   * computeVeto 只看得到 enabled=false，只能判成 disabled（用户主动停用）冻 24h。
   *
   * 覆盖范围（如实标注，不要当成完备信号）：
   *   · 只覆盖 **hunter 自己发起的 toggle**（网页按钮 / 桌面按钮 / 灌入时的自动启用）；
   *   · 用户在 lxserver 网页上直接点启用或加白，hunter 拿不到那个响应，不会走到这里 ——
   *     那种情况仍按 disabled 处理。
   *
   * @param {string|null} lxId 服务端音源 id
   * @param {object|null} resp lxservice.toggle 的返回体
   * @returns {boolean} 是否改动了账本
   */
  noteToggleNeedUnsafeVM(lxId, resp) {
    if (lxId == null) return false
    const imported = this.store.imported || {}
    // 一个服务端 id 可能对应多条本地账本（多账号），全部同步
    let touched = false
    for (const eid of Object.keys(imported)) {
      const rec = imported[eid]
      if (!rec) continue
      const ids = []
      if (rec.lxId != null) ids.push(String(rec.lxId))
      if (Array.isArray(rec.importedTo)) for (const x of rec.importedTo) if (x && x.lxId != null) ids.push(String(x.lxId))
      if (ids.indexOf(String(lxId)) === -1) continue

      if (resp && resp.needUnsafeVM) {
        if (rec.needUnsafeVM === true) continue
        rec.needUnsafeVM = true
        rec.needUnsafeVMAt = Date.now()
        if (resp.vmGloballyEnabled !== undefined) rec.vmGloballyEnabled = !!resp.vmGloballyEnabled
        touched = true
      } else if (rec.needUnsafeVM === true) {
        // 这次启用成功了（或失败原因与 VM 无关）→ 旧标记作废，别再拿它判 vm-blocked
        delete rec.needUnsafeVM
        delete rec.needUnsafeVMAt
        delete rec.vmGloballyEnabled
        touched = true
      }
    }
    if (touched) {
      try { this.store.saveImported() } catch (e) { /* 记账失败不影响 toggle 结论 */ }
    }
    return touched
  }

  /** 从灌入记录里摘掉某个平台；该音源在所有平台都没了才整条删除 */
  _dropPlatformFromImported(eid, platformId) {
    const rec = this.store.imported[eid]
    if (!rec) return
    const rest = Array.isArray(rec.importedTo) ? rec.importedTo.filter(x => x.platformId !== platformId) : []
    if (!rest.length) { delete this.store.imported[eid]; return }
    const nx = rest[rest.length - 1]
    this.store.imported[eid] = Object.assign({}, rec, {
      lxId: nx.lxId, platformId: nx.platformId, platformType: nx.platformType, accountName: nx.accountName,
      importedTo: rest   // 必须写回：只改顶层不改数组的话，下次撤回还会以为这个平台仍有一份
    })
  }

  /**
   * 刷新「服务端处置」冻结表（v1.13.0）
   *
   * 把 lx-music 侧的四种动作翻译成本地冻结：
   *   removed（服务端已删除）/ isolated（自检护栏隔离）/ disabled（整源禁用）/
   *   platform-disabled（单平台或全部平台禁用）
   * 冻结期间任何灌入目标都不再上传该音源；音源内容（contentHash）变了自动解冻。
   *
   * 三个必须守住的点：
   *  1. **顺序**：必须在 reconcileImported 之前跑 —— 对账会摘掉「服务端已删」的记录，
   *     摘完就再也分不清「被删了」和「从没灌过」。
   *  2. **列表没读到就不要动冻结表**：服务端抖动时 serverList 为 null，此时按「全部消失」
   *     去算会把整张表写成 removed —— 一次网络故障就把全库源冻死。
   *  3. **多平台取并集**：冻结只针对同一份字节，任一平台判过就够（删除最优先）。
   *
   * @param {Array} plans runImport 阶段已建好的 {svc,label,serverList} 列表
   * @param {string} activeId 当前选中账号（老记录归属）
   */
  /**
   * 替换灌入中间态（轻量 B 案）：删旧版到装回新版之间，记一笔 db.pendingReplace[eid]，
   * 让这段「已删未装」不被冻结表误判成「用户删除」（serverVeto computeVeto 会豁免这些 lxId）。
   * 按 eid 存、按 lxId 精确豁免；跨崩溃/重启存活，成功/明确失败/超时后清理。
   */
  _pendingReplaceKey(eid) { return String(eid) }
  _setPendingReplace(eid, lxId, platformId) {
    const db = this.store.db
    if (!db.pendingReplace || typeof db.pendingReplace !== 'object' || Array.isArray(db.pendingReplace)) db.pendingReplace = {}
    db.pendingReplace[this._pendingReplaceKey(eid)] = { lxId: String(lxId), platformId: platformId || null, at: Date.now() }
    this.store.saveDb()
  }
  _clearPendingReplace(eid, lxId) {
    const db = this.store.db
    const pr = db.pendingReplace
    if (!pr || typeof pr !== 'object') return
    const k = this._pendingReplaceKey(eid)
    const hit = pr[k]
    if (!hit) return
    // 指定 lxId 时只在匹配时清（避免把「本轮新发起的另一次替换」误清掉）
    if (lxId != null && String(hit.lxId) !== String(lxId)) return
    delete pr[k]
    this.store.saveDb()
  }
  /** eid → 自己删掉、尚未装回的 lxId 集合（供冻结表豁免）；顺带清掉超时项 */
  _pendingLxIdMap(now) {
    const db = this.store.db
    const pr = db.pendingReplace
    if (!pr || typeof pr !== 'object') return new Map()
    const MAX_AGE = 30 * 60 * 1000   // 30 分钟：远大于任何一次灌入，超时即视为异常残留
    const t = now || Date.now()
    const map = new Map()
    let changed = false
    for (const [eid, hit] of Object.entries(pr)) {
      if (!hit || hit.lxId == null || !Number.isFinite(hit.at) || t - hit.at > MAX_AGE) {
        delete pr[eid]; changed = true; continue
      }
      let s = map.get(eid)
      if (!s) { s = new Set(); map.set(eid, s) }
      s.add(String(hit.lxId))
    }
    if (changed) this.store.saveDb()
    return map
  }

  async _refreshServerVeto(plans, activeId) {
    const db = this.store.db
    const prev = db.veto && typeof db.veto === 'object' ? db.veto : {}
    const merged = {}
    let sawList = false
    const pendingLxIds = this._pendingLxIdMap(Date.now())

    for (const p of plans) {
      if (!p || !p.svc || !Array.isArray(p.serverList)) continue
      sawList = true
      let isolatedIds = []
      try { isolatedIds = await getIsolations(p.svc) } catch (e) { isolatedIds = [] }
      const r = computeVeto({
        imported: this.store.imported || {},
        sources: db.sources || {},
        serverList: p.serverList,
        platformId: p.svc.acct.id || activeId,
        activePlatformId: activeId,
        prev,
        isolatedIds,
        pendingLxIds,
        now: Date.now()
      })
      for (const [eid, v] of Object.entries(r.veto)) {
        const cur = merged[eid]
        if (!cur || (VETO_PRIORITY[v.type] || 0) > (VETO_PRIORITY[cur.type] || 0)) merged[eid] = v
      }
    }

    // 一个账号的列表都没读到 → 保持原样，绝不把「读不到」当成「全被删了」
    if (!sawList) {
      this.log('服务端音源列表未读到，本轮跳过「服务端处置」冻结刷新（冻结表保持不变）', '灌入', 'warn')
      return { added: 0, updated: 0, cleared: 0, total: Object.keys(prev).length }
    }

    const next = {}
    for (const [eid, v] of Object.entries(merged)) {
      const old = prev[eid]
      next[eid] = old ? Object.assign({}, v, { since: old.since || v.since }) : v
    }

    let added = 0
    let updated = 0
    let cleared = 0
    for (const eid of Object.keys(next)) {
      const o = prev[eid]
      if (!o) added++
      else if (o.type !== next[eid].type || o.sha !== next[eid].sha) updated++
    }
    for (const eid of Object.keys(prev)) if (!next[eid]) cleared++

    // v1.14.2 性能修复：只在冻结表真正变化时落盘。
    // 旧写法无条件 saveDb()：巡检收尾/灌入每次都把整份 data/sources.json（生产 36MB 级）
    // 全量重写一遍，即使 veto 完全没变（computeVeto 每轮都会刷新条目的 at 字段，但那只是
    // 诊断时间戳，不是需要持久化的业务变化）——这是真正的长期写放大（每天约 96 轮）。
    // added/updated/cleared 在上方已按 type/sha 算好，直接复用；只有在冻结条目新增、
    // 变更（type/sha 变）或解除时才写盘。db.veto 内存始终更新为 next（含刷新后的 at/since），
    // 否则下次以 prev 为基准比对会错、水位/状态基准也会漂移。
    const changed = added || updated || cleared
    db.veto = next
    if (changed) this.store.saveDb()

    if (added || updated) {
      const names = Object.keys(next)
        .filter(eid => !prev[eid] || prev[eid].type !== next[eid].type)
        .slice(0, 5)
        .map(eid => (db.sources[eid] && (db.sources[eid].lxName || db.sources[eid].name)) || eid)
      this.log(`服务端处置冻结：新增/变更 ${added + updated} 条（${names.join('、')}${Object.keys(next).length > 5 ? ' 等' : ''}），` +
        '这些音源在内容更新前不会再被灌入', '灌入', 'warn')
    }
    if (cleared) this.log(`服务端处置冻结：解除 ${cleared} 条（音源已更新或服务端已恢复）`, '灌入')
    return { added, updated, cleared, total: Object.keys(next).length }
  }

  /**
   * 「未知源」冻结的短周期复查（v1.14.1，2026-11-24）。
   *
   * 为什么单独做：db.veto 里的 five 类冻结中，removed/disabled/isolated/platform-disabled
   * 都是**用户（或服务端巡检）主动处置**的结果，24h 不变是合理的 —— 用户意图不会自己变。
   * 唯独 unloaded（服务端试运行加载失败、一个平台都没注册出来）的成因在**服务端侧**，
   * 用户去服务端点一次「允许原生 VM」/ 服务端重载一次，它就自愈了。
   *
   * 实测缺陷（2026-11-24 复盘）：豆包 v9.1.0 的 unloaded 冻结写入于 12:27:31，
   * 17950 在 12:44:36 就加载成功（5 平台），但 hunter 侧下一次刷新冻结表要等
   * 「灌入」或「巡检收尾」—— 巡检间隔 24h，于是界面一直顶着红色「未知源·冻结」，
   * 灌入按钮点了也是 skip。重算逻辑（computeVeto）本身是对的，缺的只是触发时机。
   *
   * 设计约束（每一条都是为了不误伤）：
   *  1. **只在真有 unloaded 时才发请求**：没有就立刻返回 {skipped:true}，零 HTTP。
   *  2. **只做减法，绝不整体替换 db.veto**：这里只拉「当前选中账号」的列表，
   *     若沿用 _refreshServerVeto 的整体替换语义，会把其它账号的冻结记录误清（那些账号
   *     这轮根本没读列表）。所以按 eid 精确改：服务端不再 failed+[] → 删掉这条；
   *     其它情况（仍失败 / 已变成 removed 等）→ 保持原样，交给常规刷新。
   *  3. **不碰 removed/disabled/isolated**：只处理 type==='unloaded' 的条目，其它一律跳过。
   *  4. **不写 lastPatrol、不改巡检水位**：这是核对不是巡检，不参与「多久巡检一次」的账。
   *  5. 服务端列表读不到 → 直接返回，绝不当成「恢复了」。
   *
   * @returns {{checked:number, cleared:number, kept:number, names:string[], healthy:boolean}}
   */
  async refreshUnloadedVeto() {
    const db = this.store.db
    const veto = db.veto && typeof db.veto === 'object' ? db.veto : {}
    // v1.14.2：两种「服务端侧可自愈」的冻结一起复查，共用同一趟 list 请求（不增加请求数）：
    //   unloaded   —— 服务端加载不出任何平台，加白/修脚本后自愈
    //   vm-blocked —— 服务端因需要原生 VM 回滚了启用，加白并启用后自愈
    const unloadedEids = Object.keys(veto).filter(eid => {
      const v = veto[eid]
      return v && (v.type === VETO_TYPES.UNLOADED || v.type === VETO_TYPES.VM_BLOCKED) && !v.partial
    })
    // ① 没有这两类 → 一个请求都不发（这条是「零额外开销」的关键）
    if (!unloadedEids.length) return { checked: 0, cleared: 0, kept: 0, names: [], healthy: true }

    // 任务在跑（灌入/巡检/采集）时不抢：那几条链路自己会在收尾刷冻结表，
    // 这里再拉一次只会多一个并发请求，还可能读到半途状态。
    if (this.job && this.job.running) return { checked: 0, cleared: 0, kept: unloadedEids.length, names: [], healthy: false }

    let svc
    try { svc = this._active() } catch (e) {
      return { checked: 0, cleared: 0, kept: unloadedEids.length, names: [], healthy: false }
    }
    let serverList = null
    try { serverList = await svc.adapter.list(svc.acct) } catch (e) {
      this.log(`服务端处置自动复查：读取服务端列表失败（${String((e && e.message) || e).slice(0, 80)}），本轮跳过（冻结表保持不变）`, '灌入', 'warn')
      return { checked: 0, cleared: 0, kept: unloadedEids.length, names: [], healthy: false }
    }
    // ⑤ 读不到 / 读到空 → 不猜（空列表在服务端认证异常时也会出现，见 runPatrol 的空列表安全阀）
    if (!Array.isArray(serverList) || !serverList.length) return { checked: 0, cleared: 0, kept: unloadedEids.length, names: [], healthy: false }

    const pid = svc.acct && svc.acct.id
    const activeId = (this.store.config && this.store.config.activePlatformId) || pid
    const byId = new Map()
    for (const s of serverList) if (s && s.id != null) byId.set(String(s.id), s)

    const clearedNames = []
    let kept = 0
    let changed = false
    for (const eid of unloadedEids) {
      const v = veto[eid]
      const rec = this.store.imported && this.store.imported[eid]
      const e = db.sources && db.sources[eid]
      // 条目/账本已没了 → 冻结无意义，顺手清掉（与 computeVeto 的 `if (!e) continue` 同口径）。
      // 也计入 cleared 并记日志：静默消失会让用户以为「冻结自己好了」，实际是本地条目被删过。
      if (!rec || !e) {
        delete veto[eid]; changed = true
        clearedNames.push(e ? this._vetoName(e) : (v.lxId ? String(v.lxId).replace(/\.js$/, '') : '未知条目'))
        continue
      }
      // ③ 只处理确实落在当前账号上的记录（别的账号这个 lxId 不适用，这轮也没读它的列表）
      const lxId = recLxIdOn(rec, pid, activeId)
      if (lxId == null) { kept++; continue }
      // 内容变了 → 上游发了新版，旧结论作废（与 computeVeto:101 同口径，兜一层）
      const sha = e.contentHash || ''
      if (v.sha && sha && v.sha !== sha) { delete veto[eid]; changed = true; clearedNames.push(this._vetoName(e)); continue }

      const srv = byId.get(String(lxId))
      if (!srv) { kept++; continue }   // 列表里没有这条 → 可能是被删了，交给常规刷新判 removed，这里不动
      // ② 按类型分流判定（v1.14.2）。两类判据刻意不同，**绝不能混用**：
      if (v.type === VETO_TYPES.VM_BLOCKED) {
        // vm-blocked 只认「服务端确实把它启用了」。回滚后这条**没有 status 字段**，
        // 若照搬下面 unloaded 的 failed+[] 判据，status===undefined 会让 stillUnloaded
        // 恒为 false → 首个 tick 就把整类误解冻（这正是绝不复用 UNLOADED 的原因）。
        if (srv.enabled !== true) { kept++; continue }
        delete veto[eid]
        changed = true
        clearedNames.push(this._vetoName(e))
        continue
      }
      // unloaded：只要不再是 failed+[] 就说明它加载出了平台
      const stillUnloaded = srv.status === 'failed' &&
        Array.isArray(srv.supportedSources) && srv.supportedSources.length === 0
      if (stillUnloaded) { kept++; continue }
      delete veto[eid]
      changed = true
      clearedNames.push(this._vetoName(e))
    }

    if (changed) { db.veto = veto; this.store.saveDb() }
    if (clearedNames.length) {
      this.log(`服务端处置自动复查：服务端已恢复，解除冻结 ${clearedNames.length} 条（${clearedNames.slice(0, 5).join('、')}` +
        `${clearedNames.length > 5 ? ' 等' : ''}）；这些音源现在可以正常灌入了`, '灌入')
    }
    return { checked: unloadedEids.length, cleared: clearedNames.length, kept, names: clearedNames, healthy: true }
  }

  /** 冻结条目的显示名（日志用，取不到就退回 eid） */
  _vetoName(e) {
    if (!e) return '未知条目'
    return e.scriptName || e.lxName || e.name || e.id || '未知条目'
  }

  /**
   * 账本对账（v1.8.0）：把「本地记着灌过某账号、但该账号服务端上已经不存在」的记录摘掉。
   *
   * 为什么必须做：本地账本一旦和服务端脱节（用户手动删源、换账号、服务端重置），
   * 「已灌入」的标记会一直挂着 —— 音源库里标着已灌入，「只选未灌入 / 检测并灌入」就会把它
   * 整体排除，用户重灌时什么都灌不进去（实测反馈）。对账后标记必然跟着服务端走。
   *
   * 只做减法（服务端为准，加法由灌入/同步服务端负责），而且**只在列表确实读到、
   * liveIds 是真实结果时才调用** —— 读列表失败时调用会把整库记录误删，由调用方把关。
   *
   * @param {string} platformId 账号 id
   * @param {string[]} liveIds 该账号服务端此刻真实存在的音源 id
   * @returns {{changed:boolean, dropped:number, imported:object}}
   */
  reconcileImported(platformId, liveIds) {
    const cfg = this.store.config || {}
    const pid = platformId || cfg.activePlatformId
    const out = { changed: false, dropped: 0, imported: this.store.imported || {} }
    if (!pid || !Array.isArray(liveIds)) return out
    const live = new Set(liveIds.filter(x => x != null).map(String))
    const drop = []
    for (const [eid, rec] of Object.entries(this.store.imported || {})) {
      if (!rec || !this._recBelongs(rec, pid, cfg.activePlatformId)) continue
      const lxId = this._recLxIdOn(rec, pid, cfg.activePlatformId)
      if (lxId == null) continue        // 记录里没有服务端 id（老数据）→ 无从对账，留着
      if (!live.has(String(lxId))) drop.push(eid)
    }
    for (const eid of drop) { this._dropPlatformFromImported(eid, pid); out.dropped++ }
    if (out.dropped) {
      this.store.saveImported()
      out.changed = true
      out.imported = this.store.imported
    }
    return out
  }

  /** 该记录在指定账号上有没有一份（v1.8.0 前的老记录 platformId 为空 → 归当前选中账号） */
  _recBelongs(rec, pid, activeId) {
    if (!rec) return false
    if (Array.isArray(rec.importedTo) && rec.importedTo.some(x => x && x.platformId === pid)) return true
    const top = rec.platformId == null ? activeId : rec.platformId
    return top === pid
  }

  /** 该记录在指定账号上那份的服务端 id（importedTo 优先，退回顶层）；null 表示没有/无 id */
  _recLxIdOn(rec, pid, activeId) {
    if (!rec) return null
    const to = Array.isArray(rec.importedTo) ? rec.importedTo.find(x => x && x.platformId === pid) : null
    if (to) return to.lxId == null ? null : to.lxId
    const top = rec.platformId == null ? activeId : rec.platformId
    return top === pid ? (rec.lxId == null ? null : rec.lxId) : null
  }

  /**
   * 「服务端条目 id → 本地打分快照」。同名裁决时把快照回放成 srv.qualityProxy，
   * 让服务端侧也能有实测证据（否则服务端 list 只有声明值，第三层音质永远比不了）。
   * 只认 30 天内的快照：太久远的实测不能代表现在（音源接口随时会变资质/限流）。
   */
  _scoreByServerId(platformId, activeId, serverList) {
    const MAX_AGE_MS = 30 * 24 * 3600 * 1000
    const out = {}
    // 服务端条目 id → 字节数：用来校验本地正文副本是否还对应服务端那条
    const sizeById = {}
    for (const s of (serverList || [])) if (s && s.id != null) sizeById[s.id] = Number(s.size) || 0
    for (const rec of Object.values(this.store.imported || {})) {
      if (!rec || !rec.score || !rec.score.metrics) continue
      const pid = rec.platformId == null ? activeId : rec.platformId
      const hit = pid === platformId ||
        (Array.isArray(rec.importedTo) && rec.importedTo.some(x => x && x.platformId === platformId && x.lxId != null))
      if (!hit) continue
      const ids = []
      if (rec.lxId != null) ids.push(rec.lxId)
      for (const x of (Array.isArray(rec.importedTo) ? rec.importedTo : [])) {
        if (x && x.platformId === platformId && x.lxId != null) ids.push(x.lxId)
      }
      const at = Number(rec.score.at) || 0
      const stale = !at || (Date.now() - at > MAX_AGE_MS)
      // 本地副本字节数 vs 服务端当前字节数：不一致说明服务端那条已被换过
      // （网页端手工改、别的工具灌过），这份快照描述的不是它 → 不给证据。
      // 任一侧取不到（0）就不判，避免因数据缺失误伤。
      const localSize = this.store.scriptSize ? this.store.scriptSize(rec.contentHash) : 0
      for (const id of ids) {
        const srvSize = sizeById[id] || 0
        const mismatch = localSize > 0 && srvSize > 0 && localSize !== srvSize
        out[id] = (stale || mismatch) ? { stale: true } : {
          checkedAt: rec.score.checkedAt || at,
          platforms: rec.score.platforms || {},
          metrics: rec.score.metrics
        }
      }
    }
    return out
  }

  /**
   * 「本地条目 id → 上次灌入时的正文 hash」账本。
   *
   * 为什么需要它：`srv.hash` 与 `srv.script` 在 lxserver/Songloft 上**恒为空**
   * （17950 实测 38 条全无 hash、无正文），于是同名判定只剩 `srv.size` 这一条弱证据：
   * 版本号相同时（作者改了 bug 没升版本），只要字节长度没变就会被判 `synced`，
   * 「留新删旧」直接卡死 —— 2026-11-10 在 17960 上真实复现过（v1.0.0→v1.1.0 等长）。
   *
   * 账本记的是「这份正文当初确实灌进去了」，所以：
   *   账本 hash == 本地 hash  → 真的没变（强证据，比 size 可靠）
   *   账本 hash != 本地 hash  → 内容变了（强证据，必须让 size 判据失效）
   * 只有在 `e.id` 不变时才能命中 —— 这点不是缺陷而是互补：
   * 改了 @name（带版本号）的更新必然换 id，那条路已由版本号比较覆盖。
   *
   * 已知残留风险：若用户在网页端手工改过脚本且 id 未变，账本会误判「没变」。
   * 这种情况服务端不回任何内容字段，任何本地算法都无从察觉；概率低且不会造成数据丢失
   * （后果只是「这次没重灌」，下次深检内容再变时 hash 不同就会正常更新）。
   */
  _ledgerByEntry(platformId, activeId) {
    const out = {}
    for (const [eid, rec] of Object.entries(this.store.imported || {})) {
      if (!rec || !rec.contentHash) continue
      const pid = rec.platformId == null ? activeId : rec.platformId
      const hit = pid === platformId ||
        (Array.isArray(rec.importedTo) && rec.importedTo.some(x => x && x.platformId === platformId && x.lxId != null))
      if (!hit) continue
      // v1.13.9（A 案）：必须按**平台**取 lxId，不能直取顶层 rec.lxId。
      // 上面 hit 已经允许「靠 importedTo 命中平台」，此时顶层 rec.lxId 属于另一个平台，
      // 账本会因此带着别的平台的 id 去做强证据对账 ⇒ 多账号下强证据静默失效。
      // 取不到本平台 id 就**不入账本**：宁可退回 size 弱判据（保守方向），
      // 也不要用错平台的 id 去「证明」内容没变。
      const lxId = this._recLxIdOn(rec, platformId, activeId)
      if (lxId == null) continue
      out[eid] = { hash: rec.contentHash, lxId, name: rec.name || '' }
    }
    return out
  }

  /**
   * 某平台账号「已灌入过的内容」指纹表（用于跨批次去重）。
   * 多平台下必须按账号过滤：只灌过 A 的源，灌 B 时不该被判为「已灌入」而跳过。
   * 老记录（platformId 为 null，v1.8.0 之前）归入当前选中账号。
   *
   * 返回 hash → { name, lxId, sourceId }。带 lxId 是必需的：光有指纹无法判断
   * 服务端上那条还在不在（用户可能已在网页端手动删过），见 _planImportQueue。
   */
  _importedRecsFor(platformId, activeId) {
    const out = {}
    for (const [eid, rec] of Object.entries(this.store.imported || {})) {
      if (!rec || !rec.contentHash) continue
      const pid = rec.platformId == null ? activeId : rec.platformId
      const hit = pid === platformId ||
        (Array.isArray(rec.importedTo) && rec.importedTo.some(x => x && x.platformId === platformId))
      if (!hit) continue
      // 同一份内容可能对应多条记录：优先保留「服务端上还真的有」的那条
      const prev = out[rec.contentHash]
      out[rec.contentHash] = prev || { name: rec.name || eid, lxId: rec.lxId || null, sourceId: eid }
    }
    return out
  }

  /**
   * 同名音源的裁决规则（纯函数，v1.8.0 抽出；2026-11-10 按用户 1/2/3 口径重排）。
   *
   * 先明确一件事：**「已灌入」不是一个终态，而是「本地账本」**。用户会在网页端手动删源、
   * 会换内容重新发布、会遇到两个不同作者用了同一个名字。所以本地记录只能用来「提示」，
   * 不能用来「拦」，真正的依据必须是服务端此刻的实际列表（见 _planImportQueue 传入的 serverIds）。
   *
   * 用户 21:01 拍板的三条口径：
   *  1) 不同名 → 直接灌入（本函数只处理同名）
   *  2) 同名 + 同仓库 + 版本有别 → 留新删旧（版本高的赢）；但本地实测 0 平台、
   *     或可用平台少于服务端声明时不做「质量降级式」替换
   *  3) 同名 + 不同仓库 → 由 lx-hunter 实测质量裁决（见 quality.js）：明显更优才
   *     留优删差，平手 / 证据不足一律不删，改名并存
   *
   * 关键取舍：只有**两边都能拿出仓库同源键**时才分流到 2/3。17950 实测 38 条里
   * homepage 非空仅 11 条，缺证据时一律沿用 v1.7.0 的保守旧规则，绝不猜仓库归属。
   *
   * 判定顺序（越靠前越硬）：
   *  1. 同名同内容（hash / 字节长度）  → synced
   *  2. 本地实测 0 个可用平台          → skip（绝不越换越差）
   *  2.5 同源证据齐备                  → 按口径 2 / 3 分流
   *  3. 服务端声明平台数 > 本地实测    → skip（仅无同源证据时的旧保护）
   *  4. 两边版本号都可解析            → 高的赢（仅无同源证据时）
   *  5. 平台零交集 → rename；有交集 → replace（跨仓库撞名保护）
   *  6. 信息不足   → 按设置（默认 replace，关掉则 rename）
   *
   * @returns {{act:'synced'|'skip'|'replace'|'rename', why:string}}
   */
  sameNameVerdict(e, srv, code, cfg, opt) {
    const c = cfg || {}
    const led = (opt && opt.ledger) || null
    const nameForCmp = e.scriptName || e.lxName || e.name
    // 版本取值：作者声明的 @version 优先，名字里的版本号兜底（2026-11-11）。
    // 服务端 `list` 会回传 version 字段（17960 实测 `{"version":"v1.0.0"}`），
    // 只读名字的话，「@name 固定、只升 @version」的源两边都取不到版本 →
    // 版本比较整条路径失效，落到第 5 条「同名 + 平台重叠 → replace」，
    // 本地旧版会把服务端新版覆盖掉（纯降级）。
    // 版本文案只显示版本号本身（`verLabel`）：兜底取名字时拿到的是整串
    // 「LXHE2E 测试源 v1.0.0」，拼进理由会变成「v1.1.0 ≥ LXHE2E 测试源 v1.0.0」。
    // 比较口径不受影响（versionKey / cmpVersion 都是整串 match 版本号）。
    const localVer = verLabel(e.scriptVersion || nameForCmp)
    const srvVer = verLabel(srv.version || srv.name)
    // 1) 同名同内容 → 服务端就是它，标记已灌入即可，不重传。
    //    精确证据：内容 sha256 / 服务端回传的脚本正文全文。
    //    弱证据：字节长度相同 —— 只在「版本号不可比或版本相同」时才允许采信。
    //    2026-11-10 17960 实机：v1.0.0 → v1.1.0 只改了等长字符，服务端又不回传
    //    hash / 正文（17950 实测 38 条中均为 0），靠 size 判 synced 会把用户口径 2
    //    的「留新删旧」直接卡死。等长不等于同内容，版本号明确不同时强证据优先。
    const sameHash = !!(e.contentHash && srv.hash && e.contentHash === srv.hash)
    const srvCode = srv.script || srv.code || ''
    const sameCode = !!(code && srvCode && String(code) === String(srvCode))
    const sameSize = !!(code && srv.size && Buffer.byteLength(code, 'utf-8') === srv.size)
    const versionConflict = !!(versionNum(localVer) && versionNum(srvVer) &&
                               cmpVersion(localVer, srvVer) !== 0)
    // 本地账本（上次真正灌进去的那份正文 hash）——服务端不回 hash/正文时唯一可靠的强证据。
    //   相等 → 内容确实没变；不等 → 内容确实变了，此时 size 判据必须失效（等长改动）
    // `ledSame` 额外要求「服务端这条就是我们当初灌的那条」（lxId 对得上）：
    // 用户手工在网页端加过同名脚本时 srv.id 会变，这时不能凭账本断定「服务端已有同内容」。
    const ledHash = (led && led.hash) || ''
    const ledIdOk = !!(led && (led.lxId == null || srv.id == null || String(led.lxId) === String(srv.id)))
    // 服务端能自证（回传 hash）时以服务端为准：账本只反映「我们上次灌了什么」，
    // 没法知道别人后来有没有在网页端改过。服务端没 hash 才让账本说话。
    // 还要排除「版本号对不上」：账本说上次灌的是这份内容，服务端显示的却是另一个版本号，
    // 说明服务端那条已被换过（或账本对应的不是它），此时不能凭账本断言「已同步」。
    const ledSame = !!(ledHash && e.contentHash && ledHash === e.contentHash &&
                       ledIdOk && !srv.hash && !versionConflict)
    const ledChanged = !!(ledHash && e.contentHash && ledHash !== e.contentHash)
    // 账本存在但指向的服务端条目已不存在/已被换掉（lxId 对不上）时，
    // 也不能用 size 兜底判「已同步」——那条已经不是我们灌的了。
    const ledForeign = !!(led && !ledIdOk)
    // 账本在、但本地这次没算出 hash（下载异常/未计算）→ 无法确认内容是否相同。
    // 此时也不能用 size 兜底判 synced：字节数一样不代表内容是同一份。
    const ledNoLocalHash = !!(led && ledHash && !e.contentHash)
    if (sameHash || sameCode || ledSame ||
        (!ledChanged && !ledForeign && !ledNoLocalHash && !srv.hash && !srvCode && sameSize && !versionConflict)) {
      return {
        act: 'synced',
        why: ledSame && !sameHash && !sameCode
          ? '同名同内容（本地账本 hash 一致），服务端已有（未重复上传）'
          : '同名同内容，服务端已有（未重复上传）'
      }
    }

    const checked = !!(e.deep && e.deep.checkedAt) && !e.stale
    // A（2026-11-23 Q2）：服务端"声明平台数"必须扣掉 disabledSources 才是有效平台。
    // 集合相减（大小写归一 + 去重），不是 length 相减：声明 5 禁 1 才是 4；全禁为 0。
    const srvDeclared = Array.isArray(srv.supportedSources) ? srv.supportedSources.slice() : []
    const srvOff = Array.isArray(srv.disabledSources) ? srv.disabledSources.slice() : []
    const offSet = new Set(srvOff.filter(Boolean).map(p => String(p).toLowerCase()))
    const seenPlat = new Set()
    const srvPlats = srvDeclared.filter(p => {
      const k = String(p == null ? '' : p).toLowerCase()
      if (!k || seenPlat.has(k)) return false
      seenPlat.add(k)
      return !offSet.has(k)
    })
    const srvN = srvPlats.length
    const declaredN = new Set(srvDeclared.filter(Boolean).map(p => String(p).toLowerCase())).size
    // 全禁用 carve-out：声明过平台、但有效平台为 0 且全部被禁 → 用户主动停用，维持冻结/skip，
    // 不能被"本地实测更多"翻案覆盖用户治理（含 enableAfterImport 豁免交给 serverVeto/skip 口径）。
    const srvAllDisabled = declaredN > 0 && srvN === 0 && offSet.size > 0 &&
      srvDeclared.length > 0 && srvDeclared.every(p => offSet.has(String(p == null ? '' : p).toLowerCase()))
    // C（2026-11-23）治理信号：都是服务端 list 已返回 / serverVeto 已算好的字段，零新增请求。
    //   after-import 停用豁免（disableReason==='after-import'）不算用户冻结（computeVeto 已豁免）；
    //   只有"全禁用 / 隔离 / 整源禁用 / 加载失败零平台"才是真冻结；候选 regression/veto 在队列层 splitFrozen 跳过。
    const srvGoverned = !!(srvAllDisabled || srv.enabled === false || srv.isolated ||
      (srv.status === 'failed' && srvDeclared.length === 0))
    const newN = checked ? usableCount(e) : -1
    const localPlats = checked ? usableKeys(e) : []

    // 2) 本地实测全挂 → 绝不替换（v1.7.0 起就这么定：本地挂掉不代表服务端不能用，
    //    把服务端能用的源换成本地实测不可用的，是纯损失）。stale 的旧结论不作数。
    if (checked && newN === 0) {
      return { act: 'skip', why: '本地实测 0 个可用平台 → 不替换（保留服务端现条目，避免越换越差）' }
    }

    // A carve-out：服务端声明过平台但全被用户禁用 → 视为主动停用，维持 skip（不覆盖治理）
    if (srvAllDisabled) {
      return { act: 'skip', why: `服务端声明 ${declaredN} 个平台但已全部禁用 → 视为用户主动停用，保留服务端（不覆盖治理）` }
    }
    // C（2026-11-23）治理保护：服务端源处于"整源禁用 / 隔离 / 全平台禁用 / 加载失败零平台"时，
    // 一律维持 skip，不让它被本地同名裁决 replace 掉（删源会覆盖用户的禁用/隔离治理）。
    // after-import 停用豁免——那是灌入落库时的默认停用，不是用户意图（与 serverVeto 同口径）。
    if (srvGoverned && srv.disableReason !== 'after-import') {
      return { act: 'skip', why: '服务端源处于治理冻结态（整源禁用/隔离/全平台禁用/加载失败）→ 保留服务端，不覆盖用户治理' }
    }

    // 2.5) 用户口径 2/3：同源代码齐备才分流；缺证据不猜，落到下面的旧规则
    const ck = candidateRepo(e), sk = serverRepo(srv)
    const provenSame = !!(ck && sk && ck === sk)
    const provenDifferent = !!(ck && sk && ck !== sk)
    const lv = versionNum(localVer), sv = versionNum(srvVer)
    const vc = cmpVersion(localVer, srvVer)
    // 服务端 list 不回传脚本正文/deep（17950 实测 38 条全无），因此默认没有实测证据。
    // 若调用方注入了 lx-hunter 本地留存的质量代理（srv.qualityProxy = 旧版脚本的 deep），
    // 综合评分才真正参与；否则明确降级为分层硬判据，绝不假装两边都测过。
    const srvDeep = srv.deep || srv.qualityProxy || null
    const qTarget = srvDeep ? Object.assign({}, srv, { deep: srvDeep }) : srv
    const srvQualitySrc = srvDeep ? '服务端侧证据来自 lx-hunter 本地质量代理' : '服务端侧无实测证据（分层回落）'
    // 「未测」≠「不支持」：untested/pending 才是真没跑过；skipped 是脚本压根没注册该平台，
    // 属于已知事实而非证据缺口，不能算进来，否则几乎所有源都会被判成「证据不足」。
    const deepPlats = (e.deep && e.deep.platforms) || {}
    const untestedN = Object.values(deepPlats).filter(p => {
      const st = String((p || {}).status || '')
      return st === 'untested' || st === 'pending'
    }).length

    // 2.4) 版本号相同但**内容确实变了**（本地账本强证据）→ 本地这份是后抓到的更新。
    //      版本号分不出新旧时，账本可以：服务端那份正是我们上次灌进去的旧正文，
    //      现在本地 hash 不同 ⇒ 作者改了东西（常见于「修了 bug 没升版本号」）。
    //      没有这条的话，等长改动会被判 synced 卡死（v1.0.0→v1.1.0 只在 17960 复现过），
    //      不等长的改动会被判 skip 卡住（版本相同 → 保留服务端），两种都更新不了。
    // `!ledForeign`：账本指向的服务端条目已被换掉时，账本描述的不是眼前这条，
    // 拿它当「内容变了」的依据去删服务端现存条目，等于删别人加的东西 —— 不做。
    if (ledChanged && !ledForeign && lv && sv && vc === 0) {
      if (!checked || newN <= 0) {
        return { act: 'skip', why: '同名同版本但内容已变（本地账本 hash 与本地正文不一致），本地尚未实测出可用平台 → 先保留服务端，做完深度检测再更新' }
      }
      if (srvN > 0 && newN < srvN) {
        return { act: 'skip', why: `同名同版本但内容已变，本地可用平台更少（${newN} < ${srvN}）→ 不做降级替换` }
      }
      return { act: 'replace', why: `同名同版本但内容已更新（账本记的是上次灌入的旧正文，本地正文 hash 已变）→ 留新删旧` }
    }

    if (provenSame && lv && sv) {
      if (vc > 0) {
        // 2026-11-18 用户拍板（覆盖 11-11「版本唯一理由」）：同仓库同名也**不许拿版本高当
        // 删源理由**。删源不可逆，必须双方有实质质量证据、且本地确实更优才留新删旧；
        // 证据不足 / 打平一律不删，改名并存（与跨仓 rename 保护口径统一），提示做全平台深检。
        // 质量维度沿用 compareVerdict 的字典序：可用平台数 → p50 延迟 → 最高可播音质档。
        if (srvDeep) {
          const qd = compareVerdict(e, qTarget)
          if (qd.cmp < 0) {
            return { act: 'skip', why: `同仓库同名且本地版本更高，但质量更差（${qd.reason}）→ 不做质量降级替换` }
          }
          if (qd.cmp > 0) {
            return { act: 'replace', why: `同仓库同名，本地版本更高（${localVer} > ${srvVer}）且质量更优（${qd.reason}）→ 留新删旧（删旧装新）` }
          }
          // cmp===0 分两种：
          //  - tie（双方证据充分、质量实质相当）：沿用既有「同源以版本为准，留新删旧」；
          //  - insufficient（证据不足、无法质量比较）：用户 2026-11-18 口径——含糊不删，
          //    改名并存，保留质量好的服务端源（核心 F1 修复点）。
          if (qd.by === 'insufficient') {
            return { act: 'rename', why: `同仓库同名，本地版本虽更高（${localVer} > ${srvVer}），但质量证据不足、无法比较优劣（${qd.reason}）→ 不按版本删源，改名并存（请做全平台深度检测后再裁决）` }
          }
          const tail = `质量相当（可用平台数同为 ${newN} 个，延迟与音质档无显著差异）`
          return { act: 'replace', why: `同仓库同名，本地版本更高（${localVer} > ${srvVer}），${tail} → 同源以版本为准，留新删旧（删旧装新）` }
        }
        // 服务端侧没有质量快照可比（老账本/未深检）：沿用既有平台数保护口径，不扩大本次改动范围。
        if (srvN > 0 && newN >= 0 && newN < srvN) {
          return { act: 'skip', why: `同仓库同名但本地可用平台少于服务端声明（${newN} < ${srvN}；${srvQualitySrc}）→ 不做质量降级替换（口径 2 要求质量不劣）` }
        }
        return { act: 'replace', why: `同仓库同名，本地版本更高（${localVer} > ${srvVer}；${srvQualitySrc}）→ 留新删旧（删旧装新）` }
      }
      return { act: 'skip', why: `同仓库同名，服务端版本不低于本地（${srvVer} ≥ ${localVer}）→ 保留服务端` }
    }
    if (provenDifferent) {
      // 22:21 审计：跨仓库「留优删差」是要删服务端条目的不可逆操作，
      // 必须双方证据齐备。未实测 / 快速模式留下 untested 平台时，综合分只由
      // 「平台数 + 音质档」凑出来（覆盖度 0.6 也能过门槛），拿它删源不科学。
      // 这类情况一律改名并存并提示全平台重测，绝不 replace/skip 掉任何一方。
      if (!checked || untestedN > 0) {
        return {
          act: 'rename',
          why: `跨仓库同名但本地证据不足（${!checked ? '未实测/未做深检' : untestedN + ' 个平台未实测（快速模式）'}）→ 不按综合评分删任何一方，改名并存（请先做全平台检测）`
        }
      }
      // 平台完全不重叠 ⇒ 名字撞了而已，是两个无关脚本。不管版本/质量都不删。
      const overlapX = srvPlats.filter(p => localPlats.indexOf(p) >= 0)
      if (srvPlats.length && localPlats.length && !overlapX.length) {
        return {
          act: 'rename',
          why: `跨仓库同名但平台完全不重叠（服务端 ${srvPlats.join('/')} vs 本地 ${localPlats.join('/')}）→ 视作无关脚本，改名并存（不删旧的）`
        }
      }

      // 版本优先于质量（2026-11-11 用户拍板）：大量仓库本来就是同一份源被多处转发，
      // 仓库地址不同不足以证明它不是同一个源。只要本地版本**明确更高**且质量不劣，就可以换。
      // 但「版本高」不是删源的唯一理由 —— 质量关必须同时过，否则保留服务端旧版。
      if (lv && sv && vc > 0) {
        if (srvDeep) {
          const qd = compareVerdict(e, qTarget)
          // 用户口径（2026-11-11）：「必须高于」才替换 —— 平手也算未通过，保留服务端。
          if (qd.cmp <= 0) {
            return { act: 'skip', why: `跨仓库同名，本地版本更高（${localVer} > ${srvVer}）但质量未更优（${qd.by}：${qd.reason}）→ 保留服务端（口径要求质量必须更优）` }
          }
          return { act: 'replace', why: `跨仓库同名，本地版本更高（${localVer} > ${srvVer}）且质量更优（${qd.by}：${qd.reason}）→ 留新删旧（删旧装新）` }
        }
        // B（2026-11-23）：服务端侧没有实测证据时，声明平台数不能当实测证据去压本地、
        //    也不能凭"本地实测 > 服务端声明"就 replace（声明天然偏小/偏大都不可靠）。
        //    一律 rename 并存（不删服务端源、不跳过本地），理由注明"服务端仅声明，待人工"。
        if (srvN <= 0) {
          return { act: 'rename', why: `跨仓库同名，本地版本更高（${localVer} > ${srvVer}）但服务端没有声明任何平台，无从判断质量是否更优 → 不删旧的，改名并存` }
        }
        return { act: 'rename', why: `跨仓库同名，服务端仅有声明平台数 ${srvN}（无实测证据），本地实测 ${newN} 个 → 声明不能当实测裁决，改名并存（不删服务端源，待人工）` }
      }
      if (lv && sv && vc < 0) {
        return { act: 'skip', why: `跨仓库同名，服务端版本更高（${srvVer} > ${localVer}）→ 保留服务端` }
      }

      const vd = compareVerdict(e, qTarget)
      const note = `本地 [${vd.aDesc}] vs 服务端 [${vd.bDesc}]｜判据 ${vd.by}：${vd.reason}`
      if (vd.cmp > 0) return { act: 'replace', why: `跨仓库同名：lx-hunter 实测质量更优（${note}）→ 留优删差（删旧装新）` }
      if (vd.cmp < 0) return { act: 'skip', why: `跨仓库同名：服务端现条目质量更优（${note}）→ 保留服务端，本地不灌` }
      return { act: 'rename', why: `跨仓库同名但质量平手或证据不足（${note}）→ 不删任何一方，改名并存` }
    }

    // 3)（B 2026-11-23）服务端平台数压本地：只有服务端有**实测证据**（qualityProxy/deep）时
    //    "平台更多"才成立；否则 srvN 只是脚本自报的声明值，拿声明压本地实测不公平（"我的聚合音源"类）。
    //    无服务端实测证据 → rename 并存（不删服务端源），理由注明"服务端仅声明，待人工"。
    if (srvN > 0 && newN >= 0 && newN < srvN) {
      if (!srvDeep) {
        return { act: 'rename', why: `服务端现条目声明 ${srvN} 个平台（无实测证据）、多于本地实测 ${newN} 个 → 声明不能压实测，改名并存（不删服务端源，服务端仅声明，待人工）` }
      }
      return { act: 'skip', why: `服务端现条目实测支持 ${srvN} 个平台、多于本地实测可用的 ${newN} 个 → 保留服务端（哪个可用多用哪个）` }
    }

    // 4) 版本号可比 → 版本高的赢（versionKey 是字符串键，必须走 cmpVersion）
    if (lv && sv) {
      if (vc > 0) {
        return { act: 'replace', why: `同名，本地版本更高（${localVer} > ${srvVer}）→ 更新（删旧装新）` }
      }
      return { act: 'skip', why: `同名，服务端版本不低于本地（${srvVer} ≥ ${localVer}）→ 保留服务端` }
    }

    // 5) 平台重叠：有交集 → 同一音源的新版本；完全无交集 → 明显无关，改名并存
    if (srvN > 0 && newN > 0) {
      const overlap = srvPlats.filter(p => localPlats.indexOf(p) >= 0)
      if (!overlap.length) {
        return {
          act: 'rename',
          why: `同名但平台完全不重叠（服务端 ${srvPlats.join('/')} vs 本地 ${localPlats.join('/')}）→ 视作无关脚本，改名并存（不删旧的）`
        }
      }
      return { act: 'replace', why: `同名且平台有重叠（${overlap.join('/')}）→ 视作同一音源的新版本，更新（删旧装新）` }
    }

    // 6) 信息不足 → 按设置（默认更新，避免用户升级后同名新版灌不进去）
    if (c.replaceSameNameOnImport === false) {
      return { act: 'rename', why: '同名不同内容；设置里关闭了自动替换 → 改名上传（保留服务端旧版）' }
    }
    return { act: 'replace', why: '同名不同内容；信息不足以判定为无关脚本 → 按更新处理（删旧装新）' }
  }

  /**
   * P-1432（v1.13.8）：合并沙箱收集的更新信号到条目（按 url 去重，保留最新 msg/at）。
   *
   * R9（v1.13.15）：写入前做**纵深校验**——只接受「协议合法 + 域名格式合法 + 非私网/回环」
   * 的 tip.url。理由：updateTip 是**沙箱里的脚本**上报的，而沙箱正是恶意脚本的地盘；
   * 伪造的 tip.url 会被 _followUpdateTips 下载并 store.addSources() + saveDb()，
   * 等于让沙箱里的脚本往用户的音源库里注入任意内容（这不是「作者换域名」的问题，
   * 是「攻击者能往库里塞东西」）。
   *
   * 这一层是**纵深**：只做格式/私网/回环的硬校验（零维护、零误伤），
   * 「这个域名是不是这个音源自己的」由 _followUpdateTips 的已知域名集合把关
   * （那层知道具体是哪个音源、它的 apiHosts 是什么）。
   *
   * ⚠️ 关键：写入阶段**只丢这一条 tip**，绝不中断整轮合并——
   * 一条坏 tip 不能让其它正常更新提示（以及整个检测流程）失败。
   */
  _mergeUpdateTips(e, tips) {
    if (!tips || !tips.length) return
    const cur = Array.isArray(e.updateTips) ? e.updateTips : []
    let dropped = 0
    for (const t of tips) {
      if (!t || !t.url) continue
      const v = checkUpdateTipUrl(t.url)
      if (!v.ok) {
        dropped++
        this.log(`更新提示的地址未通过校验（${v.why}），已丢弃这一条更新提示：${String(t.url).slice(0, 80)}`, '采集', 'warn')
        continue
      }
      const prev = cur.find(x => x.url === t.url)
      if (prev) { prev.msg = t.msg || prev.msg; prev.at = t.at || prev.at }
      else cur.push({ url: String(t.url), msg: String(t.msg || ''), at: t.at || Date.now() })
    }
    e.updateTips = cur.slice(-5)
    if (dropped) this.log(`更新提示合并：本轮 ${tips.length} 条里有 ${dropped} 条地址不合法被丢弃，其余正常合并`, '采集', 'warn')
    this.emit('source-updated', e)
  }

  /**
   * R9 第③层：域名解析结果的可信度检查（通配 DNS / 解析到私网）。
   *
   * 为什么第①②层不够：URL 里的域名形状合法、TLD 是真字母，不等于它解析到公网。
   *  - 通配 DNS 服务（localtest.me / nip.io …）把**任意**子域解析到 127.0.0.1；
   *  - 自建域名可以把 A 记录指向 10.x / 192.168.x。
   * 这两种都能让「下载到的东西」来自本机/内网。
   *
   * 口径（重要）：
   *  - **解析失败（NXDOMAIN / DNS 抖动）→ 放行**。真实追更域名解析失败时下载本来也会失败，
   *    拦下来只是把「网络抖动」变成「音源被静默拒绝」，误伤代价更大。
   *  - 解析成功但指向私网/回环 → **拦截**（硬判据，复用 outbound-policy.checkOutbound）。
   *
   * ⚠️ 残余风险（明确接受，本轮不解决）：**DNS rebinding**。
   *   这里解析出来的 IP 与 fetch 实际连的 IP 之间仍可能不同——攻击者控制的 DNS
   *   可以第一次应答给公网 IP（通过校验）、第二次应答给 127.0.0.1（实际连接）。
   *   要根治必须把「解析出的 IP」钉死到连接上（自定义 lookup / 固定 IP 连接），
   *   那是部署层 R6「DNS 受控解析器」的事，不在代码层这轮范围内。
   *
   * @param {string} host 归一化主机名
   * @returns {Promise<{ok:boolean, why:string}>}
   */
  async _checkUpdateTipResolvedIp (host) {
    const r = await resolveHostIps(host)
    if (!r.ok || !r.ips.length) {
      // 解析失败：放行（理由见上方口径说明），但记一条日志便于事后追溯
      this.log(`updateUrl 域名 ${host} 解析失败（${r.err || '无应答'}），按「不拦截」处理；若该域名本应可用，可能是本机 DNS 故障`, '采集', 'warn')
      return { ok: true, why: '' }
    }
    const v = checkUpdateTipResolvedIp(host, r.ips)
    if (!v.ok) return v
    return { ok: true, why: '' }
  }

  /**
   * P-1432（v1.13.8 用户确认）：脚本更新信号追更——
   * lxserver/animemusic 这类脚本在取链响应里自带 updateMsg/updateUrl（lxserver 前端的
   * 「有新版本啦」提示即来源于此）。hunter 沙箱在同位置嗅探（lxbootstrap request 桥 +
   * lx.send('updateAlert') 双通道），本方法把 updateUrl 指向的新版脚本拉回来入库：
   *  - 拉取内容按脚本特征（@name/lx.on/lx.send）判定，非脚本（网页）只记提示不追更；
   *  - 内容 hash 已在库 → 跳过（防重复入库）；新 hash → 新 id 条目（updateurl:: 前缀）；
   *  - 入库后走既有全管线：检测（混淆闸门/域名画像）→ 同名裁决（版本高+质量不劣 → 删旧装新）。
   * updateUrl 是脚本作者指定的任意地址，但下载内容过全部既有闸门，无新增信任面。
   * 预算：单条 20s / 整轮 3 分钟 / 上限 10 条；开关 cfg.autoFollowScriptUpdate（默认开）。
   *
   * R9（v1.13.15）：**下载前**加域名校验（详见文件上方 R9 说明块）。
   *   - 第①层 checkUpdateTipUrl：协议 / 域名格式 / 私网回环（硬校验，与音源无关）；
   *   - 第②层 checkUpdateTipHostBelongsTo：域名必须属于「这个音源自己」
   *     （取该条目 apiHosts / obfDomains / homepage / 脚本地址的域名集合）。
   *   任一层不过 → **记日志并跳过这一条**，**绝不断言整轮**（其它 tip 继续处理）。
   *   ⚠️ 被跳过的 tip **不**记进 followedUpdateUrls：它没被成功跟进，
   *   下轮检测时若音源更新了已知域名，还能再试一次。
   */
  async _followUpdateTips(cfg) {
    // 阶段A：off 档＝关闭追更（等同 autoFollowScriptUpdate:false），入口即返回，不动两处调用点。
    if ((cfg && cfg.autoFollowPolicy) === 'off') return
    const policy = (cfg && cfg.autoFollowPolicy) || 'all'
    // 阶段B：AI 安全否决档位（off=零调用 / shadow=只标记 / enforce=danger 真阻断），默认 off
    const vetoMode = (cfg && cfg.aiFollowVeto) === 'shadow' || (cfg && cfg.aiFollowVeto) === 'enforce'
      ? cfg.aiFollowVeto : 'off'
    if (!this._followVetoResults) this._followVetoResults = new Map()   // 内存旁路：sha256(tip.url) → danger，不落库、不写 e.updateTips
    const items = this.store.getSources().filter(e => !e.deprecated && Array.isArray(e.updateTips) && e.updateTips.length)
    if (!items.length) return
    const TOTAL_BUDGET_MS = 3 * 60 * 1000
    const MAX = 10
    const startedAt = Date.now()
    let followed = 0
    let skipped = 0
    const hashes = new Set(Object.values(this.store.db.sources || {}).map(x => x && x.contentHash).filter(Boolean))
    for (const e of items) {
      e.followedUpdateUrls = Array.isArray(e.followedUpdateUrls) ? e.followedUpdateUrls : []
      // 该音源自己的已知域名集合（一次算好，本条目所有 tip 共用）
      const known = knownHostsForEntry(e)
      for (const tip of e.updateTips) {
        if (!tip || !tip.url) continue
        if (e.followedUpdateUrls.includes(tip.url)) continue
        if (this.cancelRequested) return
        if (followed >= MAX || Date.now() - startedAt > TOTAL_BUDGET_MS) {
          this.log(`updateUrl 追更停止（预算/上限，已跟进 ${followed} 条），其余下次检测继续`, '采集', 'warn')
          return
        }
        // ── 阶段A：追更策略（在 R9 域名校验**之前**，纯规则、不接 AI）──
        //   followClass 三态一律写给 tip 供 UI 展示（all 档也写，方便看规则结论）；
        //   substantive 档下 ignore/gray 直接跳过追更（不写 followedUpdateUrls，下轮可重试）；
        //   all 档维持现网行为：不看 msg、全追，仅多写一个展示字段。
        //   ⚠️ 不碰 R9 三层校验 / 逐跳 guard / 同名裁决 / contentHash 去重。
        const followClass = shouldFollowUpdateTip(tip.msg)
        tip.followClass = followClass
        if (policy === 'substantive' && followClass !== 'follow') {
          skipped++
          this.log(`updateUrl 追更跳过：追更策略=仅实质更新，本条更新说明判定为 ${followClass}（无实质修复/新功能）→ 不下载（来自「${e.lxName || e.scriptName || e.name}」）`, '采集', 'info')
          continue
        }
        // ── R9：下载前校验（两层）──
        const v = checkUpdateTipUrl(tip.url)
        if (!v.ok) {
          skipped++
          this.log(`updateUrl 追更跳过：更新地址未通过校验（${v.why}）→ 不下载（来自「${e.lxName || e.scriptName || e.name}」）`, '采集', 'warn')
          continue
        }
        const own = checkUpdateTipHostBelongsTo(e, v.host, known)
        if (!own.ok) {
          skipped++
          this.log(`updateUrl 追更跳过：更新地址的域名不是该音源自己的（${own.why}）→ 不下载（来自「${e.lxName || e.scriptName || e.name}」）`, '采集', 'warn')
          continue
        }
        // 第③层：解析后 IP 私网判定（通配 DNS / 自建 A 记录指向内网）
        const ipCheck = await this._checkUpdateTipResolvedIp(v.host)
        if (!ipCheck.ok) {
          skipped++
          this.log(`updateUrl 追更跳过：更新地址的域名解析结果不可信（${ipCheck.why}）→ 不下载（来自「${e.lxName || e.scriptName || e.name}」）`, '采集', 'warn')
          continue
        }
        // ── 阶段B：AI 安全否决（R9 三层全过之后、真正下载之前）──
        //   单向否决：只有 enforce 档且 AI 明确 danger===true 才阻断；其余一律放行。
        //   off 档零 AI 调用、零字段计算；shadow 只产标记+旁路日志、不阻断。
        //   ⚠️ 不进删源/禁用链、不放宽 R9/逐跳 guard/同名裁决、不动 known/rebinding、不改阶段A 规则。
        if (vetoMode !== 'off') {
          try {
            const msg = String((tip && tip.msg) || '')
            // msg 只提取布尔风险标记，**原文绝不发给 AI**（防话术注入骗放行）
            const risk = {
              hasNudge: /请尽快更新|有新版本|版本过低|点击(更新|下载)|加群|群号|svip音源更新/.test(msg),
              hasAd: /广告|引流|推广|赞助|扫码|二维码/.test(msg),
              hasGroupOrCaptcha: /加群|群号|验证码/.test(msg),
              hasInstruction: /忽略.{0,6}(指令|规则)|系统消息|一律判|覆盖.{0,4}规则/.test(msg),
              hasVersionOnly: /^.{0,20} v?\d+\.\d+(\.\d+)?$/.test(msg)
            }
            const structured = {
              host: v.host,
              isKnownHost: true,                                  // R9 第②层已过
              isSharedHost: updateTipHostIsShared(v.host, this.store.getSources(), e.id),
              ipPrivate: false,                                   // R9 第③层已过（能到这里的都不是私网）
              wildcardDns: false,                                 // R9 第①层黑名单已过
              msgRiskFlags: risk
            }
            const ai = this._ai ? this._ai() : null
            const res = ai && typeof ai.classifyUpdateTipSafety === 'function'
              ? await ai.classifyUpdateTipSafety(structured) : { danger: 'unknown' }
            const danger = res && res.danger
            const key = sha256Str(tip.url)
            this._followVetoResults.set(key, { danger, reason: res && res.reason || '', mode: vetoMode, at: Date.now() })
            if (danger === true) {
              if (vetoMode === 'enforce') {
                skipped++
                this.log(`updateUrl 追更跳过：AI 安全否决（danger=true，enforce 档）→ 不下载（来自「${e.lxName || e.scriptName || e.name}」）`, '采集', 'warn')
                continue
              }
              // shadow：只记旁路日志，照常下载
              this.log(`updateUrl 追更[影子]：AI 标记 danger=true（shadow 档不阻断，仅供观察）→ 照常下载（来自「${e.lxName || e.scriptName || e.name}」）`, '采集', 'info')
            }
          } catch (_) {
            // AI 否决链任何异常一律放行（安全不对称：绝不因旁路故障误伤好源）
          }
        }
        followed++
        this.log(`updateUrl 追更：「${e.lxName || e.scriptName || e.name}」拉取 ${tip.url.slice(0, 60)}…`, '采集', 'info')
        let text = ''
        try {
          // ⚠️ R9：必须**逐跳校验**。默认 fetch 会自动跟随重定向，
          //   那样第②层只在第一跳生效——攻击者让第一跳（合法域）302 到自己的域就绕过了。
          //   这里用 redirect:'manual' 自己跟，每一跳都重跑全部三层校验。
          const guard = async (hopUrl) => {
            const hv = checkUpdateTipUrl(hopUrl)
            if (!hv.ok) return { ok: false, why: '第①层: ' + hv.why }
            const hown = checkUpdateTipHostBelongsTo(e, hv.host, known)
            if (!hown.ok) return { ok: false, why: '第②层: ' + hown.why }
            const hip = await this._checkUpdateTipResolvedIp(hv.host)
            if (!hip.ok) return { ok: false, why: '第③层: ' + hip.why }
            return { ok: true, why: '' }
          }
          const r = await crawlFetch(tip.url, { guard }, 15000)
          if (!r.res || !r.res.ok) { this.log(`updateUrl 追更拉取失败（HTTP ${r.res && r.res.status || '?'}）→ 下轮重试`, '采集', 'warn'); continue }
          text = String(await r.res.text()).slice(0, 1024 * 1024)
        } catch (err) {
          const why = String((err && err.message) || err)
          if (err && err.code === 'REDIRECT_BLOCKED') {
            this.log(`updateUrl 追更跳过：重定向目标未通过校验（${why}）→ 不下载（来自「${e.lxName || e.scriptName || e.name}」）`, '采集', 'warn')
          } else if (err && err.code === 'REDIRECT_TOO_MANY') {
            this.log(`updateUrl 追更跳过：重定向跳数过多（${why}）→ 不下载（来自「${e.lxName || e.scriptName || e.name}」）`, '采集', 'warn')
          } else {
            this.log(`updateUrl 追更拉取异常（${why.slice(0, 60)}）→ 下轮重试`, '采集', 'warn')
          }
          continue
        }
        const isScript = /@name\s+(.+)/.test(text.slice(0, 5000)) || /lx\.on\s*\(|lx\.send\s*\(|EVENT_NAMES/.test(text.slice(0, 5000)) || /lx\.on\s*\(/.test(text)
        if (!isScript) {
          this.log(`updateUrl 追更：内容不是音源脚本（网页/说明），只记提示`, '采集', 'info')
          e.followedUpdateUrls.push(tip.url)
          continue
        }
        const sha = sha256Str(text)
        // 静态情报·硬否决（2026-11-24）：追更入库前命中恶意指纹则拒绝入库，
        // 堵「同名源经 updateUrl 追更把恶意内容写进库」的绕过面。
        if (isMaliciousHash(sha)) {
          e.followedUpdateUrls.push(tip.url)
          this.log(`安全硬否决：updateUrl 追更内容命中恶意脚本指纹，拒绝入库：${tip.url.slice(0, 120)}（sha=${sha.slice(0, 12)}）`, '安全', 'warn')
          continue
        }
        if (hashes.has(sha)) { e.followedUpdateUrls.push(tip.url); continue }
        const name = ((text.match(/@name\s+(.+)/) || [])[1] || '').trim() ||
          ((tip.url.split('/').pop() || 'updateTip').replace(/\.js.*/i, '')) || 'updateTip'
        const id = 'updateurl::' + sha256Str(tip.url).slice(0, 10) + ':' + sha.slice(0, 12)
        this.store.addSources([{ id, repo: 'updateUrl 追更', url: tip.url, name, lxName: name, scriptName: name,
          code: text, contentHash: sha, size: text.length, status: 'ok', usable: false, addedAt: Date.now(),
          fromUpdateTip: e.id }])
        hashes.add(sha)
        e.followedUpdateUrls.push(tip.url)
        this.log(`updateUrl 追更：新版脚本「${name}」已入库（来自「${e.lxName || e.scriptName || e.name}」的更新提示）→ 待检测`, '采集', 'info')
        this.emit('source-updated', e)
      }
      this.store.saveDb()
    }
    if (followed) this.log(`updateUrl 追更完成：跟进 ${followed} 条更新信号`, '采集', 'info')
    if (skipped) this.log(`updateUrl 追更：本轮有 ${skipped} 条更新信号因地址不合法/不属于该音源被跳过（已记日志，不影响其它条目）`, '采集', 'warn')
  }

  /**
   * P-1432（R3 用户裁决）：同名并存组自动深检跟进。
   *
   * 背景：H2 完整性守卫让 quick 条目的同名对决转为 pendingDuel（并存堆积）——
   * 用户裁决「系统可以跟进自动深检」：检测收尾对同名并存组（≥2 条非废弃同名条目、
   * 组内有深检不完整者）自动跑 full 深检，跑完重新 dedupe 收敛裁决。
   * 预算照抄：单条 20s / 整轮 3 分钟 / 上限 20 条；开关 cfg.autoDeepPendingDuels（默认开）。
   * 局限如实：批量 quick 检测后同名组多时整轮最多多 3 分钟；失败条目保持现状不阻断。
   */
  async _autoDeepPendingDuels(cfg) {
    const BUDGET_MS = 20000
    const TOTAL_BUDGET_MS = 3 * 60 * 1000
    const MAX_PROBES = 20
    const startedAt = Date.now()
    const groups = {}
    for (const e of this.store.getSources()) {
      if (e.deprecated || e.fromServer || e.private || !e.contentHash) continue
      const nm = normName(e.lxName || e.scriptName || e.name)
      if (!nm) continue
      if (isWeakBaseName(nm)) continue   // P-1432 实测：'main' 通用名组 6 条白耗预算，弱名守卫与 _dedupe 同口径
      if (!this._deepIncomplete(e)) continue
      ;(groups[nm] = groups[nm] || []).push(e)
    }
    let probes = 0
    let rlSkip = 0
    for (const [nm, group] of Object.entries(groups)) {
      if (group.length < 2) continue
      for (const e of group) {
        const code = (typeof e.code === 'string' && e.code) ? e.code : ''
        if (!code) continue
        if (this.cancelRequested) return
        // P-1432 日志核查发现的优化：限流熔断有冷却窗口（doujs 实测 >5 分钟），
        // 冷却期内重试是无效消耗（结果不变）——按上次检测里 untested 的限流文案判定退避。
        const lastPlats = Object.values((e.deep && e.deep.platforms) || {})
        const rateLimited = lastPlats.some(pl => pl && pl.status === 'untested' &&
          /RATE_LIMIT|限流|已知失败/i.test(String(pl.message || '')))
        if (rateLimited && e.deep.checkedAt && Date.now() - e.deep.checkedAt < 30 * 60 * 1000) {
          rlSkip++
          continue
        }
        if (probes >= MAX_PROBES || Date.now() - startedAt > TOTAL_BUDGET_MS) {
          this.log(`同名并存自动深检停止（预算/上限，共深检 ${probes} 条），其余下次检测继续`, '检测', 'warn')
          return
        }
        probes++
        this.log(`同名并存自动深检：「${e.scriptName || e.lxName || e.name}」（组内 ${group.length} 条待完整证据）…`, '检测', 'info')
        try {
          const d = await deepCheck(e, code, Object.assign({}, cfg, { quickCheck: false }),
            (t, pl) => this.emit(t, pl), () => this.cancelRequested)
          e.deep = d
          this._mergeUpdateTips(e, d.updateTips)
          e.usable = usableCount(e) > 0
          applyProbeRecord(e, e.deep)
          this.emit('source-updated', e)
        } catch (err) {
          this.log(`自动深检失败（${String((err && err.message) || err).slice(0, 60)}）→ 保持现状`, '检测', 'warn')
          continue
        }
      }
    }
    if (probes) {
      this.log(`同名并存自动深检完成 ${probes} 条 → 重新去重裁决` +
        (rlSkip ? `；限流冷却中跳过 ${rlSkip} 条（30 分钟后重试）` : ''), '检测', 'info')
      this.dedupe()
      this.store.saveDb()
    }
  }

  /**
   * 同名冲突的「证据补齐」层（v1.13.7，P-1508 doujs 案例的规则化，用户拍板）。
   *
   * 缺口：检测默认 quickCheck=true（测到第一个可用平台就停、其余标 untested），
   * 同名裁决里「服务端声明平台数 > 本地实测」的 skip 是拿声明值压实测下限的
   * 不公平比较（声明值天然偏大）；provenDifferent 分支写着「请先做全平台检测」
   * 却只提示、不自动做——P-1508 靠人肉 POST /api/check {full:true} 补证据才放行。
   *
   * 触发（照 _probeTierForConflicts 的保守口径）：
   *  - item 是同名 skip（item.srv 由 _planImportQueue 补带的服务端条目）；
   *  - 本地实测可用数少于服务端声明数（srvN > usableCount(e)）——裁决确实是被证据挡的；
   *  - 本地没有新鲜的 full 深检证据（depth==='full' 且 7 天内 → 直接复用，不重复补测）。
   * 动作：用灌入阶段已下载的 codeCache 跑 deepCheck({quickCheck:false}) 写回 e.deep，
   * 重调 sameNameVerdict 重新裁决并改写 item（模式照抄 _probeTierForConflicts）；
   * sameNameVerdict 一行不改，比较层仍简单可解释。
   * 预算照抄：单条 20s / 整轮 3 分钟 / 上限 20 条；失败维持原裁决绝不阻断灌入。
   */
  async _supplementConflicts(plans, codeCache, cfg) {
    const BUDGET_MS = 20000
    const TOTAL_BUDGET_MS = 3 * 60 * 1000
    const MAX_PROBES = 20
    const startedAt = Date.now()
    let probes = 0
    let respins = 0
    for (const p of plans) {
      const srvByName = p.serverByName || {}
      for (const item of (p.queue || [])) {
        if (!item || !item.skip || !item.e) continue
        const e = item.e
        // 同名服务端条目：skip 项补带了 item.srv；老数据没有就按名回查
        const srv = item.srv || srvByName[e.lxName || e.scriptName || e.name || '']
        if (!srv || !Array.isArray(srv.supportedSources)) continue
        // A 口径同步（2026-11-23）：补测触发判断也用"有效平台数"（声明扣 disabledSources），
        // 与 sameNameVerdict 一致，避免声明 5 实际 4 的源被误判"证据不足"反复补测。
        const srvOff = new Set((Array.isArray(srv.disabledSources) ? srv.disabledSources : [])
          .filter(Boolean).map(p => String(p).toLowerCase()))
        const srvN = srv.supportedSources.filter(p => !srvOff.has(String(p == null ? '' : p).toLowerCase())).length
        const usableN = usableCount(e)
        if (usableN >= srvN) continue        // 证据已够，裁决不是被平台数挡的
        const metrics = (e.deep && e.deep.metrics) || {}
        const platVals = Object.values((e.deep && e.deep.platforms) || {})
        const untestedN = platVals.filter(pl => !pl || pl.status === 'untested' || pl.status === 'pending').length
        // P-1432 修正：full 但含 untested/pending = 深检不完整（上游限流熔断跳过），
        // 不是「已完整」——仍要补测（RATE_LIMIT 冷却 5 分钟后重测能出真结果）。
        // 只有「full 且无 untested」才算新鲜完整证据，7 天内直接复用。
        if (metrics.depth === 'full' && untestedN === 0 && e.deep.checkedAt &&
            Date.now() - e.deep.checkedAt < 7 * 24 * 3600 * 1000) continue  // 新鲜完整证据直接复用
        const code = codeCache[e.id] || (typeof e.code === 'string' && e.code ? e.code : '')
        if (!code) continue
        if (this.cancelRequested) return
        if (probes >= MAX_PROBES || Date.now() - startedAt > TOTAL_BUDGET_MS) {
          const why = probes >= MAX_PROBES ? `已达条数上限 ${MAX_PROBES}` : `已用 ${Math.round((Date.now() - startedAt) / 1000)}s 超预算`
          this.log(`同名冲突自动补测停止（${why}，共补测 ${probes} 条），其余维持原裁决`, '灌入', 'warn')
          return
        }
        probes++
        this.log(`同名冲突自动补测：全平台深检「${e.scriptName || e.lxName || e.name}」（服务端声明 ${srvN} > 本地实测 ${usableN}）…`, '灌入')
        let r
        try {
          r = await deepCheck(e, code, Object.assign({}, cfg, { quickCheck: false }),
            (t, pl) => this.emit(t, pl), () => this.cancelRequested)
        } catch (err) {
          item.skip += `（自动补测失败：${String((err && err.message) || err).slice(0, 60)}）`
          continue
        }
        e.deep = r
        this._mergeUpdateTips(e, r.updateTips)
        const v = this.sameNameVerdict(e, srv, code, cfg, { ledger: (p.ledger && p.ledger[e.id]) || null })
        try { this._aiExplainVerdict(e.id, v, { localVer: e.scriptVersion, srvVer: srv.version }); this._aiShadowEval(e, srv, code, v, cfg, { ledger: (p.ledger && p.ledger[e.id]) || null }); } catch (_) {}
        const note = `（已自动补测全平台：实测 ${usableCount(e)} 个可用）`
        respins++
        if (v.act === 'skip') {
          item.skip = `与服务端同名「${srv.name}」：${v.why}${note}`
        } else if (v.act === 'replace') {
          this.log(`补测后改判：留本地（删旧装新）—— ${v.why}`, '灌入', 'info')
          item.replaceServer = srv
          item.why = `同名裁决：${v.why}${note}`
          delete item.skip
        } else if (v.act === 'rename') {
          this.log(`补测后改判：改名并存 —— ${v.why}`, '灌入', 'info')
          item.renameServer = srv
          item.why = `同名裁决：${v.why}${note}`
          delete item.skip
        } else if (v.act === 'synced') {
          item.sameContentServer = srv
          item.why = `同名裁决：${v.why}${note}`
          delete item.skip
        }
      }
    }
    if (probes) this.log(`同名冲突自动补测 ${probes} 条 → 重新裁决改判 ${respins} 条`, '灌入', 'info')
  }

  /**
   * 同名冲突的音质专项补测（字典序第三层）。
   *
   * 触发条件（全部满足才动手，避免无谓的沙箱开销）：
   *  - 该条目被判「改名并存」（说明前两层——平台数、p50——已经打平或无证据）；
   *  - 本地已做过深度检测（`metrics.depth==='full'`）：连平台数都没测过就比音质是瞎比；
   *  - 本地还没有音质档证据（`tier === null`）。
   * 结果写进 `deep.metrics.qualityMax` 并**重新裁决一次**：
   *  - 服务端侧有打分快照（账本回放）→ 这次是真比较，可能翻成「留优删差 / 保留服务端」；
   *  - 服务端侧没有 → 决策不变（仍改名并存），但分数随灌入写进账本，
   *    下次同一个脚本再被别的仓库同名覆盖时就有可比的一侧了（打破「永远没证据」的死循环）。
   * 成本：每条 1 次沙箱初始化 + 最多 2 档探测，约 10~20s；
   * 因此用「整轮 3 分钟 / 20 条」双重预算截断，而不是原先硬写死的 5 条。
   */
  async _probeTierForConflicts(plans, codeCache, cfg) {
    // 预算是「时间」而不是「条数」：原先写死最多 5 条，同名冲突一多，
    // 第 6 条之后永远轮不到补测，同一批里有的比音质、有的只能改名并存，行为不一致。
    // 改成整轮 3 分钟（单条 20s，约 9 条）+ 绝对上限 20 条兜底：
    // 冲突少就全测，冲突多按时间截断，且不会把一次灌入拖成几十分钟。
    const BUDGET_MS = 20000
    const TOTAL_BUDGET_MS = 3 * 60 * 1000
    const MAX_PROBES = 20
    const startedAt = Date.now()
    let probes = 0
    for (const p of plans) {
      for (const item of (p.queue || [])) {
        if (!item || !item.renameServer || !item.e) continue
        const e = item.e
        // 顺序很重要：先判「有没有分」，再判「有没有正文」。
        // 反过来写的话，没下载正文的条目会被静默跳过，用户看不到「你还没跑深度检测」这句提示。
        const mine = qualityProfile(e)
        if (!mine.scored) {
          // 深检跑过但 0 样本（平台集为空）也算「没分」，但提示不能叫用户再跑一遍深检
          const full = !!(e.deep && e.deep.metrics && e.deep.metrics.depth === 'full')
          item.why += full
            ? '；深度检测没有产出任何可用样本，音质档无法比较（请重跑深度检测）'
            : '；未做深度检测，音质档未补测（先跑「深度检测（打分）」）'
          continue
        }
        if (mine.tier !== null) continue
        const code = codeCache[e.id] || (typeof e.code === 'string' && e.code ? e.code : '')
        if (!code) {
          item.why += '；没有脚本正文，音质档无法补测'
          continue
        }
        if (this.cancelRequested) return
        if (probes >= MAX_PROBES || Date.now() - startedAt > TOTAL_BUDGET_MS) {
          const why = probes >= MAX_PROBES ? `已达条数上限 ${MAX_PROBES}` : `已用 ${Math.round((Date.now() - startedAt) / 1000)}s 超预算`
          this.log(`音质补测停止（${why}，共补测 ${probes} 条），其余同名冲突保持改名并存`, '灌入', 'warn')
          return
        }
        probes++
        this.log(`同名冲突进入第三层：补测「${e.scriptName || e.lxName || e.name}」的最高可播档…`, '灌入')
        const pr = await probeTopTier(e, code, cfg, { platforms: usableKeys(e), budgetMs: BUDGET_MS })
        if (!pr.ok) {
          this.log(`音质档补测未得出结论（${pr.reason}）→ 维持原裁决`, '灌入', 'warn')
          item.why += `；音质档补测未得出结论：${pr.reason}`
          continue
        }
        e.deep = e.deep || {}
        e.deep.metrics = e.deep.metrics || {}
        e.deep.metrics.qualityMax = pr.tier
        e.deep.metrics.tierProbedAt = Date.now()
        e.deep.metrics.tierProbedPlatform = pr.platform
        this.log(`音质档补测：${pr.platform} 可播 ${pr.tier}`, '灌入', 'info')
        const v = this.sameNameVerdict(e, item.renameServer, code, cfg, { ledger: (p.ledger && p.ledger[e.id]) || null })
        try { this._aiExplainVerdict(e.id, v, { localVer: e.scriptVersion, srvVer: item.renameServer.version }); this._aiShadowEval(e, item.renameServer, code, v, cfg, { ledger: (p.ledger && p.ledger[e.id]) || null }); } catch (_) {}
        item.why = `同名裁决：${v.why}（已补测音质档 ${pr.tier}@${pr.platform}）`
        if (v.act === 'replace') {
          this.log(`补测后改判：留本地（删旧装新）—— ${v.why}`, '灌入', 'info')
          item.replaceServer = item.renameServer
          delete item.renameServer
        } else if (v.act === 'skip') {
          this.log(`补测后改判：保留服务端 —— ${v.why}`, '灌入', 'info')
          item.skip = `与服务端同名「${item.renameServer.name}」：${v.why}（已补测音质档 ${pr.tier}@${pr.platform}）`
          delete item.renameServer
        } else if (v.act === 'synced') {
          item.sameContentServer = item.renameServer
          delete item.renameServer
        }
      }
    }
  }

  /**
   * 灌入前的去重/同名裁决（纯函数，v1.7.0 抽出便于测试）：
   *  - 服务端原生 / 本地检测未通过（skipUnusable 默认开）/ 本次所选内同内容或同名 → skip
   *  - 「已灌入同内容」→ **只有在服务端上确实还存在那条音源时**才 skip（v1.8.0 修正）：
   *    用户可能在网页端手动删过，此时本地账本还是旧的，硬跳过会导致「怎么灌都灌不进去」。
   *  - 服务端同名 → 交给 sameNameVerdict 裁决（synced / skip / replace / rename）
   *  - 其余 → 直接上传
   */
  _planImportQueue(targets, ctx) {
    const cfg = ctx.cfg || {}
    const serverByName = ctx.serverByName || {}
    const serverByBase = ctx.serverByBase || {}
    const serverIds = ctx.serverIds || null   // 服务端此刻真实存在的 id 集合
    const serverList = ctx.serverList || []
    // 服务端已有条目的「内容指纹」表：只有平台会回传脚本正文时才有值
    // （MusicSync 实测会回传全文 → 能对它做「服务端已有同内容就不重复灌」；
    //  Songloft / LX Server 只回元信息，表为空，退回账本口径）。
    const serverByHash = {}
    for (const s of serverList) if (s && s.hash) serverByHash[s.hash] = s
    const codeCache = ctx.codeCache || {}
    // 兼容旧的调用口径：没有 serverIds 时退回「本地账本说了算」
    // 「本地条目 id → 上次灌入的正文 hash」账本，用来判定「同名同内容」
    // （服务端不回 hash/正文，size 在等长改动时会漏判，见 _ledgerByEntry 注释）
    const ledger = ctx.ledger || {}
    const importedRecs = ctx.importedRecs || (ctx.importedHashes
      ? Object.keys(ctx.importedHashes).reduce((o, h) => { o[h] = { name: ctx.importedHashes[h], lxId: null }; return o }, {})
      : {})
    const rank = (a, b) => (b.lastModified || 0) - (a.lastModified || 0) || usableCount(b) - usableCount(a) || String(a.id).localeCompare(String(b.id))
    const groups = {}, ngroups = {}, best = {}, nbest = {}
    for (const e of targets) {
      if (e.contentHash) (groups[e.contentHash] = groups[e.contentHash] || []).push(e)
      const nm = normName(e.lxName || e.scriptName || e.name)
      if (nm) (ngroups[nm] = ngroups[nm] || []).push(e)
    }
    for (const k of Object.keys(groups)) { groups[k].sort(rank); best[k] = groups[k][0] }
    for (const k of Object.keys(ngroups)) { ngroups[k].sort(rank); nbest[k] = ngroups[k][0] }
    // 一次勾选同一音源的多个版本（v1.0.0 + v2.0.0）：精确名不同、base 相同 → 只留最高版本，
    // 否则两条都会去 replace 服务端同一条旧版（P-1411 P0，实机复现出「（副本2）」并列条目）。
    const skipByBase = planBaseDedupe(targets, cfg)
    const queue = []
    // 同名音源一律走同一套裁决（含 MusicSync）—— 同名/同内容该怎么处理与平台无关，
    // 区别只有「要不要改名」：名字不是 key 的平台（MusicSync）根本不需要改，
    // 把本地这份作为独立条目加上去即可（改名不但没用，还会破坏脚本自检）。
    // matchedByBase：服务端那条是靠「剥掉版本号后同名」配上的（精确同名没命中），
    // 只是配对方式不同，裁决口径完全一样。
    const planSameName = (e, srvRaw, matchedByBase) => {
      // 服务端 list 只有声明值，回放本地账本里「当年灌进去时那份」的打分快照，
      // 否则第三层（音质档）永远没有可比的另一侧。
      const snap = (ctx.serverScore && srvRaw && srvRaw.id != null) ? ctx.serverScore[srvRaw.id] : null
      const srv = (snap && !snap.stale) ? Object.assign({}, srvRaw, { qualityProxy: snap }) : srvRaw
      const code = codeCache[e.id]
      const v = this.sameNameVerdict(e, srv, code, cfg, { ledger: ledger[e.id] || null })
      try { this._aiExplainVerdict(e.id, v, { localVer: e.scriptVersion, srvVer: srv.version }); this._aiShadowEval(e, srv, code, v, cfg, { ledger: ledger[e.id] }); } catch (_) {}
      const baseName = e.lxName || e.scriptName || e.name
      const via = matchedByBase ? `（删版本号后同名，配对到服务端「${srv.name}」）` : ''
      // matchedByBase 留给 UI/日志：用户要能分清「精确同名」与「删版本号后同名」
      const mb = !!matchedByBase
      if (v.act === 'synced') queue.push({ e, sameContentServer: srv, why: v.why, matchedByBase: mb })
      else if (v.act === 'skip') queue.push({ e, skip: `与服务端同名${via}「${srv.name}」：${v.why}`, srv, matchedByBase: mb })
      else if (v.act === 'rename' && ctx.uniqueName === false) {
        queue.push({
          e,
          why: `同名裁决：${v.why}。该平台同名音源可共存（服务端不按名字区分），直接新增为独立条目（不改名）`,
          matchedByBase: mb
        })
      } else if (v.act === 'rename') {
        // 改名安全阀前置：脚本自检名字的音源改名会变成坏源，规划阶段就说清，别等到上传失败
        if (code && renameSelfCheck(code, (extractMeta(code) || {}).name || '')) {
          queue.push({
            e,
            skip: `与服务端同名${via}「${srv.name}」：${v.why}，但该脚本内部校验自身名称，改名会让它初始化失败 → 未灌入（请先手动删除服务端同名音源，或开启「同名自动替换」）`,
            matchedByBase: mb
          })
        } else queue.push({ e, renameServer: srv, baseName, why: v.why, matchedByBase: mb })
      } else if (code) queue.push({ e, replaceServer: srv, baseName, why: v.why, matchedByBase: mb })
      // 要替换但没有本地脚本内容（只能靠 URL 导入）→ 服务端做不了「先删后传」
      else if (ctx.uniqueName === false) queue.push({ e, why: '没有本地脚本内容，直接按 URL 新增（该平台同名可共存，无需改名）', matchedByBase: mb })
      else queue.push({ e, renameServer: srv, baseName, why: '没有本地脚本内容，无法先删后传 → 改为改名上传', matchedByBase: mb })
    }
    for (const e of targets) {
      const nameForMatch = e.lxName || e.scriptName || e.name
      const nm = normName(nameForMatch)
      const eBase = baseNameKey(nameForMatch)
      if (e.fromServer) {
        // 服务端同步建的占位条目：它本来就在服务端上，重新上传只会制造重复条目。
        queue.push({ e, skip: '服务端原生音源，无需灌入' })
      } else if (!e.url && !(typeof e.code === 'string' && e.code)) {
        // 门槛：只看「本地有没有脚本正文可用」。
        // 2026-11-11 修：原来写 `!e.url || e.fromServer`，只认 url，把「导入单个音源」加进来的
        // 私人源（有 code、无 url，addPrivateSource 就是这么存的）误判成「服务端原生音源」直接跳过，
        // 与巡检门槛 buildPatrolItems 的 `!e.url && typeof e.code !== 'string'` 口径不一致，
        // 也和界面文案「私人源可手动检测 / 可灌入」自相矛盾。
        // 安全性：fromServer 已在上一个分支拦掉，且占位条目从不存 code，
        // 所以放宽后不会把服务端原生源重复上传。
        // 注意必须是「非空 code」：空串仍是 string，放行会让 codeCache 取不到内容、
        // 最后拿空 url 去 importUrl —— 必失败，还多一条无意义的结果。
        queue.push({ e, skip: '既无脚本地址、也无本地脚本正文，无法灌入' })
      } else if (cfg.skipUnusable !== false && !e.usable && e.deep && !e.stale) {
        // stale（上游内容已变待重下）的旧检测结果不作数，放行到指纹/检测流程重新裁决
        queue.push({ e, skip: '本地检测未通过（无可播放平台），跳过' })
      } else if (e.contentHash && serverByHash[e.contentHash] &&
                 (!serverIds || serverIds.has(serverByHash[e.contentHash].id))) {
        // 服务端此刻已有一条内容完全相同的音源（按脚本正文 sha256 比对）。这一条不看本地账本，
        // 所以「账本丢了 / 用户手动删过又重新同步 / 换了账号」都拦得住重复灌 —— 否则同一个音源
        // 灌几轮就会在服务端堆出好几份一模一样的（MusicSync 尤其明显：它同名还允许共存）。
        queue.push({
          e,
          sameContentServer: serverByHash[e.contentHash],
          why: '服务端已有内容完全相同的音源（按脚本内容比对）'
        })
      } else if (e.contentHash && importedRecs[e.contentHash] &&
                 (!serverIds || importedRecs[e.contentHash].lxId == null || serverIds.has(importedRecs[e.contentHash].lxId))) {
        // 本地账本说「灌过」，且服务端上那条确实还在 → 真的不用再灌。
        // 若 serverIds 里没有它（网页端已删 / 换了账号 / 服务端重置），落到下面的分支重新灌 ——
        // 这正是用户反馈的「已灌入的无法二次灌入」。
        queue.push({ e, skip: `服务端已有同内容音源「${importedRecs[e.contentHash].name}」，无需重复灌入` })
      } else if (e.contentHash && best[e.contentHash] && best[e.contentHash] !== e) {
        queue.push({ e, skip: `与本次所选的「${best[e.contentHash].scriptName || best[e.contentHash].name}」内容相同，跳过` })
      } else if (nm && nbest[nm] && nbest[nm] !== e) {
        queue.push({ e, skip: `与本次所选的「${nbest[nm].scriptName || nbest[nm].name}」同名（视为同一音源新旧版本），跳过` })
      } else if (skipByBase[e.id]) {
        // 同一音源的多个版本被一起勾选：只灌最高版本那条（理由见 planBaseDedupe）。
        // 不许两条都进 replace 流程 —— 第二条会去删一条已被删掉的服务端条目。
        const w = skipByBase[e.id]
        const wName = w.scriptName || w.lxName || w.name
        const lv2 = verLabel(e.scriptVersion || e.lxName || e.scriptName || e.name)
        const wv = verLabel(w.scriptVersion || w.lxName || w.scriptName || w.name)
        queue.push({
          e,
          skip: `与本次所选的「${wName}」是同名音源的不同版本（${wv} > ${lv2}），同批只灌最高版本；要灌这一版请单独勾选再灌`
        })
      } else if (nm && serverByName[nm]) {
        planSameName(e, serverByName[nm], false)
      } else if (eBase && serverByBase[eBase]) {
        // 精确同名没命中，但「剥掉版本号后同名」命中：作者把版本写进 @name 的常态。
        // 不加这一层，每次升级都会在服务端新起一条、旧条还 enabled（P-1404 实测）。
        planSameName(e, serverByBase[eBase], true)
      } else {
        // 本地账本有此内容、但服务端上已经没了（用户手动删过/服务端重置）→ 重新灌入
        const rec = e.contentHash ? importedRecs[e.contentHash] : null
        queue.push(rec ? { e, why: `服务端上已无「${rec.name}」（本地记录保留），本次重新灌入` } : { e })
      }
    }
    // P-1432（W-A，2026-11-16）：疑似重复只读提示——同名匹配（normName）未命中、
    // 但弱名键（去 emoji/符号）与服务端条目相同的候选，标注「疑似重复」。
    // 只标注不裁决：emoji 是作者区分变体的手段，自动合并有误删风险；音源库徽章供人工判断。
    if (Array.isArray(ctx.serverList) && ctx.serverList.length) {
      const srvByWeak = {}
      for (const s of ctx.serverList) {
        if (!s || !s.name) continue
        const wk = weakNameKey(s.name)
        if (wk && !srvByWeak[wk]) srvByWeak[wk] = s
      }
      for (const it of queue) {
        if (!it || !it.e || it.renameServer || it.skip || it.sameContentServer || it.replaceServer) continue
        const wk = weakNameKey(it.e.lxName || it.e.scriptName || it.e.name)
        const srv = srvByWeak[wk]
        if (srv) it.similarNameHint = `与服务端「${srv.name}」疑似重复（名字仅差 emoji/符号，作者/内容可能不同），如确认是同一音源的变体请人工处理`
      }
    }
    // P1-1：规划后的队列按质量排序（与 targets 排序同口径）；skip 项沉底。
    // 只改执行先后：每条 item 上的裁决/skip/sameContent/replace/rename 标记是前面规划好的，
    // 排序不改动它们；_runImportItem 逐条照旧执行。向后兼容：noQualitySort 时保持原顺序。
    if (!ctx.noQualitySort) {
      queue.sort((a, b) => {
        const as = a && a.skip ? 1 : 0, bs = b && b.skip ? 1 : 0
        if (as !== bs) return as - bs                // skip 项沉底
        return compareImportQuality(a && a.e, b && b.e) ||
          String((a && a.e && a.e.id) || '').localeCompare(String((b && b.e && b.e.id) || ''))
      })
    }
    return queue
  }

  /**
   * 删旧之后把新版本传上去：**轮询**而不是硬等固定 2.5 秒（2026-11-11 性能项 3）。
   *
   * 旧实现：remove 成功 → sleep(2500) → upload；撞名再 sleep(2500) 重试一次。
   * 批量替换（同名版本更新场景常见）时每条白等 2.5 秒，20 条约 50 秒纯等待。
   * 现在：立刻试传，只有真的撞「已存在」才按 replaceRetryDelay 退避轮询，
   * 总预算 `LXH_REPLACE_POLL_MS`（默认 3000ms）；超预算返回最后一次失败结果，
   * 由调用方按原逻辑退化成「改名上传」。
   *
   * 只对「已存在」重试：其它错误（超时/需要 VM/参数错）重试没有意义。
   * @returns 最后一次 upload 的结果对象
   */
  async _uploadAfterReplace(svc, code, name, opts) {
    const o = opts || {}
    const t0 = Date.now()
    let attempt = 0
    let last = null
    let tries = 0
    for (;;) {
      tries++
      const r = await svc.adapter.upload(svc.acct, code, name)
      if (r && r.success) {
        if (tries > 1) this.log(`服务端重载完成，第 ${tries} 次上传成功：${name}`, '灌入')
        return r
      }
      last = r
      if (!(r && r.message && /已存在/.test(r.message))) return last
      const delay = replaceRetryDelay(attempt, Date.now() - t0, o)
      if (delay == null) {
        this.log(`服务端仍报「已存在」（已轮询 ${Date.now() - t0}ms / ${tries} 次），改用改名上传兜底：${name}`, '灌入', 'warn')
        return last
      }
      await sleep(delay)
      attempt++
    }
  }

  /**
   * 改名上传（规避服务端 generateId 撞名）：撞名就换名重试，最多 4 次。
   * 传 svc 而不是 acct：多平台灌入时改名必须打到「当时那个」账号上，
   * 用 this._active() 会一律打到当前选中账号，把第二个平台的音源灌错地方。
   */
  async _uploadRenamed(svc, code, baseName, serverByName, used) {
    // 安全阀：脚本若自己校验名字，改名会把它改成「初始化失败」的坏源 —— 宁可不灌，
    // 也不要在服务端留一条看起来正常、实际跑不起来的音源（用户无从分辨）。
    const origName = (extractMeta(code) || {}).name || ''
    if (renameSelfCheck(code, origName)) {
      this.log(`跳过改名：脚本「${origName || baseName}」内部会校验自身名称，改名会让它初始化失败`, '灌入', 'warn')
      return {
        success: false,
        renameUnsafe: true,
        message: `该脚本内部校验自身名称（@name 被引用 ${String(origName || baseName)}），改名会让它初始化失败 → 未改名上传。` +
          '处理办法：到设置里保持「同名自动替换」开启（先删旧再传新），或先手动删掉服务端上的同名音源再灌入'
      }
    }
    let newName = this._uniqueRename(baseName, serverByName, used)
    for (let attempt = 0; attempt < 4; attempt++) {
      const renamed = renameScriptContent(code, newName)
      const ur = await svc.adapter.upload(svc.acct, renamed, newName)
      if (ur.success) return ur
      if (ur.message && /已存在/.test(ur.message)) { newName = this._uniqueRename(baseName, serverByName, used); continue }
      return ur
    }
    return { success: false, message: '改名后仍上传失败（已存在）' }
  }

  /** 巡检里启用/禁用音源的「安全开关」：服务端请求异常（超时/网络抖动）只记日志，不连累整轮巡检崩溃 */
  async _safeToggle(cfg, id, enabled, what, owner) {
    try {
      const svc = this._active()
      const t = await svc.adapter.toggle(svc.acct, id, enabled, { owner })
      if (!t.success) this.log(`巡检${what}失败：${t.message || '服务端未确认'}（不影响其他音源）`, '巡检', 'warn')
      return t
    } catch (err) {
      this.log(`巡检${what}请求异常：${String((err && err.message) || err).slice(0, 80)}（不影响其他音源）`, '巡检', 'warn')
      return { success: false, message: String((err && err.message) || err) }
    }
  }

  /**
   * 巡检里「停用/启用」的更安全的替代实现：
   * 走服务端 update-platforms（只改 states.json，不触发 initUserApis 全量重载），
   * 这样巡检连续禁用多个源也不会把 LX 服务端拖垮/卡死；老版本服务端没有该接口时自动退回 toggle。
   *
   * @param owner 源的归属身份（list 返回的 owner 字段）：admin 私有源的停用必须写
   *   admin 身份那份 states 才生效（它只以 admin 身份参与取歌）；公开源写 default（_open）。
   *   不传按公开源处理。
   */
  async _safePlatforms(cfg, id, disabledSources, what, owner) {
    try {
      const svc = this._active()
      const t = await svc.adapter.setPlatforms(svc.acct, id, disabledSources, { owner })
      if (!t.success) this.log(`巡检${what}失败：${t.message || '服务端未确认'}（不影响其他音源）`, '巡检', 'warn')
      return t
    } catch (err) {
      const msg = String((err && err.message) || err)
      // 老服务端无此接口 → 退回正式开关（有重载风险，但保留可用性）
      if (/HTTP 40[0-9]|不存在|not found/i.test(msg)) {
        this.log(`巡检${what}：服务端不支持平台级接口，退回正式开关`, '巡检', 'warn')
        return await this._safeToggle(cfg, id, !disabledSources.length, what, owner)
      }
      this.log(`巡检${what}请求异常：${msg.slice(0, 80)}（不影响其他音源）`, '巡检', 'warn')
      return { success: false, message: msg }
    }
  }

  /**
   * 巡检期服务端写操作串行化队列（v1.9.1，缓解巡检把 lxserver 打假死）。
   * 全部「禁用 / 启用 / 删除」服务端动作都收口到这条串行链，绝不同时发多个写请求：
   *  - delete 会触发服务端全量重载脚本；v1.6.8 教训——并发 delete 直接把 Docker 拖到重启；
   *  - 故 delete（kind='delete'）前后都强制 serverDeleteIntervalMs（默认 5s）间隔，让服务端消化。
   * 非重操作（disable/enable）仅串行执行、不额外加间隔，避免几十个源巡检拖到几十分钟。
   * 链内每个动作独立 try；单个失败不阻断后续（链尾 absorb 错误）。
   * @param {'disable'|'enable'|'delete'} kind
   */
  async _patrolEnqueueServerWrite(kind, fn) {
    if (!this._patrolWriteChain) this._patrolWriteChain = Promise.resolve()
    const cfg = this.store.config
    const gap = Number(cfg.serverDeleteIntervalMs) > 0 ? Number(cfg.serverDeleteIntervalMs) : 5000
    const prevHeavy = !!this._patrolPrevHeavy         // 上一个入队动作是否为重操作（delete）
    const heavy = kind === 'delete'
    this._patrolPrevHeavy = heavy                       // 记录本动作，供下一个动作判断「上一个是否重」
    const run = async () => {
      // 本次或上次是重操作 → 先歇 gap，给服务端喘口气再发下一个写请求
      if (heavy || prevHeavy) await new Promise(r => setTimeout(r, gap))
      return await fn()
    }
    const p = this._patrolWriteChain.then(run, run)
    // 链尾 absorb 错误，避免一个动作失败把后续动作全部 reject 掉
    this._patrolWriteChain = p.then(() => {}, () => {})
    return p
  }

  /** 为「同名不同内容」生成不与服务端撞名的展示名（用于改名上传） */
  _uniqueRename(baseName, serverByName, used) {
    const orig = normName(baseName)
    for (let i = 2; i <= 999; i++) {
      const cand = `${baseName}（副本${i}）`
      const k = normName(cand)
      if (k !== orig && !serverByName[k] && !used.has(k)) { used.add(k); return cand }
    }
    return `${baseName}（副本${Date.now()}）`
  }

  // ---------------- 健康巡检 ----------------
  /**
   * 定期重测已灌入的音源：
   *  - 脚本下载失败/仓库 404 → 已彻底失效，可判定（404 才自动禁用，网络抖动不误杀）
   *  - 沙箱能加载但五平台全部取链失败 → 失效，按配置自动禁用
   *  - 沙箱跑不起来（如需要原生 VM）→ 无法判定，不动
   *  - 之前因巡检失效被禁用、现在恢复可用 → 自动重新启用
   */
  async runPatrol() {
    this.batchId = Date.now().toString(36).slice(-6)
    this.jobGate('巡检')
    // v1.10.8 jobGate 竞态修复：与正式初始化之间隔着服务端列表拉取（网络可达数秒），先同步占位；
    // 占位后所有提前 return / throw 路径都必须回滚，否则任务卡死（下方两处已覆盖）。
    this.job = { running: true, type: 'patrol', cancel: false, progress: {}, step: '准备中' }
    const cfg = this.store.config
    const svc = this._active()
    let serverList = []
    try { serverList = await svc.adapter.list(svc.acct) } catch (e) {
      this.job = { running: false, type: '', cancel: false, progress: {}, step: '' }
      throw new Error('无法读取服务端音源列表：' + String((e && e.message) || e))
    }
    const aliveLxIds = new Set((serverList || []).map(s => s && s.id).filter(Boolean))
    // 源的归属身份：admin 私有源的停用必须写 admin 那份 states（v1.6.7）
    const ownerById = new Map((serverList || []).map(s => [s && s.id, s && s.owner]).filter(([id]) => !!id))
    // 身份口径自检：admin 等身份写的平台停用，LX 端用公开列表查看时看不到（假性不同步）
    const idNote = identityMismatch(cfg, serverList)
    if (idNote) this.log(idNote, '巡检', 'warn')
    const pid = svc.acct && svc.acct.id
    const items = buildPatrolItems(this.store.imported, this.store.db.sources, aliveLxIds, pid, cfg.activePlatformId)
    // 私人音源由 buildPatrolItems 整体排除；这里只做一次可见提示，避免用户以为「巡检漏了我的源」。
    const privateSkipped = Object.keys(this.store.imported || {})
      .filter(srcId => { const e = this.store.db.sources[srcId]; return e && e.private }).length
    if (privateSkipped) this.log(`已跳过 ${privateSkipped} 个私人音源（不参与巡检，可在音源库手动检测）`, '巡检')
    if (!items.length) {
      this.job = { running: false, type: '', cancel: false, progress: {}, step: '' }  // 占位回滚（提前返回路径）
      this.log('没有可巡检的已灌入音源（仅支持「本工具灌入且本地有对应记录」的音源）', '巡检', 'warn')
      return { ok: 0, disabled: 0, unknown: 0, total: 0 }
    }

    // 巡检并发刻意压得比主检低：几十个聚合源同时重测，打到的是同一批后端接口，
    // 并发太高会把对方打到限流，整批「全平台失败」，看起来就像集体失效。
    // 注意：日志里必须写这个真实值（曾经写死 Math.min(8,…) 而实际跑 3，纯文案误导）。
    const conc = Math.max(1, Math.min(3, cfg.concurrency || 8))
    this.job = { running: true, type: 'patrol', cancel: false, progress: { done: 0, total: items.length, ok: 0, disabled: 0 }, step: '' }
    this.emit('job', { running: true, type: 'patrol' })
    this.log(`开始健康巡检：${items.length} 个已灌入音源（并发 ${conc}，快速体检：每个源测到第一个可用平台即停）…` +
      '注意：快速体检只回答「还能不能用」，未测平台不计入平台数，所以巡检后的平台数是体检下限；' +
      '要看准确平台数请跑「深度检测（打分）」', '巡检')
    this.mirrorPref = null
    // 巡检期服务端写操作串行化（v1.9.1）：每条写请求走同一条链，delete 前后保持
    // serverDeleteIntervalMs 间隔，避免把 lxserver 打假死（即本次 bug 连带的二次事故）
    this._patrolWriteChain = null
    this._patrolPrevHeavy = false
    let idx = 0, ok = 0, disabled = 0, unknown = 0, reEnabled = 0, deleted = 0

    const worker = async () => {
      while (true) {
        if (this.cancelRequested) return
        const i = idx++
        if (i >= items.length) return
        const { srcId, e, rec, lxId } = items[i]
        const name = rec.name || e.scriptName || e.name
        e.checking = true
        this.emit('source-updated', e)
        this.step(`巡检 ${i + 1}/${items.length} ${name}`)
        let verdict = 'unknown'
        let note = ''
        let suspectTag = false   // 「疑似失效」：与「无法判定（网络原因）」在日志里分开说，避免用户看不懂
        // 2026-11-23：巡检发现已灌入的恶意 hash 源 → 记安全告警（不改 dead 判定闭环，隔离走 sourceGuard）。
        if (isMaliciousHash(e.contentHash)) {
          this.log(`安全告警：巡检命中恶意脚本指纹，已灌入源应隔离：${name}（sha=${String(e.contentHash).slice(0, 12)}）`, '巡检', 'warn')
        }
        // 本轮 patrolJudge 实际使用的判死阈值（版权类会被放宽到 4）。下方删除判定要用，
        // 故必须在 try 外声明 —— j 本身是 try 内的块级常量，catch 路径拿不到。
        let judgeNeed = 0
        try {
          const { code } = await checkBasic(e, cfg, (t, p) => this.emit(t, p), this.mirrorPref)
          if (e.fetchMirror) this.mirrorPref = e.fetchMirror
          // v1.9.11：接口域名存活遥测（需开启 cfg.apiHostCheck）。后端域名全挂 = 音源基本失效，
          // 提前累计 apiDownStreak，供下方 apiDownVerdict 在后端已死时直接判死（不待深检误判）。
          if (cfg.apiHostCheck && e.status === 'ok' && code) {
            try { await probeApiHosts(e, cfg) } catch (_) {}
          }
          if (e.status !== 'ok' || !code) {
            const errText = e.error || ''
            // Q3（2026-11-23）：只有"全候选 404/410"才判 dead（all-gone），
            // 单一镜像 404 不再直接判死——它现在会继续试下一条通道（net.js 收敛）。
            if (/ALL_GONE|HTTP 404|HTTP 410/.test(errText)) { verdict = 'dead'; note = '脚本全通道 404/410，已被删除（' + errText + '）' }
            else { verdict = 'unknown'; note = '脚本下载失败（' + (errText || '网络异常') + '），不判定' }
          } else if (!e.suspected) {
            verdict = 'dead'; note = '脚本内容已不是洛雪音源'
          } else {
            const prevUsable = !!e.usable
            const contentChanged = !!(rec.contentHash && e.contentHash && rec.contentHash !== e.contentHash)
            // 近 7 天内手动检测已给出「全平台失败且非网络原因」的铁证（内容未变）时，
            // 视为已有 1 次连续失败：巡检再失败即达阈值。否则像 fish_music 这种
            // 手动检测都确证取不到链的源，还要再等一整轮巡检才能禁用。
            let prevStreak = Number(rec.patrolFailStreak) || 0
            const d0 = e.deep
            const manualPriorFail = !!(d0 && !e.usable && d0.failKind === 'dead' &&
              d0.hash && d0.hash === e.contentHash &&
              d0.checkedAt && (Date.now() - d0.checkedAt < 7 * 24 * 3600 * 1000))
            if (manualPriorFail && prevStreak === 0) prevStreak = 1
            const d = await deepCheck(e, code, cfg, (t, p) => this.emit(t, p), () => this.cancelRequested)
            const j = patrolJudge(d, { prevStreak, threshold: cfg.patrolDisableAfter, updated: contentChanged })
            judgeNeed = Number(j.need) || 0
            if (j.streak != null) rec.patrolFailStreak = j.streak
            suspectTag = j.verdict === 'suspect'
            verdict = j.verdict === 'suspect' ? 'unknown' : j.verdict
            note = j.note
            // 巡检结论落库。特例：主检可用、脚本内容没变、这次只是「疑似失效/网络原因」——
            // 保留主检结果，免得一次限流就把库里的「可用」翻成「不可用」（服务端动作由 streak 把关）。
            const keepPrevUsable = !contentChanged && prevUsable && (j.verdict === 'suspect' || (j.verdict === 'unknown' && !d.cancelled))
            if (!keepPrevUsable && !d.cancelled) {
              // 巡检同样不继承分数：这一轮是快速模式（depth=quick），
              // 跑完就该回到「未打分」，而不是拿 N 天前的 p50 继续排。
              e.deep = d
              this._mergeUpdateTips(e, d.updateTips)   // P-1432：巡检取链也嗅探更新信号，别漏巡检路径
              e.usable = usableCount(d) > 0
            }
            // 保留主检结果时 updateTips 仍要合并——信号在响应里出现与可用性判定无关
            else if (d.updateTips && d.updateTips.length) this._mergeUpdateTips(e, d.updateTips)
            if (keepPrevUsable) note += '；库内保留主检的可用结果'
            applyProbeRecord(e, e.deep)   // v1.9.9：巡检也刷新探针记录/validTier
          }
        } catch (err) {
          const msg = String((err && err.message) || err)
          if (msg === '已取消') { verdict = 'unknown'; note = '已取消' }
          else { verdict = 'unknown'; note = '检测异常：' + msg.slice(0, 80) }
        }
        // v1.9.11：接口域名存活信号优先。后端域名连续全部不可达 = 音源大概率失效，
        // 即便深检因网络抖动偶发可用也不掩盖；后端已恢复则 probeApiHosts 已把 apiDownStreak 清零。
        if (cfg.apiHostCheck && note !== '已取消') {
          const av = apiDownVerdict(e, cfg)
          if (av) {
            if (av.verdict === 'dead' && verdict !== 'ok') {
              verdict = 'dead'; note = av.note; suspectTag = false
              rec.patrolFailStreak = av.streak
            } else if (verdict !== 'ok' && verdict !== 'dead') {
              verdict = 'unknown'; note = av.note; suspectTag = av.verdict === 'suspect'
            }
          }
        }
        delete e.checking
        rec.lastPatrol = { at: Date.now(), ok: verdict === 'ok', note: String(note).slice(0, 160) }
        if (verdict === 'ok') {
          ok++
          rec.patrolFailStreak = 0
          if (rec.disabledByPatrol) {
            // 重新启用走「平台级」接口（不触发服务端全量重载）；收口到串行队列降低对服务端冲击
            const t = await this._patrolEnqueueServerWrite('enable', () => this._safePlatforms(cfg, lxId, [], '重新启用', ownerById.get(lxId)))
            if (t.success) { delete rec.disabledByPatrol; reEnabled++; this.log(`巡检恢复正常，已重新启用：${name}`, '巡检') }
          }
        } else if (verdict === 'dead') {
          // 自动删除优先于自动禁用：开启 patrolAutoDelete 且连续失效达阈值时，从服务端+本地一并移除。
          // 本地未灌入服务端（无 lxId / 服务端已不存在）的源不删，只禁用。
          // 私人音源（v1.10.0）绝不自动删除：用户手动导入的个人源，失效了也只禁用，本体留在库里。
          // （服务端侧删除同样跳过——私人源常由用户直接在平台上维护，自动删容易误伤。）
          const streak = Number(rec.patrolFailStreak) || 0
          // 「禁用先于删除」红线（index.html 巡检设置区明示）：能进删除分支的源，必须在前一轮
          // 就已经被判死并禁用过 —— 即本轮 streak 要**严格大于**本轮实际判死阈值。
          // v1.18 批次D 起版权/会员类失败的判死阈值从 2 放宽到 4，而 patrolDeleteAfter 默认仍是 3；
          // 若只看配置值，版权类源会在 streak=4「首次判死」那一轮 4>=3 直接删除（不可逆），
          // 从未被禁用过。故删除线取 max(配置删除线, 判死线+1)。
          // 非版权类 need=2 → max(3,3)=3，与原行为完全一致（无回归）。
          // judgeNeed=0（下载失败/内容非音源/apiDown 等不经 patrolJudge 的判死路径）时
          // 退回原口径，不额外收紧。
          const effNeed = judgeNeed > 0
            ? Math.max(Number(cfg.patrolDeleteAfter) || 3, judgeNeed + 1)
            : (Number(cfg.patrolDeleteAfter) || 3)
          // !e.private 为纵深防御：buildPatrolItems 已在队列层把私人源全部排除，
          // 这里再守一次，防止将来有人从别的入口直接塞条目进来时被误删。
          const wantDelete = patrolAutoDeleteWanted(cfg, streak, effNeed) && !e.private
          if (wantDelete) {
            try {
              const r = await this._patrolEnqueueServerWrite('delete', async () => {
                const s = this._active()
                return await s.adapter.remove(s.acct, lxId, { owner: ownerById.get(lxId) })
              })
              if (r && r.success) {
                delete this.store.imported[srcId]
                if (this.store.db.sources[srcId]) delete this.store.db.sources[srcId]
                // 删除成功必须立即落盘：紧接着就把本地记录删了，崩溃丢盘会让源「复活」。
                this.store.saveImported(); this.store.saveDb()
                this._lastThrottledSave = Date.now()   // 同步节流水位，避免下一条立刻又写一次
                deleted++
                this.log(`巡检连续 ${streak} 次失效，已按配置自动删除音源：${name} — ${note}`, '巡检', 'warn')
              } else if (r && r.message) {
                this.log(`巡检失效需自动删除，但服务端删除失败：${name} — ${r.message}（本次仍按禁用处理）`, '巡检', 'warn')
              }
            } catch (err) {
              this.log(`巡检失效需自动删除，但请求异常：${String((err && err.message) || err).slice(0, 80)}（${name}）`, '巡检', 'warn')
            }
            // 删除成功 → 本地记录已删，无需再禁用；失败 → 退化为禁用，保证状态有反馈
            if (this.store.imported[srcId]) {
              const t = await this._patrolEnqueueServerWrite('disable', () => this._safePlatforms(cfg, lxId, ['wy', 'tx', 'kw', 'kg', 'mg'], '自动禁用', ownerById.get(lxId)))
              if (t.success) { disabled++; rec.disabledByPatrol = true; this.log(`巡检失效，已自动禁用：${name} — ${note}`, '巡检', 'warn') }
              else if (t.message) this.log(`巡检失效，但自动禁用失败：${name} — ${t.message}`, '巡检', 'warn')
            }
          } else if (cfg.patrolAutoDisable !== false) {
            const t = await this._patrolEnqueueServerWrite('disable', () => this._safePlatforms(cfg, lxId, ['wy', 'tx', 'kw', 'kg', 'mg'], '自动禁用', ownerById.get(lxId)))
            if (t.success) { disabled++; rec.disabledByPatrol = true; this.log(`巡检失效，已自动禁用：${name} — ${note}`, '巡检', 'warn') }
            else if (t.message) this.log(`巡检失效，但自动禁用失败：${name} — ${t.message}`, '巡检', 'warn')
          } else {
            this.log(`巡检失效：${name} — ${note}`, '巡检', 'warn')
          }
        } else {
          unknown++
          this.log(`${suspectTag ? '巡检疑似失效' : '巡检无法判定'}：${name} — ${note}`, '巡检', 'warn')
          // 「无法判定」（网络原因/加载失败）≠ 失效：之前因巡检被禁、这轮又无法确认失效的，
          // 恢复启用。过去只有「确认可用」才恢复，历史误禁的源可能永远出不了黑名单。
          // 「疑似失效」（streak 在涨）仍保持禁用，等下一轮确认。
          if (!suspectTag && rec.disabledByPatrol) {
            const t = await this._patrolEnqueueServerWrite('enable', () => this._safePlatforms(cfg, lxId, [], '恢复启用', ownerById.get(lxId)))
            if (t.success) { delete rec.disabledByPatrol; reEnabled++; this.log(`巡检无法确认失效，已恢复启用：${name}`, '巡检') }
          }
        }
        this.emit('patrol-item', { id: e.id, name, verdict, note })
        this.emit('source-updated', e)
        this.progress({ done: i + 1, total: items.length, ok, disabled })
        // 每条都双写 db+imported 是 17MB 全量写盘瓶颈；节流到最多每 60s 一次，
        // 收尾（下方）强制写保证最终一致。服务端动作已 await 生效，不受本地写盘延后影响。
        this._savePatrolProgressThrottled()
      }
    }
    await Promise.all(Array.from({ length: conc }, () => worker()))
    this.store.saveDb(); this.store.saveImported()
    // 合并而非整体覆盖：调度器会往 patrol 写 lastAttempt / lastError（失败退避水位），
    // 这里若整体赋值会把它们抹掉，导致下一轮又回到「失败不推进水位」的老问题。
    this.store.db.patrol = Object.assign({}, this.store.db.patrol, {
      lastRun: Date.now(), lastAttempt: Date.now(), lastError: null,
      total: items.length, ok, disabled, unknown, reEnabled, deleted, cancelled: this.cancelRequested
    })
    this.store.saveDb()
    const stillDisabled = Object.values(this.store.imported || {}).filter(r => r && r.disabledByPatrol).length
    this.log(this.cancelRequested
      ? '巡检已取消（已完成部分保留）'
      : `巡检完成：正常 ${ok}${reEnabled ? `（含恢复启用 ${reEnabled}）` : ''}、失效禁用 ${disabled}${deleted ? `、自动删除 ${deleted}` : ''}、无法判定 ${unknown} / 共 ${items.length}` +
        (stillDisabled ? `；仍有 ${stillDisabled} 个源处于巡检停用，可在「已灌入」页单个恢复或点「全部恢复启用」` : ''), '巡检', this.cancelRequested ? 'warn' : 'info')
    // v1.13.2：巡检收尾顺手对齐一次「服务端处置」冻结表。
    // 巡检开头本来就拉过服务端列表（serverList），这里**不再发请求**，纯本地重算 + 一次落库。
    // 意义：用户在网页上恢复平台 / 解除隔离后，最迟下一轮巡检就能反映，
    // 不用等到下一次灌入（默认 24h）才更新冻结表。
    try {
      await this._refreshServerVeto(
        [{ svc, label: (svc.acct && (svc.acct.name || svc.acct.url)) || '', serverList }],
        cfg.activePlatformId
      )
    } catch (e) { /* 冻结表刷新失败不影响巡检结论 */ }
    // P-1433（联动测试报告问题 2 主路径）：巡检收尾顺带对账——账本对账此前只在
    // 「灌入/手动同步」时发生，服务端删源（网页手动 / lxserver 巡检移 .trash/）后
    // 账本最长漂移 24h+（2026-11-16 实测：账本声称 17950 有 45 条、实际缺 4 条）。
    // 巡检开头本来就拉过 serverList，这里纯本地重算 + 一次落库，零新增请求。
    // P-1433 补充（doujs 复核意见第五节，2026-11-16 采纳）：空列表安全阀——
    // listAs 在「HTTP 200 + 响应非数组」时静默返回 []（lxservice.js:62，认证/响应
    // 结构异常的常见形态；网络级失败会抛错中断巡检、反而安全）。巡检若拿空列表
    // 对账会把该平台账本整本清空（45 条正文档案 + P-1411 打分快照不可恢复）。
    // 巡检路径无用户意图兜底 → 一律保守跳过并告警；「服务端真被清空」的对账
    // 走灌入/手动同步路径（那里有用户意图，语义上允许清）。
    const patrolLiveIds = (serverList || []).map(x => x && x.id).filter(Boolean)
    try {
      if (!Array.isArray(serverList) || patrolLiveIds.length === 0) {
        this.log('巡检对账跳过：服务端列表为空，疑似认证/响应异常（防误清账本）', '巡检', 'warn')
      } else {
        const rc = this.reconcileImported(cfg.activePlatformId, patrolLiveIds)
        if (rc.changed) {
          this.store.saveImported()
          this.log(`巡检账本对账：摘除 ${rc.dropped} 条服务端已不存在的灌入记录`, '巡检', 'info')
        }
      }
    } catch (e) { /* 对账失败不影响巡检结论 */ }
    // P-1432 补漏第二处：巡检取链捕获的 updateTips 只在 _mergeUpdateTips 合并了，
    // 追更动作（拉 updateUrl 入库）此前只挂在 runCheck 收尾——巡检是 updateTip 捕获
    // 的高频路径（12h 全量 aliveLxIds），这里不跟进的话信号要等下一轮检测才被处理。
    if (cfg && cfg.autoFollowScriptUpdate !== false && !this.cancelRequested) {
      try { await this._followUpdateTips(cfg) } catch (e) { /* 追更失败不影响巡检结论 */ }
    }
    this.job.running = false
    this.emit('job', { running: false, type: 'patrol', done: true, cancelled: this.cancelRequested, summary: { total: items.length, ok, disabled, unknown, reEnabled, deleted } })
    return { ok, disabled, unknown, reEnabled, deleted, total: items.length }
  }

  // ---------------- 撤回 ----------------
  async runRevoke(ids) {
    const cfg = this.store.config
    const svc = this._active()
    // 撤回也要按 owner 路由删除身份：灌入记录若带 owner（同步服务端时记下），
    // 私有源删归属身份那份；v1.6.8 起新灌入都是公开源，走 default
    let serverOwners = new Map()
    try {
      const list = await svc.adapter.list(svc.acct)
      serverOwners = new Map((list || []).map(s => [s && s.id, s && s.owner]).filter(([id]) => !!id))
    } catch (e) { /* 读不到列表时按 default 处理（服务端有回退 open 的兜底） */ }
    const results = []
    for (const id of ids || []) {
      const rec = this.store.imported[id]
      if (!rec || !rec.lxId) {
        results.push({ id, status: 'failed', message: '无本地灌入记录，请到服务端手动删除' })
        continue
      }
      // 多平台灌入（v1.8.0）后同一音源可能落在多个账号上：撤回只动「当前账号」那份，
      // 别的账号上的同名音源不能顺手删掉（用户没要求，且那边的服务端状态未知）。
      const belongs = rec.platformId === svc.acct.id ||
        (Array.isArray(rec.importedTo) && rec.importedTo.some(x => x && x.platformId === svc.acct.id)) ||
        rec.platformId == null
      if (!belongs) {
        const where = (rec.importedTo || []).map(x => x.accountName).filter(Boolean).join('、') || '其他账号'
        results.push({ id, status: 'failed', name: rec.name, message: `该音源不是灌入到当前账号「${svc.acct.name || svc.acct.url}」的（在：${where}），请先切换到对应账号再撤回` })
        this.log(`撤回跳过：${rec.name} 不属于当前账号（在：${where}）`, '撤回', 'warn')
        continue
      }
      try {
        const r = await svc.adapter.remove(svc.acct, rec.lxId, { owner: serverOwners.get(rec.lxId) })
        if (r.success) {
          this._dropPlatformFromImported(id, svc.acct.id)
          this.store.saveImported()
          const still = this.store.imported[id]
          if (still) {
            const n = (still.importedTo || []).length
            results.push({ id, status: 'success', name: rec.name, message: `已从当前账号撤回（仍存在于另外 ${n} 个平台）` })
            this.log(`已撤回：${rec.name}（当前账号；其它平台仍保留 ${n} 份）`, '撤回')
          } else {
            results.push({ id, status: 'success', name: rec.name })
            this.log('已撤回：' + rec.name, '撤回')
          }
        } else {
          results.push({ id, status: 'failed', name: rec.name, message: r.message })
          this.log('撤回失败：' + rec.name + ' — ' + r.message, '撤回', 'warn')
        }
      } catch (e) {
        results.push({ id, status: 'failed', name: rec.name, message: String((e && e.message) || e).slice(0, 160) })
      }
    }
    return results
  }

  // ---------------- 同步服务端音源 ----------------
  /**
   * 把 LX MUSIC 服务端「已存在」的音源全部纳入管理，算作「已灌入」：
   *  - 与本地候选同名 → 标记该候选为已灌入（记录 lxId / 平台），音源库显示「已灌入」
   *  - 本地无对应脚本（服务端原生音源）→ 建占位条目纳入管理，音源库「已灌入」一栏可见、状态栏计数
   *  - 仅新增/匹配，不删除；服务端已不存在的同步记录会被清理，避免幽灵条目
   */
  async runSyncServer() {
    const cfg = this.store.config
    const svc = this._active()
    const v = await svc.adapter.verify(svc.acct)
    if (!v.ok) throw new Error('当前服务平台不可用：' + v.msg)
    let serverList = []
    try { serverList = await svc.adapter.list(svc.acct) } catch (e) {
      throw new Error('读取服务端音源列表失败：' + String((e && e.message) || e))
    }
    if (!serverList.length) {
      this.log('服务端没有音源，无需同步', '同步', 'info')
      return { total: 0, matched: 0, added: 0, pruned: 0, imported: 0 }
    }
    const serverByName = {}
    const serverIds = new Set()
    for (const s of serverList) {
      if (!s || !s.id) continue
      serverIds.add(s.id)
      if (s.name) serverByName[normName(s.name)] = s
    }
    const alreadyLx = new Set(Object.values(this.store.imported).map(r => r.lxId).filter(Boolean))
    // F1（可观测，不联动）：同步时把服务端条目状态写进账本增量字段 serverStatus/serverEnabled。
    // 只记录、不改 lastPatrol（那是本地实测口径）、不触发任何自动处置 —— 守「不误伤」红线。
    // 性能优化 v1.13.10：预建 lxId → rec[] 索引（含多账号 importedTo），把原来「每条服务端
    // 源都遍历整个 imported」的 O(n×m) 降为 O(n+m)。键用 String，与下方匹配口径一致。
    const recsByLxId = new Map()
    for (const [eid, rec] of Object.entries(this.store.imported)) {
      if (!rec) continue
      const ids = []
      if (rec.lxId != null) ids.push(String(rec.lxId))
      if (Array.isArray(rec.importedTo)) for (const x of rec.importedTo) if (x && x.lxId != null) ids.push(String(x.lxId))
      for (const k of new Set(ids)) {
        const arr = recsByLxId.get(k)
        if (arr) arr.push(rec); else recsByLxId.set(k, [rec])
      }
    }
    const syncServerState = (s) => {
      let touched = false
      const recs = recsByLxId.get(String(s.id))
      if (!recs) return false
      const status = s.status || ''
      const enabled = s.enabled !== false
      for (const rec of recs) {
        if (rec.serverStatus !== status || rec.serverEnabled !== enabled) {
          rec.serverStatus = status
          rec.serverEnabled = enabled
          touched = true
        }
      }
      return touched
    }
    let stateChanged = false
    // 身份口径自检（同上）：把「猎手显示停用、LX 端显示启用」的假性不同步在同步时就提示出来
    const idNote = identityMismatch(cfg, serverList)
    if (idNote) this.log(idNote, '同步', 'warn')

    // 性能优化 v1.13.10：预建「基准名 → 本地候选源」索引，把 5928 处每条服务端源
    // 全扫 getSources() 的 O(n×m) 降为 O(n+m)。只在循环外算一次快照。
    // 口径与原来完全一致：非占位、未废弃、normName(lxName||scriptName||name) 匹配。
    const localByName = new Map()
    for (const e of this.store.getSources()) {
      if (e.fromServer || e.deprecated) continue
      const nm = normName(e.lxName || e.scriptName || e.name)
      if (!localByName.has(nm)) localByName.set(nm, e)   // 同名取第一条，与 .find 语义一致（含空名）
    }
    let matched = 0, added = 0, pruned = 0
    for (const s of serverList) {
      if (!s || !s.id) continue
      const nm = normName(s.name)
      if (alreadyLx.has(s.id)) {
        // F1：状态只观测、不联动。发现服务端状态变了就落库，供界面/排查读取。
        if (syncServerState(s)) stateChanged = true
        matched++; continue
      }
      // 优先匹配本地候选（非占位、未废弃、同名）
      const local = localByName.get(nm)
      if (local) {
        this.store.imported[local.id] = {
          lxId: s.id, name: s.name, contentHash: local.contentHash || '',
          serverUrl: svc.adapter.baseUrl(svc.acct), importedAt: Date.now(),
          platforms: s.supportedSources || [], serverSynced: true,
          platformId: svc.acct.id, platformType: svc.type, accountName: svc.acct.name
        }
        local.lxId = s.id
        local.fromServerMatched = true
        matched++
      } else {
        // 服务端原生音源：建占位条目纳入管理。
        // sourceUrl 是它当年经 URL 导入时留存的原始脚本地址（upload 的没有），
        // 有地址的占位条目同样可以下载 + 沙箱检测（runCheck 已放行 fromServer 且有 url 的条目）
        const pid = 'srv:' + s.id
        // v1.10.2：用户手动删过的占位不再由同步复活。删占位时对应的 imported
        // 记录已一并摘掉，若这里照常重建，会表现为「删了又自己长回来」，
        // 也与 deletedIds（不再自动采集名单）的语义冲突。
        // 清除删除记录 / 导入音源库 JSON 解除名单后，同步可正常重新纳入。
        if (this.store.isDeleted(pid)) { matched++; continue }
        if (!this.store.db.sources[pid]) {
          this.store.db.sources[pid] = {
            id: pid, name: s.name, path: '', repo: '(服务端)', url: s.sourceUrl || '',
            fromServer: true, deprecated: false,
            status: s.status === 'failed' ? 'dead' : 'ok',
            scriptName: s.name, lxName: s.name, size: s.size || 0,
            supportedSources: s.supportedSources || [], lxId: s.id
          }
        } else if (!this.store.db.sources[pid].url && s.sourceUrl) {
          // 老占位条目没记过地址：补上，让它也获得可检测能力
          this.store.db.sources[pid].url = s.sourceUrl
        }
        if (!this.store.imported[pid]) {
          this.store.imported[pid] = {
            lxId: s.id, name: s.name, contentHash: '',
            serverUrl: svc.adapter.baseUrl(svc.acct), importedAt: Date.now(),
            platforms: s.supportedSources || [], serverSynced: true, serverNative: true,
            platformId: svc.acct.id, platformType: svc.type, accountName: svc.acct.name
          }
          added++
        }
        matched++
      }
    }
    // 清理：服务端已不存在、且由本工具同步产生的「已灌入」记录（手动灌入的保留）
    for (const [k, rec] of Object.entries(this.store.imported)) {
      if (rec && rec.serverSynced && rec.lxId && !serverIds.has(rec.lxId)) {
        delete this.store.imported[k]
        if (k.startsWith('srv:')) delete this.store.db.sources[k]
        pruned++
      }
    }
    // P1-3：服务端画像落盘（同源同步也刷新一次；只读展示，不驱动行为）。
    const srvProf = profileServerFleet(serverList, this.store.imported, this.store.db.veto)
    if (srvProf) this.store.db.serverFleetProfile = srvProf
    this.store.saveDb()
    this.store.saveImported()
    this.log(`同步服务端音源完成：服务端共 ${serverList.length} 个 → 本地匹配 ${matched} 个、新增占位 ${added} 个、清理失效 ${pruned} 个（全部算作「已灌入」）`, '同步', 'info')
    if (stateChanged) this.log('已把服务端状态（serverStatus/serverEnabled）同步到账本（仅记录，不改变巡检/处置口径）', '同步', 'info')
    return { total: serverList.length, matched, added, pruned, imported: Object.keys(this.store.imported).length }
  }
}

module.exports = { Hunter, normName, identityMismatch, formatIntervalHours, patrolSchedule, renameSelfCheck, versionNum, patrolAutoDeleteWanted, buildPatrolItems, buildRepoSeeds, rankRepoSeeds, replaceRetryDelay, REPLACE_UPLOAD_POLL_MS, DUP_REASON, DUP_REASON_MARK,
  // R9（v1.13.15）：追更链域名校验的纯函数（供测试直接验证，不依赖 Hunter 实例）
  checkUpdateTipUrl, knownHostsForEntry, checkUpdateTipHostBelongsTo, isSameSiteHost, isValidPublicHostShape,
  // R9（v1.13.15）：通配 DNS 封堵 + 解析后 IP 判定 + updateurl:: 硬规则的判定函数
  isWildcardDnsHost, WILDCARD_DNS_SUFFIXES, checkUpdateTipResolvedIp,
  isUpdateUrlEntry, preferRealSource, UPDATE_URL_ID_PREFIX }
