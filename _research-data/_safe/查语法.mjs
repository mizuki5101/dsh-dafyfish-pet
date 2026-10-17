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

const DEFAULTS = [
  'pet-plugin/assets/pet.js',
  'pet-plugin/lib/index.js',
  'shell/src/main.js',
  'shell/src/preload.js',
  'shell/src/petserver.js',
  'shell/src/audio.js',
  '_research-data/测试独立桌宠.mjs',
  '_research-data/验证独立外壳.mjs',
  '_research-data/验证断开降级.mjs',
]

const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS
const needVmModules = !process.execArgv.some((a) => a.includes('experimental-vm-modules') || a.includes('--experimental-vm-modules'))
if (needVmModules && typeof vm.SourceTextModule !== 'function') {
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url), ...files], { stdio: 'inherit' })
  process.exit(r.status === null ? 1 : r.status)
}

let bad = 0
for (const rel of files) {
  const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel)
  let src
  try {
    src = fs.readFileSync(abs, 'utf8')
  } catch (e) {
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
