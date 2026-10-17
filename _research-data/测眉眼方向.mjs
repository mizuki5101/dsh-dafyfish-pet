/**
 * 量眉毛 / 嘴的方向 —— S1（2026-10-17）
 *
 * 为什么不能只看质心：
 *  - 眉形（ParamBrowLForm/RForm、ParamBrowLAngle/RAngle）是**改变形状**：
 *    八字眉 = 内端↑、外端↓；倒八字（生气）= 内端↓、外端↑。质心几乎抵消。
 *  - 撇嘴（ParamMouthX）是「一边嘴角下去、另一边嘴角上来」的**旋转**。
 *
 * 左右/内外的**几何依据**（别再凭参数名猜）：
 *  - 画布中线 x=0；ParamBrowLForm 驱动的 ArtMesh10 在 x=+73..+252，
 *    也就是**屏幕右侧**（她自己的左眉）。Live2D 的 L/R 是角色视角，不是屏幕视角。
 *  - 同一个 brow 里，离 x=0 近的那端 = 内端：
 *      ArtMesh10（x>0）：左端=内端、右端=外端
 *      ArtMesh177（x<0）：右端=内端、左端=外端
 *
 * 坐标：x 正 = 屏幕右，y 正 = 上；位移单位 px（PPU=3326）。
 * 输出：_research-data/眉眼方向.txt
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadModel } from './cubism-loader.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const OUT = []
const say = (...a) => OUT.push(a.join(' '))

const { model } = await loadModel()
const D = model.drawables, P = model.parameters
const ids = D.ids.map((v) => (typeof v === 'string' ? v : String(v)))
const pids = Array.from({ length: P.count }, (_, i) => (typeof P.ids[i] === 'string' ? P.ids[i] : String(P.ids[i])))
const counts = Array.from(D.vertexCounts)
const PPU = (model.canvasinfo || {}).PixelsPerUnit || 3326
const reset = () => P.values.set(P.defaultValues)
const set = (id, v) => { const i = pids.indexOf(id); if (i >= 0) P.values[i] = v }
const infl = JSON.parse(fs.readFileSync(HERE + 'param-influence.json', 'utf8'))
const byId = Object.fromEntries(infl.results.map((r) => [r.id, r]))

const fmt = (n, w = 7) => (n >= 0 ? ' ' : '') + n.toFixed(1).padStart(w - 1)
const dirTxt = (dx, dy, t = 1.5) => {
  const p = []
  if (Math.abs(dy) > t) p.push(dy > 0 ? '↑上' : '↓下')
  if (Math.abs(dx) > t) p.push(dx > 0 ? '→右' : '←左')
  return p.length ? p.join(' ') : '（几乎不动）'
}
function centroid(names) {
  let sx = 0, sy = 0, n = 0
  for (const nm of names) {
    const i = ids.indexOf(nm); if (i < 0) continue
    const vp = D.vertexPositions[i], c = counts[i]
    for (let k = 0; k < c; k++) { sx += vp[k * 2]; sy += vp[k * 2 + 1] }
    n += c
  }
  return n ? { x: (sx / n) * PPU, y: (sy / n) * PPU } : null
}

/** 画布顶点快照（像素），按 drawable 名称 */
function snapshot(names) {
  const snap = new Map()
  for (const nm of names) {
    const i = ids.indexOf(nm); if (i < 0) continue
    const vp = D.vertexPositions[i], c = counts[i]
    const arr = new Float32Array(c * 2)
    for (let k = 0; k < c; k++) { arr[k * 2] = vp[k * 2] * PPU; arr[k * 2 + 1] = vp[k * 2 + 1] * PPU }
    snap.set(nm, arr)
  }
  return snap
}
/** 一条眉毛：相对 base 的左端 / 右端（各取最外侧 25% 顶点）的位移 */
function deltaEnds(mesh, base) {
  const i = ids.indexOf(mesh); if (i < 0) return null
  const b = base.get(mesh), c = counts[i], vp = D.vertexPositions[i]
  const pts = []
  for (let k = 0; k < c; k++) {
    pts.push({ x: b[k * 2], dx: vp[k * 2] * PPU - b[k * 2], dy: vp[k * 2 + 1] * PPU - b[k * 2 + 1] })
  }
  pts.sort((a, b) => a.x - b.x)
  const kk = Math.max(1, Math.floor(c * 0.25))
  const avg = (arr) => ({ dx: arr.reduce((s, p) => s + p.dx, 0) / arr.length, dy: arr.reduce((s, p) => s + p.dy, 0) / arr.length })
  return { L: avg(pts.slice(0, kk)), R: avg(pts.slice(-kk)), all: avg(pts), n: c }
}

