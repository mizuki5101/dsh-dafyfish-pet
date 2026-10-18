/**
 * 「她脱离 DSH 独立存在」的单测（纯 Node，不需要外壳、不需要 DSH）。
 *
 * 被测对象是 shell/src/petserver.js —— 外壳自己的本地 HTTP 服务。
 * 为什么它值得这么多断言：她能不能在 DSH 关着的时候照常活着，全看这个文件对不对。
 *
 * 三层：
 *   ① 路由契约：pet.js 里凡 BASE + '/xxx' 的请求，本地服务必须都接得住（少一条 = 某个功能悄悄没了）
 *   ② 信任栅栏：回环端口不设防，任意网页都能访问 —— Host / Origin / 令牌 三关逐个验
 *   ③ 上游桥：连上 DSH 时转发、断开时静默降级、离线时 503 由前端兜住
 *
 * 用法：node _research-data/测试独立桌宠.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createPetServer, handles, ROUTES, standalonePage } = require('../shell/src/petserver.js')

const PET = path.join(import.meta.dirname, '..', 'pet-plugin', 'assets', 'pet.js')
const TOKEN = 'a'.repeat(32)

let pass = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fails.push(name + (extra ? ' —— ' + extra : ''))
    console.log('  ✗ ' + name + (extra ? ' —— ' + extra : ''))
  }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want))
}

// ————————————————————————————————————————————————————————————————
// 0. 造一份假资源目录（不碰真模型，测试要快、要能随便跑）
// ————————————————————————————————————————————————————————————————
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pet-local-'))
const ROOT_A = path.join(TMP, 'assets')
const ROOT_B = path.join(TMP, 'assets2')
fs.mkdirSync(path.join(ROOT_A, 'model'), { recursive: true })
fs.mkdirSync(path.join(ROOT_A, 'vendor'), { recursive: true })
fs.mkdirSync(ROOT_B, { recursive: true })
fs.writeFileSync(path.join(ROOT_A, 'pet.js'), ';(function(){ window.__DSH_PET_LOADED__ = true })()\nwindow.DSHPet={};\n')
fs.writeFileSync(path.join(ROOT_A, 'model', 'manifest.json'), '{"displayName":"大肥鱼"}')
fs.writeFileSync(path.join(ROOT_A, 'model', 'dfyfish.model3.json'), '{"Version":3}')
fs.writeFileSync(path.join(ROOT_A, 'vendor', 'pixi.min.js'), 'window.PIXI={};')
fs.writeFileSync(path.join(ROOT_A, 'only-a.txt'), 'A')
// 第二个根目录只有这一个文件 —— 用来验证「按顺序找第一个存在的」
fs.mkdirSync(path.join(ROOT_B, 'model'), { recursive: true })
fs.writeFileSync(path.join(ROOT_B, 'model', 'only-b.txt'), 'B')
fs.writeFileSync(path.join(TMP, 'secret.txt'), 'SECRET')
const SEED = path.join(TMP, 'layout-seed.json')
fs.writeFileSync(SEED, JSON.stringify({ height: 720, cfg: { idleStrength: 1.6 } }))
const CFG = path.join(TMP, 'pet-config.json')
fs.writeFileSync(CFG, JSON.stringify({ height: 240, idleRhythm: false }))

// ————————————————————————————————————————————————————————————————
// 1. 路由契约（从真 pet.js 里抠「她会请求哪些路径」）
//
// 这是本套件最重要的一条回归锁：外壳资源自足后，谁要是加了一个新接口
// 却忘了在 petserver 里接住，她独立运行时那个功能就会静默 404。
// ————————————————————————————————————————————————————————————————
console.log('=== 1. 路由契约（pet.js ↔ petserver.ROUTES）===')
const petSrc = fs.readFileSync(PET, 'utf8')
const used = new Set()
for (const m of petSrc.matchAll(/BASE \+ '([^']+)'/g)) used.add('/dsh-pet' + m[1])
const hud = petSrc.match(/const HUD_SELF = '([^']+)'/)
if (hud) used.add(hud[1])
ok('从 pet.js 抠到 ' + used.size + ' 个请求路径', used.size >= 6, [...used].join(' '))
for (const p of [...used].sort()) {
  ok('petserver 认得 ' + p, !!handles(p), 'ROUTES 里没有对应项 → 独立后这个功能会 404')
}
eq('前缀路由 /dsh-pet/model/ 命中', handles('/dsh-pet/model/manifest.json'), 'static')
eq('前缀路由 /dsh-pet/vendor/ 命中', handles('/dsh-pet/vendor/pixi.min.js'), 'static')
eq('未登记的路径返回 null', handles('/dsh-pet/不存在'), null)
ok('standalone 页带 --dsh-pet-standalone:1（pet.js 的判据）', standalonePage({}).includes('--dsh-pet-standalone:1'))
ok('standalone 页加载 /dsh-pet/pet.js', standalonePage({}).includes('src="/dsh-pet/pet.js"'))
ok('standalone 页的 title 仍含「桌宠」「鲸鱼」（第三道判据兜底）',
  standalonePage({}).includes('桌宠') && standalonePage({}).includes('鲸鱼'))

// ————————————————————————————————————————————————————————————————
// 2. 起服务
// ————————————————————————————————————————————————————————————————
console.log('\n=== 2. 起服务与静态资源 ===')
const srv = createPetServer({
  assetRoots: [ROOT_A, ROOT_B],
  configFile: CFG,
  seedFile: SEED,
  version: '9.9.9',
  token: TOKEN,
  log: () => {},
})
const { port } = await srv.listen(0)
ok('随机端口已分配（' + port + '）', port > 1024)
ok('state().port 与服务端口一致', srv.state().port === port)

const base = 'http://127.0.0.1:' + port
const COOKIE = 'dsh_pet_local=' + TOKEN

async function req(p, opts = {}) {
  const res = await fetch(base + p, {
    method: opts.method || 'GET',
    headers: Object.assign({ Cookie: COOKIE }, opts.headers || {}),
    body: opts.body,
    redirect: 'manual',
  })
  let body = ''
  try {
    body = await res.text()
  } catch (e) {}
  return { status: res.status, headers: res.headers, body }
}

let r = await req('/dsh-pet/standalone')
ok('页面 200', r.status === 200, String(r.status))
ok('页面是 html', (r.headers.get('content-type') || '').includes('text/html'))

r = await req('/dsh-pet/pet.js')
ok('pet.js 200', r.status === 200, String(r.status))
ok('pet.js 是 js 类型', (r.headers.get('content-type') || '').includes('javascript'))
const bootAt = r.body.indexOf('__DSH_PET_BOOT__=')
const runAt = r.body.indexOf('__DSH_PET_LOADED__')
ok('boot 注入在 pet.js 本体之前（老实现拼在后面 → 配置文件从来没生效过）',
  bootAt >= 0 && bootAt < runAt, 'bootAt=' + bootAt + ' runAt=' + runAt)
const bootSrc = r.body.slice(bootAt + '__DSH_PET_BOOT__='.length, r.body.indexOf(';\n', bootAt))
let boot = null
try {
  boot = JSON.parse(bootSrc)
} catch (e) {}
ok('boot 是合法 JSON', !!boot)
eq('boot.local = true（前端据此知道宿主是外壳自己的服务）', boot && boot.local, true)
eq('boot.config 只回用户写过的键（不重复填默认值）', boot && Object.keys(boot.config).sort(), ['height', 'idleRhythm'])
eq('boot.config.height 来自配置文件', boot && boot.config.height, 240)
eq('boot.seed 带上了旧存档（迁移用）', boot && boot.seed && boot.seed.height, 720)
eq('boot.version', boot && boot.version, '9.9.9')

r = await req('/dsh-pet/model/manifest.json')
ok('模型 manifest 200', r.status === 200)
ok('模型 json 类型正确', (r.headers.get('content-type') || '').includes('application/json'))
ok('模型内容正确', r.body.includes('大肥鱼'))

r = await req('/dsh-pet/vendor/pixi.min.js')
ok('vendor 200', r.status === 200)
ok('vendor 是 js', (r.headers.get('content-type') || '').includes('javascript'))

r = await req('/dsh-pet/model/没有这个文件.json')
eq('缺文件 404', r.status, 404)
r = await req('/dsh-pet/model/../secret.txt')
ok('目录穿越被挡（不是 200）', r.status !== 200, 'status=' + r.status + ' body=' + r.body.slice(0, 40))
r = await req('/dsh-pet/model/%2e%2e%2fsecret.txt')
ok('编码过的穿越也被挡', r.status !== 200, 'status=' + r.status)
r = await req('/dsh-pet/whatever')
eq('未登记路径 404（不是白屏）', r.status, 404)

// 第二个根目录兜底
const assetsSwap = createPetServer({ assetRoots: [path.join(TMP, '空的'), ROOT_B], token: TOKEN, version: 't' })
await assetsSwap.listen(0)
const r2 = await fetch('http://127.0.0.1:' + assetsSwap.state().port + '/dsh-pet/model/only-b.txt', { headers: { Cookie: COOKIE } })
ok('第一个根目录没这个文件时，退回第二个根目录', r2.status === 200, String(r2.status))
await assetsSwap.close()

// 没有 pet.js 的资源根
const noPet = createPetServer({ assetRoots: [ROOT_B], token: TOKEN, version: 't' })
await noPet.listen(0)
const r3 = await fetch('http://127.0.0.1:' + noPet.state().port + '/dsh-pet/pet.js', { headers: { Cookie: COOKIE } })
eq('资源里没有 pet.js 时给 503 + 明确文案（不是白屏）', r3.status, 503)
ok('503 文案点出资源根', (await r3.text()).includes('pet.js'))
await noPet.close()

// ETag
r = await req('/dsh-pet/model/manifest.json')
const tag = r.headers.get('etag')
ok('静态资源带 ETag（29MB 贴图重启后靠 304 省一次下载）', !!tag)
r = await req('/dsh-pet/model/manifest.json', { headers: { 'If-None-Match': tag } })
eq('带 If-None-Match 时回 304', r.status, 304)

// ————————————————————————————————————————————————————————————————
// 3. 信任栅栏
// ————————————————————————————————————————————————————————————————
console.log('\n=== 3. 信任栅栏（Host / Origin / 令牌）===')
r = await req('/dsh-pet/pet.js', { headers: { Cookie: '' } })
eq('没有令牌 → 403', r.status, 403)
r = await req('/dsh-pet/standalone?k=' + 'b'.repeat(32), { headers: { Cookie: '' } })
eq('错误的 ?k= → 403', r.status, 403)
r = await req('/dsh-pet/standalone?k=' + TOKEN, { headers: { Cookie: '' } })
eq('正确的 ?k= → 200（之后靠 cookie）', r.status, 200)
ok('顺带写了 Set-Cookie', /dsh_pet_local=/.test(r.headers.get('set-cookie') || ''))
ok('cookie 是 HttpOnly + SameSite=Strict', /HttpOnly/.test(r.headers.get('set-cookie') || '') && /SameSite=Strict/.test(r.headers.get('set-cookie') || ''))
r = await req('/dsh-pet/pet.js', { headers: { Origin: 'http://evil.example' } })
eq('跨站 Origin → 403', r.status, 403)
r = await req('/dsh-pet/pet.js', { headers: { Origin: base } })
eq('同源 Origin → 200', r.status, 200)
// 错误 Host（DNS rebinding）：fetch 不好改 Host，用原生 http
const badHost = await new Promise((resolve) => {
  const u = new URL(base + '/dsh-pet/pet.js')
  const q = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { Host: 'evil.example', Cookie: COOKIE } }, (res) => {
    let b = ''
    res.on('data', (c) => (b += c))
    res.on('end', () => resolve({ status: res.statusCode, body: b }))
  })
  q.on('error', () => resolve({ status: 0, body: '' }))
  q.end()
})
eq('Host 不是本机 → 403（防 DNS rebinding）', badHost.status, 403)

// ————————————————————————————————————————————————————————————————
// 4. SSE：离线
// ————————————————————————————————————————————————————————————————
console.log('\n=== 4. 事件流（离线）===')
function sseClient(portIn) {
  const frames = []
  let closed = false
  return new Promise((resolve) => {
    const u = new URL('http://127.0.0.1:' + portIn + '/dsh-pet/events')
    const q = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { Cookie: COOKIE, Accept: 'text/event-stream' } }, (res) => {
      res.setEncoding('utf8')
      let buf = ''
      res.on('data', (chunk) => {
        buf += chunk
        let i
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const line = frame.split('\n').find((l) => l.startsWith('data:'))
          if (line) {
            try {
              frames.push(JSON.parse(line.slice(5).trim()))
            } catch (e) {}
          }
        }
      })
      res.on('end', () => (closed = true))
      resolve({ frames, status: res.statusCode, get closed() { return closed }, close: () => q.destroy() })
    })
    q.on('error', () => resolve({ frames, status: 0, get closed() { return closed }, close: () => {} }))
    q.end()
  })
}
const waiters = (ms) => new Promise((r) => setTimeout(r, ms))

const c1 = await sseClient(port)
await waiters(120)
eq('SSE 状态 200', c1.status, 200)
eq('连上先收到 hello', c1.frames[0] && c1.frames[0].t, 'hello')
eq('离线时 hello 的 link = offline', c1.frames[0] && c1.frames[0].link, 'offline')
eq('离线时 status = idle', c1.frames[0] && c1.frames[0].status, 'idle')
await waiters(300)
ok('离线时连接保持不关（页面不会陷入疯狂重连）', c1.closed === false)
eq('state() 统计到 1 个客户端', srv.state().clients, 1)
srv.push({ t: 'hello', status: 'thinking', note: '手动推' })
await waiters(80)
ok('push() 能把本地事件推给页面', c1.frames.some((f) => f.note === '手动推'))

// ————————————————————————————————————————————————————————————————
// 5. 上游桥
// ————————————————————————————————————————————————————————————————
console.log('\n=== 5. 上游桥（连 DSH / 断开 / 转发）===')
const upClients = new Set()
let upGot = []
let upFail = false
const up = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/dsh-pet/events') {
    if (upFail) {
      res.writeHead(500)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ t: 'hello', status: 'working', ts: 1 }) + '\n\n')
    upClients.add(res)
    req.on('close', () => upClients.delete(res))
    return
  }
  if (url.pathname === '/dsh-pet/say') {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      upGot.push({ path: url.pathname, cookie: req.headers.cookie, body: b })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, echoed: b }))
    })
    return
  }
  if (url.pathname === '/dsh-pet/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, status: 'idle', sessionId: 'sess-fake', hasSessionController: true }))
    return
  }
  if (url.pathname === '/dsh-pet/hud') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, balance: { ok: true, totalBalance: 1.23 } }))
    return
  }
  if (url.pathname === '/dsh-pet/500') {
    res.writeHead(500)
    res.end()
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise((r) => up.listen(0, '127.0.0.1', r))
const upPort = up.address().port
const upBase = 'http://127.0.0.1:' + upPort

ok('setUpstream 返回 true', srv.setUpstream(upBase, 'desk-token') === true)
await waiters(200)
eq('state().online = true', srv.state().online, true)
eq('state().upstreamPort 记下了 DSH 端口', srv.state().upstreamPort, upPort)
const linkOn = c1.frames.find((f) => f.t === 'link' && f.online === true)
ok('连上后页面收到 link online 事件', !!linkOn, JSON.stringify(c1.frames.slice(-3)))
eq('link 里带上了 DSH 端口', linkOn && linkOn.port, upPort)

// 上游推一帧 → 原样转发
for (const res of upClients) res.write('data: ' + JSON.stringify({ t: 'text', text: '你好呀' }) + '\n\n')
await waiters(200)
const relayed = c1.frames.find((f) => f.t === 'text')
ok('上游事件原样转发给页面', relayed && relayed.text === '你好呀', JSON.stringify(relayed))
eq('state().framesDown 计数', srv.state().framesDown >= 2, true)
eq('上游 hello 的 status 被记住', srv.state().status, 'working')
// DSH 推的是事件名（turn-start / turn-end），没有 status 字段 —— 这里验外壳会自己翻译
for (const res of upClients) res.write('data: ' + JSON.stringify({ t: 'turn-end', turn: 1 }) + '\n\n')
await waiters(200)
eq('turn-end → 本地状态回 idle', srv.state().status, 'idle')
for (const res of upClients) res.write('data: ' + JSON.stringify({ t: 'tool-call', name: 'bash' }) + '\n\n')
await waiters(200)
eq('tool-call → 本地状态变 working', srv.state().status, 'working')

// 新客户端连上时 hello 带的是真实状态
const c2 = await sseClient(port)
await waiters(150)
eq('新客户端 hello 带当前状态（working）', c2.frames[0] && c2.frames[0].status, 'working')
eq('新客户端 hello 说已连上', c2.frames[0] && c2.frames[0].link, 'online')

// 反向通道
r = await req('/dsh-pet/say', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: '在吗' }),
})
eq('/say 转发后 200', r.status, 200)
ok('/say 的返回来自 DSH（原样透传）', r.body.includes('在吗'), r.body.slice(0, 80))
ok('转发时带上了 DSH 的桌面通行证', upGot.length === 1 && upGot[0].cookie === 'dsh_pet_desk=desk-token', JSON.stringify(upGot[0] && upGot[0].cookie))
ok('转发时正文没被改', upGot[0] && upGot[0].body === JSON.stringify({ text: '在吗' }))

r = await req('/dsh-pet/ping')
let ping = {}
try { ping = JSON.parse(r.body) } catch (e) {}
eq('/ping 只读探针：200', r.status, 200)
eq('/ping 说已连上', ping.online, true)
eq('/ping 说可以接话（canSay）', ping.canSay, true)
eq('/ping 带上了会话 id', ping.sessionId, 'sess-fake')

// dryRun：只校验、不发送 —— 断言「假上游一个字节都没收到」
const gotBefore = upGot.length
r = await req('/dsh-pet/say', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: '在吗', dryRun: true }),
})
let dry = {}
try { dry = JSON.parse(r.body) } catch (e) {}
eq('dryRun 回 200', r.status, 200)
eq('dryRun 说明了没有发送', dry.dryRun, true)
eq('dryRun 报出「本来会发几个字」', dry.wouldSend, 2)
eq('dryRun **没有**打到 DSH（假上游收到 ' + (upGot.length - gotBefore) + ' 条）', upGot.length, gotBefore)

r = await req('/dsh-pet/hud')
ok('/hud 转发后拿到余额', r.status === 200 && r.body.includes('1.23'), r.body.slice(0, 80))

// ⚠️ 回归锁：上游长时间不出声，不许被自己的「连接超时」踢掉（2026-10-17：实测 4 秒就断）
const silent = createPetServer({ assetRoots: [ROOT_A], token: TOKEN, version: 't', log: () => {} })
await silent.listen(0)
const silentUp = http.createServer((req, res) => {
  if (req.url === '/dsh-pet/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ t: 'hello', status: 'idle' }) + '\n\n')
    return // 之后一直不出声
  }
  res.writeHead(404).end()
})
await new Promise((r) => silentUp.listen(0, '127.0.0.1', r))
silent.setUpstream('http://127.0.0.1:' + silentUp.address().port, 'x')
await waiters(5000)
eq('上游 5 秒不出声仍然是连着的（空闲不该被当成超时）', silent.state().online, true)
eq('也没有被记成掉线', silent.state().upstreamLost, 0)
await silent.close()
await new Promise((r) => silentUp.close(r))

// 上游断开
for (const res of upClients) res.destroy()
await waiters(400)
eq('上游断开后 online = false', srv.state().online, false)
eq('断开后 status 回到 idle（不卡在「思考中」）', srv.state().status, 'idle')
ok('页面收到 link offline', c1.frames.some((f) => f.t === 'link' && f.online === false))
r = await req('/dsh-pet/ping')
let pingOff = {}
try { pingOff = JSON.parse(r.body) } catch (e) {}
eq('离线时 /ping 仍是 200（探针本身不该失败）', r.status, 200)
eq('离线时 /ping 说没连上', pingOff.online, false)
eq('离线时 /ping 说不能接话', pingOff.canSay, false)

r = await req('/dsh-pet/say', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
eq('断线后 /say 给 503', r.status, 503)
eq('503 带 error=offline（前端据此说人话）', JSON.parse(r.body).error, 'offline')

// 上游连不上（端口没人）
const dead = createPetServer({ assetRoots: [ROOT_A], token: TOKEN, version: 't', log: () => {} })
await dead.listen(0)
dead.setUpstream('http://127.0.0.1:1', 'x')
await waiters(300)
eq('连不上就保持离线（不抛异常）', dead.state().online, false)
await dead.close()

// 上游 500（DSH 在跑但插件没挂上 → 事件流 404/500）
upFail = true
srv.setUpstream(upBase, 'x')
await waiters(250)
eq('上游事件流回 500 时当作未连接', srv.state().online, false)
upFail = false

// ————————————————————————————————————————————————————————————————
// 6. 收尾
// ————————————————————————————————————————————————————————————————
console.log('\n=== 6. 收尾 ===')
c1.close()
c2.close()
await waiters(80)
const st = await req('/dsh-pet/state')
const body = JSON.parse(st.body)
eq('/state 标明 local', body.local, true)
ok('/state 列出资源根（排障用）', Array.isArray(body.assetRoots) && body.assetRoots.length === 2)
await srv.close()
await new Promise((r) => up.close(r))
ok('close() 之后端口不再响应', await fetch(base + '/dsh-pet/state', { headers: { Cookie: COOKIE } }).then(() => false).catch(() => true))
fs.rmSync(TMP, { recursive: true, force: true })

console.log('\n' + '='.repeat(52))
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项：')
  for (const f of fails) console.log('  · ' + f)
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项')
  process.exit(1)
} else {
  console.log('通过 ' + pass + ' 项，失败 0 项')
}
