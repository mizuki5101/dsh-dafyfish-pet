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

const DEFAULTS = [
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
  'shell/src/heart/server.js',
  DATA_DIR + '/测试独立桌宠.mjs',
  DATA_DIR + '/测试心跳决策.mjs',
  DATA_DIR + '/测试心跳纯函数.mjs',
  DATA_DIR + '/验证独立外壳.mjs',
  DATA_DIR + '/验证断开降级.mjs',
]

// ⚠️ 不能只看 argv 判断「是不是用户显式点名」：没有 --experimental-vm-modules 时
//    本脚本会 spawn 自己并把 files 作为参数传下去，子进程里的 argv 永远非空。
//    所以用环境变量标记「这是二次启动」，否则「缺文件跳过」在 CI 里永远不生效。
const EXPLICIT = process.argv.slice(2).length > 0 && !process.env.DSHP_SYNTAX_CHILD
const files = EXPLICIT ? process.argv.slice(2) : DEFAULTS
const needVmModules = !process.execArgv.some((a) => a.includes('experimental-vm-modules') || a.includes('--experimental-vm-modules'))
if (needVmModules && typeof vm.SourceTextModule !== 'function') {
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url), ...files], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { DSHP_SYNTAX_CHILD: '1' }),
  })
  process.exit(r.status === null ? 1 : r.status)
}

let bad = 0
for (const rel of files) {
  const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel)
  let src
  try {
    src = fs.readFileSync(abs, 'utf8')
  } catch (e) {
    // 默认清单里有些只是开发仓库的排障脚本，公开仓库没有 —— 跳过，不算失败。
    // 显式在命令行点名的文件缺了才算错。
    if (!EXPLICIT && e.code === 'ENOENT') {
      console.log('· ' + rel + ' —— 不存在，跳过')
      continue
    }
    console.log('✗ ' + rel + ' —— 读不出来：' + e.message)
    bad++
    continue
  }
  const isModule = /^\s*(import|export)\s/m.test(src)
  try {
    if (isModule && typeof vm.SourceTextModule === 'function') new vm.SourceTextModule(src)
    else new vm.Script('(function(exports,require,module,__filename,__dirname){' + src + '\n})')
    console.log('✓ ' + rel + (isModule ? '（ESM）' : ''))
  } catch (e) {
    bad++
    console.log('✗ ' + rel + ' —— ' + e.message)
  }
}
console.log(bad ? '有 ' + bad + ' 个文件语法不过' : '全部语法通过：' + files.length + ' 个文件')
process.exit(bad ? 1 : 0)
