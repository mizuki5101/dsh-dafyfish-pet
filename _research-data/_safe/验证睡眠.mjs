/**
 * 睡眠 / 唤醒的 CDP 真机验证（需要外壳带调试口）。
 *
 * 为什么单独一个脚本：睡眠是纯观感功能，纯 Node 只能验状态机；
 *   「闭眼有没有真的闭上、三张睡脸长得对不对、醒来那下懵不懵」必须看画布。
 *   透明窗口截图不可靠（坑 #10），所以用 DSHPet.captureCanvas() 拿她自己的画布。
 *
 * 用法：
 *   node _research-data/_safe/启动外壳.mjs 9222
 *   node _research-data/_safe/验证睡眠.mjs 9222
 *
 * 产物：_research-data/睡眠-*.png（看一眼就删/留都行，别提交）
 */
import fs from 'node:fs'
import path from 'node:path'
import { connect } from './cdp.mjs'

const PORT = Number(process.argv[2]) || 9222
const OUT = path.join(import.meta.dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

const c = await connect(PORT)
console.log('页面：' + c.page.url)

const ev = c.evaluate
const rawEval = async (expr) => {
  const r = await c.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r && r.result ? r.result.value : null
}
const shot = async (name) => {
  const data = await rawEval('DSHPet.captureCanvas()')
  if (!data || typeof data !== 'string' || !data.startsWith('data:image/png')) {
    ok('截到画布：' + name, false, data ? String(data).slice(0, 40) : data)
    return false
  }
  const file = path.join(OUT, '睡眠-' + name + '.png')
  fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'))
  console.log('  📸 ' + file)
  return true
}
const outOf = async (id) => {
  const m = await ev('DSHPet.motionState().debug.out')
  return m ? m[id] : null
}

console.log('\n【1】前置：模型与睡脸表情都在')
{
  const st = await ev('DSHPet.state')
  ok('页面已就绪（有 state.face / state.agent）', !!(st && 'face' in st && 'agent' in st), st && Object.keys(st).slice(0, 8))
  const faces = await ev('DSHPet.sleepState().faces')
  ok('三张睡脸都能用（' + JSON.stringify(faces) + '）', Array.isArray(faces) && faces.length === 3, faces)
  const d = await ev('DSHPet.describe("睡·流口水")')
  ok('睡脸参数都存在', !!(d && d.allExist), d)
}

console.log('\n【2】入睡：闭眼 + 流口水 + 待机幅度压低')
{
  const r = await ev('DSHPet.sleepNow()')
  ok('sleepNow() 返回 true', r === true, r)
  await sleep(900)
  const s = await ev('DSHPet.sleepState()')
  ok('state.asleep = true', !!(s && s.asleep), s && s.asleep)
  ok('当前脸是睡脸（' + (s && s.face) + '）', !!(s && /^睡·/.test(String(s.face))), s && s.face)
  const eL = await outOf('ParamEyeLOpen')
  const eR = await outOf('ParamEyeROpen')
  const exp5 = await outOf('PARAM_EXP5')
  ok('EyeLOpen 写入 -1（自然的闭眼）', eL !== null && eL <= -0.99, eL)
  ok('EyeROpen 写入 -1（自然的闭眼）', eR !== null && eR <= -0.99, eR)
  // 睡脸故意不用 EXP5（那是 >< 挤眼素材），所以这里必须没写它
  ok('PARAM_EXP5 保持 0（不用挤眼素材）', exp5 === 0, exp5)
  const level = await ev('DSHPet.sleepState().idleLevel')
  ok('待机幅度被压低到 0.55×（' + level + '）', typeof level === 'number' && level > 0 && level <= 0.56, level)
  await shot('1-流口水')
}

console.log('\n【3】换嘴：三张睡脸硬切')
{
  await ev('DSHPet.sleepFace(1)')
  await sleep(500)
  const s = await ev('DSHPet.sleepState()')
  ok('切到第 2 张（' + (s && s.face) + '）', !!(s && s.face === '睡·3嘴'), s && s.face)
  ok('PARAM_EXP2 = 1（3嘴）', (await outOf('PARAM_EXP2')) === 1, await outOf('PARAM_EXP2'))
  ok('PARAM_EXP7 = 0（旧的流口水已撤）', (await outOf('PARAM_EXP7')) === 0, await outOf('PARAM_EXP7'))
  await shot('2-3嘴')

  await ev('DSHPet.sleepFace(2)')
  await sleep(500)
  const s2 = await ev('DSHPet.sleepState()')
  ok('切到第 3 张（' + (s2 && s2.face) + '）', !!(s2 && s2.face === '睡·〇嘴'), s2 && s2.face)
  ok('PARAM_EXP8 = 1（〇嘴）', (await outOf('PARAM_EXP8')) === 1, await outOf('PARAM_EXP8'))
  ok('PARAM_EXP2 = 0（3嘴已撤）', (await outOf('PARAM_EXP2')) === 0, await outOf('PARAM_EXP2'))
  await shot('3-〇嘴')
}

console.log('\n【4】叫醒：快速圈圈眼，然后回到平常')
{
  const r = await ev('DSHPet.wakeNow("debug")')
  ok('wakeNow() 返回 true', r === true, r)
  await sleep(160)
  const exp5 = await outOf('PARAM_EXP5')
  ok('醒来瞬间 PARAM_EXP5 = 1（圈圈眼）', exp5 === 1, exp5)
  const eye = await outOf('ParamEyeLOpen')
  ok('眼睛不再被闭眼压着（' + eye + '）', eye !== null && eye > -0.5, eye)
  const s = await ev('DSHPet.sleepState()')
  ok('asleep 已清除、lastWake.reason=debug', !!(s && !s.asleep && s.lastWake && s.lastWake.reason === 'debug'), s && s.lastWake)
  await shot('4-醒来-懵')
  await sleep(900)
  ok('过场结束后 PARAM_EXP5 回到 0', (await outOf('PARAM_EXP5')) === 0, await outOf('PARAM_EXP5'))
  const s2 = await ev('DSHPet.sleepState()')
  ok('待机幅度已还原（' + s2.idleLevel + '）', typeof s2.idleLevel === 'number' && s2.idleLevel > 0.56, s2.idleLevel)
  await shot('5-醒后平常')
}

console.log('\n【5】唤醒手势（真机模拟光标）：5 秒悬停 / 身边甩动')
{
  // 找她身上一个点：扫 canvas 矩形，DSHPet.hitTest 命中即可
  const info = await ev(`(function(){
    const el = document.querySelector('canvas'); if (!el) return null;
    const b = el.getBoundingClientRect();
    for (let gy = 0.25; gy <= 0.75; gy += 0.05) for (let gx = 0.3; gx <= 0.7; gx += 0.05) {
      const x = Math.round(b.left + b.width * gx), y = Math.round(b.top + b.height * gy);
      if (DSHPet.hitTest(x, y)) return { x: x, y: y, w: b.width, h: b.height };
    }
    return null;
  })()`)
  ok('能在画布上找到她身上的点', !!(info && info.x), info)
  const move = (x, y) => c.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y, button: 'none', buttons: 0 })
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  if (info) {
    // —— 5 秒悬停：必须"慢慢挪过去"，否则一次跳跃会被判成甩动 ——
    await ev('DSHPet.sleepNow()')
    await wait(500)
    await move(10, 10)
    await wait(300)
    let x = 10, y = 10
    while (Math.hypot(info.x - x, info.y - y) > 30) {
      const dx = info.x - x, dy = info.y - y, d = Math.hypot(dx, dy)
      x += dx / d * 30
      y += dy / d * 30
      await move(Math.round(x), Math.round(y))
      await wait(70)
    }
    await move(info.x, info.y)
    await wait(5600)
    const s = await ev('DSHPet.sleepState()')
    ok('身上停 5 秒 → 被叫醒（hover）', !s.asleep && s.lastWake && s.lastWake.reason === 'hover', s.lastWake)
    await wait(1200)

    // —— 身边甩动：一次大跨度移动，速度超过阈值 ——
    await ev('DSHPet.sleepNow()')
    await wait(500)
    await move(10, 10)
    await wait(300)
    await move(info.x, info.y)
    await wait(600)
    const s2 = await ev('DSHPet.sleepState()')
    ok('身边快速甩动 → 被叫醒（swish）', !s2.asleep && s2.lastWake && s2.lastWake.reason === 'swish', s2.lastWake)
    await wait(1200)
  }
}

console.log('\n' + '='.repeat(52))
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
c.close()
process.exit(fail === 0 ? 0 : 1)
