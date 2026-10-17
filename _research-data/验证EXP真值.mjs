/**
 * 用作者原始 exp3 的真值表核对参数语义：
 * 同一个参数的不同取值应当切换**不同**的 drawable（O O 和 》《 是两套眼睛素材）。
 */
import fs from 'node:fs'
import { loadModel } from 'file:///D:/AI_work_space/_research/cubism-loader.mjs'
const OUT = []; const say = (...a) => OUT.push(a.join(' '))
const { model } = await loadModel()
const D = model.drawables, P = model.parameters
const pids = Array.from({ length: P.count }, (_, i) => (typeof P.ids[i] === 'string' ? P.ids[i] : String(P.ids[i])))
const reset = () => P.values.set(P.defaultValues)
const set = (id, v) => { const i = pids.indexOf(id); if (i >= 0) P.values[i] = v }

/** 返回被隐藏/显示的 drawable 集合（对比默认值） */
function visDelta(id, v) {
  reset(); model.update()
  const base = Array.from(D.opacities).map((x, i) => [x, D.dynamicFlags[i] & 1])
  reset(); set(id, v); model.update()
  const cur = Array.from(D.opacities).map((x, i) => [x, D.dynamicFlags[i] & 1])
  const changed = []
  for (let i = 0; i < D.count; i++) {
    if (Math.abs(base[i][0] - cur[i][0]) > 1e-4 || base[i][1] !== cur[i][1]) changed.push(i)
  }
  return changed
}

const CASES = [
  ['PARAM_EXP4', 1, '04 脸红'],
  ['PARAM_EXP5', 1, '05 O O（圈圈眼）'],
  ['PARAM_EXP5', -1, '05 》《（闭眼挤眼）'],
  ['PARAM_EXP2', 1, '02 3嘴'],
  ['PARAM_EXP2', -1, '02 龇牙'],
  ['PARAM_EXP7', 1, '07 流口水'],
  ['PARAM_EXP7', -1, '08 担心嘴'],
  ['PARAM_EXP8', 1, '08 O嘴'],
  ['PARAM_EXP8', -1, '08 栗子嘴'],
  ['Paramcol_1', 1, '尾巴消失(值1)'],
  ['Paramcol_1', 2, '尾巴消失(值2)'],
]
say('=== 各表达实际影响的 drawable 集合 ===')
const sets = {}
for (const [id, v, label] of CASES) {
  const c = visDelta(id, v)
  sets[label] = new Set(c)
  say('  ' + (id + '=' + v).padEnd(18) + label.padEnd(20) + ' 影响 ' + String(c.length).padStart(3) + ' 个 drawable  ' + '[' + c.slice(0, 6).join(',') + (c.length > 6 ? ',…' : '') + ']')
}
say('')
say('=== 同一参数的正负值是否切换**不同**素材（验证是两个独立状态）===')
for (const [a, b, param] of [
  ['05 O O（圈圈眼）', '05 》《（闭眼挤眼）', 'PARAM_EXP5'],
  ['02 3嘴', '02 龇牙', 'PARAM_EXP2'],
  ['07 流口水', '08 担心嘴', 'PARAM_EXP7'],
  ['08 O嘴', '08 栗子嘴', 'PARAM_EXP8'],
]) {
  const A = sets[a], B = sets[b]
  const inter = [...A].filter((x) => B.has(x)).length
  const union = new Set([...A, ...B]).size
  say('  ' + param + '  +1 影响 ' + A.size + ' 个，-1 影响 ' + B.size + ' 个，交集 ' + inter + ' / 并集 ' + union +
      (A.size && B.size && inter === 0 ? '  → **完全不同的素材** ✓' : A.size && B.size ? '  → 部分重叠' : '  → （有一侧为空）'))
}
say('')
say('=== Paramcol_1（尾巴消失）值 1 和 2 的差别 ===')
const c1 = sets['尾巴消失(值1)'], c2 = sets['尾巴消失(值2)']
say('  值1 影响 ' + c1.size + ' 个；值2 影响 ' + c2.size + ' 个；相同 ' + ([...c2].filter((x) => c1.has(x)).length))
say('  → 作者原始 exp3 用的是 **值 2**，我们 manifest 里写的是 1')
fs.writeFileSync('D:/AI_work_space/live2D桌宠/_research-data/EXP真值.txt', OUT.join('\n'), 'utf8')
