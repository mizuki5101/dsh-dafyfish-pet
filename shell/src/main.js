// DS 鲸鱼娘桌宠 · Windows 桌面外壳
// ————————————————————————————————————————————————————————————
// 和 macOS 版同一个思路：**她本身还是那份插件**（模型、联动、菜单、钱包都在插件里），
// 这个程序只是一个透明、无边框、永远置顶的窗口，加载插件提供的那一页。
//
// Windows 上比 macOS 容易的地方：Electron 自带跨平台，不用担心 App Nap、私有 API 那类坑。
// 需要注意的只有三件：
//   ① 点击穿透：setIgnoreMouseEvents(true, { forward: true }) + 我们自己定时问页面「鼠标下面是不是她」
//   ② 本机通行证：插件的 /dsh-pet/* 要过信任栅栏，所以把 ~/.dsh 里那张通行证写成 cookie
//   ③ 打字：Electron 窗口默认可聚焦，不用像 macOS 那样覆写 canBecomeKey
//
// 另外按主人要求做了「联动」：第一次打开时如果检测不到插件，会直接给一个
// 「一键安装插件」按钮，替你跑 dsh plugin --profile web add github:...，
// 所以 Windows 用户不需要自己开命令行。
const { app, BrowserWindow, Tray, Menu, screen, shell, session, ipcMain, nativeImage, dialog } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { exec } = require('node:child_process')
// 她自己的本地 HTTP 服务（2026-10-17）：页面 / 前端 / Live2D 运行时 / 模型不再向 DSH 要。
// 为什么要它、为什么不用 file://、信任栅栏怎么设，全在 petserver.js 顶部。
const { createPetServer } = require('./petserver')
const { createAudioMeter } = require('./audio')

// 宿主地址在启动时「发现」出来，不再写死 —— 与 macOS 版保持一致：
// 官方桌面版（Electron，端口由宿主决定，实测 19387）和手动起的 `dsh web`（3080）都要能连上。
const CANDIDATE_BASES = [
  'http://127.0.0.1:19387',
  'http://127.0.0.1:3080',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:3000',
]
let petBase = CANDIDATE_BASES[0]
/** 外壳自己的本地服务（独立化的关键；null = 还没起） */
let petServer = null
/** 系统声音峰值（WASAPI）；页面发 audio:on 才启动，关掉设置就 stop */
let audioMeter = null
/** 重新发现 DSH 的节奏：离线时每 8 秒试一次，每 6 次才扫一次端口（netstat 要起子进程，别太频） */
let syncAttempt = 0
let syncBusy = false
/** ⚠️ 开发期的资源目录：工作区的插件 assets。
 *  放在候选表里是为了「改 pet.js → 重启外壳就生效」这条习惯不变（交接文档第二节的改动生效规则）。
 *  独立发行时它不存在，会自动退到 exe 同级的 pet-assets/。 */
// 可以用 DSH_PET_DEV_ASSETS 覆盖；别人的机器上没有这个目录也不会出问题（按顺序找，找不到就跳过） */
const DEV_ASSETS = process.env.DSH_PET_DEV_ASSETS || 'D:/AI_work_space/live2D桌宠/pet-plugin/assets'

/** 通行证文件里记录的宿主端口（插件写的，因机器而异 —— 不能写死） */
function deskPort() {
  try {
    const j = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'))
    const n = Number(j.port)
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : null
  } catch (e) {
    return null
  }
}
// ⚠️ 这里原来有个 petURL() = DSH + '/dsh-pet/standalone'。
// 独立化之后页面由外壳自己提供（见 startLocalServer/load），所以删掉了。

/**
 * 「铺满主屏」开关 —— 来自上游 PR #7（@c1overzz），本 build 原本没有。
 * 打开方式：userData（Windows: %APPDATA%\DS-WhaleGirl-Pet）的 settings.json 里写
 *   {"fullscreenPrimary": true}
 * 开启后窗口覆盖主屏工作区，空白处照旧点击穿透（setIgnoreMouseEvents 不变），
 * 于是「她在哪」不再受窗口边界约束 —— 拖动她时窗口跟着走，位置就是她的位置。
 * 全程兜底：读不到 / 解析失败 / 不是 true 一律 false。
 */
function readFullscreenPrimary() {
  try {
    const p = path.join(app.getPath('userData'), 'settings.json')
    return JSON.parse(fs.readFileSync(p, 'utf8')).fullscreenPrimary === true
  } catch (e) {
    return false
  }
}
const PLUGIN = 'github:Andersen216/dsh-whale-girl-live2d'
// 同 macOS：窗口要装得下她 + 四周的面板（透明区域点击穿透，不挡别的窗口）
const WIN_W = 560
const WIN_H = 900   // 只加高：给她头顶留出聊天框的位置
const BALL = 62
const TOKEN_FILE = path.join(os.homedir(), '.dsh', 'dsh-live2d-pet-desktop.json')

let win = null
let ballWin = null
let tray = null
let pollTimer = null
let cursorFeed = null
let lastCursor = null
let dragTimer = null
let dragFrom = null
// 贴边小球单独一份拖动状态：原来和主窗口共用 dragFrom，收起状态下按小球会把
// 已经 hide() 的主窗口一路搬走（B站/PR 反馈的真实 bug）
let ballDrag = null
let collapsed = false
let lowPower = false
let overPanel = false
let failCount = 0
let lastHit = 'none'

