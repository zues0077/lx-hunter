'use strict'
/*
 * 登录页外观：背景预设 / 我的背景库（地址 + 本地图片）/ 折叠与切换，偏好存 localStorage。
 *
 * 这个脚本在 <head> 里同步执行：先按已保存的偏好写 <html data-auth-bg>，
 * 让浏览器第一次绘制就是用户选的背景，不会先闪一下默认渐变。
 * 远程地址渲染时附加一次性参数穿透 302/图片缓存，随机图接口才会每次刷新换一张。
 * DOM 交互统一等 DOMContentLoaded 再绑定。
 *
 * 存储分三处，互不污染：
 *   lxh-auth-bg      当前选中：{mode:'preset',preset} | {mode:'image',itemId}
 *                    —— 只存条目 id，不存整张图，避免同一张图存两份
 *   lxh-auth-bg-lib  背景库：{v:1, items:[{id,kind,src,label,w,h,bytes,addedAt}]}
 *   lxh-auth-bg-ui   界面状态：{libOpen}（折叠与否，单纯观感，丢了也不影响背景）
 *
 * localStorage 是同步的，所以首屏同步就能拿到图；代价是配额有限，
 * 因此本地图压缩到 1280px 长边、单条 80 万字符、总量 320 万字符，
 * 且写入失败会回滚并给出人话提示，不静默丢图。
 *
 * 纯函数（sanitizeImageUrl / normalizeLib / addToLib ...）导出给
 * tests/auth-bg-ui.test.js 复用；浏览器里没有 module，导出语句会自动跳过。
 */
