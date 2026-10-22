'use strict'

// 全局键鼠 / 前台窗口 / 剪贴板序列号 —— 全项目唯一的原生调用层（Koffi + user32/kernel32）。
//
// 为什么需要它：Electron 没有任何「全局鼠标按键状态 / 全局键盘状态 / 前台窗口」的 API。
//   - screen.getCursorScreenPoint() 只给位置，给不了「左键按下没有」；
//   - globalShortcut 只能注册组合键，而且会抢占系统快捷键；
//   - SetWindowsHookEx(WH_MOUSE_LL) 需要带消息泵的线程 + 跨线程回调，掉钩子风险高。
// 所以这里只做两件最稳的事：
//   1) 轮询 GetAsyncKeyState / GetCursorPos（与 main.js 的 cursorFeed 同一套路子）；
//   2) 一次性 keybd_event 模拟 Ctrl+C，用「剪贴板序列号」判断到底有没有复制成功。
//
// ⚠️ 刻意**不碰 hit/guard.js**：那份是双窗口的核心，改它风险远大于收益，
//    所以 resolveKoffi 在这里独立实现一份（加载顺序与它保持一致）。
//
// ⚠️ 原生 .node 不能从 asar 里加载，Koffi 放在 resources/koffi（build.mjs 只做存在性检查）。
//    缺了不崩：available() 返回 false，划词翻译整条优雅停用（识图不依赖这里）。

const path = require('node:path')

const VK_LBUTTON = 0x01
const VK_CONTROL = 0x11
const VK_SHIFT = 0x10
const VK_LSHIFT = 0xa0
const VK_RSHIFT = 0xa1
const VK_C = 0x43
const VK_INSERT = 0x2d
const KEYEVENTF_KEYUP = 0x0002
const CF_HDROP = 15
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
/** 系统光标的资源 ID（LoadCursorW 用；同一台机器上这些句柄跨进程一致） */
const IDC = { arrow: 32512, ibeam: 32513, cross: 32515, hand: 32649 }
const GWL_STYLE = -16
const GWL_EXSTYLE = -20
const WS_POPUP = 0x80000000
const WS_EX_TOPMOST = 0x00000008

function resolveKoffi() {
  const candidates = []
  if (process.env.DSH_PET_KOFFI) candidates.push(process.env.DSH_PET_KOFFI)
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'koffi'))
  candidates.push(path.join(path.dirname(process.execPath), 'resources', 'koffi'))
  candidates.push(path.join(__dirname, '..', '..', 'node_modules', 'koffi'))
  for (const c of candidates) {
    try {
      return require(c)
    } catch (e) {}
  }
  try {
    return require('koffi')
  } catch (e) {}
  return null
}

let api = null
let initTried = false
let initReason = ''
let log = () => {}
const nameCache = new Map()
/** POINT 结构（WindowFromPoint 是按值传的，必须注册成 koffi.struct） */
let POINT = null

function report(msg) {
  try {
    log('[keys] ' + msg)
  } catch (e) {}
}

