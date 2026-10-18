// 命中窗 renderer：只收真实 pointer，做 3px 的点击/拖动分流。
// 坐标一律带 screenX/screenY；主进程用它们搬窗口，用 clientX/clientY 注入渲染页。
const area = document.getElementById('hit-area')

// 诊断计数（CDP 验收用；不影响交互）
window.__hitStats = { down: 0, move: 0, up: 0, drag: 0, contextmenu: 0 }
window.__hitVisible = true
if (window.hitAPI && window.hitAPI.onVisibility) {
  window.hitAPI.onVisibility((v) => { window.__hitVisible = v })
}

let down = false
let dragging = false
let pointerId = null
let startScreen = { x: 0, y: 0 }

function screenPoint(e) {
  // CDP/某些合成输入里 screenX 会是 0；用窗口位置 + client 兜底。
  const sx = e.screenX || ((window.screenX || 0) + e.clientX)
  const sy = e.screenY || ((window.screenY || 0) + e.clientY)
  return { x: sx, y: sy }
}

function point(e) {
  const sp = screenPoint(e)
  return {
    x: e.clientX,
    y: e.clientY,
    sx: sp.x,
    sy: sp.y,
    button: e.button,
    at: Date.now(),
  }
}

function reset() {
  down = false
  dragging = false
  pointerId = null
  area.classList.remove('dragging')
}

area.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  e.preventDefault()
  down = true
  dragging = false
  pointerId = e.pointerId
  startScreen = screenPoint(e)
  window.__hitStats.down++
  try { area.setPointerCapture(e.pointerId) } catch (err) {}
  window.hitAPI.down(point(e))
})

area.addEventListener('pointermove', (e) => {
  window.__hitStats.move++
  if (!down) {
    window.hitAPI.move(point(e))
    return
  }
  const sp = screenPoint(e)
  const dx = sp.x - startScreen.x
  const dy = sp.y - startScreen.y
  if (!dragging && Math.abs(dx) + Math.abs(dy) > 3) {
    dragging = true
    window.__hitStats.drag++
    area.classList.add('dragging')
    window.hitAPI.dragStart({ sx: startScreen.x, sy: startScreen.y })
  }
  window.hitAPI.move(point(e))
})

area.addEventListener('pointerup', (e) => {
  if (!down) return
  e.preventDefault()
  const wasDragging = dragging
  const p = point(e)
  window.__hitStats.up++
  reset()
  try { area.releasePointerCapture(e.pointerId) } catch (err) {}
  if (wasDragging) window.hitAPI.dragEnd(p)
  else window.hitAPI.up(p)
})

function cancel() {
  if (!down) return
  const wasDragging = dragging
  reset()
  try { if (pointerId != null) area.releasePointerCapture(pointerId) } catch (err) {}
  window.hitAPI.cancel()
  if (wasDragging) window.hitAPI.dragEnd()
}

area.addEventListener('pointercancel', cancel)
area.addEventListener('lostpointercapture', () => { if (down) cancel() })
window.addEventListener('blur', cancel)
window.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  window.__hitStats.contextmenu++
  if (!down) window.hitAPI.contextMenu({ x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY })
})
area.addEventListener('pointerleave', () => {
  if (!down) window.hitAPI.leave()
})
window.addEventListener('wheel', (e) => {
  e.preventDefault()
  window.hitAPI.wheel({ x: e.clientX, y: e.clientY, dx: e.deltaX, dy: e.deltaY })
}, { passive: false })
