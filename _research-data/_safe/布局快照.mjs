/**
 * 布局快照：把「她在某些位置时，气泡 / 工具栏的屏幕矩形」记下来（含输入）。
 *
 * 用途（2026-10-17 收尾）：气泡和 dock 的锚点/夹取抽成了一处，
 * 这种改动最怕「看着一样、其实差几像素」。所以改前拍一份、改后拍一份、逐个字段比。
 *
 * ⚠️ 两个坑（第一次比对就撞上了）：
 *   1. 必须把**输入**（视口 / root 矩形 / charInset / 元素尺寸）一起记下来 ——
 *      不然尺寸一变，输出的差值就分不清是「改了算法」还是「她本来就不一样大」。
 *   2. 必须等布局**稳定**再采样：reload 之后 fitModel/掩码测量是渐进完成的，
 *      抢在中间读到的 inset 是旧的，算出来的位置当然不同。
 *
 * 用法：node _research-data/_safe/布局快照.mjs <输出文件> [调试口]
 */
import fs from 'node:fs'
import { connect } from './cdp.mjs'

const out = process.argv[2] || 'layout-snapshot.json'
const port = Number(process.argv[3] || 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const c = await connect(port)

const readInputs = () => c.evaluate(`(function(){
  var r = document.querySelector('.dshp-root')
  var b = r.getBoundingClientRect()
  return { vw: window.innerWidth, vh: window.innerHeight,
           root: { left: Math.round(b.left), top: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) },
           insetX: r.style.getPropertyValue('--dshp-inset-x'),
           insetY: r.style.getPropertyValue('--dshp-inset-y') }
})()`)

// 等布局稳定：连续 3 次采到的输入完全一样才算稳（fitModel / 掩码测量是渐进的）
async function waitStable(maxMs) {
  let last = null, same = 0
  const t0 = Date.now()
  while (Date.now() - t0 < (maxMs || 10000)) {
    const now = JSON.stringify(await readInputs())
    if (now === last) same++; else { same = 0; last = now }
    if (same >= 3) return JSON.parse(now)
    await sleep(120)
  }
  return JSON.parse(last || '{}')
}

// 4 个有代表性的位置：右下（默认）/ 左上角 / 下边缘（气泡要翻）/ 右边缘贴边
const POSITIONS = [
  { name: '右下默认', left: 1105, top: 437 },
  { name: '左上角', left: 40, top: 40 },
  { name: '下边缘（气泡该翻上去）', left: 700, top: 820 },
  { name: '右边缘贴边', left: 1780, top: 300 },
]

const snap = []
for (const pos of POSITIONS) {
  await c.evaluate(`(function(){ var r=document.querySelector('.dshp-root'); r.style.left='${pos.left}px'; r.style.top='${pos.top}px'; DSHPet.say('布局快照用的气泡文字', { ttl: 6000 }); return 1 })()`)
  const inputs = await waitStable(6000)
  await sleep(250) // 让 placeBubble/placeDock 至少跑几跳（它们是 40ms 心跳里调的）
  const rects = await c.evaluate(`(function(){
    function R(sel){ var e=document.querySelector(sel); if(!e) return null; var b=e.getBoundingClientRect(); return { left: Math.round(b.left), top: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) } }
    return { bubble: R('.dshp-bubble'), dock: R('.dshp-dock'), inputs: (function(){
      var r = document.querySelector('.dshp-root'); var b = r.getBoundingClientRect();
      return { vw: window.innerWidth, vh: window.innerHeight, root: { left: Math.round(b.left), top: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }, insetX: r.style.getPropertyValue('--dshp-inset-x'), insetY: r.style.getPropertyValue('--dshp-inset-y') }
    })() }
  })()`);
  snap.push({ pos: pos.name, want: { left: pos.left, top: pos.top }, got: rects });
  console.log(pos.name + '  insetY=' + rects.inputs.insetY + '  root=' + JSON.stringify(rects.inputs.root));
  console.log('   气泡 ' + JSON.stringify(rects.bubble) + '   工具栏 ' + JSON.stringify(rects.dock));
}

await c.evaluate("(function(){ var r=document.querySelector('.dshp-root'); r.style.left='1105px'; r.style.top='437px'; DSHPet.say('回位了', { ttl: 1200 }); return 1 })()")
fs.writeFileSync(out, JSON.stringify(snap, null, 1), 'utf8')
console.log('已写出 ' + out)
c.close()