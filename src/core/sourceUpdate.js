'use strict'
/**
 * 已添加源更新（T1 由 lx-hunter 承接，2026-11-10）
 *
 * 目标：把「服务端上已经装着的音源」与上游新版本对上号。
 * 与灌入（runImport）的区别：灌入是「我库里有个新源 → 灌进去」，
 * 本模块是「服务端上有个源 → 反查上游有没有新版」，起点在服务端列表。
 *
 * 2026-11-10 21:01 用户拍板后的定调（配合 P-1396 科学性复核）：
 *  - **检测与灌入归 lx-hunter 主链路（runImport）**：不同名直接灌；同名同仓库按
 *    版本留新删旧；同名跨仓库按 lx-hunter 实测质量留优删差（见 quality.js / hunter.js）。
 *  - 本模块从服务端列表反查，服务端不回传脚本正文 / hash（17950 实测 38 条中
 *    hash 0、script 0、homepage 非空仅 11），**天然证据不足**，因此定位为
 *    「只读巡检 / 报告层」：默认 dry-run，写入需显式 apply+confirm，且 Web 层
 *    另设实验开关；真正要装新版请走灌入链路。
 *  - A（主）：归一化 @name 配对 + @repository 同源 + @version 比较；
 *    B（@updateUrl / @downloadUrl）只写 signals，绝不单独触发动作。
 *
 * 护栏：owner 隔离 / ID 稳定 / 先验证后删 / 安全不降级 /
 *       未实测候选不参与更新（S4）/ 缺证据只报告（S5）/ 报告有效期钳制（S6）/
 *       换 id 后状态重建（S3-B）与迁移接口缺失兜底（S3-C）/ 失败自动回滚（原子性）。
 */
const crypto = require('crypto')
const { versionKey: versionNum, cmpVersion } = require('./version')
const { normName, repoKey, nameBody, scriptName } = require('./identity')
const { compareQuality, describeQuality } = require('./quality')

function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex')
}

/** B 信号：只抽取，不用于判定。输入可以是脚本正文，也可以是元数据对象 */
function extractUpdateHints(input) {
  const out = []
  if (input && typeof input === 'object') {
    if (input.updateUrl) out.push({ type: '@updateUrl', url: String(input.updateUrl) })
    if (input.downloadUrl) out.push({ type: '@downloadUrl', url: String(input.downloadUrl) })
    if (input.code || input.script) return out.concat(extractUpdateHints(input.code || input.script))
    return out
  }
  const text = String(input || '')
  const u = text.match(/@updateUrl\s+(\S+)/)
  const d = text.match(/@downloadUrl\s+(\S+)/)
  if (u) out.push({ type: '@updateUrl', url: u[1] })
  if (d) out.push({ type: '@downloadUrl', url: d[1] })
  return out
}

/** 服务端 list 条目 → 统一字段（兼容 lxserver / MusicSync / Songloft 的字段差异）。
 *  disabledSources 来自 lxserver handleList 注入的 states.json，是 S3 状态重建的输入。 */
function serverMeta(s) {
  s = s || {}
  const m = s.meta || s.metadata || {}
  return {
    id: String(s.id || ''),
    name: String(s.name || m.name || ''),
    version: String(s.version || m.version || ''),
    author: String(s.author || m.author || ''),
    repository: String(s.repository || s.homepage || m.homepage || m.repository || ''),
    hash: s.hash || s.contentHash || s.sha256 || null,
    size: Number(s.size || 0),
    supportedSources: Array.isArray(s.supportedSources) ? s.supportedSources.slice()
      : (Array.isArray(s.sources) ? s.sources.slice() : []),
    disabledSources: Array.isArray(s.disabledSources) ? s.disabledSources.slice() : [],
    owner: s.owner || 'open',
    enabled: s.enabled !== false,
    script: s.script || s.code || ''
  }
}

