'use strict'
/**
 * P-1429 加固项（2026-11-12 随机测试报告的修复）：
 *  ① /api/config 明文凭据 → 非管理员剥离 + POST 仅管理员
 *  ② sendJson / staticHandler 协商 gzip
 *  ③ store._write 原子写（tmp + rename），写坏不再可能
 *  ④ 静态资源 ETag/304
 *  ⑤ X-Lxh-Error 业务失败标记（监控可识别，状态码契约不变）
 *  ⑥ 恢复 requestTimeout/headersTimeout 默认（ Slowloris 防线）
 *  ⑦ 安全基线响应头
 * web.js 会 listen，不能直接 require —— 服务端部分用源码契约断言；
 * store 部分做真实行为测试。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

let pass = 0
const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log('  PASS', label) }

const webSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'web.js'), 'utf8')
const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'store.js'), 'utf8')
const authSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'auth.js'), 'utf8')
const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'auth-bg.js'), 'utf8')

console.log('--- ① /api/config 凭据不外泄 ---')
ok(/function sanitizeConfig\(cfg\)/.test(webSrc), 'sanitizeConfig 已定义')
ok(/config: isAdmin \? store\.config : sanitizeConfig\(store\.config\)/.test(webSrc), 'GET config 非管理员拿掩码版')
ok(/c\.adminPassword = ''/.test(webSrc) && /c\.ghToken = ''/.test(webSrc), '剥离 adminPassword 与 ghToken')
ok(/platforms\.map\(p => Object\.assign\(\{\}, p, \{ password: '' \}\)\)/.test(webSrc), '剥离各平台 password')
ok(/仅管理员可修改配置/.test(webSrc) && /route\('POST', '\/api\/config'[\s\S]{0,400}仅管理员可修改配置/.test(webSrc), 'POST config 仅管理员')

console.log('--- ② 协商 gzip ---')
ok(/require\('zlib'\)/.test(webSrc), '引入 zlib')
ok(/gzipSync\(body\)/.test(webSrc) && /Content-Encoding.*gzip/.test(webSrc), 'sendJson 大响应 gzip')
ok(/body\.length > 1024/.test(webSrc), '小响应不压（<1KB）')
ok(/zlib\.gzipSync\(cached\.data\)/.test(webSrc) && /javascript\|css\|html\|svg\|json/.test(webSrc), '静态资源文本类 gzip、二进制不压')

console.log('--- ③ store._write 原子写 ---')
ok(/renameSync\(tmp, f\)/.test(storeSrc) && /const tmp = f \+ '\.tmp'/.test(storeSrc), 'tmp + rename 两步写')
ok(/catch \(e1\)/.test(storeSrc) && /writeFileSync\(f, JSON\.stringify\(obj\)/.test(storeSrc), 'rename 失败回退直接写（不比旧行为差）')
;(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-atomic-'))
  const mod = require(path.join(__dirname, '..', 'src', 'core', 'store.js'))
  const s = new mod.Store(dir)
  s.config.ghToken = 'tok-1'
  ok(s.saveConfig({}) === true, 'saveConfig 成功')
  ok(JSON.parse(fs.readFileSync(s.configFile, 'utf8')).ghToken === 'tok-1', '内容完整可读回')
  ok(!fs.existsSync(s.configFile + '.tmp'), 'rename 后无 .tmp 残留')
  fs.rmSync(dir, { recursive: true, force: true })
})()

console.log('--- ④⑤⑥⑦ ETag / X-Lxh-Error / 超时 / 安全头 ---')
ok(/if-none-match.*=== etag/.test(webSrc) && /res\.writeHead\(304, \{ ETag: etag \}\)/.test(webSrc), 'If-None-Match 命中回 304')
ok(/ETag: etag/.test(webSrc), '响应携带 ETag')
ok(/X-Lxh-Error.*'1'/.test(webSrc) || /setHeader\('X-Lxh-Error', '1'\)/.test(webSrc), '业务失败带 X-Lxh-Error 头（监控可识别）')
ok(/server\.requestTimeout = 300000/.test(webSrc) && /server\.headersTimeout = 60000/.test(webSrc), '超时恢复默认（Slowloris 防线回来了）')
ok(/X-Content-Type-Options.*nosniff/.test(webSrc) && /X-Frame-Options.*SAMEORIGIN/.test(webSrc) && /Referrer-Policy.*no-referrer/.test(webSrc), '三个安全基线响应头')
ok(/"public" 指"公开音源"，不是"免鉴权"/.test(webSrc), 'list/public 命名歧义已注释说明')
ok(/建议混合字母、数字与符号/.test(authSrc), '密码文案带强度建议（规则未强改）')

console.log('--- ⑧ auth-bg.js 解析开销优化（一次读取传参）---')
ok(/function readSetting\(cachedLib\)/.test(bgSrc), 'readSetting 支持传入已解析的库')
ok(/function applySetting\(setting, root, nonce, cachedLib\)/.test(bgSrc), 'applySetting 支持 cachedLib')
ok(/function renderLib\(activeId, cachedLib\)/.test(bgSrc) && /function syncFoot\(v, cachedLib\)/.test(bgSrc), '渲染链支持 cachedLib')
ok(/const lib = readLib\(\)\n      const v = readSetting\(lib\)/.test(bgSrc), 'refreshAll 只解析一次')
ok(!/renderHead\(readLib\(\)/.test(bgSrc), 'renderHead 不再自己重新读库（调用方传 lib）')
ok(!/findItem\(null, v\.itemId\) : null/.test(bgSrc), 'syncFoot 用传入的库（不再 readLib）')
ok(/applySetting\(v, null, freshNonce\(\), lib\)/.test(bgSrc), 'activate 的 applySetting 复用 lib')

console.log('--- ⑫ P-1429 #6：patrolDisableAfter 暴露到设置页 ---')
ok(/patrolDisableAfter: 2,/.test(storeSrc), 'store 默认 patrolDisableAfter=2（原先无此键恒隐藏 2）')
ok(/id="cfgPatrolDisableAfter" type="number" min="1" max="20"/.test(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8')), '设置页已暴露自动禁用阈值')
ok(/patrolDisableAfter: Math\.max\(1, Math\.min\(20/.test(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8')), '保存链路带范围钳制（1-20）')
ok(/自动禁用.*先于.*自动删除|禁用次数应 ≤ 删除次数/.test(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8')), '页面说明「先禁后删」次序')

console.log(`\nsecurity-hardening: PASS ${pass} / FAIL 0`)
