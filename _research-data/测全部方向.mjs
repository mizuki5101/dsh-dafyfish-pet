/**
 * 量出「打算驱动的参数」在**屏幕上**往哪走。
 *
 * 两条踩过的坑，写在这儿免得再犯：
 *  1) `D.vertexPositions[i]` 是**每个 drawable 自己的** Float32Array，
 *     索引是 `vp[k*2]`；不要拿拼接数组的偏移量去索引它（会全变 NaN）。
 *  2) 旋转类参数（头）**不能看整体质心** —— 绕轴转时上下部分反向移动，
 *     质心几乎不动（实测 ±30 只差 30px）。要看**具体特征**（用嘴/下巴）。
 *
 * 坐标：原点在画布中心，画布宽 = 1.0（× PixelsPerUnit 3326 = 像素）；
 *      **y 向上为正**（嘴 y=0.49 > 尾巴 y=-0.06 实测确认）；x 负 = 屏幕左。
 */
import fs from 'node:fs'
import { loadModel } from 'file:///D:/AI_work_space/_research/cubism-loader.mjs'

const OUT = []
const say = (...a) => OUT.push(a.join(' '))
const { model } = await loadModel()
const D = model.drawables, P = model.parameters
const ids = D.ids.map((v) => (typeof v === 'string' ? v : String(v)))
const pids = Array.from({ length: P.count }, (_, i) => (typeof P.ids[i] === 'string' ? P.ids[i] : String(P.ids[i])))
const counts = Array.from(D.vertexCounts)
const offs = []
let acc = 0
for (let i = 0; i < D.count; i++) { offs.push(acc); acc += counts[i] * 2 }
const PPU = (model.canvasinfo || {}).PixelsPerUnit || 3326
const reset = () => P.values.set(P.defaultValues)
const set = (id, v) => { const i = pids.indexOf(id); if (i >= 0) P.values[i] = v }

/** 指定 drawable 的质心（像素） */
function centroid(names) {
  let sx = 0, sy = 0, n = 0
  for (const nm of names) {
    const i = ids.indexOf(nm); if (i < 0) continue
    const vp = D.vertexPositions[i], c = counts[i]      // ← 索引就是 vp[k*2]，不加 offs[i]
    for (let k = 0; k < c; k++) { sx += vp[k * 2]; sy += vp[k * 2 + 1] }
    n += c
  }
  return n ? { x: (sx / n) * PPU, y: (sy / n) * PPU, n } : null
}

const dir = (dx, dy) => {
  const p = []
  if (Math.abs(dy) > 8) p.push(dy > 0 ? '↑上' : '↓下')
  if (Math.abs(dx) > 8) p.push(dx > 0 ? '→右' : '←左')
  return p.length ? p.join(' ') : '（<8px，几乎不动）'
}

// 已知特征：嘴（脸上）；用来判断点头方向
const infl = JSON.parse(fs.readFileSync('D:/AI_work_space/live2D桌宠/_research-data/param-influence.json', 'utf8'))
const byId = Object.fromEntries(infl.results.map((r) => [r.id, r]))
const MOUTH = (byId['ParamMouthOpenY']?.movedDrawableIds || []).map((s) => String(s).split(':')[0])
say('嘴的部件：' + MOUTH.join(', '))

say('')
say('=== 手臂：哪个符号是「抬手 + 外张」===')
const ARMS = [
  ['屏幕左臂 L1 肩', 'Param_arm_L1', ['ArtMesh234', 'ArtMesh235']],
  ['屏幕左臂 L2 肘', 'Param_arm_L2', ['ArtMesh234', 'ArtMesh235']],
  ['屏幕左臂 L3 腕', 'Param_arm_L3', ['ArtMesh234', 'ArtMesh235']],
  ['屏幕左臂 L4 手', 'Param_arm_L4', ['ArtMesh234', 'ArtMesh235']],
  ['屏幕右臂 R1 肩', 'Param_arm_R1', ['ArtMesh231', 'ArtMesh232']],
  ['屏幕右臂 R2 肘', 'Param_arm_R2', ['ArtMesh231', 'ArtMesh232']],
  ['屏幕右臂 R3 腕', 'Param_arm_R3', ['ArtMesh231', 'ArtMesh232']],
  ['屏幕右臂 R4 手', 'Param_arm_R4', ['ArtMesh231', 'ArtMesh232']],
]
const sign = {}
say('')
say('  ' + '参数'.padEnd(18) + '推向'.padStart(6) + '   Δx(px)   Δy(px)   方向')
for (const [label, id, meshes] of ARMS) {
  const rows = []
  for (const v of [30, -30]) {
    reset(); model.update(); const b = centroid(meshes)
    reset(); set(id, v); model.update(); const c = centroid(meshes)
    const dx = c.x - b.x, dy = c.y - b.y
    rows.push({ v, dx, dy })
    say('  ' + label.padEnd(18) + String(v).padStart(6) + dx.toFixed(0).padStart(9) + dy.toFixed(0).padStart(9) + '   ' + dir(dx, dy))
  }
  const best = rows.slice().sort((a, b) => b.dy - a.dy)[0]   // y 向上为正 → 抬手 = Δy 最大
  sign[id] = best.v
  say('       → 抬手+外张用 ' + id + ' = ' + best.v)
}

say('')
say('=== 头部：用「嘴」看点头，用整体看摇头/歪头 ===')
const HEADS = [
  ['ParamAngleY', '点头', MOUTH],
  ['ParamAngleX', '摇头', null],
  ['ParamAngleZ', '歪头', null],
]
for (const [id, name, watch] of HEADS) {
  say('')
  say('  ' + id + '  ' + name + (watch ? '（看嘴）' : '（看整体）'))
  for (const v of [30, -30]) {
    reset(); model.update()
    const b = watch ? centroid(watch) : centroidAll()
    reset(); set(id, v); model.update()
    const c = watch ? centroid(watch) : centroidAll()
    say('    ' + String(v).padStart(4) + '  Δx=' + (c.x - b.x).toFixed(0).padStart(6) + 'px Δy=' + (c.y - b.y).toFixed(0).padStart(6) + 'px   ' + dir(c.x - b.x, c.y - b.y))
  }
}
function centroidAll() {
  let sx = 0, sy = 0, n = 0
  for (let i = 0; i < D.count; i++) {
    const vp = D.vertexPositions[i], c = counts[i]
    for (let k = 0; k < c; k++) { sx += vp[k * 2]; sy += vp[k * 2 + 1] }
    n += c
  }
  return { x: (sx / n) * PPU, y: (sy / n) * PPU }
}

say('')
say('=== 汇总：抬手符号表（抄进 CLIPS）===')
for (const id of Object.keys(sign)) say('  ' + id.padEnd(16) + ' → ' + sign[id])

fs.writeFileSync('D:/AI_work_space/live2D桌宠/_research-data/全部方向.txt', OUT.join('\n'), 'utf8')
fs.writeFileSync('D:/AI_work_space/live2D桌宠/_research-data/手臂符号.json', JSON.stringify(sign, null, 1), 'utf8')
