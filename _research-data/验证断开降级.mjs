/**
 * 「DSH 关掉以后，她其他一切正常」的真机验收。
 *
 * 怎么模拟「DSH 关了」而不真的关掉 DSH：外壳的托盘里有一个「连接 DSH：自动/关闭」开关，
 * 它写进 settings.json 的 linkDsh；syncUpstream() 每 8 秒读一次，
 * 所以关掉它 = 外壳主动断开上游 = DSH 掉线时同一套代码路径（petserver 的 markOffline）。
 *
 * 验四件事：
 *   ① 断线后页面照常活着（模型在、待机在、眨眼在）
 *   ② 断线的瞬间她从「思考中」回到 idle（不会永远定格在一个表情上）
 *   ③ 对话相关的接口给 503 + error:'offline'（前端据此说人话）
 *   ④ 重新打开开关后 8 秒内自动接回来（「开 DSH 她就自己连上」）
 *
 * 用法：node _research-data/验证断开降级.mjs [调试口]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connect } from './_safe/cdp.mjs'

const port = Number(process.argv[2] || 9222)
const SETTINGS = path.join(process.env.APPDATA || os.homedir(), 'DS-WhaleGirl-Pet', 'settings.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want))

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) || {}
  } catch (e) {
    return {}
  }
}
function writeSettings(obj) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true })
  fs.writeFileSync(SETTINGS, JSON.stringify(obj, null, 2))
}

const origin = readSettings()
const c = await connect(port)
/** 一次异步求值（⚠️ 不能走 c.evaluate：它会对 Promise 直接 JSON.stringify，得到 {}） */
const evalAsync = async (expr) => {
  const r = await c.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r && r.result ? r.result.value : null
}
/*
 * ⚠️⚠️ 这个文件**绝不能**在「连着」的状态下调 /dsh-pet/say。
 * 它不是连通性探针：外壳把它代理给 DSH，插件再交给 sessionController.prompt ——
 * 也就是**真的往主人的会话里塞一条用户消息**（而且是排队执行的）。
 * 2026-10-17 我拿它当探针，结果在 DSH 里插进了几条「在吗」，主人直接问「是你发的吗」。
 * 探针只用**只读**接口：/dsh-pet/hud（余额快照）或 /dsh-pet/state。
 */
const postSayOfflineProbe = async () =>
  JSON.parse(
    await evalAsync(
      "fetch('/dsh-pet/say',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:''})}).then(async r=>JSON.stringify({status:r.status,body:await r.json()}))",
    ),
  )
const getHud = async () =>
  JSON.parse(await evalAsync("fetch('/dsh-pet/hud').then(async r=>JSON.stringify({status:r.status,body:await r.json()}))"))
/*
 * 探活一律用 /dsh-pet/ping（只读，专为这件事开的）。
 * ⚠️ 不要用 /say —— 它是写操作，会真的往会话里塞消息（2026-10-17 我踩过，DSH 里多了几条「在吗」）。
 */
const getPing = async () =>
  JSON.parse(await evalAsync("fetch('/dsh-pet/ping').then(async r=>JSON.stringify({status:r.status,body:await r.json()}))"))

