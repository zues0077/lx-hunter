'use strict'
/**
 * 音源身份键（2026-11-10）：把散落在 hunter.js / sourceUpdate.js 的同名归一化、
 * 同源仓库键、脚本声明名解析集中到一处，保证「灌入裁决」与「源更新配对」口径一致。
 *
 * 用户 21:01 拍板的三条口径依赖这些键：
 *  1) 不同名 → 直接灌入（normName 不等）
 *  2) 同名 + 同仓库 + 版本有别 → 留新删旧（repoKey 相等 + cmpVersion）
 *  3) 同名 + 不同仓库 → 按质量裁决（repoKey 不等，见 quality.js）
 */

/** 与 hunter.js 历史 normName 完全同款：小写 + 去掉标点/空白/连字符 */
function normName(s) {
  return String(s || '').toLowerCase().replace(/[\[\]【】（）()|｜:：、,，.。\s_\-·•]+/g, '')
}

/**
 * 同源键：把 repository / homepage / url 归一到 gh:owner/repo 或 host/owner/repo。
 * 拿不到返回 ''。占位/模板仓库地址不算同源证据（实测 StellarWave 的
 * `https://github.com/your-repo/StellarWave` 曾被当成真同源，差点把 v4.0.0 降级成 v3.1.1.1）。
 */
const PLACEHOLDER_REPO = /^(your[-_]?repo|your[-_]?name|yourname|your[-_]?org|example|placeholder|dummy|xxx+|todo|tbd|none|null|undefined)$/i

function repoKey(meta) {
  const raw = String((meta && (meta.repository || meta.homepage || meta.url || meta.repo)) || '').trim()
  if (!raw) return ''
  let host = '', owner = '', repo = ''

  const rawHost = raw.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)/i)
  if (rawHost) {
    host = 'github.com'; owner = rawHost[1]; repo = rawHost[2]
  } else {
    try {
      const u = new URL(raw.replace(/^github:/, 'https://github.com/'))
      const seg = u.pathname.split('/').filter(Boolean)
      host = u.hostname.toLowerCase().replace(/^www\./, '')
      if (seg.length >= 2) { owner = seg[0]; repo = seg[1] }
      else return host + (seg.length ? '/' + seg.join('/').toLowerCase() : '')
    } catch (e) {
      const m = raw.match(/^([\w.-]+)\/([\w.-]+)/)
      if (!m) return ''
      host = 'github.com'; owner = m[1]; repo = m[2]
    }
  }
  owner = String(owner || '').toLowerCase()
  repo = String(repo || '').toLowerCase().replace(/\.git$/, '')
  if (!owner || !repo) return ''
  // 黑名单只留明确模板词：user / owner / repo / username 都是合法 GitHub 用户名，不能误拒
  if (PLACEHOLDER_REPO.test(owner) || PLACEHOLDER_REPO.test(repo)) return ''
  const gh = /^(github\.com|.*\.github\.com|raw\.githubusercontent\.com)$/i.test(host)
  return (gh ? 'gh:' : host + '/') + owner + '/' + repo
}

/** 名字主体：去掉版本号尾巴再归一化。作者把版本写进 @name 时仍能配上对。 */
function nameBody(s) {
  return normName(String(s || '').replace(/[vV]?\d+(?:\.\d+)+\S*/g, ' '))
}

/** 从脚本正文里读 @name（兼容多个标签写在同一行） */
function scriptName(code) {
  const m = String(code || '').match(/@name\s+([^\r\n]+)/)
  if (!m) return ''
  return m[1].trim().replace(/\s*\*\/.*$/, '').replace(/\s+@[a-zA-Z]+\s+.*$/, '').trim()
}

/** 本地候选条目 → 仓库同源键（字段口径与 sourceUpdate.candidateMeta 一致） */
function candidateRepo(e) {
  e = e || {}
  return repoKey({ repository: e.repository || e.homepage || e.repo || '', url: e.url || '' })
}

/** 服务端条目 → 仓库同源键 */
function serverRepo(s) {
  s = s || {}
  return repoKey({ repository: s.repository || s.homepage || (s.meta && (s.meta.homepage || s.meta.repository)) || '' })
}

/** 能否证明两者同源：两边都得有键且相等。缺证据一律 false（不猜）。 */
function isSameRepo(a, b) {
  const ka = repoKey(a), kb = repoKey(b)
  return !!(ka && kb && ka === kb)
}

module.exports = {
  normName, repoKey, nameBody, scriptName, candidateRepo, serverRepo, isSameRepo, PLACEHOLDER_REPO
}
