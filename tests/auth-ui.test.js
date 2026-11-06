'use strict'
/**
 * v1.10.1-beta.2 回归：登录层 hidden 属性被 CSS 覆盖导致「登录后页面没反应」。
 *
 * 根因：index.html 用 HTML `hidden` 属性控制显隐，而 .auth-layer 自带
 * `display:flex`（作者样式）。UA 的 `[hidden]{display:none}` 优先级低于作者样式，
 * 且旧 styles.css 里没有任何 [hidden] 规则 → 登录层永远盖住页面，
 * hideAuth() 只改属性、视觉上毫无变化。
 *
 * 本测试既验证修复，也验证「修复前确实会失败」（防止退化成无效断言）。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const renderer = path.join(__dirname, '..', 'src', 'renderer')
const css = fs.readFileSync(path.join(renderer, 'styles.css'), 'utf8')
// CSS 注释里也会出现选择器示例，判定规则前必须剥离，否则会误判
const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, '')
const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8')
const app = fs.readFileSync(path.join(renderer, 'app.js'), 'utf8')
const bridge = fs.readFileSync(path.join(renderer, 'web-bridge.js'), 'utf8')

let pass = 0
const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log('  PASS', label) }

// 判定「hidden 属性能否盖过 .auth-layer 的 display:flex」：
// 只有带 !important 的 [hidden] 规则才能赢；UA 默认规则必输。
function hiddenWins(text) {
  const m = /\[hidden\]\s*\{([^}]*)\}/.exec(text)
  if (!m) return false // 只有 UA 的 [hidden]{display:none}，被作者样式覆盖
  return /display\s*:\s*none\s*!important/i.test(m[1])
}

console.log('--- ① CSS 级联：修复前必败 / 修复后必胜 ---')
const legacyCss = '.auth-layer { position: fixed; inset: 0; z-index: 999; display: flex; }'
ok(!hiddenWins(legacyCss), '对照：旧 CSS（无 [hidden] 规则）时登录层关不掉')
ok(hiddenWins(cssRules), '新 CSS 含 [hidden]{display:none!important}')
ok(/\.auth-layer\s*\{[^}]*display\s*:\s*flex/.test(cssRules), '登录层仍是 flex 布局（说明级联冲突真实存在）')
ok(cssRules.indexOf('[hidden]') < cssRules.indexOf('.auth-layer'), '[hidden] 规则定义在登录层样式之前')

console.log('--- ② 登录层 DOM 与显隐契约 ---')
ok(/<div class="auth-layer" id="authLayer" hidden>/.test(html), '登录层初始带 hidden 属性')
ok(/id="authLoginBox"[^>]*>/.test(html) && /id="authRegBox" hidden>/.test(html), '登录/注册两个表单默认互斥')
ok(/id="btnAuthLogin"/.test(html) && /id="btnAuthReg"/.test(html), '登录与注册按钮存在')
ok(/id="authErr" hidden>/.test(html), '错误提示默认隐藏')
ok(/layer\.hidden = false/.test(app) && /layer\.hidden = true/.test(app), 'showAuth/hideAuth 通过 hidden 属性切换')

console.log('--- ③ DOM id 唯一（重复 id 会让第二个按钮绑不上事件） ---')
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1])
const dup = ids.filter((x, i) => ids.indexOf(x) !== i)
ok(dup.length === 0, 'index.html 无重复 id' + (dup.length ? '（重复：' + [...new Set(dup)].join(',') + '）' : ''))
ok(/id="btnLogoutTop"/.test(html) && /id="btnLogout"/.test(html), '侧边栏与设置页两个退出按钮 id 不同')
ok(/'btnLogout', 'btnLogoutTop'/.test(app), 'app.js 同时绑定两个退出按钮')

console.log('--- ④ Web/桌面标记与静态资源版本 ---')
const returnAt = bridge.indexOf('if (window.api) return')
const markAt = bridge.indexOf('window.LXH_WEB = true')
ok(returnAt > -1 && markAt > returnAt, 'LXH_WEB 标记放在桌面版 return 之后（桌面版不被误标）')
ok(/authLogin\s*:/.test(bridge) && /authState\s*:/.test(bridge), 'Web 桥接仍暴露登录接口')
const cssVer = /styles\.css\?v=(\d+)/.exec(html)
ok(cssVer && Number(cssVer[1]) >= 10, 'index.html 已 bump CSS 版本号（浏览器不会用旧缓存）')
for (const f of ['styles.css', 'index.html', 'app.js', 'web-bridge.js']) {
  ok(fs.existsSync(path.join(renderer, f)), '静态文件存在：' + f)
}

console.log(`\nauth-ui.test.js: PASS ${pass} / FAIL 0`)
