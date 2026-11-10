'use strict'
/**
 * 「同名版本更新」三件套（2026-11-11 01:5x 用户拍板）
 *
 * 背景（17960 实测 P-1404）：
 *   A 场景 `@name` 固定、只升 `@version`  → 能靠「同名 + 平台重叠」replace，但**本地旧版
 *     也会覆盖服务端新版**（版本比较读的是名字，A 场景两边都取不到版本号）。
 *   B 场景 `@name` 带版本号 → 精确同名永远配不上，每次升级都在服务端新堆一条。
 *
 * 三处修法：
 *  1. 版本取值改为「@version 优先、名字兜底」（服务端 list 会回传 version 字段）；
 *  2. 灌入配对补一层「剥掉版本号后同名」（identity.baseNameKey）；
 *  3. 跨仓库同名不再要求「双方都有实测证据」，改为「本地版本更高 + 质量/平台数更优」。
 *
 * 本文件守六件事：
 *  A. 剥版本号与 crawler.latestBaseName 完全同款（防两份实现漂移）；
 *  B. 基准名太短（≤2 字符）不配对 —— 弱名不猜；
 *  C. 同 base 多条只取版本最高那条配对，其余不动；
 *  D. 服务端 `@version` 参与比较（A 场景不再被本地旧版覆盖）；
 *  E. base 配对后走同一套裁决（该 replace 就 replace，不是直接新增）；
 *  F. 精确同名永远优先于 base 配对。
 */
const assert = require('assert')
const H = require('../src/core/hunter')
const I = require('../src/core/identity')
const C = require('../src/core/crawler')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + JSON.stringify(extra) : '')) }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, { actual, expected })
}

const hunter = Object.create(H.Hunter.prototype)

// 夹具：本地候选 / 服务端条目
const code = 'x'.repeat(40)
const mkE = o => Object.assign({
  id: 'e1', name: 'LXH源 v3.0.0', lxName: 'LXH源 v3.0.0', scriptName: 'LXH源 v3.0.0',
  scriptVersion: 'v3.0.0',
  repository: 'https://github.com/foo/bar',
  url: 'https://raw.githubusercontent.com/foo/bar/main/x.js',
  contentHash: 'hash-new', usable: true, stale: false,
  deep: { checkedAt: Date.now(), platforms: { kw: { status: 'usable' }, kg: { status: 'usable' } } }
}, o || {})
const mkS = o => Object.assign({
  id: 's1', name: 'LXH源 v2.0.0', version: 'v2.0.0',
  repository: 'https://github.com/foo/bar',
  supportedSources: ['kw'], size: 20, enabled: true
}, o || {})

console.log('=== A. 剥版本号：与 crawler.latestBaseName 同款 ===')
{
  const cases = [
    'LXH源 v1.0.0',
    'LXH源-v2.3.17.js',
    'LXH源_v1.8',
    'LXH源v2.3.17',
    'LXH源 2.3.17',
    'LXH源',
    '无版本号音源'
  ]
  for (const c of cases) {
    eq('stripVersionSuffix(' + c + ') == latestBaseName', I.stripVersionSuffix(c), C.latestBaseName(c))
  }
  eq('多段版本一路剥到底（v1.2.3.4）', I.stripVersionSuffix('foo v1.2.3.4'), 'foo')
  eq('.js 后缀先剥掉', I.stripVersionSuffix('bar.js'), 'bar')
  eq('括号包裹的版本号也能剥', I.baseNameKey('某某音源（v1.0.0）'), I.baseNameKey('某某音源'))
  eq('半角括号同样处理', I.baseNameKey('某某音源(v2.0)'), '某某音源')
  eq('版本号夹在名字中间不剥（退回新增，不乱配）', I.baseNameKey('某某音源 v1.0 便携版') !== I.baseNameKey('某某音源 v2.0 便携版'), true)
}

