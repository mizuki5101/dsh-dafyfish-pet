/**
 * 表情页逐项验证：点下去**真的**推动了对应参数。
 *
 * 为什么必须验：这一页长期只有 3 个按钮，而且「脸红」还曾经指向圈圈眼
 * （manifest 那张表错位一位）。加表情时照名字猜是**已经栽过一次**的事，
 * 所以每一项都在真实页面里点一遍、看参数。
 *
 * ⚠️ 看的是 debug.out（applyRig 里写的偏移），不是 paramValue() ——
 *    帧末 loadParameters() 会还原快照，帧外读永远是旧值。
 */
import fs from 'node:fs'
import path from 'node:path'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const t = list.find((x) => x.type === 'page' && x.url.includes('/dsh-pet/'))
if (!t) { console.error('找不到桌宠页面'); process.exit(2) }
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let seq = 0
const ev = (expr) => new Promise((res, rej) => {
  const id = ++seq
  const to = setTimeout(() => rej(new Error('timeout')), 12000)
  const on = (m) => { const d = JSON.parse(m.data); if (d.id !== id) return; clearTimeout(to); ws.removeEventListener('message', on); const v = d.result?.result?.value; try { res(JSON.parse(v)) } catch (e) { res(v) } }
  ws.addEventListener('message', on)
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify(' + expr + ')', returnByValue: true } }))
})
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

const MF = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'pet-plugin', 'assets', 'model', 'manifest.json'), 'utf8'))
// FACE_MENU 不是全局变量，这里按同样顺序列出（加表情时两边一起改）
const ORDER = ['脸红', '生气', '挤眼', '担心嘴', '栗子嘴', '龇牙', '流口水', '脸黑', '圈圈眼']
/** 「口型」页是另一张表（纯换嘴素材），也要逐项验 */
const MOUTH = ['口型切换', '3嘴', '〇嘴']

// 打开菜单 → 切到表情页
await ev('(function(){ if(!DSHPet.menu().open){ var b=document.querySelectorAll(".dshp-dock > *")[1]; if(b) b.click(); } return true })()')
await sleep(450)
await ev('(function(){ var t=Array.from(document.querySelectorAll(".dshp-tab-btn")).find(function(b){return b.textContent==="表情"}); if(t)t.click(); return true })()')
await sleep(450)

const chips = await ev('Array.from(document.querySelectorAll(".dshp-panel.dshp-on .dshp-chip")).map(function(c){return {label:c.textContent, title:c.title}})')
console.log('菜单里的表情：' + JSON.stringify(chips.map((c) => c.label)))
ok(chips.length === 10, '表情页 10 项（平常 + 9 个表情，含主人点名加回来的圈圈眼）')
// 每一项都要"点了她会说话"—— 主人最初的抱怨就是"点了没反应"
const silent = chips.filter((c) => c.label !== '平常' && !String(c.title).includes('她会说'))
ok(silent.length === 0, '每一项都配了台词' + (silent.length ? '（缺：' + silent.map((c) => c.label).join(',') + '）' : ''))
console.log('')

for (const expr of ORDER) {
  const def = MF.expressions[expr]
  if (!def) { ok(false, expr + ' 不在 manifest 里'); continue }
  const params = def.params.map((p) => ({ id: p.id, value: p.value }))
  await ev('DSHPet.clearUserFace()'); await ev('DSHPet.clearReaction()')
  await sleep(500)
  const clicked = await ev('(function(){var b=Array.from(document.querySelectorAll(".dshp-chip")).find(function(c){return c.textContent===' + JSON.stringify(expr) + '}); if(!b) return false; b.click(); return true})()')
  if (!clicked) { ok(false, expr + ' 按钮没找到'); continue }
  // 采样看参数有没有被推动
  const peak = {}
  for (let i = 0; i < 14; i++) {
    const s = await ev('DSHPet.motionState()')
    const o = s.debug.out || {}
    for (const p of params) {
      const v = o[p.id]
      if (v === undefined) continue
      const rel = p.value > 0 ? v : -v          // 取"朝目标方向"的量
      if (!(p.id in peak) || rel > peak[p.id]) peak[p.id] = rel
    }
    await sleep(85)
  }
  const detail = params.map((p) => p.id + '=' + (peak[p.id] === undefined ? 'n/a' : peak[p.id].toFixed(2)) + '(目标' + p.value + ')').join(', ')
  const good = params.every((p) => peak[p.id] !== undefined && peak[p.id] > 0.35)
  ok(good, expr.padEnd(6) + ' ' + detail)
  // 顺手确认点完之后她真的开口了（气泡里有字）
  const bub = await ev('(document.querySelector(".dshp-bubble")||{}).textContent||""')
  if (!String(bub).trim()) ok(false, expr + ' 点了之后气泡是空的（"点了没反应"的观感来源）')
}
console.log('')
console.log('=== 口型页 ===')
await ev('(function(){ var t=Array.from(document.querySelectorAll(".dshp-tab-btn")).find(function(b){return b.textContent==="口型"}); if(t)t.click(); return true })()')
await sleep(450)
const mchips = await ev('Array.from(document.querySelectorAll(".dshp-panel.dshp-on .dshp-chip")).map(function(c){return {label:c.textContent, title:c.title}})')
ok(mchips.length === 4, '口型页 4 项（平常 + 3 个换嘴素材）：' + JSON.stringify(mchips.map((c) => c.label)))
const msilent = mchips.filter((c) => c.label !== '平常' && !String(c.title).includes('她会说'))
ok(msilent.length === 0, '口型页每一项也都配了台词' + (msilent.length ? '（缺：' + msilent.map((c) => c.label).join(',') + '）' : ''))
for (const expr of MOUTH) {
  const def = MF.expressions[expr]
  if (!def) { ok(false, expr + ' 不在 manifest 里'); continue }
  const params = def.params.map((p) => ({ id: p.id, value: p.value }))
  await ev('DSHPet.clearUserFace()'); await ev('DSHPet.clearReaction()')
  await sleep(450)
  const clicked = await ev('(function(){var b=Array.from(document.querySelectorAll(".dshp-chip")).find(function(c){return c.textContent===' + JSON.stringify(expr) + '}); if(!b) return false; b.click(); return true})()')
  if (!clicked) { ok(false, expr + ' 按钮没找到'); continue }
  const peak = {}
  for (let i = 0; i < 12; i++) {
    const st = await ev('DSHPet.motionState()')
    const o = st.debug.out || {}
    for (const p of params) {
      const v = o[p.id]
      if (v === undefined) continue
      const rel = p.value > 0 ? v : -v
      if (!(p.id in peak) || rel > peak[p.id]) peak[p.id] = rel
    }
    await sleep(85)
  }
  const detail = params.map((p) => p.id + '=' + (peak[p.id] === undefined ? 'n/a' : peak[p.id].toFixed(2)) + '(目标' + p.value + ')').join(', ')
  ok(params.every((p) => peak[p.id] !== undefined && peak[p.id] > 0.35), expr.padEnd(6) + ' ' + detail)
}

await ev('DSHPet.clearUserFace()'); await ev('DSHPet.clearReaction()')
await ev('(function(){ if(DSHPet.menu().open){ var b=document.querySelectorAll(".dshp-dock > *")[1]; if(b) b.click(); } return true })()')
ws.close()
console.log('\n========================================')
console.log(fail === 0 ? `表情+口型验证通过：${pass} 项` : `⚠ 失败 ${fail} / 通过 ${pass}`)
process.exit(fail ? 1 : 0)
