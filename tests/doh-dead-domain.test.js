const { dohLookup } = require('../src/core/net')
const { deepCheck } = require('../src/core/checker')
let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }

;(async () => {
  // 网络可用性探测：DoH 不通时软跳过
  const live = await dohLookup('music.163.com').catch(() => ({ ok: false }))
  const netOk = live.ok === true
  ck('DoH 服务可达（无网络则软跳过）', netOk || live.ok === false)

  if (netOk) {
    const dead = await dohLookup('api.kunshare.com')
    ck('已注销域名: NXDOMAIN 确认', dead.ok && dead.nx === true && dead.ips.length === 0, JSON.stringify(dead))
    const ok = await dohLookup('music.163.com')
    ck('存活域名: 能解析出 IP', ok.ok && !ok.nx && ok.ips.length > 0, JSON.stringify(ok).slice(0, 80))

    // 用已注销域名构造音源，验证整链路给出「域名已失效」而不是「本机网络问题」
    const SCRIPT = `
      lx.on('request', (p) => new Promise((res, rej) => {
        var mi = (p.info && p.info.musicInfo) || {}; var sid = mi.songmid || mi.hash || 'test';
        lx.request('https://api.kunshare.com/url/' + p.source + '/' + sid + '/' + ((p.info && p.info.type) || '128k'), { timeout: 6000 }, (err, resp, body) => {
          if (err) return rej(err);
          res({ url: 'https://cdn.example.com/a.mp3' });
        });
      }));
      lx.send('inited', { sources: { wy: { name: '死域名源', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] }, tx: { name: '死域名源', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } });
    `
    const r = await deepCheck({ name: '死域名源', url: 'local' }, SCRIPT,
      { linkTimeoutMs: 8000, platformBudgetMs: 15000, retryBudgetMs: 8000, quickCheck: false }, () => {}, () => false)
    console.log('   platforms:', JSON.stringify(Object.entries(r.platforms).map(([k, v]) => k + ':' + v.status)))
    ck('死域名音源标记 deadDomain', r.deadDomain === true)
    ck('提示明确说「域名已失效，建议删除」', /已失效/.test(String(r.hint || '')) && /删除/.test(String(r.hint || '')), String(r.hint || '').slice(0, 80))
  } else {
    console.log('（当前环境无外网，跳过 DoH 相关断言）')
  }

  console.log('\n' + (bad === 0 ? 'ALL PASS' : bad + ' FAILED'))
  process.exit(bad ? 1 : 0)
})().catch(e => { console.error('ERR', e); process.exit(1) })