// ——————————————————————————————————————————————————————————————
// 通行证：插件启动时会写 ~/.dsh/dsh-live2d-pet-desktop.json
// ——————————————————————————————————————————————————————————————
function readToken() {
  try {
    const j = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'))
    return typeof j.token === 'string' && j.token.length >= 16 ? j.token : null
  } catch (e) {
    return null
  }
}

// ——————————————————————————————————————————————————————————————
// 她自己的本地服务（2026-10-17 新增：让她脱离 DSH 独立存在）
//
// 以前是 win.loadURL(DSH + '/dsh-pet/standalone')：DSH 一关、页面一刷新就白屏。
// 现在外壳自己起一个极小的 HTTP 服务，提供 页面 / pet.js / Live2D 运行时 / 模型，
// 于是「DSH 开着」只影响对话功能：连上就同步状态，连不上就静默降级。
// ——————————————————————————————————————————————————————————————

/** 读 %APPDATA%\DS-WhaleGirl-Pet\settings.json（readFullscreenPrimary 也是读它） */
let SETTINGS_FILE = ''
function settingsPath() {
  if (!SETTINGS_FILE) SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json')
  return SETTINGS_FILE
}
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) || {}
  } catch (e) {
    return {}
  }
}

/**
 * 资源根目录（按顺序找第一个存在的；见 petserver.js 的 findAsset）。
 * 为什么要有多个：① 开发时直接读工作区的插件目录（改完重启外壳就生效）
 * ② 独立发行时读 exe 同级的 pet-assets/（整目录拷走就能跑）
 * ③ 29 MB 贴图不塞进 asar，所以这里才是真身所在。
 */
function assetRoots() {
  const cfg = readSettings()
  const list = []
  const push = (p) => {
    if (typeof p === 'string' && p && !list.includes(p)) list.push(p)
  }
  if (Array.isArray(cfg.assetRoots)) cfg.assetRoots.forEach(push)
  push(process.env.DSH_PET_ASSETS)
  push(path.join(path.dirname(process.execPath), 'pet-assets'))
  push(path.join(app.getPath('userData'), 'pet-assets'))
  push(DEV_ASSETS)
  push(path.join(__dirname, 'assets'))
  return list
}

/** 起本地服务（只起一次）。端口优先用记住的那个 —— 换了端口就换了 origin，她的本地存档会丢。 */
async function startLocalServer() {
  if (petServer) return petServer
  petServer = createPetServer({
    assetRoots: assetRoots(),
    configFile: path.join(os.homedir(), '.dsh', 'dsh-live2d-pet.json'),
    seedFile: path.join(app.getPath('userData'), 'layout-seed.json'),
    version: require('./package.json').version,
    log: bootLog,
  })
  const preferred = Number(readSettings().localPort) || 19400
  let got = 0
  for (const p of [preferred, 0]) {
    try {
      const r = await petServer.listen(p)
      got = r.port
      break
    } catch (e) {
      bootLog('本地服务端口 ' + p + ' 起不来：' + (e && e.message))
    }
  }
  if (!got) throw new Error('本地服务起不来（端口都被占用？）')
  if (got !== preferred) {
    bootLog('⚠️ 端口 ' + preferred + ' 被占用，改用 ' + got + '（注意：origin 变了，她的本地存档要重新记一次）')
  }
  const st = petServer.state()
  bootLog('资源根：' + (st.assetRoots || []).join(' | '))
  // 声音峰值：先建对象，页面发 audio:on 才真正起子进程（设置里可关）
  audioMeter = createAudioMeter({
    log: bootLog,
    onSample: (peak) => {
      try { if (petServer) petServer.push({ t: 'audio', peak: peak }) } catch (e) {}
    },
  })
  return petServer
}

function petSay(text) {
  try {
    if (!win || win.isDestroyed()) return
    win.webContents.executeJavaScript('window.DSHPet && DSHPet.say && DSHPet.say(' + JSON.stringify(String(text)) + ')').catch(() => {})
  } catch (e) {}
}

/**
 * 连回 DSH（连不上就静默降级）。
 * 为什么是「轮询 + 事件流」而不是只连一次：主人要的是「DSH 什么时候开起来，她自己就接上」，
 * 所以离线时必须持续重试；已连上时就什么都不做（事件流断了 petserver 会把 online 置回 false）。
 */
async function syncUpstream() {
  if (syncBusy || !petServer) return
  const cfg = readSettings()
  if (cfg.linkDsh === false) {
    petServer.clearUpstream()
    return
  }
  if (petServer.state().online) return
  const token = readToken()
  if (!token) return // DSH 从没在这台机器上装过插件：没有通行证，等它出现再连
  syncBusy = true
  syncAttempt++
  try {
    const base = await discoverHost(token, { scan: syncAttempt % 6 === 1 })
    if (base) {
      if (base !== petBase) bootLog('发现 DSH：' + base)
      petBase = base
      petServer.setUpstream(base, token)
    }
  } catch (e) {
    bootLog('连 DSH 出错：' + (e && e.message))
  } finally {
    syncBusy = false
  }
}

