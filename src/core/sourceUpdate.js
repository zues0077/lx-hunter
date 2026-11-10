'use strict'
/**
 * 已添加源更新（T1 由 lx-hunter 承接，2026-11-10）
 *
 * 目标：把「服务端上已经装着的音源」与上游新版本对上号，并按需推更新。
 * 与灌入（runImport）的区别：灌入是「我库里有个新源 → 灌进去」，
 * 本模块是「服务端上有个源 → 反查上游有没有新版」，起点在服务端列表。
 *
 * 拍板口径（用户 2026-11-10 16:24）：
 *  - A（主）：归一化 @name 配对 + @repository 同源 + @version 比较；
 *            同内容 sha256 精确兜底；匹配不上只报告、绝不动。
 *  - B（补充信号，仅此而已）：@updateUrl / @downloadUrl 只写进 signals，
 *            **不单独把任何条目判成可更新、不单独触发任何动作**。
 *  - 默认 dry-run：只返回报告，不执行 delete / upload。
 *
 * 四个护栏（对齐 hunter.sameNameVerdict 与 lxserver 现状）：
 *  1) owner 隔离：按 owner 分组，apply 只允许处理本次 scan 的 owner；
 *  2) ID 稳定：lxserver 按 @name 生成 id，候选名字与服务端不一致会生成新 id
 *     → 判 unsafe（走改名并存，不删旧）；
 *  3) 先验证后删：apply 必须 validate 通过才 delete，服务端 delete 进 trash 可回滚；
 *  4) 安全不降级：不因「这是更新」跳过 requireUnsafeVM / 契约检查。
 */
const crypto = require('crypto')

/** 与 hunter.js normName 完全同款（同名裁决口径必须一致） */
function normName(s) {
  return String(s || '').toLowerCase().replace(/[\[\]【】（）()|｜:：、,，.。\s_\-·•]+/g, '')
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex')
}

/** 版本号 → 可比较整数（与 hunter.js versionNum 同款，但保留「不可解析」的区分） */
function versionNum(s) {
  const m = String(s || '').match(/[vV]?(\d+(?:\.\d+)+)/)
  if (!m) return 0
  const parts = m[1].split('.')
  let v = 0
  for (let i = 0; i < Math.min(parts.length, 4); i++) v = v * 1000 + (parseInt(parts[i], 10) || 0)
  return v
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

/**
 * 同源键：把 repository / homepage / url 归一到 owner/repo 或 host/path 前两段。
 * 拿不到就返回 ''，交回上层按「缺同源证据」处理，绝不猜。
 */
function repoKey(meta) {
  const raw = String((meta && (meta.repository || meta.homepage || meta.url || meta.repo)) || '').trim()
  if (!raw) return ''
  try {
    const u = new URL(raw.replace(/^github:/, 'https://github.com/'))
    const seg = u.pathname.split('/').filter(Boolean)
    if (/github\.com$/i.test(u.hostname) && seg.length >= 2) {
      return 'gh:' + seg[0].toLowerCase() + '/' + seg[1].toLowerCase().replace(/\.git$/, '')
    }
    return u.hostname.toLowerCase().replace(/^www\./, '') + '/' + seg.slice(0, 2).join('/').toLowerCase()
  } catch (e) {
    const m = raw.match(/^([\w.-]+)\/([\w.-]+)/)
    return m ? 'gh:' + m[1].toLowerCase() + '/' + m[2].toLowerCase().replace(/\.git$/, '') : ''
  }
}

/** 服务端 list 条目 → 统一字段（兼容 lxserver / MusicSync / Songloft 的字段差异） */
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
    // 实测状态以 checker.js 写入的 'usable' 为准（还有历史值 ok / passed）；
    // 旧版漏了 'usable' → 已深检过的候选 usablePlatforms 恒为 0，
    // 导致 pairSources 一律判「候选本地实测 0 个可用平台」，A 覆盖率上不去。
    return p.status === 'usable' || p.status === 'ok' || p.status === 'passed' ||
      p.ok === true || p.pass === true
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
    stale: !!e.stale,
    raw: e
  }
}

/** 名字主体：去掉版本号尾巴再归一化。版本升级时 @name 原文本就会变，
 *  只要主体一致就不会生成新 id；主体变了才说明是另一个脚本。 */