console.log('\n=== B. 基准名门槛：≤2 字符不配对 ===')
{
  eq('两个中文字 → 不配对', I.baseNameKey('音乐'), '')
  eq('一个英文 → 不配对', I.baseNameKey('a'), '')
  eq('空名 → 不配对', I.baseNameKey(''), '')
  eq('三字中文 → 可配对（用户口径 ≤2 才拦）', I.baseNameKey('音乐源'), '音乐源')
  eq('带版本的三字名剥后仍可配对', I.baseNameKey('音乐源 v1.0.0'), '音乐源')
  eq('不同版本剥出同一键', I.baseNameKey('某某音源 v1.0.0') === I.baseNameKey('某某音源 v2.0'), true)
  eq('不同名字剥出不同键', I.baseNameKey('某某音源 v1.0') === I.baseNameKey('别的音源 v1.0'), false)
  eq('符号差异被归一', I.baseNameKey('某某 音源 v1.0'), I.baseNameKey('某某-音源 v2.0'))
}

console.log('\n=== C. 同 base 多条：只取版本最高那条 ===')
{
  const arr = [
    { id: 'a', name: 'X源 v1.0', version: 'v1.0' },
    { id: 'b', name: 'X源 v2.0', version: 'v2.0' },
    { id: 'c', name: 'X源 v1.9', version: 'v1.9' }
  ]
  eq('挑到 v2.0 那条', I.pickHighestVersion(arr).id, 'b')
  eq('全都无版本 → 不配对', I.pickHighestVersion([{ id: 'a', name: 'X源' }, { id: 'b', name: 'X源' }]), null)
  eq('空列表 → 不配对', I.pickHighestVersion([]), null)
  eq('版本字段缺失时用名字里的版本号', I.pickHighestVersion([{ id: 'a', name: 'X源 v1.0' }, { id: 'b', name: 'X源 v2.0' }]).id, 'b')
}

console.log('\n=== D. 服务端 @version 参与比较（A 场景核心修复）===')
{
  // A 场景：@name 固定，只有 @version 在变。名字一字不差 → 以前两边都取不到版本，
  // 直接落到「同名 + 平台重叠 → replace」，本地旧版会覆盖服务端新版。
  const same = { name: 'LXH源', lxName: 'LXH源', scriptName: 'LXH源' }
  let v = hunter.sameNameVerdict(
    mkE(Object.assign({ scriptVersion: 'v1.0.0' }, same)),
    mkS(Object.assign({ name: 'LXH源', version: 'v1.1.0' }, { supportedSources: ['kw'] })),
    code, {})
  eq('本地 v1.0.0、服务端 v1.1.0（名字相同）→ skip', v.act, 'skip')
  ok('理由里带版本号', /v1\.1\.0/.test(v.why), v.why)

  v = hunter.sameNameVerdict(
    mkE(Object.assign({ scriptVersion: 'v1.2.0' }, same)),
    mkS(Object.assign({ name: 'LXH源', version: 'v1.1.0' }, { supportedSources: ['kw'] })),
    code, {})
  eq('本地 v1.2.0、服务端 v1.1.0 → replace', v.act, 'replace')

  // 服务端 version 优先于 name（作者把旧版本号留在名字里时不能被骗）
  v = hunter.sameNameVerdict(
    mkE(Object.assign({ scriptVersion: 'v1.0.0' }, same)),
    mkS({ name: 'LXH源 v9.9', version: 'v1.1.0', supportedSources: ['kw'] }),
    code, {})
  eq('name 里的 v9.9 不算数，按 version=v1.1.0 判 → skip', v.act, 'skip')

  // 本地 scriptVersion 优先于 name
  v = hunter.sameNameVerdict(
    mkE(Object.assign({ scriptVersion: 'v5.0.0' }, same)),
    mkS({ name: 'LXH源', version: 'v1.1.0', supportedSources: ['kw'] }),
    code, {})
  eq('本地 name 无版本但 @version=v5.0.0 → replace', v.act, 'replace')

  // 向后兼容：两边都没有 version 字段时，仍按名字里的版本号（升级前行为）
  v = hunter.sameNameVerdict(mkE({ scriptVersion: '' }), mkS({ version: '' }), code, {})
  eq('无 @version 时回落到名字版本（v3.0.0 > v2.0.0）→ replace', v.act, 'replace')
}

