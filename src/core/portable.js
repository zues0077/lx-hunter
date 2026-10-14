'use strict'
/**
 * 便携模式路径解析（v1.7.3）—— 纯函数 + 文件迁移，主进程与 Node 单测共用。
 *
 * 目标：数据目录与软件同目录，拷贝整个软件文件夹到 B 电脑数据不丢。
 * 识别便携根目录（任一命中）：
 *   1. PORTABLE_EXECUTABLE_DIR 环境变量（electron-builder portable 包装器注入，
 *      指向原始 exe 所在目录；portable 下 app.getPath('exe') 是临时解包目录，不能直接用）
 *   2. PORTABLE_EXECUTABLE_FILE 环境变量（取所在目录）
 *   3. exe 同级存在 portable / portable.txt 标记文件（exe 被改名/复制丢了环境变量时的手动开关）
 */
const fs = require('fs')
const path = require('path')

/** 判断便携根目录；没有便携意图返回 null（调用方回退系统用户目录） */
function resolvePortableRoot(env, exeDir) {
  const envDir = env && env.PORTABLE_EXECUTABLE_DIR
  if (envDir) {
    try { if (fs.existsSync(envDir)) return envDir } catch (e) {}
  }
  const envFile = env && env.PORTABLE_EXECUTABLE_FILE
  if (envFile) return path.dirname(envFile)
  if (!exeDir) return null
  for (const mark of ['portable', 'portable.txt']) {
    try { if (fs.existsSync(path.join(exeDir, mark))) return exeDir } catch (e) {}
  }
  return null
}

/**
 * 旧数据一次性迁移：新位置还没有 .json 数据文件时，把旧目录里的文件复制过去。
 * 不删旧文件（留作备份）；新位置已有数据则以新位置为准，不覆盖。
 * @returns {number} 迁移的文件数
 */
function migrateLegacyData(legacyDir, newDir) {
  try {
    if (!legacyDir || !newDir || !fs.existsSync(legacyDir)) return 0
    const hasNew = fs.existsSync(newDir) && fs.readdirSync(newDir).some(f => /\.json$/.test(f))
    if (hasNew) return 0
    const files = fs.readdirSync(legacyDir).filter(f => {
      try { return fs.statSync(path.join(legacyDir, f)).isFile() } catch (e) { return false }
    })
    if (!files.length) return 0
    fs.mkdirSync(newDir, { recursive: true })
    let n = 0
    for (const f of files) {
      try { fs.copyFileSync(path.join(legacyDir, f), path.join(newDir, f)); n++ } catch (e) {}
    }
    return n
  } catch (e) { return 0 }
}

module.exports = { resolvePortableRoot, migrateLegacyData }
