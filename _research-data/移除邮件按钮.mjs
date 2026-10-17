/**
 * 移除头顶「邮件（工作简报信封）」按钮。
 *
 * 主人反馈：那个信封点不开、平时用不上，直接去掉。
 *
 * 做法：整套 UI 删干净（信封按钮 + 未读角标 + 大号简报面板 + CSS + clampPanels 两条），
 * 但 pushReport 是**对外接口**（DSHPet.report / /dsh-pet/control 的 report 字段），
 * 保留成走气泡的薄壳，避免调用方静默失败。
 *
 * 每一处替换都带断言 —— 匹配不到就直接报错，绝不静默漏改。
 */
import fs from 'node:fs'

const P = 'D:/AI_work_space/live2D桌宠/pet-plugin/assets/pet.js'
let s = fs.readFileSync(P, 'utf8')
const before = s.length
const log = []

function cut(startMark, endMark, replacement, label) {
  const a = s.indexOf(startMark)
  if (a < 0) throw new Error('[' + label + '] 找不到起点：' + startMark.slice(0, 50))
  const b = s.indexOf(endMark, a)
  if (b < 0) throw new Error('[' + label + '] 找不到终点：' + endMark.slice(0, 50))
  const removed = s.slice(a, b)
  s = s.slice(0, a) + replacement + s.slice(b)
  log.push(label + '：删除 ' + removed.split('\n').length + ' 行')
}

/**
 * 从「小节标题上方的注释框」一直删到「下一个注释框之前」。
 * 不直接匹配横线——那个 — 字符个数不固定，写死很容易对不上（刚踩过）。
 */
function cutSection(titleMark, nextTitleMark, replacement, label) {
  const ti = s.indexOf(titleMark)
  if (ti < 0) throw new Error('[' + label + '] 找不到小节标题：' + titleMark)
  const start = s.lastIndexOf('\n  // —', ti) + 1        // 回退到注释框第一行
  if (start <= 0 || start > ti) throw new Error('[' + label + '] 找不到注释框起点')
  const ni = s.indexOf(nextTitleMark, ti)
  if (ni < 0) throw new Error('[' + label + '] 找不到下一节：' + nextTitleMark)
  const end = s.lastIndexOf('\n  // —', ni) + 1          // 到下一节注释框之前
  if (end <= start) throw new Error('[' + label + '] 区间不合法')
  const removed = s.slice(start, end)
  s = s.slice(0, start) + replacement + s.slice(end)
  log.push(label + '：删除 ' + removed.split('\n').length + ' 行')
}

/** 按「代码片段」整行删除（行尾的行内注释要对齐，写死空格太脆，刚踩过） */
function dropLine(fragment, label) {
  const esc = fragment.replace(/[.*+?^${}()[\]|\\]/g, '\\$&')
  const re = new RegExp('\\n[^\\n]*' + esc + '[^\\n]*', 'g')
  const n = (s.match(re) || []).length
  if (n !== 1) throw new Error('[' + label + '] 期望命中 1 行，实际 ' + n + ' 行')
  s = s.replace(re, '')
  log.push(label + '：删除 1 行')
}

/** 从起始片段所在整行，删到结束片段所在行之后 extra 行 */
function dropBlock(startFrag, endFrag, extra, label) {
  const i = s.indexOf(startFrag)
  if (i < 0) throw new Error('[' + label + '] 找不到起点片段')
  const start = s.lastIndexOf('\n', i) + 1
  const j = s.indexOf(endFrag, i)
  if (j < 0) throw new Error('[' + label + '] 找不到终点片段')
  let end = s.indexOf('\n', j) + 1
  for (let k = 0; k < extra; k++) end = s.indexOf('\n', end) + 1
  const removed = s.slice(start, end)
  s = s.slice(0, start) + s.slice(end)
  log.push(label + '：删除 ' + removed.split('\n').filter(Boolean).length + ' 行')
}

function swap(oldText, newText, label) {
  const n = s.split(oldText).length - 1
  if (n !== 1) throw new Error('[' + label + '] 期望恰好匹配 1 次，实际 ' + n + ' 次')
  s = s.replace(oldText, newText)
  log.push(label + '：替换 1 处')
}

