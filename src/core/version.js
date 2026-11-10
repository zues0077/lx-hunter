'use strict'
/**
 * 统一版本号算法（2026-11-10，P-1396 科学性复核 / 用户 21:01 拍板「统一版本算法」）
 *
 * 历史问题：hunter.js 与 crawler.js 各有一份 `v = v * 1000 + part`（最多 4 段），
 * sourceUpdate.js 上一轮已单独改成零填充键 —— 三套口径并存，实测：
 *   - 1.0.0.1000 == 1.0.1.0（段值 >= 1000 与相邻段碰撞）
 *   - 1.2.3.4.5  == 1.2.3.4（第 5 段被丢弃）
 *   - v1.9.9 (1009000) > v2.0 (2000000)? 否 → 只收最新版把 v2.0 丢了，留了 v1.9.9
 *
 * 现在统一为「逐段零填充字符串键」：
 *   - 每段固定 8 位，最少补齐 4 段；字典序即版本序，任意段数都不丢信息
 *   - 无版本号返回 ''（falsy），调用点 `if (!v)` / `||` 兜底语义保持不变
 *   - 需要比大小时一律用 cmpVersion()，不要对返回值做减法（字符串相减得 NaN）
 */
const MIN_SEGMENTS = 4
const SEG_WIDTH = 8
const ZERO_SEG = '0'.repeat(SEG_WIDTH)

/** 版本字符串 → 可字典序比较的规范化键；解析不出返回 '' */
function versionKey(s) {
  const m = String(s == null ? '' : s).match(/[vV]?(\d+(?:\.\d+)+)/)
  if (!m) return ''
  const parts = m[1].split('.').map(p => {
    const n = parseInt(p, 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  })
  while (parts.length < MIN_SEGMENTS) parts.push(0)
  return parts.map(n => String(n).padStart(SEG_WIDTH, '0')).join('.')
}

/** 比较任意两个版本串：a>b 返回 1，a<b 返回 -1，相等/都无版本返回 0。
 *  无版本一律视为「比任何有版本的都旧」，且两个都无版本视为平手（不猜）。 */
function cmpVersion(a, b) {
  const ka = versionKey(a), kb = versionKey(b)
  if (!ka || !kb) return !ka && !kb ? 0 : (ka ? 1 : -1)
  const pa = ka.split('.'), pb = kb.split('.')
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const x = pa[i] || ZERO_SEG, y = pb[i] || ZERO_SEG
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

module.exports = { versionKey, cmpVersion, MIN_SEGMENTS, SEG_WIDTH }
