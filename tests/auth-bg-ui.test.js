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
ok(defaultStaysDark(cssRules), '默认暖阳背景与卡片固定深色，浅色主题也保持这张图')
const layerVars = /\.auth-layer\s*\{([^}]*)\}/.exec(cssRules)[1]
ok(/--auth-h1\s*:\s*20\s*;/.test(layerVars) && /--auth-h2\s*:\s*334/.test(layerVars) && /--auth-s\s*:\s*52%/.test(layerVars),
  '首屏默认色相就是暖阳，JS 执行前不会先闪极光')
ok(/html\[data-auth-bg="dawn"\][^{]*\{[^}]*--auth-h1\s*:\s*20/.test(cssRules), '暖阳预设与默认值一致')
ok(/html\[data-auth-bg="aurora"\][^{]*\{[^}]*--auth-h1\s*:\s*222/.test(cssRules), '极光仍作为可选预设保留')
ok(/html\[data-theme="light"\]\[data-auth-bg="plain"\]/.test(cssRules), '「纯净」预设仍可回到浅色主题原色')
ok(/html\[data-theme="light"\]\s+\.auth-bg-toggle/.test(cssRules), '浅色主题下背景按钮仍清晰可读')
ok(/html\[data-auth-bg="custom"\][^{]*\{[^}]*--auth-custom/.test(cssRules), '自定义图片走 --auth-custom 变量')
ok(/html\[data-auth-bg="custom"\]\s+\.auth-layer::after/.test(cssRules), '自定义图片叠暗罩保证卡片可读')
ok(/html\[data-auth-bg="plain"\]\s+\.auth-layer::before\s*\{\s*display:\s*none/.test(cssRules), '「纯净」预设关闭网格纹理')

console.log('--- ③ 背景面板 DOM 契约 ---')
for (const id of ['btnAuthBg', 'authBgPanel', 'btnAuthBgClose', 'authBgFile', 'authBgUrl', 'btnAuthBgApply', 'btnAuthBgNext', 'btnAuthBgReset', 'authBgMsg']) {
  ok(new RegExp('id="' + id + '"').test(html), '面板元素存在：' + id)
}
ok(/data-bg="dawn" aria-pressed="true"/.test(html), 'HTML 初始选中态也是暖阳')
ok(/class="auth-bg-note"/.test(html) && /随机图接口/.test(html), '面板说明写清随机图接口与自动换图')
ok(!/<label class="auth-bg-label"[^>]*>[^<]*[（(]/.test(html), '功能标签不带括号标注')
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
ok(JSON.stringify(bg.normalizeBgSetting('{坏 JSON')) === JSON.stringify({ mode: 'preset', preset: bg.DEFAULT_PRESET }), '坏 JSON 退回默认暖阳')
ok(bg.DEFAULT_PRESET === 'dawn', '默认预设常量固定为暖阳')
ok(bg.normalizeBgSetting({ mode: 'preset', preset: '不存在' }).preset === 'dawn', '未知预设退回默认')
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

console.log('--- ⑥ 随机图 API 地址：带参数、跳转、缓存穿透 ---')
const apiUrl = 'https://img.xjh.me/random_img.php?type=bg&ctype=acg&return=302'
ok(bg.sanitizeImageUrl(apiUrl) === apiUrl, '带查询参数的随机图接口原样放行')
ok(bg.sanitizeImageUrl('http://192.168.1.246:8191/random.php?return=302') !== null, '内网 http 随机图接口也放行')
for (const bad of [
  'https://a.com/random.php?x=1");color:red;--y:url(',
  'https://a.com/random.php?x=1\u0000',
  'javascript:fetch(1)',
  'data:text/html;base64,PHNjcmlwdD4='
]) ok(bg.sanitizeImageUrl(bad) === null, '带参数的注入地址仍被拒绝：' + bad.slice(0, 42))
ok(bg.cacheBustedUrl('https://a.com/bg.jpg', 'n1') === 'https://a.com/bg.jpg?_lxh=n1', '无参数地址用 ? 追加一次性参数')
ok(bg.cacheBustedUrl(apiUrl, 'n2') === apiUrl + '&_lxh=n2', '已有参数的地址用 & 追加')
ok(bg.cacheBustedUrl('https://a.com/p?x=1#top', 'n3') === 'https://a.com/p?x=1&_lxh=n3#top', '参数加在 fragment 之前')
ok(bg.cacheBustedUrl('data:image/png;base64,iVBORw0KGgo=', 'n1').startsWith('data:'), 'data URL 不追加参数')
ok(bg.cacheBustedUrl(apiUrl, '') === apiUrl && bg.cacheBustedUrl(apiUrl) === apiUrl, '无 nonce 时保持原地址')
ok(bg.cacheBustedUrl(apiUrl, 'a b"c') === apiUrl + '&_lxh=a%20b%22c', 'nonce 被编码，不会闭合 CSS 字符串')
ok(/^[0-9a-z]+$/.test(bg.freshNonce()), 'nonce 只含安全字符')
ok(bg.forRender({ mode: 'image', image: apiUrl }, 'n9').image === apiUrl + '&_lxh=n9', 'forRender 产出本次渲染地址')
ok(bg.normalizeBgSetting({ mode: 'image', image: apiUrl }).image === apiUrl, '保存的设置仍是原始地址，不会积累 nonce')
bg.applySetting({ mode: 'image', image: apiUrl }, fakeRoot, 'n7')
ok(fakeRoot.style._v['--auth-custom'] === 'url("' + apiUrl + '&_lxh=n7' + '")', '渲染时 CSS 变量写带一次性参数的地址')
let probeFlag = 'unset'
bg.probeImage(apiUrl, f => { probeFlag = f })
ok(probeFlag === null, 'Node 环境无 Image 时探测静默降级，不误报失败')

console.log('--- ⑦ 资源引入与缓存戳 ---')
const head = html.slice(0, html.indexOf('</head>'))
ok(/<script src="auth-bg\.js\?v=(\d+)"><\/script>/.test(head) && Number(/auth-bg\.js\?v=(\d+)/.exec(head)[1]) >= 2,
  'auth-bg.js 缓存戳已 bump，并在 head 同步引入（首屏不闪默认背景）')
ok(/styles\.css\?v=(\d+)/.test(head) && Number(/styles\.css\?v=(\d+)/.exec(head)[1]) >= 12, 'CSS 缓存戳已 bump')
ok(pkg.scripts.test.includes('auth-bg-ui.test.js'), '新测试已注册进 npm test')
ok(fs.existsSync(path.join(renderer, 'auth-bg.js')), '静态资源 auth-bg.js 存在（web.js 按目录直出 .js）')

console.log(`\nauth-bg-ui.test.js: PASS ${pass} / FAIL 0`)
