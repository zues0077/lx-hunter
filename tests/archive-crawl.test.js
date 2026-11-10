/**
 * 压缩包音源抓取回归：仓库里 zip 分发的音源此前完全抓不到。
 * 覆盖：内存 zip 解压（STORE/DEFLATE）→ 从中挑音源脚本 → checkBasic 就地复用内容。
 */
const zlib = require('zlib')
const { unzip, isArchivePath, decodeZipName, decodeScriptText, countReplacement, looksGarbled } = require('../src/core/zip')
const { extractArchiveCandidates, pickScriptsFromZip } = require('../src/core/crawler')
const { checkBasic, sha256Str } = require('../src/core/checker')

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }

/** 测试专用：手工构造 zip 字节（中央目录 + EOCD），支持 STORE/DEFLATE。
 *  第 4 项 flags = general purpose bit flag；name 允许 Buffer（模拟 GBK 打包）。 */
function buildZip(files) {
  const parts = [], central = []
  let off = 0
  for (const [name, data, method, flags] of files) {
    const comp = method === 0 ? data : zlib.deflateRawSync(data)
    const nb = Buffer.isBuffer(name) ? name : Buffer.from(name, 'utf8')
    const gp = flags || 0
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(gp, 6)
    lh.writeUInt16LE(method, 8)
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(nb.length, 26)
    parts.push(lh, nb, comp)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(gp, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42)
    central.push(Buffer.concat([ch, nb]))
    off += 30 + nb.length + comp.length
  }
  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16)
  return Buffer.concat([...parts, cd, eocd])
}

// 像洛雪音源的脚本（多凑几个强特征，确保打分过线）
const FAKE_LX = `/**
 * @name 压缩包测试音源
 * @version 1.0.0
 */
lx.on(EVENT_NAMES.request, async ({ source, action, info }) => {
  const r = await lx.request('https://api.example.com/url/' + info.musicInfo.songmid, { method: 'GET' })
  return { url: 'https://cdn.example.com/a.mp3' }
})
lx.send(EVENT_NAMES.inited, { sources: { wy: { name: 'x', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } })
`
const README = '# 这个仓库的音源打包在 zip 里\n'

// ---------- 1. zip 解压 ----------
const zipBuf = buildZip([
  ['music/测试音源.js', Buffer.from(FAKE_LX, 'utf8'), 8],
  ['music/直接存储.js', Buffer.from(FAKE_LX, 'utf8'), 0],
  ['music/README.md', Buffer.from(README, 'utf8'), 8],
  ['music/sub/', Buffer.alloc(0), 0]
])
let files = []
try { files = unzip(zipBuf) } catch (e) { console.log('FAIL  unzip 抛异常: ' + e.message); process.exit(1) }
ck('DEFLATE + STORE 条目都能解出', files.length === 3 &&
  files.some(f => f.path === 'music/测试音源.js') && files.some(f => f.path === 'music/直接存储.js'),
  files.map(f => f.path).join(', '))
ck('解压内容逐字节一致（两个 js 条目）', files.filter(f => f.path.endsWith('.js')).every(f => f.data.toString('utf8') === FAKE_LX))
ck('目录项被跳过', !files.some(f => f.path.endsWith('/')))

let threw = false
try { unzip(Buffer.from('not a zip')) } catch (e) { threw = true }
ck('非 zip 输入给出明确错误', threw)

// ---------- 2. 候选挑选 ----------
ck('后缀识别', isArchivePath('a/b.zip') && isArchivePath('x.RAR') && isArchivePath('y.7z') && !isArchivePath('b.js'))
const tree = { tree: [
  { type: 'blob', path: '音源打包.zip' },
  { type: 'blob', path: 'docs/manual.pdf' },
  { type: 'blob', path: '直存音源.js' },
  { type: 'blob', path: 'node_modules/x.zip' }
] }
const arcs = extractArchiveCandidates(tree, 10)
// v1.7.0：返回对象数组（path + blob sha，供增量爬取判重），不再是纯字符串
ck('从仓库树挑出压缩包（排除 node_modules）', arcs.length === 1 && arcs[0].path === '音源打包.zip' && arcs[0].sha === '', JSON.stringify(arcs))

const picked = pickScriptsFromZip(files, '音源打包.zip', 'o/r', 'https://raw.githubusercontent.com/o/r/HEAD/%E9%9F%B3%E6%BA%90.zip', 50)
ck('zip 内音源脚本被挑出', picked.length === 2, picked.map(p => p.path).join(', '))
ck('条目带就地内容与哈希', picked.every(p => p.code === FAKE_LX && p.contentHash === sha256Str(FAKE_LX)))
ck('path 记录「压缩包!内部路径」', picked[0].path === '音源打包.zip!music/测试音源.js', picked[0].path)
ck('url 指向压缩包本身', picked[0].url.includes('%E9%9F%B3%E6%BA%90.zip'))

// ---------- 2.5 GBK entry 名解码（2026-11-10 实机定位：音源库页黑色菱形问号） ----------
// 中文 Windows 打 zip 时 entry 名是 GBK 且不置 bit-11；旧实现无条件 toString('utf8') → 整串 U+FFFD
const GBK_HELLO = Buffer.from([86, 50, 54, 49, 48, 48, 56, 47, 72, 101, 108, 108, 111, 87, 111, 114, 108, 100,
  210, 244, 212, 180, 40, 185, 171, 210, 230, 176, 230, 41, 46, 106, 115]) // V261008/HelloWorld音源(公益版).js
