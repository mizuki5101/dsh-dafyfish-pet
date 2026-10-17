/**
 * 判断 ParamAngleY 哪个方向是「低头」。
 *
 * 为什么不能只看质心：旋转类参数绕枢轴转，上下部分反向移动，质心几乎不动
 * （实测 ±30 只差 30px，还都是负的，看不出方向）。
 * 正确做法：把被带动的顶点按高度分成上下两半，看它们各自往哪走 ——
 * 反向移动才说明是旋转，而"上半往前/下半往后"就能定出低头还是抬头。
 */
import fs from 'node:fs'
import { loadModel } from 'file:///D:/AI_work_space/_research/cubism-loader.mjs'
const OUT = []; const say = (...a) => OUT.push(a.join(' '))
const { model } = await loadModel()
const D = model.drawables, P = model.parameters
const pids = Array.from({ length: P.count }, (_, i) => (typeof P.ids[i] === 'string' ? P.ids[i] : String(P.ids[i])))
const counts = Array.from(D.vertexCounts)
const offs = []; let acc = 0
for (let i = 0; i < D.count; i++) { offs.push(acc); acc += counts[i] * 2 }
const PPU = (model.canvasinfo || {}).PixelsPerUnit || 3326
const reset = () => P.values.set(P.defaultValues)
const set = (id, v) => { const i = pids.indexOf(id); if (i >= 0) P.values[i] = v }

function all() {
  const o = new Float32Array(acc)
  for (let i = 0; i < D.count; i++) o.set(D.vertexPositions[i], offs[i])
  return o
}

// 只关心「头部」：用 ParamAngleY 全量程时被带动的顶点集合
reset(); model.update(); const base = all()
reset(); set('ParamAngleY', 30); model.update(); const hi = all()
reset(); set('ParamAngleY', -30); model.update(); const lo = all()

const idx = []
for (let k = 0; k < acc / 2; k++) {
  const d = Math.hypot(hi[k * 2] - base[k * 2], hi[k * 2 + 1] - base[k * 2 + 1])
  if (d > 1e-5) idx.push(k)
}
say('ParamAngleY 带动 ' + idx.length + ' 个顶点')

// 按基准高度排序，取上 30% / 下 30%
idx.sort((a, b) => base[b * 2 + 1] - base[a * 2 + 1])   // y 向上为正 → 降序 = 从高到低
const n = Math.floor(idx.length * 0.3)
const top = idx.slice(0, n), bot = idx.slice(-n)

function avgDy(arr, cur) {
  let s = 0
  for (const k of arr) s += cur[k * 2 + 1] - base[k * 2 + 1]
  return (s / arr.length) * PPU
}
function avgDx(arr, cur) {
  let s = 0
  for (const k of arr) s += cur[k * 2] - base[k * 2]
  return (s / arr.length) * PPU
}

say('')
say('  推向   头顶(上30%)        下巴(下30%)')
for (const [v, cur] of [[30, hi], [-30, lo]]) {
  const ty = avgDy(top, cur), by = avgDy(bot, cur)
  const tx = avgDx(top, cur), bx = avgDx(bot, cur)
  say('  ' + String(v).padStart(4) + '   Δy=' + ty.toFixed(0).padStart(6) + 'px Δx=' + tx.toFixed(0).padStart(6) +
      '   Δy=' + by.toFixed(0).padStart(6) + 'px Δx=' + bx.toFixed(0).padStart(6) +
      '   ' + (ty * by < 0 ? '（上下反向 → 是旋转）' : '（同向 → 像平移）'))
  say('        ' + (by < ty ? '下巴相对往下 → **低头**' : '下巴相对往上 → **抬头**'))
}
say('')
say('结论：ParamAngleY')
for (const [v, cur] of [[30, hi], [-30, lo]]) {
  const ty = avgDy(top, cur), by = avgDy(bot, cur)
  say('  ' + String(v).padStart(4) + ' → ' + (by < ty ? '低头（下巴往下）' : '抬头（下巴往上）'))
}
fs.writeFileSync('D:/AI_work_space/live2D桌宠/_research-data/点头方向.txt', OUT.join('\n'), 'utf8')
