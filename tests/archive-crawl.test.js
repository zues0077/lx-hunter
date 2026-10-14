/**
 * 压缩包音源抓取回归：仓库里 zip 分发的音源此前完全抓不到。
 * 覆盖：内存 zip 解压（STORE/DEFLATE）→ 从中挑音源脚本 → checkBasic 就地复用内容。
 */
const zlib = require('zlib')
const { unzip, isArchivePath } = require('../src/core/zip')
const { extractArchiveCandidates, pickScriptsFromZip } = require('../src/core/crawler')
const { checkBasic, sha256Str } = require('../src/core/checker')

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }

/** 测试专用：手工构造 zip 字节（中央目录 + EOCD），支持 STORE/DEFLATE */
function buildZip(files) {
  const parts = [], central = []
  let off = 0
  for (const [name, data, method] of files) {
    const comp = method === 0 ? data : zlib.deflateRawSync(data)
    const nb = Buffer.from(name, 'utf8')
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(method, 8)
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(nb.length, 26)
    parts.push(lh, nb, comp)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6)
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
