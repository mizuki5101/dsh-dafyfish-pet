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
const ORDER = ['脸红', '生气', '挤眼', '担心嘴', '栗子嘴', '龇牙', '流口水', '脸黑', '圈圈眼', '疑惑', '怀疑', '嫌弃', '挑眉']
/*
 * 观感锁（2026-10-17，主人反馈「三个表情看不出区别」之后加的）：
 *   · ParamEyeLOpen 的「闭」是**负偏移**（范围 [0,1]、默认 1）——
 *     写 +0.7 会被夹回 1，等于没写。这就是「撇嘴没有半眯眼」的根因。
 *   · 下面的区间是照着「一眼能看出来」定的；谁把它改小，这里立刻红。
 *   · 根参数（ParamAngleX/Y/Z）不放进逐项采样：待机层也在写它们，
 *     debug.out 是总和，分不清是表情还是待机；这里直接锁 manifest 的数值。
 */
const LOOK_LOCK = {
  疑惑: {
    ParamMouthX: [0.9, 1], ParamEyeLOpen: [-0.4, -0.2],
    ParamBrowLForm: [0.9, 1], ParamBrowLAngle: [0.4, 0.6], ParamAngleZ: [5, 7],
  },
  怀疑: {
    ParamBrowRForm: [0.9, 1], ParamBrowRAngle: [0.9, 1], ParamEyeLOpen: [-0.5, -0.3],
    ParamEyeBallX: [-0.45, -0.25], ParamEyeBallY: [0.35, 0.55],
    ParamAngleZ: [-12, -8], ParamAngleX: [-6, -2],
  },
  嫌弃: {
    ParamBrowLAngle: [0.9, 1], ParamBrowRAngle: [0.9, 1],
    ParamBrowLForm: [0.5, 0.7], ParamBrowRForm: [0.5, 0.7],
    ParamEyeBallY: [-0.6, -0.4], ParamEyeLOpen: [-0.5, -0.3], ParamEyeROpen: [-0.5, -0.3],
    PARAM_EXP7: [-1, -0.9], ParamAngleY: [-8, -4], ParamAngleZ: [-5, -3],
    // 主人拍板：没有泪眼，委屈读不出来 → 改成「嫌弃」= 脸黑 + 眯眼。
    // 0.7 是「脸还看得见眯眼」的深度；1.0 会把眼睛整个盖掉。
    PARAM_EXP3: [0.6, 0.8],
  },
  挑眉: {
    // 主人：换到屏幕左眉后还是不明显 → 再把另一条眉压低 + 歪头 12° + 转头 5°
    ParamBrowRForm: [0.9, 1], ParamBrowRAngle: [0.9, 1],
    ParamBrowLForm: [-0.6, -0.4], ParamBrowLAngle: [-0.5, -0.3],
    ParamEyeBallY: [0.35, 0.55], ParamEyeBallX: [-0.45, -0.25],
    ParamAngleZ: [-14, -10], ParamAngleX: [-7, -3],
  },
}
console.log('\n=== 0. 观感锁：四个新表情的方向与幅度 ===')
for (const [expr, want] of Object.entries(LOOK_LOCK)) {
  const ps = (MF.expressions[expr] && MF.expressions[expr].params) || []
  const bad = []
  for (const [id, [lo, hi]] of Object.entries(want)) {
    const p = ps.find((x) => x.id === id)
    if (!p) bad.push(id + ' 缺失')
    else if (!(p.value >= lo && p.value <= hi)) bad.push(id + '=' + p.value + '（应 ' + lo + '~' + hi + '）')
  }
  ok(bad.length === 0, expr + ' 观感锁' + (bad.length ? '：' + bad.join('；') : '：方向/幅度都在预期区间'))
}

/** 「口型」页是另一张表（纯换嘴素材），也要逐项验 */
const MOUTH = ['口型切换', '3嘴', '〇嘴']

// 打开菜单 → 切到表情页
await ev('(function(){ if(!DSHPet.menu().open){ var b=document.querySelectorAll(".dshp-dock > *")[1]; if(b) b.click(); } return true })()')
await sleep(450)
await ev('(function(){ var t=Array.from(document.querySelectorAll(".dshp-tab-btn")).find(function(b){return b.textContent==="表情"}); if(t)t.click(); return true })()')
await sleep(450)

const chips = await ev('Array.from(document.querySelectorAll(".dshp-panel.dshp-on .dshp-chip")).map(function(c){return {label:c.textContent, title:c.title}})')
console.log('菜单里的表情：' + JSON.stringify(chips.map((c) => c.label)))
ok(chips.length === 14, '表情页 14 项（平常 + 13 个表情，含主人点名加回来的圈圈眼 + 新加的疑惑/怀疑/嫌弃/挑眉）')
// 每一项都要"点了她会说话"—— 主人最初的抱怨就是"点了没反应"
const silent = chips.filter((c) => c.label !== '平常' && !String(c.title).includes('她会说'))
ok(silent.length === 0, '每一项都配了台词' + (silent.length ? '（缺：' + silent.map((c) => c.label).join(',') + '）' : ''))
console.log('')

for (const expr of ORDER) {
  const def = MF.expressions[expr]
  if (!def) { ok(false, expr + ' 不在 manifest 里'); continue }
  // 根参数（AngleX/Y/Z）另在 LOOK_LOCK 里锁死；待机层也在写它们，逐项采样分不清归属
  const params = def.params.map((p) => ({ id: p.id, value: p.value })).filter((p) => !/^ParamAngle[XYZ]$/.test(p.id))
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
  // 0.2 的下限：0.3 的轻度半眯也要能过；方向与最小幅度由 LOOK_LOCK 负责
  const good = params.every((p) => peak[p.id] !== undefined && peak[p.id] > 0.2)
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