/** 打开 DSH 界面（没连上就说人话，别开一个空页） */
function openDsh() {
  if (petServer && petServer.state().online) shell.openExternal(petBase + '/')
  else petSay('DSH 没开呢，开了我就自己接上～')
}

/** 加载她（换成外壳自己的页面；DSH 只影响对话） */
async function load() {
  if (!win || win.isDestroyed()) return
  try {
    const s = await startLocalServer()
    const url = s.url('?k=' + s.token())
    bootLog('加载本地页面：' + url.replace(/k=[0-9a-f]+/, 'k=***'))
    win.loadURL(url)
  } catch (e) {
    bootLog('本地服务启动失败：' + (e && e.stack ? e.stack : e))
    showHint(e)
    return
  }
  syncUpstream()
}

// ——————————————————————————————————————————————————————————————
// 判断「鼠标下面是什么」：她本体 / 她的面板 / 空白
// ——————————————————————————————————————————————————————————————
const hitJS = (x, y) => `(function(){try{
  var el=document.elementFromPoint(${x},${y});
  var ui=!!(el&&el.closest&&el.closest('.dshp-panel,.dshp-menu,.dshp-hud,.dshp-bubble,.dshp-composer,.dshp-dock,.dshp-tab'));
  if(ui) return 'panel';
  if(window.DSHPet&&DSHPet.hitTest&&DSHPet.hitTest(${x},${y})) return 'model';
  return 'none';
}catch(e){return 'none'}})()`

function setIgnore(on) {
  if (!win || win.isDestroyed()) return
  win.setIgnoreMouseEvents(on, { forward: true })
}

async function poll() {
  if (!win || win.isDestroyed() || !win.isVisible()) return
  const p = screen.getCursorScreenPoint()
  const b = win.getBounds()
  if (p.x < b.x || p.x > b.x + b.width || p.y < b.y || p.y > b.y + b.height) {
    lastHit = 'none'
    setIgnore(true)
    return
  }
  if (dragTimer) return // 拖动中不抢事件（否则鼠标一离开她就变穿透，拖动会断）
  try {
    const kind = await win.webContents.executeJavaScript(hitJS(Math.round(p.x - b.x), Math.round(p.y - b.y)))
    lastHit = kind
    overPanel = kind === 'panel'
    setIgnore(kind === 'none')
  } catch (e) {
    setIgnore(true)
  }
}