console.log('\n=== E. base 配对：命中后走同一套裁决 ===')
{
  const srvV2 = { id: 's2', name: 'LXH源 v2.0.0', version: 'v2.0.0', repository: 'https://github.com/foo/bar', supportedSources: ['kw'], size: 20 }
  const baseCtx = {
    cfg: {},
    serverByName: { [H.normName('LXH源 v2.0.0')]: srvV2 },
    serverByBase: { [I.baseNameKey('LXH源 v2.0.0')]: srvV2 },
    serverIds: new Set(['s2']),
    serverList: [srvV2],
    codeCache: { e1: code },
    ledger: {}, importedRecs: {}, serverScore: {}, uniqueName: true
  }
  const e = mkE({ scriptName: 'LXH源 v3.0.0' })
  const q = hunter._planImportQueue([e], baseCtx)
  eq('队列 1 条', q.length, 1)
  ok('base 配对后判 replace（不是直接新增）', !!(q[0] && q[0].replaceServer), q[0])
  ok('结果上标记了 matchedByBase（区别于精确同名）', q[0] && q[0].matchedByBase === true, q[0])

  // 本地版本更低 → 不该替换，应 skip
  const older = mkE({ scriptName: 'LXH源 v1.0.0', scriptVersion: 'v1.0.0' })
  const q2 = hunter._planImportQueue([older], baseCtx)
  ok('本地旧版 → skip，不覆盖服务端', !!(q2[0] && q2[0].skip), q2[0])
}

console.log('\n=== F. 精确同名优先于 base 配对 ===')
{
  const exact = { id: 's9', name: 'LXH源 v3.0.0', version: 'v3.0.0', repository: 'https://github.com/foo/bar', supportedSources: ['kw'], size: 20 }
  const other = { id: 's2', name: 'LXH源 v2.0.0', version: 'v2.0.0', repository: 'https://github.com/foo/bar', supportedSources: ['kw'], size: 20 }
  const ctx = {
    cfg: {},
    serverByName: { [H.normName('LXH源 v3.0.0')]: exact },
    // base 指向另一条（故意制造冲突，验证优先级）
    serverByBase: { [I.baseNameKey('LXH源 v3.0.0')]: other },
    serverIds: new Set(['s9', 's2']),
    serverList: [exact, other],
    codeCache: { e1: code },
    ledger: {}, importedRecs: {}, serverScore: {}, uniqueName: true
  }
  const q = hunter._planImportQueue([mkE()], ctx)
  ok('精确同名命中：配的是 s9，不是 base 指向的 s2',
    !!(q[0] && !q[0].matchedByBase), q[0])
  ok('同版本内容不同 → 保留服务端（skip），不是把 s2 换掉', !!(q[0] && q[0].skip), q[0])
}

console.log('\n=== G. 弱名不配对：宁可新增也不乱删 ===')
{
  const srv = { id: 's2', name: '音乐 v1.0', version: 'v1.0', repository: 'https://github.com/other/x', supportedSources: ['kw'], size: 20 }
  const ctx = {
    cfg: {},
    serverByName: {},
    serverByBase: {},           // baseNameKey('音乐 v1.0') === '' → 不会进这个表
    serverIds: new Set(['s2']),
    serverList: [srv],
    codeCache: { e1: code },
    ledger: {}, importedRecs: {}, serverScore: {}, uniqueName: true
  }
  eq('「音乐」基准名太短 → 不配对（baseNameKey 为空）', I.baseNameKey('音乐 v1.0'), '')
  const q = hunter._planImportQueue([mkE({ scriptName: '音乐 v2.0', scriptVersion: 'v2.0', name: '音乐 v2.0' })], ctx)
  ok('不进同名裁决，直接新增', !q[0].replaceServer && !q[0].skip, q[0])
}

console.log('\n=== H. 源码级：不该再出现只读 srv.name 的版本比较 ===')
{
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'hunter.js'), 'utf8')
  ok('sameNameVerdict 用 srv.version 兜底', /const srvVer = verLabel\(srv\.version \|\| srv\.name\)/.test(src))
  ok('本地版本优先用 scriptVersion', /const localVer = verLabel\(e\.scriptVersion \|\| nameForCmp\)/.test(src))
  ok('版本文案走 verLabel（不把整串名字拼进理由）', /verLabel/.test(src) && /verLabel,? \} = require\('\.\/version'\)|verLabel \} = require/.test(src) || /verLabel/.test(src))
  ok('不再有 versionNum\(srv\.name\) 的旧写法', !/versionNum\(srv\.name\)/.test(src))
  ok('base 配对分支存在', /serverByBase\[eBase\]/.test(src) && /const eBase = baseNameKey\(/.test(src))
  ok('同 base 多条只取最高版本', /pickHighestVersion\(arr\)/.test(src))
}


