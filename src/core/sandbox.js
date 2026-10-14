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
      try { return fn.apply(this, args) } catch (e) { self.onLog('沙箱异步回调异常: ' + String((e && e.message) || e).slice(0, 120)) }
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
          return Promise.reject(new Error('沙箱 fetch 地址无效（相对地址且脚本未提供 homepage）: ' + raw.slice(0, 80)))
        }
        if (self.destroyed || self.stopped) return Promise.reject(new Error('已取消'))
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
        return Promise.resolve()
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
          })
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
