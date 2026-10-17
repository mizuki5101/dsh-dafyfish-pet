/**
 * 量「表情类」参数的方向 —— 准备给新动作用。
 * 眼睛看反方向是最容易被一眼看穿的错误，所以眼球必须实测。
 */
import fs from 'node:fs'
import { loadModel } from 'file:///D:/AI_work_space/_research/cubism-loader.mjs'
const OUT = []; const say = (...a) => OUT.push(a.join(' '))
const { model } = await loadModel()
const D = model.drawables, P = model.parameters
const ids = D.ids.map((v) => (typeof v === 'string' ? v : String(v)))
const pids = Array.from({ length: P.count }, (_, i) => (typeof P.ids[i] === 'string' ? P.ids[i] : String(P.ids[i])))
const counts = Array.from(D.vertexCounts)
const PPU = (model.canvasinfo || {}).PixelsPerUnit || 3326
const reset = () => P.values.set(P.defaultValues)
const set = (id, v) => { const i = pids.indexOf(id); if (i >= 0) P.values[i] = v }
const infl = JSON.parse(fs.readFileSync('D:/AI_work_space/live2D桌宠/_research-data/param-influence.json', 'utf8'))
const byId = Object.fromEntries(infl.results.map((r) => [r.id, r]))
const rig = JSON.parse(fs.readFileSync('D:/AI_work_space/live2D桌宠/pet-plugin/assets/model/rig-params.json', 'utf8'))

function verts(name) {
  const i = ids.indexOf(name)
  if (i < 0) return null
  const vp = D.vertexPositions[i], c = counts[i]
  const out = []
  for (let k = 0; k < c; k++) out.push([vp[k * 2], vp[k * 2 + 1]])
  return out
}
function centroid(names) {
  let sx = 0, sy = 0, n = 0
  for (const nm of names) { const v = verts(nm); if (!v) continue; for (const [x, y] of v) { sx += x; sy += y; n++ } }
  return n ? { x: (sx / n) * PPU, y: (sy / n) * PPU, n } : null
}
const dirTxt = (dx, dy, t = 1) => {
  const p = []
  if (Math.abs(dy) > t) p.push(dy > 0 ? '↑上' : '↓下')
  if (Math.abs(dx) > t) p.push(dx > 0 ? '→右' : '←左')
  return p.length ? p.join(' ') : '（<1px）'
}

say('=== 准备用的表情参数的取值范围 ===')
for (const id of ['ParamEyeBallX', 'ParamEyeBallY', 'ParamEyePuff', 'ParamBrowLAngle', 'ParamBrowRAngle',
                  'ParamBrowLForm', 'ParamBrowRForm', 'ParamMouthForm', 'ParamMouthX', 'ParamMouthOpenY',
                  'PARAM_EXP1', 'PARAM_EXP2', 'PARAM_EXP3', 'PARAM_EXP4', 'PARAM_EXP5', 'PARAM_EXP6', 'PARAM_EXP7', 'PARAM_EXP8']) {
  const r = rig.ranges[id]
  const inf = byId[id]
  say('  ' + id.padEnd(17) + (r ? '[' + r[0] + ',' + r[1] + '] def ' + r[2] : '(不在表里)').padEnd(20) +
      ' role=' + (rig.role[id] || '?').padEnd(5) +
      ' 顶点 ' + String(inf ? inf.movedVertsMax : '?').padStart(5) +
      ' 位移 ' + (inf ? inf.maxDisplacementPx.toFixed(1) : '?').padStart(6) + 'px' +
      ' 透明变化 ' + (inf ? (inf.opacityChangedMax + inf.opacityChangedMin) : '?'))
}

say('')
say('=== 眼球方向（必须实测，看反了最明显）===')
const eyeMeshes = (byId['ParamEyeBallX']?.movedDrawableIds || []).map((s) => String(s).split(':')[0])
say('  眼球部件: ' + eyeMeshes.join(', '))
for (const id of ['ParamEyeBallX', 'ParamEyeBallY']) {
  for (const v of [1, -1]) {
    reset(); model.update(); const b = centroid(eyeMeshes)
    reset(); set(id, v); model.update(); const c = centroid(eyeMeshes)
    say('  ' + id.padEnd(15) + String(v).padStart(3) + '  Δx=' + (c.x - b.x).toFixed(1).padStart(6) + 'px Δy=' + (c.y - b.y).toFixed(1).padStart(6) + 'px  ' + dirTxt(c.x - b.x, c.y - b.y, 0.5))
  }
}

say('')
say('=== 嘴形方向：看**嘴角**而不是质心（微笑是嘴角上翘）===')
const mouthMeshes = (byId['ParamMouthForm']?.movedDrawableIds || []).map((s) => String(s).split(':')[0])
function corners(names) {
  const pts = []
  for (const nm of names) { const v = verts(nm); if (v) pts.push(...v) }
  if (!pts.length) return null
  pts.sort((a, b) => a[0] - b[0])
  const k = Math.max(1, Math.floor(pts.length * 0.2))
  const left = pts.slice(0, k), right = pts.slice(-k)
  const avg = (arr) => ({ x: arr.reduce((s, p) => s + p[0], 0) / arr.length * PPU, y: arr.reduce((s, p) => s + p[1], 0) / arr.length * PPU })
  return { L: avg(left), R: avg(right) }
}
for (const id of ['ParamMouthForm', 'ParamMouthX', 'ParamMouthOpenY']) {
  const r = rig.ranges[id]
  for (const v of [r ? r[1] : 1, r ? r[0] : -1]) {
    if (r && v === r[2]) continue
    reset(); model.update(); const b = corners(mouthMeshes)
    reset(); set(id, v); model.update(); const c = corners(mouthMeshes)
    const dL = (c.L.y - b.L.y), dR = (c.R.y - b.R.y)
    const smile = (dL > 0 && dR > 0) ? '嘴角**上翘 = 笑**' : (dL < 0 && dR < 0) ? '嘴角**下弯 = 撇嘴**' : '嘴角一上一下'
    say('  ' + id.padEnd(16) + String(v).padStart(5) + '  左嘴角 Δy=' + dL.toFixed(1).padStart(6) + 'px  右嘴角 Δy=' + dR.toFixed(1).padStart(6) + 'px  ' + smile)
  }
}
fs.writeFileSync('D:/AI_work_space/live2D桌宠/_research-data/表情方向.txt', OUT.join('\n'), 'utf8')