/** 本地库候选 → 统一字段 */
function candidateMeta(e) {
  e = e || {}
  const deep = e.deep || {}
  const platforms = deep.platforms || {}
  const usablePlatforms = Object.keys(platforms).filter(k => {
    const p = platforms[k] || {}
    // 实测状态以 checker.js 写入的 'usable' 为准（还有历史值 ok / passed）
    return p.status === 'usable' || p.status === 'ok' || p.status === 'passed' ||
      p.ok === true || p.pass === true
  })
  // 快速模式只测到第一个可用平台就停，其余标 untested。untested ≠ failed，
  // 拿去和服务端声明的全量 supportedSources 比长度会系统性误判「平台更少」。
  const untestedPlatforms = Object.keys(platforms).filter(k => {
    const st = String((platforms[k] || {}).status || '')
    return st === 'untested' || st === 'skipped' || st === 'pending'
  })
  return {
    id: String(e.id || ''),
    name: String(e.lxName || e.scriptName || e.name || ''),
    version: String(e.scriptVersion || e.version || ''),
    author: String(e.author || ''),
    repository: String(e.repository || e.homepage || e.repo || ''),
    url: String(e.url || ''),
    hash: e.contentHash || null,
    code: typeof e.code === 'string' ? e.code : '',
    checked: !!(deep.checkedAt) && !e.stale,
    usablePlatforms,
    untestedPlatforms,
    stale: !!e.stale,
    raw: e
  }
}

function platformList(e) {
  return candidateMeta(e).usablePlatforms
}

/**
 * A 配对核心（纯函数）。
 * 2026-11-10 修 S2：候选池不再「按名字主体胜者通吃」——同主体下先按同源键分组，
 * 同源候选按版本取最新、跨仓库候选按质量取最优（只报告，不自动更新），
 * 避免撞名的非同源 v3.0 把同源 v2.5 挤掉、真更新被判 unmatched。
 *
 * @param {Array} serverList 服务端已有源（adapter.list 的返回）
 * @param {Array} candidates 本地库 / Hub 清单候选
 * @param {object} opts { owner, allowVersionOnly }
 * @returns {Array} 每个服务端源一条判定
 */
