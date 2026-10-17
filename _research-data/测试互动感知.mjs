/**
 * 互动感知器 + 睡眠状态机单测（纯 Node，不需要外壳）。
 *
 * 做法同 测试待机节奏.mjs：从 pet.js 抠 `@idle-sensors` / `@sleep-state` 两块原样求值，
 * 所以测的就是线上跑的那份代码。
 *
 * 2026-10-17 起这一套还覆盖睡眠：5 秒悬停唤醒（含「入睡时鼠标已在身上不算」）、
 * 身边甩动唤醒、换嘴节奏、梦话节奏。
 *
 * 为什么感知器必须做成纯函数才好测：真实的「鼠标凑过来 1.2 秒」在浏览器里
 * 很难精确复现（还得等 20 秒冷却），而纯函数只要喂一串坐标 + 时间戳就行。
 *
 * 用法：node _research-data/测试互动感知.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const PET = path.join(import.meta.dirname, '..', 'pet-plugin', 'assets', 'pet.js')
const src = fs.readFileSync(PET, 'utf8')
const m = /\/\* ==== @idle-sensors:start ====[\s\S]*?\/\* ==== @idle-sensors:end ==== \*\//.exec(src)
if (!m) { console.error('❌ 抠不出 @idle-sensors 块'); process.exit(1) }
const S = new Function(m[0].replace('var DSHPetIdleSensors =', 'return') + '')()
if (!S || typeof S.frame !== 'function') { console.error('❌ 块求值失败'); process.exit(1) }

// 睡眠状态机（@sleep-state）：和感知器同一套「抠出来原样跑」的做法
const sm = /\/\* ==== @sleep-state:start ====[\s\S]*?\/\* ==== @sleep-state:end ==== \*\//.exec(src)
if (!sm) { console.error('❌ 抠不出 @sleep-state 块'); process.exit(1) }
const SL = new Function(sm[0].replace('var DSHPetSleep =', 'return') + '')()
if (!SL || typeof SL.frame !== 'function') { console.error('❌ @sleep-state 求值失败'); process.exit(1) }

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

/**
 * 喂一段「光标停在近处」的轨迹，返回整段里各事件被触发的次数。
 * 用固定的 40ms 步进，模拟真实的 gazeTick 心跳。
 */
function hoverRun(ms, opts) {
  opts = opts || {}
  const st = S.makeState()
  const cfg = Object.assign({ idleReact: true, idleReactStrength: 1 }, opts.cfg || {})
  const counts = { hover: 0, stare: 0, swoosh: 0, typing: 0, typingStop: 0 }
  const first = {}
  for (let t = 0; t <= ms; t += 40) {
    const near = opts.near === undefined ? true : opts.near(t)
    const ev = S.frame(st, { x: 100, y: 100, near: near, inside: near, overUi: opts.overUi === true, vx: 0, vy: 0 }, cfg, t)
    for (const k in counts) if (ev[k]) { counts[k]++; if (first[k] === undefined) first[k] = t }
  }
  return { counts, first, st }
}

console.log('\n【1】阈值与时机')
{
  // 注意边界：循环步进 40ms、含 t=1200 那一点，而判定是 held >= hoverMs，
  // 所以「刚好 1200ms」是**会**触发的。测「不到阈值」必须停在 1000ms。
  const rBelow = hoverRun(1000)
  ok('停留 1.0s（<阈值）不触发 hover', rBelow.counts.hover === 0, rBelow.counts)
  const r = hoverRun(6000)
  ok('停留 ≥1.2s 触发一次 hover（首次在 ' + r.first.hover + 'ms）', r.counts.hover === 1)
  ok('首次 hover 不早于 1200ms', r.first.hover >= 1200, r.first.hover)
  ok('停留 6s 只触发 1 次 hover（冷却 20s 生效）', r.counts.hover === 1, r.counts.hover)
  const r2 = hoverRun(9000)
  ok('停留 9s 触发 1 次 stare（阈值 4.5s，首次 ' + r2.first.stare + 'ms）', r2.counts.stare === 1)
  ok('首次 stare 不早于 4500ms', r2.first.stare >= 4500, r2.first.stare)
  ok('hover 与 stare 都只各触发一次', r2.counts.hover === 1 && r2.counts.stare === 1, r2.counts)
}

