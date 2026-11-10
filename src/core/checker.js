'use strict'
/** 音源检测：下载 → 疑似识别 → vm 沙箱深度检测（真实取链 + 音频魔数校验） */
const crypto = require('crypto')
const { Sandbox } = require('./sandbox')
const { crawlFetch, readText, fetchAnyWithTimeout, describeNetError, dohLookup, UA } = require('./net')
// 单一来源：音质档位 → 能力分只由 quality.js 定义。
// quality.js 不 require checker，无循环依赖。
const { tierScore } = require('./quality')

const TEST_SONGS = {
  wy: [{ name: '海阔天空', info: { songmid: '347230' } }],
  tx: [{ name: '晴天', info: { songmid: '0039MnYb0qxYhV' } }],
  kw: [{ name: '晴天', info: { songmid: '838607' } }],
  kg: [{ name: '晴天', info: { hash: '30ece05c17d4e9ec8ba0ef9f96e7a07c' } }],
  mg: [{ name: '晴天', info: { copyrightId: '69984639', songmid: '69984639' } }]
}
const PLATFORMS = ['wy', 'tx', 'kw', 'kg', 'mg']
/** 网络类瞬时错误：重试一次很可能就成功，不该据此把平台判死 */
function isTransient(msg) {
  return /timeout|timedout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|abort|fetch failed|fetch 失败|请求超时|连接|已取消/i.test(String(msg || ''))
}

/**
 * 失败原因是否偏向「本机 / 网络侧」，而不是音源本身失效。
 *
 * 这是自动禁用前必须过的闸门：看到 DNS 失败、证书不受信、代理拒绝、429/403，
 * 只能说明「这一刻从这台机器取不到」，不能说明「导入洛雪也不能用」。
 * 过去这里漏掉了中文文案（沙箱抛的是「沙箱 fetch 失败」，而旧规则只认英文 fetch failed），
 * 结果一次网络抖动就把好音源判死、还会被巡检自动禁用 —— 典型的误杀。
 */
function isLocalNetworkIssue(msg) {
  const m = String(msg || '')
  if (!m) return false
  return /fetch 失败|Failed to fetch|沙箱 fetch|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|socket|certificate|证书|代理|proxy|请求超时|解析失败|HTTP (403|401|429|5\d\d)/i.test(m) ||
    isTransient(m)
}
const PLATFORM_LABEL = { wy: '网易云', tx: 'QQ音乐', kw: '酷我', kg: '酷狗', mg: '咪咕' }
const MAX_CONTENT_BYTES = 2 * 1024 * 1024

/** 给慢 Promise 挂一个「取消探针」：shouldStop() 为真时立刻 reject，不再等网络 */
function stoppable(p, shouldStop, intervalMs) {
  return new Promise((resolve, reject) => {
    if (shouldStop && shouldStop()) { reject(new Error('已取消')); return }
    let done = false
    const t = setInterval(() => {
      if (!done && shouldStop && shouldStop()) { done = true; clearInterval(t); reject(new Error('已取消')) }
    }, intervalMs || 250)
    p.then(
      v => { if (!done) { done = true; clearInterval(t); resolve(v) } },
      e => { if (!done) { done = true; clearInterval(t); reject(e) } }
    )
  })
}

