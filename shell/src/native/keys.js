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
const KEYEVENTF_KEYUP = 0x0002
const CF_HDROP = 15
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

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
  const a = init()
  if (!a) return { ok: false, reason: 'no-native' }
  const hwnd = foreground()
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
 * 模拟一次 Ctrl+C。
 * 用 keybd_event 而不是 SendInput：后者要手工摆 40 字节的 INPUT 联体结构，
 * 一处对齐错就静默无效（返回 0 还不报错）；两者最终都走 NtUserSendInput，UIPI 限制相同。
 */
function sendCopy() {
  const a = init()
  if (!a) return false
  if (ctrlDown()) return false // 用户自己按着 Ctrl，别叠加出一堆怪组合键
  try {
    a.keybdEvent(VK_CONTROL, 0, 0, null)
    a.keybdEvent(VK_C, 0, 0, null)
    a.keybdEvent(VK_C, 0, KEYEVENTF_KEYUP, null)
    a.keybdEvent(VK_CONTROL, 0, KEYEVENTF_KEYUP, null)
    return true
  } catch (e) {
    return false
  }
}

function setLog(fn) {
  if (typeof fn === 'function') log = fn
}

module.exports = {
  setLog,
  available,
  unavailableReason,
  leftDown,
  shiftDown,
  ctrlDown,
  cursor,
  foreground,
  windowRect,
  foregroundProcess,
  isFileDrop,
  clipSeq,
  sendCopy,
  VK_LBUTTON,
}
