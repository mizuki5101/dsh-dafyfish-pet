/**
 * 动作引擎单测。
 *
 * 为什么要有：这台机器的透明窗口截不了图（交接文档坑 #10），
 * 所以「动作对不对」不能靠看。引擎是纯函数（时间 → 参数偏移量），
 * 直接从 pet.js 里把标记块抠出来在 Node 里跑，就能验证：
 *   · 永远不会把参数推出合法区间
 *   · 待机层真的在动、而且只动那 4 个根参数
 *   · clip 能正常播完、关键帧插值正确
 * 视觉观感仍然要人眼确认（这一步替代不了）。
 */
import fs from 'node:fs';
import path from 'node:path';

// 用相对定位，别写死某台机器的路径（公开仓库里那样会让人 clone 下来直接跑不了）
const MODEL_DIR = path.join(import.meta.dirname, '..', 'pet-plugin', 'assets', 'model');
const PET = path.join(MODEL_DIR, '..', 'pet.js');
const RIG = path.join(MODEL_DIR, 'rig-params.json');

// —— 从 pet.js 抠出引擎 ——
const src = fs.readFileSync(PET, 'utf8');
const a = src.indexOf('/* ==== @motion-engine:start ====')
const b = src.indexOf('/* ==== @motion-engine:end ====')
if (a < 0 || b < 0) throw new Error('找不到 @motion-engine 标记块')
const block = src.slice(src.lastIndexOf('\n', a) + 1, src.lastIndexOf('\n', b))
const M = new Function(block + '\n return DSHPetMotion;')()

const rig = JSON.parse(fs.readFileSync(RIG, 'utf8'))
M.setRanges(rig.ranges)

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg) } else { fail++; console.log('  ✗ ' + msg) } }

const bounds = (id) => {
  const r = rig.ranges[id]
  if (!r) return null
  return [r[0] - r[2], r[1] - r[2]]   // 允许的偏移区间
}

console.log('=== 1. 缓动函数 ===')
for (const n of ['linear', 'in', 'out', 'inout', 'smooth']) {
  ok(Math.abs(M.ease(n, 0)) < 1e-9 && Math.abs(M.ease(n, 1) - 1) < 1e-9, n + ' 两端点为 0 / 1')
}
ok(Math.abs(M.ease('inout', 0.5) - 0.5) < 1e-6, 'inout(0.5) = 0.5')

console.log('\n=== 2. clampOffset 边界 ===')
ok(M.clampOffset('Param_arm_L1', 999) === 30, 'Param_arm_L1 上限夹到 +30')
ok(M.clampOffset('Param_arm_L1', -999) === -30, 'Param_arm_L1 下限夹到 -30')
ok(M.clampOffset('ParamBreath', -5) === 0, 'ParamBreath 不会变成负数（尾巴物理的输入必须是 0..1）')
ok(M.clampOffset('ParamAngleZ', 1e9) === 30, 'ParamAngleZ 夹到 +30')
ok(M.clampOffset('不存在的参数', 42) === 42, '未知参数原样放过（由 Cubism 自己忽略）')

