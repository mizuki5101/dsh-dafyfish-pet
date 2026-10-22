// 识图遮罩窗（独立 BrowserWindow）的渲染层：只做"画框 + 交坐标"，不碰截图。
//
// 为什么是独立窗口而不是页面里的一个 fixed 遮罩：
//   主窗默认只有 560×900（readFullscreenPrimary 默认 false），根本不是全屏，
//   在页面里铺满屏是错的；临时把主窗改全屏会牵动一整套位置/拖动/命中窗逻辑。
//
// 坐标口径：clientX/Y 是**窗口内 CSS px**，而窗口正好铺在主屏 bounds 上，
// 所以主进程加一个 bounds 原点就得到屏幕 DIP —— DPR 换算在 capture.js 里做。

const rectEl = document.getElementById('rect')
const sizeEl = document.getElementById('size')
const hintEl = document.getElementById('hint')

const MIN_SIZE = 24 // DIP；再小就是误触，别把 4×4 的噪点丢给模型

let down = false
let start = { x: 0, y: 0 }
let current = { x: 0, y: 0 }
let done = false

function paint() {
  const x = Math.min(start.x, current.x)
  const y = Math.min(start.y, current.y)
  const w = Math.abs(current.x - start.x)
  const h = Math.abs(current.y - start.y)
  rectEl.classList.add('on')
  rectEl.style.left = x + 'px'
  rectEl.style.top = y + 'px'
  rectEl.style.width = w + 'px'
  rectEl.style.height = h + 'px'
  sizeEl.classList.add('on')
  sizeEl.textContent = Math.round(w) + ' × ' + Math.round(h)
  // 尺寸标签跟着鼠标走，框太靠边时翻到另一侧
  const flipX = current.x + 80 > window.innerWidth
  const flipY = current.y - 26 < 4
  sizeEl.style.left = (flipX ? current.x - 78 : current.x + 10) + 'px'
  sizeEl.style.top = (flipY ? current.y + 14 : current.y - 24) + 'px'
}

function finish() {
  if (done) return
  done = true
  const x = Math.min(start.x, current.x)
  const y = Math.min(start.y, current.y)
  const w = Math.abs(current.x - start.x)
  const h = Math.abs(current.y - start.y)
  if (w < MIN_SIZE || h < MIN_SIZE) {
    cancel('too-small')
    return
  }
  hintEl.textContent = '正在看…'
  document.body.style.cursor = 'progress'
  try {
    window.shotAPI.rect({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), minSize: MIN_SIZE })
  } catch (e) {}
  // 不等回包：主进程拿到 rect 就先 hide 再截图，错误走气泡提示
}

function cancel(reason) {
  if (done && reason !== 'too-small') return
  done = true
  try {
    window.shotAPI.cancel(reason || 'cancelled')
  } catch (e) {}
}

function resetAll() {
  down = false
  done = false
  start = { x: 0, y: 0 }
  current = { x: 0, y: 0 }
  rectEl.classList.remove('on')
  rectEl.style.width = '0px'
  rectEl.style.height = '0px'
  sizeEl.classList.remove('on')
  hintEl.style.display = ''
  hintEl.textContent = '拖出一个矩形框住要看的东西 · Esc 或右键取消'
  document.body.style.cursor = 'crosshair'
}

if (window.shotAPI && window.shotAPI.onReset) window.shotAPI.onReset(resetAll)
// 双保险：窗口被隐藏再显示时也复位（万一主进程没发 reset）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resetAll()
})

window.addEventListener('pointerdown', (e) => {
  if (done) return
  if (e.button !== 0) {
    cancel('right-click')
    return
  }
  e.preventDefault()
  down = true
  start = { x: e.clientX, y: e.clientY }
  current = { x: e.clientX, y: e.clientY }
  hintEl.style.display = 'none'
  try {
    document.body.setPointerCapture(e.pointerId)
  } catch (err) {}
  paint()
})

window.addEventListener('pointermove', (e) => {
  if (!down || done) return
  current = { x: e.clientX, y: e.clientY }
  paint()
})

window.addEventListener('pointerup', (e) => {
  if (!down || done) return
  down = false
  current = { x: e.clientX, y: e.clientY }
  try {
    document.body.releasePointerCapture(e.pointerId)
  } catch (err) {}
  finish()
})

window.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  cancel('right-click')
})

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    cancel('esc')
  }
})

// Alt+Tab / 点到别处 → 别留一个全屏遮罩卡在屏幕上
window.addEventListener('blur', () => {
  if (!done) cancel('blur')
})