function sha256Str(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex') }

/**
 * 构造给脚本的 musicInfo。除 id 外补上歌曲名 ——
 * 真实洛雪传的就是完整歌曲信息，部分脚本依赖 name 做二次搜索/兜底，缺了会直接取不到链。
 */
function musicInfo(song) {
  const base = song.info || {}
  return base.name ? base : Object.assign({ name: song.name }, base)
}

function extractMeta(code) {
  const meta = { name: '', description: '', version: '', author: '', homepage: '' }
  const block = code.match(/\/\*[!*][\s\S]*?\*\//)
  if (!block) return meta
  const pairs = {
    name: /@name\s+(.+)/, version: /@version\s+(.+)/,
    description: /@description\s+(.+)/, author: /@author\s+(.+)/, homepage: /@homepage\s+(.+)/
  }
  for (const k of Object.keys(pairs)) {
    const m = block[0].match(pairs[k])
    if (m && m[1]) meta[k] = m[1].trim()
  }
  return meta
}

/**
 * 宿主插件 / 适配层识别（2026-11-08 实机假阳性复盘）。
 *
 * 背景：jfeng018/mygo-music-lx-source 是「把洛雪音源脚本接进 MyGo Music」的播放器插件。
 * 它的 index.js 为了给第三方脚本造运行时，自带 `globalThis.lx`、`EVENT_NAMES`、`musicUrl`、
 * `inited` 等字样，scoreEntry 算出 8 分 → 被当成音源脚本收进库；release 里同一个 zip
 * 又被 isSourceAsset（名字含 source）放行 → 一次爬取凭空多出 2 条假音源。
 *
 * 判据只认「脚本宿主」而非关键词，且以真音源的硬契约做豁免，避免误伤：
 *  - 真音源必须注册 lx 事件（lx.on 调用）或带 @name 元信息头 → 一律不判宿主；
 *  - 宿主特征：自己 `new Function` 执行第三方脚本 + 提供 EVENT_NAMES/module.exports，
 *    或导出播放器插件生命周期 API（search/stream/lyrics/home/setSetting…）。
 */
function isHostAdapterScript(content) {
  if (!content || typeof content !== 'string') return false
  // ① 洛雪音源脚本的核心契约，命中即豁免（测试夹具里的 globalThis.lx = {} 也靠这条保住）
  if (/\blx\s*\.\s*on\s*\(|\bLX\s*\.\s*on\s*\(|on\s*\(\s*['"]request['"]/.test(content)) return false
  // ② 标准音源元信息头，命中即豁免
  if (/@name\s+\S|@version\s+\S/.test(content)) return false
  // ③ 宿主运行时 / 宿主插件 API
  const buildsRuntime = /new\s+Function\s*\(/.test(content) &&
    /EVENT_NAMES/.test(content) && /module\.exports/.test(content)
  const exportsHostApi = /export\s+(?:async\s+)?function\s+(?:search|stream|lyrics|home|setSetting|browse|signIn|account|playlists)\b/.test(content)
  return buildsRuntime || exportsHostApi
}

/**
 * 音源疑似度打分。阈值从 5 下调到 4：
 * 旧阈值会把「只有 lx.request + @name + 文件名带 source」这类真实音源挡在深检之外，
 * 它们连手动点击「检测」都进不了沙箱（用户表现为「明明能用却检测不出来」）。
 * 深检本身有并发与预算保护，多放行一档不会拖垮速度。
 */
function scoreEntry(path, content) {
  // 宿主插件/适配层不是音源脚本：直接归零，避免「造 lx 运行时」的代码被当成音源特征
  if (content && isHostAdapterScript(content)) return 0
  const fname = String(path || '').split('/').pop() || ''
  let score = 0
  if (/音源|源|source|lx-source/i.test(fname)) score += 2
  if (/^(lx|src|source)[-_ .]/i.test(fname)) score += 1
  if (content) {
    if (/globalThis\s*\.\s*lx\b|globalThis\s*\[\s*['"]lx['"]\s*\]/.test(content)) score += 3
    if (/EVENT_NAMES/.test(content)) score += 2
    if (/\blx\s*\.\s*on\s*\(|\bLX\s*\.\s*on\s*\(/.test(content)) score += 2
    if (/\blx\s*\.\s*request\b|\blx\s*\.\s*send\b|\blx\s*\.\s*utils\b/.test(content)) score += 2
    if (/musicSources|musicUrl|supportedSources|qualitys/.test(content)) score += 2
    if (/@name\s|@description\s/.test(content)) score += 1
    if (/on\s*\(\s*['"]request['"]/.test(content)) score += 2
    if (/['"]inited['"]/.test(content)) score += 1
  }
  return score
}

function classifyEntry(path, content) { return scoreEntry(path, content) >= 4 }

/**
 * 混淆风险评估（v1.7.1，依据 lx-ikun-music-sources issue#8 的科普）：
 * 音源脚本没必要混淆 —— 混淆的主要用途是藏代码（木马/后门/统计上报）。
 * 用三类特征判级，阈值按实测样本标定（23 个真实音源扫描）：
 *  - _0x 十六进制变量名：重混淆样本 37~52 个/KB，良性偶用 < 1 个/KB
 *  - \uXXXX unicode 转义：独家V5 样本 14 个/KB，正常脚本 ≈ 0
 *  - 阿拉伯/异体 Unicode 字符（参与运算的小语种字符）：独家V5 47 个/KB，正常 ≈ 0
 *
 * v1.9.5 增补「反调试 / 自调度」硬特征（依据 2026-10-15 NAS CPU 占用定位实测）：
 * lxserver 上 44 音源实例单核 60%+、内存 513MB，二分定位到 jsjiami.com.v7 混淆的
 * 「洛雪音乐源.js」独吞 63%~67% 单核 + 270MB；其余 45 个音源合计 ≈ 0%。
 * 该脚本的三个签名正常音源一个都不该有（46 个真实音源全量扫描验证，零误报）：
 *  - while(!![]){} 空转死循环：混淆器反调试标准套路（检测到调试器就卡死线程），
 *    直接表现就是持续吃满一个核；
 *  - 混淆自调度定时器：setTimeout/setInterval 被字符串数组间接调用，真实形态
 *    _0x10ce4b[_0x1ff486(0x2dd,'NbSd')](_0x2bcf9e,0x7d0)（每 2s 自调一次）——
 *    所以直接 grep setInterval/setTimeout 是 0 命中，必须按调用形态识别；
 *  - jsjiami.com.v7 混淆器标识串（var version_ = 'jsjiami.com.v7'）。
 * 注意：while(!![]) 只匹配**空函数体**——带函数体的 while(!![]){switch…} 是混淆器
 * 字符串数组解码器的正常工作方式，46 音源里 10 个脚本都有（含干净音源 KuwoDES.js），
 * 误伤它们会直接把好音源判死，所以空转判定必须限定 `\{\s*\}`。
 * 判级：
 *  - 'high'  重度混淆/高危：密度超高阈值，或命中任意反调试硬特征 —— 建议直接拒绝使用
 *  - 'mid'   局部混淆：轻度命中 —— 有风险，需自行甄别（issue 里 Hei Music 属此类）
 *  - ''      未检出混淆特征
 */
function obfuscationRisk(content) {
  const t = String(content || '')
  if (!t || t.length < 200) return { level: '', hits: null }
  const kb = t.length / 1024
  const count = re => (t.match(re) || []).length
  const n0x = count(/_0x[0-9a-f]{4,6}/gi)
  const nUni = count(/\\u[0-9a-fA-F]{4}/g)
  const nExotic = count(/[\u0600-\u06FF\uFB50-\uFEFF]/g)
  // eval / new Function 动态执行：混淆脚本的常用执行出口，单独计数供 tooltip
  const nEval = count(/\beval\s*\(|new\s+Function\s*\(/g)
  // 反调试/自调度硬特征（v1.9.5，见上方注释）：空转死循环 + 混淆自调度 + 混淆器标识
  const nSpin = count(/while\s*\(\s*(?:!!\s*\[\s*\]|!0x0|!0|true)\s*\)\s*\{\s*\}/g)
  const nSelfSched = count(/_0x[0-9a-f]{4,6}\s*(?:\[[^\]\r\n]{1,80}\])?\s*\(\s*_0x[0-9a-f]{4,6}\s*,\s*0x[0-9a-f]{3,5}\s*\)/gi)
  const nJsjiami = count(/jsjiami/gi)
  const hits = {
    perKb0x: n0x / kb, perKbUni: nUni / kb, perKbExotic: nExotic / kb,
    evalCalls: nEval, total0x: n0x, totalUni: nUni, totalExotic: nExotic,
    spinLoops: nSpin, selfSchedCalls: nSelfSched, jsjiamiMarks: nJsjiami
  }
  // 硬特征优先：空转死循环/混淆自调度没有任何正当用途，与密度无关，命中即 high
  if (nSpin >= 1 || nSelfSched >= 1) {
    return { level: 'high', hits }
  }
  const HIGH_0X = 20, HIGH_UNI = 8, HIGH_EXOTIC = 20
  const MID_0X = 2, MID_UNI = 1, MID_EXOTIC = 2
  if (hits.perKb0x >= HIGH_0X || hits.perKbUni >= HIGH_UNI || hits.perKbExotic >= HIGH_EXOTIC) {
    return { level: 'high', hits }
  }
  // 混淆器标识 + 已达局部混淆密度 → high：整份文件过一遍混淆器，不可能只混几行
  if (nJsjiami >= 1 && (hits.perKb0x >= MID_0X || hits.perKbUni >= MID_UNI || hits.perKbExotic >= MID_EXOTIC)) {
    return { level: 'high', hits }
  }
  if (hits.perKb0x >= MID_0X || hits.perKbUni >= MID_UNI || hits.perKbExotic >= MID_EXOTIC) {
    return { level: 'mid', hits }
  }
  return { level: '', hits }
}

/** 混淆风险的中文摘要（状态徽章 tooltip / 日志用） */
function obfuscationTip(risk) {
  if (!risk || !risk.level || !risk.hits) return ''
  const h = risk.hits
  const parts = [`_0x 变量名 ${Math.round(h.perKb0x)}/KB`, `unicode 转义 ${h.perKbUni.toFixed(1)}/KB`, `异体字符 ${Math.round(h.perKbExotic)}/KB`]
    .filter((s, i) => [h.perKb0x >= 2, h.perKbUni >= 1, h.perKbExotic >= 2][i])
  if (h.spinLoops) parts.push(`空转死循环 while(!![]){} ${h.spinLoops} 处（反调试套路，会持续吃满 CPU）`)
  if (h.selfSchedCalls) parts.push(`混淆自调度定时器 ${h.selfSchedCalls} 处（setTimeout/setInterval 经字符串数组间接调用）`)
  if (h.jsjiamiMarks) parts.push(`jsjiami 混淆器标识 ${h.jsjiamiMarks} 处`)
  if (h.evalCalls) parts.push(`动态执行 eval/new Function ${h.evalCalls} 处`)
  return risk.level === 'high'
    ? `重度混淆脚本（${parts.join('、')}）：音源脚本没有混淆的必要，混淆常用于隐藏恶意代码，建议拒绝使用`
    : `含局部混淆（${parts.join('、')}）：可能用于防和谐，也可能藏统计上报/后门，建议自行甄别`
}

function looksAudio(headAscii, b0, b1) {
  if (headAscii.slice(0, 3) === 'ID3') return true
  if (b0 === 0xff && (b1 & 0xe0) === 0xe0) return true
  const four = headAscii.slice(0, 4)
  if (four === 'fLaC' || four === 'OggS' || four === 'RIFF') return true
  if (headAscii.slice(4, 8) === 'ftyp') return true
  return false
}

async function verifyUrl(url) {
  let u
  try { u = new URL(url) } catch (e) { return { ok: false, reason: '无效 URL' } }
  const host = (u.hostname || '').toLowerCase()
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || /^10\./.test(host) ||
    /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host)) {
    return { ok: false, reason: '私有/本地地址，疑似假链接' }
  }
  try {
    const res = await fetchAnyWithTimeout(url, {
      // 不少音乐 CDN 校验 Referer / UA，缺了会返回 403 —— 过去据此把实际可用的音源误判为失效
      headers: { Range: 'bytes=0-16383', 'User-Agent': UA, Referer: u.origin + '/' }
    }, 8000)
    let ct = ''
    try { ct = res.headers.get('content-type') || '' } catch (e) {}
    if (!res.ok && res.status !== 206) return { ok: false, reason: 'HTTP ' + res.status }
    const ab = await res.arrayBuffer()
    const bytes = new Uint8Array(ab.slice(0, 16))
    let ascii = ''
    for (let i = 0; i < bytes.length; i++) ascii += String.fromCharCode(bytes[i])
    // 先以「音频魔数」为准，避免个别 CDN 返回 text/plain / 空 content-type 被误杀
    if (looksAudio(ascii, bytes[0], bytes[1])) return { ok: true, size: ab.byteLength }
    if (/audio|octet-stream/i.test(ct)) return { ok: true, size: ab.byteLength }
    if (/json|text\/html/i.test(ct)) return { ok: false, reason: '返回 ' + ct + '，非音频' }
    return { ok: false, reason: '非音频内容 (' + (ct || '未知') + ')' }
  } catch (e) {
    return { ok: false, reason: describeNetError(e).slice(0, 120) }
  }
}

/** 下载脚本 + 基础判定（可达性、大小、哈希、疑似度、@name/@version）
 *  @returns {{entry:object, code:string|null}} code 直接回传，避免调用方二次下载 */
/** 混淆风险统一评估：主检两条路径（解压 code / 下载 text）都要过一遍 */
function assessObfuscation(entry, text) {
  const risk = obfuscationRisk(text)
  entry.obfLevel = risk.level || ''
  entry.obfHits = risk.hits || null
  return risk
}

async function checkBasic(entry, cfg, onEvent, preferredMirror) {
  entry.lastCheck = Date.now()
  // 压缩包内脚本：内容在爬取时已解出随条目保存（raw 链接指向整个 zip，没法按文件下）。
  // 直接复用，元信息补齐逻辑与下载路径一致。
  if (typeof entry.code === 'string' && entry.code) {
    entry.status = 'ok'
    entry.error = null
    entry.size = entry.code.length
    entry.contentHash = entry.contentHash || sha256Str(entry.code)
    const score = entry.suspectScore != null ? entry.suspectScore : scoreEntry(entry.path, entry.code)
    entry.suspectScore = score
    entry.suspected = score >= 4
    assessObfuscation(entry, entry.code)
    const meta = extractMeta(entry.code)
    entry.scriptName = meta.name || entry.name
    entry.scriptVersion = meta.version || ''
    entry.author = meta.author || ''
    entry.homepage = meta.homepage || ''
    entry.description = meta.description || ''
    entry.lxName = meta.name || ''
    entry.apiHosts = extractApiHosts(entry.code)
    return { entry, code: entry.code }
  }
  const { res, url, mirror } = await crawlFetch(entry.url, null, cfg.timeoutMs, cfg.mirror, preferredMirror)
  if (!res) { entry.status = 'dead'; entry.error = '全部镜像不可达'; return { entry, code: null } }
  if (!res.ok) { entry.status = 'dead'; entry.error = 'HTTP ' + res.status; return { entry, code: null } }
  const text = await readText(res, cfg.timeoutMs)
  if (text.length > MAX_CONTENT_BYTES) { entry.status = 'dead'; entry.error = '文件过大'; return { entry, code: null } }
  entry.size = text.length
  entry.contentHash = sha256Str(text)
  entry.status = 'ok'
  entry.error = null
  entry.fetchMirror = mirror
  entry.fetchUrl = url
  try {
    const lm = res.headers && res.headers.get ? res.headers.get('last-modified') : null
    if (lm) entry.lastModified = Date.parse(lm) || 0
  } catch (e) {}
  const score = scoreEntry(entry.path, text)
  entry.suspectScore = score
  entry.suspected = score >= 4
  assessObfuscation(entry, text)
  const meta = extractMeta(text)
  entry.scriptName = meta.name || entry.name
  entry.scriptVersion = meta.version || ''
  entry.author = meta.author || ''
  entry.homepage = meta.homepage || ''
  entry.description = meta.description || ''
  entry.lxName = meta.name || ''
  entry.apiHosts = extractApiHosts(text)
  return { entry, code: text }
}

/** 受限并发：既要压低总耗时，又不能一次把 5 个平台全打进同一个脚本（见 deepCheck 说明） */
async function runPool(items, width, fn) {
  const queue = items.slice()
  if (!queue.length) return
  const n = Math.max(1, Math.min(width, queue.length))
  await Promise.all(Array.from({ length: n }, async () => {
    while (queue.length) { await fn(queue.shift()) }
  }))
}

/**
 * 单个平台的可用性判定。
 *
 * 【判定口径已修正】脚本能解析出真实 http(s) 音频链接 ⟹ 该平台「可用」。
 * 旧口径要求「狩猎机把这段音频下载下来且魔数校验通过」才算可用，于是遇到需要 Referer、
 * 或有地域/时效限制的 CDN 时，会把「导入洛雪后明明能听」的音源整片误判为失效（假阴性）。
 * 本机能否下载只反映狩猎机到该 CDN 的连通性，并不等价于音源本身能否解析出链接。
 *
 * 每个平台有总预算 deadline：到点即收手，避免多档音质叠加重试把单条目拖到几分钟。
 *
 * @returns null 表示被提前叫停（快速模式已出结果 / 用户取消）
 */
/**
 * 按「脚本自己声明的音质清单」去取链，而不是瞎猜 128k/320k。
 *
 * 洛雪音源注册格式形如：
 *   sources[src] = { name, type:'music', actions:['musicUrl'], qualitys:['128k','320k','flac'] }
 * 大量脚本只认清单里的值（例如只有 'flac' / '320k'，或自定义档位），
 * 请求一个它不支持的 type 会直接返回空 —— 旧逻辑固定试 128k/320k，
 * 于是这类「导入后明明能用」的音源被整片判成无可用平台。
 */
function declaredQualities(def) {
  if (!def || typeof def !== 'object') return []
  const raw = def.qualitys || def.qualities || def.supportQualitys
  if (!Array.isArray(raw)) return []
  return raw.filter(q => typeof q === 'string' && q).slice(0, 4)   // 最多 4 档，避免拖慢
}

/** 音质档位原始清单由调用方传入；这里只负责把「一次深检」的散布指标聚合成可评分的样本集。
 *  设计取舍（2026-11-10 用户要求「综合性检测」）：
 *  - 「取链成功率」的分母是**真实发出的请求数**，不是平台数；快速模式只跑 1 个平台时样本量自然小，
 *    quality.js 会按 MIN_SAMPLES 判证据不足，绝不拿 1 个样本当成功率。
 *  - p50 只统计「拿到 http 链接」的请求耗时；失败请求的耗时单独留档但不当体验分，
 *    否则超时失败会把 p50 压成难看的值、把好源误判成差源。
 *  - 音质档保留原始字符串，评分映射交给 quality.js 单一来源，避免两处口径分裂。
 */
function aggregateMetrics(platforms, srcDefs, depth) {
  let attempts = 0, successes = 0, playable = 0
  const okLat = [], allLat = []
  const qualityUsed = [], qualityMax = [], qualityDeclared = []
  for (const [src, p] of Object.entries(platforms || {})) {
    const m = p && p.metrics
    if (m) {
      attempts += Number(m.attempts) || 0
      successes += Number(m.successes) || 0
      playable += Number(m.playable) || 0
      for (const x of (m.latencies || [])) okLat.push(Number(x) || 0)
      for (const x of (m.attemptLatencies || [])) allLat.push(Number(x) || 0)
      if (m.qualityUsed) qualityUsed.push(String(m.qualityUsed))
      if (m.qualityMax) qualityMax.push(String(m.qualityMax))
    }
    // 声明档位取一份：srcDefs（脚本原始注册对象）优先，缺失时用该平台 metrics 里的副本兜底。
    // 旧实现两边都 push，而 metrics 副本本身就是 declaredQualities(def) 的拷贝 ⇒ 每平台重复两遍，
    // 5 平台就是 10 倍。8192 实测 74/77 条重复、平均 7.5 倍，纯属数据膨胀。
    const def = srcDefs && srcDefs[src]
    const fromDef = declaredQualities(def)
    const fromM = (m && Array.isArray(m.qualityDeclared)) ? m.qualityDeclared : []
    for (const q of (fromDef.length ? fromDef : fromM)) qualityDeclared.push(String(q))
  }
  const lat = okLat.length ? okLat : allLat
  lat.sort((a, b) => a - b)
  const pctl = (arr, p) => {
    if (!arr.length) return null
    const idx = (arr.length - 1) * p
    const lo = Math.floor(idx), hi = Math.ceil(idx)
    return Math.round(arr[lo] + (arr[hi] - arr[lo]) * (idx - lo))
  }
  return {
    // 这次检测是「初筛」还是「打分档」：2026-11-10 00:1x 用户口径 ——
    //   初筛（快速模式）只回答「有没有可用平台」，不产生打分数据；
    //   只有用户主动点「深度检测（打分）」跑全平台，才产出可用于排序/比较的 p50 与平台数。
    // quality.js 只认 depth==='full'，避免拿 1 次成功请求的 p50 冒充实测能力。
    depth: depth === 'full' ? 'full' : 'quick',
    attempts, successes, playable,
    // 「拿到链接」≠「真能播」：lxserver 播放侧已知坑（HEAD 校验重定向失败、
    // content-type 非音频、试听片段拒绝、1500/3000ms 超时，见 A/B 四轮报告），
    // 所以两套比率都留档，由 quality.js 决定权重，绝不在采集层就把假可播当成功。
    successRate: attempts > 0 ? successes / attempts : null,
    playableRate: attempts > 0 ? playable / attempts : null,
    p50LatencyMs: pctl(lat, 0.5), p90LatencyMs: pctl(lat, 0.9),
    samples: lat.length,
    okSamples: okLat.length,
    // 去重：声明档位来自各平台 def，同一声明会重复 5 次，Set 后只保留真实档位集合。
    qualityUsed, qualityMax,
    qualityDeclared: [...new Set(qualityDeclared)]
  }
}

async function testPlatform(sb, src, cfg, onEvent, bail, displayName, def) {
  const songs = TEST_SONGS[src] || []
  if (!songs.length) return { status: 'skipped', message: '无测试歌曲' }
  const declared = declaredQualities(def)
  // 音质档探测策略（2026-11-10 23:5x 用户口径，覆盖同日 23:0x 的「最高档优先」）：
  //   「全面检测没必要测音源音质；只有同名、同平台数、同 p50 才需要比音质」
  //   ⇒ 采集阶段只回答「能不能用」，按脚本声明的档位顺序逐档试到成功即停。
  //   ⇒ 不做「最高档优先」探测：全库为排序多付一次高档超时（47→60~70 分钟）不划算，
  //     且 qualityMax 一旦只在深检里写，就等于「排序用的音质列」绑架了检测耗时。
  //   ⇒ 真正的音质证据由「同名冲突走到第③层」时的专项补测产生（写 metrics.qualityMax），
  //     这里不产出，所以本阶段 qualityMax 恒为 null。
  const probeList = declared.length ? declared : ['128k', '320k']
  const metrics = {
    attempts: 0, successes: 0, playable: 0, latencies: [], attemptLatencies: [],
    qualityUsed: null, qualityMax: null, qualityDeclared: declared
  }
  const done = r => Object.assign(r, { metrics })
  // 单平台总预算：够跑完「多档音质 + 一次抖动重试」，又不至于让坏脚本拖垮整个批次。
  // 显式配置了就用配置值（只兜一个很小的下限），否则按取链超时推算。
  const budgetCfg = Number(cfg.platformBudgetMs)
  const budget = budgetCfg > 0 ? Math.max(3000, budgetCfg) : (Number(cfg.linkTimeoutMs) || 20000) * 2
  const deadline = Date.now() + budget
  let lastMsg = ''
  for (const q of probeList) {
    for (const song of songs) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (bail()) return done({ status: 'untested', message: '已停止（其它平台已确认可用）' })
        if (Date.now() > deadline) { lastMsg = lastMsg || '取链超时（已超出单平台预算）'; continue }
        onEvent('step', { text: `沙箱取链 ${PLATFORM_LABEL[src]}「${song.name}」${q} · ${displayName || ''}` })
        try {
          const left = Math.max(1000, deadline - Date.now())
          const waitMs = Math.min(Number(cfg.linkTimeoutMs) || 20000, left)
          const t0 = Date.now()
          const r = await stoppable(
            sb.dispatch('request', { source: src, action: 'musicUrl', info: { type: q, musicInfo: musicInfo(song) } }, waitMs),
            bail
          )
          const dt = Date.now() - t0
          metrics.attempts++
          metrics.attemptLatencies.push(dt)
          const ret = r && r.result
          // 规范协议要求返回字符串；少数脚本返回 {url} / {link} / {data} 形式，一并兼容，
          // 否则这批源会被当成「返回异常」误杀
          let link = null
          if (typeof ret === 'string') link = ret
          else if (ret && typeof ret === 'object') {
            const cand = ret.url || ret.link || ret.data
            if (typeof cand === 'string') link = cand
          }
          if (link && /^https?:\/\//i.test(link)) {
            const v = await stoppable(verifyUrl(link), bail).catch(() => ({ ok: false, reason: bail() ? '未校验（已确认可用，无需继续）' : '校验异常' }))
            // 明确是假链接（内网/非法地址）才算真的失败，且不用再试其它音质。
            // 注意：此时不能计入 successes/latencies —— 拿到内网串不等于「取链成功」，
            // 否则综合评分的「取链成功率」会被假链接灌水。
            if (/私有|本地|无效 URL/.test(v.reason || '')) return done({ status: 'failed', message: v.reason })
            metrics.successes++
            metrics.latencies.push(dt)
            if (!metrics.qualityUsed) metrics.qualityUsed = q
            // 注意：这里**不**写 qualityMax。qualityUsed 是「声明顺序里第一个成功的档位」，
            // 只能证明「这个档能用」，不能证明「更高档用不了」；把它当最高可播档会
            // 让「qualitys 写 128k 在前」的差源看起来和 flac 源同档。最高可播档由专项补测写入。
            if (v.ok) {
              metrics.playable++
              return done({ status: 'usable', message: `「${song.name}」返回可播音频 (${q})`, url: link, verified: true })
            }
            // 链接已解析出来，只是本机没拉下来 —— 仍判可用，把原因标注出来供参考
            return done({ status: 'usable', message: `已解析音频链接（本机未校验：${v.reason}）`, url: link, verified: false })
          }
          lastMsg = (ret == null || ret === '') ? '返回空链接' : '返回异常: ' + String(ret).slice(0, 60)
        } catch (e) {
          lastMsg = String((e && e.message) || e).slice(0, 80)
          // 网络抖动才重试；脚本明确返回空/异常没必要再试
          if (isTransient(lastMsg) && attempt < 2) { onEvent('step', { text: `${PLATFORM_LABEL[src]} 网络抖动，重试…` }); continue }
        }
      }
    }
  }
  return done({ status: 'failed', message: lastMsg || '未知失败' })
}

/** 沙箱深度检测：初始化脚本 + 平台真实取链
 *  - quickCheck（默认开）：拿到第一个可用平台即通过，剩余平台标记跳过，大幅提速
 *  - 脚本未注册的平台直接跳过，不发请求
 *  - 结果记录内容指纹 hash，供「跳过已检测且内容未变」使用 */
async function deepCheck(entry, code, cfg, onEvent, shouldStop) {
  const result = { checkedAt: Date.now(), loadable: false, loadError: null, inited: false, platforms: {}, hash: entry.contentHash || null }
  const quick = cfg.quickCheck !== false
  const meta = extractMeta(code)
  result.version = meta.version
  result.lxName = meta.name || ''
  result.author = meta.author || ''
  let sb = null
  let recovered = false
  try {
    sb = new Sandbox({
      id: entry.id,
      fetchTimeout: cfg.timeoutMs,
      dispatchTimeout: Number(cfg.linkTimeoutMs) || 20000,
      initGraceMs: Number(cfg.initGraceMs) || 4000,
      initGraceMaxMs: Number(cfg.initGraceMaxMs) || 15000
    })
    const initRes = await sb.init(code, {
      name: meta.name, description: meta.description, version: meta.version,
      author: meta.author, homepage: meta.homepage, rawScript: code
    })
    recovered = !!(initRes && initRes.recovered)
    // 只知道脚本挂了取链处理器、却没拿到它声明的平台列表 ⇒ 按标准五平台全测。
    // 此时某个平台失败不等于「脚本不支持」，只是这次没取到链，UI 需据此措辞。
    result.guessedSources = !!(initRes && initRes.guessedSources)
    if (recovered) result.initWarning = (initRes && initRes.runError) || '脚本初始化有报错，但已注册音源，仍按可用流程实测'
    if (!initRes.inited) {
      result.loadError = (sb.initError && ('脚本执行报错: ' + sb.initError)) || "脚本未调用 lx.send('inited', …)"
      return result
    }
    // 保留完整注册对象：里面的 qualitys 决定「该用哪个音质去请求」，是能不能取到链的关键
    const srcDefs = (initRes.data && initRes.data.sources) || {}
    result.sources = Object.keys(srcDefs)
    result.sourceDefs = srcDefs
    result.loadable = true
    result.inited = true
    // 脚本注册了哪些平台（key 一般是 wy/tx/kw/kg/mg）；全部 key 都不认识时视为无法判断，逐个照常测
    const srcKeys = result.sources.map(k => String(k).toLowerCase())
    const registered = srcKeys.filter(k => PLATFORMS.includes(k))

    // 快速模式下「任一平台已确认可用」后即通知其余平台尽快收手，不必再等它们跑完
    let stopEarly = false
    const bail = () => stopEarly || !!(shouldStop && shouldStop())
    let anyUsable = false

    const queue = PLATFORMS.filter(src => !registered.length || registered.includes(src))
    for (const src of PLATFORMS) {
      if (!queue.includes(src)) result.platforms[src] = { status: 'skipped', message: '脚本未提供该平台' }
    }

    // 限制的并发数而非一次性全放：少数脚本用模块级共享变量暂存「当前请求状态」，
    // 5 个平台同时打进去会互相串味，反而制造新的假阴性。默认 3 路，够快也够安全。
    const width = Math.max(1, Math.min(5, Number(cfg.platformConcurrency) || 3))
    await runPool(queue, width, async src => {
      if (bail()) return
      const r = await testPlatform(sb, src, cfg, onEvent, bail, result.lxName || entry.name, srcDefs[src]).catch(e => ({ status: 'failed', message: String((e && e.message) || e).slice(0, 80) }))
      if (!r) return
      result.platforms[src] = r
      if (r.status === 'usable') { anyUsable = true; if (quick) stopEarly = true }
    })

    // 并发串扰兜底：失败的平台单独再串行跑一次（此刻没有其它请求在飞），
    // 若这次成功，说明上一轮是并发导致的假阴性，以串行结果为准。
    const cancelled0 = !!(shouldStop && shouldStop())
    const losers = queue.filter(src => {
      const p = result.platforms[src]
      if (!p || p.status !== 'failed') return false
      // 明确是假链接的没必要复测
      if (/私有|本地|无效 URL/.test(p.message || '')) return false
      // 超时/取消是脚本本身卡死，复测也只是再等一轮，白白翻倍耗时
      if (/超时|已取消/.test(p.message || '')) return false
      return true
    })
    // 若所有平台报的是同一个错（网络不通、网关挂了、鉴权失败…），
    // 那是系统性原因而不是并发串扰，再串行复测只是把耗时翻倍却不会改变结论。
    const msg0 = losers.length ? String(result.platforms[losers[0]].message || '') : ''
    // 只有当「同一个错」且属于系统性原因（网络/沙箱/网关）才跳过复测。
    // 「返回空链接」这种恰好是并发串扰的典型特征，必须保留复测，否则会误杀。
    const systemic = /fetch 失败|沙箱|网络|超时|HTTP \d+|ECONN|ENOTFOUND|ETIMEDOUT|鉴权|403|401/i.test(msg0)
    const allSameReason = queue.length > 1 && losers.length === queue.length &&
      new Set(losers.map(src => String(result.platforms[src].message || ''))).size === 1 && systemic
    const needRetry = losers.length && !allSameReason && !cancelled0 && !(quick && anyUsable)
    result.retrySkipped = losers.length > 0 && !needRetry && !!allSameReason
    if (needRetry) {
      // 复测也要有预算，否则「脚本整体卡死」时会被逐个重试点名拖到几分钟
      const rbCfg = Number(cfg.retryBudgetMs)
      const retryDeadline = Date.now() + (rbCfg > 0 ? Math.max(2000, rbCfg) : 25000)
      for (const src of losers) {
        if (shouldStop && shouldStop()) break
        if (Date.now() > retryDeadline) break
        const r = await testPlatform(sb, src, cfg, onEvent, () => !!(shouldStop && shouldStop()), result.lxName || entry.name, srcDefs[src]).catch(() => null)
        if (!r) continue
        result.platforms[src] = r
        if (r.status === 'usable') {
          anyUsable = true
          if (quick) break // 快速模式：复测出一个可用就够了
        }
      }

      // 靠复测才救回来的：说明首轮结果普遍受并发串扰污染，
      // 其余仍标 failed 的平台实为「没验证干净」，按未验证计，避免整片误判失效
      if (anyUsable && quick) {
        for (const src of losers) {
          const p = result.platforms[src]
          if (p && p.status === 'failed') result.platforms[src] = { status: 'untested', message: '未逐一验证（已确认该音源可用）' }
        }
      }
    }

    const cancelled = !!(shouldStop && shouldStop())
    for (const src of PLATFORMS) {
      if (result.platforms[src]) continue
      if (cancelled) result.platforms[src] = { status: 'skipped', message: '已取消' }
      // 注意：这里是「未测」而不是「不支持」，界面必须区别于 failed，
      // 否则会让人以为音源只支持 1 个平台（洛雪里显示多平台来自脚本声明，本工具才是真取链验证）
      else if (anyUsable && quick) result.platforms[src] = { status: 'untested', message: '未测（快速模式：已确认可用即停止）' }
      else result.platforms[src] = { status: 'skipped', message: '未检测' }
    }
    // 脚本声明支持的平台数（洛雪里显示的多平台来自这个值，未经真实取链验证）
    result.declaredSources = result.sources || []
    // 全平台同因失败时给出方向性提示。
    // 特别地，DNS 解析失败必须用公共 DoH 二次确认：
    //   「本机 DNS 坏了」→ 可自救；「域名全网都不存在」→ 音源接口已停用，该删。
    // 过去这两者显示同一句 ENOTFOUND，用户会以为检测坏了，实际是音源死了。
    const failing = queue.map(src => result.platforms[src]).filter(p => p && p.status === 'failed')
    if (failing.length >= 2 && new Set(failing.map(p => String(p.message || ''))).size === 1) {
      const msg0 = String(failing[0].message || '')
      const hostM = msg0.match(/ENOTFOUND\s+([a-z0-9][a-z0-9.-]*[a-z0-9])/i)
      if (hostM) {
        const doh = await dohLookup(hostM[1]).catch(() => ({ ok: false, nx: false, ips: [] }))
        if (doh.nx) {
          result.deadDomain = true
          result.hint = '接口域名 ' + hostM[1] + ' 已失效（公共 DNS 确认域名不存在，多为接口停用或域名易主），该音源大概率已废弃，建议删除或找替代源'
        } else if (doh.ok && doh.ips.length) {
          result.hint = '接口域名 ' + hostM[1] + ' 本机解析失败，但公共 DNS 可解析：是本机 DNS 被污染或抽风，换 DNS / 开代理后重测即可，不代表导入洛雪后不可用'
        } else {
          result.hint = sameReasonHint(msg0)
        }
      } else {
        result.hint = sameReasonHint(msg0)
      }
    }
  } catch (e) {
    const msg = String((e && e.message) || e)
    result.loadError = msg.slice(0, 200)
    if (msg === '已取消') result.cancelled = true
  } finally {
    if (sb) sb.stop()
    if (sb) sb.destroy()
    // 统一在这里收口失效类别：无论走正常流程还是异常分支，统计口径都一致
    result.failKind = deepFailKind(result)
    // 综合性检测样本集：异常/取消时也要有一份（可能为空），下游评分据此判「证据不足」
    result.metrics = aggregateMetrics(result.platforms, result.sourceDefs || {}, quick ? 'quick' : 'full')
  }
  return result
}

/**
 * 音质档专项补测（只在「同名冲突、各维度都打平」时调用）。
 *
 * 为什么不能放进常规检测：用户口径是「全面检测没必要测音质」——
 * 每个平台都先试最高档会让全库 47 → 60~70 分钟，只为排序多一列，不划算。
 * 但同名冲突走到最后一层（平台数相同、p50 差在噪声带内）时，
 * 「能不能播 flac」就是唯一的区别依据，这时才值得为**那一条**付一次探测成本。
 *
 * 做法：建一次沙箱 → 只挑 1~2 个已实测可用的平台 → 按声明档位的**能力分从高到低**
 * 取前两档试探（最高档成功即得证；最高失败再退次高档，避免「全库最高档都不支持」时误判无音质）；
 * 两档都失败则**不写结果**（不能把 128k 当能力，也不能凭「高两档失败」就断言最高只有 128k）。
 *
 * @returns {{ok:boolean, tier:string|null, platform:string|null, tried:Array, reason:string}}
 */
function planTierProbe(declared, max) {
  const n = Math.max(1, Number(max) || 2)
  return (Array.isArray(declared) ? declared : [])
    .filter(q => typeof q === 'string' && q)
    .map(q => ({ q, s: (tierScore(q) || {}).score || 0 }))
    .sort((a, b) => b.s - a.s)      // 能力分高的在前（同分保持声明顺序，sort 稳定）
    .slice(0, n)
    .map(x => x.q)
}

async function probeTopTier(entry, code, cfg, opts) {
  const o = opts || {}
  const c = cfg || {}
  const out = { ok: false, tier: null, platform: null, tried: [], reason: '' }
  if (!code) { out.reason = '没有脚本正文，无法补测'; return out }
  const budgetMs = Math.max(3000, Number(o.budgetMs) || 20000)
  const deadline = Date.now() + budgetMs
  const want = Array.isArray(o.platforms) && o.platforms.length ? o.platforms.slice(0, 2) : null
  let sb = null
  try {
    sb = new Sandbox({
      id: (entry && entry.id) || 'tier-probe',
      fetchTimeout: c.timeoutMs,
      dispatchTimeout: Number(c.linkTimeoutMs) || 20000,
      initGraceMs: Number(c.initGraceMs) || 4000,
      initGraceMaxMs: Number(c.initGraceMaxMs) || 15000
    })
    const meta = extractMeta(code) || {}
    const initRes = await sb.init(code, {
      name: meta.name, description: meta.description, version: meta.version,
      author: meta.author, homepage: meta.homepage, rawScript: code
    })
    if (!initRes || !initRes.inited) {
      out.reason = '脚本初始化失败，无法补测音质档'
      return out
    }
    const srcDefs = (initRes.data && initRes.data.sources) || {}
    const cand = (want || Object.keys(srcDefs)).filter(k => srcDefs[k])
    if (!cand.length) { out.reason = '脚本没有注册任何可测平台'; return out }
    for (const src of cand) {
      if (Date.now() > deadline) { out.reason = out.reason || '补测超出时间预算'; break }
      // 按能力分从高到低取前两档（flac24bit → flac → 320k → …）：
      // 最高档能播就直接得证；不能播才退次高档，避免「脚本声称支持 flac 但实际只有 320k」
      // 被误记成「没有音质」。第三档以后不探 —— 那是常规检测该回答的问题，不是第三层。
      const probe = planTierProbe(declaredQualities(srcDefs[src]), 2)
      if (!probe.length) continue
      // 只把「要探的两档」塞进 def.qualitys：testPlatform 会按这个顺序逐档试，
      // 第一个成功即返回，于是 metrics.qualityUsed 就是这两档里真正能播的最高档。
      const def = Object.assign({}, srcDefs[src], { qualitys: probe })
      const r = await testPlatform(sb, src, c, () => {}, () => Date.now() > deadline, meta.name || (entry && entry.name) || '', def)
        .catch(e => ({ status: 'failed', message: String((e && e.message) || e).slice(0, 80) }))
      out.tried.push({ platform: src, qualities: probe, status: (r && r.status) || 'failed', message: (r && r.message) || '' })
      if (r && r.status === 'usable' && r.metrics && r.metrics.qualityUsed) {
        out.ok = true
        out.tier = r.metrics.qualityUsed
        out.platform = src
        return out
      }
    }
    out.reason = out.reason || '最高两档音质都取不到可播链接（不能据此断言更低档的表现）'
    return out
  } catch (e) {
    out.reason = String((e && e.message) || e).slice(0, 120)
    return out
  } finally {
    if (sb) { try { sb.stop() } catch (e) {} try { sb.destroy() } catch (e) {} }
  }
}

/**
 * 全平台报同一个网络错时，给一条「能照着做」的提示。
 *
 * 这类错误几乎从来不代表音源废了 —— 洛雪客户端跑的是同一份脚本、同一个 Link 流程，
 * 差别只在本机网络栈（代理 / 证书 / DNS / 防火墙）。所以提示的重点是：告诉用户可以先怎么试，
 * 并明确「这可能是本机环境问题」，别让人误以为这批音源都不能用而白删。
 */
function sameReasonHint(msg) {
  const m = String(msg || '')
  if (!m) return ''
  // 错误信息形如「沙箱 fetch 失败: fetch failed ← getaddrinfo ENOTFOUND xxx.com […]」，取最内层原因
  let cause = String(msg || '').replace(/^沙箱 fetch 失败:\s*/, '')
  if (cause.indexOf('←') >= 0) cause = cause.split('←').pop()
  cause = cause.replace(/\[.*$/, '').trim()
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|解析/i.test(cause)) {
    return '域名解析失败（' + cause.slice(0, 40) + '）：本机 DNS 或运营商拦截，不代表导入洛雪后不可用。可尝试换 DNS / 开代理后再测'
  }
  if (/certificate|证书|UNABLE_TO_VERIFY|SSL/i.test(cause)) {
    return '证书校验失败（' + cause.slice(0, 40) + '）：多为代理或安全软件的中间人证书，不代表导入洛雪后不可用'
  }
  if (/ECONNREFUSED/.test(cause)) {
    return '连接被拒绝（' + cause.slice(0, 40) + '）：多为本机代理端口不对或防火墙拦截，不代表导入洛雪后不可用'
  }
  if (/超时|timeout|ETIMEDOUT/i.test(cause)) {
    return '请求超时（' + cause.slice(0, 40) + '）：本机到音源接口太慢或被限速，可放宽「链接超时」后重测，不代表导入洛雪后不可用'
  }
  if (/403|401|鉴权/i.test(cause)) {
    return '接口返回鉴权失败（' + cause.slice(0, 40) + '）：多为音源侧限流或本机 IP 被拒，不代表导入洛雪后不可用'
  }
  if (/HTTP \d+/.test(m)) {
    return '所有平台返回 ' + (m.match(/HTTP \d+/) || [''])[0] + '：多为接口限制或本机网络限制，不代表导入洛雪后不可用'
  }
  if (/fetch 失败|沙箱|网络/.test(m)) {
    return '所有平台报同一个网络错（' + cause.slice(0, 60) + '），多为本机到音源接口不通或被拦截，不代表导入洛雪后不可用'
  }
  return '所有平台报同一个错：' + m.slice(0, 60)
}

/** 统计可用平台数。两种入参都认：
 *  - 整个条目 { deep: { platforms } }（音源库条目）
 *  - 深检结果本身 { platforms }（deepCheck 的返回值）
 *  过去巡检把深检结果 d 直接传进来，函数只认 entry.deep ⇒ 永远返回 0 ⇒
 *  所有已灌入源被巡检判死并自动禁用（包括主检明明可用的）—— 这是「检测可用的源被巡检禁用」的根因。 */
function usableCount(entry) {
  const deep = entry && entry.deep ? entry.deep : (entry && entry.platforms ? entry : null)
  const p = (deep && deep.platforms) || {}
  let n = 0
  for (const s of Object.keys(p)) if (p[s] && p[s].status === 'usable') n++
  return n
}

/**
 * 深检结果的「失效类别」（供统计卡、筛选与状态徽章使用）：
 *  - 'dead'：无任何可用平台、有平台实测失败，且失败原因不像本机网络/限流（真失效）
 *  - 'net' ：同样无可用平台，但失败原因偏向本机网络/限流（可自救，不计入失效）
 *  - ''    ：其余（有可用平台 / 加载失败 / 没有实测失败的平台 / 已取消）
 * 过去统计只认「脚本下载失败(status=dead)」，深检全平台失败的真实失效源全部被算进
 * 「疑似」，失效栏永远是 0 —— 与列表里一片红自相矛盾。
 */
function deepFailKind(deep) {
  if (!deep || deep.loadError || deep.cancelled) return ''
  const vals = Object.values(deep.platforms || {})
  if (vals.some(p => p && p.status === 'usable')) return ''
  const failed = vals.filter(p => p && p.status === 'failed')
  if (!failed.length) return ''
  if (deep.deadDomain === true) return 'dead'
  // 只要有任一失败像网络问题（超时/DNS/限流…）就保守归为「网络疑云」，不把可自救的源算死
  return failed.some(p => isLocalNetworkIssue(p.message || '')) ? 'net' : 'dead'
}

/**
 * 巡检判定：把一次巡检深检结果翻成 verdict（纯函数，便于测试）。
 * 策略——「一次失败不判死」：
 *  - 铁证（脚本已删 / 域名全网注销 / 已不是音源）可立即判死；
 *  - 其余全平台失败只算「疑似失效」，连续 threshold 次（默认 2）才升级为 dead。
 *    聚合类音源对请求频率极敏感，巡检 34 个源并发重测很容易被限流而全灭，
 *    一次失败就禁用会误杀用户正在用的源。
 * @returns {{verdict:'ok'|'dead'|'unknown'|'suspect', note:string, fatal?:boolean, streak?:number}}
 */
function patrolJudge(d, ctx) {
  const c = ctx || {}
  if (!d || d.cancelled) return { verdict: 'unknown', note: d && d.cancelled ? '已取消' : '无深检结果' }
  if (!d.loadable) return { verdict: 'unknown', note: '本地无法验证（' + String(d.loadError || '').slice(0, 60) + '），不动服务端' }
  const n = usableCount(d)
  if (n > 0) return { verdict: 'ok', note: '可用平台 ' + n + ' 个' + (c.updated ? '（脚本内容已更新）' : '') }
  const fails = Object.values(d.platforms || {}).filter(p => p && p.status === 'failed')
  const firstMsg = fails.length ? String(fails[0].message || '') : ''
  const netIssue = fails.some(p => isLocalNetworkIssue(p.message || ''))
  if (netIssue && d.deadDomain !== true) {
    return {
      verdict: 'unknown',
      note: '全部平台取链失败，但失败原因像本机网络/限流（' + firstMsg.slice(0, 60) + '），不禁用' +
        (d.hint ? '；建议：' + String(d.hint).slice(0, 80) : '')
    }
  }
  if (d.deadDomain === true) return { verdict: 'dead', fatal: true, streak: (Number(c.prevStreak) || 0) + 1, note: '接口域名已失效（公共 DNS 确认不存在）' }
  const streak = (Number(c.prevStreak) || 0) + 1
  const need = Math.max(1, Number(c.threshold) || 2)
  const brief = d.hint ? String(d.hint).slice(0, 90) : (firstMsg ? '如 ' + firstMsg.slice(0, 60) : '五平台真实取链全部失败')
  if (streak >= need) return { verdict: 'dead', streak, note: '连续 ' + streak + ' 次巡检全平台失败：' + brief }
  return { verdict: 'suspect', streak, note: '五平台取链全部失败（连续第 ' + streak + ' 次），连续 ' + need + ' 次确认后才自动禁用' }
}

/**
 * 把一次深检结果固化为可记录的「探针」（对齐 lxhub 的 probe_* 字段，v1.9.9）：
 * 本工具的 deepCheck 本就是「真实能力探针」——在沙箱里初始化脚本、按声明音质向各平台
 * 真实发起 musicUrl 取链并校验音频魔数。这里把它的结论落成一等公民字段，便于：
 *  - 前端展示「已实测可用 / 降级 / 无法加载 / 未测」
 *  - 统计连续失败次数（probeFailStreak），供巡逻自动退役
 *  - 给出两级置信 validTier（confirmed 真实取链通过 / probable 疑似音源未实测通过 / rejected 明确非音源或已死）
 * @param {object} e 音源库条目（会被就地写入 probe / validTier / probeFailStreak）
 * @param {object} [d] 深检结果（缺省用 e.deep）
 * @returns {object} e
 */
function applyProbeRecord(e, d) {
  const deep = d || e.deep
  const usable = usableCount(deep)
  let status, detail
  if (!deep || deep.cancelled) {
    status = 'untested'; detail = '未检测或未确认'
  } else if (!deep.loadable) {
    status = 'not_loadable'; detail = String(deep.loadError || '脚本无法加载').slice(0, 120)
  } else if (usable > 0) {
    status = 'usable'; detail = '可用平台 ' + usable + ' 个'
  } else {
    const fails = Object.values(deep.platforms || {}).filter(p => p && p.status === 'failed')
    const net = fails.some(p => isLocalNetworkIssue(p.message || ''))
    status = net ? 'degraded' : 'not_loadable'
    detail = net ? '全部平台取链失败（疑似本机网络/限流）' : '全部平台取链失败（音源可能已失效）'
  }
  e.probe = {
    status,
    detail,
    checkedAt: (deep && deep.checkedAt) || Date.now(),
    sha: e.contentHash || null,
    sources: (deep && deep.declaredSources) || null
  }
  if (status === 'usable') e.validTier = 'confirmed'
  else if (e.suspected) e.validTier = 'probable'
  else e.validTier = 'rejected'
  e.probeFailStreak = (status === 'usable') ? 0 : (Number(e.probeFailStreak) || 0) + 1
  return e
}

/**
 * 抽取脚本里出现的「疑似接口域名」（v1.9.10，借鉴 lxhub 的 api_hosts）：
 * 洛雪音源脚本通过 lx.request 向各音乐平台接口取链，这些域名就是音源的「后端」——
 * 后端挂了，脚本写得再对也取不到链。这里从代码里抓出 http(s):// 域名，去重后供存活探测。
 * 过滤掉明显不是接口的噪声（CDN/图床/文档/github 自身），上限 8 个。
 * @param {string} code 脚本源码
 * @returns {string[]} 去重后的域名列表
 */
function extractApiHosts(code) {
  const t = String(code || '')
  const hosts = new Set()
  const re = /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)/gi
  let m
  while ((m = re.exec(t)) && hosts.size < 16) {
    const host = m[1].toLowerCase()
    if (/(?:^|\.)(github\.com|github\.io|githubusercontent\.com|jsdelivr\.net|unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|w3\.org|schema\.org|nodejs\.org)$/i.test(host)) continue
    if (/\.(png|jpg|jpeg|gif|svg|css|js|json|md|woff2?|ttf)$/i.test(host)) continue
    hosts.add(host)
  }
  return Array.from(hosts).slice(0, 8)
}

/**
 * 对抽取出的接口域名做轻量存活探测（v1.9.10，借鉴 lxhub 的 api_alive）。
 * 仅在 cfg.apiHostCheck 开启时执行（默认关，避免对每个音源每个域名都打网络请求）。
 * 后端域名全挂的音源，即便脚本本身能加载，也基本等于失效——提前标记便于巡检。
 * @param {object} entry 音源条目（就地写入 apiAlive: {host: 'up'|'down'|'http_N'}）
 */
async function probeApiHosts(entry, cfg) {
  const hosts = Array.isArray(entry.apiHosts) ? entry.apiHosts : []
  if (!hosts.length || !cfg || !cfg.apiHostCheck) return
  const out = {}
  for (const h of hosts) {
    try {
      const res = await fetchAnyWithTimeout('https://' + h + '/', { method: 'HEAD', headers: { 'User-Agent': UA } }, 5000)
      const st = res && res.status
      out[h] = (res && (res.ok || st === 403 || st === 405)) ? 'up' : ('http_' + (st != null ? st : 'na'))
    } catch (e) {
      out[h] = 'down'
    }
  }
  entry.apiAlive = out
  // 生命周期遥测（v1.9.11，借鉴 lxhub 的 api_down_streak）：后端域名全挂 = 音源基本失效。
  // 只要有一个可达（up 或返回了 HTTP 状态码，说明域名解析且服务在）就清零；全部不可达才累计。
  const anyAlive = Object.values(out).some(s => s === 'up' || String(s).startsWith('http_'))
  entry.apiDownStreak = anyAlive ? 0 : (Number(entry.apiDownStreak) || 0) + 1
}

/**
 * 把「接口域名存活遥测」翻译成巡检判定（v1.9.11，对齐 lxhub api_down_streak）。
 * 仅在 cfg.apiHostCheck 开启时有效；后端域名连续全部不可达，等价于深检全平台失败。
 * @returns {null|{verdict:'dead'|'suspect', note:string, streak:number}}
 */
function apiDownVerdict(e, cfg) {
  if (!cfg || !cfg.apiHostCheck) return null
  const streak = Number(e && e.apiDownStreak) || 0
  if (streak <= 0) return null
  const thr = Math.max(1, Number(cfg.patrolDisableAfter) || 2)
  if (streak >= thr) return { verdict: 'dead', note: `接口域名连续 ${streak} 次巡检全部不可达（后端已失效）`, streak }
  return { verdict: 'suspect', note: `接口域名连续 ${streak} 次不可达`, streak }
}

/**
 * 收集一次深检结果里「实测通过」的平台清单（质量守门 v1.12.0 用）。
 * 只认 status === 'usable'（与 usableCount 同口径）；'untested'/'skipped' 是「没测/未提供」，
 * 不是「测了不过」，不进通过集合。调用方负责先确认 deep.hash === contentHash（结果属于当前内容）。
 * @param {object} deep 深检结果 { platforms: { src: { status } } }
 * @returns {string[]} 通过的平台名数组（保持 platforms 的键序）
 */
function passedPlatforms(deep) {
  const p = (deep && deep.platforms) || {}
  const out = []
  for (const s of Object.keys(p)) if (p[s] && p[s].status === 'usable') out.push(s)
  return out
}

/**
 * 版本回归判定（质量守门 v1.12.0，纯函数便于测试）：
 * 新版本实测通过范围是否比上一版「缩小」。
 *
 * 证据口径刻意保守（借鉴 shellsec/lx-music-source 的 previousPassed/passed 回归对比，
 * 但比它稳）：只有「上一版通过、这一版**实测失败**」才算丢失平台——快速模式的
 * 'untested'、未声明平台的 'skipped' 都算未定证据，不计入丢失，避免把
 * 「没测到」误判成「测了不过」（风控波动 / 单样本抽测的证据强度撑不起更激进的口径）。
 *
 * suspect = 有实测失败导致的丢失 ∧ 通过总数变少。
 * @param {string[]} prevPassed 上一版通过的平台
 * @param {string[]} newPassed  新版通过的平台
 * @param {string[]} newFailed  新版实测失败的平台（status === 'failed'）
 * @returns {{suspect:boolean, lost:string[], gained:string[]}}
 */
function regressionJudge(prevPassed, newPassed, newFailed) {
  const prev = Array.isArray(prevPassed) ? prevPassed : []
  const next = Array.isArray(newPassed) ? newPassed : []
  const failedSet = new Set(Array.isArray(newFailed) ? newFailed : [])
  const nextSet = new Set(next)
  const prevSet = new Set(prev)
  const lost = prev.filter(s => failedSet.has(s))
  const gained = next.filter(s => !prevSet.has(s))
  return { suspect: lost.length > 0 && next.length < prev.length, lost, gained }
}

module.exports = {
  TEST_SONGS, PLATFORMS, PLATFORM_LABEL,
  sha256Str, extractMeta, classifyEntry, scoreEntry, isHostAdapterScript, obfuscationRisk, obfuscationTip, verifyUrl,
  checkBasic, deepCheck, usableCount, stoppable, testPlatform, sameReasonHint, patrolJudge, probeTopTier, planTierProbe,
  aggregateMetrics, declaredQualities,
  isTransient, isLocalNetworkIssue, deepFailKind, applyProbeRecord, extractApiHosts, probeApiHosts, apiDownVerdict,
  passedPlatforms, regressionJudge
}