function pairSources(serverList, candidates, opts) {
  opts = opts || {}
  const list = Array.isArray(serverList) ? serverList : []
  const cand = (Array.isArray(candidates) ? candidates : []).map(candidateMeta)
  const byBody = {}
  for (const c of cand) {
    const k = nameBody(c.name)
    if (!k) continue
    ;(byBody[k] = byBody[k] || []).push(c)
  }

  return list.map(function (raw) {
    const s = serverMeta(raw)
    const signals = extractUpdateHints({ script: s.script })
    // S5：把「确实没新版」与「服务端/候选缺证据」分开，避免 0 updatable 被误读成「全是最新的」
    const missingEvidence = []
    if (!s.hash && !s.script) missingEvidence.push('server.hash/script（lxserver 不回传脚本正文，sha256 同内容护栏不可达）')
    if (!s.repository) missingEvidence.push('server.repository/homepage')
    if (!s.version) missingEvidence.push('server.version')
    if (!s.supportedSources.length) missingEvidence.push('server.supportedSources')
    const item = {
      id: s.id, name: s.name, owner: s.owner, enabled: s.enabled,
      verdict: 'unmatched', reason: '', applyAllowed: false,
      evidence: {
        via: 'none', relation: 'none', serverVersion: s.version, candidateVersion: '',
        repo: '', hashMatch: false, missingEvidence,
        // S3：删旧前先把服务端状态存档，upload 后按新 id 重建
        serverState: { enabled: s.enabled, disabledSources: s.disabledSources }
      },
      signals: signals,
      candidate: null
    }
    function finish(verdict, reason, via) {
      item.verdict = verdict
      item.reason = reason
      if (via) item.evidence.via = via
      if (verdict === 'unmatched' && item.evidence.missingEvidence.length) {
        item.reason += '；缺证据：' + item.evidence.missingEvidence.join('、') +
          '（这是证据链缺口，不等于「没有新版」；请先补齐或走灌入链路）'
      }
      return item
    }

    if (opts.owner && s.owner !== opts.owner) {
      return finish('unsafe', 'owner 不匹配（当前扫描限定 ' + opts.owner + '）→ 不处理，避免跨身份误删', 'owner')
    }

    const pool = byBody[nameBody(s.name)] || []
    if (!pool.length) {
      return finish('unmatched', '本地候选池里没有同源同名条目（出处不明）→ 只报告，不更新' +
        (signals.length ? '；B 信号仅作提示，不单独触发更新' : ''), 'none')
    }

    const sk = repoKey({ repository: s.repository })
    const keyOf = c => repoKey({ repository: c.repository, url: c.url })
    const samePool = sk ? pool.filter(c => keyOf(c) === sk) : []
    const crossPool = sk ? pool.filter(c => { const k = keyOf(c); return k && k !== sk }) : []
    let c = null, relation = 'repo-unknown'
    if (samePool.length) {
      relation = 'same-repo'
      c = samePool.reduce((best, x) => cmpVersion(x.version, best.version) > 0 ? x : best)
    } else if (crossPool.length) {
      relation = 'cross-repo'
      c = crossPool.reduce((best, x) => compareQuality(x.raw, best.raw) > 0 ? x : best)
    } else {
      // 服务端无 homepage 或候选无 repo：拿不到同源键，按最高版本挑一条只作报告
      c = pool.reduce((best, x) => cmpVersion(x.version, best.version) > 0 ? x : best)
    }
    item.evidence.relation = relation
    item.evidence.repo = sk || keyOf(c) || ''
    item.candidate = {
      id: c.id, name: c.name, version: c.version, url: c.url,
      repository: c.repository, hash: c.hash
    }
    item.evidence.candidateVersion = c.version
    item.signals = item.signals.concat(extractUpdateHints({ script: c.code }))
    if (!c.hash && !c.code) missingEvidence.push('candidate.code/contentHash')
    if (!c.checked) missingEvidence.push('candidate.deep.checkedAt')

    // 1) 同内容：sha256 优先（服务端能回传 hash 时才可达）
    if (s.hash && c.hash && s.hash === c.hash) {
      item.evidence.via = 'same-content'
      item.evidence.hashMatch = true
      return finish('current', '脚本内容指纹相同（sha256）→ 已是同一版本，无需更新', 'same-content')
    }

    // 2) S4：检测归 lx-hunter。未经实测的候选（含采集站 hub 清单，deep:null）
    //    绝不能凭版本号直接判 updatable 去删旧装新。
    if (!c.checked) {
      return finish('unmatched',
        '候选未经 lx-hunter 实测（deep.checkedAt 缺失' +
        (String(c.id).indexOf('hub:') === 0 ? '，采集站清单候选' : '') +
        '）→ 请先做全平台检测；检测归 lx-hunter，禁止凭清单直接更新', 'need-check')
    }

    // 3) ID 稳定：真正决定服务端 id 的是脚本正文里的 @name（generateId 的输入）
    const declared = scriptName(c.code)
    if (declared && nameBody(declared) !== nameBody(s.name)) {
      return finish('unsafe',
        '候选脚本声明的 @name 主体与服务端条目不一致，上传会生成新 id（平台开关/排序/缓存会丢）→ 走改名并存，不删旧',
        'name-mismatch')
    }

    // 4) 沿用同名裁决硬规则（与 hunter.sameNameVerdict 同口径）
    if (c.usablePlatforms.length === 0) {
      return finish('unsafe', '候选本地实测 0 个可用平台 → 不替换（换过去是纯损失）', 'zero-usable')
    }
    if (s.supportedSources.length > 0) {
      const overlap = s.supportedSources.filter(p => c.usablePlatforms.indexOf(p) >= 0)
      if (!overlap.length) {
        return finish('unsafe', '同名但平台零交集（疑似无关脚本撞名）→ 改名并存，不删旧', 'no-overlap')
      }
      if ((c.untestedPlatforms || []).length > 0 && c.usablePlatforms.length < s.supportedSources.length) {
        return finish('unmatched',
          '候选有 ' + c.untestedPlatforms.length + ' 个平台未实测（快速模式），证据不足以判「平台更少」→ 只报告，请先全平台重测',
          'insufficient-evidence')
      }
      if (c.usablePlatforms.length < s.supportedSources.length) {
        return finish('unsafe', '服务端现条目支持平台更多 → 保留服务端', 'fewer-platforms')
      }
    }

    // 5) 按同源关系分流
    const lv = versionNum(c.version) || versionNum(c.name)
    const sv = versionNum(s.version) || versionNum(s.name)
    if (relation === 'cross-repo') {
      // 用户口径 3：跨仓库同名按 lx-hunter 实测质量裁决；但裁决的执行在灌入链路，
      // 本反查模块只报告，绝不从服务端列表反推去删改。
      const q = compareQuality(c.raw, s)
      const note = '本地 ' + describeQuality(c.raw) + ' vs 服务端 ' + describeQuality(s)
      if (q > 0) {
        return finish('unmatched', '跨仓库同名：lx-hunter 实测质量更优（' + note +
          '）→ 留优删差请走「灌入」链路执行；本反查只报告', 'cross-repo-quality')
      }
      if (q < 0) {
        return finish('unmatched', '跨仓库同名：服务端现条目质量更优（' + note + '）→ 保留服务端', 'cross-repo-quality')
      }
      return finish('unmatched', '跨仓库同名且质量判据平手（' + note + '）→ 不删任何一方，只报告', 'cross-repo-quality')
    }
    if (lv && sv) {
      const cmp = cmpVersion(c.version || c.name, s.version || s.name)
      if (cmp <= 0) {
        return finish('current',
          '服务端版本不低于候选（' + (s.version || s.name) + ' ≥ ' + (c.version || c.name) + '）→ 无需更新',
          relation === 'same-repo' ? 'repo-version' : 'version-only')
      }
      if (relation !== 'same-repo' && !opts.allowVersionOnly) {
        return finish('unmatched', '候选版本更高，但缺 @repository 同源证据 → 只报告，不自动更新（A 口径不猜）', 'version-only')
      }
      item.applyAllowed = true
      return finish('updatable', relation === 'same-repo'
        ? '同源同名且候选版本更高 → 可更新（删旧装新）'
        : '同名且候选版本更高（同源证据缺失，已由 allowVersionOnly 显式放行）→ 需人工确认',
        relation === 'same-repo' ? 'repo-version' : 'version-only')
    }
    return finish('unmatched', relation === 'same-repo'
      ? '同源但两边版本号不可比 → 不猜，只报告'
      : '缺同源证据且版本号不可比 → 出处不明，只报告',
      relation === 'same-repo' ? 'repo-only' : 'none')
  })
}

