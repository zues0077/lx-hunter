// v1.11.0 代理策略 / 健康熔断专项测试
// 零外网依赖：本地起一个「假代理」（按请求行是绝对 URI 还是相对路径区分经代理 / 直连）
// 与一个本地目标站；所有外网目标都只发给假代理，不真正出网。
'use strict'
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')
const net = require(path.join(__dirname, '..', 'src', 'core', 'net.js'))
const { Store } = require(path.join(__dirname, '..', 'src', 'core', 'store.js'))

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const RAW = 'https://raw.githubusercontent.com/owner/repo/HEAD/a.js'

function startStub() {
  const state = { absolute: 0, relative: 0, fail: false }
  const s = http.createServer((req, res) => {
    if (/^https?:\/\//i.test(req.url)) {
      state.absolute++
      if (state.fail) { req.socket.destroy(); return }   // 模拟代理连接层故障
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': 10 })
      res.end('PROXY_HIT!')
    } else {
      state.relative++
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': 11 })
      res.end('DIRECT_HIT!')
    }
  })
  return new Promise(r => s.listen(0, '127.0.0.1', () => r({
    server: s, url: 'http://127.0.0.1:' + s.address().port,
    siteUrl: 'http://127.0.0.1:' + s.address().port + '/x', state
  })))
}