const GBK_STELLAR = Buffer.from([115, 116, 101, 108, 108, 97, 114, 119, 97, 118, 101, 45, 118, 52, 46, 48, 46, 48,
  163, 168, 191, 225, 206, 210, 201, 212, 186, 243, 214, 167, 179, 214, 163, 169, 46, 106, 115]) // stellarwave-v4.0.0（酷我稍后支持）.js
const HELLO_UTF8 = 'V261008/HelloWorld音源(公益版).js'
const STELLAR_UTF8 = 'stellarwave-v4.0.0（酷我稍后支持）.js'

ck('旧行为复现：GBK 字节按 utf8 直读确实产出 U+FFFD/伪字符',
  countReplacement(GBK_HELLO.toString('utf8')) > 0 || looksGarbled(GBK_HELLO.toString('utf8')),
  JSON.stringify(GBK_HELLO.toString('utf8')))
ck('GBK entry 名（未置 bit-11）解回中文', decodeZipName(GBK_HELLO, 0) === HELLO_UTF8, decodeZipName(GBK_HELLO, 0))
ck('GBK entry 名（含全角括号）解回中文', decodeZipName(GBK_STELLAR, 0) === STELLAR_UTF8, decodeZipName(GBK_STELLAR, 0))
ck('UTF-8 entry 名 + bit-11 保持原样', decodeZipName(Buffer.from(HELLO_UTF8, 'utf8'), 0x0800) === HELLO_UTF8, decodeZipName(Buffer.from(HELLO_UTF8, 'utf8'), 0x0800))
ck('UTF-8 entry 名但未置 bit-11 仍不被 GBK 误伤', decodeZipName(Buffer.from(HELLO_UTF8, 'utf8'), 0) === HELLO_UTF8, decodeZipName(Buffer.from(HELLO_UTF8, 'utf8'), 0))
ck('纯 ASCII entry 名不受影响', decodeZipName(Buffer.from('music/source.js', 'utf8'), 0) === 'music/source.js')
ck('打包工具乱置 bit-11 但塞 GBK 也能兜底', decodeZipName(GBK_HELLO, 0x0800) === HELLO_UTF8, decodeZipName(GBK_HELLO, 0x0800))
ck('脚本正文本是 UTF-8 时不被改动', decodeScriptText(Buffer.from(FAKE_LX, 'utf8')) === FAKE_LX)
// 逻辑复核：合法非中文 UTF-8 不得被编码猜测改坏（旧版 looksGarbled 会误判）
for (const [tag, txt] of [
  ['俄文注释', '/* @name Source\n * автор: Иван, статус: ОК */\nlx.on("musicUrl",()=>{})'],
  ['希伯来注释', '/* @name Source\n * בדיקה */\nlx.on("musicUrl",()=>{})'],
  ['亚美尼亚注释', '/* @name Source\n * փորձարկում */\nlx.on("musicUrl",()=>{})']
]) {
  ck('合法 ' + tag + ' 的 UTF-8 脚本原样返回', decodeScriptText(Buffer.from(txt, 'utf8')) === txt)
}
ck('含 U+FFFD 的 GBK 正文仍回退解出中文',
  decodeScriptText(GBK_HELLO).indexOf('HelloWorld音源(公益版)') >= 0,
  JSON.stringify(decodeScriptText(GBK_HELLO).slice(0, 50)))

// 端到端：真实 unzip 走 GBK entry 名
const gbkZip = buildZip([[GBK_HELLO, Buffer.from(FAKE_LX, 'utf8'), 0, 0]])
const gbkFiles = unzip(gbkZip)
ck('unzip 端到端产出正确中文路径（无菱形）', gbkFiles.length === 1 && gbkFiles[0].path === HELLO_UTF8 &&
  !looksGarbled(gbkFiles[0].path), gbkFiles.map(f => f.path).join(', '))
const gbkPicked = pickScriptsFromZip(gbkFiles, 'V261008.zip', 'o/r', 'https://x/V261008.zip', 50)
ck('GBK 包内候选 name/id 全为正确中文', gbkPicked.length === 1 &&
  gbkPicked[0].name === 'HelloWorld音源(公益版)' && !looksGarbled(gbkPicked[0].id),
  gbkPicked.length ? gbkPicked[0].name : '(未挑出)')

// ---------- 3. checkBasic 就地复用（不再下载） ----------
;(async () => {
  const e = { id: 't', name: '测试音源', path: '音源打包.zip!music/测试音源.js', code: FAKE_LX }
  const t0 = Date.now()
  const r = await checkBasic(e, { timeoutMs: 3000 }, () => {})
  ck('code 条目直接返回内容', r.code === FAKE_LX && e.status === 'ok', e.status + ' ' + (Date.now() - t0) + 'ms')
  ck('元信息从内容补齐', e.lxName === '压缩包测试音源', String(e.lxName))
  ck('哈希与疑似度就位', e.contentHash === sha256Str(FAKE_LX) && e.suspected === true, 'score=' + e.suspectScore)
  // 没有 code 的条目仍走下载路径（这里不给网络，应标记 dead 而不是抛异常）
  const e2 = { id: 't2', name: '需下载', url: 'http://127.0.0.1:1/no.js', path: 'no.js' }
  await checkBasic(e2, { timeoutMs: 1500 }, () => {})
  ck('无 code 条目仍走下载路径', e2.status === 'dead', e2.status + ' ' + (e2.error || ''))

  console.log('\n' + (bad === 0 ? 'ALL PASS' : bad + ' FAILED'))
  process.exit(bad ? 1 : 0)
})().catch(e => { console.error('ERR', e); process.exit(1) })
