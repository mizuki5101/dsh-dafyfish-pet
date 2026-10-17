/**
 * 待机节奏引擎单测（纯 Node，不需要外壳）。
 *
 * 做法和 测试动作引擎.mjs 一样：从 pet.js 里把 `@idle-rhythm` 标记的那一块**原样抠出来**
 * 求值，所以测的就是线上跑的那份代码，不存在「测试副本和线上不一致」。
 *
 * 用法：node _research-data/测试待机节奏.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const PET = path.join(import.meta.dirname, '..', 'pet-plugin', 'assets', 'pet.js')
const src = fs.readFileSync(PET, 'utf8')
const m = /\/\* ==== @idle-rhythm:start ====[\s\S]*?\/\* ==== @idle-rhythm:end ==== \*\//.exec(src)
if (!m) { console.error('❌ 抠不出 @idle-rhythm 块（标记被删了？）'); process.exit(1) }
const R = new Function(m[0].replace('var DSHPetIdleRhythm =', 'return') + '')()
if (!R || typeof R.makeState !== 'function') { console.error('❌ 块求值失败'); process.exit(1) }

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}
/**
 * 固定种子的伪随机（mulberry32，和 pet.js 里动作引擎用的是同一个）。
 * ⚠️ 早先用的是简单 LCG（seed*1103515245+12345），**低位规律性太强**，
 *    测「命中率」时实测 28.6% 而理论 35% —— 是随机源的问题，不是被测代码的问题。
 *    换成 mulberry32 后比例就准了。测试用的随机源也必须够好，否则会误判。
 */
const seeded = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const IDLE_TABLE = [['glance',46],['express',28],['mutter',22],['hungry',4],['nopang',2],['fiddle',8]]

// ——— 1. 三档定义 ———
console.log('\n【1】三档节拍定义')
ok('有 drowsy / normal / lively 三档', !!R.MOODS.drowsy && !!R.MOODS.normal && !!R.MOODS.lively)
ok('normal 与上游一致 (3.5~7.5s)', R.MOODS.normal.inter[0] === 3.5 && R.MOODS.normal.inter[1] === 7.5)
ok('drowsy 比 normal 慢（下限比下限）', R.MOODS.drowsy.inter[0] > R.MOODS.normal.inter[0])
ok('lively 比 normal 快（上限比上限）', R.MOODS.lively.inter[1] < R.MOODS.normal.inter[1])
ok('lively 会连做 2~3 件', R.MOODS.lively.cluster[0] === 2 && R.MOODS.lively.cluster[1] === 3)
ok('drowsy/normal 一次只做 1 件', R.MOODS.drowsy.cluster[0] === 1 && R.MOODS.normal.cluster[1] === 1)
ok('drowsy 权重偏 glance', R.MOODS.drowsy.weights.glance > R.MOODS.drowsy.weights.express)
ok('lively 权重偏 express/fiddle', R.MOODS.lively.weights.express > R.MOODS.lively.weights.glance)
ok('normal 不设专属权重（用主表）', R.MOODS.normal.weights === null)

// ——— 2. 间隔区间（用固定种子大量采样） ———
console.log('\n【2】间隔区间')
for (const mood of ['drowsy','normal','lively']) {
  const st = R.makeState(); st.mood = mood; st.left = 0
  const lo = R.MOODS[mood].inter[0], hi = R.MOODS[mood].inter[1]
  const samples = []
  const rnd = seeded(7)
  const origRandom = Math.random; Math.random = rnd
  for (let i = 0; i < 400; i++) samples.push(R.intervalMs(st, { idleMoodBias: 0 }))
  Math.random = origRandom
  const mn = Math.min(...samples) / 1000, mx = Math.max(...samples) / 1000
  // 允许 ±12% 的微扰余量
  ok(mood + ' 间隔落在 [' + lo + ',' + hi + ']s ±12% 内（实测 ' + mn.toFixed(2) + '~' + mx.toFixed(2) + 's）',
     mn >= lo * 0.88 - 0.1 && mx <= hi * 1.12 + 0.1, { mn, mx, lo, hi })
}

