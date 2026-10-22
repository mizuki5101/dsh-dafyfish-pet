'use strict'

// 「识图（实验性）」：Shift+右击她 → 全屏遮罩框一块 → 截图 → 让视觉模型描述 → 特殊气泡。
//
// 为什么是自己开一个 BrowserWindow：
//   主窗默认 560×900（readFullscreenPrimary 默认 false），页面里铺不了全屏遮罩；
//   临时把主窗改全屏会牵动 applyFullscreenPrimaryBounds 那整套位置/拖动/命中窗逻辑。
//
// 两个必须守住的顺序：
//   1) **先 hide 遮罩、等两帧、再 getSources** —— 否则拍出来半屏是那块半透明黑幕；
//   2) 调用模型期间 heart.hold()/release() 必须 try/finally —— 漏了心跳会永久停摆。

const path = require('node:path')
const { BrowserWindow, screen } = require('electron')
const { captureScreen } = require('../heart/capture')
const vision = require('../heart/vision')

const HIDE_SETTLE_MS = 90

const SHOT_SYSTEM =
  '你是桌面宠物「大肥鱼」的眼睛。主人从屏幕上框了一小块给你看。\n' +
  '要求：\n' +
  '1) 只用简体中文，1~3 句，说清这里是什么、最要紧的内容是什么（能读出字就引一下原话）；\n' +
  '2) 只描述框里的东西，绝对不要提"框""矩形""截图""选区"这些词，也不要猜框外的事；\n' +
  '3) 看不清就直说看不清，不要编；\n' +
  '4) 不要用 markdown，不要分点。'

const SHOT_DEFAULT_PROMPT = '这是我框出来的一块屏幕，告诉我这是什么、上面写了什么。'

