'use strict'
/** 本地持久化：配置 / 音源库 / 已灌入记录，存于 Electron userData 目录 */
const fs = require('fs')
const path = require('path')
const { usableCount } = require('./checker')
const { DEFAULT_REPOS, normalizeRepo } = require('./crawler')

const DEFAULT_CONFIG = {
  serverUrl: '',
  // lxserver 的管理员密码（自定义源接口 /api/custom-source/* 的 x-frontend-auth，
  // 即服务端配置里的 frontend.password）。
  // 注意与 LX 网页「用户账号登录」密码是两套体系：出厂默认见 lxserver 文档，
  // 若改过 frontend.password，这里要同步改（不要在任何地方硬编码真实口令）。
  adminPassword: '',
  username: 'default',
  // ---------------- 多平台 / 多账号（v1.8.0） ----------------
  // 把所有「服务平台账号」统一管理：每个账号一份连接配置，可配置多个平台（lxserver /
  // songloft / musicsync）、每个平台多个账号，并指定其中一个为「当前选中」（灌入 / 同步 /
  // 巡检 / 撤回等操作都作用于它）。
  // 旧版单账号字段（serverUrl / adminPassword / username / serverTimeoutMs）首次启动会
  // 自动迁移成下面 platforms 数组里的第一个 lxserver 账号（见 Store 构造里的 _migratePlatforms）。
  platforms: [],
  activePlatformId: null,
  ghToken: '',
  mirror: 'auto',
  // ---------------- 网络加速 / 代理策略（v1.11.0 统一重整） ----------------
  // crawlProxy：HTTP 代理（http://host:port）。作用于 GitHub 爬取链（raw / release / 仓库扫描）
  // 与第三方站点取数（采集站 hubfeed、网页音源站、站外分发源 websource）；
  // 不影响音源检测的播放请求与灌入。
  // proxyPolicy：off=全局不用代理；auto=第三方站点代理优先、GitHub 走直连+镜像（默认）；
  // force=在 auto 基础上把代理插到 GitHub 候选链最前。forceProxy 是旧字段，写入时与之同步。
  // useJsdelivr：jsDelivr 是否参与镜像候选链；mirrorCustom：镜像选「自定义…」时的前缀基址。
  crawlProxy: '',
  proxyPolicy: 'auto',
  forceProxy: false,
  useJsdelivr: true,
  mirrorCustom: '',
  customRepos: [],
  // ---------------- 统一仓库清单（v1.9.12，全部可管理） ----------------
  // repos：内置/附加/发现三类仓库的统一清单，每项是 {repo, enabled, builtin, origin}。
  // 用户可对任一仓库勾选「禁用」（本次不爬）或「删除」（从清单移除）；内置仓库删除后可用「恢复默认」找回。
  // 未初始化（null）时由 _ensureRepoList 从 DEFAULT_REPOS + 旧 customRepos 播种；
  // 一旦是数组（哪怕为空）即尊重用户编辑，不再自动播种。
  // 注意：这里必须是 null 而不是 []——空数组表示「用户已清空清单」，不能再被播种覆盖。
  repos: null,
  // ---------------- 抓取发现（v1.9.9，借鉴 lxhub 关键词搜索发现） ----------------
  // searchEnabled：用关键词在 GitHub 搜索新仓库，作为种子列表的增量补充（默认关，需手动开启）。
  // searchKeywords：搜索关键词（中文）；maxReposPerKeyword/maxSearchReposTotal：每词/全局上限；
  // searchMinStars：最小 star 门槛（0=不限），过滤噪声仓库，避免把 star 极少的仓库也爬进来。
  searchEnabled: false,
  searchKeywords: [
    'lx 音源', '洛雪 音源', 'lx-music 音源', 'lx music 自定义源', 'lxmusic',
    '洛雪音乐 音源', 'lx音乐源', '洛雪音乐 源', 'lx 源脚本', '洛雪音源js'
  ],
  maxReposPerKeyword: 20,
  maxSearchReposTotal: 60,
  searchMinStars: 0,
  // searchVerify：内容验真（v1.9.14）。名字/描述像音源仓库不代表真有脚本——
  // 实测 60 个命中里只有 32 个真含音源，其余是客户端/播放器/API。开启后逐个看文件树
  // 抽检 .js、并放行「压缩包分发」与「Release 资产分发」两类仓库。默认开。
  searchVerify: true,
  // v1.10.3：搜索发现节流。每轮爬取都跑关键词搜索会白烧配额（新音源仓库不会那么快冒出来），
  // 改为距上次 searchDiscoverAt 满 searchDiscoverHours 小时才跑一次；0=不节流（每轮都搜）。
  searchDiscoverHours: 24,
  searchDiscoverAt: 0,
  // v1.10.3：失效仓库自动清理。爬取时对确定性 404（仓库不存在/已删）的条目，爬完自动从
  // 仓库清单移除（仅非内置条目；内置条目可用「恢复默认」找回，不自动删）。
  // 只认 404，网络抖动/5xx/限流一律不删，避免误删暂时不可达的仓库。默认开。
  autoCleanDeadRepos: true,
  // 非音源仓库黑名单（v1.10.3）：被「清理非音源仓库脚本」判定删除的仓库（播放器/管理器/网关等）。
  // 记在这里后，搜索发现与社区精选都不会再把它们加回清单，避免「清了又回来」。
  blockedRepos: [],
  // ---------------- 站外分发源（v1.11.0）----------------
  // externalSources：用户显式添加的 Pages / 自建域名 / 对象存储直链源，与仓库清单并列的一类采集源。
  // 每项 {url, name, enabled, origin:'external', kind, addedAt, lastProbe, lastCrawl}。
  // 刻意不放进 repos：repos 规范化只保留 repo/enabled/builtin/origin 四个字段，
  // 且「清理非音源仓库」会对 repos 里的每条做 GitHub 验真（URL 必然 404 → 误删好源）。
  // buildRepoSeeds 会把 enabled 的站外源 URL 并进爬取种子，全链路（手动/定时/行级采集）自动复用。
  externalSources: [],
  // 站外源时间窗指纹：{ [url]: {hash, at} }。站外源没有 Git 提交/发布时间，
  // 用「响应体指纹是否变化」等价判定「sinceDays 天内有没有新音源」（见 websource.js）。
  // 独立于 externalSources，是为了让从旧「网页音源站」入口加进 repos 的 URL 也吃到同一时间窗。
  externalStates: {},
  // ---------------- 社区精选订阅（v1.9.18，借鉴 lx-hub 的 community.json market） ----------------
  // communityEnabled：爬取时拉取 zlyon/lx-hunter-market 维护的社区精选清单
  // （人工提交、维护者审核，带 submitter/approvedAt），把其中 type=repo 的条目并入种子
  // （origin=community，进统一仓库清单后可单独禁用/删除）。默认开：只多一次 HTTP 拉取
  // （30 分钟缓存，走镜像链），不额外烧 GitHub 配额；拉取失败只记 warn 不影响爬取。
  // communityFeedUrl：自定义订阅源地址（留空 = 内置官方地址）。
  communityEnabled: true,
  communityFeedUrl: '',
  // ---------------- 接口域名探活（v1.9.10，借鉴 lxhub 的 api_hosts/api_alive） ----------------
  // apiHostCheck：检测时额外对脚本引用的后端域名做轻量存活探测（默认关，开启会为每个音源多发若干请求）。
  apiHostCheck: false,
  // v1.9.15：批量补探。探活开关是后开的，库里大量历史音源身上没有 apiAlive，
  // 而主检测走「跳过已检测」分支不重新拉代码，探测永远补不上 → 音源库的
  // 「后端N在线/失效」徽章一直是空的。主检测收尾后单独挑一批缺结果的补探，
  // 每轮限量（apiHostBackfillMax，0=不补探）＋并发＋时间预算，慢慢把全库补齐。
  apiHostBackfillMax: 200,
  apiHostBackfillConcurrency: 6,
  apiHostBackfillBudgetMs: 180000,
  maxCandidatesPerRepo: 400,
  timeoutMs: 15000,
  linkTimeoutMs: 20000,
  serverTimeoutMs: 25000,
  concurrency: 8,
  quickCheck: true,
  skipChecked: true,
  hashDedupeAfterCrawl: true,
  patrolEnabled: false,
  patrolIntervalHours: 12,
  // 巡检失败（常见于推送服务端没开 / 网络不通）后的重试间隔，单位分钟。
  // 旧逻辑失败时不推进调度水位，每分钟轮询都会判「到期」并真跑一轮 → 日志刷屏。
  // 默认 15 分钟：不刷屏，服务端恢复后也不用等满整个巡检间隔。上限不超过主间隔。
  patrolRetryMinutes: 15,
  crawlScheduleEnabled: false,
  crawlIntervalHours: 24,
  crawlSinceDays: 0,
  // v1.10.0「只收最新版」：爬取时按归一化音源名分组，同一音源只收版本号最高的一个
  // 候选（旧版本不下载不入库）。组内无可比较版本号/弱名时全部保留，交给内容去重裁决。
  crawlLatestOnly: true,
  // v1.9.0：定时爬取跑完后自动接上「检测 → 灌入」（全链路无人值守）。
  // 从属于 crawlScheduleEnabled：定时爬取本身没开，也就无所谓「爬完自动灌」。
  crawlAutoImport: false,
  // 同名音源裁决的**兜底**开关（不是全部规则！）：
  // 灌入时先按 hunter.sameNameVerdict 里那 6 条硬规则判（同名同内容不重传 / 本地全挂不替换 /
  // 服务端平台更多保留现条目 / 版本高的赢 / 平台无交集则改名并存 / 有交集则替换），
  // 全都判不出来（两边信息都不足）时才看这里：true=替换服务端旧版（先删后传），false=改名并存。
  replaceSameNameOnImport: true,
  // 2026-11-10 23:28 用户口径修正：不再有「综合质量分」，也就没有权重/门槛类设置项。
  // 同名裁决改用字典序（可用平台数 → 最高可播档 → p50 延迟，延迟噪声带 300ms 写死在
  // quality.LATENCY_MARGIN_MS），所以这里不需要 qualityWeights/MinSamples/... 一串参数 ——
  // 少一组可调参数就少一处「配置漂移导致裁决翻案」的风险。
  patrolAutoDisable: true,
  // v1.9.1：巡检连续失效「自动删除音源」。
  // 与 patrolAutoDisable（自动禁用）的区别：禁用只是把该音源在五个平台上的开关关掉、
  // 音源本体仍留在库里；自动删除则是从服务端 + 本地库一并移除（服务端每次 delete 都会全量
  // 重载脚本，故删除需严格串行化并保留 serverDeleteIntervalMs 间隔，避免服务端假死）。
  // patrolAutoDelete=false（默认）时仅禁用不删；开启后连续 patrolDeleteAfter 次（默认 3）
  // 巡检判定 dead 才走删除。注意：本地（未灌入服务端）的音源无论开关如何都只禁用、不删。
  patrolAutoDelete: false,
  patrolDeleteAfter: 3,
  // v1.13.4：巡检「连续失效自动禁用」的阈值（patrolJudge 的 streak 达到即处置、
  // apiDownVerdict 的域名判死同用此值）。之前无 config 键也无 UI，恒为隐藏默认 2（P-1429 #6）。
  // 语义次序：失效 streak 先到 patrolDisableAfter → 禁用；继续失效到 patrolDeleteAfter 且
  // patrolAutoDelete 开 → 删除。所以本值应 ≤ patrolDeleteAfter 才有「先禁后删」。
  patrolDisableAfter: 2,
  enableAfterImport: true,
  autoAllowUnsafeVM: false,
  allowUnsafeVM: false,
  skipUnusable: true,
  // 自动剔除高危混淆/反调试脚本（v1.7.1 引入时默认关，v1.9.5 起默认开）：
  // 开启后检测阶段与每次灌入前都会拒绝 high 级脚本——密度超高阈值，或命中反调试硬特征
  // （while(!![]){} 空转死循环 / 混淆自调度定时器 / jsjiami 标识）。
  // 依据：lx-ikun issue#8（音源脚本没有混淆的必要）+ 2026-10-15 NAS CPU 占用实测
  // （jsjiami.com.v7 混淆的「洛雪音乐源.js」独吞 63%~67% 单核 + 270MB，其余 45 个源合计≈0%）。
  // mid 级（局部混淆）只标注不剔除，由用户自行甄别。
  excludeHighRiskObfuscated: true,
  // 混淆隔离信任名单（v1.10.7）：被隔离条目的 contentHash 列表。
  // 用户在「混淆隔离」页对无恶意硬特征的混淆脚本点「信任」后，检测/灌入两道闸门按
  // 内容哈希放行（内容一变哈希就变，重新混入隔离区——信任不跟随未知的新版本）。
  // 只豁免这一个维度：深度体检 / 巡检 / 可用性判定照常执行。
  trustedObfHashes: [],
  // 批量删除公开源时，每个删除之间的间隔（毫秒）。
  // 背景：lxserver 每次 delete 都会全量重载所有脚本，连续删除会把服务端拖到假死
  // （v1.6.8 教训：12 连删导致 Docker 重启）。留间隔让服务端喘口气。
  serverDeleteIntervalMs: 5000,
  debugMode: false
}

