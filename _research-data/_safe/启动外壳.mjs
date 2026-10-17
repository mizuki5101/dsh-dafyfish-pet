/**
 * 带调试口重启桌宠外壳（可复用）。
 *
 * 为什么需要这个脚本（都是踩过的）：
 *   · DSH 工具进程的环境里有 ELECTRON_RUN_AS_NODE=1 → Electron 会静默变成 Node 立刻退出（交接文档坑 #1）
 *   · 本沙箱里 process.env 是空的，直接 spawn exe 会崩在 0x80000003（读不到系统环境）
 *     → 所以先从 PowerShell 抓一份真实环境存成 真实环境.json，再传给子进程
 *   · 已经有一份在跑时必须先清场，否则外壳的单实例锁会让新进程起不来（boot.log 会停在 "=== 启动 ===" 就没有下文）
 *   · 非 ASCII 路径（工作区名里有中文）会让子进程原生崩溃 → 所以 cwd 用 D:\whalepet
 *
 * 用法：node _research-data/_safe/启动外壳.mjs [端口]
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const PORT = process.argv[2] || '9222'
const EXE = 'D:\\whalepet\\DS-WhaleGirl-Pet.exe'
const ENV_JSON = path.join(import.meta.dirname, '真实环境.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1) 抓真实环境（沙箱里 process.env 是空的，不能直接用）
const psEnv = spawnSync('pwsh', ['-NoProfile', '-Command',
  "$h=@{};Get-ChildItem Env:|ForEach-Object{$h[$_.Name]=$_.Value};$h|ConvertTo-Json -Compress"],
  { encoding: 'utf8', shell: false })
let env = {}
if (psEnv.stdout && psEnv.stdout.trim().startsWith('{')) {
  env = JSON.parse(psEnv.stdout)
  fs.writeFileSync(ENV_JSON, JSON.stringify(env, null, 1), 'utf8')
} else {
  env = JSON.parse(fs.readFileSync(ENV_JSON, 'utf8').replace(/^\uFEFF/, ''))
}
delete env.ELECTRON_RUN_AS_NODE            // ⚠️ 坑 #1
console.log('环境变量 ' + Object.keys(env).length + ' 个，ELECTRON_RUN_AS_NODE 已清除')

// 2) 清场（单实例锁）
spawnSync('pwsh', ['-NoProfile', '-Command', 'Stop-Process -Name DS-WhaleGirl-Pet -Force -ErrorAction SilentlyContinue'], { stdio: 'ignore' })
await sleep(4000)

// 3) 启动
const child = spawn(EXE, ['--remote-debugging-port=' + PORT], { detached: true, stdio: 'ignore', cwd: 'D:\\whalepet', env })
child.unref()
console.log('已启动 pid=' + child.pid + '，调试口 ' + PORT)

// 4) 等端口
for (let i = 0; i < 40; i++) {
  await sleep(1000)
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + '/json/version', { signal: AbortSignal.timeout(1500) })
    if (r.ok) { console.log('✅ ' + (i + 1) + ' 秒后调试口就绪'); process.exit(0) }
  } catch {}
}
console.error('❌ 30 秒内调试口没起来，去看 %APPDATA%\\ds-whale-girl-pet\\boot.log')
process.exit(1)