console.log('\n【2】冷却与去重')
{
  // 凑近→离开→再凑近：冷却期内不该再触发
  const st = S.makeState()
  const cfg = { idleReact: true }
  let h = 0
  for (let t = 0; t <= 16000; t += 40) {
    // 0~2s 靠近；2~10s 离开；10~16s 再靠近
    const near = (t <= 2000) || (t >= 10000)
    const ev = S.frame(st, { x: 100, y: 100, near: near, inside: near, vx: 0, vy: 0 }, cfg, t)
    if (ev.hover) h++
  }
  ok('20 秒冷却内「离开再回来」不会重复触发（实测 ' + h + ' 次）', h === 1, h)
  // 冷却过后应该能再触发
  let h2 = 0
  for (let t = 20000; t <= 46000; t += 40) {
    const ev = S.frame(st, { x: 100, y: 100, near: true, inside: true, vx: 0, vy: 0 }, cfg, t)
    if (ev.hover) h2++
  }
  ok('冷却过后能再次触发（实测 ' + h2 + ' 次）', h2 >= 1, h2)
  ok('但 26 秒内不会超过 2 次', h2 <= 2, h2)
}

console.log('\n【3】stare 每次停留只报一次')
{
  const st = S.makeState()
  let s1 = 0
  for (let t = 0; t <= 12000; t += 40) {
    const ev = S.frame(st, { x: 1, y: 1, near: true, inside: true, vx: 0, vy: 0 }, {}, t)
    if (ev.stare) s1++
  }
  ok('连续盯 12 秒只报 1 次 stare', s1 === 1, s1)
  // 离开一会儿再回来盯（超过 45s 冷却）
  let s2 = 0
  for (let t = 13000; t <= 14000; t += 40) S.frame(st, { x: 1, y: 1, near: false, vx: 0, vy: 0 }, {}, t)
  for (let t = 14000 + 45000; t <= 14000 + 45000 + 6000; t += 40) {
    const ev = S.frame(st, { x: 1, y: 1, near: true, inside: true, vx: 0, vy: 0 }, {}, t)
    if (ev.stare) s2++
  }
  ok('冷却 45s 后重新盯能再报（实测 ' + s2 + ' 次）', s2 === 1, s2)
}

console.log('\n【4】甩鼠标（swoosh）')
{
  const st = S.makeState()
  let n = 0
  // 持续高速（2500px/s）跑 1 秒
  for (let t = 0; t <= 1000; t += 40) {
    const ev = S.frame(st, { x: 0, y: 0, near: false, vx: 2500, vy: 0 }, {}, t)
    if (ev.swoosh) n++
  }
  ok('高速掠过会触发 swoosh', n >= 1, n)
  ok('6 秒冷却内最多 1 次（实测 ' + n + '）', n === 1, n)
  // 慢速不该触发
  const st2 = S.makeState()
  let n2 = 0
  for (let t = 0; t <= 3000; t += 40) {
    const ev = S.frame(st2, { x: 0, y: 0, near: false, vx: 300, vy: 0 }, {}, t)
    if (ev.swoosh) n2++
  }
  ok('慢速移动不触发 swoosh', n2 === 0, n2)
  // 在她自己的面板上甩不该触发
  const st3 = S.makeState()
  let n3 = 0
  for (let t = 0; t <= 1000; t += 40) {
    const ev = S.frame(st3, { x: 0, y: 0, near: false, overUi: true, vx: 2500, vy: 0 }, {}, t)
    if (ev.swoosh) n3++
  }
  ok('在她自己的面板上甩鼠标不触发', n3 === 0, n3)
}

console.log('\n【5】打字 / 停打字')
{
  const st = S.makeState()
  S.key(st, 1000)
  let stop = 0
  for (let t = 1040; t <= 2500; t += 40) {
    const ev = S.frame(st, { x: 0, y: 0, vx: 0, vy: 0 }, {}, t)
    if (ev.typingStop) stop++
  }
  ok('停打字不足 3 秒不触发 typingStop', stop === 0, stop)
  for (let t = 2540; t <= 5000; t += 40) {
    const ev = S.frame(st, { x: 0, y: 0, vx: 0, vy: 0 }, {}, t)
    if (ev.typingStop) stop++
  }
  ok('停打字 ≥3 秒触发一次 typingStop', stop === 1, stop)
  ok('typing 状态已被清掉', st.typing === false)
}

console.log('\n【6】位置判定（外扩环带 / 面板 / 掩码）')
{
  const st = S.makeState()
  let nearSeen = 0
  for (let t = 0; t <= 2000; t += 40) if (S.frame(st, { x: 0, y: 0, near: true, vx: 0, vy: 0 }, {}, t).near) nearSeen++
  ok('near=true 时 frame 报告 near', nearSeen > 0, nearSeen)
  const st2 = S.makeState()
  let overUiNear = 0
  for (let t = 0; t <= 3000; t += 40) if (S.frame(st2, { x: 0, y: 0, near: true, overUi: true, vx: 0, vy: 0 }, {}, t).near) overUiNear++
  ok('在她面板上（overUi）不算「在看她」', overUiNear === 0, overUiNear)
}