function init() {
  if (initTried) return api
  initTried = true
  if (process.platform !== 'win32') {
    initReason = 'not-win32'
    return null
  }
  try {
    const koffi = resolveKoffi()
    if (!koffi) {
      initReason = 'koffi-missing'
      report('Koffi 不可用（resources/koffi 或 node_modules/koffi）→ 划词翻译停用')
      return null
    }
    const user32 = koffi.load('user32.dll')
    const kernel32 = koffi.load('kernel32.dll')
    POINT = koffi.struct('POINT', { x: 'int', y: 'int' })
    api = {
      koffi,
      getAsyncKeyState: user32.func('short __stdcall GetAsyncKeyState(int vKey)'),
      getCursorPos: user32.func('bool __stdcall GetCursorPos(void *lpPoint)'),
      getForegroundWindow: user32.func('void *__stdcall GetForegroundWindow()'),
      getWindowRect: user32.func('bool __stdcall GetWindowRect(void *hWnd, void *lpRect)'),
      getWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hWnd, void *lpdwProcessId)'),
      isClipboardFormatAvailable: user32.func('bool __stdcall IsClipboardFormatAvailable(uint32 format)'),
      getClipboardSequenceNumber: user32.func('uint32 __stdcall GetClipboardSequenceNumber()'),
      keybdEvent: user32.func('void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, void *dwExtraInfo)'),
      openProcess: kernel32.func('void *__stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)'),
      queryFullProcessImageNameW: kernel32.func(
        'bool __stdcall QueryFullProcessImageNameW(void *hProcess, uint32 dwFlags, void *lpExeName, void *lpdwSize)',
      ),
      closeHandle: kernel32.func('bool __stdcall CloseHandle(void *hObject)'),
      loadCursor: user32.func('void *__stdcall LoadCursorW(void *hInstance, void *lpCursorName)'),
      getCursorInfo: user32.func('bool __stdcall GetCursorInfo(void *pci)'),
      getWindowLongPtr: user32.func('intptr_t __stdcall GetWindowLongPtrW(void *hWnd, int nIndex)'),
      // 光标下面**真正会收到这一击**的窗口（比 GetForegroundWindow 可靠，见 targetWindow 注释）
      // 签名里的 POINT 是上面 koffi.struct('POINT', …) 注册的类型名（按值传）
      windowFromPoint: user32.func('void *__stdcall WindowFromPoint(POINT pt)'),
      getAncestor: user32.func('void *__stdcall GetAncestor(void *hwnd, uint32 gaFlags)'),
    }
    report('Koffi 就绪（' + (process.resourcesPath || 'resourcesPath 未知') + '）')
    return api
  } catch (e) {
    initReason = 'load-failed'
    report('加载 user32/kernel32 失败：' + (e && e.message))
    api = null
    return null
  }
}

function available() {
  return !!init()
}

function unavailableReason() {
  init()
  return initReason
}

function keyDown(vk) {
  const a = init()
  if (!a) return false
  return (a.getAsyncKeyState(vk) & 0x8000) !== 0
}

/** 左键当前是否按着（轮询用） */
function leftDown() {
  return keyDown(VK_LBUTTON)
}

/** Shift 是否按着（Shift+右击的兜底判定：命中窗是 WS_EX_NOACTIVATE，可能收不到键盘消息） */
function shiftDown() {
  return keyDown(VK_SHIFT) || keyDown(VK_LSHIFT) || keyDown(VK_RSHIFT)
}

function ctrlDown() {
  return keyDown(VK_CONTROL)
}

/**
 * 全局光标。⚠️ **物理像素**（与 Electron 的 screen.getCursorScreenPoint() 的 DIP 不是一个单位）。
 * 主流程不要用它做位置判定，一律用 screen.getCursorScreenPoint()，这里只留作诊断。
 */
function cursor() {
  const a = init()
  if (!a) return null
  const buf = Buffer.alloc(8)
  if (!a.getCursorPos(buf)) return null
  return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) }
}

function foreground() {
  const a = init()
  if (!a) return null
  try {
    const h = a.getForegroundWindow()
    return h || null
  } catch (e) {
    return null
  }
}

function windowRect(hwnd) {
  const a = init()
  if (!a || !hwnd) return null
  const buf = Buffer.alloc(16)
  if (!a.getWindowRect(hwnd, buf)) return null
  return {
    left: buf.readInt32LE(0),
    top: buf.readInt32LE(4),
    right: buf.readInt32LE(8),
    bottom: buf.readInt32LE(12),
  }
}

/**
 * 前台窗口的进程名（小写 basename）。
 * 返回 { ok:true, pid, name } / { ok:false, reason:'elevated'|'no-window'|'query-failed' }
 *
 * elevated 判定：QueryFullProcessImageNameW 需要 PROCESS_QUERY_LIMITED_INFORMATION，
 * 管理员权限的进程会拒绝中等完整性进程的查询（UIPI）→ 我们也就发不进 Ctrl+C。
 */
function foregroundProcess() {
  return processOf(foreground())
}

