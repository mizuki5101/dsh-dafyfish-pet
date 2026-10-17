/** 量眉毛/嘴的方向，用来把「微笑 / 生气」这两个死项重新绑到真能生效的参数上。 */
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

function centroid(names) {
  let sx = 0, sy = 0, n = 0
  for (const nm of names) {
    const i = ids.indexOf(nm); if (i < 0) continue
    const vp = D.vertexPositions[i], c = counts[i]
    for (let k = 0; k < c; k++) { sx += vp[k * 2]; sy += vp[k * 2 + 1] }
    n += c
  }
  return n ? { x: (sx / n) * PPU, y: (sy / n) * PPU, n } : null
}

const CAND = ['ParamBrowLAngle', 'ParamBrowRAngle', 'ParamBrowLForm', 'ParamBrowRForm', 'ParamMouthForm', 'ParamEyePuff']
say('=== 眉毛 / 嘴 / 眼袋 的方向 ===')
for (const id of CAND) {
  const r = byId[id]
  if (!r) { say('  ' + id + ' 不在模型里'); continue }
  const meshes = (r.movedDrawableIds || []).map((s) => String(s).split(':')[0])
  say('')
  say('  ' + id + '  范围[' + r.min + ',' + r.max + '] 默认' + r.default + '  影响 ' + r.movedVertsMax + ' 点 / ' + r.maxDisplacementPx.toFixed(1) + 'px')
  const rows = []
  for (const v of [r.min, r.max]) {
    if (v === r.default) continue
    reset(); model.update(); const b = centroid(meshes)
    reset(); set(id, v); model.update(); const c = centroid(meshes)
    const dx = c.x - b.x, dy = c.y - b.y
    rows.push({ v, dx, dy })
    const d = []
    if (Math.abs(dy) > 1.5) d.push(dy > 0 ? '↑上' : '↓下')
    if (Math.abs(dx) > 1.5) d.push(dx > 0 ? '→右' : '←左')
    say('    ' + String(v).padStart(5) + '  Δx=' + dx.toFixed(1).padStart(7) + ' Δy=' + dy.toFixed(1).padStart(7) + '   ' + (d.join(' ') || '（<1.5px）'))
  }
  // 眉毛：往上 = 惊讶/温和；往下(且向内) = 生气
  if (id.startsWith('ParamBrow')) {
    const down = rows.slice().sort((a, b) => a.dy - b.dy)[0]
    const up = rows.slice().sort((a, b) => b.dy - a.dy)[0]
    say('    → 眉毛往**下**（生气/皱眉）= ' + id + ' ' + down.v + ' ；往**上**（惊讶）= ' + id + ' ' + up.v)
  }
}
fs.writeFileSync('D:/AI_work_space/live2D桌宠/_research-data/眉眼方向.txt', OUT.join('\n'), 'utf8')
