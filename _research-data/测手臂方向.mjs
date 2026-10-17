/**
 * 量手臂参数到底把胳膊转到哪个方向。
 *
 * 动机：主人反馈「挥左手」时手藏到身后看不见，「挥右手」正常 ——
 * 典型的镜像骨架问题：左右手旋转在视觉上是反的，而我在 clip 里两边写了同一个正号。
 *
 * 顺带确认 canvas 的 y 轴朝向（用「嘴」和「尾巴」两个已知上下位置的部件比对）。
 */
import fs from 'node:fs'
import { loadModel } from 'file:///D:/AI_work_space/_research/cubism-loader.mjs'

const OUT = []
const say = (...a) => OUT.push(a.join(' '))

const { model } = await loadModel()
const D = model.drawables
const P = model.parameters
const ids = D.ids.map((v) => (typeof v === 'string' ? v : String(v)))
const counts = Array.from(D.vertexCounts)
const offs = []
let acc = 0
for (let i = 0; i < D.count; i++) { offs.push(acc); acc += counts[i] * 2 }
const TOTAL = acc

const canvas = model.canvasinfo || {}
const PPU = canvas.PixelsPerUnit || 3326
say('canvas: ' + (canvas.CanvasWidth || '?') + ' x ' + (canvas.CanvasHeight || '?') +
    ' | PixelsPerUnit ' + PPU + ' | drawable ' + D.count + ' | 顶点 ' + TOTAL / 2 + ' | 顶点单位 = 模型单位(画布宽=1)')

function reset() { P.values.set(P.defaultValues) }
function set(id, v) { const i = ids0.indexOf(id); if (i >= 0) P.values[i] = v }
const ids0 = Array.from({ length: P.count }, (_, i) => (typeof P.ids[i] === 'string' ? P.ids[i] : String(P.ids[i])))

function centroidOf(name) {
  const i = ids.indexOf(name)
  if (i < 0) return null
  const vp = D.vertexPositions[i], o = offs[i], n = counts[i]
  let sx = 0, sy = 0
  for (let k = 0; k < n; k++) { sx += vp[k * 2]; sy += vp[k * 2 + 1] }
  return { x: sx / n, y: sy / n, n }
}
function centroidOfMany(names) {
  let sx = 0, sy = 0, n = 0
  for (const nm of names) { const c = centroidOf(nm); if (c) { sx += c.x * c.n; sy += c.y * c.n; n += c.n } }
  return n ? { x: sx / n, y: sy / n, n } : null
}

// ——— y 轴朝向：嘴（在上）vs 尾巴（在下）———
reset(); model.update()
say('')
say('=== y 轴朝向校验（用「嘴」和「尾巴」比）===')
const infl = JSON.parse(fs.readFileSync('D:/AI_work_space/live2D桌宠/_research-data/param-influence.json', 'utf8'))
const byId = Object.fromEntries(infl.results.map((r) => [r.id, r]))
const mouthMeshes = (byId['ParamMouthOpenY']?.movedDrawableIds || []).map((s) => String(s).split(':')[0])
const tailMeshes = (byId['Param_Angle_Rotation_2_ArtMesh367']?.movedDrawableIds || []).map((s) => String(s).split(':')[0])
const mc = centroidOfMany(mouthMeshes), tc = centroidOfMany(tailMeshes)
say('  嘴  (' + mouthMeshes.join(',') + ') 质心 y=' + mc.y.toFixed(4))
say('  尾巴(' + tailMeshes.join(',') + ') 质心 y=' + tc.y.toFixed(4))
const Y_DOWN = mc.y < tc.y
say('  → y ' + (Y_DOWN ? '向下增大（上 = y 小）' : '向上增大（上 = y 大）') + '；"抬手"= y ' + (Y_DOWN ? '变小' : '变大'))
say('')

// ——— 手臂方向 ———
const ARMS = [
  { side: 'L(模型左肩)', param: 'Param_arm_L1', meshes: ['ArtMesh234', 'ArtMesh235'] },
  { side: 'R(模型右肩)', param: 'Param_arm_R1', meshes: ['ArtMesh231', 'ArtMesh232'] },
]
say('=== 肩关节旋转的实际方向（x 单位=画布宽，乘 ' + PPU + ' 得像素）===')
const verdict = {}
for (const a of ARMS) {
  const rows = []
  for (const v of [0, 30, -30]) {
    reset(); set(a.param, v); model.update()
    const c = centroidOfMany(a.meshes)
    rows.push({ v, ...c })
  }
  const base = rows[0]
  say('')
  say('  ' + a.side + '  ' + a.param)
  for (const r of rows) {
    const dy = (r.y - base.y) * PPU
    const awayBase = Math.abs(base.x - 0.5) * PPU
    const awayNow = Math.abs(r.x - 0.5) * PPU
    say('    ' + String(r.v).padStart(4) + '  x=' + (r.x * PPU).toFixed(0).padStart(6) + 'px y=' + (r.y * PPU).toFixed(0).padStart(6) + 'px' +
        '   Δy=' + (dy >= 0 ? '+' : '') + dy.toFixed(0).padStart(6) + 'px' +
        '   离中线 ' + ((awayNow - awayBase) >= 0 ? '+' : '') + (awayNow - awayBase).toFixed(0) + 'px')
  }
  const nonzero = rows.filter((r) => r.v !== 0)
  const up = nonzero.slice().sort((p, q) => (Y_DOWN ? p.y - q.y : q.y - p.y))[0]
  const out = nonzero.slice().sort((p, q) => Math.abs(q.x - 0.5) - Math.abs(p.x - 0.5))[0]
  verdict[a.param] = { up: up.v, out: out.v }
  say('    → 手**往上**的是 ' + a.param + ' = ' + up.v + '   手**往外**的是 ' + a.param + ' = ' + out.v)
  say('    → 结论：抬手应当用 ' + (up.v === out.v ? String(up.v) : '（上/外不一致，见上）'))
}
say('')
say('=== 建议（抬手 + 往外张开 = 挥手）===')
for (const a of ARMS) {
  const v = verdict[a.param]
  say('  ' + a.param.padEnd(14) + ' → ' + v.up)
}

fs.writeFileSync('D:/AI_work_space/live2D桌宠/_research-data/手臂方向.txt', OUT.join('\n'), 'utf8')
