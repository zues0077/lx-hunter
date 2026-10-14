'use strict'
/**
 * v1.6.6 停用状态同步口径测试
 *
 * 背景（lxserver 源码实锤）：
 *  - 平台级停用 disabledSources 按身份分文件存：users/source/_open/states.json（公开源）
 *    与 users/source/admin/states.json（admin 私有源）是两份独立文件；
 *  - LX 网页端音源管理页固定读 default→_open 那份（前端 currentListData?.username
 *    恒为 default：歌单接口返回里没有 username 字段，与实际登录账号无关）；
 *  - 旧版猎手以 cfg.username=admin 写入 → 写进 admin/states.json → 网页端永远看不到。
 *
 * 修复：setPlatforms 固定以 username='default' 写入（服务端映射 _open）；
 *       list() 以 default 视角读回为主，再按 id 补充具名用户的私有源。
 */
const assert = require('assert')
const path = require('path')

// 注意：lxservice 在 require 时就从 ./net 解构了 fetchWithTimeout，
// 必须在首次 require 之前装好假实现（闭包读可变 mode，避免重复 require）。
const net = require(path.join(__dirname, '..', 'src', 'core', 'net'))
const realFetch = net.fetchWithTimeout
let calls = []
let mode = 'ok'
const OPEN_LIST = [
  { id: 'open1', name: '公开源A', owner: 'open', supportedSources: ['wy', 'tx'], disabledSources: [] },
  { id: 'shared', name: '同名源(公开版)', owner: 'open', supportedSources: ['wy'], disabledSources: ['wy'] }
]
const PRIV_LIST = [
  { id: 'shared', name: '同名源(admin私有版)', owner: 'admin', supportedSources: ['kw'], disabledSources: [] },
  { id: 'priv1', name: 'admin私有源', owner: 'admin', supportedSources: ['kg'], disabledSources: [] }
]
net.fetchWithTimeout = async (url, init) => {
  calls.push({ url, init })
  if (mode === 'fail') return { ok: false, status: 500, text: async () => JSON.stringify({ success: false, error: 'boom' }) }
  const u = String(url)
  if (u.includes('/api/custom-source/update-platforms')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, disabledSources: JSON.parse(init.body).disabledSources }) }
  }
  if (u.includes('/api/custom-source/list')) {
    const qs = new URL(u).searchParams.get('username')
    return { ok: true, status: 200, text: async () => JSON.stringify(qs === 'default' ? OPEN_LIST : PRIV_LIST) }
  }
  return { ok: true, status: 200, text: async () => '{}' }
}

const lx = require(path.join(__dirname, '..', 'src', 'core', 'lxservice'))

let passed = 0
function ck(name, cond, extra) {
  assert.ok(cond, name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''))
  passed++
  console.log('ok -', name)
}

;(async () => {
  // ---------- setPlatforms：固定写公开(_open)，不写 admin ----------
  calls = []
  const cfgAdmin = { serverUrl: 'http://srv:7968', adminPassword: 'pw', username: 'admin' }
  const r1 = await lx.setPlatforms(cfgAdmin, 'open1', ['wy', 'tx'])
  ck('停用返回 success', r1.success === true, r1)
  ck('只发一次请求（不双写）', calls.length === 1, calls.length)
  ck('请求打到 update-platforms', calls[0].url.includes('/api/custom-source/update-platforms'), calls[0].url)
  const body1 = JSON.parse(calls[0].init.body)
  ck('写入身份固定为 default（→_open）', body1.username === 'default', body1.username)
  ck('disabledSources 原样透传', JSON.stringify(body1.disabledSources) === JSON.stringify(['wy', 'tx']), body1.disabledSources)
  ck('带管理员鉴权头（open 源操作需要）', calls[0].init.headers['x-frontend-auth'] === 'pw')

  // 恢复启用（空数组）同样走公开口径
  calls = []
  const r2 = await lx.setPlatforms(cfgAdmin, 'open1', [])
  ck('恢复启用 success', r2.success === true)
  ck('恢复启用也只发一次请求', calls.length === 1, calls.length)
  ck('恢复启用身份仍为 default', JSON.parse(calls[0].init.body).username === 'default')

  // 服务端失败：不谎报 success
  calls = []
  mode = 'fail'
  const r3 = await lx.setPlatforms(cfgAdmin, 'open1', ['wy'])
  mode = 'ok'
  ck('服务端失败时不谎报 success', r3.success === false && /boom/.test(r3.message || ''), r3)

  // ---------- list：公开视角为主 + 私有源补充 ----------
  calls = []
  const merged = await lx.list(cfgAdmin)
  const queried = calls.map(c => new URL(String(c.url)).searchParams.get('username'))
  ck('list 先查 default 再查 admin', JSON.stringify(queried) === JSON.stringify(['default', 'admin']), queried)
  const ids = merged.map(s => s.id)
  ck('合并后共 3 条（2 公开 + 1 私有独有）', merged.length === 3, ids)
  ck('私有源不丢', ids.includes('priv1'), ids)
  const shared = merged.find(s => s.id === 'shared')
  ck('同 id 冲突以公开源条目为准', shared.owner === 'open', shared)
  ck('公开源停用状态按 _open 口径读回', JSON.stringify(shared.disabledSources) === JSON.stringify(['wy']), shared.disabledSources)

  // username=default 时只查一次
  calls = []
  const merged2 = await lx.list({ serverUrl: 'http://srv:7968', adminPassword: 'pw', username: 'default' })
  ck('default 身份只查一次', calls.length === 1, calls.length)
  ck('default 身份不混入私有源', merged2.length === 2 && !merged2.some(s => s.id === 'priv1'), merged2.map(s => s.id))

  net.fetchWithTimeout = realFetch
  console.log(`\nplatform-sync: ${passed} 项全部通过`)
})().catch(e => { net.fetchWithTimeout = realFetch; console.error('FAIL:', e.message); process.exit(1) })