/** dry-run 报告（纯函数） */
function buildReport(serverList, candidates, opts) {
  opts = opts || {}
  const items = pairSources(serverList, candidates, opts)
  const summary = {
    total: items.length, updatable: 0, current: 0, unmatched: 0, unsafe: 0,
    bSignals: 0, withMissingEvidence: 0, needCheck: 0
  }
  for (const it of items) {
    if (summary[it.verdict] != null) summary[it.verdict]++
    if (it.signals && it.signals.length) summary.bSignals++
    if (it.evidence && it.evidence.missingEvidence && it.evidence.missingEvidence.length) summary.withMissingEvidence++
    if (it.evidence && it.evidence.via === 'need-check') summary.needCheck++
  }
  return {
    dryRun: true,
    generatedAt: Number(opts.now || Date.now()),
    candidateSource: opts.candidateSource || 'local-library',
    owner: opts.owner || null,
    summary,
    items,
    notes: [
      'A 配对为主：@name 归一化 + @repository 同源 + @version 比较；同内容 sha256 判「已是最新」。',
      'B（@updateUrl / @downloadUrl）只写进 signals，不单独触发更新、不改变 verdict。',
      '本报告为 dry-run：未执行任何 validate / delete / upload，服务端数据未被修改。',
      '实际更新须显式 apply + confirm，且只允许本报告中 verdict=updatable 的条目。',
      'lxserver 按 @name 生成 id、delete 进回收站：更新前先 validate，失败保留旧条目并尝试自动恢复。',
      'S5：unmatched 附带 missingEvidence —— 服务端不回传脚本正文/hash，0 updatable 不等于「全是最新的」。',
      '本模块是只读巡检/报告层：检测与灌入归 lx-hunter 主链路（runImport），跨仓库质量裁决也在那里执行。'
    ]
  }
}

const MAX_REPORT_AGE_MS = 10 * 60 * 1000

/**
 * apply 准入（纯函数）。S6：maxAgeMs 由服务端钳到 ≤10min，
 * 防止外部传 1e15 让 1 小时前的报告重新可用。
 */
