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
    /** 按下时光标是不是十字（框选工具的特征） */
    crossAtDown: false,
    /** 按在她身上（拖她/点她）→ 不算选字 */
    overPetAtDown: false,
    /** 按在我们真正的 UI 上（面板/气泡）→ 不算选字 */
    overUiAtDown: false,
    pin: { visible: false, shownAt: 0, holdUntil: 0 },
    lastText: '',
    lastAt: 0,
    /** 最近一次松手时**为什么这么判**（上屏到面板，排查用） */
    lastDecision: null,
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
      s.crossAtDown = !!(obs && obs.cursor === 'cross')
      s.overPetAtDown = !!(obs && obs.overPet)
      s.overUiAtDown = !!(obs && obs.overOwnUi)
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
  const o = (obs && obs.overlay) || {}
  const capture = isCaptureOverlay({
    crossCursor: s.crossAtDown || !!(obs && obs.cursor === 'cross'),
    windowCapture: !!o.windowCapture,
    topmost: !!o.topmost,
    popup: !!o.popup,
  })

  // ⚠️ 这里**不再看**「前台是不是我们自己的进程」：
  // 我们的窗是置顶+穿透的，可能只是"恰好是前台"（实际点击给的是别的程序）。
  // 真正该问的是"光标是不是压在我们的 UI / 她身上"——那个由 hitJS 精确给出（overOwnUi/overPet）。
  // 2026-10-22 真机就是因为前者，划词一次都不触发（面板显示 应用=ds-whalegirl-pet.exe）。
  if (dragged && !windowMoved && appOk && !s.overPetAtDown && !s.overUiAtDown) {
    if (capture) {
      // 这是在框选/截图，不是在选字：**绝对不要把 Ctrl+C 发过去**（会按到它的"复制"）
      emit = { type: 'skip', reason: 'capture-tool', cursor: (obs && obs.cursor) || '', topmost: !!o.topmost }
    } else {
      emit = { type: 'grab', app: appName, expectSeq: s.seq0, ms: heldMs }
      s.pendingClear = false
    }
  } else if (s.pendingClear) {
    emit = { type: 'clear', reason: 'selection-cleared' }
    s.pendingClear = false
    s.pin.visible = false
  }

  s.mouse = 'up'
  // 把这次判定的全部依据留在 state 上：面板直接显示，出问题不用猜也不用翻日志
  s.lastDecision = {
    ms: heldMs,
    cursor: (obs && obs.cursor) || '',
    topmost: !!o.topmost,
    popup: !!o.popup,
    windowCapture: !!o.windowCapture,
    app: appName,
    self: !!s.selfAtDown,
    pet: !!s.overPetAtDown,
    capture: !!capture,
    acted: emit ? emit.type : 'none',
  }
  s.start = null
  s.rect0 = null
  s.app = null
  s.selfAtDown = false
  s.crossAtDown = false
  s.overPetAtDown = false
  s.overUiAtDown = false
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

/**
 * 这一拖是「选字」还是「框选 / 截图」？
 *
 * 为什么会误判：划词要靠"发一次 Ctrl+C 再读剪贴板"来拿文本。
 * 而笔记本的 F10 截图键、各种截图工具是"框好图 → 等你点保存/复制"，
 * 我们在松手那一瞬间发的 Ctrl+C 正好按到它自己的「复制」——
 * 表现就是「还没点截获，图就被复制了，而且没落盘」（2026-10-22 真机）。
 *
 * 两个信号，任一命中就放弃：
 *   ① 光标是十字（框选工具的标配；选字用的是 I 形/箭头）
 *   ② 光标下面那个窗口是置顶弹窗（全屏框选层的标准形态）
 *   ③ **前台窗口**是置顶弹窗 —— 这条最关键：我们发出去的复制键是给「有焦点的窗口」的，
 *      而"光标下面的窗口"可能是被截的那个程序（比如 WorkBuddy）。两者不是一回事。
 *      2026-10-22 真机：框 WorkBuddy 那块时，光标下面是 workbuddy.exe（不是置顶弹窗），
 *      但键落到了截图工具的框选层上 → 被复制。所以必须把前台窗口也判一遍。
 */
function isCaptureOverlay(o) {
  const x = o && typeof o === 'object' ? o : {}
  if (x.crossCursor) return true
  if (x.windowCapture) return true
  return !!(x.topmost && x.popup)
}

/**
 * 该不该把剪贴板恢复成「我们动手之前」的样子？
 *
 * 默认是"该"（我们借剪贴板拿文本，用完要还回去）。但有三种情况**绝对不能动**：
 *   1) 剪贴板里有图 —— 笔记本的 F10 截图键 / 各种截图工具是"截完放剪贴板"，
 *      我们一恢复就把刚截的图覆盖掉了（症状：能截但保存不出东西 / 粘贴出来是旧文本）；
 *   2) 序列号又变了 —— 别人（或我们自己以外的东西）刚写过；
 *   3) 当前文本已经不是我们刚拿到的那段 —— 同上。
 *
 * 宁可把剪贴板留在"我们复制的那段文字"上，也不要去覆盖别人刚写的东西。
 */
function shouldRestoreClipboard(o) {
  const x = o && typeof o === 'object' ? o : {}
  if (x.hasImage) return false
  if (x.seqChanged) return false
  if (typeof x.currentText !== 'string') return false
  return x.currentText === String(x.capturedText == null ? '' : x.capturedText)
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
  shouldRestoreClipboard,
  isCaptureOverlay,
  cleanText,
  looksLikeFileList,
  isSkippedApp,
  isWindowDrag,
  sameRect,
  normalizeAppName,
}
