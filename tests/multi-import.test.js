'use strict'
/**
 * v1.8.0：多平台同时灌入 + 同名音源可用性裁决
 *
 * 重点不是「能不能灌两个」，而是这几个容易做错的点：
 *  1) 目标账号的选取规则：勾了「参与批量灌入」的才算；一个都没勾要退回「只灌当前账号」，
 *     否则老用户升级后会发现「我只有一个账号却报没目标」或者「莫名灌到了别的账号」。
 *  2) 同名冲突必须按「每个服务端各自的现状」裁决：同名在 A 上有、在 B 上没有，
 *     A 该走替换/跳过、B 该正常上传 —— 拿一份列表去裁决两个平台必然出错。
 *  3) 已灌入记录要按平台分开记账（importedTo）：只灌过 A 的源不该在灌 B 时被判
 *     「已灌入」而跳过；从 A 撤回也不能把 B 上的那份记录一起删掉。
 *  4) 可用性多寡裁决要「两边都有数才裁决」：服务端拿不到声明平台数时不能瞎拦。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Hunter } = require('../src/core/hunter')
const { Store } = require('../src/core/store')
const svc = require('../src/core/services')

let pass = 0
function ok(name) { pass++; console.log('  ✓ ' + name) }

function mkHunter() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-multi-'))
  const store = new Store(dir)
  const h = Object.create(Hunter.prototype)
  h.store = store
  h.job = { running: false }
  // cancelRequested 是原型上的 getter（读 job.cancel），不能赋值
  h.emit = () => {}
  h.log = () => {}
  h.step = () => {}
  h.progress = () => {}
  return h
}

/** 假适配器：记录被调用的动作，行为可通过 opts 定制（down = 连不上） */
function mkFake(name, opts) {
  const o = opts || {}
  const st = { uploads: [], removes: [], verifyCalls: 0, listCalls: 0 }
  return {
    st,
    verify: async () => { st.verifyCalls++; return o.down ? { ok: false, msg: '连不上' } : { ok: true, msg: 'ok' } },
    list: async () => {
      st.listCalls++
      return (o.list || []).map(s => Object.assign({}, s))
    },
    upload: async (acct, code, filename) => {
      if (o.uploadFail) return { success: false, message: '上传失败' }
      st.uploads.push({ code, name: filename })
      return { success: true, id: name + ':' + filename, name: filename, platforms: ['kw', 'kg'] }
    },
    remove: async (acct, id) => { st.removes.push(id); return { success: o.removeFail ? false : true, message: '' } },
    importUrl: async () => ({ success: true, id: name + ':url', name: 'url', platforms: [] }),
    toggle: async () => ({ success: true }),
    setPlatforms: async () => ({ success: true }),
    validate: async () => ({ status: 'ok', data: {} }),
    baseUrl: () => 'http://' + name
  }
}

const ACCT = (id, type, extra) => Object.assign(
  { id, type, name: id.toUpperCase(), url: 'http://' + id, username: 'u', password: 'p', timeoutMs: 5000, enabled: true },
  extra || {}
)

// -------------------------------------------------- 1. 目标账号选取
console.log('\n[批量灌入目标选取]')
{
  const cfg = {
    platforms: [
      ACCT('a', 'lxserver', { batchImport: true }),
      ACCT('b', 'songloft', { batchImport: true }),
      ACCT('c', 'musicsync', {})            // 没勾
    ],
    activePlatformId: 'c'
  }
  const picked = svc.getBatchImportAccounts(cfg).map(p => p.id)
  assert.deepStrictEqual(picked, ['a', 'b'])
  ok('勾了「参与批量灌入」的才进目标，没勾的不进（哪怕它是当前账号）')

  const none = svc.getBatchImportAccounts({ platforms: [ACCT('a', 'lxserver'), ACCT('b', 'songloft')], activePlatformId: 'b' })
  assert.deepStrictEqual(none.map(p => p.id), ['b'])
  ok('一个都没勾 → 回退为「只灌当前选中账号」（老用户升级无感）')

  const withDisabled = svc.getBatchImportAccounts({
    platforms: [ACCT('a', 'lxserver', { batchImport: true }), ACCT('b', 'songloft', { batchImport: true, enabled: false })],
    activePlatformId: 'a'
  })
  assert.deepStrictEqual(withDisabled.map(p => p.id), ['a'])
  ok('禁用的账号不参与（enabled=false 一律跳过）')

  assert.deepStrictEqual(svc.getBatchImportAccounts({ platforms: [], activePlatformId: null }), [])
  ok('没有任何账号 → 空数组（由调用方转成 NO_ACCOUNT_ERR）')

  const tg = svc.getImportTargets(cfg)
  assert.strictEqual(tg.length, 2)
  assert.ok(typeof tg[0].adapter.upload === 'function' && tg[1].type === 'songloft')
  ok('getImportTargets 把账号包装成 { adapter, acct, type }')
}

