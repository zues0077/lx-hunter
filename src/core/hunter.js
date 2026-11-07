'use strict'
/** 任务编排：爬取 / 检测 / 灌入 / 撤回 */
const { crawl, DEFAULT_REPOS, normalizeRepo, discoverReposViaSearch, verifyRepoHasSource, resolveRepoRename } = require('./crawler')
const { crawlWebSite, isWebRepo } = require('./websource')
const { fetchCommunityRepos } = require('./community')
const { collectFromHubs } = require('./hubfeed')
const { checkBasic, deepCheck, extractMeta, sha256Str, usableCount, stoppable, isLocalNetworkIssue, patrolJudge, obfuscationRisk, obfuscationTip, applyProbeRecord, probeApiHosts, apiDownVerdict } = require('./checker')
const { crawlFetch, readText, sleep } = require('./net')
const { getActiveService, getService, getBatchImportAccounts, NO_ACCOUNT_ERR } = require('./services')
const { Store } = require('./store')

function normName(s) {
  return String(s || '').toLowerCase().replace(/[\[\]【】（）()|｜:：、,，.。\s_\-·•]+/g, '')
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
  if (rl) return rl.filter(r => r && r.enabled !== false).map(r => normalizeRepo(r.repo)).filter(Boolean)
  const out = DEFAULT_REPOS.slice()
  for (const r of (c.customRepos || [])) {
    const n = normalizeRepo(r)
    if (n && out.indexOf(n) === -1) out.push(n)
  }
  return out
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
function versionNum(s) {
  const m = String(s || '').match(/[vV]?(\d+(?:\.\d+)+)/)
  if (!m) return 0
  const parts = m[1].split('.')
  let v = 0
  for (let i = 0; i < Math.min(parts.length, 4); i++) v = v * 1000 + (parseInt(parts[i], 10) || 0)
  return v
}

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
 * @param {object} cfg 配置（含 patrolAutoDelete / patrolDeleteAfter）
 * @param {number} streak 连续失效次数（rec.patrolFailStreak）
 */
function patrolAutoDeleteWanted(cfg, streak) {
  if (!cfg || cfg.patrolAutoDelete !== true) return false
  const deleteThreshold = Number(cfg.patrolDeleteAfter) > 0 ? Number(cfg.patrolDeleteAfter) : 3
  return Number(streak) >= deleteThreshold
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
 * @returns {Array<{srcId:string, e:object, rec:object}>}
 */
function buildPatrolItems(imported, sources, aliveLxIds) {
  const alive = aliveLxIds instanceof Set ? aliveLxIds : new Set(aliveLxIds || [])
  const items = []
  for (const [srcId, rec] of Object.entries(imported || {})) {
    if (!rec || !rec.lxId || !alive.has(rec.lxId)) continue   // 服务端已不在（被手动删除）
    const e = (sources || {})[srcId]
    if (!e) continue
    if (e.private) continue                                   // v1.10.2：私人音源不参与巡检
    // 无脚本地址的跳过：手动灌入无本地记录，或服务端原生音源未留存 sourceUrl。
    // 本地存有正文（code）的非私人条目仍可直接复测，不跳过。
    if (!e.url && typeof e.code !== 'string') continue
    items.push({ srcId, e, rec })
  }
  return items
}

class Hunter {
  constructor(store, emit) {
    this.store = store
    this.emit = emit || function () {}
    this.job = { running: false, type: '', cancel: false, progress: {}, step: '' }
  }

  log(msg, module, level) {
    this.emit('log', { msg, module: module || '任务', level: level || 'info', at: Date.now() })
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

  async runCrawl(opts) {
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
            verifyConcurrency: 4
          })
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
    this.job = { running: true, type: 'crawl', cancel: false, progress: { reposDone: 0, repoTotal: repos.length, added: 0, linksFound: 0 }, step: '' }
    this.emit('job', { running: true, type: 'crawl' })
    this.log((onlyRepos.length ? '主动采集' : incremental ? '定时增量爬取' : '开始爬取') + ` ${repos.length} 个仓库（文件树 + Releases）…`, '爬取')
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
      // 网页音源站采集（v1.10.0）：与 GitHub 爬取并列的一类仓库来源
      if (webRepos.length) {
        for (let wi = 0; wi < webRepos.length; wi++) {
          if (this.cancelRequested) break
          const site = webRepos[wi]
          this.step(`采集网页音源站 ${wi + 1}/${webRepos.length} ${site}`)
          this.progress({ reposDone: ghRepos.length + wi + 1, repoTotal: repos.length })
          try {
            await crawlWebSite(site, { timeoutMs: cfg.timeoutMs, latestOnly }, onCrawlEvent, () => this.cancelRequested)
          } catch (e) {
            this.log(`网页音源站 ${site} 采集异常：` + String((e && e.message) || e).slice(0, 100), '爬取', 'warn')
          }
        }
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
      this.log('爬取异常：' + String((e && e.message) || e), '爬取', 'error')
    } finally {
      this.job.running = false
      this.emit('job', {
        running: false, type: 'crawl', done: true,
        summary: Object.assign({ incremental }, merge)
      })
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
    const targets = getBatchImportAccounts(cfg)
    const tids = targets.map(a => a && a.id).filter(Boolean)
    const activeId = cfg.activePlatformId || null
    const ids = this.store.getSources()
      .filter(e => !e.deprecated && e.usable && (e.url || typeof e.code === 'string'))
      .filter(e => !this._importedEverywhere(e.id, tids, activeId))
      .map(e => e.id)
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
  _importedEverywhere(eid, targetIds, activeId) {
    if (!targetIds || !targetIds.length) return false
    const rec = this.store.imported[eid]
    if (!rec) return false
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
        d.dupReason = dropDead && keepOk ? '同名版本（此版本已失效）'
          : kind === 'oldVersionUpdated' ? '同名旧版本（已有更新版本）'
            : '同名旧版本'
      } else {
        d.dupReason = kind === 'dupContent' ? '同内容重复' : '同仓库同名重复'
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
    // ② 同名旧版本（以 @name 为准，内容不同视为版本迭代）
    //    同样的弱文件名守卫：「6」「index」这类名字不构成音源身份，不能拿来判版本
    //    门槛放宽到「有内容哈希」（不限 status=ok，v1.7.0）：增量爬取刚更新的条目
    //    检测结果已重置（status=unknown），但内容确实是新版本，要能立刻参与同名裁决，
    //    否则「内容更新」永远排在旧版后面，用户要求的更新添加不生效。
    const byName = {}
    for (const e of all) {
      if (e.deprecated || e.fromServer || e.private || !e.contentHash) continue
      const nm = normName(e.lxName || e.scriptName || e.name)
      if (!nm) continue
      if (isWeakBaseName(nm)) { weakSkipped++; continue }
      if (!byName[nm]) { byName[nm] = e; continue }
      const keep = this.betterKeeper(e, byName[nm]) ? e : byName[nm]
      const drop = keep === e ? byName[nm] : e
      dep(drop, keep, keep.updated ? 'oldVersionUpdated' : 'oldVersion'); res.oldVersion++
      byName[nm] = keep
    }
    // ②b 检测后的同名二次裁决（v1.7.0 按用户要求：同名内容更新以接口可用度选择）：
    //    检测前的占位裁决可能凭「有更新」留了新版、废了旧版；若新版深检确认失效，
    //    这里翻案——恢复旧版为候选、废弃新版。旧版若已有实测可用结果则同时恢复 usable。
    //    （检测只跑非 deprecated 条目，所以旧版是否真能用要看它既有 deep；
    //      没有实测就先恢复成候选，下轮检测再定。）
    for (const e of all) {
      if (!e.deprecated || e.fromServer || e.private || e.dupReason !== '同名旧版本（已有更新版本）') continue
      const keeper = e.dupOf ? all.find(x => x.id === e.dupOf) : null
      if (!keeper || keeper.deprecated || keeper.private || !keeper.contentHash || keeper.contentHash === e.contentHash) continue
      // 只有保留方实测确认失效（深检 0 平台）才翻案；没深检过或还可用则维持原裁决
      if (!(keeper.deep && keeper.deep.checkedAt && usableCount(keeper) === 0)) continue
      e.deprecated = false; e.dupOf = null; e.dupReason = null
      e.usable = !!(e.deep && e.deep.checkedAt && usableCount(e) > 0)
      keeper.deprecated = true; keeper.dupOf = e.id
      keeper.dupReason = '同名版本（此版本已失效）'; keeper.usable = false
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
    if (res.dupContent || res.oldVersion || res.dupFile) {
      this.store.saveDb()
      this.log(`去重完成：废弃同内容 ${res.dupContent} 条、同名旧版本 ${res.oldVersion} 条、同仓库同名 ${res.dupFile} 条` +
        (weakSkipped ? `（弱文件名 ${weakSkipped} 条不按名判重，留待指纹确认）` : ''), '去重')
    }
    return res
  }

  /** 撤销去重：把所有被判为重复的条目恢复为候选（不删检测结果，不删已灌入记录） */
  restoreDedupe() {
    const all = this.store.getSources()
    let n = 0
    for (const e of all) {
      if (!e.deprecated) continue
      e.deprecated = false
      e.dupOf = null
      e.dupReason = null
      n++
    }
    if (n) {
      this.store.saveDb()
      this.log(`已撤销去重：恢复 ${n} 条候选（检测结果与已灌入记录均保留，可重新去重或重新检测）`, '去重', 'info')
    }
    return { restored: n, total: all.length }
  }

  /**
   * 同名/同内容条目的取舍（v1.7.0 按用户要求改为「接口可用度优先」）：
   *  - 双方都深检过 → 可用平台多者留（同为 0 再比新旧，此时更新时间才有意义）
   *  - 一方实测可用、另一方没检测过 → 留实测可用的（不能凭「有更新」废掉能用版）
   *  - 一方实测确认失效（深检 0 平台）、另一方没检测过 → 让位给未检测的（可能是
   *    可用的新版本，等它检测完自然裁决；旧版确认死了留着也没意义）
   *  - 都没检测过 → 按「有更新 > 时间 > 版本号 > id」兜底（检测前先临时占位，
   *    检测完成后 runCheck 的同名即时去重会按上面三条重新裁决）
   */
  betterKeeper(a, b) {
    const da = a && a.deep && a.deep.checkedAt ? a.deep : null
    const db = b && b.deep && b.deep.checkedAt ? b.deep : null
    if (da && db) {
      const na = usableCount({ deep: da }), nb = usableCount({ deep: db })
      if (na !== nb) return na > nb
    } else if (da || db) {
      // 只有一方检测过：可用 > 未检测 > 确认失效
      const checked = da ? a : b, other = da ? b : a
      const checkedOk = usableCount(da ? { deep: da } : { deep: db }) > 0
      if (checkedOk) return checked === a
      if (other.updated || !other.deep) return other === a   // 未检测方优先
      return checked === a                                    // 对方也只是旧结果，保持
    }
    // 兜底：有更新的优先（用户要求的更新添加），其次时间、版本号、id
    if (!!a.updated !== !!b.updated) return !!a.updated
    const la = a.lastModified || 0, lb = b.lastModified || 0
    if (la !== lb) return la > lb
    const va = versionNum(a.scriptVersion || a.scriptName || a.name)
    const vb = versionNum(b.scriptVersion || b.scriptName || b.name)
    if (va !== vb) return va > vb
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
    for (const x of rl) {
      if (!x || x.origin === 'builtin') continue
      const n = normalizeRepo(x.repo)
      if (!n || seen.has(n)) continue
      seen.add(n); cands.push(n)
    }
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
          results[k] = { repo, v: await verifyRepoHasSource(repo, { token: cfg.ghToken, timeoutMs: cfg.timeoutMs }) }
        } catch (e) {
          results[k] = { repo, v: { ok: false, reason: 'ERR ' + String((e && e.message) || e) } }
        }
      }
    }))
    // 临时失败（限流/权限/网络）不算判定结果，绝不据此删东西
    const isTransient = (r) => /HTTP (403|429|5\d\d)|ERR |ECONN|timeout|abort/i.test(String(r || ''))
    const dead = results.filter(x => !x.v.ok && !isTransient(x.v.reason))
    const skipped = results.filter(x => !x.v.ok && isTransient(x.v.reason)).length

    // ①' 改名检测（v1.10.7）：GitHub 改名返回 301，旧名经重定向仍「能用」，验真判不死
    //    → 旧名条目会永远留在清单里重复爬取、白烧 API 配额（246 实测：luanmuc/lx-music-source
//    改名 backend-api 后新旧两条并存）。这里对每个候补做一次轻量探测（1~2 次调用）：
    //    新名已在清单（重复旧名）→ 自动移出旧名条目，历史音源保留不删脚本、不进黑名单；
    //    新名不在清单 → 只提示不自动改（避免误判）。任何探测失败都当没改名（宁漏不误）。
    const renameResults = new Array(batch.length)
    let ri = 0
    await Promise.all(Array.from({ length: Math.min(4, batch.length) }, async () => {
      while (true) {
        const k = ri++
        if (k >= batch.length) return
        try {
          renameResults[k] = await resolveRepoRename(batch[k], { token: cfg.ghToken, timeoutMs: cfg.timeoutMs })
        } catch (e) {
          renameResults[k] = { moved: false, to: '', error: String((e && e.message) || e) }
        }
      }
    }))
    const renamedRepos = []   // {from,to} 新名已在清单 → 已自动清理旧名条目
    const renameHints = []    // {from,to} 新名不在清单 → 仅提示
    for (let k = 0; k < batch.length; k++) {
      const rr = renameResults[k]
      if (!rr || !rr.moved || !rr.to) continue
      const from = batch[k]
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
    const deadSet = new Set(dead.map(x => String(x.repo).toLowerCase()))
    // ① 移出仓库清单
    const removedRepos = []
    this.store.config.repos = rl.filter(x => {
      const n = normalizeRepo(x && x.repo)
      if (n && deadSet.has(n.toLowerCase())) { removedRepos.push(n); return false }
      return true
    })
    // ② 删掉这些仓库贡献的脚本：不限 deprecated —— 旧版本副本同样是垃圾，统一删干净
    //    （removeSources 会记入 deletedIds，后续不会自动加回）
    const srcIds = []
    for (const e of this.store.getSources()) {
      if (!e) continue
      const r = normalizeRepo(e.repo)
      if (r && deadSet.has(r.toLowerCase())) srcIds.push(e.id)
    }
    if (srcIds.length) {
      const r = this.store.removeSources(srcIds)
      removedSources += (r && r.deleted) || 0
    }
    // ③ 黑名单：发现器/社区精选不再回填
    const blk = new Set((Array.isArray(this.store.config.blockedRepos) ? this.store.config.blockedRepos : [])
      .map(x => String(x || '').toLowerCase()).filter(Boolean))
    for (const r of removedRepos) blk.add(r.toLowerCase())
    this.store.config.blockedRepos = Array.from(blk)
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
  blockRepo(repo) {
    this.jobGate('拉黑仓库', String(repo || ''))
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
    this.store.saveConfig()
    this.store.saveDb()
    this.log(`已拉黑仓库 ${name}：${removedFromList ? '移出清单' : '本就不在清单'}、${alreadyBlocked ? '原本已在黑名单' : '加入黑名单'}、清理脚本 ${removedSources} 条（后续搜索发现/社区精选不再回填）`, '音源库', 'warn')
    return { blocked: name, removedFromList, alreadyBlocked, removedSources }
  }

  // ---------------- 检测 ----------------
  // 混淆隔离闸门（v1.10.7）：high 级混淆不再直接判死，而是移入「混淆隔离」区（status=quarantined），
  // 条目仍留在音源库中可见。用户在隔离页对「无恶意硬特征」的脚本点「信任」后，按 contentHash
  // 记入 cfg.trustedObfHashes，检测/灌入两道闸共用本函数放行；内容一变哈希就变，重新被隔离
  // ——信任不跟随未知的新版本。返回 {rejected, trusted}；codeOf 返回空串/null 表示拿不到脚本正文（放行）。
  applyObfGate(list, codeOf, phase) {
    const cfg = this.store.config
    if (!cfg.excludeHighRiskObfuscated) return { rejected: 0, trusted: 0 }
    const trustedHashes = Array.isArray(cfg.trustedObfHashes) ? cfg.trustedObfHashes : []
    const kept = []
    let rejected = 0
    let trusted = 0
    for (const e of list) {
      const code = codeOf(e)
      if (code) {
        const risk = obfuscationRisk(code)
        if (risk.level === 'high') {
          e.obfLevel = 'high'
          e.obfHits = risk.hits
          if (e.contentHash && trustedHashes.includes(e.contentHash)) {
            e.obfTrusted = true
            e.quarantined = false
            if (e.status === 'quarantined') e.status = 'ok'
            trusted++
            kept.push(e)
            continue
          }
          e.status = 'quarantined'
          e.quarantined = true
          e.usable = false
          e.error = '混淆隔离：重度混淆脚本，已移入「混淆隔离」区，可在该页信任后放行'
          rejected++
          this.emit('source-updated', e)
          continue
        }
      }
      kept.push(e)
    }
    if (rejected) {
      list.length = 0
      list.push(...kept)
      this.log(`${phase}隔离 ${rejected} 条重度混淆脚本（已移入「混淆隔离」区，可在该页信任后放行）`, '安全', 'warn')
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
      const hits = e.obfHits || {}
      const hard = (hits.spinLoops || 0) > 0 || (hits.selfSchedCalls || 0) > 0 ||
        (hits.jsjiamiMarks || 0) > 0 || (hits.evalCalls || 0) > 0
      if (hard) throw new Error('命中反调试/混淆器硬特征（空转死循环/自调度定时器/jsjiami/eval），不允许信任')
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
        e.error = '混淆隔离：重度混淆脚本，已移入「混淆隔离」区，可在该页信任后放行'
      }
      this.log(`已取消信任「${name}」${(e.obfLevel === 'high' && cfg.excludeHighRiskObfuscated) ? '，重新移入混淆隔离区' : ''}`, '安全', 'info')
    }
    this.emit('source-updated', e)
    this.store.saveDb()
    return { id: e.id, trusted: !!trust, status: e.status, usable: e.usable, trustedHashes: hashes.length }
  }

  async runCheck(ids, opts) {
    this.jobGate('检测', (ids && ids.length ? ids.length + ' 条' : '全部候选'))
    const opt = opts || {}
    // full=true：全平台完整检测（关掉快速模式并强制重测），用于「补全平台覆盖」
    const cfg = opt.full ? Object.assign({}, this.store.config, { quickCheck: false }) : this.store.config
    // 单条手动检测 = 强制重测；批量时默认跳过「已检测且脚本内容未变」的条目。
    // v1.9.16：UI 的「检测选中 / 检测并灌入」带 opts.force=true —— 手动勾选就是明确要重测，
    // 再走跳过逻辑会让用户以为批量检测没生效（实测反馈：勾 36 条点检测，秒完成、徽章全不变）。
    // 「跳过已检测」只对不指定条目的调用生效（爬取后自动检测 / 巡检 / 定时管线）。
    const force = opt.full || opt.force || !ids || ids.length <= 1
    const picked = (ids && ids.length ? ids.map(i => this.store.db.sources[i]).filter(Boolean) : this.store.getSources())
    // 服务端原生音源：服务端 list 会带 sourceUrl（当年经 URL 导入时留存的原始脚本地址），
    // 有地址的同样可以下载 + 沙箱真实取链检测 —— 过去一律跳过，用户点「检测」毫无反应
    const list = picked.filter(e => !e.deprecated && (!e.fromServer || e.url))
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
      return { usable: 0, total: 0, excluded, notSource: 0, depInline: 0 }
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
              e.dupReason = '同内容重复'
              e.usable = false
              depInline++
            } else {
              const rec = e.contentHash ? (deepByHash[e.contentHash] || reserve(e)) : null
              const d = await deepCheck(e, code, cfg, (t, p) => this.emit(t, p), () => this.cancelRequested)
              if (d.cancelled) {
                // 取消：绝不覆盖旧的好结果；旧结果不存在但部分平台已可用时才采用部分结果
                if (!e.deep && usableCount(d) > 0) e.deep = d
              } else {
                e.deep = d
              }
              if (rec) { rec.deep = e.deep || d; if (rec.resolve) { rec.resolve(rec.deep); rec.resolve = null } }
              e.usable = usableCount(e) > 0
              applyProbeRecord(e, e.deep)   // v1.9.9：把深检结论固化为可记录的探针/validTier
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
                  const keep = this.betterKeeper(prev.entry, e) ? prev.entry : e
                  const drop = keep === prev.entry ? e : prev.entry
                  if (drop.usable) usable--
                  drop.usable = false
                  drop.deprecated = true
                  drop.dupOf = keep.id
                  // 可用度裁决的措辞：被废方实测失效而保留方可用 → 说明是「失效让位」
                  drop.dupReason = (drop.deep && drop.deep.checkedAt && usableCount(drop) === 0 && usableCount(keep) > 0)
                    ? '同名版本（此版本已失效）' : '同名旧版本'
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
          }
        } catch (err) {
          const msg = String((err && err.message) || err)
          if (msg !== '已取消') { e.status = 'dead'; e.error = msg.slice(0, 120) }
        }
        delete e.checking
        this.emit('source-updated', e)
        this.progress({ done: i + 1, total: list.length, usable })
        if ((i + 1) % 10 === 0) { this.store.saveDb() }
      }
    }
    await Promise.all(Array.from({ length: conc }, () => worker()))
    this.store.saveDb()
    const bf = await this._backfillApiAlive(list, cfg)
    const dup = this.dedupe()
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
    return { usable, total: list.length, notSource, depInline, obfHigh: obfSeen.high || 0, obfMid: obfSeen.mid || 0, backfill: bf || null }
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
        if (done % 20 === 0) { this.step(`补探接口域名 ${done}/${picked.length}`); this.store.saveDb() }
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
            if (!e.suspected) noSource++
            if (e.stale) { e.stale = false; e.staleAt = 0 }   // 已重新下载校验，清除待重下标记
            // 检测完还没深检：先清掉旧的深检结果标记（内容已变则旧结果作废）
            if (e.deep && e.deep.hash && e.deep.hash !== e.contentHash) {
              e.deep = null; e.usable = false
              e.updated = true; e.updatedAt = Date.now()   // 内容确实变了：标「有更新」，灌入时走同名替换
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
        if ((i + 1) % 20 === 0) this.store.saveDb()
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
      drop.dupReason = '同内容重复'
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
    const accts = wanted
      ? all.filter(p => p && p.type && wanted.indexOf(p.id) >= 0)
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
    this.jobGate('灌入', (ids && ids.length ? ids.length + ' 条' : '全部待灌'))
    const cfg = this.store.config
    const targets = (ids || []).map(i => this.store.db.sources[i]).filter(Boolean)
    if (!targets.length) throw new Error('没有选中任何音源')

    const svcs = this._importTargets(opts)
    if (!svcs.length) throw new Error(NO_ACCOUNT_ERR)
    const multi = svcs.length > 1

    this.job = { running: true, type: 'import', cancel: false, progress: { done: 0, total: targets.length * svcs.length }, step: '' }
    this.emit('job', { running: true, type: 'import' })
    this.emit('import-targets', svcs.map(s => ({ id: s.acct.id, name: s.acct.name || s.acct.url, type: s.type })))
    if (multi) this.log(`多平台灌入：目标 ${svcs.length} 个账号（${svcs.map(s => s.acct.name || s.acct.url).join('、')}）`, '灌入')

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
      let serverIds = null
      let serverList = null
      try { serverList = await svc.adapter.list(svc.acct) } catch (e) {
        this.log(`读取「${label}」音源列表失败：${String((e && e.message) || e)}（同名保护与「是否已灌入」判定将退回本地记录）`, '灌入', 'warn')
      }
      if (Array.isArray(serverList)) {
        serverIds = new Set()
        for (const s of serverList) {
          if (!s) continue
          if (s.id != null) serverIds.add(s.id)
          if (s.name) serverByName[normName(s.name)] = s
        }
        this.log(`「${label}」服务端现有音源 ${serverList.length} 个`, '灌入')
      }
      plans.push({ svc, label, serverByName, serverIds, serverList })
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
    const obfGate = this.applyObfGate(targets, (e) => codeCache[e.id] || (typeof e.code === 'string' && e.code ? e.code : '') || '', '灌入前')
    const obfRejected = obfGate.rejected
    if (!targets.length) {
      this.job.running = false
      this.emit('job', { running: false, type: 'import', done: true, summary: { ok: 0, replaced: 0, synced: 0, skipped: 0, total: 0, obfRejected } })
      return { results: [], ok: 0, replaced: 0, synced: 0, skipped: 0, total: 0, obfRejected }
    }

    // 去重与同名裁决规划（纯函数 _planImportQueue，便于单测）——每个账号各规划一份：
    // 同名冲突取决于该服务端自己的现状，改名池也要按账号分开（否则第二个平台会
    // 以为名字已被占用而继续往后加后缀）
    const activeId = cfg.activePlatformId || (plans[0] && plans[0].svc.acct.id)
    let total = 0
    for (const p of plans) {
      // 账本对账（只在该账号的列表确实读到时才做）：服务端已经删掉的条目，本地记录跟着摘掉。
      // 不这么做的话，用户「删空服务端再重灌」会被本地那枚「已灌入」标记整体排除，表现为「灌不进去」。
      if (p.serverIds) {
        const rc = this.reconcileImported(p.svc.acct.id, Array.from(p.serverIds))
        if (rc.changed) this.log(`「${p.label}」账本对账：摘除 ${rc.dropped} 条服务端已不存在的灌入记录`, '灌入', 'info')
      }
      p.importedRecs = this._importedRecsFor(p.svc.acct.id, activeId)
      p.queue = this._planImportQueue(targets, {
        cfg, serverByName: p.serverByName, serverIds: p.serverIds, serverList: p.serverList,
        codeCache, importedRecs: p.importedRecs,
        // 该平台名字是不是 key：不是（MusicSync）则同名不需要改名，直接新增为独立条目
        uniqueName: p.svc.adapter.uniqueName !== false
      })
      p.usedRename = new Set()
      total += p.queue.length
    }
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
    this.store.saveDb()
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
    this.job.running = false
    this.emit('job', { running: false, type: 'import', done: true, summary })
    return { results, ok, replaced, synced, skipped, obfRejected }
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
    const tag = multi ? `[${p.label}] ` : ''
    if (item.skip) {
      this.log(tag + '跳过：' + name + ' — ' + item.skip, '灌入', 'warn')
      return Object.assign(base(), { status: 'skipped', message: item.skip })
    }
    try {
      let r = null
      if (item.sameContentServer) {
        // 服务端已有一份内容相同的音源（同名命中，或按脚本内容指纹比对命中）：不重复上传，
        // 直接把本地这条挂到服务端那一条上，标记为「已灌入」。
        const srv = item.sameContentServer
        this._markImported(e, svc, srv.id, srv.name || name, srv.supportedSources || [], true)
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
        const rm = await svc.adapter.remove(svc.acct, srv.id, { owner: srv.owner })
        if (!rm.success) {
          this.log(tag + `替换失败：服务端旧版「${srv.name || name}」删除失败（${rm.message}），退回改名上传`, '灌入', 'warn')
          r = await this._uploadRenamed(svc, code, item.baseName, p.serverByName, p.usedRename)
          if (r && r.success) r.replacedFallback = 'renamed'
        } else {
          this.log(tag + `已删除服务端旧版「${srv.name || name}」（id=${srv.id}），等待服务端重载后上传新版本…`, '灌入')
          await sleep(2500)
          r = await svc.adapter.upload(svc.acct, code, name)
          if (!r.success && r.message && /已存在/.test(r.message)) {
            await sleep(2500)
            r = await svc.adapter.upload(svc.acct, code, name)
          }
          if (!r.success && r.message && /已存在/.test(r.message)) {
            // 仍撞名（极少见）：退回改名上传，保证音源至少能进去
            this.log(tag + '替换上传仍撞名，退回改名上传', '灌入', 'warn')
            r = await this._uploadRenamed(svc, code, item.baseName, p.serverByName, p.usedRename)
            if (r && r.success) r.replacedFallback = 'renamed'
          }
        }
        if (r && r.success) {
          // 清理本地「已灌入」里指向被替换音源的旧记录（服务端那份已不存在）
          let purged = 0
          for (const [k, rec] of Object.entries(this.store.imported)) {
            if (rec && rec.lxId === srv.id) { this._dropPlatformFromImported(k, svc.acct.id); purged++ }
          }
          if (purged) { this.store.saveImported(); this.log(tag + `已清理 ${purged} 条指向被替换音源的本地灌入记录`, '灌入', 'info') }
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
      }
      if (r && r.success) {
        this._markImported(e, svc, r.id, r.name || name, r.platforms || [], false)
        // 把裁决理由带上：用户最常问的就是「为什么这次是替换、那次是改名」
        const note = item.replaceServer
          ? (r.replacedFallback === 'renamed'
            ? '（同名替换失败，已改名上传）'
            : '（已替换服务端同名旧版：先删后传）' + (item.why ? ' — ' + item.why : ''))
          : item.renameServer ? '（已改名并存，未删服务端旧版）' + (item.why ? ' — ' + item.why : '')
            : (item.why ? '（' + item.why + '）' : '')
        const st = item.replaceServer && r.replacedFallback !== 'renamed' ? 'replaced' : 'success'
        this.log(tag + `已灌入：${name}${note}（id=${r.id}）`, '灌入')
        return Object.assign(base(), { status: st, lxId: r.id, message: (r.message || '') + note, platforms: r.platforms || [] })
      }
      this.log(tag + '灌入失败：' + name + ' — ' + ((r && r.message) || '导入失败'), '灌入', 'warn')
      return Object.assign(base(), { status: 'failed', message: (r && r.message) || '导入失败', requireUnsafe: !!(r && r.requireUnsafe) })
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
  _markImported(e, svc, lxId, name, platforms, synced) {
    const prev = this.store.imported[e.id]
    const list = (prev && Array.isArray(prev.importedTo) ? prev.importedTo : [])
      .filter(x => x && x.platformId !== svc.acct.id)
    list.push({ platformId: svc.acct.id, platformType: svc.type, accountName: svc.acct.name || svc.acct.url, lxId, at: Date.now() })
    this.store.imported[e.id] = {
      lxId, name: name || (prev && prev.name) || e.name, contentHash: e.contentHash || '',
      serverUrl: svc.adapter.baseUrl(svc.acct), importedAt: Date.now(),
      platforms: platforms || [], serverSynced: !!synced,
      platformId: svc.acct.id, platformType: svc.type, accountName: svc.acct.name || svc.acct.url,
      importedTo: list
    }
    this.store.saveImported()
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
   * 同名音源的裁决规则（纯函数，v1.8.0 抽出并把口径写死在这里，便于单测和排错）。
   *
   * 先明确一件事：**「已灌入」不是一个终态，而是「本地账本」**。用户会在网页端手动删源、
   * 会换内容重新发布、会遇到两个不同作者用了同一个名字。所以本地记录只能用来「提示」，
   * 不能用来「拦」，真正的依据必须是服务端此刻的实际列表（见 _planImportQueue 传入的 serverIds）。
   *
   * 判定顺序（越靠前越硬）：
   *  1. 字节长度相同            → synced  同名同内容，服务端就是它，标记已灌入即可，不重传
   *  2. 服务端声明平台数 > 本地实测 → skip    哪个可用平台多用哪个（v1.7.0 用户要求）
   *  3. 两边版本号都可解析       → 高的赢   本地更高 → replace（删旧装新）；否则 skip（服务端不旧）
   *  4. 两边都有平台信息但完全无交集 → rename 明显是两个无关脚本撞了名 → 改名并存，不删旧的
   *  5. 其余（信息不足）         → 按设置    默认 replace（先删后传），设置里关掉则 rename
   *
   * 注意 2/4 都要求「两边都拿得到数」：服务端没声明平台、或本地没深检过，就跳过该条规则，
   * 绝不拿半个信息去猜 —— 猜错要么删掉能用的源，要么把无关脚本覆盖掉，都不可逆。
   *
   * @returns {{act:'synced'|'skip'|'replace'|'rename', why:string}}
   */
  sameNameVerdict(e, srv, code, cfg) {
    const c = cfg || {}
    // 1) 同名同内容 → 服务端就是它，标记已灌入即可，不重传。
    //    平台能回传脚本内容时（srv.hash）按内容指纹比，最准；不能回传的平台退回比字节长度。
    const sameHash = !!(e.contentHash && srv.hash && e.contentHash === srv.hash)
    const sameSize = !!(code && srv.size && Buffer.byteLength(code, 'utf-8') === srv.size)
    if (sameHash || (!srv.hash && sameSize)) {
      return { act: 'synced', why: '同名同内容，服务端已有（未重复上传）' }
    }

    const checked = !!(e.deep && e.deep.checkedAt) && !e.stale
    const srvPlats = Array.isArray(srv.supportedSources) ? srv.supportedSources.slice() : []
    const srvN = srvPlats.length
    const newN = checked ? usableCount(e) : -1
    const localPlats = checked ? usableKeys(e) : []

    // 2) 本地实测全挂 → 绝不替换（v1.7.0 起就这么定：本地挂掉不代表服务端不能用，
    //    把服务端能用的源换成本地实测不可用的，是纯损失）。stale 的旧结论不作数。
    if (checked && newN === 0) {
      return { act: 'skip', why: '本地实测 0 个可用平台 → 不替换（保留服务端现条目，避免越换越差）' }
    }
    // 3) 服务端现条目可用平台更多 → 保留服务端
    if (srvN > 0 && newN >= 0 && newN < srvN) {
      return { act: 'skip', why: `服务端现条目支持 ${srvN} 个平台、多于本地实测可用的 ${newN} 个 → 保留服务端（哪个可用多用哪个）` }
    }

    // 3) 版本号可比 → 版本高的赢
    const localName = e.scriptName || e.lxName || e.name
    const lv = versionNum(localName)
    const sv = versionNum(srv.name)
    if (lv && sv) {
      if (lv > sv) {
        return { act: 'replace', why: `同名，本地版本更高（${localName} > ${srv.name}）→ 更新（删旧装新）` }
      }
      return { act: 'skip', why: `同名，服务端版本不低于本地（${srv.name} ≥ ${localName}）→ 保留服务端` }
    }

    // 4) 平台重叠：有交集 → 同一音源的新版本；完全无交集 → 明显无关，改名并存
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

    // 5) 信息不足 → 按设置（默认更新，避免用户升级后同名新版灌不进去）
    if (c.replaceSameNameOnImport === false) {
      return { act: 'rename', why: '同名不同内容；设置里关闭了自动替换 → 改名上传（保留服务端旧版）' }
    }
    return { act: 'replace', why: '同名不同内容；信息不足以判定为无关脚本 → 按更新处理（删旧装新）' }
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
    const serverIds = ctx.serverIds || null   // 服务端此刻真实存在的 id 集合
    const serverList = ctx.serverList || []
    // 服务端已有条目的「内容指纹」表：只有平台会回传脚本正文时才有值
    // （MusicSync 实测会回传全文 → 能对它做「服务端已有同内容就不重复灌」；
    //  Songloft / LX Server 只回元信息，表为空，退回账本口径）。
    const serverByHash = {}
    for (const s of serverList) if (s && s.hash) serverByHash[s.hash] = s
    const codeCache = ctx.codeCache || {}
    // 兼容旧的调用口径：没有 serverIds 时退回「本地账本说了算」
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
    const queue = []
    for (const e of targets) {
      const nm = normName(e.lxName || e.scriptName || e.name)
      if (!e.url || e.fromServer) {
        // 服务端原生音源本来就在服务端上，重新上传只会制造重复条目
        queue.push({ e, skip: '服务端原生音源，无需灌入' })
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
      } else if (nm && serverByName[nm]) {
        // 同名音源：交给 sameNameVerdict 统一裁决（规则与理由都写在那个函数上）
        const srv = serverByName[nm]
        const code = codeCache[e.id]
        // 同名音源一律走同一套裁决（含 MusicSync）—— 同名/同内容该怎么处理与平台无关，
        // 区别只有「要不要改名」：名字不是 key 的平台（MusicSync）根本不需要改，
        // 把本地这份作为独立条目加上去即可（改名不但没用，还会破坏脚本自检）。
        const v = this.sameNameVerdict(e, srv, code, cfg)
        const baseName = e.lxName || e.scriptName || e.name
        if (v.act === 'synced') queue.push({ e, sameContentServer: srv, why: v.why })
        else if (v.act === 'skip') queue.push({ e, skip: `与服务端同名「${srv.name}」：${v.why}` })
        else if (v.act === 'rename' && ctx.uniqueName === false) {
          queue.push({
            e,
            why: `同名裁决：${v.why}。该平台同名音源可共存（服务端不按名字区分），直接新增为独立条目（不改名）`
          })
        } else if (v.act === 'rename') {
          // 改名安全阀前置：脚本自检名字的音源改名会变成坏源，规划阶段就说清，别等到上传失败
          if (code && renameSelfCheck(code, (extractMeta(code) || {}).name || '')) {
            queue.push({
              e,
              skip: `与服务端同名「${srv.name}」：${v.why}，但该脚本内部校验自身名称，改名会让它初始化失败 → 未灌入（请先手动删除服务端同名音源，或开启「同名自动替换」）`
            })
          } else queue.push({ e, renameServer: srv, baseName, why: v.why })
        } else if (code) queue.push({ e, replaceServer: srv, baseName, why: v.why })
        // 要替换但没有本地脚本内容（只能靠 URL 导入）→ 服务端做不了「先删后传」
        else if (ctx.uniqueName === false) queue.push({ e, why: '没有本地脚本内容，直接按 URL 新增（该平台同名可共存，无需改名）' })
        else queue.push({ e, renameServer: srv, baseName, why: '没有本地脚本内容，无法先删后传 → 改为改名上传' })
      } else {
        // 本地账本有此内容、但服务端上已经没了（用户手动删过/服务端重置）→ 重新灌入
        const rec = e.contentHash ? importedRecs[e.contentHash] : null
        queue.push(rec ? { e, why: `服务端上已无「${rec.name}」（本地记录保留），本次重新灌入` } : { e })
      }
    }
    return queue
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
    const items = buildPatrolItems(this.store.imported, this.store.db.sources, aliveLxIds)
    // 私人音源由 buildPatrolItems 整体排除；这里只做一次可见提示，避免用户以为「巡检漏了我的源」。
    const privateSkipped = Object.keys(this.store.imported || {})
      .filter(srcId => { const e = this.store.db.sources[srcId]; return e && e.private }).length
    if (privateSkipped) this.log(`已跳过 ${privateSkipped} 个私人音源（不参与巡检，可在音源库手动检测）`, '巡检')
    if (!items.length) {
      this.job = { running: false, type: '', cancel: false, progress: {}, step: '' }  // 占位回滚（提前返回路径）
      this.log('没有可巡检的已灌入音源（仅支持「本工具灌入且本地有对应记录」的音源）', '巡检', 'warn')
      return { ok: 0, disabled: 0, unknown: 0, total: 0 }
    }

    this.job = { running: true, type: 'patrol', cancel: false, progress: { done: 0, total: items.length, ok: 0, disabled: 0 }, step: '' }
    this.emit('job', { running: true, type: 'patrol' })
    this.log(`开始健康巡检：${items.length} 个已灌入音源（并发 ${Math.max(1, Math.min(8, cfg.concurrency || 8))}）…`, '巡检')
    this.mirrorPref = null
    // 巡检期服务端写操作串行化（v1.9.1）：每条写请求走同一条链，delete 前后保持
    // serverDeleteIntervalMs 间隔，避免把 lxserver 打假死（即本次 bug 连带的二次事故）
    this._patrolWriteChain = null
    this._patrolPrevHeavy = false
    // 巡检并发刻意压得比主检低：几十个聚合源同时重测，打到的是同一批后端接口，
    // 并发太高会把对方打到限流，整批「全平台失败」，看起来就像集体失效
    const conc = Math.max(1, Math.min(3, cfg.concurrency || 8))
    let idx = 0, ok = 0, disabled = 0, unknown = 0, reEnabled = 0, deleted = 0

    const worker = async () => {
      while (true) {
        if (this.cancelRequested) return
        const i = idx++
        if (i >= items.length) return
        const { srcId, e, rec } = items[i]
        const name = rec.name || e.scriptName || e.name
        e.checking = true
        this.emit('source-updated', e)
        this.step(`巡检 ${i + 1}/${items.length} ${name}`)
        let verdict = 'unknown'
        let note = ''
        let suspectTag = false   // 「疑似失效」：与「无法判定（网络原因）」在日志里分开说，避免用户看不懂
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
            if (/HTTP 404|HTTP 410/.test(errText)) { verdict = 'dead'; note = '脚本已被删除（' + errText + '）' }
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
            if (j.streak != null) rec.patrolFailStreak = j.streak
            suspectTag = j.verdict === 'suspect'
            verdict = j.verdict === 'suspect' ? 'unknown' : j.verdict
            note = j.note
            // 巡检结论落库。特例：主检可用、脚本内容没变、这次只是「疑似失效/网络原因」——
            // 保留主检结果，免得一次限流就把库里的「可用」翻成「不可用」（服务端动作由 streak 把关）。
            const keepPrevUsable = !contentChanged && prevUsable && (j.verdict === 'suspect' || (j.verdict === 'unknown' && !d.cancelled))
            if (!keepPrevUsable && !d.cancelled) {
              e.deep = d
              e.usable = usableCount(d) > 0
            }
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
            const t = await this._patrolEnqueueServerWrite('enable', () => this._safePlatforms(cfg, rec.lxId, [], '重新启用', ownerById.get(rec.lxId)))
            if (t.success) { delete rec.disabledByPatrol; reEnabled++; this.log(`巡检恢复正常，已重新启用：${name}`, '巡检') }
          }
        } else if (verdict === 'dead') {
          // 自动删除优先于自动禁用：开启 patrolAutoDelete 且连续失效达阈值时，从服务端+本地一并移除。
          // 本地未灌入服务端（无 lxId / 服务端已不存在）的源不删，只禁用。
          // 私人音源（v1.10.0）绝不自动删除：用户手动导入的个人源，失效了也只禁用，本体留在库里。
          // （服务端侧删除同样跳过——私人源常由用户直接在平台上维护，自动删容易误伤。）
          const streak = Number(rec.patrolFailStreak) || 0
          // !e.private 为纵深防御：buildPatrolItems 已在队列层把私人源全部排除，
          // 这里再守一次，防止将来有人从别的入口直接塞条目进来时被误删。
          const wantDelete = patrolAutoDeleteWanted(cfg, streak) && !e.private
          if (wantDelete) {
            try {
              const r = await this._patrolEnqueueServerWrite('delete', async () => {
                const s = this._active()
                return await s.adapter.remove(s.acct, rec.lxId, { owner: ownerById.get(rec.lxId) })
              })
              if (r && r.success) {
                delete this.store.imported[srcId]
                if (this.store.db.sources[srcId]) delete this.store.db.sources[srcId]
                this.store.saveImported(); this.store.saveDb()
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
              const t = await this._patrolEnqueueServerWrite('disable', () => this._safePlatforms(cfg, rec.lxId, ['wy', 'tx', 'kw', 'kg', 'mg'], '自动禁用', ownerById.get(rec.lxId)))
              if (t.success) { disabled++; rec.disabledByPatrol = true; this.log(`巡检失效，已自动禁用：${name} — ${note}`, '巡检', 'warn') }
              else if (t.message) this.log(`巡检失效，但自动禁用失败：${name} — ${t.message}`, '巡检', 'warn')
            }
          } else if (cfg.patrolAutoDisable !== false) {
            const t = await this._patrolEnqueueServerWrite('disable', () => this._safePlatforms(cfg, rec.lxId, ['wy', 'tx', 'kw', 'kg', 'mg'], '自动禁用', ownerById.get(rec.lxId)))
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
            const t = await this._patrolEnqueueServerWrite('enable', () => this._safePlatforms(cfg, rec.lxId, [], '恢复启用', ownerById.get(rec.lxId)))
            if (t.success) { delete rec.disabledByPatrol; reEnabled++; this.log(`巡检无法确认失效，已恢复启用：${name}`, '巡检') }
          }
        }
        this.emit('patrol-item', { id: e.id, name, verdict, note })
        this.emit('source-updated', e)
        this.progress({ done: i + 1, total: items.length, ok, disabled })
        this.store.saveDb(); this.store.saveImported()
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
    // 身份口径自检（同上）：把「猎手显示停用、LX 端显示启用」的假性不同步在同步时就提示出来
    const idNote = identityMismatch(cfg, serverList)
    if (idNote) this.log(idNote, '同步', 'warn')

    let matched = 0, added = 0, pruned = 0
    for (const s of serverList) {
      if (!s || !s.id) continue
      const nm = normName(s.name)
      if (alreadyLx.has(s.id)) { matched++; continue }
      // 优先匹配本地候选（非占位、未废弃、同名）
      const local = this.store.getSources().find(e => !e.fromServer && !e.deprecated && normName(e.lxName || e.scriptName || e.name) === nm)
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
    this.store.saveDb()
    this.store.saveImported()
    this.log(`同步服务端音源完成：服务端共 ${serverList.length} 个 → 本地匹配 ${matched} 个、新增占位 ${added} 个、清理失效 ${pruned} 个（全部算作「已灌入」）`, '同步', 'info')
    return { total: serverList.length, matched, added, pruned, imported: Object.keys(this.store.imported).length }
  }
}

module.exports = { Hunter, normName, identityMismatch, formatIntervalHours, patrolSchedule, renameSelfCheck, versionNum, patrolAutoDeleteWanted, buildPatrolItems, buildRepoSeeds }
