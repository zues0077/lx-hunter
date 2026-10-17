/**
 * v1.9.10 接口域名抽取（extractApiHosts）+ 可选存活探测（probeApiHosts）回归测试。
 * 借鉴 lxhub 的 api_hosts / api_alive：从脚本里抓出后端域名，可选探活，后端全挂的音源提前标记。
 */
const { extractApiHosts, probeApiHosts } = require('../src/core/checker')

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }

;(async () => {
  // ---------- extractApiHosts ----------
  const code = [
    "const api = 'https://api.music-abc.com/music/search';",
    "lx.request({ url: 'http://cdn.xxx.cn/v1/get', method: 'get' });",
    "const doc = 'https://github.com/foo/bar';",          // 噪声：github 自身应被过滤
    "const lib = 'https://cdn.jsdelivr.net/npm/x';",       // 噪声：jsdelivr 应被过滤
    "const dup = 'https://API.MUSIC-ABC.com/other';",     // 与首条同主机（大小写归一）应去重
    "const pic = 'https://img.foo.png/x.jpg';",           // 噪声：图片域名后缀应被过滤
    "const safe = 'https://secure-music.example.org/play';"
  ].join('\n')
  const hosts = extractApiHosts(code)
  ck('抽取到接口域名（去重+大小写归一）', hosts.includes('api.music-abc.com') && hosts.includes('cdn.xxx.cn') && hosts.includes('secure-music.example.org'), hosts.join(','))
  ck('过滤 github 自身', !hosts.includes('github.com'))
  ck('过滤 jsdelivr', !hosts.includes('cdn.jsdelivr.net'))
  ck('过滤图片域名后缀', !hosts.some(h => h.startsWith('img.foo')))
  ck('同主机大小写归一去重', hosts.filter(h => h === 'api.music-abc.com').length === 1, hosts.join(','))
  ck('上限 8 个', hosts.length <= 8, 'got ' + hosts.length)

  const empty = extractApiHosts('no urls here')
  ck('无 http(s) 域名返回空', Array.isArray(empty) && empty.length === 0)

  // ---------- probeApiHosts ----------
  // apiHostCheck 关闭时不发请求
  const e0 = { apiHosts: ['api.music-abc.com'] }
  await probeApiHosts(e0, { apiHostCheck: false })
  ck('apiHostCheck 关闭：不探活、不写 apiAlive', e0.apiAlive === undefined)

  // apiHostCheck 开启 + 域名可达
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '' })
  const e1 = { apiHosts: ['api.music-abc.com'] }
  await probeApiHosts(e1, { apiHostCheck: true })
  ck('探活：可达域名标记 up', e1.apiAlive && e1.apiAlive['api.music-abc.com'] === 'up', JSON.stringify(e1.apiAlive))

  // apiHostCheck 开启 + 域名不可达（抛错）
  globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND api.dead.com') }
  const e2 = { apiHosts: ['api.dead.com'] }
  await probeApiHosts(e2, { apiHostCheck: true })
  ck('探活：不可达域名标记 down', e2.apiAlive && e2.apiAlive['api.dead.com'] === 'down', JSON.stringify(e2.apiAlive))

  // 无域名直接返回
  const e3 = { apiHosts: [] }
  await probeApiHosts(e3, { apiHostCheck: true })
  ck('无域名：直接返回不写 apiAlive', e3.apiAlive === undefined)

  if (bad) { console.error(`\n${bad} 个断言失败`); process.exit(1) }
  console.log('\n全部通过')
})()
