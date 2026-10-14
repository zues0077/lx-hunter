'use strict'
/** 任务编排：爬取 / 检测 / 灌入 / 撤回 */
const { crawl, DEFAULT_REPOS, normalizeRepo } = require('./crawler')
const { checkBasic, deepCheck, extractMeta, sha256Str, usableCount, stoppable, isLocalNetworkIssue, patrolJudge, obfuscationRisk, obfuscationTip } = require('./checker')
const { crawlFetch, readText, sleep } = require('./net')
const lx = require('./lxservice')
const { Store } = require('./store')

function normName(s) {
  return String(s || '').toLowerCase().replace(/[\[\]【】（）()|｜:：、,，.。\s_\-·•]+/g, '')
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

// 注：原先这里的规则只认英文 "fetch failed"，而沙箱抛的是中文「沙箱 fetch 失败」，
// 导致全平台网络失败会被判死并自动禁用。现统一改由 checker.isLocalNetworkIssue 判定。

/** 是否为「本地真实候选」：服务端原生占位 / 无脚本地址的条目不参与检测与去重 */
function isLocalSource(e) {
  return !!e && !e.fromServer && !e.deprecated && !!e.url
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

  // ---------------- 爬取 ----------------
  /**
   * @param {object} [opts] {incremental} —— 定时爬取传 true：
   *  已抓取的默认不重抓（blob sha / release 资产 key 判重），只收新音源；
   *  内容有变化的就地更新（压缩包/release 资产）或标记待重下（树内 .js）。
   */
  async runCrawl(opts) {
    if (this.job.running) throw new Error('已有任务在运行')
    const cfg = this.store.config
    const incremental = !!(opts && opts.incremental)
    // reposOverride 非空时只爬这些仓库（省 GitHub 配额，也便于定向补源）
    let repos
    if (Array.isArray(cfg.reposOverride) && cfg.reposOverride.length) {
      repos = this._normRepos(cfg.reposOverride, '定向仓库')
    } else {
      repos = DEFAULT_REPOS.slice().concat(this._normRepos(cfg.customRepos || [], '附加仓库'))
    }
    this.job = { running: true, type: 'crawl', cancel: false, progress: { reposDone: 0, repoTotal: repos.length, added: 0, linksFound: 0 }, step: '' }
    this.emit('job', { running: true, type: 'crawl' })
    this.log((incremental ? '定时增量爬取' : '开始爬取') + ` ${repos.length} 个仓库（文件树 + Releases）…`, '爬取')
    let total = 0
    const merge = { added: 0, updated: 0, skipped: 0 }
    try {
      const known = this._knownMaps()   // 手动/定时爬取都用判重地图：压缩包 sha 未变不解压、release 资产已抓不重下
      // crawlSinceDays（v1.7.2）：只爬 N 天内有更新的仓库（0=不限）。静默仓库整仓跳过，
      // 新发布的 release 资产也按发布时间过滤——树内文件不受影响（sha 判重已覆盖）。
      const sinceDays = Math.max(0, Number(cfg.crawlSinceDays) || 0)
      await crawl({ repos, token: cfg.ghToken, maxCandidatesPerRepo: cfg.maxCandidatesPerRepo, timeoutMs: cfg.timeoutMs, mirror: cfg.mirror, known, sinceDays },
        (type, payload) => {
          if (type === 'repo') {
            // 统一走增量合并（v1.7.0）：手动爬取与定时爬取行为一致——
            // 已抓取的不重抓（blob sha/资产 key/内容哈希判重），内容变了标 updated/stale 待重下。
            const m = this.store.mergeSources(payload.items, { incremental: true })
            merge.added += m.added; merge.updated += m.updated; merge.skipped += m.skipped
            total = merge.added
            this.progress({ reposDone: payload.repo, added: total, linksFound: (this.job.progress.linksFound || 0) + payload.candidates })
          } else if (type === 'log') {
            this.log(payload.msg, payload.module, payload.level)
          } else if (type === 'progress') {
            this.step(payload.step)
            this.progress({ reposDone: payload.reposDone, repoTotal: payload.repoTotal })
          }
        },
        () => this.cancelRequested)
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
    return { added: total, updated: merge.updated, skipped: merge.skipped }
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
    // ① 同内容（已下载过的才有哈希，最可靠）
    const checked = all.filter(e => !e.deprecated && !e.fromServer && e.status === 'ok' && e.contentHash)
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
      if (e.deprecated || e.fromServer || !e.contentHash) continue
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
      if (!e.deprecated || e.fromServer || e.dupReason !== '同名旧版本（已有更新版本）') continue
      const keeper = e.dupOf ? all.find(x => x.id === e.dupOf) : null
      if (!keeper || keeper.deprecated || !keeper.contentHash || keeper.contentHash === e.contentHash) continue
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
      if (e.deprecated || e.fromServer || e.contentHash || e.status === 'dead') continue
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

  // ---------------- 检测 ----------------
  async runCheck(ids, opts) {
    if (this.job.running) throw new Error('已有任务在运行')
    const opt = opts || {}
    // full=true：全平台完整检测（关掉快速模式并强制重测），用于「补全平台覆盖」
    const cfg = opt.full ? Object.assign({}, this.store.config, { quickCheck: false }) : this.store.config
    // 单条手动检测 = 强制重测；批量时默认跳过「已检测且脚本内容未变」的条目
    const force = opt.full || !ids || ids.length <= 1
    const picked = (ids && ids.length ? ids.map(i => this.store.db.sources[i]).filter(Boolean) : this.store.getSources())
    // 服务端原生音源：服务端 list 会带 sourceUrl（当年经 URL 导入时留存的原始脚本地址），
    // 有地址的同样可以下载 + 沙箱真实取链检测 —— 过去一律跳过，用户点「检测」毫无反应
    const list = picked.filter(e => !e.deprecated && (!e.fromServer || e.url))
    // 静默过滤是「点了检测却毫无反应」的根源：重复合并项/无脚本地址的服务端音源本来就不该本地检测，
    // 但用户不知道，只会以为功能坏了。这里必须说清楚跳过了多少、为什么。
    let excluded = picked.length - list.length
    // 混淆剔除（v1.7.1，默认关）：开启后检测阶段直接拒绝重度混淆脚本——
    // 音源脚本没有混淆的必要，重度混淆常用于藏木马/后门（lx-ikun issue#8 科普）。
    // 只剔 high（密度远超防和谐所需的局部混淆），mid 级标注不剔除，由用户自行判断。
    let obfRejected = 0
    if (cfg.excludeHighRiskObfuscated) {
      const kept = []
      for (const e of list) {
        const code = typeof e.code === 'string' && e.code ? e.code : null
        if (code) {
          const risk = obfuscationRisk(code)
          if (risk.level === 'high') {
            e.status = 'dead'
            e.error = '重度混淆脚本，已按设置剔除'
            e.obfLevel = 'high'
            e.obfHits = risk.hits
            e.usable = false
            obfRejected++
            this.emit('source-updated', e)
            continue
          }
        }
        kept.push(e)
      }
      if (obfRejected) {
        list.length = 0
        list.push(...kept)
        excluded += obfRejected
      }
    }
    if (obfRejected) this.log(`已按设置剔除 ${obfRejected} 条重度混淆脚本（高危，建议拒绝使用；可在设置里关闭此剔除）`, '安全', 'warn')
    if (ids && ids.length && !list.length) {
      this.log(`所选 ${picked.length} 条全部无需本地检测（已合并的重复项 / 无原始脚本地址的服务端音源 / 高危混淆剔除），未执行检测`, '检测', 'warn')
      return { usable: 0, total: 0, excluded, notSource: 0, depInline: 0 }
    }
    this.job = { running: true, type: 'check', cancel: false, progress: { done: 0, total: list.length, usable: 0 }, step: '' }
    this.emit('job', { running: true, type: 'check' })
    this.log(`开始检测 ${list.length} 条候选（下载 + 沙箱真实取链，并发 ${Math.max(1, Math.min(16, cfg.concurrency || 8))}${cfg.quickCheck !== false ? '，快速模式（首个平台可用即停，其余标记未测）' : '，全平台完整检测'}）…`, '检测')

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
    const dup = this.dedupe()
    if (this.cancelRequested) this.log('检测已取消（已完成的检测结果全部保留）', '检测', 'warn')
    else this.log(`检测完成：可用 ${usable} 条 / 共 ${list.length} 条` +
      (skippedChecked ? `，跳过已检测 ${skippedChecked} 条` : '') +
      (depInline ? `，即时去重废弃 ${depInline} 条` : '') +
      (excluded ? `，跳过重复合并项/服务端原生 ${excluded} 条` : '') +
      (notSource ? `，非典型音源 ${notSource} 条` : '') +
      (obfSeen.high ? `，重度混淆 ${obfSeen.high} 条（状态栏有标记，建议拒绝使用）` : '') +
      (obfSeen.mid ? `，局部混淆 ${obfSeen.mid} 条（可能防和谐，自行甄别）` : '') +
      ((dup.dupFile || dup.dupContent || dup.oldVersion) ? `，收尾去重 ${dup.dupFile + dup.dupContent + dup.oldVersion} 条` : ''), '检测')
    this.job.running = false
    this.emit('job', { running: false, type: 'check', done: true, cancelled: this.cancelRequested, usable, total: list.length, notSource, depInline, obfHigh: obfSeen.high || 0, obfMid: obfSeen.mid || 0 })
    return { usable, total: list.length, notSource, depInline, obfHigh: obfSeen.high || 0, obfMid: obfSeen.mid || 0 }
  }

  // ---------------- 快速指纹去重（爬取后先跑，检测就跳过重复） ----------------
  /**
   * 只下载 + 算 sha256 + 正则提取元信息（不进沙箱，非常快），
   * 然后按内容哈希、@name 去重。检测阶段直接跳过被废弃的孪生条目，
   * 省掉最贵的沙箱取链耗时。
   */
  async runHash(ids) {
    if (this.job.running) throw new Error('已有任务在运行')
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
          const { code } = await checkBasic(e, cfg, (t, p) => this.emit(t, p), this.mirrorPref)
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

  // ---------------- 灌入 ----------------
  async runImport(ids) {
    if (this.job.running) throw new Error('已有任务在运行')
    const cfg = this.store.config
    const targets = (ids || []).map(i => this.store.db.sources[i]).filter(Boolean)
    if (!targets.length) throw new Error('没有选中任何音源')

    this.job = { running: true, type: 'import', cancel: false, progress: { done: 0, total: targets.length }, step: '' }
    this.emit('job', { running: true, type: 'import' })

    const results = []
    const v = await lx.verify(cfg)
    if (!v.ok) {
      this.job.running = false
      this.emit('job', { running: false, type: 'import', done: true })
      throw new Error('LX 服务不可用：' + v.msg)
    }
    this.log('已连接 LX 服务：' + v.msg, '灌入')

    // 服务端现有列表（用于同名保护）
    let serverList = []
    try { serverList = await lx.list(cfg) } catch (e) {
      this.log('读取服务端音源列表失败：' + String((e && e.message) || e) + '（同名保护将跳过）', '灌入', 'warn')
    }
    const serverByName = {}
    for (const s of serverList) if (s && s.name) serverByName[normName(s.name)] = s

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

    // 去重与同名裁决规划（抽成纯函数 _planImportQueue，便于单测）
    const importedHashes = {}
    for (const eid of Object.keys(this.store.imported)) {
      const rec = this.store.imported[eid]
      if (rec && rec.contentHash) importedHashes[rec.contentHash] = rec.name
    }
    const queue = this._planImportQueue(targets, { cfg, serverByName, codeCache, importedHashes })
    const usedRename = new Set()

    for (let i = 0; i < queue.length; i++) {
      if (this.cancelRequested) { this.log('用户取消灌入', '灌入', 'warn'); break }
      const item = queue[i]
      const e = item.e
      const name = e.scriptName || e.lxName || e.name
      if (item.skip) {
        results.push({ id: e.id, name, status: 'skipped', message: item.skip })
        this.log('跳过：' + name + ' — ' + item.skip, '灌入', 'warn')
        this.emit('import-item', results[results.length - 1])
        this.progress({ done: i + 1, total: queue.length })
        continue
      }
      this.step(`灌入 ${i + 1}/${queue.length} ${name}`)
      try {
        let r = null
        if (item.sameContentServer) {
          // 同名 + 同内容：服务端已有，不重复上传，直接标记为「已灌入」
          const srv = item.sameContentServer
          this.store.imported[e.id] = {
            lxId: srv.id, name: srv.name || name, contentHash: e.contentHash || '',
            serverUrl: lx.baseUrl(cfg), importedAt: Date.now(),
            platforms: srv.supportedSources || [], serverSynced: true
          }
          this.store.saveImported()
          results.push({ id: e.id, name, status: 'synced', lxId: srv.id, message: '与服务端同名同内容，已标记为已灌入（未重复上传）', platforms: srv.supportedSources || [] })
          this.log('同名同内容，已标记已灌入（跳过上传）：' + name, '灌入', 'info')
          this.emit('import-item', results[results.length - 1])
          this.progress({ done: i + 1, total: queue.length })
          await sleep(80)
          continue
        }
        if (item.replaceServer) {
          // 同名 + 内容不同 + 开启自动替换（默认）：先删服务端旧版，再传新版本 ——
          // 这正是 LX 网页端「同名要先删旧才能传新」的操作，猎手自动完成（v1.7.0）。
          // 删除会触发服务端全量脚本重载，等 2.5s 再传，规避「已存在」。
          const srv = item.replaceServer
          const code = codeCache[e.id]
          const rm = await lx.remove(cfg, srv.id, { owner: srv.owner })
          if (!rm.success) {
            this.log(`替换失败：服务端旧版「${srv.name || name}」删除失败（${rm.message}），退回改名上传`, '灌入', 'warn')
            r = await this._uploadRenamed(cfg, code, item.baseName, serverByName, usedRename)
            if (r && r.success) r.replacedFallback = 'renamed'
          } else {
            this.log(`已删除服务端旧版「${srv.name || name}」（id=${srv.id}），等待服务端重载后上传新版本…`, '灌入')
            await sleep(2500)
            r = await lx.upload(cfg, code, name)
            if (!r.success && r.message && /已存在/.test(r.message)) {
              await sleep(2500)
              r = await lx.upload(cfg, code, name)
            }
            if (!r.success && r.message && /已存在/.test(r.message)) {
              // 仍撞名（极少见）：退回改名上传，保证音源至少能进去
              this.log('替换上传仍撞名，退回改名上传', '灌入', 'warn')
              r = await this._uploadRenamed(cfg, code, item.baseName, serverByName, usedRename)
              if (r && r.success) r.replacedFallback = 'renamed'
            }
          }
          if (r && r.success) {
            // 清理本地「已灌入」里指向被替换音源的旧记录（服务端那份已不存在）
            let purged = 0
            for (const [k, rec] of Object.entries(this.store.imported)) {
              if (rec && rec.lxId === srv.id) { delete this.store.imported[k]; purged++ }
            }
            if (purged) { this.store.saveImported(); this.log(`已清理 ${purged} 条指向被替换音源的本地灌入记录`, '灌入', 'info') }
          }
        } else if (item.renameServer) {
          // 同名 + 内容不同 + 用户关闭了自动替换：改名后上传，规避服务端「已存在」
          const srv = item.renameServer
          let code = codeCache[e.id]
          if (!code) {
            r = await lx.importUrl(cfg, e.url, (e.lxName || e.scriptName || e.name))
          } else {
            r = await this._uploadRenamed(cfg, code, item.baseName, serverByName, usedRename)
          }
        } else {
          const code = codeCache[e.id]
          r = code
            ? await lx.upload(cfg, code, (e.lxName || e.scriptName || e.name))
            : await lx.importUrl(cfg, e.url, (e.lxName || e.scriptName || e.name))
        }
        if (r && r.success) {
          this.store.imported[e.id] = {
            lxId: r.id, name: r.name || name, contentHash: e.contentHash || '',
            serverUrl: lx.baseUrl(cfg), importedAt: Date.now(), platforms: r.platforms || []
          }
          this.store.saveImported()
          const note = item.replaceServer
            ? (r.replacedFallback === 'renamed' ? '（同名替换因服务端旧版删除失败，已改名上传）' : '（已替换服务端同名旧版：先删后传）')
            : item.renameServer ? '（已改名规避同名冲突）' : ''
          const st = item.replaceServer && r.replacedFallback !== 'renamed' ? 'replaced' : 'success'
          results.push({ id: e.id, name, status: st, lxId: r.id, message: (r.message || '') + note, platforms: r.platforms || [] })
          this.log(`已灌入：${name}${note}（id=${r.id}）`, '灌入')
        } else {
          results.push({ id: e.id, name, status: 'failed', message: (r && r.message) || '导入失败', requireUnsafe: !!(r && r.requireUnsafe) })
          this.log('灌入失败：' + name + ' — ' + ((r && r.message) || '导入失败'), '灌入', 'warn')
        }
      } catch (err) {
        results.push({ id: e.id, name, status: 'failed', message: String((err && err.message) || err).slice(0, 160) })
        this.log('灌入失败：' + name + ' — ' + String((err && err.message) || err), '灌入', 'warn')
      }
      this.emit('import-item', results[results.length - 1])
      this.progress({ done: i + 1, total: queue.length })
      await sleep(150)   // 轻微节流，避免打爆服务端；批量灌入时几乎无感
    }
    this.store.saveDb()
    const ok = results.filter(r => r.status === 'success' || r.status === 'replaced').length
    const replaced = results.filter(r => r.status === 'replaced').length
    this.log(`灌入完成：成功 ${ok} / 共 ${results.length}` + (replaced ? `（其中替换同名旧版 ${replaced} 个）` : ''), '灌入')
    this.job.running = false
    this.emit('job', { running: false, type: 'import', done: true, summary: { ok, total: results.length, replaced } })
    return { results, ok, replaced }
  }

  /**
   * 灌入前的去重/同名裁决（纯函数，v1.7.0 抽出便于测试）：
   *  - 服务端原生 / 本地检测未通过（skipUnusable 默认开）/ 与已灌入同内容 / 本次所选内同内容或同名 → skip
   *  - 服务端同名 + 同内容（字节长度相等）→ sameContentServer：标记已灌入，不重复上传
   *  - 服务端同名 + 内容不同：
   *      · 本地深检确认失效（0 可用平台，非 stale）→ skip：不替换，避免把服务端
   *        能用的源换成本地实测挂掉的（v1.7.0 用户要求同名更新看接口可用度）
   *      · replaceSameNameOnImport !== false（默认）且有本地内容 → replaceServer：先删后传
   *      · 否则 → renameServer：改名上传（旧行为）
   *  - 其余 → 直接上传
   */
  _planImportQueue(targets, ctx) {
    const cfg = ctx.cfg || {}
    const serverByName = ctx.serverByName || {}
    const codeCache = ctx.codeCache || {}
    const importedHashes = ctx.importedHashes || {}
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
      } else if (e.contentHash && importedHashes[e.contentHash]) {
        queue.push({ e, skip: `内容与已灌入的「${importedHashes[e.contentHash]}」相同，跳过` })
      } else if (e.contentHash && best[e.contentHash] && best[e.contentHash] !== e) {
        queue.push({ e, skip: `与本次所选的「${best[e.contentHash].scriptName || best[e.contentHash].name}」内容相同，跳过` })
      } else if (nm && nbest[nm] && nbest[nm] !== e) {
        queue.push({ e, skip: `与本次所选的「${nbest[nm].scriptName || nbest[nm].name}」同名（视为同一音源新旧版本），跳过` })
      } else if (nm && serverByName[nm]) {
        // 同名音源：比较字节长度判断内容是否相同。
        //  - 同内容：不重复上传，直接标记为「已灌入」（服务端已有该音源）
        //  - 内容不同：默认「替换」——先删服务端旧版再传新版。LX 网页端里同名更新必须
        //    先删旧才能传新，猎手把这两步自动做完；设置里可关掉，退回改名上传。
        //    替换的前提是本地检测过且可用（v1.7.0 按用户要求：同名内容更新要看接口
        //    可用度）——检测确认失效的不替换，避免把服务端能用的源换成本地实测挂掉的。
        const srv = serverByName[nm]
        const code = codeCache[e.id]
        if (code && Buffer.byteLength(code, 'utf-8') === srv.size) {
          queue.push({ e, sameContentServer: srv })
        } else if (cfg.replaceSameNameOnImport !== false && code) {
          const checked = e.deep && e.deep.checkedAt
          if (checked && usableCount(e) === 0 && !e.stale) {
            queue.push({ e, skip: `与服务端同名「${srv.name}」内容不同，但本地检测已失效（0 个可用平台），不替换（保留服务端现条目）` })
          } else {
            queue.push({ e, replaceServer: srv, baseName: e.lxName || e.scriptName || e.name })
          }
        } else {
          queue.push({ e, renameServer: srv, baseName: e.lxName || e.scriptName || e.name })
        }
      } else {
        queue.push({ e })
      }
    }
    return queue
  }

  /** 改名上传（规避服务端 generateId 撞名）：撞名就换名重试，最多 4 次 */
  async _uploadRenamed(cfg, code, baseName, serverByName, used) {
    let newName = this._uniqueRename(baseName, serverByName, used)
    for (let attempt = 0; attempt < 4; attempt++) {
      const renamed = renameScriptContent(code, newName)
      const ur = await lx.upload(cfg, renamed, newName)
      if (ur.success) return ur
      if (ur.message && /已存在/.test(ur.message)) { newName = this._uniqueRename(baseName, serverByName, used); continue }
      return ur
    }
    return { success: false, message: '改名后仍上传失败（已存在）' }
  }

  /** 巡检里启用/禁用音源的「安全开关」：服务端请求异常（超时/网络抖动）只记日志，不连累整轮巡检崩溃 */
  async _safeToggle(cfg, id, enabled, what, owner) {
    try {
      const t = await lx.toggle(cfg, id, enabled, { owner })
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
      const t = await lx.setPlatforms(cfg, id, disabledSources, { owner })
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
    if (this.job.running) throw new Error('已有任务在运行')
    const cfg = this.store.config
    let serverList = []
    try { serverList = await lx.list(cfg) } catch (e) {
      throw new Error('无法读取服务端音源列表：' + String((e && e.message) || e))
    }
    const aliveLxIds = new Set((serverList || []).map(s => s && s.id).filter(Boolean))
    // 源的归属身份：admin 私有源的停用必须写 admin 那份 states（v1.6.7）
    const ownerById = new Map((serverList || []).map(s => [s && s.id, s && s.owner]).filter(([id]) => !!id))
    // 身份口径自检：admin 等身份写的平台停用，LX 端用公开列表查看时看不到（假性不同步）
    const idNote = identityMismatch(cfg, serverList)
    if (idNote) this.log(idNote, '巡检', 'warn')
    const items = []
    for (const [srcId, rec] of Object.entries(this.store.imported || {})) {
      if (!rec || !rec.lxId || !aliveLxIds.has(rec.lxId)) continue   // 服务端已不在（被手动删除）
      const e = this.store.db.sources[srcId]
      // 无脚本地址的跳过：手动灌入无本地记录，或服务端原生音源未留存 sourceUrl（无法下载重测）
      if (!e || !e.url) continue
      items.push({ e, rec })
    }
    if (!items.length) {
      this.log('没有可巡检的已灌入音源（仅支持「本工具灌入且本地有对应记录」的音源）', '巡检', 'warn')
      return { ok: 0, disabled: 0, unknown: 0, total: 0 }
    }

    this.job = { running: true, type: 'patrol', cancel: false, progress: { done: 0, total: items.length, ok: 0, disabled: 0 }, step: '' }
    this.emit('job', { running: true, type: 'patrol' })
    this.log(`开始健康巡检：${items.length} 个已灌入音源（并发 ${Math.max(1, Math.min(8, cfg.concurrency || 8))}）…`, '巡检')
    this.mirrorPref = null
    // 巡检并发刻意压得比主检低：几十个聚合源同时重测，打到的是同一批后端接口，
    // 并发太高会把对方打到限流，整批「全平台失败」，看起来就像集体失效
    const conc = Math.max(1, Math.min(3, cfg.concurrency || 8))
    let idx = 0, ok = 0, disabled = 0, unknown = 0, reEnabled = 0

    const worker = async () => {
      while (true) {
        if (this.cancelRequested) return
        const i = idx++
        if (i >= items.length) return
        const { e, rec } = items[i]
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
          }
        } catch (err) {
          const msg = String((err && err.message) || err)
          if (msg === '已取消') { verdict = 'unknown'; note = '已取消' }
          else { verdict = 'unknown'; note = '检测异常：' + msg.slice(0, 80) }
        }
        delete e.checking
        rec.lastPatrol = { at: Date.now(), ok: verdict === 'ok', note: String(note).slice(0, 160) }
        if (verdict === 'ok') {
          ok++
          rec.patrolFailStreak = 0
          if (rec.disabledByPatrol) {
            // 停用/启用均走「平台级」接口，不触发服务端全量重载（覆盖本工具已知的全部平台）
            const t = await this._safePlatforms(cfg, rec.lxId, [], '重新启用', ownerById.get(rec.lxId))
            if (t.success) { delete rec.disabledByPatrol; reEnabled++; this.log(`巡检恢复正常，已重新启用：${name}`, '巡检') }
          }
        } else if (verdict === 'dead') {
          if (cfg.patrolAutoDisable !== false) {
            const t = await this._safePlatforms(cfg, rec.lxId, ['wy', 'tx', 'kw', 'kg', 'mg'], '自动禁用', ownerById.get(rec.lxId))
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
            const t = await this._safePlatforms(cfg, rec.lxId, [], '恢复启用', ownerById.get(rec.lxId))
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
    this.store.db.patrol = { lastRun: Date.now(), total: items.length, ok, disabled, unknown, reEnabled, cancelled: this.cancelRequested }
    this.store.saveDb()
    const stillDisabled = Object.values(this.store.imported || {}).filter(r => r && r.disabledByPatrol).length
    this.log(this.cancelRequested
      ? '巡检已取消（已完成部分保留）'
      : `巡检完成：正常 ${ok}${reEnabled ? `（含恢复启用 ${reEnabled}）` : ''}、失效禁用 ${disabled}、无法判定 ${unknown} / 共 ${items.length}` +
        (stillDisabled ? `；仍有 ${stillDisabled} 个源处于巡检停用，可在「已灌入」页单个恢复或点「全部恢复启用」` : ''), '巡检', this.cancelRequested ? 'warn' : 'info')
    this.job.running = false
    this.emit('job', { running: false, type: 'patrol', done: true, cancelled: this.cancelRequested, summary: { total: items.length, ok, disabled, unknown, reEnabled } })
    return { ok, disabled, unknown, reEnabled, total: items.length }
  }

  // ---------------- 撤回 ----------------
  async runRevoke(ids) {
    const cfg = this.store.config
    // 撤回也要按 owner 路由删除身份：灌入记录若带 owner（同步服务端时记下），
    // 私有源删归属身份那份；v1.6.8 起新灌入都是公开源，走 default
    let serverOwners = new Map()
    try {
      const list = await lx.list(cfg)
      serverOwners = new Map((list || []).map(s => [s && s.id, s && s.owner]).filter(([id]) => !!id))
    } catch (e) { /* 读不到列表时按 default 处理（服务端有回退 open 的兜底） */ }
    const results = []
    for (const id of ids || []) {
      const rec = this.store.imported[id]
      if (!rec || !rec.lxId) {
        results.push({ id, status: 'failed', message: '无本地灌入记录，请到服务端手动删除' })
        continue
      }
      try {
        const r = await lx.remove(cfg, rec.lxId, { owner: serverOwners.get(rec.lxId) })
        if (r.success) {
          delete this.store.imported[id]
          this.store.saveImported()
          results.push({ id, status: 'success', name: rec.name })
          this.log('已撤回：' + rec.name, '撤回')
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
    const v = await lx.verify(cfg)
    if (!v.ok) throw new Error('LX 服务不可用：' + v.msg)
    let serverList = []
    try { serverList = await lx.list(cfg) } catch (e) {
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
          serverUrl: lx.baseUrl(cfg), importedAt: Date.now(),
          platforms: s.supportedSources || [], serverSynced: true
        }
        local.lxId = s.id
        local.fromServerMatched = true
        matched++
      } else {
        // 服务端原生音源：建占位条目纳入管理。
        // sourceUrl 是它当年经 URL 导入时留存的原始脚本地址（upload 的没有），
        // 有地址的占位条目同样可以下载 + 沙箱检测（runCheck 已放行 fromServer 且有 url 的条目）
        const pid = 'srv:' + s.id
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
            serverUrl: lx.baseUrl(cfg), importedAt: Date.now(),
            platforms: s.supportedSources || [], serverSynced: true, serverNative: true
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

module.exports = { Hunter, normName, identityMismatch }