/**
 * 光标下面**真正会收到这一击**的窗口：{ hwnd, root, pt }。
 *
 * ⚠️ 不能用 GetForegroundWindow 代替（2026-10-22 真机踩过）：
 * 我们的桌宠窗是「置顶 + 点击穿透」的，但它**仍然可能是前台窗口**。
 * 那样就会把"你正在操作的 Chrome"认成我们自己（面板显示 `应用=ds-whalegirl-pet.exe`），
 * self 判定为真 → 划词一次都不触发。
 * 透明/穿透窗口不参与命中测试，所以 WindowFromPoint 会落到真正接收点击的那一层。
 * root 是顶层窗（样式/矩形要看顶层窗，子窗口没有 WS_EX_TOPMOST）。
 */
function targetWindow() {
  const a = init()
  if (!a) return null
  const pos = Buffer.alloc(8)
  if (!a.getCursorPos(pos)) return null
  const pt = { x: pos.readInt32LE(0), y: pos.readInt32LE(4) }
  let hwnd = null
  try {
    hwnd = a.windowFromPoint(pt)
  } catch (e) {
    hwnd = null
  }
  if (!hwnd) hwnd = foreground()
  if (!hwnd) return null
  let root = hwnd
  try {
    const r = a.getAncestor(hwnd, 2) // GA_ROOT
    if (r) root = r
  } catch (e) {}
  return { hwnd, root, pt }
}

/** 任意窗口 → 进程信息（{ok,pid,name,path} / {ok:false,reason}） */
function processOf(hwnd) {
  const a = init()
  if (!a) return { ok: false, reason: 'no-native' }
  if (!hwnd) return { ok: false, reason: 'no-window' }
  const pidBuf = Buffer.alloc(4)
  try {
    a.getWindowThreadProcessId(hwnd, pidBuf)
  } catch (e) {
    return { ok: false, reason: 'no-window' }
  }
  const pid = pidBuf.readUInt32LE(0)
  if (!pid) return { ok: false, reason: 'no-window' }
  const hit = nameCache.get(pid)
  if (hit) return { ok: true, pid, name: hit }

  const h = a.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!h) return { ok: false, pid, reason: 'elevated' }
  try {
    const buf = Buffer.alloc(2048)
    const sizeBuf = Buffer.alloc(4)
    sizeBuf.writeUInt32LE(1024, 0)
    const ok = a.queryFullProcessImageNameW(h, 0, buf, sizeBuf)
    if (!ok) return { ok: false, pid, reason: 'query-failed' }
    const len = sizeBuf.readUInt32LE(0) * 2
    const full = buf.toString('utf16le', 0, len)
    const name = full.split(/[\\/]/).pop().toLowerCase()
    if (nameCache.size > 64) nameCache.clear()
    nameCache.set(pid, name)
    return { ok: true, pid, name, path: full }
  } catch (e) {
    return { ok: false, pid, reason: 'query-failed' }
  } finally {
    try {
      a.closeHandle(h)
    } catch (e) {}
  }
}

/** 剪贴板是否装着「文件列表」（拖文件/资源管理器复制的 CF_HDROP） */
function isFileDrop() {
  const a = init()
  if (!a) return false
  try {
    return !!a.isClipboardFormatAvailable(CF_HDROP)
  } catch (e) {
    return false
  }
}

/** 剪贴板序列号：变了 = 剪贴板被写过（比读内容可靠，且不受格式影响） */
function clipSeq() {
  const a = init()
  if (!a) return 0
  try {
    return a.getClipboardSequenceNumber() >>> 0
  } catch (e) {
    return 0
  }
}

/**
 * 模拟一次「复制」。默认用 **Ctrl+Insert**，不行再退 Ctrl+C。
 *
 * 为什么不是直接用 Ctrl+C（2026-10-22）：
 *   截图工具/各种软件几乎都把「复制」绑在 **Ctrl+C** 上。我们为了拿选中的文字要发复制键，
 *   一旦这一拖其实是在框选，Ctrl+C 就按到了对方自己的「复制」——
 *   表现是"框好图、还没点保存，图就被复制了"。
 *   Ctrl+Insert 是 Windows 另一条标准复制快捷键（记事本/浏览器/Office/资源管理器都支持），
 *   但**极少有截图工具绑它**。所以先试它，撞车概率低得多；不行再退 Ctrl+C。
 *
 * 用 keybd_event 而不是 SendInput：后者要手工摆 40 字节的 INPUT 联体结构，
 * 一处对齐错就静默无效（返回 0 还不报错）；两者最终都走 NtUserSendInput，UIPI 限制相同。
 */