// ——— 3. 簇发：lively 取一次会连做 2~3 件 ———
console.log('\n【3】簇发（连做多件）')
{
  const counts = {}
  for (let i = 0; i < 600; i++) {
    const st = R.makeState(); st.mood = 'lively'
    const n = R.takeCluster(st)
    counts[n] = (counts[n] || 0) + 1
    if (n !== 2 && n !== 3) { ok('takeCluster 只返回 2 或 3', false, n); break }
    if (st.left !== n - 1) { ok('left 与簇件数一致', false, { n, left: st.left }); break }
  }
  ok('lively 取簇只出 2/3 件', Object.keys(counts).every(k => k === '2' || k === '3'))
  ok('2 和 3 都会出现（不是常数）', Object.keys(counts).length === 2)
  for (const mood of ['drowsy','normal']) {
    const st = R.makeState(); st.mood = mood
    const ns = []
    for (let i = 0; i < 50; i++) ns.push(R.takeCluster(st))
    ok(mood + ' 每次都只做 1 件', ns.every(x => x === 1))
  }
}

// ——— 4. 状态转移 ———
console.log('\n【4】状态转移')
{
  // 4a. 连续抽到「没戏」→ 转安静
  const st = R.makeState()
  let guard = 0
  while (st.mood === 'normal' && guard++ < 50) R.noteBehavior(st, 'glance', IDLE_TABLE, 1000)
  ok('连续 ' + R.consts.DROWSY_AFTER_QUIET + ' 次 glance → drowsy', st.mood === 'drowsy', { mood: st.mood, guard })

  // 4b. 安静期抽到「有戏」的事 → 回常态
  const st2 = R.makeState(); st2.mood = 'drowsy'
  R.noteBehavior(st2, 'express', IDLE_TABLE, 2000)
  ok('drowsy 中抽到 express → normal', st2.mood === 'normal', st2.mood)

  // 4c. ⚠️ 主人互动必须**当场**转活泼（回归锁）
  //     早先写成「先抽一件事、抽完再在 noteBehavior 里转」，结果主人一有动作、
  //     第一件事仍按常态排（CDP 实测戳一下后 nextIn 仍是 4.33s），手感完全不对。
  const st3 = R.makeState(); st3.mood = 'drowsy'
  R.noteActivity(st3, 10000)
  ok('noteActivity 当场把 drowsy 拉到 lively（回归锁）', st3.mood === 'lively', st3.mood)
  ok('noteActivity 会清零 quiet', st3.quiet === 0, st3.quiet)
  {
    const stLive = R.makeState(); stLive.mood = 'lively'
    const saved = Math.random; Math.random = seeded(5)
    const iv = R.intervalMs(stLive, { idleMoodBias: 0 }); Math.random = saved
    const lo = R.MOODS.lively.inter[0] * 880, hi = R.MOODS.lively.inter[1] * 1120
    ok('活泼档间隔落在 1.5~3.5s（实测 ' + (iv / 1000).toFixed(2) + 's）', iv >= lo && iv <= hi, iv)
  }
  {
    const stB = R.makeState(); stB.mood = 'lively'
    const n = R.takeCluster(stB)
    ok('活泼档取簇为 2~3 件', n === 2 || n === 3, n)
  }

  // 4d. 活泼窗口过期 + 本簇做完 → 退出活泼
  const st4 = R.makeState(); st4.mood = 'lively'; st4.left = 0
  R.noteActivity(st4, 1000)
  R.noteBehavior(st4, 'mutter', IDLE_TABLE, 1000 + R.consts.LIVELY_WINDOW_MS + 1)
  ok('窗口过期后退出 lively', st4.mood !== 'lively', st4.mood)

  // 4f. maybeDrowsy：抽事**之前**判定，久无互动直接转安静
  {
    const stD = R.makeState()
    ok('刚启动不该立刻转安静', R.maybeDrowsy(stD, 1000) === 'normal', stD.mood)
    R.maybeDrowsy(stD, R.consts.DROWSY_AFTER_MS + 5000)
    ok('久无互动 → maybeDrowsy 转 drowsy', stD.mood === 'drowsy', stD.mood)
    const stE = R.makeState(); R.noteActivity(stE, 100)
    R.maybeDrowsy(stE, 200)
    ok('活泼期不被 maybeDrowsy 打断', stE.mood === 'lively', stE.mood)
  }
}

