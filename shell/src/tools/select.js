'use strict'

// 划词采集的 IO 层：30ms 轮询全局左键 → 判定 → 模拟 Ctrl+C → 读剪贴板 → 回调。
//
// 判定逻辑全在 select-core.js（纯函数、可单测）；这里只负责"喂观测"和"真的去复制"。
//
// 三个必须知道的事实：
//   1) GetCursorPos 返回物理像素，而 Electron 的 screen.getCursorScreenPoint() 是 DIP。
//      所以位置一律用 Electron 那个（与项目其它地方同一套单位），原生层只提供"键是否按着"。
//   2) 模拟 Ctrl+C 会**覆盖用户剪贴板**，所以要先拍快照、读完再恢复；
//      恢复前要再比对序列号 —— 用户这期间自己复制了东西就放弃恢复。
//   3) 终端类进程不检测（skipApps）：Ctrl+C 在终端里是中断信号，会打断正在跑的命令。

const { clipboard, screen } = require('electron')
const keys = require('../native/keys')
const core = require('./select-core')

const TICK_MS = 30
/** 松手后等目标应用把选区提交完再发 Ctrl+C */
const COPY_DELAY_MS = 50
/** 等剪贴板序列号变化的上限 */
const COPY_WAIT_MS = 500

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 前台进程是不是我们自己（Electron 主进程 / 打包后的 exe）。
 * 用来挡掉「在她自己的面板里拖选」—— 不然会给我们自己发 Ctrl+C。
 * ⚠️ 别用「落点在不在主窗矩形内」判：主窗可以铺满主屏（fullscreenPrimary=true），
 * 那时恒为真，划词整条哑火（2026-10-22 踩过）。
 */
function isSelfProcess(app) {
  if (!app || !app.ok) return false
  const exe = String(process.execPath || '')
  if (app.path && exe && String(app.path).toLowerCase() === exe.toLowerCase()) return true
  const n = String(app.name || '').toLowerCase()
  if (!n) return false
  const base = exe ? exe.split(/[\\/]/).pop().toLowerCase() : ''
  return n === 'electron.exe' || n === 'ds-whalegirl-pet.exe' || (base && n === base)
}

