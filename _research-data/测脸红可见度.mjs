/** 脸红只影响 1 个 drawable —— 量一下它有多大，判断够不够看得见。 */
import fs from 'node:fs'
import { loadModel } from 'file:///D:/AI_work_space/_research/cubism-loader.mjs'
const OUT = []; const say = (...a) => OUT.push(a.join(' '))
const { model } = await loadModel()
const D = model.drawables, P = model.parameters
const ids = D.ids.map((v) => (typeof v === 'string' ? v : String(v)))
const pids = Array.from({ length: P.count }, (_, i) => (typeof P.ids[i] === 'string' ? P.ids[i] : String(P.ids[i])))
const counts = Array.from(D.vertexCounts)
const PPU = (model.canvasinfo || {}).PixelsPerUnit || 3326
const W = (model.canvasinfo || {}).CanvasWidth || 3326
const H = (model.canvasinfo || {}).CanvasHeight || 4992
const reset = () => P.values.set(P.defaultValues)

function bbox(drawableNames) {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, n = 0
  for (const nm of drawableNames) {
    const i = ids.indexOf(nm); if (i < 0) continue
    const vp = D.vertexPositions[i], c = counts[i]
    for (let k = 0; k < c; k++) {
      const x = vp[k * 2] * PPU, y = vp[k * 2 + 1] * PPU
      if (x < x0) x0 = x; if (x > x1) x1 = x
      if (y < y0) y0 = y; if (y > y1) y1 = y
    }
    n += c
  }
  return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0, n }
}

/** 某参数从默认推到 v 时，被「显示出来」的 drawable（透明度从 0 变 >0） */
function shownBy(id, v) {
  reset(); model.update()
  const base = Array.from(D.opacities)
  reset(); P.values[pids.indexOf(id)] = v; model.update()
  const cur = Array.from(D.opacities)
  const out = []
  for (let i = 0; i < D.count; i++) if (cur[i] > base[i] + 1e-4) out.push(ids[i])
  return out
}

say('画布 ' + W + ' × ' + H + ' px')
say('')
for (const [id, v, label] of [['PARAM_EXP4', 1, '04 脸红'], ['PARAM_EXP5', 1, '05 O O 圈圈眼'], ['PARAM_EXP5', -1, '05 》《 闭眼']]) {
  const shown = shownBy(id, v)
  const bb = bbox(shown)
  say(id + '=' + v + '  ' + label)
  say('  显示出 ' + shown.length + ' 个 drawable：' + shown.slice(0, 8).join(',') + (shown.length > 8 ? ',…' : ''))
  if (bb.n) {
    say('  合计包围盒 ' + bb.w.toFixed(0) + ' × ' + bb.h.toFixed(0) + ' px（占画布宽 ' + (bb.w / W * 100).toFixed(1) + '%，高 ' + (bb.h / H * 100).toFixed(1) + '%），中心 x=' + ((bb.x0 + bb.x1) / 2).toFixed(0) + ' y=' + ((bb.y0 + bb.y1) / 2).toFixed(0))
    say('  折到屏幕上（桌宠缩放约 0.136）≈ ' + (bb.w * 0.136).toFixed(0) + ' × ' + (bb.h * 0.136).toFixed(0) + ' 屏幕像素')
  }
  say('')
}
fs.writeFileSync('D:/AI_work_space/live2D桌宠/_research-data/脸红可见度.txt', OUT.join('\n'), 'utf8')
