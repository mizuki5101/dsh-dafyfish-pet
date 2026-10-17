/**
 * 成套小戏（e）单测（纯 Node，不需要外壳）。
 *
 * 两块都测：
 *   · `@idle-scripts` 引擎（时间轴 / 中断 / 冷却 / 加权抽取）
 *   · `IDLE_SCRIPTS` 数据表（步数、at 递增、动词合法、时长）
 * 两者都从 pet.js 原样抠出来，所以测的就是线上跑的那份。
 *
 * 用法：node _research-data/测试成套小戏.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const PET = path.join(import.meta.dirname, '..', 'pet-plugin', 'assets', 'pet.js')
const src = fs.readFileSync(PET, 'utf8')

const m = /\/\* ==== @idle-scripts:start ====[\s\S]*?\/\* ==== @idle-scripts:end ==== \*\//.exec(src)
if (!m) { console.error('❌ 抠不出 @idle-scripts 块'); process.exit(1) }
const E = new Function(m[0].replace('var DSHPetIdleScripts =', 'return') + '')()
if (!E || typeof E.frame !== 'function') { console.error('❌ 块求值失败'); process.exit(1) }

// IDLE_SCRIPTS 数据表：用 vm 抠出来（它引用的 SAY 等不需要，只求值字面量）
const dm = /const IDLE_SCRIPTS = \[([\s\S]*?)\n  \]/.exec(src)
if (!dm) { console.error('❌ 抠不出 IDLE_SCRIPTS'); process.exit(1) }
const DATA = new Function('return [' + dm[1] + ']')()

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}
const seeded = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

console.log('\n【1】数据表本身是合法的')
{
  const problems = E.validate(DATA)
  ok('validate 通过（无问题）', problems.length === 0, problems)
  ok('至少 5 段小戏（实测 ' + DATA.length + '）', DATA.length >= 5, DATA.length)
  const names = DATA.map((x) => x.name)
  ok('名字不重复', new Set(names).size === names.length, names)
  ok('每段 2~4 步', DATA.every((x) => x.steps.length >= 2 && x.steps.length <= 4), DATA.map((x) => x.steps.length))
  const verbs = new Set()
  DATA.forEach((x) => x.steps.forEach((y) => verbs.add(y.do)))
  ok('只用了支持的动词（' + [...verbs].join(',') + '）', [...verbs].every((v) => E.VERBS[v]))
  ok('没有嵌套调用 idleExpress/idleFiddle（铁律）',
     !/idleExpress|idleFiddle/.test(dm[1]))
  DATA.forEach((x) => {
    const d = E.durOf(x)
    ok(x.name + ' 时长合理（' + d.toFixed(1) + 's）', d >= 2 && d <= 8, d)
    ok(x.name + ' 有 minGap（' + x.minGap + 's）', Number(x.minGap) > 0, x.minGap)
  })
}

console.log('\n【2】validate 能抓出坏数据')
{
  ok('缺 name 被报', E.validate([{ steps: [{ at: 0, do: 'glance' }] }]).length > 0)
  ok('未知动词被报', E.validate([{ name: 'x', steps: [{ at: 0, do: 'fly', arg: 'a' }] }]).length > 0)
  ok('at 非递增被报', E.validate([{ name: 'x', steps: [{ at: 2, do: 'glance' }, { at: 1, do: 'glance' }] }]).length > 0)
  ok('clip 缺 arg 被报', E.validate([{ name: 'x', steps: [{ at: 0, do: 'clip' }, { at: 1, do: 'glance' }] }]).length > 0)
  ok('合法数据不报', E.validate([{ name: 'x', minGap: 10, steps: [{ at: 0, do: 'glance' }, { at: 1, do: 'clip', arg: '点头' }] }]).length === 0)
}

console.log('\n【3】时间轴：到点才放、按序放')
{
  const sc = { name: 'T', minGap: 10, steps: [{ at: 0, do: 'glance' }, { at: 1, do: 'clip', arg: '点头' }, { at: 2.5, do: 'line', arg: 'x' }] }
  const st = E.makeState()
  E.start(st, sc, 1000)
  // ⚠️ frame() 是**有状态**的：每帧只能调一次，调第二次同一帧就什么都没了。
  //    我第一版把 at(1000) 在同一个表达式里调了三次，自己把状态吃掉了 —— 测试也要当心这个。
  const at = (ms) => { const r = E.frame(st, ms, { holdSec: 0.5 }); return { acts: r.filter((x) => x.verb !== 'end'), end: r.some((x) => x.verb === 'end') } }
  const f0 = at(1000)
  ok('t=0 放第 1 步（glance）', f0.acts.length === 1 && f0.acts[0].verb === 'glance', f0.acts)
  const f1 = at(1500)
  ok('t=0.5s 什么都不放', f1.acts.length === 0, f1.acts)
  const f2 = at(2000)
  ok('t=1.0s 放第 2 步（clip 点头）', f2.acts.length === 1 && f2.acts[0].verb === 'clip' && f2.acts[0].arg === '点头', f2.acts)
  const f3 = at(2500)
  ok('t=1.5s 不重复放第 2 步', f3.acts.length === 0, f3.acts)
  const f4 = at(3500)
  ok('t=2.5s 放第 3 步（line）', f4.acts.length === 1 && f4.acts[0].verb === 'line', f4.acts)
  const f5 = at(4200)
  ok('t=3.2s（总时长 2.5 + hold 0.5 之后）报 end', f5.end === true, f5)
  ok('end 之后 running 被清空', st.running === null)
}

console.log('\n【4】卡顿跨帧：中间步骤不能被丢掉')
{
  const sc = { name: 'T', minGap: 5, steps: [{ at: 0, do: 'glance' }, { at: 0.2, do: 'clip', arg: 'a' }, { at: 0.4, do: 'clip', arg: 'b' }] }
  const st = E.makeState()
  E.start(st, sc, 0)
  E.frame(st, 0, {})
  const jump = E.frame(st, 1000, {}).filter((x) => x.verb !== 'end') // 一帧跨过 1 秒
  ok('一帧跨过全部 at 时，后面的步骤全部放出（' + jump.length + ' 个）', jump.length === 2, jump)
  ok('顺序仍然是原顺序', jump[0].arg === 'a' && jump[1].arg === 'b', jump)
}

console.log('\n【5】中断：立刻收掉且不留状态')
{
  const sc = { name: 'T', minGap: 30, steps: [{ at: 0, do: 'glance' }, { at: 5, do: 'clip', arg: 'a' }] }
  const st = E.makeState()
  E.start(st, sc, 0)
  E.frame(st, 0, {})
  const name = E.abort(st, 2000)
  ok('abort 返回被中断的名字', name === 'T', name)
  ok('中断后 running 为空', st.running === null)
  ok('中断后再 frame 什么都不放', E.frame(st, 3000, {}).length === 0)
  ok('没在演时 abort 返回 null', E.abort(st, 4000) === null)
}

console.log('\n【6】冷却：演完要等 minGap')
{
  const sc = { name: 'T', minGap: 20, steps: [{ at: 0, do: 'glance' }] }
  const st = E.makeState()
  E.start(st, sc, 0)
  E.frame(st, 0, { holdSec: 0 })
  E.frame(st, 900, { holdSec: 0.1 }) // 超过 hold 才会触发 end → 上锁（holdSec 0 会被 || 兜成 0.8）
  ok('结束后冷却已上锁（≈20s + 时长）', (st.nextAt.T || 0) > 15000, st.nextAt.T)
  ok('冷却中 canStart 为 false', E.canStart(st, sc, 5000, 0) === false)
  ok('冷却过后 canStart 为 true', E.canStart(st, sc, st.nextAt.T + 1, 0) === true)
}

console.log('\n【7】加权抽取：刚演过的权重被压')
{
  const list = [
    { name: 'A', weight: 10, minGap: 1, steps: [{ at: 0, do: 'glance' }] },
    { name: 'B', weight: 10, minGap: 1, steps: [{ at: 0, do: 'glance' }] }
  ]
  const rnd = seeded(7)
  const tally = { A: 0, B: 0 }
  for (let i = 0; i < 4000; i++) {
    const st = E.makeState()
    st.last = 'A' // 假装刚演过 A
    const c = E.choose(st, list, 0, rnd)
    if (c) tally[c.name]++
  }
  const pB = tally.B / (tally.A + tally.B)
  ok('刚演过的 A 被压到约 23%（实测 ' + (100 - pB * 100).toFixed(1) + '%）', pB > 0.7 && pB < 0.85, tally)
  // 冷却中的段被完全排除
  const st2 = E.makeState()
  st2.nextAt = { A: 99999 }
  let gotA = 0
  for (let i = 0; i < 500; i++) { if ((E.choose(st2, list, 1000, rnd) || {}).name === 'A') gotA++ }
  ok('冷却中的段抽不到（实测 ' + gotA + ' 次）', gotA === 0)
  // 全在冷却 → 返回 null
  const st3 = E.makeState()
  st3.nextAt = { A: 99999, B: 99999 }
  ok('全部冷却中返回 null', E.choose(st3, list, 1000, rnd) === null)
}

console.log('\n【8】canStart 的三道闸门')
{
  const sc = { name: 'T', minGap: 1, steps: [{ at: 0, do: 'glance' }] }
  const st = E.makeState()
  ok('干净状态可开演', E.canStart(st, sc, 0, 0) === true)
  E.start(st, sc, 0)
  ok('已在演时不可再开', E.canStart(st, sc, 100, 0) === false)
  const st2 = E.makeState()
  st2.lastEndAt = 1000
  // ⚠️ gapAfter 的单位是**毫秒**（我第一版传了 15，等于要求 15ms，断言就假过了）
  ok('刚演完不到 gapAfter 不可开（gapAfter 单位=毫秒）', E.canStart(st2, sc, 3000, 15000) === false)
  ok('超过 gapAfter 可开', E.canStart(st2, sc, 20000, 15000) === true)
}

console.log('\n【9】与 pet.js 的接线（防止只写了引擎没接上）')
{
  ok('gazeTick 里调了 scriptTick', /scriptTick\(now\)/.test(src))
  ok('IDLE_TABLE 里有 script 条目', /\['script',\s*\d+\]/.test(src))
  ok('runIdleBehavior 的 switch 有 script 分支', /case 'script'/.test(src))
  ok('agent 切走时会中断小戏', /if \(next !== 'idle'\) abortIdleScript\(\)/.test(src))
  ok('点击时会中断小戏', /abortIdleScript\(\) \/\/ 主人点她/.test(src))
  ok('idle.scripts 状态已初始化', /scripts: \(typeof DSHPetIdleScripts/.test(src))
  // 权重表与 switch 的一致性（沿用节奏套件那条断言的精神）
  const tm = /const IDLE_TABLE = \[([\s\S]*?)\n  \]/.exec(src)
  const table = [...tm[1].matchAll(/\['([A-Za-z]+)'/g)].map((x) => x[1])
  const cases = [.../switch \(b\) \{([\s\S]*?)\n    \}/.exec(src)[1].matchAll(/case '([A-Za-z]+)'/g)].map((x) => x[1])
  ok('权重表里每个行为都有 switch 分支（含 script）', table.every((k) => cases.includes(k)), { table, cases })
}

console.log('\n【10】接线细节：优先级与暂停语义（本次两个真 bug 的回归锁）')
{
  // ⚠️ bug 1：小戏刚起就被待机大脑的 soft 表演（自言自语/自己换表情）打断 →
  //    根因是 scriptTick 一看到任何 rig.override 就 abort，而待机大脑几秒就 act() 一次。
  ok('setReaction 支持 soft 标记', /soft: opts\.soft === true/.test(src))
  ok('act 会透传 soft', /soft: spec\.soft/.test(src))
  const softCount = (src.match(/soft: true/g) || []).length
  ok('待机自发行为都标了 soft（实测 ' + softCount + ' 处）', softCount >= 5, softCount)
  ok('scriptTick 不再把 override 当中断条件',
     !/hardOverride \? 'override'/.test(src))
  ok('硬表演改为「暂停」而非「中断」', /paused:override/.test(src))
  // ⚠️ bug 2：小戏在演时待机大脑还会插一件，把小戏的步骤盖掉
  ok('小戏在演时待机大脑不插新行为', /if \(idle\.scripts && idle\.scripts\.running\) \{[^}]*return null/.test(src))
  ok('排期会等小戏演完', /durOf\(idle\.scripts\.running\) \* 1000/.test(src))
  ok('中断原因被记录下来（诊断用）', /idle\.scriptAbortWhy = /.test(src))
}

console.log('\n【11】闭眼必须「素材 + 形状」成对出现（本次真 bug 的结构性回归锁）')
{
  // 主人报的：「闭眼动作时还隐隐看到睁眼，像透明度没调好」。
  // 真因（_research-data/param-influence.json 实测）：
  //   PARAM_EXP5    → 只改 29 个 drawable 的 opacity（切眼睑素材），**不改顶点**
  //   ParamEyeLOpen → 改 109px 顶点位移（真正让眼睛闭上），**不改 opacity**
  // 两个是独立系统 —— 只切素材、形状还睁着，就会「闭眼没盖严」。
  ok('param-influence.json 记录了 EXP5 只改 opacity', (() => {
    try {
      const inf = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'param-influence.json'), 'utf8'))
      const r = (inf.results || []).find((x) => x.id === 'PARAM_EXP5')
      const e = (inf.results || []).find((x) => x.id === 'ParamEyeLOpen')
      return r && e && r.opacityChangedMax > 0 && r.maxDisplacementPx === 0 && e.maxDisplacementPx > 50 && e.opacityChangedMax === 0
    } catch (err) { return false }
  })())

  // 扫所有 CLIPS 定义：任何写 `PARAM_EXP5` 且含负值的轨道，同 clip 里必须有眼睛形状轨道
  const clipBlocks = [...src.matchAll(/^      '([^']+)': \{\r?\n        duration:[\s\S]*?\n      \},/gm)]
  ok('能扫到 CLIPS 定义（' + clipBlocks.length + ' 个）', clipBlocks.length >= 10, clipBlocks.length)
  const offenders = []
  for (const cb of clipBlocks) {
    const name = cb[1], body = cb[0]
    const exp5 = /id: 'PARAM_EXP5', keys: \[([^\]]*(?:\][^\]]*)*?)\] \}/.exec(body)
    if (!exp5) continue
    const hasNegative = /-\d/.test(exp5[1])
    if (!hasNegative) continue
    const hasEyeShape = /id: 'ParamEyeLOpen'/.test(body) && /id: 'ParamEyeROpen'/.test(body)
    if (!hasEyeShape) offenders.push(name)
  }
  ok('凡是用 EXP5 闭眼的 clip，都同时闭了眼睛形状（违规: ' + (offenders.join(',') || '无') + '）', offenders.length === 0, offenders)
  ok('「伸懒腰」确实成对（EXP5 + EyeLOpen + EyeROpen）', /'伸懒腰':[\s\S]{0,1600}ParamEyeLOpen[\s\S]{0,200}ParamEyeROpen/.test(src))
  ok('眼睛形状参数已在 WATCH 诊断名单里', /'ParamEyeLOpen', 'ParamEyeROpen'/.test(src))
}

console.log('\n【12】clip 自带表情时，脸层必须让位（本次真 bug 的回归锁）')
{
  // 主人报：「随机激活的伸懒腰眼睑很明显，手动选的却消失了」。
  // 差异来源：手动走 act()（会 stopActing 清掉脸层），随机走 playClip（不动脸层）。
  // 脸层的 PARAM_EXP* 偏移会叠到 clip 的同一个参数上 → 半吊子效果。
  ok('有 clipOwnsExpression 判定函数', /function clipOwnsExpression\(\)/.test(src))
  ok('applyRig 里脸层会因它让位（face）', /if \(!clipExpr && rig\.face\) targets\.set/.test(src))
  ok('applyRig 里道具也随之让位（props）', /if \(!clipExpr\) for \(const name of rig\.props\)/.test(src))
  ok('判定按 PARAM_EXP 前缀（显隐类开关）', /indexOf\('PARAM_EXP'\) === 0/.test(src))
  // 这套逻辑必须只在「有 clip 且它自带表情」时生效，否则会把常驻脸全压掉
  ok('空 clips 时判定为 false（不会误伤常驻脸）', /if \(!motion \|\| !motion\.clips \|\| !motion\.clips\.length\) return false/.test(src))
  // 自检：让位是「跳过加入 targets」，而 targets 决定权重推进 —— 所以脸会平滑淡出/淡回
  ok('让位窗口跟着 clip 走（淡出期间也在让位）', /c\.done \|\| !c\.def/.test(src))
}
console.log('\n【13】待机路径的动作强度必须满（本次真凶的回归锁）')
{
  // 真凶：idleClipAction 原来写 strength: 0.8 + rand*0.2，
  //   而 strength 会缩放整个动作的偏移量（sampleTrack 里 v * strength），
  //   于是闭眼只到 EXP5 = -0.837 —— 眼睛形状留着一条缝，
  //   看起来就是「随机伸懒腰眼睑没消掉」。手动菜单走 strength 默认 1 才完全闭上。
  const idleBlock = /function idleClipAction[\s\S]*?\n  \}/.exec(src)
  ok('能抠出 idleClipAction', !!idleBlock)
  if (idleBlock) {
    // ⚠️ 只看**代码行**，排除注释 —— 注释里为了解释这段历史特意写了 strength: 的旧写法，
    //    我第一版的正则把注释也算进去，于是断言自己被自己的说明文档骗红了。
    const codeOnly = idleBlock[0].split('\n').filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l)).join('\n')
    ok('它不再给动作降强度（代码里不能出现 strength:）', !/strength\s*:/.test(codeOnly), /strength\s*:[^,}]*/.exec(codeOnly)?.[0])
    ok('速度仍可随机（不影响幅度）', /speed:\s*0\.9/.test(idleBlock[0]))
    ok('起手会清软脸层（clearSoftFace）', /clearSoftFace\(\)/.test(idleBlock[0]))
  }
  // 小戏的 clip 步骤同样：不降强度，且清脸层
  const scriptClip = /a\.verb === 'clip'\) \{([\s\S]*?)\n      \}/.exec(src)
  ok('小戏 clip 步骤也清脸层', !!scriptClip && /clearSoftFace\(\)/.test(scriptClip[1]))
  const scriptClipCode = scriptClip ? scriptClip[1].split('\n').filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l)).join('\n') : ''
  ok('小戏 clip 步骤不降强度（只看代码）', !!scriptClip && !/strength\s*:/.test(scriptClipCode))
  // clearSoftFace 只能清 soft（硬表演不能碰）
  const csf = /function clearSoftFace\(\) \{([\s\S]*?)\n  \}/.exec(src)
  ok('clearSoftFace 只清 soft 层', !!csf && /if \(!rig\.override\.soft\) return false/.test(csf[1]))
  ok('小戏的 face 步骤标了 soft', /setReaction\(\{ face: a\.arg, ms: 2600, soft: true \}\)/.test(src))
}
console.log('\n【14】第 6 段小戏「偷看主人」（2026-10-17）')
{
  const sc = DATA.find((x) => x.name === '偷看主人')
  ok('数据表里有「偷看主人」', !!sc, DATA.map((x) => x.name))
  if (sc) {
    ok(
      '4 步：glance → face(脸红) → clip(歪头) → line',
      sc.steps.map((s) => s.do + (s.arg ? ':' + s.arg : '')).join(' / ') === 'glance / face:脸红 / clip:歪头 / line:（偷看）主人在干嘛…',
      sc.steps,
    )
    const st = E.makeState()
    E.start(st, sc, 0)
    // frame 有状态：每一帧只能调一次（见 §3 的坑）
    const at = (ms) => E.frame(st, ms, { holdSec: 0.8 }).filter((x) => x.verb !== 'end')
    const a0 = at(0)
    const a1 = at(1400)
    const a2 = at(2600)
    const a3 = at(4400)
    ok(
      '按 0 / 1.4 / 2.6 / 4.4 秒依次放出四步',
      a0.length === 1 && a0[0].verb === 'glance' &&
        a1.length === 1 && a1[0].verb === 'face' && a1[0].arg === '脸红' &&
        a2.length === 1 && a2[0].verb === 'clip' && a2[0].arg === '歪头' &&
        a3.length === 1 && a3[0].verb === 'line',
      { a0, a1, a2, a3 },
    )
    const end = E.frame(st, 5300, { holdSec: 0.8 }).some((x) => x.verb === 'end')
    ok('4.4 + 0.8 秒后报 end（时长 ' + E.durOf(sc).toFixed(1) + 's）', end === true)
  }
}

console.log('\n' + '='.repeat(52))
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
