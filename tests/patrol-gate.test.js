// 巡检闸门：全平台因网络原因失败时必须「不禁用」
const { isLocalNetworkIssue } = require('../src/core/checker')
let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }
const shouldNotDisable = [
  '沙箱 fetch 失败: fetch failed ← getaddrinfo ENOTFOUND api.x.com [https://api.x.com/s]',
  '沙箱 fetch 失败: fetch failed ← unable to get local issuer certificate [https://a.cn]',
  '沙箱 fetch 失败: 请求超时 8000ms [https://a.cn]',
  '沙箱 fetch 失败: fetch failed ← connect ECONNREFUSED 127.0.0.1:7890 [https://a.cn]',
  'HTTP 403',
  'HTTP 429',
  '沙箱 fetch 失败: fetch failed ← socket hang up [https://a.cn]'
]
shouldNotDisable.forEach(m => ck('不禁用: ' + m.slice(0, 46), isLocalNetworkIssue(m) === true))
const mayDisable = ['返回空链接', '私有/本地地址，疑似假链接', '未匹配到歌曲', '接口返回：{}']
mayDisable.forEach(m => ck('非网络原因放行: ' + m, isLocalNetworkIssue(m) === false))
console.log('\n' + (bad === 0 ? 'ALL PASS' : bad + ' FAILED'))
process.exit(bad ? 1 : 0)
