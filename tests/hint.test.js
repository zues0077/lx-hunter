const { sameReasonHint } = require('../src/core/checker')
let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }
const cases = [
  ['沙箱 fetch 失败: fetch failed ← getaddrinfo ENOTFOUND api.xyz.com [https://api.xyz.com/?a=1]', /域名解析失败/],
  ['沙箱 fetch 失败: fetch failed ← unable to get local issuer certificate [https://a.cn]', /证书校验失败/],
  ['沙箱 fetch 失败: fetch failed ← connect ECONNREFUSED 127.0.0.1:7890 [https://a.cn]', /连接被拒绝/],
  ['沙箱 fetch 失败: 请求超时 8000ms [https://a.cn]', /请求超时/],
  ['HTTP 403', /鉴权|403/],
  ['返回空链接', /所有平台报同一个错/]
]
cases.forEach(([m, re]) => {
  const h = sameReasonHint(m)
  ck('提示可行动: ' + m.slice(0, 50), re.test(h), h.slice(0, 80))
})
console.log('\n' + (bad === 0 ? 'ALL PASS' : bad + ' FAILED'))
process.exit(bad ? 1 : 0)
