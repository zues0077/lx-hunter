'use strict'
/**
 * 私人源灌入 + 两处文案（2026-11-11）
 *
 * 1) 私人源（「导入单个音源」加进来的：有 code、无 url）之前点灌入会被判
 *    「服务端原生音源，无需灌入」直接跳过 —— 门槛写的是 `!e.url || e.fromServer`，只认 url。
 *    巡检门槛 `buildPatrolItems` 认的是 code，两边口径不一致，界面文案又说私人源可灌入。
 *
 * 2) 同仓库同名 + 版本更高 + 质量平手时，理由里被塞进 compareVerdict 平手分支的
 *    「…→ 平手，不删任何一方」，与紧随其后的「留新删旧」自相矛盾。
 *
 * 3) 版本文案兜底取名字时会把整串名字填进理由（「v1.1.0 ≥ LXHE2E 测试源 v1.0.0」）。
 */
const assert = require('assert')
const H = require('../src/core/hunter')
const V = require('../src/core/version')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + JSON.stringify(extra) : '')) }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, { actual, expected })
}

const hunter = Object.create(H.Hunter.prototype)

// 灌入规划的最小 ctx：没有服务端同名、没有 hash 比对、没有账本
const ctx = () => ({ cfg: {}, serverByName: {}, serverByBase: {}, serverIds: new Set(), serverList: [], codeCache: {} })

console.log('=== A. 私人源（有 code、无 url）必须能进灌入队列 ===')
{
  const priv = {
    id: 'private::my_src', name: 'my_src', url: '', code: 'const a=1', private: true,
    contentHash: 'h-priv', usable: true, deep: null, size: 9
  }
  const q = hunter._planImportQueue([priv], ctx())
  eq('只有一条计划', q.length, 1)
  ok('没被当成「服务端原生音源」跳过', !q[0].skip, q[0])
  ok('走的是新增上传（无 replace/rename 服务端条目）', !q[0].replaceServer && !q[0].renameServer, q[0])

  // 私人源检测过、且实测可用 → 照样能灌
  const priv2 = Object.assign({}, priv, {
    id: 'private::my_src2', name: 'my_src2',
    deep: { checkedAt: Date.now(), platforms: { kw: { status: 'usable' } } }
  })
  const q2 = hunter._planImportQueue([priv2], ctx())
  ok('检测通过的私人源也能灌', q2[0] && !q2[0].skip, q2[0])
}

console.log('\n=== B. 真正该拦的仍然拦住 ===')
{
  // 服务端同步建的占位条目：fromServer 且从不存 code
  const placeholder = { id: 'srv:s1', name: '服务端源', url: '', fromServer: true, contentHash: '', usable: true }
  const q = hunter._planImportQueue([placeholder], ctx())
  ok('占位条目（fromServer、无 code）→ 跳过，不重复上传', /服务端原生音源/.test(String(q[0] && q[0].skip)), q[0])

  const placeholderWithCode = Object.assign({}, placeholder, { id: 'srv:s2', code: 'const b=2' })
  const q2 = hunter._planImportQueue([placeholderWithCode], ctx())
  ok('即使占位条目带了正文也跳过（它本来就在服务端）', /服务端原生音源/.test(String(q2[0] && q2[0].skip)), q2[0])

  const noUrlNoCode = { id: 'e-broken', name: '无地址无正文', url: '', contentHash: '', usable: true }
  const q3 = hunter._planImportQueue([noUrlNoCode], ctx())
  ok('既没 url 也没正文 → 跳过（本来也传不上去）', /无法灌入/.test(String(q3[0] && q3[0].skip)), q3[0])

  // 空串 code 仍是 string，但空正文上传必失败 → 必须拦住，不能只看 typeof
  const emptyCode = { id: 'e-empty', name: '空正文', url: '', code: '', contentHash: 'h0', usable: true }
  const q4 = hunter._planImportQueue([emptyCode], ctx())
  ok('空串正文 → 拦住（别拿空 url 去 importUrl）', /无法灌入/.test(String(q4[0] && q4[0].skip)), q4[0])
}

console.log('\n=== C. 灌入门槛与巡检门槛口径一致（源码级） ===')
{
  const fs = require('fs'), path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'hunter.js'), 'utf8')
  ok('灌入门槛认「非空 code」', /!e\.url && !\(typeof e\.code === 'string' && e\.code\)/.test(src))
  ok('fromServer 单独一个分支拦掉', /if \(e\.fromServer\) \{/.test(src))
  ok('不再有「只认 url」的旧写法', !/if \(!e\.url \|\| e\.fromServer\)/.test(src))
  // 2026-11-11（P-1411 P1-1）：巡检门槛原来写 `typeof e.code !== 'string'`，空串也算「有正文」，
  // 那条音源会进巡检却永远测不出东西。现在与灌入口径完全一致（必须是**非空** code）。
  ok('巡检门槛同样是认「非空 code」的写法',
    (src.match(/if \(!e\.url && !\(typeof e\.code === 'string' && e\.code\)\)/g) || []).length >= 2)
  ok('巡检不再保留「空串 code 也算有正文」的旧写法', !/if \(!e\.url && typeof e\.code !== 'string'\) continue/.test(src))
}

