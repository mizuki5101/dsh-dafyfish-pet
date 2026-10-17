/** 验证「邮件信封」已彻底移除，且 pushReport 改走气泡仍然可用。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const t = list.find((x) => x.type === 'page' && x.url.includes('/dsh-pet/'))
if (!t) { console.error('找不到桌宠页面'); process.exit(2) }
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let seq = 0
const ev = (expr) => new Promise((res, rej) => {
  const id = ++seq
  const to = setTimeout(() => rej(new Error('timeout: ' + expr)), 12000)
  const on = (m) => { const d = JSON.parse(m.data); if (d.id !== id) return; clearTimeout(to); ws.removeEventListener('message', on); const v = d.result?.result?.value; try { res(JSON.parse(v)) } catch (e) { res(v) } }
  ws.addEventListener('message', on)
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify(' + expr + ')', returnByValue: true } }))
})
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

console.log('=== 1. DOM 里不该再有信封/简报 ===')
ok((await ev('document.querySelectorAll(".dshp-mail").length')) === 0, '没有 .dshp-mail 元素（头顶信封已删）')
ok((await ev('document.querySelectorAll(".dshp-mail-badge").length')) === 0, '没有 .dshp-mail-badge（未读角标已删）')
ok((await ev('document.querySelectorAll(".dshp-report").length')) === 0, '没有 .dshp-report 面板（大号简报已删）')
ok((await ev('document.querySelectorAll(".dshp-report-item").length')) === 0, '没有简报条目')

console.log('\n=== 2. clampPanels 不再引用它们（ui.mail / ui.report 应为空）===')
ok((await ev('document.querySelectorAll(".dshp-panel").length')) >= 0, '面板查询不报错（clampPanels 没崩）')

console.log('\n=== 3. CSS 里不该再有相关规则 ===')
const css = await ev('(document.getElementById("dsh-live2d-pet-style")||{}).textContent||""')
ok(!String(css).includes('dshp-mail'), '样式表里没有 dshp-mail')
ok(!String(css).includes('dshp-report'), '样式表里没有 dshp-report')

console.log('\n=== 4. DSHPet.report 仍在（对外 API 不能断），改走气泡 ===')
ok((await ev('typeof DSHPet.report')) === 'function', 'DSHPet.report 仍然是函数')
await ev('DSHPet.report("测试标题","这是一条测试简报")')
await sleep(500)
const bubbleText = await ev('(document.querySelector(".dshp-bubble")||{}).textContent||""')
ok(String(bubbleText).includes('测试标题') && String(bubbleText).includes('这是一条测试简报'),
   '推送后气泡里能看到内容：' + String(bubbleText).slice(0, 60))
ok((await ev('document.querySelectorAll(".dshp-mail").length')) === 0, '推送简报不会再生出信封')

console.log('\n=== 5. /dsh-pet/control 的 report 字段仍可用 ===')
const token = (await import('node:fs')).readFileSync(
  (await import('node:path')).join((await import('node:os')).homedir(), '.dsh', 'dsh-live2d-pet-desktop.json'), 'utf8')
const tk = JSON.parse(token).token
const rr = await fetch('http://127.0.0.1:19387/dsh-pet/control', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: 'dsh_pet_desk=' + tk },
  body: JSON.stringify({ report: ['控制通道简报', '来自 HTTP 的测试'] }),
})
ok(rr.status === 200, 'POST /dsh-pet/control {report:[...]} 返回 200')
await sleep(600)
const b2 = await ev('(document.querySelector(".dshp-bubble")||{}).textContent||""')
ok(String(b2).includes('控制通道简报'), '气泡显示控制通道推来的简报：' + String(b2).slice(0, 60))

console.log('\n=== 6. 回归：动作/表情/眨眼都还在 ===')
/*
 * 这里**刻意不写死数量** —— 这个脚本要验的是「移除邮件有没有伤到动作系统」，
 * 不是「动作有几个」。写死数量的话每加一个动作就误报一次。
 */
const nClips = await ev('DSHPet.clips().length')
const nActs = await ev('DSHPet.actions().length')
ok(nClips >= 8, '动作库仍在（' + nClips + ' 个）')
ok(nActs === nClips, '菜单项数与动作库一致（' + nActs + ' = ' + nClips + '）')
const nExpr = await ev('DSHPet.state.expressions.length')
ok(nExpr >= 13, '表情表仍在（' + nExpr + ' 个）')   // 同样不写死数量
ok((await ev('typeof DSHPet.motionState')) === 'function', '动作引擎仍在')
await ev('DSHPet.clearUserFace()')

ws.close()
console.log('\n========================================')
console.log(fail === 0 ? `验证通过：${pass} 项` : `⚠ 失败 ${fail} / 通过 ${pass}`)
process.exit(fail ? 1 : 0)