function nameBody(s) {
  return normName(String(s || '').replace(/[vV]?\d+(?:\.\d+)+\S*/g, ' '))
}

function scriptName(code) {
  const m = String(code || '').match(/@name\s+([^\r\n]+)/)
  if (!m) return ''
  // 兼容把多个标签写在同一行的脚本：只取 @name 的值，剥掉注释尾与后续 @xxx
  return m[1].trim().replace(/\s*\*\/.*$/, '').replace(/\s+@[a-zA-Z]+\s+.*$/, '').trim()
}

function platformList(e) {
  const c = candidateMeta(e)
  return c.usablePlatforms
}

/**
 * A 配对核心（纯函数）。
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
    // 更新口径与灌入口径的差别：作者常把版本号写进 @name（v1.2→v1.3），
    // 按 hunter.normName 会永远配不上；这里按「去版本号的名字主体」配对。
    const k = nameBody(c.name)
    if (!k) continue
    if (!byBody[k] || versionNum(c.version) > versionNum(byBody[k].version)) byBody[k] = c
  }

  return list.map(function (raw) {
    const s = serverMeta(raw)
    const signals = extractUpdateHints({ script: s.script })
    const item = {
      id: s.id, name: s.name, owner: s.owner, enabled: s.enabled,
      verdict: 'unmatched', reason: '', applyAllowed: false,
      evidence: { via: 'none', serverVersion: s.version, candidateVersion: '', repo: '', hashMatch: false },
      signals: signals,
      candidate: null
    }
    if (opts.owner && s.owner !== opts.owner) {
      item.verdict = 'unsafe'
      item.reason = 'owner 不匹配（当前扫描限定 ' + opts.owner + '）→ 不处理，避免跨身份误删'
      return item
    }

    const c = byBody[nameBody(s.name)]
    if (!c) {
      item.reason = '本地候选池里没有同源同名条目（出处不明）→ 只报告，不更新'
      if (signals.length) item.reason += '；B 信号仅作提示，不单独触发更新'
      return item
    }
    item.candidate = {
      id: c.id, name: c.name, version: c.version, url: c.url,
      repository: c.repository, hash: c.hash
    }
    item.evidence.candidateVersion = c.version
    item.evidence.repo = repoKey({ repository: c.repository }) || repoKey({ repository: s.repository })
    item.signals = item.signals.concat(extractUpdateHints({ script: c.code }))

    // 1) 同内容：sha256 优先，其次同字节长度（弱证据）
    if (s.hash && c.hash && s.hash === c.hash) {
      item.evidence.via = 'same-content'
      item.evidence.hashMatch = true
      item.verdict = 'current'
      item.reason = '脚本内容指纹相同（sha256）→ 已是同一版本，无需更新'
      return item
    }

    // 2) ID 稳定：真正决定服务端 id 的是脚本正文里的 @name（generateId 的输入）。
    //    库记录可能被人工改过，只有正文一致才能保证「删旧装新」后仍是同一个 id。
    const declared = scriptName(c.code)
    if (declared && nameBody(declared) !== nameBody(s.name)) {
      item.evidence.via = 'name-mismatch'
      item.verdict = 'unsafe'
      item.reason = '候选脚本声明的 @name 主体与服务端条目不一致，上传会生成新 id（平台开关/排序/缓存会丢）→ 走改名并存，不删旧'
      return item
    }

    // 3) 沿用同名裁决硬规则：本地实测全挂 / 本地可用平台更少 / 平台零交集
    if (c.checked && c.usablePlatforms.length === 0) {
      item.verdict = 'unsafe'
      item.reason = '候选本地实测 0 个可用平台 → 不替换（换过去是纯损失）'
      return item
    }
    if (c.checked && s.supportedSources.length > 0 && c.usablePlatforms.length > 0) {
      const overlap = s.supportedSources.filter(p => c.usablePlatforms.indexOf(p) >= 0)
      if (!overlap.length) {
        item.verdict = 'unsafe'
        item.reason = '同名但平台零交集（疑似无关脚本撞名）→ 改名并存，不删旧'
        return item
      }
      if (c.usablePlatforms.length < s.supportedSources.length) {
        item.verdict = 'unsafe'
        item.reason = '服务端现条目支持平台更多 → 保留服务端'
        return item
      }
    }

    // 4) A：同源 + 版本号可比 → 版本高的赢
    const ck = repoKey({ repository: c.repository, url: c.url })
    const sk = repoKey({ repository: s.repository })
    const sameRepo = !!(ck && sk && ck === sk)
    const lv = versionNum(c.version) || versionNum(c.name)
    const sv = versionNum(s.version) || versionNum(s.name)
    if (lv && sv) {
      if (lv <= sv) {
        item.evidence.via = sameRepo ? 'repo-version' : 'version-only'
        item.verdict = 'current'
        item.reason = '服务端版本不低于候选（' + (s.version || s.name) + ' ≥ ' + (c.version || c.name) + '）→ 无需更新'
        return item
      }
      item.evidence.via = sameRepo ? 'repo-version' : 'version-only'
      if (!sameRepo && !opts.allowVersionOnly) {
        item.verdict = 'unmatched'
        item.reason = '候选版本更高，但缺 @repository 同源证据 → 只报告，不自动更新（A 口径不猜）'
        return item
      }
      item.verdict = 'updatable'
      item.applyAllowed = true
      item.reason = sameRepo
        ? '同源同名且候选版本更高 → 可更新（删旧装新）'
        : '同名且候选版本更高（同源证据缺失，已由 allowVersionOnly 显式放行）→ 需人工确认'
      return item
    }

    item.evidence.via = sameRepo ? 'repo-only' : 'none'
    item.verdict = 'unmatched'
    item.reason = sameRepo
      ? '同源但两边版本号不可比 → 不猜，只报告'
      : '缺同源证据且版本号不可比 → 出处不明，只报告'
    return item
  })
}

/** dry-run 报告（纯函数） */
function buildReport(serverList, candidates, opts) {
  opts = opts || {}
  const items = pairSources(serverList, candidates, opts)
  const summary = { total: items.length, updatable: 0, current: 0, unmatched: 0, unsafe: 0, bSignals: 0 }
  for (const it of items) {
    if (summary[it.verdict] != null) summary[it.verdict]++
    if (it.signals && it.signals.length) summary.bSignals++
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
      'lxserver 按 @name 生成 id、delete 进回收站：更新前先 validate，失败保留旧条目。'
    ]
  }
}

