'use strict'
/**
 * v1.10.1-beta.2 回归：「只收最新版」开关的位置与文案契约。
 *
 * 背景：该开关是全局采集偏好，但原先放在「定时爬取」卡片里，容易被误解成
 * 只对定时任务生效；旧文案「只收最新版」也没说清判定优先级与生效范围。
 * 本轮把它挪到「仓库清单」卡片（贴着清单），文案改为与实现一致的描述。
 *
 * 测试含旧结构对照，防止切片/断言退化成恒真。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const renderer = path.join(__dirname, '..', 'src', 'renderer')
const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8')
const app = fs.readFileSync(path.join(renderer, 'app.js'), 'utf8')

let pass = 0
const ok = (cond, label) => {
  assert.ok(cond, label)
  pass++
  console.log('  PASS', label)
}

// 以卡片标题切段：从本卡片 h3 起，到下一个卡片 h3 之前
function cardOf(doc, title) {
  const start = doc.indexOf(title)
  if (start < 0) return ''
  const next = doc.indexOf('<h3 class="card-title">', start + title.length)
  return doc.slice(start, next < 0 ? doc.length : next)
}

console.log('--- ① 切片函数自检（旧结构对照，防恒真） ---')
const legacyDoc = '<div class="card"><h3 class="card-title">定时爬取（增量发现新音源）</h3>' +
  '<input id="cfgCrawlLatestOnly"></div><div class="card">' +
  '<h3 class="card-title">仓库清单（全部可管理）</h3><div id="repoList"></div></div>'
ok(cardOf(legacyDoc, '定时爬取（增量发现新音源）').includes('id="cfgCrawlLatestOnly"'),
  '对照：旧结构下开关确实落在定时爬取卡片')
ok(!cardOf(legacyDoc, '仓库清单（全部可管理）').includes('id="cfgCrawlLatestOnly"'),
  '对照：旧结构下仓库清单卡片不含该开关')

console.log('--- ② 位置契约 ---')
const crawlCard = cardOf(html, '定时爬取（增量发现新音源）')
const repoCard = cardOf(html, '仓库清单（全部可管理）')
ok(crawlCard.length > 0 && repoCard.length > 0, '两张卡片都能在页面里定位')
ok(!crawlCard.includes('id="cfgCrawlLatestOnly"'), '开关已从定时爬取卡片移除')
ok(repoCard.includes('id="cfgCrawlLatestOnly"'), '开关已挪进仓库清单卡片')
ok(repoCard.indexOf('id="cfgCrawlLatestOnly"') < repoCard.indexOf('id="repoList"'),
  '开关位于清单列表上方，紧贴清单')
ok((html.match(/id="cfgCrawlLatestOnly"/g) || []).length === 1, '开关 id 全局唯一')

console.log('--- ③ 文案契约：不误导 + 说清判定优先级与范围 ---')
const m = /<input type="checkbox" id="cfgCrawlLatestOnly">(<span>[\s\S]*?<\/span>)/.exec(html)
ok(!!m, '能定位到开关自身的说明文本')
const text = m ? m[1] : ''
ok(!/只采集时间最新的脚本/.test(html), '未照抄「只采集时间最新的脚本」（实现并非纯按时间挑）')
ok(!/只收最新版/.test(html), '旧标题「只收最新版」已替换')
ok(/同组音源只保留最新版/.test(text), '新标题点明按「同组」归并且只留一个')
ok(/页面表格标注的版本号/.test(text) && /更新时间/.test(text), '说明写明页面表格版本号为准')
ok(/文件名/.test(text) && /兜底/.test(text), '说明写明「页面 > 文件名 > 时间」的优先级')
ok(/全部保留/.test(text) && /内容指纹/.test(text), '说明写明分不出版本时整组保留')
const hint = /这是<strong>全局采集偏好<\/strong>[\s\S]*?<\/p>/.exec(repoCard)
ok(!!hint, '仓库清单卡片内含独立的范围说明')
const hintText = hint ? hint[0] : ''
ok(/手动/.test(hintText) && /定时爬取/.test(hintText) && /自动流水线/.test(hintText) &&
  /网页音源站/.test(hintText), '范围说明覆盖手动/定时/流水线/网页站四种入口')
ok(/并非只对定时任务生效/.test(hintText), '明确否定「只管定时爬取」的误解')
ok(/取消勾选/.test(hintText), '说明关闭开关后的行为')

console.log('--- ④ 功能契约：id 未变，配置读写仍生效 ---')
ok(/\$\('cfgCrawlLatestOnly'\)\.checked\s*=\s*c\.crawlLatestOnly\s*!==\s*false/.test(app),
  'app.js 仍按默认 true 回显该开关')
ok(/crawlLatestOnly:\s*\$\('cfgCrawlLatestOnly'\)\.checked/.test(app),
  'app.js 仍保存该开关到配置')

console.log('\nPASS', pass, 'assertions')
