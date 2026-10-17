/**
 * 把她装进桌面外壳：把 shell/src 打成 app.asar，装到 exe 旁边。
 *
 * 为什么要有这个脚本（交接文档「九、技术债」第一条就写着）：
 *   app.asar **没有版本管理** —— 以前每次改外壳都是「关外壳 → npx extract → 手改 → npx pack → 重启」，
 *   改了什么、改没改成功，全靠记忆。现在外壳的源码进仓库（shell/src），打包只剩一条命令。
 *
 * 用法：
 *   node shell/build.mjs                 只打包 → shell/dist/app.asar
 *   node shell/build.mjs --install       打包并装到外壳目录（会先备份现有的 asar）
 *   node shell/build.mjs --install --assets   顺便把 pet.js/运行时/模型拷成 exe 同级 pet-assets/
 *                                            （「整目录拷走就能跑」的自包含发行用；29MB 贴图会一起拷）
 *   node shell/build.mjs --verify        打包后解开校验一遍（文件齐、语法过）
 *
 * ⚠️ 安装前必须先退出外壳：Electron 正在用那个 asar，Windows 下会锁住文件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE = path.resolve(HERE, '..')
const SRC = path.join(HERE, 'src')
const DIST = path.join(HERE, 'dist')
const OUT = path.join(DIST, 'app.asar')
/** 外壳安装位（与插件 lib/index.js 的 SHELL_CANDIDATES 保持一致） */
const SHELL_DIR = process.env.DSH_PET_SHELL_DIR || 'D:\\whalepet'
const SHELL_ASAR = path.join(SHELL_DIR, 'resources', 'app.asar')
const ASSETS_SRC = path.join(WORKSPACE, 'pet-plugin', 'assets')
const ASSETS_DST = path.join(SHELL_DIR, 'pet-assets')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)

/** 找 @electron/asar 的命令行（有 npx 缓存就用缓存里那份，不联网） */
function findAsarCli() {
  const cands = []
  if (process.env.DSH_ASAR_CLI) cands.push(process.env.DSH_ASAR_CLI)
  cands.push(path.join(WORKSPACE, 'node_modules', '@electron', 'asar', 'bin', 'asar.mjs'))
  const npx = path.join(WORKSPACE, '.npm-cache', '_npx')
  try {
    for (const d of fs.readdirSync(npx)) {
      cands.push(path.join(npx, d, 'node_modules', '@electron', 'asar', 'bin', 'asar.mjs'))
    }
  } catch (e) {}
  for (const c of cands) {
    try {
      if (fs.statSync(c).isFile()) return c
    } catch (e) {}
  }
  throw new Error('找不到 @electron/asar。跑一次 npx @electron/asar --version 就会有缓存，或用 DSH_ASAR_CLI 指定。')
}

function walk(dir, base, out) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name)
    const rel = base ? base + '/' + name : name
    const s = fs.statSync(abs)
    if (s.isDirectory()) walk(abs, rel, out)
    else out.push({ rel, size: s.size })
  }
  return out
}

function syntaxOk(file) {
  const src = fs.readFileSync(file, 'utf8')
  new vm.Script('(function(exports,require,module,__filename,__dirname){' + src + '\n})')
}