/**
 * apply 准入（纯函数）：把「能执行什么」与「执行」分开，便于单测和审计。
 * 未显式 confirm/apply、报告过期、非 updatable、owner 不符一律拒绝。
 */
function assertApplyAllowed(report, ids, opts) {
  opts = opts || {}
  if (!opts.confirm || opts.apply !== true) throw new Error('未显式确认：apply 需同时传 apply:true 与 confirm:true（默认 dry-run）')
  const r = report || opts.report
  if (!r || !Array.isArray(r.items)) throw new Error('请先执行 dry-run 扫描')
  const maxAge = Number(opts.maxAgeMs || 10 * 60 * 1000)
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
        ' / 不建议动 ' + rep.summary.unsafe + '（未写入任何数据）')
    return rep
  }

  async function apply(ids, opts) {
    opts = opts || {}
    const { allowed, rejected } = assertApplyAllowed(lastReport, ids, opts)
    const results = []
    for (const it of allowed) {
      const rec = { id: it.id, name: it.name, owner: it.owner, ok: false, steps: [] }
      try {
        const cand = Object.assign({}, it.candidate, { signals: it.signals })
        const code = await fetchCode(cand, opts.timeoutMs)
        // 3) 先验证后删；4) 安全不降级：requireUnsafe 一律不重试
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
        rec.steps.push('delete(旧脚本进服务端回收站，可回滚)')
        const up = await adapter.upload(acct, code, safeFilename(it.name))
        if (!up || up.success === false) throw new Error('上传新脚本失败：' + String((up && (up.message || up.error)) || ''))
        rec.steps.push('upload')
        rec.ok = true
        rec.newId = up.id || null
        log('已更新「' + it.name + '」（旧 id ' + it.id + ' → 新 id ' + (rec.newId || '?') + '）')
      } catch (e) {
        rec.error = String((e && e.message) || e)
        rec.rollback = '若已 delete 但 upload 失败，旧脚本在服务端回收站（/api/custom-source/trash）可恢复'
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
  normName, nameBody, scriptName, sha256, versionNum, extractUpdateHints, repoKey,
  serverMeta, candidateMeta, platformList,
  pairSources, buildReport, assertApplyAllowed, defaultFetchCode, safeFilename, createUpdater
}