function assertApplyAllowed(report, ids, opts) {
  opts = opts || {}
  if (!opts.confirm || opts.apply !== true) throw new Error('未显式确认：apply 需同时传 apply:true 与 confirm:true（默认 dry-run）')
  const r = report || opts.report
  if (!r || !Array.isArray(r.items)) throw new Error('请先执行 dry-run 扫描')
  const rawMax = Number(opts.maxAgeMs || MAX_REPORT_AGE_MS)
  const maxAge = Math.min(Number.isFinite(rawMax) && rawMax > 0 ? rawMax : MAX_REPORT_AGE_MS, MAX_REPORT_AGE_MS)
  if (Date.now() - Number(r.generatedAt || 0) > maxAge) throw new Error('扫描报告已过期，请重新 dry-run')
  const want = Array.isArray(ids) ? ids.map(String) : []
  if (!want.length) throw new Error('未指定要更新的服务端条目 id')
  const byId = {}
  for (const it of r.items) byId[String(it.id)] = it
  const allowed = [], rejected = []
  for (const id of want) {
    const it = byId[id]
    if (!it) { rejected.push({ id, reason: '不在最近一次 dry-run 报告中' }); continue }
    if (it.verdict !== 'updatable' || !it.applyAllowed) { rejected.push({ id, reason: '判定为 ' + it.verdict + '：' + it.reason }); continue }
    if (opts.owner && it.owner !== opts.owner) { rejected.push({ id, reason: 'owner 不匹配' }); continue }
    if (!it.candidate) { rejected.push({ id, reason: '缺候选条目' }); continue }
    allowed.push(it)
  }
  return { allowed, rejected }
}

/** 默认取脚本正文：优先候选自带 code，其次按 url 下载（与灌入同款镜像链） */
async function defaultFetchCode(candidate, timeoutMs) {
  if (candidate && candidate.code) return candidate.code
  const url = candidate && (candidate.url || (candidate.signals || []).length && (candidate.signals[0] || {}).url)
  if (!url) throw new Error('候选既无脚本正文也无下载地址')
  let text = ''
  try {
    const { crawlFetch } = require('./crawler')
    const r = await crawlFetch(url, null, timeoutMs || 20000)
    const res = r && (r.res || r)
    if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status))
    text = await res.text()
  } catch (e) {
    throw new Error('下载候选脚本失败：' + String((e && e.message) || e))
  }
  if (!text) throw new Error('候选脚本正文为空')
  return text
}

function safeFilename(name) {
  return (String(name || 'source').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'source') + '.js'
}

/**
 * 编排层：scan 只读、apply 才写。所有网络/适配器调用都经注入，便于单测。
 */
