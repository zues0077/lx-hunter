'use strict'
/**
 * Node vm 沙箱：运行洛雪音源脚本，做「真实取链 + 音频校验」可用性检测。
 * 等价于音源猎手插件里的 songloft.jsenv 能力，但在 PC 上跑，速度不受手机限制。
 */
const vm = require('vm')
const nodeCrypto = require('crypto')
const zlib = require('zlib')
const { SETUP } = require('./lxbootstrap')
const { hostFetch, describeNetError } = require('./net')

// ---------- 全局兜底：未处理的 Promise 拒绝（本次 bug 的根因）----------
// 沙箱运行不可信第三方音源脚本，脚本内部 `fetch(u).then(r=>r.json()).then(cb)` 不接 catch 是常态。
// 一旦这些派生出的 Promise 拒绝，Node 默认 --unhandled-rejections=throw 会直接杀进程（SIGKILL 137）。
// 注册 'unhandledRejection' 监听器后，Node 不再因未处理拒绝而终止，而是交给这里记录后忽略 ——
// 这是最后一道防线；配合 fetch 返回值的 swallow（见下）与配额闸门，根治本次事故。
// 仅注册一次（模块可能被多次 require，用标记去重）。
if (!process.__lxUnhandledGuard) {
  process.__lxUnhandledGuard = true
  process.__lxUnhandledCount = 0
  process.on('unhandledRejection', (reason) => {
    try {
      process.__lxUnhandledCount = (process.__lxUnhandledCount || 0) + 1
      const m = reason && reason.message ? String(reason.message) : String(reason)
      // 仅记录、绝不再抛出 —— 否则又变成新的未捕获异常，回到原点
      console.error('[lx-hunter] 未处理的 Promise 拒绝（已忽略，不终止进程）: ' + m.slice(0, 200))
    } catch (e) { /* 自身绝不能抛 */ }
  })
}

// ---------- 注入给沙箱的 crypto / zlib polyfill ----------
function makeCryptoPolyfill() {
  function toBuf(v, enc) {
    if (Buffer.isBuffer(v)) return v
    if (v == null) return Buffer.alloc(0)
    if (typeof v === 'string') return Buffer.from(v, enc || 'utf8')
    if (v instanceof Uint8Array || Array.isArray(v)) return Buffer.from(v)
    return Buffer.from(String(v))
  }
  function normMode(mode, keyLen) {
    let m = String(mode || 'cbc').toLowerCase()
    if (m.indexOf('-') === -1 && m.indexOf('aes') === -1) m = 'aes-' + keyLen * 8 + '-' + m
    else if (m.indexOf('aes-') === 0) {
      const parts = m.split('-')
      if (parts.length === 2) m = 'aes-' + keyLen * 8 + '-' + parts[1]
    }
    return m
  }
  return {
    md5(s) { return nodeCrypto.createHash('md5').update(toBuf(s)).digest('hex') },
    randomBytes(n) { return nodeCrypto.randomBytes(n) },
    aesEncrypt(buffer, mode, key, iv) {
      const buf = toBuf(buffer)
      const k = toBuf(key)
      let algo
      try { algo = normMode(mode, k.length) } catch (e) { algo = 'aes-128-cbc' }
      let ivBuf = iv ? toBuf(iv).slice(0, 16) : Buffer.alloc(0)
      if (/-ecb$/.test(algo)) ivBuf = Buffer.alloc(0)
      else if (ivBuf.length === 0) ivBuf = Buffer.alloc(16)
      const cipher = nodeCrypto.createCipheriv(algo, k, ivBuf)
      cipher.setAutoPadding(true)
      return Buffer.concat([cipher.update(buf), cipher.final()])
    },
    rsaEncrypt(buffer, key) {
      const buf = toBuf(buffer)
      let pem = String(key || '')
      if (pem.indexOf('BEGIN') === -1) {
        pem = '-----BEGIN PUBLIC KEY-----\n' + pem.replace(/(.{64})/g, '$1\n') + '\n-----END PUBLIC KEY-----'
      }
      try {
        return nodeCrypto.publicEncrypt({ key: pem, padding: nodeCrypto.constants.RSA_PKCS1_PADDING }, buf)
      } catch (e) {
        return nodeCrypto.publicEncrypt({ key: pem, padding: nodeCrypto.constants.RSA_PKCS1_OAEP_PADDING }, buf)
      }
    }
  }
}