console.log('\n=== 3. 待机层：60 秒仿真 ===')
const ROOTS = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBreath']
const idle = M.makeIdle(20260519)
const seen = new Map(), mins = new Map(), maxs = new Map()
let steps = 0
for (let i = 0; i < 60 * 60; i++) {          // 60 秒 @60fps，引擎按 dt 推进
  M.stepIdle(idle, 1000 / 60)
  M.sampleIdle(idle, (id, v) => {
    seen.set(id, (seen.get(id) || 0) + 1)
    mins.set(id, Math.min(mins.has(id) ? mins.get(id) : Infinity, v))
    maxs.set(id, Math.max(maxs.has(id) ? maxs.get(id) : -Infinity, v))
  })
  steps++
}
ok(seen.size === 4, '只写了 4 个根参数（实际 ' + seen.size + '：' + [...seen.keys()].join(',') + '）')
for (const id of ROOTS) ok(seen.has(id), '包含 ' + id)
let allInBounds = true, worst = ''
for (const [id, mx] of maxs) {
  const bb = bounds(id)
  if (!bb) continue
  const mn = mins.get(id)
  if (mn < bb[0] - 1e-9 || mx > bb[1] + 1e-9) { allInBounds = false; worst = id + ' [' + mn.toFixed(2) + ',' + mx.toFixed(2) + '] vs ' + JSON.stringify(bb) }
}
ok(allInBounds, '所有输出都在合法偏移区间内' + (worst ? ' —— 越界: ' + worst : ''))
const spanOf = (id) => maxs.get(id) - mins.get(id)
ok(spanOf('ParamAngleZ') > 4, 'ParamAngleZ 在动（跨度 ' + spanOf('ParamAngleZ').toFixed(2) + '°，她会换重心/歪头）')
ok(spanOf('ParamAngleX') > 3, 'ParamAngleX 在动（跨度 ' + spanOf('ParamAngleX').toFixed(2) + '°）')
ok(spanOf('ParamAngleY') > 2, 'ParamAngleY 在动（跨度 ' + spanOf('ParamAngleY').toFixed(2) + '°）')
ok(spanOf('ParamBreath') > 0.3, 'ParamBreath 在动（跨度 ' + spanOf('ParamBreath').toFixed(2) + ' → 尾巴会摆）')
ok(mins.get('ParamBreath') >= 0, 'ParamBreath 偏移不为负')

console.log('\n=== 4. 待机层：可复现 & 低性能档 ===')
const i1 = M.makeIdle(7), i2 = M.makeIdle(7)
const trace = (s) => { const out = []; for (let i = 0; i < 600; i++) { M.stepIdle(s, 16.7); M.sampleIdle(s, (id, v) => out.push(id + ':' + v.toFixed(4))) } return out.join('|') }
ok(trace(i1) === trace(i2), '同种子输出完全一致（可复现）')
const i3 = M.makeIdle(7); i3.level = 0.35
let mx3 = 0
for (let i = 0; i < 600; i++) { M.stepIdle(i3, 16.7); M.sampleIdle(i3, (id, v) => { if (id === 'ParamAngleZ') mx3 = Math.max(mx3, Math.abs(v)) }) }
ok(mx3 < 6, '低性能档幅度显著变小（ParamAngleZ 峰值 ' + mx3.toFixed(2) + ' < 6）')

console.log('\n=== 5. Clip 播放 ===')
const names = M.listClips()
ok(names.length >= 5, '动作库有 ' + names.length + ' 个：' + names.join(' / '))
for (const name of names) {
  const def = M.getClipDef(name)
  let outOfBounds = null, emitted = new Set(), n = 0
  const c = M.makeClip(name, { speed: 1, strength: 1 })
  let guard = 0
  while (!c.done && guard++ < 4000) {
    M.stepClip(c, 1000 / 60)
    M.sampleClip(c, (id, v) => {
      n++
      emitted.add(id)
      const bb = bounds(id)
      if (bb && (v < bb[0] - 1e-9 || v > bb[1] + 1e-9)) outOfBounds = id + '=' + v.toFixed(2) + ' vs ' + JSON.stringify(bb)
      if (!rig.ranges[id]) outOfBounds = '未知参数 ' + id
    })
  }
  ok(!outOfBounds, name + ' 播放完(' + (guard / 60).toFixed(1) + 's)，' + emitted.size + ' 个参数，无越界' + (outOfBounds ? ' —— ' + outOfBounds : ''))
}
/*
 * 手臂符号是这一版最容易再犯的错（第一版就是两边写同一个正号，
 * 结果左臂转到身后看不见）。所以这里把**实测约定**写进断言，谁改反了立刻红：
 *   Param_arm_L* 抬手 = 负值；Param_arm_R* 抬手 = 正值。
 * 依据：_research-data/测全部方向.mjs（L1 -30 → 上 111px/外 171px）。
 */