console.log('\n【7】配置覆写与可关闭')
{
  const r = hoverRun(3000, { cfg: { sensorHoverMs: 500 } })
  ok('sensorHoverMs 可覆写（500ms 就该触发）', r.counts.hover >= 1, r.counts)
  ok('覆写后首次触发不早于 500ms', r.first.hover >= 500, r.first.hover)
  const r2 = hoverRun(8000, { cfg: { sensorStareMs: 2000 } })
  ok('sensorStareMs 可覆写（2s 就该 stare）', r2.counts.stare === 1 && r2.first.stare >= 2000, r2.first)
  const r3 = hoverRun(6000, { cfg: { sensorSwooshSpeed: 99999 } })
  ok('把速度阈值调到极高 → 甩鼠标不再触发', r3.counts.swoosh === 0)
}

console.log('\n【8】活泼节流（noteActivity 不能被刷爆）')
{
  const st = S.makeState()
  let n = 0
  for (let t = 0; t <= 30000; t += 40) if (S.livelyTick(st, t)) n++
  ok('30 秒内最多 7 次（5s 节流，实测 ' + n + '）', n <= 7, n)
  ok('至少 5 次（不是被压得太死）', n >= 5, n)
  // ⚠️ 回归锁：页面刚起来时 now 很小（甚至 0），若 livelyTick 用初始 lastLivelyAt=0 做差，
  //    会算出 0-0<5000 而把主人的**第一个**动作吃掉。（同 @idle-rhythm 里 drowsy 的坑。）
  ok('时刻 0 的第一次调用也要放行（回归锁）', S.livelyTick(S.makeState(), 0) === true)
  {
    const st0 = S.makeState()
    const first = S.livelyTick(st0, 0)   // 第一次：放行
    const second = S.livelyTick(st0, 100) // 紧接着：必须被节流
    ok('第一次放行、紧接着的第二次被节流', first === true && second === false, { first: first, second: second })
  }
}