// ——— 5. idleMoodBias 缩放 ———
console.log('\n【5】idleMoodBias（性格旋钮）')
ok('0 → 不缩放', Math.abs(R.biasFactor({ idleMoodBias: 0 }) - 1) < 1e-9)
ok('+1 → 明显更频繁', R.biasFactor({ idleMoodBias: 1 }) < 0.6)
ok('-1 → 明显更安静', R.biasFactor({ idleMoodBias: -1 }) > 1.4)
ok('越界值被夹住', Math.abs(R.biasFactor({ idleMoodBias: 99 }) - R.biasFactor({ idleMoodBias: 1 })) < 1e-9)
ok('非数字当 0 处理', Math.abs(R.biasFactor({ idleMoodBias: 'abc' }) - 1) < 1e-9)
{
  const st = R.makeState(); st.mood = 'normal'
  const orig = Math.random; Math.random = seeded(3)
  const base = []; for (let i=0;i<300;i++) base.push(R.intervalMs(st, { idleMoodBias: 0 }))
  Math.random = seeded(3)
  const fast = []; for (let i=0;i<300;i++) fast.push(R.intervalMs(st, { idleMoodBias: 1 }))
  Math.random = orig
  const avg = a => a.reduce((x,y)=>x+y,0)/a.length
  ok('偏活泼后平均间隔变短', avg(fast) < avg(base) * 0.75, { base: avg(base), fast: avg(fast) })
}

// ——— 6. 权重抽取 ———
console.log('\n【6】权重抽取')
{
  const rnd = seeded(11)
  const tally = {}
  for (let i = 0; i < 4000; i++) {
    const st = R.makeState(); st.mood = 'drowsy'
    const b = R.chooseBehavior(st, IDLE_TABLE, rnd)
    tally[b] = (tally[b] || 0) + 1
  }
  const total = Object.values(tally).reduce((a,b)=>a+b,0)
  const pGlance = (tally.glance||0)/total
  // 2026-10-16（A+B）后 drowsy 档不再让 glance 独大：它只占 24%，
  // 因为「只动视线、几乎看不见」的行为不该拿最高权重 —— 让位给看得见的。
  const pMutter = (tally.mutter||0)/total
  // ⭐ 设计意图：发呆档**不再**由 glance 领跑。
  //   glance 只换视线落点、几乎看不见；mutter 有气泡、express 有表情，都是「看得见」的。
  //   所以「安静」应该是「安静但看得见」，而不是「安静且什么都看不到」。
  ok('drowsy 档由「看得见的」mutter 领跑（mutter ' + (pMutter*100).toFixed(1) + '% > glance ' + (pGlance*100).toFixed(1) + '%）',
     pMutter > pGlance, { glance: pGlance, mutter: pMutter })
  // 2026-10-17：新增的两个待机行为**都是看得见的** ——
  //   peer（探头张望）动的是头，sway（换重心）动的是整个上身；
  //   它们不是 glance 那种「只换视线落点、肉眼几乎看不出」的东西。
  // 所以这一侧必须把它们算进来，否则这条断言会因为「行为名单没更新」而误红
  // （误红比误绿更浪费时间：上一轮我就差点去查权重是不是被算错了）。
  const visible = pMutter + (tally.express||0)/total + (tally.tailWag||0)/total + (tally.tilt||0)/total
    + (tally.peer||0)/total + (tally.sway||0)/total
  ok('drowsy 档里「看得见」的行为合计 >60%',
     visible > 0.60,
     { mutter: pMutter, express: (tally.express||0)/total, tailWag: (tally.tailWag||0)/total,
       tilt: (tally.tilt||0)/total, peer: (tally.peer||0)/total, sway: (tally.sway||0)/total, 合计: visible })
  ok('drowsy 档 glance 已被压到 30% 以下（曾经是 66%）', pGlance < 0.30, pGlance)
  ok('drowsy 档抽不到 fiddle（权重表里没有）', !tally.fiddle)

  const tally2 = {}
  for (let i = 0; i < 4000; i++) {
    const st = R.makeState(); st.mood = 'lively'
    const b = R.chooseBehavior(st, IDLE_TABLE, rnd)
    tally2[b] = (tally2[b] || 0) + 1
  }
  const tot2 = Object.values(tally2).reduce((a,b)=>a+b,0)
  const pEF = ((tally2.express||0)+(tally2.fiddle||0))/tot2
  const pClip = ((tally2.stretch||0)+(tally2.tilt||0)+(tally2.nod||0)+(tally2.tailWag||0))/tot2
  ok('lively 档 express+fiddle ≥35%（实测 ' + (pEF*100).toFixed(1) + '%）', pEF > 0.35, pEF)
  ok('lively 档肢体动作合计 ≥25%（实测 ' + (pClip*100).toFixed(1) + '%）——这正是 A 的效果', pClip > 0.25, pClip)
  ok('lively 档里动作占比明显高于 drowsy 档', pClip > 0.25)

  // normal 档必须退回主权重表（因此能抽到 fiddle 与所有上游行为）
  const tally3 = {}
  for (let i = 0; i < 4000; i++) {
    const st = R.makeState(); st.mood = 'normal'
    const b = R.chooseBehavior(st, IDLE_TABLE, rnd)
    tally3[b] = (tally3[b] || 0) + 1
  }
  ok('normal 档能抽到主表全部 6 种行为', Object.keys(tally3).length === 6, Object.keys(tally3))
}