function peakOf(clipName, id, ms = 4000) {
  const c = M.makeClip(clipName, {})
  let lo = 1e9, hi = -1e9
  let g = 0
  while (!c.done && g++ < ms) {
    M.stepClip(c, 1000 / 60)
    M.sampleClip(c, (k, v) => { if (k === id) { lo = Math.min(lo, v); hi = Math.max(hi, v) } })
  }
  return { lo, hi }
}
const wl = peakOf('挥手(左)', 'Param_arm_L1')
const wr = peakOf('挥手(右)', 'Param_arm_R1')
ok(wl.lo < -15, '挥手(左) 的 Param_arm_L1 峰值 ' + wl.lo.toFixed(1) + '°（**负** = 真正抬手，实测约定）')
ok(wr.hi > 15, '挥手(右) 的 Param_arm_R1 峰值 ' + wr.hi.toFixed(1) + '°（**正** = 真正抬手，实测约定）')
ok(wl.lo >= -30 && wr.hi <= 30, '两边都在 ±30 量程内')
ok(Math.abs(wl.lo) > 15 && Math.abs(wl.hi) < 1, '左臂 clip 不会把参数推成正的（推成正 = 手会藏到身后）')
// 左臂那几根都不该用 L4（满量程只动 1px，等于没用）
const wlDef = M.getClipDef('挥手(左)')
ok(!wlDef.tracks.some((t) => t.id === 'Param_arm_L4'), '挥手(左) 不用 Param_arm_L4（满量程只动 1px，没意义）')
const sl = M.getClipDef('伸懒腰')  // 合并版：手臂 ±27 + 闭眼 + 张嘴
ok(sl.tracks.find((t) => t.id === 'Param_arm_L1').keys.every((k) => k[1] <= 0), '伸懒腰 左臂同样用负值（第一版就是这里左右不分才显得怪）')
ok(sl.tracks.find((t) => t.id === 'Param_arm_R1').keys.every((k) => k[1] >= 0), '伸懒腰 右臂用正值')
ok(M.getClipDef('鞠躬') === null, '「鞠躬」已删除（站姿立绘没有弯腰绑定，留着是假动作）')
ok(!M.listClips().includes('鞠躬'), '动作库里不再有鞠躬')

