'use strict'
/**
 * 极简内存 zip 读取器（零第三方依赖，zlib 为 Node 内置模块）。
 * 用途：GitHub 音源仓库里大量音源打包成 zip 分发，爬取时下载后直接解出脚本原文，
 * 省掉「先入库一个 zip 链接、检测时再下载再解压」的往返。
 *
 * 只支持常见情形：
 *  - STORE(0) / DEFLATE(8) 两种压缩方法
 *  - 无加密、无 zip64（GitHub 仓库附带的压缩包远达不到 4GB）
 *  - 压缩包尺寸以中央目录为准（local header 里 bit-3 数据描述符场景不受影响）
 */
const zlib = require('zlib')
const { TextDecoder } = require('util')

const REPL = '\uFFFD'

/** 计数替换符 U+FFFD —— 中文 GBK 字节被按 UTF-8 解时就变成它（页面上的黑色菱形问号） */
function countReplacement(s) {
  let n = 0
  for (const ch of String(s || '')) if (ch === REPL) n++
  return n
}

let _gbk = null
function gbkDecoder() {
  if (_gbk === null) {
    try { _gbk = new TextDecoder('gbk') } catch (e) { _gbk = false }
  }
  return _gbk || null
}

/** 判断 UTF-8 解出来的「伪中文」：GBK 双字节常被解成亚美尼亚/希伯来/西里尔扩展等罕见区块 */
function looksGarbled(s) {
  if (countReplacement(s) > 0) return true
  let odd = 0, cjk = 0
  for (const ch of String(s || '')) {
    const c = ch.codePointAt(0)
    if (c >= 0x4e00 && c <= 0x9fff) cjk++
    else if (c > 127 && (
      (c >= 0x0530 && c <= 0x058f) ||  // 亚美尼亚
      (c >= 0x0590 && c <= 0x05ff) ||  // 希伯来
      (c >= 0x0400 && c <= 0x052f) ||  // 西里尔
      (c >= 0x0600 && c <= 0x06ff)     // 阿拉伯
    )) odd++
  }
  return odd > 0 && cjk === 0
}

/**
 * ZIP entry 名解码。
 * ZIP 规范：central directory 的 general purpose bit 11 (0x0800) 置位才表示文件名是 UTF-8；
 * 未置位时是本地编码，中文 Windows 打包出来就是 GBK。旧实现无条件 toString('utf8')，
 * 于是 Release zip 里含中文的脚本名整串变 U+FFFD（音源库页菱形），2026-11-10 实机定位。
 */
function decodeZipName(nameBuf, flags) {
  const b = Buffer.isBuffer(nameBuf) ? nameBuf : Buffer.from(String(nameBuf || ''))
  if (!b.length) return ''
  const utf8 = b.toString('utf8')
  const dec = gbkDecoder()
  const gbk = dec ? dec.decode(b) : null
  const utf8Flag = !!(Number(flags || 0) & 0x0800)
  if (utf8Flag) {
    // 打包工具偶尔乱置 flag：声称 UTF-8 却塞 GBK，出现替换符就回退
    if (gbk && countReplacement(utf8) > 0 && countReplacement(gbk) < countReplacement(utf8)) return gbk
    return utf8
  }
  // 未置位：按规范优先本地编码（纯 ASCII 名两种解码结果完全一致，无损）
  if (gbk && !looksGarbled(gbk) && (looksGarbled(utf8) || countReplacement(gbk) < countReplacement(utf8))) return gbk
  return utf8
}

/**
 * 脚本正文解码：绝大多数是 UTF-8，保持原样（避免误伤）；只有明确出现替换符或
 * 「伪中文」时才用 GBK 重解。ZIP 内文件名用 decodeZipName，不要用这个。
 */
function decodeScriptText(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''))
  if (!b.length) return ''
  const utf8 = b.toString('utf8')
  if (!looksGarbled(utf8)) return utf8.replace(/^\uFEFF/, '')
  const dec = gbkDecoder()
  const gbk = dec ? dec.decode(b) : null
  if (gbk && !looksGarbled(gbk)) return gbk.replace(/^\uFEFF/, '')
  return utf8.replace(/^\uFEFF/, '')
}

/** 在文件末尾向前找 EOCD（End Of Central Directory）签名 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

/**
 * 解出 zip 内全部文件。
 * @param {Buffer} buf zip 原始字节
 * @returns {Array<{path: string, data: Buffer}>} 目录项已跳过；解压失败的单项跳过不抛
 */
function unzip(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('unzip 需要 Buffer')
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是有效的 zip 文件（找不到中央目录）')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const out = []
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const cmtLen = buf.readUInt16LE(off + 32)
    const lho = buf.readUInt32LE(off + 42)
    // bit 11 = UTF-8 文件名；未置位时是 GBK（中文 Windows 打包），见 decodeZipName
    const gpFlags = buf.readUInt16LE(off + 8)
    const name = decodeZipName(buf.slice(off + 46, off + 46 + nameLen), gpFlags)
    off += 46 + nameLen + extraLen + cmtLen
    if (!name || name.endsWith('/')) continue   // 目录
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) continue
    const lNameLen = buf.readUInt16LE(lho + 26)
    const lExtraLen = buf.readUInt16LE(lho + 28)
    const dataStart = lho + 30 + lNameLen + lExtraLen
    if (dataStart + compSize > buf.length) continue
    const comp = buf.slice(dataStart, dataStart + compSize)
    let data
    try {
      if (method === 0) data = comp
      else if (method === 8) data = zlib.inflateRawSync(comp)
      else continue                    // 未知压缩方法：跳过该项
    } catch (e) { continue }
    out.push({ path: name, data })
  }
  return out
}

/** 判断是否爬取器关心的压缩包后缀 */
function isArchivePath(p) {
  return /\.(zip|rar|7z|tar|gz|tgz)$/i.test(String(p || ''))
}

module.exports = { unzip, isArchivePath, decodeZipName, decodeScriptText, countReplacement, looksGarbled }
