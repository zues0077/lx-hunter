'use strict'
/** GitHub 音源仓库爬取，两条发现通道：
 *  ① 仓库文件树（git/trees）→ .js 候选 + 压缩包候选（zip 分发是音源仓库常见形态）
 *  ② GitHub Releases 资产 —— 很多仓库只把音源发在 release 里（lx-ikun-music-sources 的
 *     HYWmusic_.V1.2.0.js 就在 release V261008 资产里），不读 release 就永远抓不到。
 *  压缩包（树内 / release 资产）统一「下载 → 本地解压 → 挑像音源的脚本」，内容就地保存，
 *  检测环节直接复用，不重复下载解压。
 *
 *  增量模式（定时爬取用）：传 known {archiveSha, assetKeys}——
 *   - 树内文件带 blob sha：内容没变的条目不重新下载（sha 由 tree API 免费给出）
 *   - 压缩包 sha 没变 → 不重新下载解压；变了 → 重下重解，内层脚本按内容哈希就地更新
 *   - release 资产按 tag+文件名判重（资产上传后不可变；新 release/新资产才是更新）
 *
 *  下载统一走 crawlFetch（直连 → 前缀镜像链）：raw.githubusercontent.com 直连不通的
 *  网络环境下（用户实测），裸 fetch 会把所有压缩包音源漏掉，镜像链是刚需。 */
const { fetchWithTimeout, crawlFetch, readText, sleep } = require('./net')
const { unzip, isArchivePath } = require('./zip')
const { scoreEntry, sha256Str } = require('./checker')

const GH_HEADERS_BASE = { 'User-Agent': 'lx-hunter-pc/1.0', 'Accept': 'application/vnd.github+json' }

const DEFAULT_REPOS = [
  'guoyue2010/lxmusic-',
  'ZxwyWebSite/lx-script',
  'ZxwyWebSite/lx-source',
  'laosunmaker/New_lxmusic_source',
  'cc2415/lx-custom-music-source',
  'ycquah00/lx-music-source-v5',
  'javon4016/xgzy-mysources',
  'pronii/lx-music-qdy-mini',
  'yanghook730-sketch/lx-music-source-yuanli',
  'fengyvle/yyt-music-sources',
  'peakshuoera/lx-music-source-manager',
  'wwnbalone/lx-manager',
  'NeoDtime/lxmusic-source3',
  'sphenoid-111/LXmusicyy',
  'lczj1215/lx-music',
  'a97083435/lxmusic-source',
  'LXJ-George666/LXMusic-Yinyuan',
  'LuoXiaohei-2025/LX-music-collection',
  'Macrohard0001/lx-ikun-music-sources',
  'lxmusics/lx-music-api-server-python',
  'hejuworld-droid/lx-music-source',
  'haonanren118/jiexiang-Music-Source',
  'hllsg/lx-music-myvip',
  'ZhonX07/lx-music-source-netease',
  'Scotlight/lx-music-source-gateway',
  'HJinTao/Listening',
  'mlik-git/lx-music',
  '7878gyc/gdstudio-lx-source',
  'piko017/-LX-luoxue_yinyuan',
  'wzh15802/lxmusic',
  // v1.7.0 新增：用户点名、经核实确有音源的两个仓库
  'oozzbb/LxMusicApi',                 // release 资产 LxMusicApi_1.0.0.0.zip（内含 App_Data/lx-music-source.js）
  'skxingyu/lx_music-',                // 仓库树内 4 个 zip（0912-update.zip 等），无散装 .js
  // v1.7.5 新增：把 PC 端长期使用的 6 个「附加仓库」收敛进内置（合计 38 个），
  // 便携新装 / Docker 新装开箱即得同一份清单，无需再手动补录。
  'pdone/lx-music-source',
  'Huibq/keep-alive',
  'xzh767/lxmusic-source-all',
  'liuyunss/LX-source',
  'jeffernn/music-source',
  'Qian-Ning/LX-Music-Source'
]

// releases 通道参数
const RELEASES_PER_REPO = 5                 // 每仓库只看最新 5 个 release（更老的一般是旧版本，交给去重）
const MAX_ASSET_BYTES = 30 * 1024 * 1024    // 单资产大小上限（LxMusicApi 的包 30MB，放行但设顶）
const MAX_RELEASE_DL_PER_REPO = 48 * 1024 * 1024  // 单仓库 release 资产总下载预算，超了跳过剩下的
const MAX_ARCHIVE_BYTES = 60 * 1024 * 1024  // 树内压缩包大小上限