// 两条眉：mesh + 哪一端是内端（几何依据见文件头）
const BROW = {
  ParamBrowLForm: { mesh: 'ArtMesh10', side: '屏幕右眉（她的左眉）', inner: 'L', outer: 'R', x: '+73..+252' },
  ParamBrowRForm: { mesh: 'ArtMesh177', side: '屏幕左眉（她的右眉）', inner: 'R', outer: 'L', x: '−252..−73' },
}
const BROW_ANGLE = {
  ParamBrowLAngle: { mesh: 'ArtMesh10', side: '屏幕右眉（她的左眉）', inner: 'L', outer: 'R' },
  ParamBrowRAngle: { mesh: 'ArtMesh177', side: '屏幕左眉（她的右眉）', inner: 'R', outer: 'L' },
}
const BROW_MESHES = ['ArtMesh10', 'ArtMesh168', 'ArtMesh169', 'ArtMesh170', 'ArtMesh171',
  'ArtMesh177', 'ArtMesh267', 'ArtMesh269', 'ArtMesh270', 'ArtMesh276']
const baseBrow = (() => { reset(); model.update(); return snapshot(BROW_MESHES) })()

// 嘴：所有嘴部件按 x 取最左/最右各 20% 当「左嘴角 / 右嘴角」
const MOUTH = (byId['ParamMouthX']?.movedDrawableIds || []).map((s) => String(s).split(':')[0])
const baseMouth = (() => { reset(); model.update(); return snapshot(MOUTH) })()
function cornerDeltas() {
  const pts = []
  for (const nm of MOUTH) {
    const b = baseMouth.get(nm); if (!b) continue
    const i = ids.indexOf(nm), c = counts[i], vp = D.vertexPositions[i]
    for (let k = 0; k < c; k++) pts.push({ x: b[k * 2], dx: vp[k * 2] * PPU - b[k * 2], dy: vp[k * 2 + 1] * PPU - b[k * 2 + 1] })
  }
  pts.sort((a, b) => a.x - b.x)
  const kk = Math.max(1, Math.floor(pts.length * 0.2))
  const avg = (arr) => ({ dx: arr.reduce((s, p) => s + p.dx, 0) / arr.length, dy: arr.reduce((s, p) => s + p.dy, 0) / arr.length })
  return { L: avg(pts.slice(0, kk)), R: avg(pts.slice(-kk)), n: pts.length }
}

// ── 1. 参数总览 ────────────────────────────────────────────────
say('=== 眉毛 / 嘴 / 眼袋 的方向（S1 · 2026-10-17 实测）===')
say('坐标：x 正=屏幕右，y 正=上；位移 px（PPU=' + PPU + '）。')
say('左右是**屏幕**视角；Live2D 的 L/R 是角色视角（ParamBrowL 在屏幕右侧）。')
say('')
say('  参数                范围        默认   影响顶点   最大位移')
for (const id of ['ParamBrowLAngle', 'ParamBrowRAngle', 'ParamBrowLForm', 'ParamBrowRForm', 'ParamMouthForm', 'ParamMouthX', 'ParamEyePuff']) {
  const r = byId[id]
  if (!r) { say('  ' + id + ' 不在模型里'); continue }
  say('  ' + id.padEnd(18) + ('[' + r.min + ',' + r.max + ']').padEnd(12) + String(r.default).padEnd(7) +
      String(r.movedVertsMax).padStart(6) + ' 点' + r.maxDisplacementPx.toFixed(1).padStart(8) + ' px')
}