// ——————————————————————————————————————————————————————————————
// 主窗口
// ——————————————————————————————————————————————————————————————
function createMain() {
  const FULLSCREEN_PRIMARY = readFullscreenPrimary()
  const waFs = screen.getPrimaryDisplay().workArea
  win = new BrowserWindow({
    width: FULLSCREEN_PRIMARY ? waFs.width : WIN_W,
    height: FULLSCREEN_PRIMARY ? waFs.height : WIN_H,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    title: 'DS 鲸鱼娘桌宠',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false, // 她不能被后台降频（不然会像卡住）
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  win.setMenuBarVisibility(false)

  const wa = screen.getPrimaryDisplay().workArea
  if (FULLSCREEN_PRIMARY) {
    // 铺满主屏时位置就是整块工作区，历史位置无意义（否则窗口会被挪走）
    win.setPosition(waFs.x, waFs.y)
    bootLog('已启用「铺满主屏」（settings.json: fullscreenPrimary=true）')
  } else {
    const saved = readPos()
    win.setPosition(saved ? saved[0] : wa.x + wa.width - WIN_W - 8, saved ? saved[1] : wa.y + wa.height - WIN_H - 8)
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('did-finish-load', () => {
    failCount = 0
    win.webContents.executeJavaScript('window.DSHPet && DSHPet.setLowPower && DSHPet.setLowPower(' + lowPower + ')').catch(() => {})
    setTimeout(() => win.webContents.executeJavaScript('window.DSHPet && DSHPet.setHidden && DSHPet.setHidden(false)').catch(() => {}), 1200)
    setTimeout(() => win.webContents.executeJavaScript('window.DSHPet && DSHPet.setHidden && DSHPet.setHidden(false)').catch(() => {}), 3000)
  })
  win.webContents.on('did-fail-load', () => {
    failCount++
    if (failCount >= 3) showHint()
    scheduleRetry(5000)
  })
  // 窗口移动：越界就拉回来（拔掉外接屏 / 改分辨率后可能跑到屏幕外），
  // 写盘节流到 400ms —— 原来每个 moved 事件都写一次，拖动时非常费（PR 反馈）
  win.on('moved', () => {
    if (!win || win.isDestroyed()) return
    const [x, y] = win.getPosition()
    const [cx, cy] = clampToDisplays(x, y)
    if (cx !== x || cy !== y) win.setPosition(cx, cy)
    const now = Date.now()
    if (now - (globalThis.__lastSaveAt || 0) > 400) {
      globalThis.__lastSaveAt = now
      // 铺满主屏时窗口位置恒等于工作区，写盘没有意义，且会污染非铺满模式的位置记忆
      if (!readFullscreenPrimary()) savePos()
    }
  })
  win.on('closed', () => { win = null })

  // 拖动：页面里按下她 → 交给主进程搬窗口（拖动期间用 16ms 快速轮询，跟手）
  ipcMain.on('drag-start', async (_e, at) => {
    // 小球用的是同一个 preload，也会发 drag-start；主窗口只是 hide() 没 destroy()，
    // 不加这条守卫就会把看不见的主窗口搬走（PR 反馈）
    if (!win || win.isDestroyed() || !win.isVisible()) return
    // ⚠️ 不能直接用 overPanel（那是 90ms 轮询的上一次结果）：
    // 按下那一刻它恰好是 panel 时，这次拖动就被让给网页，只能在窗口内挪、整个窗口搬不动。
    // B 站 @F0rsEn 反馈的正是这条。改成「按下瞬间重新判一次」，几十毫秒的等待对拖动没影响。
    try {
      const b = win.getBounds()
      const kind = await win.webContents.executeJavaScript(
        hitJS(Math.round(at.x - b.x), Math.round(at.y - b.y)),
      )
      if (kind === 'panel') return // 真控件（滑块/按钮/输入框）→ 让给网页
    } catch (e) {}
    dragFrom = { mouse: at, win: win.getPosition() }
    clearInterval(dragTimer)
    dragTimer = setInterval(() => {
      if (!dragFrom || !win) return
      const p = screen.getCursorScreenPoint()
      win.setPosition(dragFrom.win[0] + (p.x - dragFrom.mouse.x), dragFrom.win[1] + (p.y - dragFrom.mouse.y))
    }, 16)
    win.webContents.executeJavaScript("document.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true}))").catch(() => {})
  })
  ipcMain.on('drag-end', () => {
    clearInterval(dragTimer)
    dragTimer = null
    dragFrom = null
    savePos()
  })
  // 前端那个 ↗ 符号：用默认浏览器打开 DSH 界面
  ipcMain.on('install-plugin', () => installPlugin())
  // 前端（pet.js）发来的指令，和 macOS 版一一对应。
  // ⚠️ 每条都带状态守卫：macOS 版在这里踩过无限递归的坑（expand 后又收到 shown 再 expand，
  //    日志炸到 5472 万行、CPU 打满），Windows 版一开始就不留这个隐患。
  ipcMain.on('shell-msg', (_e, msg) => {
    switch (msg) {
      case 'hidden':
      case 'collapse':
        if (!collapsed) collapse()
        break
      case 'shown':
      case 'expand':
        if (collapsed) expand()
        break
      case 'open-dsh':
        openDsh()
        break
      // 设置面板里的「连接哪一个 DSH：自动/桌面版/网页版」。
      // 独立化之后连接由外壳自己发现与维持（见 syncUpstream），页面没有选择权了 ——
      // 所以要回一句，否则「点了没反应」就是面板在骗人（待机文档记过同型 bug）。
      case 'host:auto':
      case 'host:desktop':
      case 'host:web':
        petSay('现在连接由我自己照看啦，开哪个都行～')
        break
      // 设置面板里的「重新连 DSH」（独立化之后面板里能看到连接状态，配一个按钮）
      case 'link-retry':
        if (readSettings().linkDsh === false) {
          petSay('连接被我关掉了，托盘里能打开～')
          break
        }
        syncAttempt = 0
        petSay('好，我再找一下 DSH…')
        syncUpstream()
        break
      // 设置页「系统声音：开/关」
      case 'audio:on':
        if (audioMeter) {
          bootLog('音频峰值：开')
          audioMeter.start()
        }
        break
      case 'audio:off':
        if (audioMeter) {
          bootLog('音频峰值：关')
          audioMeter.stop()
        }
        break
      case 'quit':
        app.quit()
        break
    }
  })

  load()
  // ——— 全屏视线追踪 ———
  // 页面只能看到窗口内的鼠标；窗口外的移动它收不到 → 她"不看你鼠标"。
  // 用 Electron 原生 sendInputEvent 把全局光标位置喂进去（比 executeJavaScript 省得多）。
  cursorFeed = setInterval(() => {
    try {
      if (!win || win.isDestroyed() || !win.isVisible() || dragTimer) return
      const p = screen.getCursorScreenPoint()
      // 与 macOS 同理：原来 60ms + 3px 死区会让视线目标「跳着给」，看着卡
      if (lastCursor && Math.abs(lastCursor.x - p.x) < 1 && Math.abs(lastCursor.y - p.y) < 1) return
      lastCursor = p
      const b = win.getBounds()
      // 把「整个屏幕」映射到窗口坐标里（与 macOS 同理）：
      // 否则鼠标跑到窗口外就会被夹住，看着像「到屏幕边缘就不跟了」。
      const disp = screen.getDisplayNearestPoint(p).bounds
      const nx = (p.x - disp.x) / Math.max(1, disp.width)
      const ny = (p.y - disp.y) / Math.max(1, disp.height)
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(nx * b.width),
        y: Math.round(ny * b.height),
      })
    } catch (e) {}
  }, 16)
  pollTimer = setInterval(poll, 90)
  win.once('ready-to-show', () => {
    bootLog('ready-to-show：窗口即将显示')
    bootLog('ready-to-show')
    win.showInactive()
    win.setAlwaysOnTop(true, 'screen-saver')
  })
}

/**
 * 发现正在运行的 DSH 宿主：官方桌面版（19387）或 `dsh web`（3080）。
 * 带通行证探 /dsh-pet/pet.js：200 = 就是它；401 = 插件在但票不对（也先进去）。
 * 以前写死 3080，导致只开官方桌面版的用户连不上。
 */
async function discoverHost(token, opts) {
  let fallback = null
  // 优先顺序：① 插件写下的真实端口 ② 本机实际在监听的端口（扫出来的） ③ 常见端口兜底
  // 独立化以后这个函数变成「重试循环里的一步」，所以加了 opts.scan：
  //   netstat 要起一个子进程，不能每 8 秒扫一次 —— 由调用方决定这一轮扫不扫。
  const scanned = opts && opts.scan === false ? [] : await scanListeningPorts()
  const ordered = []
  const p = deskPort()
  if (p) ordered.push(p)
  for (const n of scanned) if (!ordered.includes(n)) ordered.push(n)
  for (const base of CANDIDATE_BASES) {
    const n = Number(base.split(':').pop())
    if (!ordered.includes(n)) ordered.push(n)
  }
  const bases = ordered.map((n) => 'http://127.0.0.1:' + n)
  for (const base of bases) {
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 1500)
      const res = await fetch(base + '/dsh-pet/pet.js', {
        headers: { Cookie: 'dsh_pet_desk=' + token },
        signal: ctl.signal,
      })
      clearTimeout(timer)
      if (res.status === 200) return base
      if (res.status === 401 && !fallback) fallback = base
    } catch (e) {
      /* 这个宿主没在跑，试下一个 */
    }
  }
  return fallback
}

