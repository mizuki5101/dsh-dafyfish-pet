/** 回归检查：确认新加的动作层没有破坏原有功能。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const t = list.find((x) => x.type === 'page' && x.url.includes('/dsh-pet/'))
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let seq = 0
const ev = (expr) => new Promise((res, rej) => {
  const id = ++seq
  const to = setTimeout(() => rej(new Error('timeout ' + expr)), 12000)
  const on = (m) => { const d = JSON.parse(m.data); if (d.id !== id) return; clearTimeout(to); ws.removeEventListener('message', on); const v = d.result?.result?.value; try { res(JSON.parse(v)) } catch (e) { res(v) } }
  ws.addEventListener('message', on)
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify(' + expr + ')', returnByValue: true } }))
})
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

console.log('=== 眨眼还正常吗 ===')
const b0 = await ev('DSHPet.blink()')
await sleep(15000)
const b1 = await ev('DSHPet.blink()')
ok(typeof b1.count === 'number', 'blink() 可用（phase=' + b1.phase + ', gate=' + b1.gate + '）')
ok(b1.count > b0.count, '15 秒内眨了 ' + (b1.count - b0.count) + ' 次（说明动作层没有把眨眼憋死）')

console.log('\n=== 表情（manifest）还正常吗 ===')
const nExpr = await ev('DSHPet.state.expressions.length')
ok(nExpr > 0, '可用表情 ' + nExpr + ' 个')
await ev('DSHPet.setUserFace("脸红")')
await sleep(600)
ok((await ev('DSHPet.menu().face')) === '脸红', 'setUserFace("脸红") 生效')
await ev('DSHPet.clearUserFace()')

console.log('\n=== 死参数（微笑/生气）确认无效（预期，非回归）===')
const a1 = await ev('DSHPet.paramValue("ParamEyeSmile")')
ok(a1 !== undefined, 'ParamEyeSmile 当前值 ' + a1 + '（物理输出，写了也会被覆盖——已在报告里记录）')

console.log('\n=== 命中测试 / 掩码还在吗 ===')
const ht = await ev('DSHPet.hitTest(400, 400)')
ok(ht !== undefined && ht !== null, 'hitTest 可用：' + JSON.stringify(ht).slice(0, 80))

console.log('\n=== 视觉相关状态 ===')
// 注意：DSHPet.state 是**属性**不是函数（自检页也是这么用的）
const s = await ev('DSHPet.state')
ok(!!(s && s.modelSize), '模型尺寸 ' + Math.round(s.modelSize.w) + '×' + Math.round(s.modelSize.h))
ok(s.view && s.view.scale > 0, '取景缩放 ' + s.view.scale)
ok(Array.isArray(s.motions) && s.motions.length === 0, 'manifest.motions 仍是空（新动作走 clip 引擎，没混进来）')
ok(Array.isArray(s.droppedParams), '参数过滤仍在工作（丢弃 ' + s.droppedParams.length + ' 个）')

ws.close()
console.log('\n========================================')
console.log(fail === 0 ? `回归检查通过：${pass} 项` : `⚠ 失败 ${fail} / 通过 ${pass}`)
process.exit(fail ? 1 : 0)
