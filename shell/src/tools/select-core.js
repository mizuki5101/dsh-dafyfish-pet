'use strict'

// 「划词翻译」的全部判断逻辑（纯函数，不 require 任何东西，可被 node 直接单测）。
//
// 这里回答三个问题：
//   1) 这一次鼠标动作算不算「按住左键拖选文字」？（单击/双击/拖窗口/拖文件都不算）
//   2) 拿到的剪贴板文本值不值得弹气泡？（太短、太长、是文件路径都不值得）
//   3) 气泡弹出来之后，什么时候该收掉？（Windows 没有"选区变化"通知，只能靠几何近似）
//
// 为什么要单独一层：真机行为没法在 CI 里跑（要 koffi + 真鼠标），但状态机的坑全在
// "什么顺序下会误判"，这层可以 100% 覆盖。

/** 拖选至少要移动这么多 DIP 才算「在选字」（正常点一下也会抖 2~3px，别用 3px） */
const DEFAULT_DRAG_PX = 8
/** 拖选至少要按住这么久（毫秒）—— 快速甩一下鼠标不该触发 */
const MIN_DRAG_MS = 120
/** 气泡刚弹出来的这段时间里，任何 click 都不当成「取消选中」（松手边沿会紧跟一个 down） */
const PIN_GRACE_MS = 600
/** 同一条文本在这个间隔内不重复弹（一次拖选可能被采样两遍） */
const DEDUPE_MS = 1500

function createState() {
  return {
    /** 'up' | 'down' | 'drag' */
    mouse: 'up',
    start: null,
    t0: 0,
    rect0: null,
    seq0: 0,
    app: null,
    /**
     * 按下时前台是**我们自己的进程**（在她自己的面板/气泡里拖选）→ 不抓。
     *
     * ⚠️ 这里判的是**进程身份**，不是「落点在不在主窗矩形内」。
     * 主窗可以铺满主屏（settings.json fullscreenPrimary=true），那时"落点在窗内"
     * 恒为真 —— 2026-10-22 用矩形判过一次，结果所有拖选都被当成"在自己窗口里"，
     * 划词整条哑火。
     */
    selfAtDown: false,
    /** down 落在气泡/面板之外 —— 若最后是单击（没拖动）就代表"取消选中" */
    pendingClear: false,
    pin: { visible: false, shownAt: 0, holdUntil: 0 },
    lastText: '',
    lastAt: 0,
  }
}

function clone(state) {
  return Object.assign({}, state, { pin: Object.assign({}, state.pin) })
}

function sameRect(a, b, tolerance) {
  if (!a || !b) return true // 拿不到就当作没变（宁可放过，不要误杀）
  const t = Number.isFinite(tolerance) ? tolerance : 2
  return (
    Math.abs(a.left - b.left) <= t &&
    Math.abs(a.top - b.top) <= t &&
    Math.abs(a.right - b.right) <= t &&
    Math.abs(a.bottom - b.bottom) <= t
  )
}

/** 拖窗口 / 拖动对话框会改变前台窗口的矩形 —— 这是最省事的"不是选字"信号 */
function isWindowDrag(rect0, rect1, tolerance) {
  if (!rect0 || !rect1) return false
  return !sameRect(rect0, rect1, tolerance)
}

function normalizeAppName(name) {
  if (typeof name !== 'string') return ''
  const base = name.split(/[\\/]/).pop() || ''
  return base.trim().toLowerCase().replace(/\.exe$/, '')
}

/** 这个前台程序要不要跳过（终端里模拟 Ctrl+C 会打断正在跑的命令） */
function isSkippedApp(name, list) {
  const n = normalizeAppName(name)
  if (!n) return false
  const arr = Array.isArray(list) ? list : []
  for (const x of arr) {
    if (normalizeAppName(x) === n) return true
  }
  return false
}

/** 单行/多行的绝对路径列表（拖文件、资源管理器里 Ctrl+C、某些 IDE 的路径复制） */
function looksLikeFileList(text) {
  if (typeof text !== 'string') return false
  const t = text.trim()
  if (!t) return false
  const lines = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (!lines.length) return false
  const isPath = (s) => /^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s)
  if (lines.length === 1) {
    const one = lines[0]
    // 单行时要求"整行就是个路径"：没有空白、没有中文句子特征（避免误杀「C:\ 是系统盘吗」）
    if (!isPath(one)) return false
    if (/\s/.test(one)) return false
    if (/[\u4e00-\u9fa5]/.test(one)) return false
    return true
  }
  let pathish = 0
  for (const l of lines) if (isPath(l)) pathish++
  return pathish / lines.length >= 0.8
}

/**
 * 剪贴板文本 → 能不能用。
 * 返回 { ok:true, text, chars, truncated } 或 { ok:false, reason }
 */
function cleanText(raw, cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {}
  const maxChars = Number.isFinite(Number(c.maxChars)) ? Math.round(Number(c.maxChars)) : 4000
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' }
  const text = raw.replace(/\r\n?/g, '\n').trim()
  if (!text) return { ok: false, reason: 'empty' }
  if (text.length < 2) return { ok: false, reason: 'too-short' }
  // 一次选中整篇文档：连截断都没意义，纯浪费一次请求
  if (text.length > 20000) return { ok: false, reason: 'too-long' }
  if (looksLikeFileList(text)) return { ok: false, reason: 'file-list' }
  if (text.length > maxChars) {
    return { ok: true, text: text.slice(0, maxChars), chars: maxChars, truncated: true }
  }
  return { ok: true, text, chars: text.length, truncated: false }
}