function createShot(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const getCfg = typeof options.getCfg === 'function' ? options.getCfg : () => null
  const getHeart = typeof options.getHeart === 'function' ? options.getHeart : () => null
  const pinShow = typeof options.pinShow === 'function' ? options.pinShow : () => 0
  const pinUpdate = typeof options.pinUpdate === 'function' ? options.pinUpdate : () => {}
  const onOpenChange = typeof options.onOpenChange === 'function' ? options.onOpenChange : () => {}
  const report = (m) => {
    try {
      log('[shot] ' + m)
    } catch (e) {}
  }

  let ovWin = null
  let busy = false
  let lastRect = null

  function isOpen() {
    return !!(ovWin && !ovWin.isDestroyed() && ovWin.isVisible())
  }

  function destroyOverlay() {
    if (!ovWin) return
    try {
      if (!ovWin.isDestroyed()) ovWin.destroy()
    } catch (e) {}
    ovWin = null
    onOpenChange(false)
  }

  function hideOverlay() {
    if (!ovWin || ovWin.isDestroyed()) return
    try {
      ovWin.hide()
    } catch (e) {}
    onOpenChange(false)
  }

  function ensureOverlay() {
    if (ovWin && !ovWin.isDestroyed()) return ovWin
    const d = screen.getPrimaryDisplay()
    const b = d.bounds
    ovWin = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      enableLargerThanScreen: true,
      title: '框选一块屏幕',
      webPreferences: {
        preload: path.join(__dirname, 'preload-overlay.js'),
        contextIsolation: true,
        backgroundThrottling: false,
      },
    })
    ovWin.setAlwaysOnTop(true, 'screen-saver')
    ovWin.setMenuBarVisibility(false)
    try {
      ovWin.webContents.setVisualZoomLevelLimits(1, 1)
    } catch (e) {}
    ovWin.loadFile(path.join(__dirname, 'overlay.html'))
    ovWin.on('closed', () => {
      ovWin = null
      onOpenChange(false)
    })
    return ovWin
  }

  /** 前置检查 + 弹遮罩。返回 { ok } 或 { ok:false, reason, hint } */
  function start() {
    const cfg = getCfg()
    const v = (cfg && cfg.tools && cfg.tools.vision) || {}
    if (!v.enabled) return { ok: false, reason: 'disabled', hint: '识图是关着的，先在功能面板里打开' }
    const m = (cfg && cfg.model) || {}
    if (!m.baseUrl) {
      return { ok: false, reason: 'no-model', hint: '还没配能看图的模型（功能面板 → 模型）' }
    }
    if (busy) return { ok: false, reason: 'busy', hint: '上一张还没看完' }
    if (isOpen()) return { ok: true }
    const w = ensureOverlay()
    const show = () => {
      try {
        // 遮罩窗是复用的：先把上一轮的 done/框复位，否则第二次框选会毫无反应
        w.webContents.send('shot:reset')
        w.show()
        w.focus()
        w.moveTop()
      } catch (e) {}
      onOpenChange(true)
      report('遮罩已弹出')
    }
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', show)
    else show()
    return { ok: true }
  }

  function cancel(reason) {
    lastRect = null
    hideOverlay()
    report('取消：' + (reason || 'unknown'))
    return { ok: true }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }

  /** 遮罩 → 截图。必须唯一入口：先 hide 再等两帧再拍。 */
  async function hideThenCapture(region) {
    const bounds = ovWin && !ovWin.isDestroyed() ? ovWin.getContentBounds() : null
    hideOverlay()
    await sleep(HIDE_SETTLE_MS)
    const abs = {
      x: Math.round((bounds ? bounds.x : 0) + region.x),
      y: Math.round((bounds ? bounds.y : 0) + region.y),
      w: Math.round(region.w),
      h: Math.round(region.h),
    }
    const cap = await captureScreen({ region: abs, includeImage: true, quality: 92 })
    return { cap, abs, bounds }
  }

  /** 遮罩层交来一块区域 */
  async function submitRect(rect) {
    const r = rect && typeof rect === 'object' ? rect : null
    if (!r || !(Number(r.w) > 0) || !(Number(r.h) > 0)) {
      hideOverlay()
      return { ok: false, reason: 'bad-rect' }
    }
    lastRect = { x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h) }
    if (busy) {
      hideOverlay()
      return { ok: false, reason: 'busy' }
    }
    busy = true
    const id = pinShow({ kind: 'shot', text: '', pending: true, head: '看图 · 框选' })
    try {
      const { cap, abs } = await hideThenCapture(lastRect)
      if (!cap || !cap.ok) {
        pinUpdate(id, { text: '', foot: '截图失败：' + ((cap && cap.reason) || 'unknown') })
        return { ok: false, reason: (cap && cap.reason) || 'capture-failed' }
      }
      report('截到 ' + cap.width + '×' + cap.height + ' / ' + Math.round(cap.bytes / 1024) + 'KB / ' + cap.ms + 'ms @' + JSON.stringify(abs))
      const cfg = getCfg()
      const v = (cfg && cfg.tools && cfg.tools.vision) || {}
      const heart = getHeart()
      const promptText = (v.prompt && String(v.prompt).trim()) || SHOT_DEFAULT_PROMPT
      const messages = [
        { role: 'system', content: SHOT_SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: promptText },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + cap.jpeg } },
          ],
        },
      ]
      let hold = false
      if (heart && heart.hold) {
        try {
          heart.hold()
          hold = true
        } catch (e) {}
      }
      let out = null
      try {
        out = await vision.infer(cfg, messages, {
          maxTokens: Number(v.maxTokens) || 300,
          // 小模型把预算全花在思考上就只剩空 content
          enableThinking: false,
          temperature: 0.3,
          timeoutMs: (cfg && cfg.model && cfg.model.timeoutMs) || 30000,
        })
      } finally {
        if (hold && heart && heart.release) {
          try {
            heart.release()
          } catch (e) {}
        }
      }
      if (!out || !out.ok) {
        const why = (out && (out.error || out.reason)) || 'unknown'
        pinUpdate(id, { text: '', foot: '没看成：' + String(why).slice(0, 120) })
        report('模型失败：' + why)
        return { ok: false, reason: 'infer-failed' }
      }
      const text = String(out.text || '').trim()
      pinUpdate(id, { text: text || '（它看了半天没说出什么…）', foot: '看图 · ' + cap.width + '×' + cap.height })
      report('描述完成 ' + (out.ms || 0) + 'ms / ' + text.length + ' 字')
      return { ok: true }
    } catch (e) {
      pinUpdate(id, { text: '', foot: '出错了：' + String((e && e.message) || e).slice(0, 100) })
      report('异常：' + (e && e.stack ? e.stack : e))
      return { ok: false, reason: 'error' }
    } finally {
      busy = false
    }
  }

  function destroy() {
    destroyOverlay()
  }

  function status() {
    return { open: isOpen(), busy, lastRect }
  }

  return { start, cancel, submitRect, isOpen, status, destroy }
}

module.exports = { createShot }
