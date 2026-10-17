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
  // ---------------- 网络加速（v1.9.7，借鉴 songloft 版设置页） ----------------
  // crawlProxy：HTTP 代理（http://host:port），仅作用于 GitHub 爬取链（仓库扫描/脚本/压缩包下载），
  // 不影响音源检测的播放请求与灌入；forceProxy：把代理排到候选链最前；
  // useJsdelivr：jsDelivr 是否参与镜像候选链；mirrorCustom：镜像选「自定义…」时的前缀基址。
  crawlProxy: '',
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
  // ---------------- 接口域名探活（v1.9.10，借鉴 lxhub 的 api_hosts/api_alive） ----------------
  // apiHostCheck：检测时额外对脚本引用的后端域名做轻量存活探测（默认关，开启会为每个音源多发若干请求）。
  apiHostCheck: false,
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
  crawlScheduleEnabled: false,
  crawlIntervalHours: 24,
  crawlSinceDays: 0,
  // v1.9.0：定时爬取跑完后自动接上「检测 → 灌入」（全链路无人值守）。
  // 从属于 crawlScheduleEnabled：定时爬取本身没开，也就无所谓「爬完自动灌」。
  crawlAutoImport: false,
  // 同名音源裁决的**兜底**开关（不是全部规则！）：
  // 灌入时先按 hunter.sameNameVerdict 里那 6 条硬规则判（同名同内容不重传 / 本地全挂不替换 /
  // 服务端平台更多保留现条目 / 版本高的赢 / 平台无交集则改名并存 / 有交集则替换），
  // 全都判不出来（两边信息都不足）时才看这里：true=替换服务端旧版（先删后传），false=改名并存。
  replaceSameNameOnImport: true,
  patrolAutoDisable: true,
  // v1.9.1：巡检连续失效「自动删除音源」。
  // 与 patrolAutoDisable（自动禁用）的区别：禁用只是把该音源在五个平台上的开关关掉、
  // 音源本体仍留在库里；自动删除则是从服务端 + 本地库一并移除（服务端每次 delete 都会全量
  // 重载脚本，故删除需严格串行化并保留 serverDeleteIntervalMs 间隔，避免服务端假死）。
  // patrolAutoDelete=false（默认）时仅禁用不删；开启后连续 patrolDeleteAfter 次（默认 3）
  // 巡检判定 dead 才走删除。注意：本地（未灌入服务端）的音源无论开关如何都只禁用、不删。
  patrolAutoDelete: false,
  patrolDeleteAfter: 3,
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
    this.config = Object.assign({}, DEFAULT_CONFIG, this._read(this.configFile))
    this.db = this._read(this.dbFile) || { sources: {}, lastCrawl: 0, patrol: { lastRun: 0 } }
    if (!this.db.sources) this.db.sources = {}
    if (!this.db.patrol) this.db.patrol = { lastRun: 0 }
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
    try { fs.writeFileSync(f, JSON.stringify(obj), 'utf8'); return true } catch (e) { return false }
  }

  saveConfig(patch) {
    if (patch) this.config = Object.assign(this.config, patch)
    return this._write(this.configFile, this.config)
  }

  saveDb() { return this._write(this.dbFile, this.db) }
  saveImported() { return this._write(this.importedFile, this.imported) }

  addSources(items) {
    let added = 0
    for (const it of items) {
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
    for (const it of items || []) {
      const cur = this.db.sources[it.id]
      if (!cur) { this.db.sources[it.id] = it; res.added++; continue }
      let changed = false
      // 树内 .js：blob sha 变化 = 上游内容可能变了（URL 指向 HEAD，无需现在下载）
      if (it.blobSha && cur.blobSha && it.blobSha !== cur.blobSha) {
        cur.blobSha = it.blobSha
        cur.stale = true
        cur.staleAt = Date.now()
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
    for (const it of items || []) {
      if (!this.db.sources[it.id]) { this.db.sources[it.id] = it; res.added++ }
      else res.skipped++
    }
    return res
  }

  getSources() { return Object.values(this.db.sources) }

  clearSources() { this.db.sources = {}; this.saveDb() }

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