console.log('\n=== 5.5 S3 新动作：打喷嚏 / 叹气 ===')
{
  const sneeze = M.getClipDef('打喷嚏')
  ok(!!sneeze && sneeze.duration <= 1.1, '打喷嚏 是 0.9 秒的快动作（' + (sneeze && sneeze.duration) + 's）')
  const y = peakOf('打喷嚏', 'ParamAngleY')
  ok(y.lo < -15, '打喷嚏 快速低头（ParamAngleY 峰值 ' + y.lo.toFixed(1) + '°）')
  const eL = peakOf('打喷嚏', 'ParamEyeLOpen'), eR = peakOf('打喷嚏', 'ParamEyeROpen')
  ok(eL.lo < -0.95 && eR.lo < -0.95, '打喷嚏 眼睛形状真的闭上（EyeL/R = ' + eL.lo.toFixed(2) + ' / ' + eR.lo.toFixed(2) + '）')
  const ex5 = peakOf('打喷嚏', 'PARAM_EXP5')
  ok(ex5.lo < -0.95, '打喷嚏 同时切了闭眼素材 EXP5=' + ex5.lo.toFixed(2) + '（坑 12.5：两套系统必须成对）')
  const mo = peakOf('打喷嚏', 'ParamMouthOpenY')
  ok(mo.hi > 0.6, '打喷嚏 张嘴（ParamMouthOpenY 峰值 ' + mo.hi.toFixed(2) + '）')
  const br = peakOf('打喷嚏', 'ParamBrowLAngle')
  ok(br.lo < -0.3, '打喷嚏 皱眉（BrowAngle 峰值 ' + br.lo.toFixed(2) + '，负=倒八字）')

  const sigh = M.getClipDef('叹气')
  ok(!!sigh && sigh.duration >= 2.4, '叹气 是慢动作（' + (sigh && sigh.duration) + 's）')
  const sy = peakOf('叹气', 'ParamAngleY')
  ok(sy.lo < -8, '叹气 低头（ParamAngleY 峰值 ' + sy.lo.toFixed(1) + '°）')
  const se = peakOf('叹气', 'ParamEyeLOpen')
  ok(se.lo < -0.95, '叹气 闭眼（EyeOpen 峰值 ' + se.lo.toFixed(2) + '）')
  const sb = peakOf('叹气', 'ParamBrowLAngle')
  ok(sb.hi > 0.4, '叹气 八字眉（BrowAngle +' + sb.hi.toFixed(2) + '，委屈/无奈）')
  ok(!sigh.tracks.some((t) => t.id === 'ParamBreath'), '叹气 不写 ParamBreath 负值（引擎夹到 [0,1]，负值等于没写；尾巴靠低头带动）')

  // 结构性锁：闭眼两套系统必须同时出现（只写一个 = 坑 12.5）
  for (const name of ['打喷嚏', '叹气']) {
    const ids = M.getClipDef(name).tracks.map((t) => t.id)
    ok(ids.includes('PARAM_EXP5') && ids.includes('ParamEyeLOpen') && ids.includes('ParamEyeROpen'),
       name + ' 闭眼两套系统成对出现（EXP5 + EyeL/R）')
    ok(M.getClipDef(name).tracks.every((t) => t.keys[t.keys.length - 1][1] === 0),
       name + ' 每条轨道末尾都回到 0（不会留残姿）')
  }
  ok(M.resolveName('sneeze') === '打喷嚏', "resolveName('sneeze') -> 打喷嚏")
  ok(M.resolveName('sigh') === '叹气', "resolveName('sigh') -> 叹气")
}

console.log('\n=== 6. speed / strength / hold / delay ===')
const fast = M.makeClip('挥手(左)', { speed: 2 }), slow = M.makeClip('挥手(左)', { speed: 0.5 })
const len = (c) => { let g = 0; while (!c.done && g++ < 8000) M.stepClip(c, 1000 / 60); return g / 60 }
const lf = len(fast), ls = len(slow)
ok(lf < ls, 'speed=2 比 speed=0.5 快（' + lf.toFixed(2) + 's vs ' + ls.toFixed(2) + 's）')
const st = M.makeClip('挥手(右)', { strength: 0.5 })
let pk2 = 0
for (let i = 0; i < 200; i++) { M.stepClip(st, 1000 / 60); M.sampleClip(st, (id, v) => { if (id === 'Param_arm_R1') pk2 = Math.max(pk2, v) }) }
ok(pk2 > 10 && pk2 < 14, 'strength=0.5 让峰值减半（' + pk2.toFixed(1) + '°）')
const hd = M.makeClip('点头', { hold: 3 })
const lh = len(hd)                      // 只算一次：len() 会把 clip 跑到 done
ok(lh > 4, 'hold=3 延长了总时长（' + lh.toFixed(2) + 's，基础 1.3s）')
const dl = M.makeClip('点头', { delay: 1 })
let early = 0
for (let i = 0; i < 30; i++) { M.stepClip(dl, 1000 / 60); M.sampleClip(dl, () => early++) }
ok(early === 0, 'delay=1 的前 0.5 秒没有任何输出')
const bad = M.makeClip('不存在的动作', {})
ok(bad === null, '未知动作名返回 null（不会静默乱播）')