function makeZlibPolyfill() {
  function toBuf(v) {
    if (Buffer.isBuffer(v)) return v
    if (v == null) return Buffer.alloc(0)
    if (typeof v === 'string') return Buffer.from(v, 'binary')
    return Buffer.from(v)
  }
  return {
    inflate(b) {
      const buf = toBuf(b)
      for (const fn of [zlib.inflateSync, zlib.gunzipSync, zlib.inflateRawSync]) {
        try { return fn(buf) } catch (e) {}
      }
      throw new Error('inflate failed')
    },
    deflate(b) {
      const buf = toBuf(b)
      try { return zlib.deflateSync(buf) } catch (e) { return zlib.gzipSync(buf) }
    }
  }
}

// ---------- 沙箱实例 ----------
class Sandbox {
  constructor(opts) {
    opts = opts || {}
    this.id = opts.id || 'sb_' + Date.now()
    this.fetchTimeout = opts.fetchTimeout || 15000
    this.initGraceMs = Number(opts.initGraceMs) || 4000        // 异步 init 的等待宽限
    this.initGraceMaxMs = Number(opts.initGraceMaxMs) || 15000  // 有请求在飞时的硬上限
    this.onLog = opts.onLog || function () {}
    this.events = []
    this.cookies = {}
    this.inflightFetches = 0   // 在飞的网络请求数：init 宽限据此自适应延长
    this.pending = new Map()
    this.destroyed = false
    this.stopped = false
    this.reqSeq = 0
    this.baseUrl = null       // 相对 URL 的基址（取脚本 @homepage）
    // ---- 资源配额（v1.9.1）----
    // 实测事故：一批已废弃音源在被并发抓取时，脚本内部对同一个失效域名反复重试
    // （每次 fetch 都 ENOTFOUND / 证书不匹配），在飞请求数无上限地涨，
    // 宿主 socket / 内存被打满，最终被 OOM Killer 以 SIGKILL(137) 干掉。
    // 这里给单个沙箱的「并发请求数」和「请求总量」都加上限：
    // 超限一律快速失败，让脚本自己走它的错误分支，而不是拖垮整个进程。
    this.maxInflight = Number(opts.maxInflight) > 0 ? Number(opts.maxInflight) : 12
    this.maxTotalFetches = Number(opts.maxTotalFetches) > 0 ? Number(opts.maxTotalFetches) : 200
    this.totalFetches = 0
    this.rejectedByQuota = 0
    // 异步错误去重计数（_noteAsyncError 用），避免海量重复拒绝打爆日志/自身再抛
    this._asyncErrSeen = new Map()

    const self = this
    const log = (...a) => { try { self.onLog(a.map(String).join(' ')) } catch (e) {} }
    // 音源脚本常调用 console.group/table/time 等，且多为混淆调用，
    // 用 Proxy 兜住任意方法名，避免因宿主 console 缺方法而整脚本失败
    const consolePolyfill = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'warn' || prop === 'error') return (...a) => log('[' + String(prop) + ']', ...a)
        if (prop === 'log' || prop === 'info' || prop === 'debug' || prop === 'trace') return () => {}
        if (typeof prop === 'symbol') return undefined
        return () => {}
      },
      has() { return true }
    })

    // ---- 定时器守卫 ----
    // 脚本/引导脚本会挂宿主定时器回调；沙箱销毁或停止后回调再触发，
    // 若引用了已被清理的全局会抛 ReferenceError 并冒泡成主进程未捕获异常（弹错误框）。
    // 因此所有进入沙箱的定时器回调都包一层 try/catch，且销毁后直接静默。
    const guard = fn => function (...args) {
      if (self.destroyed || self.stopped) return
      try { return fn.apply(this, args) } catch (e) { self._noteAsyncError(e) }
    }
    /**
     * 给「从沙箱流出到宿主」的 Promise 挂静默兜底（v1.9.1）。
     *
     * 事故根因：脚本里常见 `fetch(u).then(r => r.json()).then(cb)` 这种链，
     * 而我们返回的 fetch Promise 一旦被 .then 派生，派生出的**新** Promise 由脚本自己持有，
     * 它被拒绝时脚本通常并不接 —— Node 于是把它当成「未处理的拒绝」，
     * 冒到宿主进程；`--unhandled-rejections=throw`（Node 15+ 默认）会直接终止进程。
     * 典型触发就是那三条日志：证书 altnames 不匹配 / ENOTFOUND / 域名不存在。
     *
     * 做法：在我们交出去的 Promise 上预挂一个「已被消费」的尾巴，
     * 让引擎认为该拒绝有人处理；同时在沙箱侧记录一次（去重、限量），
     * 既不影响脚本自己的 catch，也不会让它污染宿主。
     */
    const swallow = p => {
      if (!p || typeof p.then !== 'function') return p
      try { p.then(undefined, e => self._noteAsyncError(e)) } catch (e) {}
      return p
    }
    const mkTimer = hostFn => (fn, ms, ...a) => {
      // 不允许字符串代码定时器（会在宿主作用域 eval，逃逸沙箱）
      if (typeof fn !== 'function') return hostFn(() => {}, ms)
      return hostFn(guard(fn), ms, ...a)
    }
    const hostSetTimeout = setTimeout, hostSetInterval = setInterval
    const hostSetImmediate = setImmediate
    const hostQueueMicrotask = typeof queueMicrotask === 'function' ? queueMicrotask : null
    const hostNextTick = process.nextTick.bind(process)

    const sandboxGlobals = {
      __host_emit(name, json) {
        try {
          const data = json == null ? null : JSON.parse(json)
          self.events.push({ name, data, at: Date.now() })
          if (name === 'dispatchResult' || name === 'dispatchError') {
            const p = self.pending.get(data && data.id)
            if (p) { self.pending.delete(data.id); name === 'dispatchResult' ? p.resolve(data) : p.reject(new Error(String((data && data.error) || 'dispatch error'))) }
          }
        } catch (e) {}
      },
      __host_setcookie(ck) { try { String(ck).split(/,(?=[^;]+=)/).forEach(c => { const kv = c.split(';')[0]; const i = kv.indexOf('='); if (i > 0) self.cookies[kv.slice(0, i).trim()] = kv.slice(i + 1).trim() }) } catch (e) {} },
      // 沙箱 fetch：
      //  1) 脚本里常见相对地址（如 /script?key=...），Node fetch 无基址会抛
      //     "Failed to parse URL"，一路冒成主进程未捕获异常。这里用脚本 homepage 作基址补全，
      //     没有基址就直接给一个明确的失败，不抛裸 TypeError。
      //  2) 网络错误统一包装成「沙箱 fetch 失败: …」，便于上层区分瞬时/永久错误。
      fetch: (url, init) => {
        const raw = String(url)
        let finalUrl
        try {
          finalUrl = self.baseUrl ? new URL(raw, self.baseUrl).href : new URL(raw).href
        } catch (e) {
          // 流出的拒绝也要 swallow：脚本若这样写 fetch(u).then(r=>r.json()).then(cb)
          // 而没有 catch，裸拒绝会冒成宿主 unhandledRejection → 默认 throw 终止进程
          return swallow(Promise.reject(new Error('沙箱 fetch 地址无效（相对地址且脚本未提供 homepage）: ' + raw.slice(0, 80))))
        }
        if (self.destroyed || self.stopped) return swallow(Promise.reject(new Error('已取消')))
        // ---- 资源配额闸门（v1.9.1，事故根因修复）----
        // 实测事故：一批已废弃音源被并发抓取时，脚本对同一个失效域名反复重试，
        // 在飞请求数无上限地涨，宿主 socket/内存被打满 → 被 OOM Killer 以 SIGKILL(137) 干掉。
        // 这里双向限速：总量超限直接拒（音源本身已失效，没必要再打网络）；
        // 并发超限快速失败，让脚本走自己的错误分支（多数回退到其它源/本地解析），
        // 而不是把整个进程拖死。所有拒绝都经 swallow 兜底，绝不污染宿主。
        if (self.totalFetches >= self.maxTotalFetches) {
          self.rejectedByQuota++
          self.onLog('沙箱请求被拒（总量超限 ' + self.maxTotalFetches + '）: ' + finalUrl.slice(0, 60))
          return swallow(Promise.reject(new Error('沙箱请求数超限（总量 ' + self.maxTotalFetches + '）')))
        }
        if (self.inflightFetches >= self.maxInflight) {
          self.rejectedByQuota++
          self.onLog('沙箱请求被拒（并发超限 ' + self.maxInflight + '）: ' + finalUrl.slice(0, 60))
          return swallow(Promise.reject(new Error('沙箱并发请求超限（' + self.maxInflight + '）')))
        }
        self.totalFetches++
        const doFetch = opts.fetchImpl || hostFetch()
        // 在飞请求计数：init 宽限据此自适应延长。
        // 一类脚本把 lx.send('inited') 放在网络回调里（先拉远端平台配置再注册），
        // 固定宽限一到期就判「未调用 inited」，用户看到的就是五个平台全灰「未检测」。
        self.inflightFetches++
        // 脚本自带 signal 时尊重脚本设置；否则兜一个超时，
        // 免得脚本直接用裸 fetch 时请求卡住、把整个取链流程拖到 dispatch 超时
        let initObj = init && typeof init === 'object' ? Object.assign({}, init) : {}
        if (!initObj.signal) {
          try { initObj.signal = AbortSignal.timeout(Number(opts.fetchTimeout) > 0 ? Number(opts.fetchTimeout) : 15000) } catch (e) {}
        }
        const settle = () => { if (self.inflightFetches > 0) self.inflightFetches-- }
        return swallow(Promise.resolve()
          .then(() => doFetch(finalUrl, initObj))
          .then(r => { settle(); return r })
          .catch(err => {
            settle()
            // 直接抛裸 "fetch failed" / "The operation was aborted due to timeout" 对排障没帮助：
            // 把 cause 链展开 + 把超时行话翻成人话，用户才看得出是 DNS、证书、代理还是目标站慢
            const raw = describeNetError(err)
            const ms = Number(opts.fetchTimeout) > 0 ? Number(opts.fetchTimeout) : 15000
            const msg = (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) || /aborter|aborted|due to timeout|timed out/i.test(raw)
              ? '请求超时 ' + ms + 'ms'
              : raw
            throw new Error('沙箱 fetch 失败: ' + msg.slice(0, 160) + ' [' + finalUrl.slice(0, 60) + ']')
          }))
      },
      Buffer,
      crypto: makeCryptoPolyfill(),
      zlib: makeZlibPolyfill(),
      // 取链超时下发到引导层：让 lx._dispatch 用它替代硬编码的 20s
      __dispatchTimeout: opts.dispatchTimeout || 20000,
      console: consolePolyfill,
      setTimeout: mkTimer(hostSetTimeout),
      clearTimeout,
      setInterval: mkTimer(hostSetInterval),
      clearInterval,
      setImmediate: mkTimer(hostSetImmediate),
      clearImmediate,
      queueMicrotask: hostQueueMicrotask ? fn => (typeof fn === 'function' ? hostQueueMicrotask(guard(fn)) : undefined) : undefined,
      URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal,
      btoa: s => Buffer.from(String(s), 'binary').toString('base64'),
      atob: s => Buffer.from(String(s), 'base64').toString('binary'),
      escape: s => encodeURIComponent(String(s)),
      unescape: s => decodeURIComponent(String(s)),
      process: {
        env: {}, platform: 'win32', version: process.version,
        nextTick: fn => (typeof fn === 'function' ? hostNextTick(guard(fn)) : undefined)
      }
    }
    // vm 默认 context 不含这些，显式挂上
    sandboxGlobals.globalThis = sandboxGlobals
    this.context = vm.createContext(sandboxGlobals)
    vm.runInContext(SETUP, this.context, { timeout: 5000 })
  }

  /**
   * 沙箱异步错误的统一出口（v1.9.1）。
   * guard / swallow / fetch 兜底都会把逃逸的 Promise 拒绝或回调异常导到这里：
   * 只记录、绝不再抛出 —— 否则又会在宿主进程里变成新的未捕获异常，
   * 重新触发 SIGKILL（正是这次事故的来源）。
   * 去重 + 限量（同一沙箱同消息最多记 8 次），避免海量重复拒绝打爆日志，也避免自身抛错。
   */
  _noteAsyncError(e) {
    try {
      if (!this._asyncErrSeen) this._asyncErrSeen = new Map()
      const msg = e && e.message ? String(e.message) : (e == null ? 'undefined' : String(e))
      const key = msg.slice(0, 80)
      const seen = this._asyncErrSeen.get(key) || 0
      if (seen < 8) {
        this._asyncErrSeen.set(key, seen + 1)
        this.onLog('沙箱异步异常: ' + msg.slice(0, 200))
      }
    } catch (e2) { /* 自身绝不能抛 */ }
  }

  /** 注入脚本元信息（洛雪脚本通过 lx.currentScriptInfo 读取） */
  setScriptInfo(info) {
    this.run('globalThis.lx.currentScriptInfo = ' + JSON.stringify(info || {}) + ';', 3000)
  }

  /** 从 lx 注册表读取已注册的音源 key（不依赖是否发过 inited） */
  probeRegisteredSources() {
    try {
      const raw = this.run('JSON.stringify(globalThis.lx && globalThis.lx._getSources ? globalThis.lx._getSources() : {})', 3000)
      const obj = JSON.parse(raw || '{}')
      return Object.keys(obj || {})
    } catch (e) { return [] }
  }

  /** 从 lx 注册表读取已注册的事件名（含 request 说明脚本已挂上取链处理器） */
  probeRegisteredEvents() {
    try {
      const raw = this.run('JSON.stringify(globalThis.lx && globalThis.lx._getEvents ? globalThis.lx._getEvents() : [])', 3000)
      const arr = JSON.parse(raw || '[]')
      return Array.isArray(arr) ? arr : []
    } catch (e) { return [] }
  }

  run(code, timeoutMs) {
    if (this.destroyed || this.stopped) throw new Error('已取消')
    return vm.runInContext(code, this.context, { timeout: timeoutMs || 15000, displayErrors: true })
  }

  /** 执行脚本本体，等待 inited 事件。脚本本体抛异常时不往外抛，交给调用方抢救 */
  async init(code, meta) {
    this.events.length = 0
    // 脚本 homepage 作为相对 URL 的基址（脚本里 fetch('/script?key=…') 这种写法靠它补全）
    const hp = meta && meta.homepage
    this.baseUrl = (typeof hp === 'string' && /^https?:\/\//i.test(hp)) ? hp : null
    this.setScriptInfo(meta || {})
    let runErr = null
    try { this.run(code, 20000) } catch (e) { runErr = e }
    // inited 可能同步就发了（多数脚本是同步 lx.send('inited')）
    const r = await this._findInited()
    // 只要注册了音源或取链处理器，就照测不误 —— 下面两种都不是「取链能力不可用」：
    //  a) 本体同步报错（runErr）：脚本尾部炸了，但注册已完成；
    //  b) inited 迟迟不来：一类脚本把 lx.send('inited') 放在网络回调里（先拉远端平台配置），
    //     原先只抢救 a)，b) 直接判死 → 上层显示「脚本未调用 lx.send('inited')」+ 五个平台全灰「未检测」。
    //     这正是「检测完还是显示未检测」的主因。
    if (!r.inited) {
      const keys = this.probeRegisteredSources()
      const evs = this.probeRegisteredEvents()
      if (keys.length || evs.includes('request')) {
        const why = runErr
          ? String(runErr.message || runErr).slice(0, 200)
          : '脚本未在 ' + Math.round(r.waitedMs || this.initGraceMs || 4000) + 'ms 内发出 inited' +
            '（多见于需联网拉取平台配置），但已注册取链处理器 —— 按标准五平台实测'
        return {
          inited: true,
          data: { sources: keys.reduce((a, k) => (a[k] = {}, a), {}) },
          recovered: true,
          // 只知道「有取链处理器」但不知声明了哪些平台 ⇒ 上层按标准五平台全测
          guessedSources: keys.length === 0,
          runError: why
        }
      }
    }
    if (runErr && !r.inited) this.initError = String(runErr.message || runErr).slice(0, 200)
    return r
  }

  _findInited() {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].name === 'inited') return { inited: true, data: this.events[i].data }
    }
    // 兜底：从 _getSources 看是否注册了源
    const keys = this.probeRegisteredSources()
    if (keys.length) return { inited: true, data: { sources: keys.reduce((a, k) => (a[k] = {}, a), {}) } }
    // 少数脚本异步 init（先拉远端平台配置，再在回调里 send('inited')）。
    // 固定宽限对这类脚本是死结：网络稍慢就永远等不到 inited，
    // 上层于是判定「脚本未调用 lx.send('inited')」，五个平台全灰显示「未检测」。
    // 所以宽限自适应：还有请求在飞就继续等，等到硬上限为止。
    const grace = Math.max(500, Number(this.initGraceMs) || 4000)
    const cap = Math.max(grace + 1000, Number(this.initGraceMaxMs) || 15000)
    return new Promise(resolve => {
      const t0 = Date.now()
      const timer = setInterval(() => {
        const el = Date.now() - t0
        for (let i = this.events.length - 1; i >= 0; i--) {
          if (this.events[i].name === 'inited') { clearInterval(timer); return resolve({ inited: true, data: this.events[i].data }) }
        }
        if (el > grace && this.inflightFetches <= 0) { clearInterval(timer); return resolve({ inited: false, waitedMs: el }) }
        if (el > cap) { clearInterval(timer); resolve({ inited: false, waitedMs: el }) }
      }, 60)
    })
  }

  /** 立即中止：拒绝所有待完成的取链请求，后续 dispatch 直接失败 */
  stop() {
    this.stopped = true
    for (const [id, p] of Array.from(this.pending.entries())) {
      this.pending.delete(id)
      try { p.reject(new Error('已取消')) } catch (e) {}
    }
  }

  /** 派发一次取链请求，等待 dispatchResult / dispatchError */
  dispatch(action, payload, timeoutMs) {
    if (this.stopped || this.destroyed) return Promise.reject(new Error('已取消'))
    const reqId = 'hq_' + Date.now() + '_' + (this.reqSeq++)
    const tmo = timeoutMs || 20000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId)
        reject(new Error('取链超时'))
      }, tmo)
      this.pending.set(reqId, {
        resolve: v => { clearTimeout(timer); resolve(v) },
        reject: e => { clearTimeout(timer); reject(e) }
      })
      try {
        this.run('lx._dispatch(' + JSON.stringify(reqId) + ', ' + JSON.stringify(action) + ', ' + JSON.stringify(payload) + ');', 5000)
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(reqId)
        reject(e)
      }
    })
  }

  /**
   * 销毁沙箱：仅标记状态并拒绝待完成的取链请求。
   * 注意：绝不能删除 context 里的全局对象 —— 脚本可能还挂着宿主定时器回调，
   * 删掉后回调触发会 ReferenceError 并冒泡为主进程未捕获异常（弹错误框）。
   * context 会在所有引用（定时器等）释放后被 GC 回收。
   */
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.stop()
  }
}

module.exports = { Sandbox }