/** 打包 */
function pack() {
  fs.mkdirSync(DIST, { recursive: true })
  try {
    fs.rmSync(OUT)
  } catch (e) {}
  const cli = findAsarCli()
  const r = spawnSync(process.execPath, [cli, 'pack', SRC, OUT], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error('asar pack 失败：' + (r.stderr || r.stdout || r.status))
  const files = walk(SRC, '', []).sort((a, b) => a.rel.localeCompare(b.rel))
  const size = fs.statSync(OUT).size
  console.log('打包完成：' + OUT)
  console.log('  体积 ' + (size / 1024 / 1024).toFixed(2) + ' MB，' + files.length + ' 个文件')
  for (const f of files) console.log('    ' + f.rel + '  ' + (f.size / 1024).toFixed(1) + ' KB')
  return { size, files }
}

/** 解开校验：文件齐、main.js 语法过 */
function verify() {
  const cli = findAsarCli()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-asar-'))
  const r = spawnSync(process.execPath, [cli, 'extract', OUT, tmp], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error('asar extract 失败：' + (r.stderr || r.stdout))
  const got = walk(tmp, '', []).map((f) => f.rel).sort()
  const want = walk(SRC, '', []).map((f) => f.rel).sort()
  const missing = want.filter((f) => !got.includes(f))
  if (missing.length) throw new Error('asar 里少了：' + missing.join(', '))
  for (const f of ['main.js', 'preload.js', 'petserver.js', 'audio.js']) {
    syntaxOk(path.join(tmp, f))
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'))
  if (pkg.main !== 'main.js') throw new Error('package.json 的 main 不是 main.js')
  const mainSrc = fs.readFileSync(path.join(tmp, 'main.js'), 'utf8')
  // 结构锁：独立化的三个关键函数必须在包里（不然「独立」这件事根本没上线）
  for (const key of ['createPetServer', 'startLocalServer', 'syncUpstream']) {
    if (!mainSrc.includes(key)) throw new Error('main.js 里缺少 ' + key + '（独立化代码没打进去？）')
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('校验通过：' + got.length + ' 个文件，语法 OK，package.json OK，独立化代码在位')
}

/** 装到外壳目录（先备份） */
function install() {
  if (!fs.existsSync(SHELL_ASAR)) throw new Error('找不到外壳：' + SHELL_ASAR)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backup = path.join(WORKSPACE, '_restore', 'app.asar.bak-' + stamp)
  fs.mkdirSync(path.dirname(backup), { recursive: true })
  fs.copyFileSync(SHELL_ASAR, backup)
  console.log('已备份现有 asar → ' + backup)
  try {
    fs.copyFileSync(OUT, SHELL_ASAR)
  } catch (e) {
    throw new Error('写入失败（外壳还在运行？先把她彻底退出再装）：' + e.message)
  }
  console.log('已安装 → ' + SHELL_ASAR + '（' + (fs.statSync(SHELL_ASAR).size / 1024 / 1024).toFixed(2) + ' MB）')
  console.log('⚠️ 需要重启外壳才生效：PowerShell 里 Stop-Process -Name DS-WhaleGirl-Pet -Force，再双击 exe')
}

/** 自包含发行：把资源拷到 exe 同级 pet-assets/ */
function copyAssets() {
  if (!fs.existsSync(ASSETS_SRC)) throw new Error('找不到资源目录：' + ASSETS_SRC)
  let n = 0
  let bytes = 0
  const copy = (from, to) => {
    fs.mkdirSync(to, { recursive: true })
    for (const name of fs.readdirSync(from)) {
      // 鲸鱼娘那套原模型不拷（我们只做大肥鱼，省 2MB 和一堆混淆）
      if (name.startsWith('c_0120')) continue
      const a = path.join(from, name)
      const b = path.join(to, name)
      const s = fs.statSync(a)
      if (s.isDirectory()) copy(a, b)
      else {
        fs.copyFileSync(a, b)
        n++
        bytes += s.size
      }
    }
  }
  copy(ASSETS_SRC, ASSETS_DST)
  // pet.js 是「前端本体」，资源根目录约定它是 assets/pet.js
  fs.copyFileSync(path.join(ASSETS_SRC, 'pet.js'), path.join(ASSETS_DST, 'pet.js'))
  console.log('资源已拷到 ' + ASSETS_DST + '：' + n + ' 个文件，' + (bytes / 1024 / 1024).toFixed(1) + ' MB')
  console.log('  注意：拷完以后「改 pet.js → 重启外壳」改的是工作区那份；')
  console.log('  想让外壳读这份，就在 settings.json 里写 {"assetRoots":["' + ASSETS_DST.replace(/\\/g, '/') + '"]}，')
  console.log('  或者把工作区挪走后它自然就会用这份（候选顺序见 main.js 的 assetRoots()）。')
}

const t0 = Date.now()
const info = pack()
if (has('--verify') || has('--install')) verify()
if (has('--install')) install()
if (has('--assets')) copyAssets()
console.log('耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's')
