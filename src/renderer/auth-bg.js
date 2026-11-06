'use strict'
/*
 * 登录页外观：背景预设 / 本地图片 / 远程图片地址（含随机图 API），偏好存 localStorage。
 *
 * 这个脚本在 <head> 里同步执行：先按已保存的偏好写 <html data-auth-bg>，
 * 让浏览器第一次绘制就是用户选的背景，不会先闪一下默认渐变。
 * 远程地址渲染时附加一次性参数穿透 302/图片缓存，随机图接口才会每次刷新换一张。
 * DOM 交互统一等 DOMContentLoaded 再绑定。
 *
 * 纯函数（sanitizeImageUrl / normalizeBgSetting / applySetting ...）导出给
 * tests/auth-bg-ui.test.js 复用；浏览器里没有 module，导出语句会自动跳过。
 */
;(function (global) {
  const STORE_KEY = 'lxh-auth-bg'
  const PRESETS = ['aurora', 'dawn', 'mint', 'night', 'plain']
  const DEFAULT_PRESET = 'dawn' // 无偏好 / 坏数据时的默认观感（暖阳）
  const MAX_URL = 2048
  const MAX_DATA = 1800000 // localStorage 按 UTF-16 计配额，1.8M 字符约 3.6MB，留足余量

  // 只允许 http(s) 链接与图片 data URL。CSS 用 url("...") 拼接，引号/括号/
  // 反斜杠/空白都可能闭合字符串或注入新声明，一律拒绝（防样式注入）。
  function sanitizeImageUrl(v) {
    if (typeof v !== 'string') return null
    const s = v.trim()
    if (!s || s.length > MAX_DATA) return null
    if (/["'()\\\s\u0000-\u001f\u007f]/.test(s)) return null
    if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(s)) return s
    if (s.length > MAX_URL) return null
    if (!/^https?:\/\/[^\s]+$/i.test(s)) return null
    return s
  }

  // 随机图接口（带 ?type=bg&... 参数、或返回 302 跳转）每次都要拿到新图。
  // 给它加一次性参数就能穿透浏览器/CDN 对 302 与图片响应的缓存；data URL 不需要。
  // 参数必须加在 #fragment 之前，否则只会改 fragment、请求完全一样。
  function cacheBustedUrl(url, nonce) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return url
    if (nonce == null || nonce === '') return url
    const hashAt = url.indexOf('#')
    const base = hashAt >= 0 ? url.slice(0, hashAt) : url
    const hash = hashAt >= 0 ? url.slice(hashAt) : ''
    const sep = base.indexOf('?') >= 0 ? '&' : '?'
    return base + sep + '_lxh=' + encodeURIComponent(String(nonce)) + hash
  }

  function freshNonce() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  }

  // 保存的永远是原始地址，只有渲染时才附加一次性参数，避免 nonce 被反复存进偏好
  function forRender(v, nonce) {
    const n = normalizeBgSetting(v)
    if (n.mode !== 'image') return n
    return { mode: 'image', image: cacheBustedUrl(n.image, nonce) }
  }

  // 任何脏数据（旧版本格式、坏 JSON、被手改过的 localStorage）都退回默认预设
  function normalizeBgSetting(raw) {
    let v = raw
    if (typeof v === 'string') { try { v = JSON.parse(v) } catch (e) { v = null } }
    if (!v || typeof v !== 'object') return { mode: 'preset', preset: DEFAULT_PRESET }
    if (v.mode === 'image') {
      const img = sanitizeImageUrl(v.image)
      return img ? { mode: 'image', image: img } : { mode: 'preset', preset: DEFAULT_PRESET }
    }
    return { mode: 'preset', preset: PRESETS.indexOf(v.preset) >= 0 ? v.preset : DEFAULT_PRESET }
  }

  function readSetting() {
    try {
      const ls = global.localStorage
      return normalizeBgSetting(ls ? ls.getItem(STORE_KEY) : null)
    } catch (e) { return normalizeBgSetting(null) }
  }

  function saveSetting(setting) {
    try {
      if (!global.localStorage) return false
      global.localStorage.setItem(STORE_KEY, JSON.stringify(normalizeBgSetting(setting)))
      return true
    } catch (e) { return false } // 配额超限 / 隐私模式禁用存储
  }

  function clearSetting() {
    try { if (global.localStorage) global.localStorage.removeItem(STORE_KEY) } catch (e) {}
  }

  function applySetting(setting, root, nonce) {
    const v = normalizeBgSetting(setting)
    const el = root || (global.document && global.document.documentElement)
    if (!el || !el.dataset || !el.style) return v
    el.dataset.authBg = v.mode === 'image' ? 'custom' : v.preset
    if (v.mode === 'image') el.style.setProperty('--auth-custom', 'url("' + cacheBustedUrl(v.image, nonce) + '")')
    else el.style.removeProperty('--auth-custom')
    return v
  }

  // 远程地址先探一次：随机图接口可能已下线、被墙、或返回 HTML 而不是图片。
  // 不阻塞应用（CSS 会自己加载），只在确实加载失败时给一句人话提示。
  function probeImage(url, cb) {
    if (typeof global.Image !== 'function') return cb(null)
    const img = new global.Image()
    let done = false
    const finish = flag => { if (!done) { done = true; cb(flag) } }
    const timer = global.setTimeout(() => finish(false), 8000)
    img.onload = () => { global.clearTimeout(timer); finish(true) }
    img.onerror = () => { global.clearTimeout(timer); finish(false) }
    img.src = url
  }

  // 本地图片先压到最长边 1600px 的 JPEG，避免把几 MB 的 data URL 塞进 localStorage
  function compressImageFile(file, cb) {
    if (!file || !/^image\//.test(file.type || '')) return cb(new Error('请选择图片文件'))
    if (file.size > 12 * 1024 * 1024) return cb(new Error('图片超过 12MB，请换一张'))
    const fr = new global.FileReader()
    fr.onerror = () => cb(new Error('文件读取失败'))
    fr.onload = () => {
      const img = new global.Image()
      img.onerror = () => cb(new Error('图片解码失败，请换一张'))
      img.onload = () => {
        try {
          const scale = Math.min(1, 1600 / Math.max(img.width, img.height))
          const canvas = global.document.createElement('canvas')
          canvas.width = Math.max(1, Math.round(img.width * scale))
          canvas.height = Math.max(1, Math.round(img.height * scale))
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
          let out = canvas.toDataURL('image/jpeg', 0.82)
          if (out.length > MAX_DATA) out = canvas.toDataURL('image/jpeg', 0.6)
          if (out.length > MAX_DATA) return cb(new Error('图片压缩后仍过大，请换一张更小的图'))
          cb(null, out)
        } catch (e) { cb(new Error('图片处理失败：' + e.message)) }
      }
      img.src = fr.result
    }
    fr.readAsDataURL(file)
  }

  function initUi() {
    const $ = id => global.document.getElementById(id)
    const panel = $('authBgPanel')
    const toggle = $('btnAuthBg')
    if (!panel || !toggle) return
    const say = t => { const m = $('authBgMsg'); if (m) m.textContent = t || '' }

    function markActive(v) {
      panel.querySelectorAll('[data-bg]').forEach(b => {
        const on = v.mode === 'preset' && b.dataset.bg === v.preset
        b.classList.toggle('active', on)
        b.setAttribute('aria-pressed', on ? 'true' : 'false')
      })
    }

    function use(v, okText) {
      const nonce = freshNonce()
      if (!saveSetting(v)) { say('未能保存偏好：浏览器存储不可用或图片过大'); return null }
      applySetting(v, null, nonce)   // 渲染带一次性参数，保存的是原始地址
      markActive(v)
      say(okText)
      return nonce
    }

    toggle.addEventListener('click', () => { panel.hidden = !panel.hidden; markActive(readSetting()); say('') })
    const close = $('btnAuthBgClose')
    if (close) close.addEventListener('click', () => { panel.hidden = true })
    global.document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && !panel.hidden) panel.hidden = true
    })

    panel.querySelectorAll('[data-bg]').forEach(b => b.addEventListener('click', () => {
      use({ mode: 'preset', preset: b.dataset.bg }, '已切换背景：' + (b.textContent || '').trim())
    }))

    const file = $('authBgFile')
    if (file) file.addEventListener('change', ev => {
      const f = ev.target.files && ev.target.files[0]
      if (!f) return
      say('正在处理图片…')
      compressImageFile(f, (err, dataUrl) => {
        if (err) return say(err.message)
        use({ mode: 'image', image: dataUrl }, '已应用本地图片（只保存在本浏览器）')
      })
    })

    const applyUrl = $('btnAuthBgApply')
    if (applyUrl) applyUrl.addEventListener('click', () => {
      const input = $('authBgUrl')
      const raw = input ? input.value.trim() : ''
      if (!raw) return say('请填写图片地址')
      const safe = sanitizeImageUrl(raw)
      if (!safe) return say('地址无效：仅支持 http(s) 图片链接，且不能含引号、括号或空格')
      const nonce = use({ mode: 'image', image: safe }, '已应用图片地址')
      if (nonce && /^https?:\/\//i.test(safe)) {
        probeImage(cacheBustedUrl(safe, nonce), flag => {
          if (flag === false) say('地址已保存，但图片暂时加载不出来；请确认它返回的是图片，且浏览器能访问该服务')
        })
      }
    })

    const next = $('btnAuthBgNext')
    if (next) next.addEventListener('click', () => {
      const v = readSetting()
      if (v.mode !== 'image') return say('当前是配色预设，先应用本地图片或图片地址')
      applySetting(v, null, freshNonce())
      say('已重新加载图片')
    })

    const reset = $('btnAuthBgReset')
    if (reset) reset.addEventListener('click', () => {
      clearSetting()
      const v = normalizeBgSetting(null)
      applySetting(v)
      markActive(v)
      const u = $('authBgUrl'); if (u) u.value = ''
      if (file) file.value = ''
      say('已恢复默认背景')
    })

    markActive(readSetting())
  }

  const api = {
    STORE_KEY, PRESETS, DEFAULT_PRESET, MAX_DATA,
    sanitizeImageUrl, cacheBustedUrl, freshNonce, forRender, probeImage,
    normalizeBgSetting, readSetting, saveSetting, clearSetting, applySetting, compressImageFile
  }
  global.LXHAuthBg = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api

  if (typeof global.document !== 'undefined') {
    // 每次打开登录页都换一张（随机图接口的意义所在）；预设配色不受 nonce 影响
    applySetting(readSetting(), null, freshNonce())
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', initUi)
    else initUi()
  }
})(typeof window !== 'undefined' ? window : globalThis)