console.log('\n=== D. 同仓库版本更高 + 质量平手：replace 且文案不自相矛盾 ===')
{
  const code = 'x'.repeat(40)
  const mkE = o => Object.assign({
    id: 'e1', name: 'LXH源 v3.0.0', lxName: 'LXH源 v3.0.0', scriptName: 'LXH源 v3.0.0',
    scriptVersion: 'v3.0.0', repository: 'https://github.com/foo/bar',
    url: 'https://raw.githubusercontent.com/foo/bar/main/x.js',
    contentHash: 'hash-new', usable: true, stale: false, size: 120,
    deep: {
      checkedAt: Date.now(),
      platforms: { kw: { status: 'usable' }, kg: { status: 'usable' } },
      metrics: { depth: 'full', p50LatencyMs: 100, samples: 3 }
    }
  }, o || {})
  const mkS = o => Object.assign({
    id: 's1', name: 'LXH源 v2.0.0', version: 'v2.0.0',
    repository: 'https://github.com/foo/bar', supportedSources: ['kw', 'kg'], size: 20, enabled: true
  }, o || {})

  // 平台数 2 vs 2、p50 差 50ms（< 300ms 噪声带）→ tie
  const srvTie = mkS({
    qualityProxy: {
      platforms: { kw: { status: 'usable' }, kg: { status: 'usable' } },
      metrics: { depth: 'full', p50LatencyMs: 150, samples: 3 }
    }
  })
  const v = hunter.sameNameVerdict(mkE(), srvTie, code, {})
  eq('平手 → 仍判 replace（同源以版本为准）', v.act, 'replace')
  ok('理由写明「同源以版本为准」', /同源以版本为准/.test(v.why), v.why)
  ok('理由里不再出现「不删任何一方」', !/不删任何一方/.test(v.why), v.why)
  ok('理由里不再出现「平手，不删」这种残句', !/平手，不删/.test(v.why), v.why)

  // 质量明显更优 → 照旧 replace，文案说「质量更优」
  const srvWorse = mkS({
    qualityProxy: {
      platforms: { kw: { status: 'usable' }, kg: { status: 'usable' } },
      metrics: { depth: 'full', p50LatencyMs: 2000, samples: 3 }
    }
  })
  const v2 = hunter.sameNameVerdict(mkE(), srvWorse, code, {})
  eq('本地更快很多 → replace', v2.act, 'replace')
  ok('理由说「质量更优」', /质量更优/.test(v2.why), v2.why)

  // 质量明显更差 → skip，不降级（本地 2000ms vs 服务端 10ms，差 1990ms 远超 300ms 噪声带）
  const eSlow = mkE({
    deep: {
      checkedAt: Date.now(),
      platforms: { kw: { status: 'usable' }, kg: { status: 'usable' } },
      metrics: { depth: 'full', p50LatencyMs: 2000, samples: 3 }
    }
  })
  const srvBetter = mkS({
    qualityProxy: {
      platforms: { kw: { status: 'usable' }, kg: { status: 'usable' } },
      metrics: { depth: 'full', p50LatencyMs: 10, samples: 3 }
    }
  })
  const v3 = hunter.sameNameVerdict(eSlow, srvBetter, code, {})
  eq('本地慢很多 → skip', v3.act, 'skip')
  ok('理由说「质量更差」', /质量更差/.test(v3.why), v3.why)
}

console.log('\n=== E. 版本文案：只显示版本号，不塞整串名字 ===')
{
  eq('verLabel 从名字里取出 v1.0.0', V.verLabel('LXHE2E 测试源 v1.0.0'), 'v1.0.0')
  eq('verLabel 对纯版本号原样返回', V.verLabel('v1.1.0'), 'v1.1.0')
  eq('verLabel 无版本号 → 原样返回', V.verLabel('某些音源'), '某些音源')
  eq('verLabel 取第一处版本号（与 versionKey 同款正则）', V.verLabel('2.0 音源 v1.5'), '2.0')
  eq('提取后比较结果不变', V.cmpVersion(V.verLabel('源 v2.0.0'), V.verLabel('源 v1.0.0')), 1)

  // 端到端：本地版本来自名字兜底时，理由里只有版本号
  const code = 'x'.repeat(40)
  const e = {
    id: 'e2', name: 'LXHE2E 测试源 v1.1.0', lxName: 'LXHE2E 测试源 v1.1.0',
    scriptName: 'LXHE2E 测试源 v1.1.0', scriptVersion: '',
    repository: 'https://github.com/foo/bar', url: 'https://x/y.js',
    contentHash: 'hash-2', usable: true, stale: false, size: 200,
    deep: { checkedAt: Date.now(), platforms: { kw: { status: 'usable' } } }
  }
  const srv = {
    id: 's2', name: 'LXHE2E 测试源 v1.0.0', version: '',
    repository: 'https://github.com/foo/bar', supportedSources: ['kw'], size: 50
  }
  const v = hunter.sameNameVerdict(e, srv, code, {})
  ok('理由里是「v1.1.0 > v1.0.0」这种短版本号', /v1\.1\.0 > v1\.0\.0/.test(v.why), v.why)
  ok('理由里不再出现整串名字', !/LXHE2E 测试源/.test(v.why), v.why)
}

console.log('\nRESULT ' + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail ? 1 : 0)