// 防止重试定时器叠加：load() 可能从多处被调用（启动 / did-fail-load / 托盘重载）
let retryTimer = null
function scheduleRetry(ms) {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    load()
  }, ms || 5000)
}

/** 用 netstat 列出本机正在监听的端口（不靠固定端口去猜 —— 别人的端口可能完全不同） */
function scanListeningPorts() {
  return new Promise((resolve) => {
    try {
      exec('netstat -ano -p tcp', { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve([])
        const ports = []
        for (const line of String(stdout).split('\n')) {
          if (!/LISTENING/i.test(line)) continue
          const m = line.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\]):(\d{2,5})/)
          if (m) {
            const n = Number(m[1])
            if (n > 1023 && n < 65536) ports.push(n)
          }
        }
        // 去重 + 常见开发端口排前面（纯优化顺序，不影响正确性）
        const uniq = [...new Set(ports)]
        uniq.sort((a, b) => (a === 19387 || a === 3080 ? -1 : 0) - (b === 19387 || b === 3080 ? -1 : 0))
        resolve(uniq.slice(0, 60))
      })
    } catch (e) {
      resolve([])
    }
  })
}

function readPos() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'pos.json'), 'utf8'))
    // 兼容两种历史格式：[x, y] 与 [x, y, w, h]
    if (Array.isArray(j) && j.length >= 2 && Number.isFinite(j[0]) && Number.isFinite(j[1])) return [j[0], j[1]]
  } catch (e) {}
  return null
}

/** 把窗口夹进「所有显示器工作区的并集」，越界就返回修正后的坐标 */
function clampToDisplays(x, y) {
  try {
    const areas = screen.getAllDisplays().map((d) => d.workArea)
    const w = 200, h = 120 // 只保证还有一块可见区域，允许半出屏（窗子本身很大）
    const inside = areas.some((a) => x + w > a.x && x < a.x + a.width && y + h > a.y && y < a.y + a.height)
    if (inside) return [x, y]
    const p = screen.getPrimaryDisplay().workArea
    return [p.x + p.width - 560, p.y + p.height - 300]
  } catch (e) {
    return [x, y]
  }
}

function savePos() {
  if (!win || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  const dir = app.getPath('userData')
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'pos.json'), JSON.stringify([x, y]))
  } catch (e) {}
}

/**
 * 出问题时给一张能看懂、能求助的页面。
 *
 * ⚠️ 独立化之后这里**不再**用来表示「连不上 DSH」——那时候她照常活着，没什么可求助的。
 * 现在只剩一类真错误：她自己的资源（pet.js / 模型）一个都找不到。
 * 所以文案要能直接告诉主人「去哪个目录放 pet-assets」。
 */