;(async () => {
  const stub = await startStub()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-proxy-'))
  try {
    // ---------- 1. 三态策略：候选链与代理入口 ----------
    net.resetProxyHealth()
    net.applyConfig({ crawlProxy: stub.url, proxyPolicy: 'off', useJsdelivr: true })
    let c = net.buildCandidates(RAW, 'auto')
    ck('off：GitHub 候选链不含 proxy 且首条是直连', !c.some(x => x.id === 'proxy') && c[0].id === 'direct')
    const absOff = stub.state.absolute
    ck('off：managedProxyFetch 直接拒绝且不发起任何连接',
      (await net.managedProxyFetch('http://example.com/a.js', {}, 1000)) === null && stub.state.absolute === absOff)
    ck('off：健康状态标记为 off', net.getProxyHealth().state === 'off')

    net.applyConfig({ crawlProxy: stub.url, proxyPolicy: 'auto' })
    c = net.buildCandidates(RAW, 'auto')
    ck('auto：GitHub 候选链仍不含 proxy（保持升级前行为）', !c.some(x => x.id === 'proxy') && c[0].id === 'direct')
    const absAuto = stub.state.absolute
    const rAuto = await net.fetchAuto('http://example.com/auto.js', {}, 2000)
    ck('auto：第三方外网站点走代理并取回内容',
      stub.state.absolute === absAuto + 1 && (await rAuto.text()) === 'PROXY_HIT!')

    net.applyConfig({ crawlProxy: stub.url, proxyPolicy: 'force' })
    c = net.buildCandidates(RAW, 'auto')
    ck('force：代理排到 GitHub 候选链最前', c[0].id === 'proxy' && c[0].url === RAW)

    // 内网目标一律直连，连 force 也不走代理
    const absLan = stub.state.absolute
    const rLan = await net.fetchAuto(stub.siteUrl, {}, 2000)
    ck('内网目标：force 策略下也一律直连',
      stub.state.absolute === absLan && (await rLan.text()) === 'DIRECT_HIT!' && net.isLanHost(stub.siteUrl))

    // ---------- 2. 配置兼容与迁移 ----------
    net.applyConfig({ crawlProxy: stub.url, forceProxy: true })
    ck('旧调用只传 forceProxy=true → 推导为 force', net.getProxyHealth().policy === 'force')
    net.applyConfig({ proxyPolicy: 'off', forceProxy: true })
    ck('proxyPolicy 优先于 forceProxy', net.getProxyHealth().policy === 'off')
    net.applyConfig({ crawlProxy: stub.url, proxyPolicy: 'auto' })

    const st = new Store(tmp)
    ck('store 默认 proxyPolicy=auto / forceProxy=false',
      st.config.proxyPolicy === 'auto' && st.config.forceProxy === false)
    st.saveConfig({ proxyPolicy: 'force' })
    ck('saveConfig 写 proxyPolicy 时同步 forceProxy', st.config.forceProxy === true)
    st.saveConfig({ forceProxy: false })
    ck('saveConfig 只写旧 forceProxy 时同步 proxyPolicy', st.config.proxyPolicy === 'auto')
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ forceProxy: true, crawlProxy: 'http://x:1' }))
    const st2 = new Store(tmp)
    ck('旧配置（无 proxyPolicy + forceProxy=true）升级后迁移为 force', st2.config.proxyPolicy === 'force')

    // ---------- 3. 健康熔断（P-0850 思路） ----------
    net.resetProxyHealth()
    net.applyConfig({ crawlProxy: stub.url, proxyPolicy: 'auto' })
    ck('健康态给完整超时预算（不误杀慢代理）', net.proxyAttemptBudget(15000) === 15000)
    stub.state.fail = true
    const abs0 = stub.state.absolute
    for (let i = 0; i < 3; i++) {
      const got = await net.managedProxyFetch('http://example.com/fail.js', {}, 1000)
      if (got !== null) ck('第 ' + (i + 1) + ' 次代理失败应返回 null', false)
    }
    const h = net.getProxyHealth()
    ck('连续 3 次失败触发熔断（state=cooldown）', h.state === 'cooldown' && h.fails === 3)
    ck('3 次失败各发起 1 次代理连接', stub.state.absolute - abs0 === 3)
    ck('熔断后剩余冷却约 5 分钟', h.cooldownRemainingMs > 4 * 60 * 1000 && h.cooldownRemainingMs <= 5 * 60 * 1000)
    const abs1 = stub.state.absolute
    const gotSkip = await net.managedProxyFetch('http://example.com/fail.js', {}, 1000)
    ck('冷却期间跳过代理、0 次连接（不再逐请求白撞）',
      gotSkip === null && stub.state.absolute === abs1)
    net.applyConfig({ proxyPolicy: 'force' })
    ck('冷却期间 force 候选链也不生成 proxy 通道', !net.buildCandidates(RAW, 'auto').some(x => x.id === 'proxy'))
    ck('失败过/可疑态收紧为短预算', net.proxyAttemptBudget(15000) === 4000 && net.proxyAttemptBudget(6000) === 2000)

    // 半开探测：把时钟推过冷却，验证一次成功后恢复
    const realNow = Date.now
    try {
      Date.now = () => realNow() + 6 * 60 * 1000
      ck('冷却到期进入 half-open', net.getProxyHealth().state === 'half-open')
      stub.state.fail = false
      const gotHalf = await net.managedProxyFetch('http://example.com/ok.js', {}, 1000)
      const h2 = net.getProxyHealth()
      ck('半开探测成功 → 恢复 healthy 且失败计数清零',
        !!gotHalf && h2.state === 'healthy' && h2.fails === 0 && h2.cooldownRemainingMs === 0)
    } finally {
      Date.now = realNow
    }

    // ---------- 4. 探测口径与手动恢复 ----------
    net.resetProxyHealth()
    net.applyConfig({ crawlProxy: stub.url, proxyPolicy: 'auto' })
    net.applyConfig({ proxyPolicy: 'auto' })
    const tForce = await net.testNetwork({
      url: stub.siteUrl, crawlProxy: stub.url, proxyPolicy: 'force', mirror: 'direct', timeoutMs: 1500
    })
    ck('testNetwork：force 快照下报告 proxy 通道', (tForce.attempts || []).some(a => a.mirror === 'proxy'))
    ck('testNetwork：返回 proxyPolicy 与 proxyHealth',
      tForce.proxyPolicy === 'force' && !!tForce.proxyHealth && !!tForce.proxyHealth.state)
    const tOff = await net.testNetwork({
      url: stub.siteUrl, crawlProxy: stub.url, proxyPolicy: 'off', mirror: 'direct', timeoutMs: 1500
    })
    ck('testNetwork：off 快照下不含 proxy 通道', !(tOff.attempts || []).some(a => a.mirror === 'proxy'))
    ck('testNetwork 不污染全局策略', net.getProxyHealth().policy === 'auto')

    stub.state.fail = true
    net.resetProxyHealth()
    for (let i = 0; i < 3; i++) await net.managedProxyFetch('http://example.com/fail2.js', {}, 1000)
    ck('手动恢复前处于熔断', net.getProxyHealth().state === 'cooldown')
    stub.state.fail = false
    const pr = await net.testProxy({ proxy: stub.url, url: stub.siteUrl, timeoutMs: 2000 })
    ck('「测试代理」成功可手动解除熔断',
      pr.ok === true && pr.healthReset === true && net.getProxyHealth().state === 'healthy')
    net.resetProxyHealth()
    ck('resetProxyHealth 清空计数与冷却', net.getProxyHealth().fails === 0 && net.getProxyHealth().state === 'healthy')

    // ---------- 5. 文案 / 三端透传 / 缓存戳 ----------
    const html = read('src/renderer/index.html')
    const app = read('src/renderer/app.js')
    const web = read('src/server/web.js')
    const main = read('src/main/index.js')
    const preload = read('src/main/preload.js')
    const bridge = read('src/renderer/web-bridge.js')
    const storeSrc = read('src/core/store.js')
    const netSrc = read('src/core/net.js')
    ck('设置页三态下拉 / 健康提示 / 手动恢复按钮齐备',
      html.includes('id="cfgProxyPolicy"') && html.includes('id="proxyHealthTip"') && html.includes('id="btnProxyHealthReset"'))
    ck('文案写明适用范围（GitHub + 第三方站点）与熔断规则',
      html.includes('第三方站点') && html.includes('连续失败 3 次') && html.includes('任何链路都不用代理'))
    ck('旧错误文案「只用于 GitHub 爬取」已清除',
      !html.includes('爬取代理只用于 GitHub 爬取') && !netSrc.includes('仅作用于 GitHub 爬取链') && !storeSrc.includes('仅作用于 GitHub 爬取链'))
    ck('app.js 三态提交 + 健康刷新/重置',
      app.includes('proxyPolicy: $(\'cfgProxyPolicy\')') && app.includes('function refreshProxyHealth') &&
      app.includes('api.proxyHealth()') && app.includes('api.proxyHealthReset()'))
    ck('Web / 桌面 / preload / bridge 四端透传健康查询与重置',
      web.includes('/api/net/proxy-health') && web.includes('/api/net/proxy-health/reset') &&
      main.includes('net:proxyHealth') && main.includes('net:proxyHealthReset') &&
      preload.includes('proxyHealth') && bridge.includes('/api/net/proxy-health'))
    ck('store 默认含 proxyPolicy', storeSrc.includes("proxyPolicy: 'auto'"))
    ck('缓存戳 v66 / v57 / v20',
      html.includes('app.js?v=68') && html.includes('web-bridge.js?v=57') && html.includes('styles.css?v=20'))

    console.log(`\n${bad ? 'FAIL（失败 ' + bad + ' 项）' : 'ALL PASS'}`)
  } catch (e) {
    console.error('测试异常：', e)
    bad++
  } finally {
    stub.server.close()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (e) {}
    process.exit(bad ? 1 : 0)
  }
})()