console.log('\n=== I. 正文副本：落档 / 读取 / 存量补档 ===')
{
  const fs = require('fs'), os = require('os'), path = require('path')
  const { Store } = require('../src/core/store')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-scripts-'))
  const st = new Store(dir)
  const h1 = 'a'.repeat(64)
  eq('非法 hash（非 sha256 hex）不落档、也不抛', st.archiveScript('h-s1', 'x'), false)
  eq('非法 hash 读不到', st.readScript('h-s1'), null)
  eq('落档成功', st.archiveScript(h1, 'const x=1'), true)
  eq('读回来一致', st.readScript(h1), 'const x=1')
  eq('字节数正确', st.scriptSize(h1), 9)
  eq('重复写幂等（同内容不重复写）', st.archiveScript(h1, 'const x=1'), true)
  eq('不存在的副本返回 null', st.readScript('b'.repeat(64)), null)
  eq('不存在的副本 size 为 0', st.scriptSize('b'.repeat(64)), 0)

  st.db.sources = {
    s1: { id: 's1', contentHash: h1, code: 'const x=1' },              // 已有副本
    s2: { id: 's2', contentHash: 'c'.repeat(64), code: 'const y=2' },  // 待补
    s3: { id: 's3', contentHash: 'd'.repeat(64) },                     // 本地没正文
    s4: { id: 's4', contentHash: '', code: 'no-hash' }                 // 没 hash
  }
  const bf = st.backfillScripts()
  eq('存量补档 1 份（只有 s2 缺）', bf.archived, 1)
  eq('s2 副本补进来了', st.readScript('c'.repeat(64)), 'const y=2')
  eq('s3 没正文 → 补不出来', st.readScript('d'.repeat(64)), null)
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('\n=== J. 打分快照对账：服务端那条被换过就不给证据 ===')
{
  const fs = require('fs'), os = require('os'), path = require('path')
  const { Store } = require('../src/core/store')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-score-'))
  const st = new Store(dir)
  const hash = 'e'.repeat(64)
  st.archiveScript(hash, 'x'.repeat(30))
  st.imported = {
    e1: {
      lxId: 's1', contentHash: hash, platformId: 'p1',
      importedTo: [{ platformId: 'p1', lxId: 's1', at: Date.now() }],
      score: { at: Date.now(), checkedAt: Date.now(), platforms: { kw: { status: 'usable' } }, metrics: { depth: 'full', p50LatencyMs: 100, samples: 3 } }
    }
  }
  const h = Object.create(H.Hunter.prototype)
  h.store = st
  const same = h._scoreByServerId('p1', 'p1', [{ id: 's1', size: 30 }])
  ok('字节数与副本一致 → 快照可用', same.s1 && !same.s1.stale, same.s1)
  const diff = h._scoreByServerId('p1', 'p1', [{ id: 's1', size: 99 }])
  ok('字节数不符 → 快照失效（服务端那条已被换过）', diff.s1 && diff.s1.stale === true, diff.s1)
  const unknown = h._scoreByServerId('p1', 'p1', null)
  ok('没读到服务端列表 → 不判不符，快照仍可用', unknown.s1 && !unknown.s1.stale, unknown.s1)
  const noSrvSize = h._scoreByServerId('p1', 'p1', [{ id: 'other', size: 7 }])
  ok('服务端列表里没有该 id（取不到 size）→ 不判不符', noSrvSize.s1 && !noSrvSize.s1.stale, noSrvSize.s1)

  // 本机没有副本（localSize=0）时同样不判 —— 拿不到基准就不能说「被换过」
  st.imported.e2 = {
    lxId: 's2', contentHash: 'f'.repeat(64), platformId: 'p1',
    importedTo: [{ platformId: 'p1', lxId: 's2', at: Date.now() }],
    score: { at: Date.now(), checkedAt: Date.now(), platforms: { kw: { status: 'usable' } }, metrics: { depth: 'full', p50LatencyMs: 200, samples: 2 } }
  }
  const noCopy = h._scoreByServerId('p1', 'p1', [{ id: 's1', size: 30 }, { id: 's2', size: 777 }])
  ok('本机没有副本时不误判（缺基准）', noCopy.s2 && !noCopy.s2.stale, noCopy.s2)
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('\nRESULT ' + pass + ' PASS / ' + fail + ' FAIL')
if (fail) process.exit(1)