function showHint(err) {
  if (!win || win.isDestroyed()) return
  const roots = (() => {
    try {
      return assetRoots()
    } catch (e) {
      return []
    }
  })()
  const detail = err ? String((err && err.message) || err) : ''
  const html = ['<!doctype html><meta charset="utf-8"><style>',
    'html,body{margin:0;height:100%;background:transparent}',
    'body{display:flex;align-items:center;justify-content:center;font:13px/1.7 "Microsoft YaHei",-apple-system,sans-serif;color:#fff;text-align:center}',
    '.box{background:rgba(18,22,34,.92);border:1px solid rgba(255,255,255,.18);border-radius:14px;padding:18px 22px;max-width:84%}',
    '.t{font-weight:600;margin-bottom:8px;font-size:15px}',
    '.s{opacity:.78;font-size:12px;margin-bottom:10px;text-align:left}',
    'button{font:inherit;padding:8px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.25);',
    '  background:rgba(59,98,246,.9);color:#fff;cursor:pointer;margin:0 4px}',
    'code{background:rgba(127,150,255,.18);padding:1px 5px;border-radius:6px;word-break:break-all}',
    '</style><body><div class="box">',
    '<div class="t">找不到她的资源</div>',
    '<div class="s">页面 / 脚本 / 模型是一起找的，下面这些目录都没有 <code>pet.js</code>：<br>' +
      roots.map((p) => '<code>' + p + '</code>').join('<br>') +
      '<br><br>把 <code>pet-plugin/assets</code> 整个拷成 exe 同级的 <code>pet-assets</code> 即可，' +
      '或在 <code>settings.json</code> 里写 <code>{"assetRoots":["..."]}</code>。' +
      (detail ? '<br><br>错误：<code>' + detail.replace(/[<>&]/g, '') + '</code>' : '') +
      '</div>',
    '<button onclick="window.dshpetBridge && window.dshpetBridge.reload()">重新加载</button>',
    '</div></body>'].join('\n')
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}
/** 联动：替用户跑一遍插件安装命令（这就是「下载软件同时把插件装好」） */
function installPlugin() {
  const cmd = `dsh plugin --profile web add ${PLUGIN}`
  if (!win || win.isDestroyed()) return
  win.webContents
    .executeJavaScript(
      `document.querySelector('.s').innerHTML = '正在安装插件…<br><code>${cmd}</code>'`,
    )
    .catch(() => {})
  exec(cmd, { timeout: 300000, windowsHide: true }, (err, stdout, stderr) => {
    const tail = (err ? String(stderr || err.message) : String(stdout || '')).slice(-400)
    const ok = !err
    const msg = ok
      ? '✅ 插件装好了。<br>现在**重启一次 DSH**，然后点「重新连接」。<br><code>' + cmd + '</code>'
      : '❌ 没装成，可能要手动来一次：<br><code>' + cmd + '</code><br>错误：' + tail
    win.webContents
      .executeJavaScript(`document.querySelector('.s').innerHTML = ${JSON.stringify(msg)}`)
      .catch(() => {})
    if (ok) setTimeout(load, 4000)
  })
}