function createSelect(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const getCfg = typeof options.getCfg === 'function' ? options.getCfg : () => ({})
  const onText = typeof options.onText === 'function' ? options.onText : () => {}
  const onClear = typeof options.onClear === 'function' ? options.onClear : () => {}
  /** 落点是不是压在我们真正的 UI 上（由主进程的 hitJS 结果给，不能拿窗口矩形猜） */
  const isOverOwnUi = typeof options.isOverOwnUi === 'function' ? options.isOverOwnUi : () => false
  const report = (m) => {
    try {
      log('[select] ' + m)
    } catch (e) {}
  }

  let timer = null
  let running = false
  let paused = false
  let grabbing = false
  let state = core.createState()
  let lastError = ''
  let grabs = 0

  function snapshotClipboard() {
    try {
      return {
        text: clipboard.readText(),
        html: clipboard.readHTML(),
        rtf: clipboard.readRTF(),
        bookmark: clipboard.readBookmark(),
        image: clipboard.readImage(),
      }
    } catch (e) {
      return null
    }
  }

  function restoreClipboard(snap, seqAfterOurs) {
    if (!snap) return
    // 用户在等我们的这一小会儿里自己复制了东西 → 别覆盖他
    if (keys.clipSeq() !== seqAfterOurs) return
    try {
      const payload = {}
      if (snap.text) payload.text = snap.text
      if (snap.html) payload.html = snap.html
      if (snap.rtf) payload.rtf = snap.rtf
      if (snap.image && !snap.image.isEmpty()) payload.image = snap.image
      if (snap.bookmark && snap.bookmark.url) payload.bookmark = snap.bookmark.url
      if (Object.keys(payload).length) clipboard.write(payload)
      else clipboard.clear()
    } catch (e) {}
  }

  function observe() {
    const cfg = (getCfg().tools || {}).translate || {}
    const p = screen.getCursorScreenPoint()
    const down = keys.leftDown()
    // ⚠️ fg / rect / seq 必须**每帧都取**，不能只在按下时取：
    // 松手那一帧 down 已经是 false，而「拖窗口」判定正好要用那一刻的前台窗口矩形。
    // （2026-10-22 踩过：只在 down 时取 → 松手拿到 null → 拖标题栏被当成选字。）
    const fg = keys.foreground()
    const rawApp = down ? keys.foregroundProcess() : null
    const app = rawApp ? Object.assign({}, rawApp, { self: isSelfProcess(rawApp) }) : null
    let overOwnUi = false
    try {
      overOwnUi = !!isOverOwnUi()
    } catch (e) {}
    return {
      down,
      pt: { x: p.x, y: p.y },
      rect: fg ? keys.windowRect(fg) : null,
      // 进程名要 OpenProcess + 查路径，比较贵，只在按下时取
      app,
      seq: keys.clipSeq(),
      now: Date.now(),
      overOwnUi,
      cfg,
    }
  }

  async function grab(info) {
    if (grabbing) return
    grabbing = true
    try {
      const cfg = ((getCfg().tools || {}).translate || {})
      // 拖文件/资源管理器里 Ctrl+C 写的是 CF_HDROP，readText 只会拿到空或路径
      if (keys.isFileDrop()) {
        report('跳过：剪贴板是文件列表')
        return
      }
      const preSeq = keys.clipSeq()
      let seqNow = preSeq
      let snap = null
      const needCopy = info.expectSeq === preSeq || info.expectSeq === 0 || preSeq === 0
      if (needCopy) {
        snap = cfg.restoreClipboard === false ? null : snapshotClipboard()
        await sleep(COPY_DELAY_MS)
        if (!keys.sendCopy()) {
          report('模拟 Ctrl+C 被拒（可能用户按着 Ctrl 或缺少权限）')
          return
        }
        const t0 = Date.now()
        while (Date.now() - t0 < COPY_WAIT_MS) {
          await sleep(15)
          const s = keys.clipSeq()
          if (s !== preSeq) {
            seqNow = s
            break
          }
        }
        if (seqNow === preSeq) {
          // 没变化：要么没有可复制的内容，要么目标窗口是管理员权限（UIPI 拦住了注入）
          report('剪贴板没变化（没有选中内容，或目标窗口是管理员权限）')
          lastError = '剪贴板没变化（目标窗口可能是管理员权限）'
          return
        }
      }
      let raw = ''
      try {
        raw = clipboard.readText()
      } catch (e) {
        return
      }
      const r = core.cleanText(raw, cfg)
      if (!r.ok) {
        report('丢弃：' + r.reason + '（' + String(raw).length + ' 字）')
        if (r.reason !== 'empty') lastError = ''
        return
      }
      if (!core.shouldAcceptText(state, r.text, Date.now())) {
        report('丢弃：与上一条相同（去抖）')
        return
      }
      state = core.rememberText(state, r.text, Date.now())
      grabs++
      lastError = ''
      // 先把文本交出去（气泡要尽快出来），再恢复剪贴板
      try {
        onText({ text: r.text, chars: r.chars, truncated: r.truncated, app: info.app || '' })
      } catch (e) {}
      if (snap) restoreClipboard(snap, seqNow)
    } finally {
      grabbing = false
    }
  }

  function tick() {
    if (!running || paused || grabbing) return
    const obs = observe()
    const r = core.step(state, obs, obs.cfg)
    state = r.state
    if (!r.emit) return
    if (r.emit.type === 'clear') {
      try {
        onClear(r.emit.reason)
      } catch (e) {}
      return
    }
    if (r.emit.type === 'grab') {
      // 状态机已经回到 up，异步复制不影响下一轮采样
      grab(r.emit).catch((e) => report('复制失败：' + (e && e.message)))
    }
  }

  function start() {
    if (running) return
    if (!keys.available()) {
      report('原生组件不可用（' + keys.unavailableReason() + '）→ 划词翻译无法启用')
      return
    }
    running = true
    state = core.createState()
    timer = setInterval(() => {
      try {
        tick()
      } catch (e) {
        report('轮询异常：' + (e && e.message))
      }
    }, TICK_MS)
    report('已启动（' + TICK_MS + 'ms 轮询）')
  }

  function stop() {
    if (!running) return
    running = false
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    state = core.createState()
    report('已停止')
  }

  /** 识图选区域期间要暂停（遮罩窗里拖框会被当成一次"拖选"） */
  function setPaused(on) {
    paused = !!on
    if (paused) state = core.createState()
  }

  function onPin(visible, now) {
    state = core.markPin(state, visible, now || Date.now())
  }

  function holdPin(ms) {
    state = core.holdPin(state, Date.now(), ms)
  }

  function status() {
    return {
      running,
      paused,
      available: keys.available(),
      reason: keys.unavailableReason(),
      grabs,
      lastError,
      pin: { visible: state.pin.visible },
    }
  }

  function destroy() {
    stop()
  }

  return { start, stop, setPaused, onPin, holdPin, status, destroy }
}

module.exports = { createSelect }