function createUpdater(o) {
  o = o || {}
  const adapter = o.adapter, acct = o.acct || {}
  const getCandidates = o.getCandidates || (() => [])
  const fetchCode = o.fetchCode || defaultFetchCode
  const log = o.log || (() => {})
  let lastReport = null

  async function scan(opts) {
    opts = opts || {}
    const serverList = await adapter.list(acct)
    const candidates = await getCandidates(opts)
    const rep = buildReport(serverList, candidates, Object.assign({}, opts, {
      candidateSource: opts.candidateSource || 'local-library',
      now: Date.now()
    }))
    lastReport = rep
    log('dry-run 扫描完成：' + rep.summary.total + ' 条，可更新 ' + rep.summary.updatable +
        ' / 已是最新 ' + rep.summary.current + ' / 出处不明 ' + rep.summary.unmatched +
        ' / 不建议动 ' + rep.summary.unsafe + ' / 缺证据 ' + rep.summary.withMissingEvidence +
        '（未写入任何数据）')
    return rep
  }

  async function apply(ids, opts) {
    opts = opts || {}
    const { allowed, rejected } = assertApplyAllowed(lastReport, ids, opts)
    // S3-C 兜底：换 id 后若适配器不支持状态迁移，不自动放行（除非显式 allowNoStateMigration）
    const canMigrate = typeof adapter.setPlatforms === 'function' || typeof adapter.toggle === 'function'
    if (!canMigrate && !opts.allowNoStateMigration) {
      return {
        applied: 0, failed: 0,
        rejected: rejected.concat(allowed.map(it => ({ id: it.id, reason: '适配器不支持状态迁移（setPlatforms/toggle），换 id 会丢平台开关与排序 → 不自动放行' }))),
        results: [],
        note: 'S3-C：状态迁移能力缺失，已全部拒绝；请走灌入链路或显式 allowNoStateMigration'
      }
    }
    const results = []
    for (const it of allowed) {
      const rec = {
        id: it.id, name: it.name, owner: it.owner, ok: false, steps: [],
        serverState: (it.evidence && it.evidence.serverState) || null
      }
      let deleted = false
      try {
        const cand = Object.assign({}, it.candidate, { signals: it.signals })
        const code = await fetchCode(cand, opts.timeoutMs)
        // 先验证后删；安全不降级：requireUnsafe 一律不重试
        const v = await adapter.validate(acct, code)
        const d = v && v.data
        if (!v || v.ok === false || (d && d.success === false)) {
          throw new Error('validate 未通过' + (d && d.requireUnsafe ? '（脚本需要 allowUnsafeVM，更新不降级放行）' : ''))
        }
        rec.steps.push('validate')
        const meta = (d && (d.metadata || d.meta)) || {}
        if (meta.name && nameBody(meta.name) !== nameBody(it.name)) {
          throw new Error('候选 @name 与服务端条目名不一致，放弃更新以免生成新 id')
        }
        const del = await adapter.remove(acct, it.id, { owner: it.owner })
        if (!del || del.success === false) throw new Error('删除旧条目失败：' + String((del && del.message) || ''))
        deleted = true
        rec.steps.push('delete(旧脚本进服务端回收站，可回滚)')
        const up = await adapter.upload(acct, code, safeFilename(it.name))
        if (!up || up.success === false) throw new Error('上传新脚本失败：' + String((up && (up.message || up.error)) || ''))
        rec.steps.push('upload')
        rec.ok = true
        rec.newId = up.id || null
        // S3-B：lxserver 按 @name 生成 id，版本写进名字时 id 必变 → 按新 id 重建状态
        if (rec.newId && typeof adapter.setPlatforms === 'function' &&
            rec.serverState && rec.serverState.disabledSources.length) {
          const m = await adapter.setPlatforms(acct, rec.newId, rec.serverState.disabledSources, { owner: it.owner })
          rec.stateMigration = rec.stateMigration || {}
          rec.stateMigration.platforms = !!(m && m.success !== false)
          rec.steps.push('migrate:platforms')
        }
        if (rec.newId && typeof adapter.toggle === 'function' &&
            rec.serverState && rec.serverState.enabled === false) {
          await adapter.toggle(acct, rec.newId, false, { owner: it.owner })
          rec.stateMigration = rec.stateMigration || {}
          rec.stateMigration.enabled = true
          rec.steps.push('migrate:enabled')
        }
        log('已更新「' + it.name + '」（旧 id ' + it.id + ' → 新 id ' + (rec.newId || '?') + '）')
      } catch (e) {
        rec.error = String((e && e.message) || e)
        rec.rollback = '若已 delete 但 upload 失败，旧脚本在服务端回收站（/api/custom-source/trash）可恢复'
        rec.trash = { owner: it.owner, id: it.id, name: it.name, at: new Date().toISOString() }
        // 原子性：delete 已成功但最终没装上 → 自动从回收站恢复旧脚本，
        // 并把 trash 定位信息写进结果（恢复接口不可用时至少能人工定位）
        if (deleted && !rec.ok &&
            typeof adapter.listTrash === 'function' && typeof adapter.restoreTrash === 'function') {
          try {
            const items = await adapter.listTrash(acct, it.owner)
            const hit = (items || []).find(t => String(t.id) === String(it.id))
            if (hit) {
              rec.trashFile = hit.file
              const rr = await adapter.restoreTrash(acct, it.owner, hit.file)
              rec.restored = !!(rr && rr.success !== false)
            } else rec.restored = false
          } catch (e2) {
            rec.restored = false
            rec.restoreError = String((e2 && e2.message) || e2)
          }
        }
        log('更新失败「' + it.name + '」：' + rec.error)
      }
      results.push(rec)
    }
    return {
      applied: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
      rejected,
      results,
      note: '只处理 dry-run 判定为 updatable 的条目；未经 apply+confirm 的扫描全程只读'
    }
  }

  return { scan, apply, getLastReport: () => lastReport }
}

module.exports = {
  normName, nameBody, scriptName, sha256, versionNum, cmpVersion, extractUpdateHints, repoKey,
  serverMeta, candidateMeta, platformList,
  pairSources, buildReport, assertApplyAllowed, defaultFetchCode, safeFilename, createUpdater,
  MAX_REPORT_AGE_MS
}
