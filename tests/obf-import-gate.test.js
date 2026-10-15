'use strict'
/**
 * v1.9.5 灌入前混淆剔除闸门（runImport）行为测试。
 *
 * 背景（2026-10-15 NAS CPU 占用定位实测）：jsjiami.com.v7 混淆的「洛雪音乐源.js」
 * 独吞 63%~67% 单核 + 270MB 内存，其余 45 个音源合计 ≈ 0%。该脚本签名：
 * while(!![]){} 空转死循环 + _0xKEY[_0xK(..)](_0xFN,0x7d0) 混淆自调度 + jsjiami 标识。
 *
 * 用户要求：设置里勾选后「每次灌入」都自动剔除此类音源。检测阶段（runCheck）只管
 * 新检测的条目，两条路径会绕开它——① 开关打开前就已检测入库的老条目；② 用户手动
 * 勾选直接灌入。所以 runImport 在下载预处理之后、队列规划之前必须再过一遍闸门。
 *
 * 覆盖：
 *  ① 默认开（v1.9.5 起）——高危条目灌不进去，干净条目照常灌；
 *  ② 手动关闭 —— 不拦（用户自担风险，与旧行为一致）；
 *  ③ 全部被剔 —— 不抛错、不上传、返回 obfRejected 计数；
 *  ④ 条目落库状态 —— status=dead / error / obfLevel=high，UI 徽章有据可查。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Hunter } = require('../src/core/hunter')
const { Store } = require('../src/core/store')
const svc = require('../src/core/services')

let pass = 0
const ok = n => { pass++; console.log('  ✓ ' + n) }

const ACCT = (id, type, extra) => Object.assign(
  { id, type, name: id.toUpperCase(), url: 'http://' + id, username: 'u', password: 'p', timeoutMs: 5000, enabled: true, batchImport: true },
  extra || {}
)

/** 假适配器：只记录上传，够验证「谁被灌进去了」 */
function mkFake(name) {
  const st = { uploads: [], listCalls: 0, verifyCalls: 0 }
  return {
    st,
    verify: async () => { st.verifyCalls++; return { ok: true, msg: 'ok' } },
    list: async () => { st.listCalls++; return [] },
    upload: async (acct, code, filename) => { st.uploads.push({ code, name: filename }); return { success: true, id: name + ':' + filename, name: filename, platforms: ['kw'] } },
    remove: async () => ({ success: true }),
    importUrl: async () => ({ success: true, id: name + ':url', name: 'url', platforms: [] }),
    toggle: async () => ({ success: true }),
    setPlatforms: async () => ({ success: true }),
    validate: async () => ({ status: 'ok', data: {} }),
    baseUrl: () => 'http://' + name
  }
}

const CLEAN = '// -------- yunmge 酷我 --------\nconst getYunmgeKw = async (songId, quality, musicInfo) => {\n  const id = musicInfo?.rid || musicInfo?.songmid || songId\n  if (!id) throw new Error("yunmge: 缺少 id")\n  const brMap = { "128k":128, "320k":320 }\n  const resp = await httpFetch(url, { method: "GET", timeout: 8000 })\n  return resp.body\n}\n'.repeat(20)
// 罪魁脚本同款签名（精简复刻）：空转死循环 + 混淆自调度 + jsjiami 标识
const BAD = CLEAN + [
  "var _0xodM='jsjiami.com.v7';const _0xa83665=_0x289b;",
  'const _0x1a649c=function(){while(!![]){}};return check(_0x1a649c);',
  "_0x10ce4b[_0x1ff486(0x2dd,'NbSd')](_0x2bcf9e,0x7d0);}());var version_ = 'jsjiami.com.v7';"
].join('\n')

const FAKE = mkFake('gate')
svc.REGISTRY.fakeGate = FAKE

function mkHunter() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-obfgate-'))
  const store = new Store(dir)
  const h = Object.create(Hunter.prototype)
  h.store = store
  h.job = { running: false }
  h.emit = () => {}
  h.log = () => {}
  h.step = () => {}
  h.progress = () => {}
  h.mirrorPref = null
  return h
}

const mkSrc = (id, name, code) => ({ id, name, lxName: name, scriptName: name, url: 'http://x/' + id + '.js', code, contentHash: 'h-' + id, usable: true, status: 'ok', deep: null, deprecated: false, fromServer: false, stale: false, suspectScore: 8, suspected: true })

async function main() {
  // ① 默认开：高危灌不进去，干净照常
  {
    const h = mkHunter()
    assert.strictEqual(h.store.config.excludeHighRiskObfuscated, true, 'v1.9.5 起默认应开启')
    h.store.config.platforms = [ACCT('g', 'fakeGate')]
    h.store.config.activePlatformId = 'g'
    h.store.db.sources = { bad: mkSrc('bad', '洛雪音乐源', BAD), good: mkSrc('good', '云曼酷我', CLEAN) }
    h.store.saveDb()
    const before = FAKE.st.uploads.length
    const r = await h.runImport(['bad', 'good'])
    assert.strictEqual(FAKE.st.uploads.length - before, 1, '只应上传干净音源，实际 ' + (FAKE.st.uploads.length - before))
    assert.strictEqual(FAKE.st.uploads[FAKE.st.uploads.length - 1].name, '云曼酷我')
    assert.strictEqual(r.obfRejected, 1, '应报告剔除 1 条')
    const bad = h.store.db.sources.bad
    assert.strictEqual(bad.status, 'dead')
    assert.strictEqual(bad.error, '重度混淆脚本，已按设置剔除')
    assert.strictEqual(bad.obfLevel, 'high')
    assert.ok(bad.obfHits && bad.obfHits.spinLoops === 1 && bad.obfHits.selfSchedCalls === 1, 'hits 应带反调试特征计数')
    ok('灌入前剔除高危条目：干净音源照常灌，高危条目标 dead + 特征计数落库')
  }

  // ② 手动关闭：不拦（与旧行为一致，风险自担）
  {
    const h = mkHunter()
    h.store.config.excludeHighRiskObfuscated = false
    h.store.config.platforms = [ACCT('g', 'fakeGate')]
    h.store.config.activePlatformId = 'g'
    h.store.db.sources = { bad: mkSrc('bad', '洛雪音乐源', BAD) }
    h.store.saveDb()
    const before = FAKE.st.uploads.length
    await h.runImport(['bad'])
    assert.strictEqual(FAKE.st.uploads.length - before, 1, '关闭后不应拦截')
    ok('关闭开关后不拦截（保持旧行为，用户自担风险）')
  }

  // ③ 全部被剔：不抛错、不上传、计数正确
  {
    const h = mkHunter()
    h.store.config.platforms = [ACCT('g', 'fakeGate')]
    h.store.config.activePlatformId = 'g'
    h.store.db.sources = { bad: mkSrc('bad', '洛雪音乐源', BAD) }
    h.store.saveDb()
    const before = FAKE.st.uploads.length
    const r = await h.runImport(['bad'])
    assert.strictEqual(FAKE.st.uploads.length - before, 0, '全剔时不应有任何上传')
    assert.strictEqual(r.obfRejected, 1)
    assert.deepStrictEqual(r.results, [])
    assert.strictEqual(r.ok, 0)
    ok('全部被剔：不抛错、零上传、返回 obfRejected')
  }

  console.log(`\n灌入闸门测试 ALL PASS（${pass} 项）`)
}

main().catch(e => { console.error('测试异常:', e); process.exit(1) })