console.log('\n=== 7. ASCII 别名（中文名经过 shell/curl 会被编码搞坏） ===')
const aliasMap = M.aliases()
ok(Object.keys(aliasMap).length >= 8, '别名表有 ' + Object.keys(aliasMap).length + ' 条')
ok(M.resolveName('wave-left') === '挥手(左)', "resolveName('wave-left') -> 挥手(左)")
ok(M.resolveName('WAVE_RIGHT') === '挥手(右)', "大小写 + 下划线也能认：'WAVE_RIGHT' -> 挥手(右)")
ok(M.resolveName('nod') === '点头', "resolveName('nod') -> 点头")
ok(M.resolveName('tailwag') === '尾巴快摆', "去掉连字符也能认：'tailwag' -> 尾巴快摆")
ok(M.resolveName('挥手(左)') === '挥手(左)', '中文原名照常可用')
ok(M.resolveName('后空翻') === null, '不存在的名字返回 null')
const ac = M.makeClip('wag', {})
ok(ac && ac.name === '尾巴快摆' && ac.asked === 'wag', '别名播放时记录规范名 + 原始请求')
for (const [k, v] of Object.entries(aliasMap)) {
  if (!M.getClipDef(v)) { ok(false, '别名 ' + k + ' 指向了不存在的动作 ' + v); break }
}
ok(true, '所有别名都指向真实存在的动作')