// ——————————————————————————————————————————————————————————————
// 贴边小球（收起态）
// ——————————————————————————————————————————————————————————————
function ballHTML() {
  const icon = readWhaleSVG()
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none;-webkit-app-region:no-drag}
  .ball{width:100%;height:100%;border-radius:50%;box-sizing:border-box;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(120% 120% at 50% 0%, rgba(60,70,96,.98), rgba(16,20,32,.98));
    border:1.5px solid rgba(255,255,255,.34);box-shadow:0 6px 18px rgba(0,0,0,.38);cursor:pointer}
  .ball:hover{border-color:rgba(255,255,255,.6);transform:scale(1.06)}
  svg{width:58%;height:58%}
  svg path{fill:#fff}
  </style><body><div class="ball">${icon}</div></body>`
}

function readWhaleSVG() {
  const cands = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'favicon.svg'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon.svg',
  ]
  for (const p of cands) {
    try {
      const s = fs.readFileSync(p, 'utf8')
      if (s.includes('<svg')) return s.replace(/<style>[\s\S]*?<\/style>/, '')
    } catch (e) {}
  }
  return '<svg viewBox="0 0 24 24"><path d="M3 15c3 0 4-2 6-2s3 2 6 2 4-3 6-3v3c-2 0-3 3-6 3s-3-2-6-2-3 2-6 2z"/></svg>'
}

function createBall() {
  ballWin = new BrowserWindow({
    width: BALL,
    height: BALL,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    // ⚠️ 小球也必须挂 preload：它是靠 window.dshpetBridge 把点击/拖动报回来的，
    // 不挂就等于「小球点不动、拖不了」（写完先自查发现的）
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  })
  ballWin.setAlwaysOnTop(true, 'screen-saver')
  ballWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(ballHTML()))
  ballWin.webContents.on('did-finish-load', () => {
    // 点一下展开；拖一下挪位置（松手贴最近的一边）
    ballWin.webContents.executeJavaScript(`
      (function(){
        var d=false, moved=0, sx=0, sy=0;
        document.addEventListener('mousedown', function(e){ d=true; moved=0; sx=e.screenX; sy=e.screenY; e.preventDefault() });
        document.addEventListener('mousemove', function(e){ if(!d) return; moved=Math.max(moved, Math.abs(e.screenX-sx)+Math.abs(e.screenY-sy));
          if(moved>3) window.dshpetBridge && window.dshpetBridge.ballMove(e.screenX-sx, e.screenY-sy) });
        document.addEventListener('mouseup', function(){ if(!d) return; d=false;
          window.dshpetBridge && window.dshpetBridge.ballDrop(moved>3) });
      })()
    `).catch(() => {})
  })
  ipcMain.on('ball-move', (_e, dx, dy) => {
    if (!ballWin || !ballDrag) return
    ballWin.setPosition(Math.round(ballDrag[0] + dx), Math.round(ballDrag[1] + dy))
  })
  ipcMain.on('ball-drop', (_e, moved) => {
    if (!ballWin) return
    if (!moved) return expand()
    snapBall()
  })
}

function snapBall() {
  if (!ballWin) return
  const wa = screen.getPrimaryDisplay().workArea
  const [x, y] = ballWin.getPosition()
  const nearest = x + BALL / 2 < wa.x + wa.width / 2 ? wa.x + 4 : wa.x + wa.width - BALL - 4
  const ny = Math.min(Math.max(y, wa.y + 4), wa.y + wa.height - BALL - 4)
  ballWin.setPosition(nearest, ny)
}

function collapse() {
  if (!win || collapsed) return
  collapsed = true
  savePos()
  const [wx, wy] = win.getPosition()
  const wa = screen.getPrimaryDisplay().workArea
  const onLeft = wx + WIN_W / 2 < wa.x + wa.width / 2
  if (!ballWin) createBall()
  ballWin.setPosition(onLeft ? wa.x + 4 : wa.x + wa.width - BALL - 4, Math.round(wy + WIN_H / 2 - BALL / 2))
  ballWin.showInactive()
  ballWin.setAlwaysOnTop(true, 'screen-saver')
  win.hide()
  ballDrag = [ballWin.getPosition()[0], ballWin.getPosition()[1]]
  setTimeout(snapBall, 30)
}

function expand() {
  if (!collapsed) return
  collapsed = false
  if (ballWin) {
    ballDrag = null
    ballWin.hide()
  }
  if (win) {
    win.showInactive()
    win.setAlwaysOnTop(true, 'screen-saver')
    win.webContents.executeJavaScript('window.DSHPet && DSHPet.setHidden && DSHPet.setHidden(false)').catch(() => {})
  }
}

// ——————————————————————————————————————————————————————————————
// 托盘菜单（Windows 上没有菜单栏图标，改放系统托盘）
// ——————————————————————————————————————————————————————————————
function createTray() {
  const iconPath = path.join(__dirname, 'build', 'icon.png')
  let img = nativeImage.createFromPath(iconPath)
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 })
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
  tray.setToolTip('DS 鲸鱼娘桌宠')

  // 开机自启动已移除（本机调整）：改为「DSH 启动时由插件拉起外壳」，
  // 见插件 lib/index.js 的 autoStartShell()。
  const rebuild = () => {
    const online = !!(petServer && petServer.state().online)
    const linkPort = petServer ? petServer.state().upstreamPort : null
    const linkOff = readSettings().linkDsh === false
    tray.setContextMenu(
      Menu.buildFromTemplate([
        // 第一行就是「她现在的状态」：独立之后，这一行是主人唯一的观察窗口
        { label: online ? '● 已连上 DSH' + (linkPort ? ' · ' + linkPort : '') : linkOff ? '○ 连接 DSH：已关闭' : '○ 未连上 DSH（点我重试）',
          enabled: !online,
          click: () => { syncAttempt = 0; syncUpstream() } },
        { type: 'separator' },
        { label: winVisible() ? '隐藏桌宠' : '显示桌宠', click: () => toggleVisible() },
        { label: collapsed ? '展开桌宠' : '收起成小球（贴边）', click: () => (collapsed ? expand() : collapse()) },
        { label: '回到右下角', click: resetPos },
        { label: '重新加载页面', click: load },
        { type: 'separator' },
        {
          label: '低性能模式（少动、省电）',
          type: 'checkbox',
          checked: lowPower,
          click: (mi) => {
            lowPower = mi.checked
            if (win) win.webContents.executeJavaScript('window.DSHPet && DSHPet.setLowPower && DSHPet.setLowPower(' + lowPower + ')').catch(() => {})
          },
        },
        { label: '打开 DSH 界面', click: () => openDsh() },
        { label: linkOff ? '连接 DSH：已关闭（点我打开）' : '连接 DSH：自动（点我关掉）',
          click: () => toggleLink() },
        { label: '一键安装 DSH 插件（聊天用）', click: installPlugin },
        { type: 'separator' },
        { label: '彻底退出', click: () => app.quit() },
      ]),
    )
  }
  tray.on('click', () => (collapsed ? expand() : win && win.showInactive()))
  setInterval(rebuild, 1500)
  rebuild()
}

/** 她现在是显示着的吗（收起成小球时主窗口是 hide 的） */
function winVisible() {
  try {
    return !!(win && !win.isDestroyed() && win.isVisible())
  } catch (e) {
    return false
  }
}

/**
 * 托盘里的「显示 / 隐藏」。
 * 和「收起成小球」不是一回事：那个会换成贴边悬浮球（有 UI），这个只是看不见她（不占地方）。
 * 隐藏时页面里的状态一起改（DSHPet.setHidden），否则再显示出来时她还以为自己被藏着。
 */
function toggleVisible() {
  if (!win || win.isDestroyed()) return
  if (winVisible()) {
    win.hide()
    bootLog('托盘：隐藏桌宠')
  } else {
    win.showInactive()
    win.setAlwaysOnTop(true, 'screen-saver')
    win.webContents.executeJavaScript('window.DSHPet && DSHPet.setHidden && DSHPet.setHidden(false)').catch(() => {})
    bootLog('托盘：显示桌宠')
  }
}

/**
 * 托盘里的「连接 DSH：自动 / 关掉」。
 * 主人要的是「她的独立开关」：不想让她连 DSH（比如在旁边专心工作、不想被气泡打扰）时就关掉，
 * 她会照样待机、照样动，只是失去对话。写在 settings.json 里，重启后仍然有效。
 */
function toggleLink() {
  const cfg = readSettings()
  const next = cfg.linkDsh === false
  cfg.linkDsh = next ? true : false
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
    fs.writeFileSync(settingsPath(), JSON.stringify(cfg, null, 2))
  } catch (e) {
    bootLog('写 settings.json 失败：' + (e && e.message))
  }
  bootLog('连接 DSH → ' + (cfg.linkDsh ? '自动' : '关闭'))
  if (cfg.linkDsh) {
    syncAttempt = 0
    syncUpstream()
    petSay('我去找 DSH 啦')
  } else {
    if (petServer) petServer.clearUpstream()
    petSay('好，先不连 DSH，我陪你就好')
  }
}

function resetPos() {
  if (!win) return
  const wa = screen.getPrimaryDisplay().workArea
  win.setPosition(wa.x + wa.width - WIN_W - 8, wa.y + wa.height - WIN_H - 8)
  savePos()
}

// ——————————————————————————————————————————————————————————————

// ————————————————————————————————————————————————————————————————
// 启动诊断（Issue #6 / #8 的血泪）：两位 Windows 用户都遇到「双击后无声无息」——
// 没有窗口、没有日志、没有 userData，连退出码都看不出来，完全没法定位。
// 所以这里做三件事：① 任何阶段都往文件写日志 ② 兜住未捕获异常/未处理 Promise
// ③ 启动失败时弹一个看得见的对话框，把日志路径告诉用户。
// ————————————————————————————————————————————————————————————————
const LOG_DIR = path.join(process.env.APPDATA || os.homedir(), 'ds-whale-girl-pet')
const LOG_FILE = path.join(LOG_DIR, 'boot.log')
function bootLog(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`)
  } catch (e) {}
  try {
    console.log('[dsh-pet]', msg)
  } catch (e) {}
}
bootLog(
  `=== 启动 v${require('./package.json').version} | electron ${process.versions.electron} | ` +
    `node ${process.versions.node} | exe=${process.execPath} | dir=${__dirname} | ` +
    `token=${fs.existsSync(TOKEN_FILE) ? '有' : '无'} ===`,
)
process.on('uncaughtException', (err) => {
  bootLog('未捕获异常: ' + (err && err.stack ? err.stack : String(err)))
})
process.on('unhandledRejection', (err) => {
  bootLog('未处理的 Promise 拒绝: ' + (err && err.stack ? err.stack : String(err)))
})

