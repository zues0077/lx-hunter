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

/** 在缓冲区里从尾向前找 EOCD（End Of Central Directory）签名 */
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
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8')
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

module.exports = { unzip, isArchivePath }
