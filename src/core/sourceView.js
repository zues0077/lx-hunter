'use strict'
/**
 * 列表接口的音源视图：剥掉脚本正文（`code`）。
 *
 * 为什么单独一层（2026-11-11 性能项 1）：
 *  - `/api/sources` 实测 14.3MB，其中 `code` 11.6MB = 81%。手机/弱网打开一次列表就下 14MB，
 *    NAS 上每次刷新也要序列化 + 传 11MB，列表首屏明显发卡。
 *  - 前端列表**一个字段都不用正文**：预览/导出/检测/灌入/撤回全在服务端按 `id` 取，
 *    renderer 里 grep `\.code` 零命中（只留在 `tests/external-source.test.js` 的采集断言里）。
 *  - 剥掉后 14.3MB → 2.7MB（实测），元信息（state/deep/obfHits/dupOf…）一个不丢。
 *
 * 注意：只用「列表」接口剥正文，`store` 内部、灌入/检测/导出一律拿完整条目。
 * 将来若前端真要显示正文，另开按 id 取单条正文的接口，别把 11MB 又塞回列表。
 */
const STRIP_FIELDS = ['code']

function publicSourceView(src) {
  if (!src || typeof src !== 'object') return src
  const out = Object.assign({}, src)
  for (const k of STRIP_FIELDS) delete out[k]
  return out
}

function publicSourceList(list) {
  const arr = Array.isArray(list) ? list : []
  return arr.map(publicSourceView)
}

module.exports = { publicSourceView, publicSourceList, STRIP_FIELDS }
