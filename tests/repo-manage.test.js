/**
 * v1.9.12 统一仓库清单：
 *  - 首次启动把内置 DEFAULT_REPOS + 旧 customRepos 播种进可管理的 repos 清单；
 *  - 内置/附加/发现三类仓库都可勾选禁用（本次不爬）或删除；
 *  - 搜索发现的仓库会持久化进清单，且已禁用的不会被搜索重新启用。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Store } = require(path.join(__dirname, '..', 'src', 'core', 'store.js'))
const { buildRepoSeeds } = require(path.join(__dirname, '..', 'src', 'core', 'hunter.js'))
const { DEFAULT_REPOS } = require(path.join(__dirname, '..', 'src', 'core', 'crawler.js'))

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }

const tmp = () => fs.mkdtempSync(os.tmpdir() + path.sep + 'lxr-')
const put = (dir, obj) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(obj))

// ---------- 1. 首次启动播种：内置 + 旧附加仓库 ----------
;(async () => {
const d1 = tmp()
put(d1, { customRepos: ['myuser/myrepo', 'https://github.com/Other/Custom.git'] })
const s1 = new Store(d1)
const EXPECT1 = DEFAULT_REPOS.length + 2 // 内置 38 + 两个迁移来的旧附加仓库
ck('首次启动把内置仓库播种进 repos', s1.config.repos.length === EXPECT1, 'got ' + s1.config.repos.length + ' expect ' + EXPECT1)
ck('内置仓库标记为 builtin/origin=builtin 且默认启用',
  s1.config.repos.filter(r => r.origin === 'builtin').every(r => r.builtin === true && r.enabled === true))
ck('旧 customRepos 迁移为 origin=custom 且剥离成 owner/repo',
  s1.config.repos.some(r => r.repo === 'myuser/myrepo' && r.origin === 'custom' && r.builtin === false) &&
  s1.config.repos.some(r => r.repo === 'Other/Custom' && r.origin === 'custom'),
  JSON.stringify(s1.config.repos.filter(r => r.origin === 'custom').map(r => r.repo)))
ck('旧 customRepos 已清空（避免与 legacy 回退重复计数）', s1.config.customRepos.length === 0)
ck('播种结果已落盘', (JSON.parse(fs.readFileSync(path.join(d1, 'config.json'), 'utf8')).repos || []).length === EXPECT1)

// ---------- 2. 已有 repos 数组时尊重用户编辑（哪怕为空） ----------
const d2 = tmp()
put(d2, { repos: [], customRepos: ['foo/bar'] })
const s2 = new Store(d2)
ck('已有空 repos 数组：不再播种（尊重用户清空）', Array.isArray(s2.config.repos) && s2.config.repos.length === 0, JSON.stringify(s2.config.repos))
ck('未迁移时旧 customRepos 保留不被清', s2.config.customRepos.length === 1)

const d3 = tmp()
put(d3, { repos: [{ repo: 'a/b', enabled: false, builtin: true, origin: 'builtin' }] })
const s3 = new Store(d3)
ck('已有 repos 清单：不覆盖用户设置（保留 disabled）',
  s3.config.repos.length === 1 && s3.config.repos[0].enabled === false && s3.config.repos[0].repo === 'a/b')

// ---------- 3. buildRepoSeeds：只出启用中的仓库 ----------
const list = [
  { repo: 'a/keep', enabled: true, builtin: true, origin: 'builtin' },
  { repo: 'b/off', enabled: false, builtin: true, origin: 'builtin' },
  { repo: 'c/disc', enabled: true, builtin: false, origin: 'discovered' }
]
const seeds = buildRepoSeeds({ repos: list })
ck('只取启用的仓库（内置被禁用则不爬）', seeds.join(',') === 'a/keep,c/disc', seeds.join(','))
ck('发现的仓库也会参与爬取', seeds.includes('c/disc'))

const none = buildRepoSeeds({ repos: [{ repo: 'a/b', enabled: false }] })
ck('全部禁用 → 种子为空（不回退到内置，尊重用户选择）', Array.isArray(none) && none.length === 0, 'got ' + none.length)

// legacy 回退：repos 非数组时用 DEFAULT_REPOS + customRepos
const legacy = buildRepoSeeds({ customRepos: ['legacy/one', 'a/b'] })
ck('未迁移时回退：含全部内置仓库', legacy.length >= DEFAULT_REPOS.length, 'got ' + legacy.length)
ck('未迁移时回退：附加仓库并入且不重复', legacy.includes('legacy/one') && legacy.filter(x => x === 'a/b').length === 1)

// 规范化：完整 URL / .git 后缀统一剥成 owner/repo（大小写沿用 normalizeRepo 的既有行为）
const norm = buildRepoSeeds({ repos: [{ repo: 'https://github.com/GitHubUser/MyRepo.git', enabled: true }] })
ck('种子列表已归一化为 owner/repo（剥离 URL 与 .git）', norm.join(',') === 'GitHubUser/MyRepo', norm.join(','))

if (bad) { console.error(`\n${bad} 个断言失败`); process.exit(1) }
console.log('\n全部通过')
})()