try {
  console.log('=== 0. 前提：先确认现在是连着的 ===')
  let link = await c.evaluate('DSHPet.linkState()')
  ok('验收开始时是连上的（不然下面的「断开」没有对照）', !!(link && link.online), JSON.stringify(link))
  const beforePing = await getPing()
  ok('连着的时候 /ping 说可以接话（只读探针，不发消息）', !!(beforePing.body && beforePing.body.canSay), JSON.stringify(beforePing).slice(0, 140))

  console.log('\n=== 1. 断开（等价于 DSH 被关掉）===')
  writeSettings(Object.assign({}, readSettings(), { linkDsh: false }))
  let waited = 0
  while (waited < 20000) {
    await sleep(1000)
    waited += 1000
    link = await c.evaluate('DSHPet.linkState()')
    if (link && !link.online) break
  }
  ok('外壳在 ' + waited / 1000 + ' 秒内断开了上游', !!(link && !link.online), JSON.stringify(link))

  console.log('\n=== 2. 断线后她照常活着 ===')
  await sleep(1500)
  const st = await c.evaluate('DSHPet.state')
  ok('模型还在（没有白屏）', !!(st && st.modelSize), JSON.stringify(st && st.modelSize))
  eq('画布还是 3326×4992', st && Math.round(st.modelSize.w) + 'x' + Math.round(st.modelSize.h), '3326x4992')
  ok('表情还在', st && st.expressions && st.expressions.length >= 13)
  eq('agent 状态回到 idle（不会永远停在「思考中」）', link && link.status, 'idle')
  const t1 = await c.evaluate('DSHPet.motionState().idle.t')
  await sleep(1200)
  const t2 = await c.evaluate('DSHPet.motionState().idle.t')
  ok('待机层还在推进（' + t1 + ' → ' + t2 + '）', t2 > t1)
  const eye = await c.evaluate('DSHPet.eyeState()')
  ok('眨眼系统正常', eye && eye.L !== undefined, JSON.stringify(eye))
  const body = await c.evaluate('document.body ? getComputedStyle(document.body).getPropertyValue("--dsh-pet-standalone") : ""')
  ok('页面仍是独立页（判据变量还在）', String(body).trim() !== '')

  console.log('\n=== 3. 只有对话不可用，而且要能听懂 ===')
  // 离线时 /say 是安全的：本地服务直接 503，根本不会碰到 DSH（也就不会塞消息）
  const say = await postSayOfflineProbe()
  eq('/say 给 503', say.status, 503)
  eq('/say 带 error=offline', say.body && say.body.error, 'offline')
  ok('/say 带中文人话（前端直接显示它）', !!(say.body && say.body.message), JSON.stringify(say.body))
  const pingOff = await getPing()
  eq('离线时 /ping 仍回 200（探针本身不该失败）', pingOff.status, 200)
  eq('离线时 /ping 说没连上', pingOff.body && pingOff.body.online, false)
  const hud = await getHud()
  eq('/hud 离线时也给 503', hud.status, 503)
  const state = JSON.parse(await evalAsync("fetch('/dsh-pet/state').then(r=>r.json()).then(j=>JSON.stringify(j))"))
  eq('/state 说 online=false', state.online, false)

  console.log('\n=== 3.5 断线状态下刷新页面（这正是原来会白屏的情形）===')
  await evalAsync('(function(){ setTimeout(function(){ location.reload() }, 60); return 1 })()')
  await sleep(2500)
  let ready = null
  for (let i = 0; i < 20; i++) {
    await sleep(1000)
    try {
      ready = await c.evaluate('(window.DSHPet && DSHPet.state && DSHPet.state.modelSize) || null')
    } catch (e) {
      ready = null
    }
    if (ready) break
  }
  ok('刷新后她重新加载出来了（模型 ' + (ready ? Math.round(ready.w) + '×' + Math.round(ready.h) : '没出来') + '）', !!ready, JSON.stringify(ready))
  const afterReloadLink = await c.evaluate('DSHPet.linkState()')
  ok('刷新后仍然是「未连上 DSH」的状态', !!(afterReloadLink && afterReloadLink.known && !afterReloadLink.online), JSON.stringify(afterReloadLink))
  const afterReloadBoot = await c.evaluate('DSHPet.boot()')
  ok('刷新后 boot.local 仍然是 true（页面还是本地服务给的）', !!(afterReloadBoot && afterReloadBoot.local), JSON.stringify(afterReloadBoot && afterReloadBoot.local))
  const afterReloadLayout = await c.evaluate("(function(){try{return JSON.parse(localStorage.getItem('dsh-live2d-pet:layout')||'{}').height}catch(e){return null}})()")
  ok('刷新后她的大小编排还在（' + afterReloadLayout + '）', afterReloadLayout === 720, String(afterReloadLayout))

  console.log('\n=== 4. 重新打开开关 → 8 秒内自动接回 ===')
  writeSettings(Object.assign({}, readSettings(), { linkDsh: true }))
  waited = 0
  while (waited < 20000) {
    await sleep(1000)
    waited += 1000
    link = await c.evaluate('DSHPet.linkState()')
    if (link && link.online) break
  }
  ok('外壳在 ' + waited / 1000 + ' 秒内自己接回来了', !!(link && link.online), JSON.stringify(link))
  const afterPing = await getPing()
  ok('接回来以后 /ping 又可以说可以接话了', !!(afterPing.body && afterPing.body.canSay), JSON.stringify(afterPing).slice(0, 140))
} finally {
  // 无论成没成，都要把 settings.json 恢复原样（这是真机配置，别留脏数据）
  writeSettings(origin)
  c.close()
}

console.log('\n' + '='.repeat(44))
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项：')
  for (const f of fails) console.log('  · ' + f)
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项')
  process.exit(1)
} else {
  console.log('断开降级验收通过：' + pass + ' 项')
}
