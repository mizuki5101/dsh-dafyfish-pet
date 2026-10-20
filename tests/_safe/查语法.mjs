/**
 * 语法校验（替代 node --check）。
 *
 * 为什么不用 node --check：本机工作区路径含中文（live2D桌宠），
 * 子进程会原生崩溃（退出码 0x80000003 = 2147483651），交接文档坑 #11 同一类问题。
 * 这里在进程内解析，把文件包成「函数」或「模块」两种形态之一来校验：
 *   · 有顶层 import / export 的 → vm.SourceTextModule（需要 --experimental-vm-modules，本脚本会自己带上）
 *   · 其余（浏览器脚本 / CommonJS）→ new vm.Script 包一层函数，于是顶层 return 也合法
 *
 * 用法：node _research-data/_safe/查语法.mjs [文件...]
 *      不给文件时校验本项目全部关键文件。
 *
 * 2026-10-19：清单拆成 REQUIRED / OPTIONAL。
 *   原来是一张清单，缺文件就跳过 —— 结果是「核心模块被改名/误删」也能绿。
 *   现在：REQUIRED 缺一个就红；只有真机排障脚本（公开仓库本来就没有）允许缺席。
 *   另有覆盖告警：shell/src/heart/ 下新增模块忘了加进清单会打 ⚠（不失败）。
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')

// 开发仓库的测试在 _research-data/，公开仓库叫 tests/ —— 同一份脚本两边都要能跑
const DATA_DIR = fs.existsSync(path.join(ROOT, '_research-data')) ? '_research-data' : 'tests'

/** 必须存在：缺任何一个都算失败（改名/误删/路径写错都会红） */
const REQUIRED = [
  'pet-plugin/assets/pet.js',
  'pet-plugin/lib/index.js',
  'shell/src/main.js',
  'shell/src/preload.js',
  'shell/src/petserver.js',
  'shell/src/audio.js',
  'shell/src/heart/index.js',
  'shell/src/heart/capture.js',
  'shell/src/heart/gate.js',
  'shell/src/heart/hash.js',
  'shell/src/heart/config.js',
  'shell/src/heart/vision.js',
  'shell/src/heart/prompt.js',
  'shell/src/heart/catalog.js',
  'shell/src/heart/decide.js',
  'shell/src/heart/settings.js',
  'shell/src/heart/opener.js',
  'shell/src/heart/chat.js',
  'shell/src/heart/memo.js',
  'shell/src/heart/mask.js',
  'shell/src/heart/server.js',
  // 2026-10-20：刷视频（bili）—— 新增模块必须进清单，否则改名/误删照样全绿
  'shell/src/heart/bili/index.js',
  'shell/src/heart/bili/api.js',
  'shell/src/heart/bili/budget.js',
  'shell/src/heart/bili/frames.js',
  'shell/src/heart/bili/memo.js',
  DATA_DIR + '/测试独立桌宠.mjs',
  DATA_DIR + '/测试心跳决策.mjs',
  DATA_DIR + '/测试心跳纯函数.mjs',
  DATA_DIR + '/测试刷视频.mjs',
  DATA_DIR + '/_safe/查语法.mjs',
]

/**
 * 可以不存在：需要真实桌面外壳/Electron 或调试口的真机排障脚本。
 * 交接文档写明「真机 CDP 套件不在公开仓库」，所以它们缺席是预期内的。
 */
const OPTIONAL = [
  DATA_DIR + '/验证独立外壳.mjs',
  DATA_DIR + '/验证断开降级.mjs',
]

const DEFAULTS = REQUIRED.concat(OPTIONAL)

// ⚠️ 不能只看 argv 判断「是不是用户显式点名」：没有 --experimental-vm-modules 时
//    本脚本会 spawn 自己并把 files 作为参数传下去，子进程里的 argv 永远非空。
//    所以用环境变量把「二次启动 / 是否显式」两个事实都带过去。
const CHILD = process.env.DSHP_SYNTAX_CHILD === '1'
const ARGV_FILES = process.argv.slice(2)
const EXPLICIT = CHILD ? process.env.DSHP_SYNTAX_EXPLICIT === '1' : ARGV_FILES.length > 0
const files = ARGV_FILES.length ? ARGV_FILES : DEFAULTS

const needVmModules = !process.execArgv.some((a) => a.includes('experimental-vm-modules') || a.includes('--experimental-vm-modules'))
if (needVmModules && typeof vm.SourceTextModule !== 'function') {
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url), ...files], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, {
      DSHP_SYNTAX_CHILD: '1',
      DSHP_SYNTAX_EXPLICIT: EXPLICIT ? '1' : '',
    }),
  })
  process.exit(r.status === null ? 1 : r.status)
}

let pass = 0
let bad = 0
let skip = 0

for (const rel of files) {
  const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel)
  let src
  try {
    src = fs.readFileSync(abs, 'utf8')
  } catch (e) {
    // 只有 OPTIONAL 允许缺席；REQUIRED 缺了就是错（改名/误删/路径写错都该被抓住）。
    // 命令行显式点名的文件一律按 REQUIRED 处理。
    const optional = !EXPLICIT && OPTIONAL.includes(rel)
    if (optional && e.code === 'ENOENT') {
      skip++
      console.log('· ' + rel + ' —— 可选文件不存在，跳过')
      continue
    }
    bad++
    console.log('✗ ' + rel + ' —— 读不出来：' + e.message)
    continue
  }
  const isModule = /^\s*(import|export)\s/m.test(src)
  try {
    if (isModule && typeof vm.SourceTextModule === 'function') new vm.SourceTextModule(src)
    else new vm.Script('(function(exports,require,module,__filename,__dirname){' + src + '\n})')
    pass++
    console.log('✓ ' + rel + (isModule ? '（ESM）' : ''))
  } catch (e) {
    bad++
    console.log('✗ ' + rel + ' —— ' + e.message)
  }
}

// —— 覆盖告警（不失败）：新增模块忘了加进 REQUIRED，这里能看见 ——
if (!EXPLICIT) {
  const heartDir = path.join(ROOT, 'shell/src/heart')
  let names = []
  try {
    names = fs.readdirSync(heartDir).filter((n) => n.endsWith('.js'))
  } catch (e) {}
  const listed = new Set(files.map((p) => String(p).replace(/\\/g, '/')))
  const uncovered = names.filter((n) => !listed.has('shell/src/heart/' + n))
  if (uncovered.length) {
    console.log('\n⚠ 有 ' + uncovered.length + ' 个模块没纳入语法检查：')
    for (const n of uncovered) console.log('   shell/src/heart/' + n)
    console.log('   → 加进 REQUIRED，否则它语法错了 CI 也不会发现')
  }
}

console.log('')
if (bad) {
  console.log('有 ' + bad + ' 个文件语法不过' + (skip ? '（另有 ' + skip + ' 个可选文件缺席）' : ''))
} else {
  console.log('全部语法通过：' + pass + ' 个' + (skip ? '（跳过 ' + skip + ' 个可选文件）' : ''))
}
process.exit(bad ? 1 : 0)
