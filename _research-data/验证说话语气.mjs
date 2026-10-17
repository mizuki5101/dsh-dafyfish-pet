/**
 * 「说话时脸会跟着语气变」的真机验收（走 CDP）。
 *
 * 2026-10-17 新增：她说话时不再只有一个固定正弦的嘴 —— 疑问会抬眉毛+歪头，
 * 感叹会把嘴张大、嘴角上扬、抬头。判据是**最后一句**的标点与语气词（见 @talk-tone）。
 *
 * 为什么用 DSHPet.talkProbe()：真实的说话只发生在 agent 吐字那一刻，
 * 而那时候正是主人在干活的时候，CDP 很难正好采样 —— 和 idleDemo 是同一个理由。
 * talkProbe 只动语气与口型，**不发任何消息**。
 *
 * 用法：node _research-data/验证说话语气.mjs [调试口，默认 9222]
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
const near = (name, got, want, tol) => ok(name, typeof got === 'number' && Math.abs(got - want) <= tol, 'got=' + got + ' want≈' + want)

const c = await connect(port)
const ev = (expr) => c.evaluate(expr)

/** 采样 n 帧，取每个参数「绝对值最大」的那个（正弦在动，单帧可能采到 0） */
async function sampleOut(id, n) {
  let best = null
  for (let i = 0; i < (n || 6); i++) {
    const out = await ev('DSHPet.motionState().debug.out')
    const v = out ? out[id] : undefined
    if (typeof v === 'number' && (best === null || Math.abs(v) > Math.abs(best))) best = v
    await sleep(70)
  }
  return best === null ? 0 : best
}

console.log('=== 1. 判语气的接口 ===')
ok('classifyTone(你在吗？) = ask', (await ev("DSHPet.classifyTone('你在吗？')")) === 'ask')
ok('classifyTone(好耶！) = excl', (await ev("DSHPet.classifyTone('好耶！')")) === 'excl')
ok('classifyTone(我去看看) = plain', (await ev("DSHPet.classifyTone('我去看看')")) === 'plain')
const tone0 = await ev('DSHPet.talkTone()')
ok('talkTone() 报出三档', !!(tone0 && Array.isArray(tone0.tones) && tone0.tones.length === 3), JSON.stringify(tone0))

console.log('=== 2. 疑问：抬眉毛 + 嘴角微动 ===')
await ev('DSHPet.stopClips()')
const askStart = await ev("DSHPet.talkProbe('你在吗？', 2600)")
ok('talkProbe 判定为 ask', askStart && askStart.tone === 'ask', JSON.stringify(askStart))
await sleep(250)
const askBrow = await sampleOut('ParamBrowLAngle', 6)
const askForm = await sampleOut('ParamMouthForm', 3)
const askMouth = await sampleOut('ParamMouthOpenY', 6)
near('疑问时眉毛抬起', askBrow, 0.30, 0.09)
near('疑问时嘴角微扬', askForm, 0.10, 0.06)
ok('嘴仍然在动（口型没坏）', Math.abs(askMouth) > 0.08, String(askMouth))
const askState = await ev('DSHPet.state.talkTone')
ok('state.talkTone = ask', askState === 'ask', String(askState))

console.log('=== 3. 感叹：嘴角更扬 + 嘴更大 ===')
const exclStart = await ev("DSHPet.talkProbe('好耶！', 2600)")
ok('talkProbe 判定为 excl', exclStart && exclStart.tone === 'excl', JSON.stringify(exclStart))
await sleep(250)
const exclForm = await sampleOut('ParamMouthForm', 4)
const exclBrow = await sampleOut('ParamBrowLAngle', 4)
const exclMouth = await sampleOut('ParamMouthOpenY', 8)
near('感叹时嘴角上扬', exclForm, 0.22, 0.07)
near('感叹时眉毛轻抬（比疑问小）', exclBrow, 0.14, 0.07)
ok('感叹时嘴角比疑问更扬（' + exclForm + ' > ' + askForm + '）', exclForm > askForm + 0.03, exclForm + ' vs ' + askForm)
ok('感叹时嘴张得更大（峰值 ' + exclMouth + '）', Math.abs(exclMouth) > Math.abs(askMouth), exclMouth + ' vs ' + askMouth)

console.log('=== 4. 平常：不动眉毛 ===')
const plainStart = await ev("DSHPet.talkProbe('我去看看', 2000)")
ok('talkProbe 判定为 plain', plainStart && plainStart.tone === 'plain', JSON.stringify(plainStart))
await sleep(250)
const plainBrow = await sampleOut('ParamBrowLAngle', 4)
ok('平常时眉毛不动（|' + plainBrow + '| < 0.06）', Math.abs(plainBrow) < 0.06, String(plainBrow))

console.log('=== 5. 探针会自己收（不会一直张着嘴）===')
await sleep(2200)
const after = await ev('(function(){ var s = DSHPet.state; return { talking: s.talking, tone: s.talkTone } })()')
ok('探针到点后 talking = false', after && after.talking === false, JSON.stringify(after))
ok('语气回到 plain', after && after.tone === 'plain', JSON.stringify(after))

console.log('=== 6. 没碰坏既有东西 ===')
const st = await ev('DSHPet.state')
ok('模型还在', !!(st && st.modelSize))
const blink = await ev('DSHPet.blink()')
ok('眨眼正常', !!(blink && blink.gate === 'ok'))
const eye = await ev('DSHPet.eyeState()')
ok('眼睛参数合法', !!(eye && typeof eye.L === 'number' && eye.L > 0.5), JSON.stringify(eye))
const scripts = await ev('DSHPet.scriptList().length')
ok('小戏还在（' + scripts + '）', scripts >= 5)

c.close()
console.log('\n' + '='.repeat(44))
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项：')
  for (const f of fails) console.log('  · ' + f)
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项')
  process.exit(1)
} else {
  console.log('说话语气验收通过：' + pass + ' 项')
}