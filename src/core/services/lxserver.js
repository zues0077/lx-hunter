'use strict'
/**
 * LX Server（XCQ0607/lxserver）适配器
 *
 * 仅做「账号对象 → lxservice cfg」的薄封装，业务逻辑全部复用 src/core/lxservice.js，
 * 以保证 owner-routing / public-cleanup / identity-mismatch 等既有契约与单测完全不变。
 *
 * 账号对象字段：{ url, password, username, timeoutMs }
 *   url       → lxservice 的 serverUrl
 *   password  → adminPassword（frontend.password）
 *   username  → 灌入目标身份（留空/default=公开源，具名=私有源）
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
// S3 原子性：删旧灌新失败时从服务端回收站自动恢复旧脚本
function listTrash(acct, owner) { return L.listTrash(toCfg(acct), owner) }
function restoreTrash(acct, owner, file) { return L.restoreTrash(toCfg(acct), owner, file) }

// ---- lxserver 专属：公共音源清理（v1.7.4），其余平台不支持 ----
function listPublic(acct) { return L.listPublic(toCfg(acct)) }
function removePublic(acct, id) { return L.removePublic(toCfg(acct), id) }
function removePublicBatch(acct, ids, onProgress) { return L.removePublicBatch(toCfg(acct), ids, onProgress) }
function planPublicCleanup(serverList) { return L.planPublicCleanup(serverList) }
function isPublicSource(s) { return L.isPublicSource(s) }
function targetUsername(acct) { return L.targetUsername(toCfg(acct)) }

module.exports = {
  kind: 'lxserver',
  // 名字即 key：服务端按脚本 @name 生成 id，重名会被拒（README「灌入提示已存在」即此）。
  uniqueName: true,
  verify, list, upload, importUrl, toggle, remove, setPlatforms, validate, baseUrl,
  listTrash, restoreTrash,
  listPublic, removePublic, removePublicBatch, planPublicCleanup, isPublicSource, targetUsername
}
