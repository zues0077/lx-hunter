'use strict'
/**
 * 登录页 UI 契约：输入框对齐 + 可选背景。
 *
 * 两个真实问题：
 *  1) 账号/密码输入框没有宽度，沿用浏览器默认约 190px，而登录按钮是 width:100%，
 *     视觉上像「表单没居中」；
 *  2) 登录层原来是 background: var(--bg) 纯色（浅色主题接近纯白）。
 *
 * 本测试同时验证 CSS 级联/安全过滤/持久化容错，并带「修复前必败」的对照组，
 * 防止断言退化成永远为真的空检查。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const renderer = path.join(__dirname, '..', 'src', 'renderer')
const css = fs.readFileSync(path.join(renderer, 'styles.css'), 'utf8')
const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, '') // 注释里会出现选择器示例，先剥离
const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
const bg = require(path.join(renderer, 'auth-bg.js'))

let pass = 0
const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log('  PASS', label) }

// 只有输入框与按钮都是 100% 宽且等高，表单才算对齐
function formAligned(text) {
  const inp = /\.auth-box\s+\.input\s*\{([^}]*)\}/.exec(text)
  const btn = /\.auth-box\s+\.btn\.primary\s*\{([^}]*)\}/.exec(text)
  if (!inp || !btn) return false
  const full = b => /width\s*:\s*100%/.test(b[1])
  const h = b => (/height\s*:\s*(\d+)px/.exec(b[1]) || [])[1]
  return full(inp) && full(btn) && !!h(inp) && h(inp) === h(btn)
}

console.log('--- ① 表单对齐：修复前必败 / 修复后必胜 ---')
const legacyCss = '.auth-box .field { display:block; } .btn.primary { width:100%; }'
ok(!formAligned(legacyCss), '对照：旧 CSS（输入框无宽度）时表单不对齐')
ok(formAligned(cssRules), '新 CSS 让输入框与登录按钮同宽等高')
ok(/\.auth-box\s*\{[^}]*position\s*:\s*relative[^}]*z-index\s*:\s*1/.test(cssRules),
  '卡片抬到背景纹理之上（不会被伪元素盖住）')
ok(/<label class="field"><span>账号<\/span><input class="input" id="authName"/.test(html),
  '登录表单仍用 .field/.input 结构（宽度规则能命中）')
ok(/id="btnAuthLogin" style="width:100%"/.test(html), '登录按钮保持满宽')

console.log('--- ② 背景：不再是纯色，五套预设 + 自定义图片 ---')
const authLayerRule = /\.auth-layer\s*\{([^}]*)\}/.exec(cssRules)
ok(authLayerRule && /linear-gradient/.test(authLayerRule[1]) && /radial-gradient/.test(authLayerRule[1]),
  '默认背景改为渐变（含两处光晕），不再是 background: var(--bg) 纯色')
ok(!/\{\s*background\s*:\s*var\(--bg\)\s*;?\s*\}/.test(authLayerRule ? authLayerRule[0] : ''),
  '登录层规则里已无纯色兜底')
for (const p of bg.PRESETS) {
  ok(new RegExp('html\\[data-auth-bg="' + p + '"\\]\\s+\\.auth-layer').test(cssRules), '预设样式存在：' + p)
  ok(new RegExp('data-bg="' + p + '"').test(html), '预设按钮存在：' + p)
}
// 默认背景是否被浅色主题冲淡：旧实现有一条 light 覆盖 --auth-l 的规则，会把深蓝渐变变浅
function defaultStaysDark(text) {
  const layer = /\.auth-layer\s*\{([^}]*)\}/.exec(text)
  if (!layer || !/--auth-l\s*:\s*13%/.test(layer[1])) return false
  if (/html\[data-theme="light"\]\s+\.auth-layer\s*\{[^}]*--auth-l/.test(text)) return false
  return /--card\s*:\s*#1c1f27/.test(layer[1])
}
const legacyDarkCss = '.auth-layer { --auth-l: 13%; } html[data-theme="light"] .auth-layer { --auth-l: 90%; }'
ok(!defaultStaysDark(legacyDarkCss), '对照：旧 CSS 在浅色主题下会把默认背景冲淡成白色')
ok(defaultStaysDark(cssRules), '默认极光背景与卡片固定深色，浅色主题也保持这张图')
ok(/html\[data-theme="light"\]\[data-auth-bg="plain"\]/.test(cssRules), '「纯净」预设仍可回到浅色主题原色')
ok(/html\[data-theme="light"\]\s+\.auth-bg-toggle/.test(cssRules), '浅色主题下背景按钮仍清晰可读')
ok(/html\[data-auth-bg="custom"\][^{]*\{[^}]*--auth-custom/.test(cssRules), '自定义图片走 --auth-custom 变量')
ok(/html\[data-auth-bg="custom"\]\s+\.auth-layer::after/.test(cssRules), '自定义图片叠暗罩保证卡片可读')
ok(/html\[data-auth-bg="plain"\]\s+\.auth-layer::before\s*\{\s*display:\s*none/.test(cssRules), '「纯净」预设关闭网格纹理')

console.log('--- ③ 背景面板 DOM 契约 ---')
for (const id of ['btnAuthBg', 'authBgPanel', 'btnAuthBgClose', 'authBgFile', 'authBgUrl', 'btnAuthBgApply', 'btnAuthBgReset', 'authBgMsg']) {
  ok(new RegExp('id="' + id + '"').test(html), '面板元素存在：' + id)
}
ok(/id="authBgPanel" hidden>/.test(html), '背景面板默认隐藏')
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1])
const dup = ids.filter((x, i) => ids.indexOf(x) !== i)
ok(dup.length === 0, 'index.html 仍无重复 id' + (dup.length ? '（重复：' + [...new Set(dup)].join(',') + '）' : ''))
ok(/<div class="auth-layer" id="authLayer" hidden>/.test(html), '登录层初始 hidden 未被改动')
ok(/\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/.test(cssRules), '[hidden] 规则仍在（面板能被关掉）')

console.log('--- ④ 图片地址安全过滤 ---')
const goodUrl = 'https://example.com/pic/bg.jpg?w=1200'
ok(bg.sanitizeImageUrl(goodUrl) === goodUrl, '接受 https 图片地址')
ok(bg.sanitizeImageUrl('http://192.168.1.246:8080/a.png') !== null, '接受 http 内网图片地址')
ok(bg.sanitizeImageUrl('data:image/png;base64,iVBORw0KGgo=') !== null, '接受图片 data URL（本地上传用）')
for (const bad of [
  'javascript:alert(1)',
  'data:text/html;base64,PHNjcmlwdD4=',
  'https://x.com/a.jpg");color:red;--x:url(',
  "https://x.com/a.jpg'",
  'https://x.com/a b.jpg',
  'https://x.com/a\\b.jpg',
  'ftp://x.com/a.jpg',
  '', null, 42, 'x'.repeat(bg.MAX_DATA + 1)
]) {
  ok(bg.sanitizeImageUrl(bad) === null, '拒绝不安全地址：' + String(bad).slice(0, 46))
}

console.log('--- ⑤ 偏好持久化容错与首屏应用 ---')
ok(bg.STORE_KEY === 'lxh-auth-bg', '存储 key 固定')
ok(JSON.stringify(bg.normalizeBgSetting('{坏 JSON')) === JSON.stringify({ mode: 'preset', preset: 'aurora' }), '坏 JSON 退回默认')
ok(bg.normalizeBgSetting({ mode: 'preset', preset: '不存在' }).preset === 'aurora', '未知预设退回默认')
ok(bg.normalizeBgSetting({ mode: 'image', image: 'javascript:1' }).mode === 'preset', '非法图片退回默认')
ok(bg.normalizeBgSetting({ mode: 'preset', preset: 'mint' }).preset === 'mint', '合法预设保留')
const saved = bg.normalizeBgSetting({ mode: 'image', image: goodUrl })
ok(saved.mode === 'image' && saved.image === goodUrl, '合法图片地址保留')
const fakeRoot = {
  dataset: {},
  style: {
    _v: {},
    setProperty(k, v) { this._v[k] = v },
    removeProperty(k) { delete this._v[k] }
  }
}
bg.applySetting(saved, fakeRoot)
ok(fakeRoot.dataset.authBg === 'custom' && fakeRoot.style._v['--auth-custom'] === 'url("' + goodUrl + '")',
  '应用图片设置时写 data-auth-bg 与 --auth-custom')
bg.applySetting({ mode: 'preset', preset: 'dawn' }, fakeRoot)
ok(fakeRoot.dataset.authBg === 'dawn' && !fakeRoot.style._v['--auth-custom'], '切回预设时清掉自定义图片')

console.log('--- ⑥ 资源引入与缓存戳 ---')
const head = html.slice(0, html.indexOf('</head>'))
ok(/<script src="auth-bg\.js\?v=\d+"><\/script>/.test(head), 'auth-bg.js 在 head 同步引入（首屏不闪默认背景）')
ok(/styles\.css\?v=(\d+)/.test(head) && Number(/styles\.css\?v=(\d+)/.exec(head)[1]) >= 11, 'CSS 缓存戳已 bump')
ok(pkg.scripts.test.includes('auth-bg-ui.test.js'), '新测试已注册进 npm test')
ok(fs.existsSync(path.join(renderer, 'auth-bg.js')), '静态资源 auth-bg.js 存在（web.js 按目录直出 .js）')

console.log(`\nauth-bg-ui.test.js: PASS ${pass} / FAIL 0`)