function ghHeaders(token) {
  const h = Object.assign({}, GH_HEADERS_BASE)
  if (token) h['Authorization'] = 'Bearer ' + token
  return h
}

/**
 * 规范化仓库输入为 owner/repo：
 *   https://github.com/a/b            -> a/b
 *   https://github.com/a/b/tree/main  -> a/b
 *   https://github.com/a/b.git        -> a/b
 *   git@github.com:a/b.git            -> a/b
 *   a/b                               -> a/b
 * 无法识别返回 null
 */
function normalizeRepo(input) {
  let s = String(input || '').trim()
  if (!s) return null
  s = s.replace(/\.git$/i, '').replace(/\/+$/, '')
  let m = s.match(/github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i)
  if (m) return m[1] + '/' + m[2]
  m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  if (m && !/^https?:$/i.test(m[1])) return m[1] + '/' + m[2]
  return null
}

/** 树里的 .js 候选（带 blob sha —— 增量判重靠它，零额外请求） */
function extractCandidates(tree, maxPerRepo) {
  const out = []
  const items = (tree && tree.tree) || []
  for (const item of items) {
    if (item.type !== 'blob' || !/\.js$/i.test(item.path || '')) continue
    if (/(^|\/)(node_modules|test|tests|__tests__|dist\/assets)\//.test(item.path)) continue
    if (/(webpack|vite|rollup|babel|jest|eslint|tsconfig)[^/]*\.js$/i.test(item.path)) continue
    out.push({ path: item.path, sha: item.sha || '' })
    if (out.length >= (maxPerRepo || 400)) break
  }
  return out
}

/** 从仓库树里挑压缩包候选（音源仓库常用 zip 分发脚本，不处理就漏抓） */
function extractArchiveCandidates(tree, maxPerRepo) {
  const out = []
  const items = (tree && tree.tree) || []
  for (const item of items) {
    if (item.type !== 'blob' || !isArchivePath(item.path || '')) continue
    if (/(^|\/)(node_modules|test|tests|__tests__)\//.test(item.path)) continue
    out.push({ path: item.path, sha: item.sha || '' })
    if (out.length >= (maxPerRepo || 10)) break
  }
  return out
}

/** 压缩包内挑出「像洛雪音源」的 .js，返回候选条目（code 已就位，检测时无需再下载） */
function pickScriptsFromZip(entries, archivePath, repo, rawUrl, maxPerArchive) {
  const out = []
  for (const f of entries) {
    if (!/\.js$/i.test(f.path) || f.data.length > 2 * 1024 * 1024) continue
    if (/(^|\/)(node_modules|test|tests|__tests__)\//.test(f.path)) continue
    const text = f.data.toString('utf8')
    const score = scoreEntry(f.path, text)
    if (score < 4) continue   // 压缩包里常混文档/示例/构建产物，宁缺毋滥
    const id = repo + '::' + archivePath + '!' + f.path
    out.push({
      id,
      repo,
      path: archivePath + '!' + f.path,
      url: rawUrl,
      archive: archivePath,
      innerPath: f.path,
      name: f.path.split('/').pop().replace(/\.js$/i, ''),
      // 内容就地保存：raw 链接指向整个压缩包，检测环节直接用，不再重复下载解压
      code: text,
      contentHash: sha256Str(text),
      suspectScore: score,
      status: 'unknown',
      suspected: score >= 4,
      usable: false,
      size: text.length,
      addedAt: Date.now(),
      lastCheck: 0,
      deep: null
    })
    if (out.length >= (maxPerArchive || 50)) break
  }
  return out
}

/**
 * 仓库新鲜度探测（v1.7.2 时间过滤）：commits?since= 只花 1 次配额就能判断
 * 仓库在时间窗内有没有动静——静默仓库直接整仓跳过（省掉 tree+releases 的 2 次配额）。
 * 返回 { fresh, lastCommitAt, empty }：empty=API 异常（保守起见按 fresh 处理，不漏爬）。
 */
async function fetchRepoFreshness(repo, sinceIso, token, timeoutMs) {
  try {
    const url = `https://api.github.com/repos/${repo}/commits?per_page=1&since=${encodeURIComponent(sinceIso)}`
    const res = await fetchWithTimeout(url, { headers: ghHeaders(token) }, timeoutMs)
    if (!res.ok) return { fresh: true, empty: true }   // 异常不拦路
    const j = JSON.parse(await readText(res, timeoutMs))
    if (!Array.isArray(j)) return { fresh: true, empty: true }
    const last = j[0] && j[0].commit && j[0].commit.committer ? j[0].commit.committer.date : null
    return { fresh: j.length > 0, lastCommitAt: last ? Date.parse(last) || 0 : 0 }
  } catch (e) {
    return { fresh: true, empty: true }   // 网络抖动不拦路
  }
}

/**
 * 从 releases API 响应里挑可爬取的资产（v1.7.0）：
 *  - .js 资产直接作为候选（release 作者发布的就是音源，与树内 .js 同样不加硬门槛）
 *  - .zip 资产走解压挑选
 *  - 跳过 skipKeys 里已有的（tag/文件名 判重；GitHub 资产上传后不可变，
 *    新 release/新资产名才是「更新」，同 key 重复爬无意义）
 *  - 超过大小上限的跳过（LxMusicApi 的 30MB 包放行，但给单仓库总下载设预算）
 *  - sinceTs（v1.7.2）：发布时间早于它的 release 资产跳过（只爬近期发布的）
 */
function parseReleaseAssets(releases, opts) {
  const o = opts || {}
  const maxReleases = o.maxReleases || RELEASES_PER_REPO
  const maxBytes = o.maxAssetBytes || MAX_ASSET_BYTES
  const skip = o.skipKeys instanceof Set ? o.skipKeys : new Set(o.skipKeys || [])
  const sinceTs = o.sinceTs > 0 ? o.sinceTs : 0
  const out = []
  const list = Array.isArray(releases) ? releases : []
  for (let i = 0; i < list.length && i < maxReleases; i++) {
    const rel = list[i] || {}
    const tag = String(rel.tag_name || rel.name || ('r' + i))
    // release 级时间过滤：发布时间早于窗口的整条 release 跳过（published_at 零额外配额）
    const publishedAt = rel.published_at ? Date.parse(rel.published_at) || 0 : 0
    if (sinceTs && publishedAt && publishedAt < sinceTs) continue
    for (const a of (rel.assets || [])) {
      const name = String(a.name || '')
      if (!/\.js$/i.test(name) && !/\.zip$/i.test(name)) continue
      if (a.size && a.size > maxBytes) continue
      const key = tag + '/' + name
      if (skip.has(key)) continue
      out.push({
        tag, key, name,
        size: a.size || 0,
        url: a.browser_download_url || '',
        kind: /\.zip$/i.test(name) ? 'zip' : 'js',
        publishedAt
      })
    }
  }
  return out
}

async function fetchReleases(repo, token, timeoutMs) {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=${RELEASES_PER_REPO}`
  const res = await fetchWithTimeout(url, { headers: ghHeaders(token) }, timeoutMs)
  const text = await readText(res, timeoutMs)
  const j = JSON.parse(text)
  if (j.message) throw new Error('GitHub API: ' + String(j.message).slice(0, 80))
  return Array.isArray(j) ? j : []
}

/** 查配额（/rate_limit 本身不消耗配额） */
async function checkQuota(need, token) {
  try {
    const res = await fetchWithTimeout('https://api.github.com/rate_limit', { headers: ghHeaders(token) }, 8000)
    const j = JSON.parse(await readText(res, 5000))
    const core = (j.resources && j.resources.core) || {}
    if (typeof core.remaining !== 'number') return { ok: true }
    if (core.remaining < need) {
      const mins = core.reset ? Math.max(1, Math.ceil((core.reset * 1000 - Date.now()) / 60000)) : 60
      return {
        ok: false,
        remaining: core.remaining,
        limit: core.limit,
        resetMin: mins,
        msg: `GitHub API 配额不足（剩余 ${core.remaining}，本次需 ${need}），约 ${mins} 分钟后重置。` +
          (token ? '请检查 Token 是否有效。' : '建议填入 GitHub Token（限额提升到 5000 次/小时）或稍后重试。')
      }
    }
    return { ok: true, remaining: core.remaining, limit: core.limit }
  } catch (e) {
    return { ok: true }
  }
}

/**
 * GitHub 关键词搜索自动发现（v1.9.9，借鉴 lxhub 的 search_stars 模式）：
 *  用一组中文关键词在 GitHub 搜索仓库（按 stars 降序），自动发掘「写死种子列表之外」的新音源仓库，
 *  作为 DEFAULT_REPOS 的**增量补充**（绝不替换种子，也不重复爬已知仓库）。
 *  - 跳过已知仓库（seed / custom / 库内已有 → 传入 known 集合）
 *  - 每关键词取前 maxReposPerKeyword，全局上限 maxTotal
 *  - 可选最小 stars 门槛（skipStarsBelow），过滤掉 star 极少的噪声仓库
 *  - 复用 GitHub Token 提升搜索配额（未配则匿名 10 次/分钟，足够关键词发现）
 * @param {object} opts {keywords, token, maxReposPerKeyword, maxTotal, timeoutMs, known, skipStarsBelow}
 * @returns {Promise<{repos:string[], perKeyword:object, searched:number, total:number}>}
 */
/**
 * 搜索命中的相关性闸门（v1.9.13）。
 *
 * 为什么必须有：GitHub 搜索对中文关键词非常宽松，早先的 `in:name,description,readme`
 * 会把 readme 里偶然出现「音源」二字的仓库全捞进来。实测一轮 16 个新增里全是
 * ebooks / china-dictatorship / gpt4o-image-prompts / awesome-security 这类无关仓库——
 * 既浪费 GitHub 配额，又把这些仓库塞进用户的仓库清单。
 *
 * 判据只看「仓库自己的身份信息」（全名/名字/描述/topics），不看 readme；
 * 必须出现 lx 音源语义（lxmusic / 洛雪 / 音源 / music-source / lx-source …）。
 */
const SOURCE_REPO_RE = /(lx[-_\s.]?music|lxmusic|洛雪|音源|music[-_\s.]?sources?|song[-_\s.]?sources?|lx[-_\s.]?source|lx[-_\s.]?script|音源脚本|音源仓库)/i

function looksLikeSourceRepo(it) {
  if (!it) return false
  const hay = [it.full_name, it.name, it.description, (it.topics || []).join(' ')]
    .filter(Boolean).join(' ')
  return SOURCE_REPO_RE.test(hay)
}

/**
 * 内容验真（v1.9.14）：名字像音源仓库，不代表里面真有音源脚本。
 *
 * 实测 60 个「名字/描述含 lx 音源」的仓库里只有 32 个真含脚本，其余是客户端/播放器/API
 * （Mineradio、lx-music-downloader、lxmusic-android、lxmusic2api…）甚至毫不相干的
 * lxde/lxmusic（Linux 桌面环境的播放器）。只靠关键词会把它们塞进仓库清单、白耗爬取配额。
 *
 * 判据复用项目自己的 scoreEntry（>=4 即「像音源脚本」），并对「压缩包分发」的仓库网开一面：
 * 不少仓库把音源打包成 zip 发（chinaes666/lx-music-source 就是），树里没有 .js 但是真音源。
 */
async function verifyRepoHasSource(repo, o) {
  const token = (o && o.token) || ''
  const tmo = Number(o && o.timeoutMs) || 15000
  const get = async (url, raw) => {
    const res = await fetchWithTimeout(url, { headers: raw
      ? Object.assign({}, ghHeaders(token), { Accept: 'application/vnd.github.raw' })
      : ghHeaders(token) }, tmo)
    return res
  }
  const info = await get(`https://api.github.com/repos/${repo}`)
  if (!info.ok) return { ok: false, reason: 'repo HTTP ' + info.status }
  let meta = {}
  try { meta = JSON.parse(await readText(info, tmo)) } catch (e) {}
  const branch = meta.default_branch || 'main'
  const tr = await get(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`)
  if (!tr.ok) return { ok: false, reason: 'tree HTTP ' + tr.status }
  let tj = {}
  try { tj = JSON.parse(await readText(tr, tmo)) } catch (e) {}
  const items = Array.isArray(tj.tree) ? tj.tree : []
  const js = items.filter(t => t.type === 'blob' && /\.js$/i.test(t.path) &&
    (t.size || 0) < 2 * 1024 * 1024 && !/node_modules|\.min\.js/i.test(t.path))
  const packs = items.filter(t => t.type === 'blob' && /\.(zip|7z|rar)$/i.test(t.path))
  // 测试夹具 / 示例 / 模板里的「音源」不是可分发音源。实测有仓库整个就是「音源管理工具」，
  // 唯一命中来自 tests/fixtures/basic-source.js——把它当音源收进来，爬取阶段也只能捞到个假脚本。
  const isWeakPath = (p) => /(^|\/)(tests?|__tests__|specs?|fixtures?|examples?|demos?|samples?|docs?|templates?)\//i.test(p) ||
    /(template|example|sample|demo|fixture|mock)[^/]*\.js$/i.test(p)
  js.sort((a, b) => {
    const wa = isWeakPath(a.path) ? 1 : 0
    const wb = isWeakPath(b.path) ? 1 : 0
    if (wa !== wb) return wa - wb
    const sa = /音源|源|source|lx/i.test(a.path) ? 0 : 1
    const sb = /音源|源|source|lx/i.test(b.path) ? 0 : 1
    return sa - sb || (a.size || 0) - (b.size || 0)
  })
  let best = 0
  let weakHit = null
  for (const f of js.slice(0, 3)) {
    const enc = f.path.split('/').map(encodeURIComponent).join('/')
    try {
      const c = await get(`https://api.github.com/repos/${repo}/contents/${enc}?ref=${encodeURIComponent(branch)}`, true)
      if (!c.ok) continue
      const text = await readText(c, tmo)
      const sc = scoreEntry(f.path, text)
      if (sc > best) best = sc
      if (sc >= 4) {
        // 正常路径直接放行；测试/示例路径先记着，等压缩包与发行资产都排除后再算账
        if (isWeakPath(f.path)) { weakHit = weakHit || { score: sc, file: f.path }; continue }
        return { ok: true, reason: '含音源脚本', score: sc, file: f.path }
      }
    } catch (e) { /* 单个文件失败不影响整仓判定 */ }
  }
  // ★ 压缩包分发：很多仓库把音源打包成 zip 发（skxingyu/lx_music- 树里 4 个 zip、无散装 .js），
  //   树里只有零散构建脚本甚至没有 .js。这种情况不能因为「抽检的 .js 不是音源」就判死，
  //   只要树里有压缩包就放行，交给爬取阶段的解压挑脚本。
  if (packs.length) return { ok: true, reason: '压缩包分发', score: best, packs: packs.length }
  // ★ 只发 Release 资产的仓库：树里可能空空如也，再看一眼 release 资产名
  try {
    const rl = await get(`https://api.github.com/repos/${repo}/releases?per_page=5`)
    if (rl.ok) {
      const list = JSON.parse(await readText(rl, tmo))
      const hit = (Array.isArray(list) ? list : []).some(rel =>
        (rel.assets || []).some(a => /\.(js|zip|7z|rar)$/i.test(a.name || '')))
      if (hit) return { ok: true, reason: 'Release 资产分发', score: best }
    }
  } catch (e) {}
  if (weakHit) return { ok: false, reason: '仅测试/示例脚本', score: weakHit.score, file: weakHit.file }
  return { ok: false, reason: js.length ? '无音源脚本（也无压缩包/发行资产）' : '无 .js 也无压缩包', score: best }
}

/** 小并发跑一批异步任务（内容验真用；不想给 GitHub 打突发请求） */
async function runPool(items, n, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const k = i++
      if (k >= items.length) return
      try { out[k] = await fn(items[k], k) } catch (e) { out[k] = { ok: false, reason: String((e && e.message) || e) } }
    }
  }))
  return out
}