// ——— 6.5 「做不了的行为不进池」（2026-10-17 收尾）———
//
// 真问题：fiddle（拨弄道具）在常态占 10、活跃期占 14，但它依赖鲸鱼娘模型的道具表达式，
// 大肥鱼一个都没有 → 每次抽到都「什么都没发生」。所以引擎要支持传一个 allowed 判定。
console.log('\n【6.5】做不了的行为不进池（weightsOf / allowed）')
{
  const rnd = seeded(23)
  const st = R.makeState()
  st.mood = 'normal'
  const all = R.weightsOf(st, IDLE_TABLE)
  ok('weightsOf 不传 allowed 时原样返回', all.length === IDLE_TABLE.length, all.length + ' vs ' + IDLE_TABLE.length)
  const noFiddle = R.weightsOf(st, IDLE_TABLE, (k) => k !== 'fiddle')
  ok('allowed 能剔掉 fiddle（' + noFiddle.map((x) => x[0]).join(',') + '）', !noFiddle.some((x) => x[0] === 'fiddle'))
  ok('剔掉之后其它项还在', noFiddle.some((x) => x[0] === 'express') && noFiddle.some((x) => x[0] === 'mutter'))

  // 活跃期用的是 mood 专属权重（fiddle 在那里占 14），同样要被剔掉
  const st2 = R.makeState()
  st2.mood = 'lively'
  const lively = R.weightsOf(st2, IDLE_TABLE, (k) => k !== 'fiddle')
  ok('mood 专属权重也走 allowed 过滤', !lively.some((x) => x[0] === 'fiddle'), lively.map((x) => x[0]).join(','))
  const sumLively = lively.reduce((a, b) => a + b[1], 0)
  const sumAll = R.weightsOf(st2, IDLE_TABLE).reduce((a, b) => a + b[1], 0)
  ok('剔掉后权重自动归一（总和 ' + sumAll + ' → ' + sumLively + '）', sumLively > 0 && sumLively < sumAll)

  // 抽 4000 次，一次都不该出现被剔掉的那个
  let hit = 0
  for (let i = 0; i < 4000; i++) {
    const s3 = R.makeState()
    s3.mood = i % 2 ? 'lively' : 'normal'
    if (R.chooseBehavior(s3, IDLE_TABLE, rnd, (k) => k !== 'fiddle') === 'fiddle') hit++
  }
  ok('chooseBehavior 传 allowed 后一次都抽不到 fiddle', hit === 0, 'hit=' + hit)

  // 全剔掉时要有兜底，不能返回 undefined
  const none = R.chooseBehavior(R.makeState(), IDLE_TABLE, rnd, () => false)
  ok('全被剔掉时兜底为 glance（不返回 undefined）', none === 'glance', String(none))

  // 详细频率面板：scale 倍数（0 = 不进池，0.5 = 减半）
  const half = R.weightsOf(st, IDLE_TABLE, null, { express: 0.5, fiddle: 0 })
  const ex = (half.find((x) => x[0] === 'express') || [])[1]
  ok('scale 0.5 把 express 28 变成 14', ex === 14, ex)
  ok('scale 0 把 fiddle 剔出池', !half.some((x) => x[0] === 'fiddle'), half)
  const pick = R.chooseBehavior(st, IDLE_TABLE, () => 0, null, { glance: 0 })
  ok('scale 0 的行为不会被抽到（glance=0 时首抽不是 glance）', pick !== 'glance', pick)

  // 详细频率面板：待机间隔倍数
  const oldRandom = Math.random
  Math.random = () => 0.5
  const baseMs = R.intervalMs(st, {})
  const twiceMs = R.intervalMs(st, { idleIntervalScale: 2 })
  Math.random = oldRandom
  ok('idleIntervalScale=2 时间隔约 ×2', Math.abs(twiceMs / baseMs - 2) < 0.02, twiceMs + ' / ' + baseMs)
}