// -------------------------------------------------- 2. runImport 的多账号接线
console.log('\n[多平台灌入执行]')

// 往 REGISTRY 里塞两个假类型：getService 是运行时查表，注入即可生效
const A = mkFake('A')
const B = mkFake('B')
const Adown = mkFake('Adown', { down: true })
svc.REGISTRY.fakeA = A
svc.REGISTRY.fakeB = B
svc.REGISTRY.fakeDown = Adown

function mkSrc(id, name, code) {
  return { id, name, lxName: name, scriptName: name, url: 'http://x/' + id + '.js', code, contentHash: 'h-' + id, usable: true, deep: null, deprecated: false, fromServer: false, stale: false }
}

async function main() {
  {
    const h = mkHunter()
    h.store.config.platforms = [ACCT('a', 'fakeA', { batchImport: true }), ACCT('b', 'fakeB', { batchImport: true })]
    h.store.config.activePlatformId = 'a'
    h.store.db.sources = { s1: mkSrc('s1', '源一', 'code-1') }
    h.store.saveDb()

    const r = await h.runImport(['s1'])
    assert.strictEqual(A.st.uploads.length, 1, 'A 应收到 1 次上传')
    assert.strictEqual(B.st.uploads.length, 1, 'B 应收到 1 次上传')
    ok('两个账号都勾了 → 同一条音源分别灌进两个平台')

    assert.strictEqual(r.ok, 2)
    const ids = r.results.map(x => x.platformId).sort()
    assert.deepStrictEqual(ids, ['a', 'b'])
    assert.ok(r.results.every(x => x.accountName && x.platformType))
    ok('每条结果都带平台归属（platformId / accountName / platformType）')

    assert.strictEqual(A.st.listCalls, 1)
    assert.strictEqual(B.st.listCalls, 1)
    ok('每个账号各读一次自己的服务端列表（不共用，同名裁决才准）')

    const rec = h.store.imported['s1']
    assert.strictEqual(rec.importedTo.length, 2, '灌入记录应记两个平台')
    assert.strictEqual(rec.platformId, 'b', '顶层平台指向最近一次灌入的账号')
    ok('已灌入记录用 importedTo[] 按平台记账，顶层指向最近一次')
  }

  {
    // 只灌过 A 的源，再灌 B 时不能被判成「已灌入」而跳过
    const h = mkHunter()
    h.store.config.platforms = [ACCT('a', 'fakeA', { batchImport: true }), ACCT('b', 'fakeB', {})]
    h.store.config.activePlatformId = 'a'
    h.store.db.sources = { s1: mkSrc('s1', '源一', 'code-1') }
    h.store.saveDb()
    await h.runImport(['s1'], { platformIds: ['a'] })
    const before = B.st.uploads.length
    const r2 = await h.runImport(['s1'], { platformIds: ['b'] })
    assert.strictEqual(B.st.uploads.length - before, 1, 'B 应该真的收到上传')
    assert.strictEqual(r2.ok, 1)
    ok('已灌入记录按账号过滤：只灌过 A 的源，灌 B 时不会被误判为已灌入')
  }

  {
    // 其中一个账号连不上 → 另一个照常灌，不整轮失败
    const h = mkHunter()
    h.store.config.platforms = [ACCT('d', 'fakeDown', { batchImport: true }), ACCT('a', 'fakeA', { batchImport: true })]
    h.store.config.activePlatformId = 'a'
    h.store.db.sources = { s1: mkSrc('s1', '源一', 'code-1') }
    h.store.saveDb()
    const r = await h.runImport(['s1'])
    assert.strictEqual(r.ok, 1)
    assert.deepStrictEqual(r.results.map(x => x.platformId), ['a'])
    ok('某个目标平台连不上 → 跳过它，其它平台继续灌（不整轮失败）')
  }

  {
    // 全部目标都不可用时必须报错，而不是静默「成功 0 个」
    const h = mkHunter()
    h.store.config.platforms = [ACCT('d', 'fakeDown', { batchImport: true })]
    h.store.config.activePlatformId = 'd'
    h.store.db.sources = { s1: mkSrc('s1', '源一', 'code-1') }
    h.store.saveDb()
    let err = null
    try { await h.runImport(['s1']) } catch (e) { err = e }
    assert.ok(err && /都不可用/.test(err.message), '应抛「所有灌入目标平台都不可用」')
    ok('所有目标都不可用 → 明确报错（不静默报成功 0）')
  }

  {
    // 同名冲突按各平台现状裁决：A 上已有同名（内容不同），B 上没有
    const h = mkHunter()
    const A2 = mkFake('A2', { list: [{ id: 'old', name: '源一', size: 3, supportedSources: [] }] })
    svc.REGISTRY.fakeA2 = A2
    h.store.config.platforms = [ACCT('a2', 'fakeA2', { batchImport: true }), ACCT('b', 'fakeB', { batchImport: true })]
    h.store.config.activePlatformId = 'a2'
    h.store.db.sources = { s1: mkSrc('s1', '源一', 'code-1') }
    h.store.saveDb()
    const r = await h.runImport(['s1'])
    const ra = r.results.find(x => x.platformId === 'a2')
    const rb = r.results.find(x => x.platformId === 'b')
    assert.strictEqual(ra.status, 'replaced', 'A2 上同名 → 走替换，实际：' + ra.status + ' / ' + ra.message)
    assert.ok(A2.st.removes.length === 1, 'A2 应先删旧版')
    assert.strictEqual(rb.status, 'success', 'B 上没同名 → 直接上传')
    ok('同名冲突按各平台自己的列表裁决（A 替换 / B 直传），不串台')
  }

  // -------------------------------------------------- 3. 同名可用性多寡裁决
  console.log('\n[同名音源可用性裁决]')
  {
    const h = mkHunter()
    const normN = s => String(s || '').toLowerCase().replace(/[\[\]【】（）()|｜:：、,，.。\s_\-·•]+/g, '')
    const nm = normN('同名源')
    const srv = { id: 'srv', name: '同名源', size: 10, supportedSources: ['kw', 'kg', 'wy', 'tx'] }
    const ctx = { cfg: {}, serverByName: { [nm]: srv }, codeCache: {}, importedHashes: {} }
    const mkE = (id, deep) => ({ id, name: '同名源', lxName: '同名源', scriptName: '同名源', url: 'u', fromServer: false, contentHash: 'h' + id, usable: true, deep, stale: false, updated: false })

    // 本地实测 1 个可用 < 服务端声明 4 个 → 保留服务端的
    const e1 = mkE('e1', { checkedAt: Date.now(), platforms: { kw: { status: 'usable' } } })
    let q = h._planImportQueue([e1], Object.assign({}, ctx, { codeCache: { e1: 'x'.repeat(20) } }))
    assert.ok(q[0].skip && /多于本地实测/.test(q[0].skip), '实际：' + JSON.stringify(q[0]))
    ok('服务端现条目可用平台更多 → 跳过替换，保留服务端（哪个可用多用哪个）')

    // 本地实测 5 个 ≥ 服务端声明 4 个 → 正常替换
    const e2 = mkE('e2', { checkedAt: Date.now(), platforms: { kw: { status: 'usable' }, kg: { status: 'usable' }, wy: { status: 'usable' }, tx: { status: 'usable' }, mg: { status: 'usable' } } })
    q = h._planImportQueue([e2], Object.assign({}, ctx, { codeCache: { e2: 'x'.repeat(20) } }))
    assert.ok(q[0].replaceServer, '实际：' + JSON.stringify(q[0]))
    ok('本地实测可用平台不少于服务端 → 照常替换（新版更值）')

    // 服务端没声明平台数（拿不到数）→ 不裁决，不能瞎拦
    const srvEmpty = { id: 'srv2', name: '同名源', size: 10 }
    const e3 = mkE('e3', { checkedAt: Date.now(), platforms: { kw: { status: 'usable' } } })
    q = h._planImportQueue([e3], { cfg: {}, serverByName: { [nm]: srvEmpty }, codeCache: { e3: 'x'.repeat(20) }, importedHashes: {} })
    assert.ok(q[0].replaceServer, '实际：' + JSON.stringify(q[0]))
    ok('服务端没声明平台数 → 不裁决（拿不到数不瞎拦，保持旧行为）')

    // 未检测的候选 → 不做裁决
    const e4 = Object.assign(mkE('e4', null), { deep: null })
    q = h._planImportQueue([e4], Object.assign({}, ctx, { codeCache: { e4: 'x'.repeat(20) } }))
    assert.ok(q[0].replaceServer, '实际：' + JSON.stringify(q[0]))
    ok('本地还没检测 → 不做可用性裁决（未知不参与比较）')
  }

  // -------------------------------------------------- 4. 撤回按账号摘除
  console.log('\n[多平台撤回]')
  {
    const h = mkHunter()
    h.store.config.platforms = [ACCT('a', 'fakeA'), ACCT('b', 'fakeB')]
    h.store.config.activePlatformId = 'a'
    h.store.imported['s1'] = {
      lxId: 'B:s1', name: '源一', contentHash: 'h-s1', importedAt: Date.now(),
      platformId: 'b', platformType: 'fakeB', accountName: 'B',
      importedTo: [
        { platformId: 'a', platformType: 'fakeA', accountName: 'A', lxId: 'A:s1' },
        { platformId: 'b', platformType: 'fakeB', accountName: 'B', lxId: 'B:s1' }
      ]
    }
    const r = await h.runRevoke(['s1'])
    assert.strictEqual(r[0].status, 'success')
    assert.ok(/另外 1 个平台/.test(r[0].message || ''), '实际：' + r[0].message)
    assert.ok(h.store.imported['s1'], '记录不能整条删掉，B 上还有一份')
    assert.strictEqual(h.store.imported['s1'].platformId, 'b')
    ok('从当前账号撤回只摘该账号那份，其它平台的记录保留')

    // 再切到 B 撤回 → 这次才整条删除
    h.store.config.activePlatformId = 'b'
    const r2 = await h.runRevoke(['s1'])
    assert.strictEqual(r2[0].status, 'success')
    assert.strictEqual(h.store.imported['s1'], undefined)
    ok('最后一个平台撤回后整条记录才删除')

    // 不属于当前账号的记录要拦住，而不是「删了个寂寞」还报成功
    h.store.imported['s2'] = { lxId: 'B:s2', name: '源二', platformId: 'b', importedTo: [{ platformId: 'b', accountName: 'B', lxId: 'B:s2' }] }
    h.store.config.activePlatformId = 'a'
    const r3 = await h.runRevoke(['s2'])
    assert.strictEqual(r3[0].status, 'failed')
    assert.ok(/不是灌入到当前账号/.test(r3[0].message), '实际：' + r3[0].message)
    ok('不属于当前账号的灌入记录 → 明确拦下并提示切账号（不误删、不假成功）')
  }

  // -------------------------------------------------- 5. 同名裁决规则表（sameNameVerdict）
  // 用户问的是「已灌入音源检测到底按什么规则」——规则就写在这一个函数里，
  // 这一节把每条规则钉住，避免以后有人「顺手改一下」把删旧装新/改名并存搞反。
  console.log('\n[同名裁决规则]')
  {
    const h = mkHunter()
    const cfg = {}
    const mkE = (id, deep, name) => ({
      id, name: name || '同名源', lxName: name || '同名源', scriptName: name || '同名源',
      url: 'u', fromServer: false, contentHash: 'h' + id, usable: true, deep, stale: false
    })
    const deepOf = keys => ({ checkedAt: Date.now(), platforms: keys.reduce((o, k) => { o[k] = { status: 'usable' }; return o }, {}) })

    // 1) 同名同内容（字节长度一致）→ 不重复上传，标记已灌入
    let v = h.sameNameVerdict(mkE('x', deepOf(['kw'])), { id: 's', name: '同名源', size: 20 }, 'x'.repeat(20), cfg)
    assert.strictEqual(v.act, 'synced')
    ok('同名 + 同内容（长度一致）→ 标记已灌入，不重复上传')

    // 2) 本地实测全挂 → 绝不替换（保留服务端，避免越换越差）
    v = h.sameNameVerdict(mkE('x', { checkedAt: Date.now(), platforms: { kw: { status: 'failed' } } }),
      { id: 's', name: '同名源', size: 20, supportedSources: ['kw'] }, 'y'.repeat(30), cfg)
    assert.strictEqual(v.act, 'skip')
    assert.ok(/0 个可用平台/.test(v.why), '实际：' + v.why)
    ok('同名 + 本地实测 0 可用 → 不替换（服务端能用的源不能换成本地实测挂掉的）')

    // 3) 服务端声明平台数更多 → 保留服务端
    v = h.sameNameVerdict(mkE('x', deepOf(['kw'])),
      { id: 's', name: '同名源', size: 20, supportedSources: ['kw', 'kg', 'wy'] }, 'y'.repeat(30), cfg)
    assert.strictEqual(v.act, 'skip')
    ok('同名 + 服务端支持平台更多 → 保留服务端（哪个可用多用哪个）')

    // 4) 本地版本更高 → 删旧装新（这是用户要的「同名内容更新就换新」）
    v = h.sameNameVerdict(mkE('x', deepOf(['kw', 'kg']), '同名源 v2.0'),
      { id: 's', name: '同名源 v1.0', size: 20, supportedSources: ['kw', 'kg'] }, 'y'.repeat(30), cfg)
    assert.strictEqual(v.act, 'replace')
    assert.ok(/本地版本更高/.test(v.why), '实际：' + v.why)
    ok('同名 + 本地版本更高 → 更新（先删旧再装新）')

    // 5) 服务端版本不低于本地 → 不折腾
    v = h.sameNameVerdict(mkE('x', deepOf(['kw', 'kg']), '同名源 v1.0'),
      { id: 's', name: '同名源 v2.0', size: 20, supportedSources: ['kw', 'kg'] }, 'y'.repeat(30), cfg)
    assert.strictEqual(v.act, 'skip')
    ok('同名 + 服务端版本不低于本地 → 保留服务端（不做无意义的替换）')

    // 6) 同名但平台完全不重叠 → 明显是两个无关脚本，改名并存，绝不删旧的
    v = h.sameNameVerdict(mkE('x', deepOf(['kw', 'kg'])),
      { id: 's', name: '同名源', size: 20, supportedSources: ['tx', 'wy'] }, 'y'.repeat(30), cfg)
    assert.strictEqual(v.act, 'rename')
    assert.ok(/完全不重叠/.test(v.why), '实际：' + v.why)
    ok('同名但支持平台零交集 → 视作无关脚本，改名并存（不删服务端那条）')

    // 7) 同名且平台有交集 → 同一音源的新版本，走替换
    v = h.sameNameVerdict(mkE('x', deepOf(['kw', 'kg', 'wy'])),
      { id: 's', name: '同名源', size: 20, supportedSources: ['kw', 'tx'] }, 'y'.repeat(30), cfg)
    assert.strictEqual(v.act, 'replace')
    assert.ok(/有重叠/.test(v.why), '实际：' + v.why)
    ok('同名且支持平台有交集 → 同一音源的新版本，更新（删旧装新）')

    // 8) 信息不足（服务端没声明平台 / 本地没检测）→ 按设置，默认替换
    v = h.sameNameVerdict(mkE('x', null), { id: 's', name: '同名源', size: 20 }, 'y'.repeat(30), cfg)
    assert.strictEqual(v.act, 'replace')
    ok('同名的信息不足（未检测 / 服务端未声明平台）→ 默认按更新处理（不做删除式猜测）')

    // 9) 设置里关掉自动替换 → 改名，不动服务端旧条目
    v = h.sameNameVerdict(mkE('x', null), { id: 's', name: '同名源', size: 20 }, 'y'.repeat(30), { replaceSameNameOnImport: false })
    assert.strictEqual(v.act, 'rename')
    ok('关闭「同名自动替换」后 → 改名上传，保留服务端旧版')
  }

  // -------------------------------------------------- 6. 「已灌入」不再硬跳过
  // 用户反馈的原话是「已灌入的无法二次灌入」。根因：本地账本说灌过就直接 skip，
  // 但用户可能早就在服务端网页端删掉了那条（或换了账号/服务端重置）——服务端上
  // 到底还有没有，必须以服务端此刻的列表为准。
  console.log('\n[已灌入不硬跳过]')
  {
    const normN = s => String(s || '').toLowerCase().replace(/[\[\]【】（）()|｜:：、,，.。\s_\-·•]+/g, '')
    const h = mkHunter()
    const mkE = id => ({
      id, name: '源' + id, lxName: '源' + id, scriptName: '源' + id, url: 'u',
      fromServer: false, contentHash: 'h-' + id, usable: true, deep: null, stale: false, lastModified: 1
    })
    const e = mkE('e1')
    const recs = { ['h-e1']: { name: '源e1', lxId: 'srv-old', sourceId: 'e1' } }

    // 服务端列表里还有那条 → 真的不用再灌
    let q = h._planImportQueue([e], {
      cfg: {}, serverByName: {}, serverIds: new Set(['srv-old', 'other']),
      codeCache: { e1: 'x' }, importedRecs: recs
    })
    assert.ok(q[0].skip && /无需重复灌入/.test(q[0].skip), '实际：' + JSON.stringify(q[0]))
    ok('服务端上确实还有那条 → 跳过（不重复灌）')

    // 服务端列表里没有那条（网页端删过 / 服务端重置）→ 允许重新灌入
    q = h._planImportQueue([e], {
      cfg: {}, serverByName: {}, serverIds: new Set(['other']),
      codeCache: { e1: 'x' }, importedRecs: recs
    })
    assert.ok(!q[0].skip, '实际：' + JSON.stringify(q[0]))
    assert.ok(/已无|重新灌入/.test(q[0].why || ''), '理由里要说清为什么重灌，实际：' + q[0].why)
    ok('服务端上已经没了 → 重新灌入（这就是「已灌入的无法二次灌入」的修复点）')

    // 读不到服务端列表（serverIds=null）→ 只能信本地账本，避免服务端一抖动把整库重灌一遍
    q = h._planImportQueue([e], {
      cfg: {}, serverByName: {}, serverIds: null,
      codeCache: { e1: 'x' }, importedRecs: recs
    })
    assert.ok(q[0].skip, '实际：' + JSON.stringify(q[0]))
    ok('读不到服务端列表 → 退回本地账本判定（宁可不灌，也不要因抖动重复灌一库）')

    // 账本按账号分开：只灌过 A 的源，灌 B 时不该被判「已灌入」
    h.store.imported = {
      e1: { lxId: 'A-1', name: '源e1', contentHash: 'h-e1', platformId: 'a', importedTo: [{ platformId: 'a', lxId: 'A-1' }] }
    }
    const recA = h._importedRecsFor('a', 'a')
    const recB = h._importedRecsFor('b', 'a')
    assert.ok(recA['h-e1'], 'A 账号应查到自己的记录')
    assert.strictEqual(recB['h-e1'], undefined, 'B 账号不该看到 A 的记录')
    ok('已灌入账本按平台账号分开统计（只灌过 A 的源，灌 B 时仍算未灌入）')

    // v1.8.0 之前的老记录没有 platformId → 归入当前选中账号，升级后行为不变
    h.store.imported = { e1: { lxId: 'old', name: '源e1', contentHash: 'h-e1' } }
    assert.ok(h._importedRecsFor('cur', 'cur')['h-e1'])
    assert.strictEqual(h._importedRecsFor('other', 'cur')['h-e1'], undefined)
    ok('老记录（无 platformId）归入当前选中账号（升级无感）')
  }

  // -------------------------------------------------- 7. 平台是否「按名字区分音源」
  // 实测结论（真实服务端）：
  //  - MusicSync：id 是 user_api_<时间戳>，连传两次同名都成功 → 同名不是冲突，
  //    对它做同名替换/改名纯属自找麻烦（还会顺手删掉一条本可共存的源）。
  //  - Songloft：id 由脚本 @name 生成（「聚合API接口 (by lerd)」→「聚合api接口-by-lerd」）→ 同名必撞。
  console.log('\n[平台能力：名字是否 key]')
  {
    const { REGISTRY } = require('../src/core/services')
    assert.strictEqual(REGISTRY.musicsync.uniqueName, false)
    assert.strictEqual(REGISTRY.songloft.uniqueName, true)
    assert.strictEqual(REGISTRY.lxserver.uniqueName, true)
    ok('适配器声明各自是否「按名字区分音源」（MusicSync false / 其余 true）')

    const h = mkHunter()
    const normN = s => String(s || '').toLowerCase().replace(/[\[\]【】（）()|｜:：、,，.。\s_\-·•]+/g, '')
    // 服务端声明 1 个平台（tx）、本地实测 1 个（kw）：数量持平 → 不触发「谁多用谁」，
    // 才能走到「零交集」这条规则（规则是顺序命中的，这里要构造成能落到改名分支）
    const srv = { id: 'srv', name: '同名源', size: 999, supportedSources: ['tx'] }
    const e = {
      id: 'e9', name: '同名源', lxName: '同名源', scriptName: '同名源', url: 'u', fromServer: false,
      contentHash: 'h9', usable: true, deep: { checkedAt: Date.now(), platforms: { kw: { status: 'usable' } } }, stale: false
    }
    const base = { cfg: {}, serverByName: { [normN('同名源')]: srv }, codeCache: { e9: 'x'.repeat(20) }, importedRecs: {} }

    // 名字是 key 的平台：零交集 → 改名并存（不能删服务端的）
    let q = h._planImportQueue([e], Object.assign({}, base, { uniqueName: true }))
    assert.ok(q[0].renameServer, '实际：' + JSON.stringify(q[0]))
    ok('名字是 key 的平台：同名零交集 → 改名并存')

    // 名字不是 key 的平台：同名不算冲突 → 直接上新条目，不删不改
    q = h._planImportQueue([e], Object.assign({}, base, { uniqueName: false }))
    assert.ok(!q[0].skip && !q[0].replaceServer && !q[0].renameServer, '实际：' + JSON.stringify(q[0]))
    assert.ok(/可共存/.test(q[0].why || ''), '实际：' + q[0].why)
    ok('名字不是 key 的平台（MusicSync）：同名不算冲突 → 直接上传新条目（不删不改他人的源）')
  }

  // -------------------------------------------------- 8. 改名安全阀
  // 实测教训：`_real_聚合API接口.js` 里有 `scriptInfo.name !== "聚合API接口 (by lerd)"`，
  // 只改 @name 注释会让脚本初始化失败（MusicSync 上直接报「初始化失败」）。
  // 宁可不灌，也不要在服务端留一条看着正常、实际跑不起来的源。
  console.log('\n[改名安全阀]')
  {
    const h = mkHunter()
    const normN = s => String(s || '').toLowerCase().replace(/[\[\]【】（）()|｜:：、,，.。\s_\-·•]+/g, '')
    const mk = code => ({
      id: 'e1', name: '同名源', lxName: '同名源', scriptName: '同名源', url: 'u', fromServer: false,
      contentHash: 'h1', usable: true, deep: { checkedAt: Date.now(), platforms: { kw: { status: 'usable' } } }, stale: false
    })
    // 服务端现条目支持 tx、本地实测 kw（零交集 → 本应改名并存；声明数与实测数持平才不会先命中「谁多用谁」）
    const srv = { id: 'srv', name: '同名源', size: 999, supportedSources: ['tx'] }
    const ctxOf = code => ({ cfg: {}, serverByName: { [normN('同名源')]: srv }, codeCache: { e1: code }, importedRecs: {} })

    // ① 脚本自检自己的名字（名字在源码里出现 2 次：@name 注释 + 自检断言）
    const selfCheck = [
      '/*!',
      ' * @name 同名源',
      ' * @description 自检名字的脚本',
      ' */',
      'if (scriptInfo.name !== "同名源" || !scriptInfo.version) { return }'
    ].join('\n')
    let q = h._planImportQueue([mk(selfCheck)], ctxOf(selfCheck))
    assert.ok(q[0].skip && /内部校验自身名称/.test(q[0].skip), '实际：' + JSON.stringify(q[0]))
    ok('脚本自己校验名字 → 不改名（规划阶段就拦下并说明该怎么办）')

    // ② 名字只在 @name 注释里出现 → 改名安全，照常改名并存
    const plain = ['/*!', ' * @name 同名源', ' * @description 普通脚本', ' */', 'lx.send("inited", { name: "同名源" })'].join('\n')
    q = h._planImportQueue([mk(plain)], ctxOf(plain))
    assert.ok(q[0].renameServer, '实际：' + JSON.stringify(q[0]))
    ok('名字只在 @name（和可一起改写的 inited）里出现 → 改名安全，照常改名并存')

    // ③ 执行阶段再兜一道：就算绕过规划，_uploadRenamed 也不会把脚本改成坏源
    const r = await h._uploadRenamed({ adapter: {}, acct: {} }, selfCheck, '同名源', {}, new Set())
    assert.strictEqual(r.success, false)
    assert.ok(r.renameUnsafe && /初始化失败/.test(r.message), '实际：' + JSON.stringify(r))
    ok('执行阶段二次兜底：宁可不灌，也不上传一个改名后跑不起来的坏源')
  }

  // -------------------------------------------------- 9. 服务端内容指纹判重
  // MusicSync 的列表接口会把脚本正文回传（适配器把它算成 hash），于是「服务端已经有同内容」
  // 可以不依赖本地账本判断 —— 账本丢了、换了账号、用户手动删过又重新同步，都拦得住重复。
  // 用户反馈的现象就是「同一个音源灌几轮，MusicSync 上堆出好几份一模一样的」。
  console.log('\n[服务端内容指纹判重]')
  {
    const h = mkHunter()
    const e = {
      id: 'e1', name: '源e1', lxName: '源e1', scriptName: '源e1', url: 'u',
      fromServer: false, contentHash: 'h-e1', usable: true, deep: null, stale: false
    }
    // 账本里什么都没有（模拟：换过账号 / 账本丢了），但服务端上已经有一条内容完全一样的
    let q = h._planImportQueue([e], {
      cfg: {}, serverByName: {}, serverList: [{ id: 'srv1', name: '源e1', hash: 'h-e1' }],
      serverIds: new Set(['srv1']), codeCache: { e1: 'x' }, importedRecs: {}
    })
    assert.ok(q[0].sameContentServer && q[0].sameContentServer.id === 'srv1', '实际：' + JSON.stringify(q[0]))
    ok('服务端已有同内容（按正文指纹比）→ 标记已灌入、不重复上传（不依赖本地账本）')

    // 服务端那条已经被删了 → 该重灌就重灌
    q = h._planImportQueue([e], {
      cfg: {}, serverByName: {}, serverList: [], serverIds: new Set(),
      codeCache: { e1: 'x' }, importedRecs: {}
    })
    assert.ok(!q[0].skip && !q[0].sameContentServer, '实际：' + JSON.stringify(q[0]))
    ok('服务端那条已经没了 → 正常重新灌入')

    // 有内容指纹时必须以指纹为准：长度一样但内容不同，不能误判成「同内容」
    const v = h.sameNameVerdict(
      { id: 'e1', name: '同名源', lxName: '同名源', scriptName: '同名源', url: 'u', contentHash: 'aaa', usable: true, deep: null, stale: false },
      { id: 's', name: '同名源', size: 20, hash: 'bbb' }, 'y'.repeat(20), {})
    assert.notStrictEqual(v.act, 'synced', '实际：' + JSON.stringify(v))
    ok('有内容指纹时以指纹为准：字节长度相同但内容不同 → 不判「同内容」')
  }

  // -------------------------------------------------- 10. 账本对账
  // 用户反馈：「已灌入页 28 个，音源库却显示 45 个」。差额来自本地账本和服务端脱节
  // （用户手动删过源、或那份记录属于别的账号）。对账后计数必然跟着服务端走。
  console.log('\n[账本对账]')
  {
    const h = mkHunter()
    h.store.imported = {
      s1: { lxId: 'A:1', name: '源一', contentHash: 'h1', platformId: 'a', importedTo: [{ platformId: 'a', lxId: 'A:1' }] },
      s2: {
        lxId: 'A:2', name: '源二', contentHash: 'h2', platformId: 'a',
        importedTo: [{ platformId: 'a', lxId: 'A:2' }, { platformId: 'b', lxId: 'B:2' }]
      },
      s3: { lxId: 'old', name: '老记录', contentHash: 'h3' }   // v1.8.0 之前：没有 platformId，归当前账号
    }
    h.store.config.activePlatformId = 'a'
    // A 上只剩 A:2（A:1 和那条老记录都已被用户在网页端删掉）
    const r = h.reconcileImported('a', ['A:2', 'A:9'])
    assert.strictEqual(r.dropped, 2, '实际：' + JSON.stringify(r))
    assert.strictEqual(h.store.imported.s1, undefined)
    assert.strictEqual(h.store.imported.s3, undefined)
    assert.ok(h.store.imported.s2, 's2 在 A 上还在，不能摘')
    assert.deepStrictEqual(h.store.imported.s2.importedTo.map(x => x.platformId), ['a', 'b'])
    ok('服务端上还存在的记录原样保留（对账一视同仁地放过还活着的那条）')

    // 切到 B 对账：B 上一条都没了 → 只摘 B 那份，A 那份必须留着
    const r2 = h.reconcileImported('b', [])
    assert.strictEqual(r2.dropped, 1)
    assert.ok(h.store.imported.s2, 's2 在 A 上还有一份，整条记录不能删')
    assert.deepStrictEqual(h.store.imported.s2.importedTo.map(x => x.platformId), ['a'])
    assert.strictEqual(h.store.imported.s2.platformId, 'a')
    assert.strictEqual(h.store.imported.s2.lxId, 'A:2')
    ok('对账只作用于指定账号：B 那份被摘掉，A 那份（含顶层指针）完整保留')

    h.store.imported.s4 = { lxId: 'A:4', platformId: 'a', contentHash: 'h4', importedTo: [{ platformId: 'a', lxId: 'A:4' }] }
    const r3 = h.reconcileImported('a', undefined)
    assert.strictEqual(r3.dropped, 0)
    assert.ok(h.store.imported.s4)
    ok('没拿到服务端列表（undefined）→ 一条都不删（防止把整库记录误删）')
  }

  console.log(`\n全部通过：${pass} 项断言`)
}

main().catch(e => { console.error('\n测试异常：', e); process.exit(1) })