class Store {
  constructor(dir) {
    this.dir = dir
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    this.configFile = path.join(dir, 'config.json')
    this.dbFile = path.join(dir, 'sources.json')
    this.importedFile = path.join(dir, 'imported.json')
    const rawCfg = this._read(this.configFile)
    this.config = Object.assign({}, DEFAULT_CONFIG, rawCfg)
    // v1.11.0：旧配置只有 forceProxy，按它推导 proxyPolicy，保证升级后行为不变
    if (rawCfg && rawCfg.proxyPolicy == null && rawCfg.forceProxy === true) this.config.proxyPolicy = 'force'
    this.db = this._read(this.dbFile) || { sources: {}, lastCrawl: 0, patrol: { lastRun: 0 } }
    if (!this.db.sources) this.db.sources = {}
    if (!this.db.patrol) this.db.patrol = { lastRun: 0 }
    // v1.10.2 手动删除记录：被删掉的 id 不再由自动采集加回（见 removeSources）
    if (!Array.isArray(this.db.deletedIds)) this.db.deletedIds = []
    // 兜底：清理进程中断残留的「检测中」标记
    for (const k of Object.keys(this.db.sources)) delete this.db.sources[k].checking
    this.imported = this._read(this.importedFile) || {}
    // 多平台模型迁移：把旧版单账号字段收敛进 platforms 数组，保证向后兼容
    if (this._migratePlatforms()) this.saveConfig()
    // 仓库清单迁移（v1.9.12）：首次启动把内置 38 个 + 旧附加仓库播种进统一 repos 清单
    if (this._ensureRepoList()) this.saveConfig()
  }

