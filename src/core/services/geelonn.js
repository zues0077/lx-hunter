'use strict'
/**
 * Geelonn LX Server（gefl24/lxserver）适配器
 *
 * gefl24/lxserver 是基于 LX Music Sync Server（XCQ0607/lxserver）的魔改 fork，
 * 新增本地歌曲管理 / Subsonic API / 小爱音箱等能力，但**核心自定义音源 API 完全沿用
 * 原 lxserver**：灌入仍走 /api/custom-source/* ，鉴权头仍是 x-frontend-auth = frontend.password。
 * 因此本适配器与 lxserver.js 是同一套薄封装，仅 kind 不同，便于以后 geelonn 若 divergence
 * 时能独立演进，不影响既有 lxserver 行为。
 *
 * 账号对象字段：{ url, password, username, timeoutMs }（与 lxserver 完全一致）
 *   url       → lxservice 的 serverUrl
 *   password  → adminPassword（frontend.password）
 *   username  → 灌入目标身份（default=公开源，具名=私有源）
 *   timeoutMs → serverTimeoutMs
 */
const L = require('../lxservice')

function toCfg(acct) {
  return {
    serverUrl: acct && acct.url || '',
    adminPassword: acct && acct.password || '',
    username: (acct && acct.username) || 'default',
    serverTimeoutMs: (acct && acct.timeoutMs) || 25000
  }
}

function verify(acct) { return L.verify(toCfg(acct)) }
function list(acct) { return L.list(toCfg(acct)) }
function upload(acct, content, filename) { return L.upload(toCfg(acct), content, filename) }
function importUrl(acct, url, name) { return L.importUrl(toCfg(acct), url, name) }
function toggle(acct, id, enabled, opts) { return L.toggle(toCfg(acct), id, enabled, opts) }
function remove(acct, id, opts) { return L.remove(toCfg(acct), id, opts) }
function setPlatforms(acct, id, disabledSources, opts) { return L.setPlatforms(toCfg(acct), id, disabledSources, opts) }
function validate(acct, code) { return L.validate(toCfg(acct), code) }
function baseUrl(acct) { return L.baseUrl(toCfg(acct)) }

// ---- 公共音源清理（与 lxserver 同源：geelonn 保留同一套 custom-source 存储与接口） ----
function listPublic(acct) { return L.listPublic(toCfg(acct)) }
function removePublic(acct, id) { return L.removePublic(toCfg(acct), id) }
function removePublicBatch(acct, ids, onProgress) { return L.removePublicBatch(toCfg(acct), ids, onProgress) }
function planPublicCleanup(serverList) { return L.planPublicCleanup(serverList) }
function isPublicSource(s) { return L.isPublicSource(s) }
function targetUsername(acct) { return L.targetUsername(toCfg(acct)) }

module.exports = {
  kind: 'geelonn',
  // 名字即 key：服务端按脚本 @name 生成 id，重名会被拒（README「灌入提示已存在」即此）。
  uniqueName: true,
  verify, list, upload, importUrl, toggle, remove, setPlatforms, validate, baseUrl,
  listPublic, removePublic, removePublicBatch, planPublicCleanup, isPublicSource, targetUsername
}
