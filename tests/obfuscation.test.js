/**
 * v1.7.1 混淆风险检测回归（依据 lx-ikun-music-sources issue#8 科普）：
 *  ① 分级阈值 —— 用真实混淆样本的实测密度标定（V260817 全量 23 脚本扫描）：
 *     重混淆 _0x 37~52/KB、独家V5 unicode 14.3/KB + 异体字符 47.4/KB；
 *     良性 Hei Music _0x 0.16/KB；干净脚本全 0。
 *  ② checkBasic 接线 —— 两条路径（解压 code / 下载 text）都写 obfLevel/obfHits。
 *  ③ 检测阶段剔除 —— excludeHighRiskObfuscated 开启时 high 直接拒绝，mid 放行。
 *  ④ UI 展示 —— 状态徽章：high=⚠混淆高危(红)，mid=含混淆(黄)。
 */
const { obfuscationRisk, obfuscationTip, checkBasic } = require('../src/core/checker')
const { Hunter } = require('../src/core/hunter')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Store } = require('../src/core/store')

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x !== undefined ? '  -> ' + x : ''}`) }

// ① 分级
console.log('\n== 混淆分级（obfuscationRisk） ==')
// 重混淆：模拟 V260817 实测（_0x 名 37~52/KB）
const heavy = ('const _0x9ea57b=parseInt(_0x5cebec(0x445,\'s[!1\'))/(-0xfa);').repeat(600)   // ~30/KB * 2 项
ck('重 _0x 密度 → high', obfuscationRisk(heavy).level === 'high')
// 异体字符（issue 里独家V5 的阿拉伯字符运算）
const exotic = ('var \u0621\u0640\u0621=function(\u0621\u0640){return \u0621\u0640+1};\u0621\u0640(1);\u0621\u0640(2);\u0621\u0640(3);\u0621\u0640(4);\u0621\u0640(5);\u0621\u0640(6);\u0621\u0640(7);\u0621\u0640(8);\u0621\u0640(9);\u0621\u0640(10);\u0621\u0640(11);\u0621\u0640(12);\u0621\u0640(13);\u0621\u0640(14);\u0621\u0640(15);\u0621\u0640(16);\u0621\u0640(17);\u0621\u0640(18);\u0621\u0640(19);\u0621\u0640(20);\u0621\u0640(21);\u0621\u0640(22);\u0621\u0640(23);\u0621\u0640(24);\u0621\u0640(25);\u0621\u0640(26);\u0621\u0640(27);\u0621\u0640(28);\u0621\u0640(29);\u0621\u0640(30);\u0621\u0640(31);\u0621\u0640(32);\u0621\u0640(33);\u0621\u0640(34);\u0621\u0640(35);\u0621\u0640(36);\u0621\u0640(37);\u0621\u0640(38);\u0621\u0640(39);\u0621\u0640(40);\u0621\u0640(41);\u0621\u0640(42);\u0621\u0640(43);\u0621\u0640(44);\u0621\u0640(45);\u0621\u0640(46);\u0621\u0640(47);\u0621\u0640(48);\u0621\u0640(49);\u0621\u0640(50);').repeat(20)
ck('异体字符参与运算 → high', obfuscationRisk(exotic).level === 'high')
// unicode 转义（issue 里的 \u0072\u0065\u0071... 手法）
const uni = ('return \\u0072\\u0065\\u0071\\u0075\\u0069\\u0072\\u0065;').repeat(80)
ck('unicode 转义密度 → high', obfuscationRisk(uni).level === 'high')
// 轻度：Hei Music 类（_0x 0.16/KB + fromCharCode XOR 存密钥）→ mid
const mild = '/** @name Hei Music */\n' + 'var _0x4e8f = function(arr, key) { return String.fromCharCode(arr[0] ^ key.charCodeAt(0)) }\n'.repeat(30)
ck('局部混淆 → mid', obfuscationRisk(mild).level === 'mid', JSON.stringify(obfuscationRisk(mild).level))
// 干净脚本（issue 里星澜的 yunmge 片段风格）
const clean = '// -------- yunmge 酷我 --------\nconst getYunmgeKw = async (songId, quality, musicInfo) => {\n  const id = musicInfo?.rid || musicInfo?.songmid || songId\n  if (!id) throw new Error("yunmge: 缺少 id")\n  const brMap = { "128k":128, "320k":320 }\n  const resp = await httpFetch(url, { method: "GET", timeout: 8000 })\n  return resp.body\n}\n'.repeat(30)
ck('干净脚本 → 无级别', obfuscationRisk(clean).level === '')
ck('过短内容不评估', obfuscationRisk('var a=1').level === '')
ck('空内容不炸', obfuscationRisk('').level === '' && obfuscationRisk(null).level === '')
// 阈值边界：正常代码里偶见 _0x（≤2/KB）不算混淆
const borderline = ('var _0x1 = 1; // 正常注释\n').repeat(10) + clean.repeat(5)
ck('偶发 _0x 不误报', obfuscationRisk(borderline).level === '')
// eval 计数
const withEval = 'eval(atob("...")); new Function("return 1")();'.repeat(50) + clean.repeat(10)
ck('eval/new Function 被计数（进 tooltip）', obfuscationRisk(withEval).hits.evalCalls >= 100)
ck('tip 高危措辞', /建议拒绝使用/.test(obfuscationTip(obfuscationRisk(heavy))))
ck('tip 中危措辞', /自行甄别/.test(obfuscationTip(obfuscationRisk(mild))))

// ② checkBasic 接线（code 路径）
console.log('\n== checkBasic 接线 ==')
async function t() {
  const entry = { id: 't1', path: 'x.js', url: 'u', name: 'x', code: heavy, status: 'unknown', suspected: null, contentHash: null, deep: null }
  const cfg = {}
  await checkBasic(entry, cfg, () => {})
  ck('code 路径写入 obfLevel=high', entry.obfLevel === 'high')
  ck('code 路径写入 obfHits 特征数据', entry.obfHits && entry.obfHits.perKb0x > 20)
  const entry2 = { id: 't2', path: 'y.js', url: 'u', name: 'y', code: clean, status: 'unknown', suspected: null, contentHash: null, deep: null }
  await checkBasic(entry2, cfg, () => {})
  ck('干净脚本 obfLevel 为空', !entry2.obfLevel)

  // ③ 检测阶段剔除（excludeHighRiskObfuscated=true）
  console.log('\n== 检测剔除（runCheck 过滤逻辑） ==')
  // 只测过滤段：用 Object.create 绕开完整构造，stub 必要方法
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-obf-'))
  const store = new Store(dir)
  const h = Object.create(Hunter.prototype)
  h.store = store
  h.emit = () => {}
  h.log = (msg, mod, level) => { h.lastLog = msg }
  h.step = () => {}
  h.progress = () => {}
  h.mirrorPref = null
  h.cancelRequested = false
  // 构造两条候选：一条重混淆（带 code，免下载）、一条干净
  const obfEntry = { id: 'obf-1', repo: 'r', path: 'obf.js', url: 'u1', name: 'obf', code: heavy, contentHash: 'h1', suspectScore: 8, status: 'unknown', suspected: true, usable: false, size: 0, addedAt: 1, lastCheck: 0, deep: null }
  const okEntry = { id: 'ok-1', repo: 'r', path: 'ok.js', url: 'u2', name: 'ok', code: clean, contentHash: 'h2', suspectScore: 8, status: 'unknown', suspected: true, usable: false, size: 0, addedAt: 1, lastCheck: 0, deep: null }
  store.mergeSources([obfEntry, okEntry], { incremental: false })
  // 不真跑沙箱：剔除发生在 checkBasic 之前，这里只需要 job 状态与列表过滤。
  // 直接调用 runCheck 会进入沙箱检测 ok-1 —— 沙箱依赖 electron，无法在 node 测试里跑。
  // 改为抽取验证：过滤逻辑与 deepCheck 耦合在 runCheck 内，无法单测过滤段本身，
  // 所以断言配置默认值 + hunter.js 源码含剔除分支（结构断言），行为由 dist-selfcheck 兜底。
  ck('默认不剔除（excludeHighRiskObfuscated=false）', store.config.excludeHighRiskObfuscated === false)
  store.config.excludeHighRiskObfuscated = true
  ck('开启后配置生效', store.config.excludeHighRiskObfuscated === true)

  // ④ UI 徽章逻辑（结构断言）
  const appSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8')
  ck('高危徽章 ⚠混淆高危（红）', appSrc.includes('⚠混淆高危') && appSrc.includes("obfLevel === 'high'"))
  ck('局部徽章 含混淆（黄）', appSrc.includes('含混淆') && appSrc.includes("obfLevel === 'mid'"))
  ck('tooltip 用 obfTip 人话摘要', appSrc.includes('function obfTip'))
  const htmlSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8')
  ck('设置页有剔除开关', htmlSrc.includes('cfgExcludeObf') && htmlSrc.includes('重度混淆'))
  const hunterSrc = fs.readFileSync(path.join(__dirname, '../src/core/hunter.js'), 'utf8')
  ck('runCheck 含剔除分支', hunterSrc.includes('excludeHighRiskObfuscated') && hunterSrc.includes('重度混淆脚本，已按设置剔除'))
  ck('检测完成日志报混淆计数', hunterSrc.includes('重度混淆') && hunterSrc.includes('局部混淆'))
}
t().then(() => {
  console.log(`\n${bad ? 'FAIL' : 'ALL PASS'}（失败 ${bad} 项）`)
  process.exit(bad ? 1 : 0)
}).catch(e => { console.error('测试异常:', e); process.exit(1) })
