'use strict'
/**
 * 便携模式单测（v1.7.3）：src/core/portable.js 纯函数。
 * 覆盖：便携根目录识别（环境变量 / 标记文件 / 无意图）、旧数据一次性迁移。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { resolvePortableRoot, migrateLegacyData } = require('../src/core/portable.js')

let n = 0
const ck = (name, cond) => { n++; if (!cond) { console.error('FAIL  ' + name); process.exitCode = 1 } else console.log('PASS  ' + name) }

// ---- resolvePortableRoot ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-portable-'))
const exeDir = path.join(tmp, 'app')
fs.mkdirSync(exeDir, { recursive: true })

ck('PORTABLE_EXECUTABLE_DIR 命中（存在的目录）', resolvePortableRoot({ PORTABLE_EXECUTABLE_DIR: exeDir }, null) === exeDir)
ck('PORTABLE_EXECUTABLE_DIR 不存在时落到 FILE', resolvePortableRoot({ PORTABLE_EXECUTABLE_DIR: path.join(tmp, 'nope'), PORTABLE_EXECUTABLE_FILE: path.join(tmp, 'x', '音源猎手PC.exe') }, null) === path.join(tmp, 'x'))
ck('只有 PORTABLE_EXECUTABLE_FILE 时取所在目录', resolvePortableRoot({ PORTABLE_EXECUTABLE_FILE: path.join(tmp, 'y', 'app.exe') }, exeDir) === path.join(tmp, 'y'))
ck('环境变量优先于 exe 同级标记', (() => {
  fs.writeFileSync(path.join(exeDir, 'portable'), '1')
  return resolvePortableRoot({ PORTABLE_EXECUTABLE_DIR: exeDir }, exeDir) === exeDir
})())
ck('无环境变量时识别 exe 同级 portable 标记', resolvePortableRoot({}, exeDir) === exeDir)
ck('portable.txt 标记也认', (() => {
  fs.rmSync(path.join(exeDir, 'portable'))
  fs.writeFileSync(path.join(exeDir, 'portable.txt'), '1')
  return resolvePortableRoot({}, exeDir) === exeDir
})())
ck('无环境变量无标记 → null（回退系统用户目录）', (() => {
  fs.rmSync(path.join(exeDir, 'portable.txt'))
  return resolvePortableRoot({}, exeDir) === null
})())
ck('空 env / 空 exeDir 不炸', resolvePortableRoot(null, null) === null && resolvePortableRoot({}, null) === null)
ck('PORTABLE_EXECUTABLE_DIR 存在性校验：不存在的目录不采用', resolvePortableRoot({ PORTABLE_EXECUTABLE_DIR: path.join(tmp, 'ghost') }, exeDir) === null)

// ---- migrateLegacyData ----
const legacy = path.join(tmp, 'legacy', 'data')
const fresh = path.join(tmp, 'fresh', 'data')
fs.mkdirSync(legacy, { recursive: true })
fs.writeFileSync(path.join(legacy, 'config.json'), '{"a":1}')
fs.writeFileSync(path.join(legacy, 'sources.json'), '{"sources":{}}')
fs.writeFileSync(path.join(legacy, 'imported.json'), '{}')
fs.writeFileSync(path.join(legacy, 'readme.txt'), 'note')
fs.mkdirSync(path.join(legacy, 'sub'), { recursive: true })   // 子目录应被忽略

const moved = migrateLegacyData(legacy, fresh)
ck('旧目录文件全部迁移（含非 json，不含子目录）', moved === 4)
ck('迁移后新目录内容一致', fs.readFileSync(path.join(fresh, 'sources.json'), 'utf8') === '{"sources":{}}' && fs.existsSync(path.join(fresh, 'readme.txt')))
ck('旧文件保留作备份（不删）', fs.existsSync(path.join(legacy, 'sources.json')))
ck('新目录已有 json → 不重复迁移（以新位置为准）', migrateLegacyData(legacy, fresh) === 0)
ck('迁移是拷贝：改新目录不影响旧目录', (() => {
  fs.writeFileSync(path.join(fresh, 'sources.json'), 'changed')
  return fs.readFileSync(path.join(legacy, 'sources.json'), 'utf8') === '{"sources":{}}'
})())
ck('旧目录不存在 → 0 不炸', migrateLegacyData(path.join(tmp, 'no-such-dir'), path.join(tmp, 'x1')) === 0)
ck('旧目录为空 → 0', (() => {
  const empty = path.join(tmp, 'empty', 'data')
  fs.mkdirSync(empty, { recursive: true })
  return migrateLegacyData(empty, path.join(tmp, 'x2')) === 0
})())
ck('参数缺失不炸', migrateLegacyData(null, null) === 0 && migrateLegacyData('', '') === 0)

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n' + (process.exitCode ? 'FAILED' : `ALL PASS（${n} 项）`))
process.exit(process.exitCode || 0)