  /**
   * 旧版 → 多平台迁移（v1.8.0）：
   *  - platforms 为空且存在旧版 serverUrl → 生成第一个 lxserver 账号；
   *  - platforms 非空但 activePlatformId 缺失 → 指向第一个账号。
   * 返回是否有写入过迁移。
   */
  /**
   * 仓库清单迁移（v1.9.12）：首次启动（config.repos 未初始化）时，从内置 DEFAULT_REPOS
   * （builtin）+ 旧 customRepos（custom）播种出统一清单，使所有仓库都进入可管理状态。
   * 已有 repos 数组（哪怕为空）则尊重用户编辑，不再播种。返回是否发生过写入。
   */
  _ensureRepoList() {
    if (Array.isArray(this.config.repos)) return false
    const out = []
    const seen = new Set()
    for (const r of DEFAULT_REPOS) {
      const n = normalizeRepo(r)
      if (n && !seen.has(n)) { seen.add(n); out.push({ repo: n, enabled: true, builtin: true, origin: 'builtin' }) }
    }
    for (const r of (this.config.customRepos || [])) {
      const n = normalizeRepo(r)
      if (n && !seen.has(n)) { seen.add(n); out.push({ repo: n, enabled: true, builtin: false, origin: 'custom' }) }
    }
    this.config.repos = out
    this.config.customRepos = [] // 旧字段已并入 repos，清空避免与 legacy 回退路径重复计数
    return true
  }

