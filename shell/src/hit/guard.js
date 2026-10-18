'use strict'

// Windows 命中窗防激活守卫（独立实现）。
//
// 依据 Chromium 的 HWNDMessageHandler::OnMouseActivate：
//   1) 窗口上有 "Chrome.IgnoreMouseActivate" 属性时：RemoveProp + 返回 MA_NOACTIVATE；
//   2) 否则才看 HasNonClientView / WS_EX_NOACTIVATE。
// Chromium 每次点击会消费掉这个属性，所以 hook WM_MOUSEACTIVATE，每次重新 SetPropW。
//
// 只调用 user32 的公开 API；Koffi 只负责把 DLL 函数接进来。
// 参考过 clawd-on-desk（AGPL-3.0）的架构，但没有复制它的代码。

const path = require('node:path')

const GWL_EXSTYLE = -20
const WS_EX_NOACTIVATE = 0x08000000
const WM_MOUSEACTIVATE = 0x0021
const MOUSE_ACTIVATE_PROP = 'Chrome.IgnoreMouseActivate'
const STYLE_REFRESH_FLAGS = 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020

function resolveKoffi() {
  const candidates = []
  if (process.env.DSH_PET_KOFFI) candidates.push(process.env.DSH_PET_KOFFI)
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'koffi'))
  candidates.push(path.join(path.dirname(process.execPath), 'resources', 'koffi'))
  candidates.push(path.join(__dirname, '..', '..', 'node_modules', 'koffi'))
  for (const c of candidates) {
    try { return require(c) } catch (e) {}
  }
  try { return require('koffi') } catch (e) {}
  return null
}

function asNumber(value) {
  if (typeof value === 'bigint') return Number(BigInt.asUintN(32, value))
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function createHitGuard(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const report = (msg) => {
    try { log('[hit-guard] ' + msg) } catch (e) {}
  }

  let koffi = null
  let user32 = null
  let fns = null
  let pointerBits = 64
  let hwnd = null
  let hwndAddress = null
  let hookedWin = null
  let active = false
  let available = false

  if (process.platform === 'win32') {
    try {
      koffi = resolveKoffi()
      if (!koffi) {
        report('Koffi 不可用（resources/koffi 或 node_modules/koffi）')
      } else {
        user32 = koffi.load('user32.dll')
        pointerBits = koffi.sizeof('void *') * 8
        fns = {
          getStyle: user32.func('intptr_t __stdcall GetWindowLongPtrW(void* hWnd, int nIndex)'),
          setStyle: user32.func('intptr_t __stdcall SetWindowLongPtrW(void* hWnd, int nIndex, intptr_t dwNewLong)'),
          setPos: user32.func('bool __stdcall SetWindowPos(void* hWnd, void* hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)'),
          setProp: user32.func('bool __stdcall SetPropW(void* hWnd, str16 lpString, void* hData)'),
          removeProp: user32.func('void* __stdcall RemovePropW(void* hWnd, str16 lpString)'),
        }
        available = true
      }
    } catch (e) {
      report('加载 user32 失败：' + (e && e.message))
      available = false
    }
  }

  function liveHwnd(win) {
    if (!available || !win) return null
    try {
      if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return null
      const buf = win.getNativeWindowHandle()
      if (!buf || !buf.length) return null
      return koffi.decode(buf, 'void *')
    } catch (e) {
      report('取 HWND 失败：' + (e && e.message))
      return null
    }
  }

  function readStyle() {
    if (!fns || !hwnd) return null
    try { return asNumber(fns.getStyle(hwnd, GWL_EXSTYLE)) } catch (e) { return null }
  }

  function writeStyle(style) {
    if (!fns || !hwnd) return false
    try {
      const native = pointerBits > 32
        ? BigInt.asIntN(pointerBits, BigInt(style >>> 0))
        : Number(BigInt.asIntN(32, BigInt(style >>> 0)))
      fns.setStyle(hwnd, GWL_EXSTYLE, native)
      return true
    } catch (e) {
      report('写 WS_EX 失败：' + (e && e.message))
      return false
    }
  }

  function refreshFrame() {
    if (!fns || !hwnd) return false
    try { return !!fns.setPos(hwnd, null, 0, 0, 0, 0, STYLE_REFRESH_FLAGS) } catch (e) { return false }
  }

  function armProperty() {
    if (!fns || !hwnd) return false
    try { return !!fns.setProp(hwnd, MOUSE_ACTIVATE_PROP, hwnd) } catch (e) { return false }
  }

  function disarmProperty() {
    if (!fns || !hwnd) return
    try { fns.removeProp(hwnd, MOUSE_ACTIVATE_PROP) } catch (e) {}
  }

  function prepare(win) {
    if (!available || !win || hookedWin === win) return active
    hwnd = liveHwnd(win)
    if (!hwnd) {
      report('没有 HWND，退化为普通窗口')
      return false
    }
    try { hwndAddress = koffi.address(hwnd) } catch (e) { hwndAddress = null }

    const style = readStyle()
    if (style == null) return false
    if (!(style & WS_EX_NOACTIVATE)) {
      if (!writeStyle(style | WS_EX_NOACTIVATE)) return false
    }
    refreshFrame()
    if (!armProperty()) {
      report('SetPropW 失败，退化为普通窗口')
      return false
    }
    try {
      win.hookWindowMessage(WM_MOUSEACTIVATE, () => {
        if (active) armProperty()
      })
    } catch (e) {
      report('hookWindowMessage 失败：' + (e && e.message))
      disarmProperty()
      return false
    }
    hookedWin = win
    active = true
    report('已启用（hwnd=' + String(hwndAddress) + '）')
    return true
  }

  function dispose() {
    if (hookedWin) {
      try { hookedWin.unhookWindowMessage(WM_MOUSEACTIVATE) } catch (e) {}
    }
    disarmProperty()
    hookedWin = null
    active = false
    return true
  }

  return {
    prepare,
    dispose,
    get available() { return available },
    get active() { return active },
    get hwnd() { return hwndAddress },
    readStyle,
  }
}

module.exports = { createHitGuard, WS_EX_NOACTIVATE, WM_MOUSEACTIVATE, MOUSE_ACTIVATE_PROP }