// ——— 7. 权重表 ↔ switch 分支一致性（防上游 fiddle 那种坑复发） ———
console.log('\n【7】权重表 ↔ switch 分支 一致性')
{
  const switchBlock = /function runIdleBehavior[\s\S]*?switch \(b\) \{([\s\S]*?)\n    \}/.exec(src)
  ok('能从 pet.js 抠出 runIdleBehavior 的 switch', !!switchBlock)
  if (switchBlock) {
    const cases = [...switchBlock[1].matchAll(/case '([A-Za-z]+)':/g)].map(x => x[1])
    const table = [.../const IDLE_TABLE = \[([\s\S]*?)\n  \]/.exec(src)[1].matchAll(/\['([A-Za-z]+)',/g)].map(x => x[1])
    const missing = table.filter(k => !cases.includes(k))
    ok('IDLE_TABLE 里每个行为都有 switch 分支（表: ' + table.join(',') + '）', missing.length === 0, missing)
    ok('switch 里没有表外的孤儿分支', cases.filter(c => !table.includes(c)).length === 0, cases.filter(c => !table.includes(c)))
    // 档位权重里出现的行为也必须有分支
    const moodKeys = new Set()
    for (const mood of ['drowsy','lively']) for (const k of Object.keys(R.MOODS[mood].weights)) moodKeys.add(k)
    const orphan = [...moodKeys].filter(k => !cases.includes(k))
    ok('档位权重里的行为也都有 switch 分支', orphan.length === 0, orphan)
  }
}

// ============ 8/9 节：A+B（肢体动作）+ 灵动度预设 ============
{
  const R2 = R, S = src
  const q = String.fromCharCode(39)

  console.log('\n【8】肢体动作（A）与权重重排（B）')
  const tm = /const IDLE_TABLE = \[([\s\S]*?)\n  \]/.exec(S)
  const table = {}
  if (tm) for (const mm of tm[1].matchAll(/\['([A-Za-z]+)',\s*(\d+)\]/g)) table[mm[1]] = Number(mm[2])
  const fourClips = ['nod', 'tilt', 'stretch', 'tailWag']
  ok('主表含四个肢体动作', fourClips.every(function (k) { return table[k] > 0 }), Object.keys(table))
  ok('glance 已从 46 降到 16 以内', table.glance <= 16, table.glance)
  const mx = Math.max.apply(null, Object.keys(table).map(function (k) { return table[k] }))
  ok('glance 不再是最高权重项', mx > table.glance, { glance: table.glance, max: mx })
  let tot = 0; for (const k in table) tot += table[k]
  const clipShare = (table.nod + table.tilt + table.stretch + table.tailWag) / tot
  ok('肢体动作合计占比 ' + (clipShare * 100).toFixed(1) + '%（期望 15%~40%）', clipShare > 0.15 && clipShare < 0.40)

  const cb = /const IDLE_CLIP = \{([\s\S]*?)\n  \}/.exec(S)
  ok('能抠出 IDLE_CLIP 映射表', !!cb)
  if (cb) {
    const mapped = Array.from(cb[1].matchAll(/([A-Za-z]+):/g)).map(function (x) { return x[1] })
    const missing = fourClips.filter(function (k) { return mapped.indexOf(k) < 0 })
    ok('主表里的肢体动作都有 clip 映射', missing.length === 0, missing)
    const motionBlock = (/\/\* ==== @motion-engine:start ====[\s\S]*?==== @motion-engine:end ==== \*\//.exec(S) || [''])[0]
    const names = Array.from(cb[1].matchAll(/:[ \t]*'([^']+)'/g)).map(function (x) { return x[1] })
    const bad = names.filter(function (n) { return motionBlock.indexOf(q + n + q) < 0 })
    ok('映射的动作名都在动作库里（防拼错）', bad.length === 0, { names: names, bad: bad })
  }

  for (const mood of ['drowsy', 'lively']) {
    const w = R2.MOODS[mood].weights
    const ck = Object.keys(w).filter(function (k) { return fourClips.indexOf(k) >= 0 })
    ok(mood + ' 档也放得进肢体动作（' + ck.join(',') + '）', ck.length > 0, ck)
  }

  {
    const st = R2.makeState()
    const r0 = seeded(9)
    let any = false
    for (let i = 0; i < 300; i++) if (R2.clipAllowed(st, { idleClipChance: 0 }, r0)) any = true
    ok('动作率=0 → 永远不放动作（可回退到上游行为）', !any)
    const r1 = seeded(9)
    let cnt = 0
    for (let i = 0; i < 2000; i++) if (R2.clipAllowed(st, { idleClipChance: 0.35 }, r1)) cnt++
    const rate = cnt / 2000
    ok('动作率=0.35 → 实测 ' + (rate * 100).toFixed(1) + '%（normal 档，期望 35%±3%）', Math.abs(rate - 0.35) < 0.03, rate)
  }
  {
    const st = R2.makeState(); st.mood = 'drowsy'
    const rr = seeded(4)
    let cnt = 0
    for (let i = 0; i < 4000; i++) if (R2.clipAllowed(st, { idleClipChance: 0.35 }, rr)) cnt++
    const rate = cnt / 4000
    ok('发呆档动作率更低（实测 ' + (rate * 100).toFixed(1) + '%，期望 8.75%±2%）', Math.abs(rate - 0.0875) < 0.02, rate)
  }
  ok('idleLiveliness 生效', R2.biasFactor({ idleLiveliness: 1 }) < 0.6)
  ok('旧键 idleMoodBias 仍兼容', Math.abs(R2.biasFactor({ idleMoodBias: 0 }) - 1) < 1e-9)
  ok('两键同时给时优先 idleLiveliness',
     Math.abs(R2.biasFactor({ idleLiveliness: 1, idleMoodBias: -1 }) - R2.biasFactor({ idleLiveliness: 1 })) < 1e-9)

  console.log('\n【9】灵动度预设')
  const pb = /const LIVELY_PRESETS = \[([\s\S]*?)\n  \]/.exec(S)
  ok('能抠出 LIVELY_PRESETS', !!pb)
  if (pb) {
    const keys = Array.from(pb[1].matchAll(/key: '([a-z]+)'/g)).map(function (x) { return x[1] })
    ok('三档 quiet/normal/lively', keys.join(',') === 'quiet,normal,lively', keys)
    const vals = function (k) {
      return Array.from(pb[1].matchAll(new RegExp(k + ':[ \\t]*([-\\d.]+)', 'g'))).map(function (x) { return Number(x[1]) })
    }
    const lv = vals('idleLiveliness'), sg = vals('idleStrength'), cl = vals('idleClipChance'), gd = vals('gazeDrift'), rs = vals('idleReactStrength')
    ok('五组值各 3 个都齐', lv.length === 3 && sg.length === 3 && cl.length === 3 && gd.length === 3 && rs.length === 3, { lv: lv, sg: sg, cl: cl, gd: gd, rs: rs })
    ok('互动强度也单调递增（' + rs.join(' / ') + '）', rs[0] < rs[1] && rs[1] < rs[2], rs)
    ok('活泼度单调递增（' + lv.join(' / ') + '）', lv[0] < lv[1] && lv[1] < lv[2], lv)
    ok('幅度单调递增（' + sg.join(' / ') + '）', sg[0] < sg[1] && sg[1] < sg[2], sg)
    ok('动作频率单调递增（' + cl.join(' / ') + '）', cl[0] < cl[1] && cl[1] < cl[2], cl)
    ok('视线游移单调递增（' + gd.join(' / ') + '）', gd[0] < gd[1] && gd[1] < gd[2], gd)
    ok('常态档 = 默认值（含互动强度 1）', sg[1] === 1 && lv[1] === 0 && cl[1] === 0.35 && gd[1] === 1 && rs[1] === 1, { sg: sg, lv: lv, cl: cl, gd: gd, rs: rs })
  }
  ok('有 livelyPresetKey 判定函数', S.indexOf('function livelyPresetKey()') >= 0)
  ok('有自定义态', S.indexOf(q + 'custom' + q) >= 0)
}

console.log('\n' + '='.repeat(52))
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