// ── 2. 整体质心：+1 / −1 ──────────────────────────────────────
say('')
say('=== 2. 整体质心（只作参考：眉形/撇嘴看质心会被抵消）===')
for (const id of ['ParamBrowLAngle', 'ParamBrowRAngle', 'ParamBrowLForm', 'ParamBrowRForm', 'ParamMouthForm', 'ParamMouthX', 'ParamEyePuff']) {
  const r = byId[id]; if (!r) continue
  const meshes = (r.movedDrawableIds || []).map((s) => String(s).split(':')[0])
  say('')
  say('  ' + id + '  范围[' + r.min + ',' + r.max + '] 默认' + r.default)
  for (const v of [1, -1]) {
    if (v < r.min || v > r.max) continue
    reset(); model.update(); const b = centroid(meshes)
    reset(); set(id, v); model.update(); const c = centroid(meshes)
    const dx = c.x - b.x, dy = c.y - b.y
    say('    ' + (v > 0 ? '+1' : '−1').padStart(3) + '  Δx=' + fmt(dx) + '  Δy=' + fmt(dy) + '   ' + dirTxt(dx, dy))
  }
}

// ── 3. 眉形真值：内端 / 外端 ──────────────────────────────────
say('')
say('=== 3. 眉形真值：内端 / 外端各往哪走（★ 八字眉 vs 倒八字）===')
say('  ★ 八字眉（委屈/担心）= 内端↑、外端↓；倒八字（生气/皱眉）= 内端↓、外端↑。')
say('  屏幕右眉：内端=左端(x≈+73) 外端=右端(x≈+252)；屏幕左眉相反。')
const browRows = {}
for (const [id, info] of Object.entries({ ...BROW, ...BROW_ANGLE })) {
  const r = byId[id]; if (!r) continue
  say('')
  say('  ' + id + '（' + info.side + '，眉部件 ' + info.mesh + '）')
  for (const v of [1, -1]) {
    reset(); set(id, v); model.update()
    const d = deltaEnds(info.mesh, baseBrow)
    const inner = d[info.inner], outer = d[info.outer]
    browRows[id + ':' + v] = { inner: inner.dy, outer: outer.dy, all: d.all.dy }
    const diff = inner.dy - outer.dy
    const shape = diff > 3 ? '内高外低 → **八字**（委屈/担心）'
      : diff < -3 ? '内低外高 → **倒八字**（生气/皱眉）'
      : '接近水平（整体' + (d.all.dy > 2 ? '抬起' : d.all.dy < -2 ? '压低' : '不动') + '）'
    say('    ' + (v > 0 ? '+1' : '−1').padStart(3) + '  内端 Δy=' + fmt(inner.dy) + '  外端 Δy=' + fmt(outer.dy) +
        '   内−外=' + fmt(diff) + '   ' + shape)
  }
  const plus = browRows[id + ':1'], minus = browRows[id + ':-1']
  const best = [plus, minus].sort((a, b) => (b.inner - b.outer) - (a.inner - a.outer))[0]
  const sign = best === plus ? '+1' : '−1'
  say('    → 这条参数做「八字」用 ' + sign + '（内−外=' + fmt(best.inner - best.outer) + '）')
}

// ── 4. 嘴角：ParamMouthX / 参考项 ─────────────────────────────
say('')
say('=== 4. 嘴形：左嘴角、右嘴角各往哪走 ===')
say('  ★ 左嘴角↓ + 右嘴角↑ = 屏幕上的「撇嘴/坏笑」；反过来是镜像。')
for (const id of ['ParamMouthX', 'ParamMouthForm', 'ParamMouthOpenY']) {
  const r = byId[id]; if (!r) continue
  say('')
  for (const v of [1, -1]) {
    if (v < r.min || v > r.max) continue
    reset(); set(id, v); model.update()
    const d = cornerDeltas()
    let read
    if (id === 'ParamMouthX') read = d.L.dy < -1.5 && d.R.dy > 1.5 ? '左低右高（撇嘴）' : d.L.dy > 1.5 && d.R.dy < -1.5 ? '左高右低（反向撇嘴）' : '上下不明显'
    else if (id === 'ParamMouthForm') read = d.L.dy > 1 && d.R.dy > 1 ? '嘴角上翘（笑）' : d.L.dy < -1 && d.R.dy < -1 ? '嘴角下弯（撇嘴）' : '嘴角略下（幅度小）'
    else read = '张嘴（嘴角被带着上移）'
    say('  ' + id.padEnd(16) + (v > 0 ? '+1' : '−1').padStart(3) +
        '  左嘴角 Δx=' + fmt(d.L.dx) + ' Δy=' + fmt(d.L.dy) +
        '   右嘴角 Δx=' + fmt(d.R.dx) + ' Δy=' + fmt(d.R.dy) + '   → ' + read)
  }
}

