'use strict'
/**
 * 本地 hash 账本堵「等长改内容」口子（2026-11-11 00:52 用户拍板）
 *
 * 背景（17960 实机复现）：
 *   服务端 lxserver/Songloft 的 list **不回 hash、不回脚本正文**（17950 实测 38 条全空），
 *   于是「同名同内容」只剩 srv.size 一条弱证据。作者修了 bug 但没升版本号、改完字节数
 *   恰好不变时，会被判 `synced`（"已存在，不重传"），更新彻底卡死。
 *
 * 修法：灌入时账本已存 `contentHash`，同名时拿「账本 hash（上次真灌进去的那份）」
 *   和「本地当前正文 hash」比：
 *     相等 → 内容确实没变（强证据，比 size 可靠）
 *     不等 → 内容确实变了 ⇒ size 判据必须失效，并按「留新删旧」更新
 *
 * 本文件守五件事：
 *  1. 账本索引只收本平台、有 hash 的记录；
 *  2. 账本 hash 相同 → synced；不同 → **绝不 synced**；
 *  3. 版本号相同但内容变了 → replace（不是 skip 卡住）；
 *  4. 服务端能自证（回传 hash/正文）时以服务端为准，账本不越权；
 *  5. 无账本时行为与升级前完全一致（向后兼容）。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const H = require('../src/core/hunter')
const { Hunter, normName } = H

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')) }
}

const CODE = 'x'.repeat(500)                 // 500 字节正文
const mkH = () => Object.create(Hunter.prototype)

/** 造本地条目：默认「同名同版本、1 个平台可用、内容 hash = H_NEW」 */
function mkEntry(o) {
  const opt = o || {}
  return Object.assign({
    id: 'e1',
    url: 'https://example.com/demo.js',
    scriptName: 'demo v1.0.0',
    lxName: 'demo v1.0.0',
    name: 'demo v1.0.0',
    contentHash: 'H_NEW',
    usable: true,
    deep: { checkedAt: 1, platforms: { wy: { status: 'usable' } } }
  }, opt)
}

/** 造服务端条目：同名同版本、size = 500（与本地等长）、无 hash 无正文 */
function mkSrv(o) {
  return Object.assign({
    id: 's1', name: 'demo v1.0.0', size: 500, supportedSources: ['wy']
  }, o)
}

const verdict = (e, srv, ledger, code) =>
  mkH().sameNameVerdict(e, srv || mkSrv(), code === undefined ? CODE : code, {}, { ledger: ledger || null })

console.log('=== A. 账本索引 _ledgerByEntry ===')
{
  const h = mkH()
  h.store = {
    imported: {
      e1: { contentHash: 'H1', lxId: 's1', platformId: 'acc1', name: 'a' },
      e2: { contentHash: '', lxId: 's2', platformId: 'acc1', name: 'b' },     // 没有 hash → 不收录
      e3: { contentHash: 'H3', lxId: 's3', platformId: 'acc2', name: 'c' },   // 别的平台 → 不收录
      e4: { contentHash: 'H4', lxId: null, importedTo: [{ platformId: 'acc1', lxId: 's4' }], name: 'd' }
    }
  }
  const led = h._ledgerByEntry('acc1', 'acc1')
  ok('只收录本平台且有 contentHash 的记录', Object.keys(led).sort().join(',') === 'e1,e4', Object.keys(led).join(','))
  ok('importedTo 里的同平台记录也算', led.e4 && led.e4.hash === 'H4')
  ok('别的平台不串台', !led.e3)
  ok('空 hash 不进账本（不能拿空串当证据）', !led.e2)
  ok('账本条目带 lxId（用于校验服务端那条是不是我们灌的）', led.e1.lxId === 's1')
}