console.log('\n【9】睡眠状态机（唤醒手势 / 换嘴 / 梦话）')
{
  // 随机数固定成 0：间隔一律取最小值，时间点可预期
  const r0 = () => 0
  const st = SL.makeState()
  SL.begin(st, 1000, false, {}, r0)
  ok('begin 之后 asleep', st.asleep === true)
  ok('入睡时光标不在身上 → 5 秒唤醒已武装', st.hoverArmed === true)

  let woke = null
  for (let t = 1040; t <= 7000; t += 40) {
    const o = SL.frame(st, { inside: true, near: true, vx: 0, vy: 0 }, {}, t, r0)
    if (o.wake) { woke = { at: t, why: o.wake }; break }
  }
  ok('停在身上 5 秒会叫醒（hover）', !!woke && woke.why === 'hover', woke)
  ok('不早于 5 秒（' + (woke ? woke.at - 1000 : '-') + 'ms）', !!woke && woke.at - 1000 >= 5000, woke)
}
{
  // 入睡时鼠标已经在身上 → 不算；必须先移出去
  const st = SL.makeState()
  SL.begin(st, 1000, true, {}, () => 0)
  let woke = null
  for (let t = 1040; t <= 21000; t += 40) {
    const o = SL.frame(st, { inside: true, near: true, vx: 0, vy: 0 }, {}, t, () => 0)
    if (o.wake) { woke = { at: t, why: o.wake }; break }
  }
  ok('入睡时鼠标已在身上 → 一直不动不会叫醒', woke === null, woke)
  SL.frame(st, { inside: false, near: false, vx: 0, vy: 0 }, {}, 21040, () => 0)
  let woke2 = null
  for (let t = 21080; t <= 27000; t += 40) {
    const o = SL.frame(st, { inside: true, near: true, vx: 0, vy: 0 }, {}, t, () => 0)
    if (o.wake) { woke2 = { at: t, why: o.wake }; break }
  }
  ok('移出去再放回来 → 5 秒后叫醒', !!woke2 && woke2.why === 'hover', woke2)
}
{
  // 悬停中途离开 → 重新计时
  const st = SL.makeState()
  SL.begin(st, 0, false, {}, () => 0)
  SL.frame(st, { inside: true, near: true }, {}, 40, () => 0)
  SL.frame(st, { inside: true, near: true }, {}, 4000, () => 0)
  SL.frame(st, { inside: false, near: false }, {}, 4040, () => 0)
  SL.frame(st, { inside: true, near: true }, {}, 4080, () => 0)
  let woke = null
  for (let t = 4120; t <= 9800; t += 40) {
    const o = SL.frame(st, { inside: true, near: true }, {}, t, () => 0)
    if (o.wake) { woke = t; break }
  }
  ok('离开过就重新计时（不早于再次进入后 5 秒）', woke !== null && woke - 4080 >= 5000, { woke: woke, after: woke && woke - 4080 })
}
{
  // 甩动：附近 + 够快；远处 / 慢速都不算
  const nearFast = (() => {
    const st = SL.makeState(); SL.begin(st, 0, false, {}, () => 0)
    return SL.frame(st, { inside: false, near: true, vx: 5000, vy: 0 }, 40, () => 0)
  })()
  ok('身边快速甩动会叫醒（swish）', nearFast.wake === 'swish', nearFast)
  const far = (() => {
    const st = SL.makeState(); SL.begin(st, 0, false, {}, () => 0)
    return SL.frame(st, { inside: false, near: false, vx: 5000, vy: 0 }, 40, () => 0)
  })()
  ok('离她很远的高速移动不算', far.wake === null, far)
  const slow = (() => {
    const st = SL.makeState(); SL.begin(st, 0, false, {}, () => 0)
    return SL.frame(st, { inside: false, near: true, vx: 600, vy: 0 }, 40, () => 0)
  })()
  ok('慢慢挪（600px/s）不算', slow.wake === null, slow)
}
{
  // 换嘴：10~30 秒一张，按 1→2→0 循环；梦话 30~50 秒一句
  const st = SL.makeState()
  SL.begin(st, 0, false, {}, () => 0)
  const faces = []
  const dreams = []
  for (let t = 40; t <= 70000; t += 40) {
    const o = SL.frame(st, { inside: false, near: false, vx: 0, vy: 0 }, {}, t, () => 0)
    if (o.face != null) faces.push({ at: t, i: o.face })
    if (o.dream) dreams.push(t)
  }
  ok('第一次换嘴在 10 秒（配置下限）', faces[0] && faces[0].at === 10000, faces[0])
  ok('换嘴顺序 1→2→0 循环', faces.slice(0, 3).map((x) => x.i).join(',') === '1,2,0', faces.slice(0, 3))
  ok('换嘴间隔不短于 10 秒', faces.every((x, i) => i === 0 || x.at - faces[i - 1].at >= 10000), faces)
  ok('第一句梦话在 30 秒（配置下限）', dreams[0] === 30000, dreams)
  ok('梦话间隔不短于 30 秒', dreams.every((x, i) => i === 0 || x - dreams[i - 1] >= 30000), dreams)
}
{
  // 配置覆写：节奏都能被 CFG 的 sleepXxx 改
  const st = SL.makeState()
  SL.begin(st, 0, false, { sleepFaceMinMs: 1000, sleepFaceMaxMs: 1000, sleepDreamMinMs: 2000, sleepDreamMaxMs: 2000 }, () => 0.5)
  const o1 = SL.frame(st, { inside: false, near: false }, {}, 1040, () => 0.5)
  ok('sleepFaceMinMs/MaxMs 可覆写（1 秒就换）', o1.face != null, o1)
  const o2 = SL.frame(st, { inside: false, near: false }, {}, 2040, () => 0.5)
  ok('sleepDreamMinMs/MaxMs 可覆写（2 秒就说梦话）', o2.dream === true, o2)
  const st2 = SL.makeState()
  SL.begin(st2, 0, false, { sleepHoverMs: 1000 }, () => 0)
  let w = null
  for (let t = 40; t <= 2500; t += 40) {
    const o = SL.frame(st2, { inside: true, near: true }, { sleepHoverMs: 1000 }, t, () => 0)
    if (o.wake) { w = t; break }
  }
  ok('sleepHoverMs 可覆写（1 秒就叫醒）', w !== null && w >= 1000, w)
}
{
  // 没睡着 / 收尾
  const st = SL.makeState()
  const o = SL.frame(st, { inside: true, near: true, vx: 9000, vy: 0 }, 100, () => 0)
  ok('没入睡时不出任何事件', !o.wake && o.face == null && o.dream === false, o)
  SL.end(st)
  ok('end 之后 asleep=false、悬停解除武装', st.asleep === false && st.hoverArmed === false, st)
  const snap = SL.snapshot(st, 1000)
  ok('snapshot 可读（醒着时不报倒计时）', !!snap && snap.asleep === false && snap.faceInMs === 0, snap)
}

console.log('\n' + '='.repeat(52))
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
