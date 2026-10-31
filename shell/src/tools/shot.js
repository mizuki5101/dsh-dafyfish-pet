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
const read = require('./read-core')

const HIDE_SETTLE_MS = 90

const SHOT_SYSTEM =
  '你是桌面宠物「大肥鱼」的眼睛。主人从屏幕上框了一小块给你看。\n' +
  '要求：\n' +
  '1) 只用简体中文，1~3 句，说清这里是什么、最要紧的内容是什么（能读出字就引一下原话）；\n' +
  '2) 只描述框里的东西，绝对不要提"框""矩形""截图""选区"这些词，也不要猜框外的事；\n' +
  '3) 看不清就直说看不清，不要编；\n' +
  '4) 不要用 markdown，不要分点。'

const SHOT_DEFAULT_PROMPT = '这是我框出来的一块屏幕，告诉我这是什么、上面写了什么。'

function sec(ms) {
  return (Math.max(0, Number(ms) || 0) / 1000).toFixed(1) + 's'
}

function createShot(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const getCfg = typeof options.getCfg === 'function' ? options.getCfg : () => null
  /** 经历流水（2026-10-31）：看到什么/答了什么记一行。以前是「答完即焚」，现在进底账 */
  const record = typeof options.record === 'function' ? options.record : null
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
        // ⚠️ 用 showInactive，**不主动抢焦点**：这个遮罩只是给用户看/画框的，
        // 没有任何理由让自己变成前台窗口（2026-10-22：怀疑抢焦点会干扰别的截图工具）。
        // 用户按下第一下框选时窗口自然激活，Esc 从那时起有效；右键也能取消。
        w.showInactive()
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
    destroyOverlay()
    report('取消：' + (reason || 'unknown'))
    return { ok: true }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }

  /**
   * 整段调用期间持有心跳（heart.hold 是引用计数，可嵌套）。
   * ⚠️ 必须在 finally 里 release —— 漏了心跳会永久停摆。
   * 两跳要**一起**持有：中间放开会让心跳挤进来，而 llama-server 只有一个槽位。
   */
  async function withHold(fn) {
    const heart = getHeart()
    let hold = false
    if (heart && heart.hold) {
      try {
        heart.hold()
        hold = true
      } catch (e) {}
    }
    try {
      return await fn()
    } finally {
      if (hold && heart && heart.release) {
        try {
          heart.release()
        } catch (e) {}
      }
    }
  }

  /** 遮罩 → 截图。必须唯一入口：先 hide 再等两帧再拍。 */
  async function hideThenCapture(region) {
    const bounds = ovWin && !ovWin.isDestroyed() ? ovWin.getContentBounds() : null
    hideOverlay()
    // 用完即销毁：不在后台留一个隐藏的全屏置顶窗口。
    // 隐藏窗口本身不该影响别的程序，但它会一直占着一个 always-on-top 的 HWND，
    // 2026-10-22 排查「笔记本 F10 截图键保存失败」时决定不留这个变量。
    destroyOverlay()
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
      const answerOn = !!v.answer
      const promptText = (v.prompt && String(v.prompt).trim()) || SHOT_DEFAULT_PROMPT
      const modelTimeout = (cfg && cfg.model && cfg.model.timeoutMs) || 30000
      const imgPart = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + cap.jpeg } }
      // 开了答题，第一跳的任务就换成「转写 + 摘问题」：
      //   用户自己写的描述提示词（默认那句"告诉我这是什么"）在这里必须**不用** ——
      //   它会让模型顺手把题也答了，第一跳就不干净了（内容还没经过第二跳的隔离）。
      const messages = answerOn
        ? [
            { role: 'system', content: read.READ_SYSTEM },
            { role: 'user', content: [{ type: 'text', text: '按格式回答，不要写别的。' }, imgPart] },
          ]
        : [
            { role: 'system', content: SHOT_SYSTEM },
            { role: 'user', content: [{ type: 'text', text: promptText }, imgPart] },
          ]
      // 答题模式要一次吐出描述 + 问题，300 会不够（描述被截断 → 问题也没了）
      const firstMax = answerOn
        ? Math.min(1024, Math.max(480, Number(v.maxTokens) || 300))
        : Number(v.maxTokens) || 300

      let first = null
      let rd = null
      let second = null
      let refused = false
      await withHold(async () => {
        first = await vision.infer(cfg, messages, {
          maxTokens: firstMax,
          // 小模型把预算全花在思考上就只剩空 content
          enableThinking: false,
          temperature: answerOn ? 0.2 : 0.3,
          timeoutMs: modelTimeout,
        })
        if (!first || !first.ok || !answerOn) return

        rd = read.parseRead(first.text)
        const seenNow = rd.seen || '（它没看清这块是什么）'
        // 先把「看到什么」落屏：第二跳还要再等几秒，光转圈会让人以为卡死
        pinUpdate(id, {
          text: seenNow,
          head: '看图 · 框选',
          foot: '看图 ' + sec(first.ms) + (rd.hasQuestion ? ' · 图里有问题，她在想…' : ' · 图里没看到要回答的问题'),
        })
        report('第一跳 ' + sec(first.ms) + ' · 问题=' + (rd.hasQuestion ? rd.question.slice(0, 40) : '无'))
        if (record) {
          try {
            record('see', seenNow, { question: rd.hasQuestion ? rd.question.slice(0, 100) : '' })
          } catch (e) {}
        }
        if (!rd.hasQuestion) return

        // 第②层防线：本地判据先拦一道，不指望模型自觉（判断依据见 read-core 文件头）
        const chk = read.checkAnswerable(rd.question)
        if (!chk.ok) {
          refused = true
          pinUpdate(id, {
            text: read.REFUSE_TEXT,
            head: '答题 · 框选',
            answer: true,
            foot: '看图 ' + sec(first.ms) + ' · 图里有越权要求，没发给她',
          })
          report('拦下越权提问：' + rd.question.slice(0, 60))
          return
        }

        second = await vision.infer(cfg, read.answerMessages(rd.question, rd.seen), {
          maxTokens: 640,
          enableThinking: false,
          temperature: 0.5,
          timeoutMs: modelTimeout,
        })
      })

      if (!first || !first.ok) {
        const why = (first && (first.error || first.reason)) || 'unknown'
        pinUpdate(id, { text: '', foot: '没看成：' + String(why).slice(0, 120) })
        report('模型失败：' + why)
        return { ok: false, reason: 'infer-failed' }
      }

      // —— 没开答题：和旧版一模一样，只显示描述 ——
      if (!answerOn) {
        const text = String(first.text || '').trim()
        pinUpdate(id, { text: text || '（它看了半天没说出什么…）', foot: '看图 · ' + cap.width + '×' + cap.height })
        report('描述完成 ' + (first.ms || 0) + 'ms / ' + text.length + ' 字')
        if (record && text) {
          try {
            record('see', text, {})
          } catch (e) {}
        }
        return { ok: true }
      }

      // —— 开了答题，但图里没有需要回答的问题 ——
      const seen = (rd && rd.seen) || '（它没看清这块是什么）'
      if (!rd || !rd.hasQuestion) {
        pinUpdate(id, { text: seen, head: '看图 · 框选', foot: '看图 ' + sec(first.ms) + ' · 图里没看到要回答的问题' })
        report('读图完成，无问句 ' + sec(first.ms))
        return { ok: true, answered: false }
      }

      // —— 被本地判据拦下：台词是写死的，没经过模型 ——
      if (refused) return { ok: true, answered: false, refused: true }

      // —— 第二跳失败：至少把看到的内容留着，别让人以为白拍了 ——
      if (!second || !second.ok) {
        const why = (second && (second.error || second.reason)) || 'unknown'
        pinUpdate(id, { text: seen, head: '答题 · 框选', foot: '问题看到了，但答案没想出来：' + String(why).slice(0, 100) })
        report('答不出来：' + why)
        return { ok: false, reason: 'answer-failed' }
      }

      const ans = read.cleanAnswer(second.text, 1200)
      pinUpdate(id, {
        text: ans.text || '（她想不出来…）',
        head: '答题 · 框选',
        answer: true,
        foot: '看图 ' + sec(first.ms) + ' + 想 ' + sec(second.ms) + (ans.truncated ? ' · 已截断' : ''),
      })
      report('答题完成 · 问「' + rd.question.slice(0, 30) + '」→ ' + ans.text.length + ' 字 / ' + sec(second.ms))
      if (record && ans.text) {
        try {
          record('answer', ans.text, { question: rd.question.slice(0, 100) })
        } catch (e) {}
      }
      return { ok: true, answered: true }
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