// ——— 淡出：被打断的 clip 必须回到 0，不能留残姿 ———
// 主人报的「连续两个伸懒腰很僵硬」「害羞打断伸懒腰很怪」就是这个：
// clip 是加性偏移，直接换掉数组的话，旧动作最后那一帧的偏移永远留在参数上。
{
  const c = M.makeClip('伸懒腰')
  ok('新 clip 默认不在淡出', c.fading === false, c.fading)
  // 推到动画中段，让偏移明显不为 0
  M.stepClip(c, 1200)
  const before = {}
  M.sampleClip(c, (id, v) => { before[id] = (before[id] || 0) + v })
  const armBefore = before['Param_arm_L1'] || 0
  ok('中段确实有手臂偏移（' + armBefore.toFixed(1) + '）', armBefore < -5, armBefore)
  ok('fadeOutClip 返回 true', M.fadeOutClip(c, 300) === true)
  ok('重复淡出返回 false（幂等）', M.fadeOutClip(c, 300) === false)
  ok('淡出中 phase = fading', M.stepClip(c, 0) === 'fading')
  // 中途：应该只剩一半左右
  M.stepClip(c, 150)
  const mid = {}
  M.sampleClip(c, (id, v) => { mid[id] = (mid[id] || 0) + v })
  const armMid = mid['Param_arm_L1'] || 0
  ok('淡出中途偏移已衰减（' + armMid.toFixed(1) + ' ≈ 一半）', armMid < armBefore * 0.75 && armMid > armBefore * 0.25, { armBefore, armMid })
  // 淡出结束：done，且不再输出
  ok('淡出走完 phase = done', M.stepClip(c, 300) === 'done')
  ok('淡出结束后 clip.done = true', c.done === true)
  let leaked = false
  M.sampleClip(c, () => { leaked = true })
  ok('淡出结束后不再输出任何偏移（残姿为 0）', leaked === false)

  // 边界：fadeMs = 0 也要能安全收掉（不能除零、不能卡住）
  const c2 = M.makeClip('点头')
  M.stepClip(c2, 300)
  M.fadeOutClip(c2, 0)
  M.sampleClip(c2, () => { leaked = true })
  ok('fadeMs=0 时立刻不再输出', leaked === false)
  ok('fadeMs=0 时 step 一步即 done', M.stepClip(c2, 16) === 'done')

  // 已结束的 clip 不该被再淡出
  const c3 = M.makeClip('点头')
  c3.done = true
  ok('已 done 的 clip 不再淡出', M.fadeOutClip(c3, 300) === false)
}
// ——— 待机层的「临时根参数脉冲」idleBurst（2026-10-17）———
//
// 为什么要有这一节：
//   「甩鼠标 → 小幅甩头」以前是**借「点头」clip 凑的**（那条注释自己都写着
//   「没有临时插根参数脉冲的公开口子」），观感是点头不是甩头。
//   现在引擎开放了 idleBurst，这里是它的锁：只写 4 个根参数、有包络、会自己收、
//   新脉冲覆盖旧的、方向可指定、低性能档跟着缩。
console.log('\n=== 6. 临时根参数脉冲（idleBurst）===')
{
  ok(typeof M.idleBurst === 'function', '引擎对外暴露 idleBurst')
  const kinds = Object.keys(M.BURST_DUR || {})
  ok(kinds.length >= 5, 'BURST_DUR 登记了 ' + kinds.length + ' 种：' + kinds.join(','))
  ok(M.BURST_DUR.flick > 0 && M.BURST_DUR.flick < M.BURST_DUR.lean, '甩头(' + M.BURST_DUR.flick + 's)比探头(' + M.BURST_DUR.lean + 's)短得多 —— 甩一下就回')

  // ① 只写 4 个根参数，幅度看得见，结束后归零
  const s1 = M.makeIdle(4242)
  s1.burst = null
  const r1 = M.idleBurst(s1, 'flick', { dir: 1 })
  ok(!!r1 && r1.kind === 'flick' && r1.dir === 1, '登记成功：' + JSON.stringify(r1))
  let zMax = -1e9, wrote = new Set()
  for (let i = 0; i < 60; i++) {
    M.stepIdle(s1, 16.7)
    M.sampleIdle(s1, (id, v) => { wrote.add(id); if (id === 'ParamAngleZ') zMax = Math.max(zMax, v) })
  }
  ok(wrote.size === 4, '仍然只写那 4 个根参数（实际 ' + wrote.size + '）')
  ok(zMax > 8, '甩头把 ParamAngleZ 推到 ' + zMax.toFixed(1) + '°（肉眼能看见）')
  ok(s1.burst === null, '脉冲结束后自动清空（不会永远歪着头）')

  // ② 方向：dir=-1 要反号（主人从右边甩鼠标 vs 左边）
  //
  // ⚠️ 不能直接看绝对值的极小值：待机层本来就有 ±3~4° 的慢正弦和漂移，
  //    脉冲正好叠在正弦的波峰上时，绝对值会被抬掉一大截（我第一版就是这么误判的）。
  //    正确做法是「同一颗种子、同样时间、有没有脉冲」两次相减，把基线抵消掉。
  function burstPeak(kind, dir, id) {
    const base = M.makeIdle(4242), withB = M.makeIdle(4242)
    // 关掉待机层自己的随机小事件：它在无脉冲时才会消耗随机数，
    // 两边一旦开始消耗不同的随机数，基线就不再一致了（这点很隐蔽）。
    for (const s of [base, withB]) { s.burst = null; s.nextBurstAt = 1e12 }
    M.idleBurst(withB, kind, { dir })
    let hi = -1e9, lo = 1e9
    for (let i = 0; i < 200; i++) {
      M.stepIdle(base, 16.7)
      M.stepIdle(withB, 16.7)
      let vb = 0, vw = 0
      M.sampleIdle(base, (pid, v) => { if (pid === id) vb = v })
      M.sampleIdle(withB, (pid, v) => { if (pid === id) vw = v })
      hi = Math.max(hi, vw - vb)
      lo = Math.min(lo, vw - vb)
    }
    return { hi, lo }
  }
  const pk1 = burstPeak('flick', 1, 'ParamAngleZ')
  const pk2 = burstPeak('flick', -1, 'ParamAngleZ')
  ok(pk1.hi > 7, 'dir=+1 往右甩：净增量 +' + pk1.hi.toFixed(1) + '°')
  ok(pk2.lo < -7, 'dir=-1 往左甩：净增量 ' + pk2.lo.toFixed(1) + '°（方向真的分左右）')

  // ③ 新脉冲覆盖旧的（两个包络叠一起 = 谁也看不懂的怪姿势）
  const s3 = M.makeIdle(5)
  s3.burst = null
  M.idleBurst(s3, 'flick', { dir: 1 })
  const old = s3.burst
  M.idleBurst(s3, 'lean', { dir: 1 })
  ok(s3.burst !== old, '新脉冲替换了旧对象')
  ok(s3.burst.kind === 'lean' && Object.keys(s3.burst).length === 4, '同一时刻只有一个脉冲：' + JSON.stringify(s3.burst))

  // ④ 探头是「抬头看你」：ParamAngleY 偏移为正（参数约定：负 = 低头）
  const s4 = M.makeIdle(7)
  s4.burst = null
  ok(M.idleBurst(s4, 'lean', { dir: 1 }).kind === 'lean', 'lean 也能登记')
  const pkLean = burstPeak('lean', 1, 'ParamAngleY')
  ok(pkLean.hi > 2.2, '探头会抬头：ParamAngleY 净增量 +' + pkLean.hi.toFixed(2) + '（负 = 低头）')

  // ⑤ 没登记的 kind 一律拒绝（宁可不甩，也别甩出一个随机姿势）
  const s5 = M.makeIdle(3)
  s5.burst = null
  ok(M.idleBurst(s5, '后空翻') === null, '未登记的 kind 返回 null')
  ok(s5.burst === null, '未登记的 kind 不会留下脉冲对象')

  // ⑥ 低性能档跟着缩放（level 是唯一旋钮，和其它待机幅度一致）
  const s6 = M.makeIdle(4242)
  s6.burst = null
  s6.level = 0.35
  M.idleBurst(s6, 'flick', { dir: 1 })
  let zMaxLow = -1e9
  for (let i = 0; i < 60; i++) {
    M.stepIdle(s6, 16.7)
    M.sampleIdle(s6, (id, v) => { if (id === 'ParamAngleZ') zMaxLow = Math.max(zMaxLow, v) })
  }
  ok(zMaxLow < zMax * 0.6, '低性能档幅度缩到 ' + zMaxLow.toFixed(1) + '°（正常档 ' + zMax.toFixed(1) + '°）')

  // ⑦ 关掉待机层时不产生脉冲（enabled=false）
  const s7 = M.makeIdle(1)
  s7.enabled = false
  ok(M.idleBurst(s7, 'flick') === null, '待机层关着时拒绝插脉冲')
}