// ── 5. 组合验证：给 S2 的候选值 ────────────────────────────────
say('')
say('=== 5. 组合验证（给 S2 写 manifest 用）===')
function comboRow(label, pairs) {
  reset(); for (const [id, v] of pairs) set(id, v); model.update()
  const L = deltaEnds(BROW.ParamBrowLForm.mesh, baseBrow)
  const R = deltaEnds(BROW.ParamBrowRForm.mesh, baseBrow)
  const Li = L[ BROW.ParamBrowLForm.inner ].dy, Lo = L[ BROW.ParamBrowLForm.outer ].dy
  const Ri = R[ BROW.ParamBrowRForm.inner ].dy, Ro = R[ BROW.ParamBrowRForm.outer ].dy
  const li = Li - Lo, ri = Ri - Ro
  say('  ' + label.padEnd(26) + '左眉 内' + fmt(Li) + ' 外' + fmt(Lo) + '（内−外 ' + fmt(li) + '）' +
      '  右眉 内' + fmt(Ri) + ' 外' + fmt(Ro) + '（内−外 ' + fmt(ri) + '）')
  return { Li, Lo, Ri, Ro, li, ri }
}
comboRow('委屈候选A：Angle+0.5', [['ParamBrowLAngle', 0.5], ['ParamBrowRAngle', 0.5]])
comboRow('委屈候选B：Form+1 Angle+0.4', [['ParamBrowLForm', 1], ['ParamBrowRForm', 1], ['ParamBrowLAngle', 0.4], ['ParamBrowRAngle', 0.4]])
comboRow('挑眉候选：单边 Form+1', [['ParamBrowLForm', 1], ['ParamBrowLAngle', 0]])
comboRow('原方案：Form−1 Angle−0.4', [['ParamBrowLForm', -1], ['ParamBrowRForm', -1], ['ParamBrowLAngle', -0.4], ['ParamBrowRAngle', -0.4]])

// ── 6. 结论 ───────────────────────────────────────────────────
say('')
say('=== 6. 结论（抄进 manifest.json 的 _note）===')
say('  ParamBrowLAngle/RAngle = −1：内端 ↓22.5 / 外端 ↑29.3 → **倒八字 = 生气/皱眉**（现役「生气」是对的）')
say('  ParamBrowLAngle/RAngle = +1：内端 ↑8.5 / 外端 ↓2.8 → **八字 = 委屈/担心**（平缓版）')
say('  ParamBrowLForm/RForm = −1：内端 ↓8.3 / 外端 ↑9.7 → **倒八字（生气）**，整体还压低 9px')
say('  ParamBrowLForm/RForm = +1：内端 ↑5.7 / 外端 ↑1.1 → 整体抬起、内端抬更多（挑眉/可怜）')
say('  ⚠️ 原 §十二 的「委屈 = Form ±1 + Angle −0.4」方向反了：实测是**倒八字**（更凶）。')
say('     委屈要么 Angle +0.5（轻），要么 Form +1 + Angle +0.4（更明显），见第 5 节。')
say('  ParamMouthX = +1：左嘴角 ↓2.7 / 右嘴角 ↑4.2、整嘴右移 5px → **撇嘴（左低右高）**')
say('  ParamMouthX = −1：镜像（左高右低）')
say('  ⚠️ ParamMouthX 与说话口型共用嘴：说话时建议归零，否则嘴会歪（§十二-5）。')

const text = OUT.join('\n') + '\n'
fs.writeFileSync(HERE + '眉眼方向.txt', text, 'utf8')
process.stdout.write(text)
