// 巡检「连续 N 次失效自动删除音源」判定与 runPatrol 删除行为（v1.9.1）
// 思路：把 checkBasic / deepCheck 桩掉（返回「域名失效 → patrolJudge 判 dead」），
// 让 runPatrol 走到 dead 分支并触发自动删除；本文件独立进程，不影响其它测试。
const fs = require('fs')
const os = require('os')
const path = require('path')
const checker = require('../src/core/checker')

// 桩：让 checkBasic 通过并给出脚本；deepCheck 返回「域名失效」使 patrolJudge 判 dead（streak 递增）
checker.checkBasic = async (e) => { e.status = 'ok'; e.suspected = true; e.error = ''; return { code: 'SCRIPT_CODE' } }
checker.deepCheck = async () => ({
  loadable: true, cancelled: false, loadError: null, deadDomain: true,
  platforms: { wy: { status: 'failed', message: '接口域名已失效（公共 DNS 确认不存在）' } },
  usable: 0, hash: 'h', checkedAt: Date.now()
})
// 重新载入 hunter，使其捕获上面的桩
delete require.cache[require.resolve('../src/core/hunter')]
const { Hunter, patrolAutoDeleteWanted } = require('../src/core/hunter')
const { Store, DEFAULT_CONFIG } = require('../src/core/store')

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? ' -> ' + x : ''}`) }

// ---------- 纯函数判定 ----------
ck('默认关闭（patrolAutoDelete=false）不删', patrolAutoDeleteWanted({ patrolAutoDelete: false }, 9) === false)
ck('开启但未达阈值(2<3)不删', patrolAutoDeleteWanted({ patrolAutoDelete: true, patrolDeleteAfter: 3 }, 2) === false)
ck('开启且达阈值(3)删除', patrolAutoDeleteWanted({ patrolAutoDelete: true, patrolDeleteAfter: 3 }, 3) === true)
ck('开启且超阈值删除', patrolAutoDeleteWanted({ patrolAutoDelete: true, patrolDeleteAfter: 3 }, 5) === true)
ck('未配置 patrolAutoDelete 当作关闭', patrolAutoDeleteWanted({}, 9) === false)
ck('阈值缺省按 3 计', patrolAutoDeleteWanted({ patrolAutoDelete: true }, 3) === true)

;(async () => {
  // ---------- 场景 A：开启自动删除，连续 3 次失效 → 删除 ----------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-patrol-del-'))
    const store = new Store(dir)
    store.config = Object.assign({}, DEFAULT_CONFIG, store.config, {
      patrolAutoDelete: true, patrolDeleteAfter: 3, patrolAutoDisable: true, serverDeleteIntervalMs: 5
    })
    const lxId = 'lx_del_1', srcId = 'src_del_1'
    store.imported[srcId] = { lxId, name: '失效源A', patrolFailStreak: 2 }
    store.db.sources[srcId] = { id: srcId, name: '失效源A', scriptName: '失效源A', url: 'https://example.com/a.js', usable: false }
    store.saveImported(); store.saveDb()

    const removed = []
    const fakeAdapter = {
      list: async () => [{ id: lxId, owner: 'open' }],
      remove: async (acct, id, opts) => { removed.push({ id, opts }); return { success: true } },
      setPlatforms: async () => ({ success: true }),
      toggle: async () => ({ success: true })
    }
    const hunter = new Hunter(store, () => {})
    hunter._active = () => ({ adapter: fakeAdapter, acct: { id: 'p1', name: 't' } })

    const res = await hunter.runPatrol()
    ck('连续 3 次失效触发自动删除', res.deleted === 1, JSON.stringify(res))
    ck('服务端 remove 被调用且 id 正确', removed.length === 1 && removed[0].id === lxId, JSON.stringify(removed))
    ck('本地 imported 记录已移除', !store.imported[srcId])
    ck('本地 db.sources 记录已移除', !store.db.sources[srcId])
  }

  // ---------- 场景 B：关闭自动删除 → 只禁用不删 ----------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-patrol-nodel-'))
    const store = new Store(dir)
    store.config = Object.assign({}, DEFAULT_CONFIG, store.config, {
      patrolAutoDelete: false, patrolDeleteAfter: 3, patrolAutoDisable: true, serverDeleteIntervalMs: 5
    })
    const lxId = 'lx_nd_1', srcId = 'src_nd_1'
    store.imported[srcId] = { lxId, name: '失效源B', patrolFailStreak: 2 }
    store.db.sources[srcId] = { id: srcId, name: '失效源B', scriptName: '失效源B', url: 'https://example.com/b.js', usable: false }
    store.saveImported(); store.saveDb()

    const removed = []
    const fakeAdapter = {
      list: async () => [{ id: lxId, owner: 'open' }],
      remove: async () => { removed.push(1); return { success: true } },
      setPlatforms: async () => ({ success: true }),
      toggle: async () => ({ success: true })
    }
    const hunter = new Hunter(store, () => {})
    hunter._active = () => ({ adapter: fakeAdapter, acct: { id: 'p1', name: 't' } })

    const res = await hunter.runPatrol()
    ck('关闭自动删除时不删除', res.deleted === 0 && removed.length === 0, JSON.stringify(res))
    ck('未达删除阈值的失效源仍保留在库', !!store.imported[srcId])
  }

  console.log('\n' + (bad === 0 ? 'ALL PASS' : bad + ' FAILED'))
  process.exit(bad ? 1 : 0)
})().catch(e => { console.error('ERR', e); process.exit(1) })
