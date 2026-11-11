'use strict'
/**
 * 多平台适配器工厂（v1.8.0）
 *
 * 把「自建 LX 服务（lxserver）」「Geelonn LX Server（gefl24/lxserver）」「Songloft 平台内
 * lxmusic 插件」「MusicSync」四个平台统一成同一组接口，供 hunter.js / main / web 按
 * 「当前选中的平台账号」路由。
 *
 * 账号对象（存于 config.platforms）：
 *   { id, type:'lxserver'|'geelonn'|'songloft'|'musicsync', name, url, username, password, timeoutMs, enabled }
 *
 * 统一接口（每个适配器都实现）：
 *   verify(acct) → {ok, msg}
 *   list(acct)   → [{id, name, enabled, owner?, supportedSources, size?, disabledSources, filename?, version?}]
 *   upload(acct, content, filename) → {success, id?, name?, platforms?, message?}
 *   importUrl(acct, url, name)      → {...}
 *   toggle(acct, id, enabled, opts)  → {success}
 *   remove(acct, id, opts)           → {success}
 *   setPlatforms(acct, id, disabledSources, opts) → {success}
 *   validate(acct, code)             → {status, data, text}
 *   baseUrl(acct)                    → string
 *
 * lxserver 适配器额外提供 listPublic / removePublic / removePublicBatch / planPublicCleanup /
 * isPublicSource / targetUsername（公共音源清理能力，仅 lxserver 有）。
 */
const lxserver = require('./lxserver')
const geelonn = require('./geelonn')
const songloft = require('./songloft')
const musicsync = require('./musicsync')

const REGISTRY = { lxserver, geelonn, songloft, musicsync }

const TYPE_LABELS = {
  lxserver: 'LX Server（自建服务）',
  geelonn: 'Geelonn LX Server（gefl24/lxserver）',
  songloft: 'Songloft（lxmusic 插件）',
  musicsync: 'MusicSync（多用户同步）'
}

function getService(type) {
  const a = REGISTRY[type]
  if (!a) throw new Error('不支持的服务平台类型：' + type)
  return a
}

/**
 * 取当前选中的平台账号 → { adapter, acct, type }
 * 没有平台账号或没选中 → 返回 null（调用方应给出清晰错误）。
 */
function getActiveService(config) {
  const list = (config && config.platforms) || []
  const id = config && config.activePlatformId
  const acct = (id && list.find(p => p.id === id)) || list[0]
  if (!acct) return null
  const adapter = getService(acct.type)
  return { adapter, acct, type: acct.type }
}

/**
 * 把账号包装成 { adapter, acct, type }（内部复用，避免每处都手写 getService）。
 */
function wrap(acct) {
  return { adapter: getService(acct.type), acct, type: acct.type }
}

/**
 * 批量灌入的目标账号（v1.8.0 多平台同时灌入）。
 *
 * 约定：账号上带 batchImport === true 表示「参与批量灌入」。
 * - 一个都没标记 → 回退为「只灌当前选中账号」（与旧版行为一致，老用户无感升级）；
 * - 标记了 → 只灌标记的那些（用户可以只勾其中两个，不想灌的别勾）。
 * enabled === false 的账号一律跳过（禁用的账号不参与任何自动行为）。
 */
function getBatchImportAccounts(config) {
  const list = ((config && config.platforms) || []).filter(p => p && p.type && p.enabled !== false)
  const marked = list.filter(p => p.batchImport === true)
  if (marked.length) return marked
  const cur = getActiveService(config)
  return cur ? [cur.acct] : []
}

/**
 * 灌入目标 = 批量灌入账号列表对应的适配器集合。
 * 没有任何可用账号 → 空数组（调用方应报 NO_ACCOUNT_ERR）。
 */
function getImportTargets(config) {
  return getBatchImportAccounts(config).map(wrap)
}

/**
 * 解析「用于服务端调用的适配器 + 账号」。
 * - 无 override：取当前选中的平台账号（getActiveService）。
 * - 有 override 且带合法 type：把它当作「正在编辑/预览的账号」直接构造适配器
 *   （设置页填完表单点「测试连接」时用，不写盘）。
 * 没有任何账号 → 返回 null，调用方应给出清晰错误。
 */
function resolveService(config, override) {
  if (override && override.type && REGISTRY[override.type]) {
    const acct = Object.assign(
      { id: 'preview', name: override.name || 'preview', enabled: true, timeoutMs: 25000 },
      override
    )
    return { adapter: REGISTRY[override.type], acct, type: override.type, preview: true }
  }
  const cur = getActiveService(config)
  if (cur) cur.preview = false   // 与预览态分支保持同构，调用方不必区分「字段缺失」和「非预览」
  return cur
}

const NO_ACCOUNT_ERR = '未配置或未选择服务平台账号：请先在「设置」里添加并选中一个平台账号'

/**
 * 服务端「自检护栏」隔离名单（v1.13.0）。
 * 只有 lxserver 有这个能力（其余平台没有隔离概念）→ 没有该方法就当空名单。
 * 读失败也不抛：隔离名单只是灌入前的附加否决信号，不能因为读不到就卡住整个灌入。
 */
async function getIsolations(svc) {
  if (!svc || !svc.adapter || typeof svc.adapter.listIsolations !== 'function') return []
  try {
    const ids = await svc.adapter.listIsolations(svc.acct)
    return Array.isArray(ids) ? ids : []
  } catch (e) {
    return []
  }
}

module.exports = {
  getService, getActiveService, resolveService, TYPE_LABELS, REGISTRY,
  getBatchImportAccounts, getImportTargets, getIsolations,
  NO_ACCOUNT_ERR, SUPPORTED_TYPES: Object.keys(REGISTRY)
}