async function discoverReposViaSearch(opts) {
  const o = opts || {}
  const keywords = Array.isArray(o.keywords) && o.keywords.length ? o.keywords : []
  if (!keywords.length) return { repos: [], perKeyword: {}, searched: 0, total: 0 }
  const token = o.token || ''
  const perKw = Math.max(1, Number(o.maxReposPerKeyword) || 20)
  const maxTotal = Math.max(1, Number(o.maxTotal) || 60)
  const timeoutMs = Number(o.timeoutMs) || 15000
  const known = o.known instanceof Set ? o.known : new Set(Array.isArray(o.known) ? o.known : [])
  const skipStarsBelow = Number(o.skipStarsBelow) || 0
  const out = []
  const seen = new Set(known)
  const perKeyword = {}
  for (const kw of keywords) {
    if (out.length >= maxTotal) break
    try {
      // 只搜名字与描述：带上 in:readme 会命中一堆「正文里提过音源」的无关仓库
      const q = encodeURIComponent(kw + ' in:name,description')
      const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${perKw}`
      const res = await fetchWithTimeout(url, { headers: ghHeaders(token) }, timeoutMs)
      const text = await readText(res, timeoutMs)
      const j = JSON.parse(text)
      if (j.message) { perKeyword[kw] = { error: String(j.message).slice(0, 80), found: 0 }; continue }
      const items = Array.isArray(j.items) ? j.items : []
      let added = 0
      let filtered = 0
      for (const it of items) {
        if (out.length >= maxTotal) break
        const full = it && it.full_name
        if (!full) continue
        const n = normalizeRepo(full)
        if (!n || seen.has(n)) continue
        if (skipStarsBelow && Number(it.stargazers_count || 0) < skipStarsBelow) continue
        // 相关性闸门：名字/描述/topics 里没有 lx 音源语义的一律不要
        if (o.skipRelevance !== true && !looksLikeSourceRepo(it)) { filtered++; continue }
        seen.add(n)
        out.push(n)
        added++
      }
      perKeyword[kw] = { found: items.length, added, filtered }
    } catch (e) {
      perKeyword[kw] = { error: String((e && e.message) || e).slice(0, 80), found: 0 }
    }
    await sleep(300)
  }
  // 内容验真（可选）：逐个仓库看有没有真音源脚本 / 压缩包 / 发行资产。
  // 只有显式 verify===true 才做——搜索本身是"发现"，实际爬取前才值得花这些 API 配额。
  let droppedNoSource = 0
  const details = []
  if (o.verify === true && out.length) {
    const vr = await runPool(out, Math.max(1, Number(o.verifyConcurrency) || 4), (r) => verifyRepoHasSource(r, o))
    const kept = []
    for (let i = 0; i < out.length; i++) {
      const v = vr[i] || { ok: false, reason: '验真失败' }
      details.push({ repo: out[i], ok: !!v.ok, reason: v.reason, score: v.score })
      if (v.ok) kept.push(out[i])
      else droppedNoSource++
    }
    return {
      repos: kept, perKeyword, searched: keywords.length, total: kept.length,
      discovered: out.length, droppedNoSource, details
    }
  }
  return { repos: out, perKeyword, searched: keywords.length, total: out.length, droppedNoSource: 0 }
}

/**
 * @param {object} opts {repos, token, maxCandidatesPerRepo, timeoutMs, mirror, known}
 *   known: {archiveSha: {'owner/repo::路径': sha}, assetKeys: Set('tag/资产名')} —— 增量判重
 * @param {function} onEvent (type, payload)
 * @param {function} shouldStop () => bool
 * @returns {Promise<{added, reposDone, repoTotal, linksFound}>}
 */
async function crawl(opts, onEvent, shouldStop) {
  const repos = opts.repos || []
  const timeoutMs = opts.timeoutMs || 15000
  const known = opts.known || { archiveSha: {}, assetKeys: new Set() }
  // 时间窗（v1.7.2）：sinceDays 天内有更新才爬（0=不限）。开销：每仓库 1 次配额探测，
  // 换来静默仓库整仓跳过（tree+releases 两次配额 + 全部下载），冷仓库多的库净省配额。
  const sinceDays = Number(opts.sinceDays) > 0 ? Number(opts.sinceDays) : 0
  const sinceTs = sinceDays ? Date.now() - sinceDays * 86400 * 1000 : 0
  const stats = { added: 0, reposDone: 0, repoTotal: repos.length, linksFound: 0, staleSkipped: 0 }
  // 下载镜像学习：本次运行里第一个成功的镜像优先复用，避免每条资产都把失败的直连重试一遍
  let mirrorPref = null

  // 每个仓库：时间窗开启时多 1 次新鲜度探测，加 tree + releases 两次核心调用
  const q = await checkQuota(repos.length * (sinceDays ? 3 : 2) + 2, opts.token)
  if (!q.ok) { onEvent('log', { level: 'error', module: '爬取', msg: q.msg }); return stats }
  if (q.remaining != null) {
    onEvent('log', { level: 'info', module: '爬取', msg: `GitHub API 配额：剩余 ${q.remaining}/${q.limit}` + (opts.token ? '（Token）' : '（未配 Token，每小时仅 60 次；爬取会同时读取文件树与 Releases）') + (sinceDays ? `；时间窗：只爬 ${sinceDays} 天内有更新的仓库` : '') })
  }

  for (let i = 0; i < repos.length; i++) {
    if (shouldStop && shouldStop()) break
    const repo = repos[i]
    stats.reposDone = i + 1
    onEvent('progress', { reposDone: i + 1, repoTotal: repos.length, step: `爬取仓库 ${i + 1}/${repos.length} ${repo}` })
    try {
      // ⓪ 仓库新鲜度探测（时间窗开启时）：静默仓库整仓跳过
      if (sinceTs) {
        const fresh = await fetchRepoFreshness(repo, new Date(sinceTs).toISOString(), opts.token, timeoutMs)
        if (!fresh.fresh) {
          stats.staleSkipped++
          onEvent('log', { level: 'info', module: '爬取', msg: `${repo}：${sinceDays} 天内无提交，整仓跳过` })
          continue
        }
      }
      // ① 仓库文件树
      const res = await fetchWithTimeout(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`, { headers: ghHeaders(opts.token) }, timeoutMs)
      const text = await readText(res, timeoutMs)
      const tree = JSON.parse(text)
      if (tree.message) throw new Error('GitHub API: ' + String(tree.message).slice(0, 80))
      if (tree.truncated) onEvent('log', { level: 'warn', module: '爬取', msg: `${repo} 文件树被截断，可能漏掉部分文件` })
      const cands = extractCandidates(tree, opts.maxCandidatesPerRepo)
      const newOnes = []
      for (const c of cands) {
        const p = c.path
        const id = repo + '::' + p
        const fname = p.split('/').pop()
        newOnes.push({
          id,
          repo,
          path: p,
          url: 'https://raw.githubusercontent.com/' + repo + '/HEAD/' + p.split('/').map(encodeURIComponent).join('/'),
          name: fname.replace(/\.js$/i, ''),
          blobSha: c.sha || '',     // 增量判重：sha 没变 = 内容没变，不重新下载
          status: 'unknown',
          suspected: null,
          usable: false,
          size: 0,
          addedAt: Date.now(),
          lastCheck: 0,
          deep: null
        })
      }
      // 压缩包分发（树内）：下载 → 本地解压 → 挑像音源的脚本入库
      // sha 没变的压缩包直接跳过（增量模式不重复下载解压）
      const archives = extractArchiveCandidates(tree, 10)
      let archiveHit = 0, archiveSkipped = 0
      for (const ar of archives) {
        if (shouldStop && shouldStop()) break
        const ap = ar.path
        if (known.archiveSha && known.archiveSha[repo + '::' + ap] && known.archiveSha[repo + '::' + ap] === ar.sha) {
          archiveSkipped++
          continue
        }
        try {
          const rawUrl = 'https://raw.githubusercontent.com/' + repo + '/HEAD/' + ap.split('/').map(encodeURIComponent).join('/')
          // 镜像链下载：raw.githubusercontent.com 直连不通的环境（用户实测）必须能走镜像
          const dl = await crawlFetch(rawUrl, null, timeoutMs, opts.mirror, mirrorPref)
          if (dl.mirror) mirrorPref = dl.mirror
          const res2 = dl.res
          if (!res2 || !res2.ok) throw new Error('HTTP ' + (res2 ? res2.status : '不可达'))
          const buf = Buffer.from(await res2.arrayBuffer())
          if (buf.length > MAX_ARCHIVE_BYTES) throw new Error('压缩包过大（' + Math.round(buf.length / 1048576) + 'MB）')
          if (/\.zip$/i.test(ap)) {
            const files = unzip(buf)
            const picked = pickScriptsFromZip(files, ap, repo, rawUrl, 50)
            if (picked.length) {
              archiveHit += picked.length
              for (const it of picked) { it.archiveSha = ar.sha || ''; newOnes.push(it) }
              onEvent('log', { level: 'info', module: '爬取', msg: `${repo}：压缩包 ${ap.split('/').pop()} 解出 ${picked.length} 个音源脚本` })
            }
          } else {
            onEvent('log', { level: 'info', module: '爬取', msg: `${repo}：压缩包 ${ap.split('/').pop()} 为 ${ap.split('.').pop()} 格式，暂只支持自动解压 zip` })
          }
        } catch (err) {
          onEvent('log', { level: 'warn', module: '爬取', msg: `${repo}：压缩包 ${ap.split('/').pop()} 处理失败: ${String((err && err.message) || err).slice(0, 80)}` })
        }
      }
      // ② Releases 资产（很多仓库只把音源发在 release 里，不读就漏抓 —— v1.7.0）
      let relHit = 0, relSkipped = 0, relBytes = 0
      try {
        const releases = await fetchReleases(repo, opts.token, timeoutMs)
        const assets = parseReleaseAssets(releases, { skipKeys: known.assetKeys, sinceTs })
        relSkipped = (releases || []).reduce((n, r) => n + ((r.assets || []).filter(a => known.assetKeys.has(String(r.tag_name || '') + '/' + String(a.name || ''))).length), 0)
        for (const a of assets) {
          if (shouldStop && shouldStop()) break
          if (a.size > MAX_ASSET_BYTES) { onEvent('log', { level: 'warn', module: '爬取', msg: `${repo}：release 资产 ${a.name} 超过 ${Math.round(MAX_ASSET_BYTES / 1048576)}MB 上限，跳过` }); continue }
          if (relBytes + a.size > MAX_RELEASE_DL_PER_REPO) { onEvent('log', { level: 'warn', module: '爬取', msg: `${repo}：release 资产下载已达单仓库预算（${Math.round(MAX_RELEASE_DL_PER_REPO / 1048576)}MB），跳过剩余资产` }); break }
          try {
            const dl = await crawlFetch(a.url, null, timeoutMs, opts.mirror, mirrorPref)
            if (dl.mirror) mirrorPref = dl.mirror
            const res2 = dl.res
            if (!res2 || !res2.ok) throw new Error('HTTP ' + (res2 ? res2.status : '不可达'))
            relBytes += a.size || 0
            if (a.kind === 'js') {
              const code = await readText(res2, timeoutMs)
              relHit++
              newOnes.push({
                id: repo + '::release:' + a.tag + ':' + a.name,
                repo,
                path: 'release:' + a.tag + ':' + a.name,
                url: a.url,
                assetKey: a.key,
                name: a.name.replace(/\.js$/i, ''),
                code,
                contentHash: sha256Str(code),
                status: 'unknown',
                suspected: scoreEntry(a.name, code) >= 4,
                usable: false,
                size: code.length,
                addedAt: Date.now(),
                lastCheck: 0,
                deep: null
              })
              onEvent('log', { level: 'info', module: '爬取', msg: `${repo}：release ${a.tag} 资产 ${a.name} 已收入` })
            } else {
              const buf = Buffer.from(await res2.arrayBuffer())
              if (buf.length > MAX_ASSET_BYTES) throw new Error('压缩包过大（' + Math.round(buf.length / 1048576) + 'MB）')
              const files = unzip(buf)
              const picked = pickScriptsFromZip(files, 'release:' + a.tag + ':' + a.name, repo, a.url, 50)
              if (picked.length) {
                relHit += picked.length
                for (const it of picked) { it.assetKey = a.key; newOnes.push(it) }
                onEvent('log', { level: 'info', module: '爬取', msg: `${repo}：release ${a.tag} 压缩包 ${a.name} 解出 ${picked.length} 个音源脚本` })
              }
            }
          } catch (err) {
            onEvent('log', { level: 'warn', module: '爬取', msg: `${repo}：release 资产 ${a.name} 处理失败: ${String((err && err.message) || err).slice(0, 80)}` })
          }
        }
      } catch (e) {
        const msg = String((e && e.message) || e)
        if (/rate limit exceeded/i.test(msg)) throw e   // 配额耗尽：向上抛，由外层统一中止
        onEvent('log', { level: 'warn', module: '爬取', msg: `${repo}：读取 Releases 失败: ${msg.slice(0, 100)}` })
      }
      stats.linksFound += cands.length + archiveHit + relHit
      onEvent('repo', { repo, candidates: cands.length + archiveHit + relHit, items: newOnes })
      onEvent('log', { level: 'info', module: '爬取', msg: `${repo}：候选 ${cands.length} 个` +
        (archiveHit ? `，压缩包内脚本 ${archiveHit} 个` : '') +
        (archiveSkipped ? `（${archiveSkipped} 个压缩包内容未变，跳过）` : '') +
        (relHit ? `，release 资产脚本 ${relHit} 个` : '') +
        (relSkipped ? `（${relSkipped} 个 release 资产已抓过，跳过）` : '') +
        (sinceTs ? `（时间窗：只收 ${sinceDays} 天内发布的 release 资产）` : '') })
    } catch (e) {
      const msg = String((e && e.message) || e)
      if (/rate limit exceeded/i.test(msg)) {
        onEvent('log', { level: 'error', module: '爬取', msg: `GitHub API 配额已耗尽，中止本次爬取（已处理 ${i + 1}/${repos.length} 个仓库）。` + (opts.token ? '请检查 Token。' : '可填入 Token 提升限额，或约 1 小时后重试。') })
        break
      }
      onEvent('log', { level: 'warn', module: '爬取', msg: `${repo} 爬取失败: ${msg.slice(0, 120)}` })
    }
    await sleep(300)
  }
  return stats
}

module.exports = {
  DEFAULT_REPOS, crawl, checkQuota, fetchReleases, parseReleaseAssets, fetchRepoFreshness,
  discoverReposViaSearch, looksLikeSourceRepo, verifyRepoHasSource,
  extractCandidates, extractArchiveCandidates, pickScriptsFromZip, normalizeRepo,
  RELEASES_PER_REPO, MAX_ASSET_BYTES, MAX_RELEASE_DL_PER_REPO
}
