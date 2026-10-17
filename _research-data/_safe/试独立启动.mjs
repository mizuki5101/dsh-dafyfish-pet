/**
 * 「她现在能不能在**没有 DSH** 的情况下单独启动」——真机验法。
 *
 * 为什么要这么绕：我（写代码的这个工具进程）就跑在 DSH 里，不能把它关掉来试。
 * 所以改用「**不碰 DSH**」的方式来证明：
 *   · 另起一份外壳（`--user-data-dir` 独立，不干扰你现在那份）
 *   · 它的 settings.json 里 `linkDsh: false` —— 外壳**连探测都不会做**（syncUpstream 第一行就返回）
 *   · 那个实例的端口会被挤到随机端口（19400 已被你手上那份占着），顺带也验证了端口兜底
 * 然后看三件事：页面能不能出来、模型能不能加载、待机能不能动。
 *
 * 用法：node _research-data/_safe/试独立启动.mjs [调试口=9223]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { connect } from './cdp.mjs'

const PORT = process.argv[2] || '9223'
const EXE = 'D:\\whalepet\\DS-WhaleGirl-Pet.exe'
const ENV_JSON = path.join(import.meta.dirname, '真实环境.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-nodsh-'))

let pass = 0
const fails = []
const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fails.push(name + (extra ? ' —— ' + extra : ''))
    console.log('  ✗ ' + name + (extra ? ' —— ' + extra : ''))
  }
}

// 干净的 userData：设置里明确「不连 DSH」
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ fullscreenPrimary: false, linkDsh: false }, null, 2))

let env = {}
try {
  env = JSON.parse(fs.readFileSync(ENV_JSON, 'utf8').replace(/^\uFEFF/, ''))
} catch (e) {
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', '$h=@{};Get-ChildItem Env:|ForEach-Object{$h[$_.Name]=$_.Value};$h|ConvertTo-Json -Compress'], { encoding: 'utf8' })
  env = JSON.parse(r.stdout)
}
delete env.ELECTRON_RUN_AS_NODE // 坑 #1：带着它 Electron 会静默变成 Node 直接退出

console.log('用干净的 userData 启动：' + tmp)
const child = spawn(EXE, ['--user-data-dir=' + tmp, '--remote-debugging-port=' + PORT], {
  detached: false,
  stdio: 'ignore',
  cwd: 'D:\\whalepet',
  env,
})

let c = null
try {
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    try {
      c = await connect(Number(PORT))
      break
    } catch (e) {}
  }
  if (!c) throw new Error('30 秒内调试口没起来')

  console.log('\n=== 1. 页面能不能出来 ===')
  const url = c.page.url
  console.log('  页面: ' + url)
  ok('页面来自外壳自己的本地服务', /^http:\/\/127\.0\.0\.1:\d+\/dsh-pet\/standalone/.test(url), url)
  const port = Number((/127\.0\.0\.1:(\d+)/.exec(url) || [])[1] || 0)
  ok('端口不是 19400（19400 被你手上那份占着 → 自动兜底到 ' + port + '）', port !== 19400 && port > 1024)

  console.log('\n=== 2. 模型能不能加载（资源不再来自 DSH）===')
  let st = null
  for (let i = 0; i < 25; i++) {
    st = await c.evaluate('(window.DSHPet && DSHPet.state && DSHPet.state.modelSize) || null')
    if (st) break
    await sleep(1000)
  }
  ok('模型加载出来了：' + (st ? Math.round(st.w) + '×' + Math.round(st.h) : '没出来'), !!st, JSON.stringify(st))
  const boot = await c.evaluate('DSHPet.boot()')
  ok('boot.local = true', !!(boot && boot.local))
  const exprs = await c.evaluate('DSHPet.state.expressions.length')
  ok('表情表读到了（' + exprs + ' 个）', exprs >= 13, String(exprs))

  console.log('\n=== 3. 她认为自己和 DSH 的关系 ===')
  await sleep(1500)
  const link = await c.evaluate('DSHPet.linkState()')
  ok('她知道自己「未连上 DSH」', !!(link && link.known && !link.online), JSON.stringify(link))
  const state = JSON.parse(await (async () => {
    const r = await c.call('Runtime.evaluate', { expression: "fetch('/dsh-pet/state').then(r=>r.json()).then(j=>JSON.stringify(j))", returnByValue: true, awaitPromise: true })
    return r.result.value
  })())
  ok('本地服务：online=false、upstream=null（压根没去探 DSH）', state.online === false && !state.upstream, JSON.stringify({ online: state.online, upstream: state.upstream }))
  ok('本地服务：upstreamLost = 0（没有反复重连）', state.upstreamLost === 0, String(state.upstreamLost))

  console.log('\n=== 4. 对话不可用，但她说人话 ===')
  const say = JSON.parse(await (async () => {
    const r = await c.call('Runtime.evaluate', { expression: "fetch('/dsh-pet/say',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:''})}).then(async r=>JSON.stringify({status:r.status,body:await r.json()}))", returnByValue: true, awaitPromise: true })
    return r.result.value
  })())
  ok('/say → 503 offline', say.status === 503 && say.body.error === 'offline', JSON.stringify(say))

  console.log('\n=== 5. 她还在动 ===')
  const t1 = await c.evaluate('DSHPet.motionState().idle.t')
  await sleep(1500)
  const t2 = await c.evaluate('DSHPet.motionState().idle.t')
  ok('待机层在推进（' + t1 + ' → ' + t2 + '）', t2 > t1)
  const eye = await c.evaluate('DSHPet.eyeState()')
  ok('眨眼系统正常', eye && eye.L !== undefined, JSON.stringify(eye))
} finally {
  try {
    if (c) c.close()
  } catch (e) {}
  try {
    process.kill(child.pid)
  } catch (e) {}
  await sleep(1200)
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch (e) {}
}

console.log('\n' + '='.repeat(44))
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项：')
  for (const f of fails) console.log('  · ' + f)
  process.exit(1)
} else {
  console.log('「不靠 DSH 单独启动」通过：' + pass + ' 项')
}