/**
 * 一个采样周期。
 *
 * obs = {
 *   down: boolean,            // 左键是否按着
 *   pt: {x,y},                // 屏幕 DIP（Electron screen.getCursorScreenPoint）
 *   rect: {left,top,right,bottom}|null,  // 前台窗口矩形（物理像素即可，只用于比较是否变过）
 *   app: {ok,name,self}|null, // 前台进程；self = 是不是我们自己的进程
 *   seq: number,              // 剪贴板序列号
 *   now: number,
 *   overOwnUi: boolean,       // 落点是不是压在我们**真正的 UI**（面板/气泡按钮）上
 * }
 *
 * ⚠️ overOwnUi 不能拿「落点在不在主窗矩形内」代替：主窗可以铺满主屏
 * （fullscreenPrimary=true），那时恒为真 —— 2026-10-22 就是这么让划词整条哑火的。
 *
 * 返回 { state, emit }，emit 为 null | {type:'grab', app, expectSeq, ms} | {type:'clear', reason}
 */
function step(state, obs, cfg) {
  const s = clone(state)
  const c = cfg && typeof cfg === 'object' ? cfg : {}
  const dragPx = Number.isFinite(Number(c.dragPx)) ? Math.round(Number(c.dragPx)) : DEFAULT_DRAG_PX
  const now = Number(obs && obs.now) || 0
  const down = !!(obs && obs.down)
  const pt = (obs && obs.pt) || { x: 0, y: 0 }
  let emit = null

  if (down) {
    if (s.mouse === 'up') {
      // 起手：先判定这是不是"点了别处"（= 取消选中，气泡该消失）
      if (s.pin.visible) {
        const fresh = now - s.pin.shownAt < PIN_GRACE_MS
        const held = now < s.pin.holdUntil
        if (!fresh && !held && !(obs && obs.overOwnUi)) s.pendingClear = true
      }
      s.mouse = 'down'
      s.start = { x: pt.x, y: pt.y }
      s.t0 = now
      s.rect0 = (obs && obs.rect) || null
      s.seq0 = Number(obs && obs.seq) || 0
      s.app = (obs && obs.app) || null
      // 前台是我们自己（在她自己的面板里选字）→ 后面不抓，否则会给我们自己发 Ctrl+C
      s.selfAtDown = !!(obs && obs.app && obs.app.self)
    } else if (s.mouse === 'down') {
      const dx = Math.abs(pt.x - s.start.x)
      const dy = Math.abs(pt.y - s.start.y)
      if (Math.max(dx, dy) >= dragPx && now - s.t0 >= MIN_DRAG_MS) s.mouse = 'drag'
    }
    return { state: s, emit }
  }

  // 松手
  if (s.mouse === 'up') return { state: s, emit }

  const wasDrag = s.mouse === 'drag'
  const heldMs = now - s.t0
  const dragged = wasDrag && heldMs >= MIN_DRAG_MS
  const windowMoved = isWindowDrag(s.rect0, obs && obs.rect)
  const appName = s.app && s.app.ok ? s.app.name : ''
  const appOk = !!(s.app && s.app.ok) && !isSkippedApp(appName, c.skipApps)

  if (dragged && !windowMoved && appOk && !s.selfAtDown) {
    emit = { type: 'grab', app: appName, expectSeq: s.seq0, ms: heldMs }
    s.pendingClear = false
  } else if (s.pendingClear) {
    emit = { type: 'clear', reason: 'selection-cleared' }
    s.pendingClear = false
    s.pin.visible = false
  }

  s.mouse = 'up'
  s.start = null
  s.rect0 = null
  s.app = null
  s.selfAtDown = false
  return { state: s, emit }
}

/** 气泡显示/隐藏（页面推来时调；只有 reducer 之外的人知道真实可见性） */
function markPin(state, visible, now) {
  const s = clone(state)
  s.pin.visible = !!visible
  if (visible) {
    s.pin.shownAt = Number(now) || 0
    s.pendingClear = false
  } else {
    s.pin.shownAt = 0
    s.pin.holdUntil = 0
    s.pendingClear = false
  }
  return s
}

/** 页面报「鼠标按在气泡上了」→ 这段时间里的 clear 一律吞掉 */
function holdPin(state, now, ms) {
  const s = clone(state)
  s.pin.holdUntil = (Number(now) || 0) + (Number(ms) || 1200)
  return s
}

/** 同一条文本的重复去抖 */
function shouldAcceptText(state, text, now) {
  if (!text) return false
  if (state.lastText === text && now - state.lastAt < DEDUPE_MS) return false
  return true
}

function rememberText(state, text, now) {
  const s = clone(state)
  s.lastText = String(text || '')
  s.lastAt = Number(now) || 0
  return s
}

module.exports = {
  DEFAULT_DRAG_PX,
  MIN_DRAG_MS,
  PIN_GRACE_MS,
  DEDUPE_MS,
  createState,
  step,
  markPin,
  holdPin,
  shouldAcceptText,
  rememberText,
  cleanText,
  looksLikeFileList,
  isSkippedApp,
  isWindowDrag,
  sameRect,
  normalizeAppName,
}