// ——— 结构锁：互动反应里的甩头不许退回「借点头 clip」 ———
//
// 当初的写法是 playClip('点头', { speed: 1.6, strength: 0.35 }) ——
// 观感是点头、不是甩头，而且被 strength 缩放（坑 12.8 同型）。
// 这条锁防「下一个人为了省事又改回去」。
console.log('\n=== 7. 结构锁：甩鼠标用的是真甩头 ===')
{
  const pet = fs.readFileSync(PET, 'utf8')
  const headZ = /if \(r\.headZ\) \{([\s\S]{0,900}?)\n      \}/.exec(pet)
  ok(!!headZ, '找得到 if (r.headZ) { ... } 那段')
  const bodyText = headZ ? headZ[1] : ''
  ok(/idleBurst/.test(bodyText), '甩鼠标走的是 idleBurst（真的甩头）')
  ok(!/playClip/.test(bodyText), '不再借「点头」clip 凑数')
  ok(/kind: 'lean'/.test(pet), 'hover 反应池里有「探头」(lean)')
  ok(/case 'peer':/.test(pet), '待机行为 peer 有 switch 分支')
  ok(/case 'sway':/.test(pet), '待机行为 sway 有 switch 分支')
}
console.log('\n========================================')
console.log(fail === 0 ? `全部通过：${pass} 项` : `⚠ 失败 ${fail} 项 / 通过 ${pass} 项`)
process.exit(fail === 0 ? 0 : 1)