console.log('=== B. 账本 hash 决定「是不是同内容」 ===')
{
  ok('无账本 + 等长 + 同版本 → 沿用旧口径 synced（向后兼容）', verdict(mkEntry()).act === 'synced')
  ok('账本 hash 一致 → synced', verdict(mkEntry(), null, { hash: 'H_NEW', lxId: 's1' }).act === 'synced')
  ok('账本 hash 一致时理由说明来自账本',
     /账本/.test(verdict(mkEntry(), null, { hash: 'H_NEW', lxId: 's1' }).why))

  // 核心用例：等长改动（版本号没升、字节数一样、内容变了）
  const changed = verdict(mkEntry(), null, { hash: 'H_OLD', lxId: 's1' })
  ok('账本 hash 不同 → 绝不判 synced（等长口子堵住）', changed.act !== 'synced', changed.act + ' | ' + changed.why)
  ok('账本 hash 不同 → 按留新删旧更新（replace）', changed.act === 'replace', changed.act + ' | ' + changed.why)

  // 不等长也一样要走更新（旧逻辑在版本相同时会判 skip 卡住）
  const longer = verdict(mkEntry({ contentHash: 'H_NEW' }), mkSrv({ size: 900 }), { hash: 'H_OLD', lxId: 's1' })
  ok('长度也变了 → 仍然 replace（不再被「版本相同」卡成 skip）', longer.act === 'replace', longer.act)
}

console.log('=== C. 服务端能自证时账本不越权 ===')
{
  // 服务端回传了真 hash，且与本地一致 → 以服务端为准，直接 synced
  ok('服务端 hash 与本地一致 → synced',
     verdict(mkEntry(), mkSrv({ hash: 'H_NEW' }), { hash: 'H_OLD', lxId: 's1' }).act === 'synced')

  // 服务端 hash 与本地不同 → 服务端说内容不一样，不能因为账本一样就判已同步
  const srvHashDiff = verdict(mkEntry(), mkSrv({ hash: 'H_OTHER' }), { hash: 'H_NEW', lxId: 's1' })
  ok('服务端 hash 不同 → 不判 synced（服务端证据优先）', srvHashDiff.act !== 'synced', srvHashDiff.act)

  // 服务端回传正文且一致 → synced
  ok('服务端正文与本地一致 → synced',
     verdict(mkEntry(), mkSrv({ script: CODE }), { hash: 'H_OLD', lxId: 's1' }).act === 'synced')
}

console.log('=== D. 账本指向的服务端条目已被换掉 ===')
{
  // lxId 对不上：说明服务端这条不是我们当初灌的
  const foreign = verdict(mkEntry(), mkSrv({ id: 's9' }), { hash: 'H_NEW', lxId: 's1' })
  ok('lxId 对不上 → 不判 synced（不能让 size 兜底）', foreign.act !== 'synced', foreign.act + ' | ' + foreign.why)
}

console.log('=== D2. 账本不替「别人加的条目」做决定 ===')
{
  // 服务端同名条目不是我们灌的那条（lxId 对不上），账本说内容变了也不能删它
  const foreignChanged = verdict(mkEntry(), mkSrv({ id: 's9' }), { hash: 'H_OLD', lxId: 's1' })
  ok('账本指向别的条目 + 内容变了 → 不 replace（不删别人加的音源）', foreignChanged.act !== 'replace', foreignChanged.act + ' | ' + foreignChanged.why)
  ok('账本指向别的条目 + 内容变了 → 保守保留服务端', foreignChanged.act === 'skip', foreignChanged.act)
}

console.log('=== D3. 账本在但本地没算出 hash ===')
{
  // 本地下载异常/未计算 hash：无法确认内容，不能靠 size 判「已同步」
  const noHash = verdict(mkEntry({ contentHash: '' }), null, { hash: 'H_OLD', lxId: 's1' })
  ok('账本在 + 本地无 hash → 不判 synced', noHash.act !== 'synced', noHash.act + ' | ' + noHash.why)
  ok('账本在 + 本地无 hash → 保守保留服务端', noHash.act === 'skip', noHash.act)
  // 对照：没有账本时仍走旧口径（size 兜底），保证升级不改历史行为
  ok('无账本 + 本地无 hash → 旧口径 synced', verdict(mkEntry({ contentHash: '' })).act === 'synced')
}