function sendCopy(which) {
  const a = init()
  if (!a) return false
  if (ctrlDown()) return false // 用户自己按着 Ctrl，别叠加出一堆怪组合键
  const vk = which === 'c' ? VK_C : VK_INSERT
  try {
    a.keybdEvent(VK_CONTROL, 0, 0, null)
    a.keybdEvent(vk, 0, 0, null)
    a.keybdEvent(vk, 0, KEYEVENTF_KEYUP, null)
    a.keybdEvent(VK_CONTROL, 0, KEYEVENTF_KEYUP, null)
    return true
  } catch (e) {
    return false
  }
}

function setLog(fn) {
  if (typeof fn === 'function') log = fn
}

// ————————————————————————————————————————————————————————————
// 「这是不是框选 / 截图工具」的两个信号（2026-10-22）
//
// 起因：博士的笔记本 F10 截图键「框好图、还没点截获，图就被复制了」。
// 根因是我们在他拖框松手时发了一次 Ctrl+C（划词要用剪贴板），正好按到了
// 截图工具自己的「复制」。所以要能认出"这一拖不是在选字，是在框选"。
//
// 两个信号，任一命中就跳过：
//   ① 光标是**十字**（IDC_CROSS）—— 框选/绘图/截图几乎都用十字，选字用的是 I 形或箭头；
//   ② 前台窗口是**置顶的弹窗**（WS_POPUP + WS_EX_TOPMOST）—— 全屏框选层的标准形态。
// 自己的窗口也是 topmost+popup，但那条路已经被「前台是不是我们自己的进程」挡住了。
// ————————————————————————————————————————————————————————————
let cursorHandles = null

function toAddr(koffi, p) {
  try {
    const a = koffi.address(p)
    return typeof a === 'bigint' ? Number(a) : Number(a)
  } catch (e) {
    return 0
  }
}

/**
 * 当前系统光标是什么形状：'arrow' | 'ibeam' | 'cross' | 'hand' | 'other' | 'unknown'
 * ⚠️ 只认系统光标。截图工具如果自带一套自绘光标，这里会返回 'other'，
 *    此时靠第二条信号（置顶弹窗）兜底。
 */
function cursorKind() {
  const a = init()
  if (!a) return 'unknown'
  if (!cursorHandles) {
    const map = {}
    try {
      for (const k of Object.keys(IDC)) map[k] = toAddr(a.koffi, a.loadCursor(null, IDC[k]))
    } catch (e) {
      return 'unknown'
    }
    cursorHandles = map
  }
  const ptr = a.koffi.sizeof('void *')
  const size = 8 + ptr + 8 // CURSORINFO: cbSize+flags+hCursor+POINT
  const buf = Buffer.alloc(size)
  buf.writeUInt32LE(size, 0)
  try {
    if (!a.getCursorInfo(buf)) return 'unknown'
  } catch (e) {
    return 'unknown'
  }
  const h = ptr === 8 ? Number(buf.readBigUInt64LE(8)) : buf.readUInt32LE(8)
  for (const k of Object.keys(cursorHandles)) {
    if (cursorHandles[k] && cursorHandles[k] === h) return k
  }
  return 'other'
}

/** 前台窗口的形态：{ popup, topmost }（拿不到返回 null） */
function windowFlags(hwnd) {
  const a = init()
  if (!a || !hwnd) return null
  try {
    const st = Number(BigInt.asUintN(32, BigInt(a.getWindowLongPtr(hwnd, GWL_STYLE))))
    const ex = Number(BigInt.asUintN(32, BigInt(a.getWindowLongPtr(hwnd, GWL_EXSTYLE))))
    return { popup: !!(st & WS_POPUP), topmost: !!(ex & WS_EX_TOPMOST) }
  } catch (e) {
    return null
  }
}

module.exports = {
  setLog,
  available,
  unavailableReason,
  leftDown,
  shiftDown,
  ctrlDown,
  cursor,
  cursorKind,
  windowFlags,
  foreground,
  targetWindow,
  processOf,
  windowRect,
  foregroundProcess,
  isFileDrop,
  clipSeq,
  sendCopy,
  VK_LBUTTON,
}