// ——————————————————————————————————————————————————————————————
// 单实例锁（本机新增）
// ——————————————————————————————————————————————————————————————
// 原版**没有**这个锁：重复双击 exe 会开出第二个窗口、桌面上就有两条鱼。
// 现在插件会在 DSH 启动时自动拉起外壳（见插件 lib/index.js 的 autoStartShell），
// 如果外壳已经在跑（比如插件重启、或 DSH 重启），没有锁就会多出一条。
// 加锁后：重复启动只会把已有窗口提到最前，不会开第二个。
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    try {
      if (win && !win.isDestroyed()) {
        if (collapsed) expand()
        win.show()
        win.setAlwaysOnTop(true, 'screen-saver')
      }
    } catch (e) {}
  })
}

app.whenReady().then(() => {
  if (!gotLock) return
  try {
    bootLog('app ready')
    app.setAppUserModelId('com.andersen216.dsh.whalegirlpet')
    createMain()
    bootLog('主窗口已创建')
    createTray()
    bootLog('托盘已创建')
    ipcMain.on('reload', load)
    // 持续盯着「DSH 有没有回来」：这是「开 DSH 她就自动接上」的唯一实现点。
    // 8 秒一次：主人从头开一次 DSH 大概十几秒，8 秒的延迟在他眼里就是「几乎立刻」，
    // 而空转的成本只是每 8 秒一次 1.5 秒超时的本地探测（没连上时才真去探）。
    setInterval(() => {
      syncUpstream().catch(() => {})
    }, 8000)
  } catch (err) {
    bootLog('启动失败: ' + (err && err.stack ? err.stack : String(err)))
    try {
      dialog.showErrorBox(
        'DS 鲸鱼娘桌宠 · 启动失败',
        '启动时出错了。日志文件在：\n' + LOG_FILE + '\n\n' +
          (err && err.message ? err.message : String(err)) +
          '\n\n把日志发到 GitHub issue 即可定位。',
      )
    } catch (e) {}
    app.exit(1)
  }
})
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  clearInterval(pollTimer)
  clearInterval(dragTimer)
  if (audioMeter) audioMeter.stop()
  if (petServer) {
    bootLog('退出：关掉本地服务')
    petServer.close().catch(() => {})
    petServer = null
  }
})
