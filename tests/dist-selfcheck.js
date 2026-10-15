// 成品自检：解开 dist 里的 app.asar，逐条断言各版本的修复确实打进了发行包（含防倒退回归）
const path = require('path')
const fs = require('fs')
const asar = require('../node_modules/@electron/asar')

const ROOT = path.resolve(__dirname, '..')
const ASAR = path.join(ROOT, 'dist/win-unpacked/resources/app.asar')
const OUT = path.join(ROOT, 'dist/_asar_check')
if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true })
asar.extractAll(ASAR, OUT)

const read = p => fs.readFileSync(path.join(OUT, p), 'utf8')
let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }
const has = (src, re) => re.test(src)

const netSrc = read('src/core/net.js')
const sbSrc = read('src/core/sandbox.js')
const chkSrc = read('src/core/checker.js')
const huntSrc = read('src/core/hunter.js')
const appSrc = read('src/renderer/app.js')
const preSrc = read('src/main/preload.js')
const html = read('src/renderer/index.html')
const pkg = JSON.parse(read('package.json'))

console.log('== 版本 ==')
// 版本断言动态化：升级版本时只改 package.json 与界面标记，无需再改这里
ck('发行包版本与 package.json 一致', pkg.version === require('../package.json').version, pkg.version)
ck('界面版本标记与包版本一致', new RegExp('v' + pkg.version.replace(/\./g, '\\.')).test(html))
ck('渲染脚本缓存戳随版本递增', /app\.js\?v=\d+/.test(html), (html.match(/app\.js\?v=\d+/) || ['未找到'])[0])

console.log('\n== v1.6.9 「已选」页签：勾选池可见可管理 ==')
// 用户反馈：勾选跨筛选/跨页全局存在，但没地方看勾了什么——「检测可用 41」而全选后
// 「已选 57」对不上；勾选 16 条在 147 条分页里翻不到。
ck('筛选页签含「已选」入口', /data-f="selected"[^>]*>已选/.test(html))
ck('matchFilter 支持 selected（只显示勾选项）', has(appSrc, /if \(state\.filter === 'selected'\) return state\.selected\.has\(e\.id\)/))
ck('页签徽章显示勾选数', has(appSrc, /function updateSelectedSeg/) && has(appSrc, /seg\.textContent = n \? `已选 \$\{n\}` : '已选'/))
ck('renderTable 时刷新徽章', has(appSrc, /updateSelectedSeg\(\)[\s\S]{0,80}const list = filtered\(\)/))
ck('已选视图取消勾选行立即消失', has(appSrc, /if \(state\.filter === 'selected'\) renderTable\(\)/))
ck('全选按钮提示勾选池总量', has(appSrc, /勾选池共 \$\{state\.selected\.size\} 条/))
ck('检测选中在勾选数>可见数时确认', has(appSrc, /但本筛选下只能看到 \$\{visible\} 条/))
ck('清空选择提示数量', has(appSrc, /已清空全部勾选（\$\{n\} 条）/))

