'use strict'
/**
 * 洛雪音源脚本的宿主环境 polyfill（在 Node vm context 内执行）
 * 与音源猎手插件 / lxmusic 的 bootstrap 保持一致，额外补齐 Node 侧缺失的浏览器全局。
 *
 * 依赖注入到 context 的宿主能力：
 *   __host_emit(name, jsonStr)  事件上行
 *   fetch / Buffer / crypto / zlib / console / 定时器 / URL / TextEncoder / btoa ...
 */

const SETUP = String.raw`
(function () {
  var _eventHandlers = new Map();
  var _registeredSources = {};

  function emit(name, data) {
    try { if (typeof __host_emit === 'function') __host_emit(name, JSON.stringify(data === undefined ? null : data)); } catch (e) {}
  }

  globalThis.lx = {
    version: '2.0.0',
    env: 'desktop',
    platform: 'web',
    currentScriptInfo: { name: '', description: '', version: '', author: '', homepage: '', rawScript: '' },
    EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
    utils: {
      buffer: {
        from: function (d, e) { return Buffer.from(d, e); },
        bufToString: function (b, f) {
          if (b !== null && typeof b === 'object' && typeof b.toString === 'function') return b.toString(f || 'utf8');
          return Buffer.from(b, 'binary').toString(f || 'utf8');
        }
      },
      crypto: {
        md5: function (s) { return crypto.md5(s || ''); },
        aesEncrypt: function (b, m, k, iv) { return crypto.aesEncrypt(b, m, k, iv); },
        rsaEncrypt: function (b, k) { return crypto.rsaEncrypt(b, k); },
        randomBytes: function (n) { return crypto.randomBytes(n); }
      },
      zlib: {
        inflate: function (b) { return zlib.inflate(b); },
        deflate: function (b) { return zlib.deflate(b); }
      }
    },
    // 洛雪风格请求（callback 形式），底层走注入的 fetch
    request: function (url, options, callback) {
      if (typeof options === 'function') { callback = options; options = {}; }
      options = options || {};
      var method = (options.method || 'GET').toUpperCase();
      var headers = options.headers || {};
      var bodyContent = options.body || null;
      if (options.form) {
        bodyContent = options.form;
        if (bodyContent !== null && typeof bodyContent === 'object') {
          var parts = [];
          for (var k in bodyContent) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(bodyContent[k]));
          bodyContent = parts.join('&');
          if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
      }
      if (bodyContent !== null && typeof bodyContent === 'object' && !(bodyContent instanceof Buffer)) {
        bodyContent = JSON.stringify(bodyContent);
        if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
      }
      var aborted = false, called = false;
      function safe(err, resp, body) {
        if (aborted || called) return; called = true;
        if (typeof callback === 'function') { try { callback(err, resp, body); } catch (e) {} }
      }
      var init = { method: method, headers: headers, redirect: 'follow' };
      if (bodyContent !== null && bodyContent !== undefined) init.body = bodyContent;
      var tmo = (typeof options.timeout === 'number' ? options.timeout : 15000);
      try { init.signal = AbortSignal.timeout(tmo); } catch (e) {}

      fetch(url, init).then(function (resp) {
        if (aborted) return;
        var ck = resp.headers && resp.headers.get ? resp.headers.get('set-cookie') : null;
        if (ck && typeof __host_setcookie === 'function') { try { __host_setcookie(ck); } catch (e) {} }
        var headersObj = {};
        try {
          if (resp.headers && resp.headers.forEach) resp.headers.forEach(function (v, k) { headersObj[k] = v; });
        } catch (e) {}
        if (options.binary === true) {
          return resp.arrayBuffer().then(function (ab) {
            if (aborted) return;
            var buf = Buffer.from(ab);
            safe(null, { statusCode: resp.status, statusMessage: resp.statusText || '', headers: headersObj, body: buf }, buf);
          });
        }
        return resp.text().then(function (text) {
          if (aborted) return;
          var body = text;
          try { body = JSON.parse(text); } catch (_) {}
          safe(null, { statusCode: resp.status, statusMessage: resp.statusText || '', headers: headersObj, body: body, raw: text }, body);
        });
      }).catch(function (err) {
        if (aborted) return;
        safe(new Error((err && err.message) ? err.message : String(err)), null, null);
      });
      return function () { aborted = true; };
    },
    send: function (eventName, data) {
      if (eventName === 'inited' && data && data.sources) _registeredSources = data.sources;
      emit(eventName, data);
    },
    on: function (eventName, handler) { _eventHandlers.set(eventName, handler); },
    _dispatch: function (requestId, eventName, data) {
      var handler = _eventHandlers.get(eventName);
      if (typeof handler !== 'function') {
        emit('dispatchError', { id: requestId, error: 'No handler registered for event: ' + eventName });
        return;
      }
      var settled = false;
      function sendResult(v) { if (settled) return; settled = true; emit('dispatchResult', { id: requestId, result: v }); }
      function sendError(e) { if (settled) return; settled = true; emit('dispatchError', { id: requestId, error: (e && e.message) ? e.message : String(e) }); }
      try {
        var result = handler(data);
        if (result && typeof result.then === 'function') {
          // 超时由宿主按「取链超时」下发，避免卡住的脚本白占 20s
          var _tmo = (typeof globalThis.__dispatchTimeout === 'number' && globalThis.__dispatchTimeout > 0) ? globalThis.__dispatchTimeout : 20000;
          var t = setTimeout(function () { sendError(new Error('取链超时')); }, _tmo);
          result.then(function (v) { clearTimeout(t); sendResult(v); }, function (e) { clearTimeout(t); sendError(e); });
        } else sendResult(result);
      } catch (err) { sendError(err); }
    },
    _getSources: function () { return _registeredSources; },
    // 未正式 send('inited') 但已挂上处理器的情况：宿主据此抢救「init 报错但能取链」的脚本
    _getEvents: function () { return Array.from(_eventHandlers.keys()); }
  };

  globalThis.window = globalThis;
  globalThis.global = globalThis;
  globalThis.self = globalThis;
  if (typeof globalThis.document === 'undefined') {
    globalThis.document = { cookie: '', location: { href: '' }, createElement: function () { return {}; } };
  }
  globalThis.navigator = globalThis.navigator || { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

  // localStorage / sessionStorage：不少音源脚本用它缓存 token，
  // 缺失会在 init 阶段抛 "localStorage is not defined"，整条音源被误判为不可用
  if (typeof globalThis.localStorage === 'undefined') {
    function mkStorage() {
      var _m = {};
      return {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(_m, String(k)) ? _m[String(k)] : null; },
        setItem: function (k, v) { _m[String(k)] = String(v); },
        removeItem: function (k) { delete _m[String(k)]; },
        clear: function () { _m = {}; },
        key: function (i) { var ks = Object.keys(_m); return i < ks.length ? ks[i] : null; },
        get length() { return Object.keys(_m).length; }
      };
    }
    globalThis.localStorage = mkStorage();
    globalThis.sessionStorage = mkStorage();
  }

  // XMLHttpRequest：少数老脚本仍用它取数据。用 fetch 兜一个最小实现，
  // 否则 init 阶段就会因 XHR 未定义而整脚本失败。
  if (typeof globalThis.XMLHttpRequest === 'undefined') {
    globalThis.XMLHttpRequest = function () {
      var _t = this;
      this.readyState = 0; this.status = 0; this.statusText = '';
      this.response = null; this.responseText = ''; this.responseType = '';
      this.timeout = 15000; this.withCredentials = false;
      this.onreadystatechange = null; this.onload = null; this.onerror = null; this.ontimeout = null;
      this._headers = {};
      this.open = function (m, u) { _t._method = m; _t._url = u; _t.readyState = 1; };
      this.setRequestHeader = function (k, v) { _t._headers[k] = v; };
      this.getAllResponseHeaders = function () { return ''; };
      this.getResponseHeader = function () { return null; };
      this.abort = function () { _t._aborted = true; };
      this.send = function (body) {
        var init = { method: _t._method || 'GET', headers: _t._headers, redirect: 'follow' };
        if (body !== null && body !== undefined) init.body = body;
        try { init.signal = AbortSignal.timeout(_t.timeout || 15000); } catch (e) {}
        fetch(_t._url, init).then(function (r) {
          if (_t._aborted) return;
          return r.text().then(function (txt) {
            if (_t._aborted) return;
            _t.readyState = 4; _t.status = r.status; _t.statusText = r.statusText || '';
            _t.responseText = txt; _t.response = txt;
            if (_t.responseType === 'json') { try { _t.response = JSON.parse(txt); } catch (e) {} }
            if (typeof _t.onreadystatechange === 'function') _t.onreadystatechange();
            if (typeof _t.onload === 'function') _t.onload();
          });
        }).catch(function (err) {
          if (_t._aborted) return;
          _t.readyState = 4; _t.status = 0;
          if (typeof _t.onerror === 'function') _t.onerror(err);
        });
      };
    };
  }
})();
`

module.exports = { SETUP }
