/**
 * Web/Docker 版渲染进程桥接（v1.9.0）
 *
 * 桌面版（Electron）里 window.api 由 preload.js 通过 contextBridge 注入；
 * Web 版没有 preload，这里提供同名同签名的 window.api，把调用转发到
 * HTTP 接口（src/server/web.js），日志/事件用 SSE（EventSource）接收。
 *
 * 本文件在 Electron 下会自动让位（检测到 window.api 已存在即退出），
 * 因此 index.html 可以无条件引用，桌面版行为不受影响。
 */
(function () {
  if (window.api) return // Electron 桌面版：preload 已注入，保持原样

  async function call(url, body) {
    const opt = body === undefined
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    const r = await fetch(url, opt)
    const ct = r.headers.get('content-type') || ''
    if (!ct.includes('application/json')) return { ok: false, error: '服务端返回了非 JSON 响应（HTTP ' + r.status + '）' }
    return await r.json()
  }

  // SSE 单例：log 与 event 两个通道复用同一条连接
  let es = null
  const listeners = { log: new Set(), event: new Set() }
  function ensureES() {
    if (es) return
    es = new EventSource('/api/events')
    es.onmessage = ev => {
      let m
      try { m = JSON.parse(ev.data) } catch (e) { return }
      const set = listeners[m.channel]
      if (set) for (const cb of set) { try { cb(m.payload) } catch (e) {} }
    }
    es.onerror = () => { /* EventSource 自动重连，无需处理 */ }
  }
  function subscribe(channel, cb) {
    ensureES()
    listeners[channel].add(cb)
    return () => listeners[channel].delete(cb)
  }

  // 导出：服务端返回附件 JSON，浏览器触发下载（替代桌面版保存对话框）
  async function dbExport(ids) {
    const r = await fetch('/api/db/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids || [] })
    })
    if (!r.ok) return { ok: false, error: '导出失败（HTTP ' + r.status + '）' }
    const blob = await r.blob()
    const disposition = r.headers.get('Content-Disposition') || ''
    const m = /filename="?([^"]+)"?/.exec(disposition)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = (m && m[1]) || 'lx-hunter-sources.json'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    return { ok: true, data: { exported: true, count: Number(r.headers.get('X-Count') || 0), path: '浏览器下载' } }
  }

  // 导入：弹出文件选择，读原文 POST 给服务端合并（替代桌面版打开对话框）
  function dbImport() {
    return new Promise(resolve => {
      const inp = document.createElement('input')
      inp.type = 'file'
      inp.accept = '.json,application/json'
      inp.onchange = async () => {
        const f = inp.files && inp.files[0]
        if (!f) return resolve({ ok: true, data: { imported: false } })
        try {
          const text = await f.text()
          const r = await fetch('/api/db/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text })
          resolve(await r.json())
        } catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }) }
      }
      inp.click()
    })
  }

  window.api = {
    configGet: () => call('/api/config'),
    configSet: patch => call('/api/config', patch),
    serviceTest: cfg => call('/api/service/test', cfg || {}),
    serviceList: () => call('/api/service/list'),
    serviceReconcile: (platformId, liveIds) => call('/api/service/reconcile', { platformId, liveIds }),
    sourcesGet: () => call('/api/sources'),
    logsGet: () => call('/api/logs'),
    logsClear: () => call('/api/logs/clear', {}),
    crawlStart: () => call('/api/crawl', {}),
    checkStart: (ids, opts) => call('/api/check', { ids, opts }),
    hashStart: ids => call('/api/hash', { ids }),
    importStart: ids => call('/api/import', { ids }),
    jobCancel: () => call('/api/job/cancel', {}),
    jobState: () => call('/api/job/state'),
    patrolStart: () => call('/api/patrol', {}),
    revoke: ids => call('/api/revoke', { ids }),
    serverSync: () => call('/api/server/sync', {}),
    dbClear: () => call('/api/db/clear', {}),
    dbUndedupe: () => call('/api/db/undedupe', {}),
    dbExport,
    dbImport,
    sourceValidate: id => call('/api/source/validate', { id }),
    importUrl: (url, name) => call('/api/import/url', { url, name }),
    serviceToggle: (id, enabled, owner) => call('/api/service/toggle', { id, enabled, owner }),
    serviceRemove: (id, owner) => call('/api/service/remove', { id, owner }),
    servicePlatforms: (id, disabledSources, owner) => call('/api/service/platforms', { id, disabledSources, owner }),
    serviceListPublic: () => call('/api/service/list/public'),
    serviceRemovePublicBatch: ids => call('/api/service/remove/public', { ids }),
    openDataDir: () => call('/api/datadir', {}),
    onLog: cb => subscribe('log', cb),
    onEvent: cb => subscribe('event', cb)
  }

  // 角标标注运行形态，避免和桌面版截图混淆
  const brand = document.querySelector('.brand-sub')
  if (brand) brand.textContent = 'Web/Docker 版 v1.9.0'
})()