console.log('\n== v1.6.8 灌入即公开源 + 开关/删除按 owner 路由 ==')
// 用户决定：猎手灌入的音源一律是公开源（所有账号可用、网页端可见），服务端私有源已全部清理。
const mainSrc = read('src/main/index.js')
const lxSrc8 = read('src/core/lxservice.js')
const upM = lxSrc8.match(/async function upload[\s\S]*?\n}/)
// v1.8.0 起 username 统一由 targetUsername(cfg) 归一：'default'/'open'/'_open'/空 → 'default'，
// 其余账号名原样下发（决定灌入落点）。断言改成检查唯一口径，别把实现细节锁死。
ck('upload 走统一口径 targetUsername（灌入落点）', !!upM && /username: targetUsername\(cfg\)/.test(upM[0]) && !/cfg\.username\b/.test(upM[0]))
const imM = lxSrc8.match(/async function importUrl[\s\S]*?\n}/)
ck('importUrl 走统一口径 targetUsername', !!imM && /username: targetUsername\(cfg\)/.test(imM[0]))
const vaM = lxSrc8.match(/async function validate[\s\S]*?\n}/)
ck('validate 与灌入口径一致', !!vaM && /username: targetUsername\(cfg\)/.test(vaM[0]))
ck('targetUsername 归一 default/open/_open/空', (() => {
  const m = lxSrc8.match(/function targetUsername\(cfg\)[\s\S]*?\n}/)
  return !!m && /return 'default'/.test(m[0]) && /open/.test(m[0]) && /_open/.test(m[0])
})())
ck('toggle 按 owner 路由', (() => {
  const m = lxSrc8.match(/async function toggle\(cfg, id, enabled, opts\)[\s\S]*?\n}/)
  return !!m && /const username = \(owner && owner !== 'open'/.test(m[0])
})())
ck('remove 按 owner 路由', (() => {
  const m = lxSrc8.match(/async function remove\(cfg, id, opts\)[\s\S]*?\n}/)
  return !!m && /const username = \(owner && owner !== 'open'/.test(m[0])
})())
ck('afterImport 用返回 owner 启用', has(lxSrc8, /owner: d\.owner \|\| 'open'/) && has(lxSrc8, /toggle\(cfg, id, true, \{ owner: info\.owner \}\)/))
ck('runRevoke 按 owner 路由删除', has(huntSrc, /owner: serverOwners\.get\(rec\.lxId\)/))
ck('_safeToggle 退回时带 owner', has(huntSrc, /_safeToggle\(cfg, id, !disabledSources\.length, what, owner\)/))
ck('手动删除按钮传 owner', has(appSrc, /api\.serviceRemove\(d\.dataset\.del, target && target\.owner\)/))
ck('全局禁用恢复传 owner', has(appSrc, /api\.serviceToggle\(id, true, target0 && target0\.owner\)/))
ck('IPC toggle/remove 透传 owner', has(mainSrc, /service:toggle', guard\(async \(e, id, enabled, owner\)/) && has(mainSrc, /service:remove', guard\(async \(e, id, owner\)/))
ck('preload toggle/remove 透传 owner', has(preSrc, /serviceToggle: \(id, enabled, owner\)/) && has(preSrc, /serviceRemove: \(id, owner\)/))

console.log('\n== v1.6.7 修「admin 私有源停用写入无效」：按 owner 路由身份 ==')
// 背景：HYWmusic_beta_公益测试 是 admin 私有源（owner=admin），v1.6.6 一律写 default
// ⇒ 写进 _open/states.json，私有源读的是 admin/states.json ⇒ 点停用/启用都不生效。
const lxSrc2 = read('src/core/lxservice.js')
ck('setPlatforms 按 owner 路由 username', (() => {
  const m = lxSrc2.match(/async function setPlatforms[\s\S]*?\n}/)
  return !!m && /const username = \(owner && owner !== 'open'/.test(m[0]) && /\n    username\n  \}/.test(m[0])
})())
ck('私有源写入路由注释完整', has(lxSrc2, /私有源（owner=admin 等）带 owner 字段返回，停用写入时按它路由身份/))
// v1.8.0 起 hunter 不再直调 lxservice，改为经适配器路由；owner 仍必须原样透传下去
ck('_safePlatforms 透传 owner', has(huntSrc, /async _safePlatforms\(cfg, id, disabledSources, what, owner\)/) && has(huntSrc, /adapter\.setPlatforms\(svc\.acct, id, disabledSources, \{ owner \}\)/))
ck('巡检建 ownerMap 并传入调用点（重新启用/自动禁用/自动删除/恢复启用）', (() => {
  const m = huntSrc.match(/const ownerById = new Map[\s\S]{0,200}/)
  return !!m && (huntSrc.match(/ownerById\.get\(rec\.lxId\)/g) || []).length >= 3
})())
ck('service:platforms IPC 透传 owner', has(mainSrc, /service:platforms', guard\(async \(e, id, disabledSources, owner\)/))
ck('preload servicePlatforms 透传 owner', has(preSrc, /servicePlatforms: \(id, disabledSources, owner\)/))
ck('手动停用按钮传 owner', has(appSrc, /api\.servicePlatforms\(id, list, target && target\.owner\)/))
ck('全部恢复启用传 owner', has(appSrc, /api\.servicePlatforms\(s\.id, \[\], s\.owner\)/))
ck('已灌入页私有源徽章标注', has(appSrc, /私有·\$\{esc\(s\.owner\)\}/) && has(appSrc, /isPrivate = !!\(s\.owner && s\.owner !== 'open'/))
ck('私有源提示条（insUser）', has(appSrc, /含 \$\{privN\} 个私有音源/))
ck('identityMismatch 改为私有源说明', has(huntSrc, /function identityMismatch[\s\S]{0,80}privates = /))

console.log('\n== v1.6.6 修「猎手停用 vs LX 网页端显示启用」不同步 ==')
// 根因：lxserver 平台停用按身份分文件存（_open/states.json vs admin/states.json），
// LX 网页端音源管理页恒读 default→_open 那份，旧版猎手按 cfg.username=admin 写入 ⇒ 永远看不到。
const lxSrc = read('src/core/lxservice.js')
ck('公开源停用写入走 default（→_open）', has(lxSrc, /const username = \(owner && owner !== 'open'/) && !/dualWrite/.test(lxSrc))
ck('setPlatforms 单次请求不双写', (() => {
  const m = lxSrc.match(/async function setPlatforms[\s\S]*?\n}/)
  return !!m && (m[0].match(/await req\(/g) || []).length === 1
})())
ck('列表读回以 default 视角为主', has(lxSrc, /const openList = await listAs\(cfg, 'default'\)/))
ck('具名用户私有源按 id 补充不丢', has(lxSrc, /if \(s && s\.id && !byId\.has\(s\.id\)\) byId\.set\(s\.id, s\)/))
ck('同 id 公开源优先（与网页端去重一致）', has(lxSrc, /const byId = new Map\(openList\.map/))
ck('已灌入徽章说明网页端平台置灰可见', has(appSrc, /平台徽章会同步置灰/))
ck('停用/启用 toast 提示 LX 网页端同步生效', has(appSrc, /LX 网页端同步生效/))

console.log('\n== v1.6.5 修「失效统计为0 / 服务端音源可检测 / 巡检恢复策略」==')
// 失效统计口径
ck('deepFailKind 失效类别判定', has(chkSrc, /function deepFailKind/))
ck('深检结果统一落 failKind', has(chkSrc, /result\.failKind = deepFailKind\(result\)/))
ck('死域名强制归 dead', has(chkSrc, /if \(deep\.deadDomain === true\) return 'dead'/))
ck('旧数据在 sources:get 时补算 failKind', has(mainSrc, /deepFailKind/))
ck('失效统计含深检确证失效', has(appSrc, /const \{[^}]*isDeepDead[^}]*\} = LXSort/) && has(appSrc, /e\.status === 'dead' \|\| isDeepDead\(e\)/))
ck('疑似统计排除深检确证失效', has(appSrc, /!isDeepDead\(e\)/))
ck('失效筛选/导出含深检确证失效', has(appSrc, /case 'dead': if \(!\(e\.status === 'dead' \|\| isDeepDead\(e\)\)\)/) && has(appSrc, /case 'dead': return e\.status === 'dead' \|\| isDeepDead\(e\)/))
ck('失效徽章（红）替代灰「不可用」', has(appSrc, /badge fail" title="\$\{esc\(tip\)\}">失效<\/span>/) && has(appSrc, /判定为失效/))
// 服务端原生音源可检测
ck('同步服务端时记录 sourceUrl', has(huntSrc, /url: s\.sourceUrl \|\| ''/))
ck('老占位条目补记 sourceUrl', has(huntSrc, /!this\.store\.db\.sources\[pid\]\.url && s\.sourceUrl/))
ck('检测放行带地址的服务端音源', has(huntSrc, /!e\.fromServer \|\| e\.url/))
ck('灌入跳过服务端音源（防重复上传）', has(huntSrc, /if \(!e\.url \|\| e\.fromServer\)/))
ck('服务端音源不参与孪生去重', has(huntSrc, /twin\.entry\.id !== e\.id && !e\.fromServer/))
// 巡检优化
ck('手动检测失效证据计入巡检连续失败', has(huntSrc, /manualPriorFail/))
ck('证据有时效（7 天）', has(huntSrc, /7 \* 24 \* 3600 \* 1000/))
ck('无法判定时恢复被巡检禁用的源', has(huntSrc, /巡检无法确认失效，已恢复启用/))
ck('疑似失效仍保持禁用', has(huntSrc, /if \(!suspectTag && rec\.disabledByPatrol\)/))
ck('巡检汇总提示剩余停用数', has(huntSrc, /stillDisabled/) && has(huntSrc, /全部恢复启用/))
// 已灌入页状态
ck('停用状态区分平台级/全局', has(appSrc, /平台级停用/) && has(appSrc, /已禁用<\/span>/))
ck('一键全部恢复启用', has(html, /btnEnableAll/) && has(appSrc, /btnEnableAll/))

console.log('\n== v1.6.4 修「巡检误禁用可用源」与「压缩包音源抓不到」==')
// 根因：巡检把深检结果 d 传给只认 entry.deep 的 usableCount ⇒ 可用数永远 0 ⇒ 全部判死
ck('usableCount 兼容深检结果入参（根因回归）', has(chkSrc, /entry\.deep \? entry\.deep : \(entry && entry\.platforms/))
ck('巡检判定抽成 patrolJudge 纯函数', has(chkSrc, /function patrolJudge/) && has(huntSrc, /patrolJudge\(d,/))
ck('一次失败不判死（连续失败计数）', has(huntSrc, /patrolFailStreak/) && has(chkSrc, /连续 ' \+ streak \+ ' 次确认后才自动禁用|连续第 ' \+ streak/))
ck('铁证才允许巡检立即判死', has(chkSrc, /verdict: 'dead', fatal: true/))
ck('巡检并发压到 3 以内防限流连坐', /巡检并发刻意压得比主检低[\s\S]{0,120}Math\.min\(3, cfg\.concurrency/.test(huntSrc))
ck('疑似失效与无法判定分开记录', has(huntSrc, /suspectTag/) && has(huntSrc, /巡检疑似失效/))
ck('主检可用时巡检不翻库内状态', has(huntSrc, /keepPrevUsable/))
// 压缩包抓取
ck('zip 读取器显式引入 zlib', has(read('src/core/zip.js'), /const zlib = require\('zlib'\)/))
ck('爬取器识别压缩包候选', has(read('src/core/crawler.js'), /function extractArchiveCandidates/) && has(read('src/core/crawler.js'), /unzip, isArchivePath/))
ck('压缩包内按疑似度挑脚本', has(read('src/core/crawler.js'), /function pickScriptsFromZip/) && /score < 4/.test(read('src/core/crawler.js')))
ck('压缩包条目就地保存脚本内容', has(read('src/core/crawler.js'), /code: text,\n      contentHash: sha256Str\(text\)/))
ck('checkBasic 支持就地内容（不再下载）', has(chkSrc, /typeof entry\.code === 'string' && entry\.code/))
ck('灌入预处理对压缩包条目免下载', has(huntSrc, /codeCache\[e\.id\] = e\.code/))

console.log('\n== v1.6.1/1.6.2 网络层修复 ==')
ck('net.js 走 Electron Chromium 网络栈', has(netSrc, /require\('electron'\)/) && has(netSrc, /net\.fetch/))
ck('双通道只在连接级失败时回退', has(netSrc, /isConnLevel\(describeNetError/) && has(netSrc, /buildDualChannel/))
ck('连接级识别覆盖 Chromium 文案', has(netSrc, /Failed to fetch\|net::ERR_/))
ck('错误原因沿 cause 链展开', has(netSrc, /function describeNetError/) && has(netSrc, /\.cause/))
ck('Windows IPv6 兜底（Happy Eyeballs）', has(netSrc, /setDefaultAutoSelectFamily\(true\)/))
ck('超时双保险（signal + 硬超时）', has(netSrc, /Promise\.race/) && /timers\.push\(setTimeout/g.test(netSrc))
ck('超时不再以 aborted 呈现', /请求超时 ' \+ ms/.test(netSrc))

console.log('\n== 沙箱侧 ==')
ck('沙箱 fetch 用双通道', has(sbSrc, /opts\.fetchImpl \|\| hostFetch\(\)/))
ck('沙箱 fetch 兜超时信号', has(sbSrc, /AbortSignal\.timeout/) && has(sbSrc, /initObj\.signal/))
ck('超时文案中文化', has(sbSrc, /请求超时 ' \+ ms/) && has(sbSrc, /AbortError/))
ck('错误信息带 URL 便于定位', has(sbSrc, /finalUrl\.slice\(0, 60\)/))

console.log('\n== 误杀防护 ==')
ck('checker 提供 isLocalNetworkIssue 闸门', has(chkSrc, /function isLocalNetworkIssue/))
ck('闸门口径含中文网络文案', has(chkSrc, /fetch 失败\|Failed to fetch/))
ck('巡检改用同一闸门', has(huntSrc, /patrolJudge\(/) && !has(huntSrc, /function isTransientMsg/))
ck('网络原因一律不判死（patrolJudge 内）', /netIssue[\s\S]{0,300}verdict: 'unknown'/.test(chkSrc))
ck('全平台同因给可行动建议', has(chkSrc, /function sameReasonHint/) && has(chkSrc, /不代表导入洛雪后不可用/))
ck('建议写进日志面板（不只 tooltip）', has(huntSrc, /hintSeen/) && has(huntSrc, /noteHint\(e\)/))
ck('列表里 hint 可见（⚠网络）', has(appSrc, /⚠网络/))

ck('DoH 二次确认（区分死域名与本机 DNS）', has(netSrc, /function dohLookup/) && has(netSrc, /dns\.alidns\.com/))
ck('死域名标记 deadDomain', has(chkSrc, /deadDomain = true/))
ck('巡检对死域名放行判死', has(chkSrc, /d\.deadDomain === true\) return \{ verdict: 'dead', fatal: true/))
ck('失效标记 ⚠失效 可见', has(appSrc, /⚠失效/))

console.log('\n== v1.6.3 修「检测完还是显示未检测」==')
// 主因：脚本把 lx.send('inited') 放在网络回调里，宽限内等不到就判死 → 五个平台全灰
ck('init 抢救不再要求「同步报错」', /if \(!r\.inited\) \{[\s\S]{0,500}probeRegisteredEvents/.test(sbSrc) && !has(sbSrc, /if \(!r\.inited && runErr\)/))
ck('在飞请求计数（宽限自适应依据）', has(sbSrc, /inflightFetches\+\+/) && has(sbSrc, /const settle/))
ck('宽限自适应：仍有请求在飞就继续等', has(sbSrc, /inflightFetches <= 0/))
ck('宽限硬上限可配 initGraceMaxMs', has(sbSrc, /initGraceMaxMs/))
ck('抢救时标记 guessedSources', has(sbSrc, /guessedSources: keys\.length === 0/))
ck('checker 透传 initGraceMaxMs', has(chkSrc, /initGraceMaxMs/))
ck('checker 记录 guessedSources 供 UI 措辞', has(chkSrc, /result\.guessedSources/))
// 次因：815 条被去重合并的重复项一直显示「未检测」，让人以为检测没跑
ck('重复项状态改为「重复·已合并」', has(appSrc, /重复·已合并/) && has(appSrc, /function mergeTip/))
ck('重复项平台格显示「已合并」', has(appSrc, /已合并<\/span>/))
ck('未检测筛选排除已合并项', has(appSrc, /case 'unchecked': if \(e\.deprecated/))
ck('导出「未检测」排除已合并项', has(appSrc, /case 'unchecked': return !e\.deprecated/))
ck('检测被整体跳过时给出反馈（不再静默）', has(huntSrc, /excluded/) && has(huntSrc, /全部无需本地检测/))

console.log('\n== v1.5.x 存量功能回归（防倒退）==')
ck('导出支持勾选', has(appSrc, /selected/) && has(appSrc, /syncExportScope/))
ck('按声明音质取链（v1.6.0）', has(chkSrc, /function declaredQualities/) && has(chkSrc, /musicInfo\(song\)/))
ck('弱可用分档（未本地校验）', has(appSrc, /plat weak|weak/))
ck('私有地址假链接快速否决', has(chkSrc, /私有\/本地地址/))
ck('更新平台不触发服务端重载', has(huntSrc, /\_safePlatforms/))

console.log('\n== v1.7.0 爬取增强（releases 资产 / 增量 / 可用度裁决）==')
const crawlSrc = read('src/core/crawler.js')
const storeSrc = read('src/core/store.js')
ck('releases 资产解析进爬取链路', has(crawlSrc, /parseReleaseAssets/) && has(crawlSrc, /browser_download_url/))
ck('releases 资产大小上限 30MB', has(crawlSrc, /MAX_ASSET_BYTES/) && /MAX_ASSET_BYTES\s*=\s*30\s*\*\s*1024\s*\*\s*1024/.test(crawlSrc))
ck('增量合并 mergeSources（blob sha / 内容哈希判重）', has(storeSrc, /mergeSources/) && has(storeSrc, /blobSha/) && has(storeSrc, /stale/))
ck('定时爬取调度器（crawlScheduleEnabled）', has(read('src/main/index.js'), /crawlScheduleEnabled/) && has(read('src/main/index.js'), /crawlIntervalHours/))
ck('设置页有定时爬取开关', has(html, /cfgCrawlOn/) && has(html, /cfgCrawlHours/))
ck('爬取信息位（上次爬取时间）', has(html, /crawlInfo/) && has(appSrc, /renderCrawlInfo/))
ck('同名裁决以接口可用度为准（betterKeeper 深检比较）', has(huntSrc, /betterKeeper\(a, b\)/) && has(huntSrc, /deep\.checkedAt/) && has(huntSrc, /na !== nb/))
ck('检测后同名翻案（更新版实测失效→恢复旧版）', has(huntSrc, /同名版本（此版本已失效）/) && has(huntSrc, /翻案|二次裁决/))
// v1.8.0：这条门禁被收进 sameNameVerdict（规则集中在一处，措辞统一为「0 个可用平台」）
ck('灌入同名替换门禁：检测失效不替换', has(huntSrc, /本地实测 0 个可用平台 → 不替换/))
ck('灌入 stale 门禁豁免（旧检测不作数）', has(huntSrc, /!e\.usable && e\.deep && !e\.stale/))
ck('releases 资产镜像回退（isGhAssetUrl）', has(netSrc, /isGhAssetUrl/))
ck('版本标记与包版本一致', new RegExp('PC 版 v' + pkg.version.replace(/\./g, '\\.')).test(html) && pkg.version === require('../package.json').version)

console.log('\n== v1.7.1 混淆风险检测（lx-ikun issue#8）==')
ck('obfuscationRisk 三特征评估', has(chkSrc, /function obfuscationRisk/) && has(chkSrc, /perKb0x/) && has(chkSrc, /perKbUni/) && has(chkSrc, /perKbExotic/))
ck('分级阈值按实测标定（high/mid）', has(chkSrc, /HIGH_0X = 20/) && has(chkSrc, /MID_0X = 2/))
ck('checkBasic 两条路径都评估混淆', (chkSrc.match(/assessObfuscation\(entry/g) || []).length >= 2)
ck('eval/new Function 计数进 tooltip', has(chkSrc, /evalCalls/) && has(chkSrc, /new\\s\+Function|new\s\+Function/))
ck('检测阶段剔除开关（v1.9.5 起默认开）', has(huntSrc, /excludeHighRiskObfuscated/) && has(storeSrc, /excludeHighRiskObfuscated: true/))
ck('剔除只针对 high 级', has(huntSrc, /risk\.level === 'high'/))
ck('高危徽章 ⚠混淆高危', has(appSrc, /⚠混淆高危/) && has(appSrc, /function obfTip/))
ck('设置页剔除开关', has(html, /cfgExcludeObf/))
ck('版本标记 v1.7.1（或更高）', pkg.version >= '1.7.1' && has(html, new RegExp('PC 版 v' + pkg.version.replace(/\./g, '\\.'))))

console.log('\n== v1.7.3 表格排序 + 便携数据目录 ==')
// 需求1：音源表可按名称/平台可用性/来源仓库/状态排序；状态排序把已灌入垫底，
//        配合「只选未灌入」实现「排除已灌入、只勾选未灌入灌入」
// 需求2：数据目录与软件同目录（便携模式），拷贝整个软件文件夹到 B 电脑数据不丢
ck('排序纯函数模块随包发行', fs.existsSync(path.join(OUT, 'src/renderer/sorters.js')))
const sortSrc = read('src/renderer/sorters.js')
ck('四列排序键与方向定义', has(sortSrc, /SORT_KEYS = \['name', 'plat', 'repo', 'status'\]/) && has(sortSrc, /plat: \{ dir: 'desc'/) && has(sortSrc, /status: \{ dir: 'asc'/))
ck('状态权重：已灌入 60 垫底', has(sortSrc, /if \(imported && imported\[e\.id\]\) return 60/))
ck('状态权重与徽章口径一致（dead 优先于疑似）', /if \(e\.status === 'dead'\) return 40[\s\S]{0,200}if \(e\.suspected \|\| isCheckedNoSource\(e\)\) return 20/.test(sortSrc))
ck('平台可用性计分（可用平台数 + 整体可用 100）', has(sortSrc, /\(e\.usable \? 100 : 0\) \+ n/))
// v1.8.0：排序用的「已灌入」改成按灌入目标算过的映射（只灌过 A 的源不该垫底装成已灌完）
ck('filtered 接入排序（已灌入口径按目标）', has(appSrc, /return sortSources\(list, state\.sort, importedRankMap\(\)\)/))
ck('表头四列可点排序（data-k）', (html.match(/class="[^"]*sortable" data-k="(name|plat|repo|status)"/g) || []).length === 4)
ck('表头点击切换/反向', has(appSrc, /state\.sort\.key === k\) state\.sort\.dir = state\.sort\.dir === 'asc' \? 'desc' : 'asc'/))
ck('排序箭头与 aria-sort 渲染', has(appSrc, /function renderSortHeads/) && has(appSrc, /aria-sort/))
ck('排序选择持久化（localStorage）', has(appSrc, /lxh-sort/) && has(appSrc, /function saveSort/))
ck('排序变化重置到第一页', has(appSrc, /saveSort\(\)\n    state\.page = 1/))
ck('状态/平台排序下单行更新后重排（防位置漂移）', has(appSrc, /if \(state\.sort\.key === 'status' \|\| state\.sort\.key === 'plat'\) scheduleTableRefresh\(\)/))
ck('「只选未灌入」按钮（排除已灌入/已合并）', has(html, /btnSelUnimported/) && has(appSrc, /btnSelUnimported/) && has(appSrc, /importedState\(e\) !== 'all' && !e\.deprecated/))
// 顺序要求：sorters.js → web-bridge.js（Web 版注入 window.api）→ app.js
// （v1.7.3 起中间多了 web-bridge.js，不能用「紧邻」正则，改按出现位置判断）
ck('renderer 脚本顺序：sorters → web-bridge → app', (() => {
  const a = html.indexOf('sorters.js'), b = html.indexOf('web-bridge.js'), c = html.indexOf('app.js')
  return a >= 0 && b > a && c > b
})())
ck('排序样式（表头可点 + 箭头）', has(read('src/renderer/styles.css'), /th\.sortable/) && has(read('src/renderer/styles.css'), /sort-arrow/))
// 便携模式
ck('便携路径逻辑抽成纯函数模块（随包发行）', fs.existsSync(path.join(OUT, 'src/core/portable.js')))
const portSrc = read('src/core/portable.js')
ck('识别 PORTABLE_EXECUTABLE_DIR/FILE', has(portSrc, /PORTABLE_EXECUTABLE_DIR/) && has(portSrc, /PORTABLE_EXECUTABLE_FILE/))
ck('exe 同级 portable 标记手动开关', has(portSrc, /'portable', 'portable\.txt'/) || (has(portSrc, /'portable'/) && has(portSrc, /portable\.txt/)))
ck('旧数据一次性迁移（保留备份）', has(portSrc, /function migrateLegacyData/) && has(portSrc, /copyFileSync/))
ck('主进程接入 portable.js', has(mainSrc, /require\('\.\.\/core\/portable'\)/) && has(mainSrc, /resolvePortableRoot\(process\.env/))
ck('userData 重定向到软件同级', has(mainSrc, /app\.setPath\('userData', newUserData\)/))
ck('可写性探测 + 不可写回退', has(mainSrc, /\.write-probe/) && has(mainSrc, /回退系统用户目录/))
ck('迁移在 Store 创建前执行', has(mainSrc, /migrateLegacyData\(path\.join\(legacyUserData, 'data'\), path\.join\(newUserData, 'data'\)\)/))
ck('config:get 返回解析后的 dataDir', has(mainSrc, /dataDir: getDataDir\(\)/))
ck('打开数据目录用同一 dataDir', has(mainSrc, /shell\.openPath\(getDataDir\(\)\)/))
ck('设置页说明便携数据目录', has(html, /便携模式（数据与软件同目录）/))
ck('版本标记 v1.7.3（或更高）', pkg.version >= '1.7.3' && has(html, new RegExp('PC 版 v' + pkg.version.replace(/\./g, '\\.'))))

// ---- v1.7.4：公共音源清理（只删 lxserver 公开源，绝不碰账号私有源）----
console.log('\n== v1.7.4 公共音源清理 ==')
// 需求：删掉 lxserver 端的公共音源（LX 网页端音源管理页可见、猎手灌入落点），
// 而不是各账号私有音源。lxserver 没有批量删除接口，服务端侧串行逐个删。
const lxSvcSrc = read('src/core/lxservice.js')
ck('公开源判定（owner=open/_open/缺省）', has(lxSvcSrc, /function isPublicSource/) && has(lxSvcSrc, /s\.owner === 'open' \|\| s\.owner === '_open'/))
ck('清理计划纯函数（公开/私有分账）', has(lxSvcSrc, /function planPublicCleanup/) && has(lxSvcSrc, /privateIds/))
ck('只读公共源列表（username=default ⇒ 只返回 _open）', has(lxSvcSrc, /async function listPublic/) && has(lxSvcSrc, /await listAs\(cfg, 'default'\)/))
ck('单删公开源身份恒 default', has(lxSvcSrc, /async function removePublic/) && has(lxSvcSrc, /id, username: 'default'/))
ck('批删串行 + 逐条结果 + 失败不中断', has(lxSvcSrc, /async function removePublicBatch/) && has(lxSvcSrc, /out\.failed\+\+/) && has(lxSvcSrc, /onProgress/))
ck('批删过滤脏 id', has(lxSvcSrc, /typeof x === 'string' && x/))
ck('新能力全部导出', has(lxSvcSrc, /listPublic, removePublic, removePublicBatch, planPublicCleanup, isPublicSource/))
// 双端接线（PC IPC + Docker Web 路由必须成对存在，杜绝只做一半）
ck('桌面版 IPC：service:listPublic', has(mainSrc, /ipcMain\.handle\('service:listPublic'/))
ck('桌面版 IPC：service:removePublicBatch', has(mainSrc, /ipcMain\.handle\('service:removePublicBatch'/))
ck('桌面版批删逐个上报进度', has(mainSrc, /type: 'pub-delete'/))
ck('preload 暴露两个新通道', has(read('src/main/preload.js'), /serviceListPublic/) && has(read('src/main/preload.js'), /serviceRemovePublicBatch/))
const webSrc = read('src/server/web.js')
ck('Web 路由：/api/service/list/public', has(webSrc, /route\('GET', '\/api\/service\/list\/public'/))
ck('Web 路由：/api/service/remove/public', has(webSrc, /route\('POST', '\/api\/service\/remove\/public'/))
ck('Web 批删同样逐个上报进度（SSE）', has(webSrc, /emitAll\('pub-delete'/))
ck('web-bridge 暴露同名方法（双端一致）', has(read('src/renderer/web-bridge.js'), /serviceListPublic/) && has(read('src/renderer/web-bridge.js'), /serviceRemovePublicBatch/))
// UI
ck('公共音源清理面板（已灌入页）', has(html, /公共音源清理/) && has(html, /btnPubRefresh/) && has(html, /btnPubDelSel/) && has(html, /btnPubDelAll/))
ck('面板说明只删公共、不碰私有', has(html, /只清理服务端<b>公共音源<\/b>/) && has(html, /私有音源不在此列表、也绝不会被删除/))
ck('读取公共音源列表', has(appSrc, /api\.serviceListPublic\(\)/) && has(appSrc, /function loadPublic/))
ck('勾选池只收公共源 + 全选', has(appSrc, /pubSel/) && has(appSrc, /pubChkAll/))
ck('删除前强确认（说明删除 vs 停用代价）', has(appSrc, /若只是不想让它们参与解析，请用上方「停用」/))
ck('批删后对账（成功/失败逐条）', has(appSrc, /failed\.slice\(0, 3\)/) && has(appSrc, /可能是网页端已手动删除/))
ck('批删进度事件接线（防看起来卡死）', has(appSrc, /type === 'pub-delete'/))
ck('删除后刷新已灌入与库内已灌入标记', has(appSrc, /await api\.serverSync\(\)/))
ck('私有源数量提示（讲清不在本列表）', has(appSrc, /另有 \$\{privN\} 个私有音源不在本列表/))
ck('复用服务端在途锁（防重复全量重载）', has(appSrc, /#btnPubRefresh, #btnPubDelSel, #btnPubDelAll/))
// 沿用 README v1.6.8「连续多次删除会把服务端拖到假死」的教训
ck('批删每个删除之间留间隔（可配置）', has(lxSvcSrc, /serverDeleteIntervalMs/) && has(lxSvcSrc, /await sleep\(gap\)/))
ck('默认间隔 5 秒（store 默认配置）', has(storeSrc, /serverDeleteIntervalMs: 5000/))
ck('网络级失败识别（超时/连接被拒）', has(lxSvcSrc, /NET_ERR_RE/) && has(lxSvcSrc, /socket hang up/))
ck('网络级失败立即中止整批（剩余记 skipped）', has(lxSvcSrc, /out\.aborted = true/) && has(lxSvcSrc, /out\.skipped = list\.slice/))
ck('业务失败（源不存在）不中止', has(lxSvcSrc, /单条业务失败（如「源不存在」）不中断/))
ck('UI 中止提示（引导确认服务端状态）', has(appSrc, /d\.aborted/) && has(appSrc, /必要时重启容器/))
ck('UI 大批量风险提示（连删假死）', has(appSrc, /连续重载脚本有假死风险/))
ck('版本标记 v1.7.4（或更高）', pkg.version >= '1.7.4' && has(html, new RegExp('PC 版 v' + pkg.version.replace(/\./g, '\\.'))))

// ---- v1.8.0：多平台账号 + 同时灌入 + 已灌入口径 ----
console.log('\n== v1.8.0 多平台账号与灌入 ==')
const svcIndexSrc = read('src/core/services/index.js')
const storeSrc2 = read('src/core/store.js')
ck('服务适配器分层（lxserver / songloft / musicsync）',
  has(svcIndexSrc, /require\('\.\/songloft'\)/) && has(svcIndexSrc, /require\('\.\/musicsync'\)/) && has(svcIndexSrc, /require\('\.\/lxserver'\)/))
ck('按「当前选中账号」路由（没有账号 → NO_ACCOUNT_ERR）',
  has(svcIndexSrc, /function getActiveService/) && has(svcIndexSrc, /NO_ACCOUNT_ERR/))
ck('配置含 platforms / activePlatformId', has(storeSrc2, /platforms: \[\]/) && has(storeSrc2, /activePlatformId/))
ck('老配置自动迁移成第一个 lxserver 账号（老用户升级无感）', has(storeSrc2, /_migratePlatforms/))
ck('批量灌入目标：勾了的全上，一个没勾退回当前账号',
  has(svcIndexSrc, /function getBatchImportAccounts/) && has(svcIndexSrc, /p\.batchImport === true/))
ck('灌入目标提示（防「以为是灌 A 结果灌到 B」）', has(appSrc, /灌入目标：/) && has(appSrc, /function batchImportTargets/))
ck('灌入结果带平台归属（多平台才分得清落在哪）',
  has(huntSrc, /platformId: svc\.acct\.id, platformType: svc\.type/) && has(html, /平台账号/))
ck('已灌入记录按平台记账（importedTo[]）',
  has(huntSrc, /importedTo: list/) && has(huntSrc, /_dropPlatformFromImported/))
ck('摘除平台时数组要写回（否则撤回后仍以为该平台有份）', has(huntSrc, /importedTo: rest/))
ck('改名上传按 svc 路由（原来用 _active() 会把第二平台灌错地方）', has(huntSrc, /async _uploadRenamed\(svc, code, baseName/))
ck('同名裁决抽成纯函数（规则可测可排错）', has(huntSrc, /sameNameVerdict\(e, srv, code, cfg\)/))
ck('同名可比时才比可用平台数（拿不到数不瞎拦）', has(huntSrc, /srvN > 0 && newN >= 0 && newN < srvN/))
ck('同名平台零交集 → 改名并存（不删服务端旧条）', has(huntSrc, /完全不重叠/))
ck('已灌入不硬跳过：服务端上还在才 skip', has(huntSrc, /serverIds\.has\(importedRecs\[e\.contentHash\]\.lxId\)/))
ck('读不到服务端列表时退回本地账本（防抖动重灌一库）', has(huntSrc, /同名保护与「是否已灌入」判定将退回本地记录/))
ck('已灌入账本按账号过滤（老记录归当前账号）', has(huntSrc, /_importedRecsFor\(platformId, activeId\)/))
// 渲染层的「已灌入」口径必须跟着灌入目标走，否则只灌过 A 的源加了 B 之后永远补灌不进去
ck('库内「已灌入」按灌入目标判定', has(appSrc, /case 'imported': if \(importedState\(e\) !== 'all'\) return false; break/))
ck('「只选未灌入」不排除仅灌入部分平台的源', has(appSrc, /importedState\(e\) !== 'all' && !e\.deprecated/))
ck('「检测并灌入」同样按目标口径筛', has(appSrc, /!e\.deprecated && importedState\(e\) !== 'all'\)\.map\(e => e\.id\)/))
ck('导出「已灌入」范围同口径', has(appSrc, /case 'imported': return importedState\(e\) === 'all'/))
ck('部分灌入的徽章写清还缺哪个账号', has(appSrc, /已灌入 \$\{t\.length - miss\.length\}\/\$\{t\.length\}/))
ck('切账号 / 改批量勾选后重画表格（否则徽章停留旧口径）', has(appSrc, /if \(state\.sources\.length\) renderTable\(\)/))
ck('已灌入列表只看当前账号（不做全账号合并视图）', !has(huntSrc, /listInstalledAll/))
ck('撤回判定与核心层一致（importedTo 也算）', has(appSrc, /rec\.importedTo\.some\(x => x && x\.platformId === active\.id\)/))
ck('已灌入页支持多选删除（串行 + 逐条进度 + 全选框）',
  has(appSrc, /btnInsDelSel/) && has(appSrc, /insChkAll/) && has(html, /id="insChkAll"/))
ck('删除按每条音源各自的 owner 路由（否则私有源删不掉）', has(appSrc, /api\.serviceRemove\([^)]*owner/))
ck('删不存在的源算「无需删除」而非失败', has(appSrc, /status: 'gone'/) || has(appSrc, /无需删除/))
// ---- 平台「名字是否 key」+ 改名安全阀（真实服务端实测后补的护栏）----
ck('适配器声明「名字是否 key」（MusicSync false：同名可共存）',
  has(read('src/core/services/musicsync.js'), /uniqueName: false/) &&
  has(read('src/core/services/songloft.js'), /uniqueName: true/))
ck('名字不是 key 的平台：同名直接上新条目（不删不改他人的源）',
  has(huntSrc, /ctx\.uniqueName === false/) && has(huntSrc, /可共存/))
ck('规划阶段就按平台能力传 uniqueName', has(huntSrc, /uniqueName: p\.svc\.adapter\.uniqueName !== false/))
ck('改名安全阀：脚本自检名字时拒绝改名（改名会变坏源）',
  has(huntSrc, /function renameSelfCheck/) && has(huntSrc, /renameUnsafe: true/))
ck('执行阶段二次兜底（宁可不灌也不上传坏源）',
  has(huntSrc, /const origName = \(extractMeta\(code\) \|\| \{\}\)\.name/) && has(huntSrc, /改名会让它初始化失败/))
ck('平台侧业务态失败给可操作指引（正在检测 / 初始化失败）',
  has(appSrc, /function delBizHint/) && has(appSrc, /音源正在检测|正在检测/))

// ---- 第三轮反馈：统计口径 / 账本对账 / MusicSync 不重复堆源 / 已灌入页排序 ----
ck('MusicSync 列表回传脚本指纹（内容级判重的前提）',
  has(read('src/core/services/musicsync.js'), /hash: typeof s\.script === 'string'/) &&
  has(read('src/core/services/musicsync.js'), /size: typeof s\.script === 'string'/))
ck('MusicSync 优先用服务端解析出的平台（sources）',
  has(read('src/core/services/musicsync.js'), /platKeysOf\(s\.sources\)/))
ck('服务端已有同内容 → 不重复灌（按脚本正文指纹，不看本地账本）',
  has(huntSrc, /serverByHash\[e\.contentHash\]/) && has(huntSrc, /服务端已有内容完全相同的音源/))
ck('有内容指纹时以指纹为准（长度相同内容不同不算同内容）',
  has(huntSrc, /const sameHash = !!\(e\.contentHash && srv\.hash/))
ck('同名裁决对 MusicSync 也生效（区别只在不需要改名）',
  has(huntSrc, /v\.act === 'rename' && ctx\.uniqueName === false/))
ck('账本对账（服务端已不存在 → 摘掉本地记录）', has(huntSrc, /reconcileImported\(platformId, liveIds\)/))
ck('对账只在读到列表时做（读失败不能删记录）', has(huntSrc, /if \(p\.serverIds\) \{/))
ck('对账接线完整（preload / IPC / Web 路由 / Web 桥）',
  has(read('src/main/preload.js'), /serviceReconcile/) &&
  has(read('src/main/index.js'), /'service:reconcile'/) &&
  has(read('src/server/web.js'), /\/api\/service\/reconcile/) &&
  has(read('src/renderer/web-bridge.js'), /serviceReconcile/))
ck('统计卡「已灌入」按当前账号口径（拿服务端列表的真实条数）',
  has(appSrc, /installedFor === state\.activePlatformId/) && has(appSrc, /已灌入 · 当前账号/))
ck('已灌入页刷新即对账 + 启动静默对账',
  has(appSrc, /await reconcileLedger\(active\.id, state\.installed\)/) && has(appSrc, /function syncInstalledQuiet/))
ck('已灌入页状态列可排序（失效/停用在前）',
  has(html, /data-k="istatus"/) && has(appSrc, /state\.insSort/) && has(appSrc, /function renderInstalledRows/))
ck('一键选中失效/停用音源（便于批量删除）',
  has(html, /id="btnInsSelFailed"/) && has(appSrc, /btnInsSelFailed/) && has(appSrc, /巡检失效/))
ck('行内显示巡检结论（巡检失效徽章）', has(appSrc, /function insRowState/) && has(appSrc, /badge dead/))

// ---- v1.9.0：定时爬取后自动灌入 + 设置页定时/灌入语义澄清 ----
console.log('\n== v1.9.0 定时爬取后自动灌入 + 设置页语义 ==')
const webSrc9 = read('src/server/web.js')
const storeSrc9 = read('src/core/store.js')
ck('新增配置 crawlAutoImport（默认关 → 升级后行为不变）', has(storeSrc9, /crawlAutoImport: false/))
ck('「同名自动替换」注释写死为兜底语义（只管第 7 条）',
  has(storeSrc9, /同名音源裁决的\*\*兜底\*\*开关/))
ck('全链路入口 runAutoPipeline（爬取 → 检测 → 灌入）',
  has(huntSrc, /async runAutoPipeline\(\)/) && has(huntSrc, /定时任务：开始增量爬取…/))
ck('爬取前拍快照，只检测新增/变化/从未测过的条目（不整库重测）',
  has(huntSrc, /const isNew = !prev/) &&
  has(huntSrc, /const changed = !!prev && \(prev\.hash !== \(e\.contentHash \|\| ''\) \|\| e\.stale\)/))
ck('灌入候选粗筛：目标账号都灌过才排除，部分灌过仍进候选补灌',
  has(huntSrc, /_importedEverywhere\(eid, targetIds, activeId\)/) &&
  has(huntSrc, /targetIds\.every\(id => got\.has\(id\)\)/))
ck('自动灌入复用批量灌入目标口径（不另开一套目标规则）',
  has(huntSrc, /const targets = getBatchImportAccounts\(cfg\)/))
ck('空转短路：没有新条目 / 没有可灌入的都不白跑',
  has(huntSrc, /out\.skipped = 'no-new-sources'/) && has(huntSrc, /out\.skipped = 'nothing-to-import'/))
ck('检测抛错时主动放开任务锁（否则紧随其后的灌入会被自己挡住）',
  has(huntSrc, /先把任务锁放开/))
ck('桌面版 + Web 版定时器都按 crawlAutoImport 分流到 runAutoPipeline',
  has(mainSrc, /cfg\.crawlAutoImport/) && has(mainSrc, /runAutoPipeline\(\)/) &&
  has(webSrc9, /cfg\.crawlAutoImport/) && has(webSrc9, /runAutoPipeline\(\)/))
ck('两版都保持「每分钟核对、够了间隔才跑」（间隔 ≠ 轮询节奏）',
  has(mainSrc, /Date\.now\(\) - last < hours \* 3600 \* 1000\) return/) &&
  has(webSrc9, /Date\.now\(\) - last < hours \* 3600 \* 1000\) return/))
ck('间隔在日志里说人话（48 → 2 天（48 小时））', has(huntSrc, /function formatIntervalHours/))
ck('设置页新增「爬取结束后自动灌入」开关并完整接线',
  has(html, /id="cfgCrawlAutoImport"/) && has(appSrc, /crawlAutoImport: \$\('cfgCrawlAutoImport'\)\.checked/))
ck('同名替换开关已搬进独立「灌入规则」卡片（不再挂在定时爬取卡片里）',
  html.indexOf('灌入规则（同名音源怎么处理）') < html.indexOf('id="cfgReplaceSame"') &&
  html.indexOf('id="cfgReplaceSame"') < html.indexOf('定时爬取（增量发现新音源）'))
ck('灌入后自动启用 / 跳过未通过 也归入「灌入规则」',
  html.indexOf('id="cfgEnableAfter"') > html.indexOf('灌入规则（同名音源怎么处理）') &&
  html.indexOf('id="cfgSkipUnusable"') > html.indexOf('灌入规则（同名音源怎么处理）'))
ck('界面直接印出同名裁决 7 条顺序，并标明自动替换只管第 7 条',
  has(html, /<ol class="rules">/) && has(html, /只在第 7 条生效/))
ck('定时/巡检勾选文案讲明「总开关 + 每分钟只是核对节奏」',
  has(html, /就是定时爬取的总开关/) && has(html, /就是定时巡检的总开关/) && has(html, /每分钟<\/strong>只是核对节奏|「每分钟」只是核对节奏/))
ck('保存设置的联动提示（自动灌入依赖定时爬取 / 没有批量目标）',
  has(appSrc, /需要上面「启用定时爬取」也勾上才会触发/) && has(appSrc, /自动灌入只会灌到当前选中账号/))
ck('「参与批量灌入」说明已覆盖定时自动灌入', has(html, /以及「定时爬取后自动灌入」同时灌入/))

// ---- v1.9.5：灌入前自动剔除高危混淆/反调试脚本（默认开） ----
// 背景：2026-10-15 NAS CPU 占用定位实测——jsjiami.com.v7 混淆的「洛雪音乐源.js」
// 独吞 63%~67% 单核 + 270MB，其余 45 个音源合计 ≈ 0%。该脚本签名：空转死循环
// while(!![]){} + 混淆自调度 _0xK[_0xK(..)](_0xFN,0x7d0) + jsjiami 标识。
console.log('\n== v1.9.5 灌入前自动剔除高危混淆/反调试脚本（默认开） ==')
const chkSrc5 = read('src/core/checker.js')
ck('obfuscationRisk 新增反调试硬特征（空转死循环/自调度/jsjiami）',
  has(chkSrc5, /const nSpin = count\(/) &&
  has(chkSrc5, /const nSelfSched = count\(/) &&
  has(chkSrc5, /const nJsjiami = count\(/) &&
  has(chkSrc5, /spinLoops: nSpin, selfSchedCalls: nSelfSched, jsjiamiMarks: nJsjiami/))
ck('硬特征命中即 high（与 _0x 密度无关）',
  has(chkSrc5, /if \(nSpin >= 1 \|\| nSelfSched >= 1\)/) &&
  has(chkSrc5, /return \{ level: 'high', hits \}/))
ck('只匹配空函数体死循环（带函数体的解码器循环不误伤）',
  chkSrc5.indexOf('!0x0|!0|true)') >= 0 && chkSrc5.indexOf('KuwoDES') >= 0)
ck('obfuscationTip 带新特征措辞', has(chkSrc5, /空转死循环 while\(!!\[\]\)\{\}/) && has(chkSrc5, /混淆自调度定时器/))
ck('runImport 灌入前剔除闸门（下载后、队列规划前）',
  has(huntSrc, /灌入前剔除 \$\{obfRejected\} 条高危混淆脚本/) &&
  has(huntSrc, /const risk = obfuscationRisk\(code\)/) &&
  has(huntSrc, /重度混淆脚本，已按设置剔除/))
ck('灌入完成日志报剔除数 + 返回 obfRejected',
  has(huntSrc, /高危混淆剔除 \$\{obfRejected\} 条/) && has(huntSrc, /return \{ results, ok, replaced, synced, skipped, obfRejected \}/))
ck('DEFAULT_CONFIG 默认开启（v1.9.5 起）', has(storeSrc9, /excludeHighRiskObfuscated: true/))
ck('设置页开关文案更新（每次灌入 + 反调试特征）',
  has(html, /每次灌入自动剔除/) && has(html, /空转死循环 while\(!!\[\]\)\{\}/))
ck('renderer obfTip 同步新特征描述', has(appSrc, /空转死循环 while\(!!\[\]\)\{\}/) && has(appSrc, /混淆自调度定时器/))

// ---- v1.9.6：修复 Web 版角标写死 v1.9.0（升级后界面版本号不变） ----
// v1.9.0 时 web-bridge.js 把品牌字样写死成 'Web/Docker 版 v1.9.0'，之后每次升级
// 界面都还显示 v1.9.0，用户无法分辨运行版本（2026-10-15 在 NAS 上实测踩中）。
// 修为动态取 /api/health 的 version（读镜像内 package.json），并加断言禁止再写死。
console.log('\n== v1.9.6 Web 角标版本号动态化 ==')
const wbSrc = read('src/renderer/web-bridge.js')
ck('Web 角标版本号取 /api/health 动态获取', has(wbSrc, /call\('\/api\/health'\)/))
ck('Web 角标不再写死版本号', !/textContent\s*=\s*['"]Web\/Docker 版 v\d/.test(wbSrc))

// ---- v1.9.7：网络加速（借鉴 songloft 版设置页）——爬取代理/强制代理/jsDelivr 开关/自定义镜像 ----
// 内置镜像以 2026-10-15 实测为准：只留返回真实文件内容的（ghfast.top / gh-proxy.com /
// ghproxy.net / jsDelivr），失效的 FastGit、ghproxy.vvv.ee、gh1.lh1.one 一律不内置，
// 免得 auto 链每轮白等一次超时。判据必须是「HTTP 200 且内容正确」——只看状态码
// 会误收 ghproxy.cn（返回 HTML 页面）这类已变质的站点。
console.log('\n== v1.9.7 网络加速 ==')
const netSrc2 = read('src/core/net.js')
ck('net 层提供爬取代理（http CONNECT）', has(netSrc2, /CONNECT/) && has(netSrc2, /proxyFetchRaw/))
ck('net 层支持强制代理（代理排候选最前）', has(netSrc2, /forceProxy/) && has(netSrc2, /push\('proxy', rawUrl\)/))
ck('net 层支持 jsDelivr 开关', has(netSrc2, /useJsdelivr/))
ck('net 层支持自定义镜像', has(netSrc2, /mirrorCustom/) && has(netSrc2, /customPreset/))
// 只看 MIRROR_PRESETS 数组本体：注释里会点名这些失效域名，直接全文匹配会误伤自己
const presetBlock = (netSrc2.match(/const MIRROR_PRESETS = \[[\s\S]*?\n\]/) || [''])[0]
ck('内置镜像不含已失效域名（FastGit / vvv.ee / gh1.lh1.one / ghproxy.cn）',
  presetBlock.length > 0 && !/fastgit|ghproxy\.vvv\.ee|gh1\.lh1\.one|ghproxy\.cn/.test(presetBlock))
ck('设置页提供爬取代理输入框', has(html, /id="cfgCrawlProxy"/))
ck('设置页提供强制代理 / jsDelivr 开关', has(html, /id="cfgForceProxy"/) && has(html, /id="cfgUseJsdelivr"/))
ck('设置页提供自定义镜像与测试按钮', has(html, /id="cfgMirrorCustom"/) && has(html, /id="btnNetTest"/))
ck('镜像下拉不再有 FastGit 选项', !/value="fastgit"/.test(html))
ck('Web 版暴露 /api/net/test', has(read('src/server/web.js'), /\/api\/net\/test/))
ck('桌面版暴露 net:test 通道', has(read('src/main/index.js'), /net:test/) && has(read('src/main/preload.js'), /netTest/))
ck('设置保存后即时同步到网络层', has(read('src/server/web.js'), /applyConfig\(store\.config\)/))
// 发行包里的 package.json 被 electron-builder 裁掉了 scripts，所以这条要读源码仓库里的
const srcPkg = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')
ck('网络加速测试存在且被纳入 npm test',
  /net-accel\.test\.js/.test(srcPkg) && fs.existsSync(path.join(ROOT, 'tests/net-accel.test.js')))

console.log('\n' + (bad === 0 ? 'ALL PASS' : bad + ' FAILED'))
process.exit(bad ? 1 : 0)