  _migratePlatforms() {
    let changed = false
    if (!Array.isArray(this.config.platforms) || this.config.platforms.length === 0) {
      if (this.config.serverUrl) {
        this.config.platforms = [{
          id: 'p_default',
          type: 'lxserver',
          name: '默认 LX 服务',
          url: this.config.serverUrl || '',
          username: this.config.username || 'default',
          password: this.config.adminPassword || '',
          timeoutMs: this.config.serverTimeoutMs || 25000,
          enabled: true
        }]
        changed = true
      } else {
        this.config.platforms = []
      }
      this.config.activePlatformId = this.config.platforms.length ? this.config.platforms[0].id : null
      changed = true
    } else if (!this.config.activePlatformId || !this.config.platforms.find(p => p.id === this.config.activePlatformId)) {
      this.config.activePlatformId = this.config.platforms[0].id
      changed = true
    }
    // 给老账号补默认字段，避免适配器读不到
    for (const p of this.config.platforms) {
      if (!p.id) { p.id = 'p_' + Math.random().toString(36).slice(2, 9); changed = true }
      if (typeof p.timeoutMs !== 'number') { p.timeoutMs = 25000; changed = true }
      if (typeof p.enabled !== 'boolean') { p.enabled = true; changed = true }
      // Geelonn 语义修正（v1.9.4）：v1.9.3 把「用户名」直接当登录账号用，导致音源全被灌进
      // 该账号的**私有**列表（网页端公开列表看不到）。现在「用户名」＝灌入落点、登录账号独立
      // 成 loginUser：老账号把 username 迁到 loginUser，落点恢复默认＝公开源。
      if (p.type === 'geelonn' && !p.loginUser) {
        p.loginUser = p.username || 'admin'
        p.username = ''
        changed = true
      }
    }
    return changed
  }

