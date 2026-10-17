/**
 * 「新待机行为 + 真甩头」的真机验收（走 CDP，不用截图）。
 *
 * 验的是 2026-10-17 这一轮加的东西真的在线上跑：
 *   · peer（探头张望）/ sway（换重心）进了待机权重表，而且真的能被抽到
 *   · 甩鼠标走的是 idleBurst('flick') 的**真甩头**，不是又借了「点头」clip
 *   · 凑近有「探头」(lean) 这一档，且是最轻的那种反应
 *   · 脉冲只活 0.x~2.x 秒，过后自己收干净（不留残姿）
 *
 * 用法：node _research-data/验证新待机行为.mjs [调试口，默认 9222]
 */
import { connect } from './_safe/cdp.mjs'

const port = Number(process.argv[2] || 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
const fails = []
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fails.push(name + (extra ? ' —— ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' —— ' + extra : '')) }
}

const c = await connect(port)
const ev = (expr) => c.evaluate(expr)

console.log('=== 1. 新的待机行为进了权重表（idleAct 会校验表里有没有）===')
const peer = await ev("DSHPet.idleAct('peer')")
ok('idleAct(peer) 被接受：' + JSON.stringify(peer && peer.got), !!(peer && peer.ok), JSON.stringify(peer))
const sway = await ev("DSHPet.idleAct('sway')")
ok('idleAct(sway) 被接受：' + JSON.stringify(sway && sway.got), !!(sway && sway.ok), JSON.stringify(sway))
const swayClips = await ev('DSHPet.motionState().clips.map(function(x){return x.name})')
ok('sway 播的是「换重心」动作', Array.isArray(swayClips) && swayClips.indexOf('换重心') >= 0, JSON.stringify(swayClips))
const peerBurst = await ev('DSHPet.motionState().idle.burst')
ok('peer 走的是 lean 脉冲（不是 clip）', peerBurst === 'lean', String(peerBurst))

console.log('=== 2. 甩鼠标 = 真甩头（idleBurst flick）===')
let flick = null, tries = 0
for (let i = 0; i < 30 && !flick; i++) {
  tries++
  await ev('DSHPet.sensorClearCooldowns()')
  await ev('DSHPet.stopClips()')
  const r = await ev("(function(){ DSHPet.reactNow('swoosh'); return { burst: DSHPet.motionState().idle.burst, who: DSHPet.sensorState().reactWho } })()")
  if (r && r.who === 'swoosh' && r.burst === 'flick') flick = r
  await sleep(120)
}
ok('甩鼠标抽到了真甩头（试了 ' + tries + ' 次）', !!flick, JSON.stringify(flick))
const clipNames = await ev('DSHPet.motionState().clips.map(function(x){return x.name})')
ok('甩头**没有**去播「点头」clip', !Array.isArray(clipNames) || clipNames.indexOf('点头') < 0, JSON.stringify(clipNames))
const flickDetail = await ev('DSHPet.motionState().idle.burst')
ok('脉冲还活着（0.62 秒内）', flickDetail === 'flick', String(flickDetail))
await sleep(900)
// ⚠️ 不能断言「一定是 null」：待机层自己每 9~21 秒会随机插一个 burst
// （换重心 / 甩尾巴 / 张望），正好撞上就是误红。要验的是「我们那个甩头已经收掉了」。
const afterFlick = await ev('DSHPet.motionState().idle.burst')
ok('0.9 秒后甩头自己收干净（现在挂着：' + afterFlick + '）', afterFlick !== 'flick', String(afterFlick))

console.log('=== 3. 凑近有「探头」这一档 ===')
let lean = null, tries2 = 0
for (let i = 0; i < 40 && !lean; i++) {
  tries2++
  await ev('DSHPet.sensorClearCooldowns()')
  await ev('DSHPet.stopClips()')
  const r = await ev("(function(){ DSHPet.reactNow('hover'); return { burst: DSHPet.motionState().idle.burst, who: DSHPet.sensorState().reactWho } })()")
  if (r && r.who === 'hover' && r.burst === 'lean') lean = r
  await sleep(100)
}
ok('凑近抽到了「探头」（试了 ' + tries2 + ' 次）', !!lean, JSON.stringify(lean))
await sleep(2400)
const afterLean = await ev('DSHPet.motionState().idle.burst')
ok('探头过后也自己收干净（现在挂着：' + afterLean + '）', afterLean !== 'lean', String(afterLean))

console.log('=== 3.5 「做不了的行为」不进池（收尾时修的真问题）===')
// fiddle（拨弄道具）在权重表里占 10~14，但那堆道具全是鲸鱼娘模型专属的，
// 大肥鱼一个都没有 → 每次抽到都「什么都没发生」。现在按 canDoIdle 过滤掉了。
const pool = await ev('DSHPet.idlePool()')
ok('idlePool() 可用（mood=' + (pool && pool.mood) + '）', !!(pool && Array.isArray(pool.names)), JSON.stringify(pool).slice(0, 160))
ok('池子里没有 fiddle（本模型没有可用道具）', !(pool.names || []).includes('fiddle'), JSON.stringify(pool && pool.names))
ok('removed 里列出了 fiddle', (pool.removed || []).includes('fiddle'), JSON.stringify(pool && pool.removed))
ok('propKeys 为空（大肥鱼没有任何装饰道具）', Array.isArray(pool.propKeys) && pool.propKeys.length === 0, JSON.stringify(pool && pool.propKeys))
ok('看得见的行为还在池子里（express / mutter / glance）',
  ['express', 'mutter', 'glance'].every((k) => (pool.names || []).includes(k)), JSON.stringify(pool && pool.names))
const forced = await ev("DSHPet.idleAct('fiddle')")
ok('点名要 fiddle 时明确拒绝并说清原因：' + JSON.stringify(forced && forced.behWhy),
  !!(forced && forced.got === null && forced.behWhy === 'not-available:fiddle'), JSON.stringify(forced))

console.log('=== 4. 没碰坏既有东西 ===')
const st = await ev('DSHPet.state')
ok('模型还在（画布没变）', !!(st && st.modelSize), JSON.stringify(st && st.modelSize))
ok('表情还在（' + (st && st.expressions && st.expressions.length) + ' 个）', !!(st && st.expressions && st.expressions.length >= 13))
const blink = await ev('DSHPet.blink()')
ok('眨眼系统正常（phase=' + (blink && blink.phase) + ' gate=' + (blink && blink.gate) + '）', !!(blink && blink.gate === 'ok'))
const eye = await ev('DSHPet.eyeState()')
ok('眼睛参数合法', !!(eye && typeof eye.L === 'number' && eye.L > 0.5), JSON.stringify(eye))
const scripts = await ev('DSHPet.scriptList().length')
ok('小戏还在（' + scripts + ' 段）', scripts >= 5, String(scripts))
const mstate = await ev('DSHPet.motionState()')
ok('待机节奏还在跑（mood=' + (mstate && mstate.idle && mstate.idle.mood) + '）', !!(mstate && mstate.idle && mstate.idle.mood))

c.close()
console.log('\n' + '='.repeat(44))
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项：')
  for (const f of fails) console.log('  · ' + f)
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项')
  process.exit(1)
} else {
  console.log('新待机行为验收通过：' + pass + ' 项')
}