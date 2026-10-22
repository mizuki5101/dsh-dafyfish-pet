'use strict'

// 「功能面板」的后端编排：划词翻译 + 识图 + 特殊气泡(pin) 的 IPC / SSE 出口。
//
// 为什么不复用 heart:save / heart:settings：
//   配置本身就在 settings.json 的 heart.tools 段（和 bili/dream 一样），
//   页面直接调现成的 heart.save / heart.settings 就够了 —— 少一条通道就少一处不一致。
//   这里只补 heart 里没有的三件事：翻译请求、框选截图、气泡优先级通知。
//
// 注册位置很关键：main.js 里这些 handler 必须放在**心跳 try 块之外**。
// 识图只依赖 desktopCapturer，不依赖 heart；heart 挂了（比如模块没打进 asar）
// 功能面板也该能用。

const { ipcMain } = require('electron')
const keys = require('../native/keys')
const { createSelect } = require('./select')
const { createTranslate } = require('./translate')
const { createShot } = require('./shot')
const core = require('./translate-core')

function createTools(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const getHeart = typeof options.getHeart === 'function' ? options.getHeart : () => null
  const push = typeof options.push === 'function' ? options.push : () => {}
  const getCfg =
    typeof options.getCfg === 'function'
      ? options.getCfg
      : () => {
          const h = getHeart()
          return h && h.config ? h.config() : null
        }
  const report = (m) => {
    try {
      log('[tools] ' + m)
    } catch (e) {}
  }

  let seq = 0
  let currentId = 0
  let currentKind = ''
  let lastError = ''

  function pushEvent(obj) {
    try {
      push(obj)
    } catch (e) {
      report('推送失败：' + (e && e.message))
    }
  }

  /** 特殊气泡出现：先让普通气泡全线让路（页面侧 pinHold），再推 show */
  function pinShow(info) {
    seq = (seq + 1) % 2147483000
    const id = seq + 1
    currentId = id
    currentKind = (info && info.kind) || 'tr'
    pushEvent({
      t: 'pin',
      action: 'show',
      id,
      kind: currentKind,
      text: String((info && info.text) || ''),
      head: (info && info.head) || (currentKind === 'shot' ? '看图 · 框选' : '划词翻译'),
      app: (info && info.app) || '',
      chars: Number((info && info.chars) || 0),
      truncated: !!(info && info.truncated),
      pending: !!(info && info.pending),
    })
    select.onPin(true)
    return id
  }

  function pinUpdate(id, patch) {
    if (!id || id !== currentId) return
    pushEvent({
      t: 'pin',
      action: 'update',
      id,
      text: patch && patch.text !== undefined ? String(patch.text) : undefined,
      foot: patch && patch.foot !== undefined ? String(patch.foot) : undefined,
      head: patch && patch.head !== undefined ? String(patch.head) : undefined,
    })
  }

  function pinClose(reason) {
    if (!currentId) return
    const id = currentId
    currentId = 0
    currentKind = ''
    pushEvent({ t: 'pin', action: 'close', id, reason: String(reason || 'user') })
    select.onPin(false)
  }

  const select = createSelect({
    log,
    getCfg,
    // 「落点是不是压在我们真正的 UI 上」由 main.js 的 hitJS 结果给（lastHit === 'panel'）。
    // 不能拿窗口矩形判：主窗可以铺满主屏，那时恒为真（2026-10-22 的哑火就是它）。
    isOverOwnUi: typeof options.isOverOwnUi === 'function' ? options.isOverOwnUi : () => false,
    onText: (info) => {
      report('选中 ' + info.chars + ' 字（' + (info.app || '?') + '）')
      pinShow({ kind: 'tr', text: info.text, app: info.app, chars: info.chars, truncated: info.truncated })
      // 注意：这里不清 lastError，交给 status() 只在失败时显示
      lastError = ''
    },
    onClear: (reason) => {
      pinClose(reason || 'selection-cleared')
    },
  })

  const translate = createTranslate({ log, getHeart })

  const shot = createShot({
    log,
    getCfg,
    getHeart,
    pinShow,
    pinUpdate,
    onOpenChange: (open) => {
      // 框选期间暂停划词（遮罩窗里的拖动会被当成一次"拖选"）
      select.setPaused(open)
      if (!open) {
        // 帧后恢复，避免 hide 的那一帧又被采样
        setTimeout(() => select.setPaused(false), 200)
      }
    },
  })

  /** 配置变化后重新对齐：开关 → 起停轮询；关掉模式时顺手把气球收掉 */
  function sync() {
    const cfg = getCfg()
    const t = (cfg && cfg.tools && cfg.tools.translate) || {}
    if (t.enabled && !shot.isOpen()) select.start()
    else select.stop()
    if (!t.enabled && currentKind === 'tr' && currentId) pinClose('mode-off')
    report(
      'sync：划词=' +
        (t.enabled ? 'on' : 'off') +
        ' 引擎=' +
        (t.engine || '?') +
        ' 原生=' +
        (keys.available() ? 'ok' : keys.unavailableReason()) +
        ' 识图=' +
        (((cfg && cfg.tools && cfg.tools.vision) || {}).enabled ? 'on' : 'off'),
    )
  }

  function status() {
    const cfg = getCfg()
    const t = (cfg && cfg.tools && cfg.tools.translate) || {}
    const v = (cfg && cfg.tools && cfg.tools.vision) || {}
    const m = (cfg && cfg.model) || {}
    return {
      translate: Object.assign({}, t, { api: { baseUrl: t.api && t.api.baseUrl, model: t.api && t.api.model, apiKeySet: !!(t.api && t.api.apiKey) } }),
      vision: v,
      native: { ok: keys.available(), reason: keys.unavailableReason() },
      model: { configured: !!m.baseUrl, baseUrl: m.baseUrl || '', model: m.model || '' },
      select: select.status(),
      shot: shot.status(),
      pin: { id: currentId, kind: currentKind },
      lastError,
    }
  }

  /** 页面刷新后主进程的 pin 状态必须复位，否则 pinHold 会永久挡住所有气泡 */
  function resetPin() {
    currentId = 0
    currentKind = ''
    select.onPin(false)
    select.setPaused(false)
    report('页面刷新，pin 状态已复位')
  }

  // —— IPC ——
  ipcMain.handle('tools:status', () => ({ ok: true, ...status() }))

  ipcMain.handle('tools:translate', async (_e, req) => {
    const text = req && typeof req.text === 'string' ? req.text : ''
    const id = Number(req && req.id) || 0
    if (!text.trim()) return { ok: false, reason: 'empty', hint: core.describeError('empty') }
    try {
      const r = await translate.run(text)
      if (!r.ok) lastError = r.hint || core.describeError(r.reason)
      else lastError = ''
      return Object.assign({ id }, r)
    } catch (e) {
      lastError = String((e && e.message) || e)
      return { ok: false, id, reason: 'error', hint: lastError }
    }
  })

  ipcMain.handle('tools:selftest', async (_e, req) => {
    try {
      return await translate.selftest((req && req.what) || 'free')
    } catch (e) {
      return { ok: false, reason: 'error', hint: String((e && e.message) || e) }
    }
  })

  // 页面入口（单窗口 Shift+右击走这里；双窗口由 main.js 的 hit:contextmenu 直接调 start）
  ipcMain.handle('tools:shot', () => {
    const r = shot.start()
    return r
  })

  ipcMain.handle('shot:rect', async (_e, rect) => {
    return await shot.submitRect(rect)
  })

  ipcMain.handle('shot:cancel', (_e, req) => {
    return shot.cancel(req && req.reason)
  })

  ipcMain.on('pin:hold', () => {
    select.holdPin(1200)
  })

  function destroy() {
    select.destroy()
    shot.destroy()
  }

  return {
    sync,
    status,
    resetPin,
    destroy,
    shotOpen: () => shot.isOpen(),
    startShot: () => shot.start(),
    pinShow,
    pinUpdate,
    pinClose,
  }
}

module.exports = { createTools }