console.log('=== E. 有内容变更时仍不做降级替换 ===')
{
  // 本地未实测（没有 deep）→ 不能凭「内容变了」就把服务端能用的换掉
  const untested = verdict(mkEntry({ deep: null }), null, { hash: 'H_OLD', lxId: 's1' })
  ok('本地未实测 → 保留服务端（不拿未验证的替换）', untested.act === 'skip', untested.act)
  ok('未实测的理由要说清「做完深度检测再更新」', /深度检测/.test(untested.why), untested.why)

  // 本地实测平台数少于服务端声明 → 不做降级替换
  const fewer = verdict(mkEntry(), mkSrv({ supportedSources: ['wy', 'tx', 'kw'] }), { hash: 'H_OLD', lxId: 's1' })
  ok('本地可用平台更少 → skip（不降级）', fewer.act === 'skip', fewer.act)

  // 本地实测 0 个可用平台 → 早有保护，优先于账本
  const dead = verdict(mkEntry({ deep: { checkedAt: 1, platforms: { wy: { status: 'failed' } } } }), null, { hash: 'H_OLD', lxId: 's1' })
  ok('本地 0 平台 → skip（账本不能突破「不越换越差」）', dead.act === 'skip', dead.act)
}

console.log('=== F. 版本号不同时账本不抢戏 ===')
{
  // 本地版本更高 → 正常更新，不管账本
  const newer = verdict(mkEntry({ scriptName: 'demo v2.0.0', lxName: 'demo v2.0.0' }), mkSrv({ name: 'demo v1.0.0' }),
    { hash: 'H_NEW', lxId: 's1' })
  ok('本地版本更高 → replace（账本 hash 相同也不挡更新）', newer.act === 'replace', newer.act)

  // 服务端版本更高 → 保留服务端
  const older = verdict(mkEntry({ scriptName: 'demo v1.0.0', lxName: 'demo v1.0.0' }), mkSrv({ name: 'demo v2.0.0' }),
    { hash: 'H_OLD', lxId: 's1' })
  ok('服务端版本更高 → skip（账本说内容变了也不倒灌旧版本）', older.act === 'skip', older.act)
}

console.log('=== G. 端到端：_planImportQueue 真的用上了账本 ===')
{
  const name = 'demo v1.0.0'
  const e = mkEntry()
  const srv = mkSrv()
  const baseCtx = {
    cfg: {}, serverIds: new Set(['s1']), serverList: [srv], codeCache: { e1: CODE },
    importedRecs: {}, uniqueName: true,
    serverByName: { [normName(name)]: srv }
  }

  // 账本说没变 → 不重传
  const q1 = mkH()._planImportQueue([e], Object.assign({}, baseCtx, { ledger: { e1: { hash: 'H_NEW', lxId: 's1' } } }))
  ok('规划层：账本一致 → sameContentServer（不重传）', !!q1[0].sameContentServer && !q1[0].replaceServer, JSON.stringify(q1[0]).slice(0, 120))

  // 账本说变了 → 走替换
  const q2 = mkH()._planImportQueue([e], Object.assign({}, baseCtx, { ledger: { e1: { hash: 'H_OLD', lxId: 's1' } } }))
  ok('规划层：账本不同 → replaceServer（删旧装新）', !!q2[0].replaceServer, JSON.stringify(q2[0]).slice(0, 120))

  // 没有账本 → 旧行为（等长判 synced）
  const q3 = mkH()._planImportQueue([e], Object.assign({}, baseCtx, { ledger: {} }))
  ok('规划层：无账本 → 旧行为 synced（升级不改历史行为）', !!q3[0].sameContentServer)
}

console.log('=== H. 改名/替换分支不会绕过账本判定 ===')
{
  // 账本说「变了」但版本也更高、平台更少 → 仍按降级保护 skip，不会被账本强行 replace
  const fewer = verdict(mkEntry({ scriptName: 'demo v2.0.0', lxName: 'demo v2.0.0' }), mkSrv({ name: 'demo v1.0.0', supportedSources: ['wy', 'tx'] }), { hash: 'H_OLD', lxId: 's1' })
  ok('版本更高但平台更少 → skip（质量不劣优先于版本）', fewer.act === 'skip', fewer.act)
}

console.log('=== I. 补测预算：时间预算而非硬条数 ===')
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'hunter.js'), 'utf8')
  ok('补测上限从 5 条放宽为 20 条', /const MAX_PROBES = 20\b/.test(src))
  ok('增加了整轮时间预算', /const TOTAL_BUDGET_MS = 3 \* 60 \* 1000/.test(src))
  ok('超预算或超条数都会停止并留日志', /TOTAL_BUDGET_MS|已达条数上限/.test(src))
  ok('不再出现「最多补测 5 条」的注释', !/最多补测 5 条/.test(src))
}

console.log('\nRESULT ' + pass + ' PASS / ' + fail + ' FAIL')
if (fail) process.exit(1)