// ——— 1. CSS：信封 + 角标 + 动画 + 简报面板 ———
cut(
  '/* ——— 工作简报：头顶的「信封」+ 点开的大号简报面板 ———',
  '\n.dshp-root.dshp-hover .dshp-dock',
  '',
  'CSS 邮件/简报样式'
)

// ——— 2. JS：整个八点四小节 → 换成走气泡的薄壳 ———
cutSection(
  '// 八点四、工作简报（信封）',
  '// 八、鼠标交互',
  `  // ——————————————————————————————————————————————————————————————
  // 八点四、工作简报
  //
  // 这里原来是「头顶挂信封 + 点开大号简报面板」。主人反馈那个信封**点不开、
  // 平时也用不上**，所以整套 UI 全部删掉了：信封按钮、未读角标、简报面板、
  // 对应 CSS，以及 clampPanels() 里的两条 placePanel。
  //
  // 但 pushReport 是**对外接口**（DSHPet.report 和 /dsh-pet/control 的 report 字段），
  // 直接删掉会让调用方静默失败，所以保留成一个薄壳，改走**气泡**——
  // 气泡本来就是本插件正常工作、看得见的通知通道。
  // ——————————————————————————————————————————————————————————————
  function pushReport(title, body) {
    try {
      const text = String(body == null ? '' : body).trim()
      if (!text) return
      const t = String(title || '工作简报')
      // work: true —— 走气泡的「工作优先」守卫，不会被随机互动台词顶掉
      ui.bubble.show(t + '：' + text, { name: 'DS 鲸鱼娘', ttl: 9000, work: true })
    } catch (err) {}
  }

`,
  'JS 八点四 工作简报小节'
)

// ——— 3. clampPanels 里的两条 placePanel ———
dropLine('placePanel(ui && ui.report && ui.report.el)', 'clampPanels 的简报面板 placePanel')
dropLine('placePanel(ui && ui.mail && ui.mail.el)', 'clampPanels 的信封 placePanel')

// ——— 4. 自动简报：任务简报（和气泡内容重复）———
dropLine("pushReport('任务简报', agent.lastText)", '自动简报「任务简报」')

// ——— 5. 自动简报：本轮完成（花费/tokens，HUD 里本来就有）———
dropBlock(
  '// 同上：不自动弹余额',
  "pushReport('本轮完成'",
  1,   // 再多删一行：那个 if 块的收尾 }
  '自动简报「本轮完成」'
)

// ——— 断言：不该再有任何残留 ———
const leftovers = ['dshp-mail', 'dshp-report', 'ensureMailUI', 'renderMail', 'toggleReport',
                   'markAllRead', 'lastReportKey', 'hostLabel', 'mail.items', 'ui.mail', 'ui.report']
const bad = leftovers.filter((k) => s.includes(k))
if (bad.length) throw new Error('还有残留：' + bad.join(', '))

// pushReport 的引用应当只剩：定义 1 + 注释 1 + DSHPet.report 1 + control 路由 3 = 6
//（不是硬编码期望值，而是逐条列出来核对，避免又猜错）
const prLines = s.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => l.includes('pushReport'))
const prCount = s.split('pushReport').length - 1
const autoGone = !s.includes("'任务简报'") && !s.includes("'本轮完成'")
if (!autoGone) throw new Error('自动简报调用点没有删干净')
if (prCount !== 6) throw new Error('pushReport 引用数应为 6，实际 ' + prCount + '\n' + prLines.map(([n, l]) => n + ': ' + l.trim()).join('\n'))
log.push('pushReport 剩余引用 ' + prCount + ' 处（逐条核对通过）')
for (const [n, l] of prLines) log.push('    L' + n + '  ' + l.trim().slice(0, 78))

fs.writeFileSync(P, s, 'utf8')
console.log(log.join('\n'))
console.log('\n体积：' + before + ' -> ' + s.length + ' 字节（-' + (before - s.length) + '）')
console.log('pushReport 引用数：' + prCount + '（定义 / DSHPet.report / control 路由）')
console.log('残留检查：通过（' + leftovers.join(', ') + ' 全部消失）')