;(function (global) {
  const STORE_KEY = 'lxh-auth-bg'
  const LIB_KEY = 'lxh-auth-bg-lib'
  const UI_KEY = 'lxh-auth-bg-ui'
  const PRESETS = ['aurora', 'dawn', 'mint', 'night', 'plain']
  const DEFAULT_PRESET = 'dawn' // 无偏好 / 坏数据时的默认观感（暖阳）
  const MAX_URL = 2048
  const MAX_DATA = 1800000 // 读老数据能容忍的上限（历史版本存过这么大的）
  const MAX_ITEM_CHARS = 800000 // 单张本地图压缩后的字符上限，约 600KB
  const MAX_LIB_CHARS = 3200000 // 整个库的字符上限，留足 5MB 配额的余量
  const MAX_URL_ITEMS = 20
  const MAX_FILE_ITEMS = 6
  const MAX_LABEL = 40
  const COMPRESS_MAX = 1280 // 本地图最长边，作为全屏背景足够
  const COMPRESS_QUALITY = 0.78

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
    return { mode: 'image', itemId: n.itemId, image: cacheBustedUrl(n.image, nonce) }
  }

  // ---------------- 背景库模型 ----------------

  function newId() {
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  }

  // 名称自动生成：本地图用原文件名；地址类用 host。
  // 为什么不用「随机图接口 / 在线图片」当名称：存两个随机图源时会撞成同名，
  // 列表就失去辨识度，所以域名当名称、性质放副标题。
  // 不做重命名——列表是为了快速认出是哪张，不是为了编辑元数据。
  function labelFor(kind, src, name) {
    if (kind === 'file') {
      const n = String(name || '').replace(/\.[^.]+$/, '').trim()
      return (n || '本地图').slice(0, MAX_LABEL)
    }
    try {
      return new URL(String(src)).host.replace(/^www\./i, '').slice(0, MAX_LABEL)
    } catch (e) { return '在线图片' }
  }

  function isRandomApi(src) {
    return /random|unsplash|picsum|bing|wallhaven|img\.php/i.test(String(src || ''))
  }

  // 副标题用路径：host 已经在名称上了，再重复一遍白占宽度
  function hostPath(src) {
    if (/^data:/i.test(src)) return '本地图'
    try {
      const u = new URL(src)
      if (!u.pathname || u.pathname === '/') return ''
      return u.pathname.slice(0, 60)
    } catch (e) {
      return String(src || '').slice(0, 60)
    }
  }

  function formatSize(chars) {
    const n = Number(chars)
    if (!n || n <= 0) return ''
    const kb = n / 1024
    if (kb < 1) return '<1 KB'
    if (kb < 1024) return Math.round(kb) + ' KB'
    return (kb / 1024).toFixed(1) + ' MB'
  }

  function subFor(item) {
    if (!item) return ''
    if (item.kind === 'file') {
      const parts = ['本地图']
      if (item.w && item.h) parts.push(item.w + '×' + item.h)
      if (item.bytes) parts.push(formatSize(item.bytes))
      return parts.join(' · ')
    }
    const tag = isRandomApi(item.src) ? '随机图接口' : '在线图片'
    const p = hostPath(item.src)
    return p ? tag + ' · ' + p : tag
  }

  // 单条目清洗：脏数据整条丢弃（不整库崩），kind 与 src 形态必须自洽
  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null
    const src = sanitizeImageUrl(raw.src)
    if (!src) return null
    const isData = /^data:image\//i.test(src)
    if (raw.kind === 'file' && !isData) return null
    if (raw.kind === 'url' && isData) return null
    const kind = isData ? 'file' : 'url'
    const item = {
      id: /^[A-Za-z0-9_-]{1,64}$/.test(String(raw.id || '')) ? String(raw.id) : newId(),
      kind,
      src,
      label: String(raw.label || labelFor(kind, src, '')).slice(0, MAX_LABEL),
      addedAt: Number(raw.addedAt) > 0 ? Math.round(Number(raw.addedAt)) : Date.now()
    }
    if (kind === 'file') {
      item.w = Number(raw.w) > 0 ? Math.round(Number(raw.w)) : 0
      item.h = Number(raw.h) > 0 ? Math.round(Number(raw.h)) : 0
      item.bytes = Number(raw.bytes) > 0 ? Math.round(Number(raw.bytes)) : Math.round(src.length * 3 / 4)
    }
    return item
  }

  // 整库清洗：坏 JSON / 坏条目 / 超量一律降级成“能用的部分”，不让一个坏 id 拖垮全库
  function normalizeLib(raw) {
    let v = raw
    if (typeof v === 'string') { try { v = JSON.parse(v) } catch (e) { v = null } }
    const out = { v: 1, items: [] }
    if (!v || typeof v !== 'object' || !Array.isArray(v.items)) return out
    const seen = new Set()
    let fileCount = 0
    let urlCount = 0
    let chars = 0
    for (let i = 0; i < v.items.length; i++) {
      const it = normalizeItem(v.items[i])
      if (!it || seen.has(it.src)) continue
      if (it.kind === 'file') {
        if (fileCount >= MAX_FILE_ITEMS) continue
        fileCount++
      } else {
        if (urlCount >= MAX_URL_ITEMS) continue
        urlCount++
      }
      chars += it.src.length
      if (chars > MAX_LIB_CHARS) break
      seen.add(it.src)
      out.items.push(it)
    }
    return out
  }

  function libChars(lib) {
    try { return JSON.stringify(lib).length } catch (e) { return 0 }
  }

  function countKind(lib, kind) {
    return lib.items.filter(x => x.kind === kind).length
  }

  // 入库：同一张图（同 src）不重复存，返回 dup 让调用方提示“已经在列表里”
  function addToLib(lib, item) {
    const base = lib && Array.isArray(lib.items) ? lib : normalizeLib(null)
    const it = normalizeItem(item)
    if (!it) return { ok: false, reason: '这张图的数据无效，未能添加' }
    const dup = base.items.find(x => x.src === it.src)
    if (dup) return { ok: true, lib: base, item: dup, dup: true }
    if (it.kind === 'file' && countKind(base, 'file') >= MAX_FILE_ITEMS) {
      return { ok: false, reason: '本地图片最多 ' + MAX_FILE_ITEMS + ' 张，先删掉一张再添加' }
    }
    if (it.kind === 'url' && countKind(base, 'url') >= MAX_URL_ITEMS) {
      return { ok: false, reason: '图片地址最多 ' + MAX_URL_ITEMS + ' 个，先删掉一个再添加' }
    }
    if (it.src.length > MAX_ITEM_CHARS) {
      return { ok: false, reason: '这张图压缩后仍有 ' + formatSize(Math.round(it.src.length * 3 / 4)) + '，换一张小一点的' }
    }
    const next = { v: 1, items: base.items.concat([it]) }
    if (libChars(next) > MAX_LIB_CHARS) {
      return { ok: false, reason: '浏览器存储已接近上限，先删掉几张旧背景再添加' }
    }
    return { ok: true, lib: next, item: it, dup: false }
  }

  function removeFromLib(lib, id) {
    const base = lib && Array.isArray(lib.items) ? lib : normalizeLib(null)
    return { v: 1, items: base.items.filter(x => x.id !== id) }
  }

  // ---------------- 当前选中项 ----------------

  // 任何脏数据（旧版本格式、坏 JSON、被手改过的 localStorage）都退回默认预设。
  // 同时兼容两种 image 形态：新格式只带 itemId，老格式带整张 image。
  function normalizeBgSetting(raw) {
    let v = raw
    if (typeof v === 'string') { try { v = JSON.parse(v) } catch (e) { v = null } }
    if (!v || typeof v !== 'object') return { mode: 'preset', preset: DEFAULT_PRESET }
    if (v.mode === 'image') {
      if (typeof v.itemId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v.itemId)) {
        const out = { mode: 'image', itemId: v.itemId }
        const img = sanitizeImageUrl(v.image)
        if (img) out.image = img
        return out
      }
      const img = sanitizeImageUrl(v.image)
      return img ? { mode: 'image', image: img } : { mode: 'preset', preset: DEFAULT_PRESET }
    }
    return { mode: 'preset', preset: PRESETS.indexOf(v.preset) >= 0 ? v.preset : DEFAULT_PRESET }
  }

  function readRaw(key) {
    try {
      const ls = global.localStorage
      return ls ? ls.getItem(key) : null
    } catch (e) { return null }
  }

  function readLib() {
    return normalizeLib(readRaw(LIB_KEY))
  }

  // 写库失败要把旧值还回去：浏览器配额超限时 setItem 抛错，原值其实还在，
  // 但万一被部分写入，这里保证磁盘上仍是可用的旧库。
  function commitLib(next, prevRaw) {
    try {
      const ls = global.localStorage
      if (!ls) return false
      ls.setItem(LIB_KEY, JSON.stringify(next))
      return true
    } catch (e) {
      try {
        const ls = global.localStorage
        if (ls && prevRaw != null) ls.setItem(LIB_KEY, prevRaw)
      } catch (e2) { /* 回滚也失败就不动它，至少不会写坏 */ }
      return false
    }
  }

  function findItem(lib, id) {
    if (!id) return null
    return (lib || readLib()).items.find(x => x.id === id) || null
  }

  // 设置里只存 itemId；渲染时才去库里取 src。条目被删了就回退默认配色。
  function readSetting() {
    const v = normalizeBgSetting(readRaw(STORE_KEY))
    if (v.mode !== 'image') return v
    if (v.image) return v
    const item = findItem(null, v.itemId)
    if (!item) return normalizeBgSetting(null)
    return { mode: 'image', itemId: v.itemId, image: item.src }
  }

  function saveSetting(setting) {
    try {
      if (!global.localStorage) return false
      const v = normalizeBgSetting(setting)
      // 剥离 image：整张图已经在库里，再存一份会双倍吃配额
      const slim = v.mode === 'image'
        ? (v.itemId ? { mode: 'image', itemId: v.itemId } : { mode: 'image', image: v.image })
        : v
      global.localStorage.setItem(STORE_KEY, JSON.stringify(slim))
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
    if (v.mode !== 'image') {
      el.dataset.authBg = v.preset
      el.style.removeProperty('--auth-custom')
      return v
    }
    const src = v.image || (findItem(null, v.itemId) || {}).src || ''
    if (!src) { // 指向的条目已经没了，静默回退，别留个空背景
      el.dataset.authBg = DEFAULT_PRESET
      el.style.removeProperty('--auth-custom')
      return { mode: 'preset', preset: DEFAULT_PRESET }
    }
    el.dataset.authBg = 'custom'
    el.style.setProperty('--auth-custom', 'url("' + cacheBustedUrl(src, nonce) + '")')
    return { mode: 'image', itemId: v.itemId, image: src }
  }

  // 老版本只存了单张图，升级后自动补成库里第一条，用户不会觉得图丢了。
  // 已经有库时也照样补：防止“库被清过但偏好还在”这种半残状态。
  function migrateLegacy() {
    const raw = readRaw(STORE_KEY)
    if (!raw) return false
    let v = null
    try { v = JSON.parse(raw) } catch (e) { return false }
    if (!v || v.mode !== 'image' || v.itemId) return false
    const src = sanitizeImageUrl(v.image)
    if (!src) return false
    const kind = /^data:image\//i.test(src) ? 'file' : 'url'
    const prevRaw = readRaw(LIB_KEY)
    const r = addToLib(readLib(), {
      id: newId(),
      kind,
      src,
      label: labelFor(kind, src, ''),
      addedAt: Date.now()
    })
    if (!r.ok) return false
    if (!commitLib(r.lib, prevRaw)) return false
    try {
      global.localStorage.setItem(STORE_KEY, JSON.stringify({ mode: 'image', itemId: r.item.id }))
    } catch (e) { return false }
    return true
  }

  // ---------------- 界面状态（折叠） ----------------

  function readUi() {
    const raw = readRaw(UI_KEY)
    let v = null
    try { v = raw ? JSON.parse(raw) : null } catch (e) { v = null }
    // 默认展开：第一次用的人要一眼看到列表在哪
    return { libOpen: !(v && v.libOpen === false) }
  }

  function saveUi(patch) {
    const next = Object.assign(readUi(), patch || {})
    try {
      if (global.localStorage) global.localStorage.setItem(UI_KEY, JSON.stringify(next))
    } catch (e) { /* 界面状态存不下无所谓 */ }
    return next
  }

  // ---------------- 图片处理 ----------------

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

  // 本地图片压到最长边 1280px 的 JPEG：既保证全屏背景够用，又不至于把
  // localStorage 配额吃光（一张图几百 KB，6 张才 1.2MB 左右）。
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
          const scale = Math.min(1, COMPRESS_MAX / Math.max(img.width, img.height))
          const canvas = global.document.createElement('canvas')
          canvas.width = Math.max(1, Math.round(img.width * scale))
          canvas.height = Math.max(1, Math.round(img.height * scale))
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
          let out = canvas.toDataURL('image/jpeg', COMPRESS_QUALITY)
          if (out.length > MAX_ITEM_CHARS) out = canvas.toDataURL('image/jpeg', 0.62)
          if (out.length > MAX_ITEM_CHARS) out = canvas.toDataURL('image/jpeg', 0.45)
          if (out.length > MAX_ITEM_CHARS) {
            return cb(new Error('图片压缩后仍有 ' + formatSize(Math.round(out.length * 3 / 4)) + '，换一张小一点的'))
          }
          cb(null, out, {
            name: file.name || '',
            w: canvas.width,
            h: canvas.height,
            bytes: Math.round(out.length * 3 / 4)
          })
        } catch (e) { cb(new Error('图片处理失败：' + e.message)) }
      }
      img.src = fr.result
    }
    fr.readAsDataURL(file)
  }

  // ---------------- DOM ----------------

  const SVG_PLACEHOLDER = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
    '<rect x="3" y="4.5" width="18" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/>' +
    '<circle cx="8.5" cy="10" r="1.6" fill="currentColor"/>' +
    '<path d="M4.5 17.5 9.5 13l3.5 2.8 3-2.3 4 3.7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>' +
    '</svg>'
  const SVG_REFRESH = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">' +
    '<path d="M20 11a8 8 0 1 0-2.3 5.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M20 4v7h-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>'
  const SVG_TRASH = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">' +
    '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l.8 12h9.4l.8-12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>'

  function initUi() {
    const $ = id => global.document.getElementById(id)
    const panel = $('authBgPanel')
    const toggle = $('btnAuthBg')
    if (!panel || !toggle) return
    const say = t => { const m = $('authBgMsg'); if (m) m.textContent = t || '' }

    const list = $('authBgList')
    const libBtn = $('btnAuthBgLib')
    const libBody = $('authBgLibBody')
    const addBtn = $('btnAuthBgAdd')
    const addBody = $('authBgAddBody')
    const fileInput = $('authBgFile')
    const urlInput = $('authBgUrl')

    // 色块只在“当前用的是预设”时高亮；用图片时五个色块全灭，避免误导
    function markSwatches(v) {
      panel.querySelectorAll('[data-bg]').forEach(b => {
        const on = v.mode === 'preset' && b.dataset.bg === v.preset
        b.classList.toggle('active', on)
        b.setAttribute('aria-pressed', on ? 'true' : 'false')
      })
    }

    function buildRow(item, active) {
      const row = global.document.createElement('div')
      row.className = 'auth-bg-item' + (active ? ' is-active' : '')
      row.dataset.id = item.id
      row.setAttribute('role', 'button')
      row.tabIndex = 0
      row.setAttribute('aria-pressed', active ? 'true' : 'false')
      row.title = active ? '当前使用中' : '点击切换到这个背景'

      const thumb = global.document.createElement('span')
      thumb.className = 'auth-bg-thumb'
      thumb.innerHTML = SVG_PLACEHOLDER // 静态字符串，不含用户数据
      const img = global.document.createElement('img')
      img.alt = ''
      img.decoding = 'async'
      img.loading = 'lazy'
      // 缩略图直接取原始地址：加 nonce 会让每次渲染都重新下载一遍
      img.src = item.src
      img.onerror = () => { if (img.parentNode) img.parentNode.removeChild(img) }
      thumb.appendChild(img)

      const main = global.document.createElement('span')
      main.className = 'auth-bg-item-main'
      const name = global.document.createElement('span')
      name.className = 'auth-bg-item-name'
      name.textContent = item.label // 一律 textContent，绝不拼 HTML
      if (active) {
        const badge = global.document.createElement('em')
        badge.className = 'auth-bg-badge'
        badge.textContent = '使用中'
        name.appendChild(badge)
      }
      const sub = global.document.createElement('span')
      sub.className = 'auth-bg-item-sub'
      sub.textContent = subFor(item)
      main.appendChild(name)
      main.appendChild(sub)

      const ops = global.document.createElement('span')
      ops.className = 'auth-bg-item-ops'
      if (item.kind === 'url') {
        const rf = global.document.createElement('button')
        rf.type = 'button'
        rf.className = 'auth-bg-icon'
        rf.dataset.act = 'refresh'
        rf.title = '换一张'
        rf.setAttribute('aria-label', '换一张')
        rf.innerHTML = SVG_REFRESH
        ops.appendChild(rf)
      }
      const del = global.document.createElement('button')
      del.type = 'button'
      del.className = 'auth-bg-icon'
      del.dataset.act = 'del'
      del.title = '删除'
      del.setAttribute('aria-label', '删除这张背景')
      del.innerHTML = SVG_TRASH
      ops.appendChild(del)

      row.appendChild(thumb)
      row.appendChild(main)
      row.appendChild(ops)
      return row
    }

    function renderLib(activeId) {
      const lib = readLib()
      if (list) {
        list.textContent = ''
        lib.items.forEach(it => list.appendChild(buildRow(it, it.id === activeId)))
      }
      const empty = $('authBgEmpty')
      if (empty) empty.hidden = lib.items.length > 0
      const count = $('authBgCount')
      if (count) count.textContent = String(lib.items.length)
      const more = $('authBgMore')
      if (more) {
        more.hidden = lib.items.length <= 4
        more.textContent = lib.items.length > 4 ? '共 ' + lib.items.length + ' 项，列表内可滚动' : ''
      }
      return lib
    }

    // 折叠时把右上的容量文字换成“当前用的是什么”，否则收起来就完全看不到状态
    function renderHead(lib, v) {
      const usage = $('authBgUsage')
      if (!usage) return
      const open = !(libBody && libBody.hidden)
      if (open) {
        usage.classList.remove('is-now')
        usage.textContent = lib.items.length ? '已用 ' + formatSize(libChars(lib)) + ' / ' + formatSize(MAX_LIB_CHARS) : ''
        return
      }
      let name = '默认配色'
      if (v.mode === 'image') {
        const it = findItem(lib, v.itemId)
        name = it ? it.label : '自定义图片'
      }
      usage.classList.add('is-now')
      usage.textContent = '当前：' + name
    }

    function syncFoot(v) {
      const next = $('btnAuthBgNext')
      if (!next) return
      const it = v.mode === 'image' && v.itemId ? findItem(null, v.itemId) : null
      const usable = v.mode === 'image' && (!it || it.kind === 'url')
      next.disabled = !usable
      next.title = usable ? '重新加载图片（随机图接口会换一张）' : '本地图片和配色预设不需要换一张'
    }

    function setLibOpen(open, persist) {
      if (!libBtn || !libBody) return
      libBody.hidden = !open
      libBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
      if (persist) saveUi({ libOpen: open })
      renderHead(readLib(), readSetting())
    }

    function setAddOpen(open) {
      if (!addBtn || !addBody) return
      addBody.hidden = !open
      addBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
    }

    function refreshAll() {
      const v = readSetting()
      const lib = renderLib(v.itemId || '')
      markSwatches(v)
      renderHead(lib, v)
      syncFoot(v)
      return v
    }

    // 入库 + 立刻应用：添加完就应该在新背景上，不该让用户再点一次
    function addImage(input, nonce) {
      const prevRaw = readRaw(LIB_KEY)
      const r = addToLib(readLib(), Object.assign({ id: newId(), addedAt: Date.now() }, input))
      if (!r.ok) { say(r.reason); return null }
      if (!commitLib(r.lib, prevRaw)) { say('浏览器存储已满或不可用，没能保存这张背景'); return null }
      const used = nonce || freshNonce()
      const v = { mode: 'image', itemId: r.item.id, image: r.item.src }
      if (!saveSetting(v)) { say('没能保存偏好：浏览器存储不可用'); return null }
      applySetting(v, null, used)
      setLibOpen(true, true)
      setAddOpen(false)
      renderLib(r.item.id)
      markSwatches(v)
      renderHead(readLib(), v)
      syncFoot(v)
      say(r.dup ? '这张背景已经在列表里了，已切换过去' : '已添加并应用：' + r.item.label)
      return { item: r.item, nonce: used, dup: !!r.dup }
    }

    function activate(id) {
      const lib = readLib()
      const it = findItem(lib, id)
      if (!it) { say('这张背景已经不存在了'); refreshAll(); return }
      const cur = readSetting()
      if (cur.mode === 'image' && cur.itemId === id) return // 已经在用，不白刷一次
      const v = { mode: 'image', itemId: id, image: it.src }
      if (!saveSetting(v)) { say('没能保存偏好：浏览器存储不可用'); return }
      applySetting(v, null, freshNonce())
      renderLib(id)
      markSwatches(v)
      renderHead(lib, v)
      syncFoot(v)
      say('已切换：' + it.label)
    }

    function refreshCurrent(targetId) {
      const v = readSetting()
      if (v.mode !== 'image') return say('当前是配色预设，换一张只对图片地址有效')
      const id = targetId || v.itemId
      const it = id ? findItem(null, id) : null
      if (it && it.kind === 'file') return say('本地图片不需要换一张，每次显示的都是同一张')
      const setting = id && it ? { mode: 'image', itemId: id, image: it.src } : v
      applySetting(setting, null, freshNonce())
      syncFoot(v)
      say('已重新加载图片')
    }

    function deleteItem(id, btn) {
      // 两段式：第一次点只是“上膛”，3 秒内再点一次才真删（不弹大窗）
      if (btn && btn.dataset.armed !== '1') {
        btn.dataset.armed = '1'
        btn.classList.add('armed')
        say('再点一次就删除这张背景')
        global.clearTimeout(btn._armTimer)
        btn._armTimer = global.setTimeout(() => {
          btn.dataset.armed = ''
          btn.classList.remove('armed')
        }, 3000)
        return
      }
      const lib = readLib()
      const it = findItem(lib, id)
      if (!it) return
      // 必须先读“当前用的是哪张”再删库：删完 readSetting 就查不到这条了，
      // 会误判成“删的不是当前项”，于是背景留着一条指向空气的 url()。
      const cur = readSetting()
      const wasActive = cur.mode === 'image' && cur.itemId === id
      const prevRaw = readRaw(LIB_KEY)
      const next = removeFromLib(lib, id)
      if (!commitLib(next, prevRaw)) { say('删除失败：浏览器存储不可用'); return }
      if (wasActive) { // 删掉正在用的这张，退回默认配色，不留空背景
        const v = normalizeBgSetting(null)
        saveSetting(v)
        applySetting(v)
        markSwatches(v)
      }
      const after = readSetting()
      renderLib(after.itemId || '')
      renderHead(next, after)
      syncFoot(after)
      say(wasActive ? '已删除并切回默认配色' : '已删除：' + it.label)
    }

    // 列表用事件委托：行是动态生成的，绑在容器上省得每次重渲染都重新绑定。
    // 行尾两个按钮先分流，否则点它们会顺带把背景切了——这是最容易踩的坑。
    if (list) {
      list.addEventListener('click', ev => {
        const icon = ev.target.closest && ev.target.closest('.auth-bg-icon')
        const row = ev.target.closest && ev.target.closest('.auth-bg-item')
        if (!row) return
        if (icon) {
          ev.preventDefault()
          ev.stopPropagation()
          if (icon.dataset.act === 'refresh') refreshCurrent(row.dataset.id)
          else if (icon.dataset.act === 'del') deleteItem(row.dataset.id, icon)
          return
        }
        activate(row.dataset.id)
      })
      list.addEventListener('keydown', ev => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return
        const row = ev.target.closest && ev.target.closest('.auth-bg-item')
        if (!row || ev.target !== row) return
        ev.preventDefault()
        activate(row.dataset.id)
      })
    }

    toggle.addEventListener('click', () => {
      panel.hidden = !panel.hidden
      toggle.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true')
      if (panel.hidden) return
      say('')
      refreshAll()
      setLibOpen(readUi().libOpen, false)
    })
    const close = $('btnAuthBgClose')
    if (close) close.addEventListener('click', () => {
      panel.hidden = true
      toggle.setAttribute('aria-expanded', 'false')
    })
    global.document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && !panel.hidden) {
        panel.hidden = true
        toggle.setAttribute('aria-expanded', 'false')
      }
    })

    if (libBtn) libBtn.addEventListener('click', () => {
      setLibOpen(libBody ? libBody.hidden : true, true)
      say('')
    })

    if (addBtn) addBtn.addEventListener('click', () => {
      const open = addBody ? addBody.hidden : true
      setAddOpen(open)
      say('')
      if (open && urlInput) urlInput.focus()
    })

    panel.querySelectorAll('[data-bg]').forEach(b => b.addEventListener('click', () => {
      const v = { mode: 'preset', preset: b.dataset.bg }
      if (!saveSetting(v)) { say('未能保存偏好：浏览器存储不可用'); return }
      applySetting(v)
      markSwatches(v)
      renderLib('')
      renderHead(readLib(), v)
      syncFoot(v)
      say('已切换背景：' + (b.textContent || '').trim())
    }))

    if (fileInput) fileInput.addEventListener('change', ev => {
      const f = ev.target.files && ev.target.files[0]
      if (!f) return
      say('正在处理图片…')
      compressImageFile(f, (err, dataUrl, meta) => {
        fileInput.value = '' // 允许连选同一个文件
        if (err) { say(err.message); return }
        addImage({
          kind: 'file',
          src: dataUrl,
          label: labelFor('file', dataUrl, meta && meta.name),
          w: meta && meta.w,
          h: meta && meta.h,
          bytes: meta && meta.bytes
        })
      })
    })

    const applyUrl = $('btnAuthBgApply')
    if (applyUrl) applyUrl.addEventListener('click', () => {
      const raw = urlInput ? urlInput.value.trim() : ''
      if (!raw) return say('请填写图片地址')
      const safe = sanitizeImageUrl(raw)
      if (!safe) return say('地址无效：仅支持 http(s) 图片链接，且不能含引号、括号或空格')
      const r = addImage({ kind: 'url', src: safe, label: labelFor('url', safe) })
      if (!r) return
      if (urlInput) urlInput.value = ''
      if (r.dup) return // 已在列表里，不必再探一次
      probeImage(cacheBustedUrl(r.item.src, r.nonce), flag => {
        if (flag === false) say('地址已保存，但图片暂时加载不出来；请确认它返回的是图片，且浏览器能访问该服务')
      })
    })

    const next = $('btnAuthBgNext')
    if (next) next.addEventListener('click', () => refreshCurrent(''))

    const reset = $('btnAuthBgReset')
    if (reset) reset.addEventListener('click', () => {
      const v = normalizeBgSetting(null)
      saveSetting(v)
      applySetting(v)
      markSwatches(v)
      renderLib('')
      renderHead(readLib(), v)
      syncFoot(v)
      if (urlInput) urlInput.value = ''
      if (fileInput) fileInput.value = ''
      say('已恢复默认配色（保存过的背景都还在）')
    })

    // 首屏：老数据先迁移，再按偏好渲染，最后把列表填好（面板可能还没打开）
    setLibOpen(readUi().libOpen, false)
    refreshAll()
  }

  const api = {
    STORE_KEY, LIB_KEY, UI_KEY, PRESETS, DEFAULT_PRESET, MAX_DATA,
    MAX_ITEM_CHARS, MAX_LIB_CHARS, MAX_URL_ITEMS, MAX_FILE_ITEMS,
    sanitizeImageUrl, cacheBustedUrl, freshNonce, forRender, probeImage,
    normalizeBgSetting, readSetting, saveSetting, clearSetting, applySetting, compressImageFile,
    newId, labelFor, hostPath, formatSize, subFor, isRandomApi,
    normalizeItem, normalizeLib, libChars, countKind, addToLib, removeFromLib,
    readLib, commitLib, findItem, migrateLegacy, readUi, saveUi
  }
  global.LXHAuthBg = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api

  if (typeof global.document !== 'undefined') {
    // 老版本只存了单张图 → 升级后补进库，别让用户的图凭空消失
    try { migrateLegacy() } catch (e) {}
    // 每次打开登录页都换一张（随机图接口的意义所在）；预设配色不受 nonce 影响
    applySetting(readSetting(), null, freshNonce())
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', initUi)
    else initUi()
  }
})(typeof window !== 'undefined' ? window : globalThis)