  _read(f) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { return null }
  }

  _write(f, obj) {
    // P-1429：改为"写临时文件 + rename"两步。之前直接 writeFileSync 覆盖 17MB 的
    // sources.json，写盘中途断电/崩溃/磁盘满会留下半个文件，下次启动 JSON 解析失败
    // = 数据看着"丢了"。同目录 rename 在同一文件系统上是原子操作，最坏只剩完整的旧文件。
    // 目录权限不足（rename 需要目录写权限）时回退旧的直接写——最坏退化为旧行为，不会更糟。
    try {
      const tmp = f + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8')
      fs.renameSync(tmp, f)
      return true
    } catch (e1) {
      try { if (fs.existsSync(f + '.tmp')) fs.unlinkSync(f + '.tmp') } catch (e2) {}
      try {
        fs.writeFileSync(f, JSON.stringify(obj), 'utf8')
        return true
      } catch (e3) {
        return false
      }
    }
  }

  saveConfig(patch) {
    if (patch) {
      this.config = Object.assign(this.config, patch)
      // v1.11.0：两个字段必须始终一致，避免只提交其中一个时行为漂移
      if (patch.proxyPolicy != null) this.config.forceProxy = patch.proxyPolicy === 'force'
      else if (typeof patch.forceProxy === 'boolean') this.config.proxyPolicy = patch.forceProxy ? 'force' : 'auto'
    }
    return this._write(this.configFile, this.config)
  }

  saveDb() { return this._write(this.dbFile, this.db) }
  saveImported() { return this._write(this.importedFile, this.imported) }

  // ---------------- 脚本正文副本（v1.12.7） ----------------
  // 为什么留副本：服务端 list 不回脚本正文，也不回逐平台实测结论（`/api/custom-source/list`
  // 只给 name/version/homepage/size/supportedSources）。要判断「服务端那条现在到底怎么样」，
  // 唯一可行的是本地留一份**当初灌进去的那份正文**，用于：
  //   1) 与服务端 size 对账 —— 不符说明服务端已被换过，本地打分快照不再代表它；
  //   2) 需要时在本地沙箱复测（走的是同一套 checker，不改服务端）。
  // 按 contentHash 命名，天然去重；单条约 50KB，1400 条约 70MB。
  scriptDir() {
    const d = path.join(this.dir, 'scripts')
    try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }) } catch (e) { /* 目录建不出来就退化为不落档 */ }
    return d
  }

  /**
   * 只接受 sha256 hex（防路径穿越），且**不做任何 IO** —— 批量对账时会被调用上千次，
   * 每次都 mkdir/exists 检查会白算几千次系统调用。建目录交给 scriptDir()/archiveScript。
   */
  _scriptPath(hash) {
    const h = String(hash || '')
    if (!/^[0-9a-f]{16,64}$/i.test(h)) return ''
    return path.join(this.dir, 'scripts', h + '.js')
  }

  /** 落档（已存在则跳过：同内容不同条目不重复写） */
  archiveScript(hash, code) {
    if (typeof code !== 'string' || !code) return false
    const f = this._scriptPath(hash)
    if (!f) return false
    this.scriptDir()
    try {
      if (fs.existsSync(f) && fs.statSync(f).size === Buffer.byteLength(code, 'utf8')) return true
      fs.writeFileSync(f, code, 'utf8')
      return true
    } catch (e) { return false }
  }

  readScript(hash) {
    const f = this._scriptPath(hash)
    if (!f) return null
    try { return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null } catch (e) { return null }
  }

  /** 副本字节数；没有副本返回 0（0 表示「不知道」，调用方不能据此判定不符） */
  scriptSize(hash) {
    const f = this._scriptPath(hash)
    if (!f) return 0
    try { return fs.existsSync(f) ? fs.statSync(f).size : 0 } catch (e) { return 0 }
  }

  /**
   * 存量补档：把本地库里已经存着正文（压缩包内脚本 / 采集时保存过 code）的条目
   * 按 contentHash 复制一份到副本目录。零网络，纯本地搬运。
   * @returns {{archived:number, skipped:number}}
   */
  backfillScripts() {
    let archived = 0, skipped = 0
    for (const e of Object.values(this.db.sources || {})) {
      if (!e || !e.contentHash || typeof e.code !== 'string' || !e.code) { skipped++; continue }
      if (this.scriptSize(e.contentHash) > 0) { skipped++; continue }
      if (this.archiveScript(e.contentHash, e.code)) archived++
      else skipped++
    }
    return { archived, skipped }
  }

  addSources(items) {
    let added = 0
    for (const it of this._undeleted(items)) {
      if (!this.db.sources[it.id]) { this.db.sources[it.id] = it; added++ }
    }
    return added
  }

  /**
   * 增量合并（定时爬取用，v1.7.0）：
   *  - 新 id → 入库（added）
   *  - 已有 id + 树内 .js 的 blobSha 变了 → 标 stale（raw 链接指向 HEAD，
   *    下次指纹 pass 会重新下载，哈希真变了才更新 + 重置检测结果）
   *  - 已有 id + 带 code 的条目（压缩包内/release 资产）内容哈希变了 → 就地更新：
   *    换 code/hash、重置检测结果（status/usable/deep/lastCheck）、标 updated，
   *    并撤销它此前的「重复废弃」标记（内容已是新版本，交给去重重新裁决）
   *  - 其余 → skipped（已抓取且未变，默认不重抓）
   * @returns {{added, updated, skipped}}
   */
  mergeSources(items, opts) {
    const incremental = !opts || opts.incremental !== false
    const res = { added: 0, updated: 0, skipped: 0 }
    if (!incremental) return this._addCount(items, res)
    for (const it of this._undeleted(items)) {
      const cur = this.db.sources[it.id]
      if (!cur) { this.db.sources[it.id] = it; res.added++; continue }
      let changed = false
      // 树内 .js：blob sha 变化 = 上游内容可能变了（URL 指向 HEAD，无需现在下载）
      if (it.blobSha && cur.blobSha && it.blobSha !== cur.blobSha) {
        cur.blobSha = it.blobSha
        cur.stale = true
        cur.staleAt = Date.now()
        // v1.12.3：树内 .js 换版必须同步撤销废弃标记 —— stale 的废弃条目永远不会被
        // 指纹 pass 重下（_hashPass 过滤 deprecated），旧内容会永久滞留库内
        // （豆包定制[聚合音源] 2026-11-10 实测：上游已更新、库内滞留旧版且无人复活）。
        if (cur.deprecated) { cur.deprecated = false; cur.dupOf = null; cur.dupReason = null }
        changed = true
      } else if (it.blobSha && !cur.blobSha) {
        cur.blobSha = it.blobSha
      }
      // 压缩包内 / release 资产：内容就地比对，真变了才更新
      if (it.code && cur.code && it.contentHash && cur.contentHash && it.contentHash !== cur.contentHash) {
        cur.code = it.code
        cur.contentHash = it.contentHash
        cur.size = it.size != null ? it.size : cur.size
        cur.status = 'unknown'
        cur.suspected = it.suspected != null ? it.suspected : cur.suspected
        cur.usable = false
        cur.deep = null
        cur.lastCheck = 0
        cur.updated = true
        cur.updatedAt = Date.now()
        cur.stale = false
        // 内容已换版：撤销此前的重复废弃标记，让去重按新内容重新裁决
        if (cur.deprecated) { cur.deprecated = false; cur.dupOf = null; cur.dupReason = null }
        changed = true
      } else if (it.code && !cur.code) {
        cur.code = it.code
        if (it.contentHash) cur.contentHash = it.contentHash
        changed = true
      }
      if (changed) res.updated++
      else res.skipped++
    }
    return res
  }

  _addCount(items, res) {
    for (const it of this._undeleted(items)) {
      if (!this.db.sources[it.id]) { this.db.sources[it.id] = it; res.added++ }
      else res.skipped++
    }
    return res
  }

  getSources() { return Object.values(this.db.sources) }

  /** 手动删除记录（不再自动采集名单）的快照，避免调用方直接改内部数组。 */
  deletedIds() { return Array.isArray(this.db.deletedIds) ? this.db.deletedIds.slice() : [] }

  isDeleted(id) {
    return Array.isArray(this.db.deletedIds) && this.db.deletedIds.indexOf(id) >= 0
  }

  /** 自动入库统一过滤：被用户手动删掉的 id 不再由爬取 / 采集站 / 服务端同步加回。 */
  _undeleted(items) {
    const gone = this.deletedIds()
    if (!gone.length) return items || []
    const set = new Set(gone)
    return (items || []).filter(it => it && it.id && !set.has(it.id))
  }

  /**
   * 手动删除音源（v1.10.2）：按 id 从本地音源库移除，并记入「不再自动采集」名单。
   *  - 只动本地库：服务端上已灌入的脚本不受影响，要撤掉请用「已灌入」页的删除；
   *  - 保留 imported 账本（它描述的是服务端状态）；本地条目没了以后，巡检队列里
   *    取不到 sources[srcId] 会自动跳过，不会把已删条目当作待巡检目标；
   *    **例外**：(服务端) 占位条目（srv:… / fromServer）要连账本一起摘掉 —— 它本来就
   *    是本地快照，留着会成孤儿：巡检跳过它，而「只选未灌入」又因账本仍标已灌入
   *    把它排除，结果既不再被巡检、想重灌也灌不进去；
   *  - 记入 deletedIds 后，runCrawl / 采集站 / 非增量合并都不会把它加回来；
   *  - 恢复途径：导入音源库 JSON（mergeFrom 自动解除）、重新导入同名私人源，
   *    或 clearDeletedIds() 清空记录后重新爬取。
   * @returns {{deleted:number, missing:string[], blocked:number, ledgerDropped:number}}
   */
  removeSources(ids) {
    const list = Array.isArray(ids) ? ids.filter(x => typeof x === 'string' && x).slice(0, 5000) : []
    if (!list.length) return { deleted: 0, missing: [], blocked: this.deletedIds().length, ledgerDropped: 0 }
    if (!Array.isArray(this.db.deletedIds)) this.db.deletedIds = []
    const gone = new Set(this.db.deletedIds)
    const missing = []
    let deleted = 0, ledgerDropped = 0
    for (const id of new Set(list)) {
      const entry = this.db.sources[id]
      if (!entry) { missing.push(id); continue }
      delete this.db.sources[id]
      if (!gone.has(id)) { this.db.deletedIds.push(id); gone.add(id) }
      const isSnapshot = !!entry.fromServer || /^srv:/.test(id)
      if (isSnapshot && this.imported && this.imported[id]) {
        delete this.imported[id]
        ledgerDropped++
      }
      deleted++
    }
    if (ledgerDropped) this.saveImported()
    if (deleted) this.saveDb()
    return { deleted, missing, blocked: this.db.deletedIds.length, ledgerDropped }
  }

  /** 清空删除记录：这些音源后续可以重新被自动采集收录（不会自动立刻出现）。 */
  clearDeletedIds() {
    const cleared = this.deletedIds().length
    this.db.deletedIds = []
    if (cleared) this.saveDb()
    return { cleared }
  }

  // 整库清空 = 从零开始，连同删除记录一起清掉，否则之后爬取会莫名少几条
  clearSources() { this.db.sources = {}; this.db.deletedIds = []; this.saveDb() }

  /**
   * 导入单个音源并标记「私人」（v1.10.0）：
   *  - id 固定为 private::<文件名>，repo 标「私人音源」，条目带 private:true；
   *  - 私人源受保护：不参与去重废弃，且完全不参与健康巡检（不重测、不累计失效、
   *    不自动禁用/删除，见 hunter.js buildPatrolItems）；用户仍可手动检测与灌入；
   *  - 同名（同文件名）重复导入 = 更新：换 code/hash、重置检测结果，保留原 addedAt。
   * @param {string} name 文件名（如 xxx.js，可不带扩展名）
   * @param {string} code 脚本全文
   * @returns {{entry:object, added:boolean, updated:boolean}}
   */
  addPrivateSource(name, code) {
    const { scoreEntry, sha256Str } = require('./checker')
    const clean = String(name || '').replace(/\.js$/i, '').replace(/[\\/:*?"<>|\s]+/g, '_').trim() || 'private-source'
    const text = String(code || '')
    if (!text.trim()) throw new Error('脚本文本为空')
    if (text.length > 2 * 1024 * 1024) throw new Error('脚本过大（超过 2MB）')
    const id = 'private::' + clean
    const prev = this.db.sources[id]
    const score = scoreEntry(clean + '.js', text)
    const entry = {
      id,
      repo: '私人音源',
      path: clean + '.js',
      url: '',
      name: clean,
      code: text,
      contentHash: sha256Str(text),
      suspectScore: score,
      status: 'unknown',
      suspected: score >= 4,
      usable: false,
      size: text.length,
      addedAt: prev && prev.addedAt ? prev.addedAt : Date.now(),
      lastCheck: 0,
      deep: null,
      private: true
    }
    if (prev) {
      // 重复导入视为更新：旧内容换新，检测与可用性重置，废弃标记撤销（内容已是新的）
      if (prev.deprecated) { entry.dupOf = null; entry.dupReason = null }
    }
    // 手动重新导入同名私人音源 = 明确恢复，解除「不再采集」记录
    this.db.deletedIds = this.deletedIds().filter(x => x !== id)
    this.db.sources[id] = entry
    this.saveDb()
    return { entry, added: !prev, updated: !!prev }
  }

  /**
   * 从导出文件合并数据（检测结果导入，换机迁移不用重跑）：
   *  - 按 id 合并条目：本地没有 → 新增；两边都有 → 保留检测时间较新的版本
   *  - 按 contentHash 补结果：本地某条没检测过，但导入数据里有同内容条目的检测结果 → 直接复制
   *  - 合并已灌入记录（按 key，本地已有则跳过）
   */
  mergeFrom(data) {
    if (!data || !Array.isArray(data.sources)) throw new Error('文件格式不正确：缺少 sources 数组')
    const res = { added: 0, updated: 0, copied: 0, importedAdded: 0, importedSkipped: 0, total: 0 }
    res.total = data.sources.length
    // 用户主动导入音源库 = 明确想恢复：导入文件里出现的 id 一律解除「不再采集」记录，
    // 否则从备份 JSON 也救不回被手动删掉的条目。
    const revived = new Set()
    for (const s of data.sources) if (s && s.id) revived.add(s.id)
    if (revived.size) this.db.deletedIds = this.deletedIds().filter(id => !revived.has(id))
    // 内容哈希 -> 最佳检测结果（取 checkedAt 最新的）
    const bestByHash = {}
    for (const s of data.sources) {
      if (!s || !s.id || !s.deep || !s.contentHash) continue
      const cur = bestByHash[s.contentHash]
      if (!cur || ((s.deep.checkedAt || 0) > (cur.deep.checkedAt || 0))) bestByHash[s.contentHash] = s
    }
    for (const s of data.sources) {
      if (!s || !s.id) continue
      delete s.checking
      const cur = this.db.sources[s.id]
      if (!cur) {
        this.db.sources[s.id] = s
        res.added++
        continue
      }
      const curT = (cur.deep && cur.deep.checkedAt) || 0
      const newT = (s.deep && s.deep.checkedAt) || 0
      if (newT > curT) {
        this.db.sources[s.id] = Object.assign({}, cur, s)
        res.updated++
      }
    }
    // 哈希补结果：本地未检测的同内容条目直接复用导入的检测结果
    for (const e of Object.values(this.db.sources)) {
      if (e.deep || !e.contentHash) continue
      const best = bestByHash[e.contentHash]
      if (!best) continue
      e.deep = best.deep
      e.usable = usableCount(e) > 0
      e.suspected = best.suspected != null ? best.suspected : e.suspected
      if (!e.scriptName && best.scriptName) e.scriptName = best.scriptName
      if (!e.lxName && best.lxName) e.lxName = best.lxName
      if (!e.lastModified && best.lastModified) e.lastModified = best.lastModified
      res.copied++
    }
    for (const [k, v] of Object.entries(data.imported || {})) {
      if (!this.imported[k]) { this.imported[k] = v; res.importedAdded++ }
      else res.importedSkipped++
    }
    if (data.lastCrawl > (this.db.lastCrawl || 0)) this.db.lastCrawl = data.lastCrawl
    this.saveDb()
    this.saveImported()
    return res
  }
}

module.exports = { Store, DEFAULT_CONFIG }
