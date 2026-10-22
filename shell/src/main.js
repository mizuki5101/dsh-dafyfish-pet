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
const { createHitGuard } = require('./hit/guard')
// 原生键位（Shift 兜底判定）：识图是「Shift+右击她」，而命中窗是 WS_NOACTIVATE，
// 它收不到键盘消息 → 渲染进程的 e.shiftKey 在某些情况下不可信，用真实的物理键状态兜底。
const nativeKeys = require('./native/keys')
// 多模态心跳（P0：采集 + 截图指纹；默认关闭）按需 require —— 见 app.whenReady 里的注释。

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
/** 心跳（多模态感知器） */
let heart = null
/** 本地推理引擎进程（面板里的「一键启动/停止」） */
let modelServer = null
/** 设置面板「心跳」页的数据源；在 app.whenReady 里装配（它依赖 heart / modelServer） */
let heartSettingsPayload = null
/** 「回应模式」的聊天记忆（持久化到 userData/heart/chat.json） */
let chatMemory = null
/** 功能面板（划词翻译 / 识图）；在 app.whenReady 里装配，独立于心跳 */
let tools = null

/**
 * 识图遮罩窗是不是开着。
 * 遮罩是 screen-saver 级的全屏窗：90ms 轮询 / 2s 安全网 / 命中窗任何一个还在动，
 * 都会把主窗或命中窗抬到遮罩上面 —— 表现就是「遮罩一闪就没了」。
 */
function shotOpenNow() {
  try {
    return !!(tools && tools.shotOpen && tools.shotOpen())
  } catch (e) {
    return false
  }
}

/**
 * 面板提交的补丁：**只接受白名单字段**。
 * 为什么不在页面侧保证：页面是回环服务发的，但它仍然是「外部输入」；
 * 写 settings.json 的东西必须在主进程再过滤一次（和 /dsh-pet/say 的 dryRun 一个道理）。
 */
/* sanitizeHeartPatch 已挪到 heart/settings.js（2026-10-20）：
 * 它是一层**字段白名单**，而白名单漏字段的症状是「保存了但没生效」——
 * 上次漏了 bili，滑块和视频口味存不进去。放在纯函数文件里才能被测到。 */
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
let topmostTimer = null
// fullscreenPrimary：窗口固定 0,0，拖动由页面自己移动 root（不再搬窗口，
// 否则窗口右/下边缘会跑到屏幕中间，把尾巴/裙摆切掉）。
let pageDragging = false
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
// 双窗口（2026-10-18）：渲染窗始终穿透，命中窗只收身体上的 pointer。
// 默认关闭；settings.json 里写 {"dualWindow": true} 才启用。
let hitWin = null
let hitGuard = null
let dualWindow = false
let hitRect = null
let hitRects = null
let hitClip = null
let hitShapeKey = ''
let hitShapeWarned = false
let hitShapeLogged = false
let hitVisibleSent = null
let hitRectBusy = false
let hitSyncTimer = null
let uiMode = false
let modalMode = false
let hitDragging = false
let lastHitPoint = null

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
 * 心跳截图前要涂掉的矩形（屏幕 DIP 坐标）。
 *
 * 为什么必须涂：desktopCapturer 会把她自己、气泡、dock 一起拍进去（2026-10-18 实测）。
 * 模型看见「一条鱼盯着屏幕」会做出离谱判断，气泡上的字也会混进画面。
 *
 * 组成：她身体的 alpha 紧包围盒（DSHPet.hitBounds，视口坐标）+ 所有可见 UI 元素，
 * 全部加上窗口内容原点。查询失败就返回空数组 —— 调用方会原样发图，
 * 所以 P1 接模型前要按 privacy 配置决定「没有遮罩时是否允许发图」。
 */
/** 心跳用：她现在忙不忙 / 睡没睡（决定能不能插话）。查不到就当空闲。 */
async function petAgentState() {
  if (!win || win.isDestroyed()) return { status: 'idle', sleeping: false }
  try {
    // ⚠️ 睡眠状态不在 DSHPet.state.agent 里（那个字段永远是 false），
    //    真正的睡眠在 DSHPet.sleepState().asleep —— 之前读错字段，导致心跳在她睡着时照样说话。
    return await win.webContents.executeJavaScript(
      "(()=>{try{const s=DSHPet.state.agent;const z=(DSHPet.sleepState&&DSHPet.sleepState())||null;return {status:s.status||'idle',sleeping:!!(z&&z.asleep)}}catch(e){return {status:'idle',sleeping:false}}})()",
    )
  } catch (e) {
    return { status: 'idle', sleeping: false }
  }
}

async function petMaskRects() {
  if (!win || win.isDestroyed()) return []
  let rects = []
  try {
    rects = await win.webContents.executeJavaScript(`(function(){
      const out = []
      try {
        if (window.DSHPet && DSHPet.hitBounds) {
          const b = DSHPet.hitBounds()
          if (b && b.w > 1 && b.h > 1) out.push(b)
        }
      } catch (e) {}
      const sels = ['.dshp-bubble', '.dshp-dock', '.dshp-menu', '.dshp-panel', '.dshp-hud', '.dshp-pin', '.dshp-tools']
      for (const sel of sels) {
        let els = []
        try { els = document.querySelectorAll(sel) } catch (e) { continue }
        for (const el of els) {
          const r = el.getBoundingClientRect()
          if (!(r.width > 1 && r.height > 1)) continue
          const cs = getComputedStyle(el)
          if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
          out.push({ x: r.left, y: r.top, w: r.width, h: r.height })
        }
      }
      return out
    })()`)
  } catch (e) {
    rects = []
  }
  let cb = null
  try {
    cb = win.getContentBounds()
  } catch (e) {}
  const ox = cb ? cb.x : 0
  const oy = cb ? cb.y : 0
  return (Array.isArray(rects) ? rects : []).map((r) => ({ x: ox + r.x, y: oy + r.y, w: r.w, h: r.h }))
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
  // 详细频率面板是模态：它铺满全屏的遮罩/面板必须让整个窗口可点，
  // 否则鼠标落在她身体外时窗口会 setIgnoreMouseEvents(true) → 面板看得见、点不到。
  if(window.__DSHPET_MODAL__) return 'panel';
  var el=document.elementFromPoint(${x},${y});
  // 只把“真正可点的控件/面板”算 UI。dock 容器、气泡容器本身不算 ——
  // 否则鼠标只是从她身上/尾巴附近划过，也会进 UI 模式（setIgnoreMouseEvents(false)），
  // 透明窗会掉 WS_EX_LAYERED，出现灰边 + 尾巴被裁 + 一闪一闪。
  var ui=!!(el&&el.closest&&el.closest('.dshp-panel,.dshp-menu,.dshp-hud,.dshp-composer,.dshp-tuning,.dshp-tuning-mask,.dshp-tab,.dshp-tab-btn,.dshp-btn,.dshp-bubble button,.dshp-bubble input,.dshp-bubble textarea,.dshp-pin,.dshp-tools'));
  if(ui) return 'panel';
  if(window.DSHPet&&DSHPet.hitTest&&DSHPet.hitTest(${x},${y})) return 'model';
  return 'none';
}catch(e){return 'none'}})()`

function setIgnore(on) {
  if (!win || win.isDestroyed()) return
  win.setIgnoreMouseEvents(on, { forward: true })
}

// ——————————————————————————————————————————————————————————————
// 双窗口（2026-10-18）：命中窗 + 渲染窗
//
// 渲染窗始终 setIgnoreMouseEvents(true,{forward:true})；命中窗只覆盖她的
// alpha 紧包围盒，收真实 pointer 后交给这里，再用 sendInputEvent 注入渲染页。
// 命中窗的“不激活”靠 hit/guard.js（WS_EX_NOACTIVATE + Chrome.IgnoreMouseActivate）。
// ——————————————————————————————————————————————————————————————
function dualEnabled() {
  return !!(dualWindow && hitWin && !hitWin.isDestroyed())
}

function renderBounds() {
  try {
    return win && !win.isDestroyed() ? win.getContentBounds() : null
  } catch (e) {
    return null
  }
}

function applyHitShape() {
  if (!dualEnabled() || !hitClip) return
  const out = []
  if (Array.isArray(hitRects) && hitRects.length) {
    for (const r of hitRects) {
      const l = Math.max(0, r.x - hitClip.ox)
      const t = Math.max(0, r.y - hitClip.oy)
      const rr = Math.min(hitClip.w, r.x + r.w - hitClip.ox)
      const bb = Math.min(hitClip.h, r.y + r.h - hitClip.oy)
      if (rr - l < 1 || bb - t < 1) continue
      out.push({
        x: Math.round(l),
        y: Math.round(t),
        width: Math.max(1, Math.round(rr - l)),
        height: Math.max(1, Math.round(bb - t)),
      })
    }
  }
  const shape = out.length && out.length <= 500 ? out : null
  const key = hitClip.w + 'x' + hitClip.h + '|' + (shape
    ? shape.map((r) => r.x + ',' + r.y + ',' + r.width + ',' + r.height).join(';')
    : 'full')
  if (key === hitShapeKey) return
  hitShapeKey = key
  try {
    hitWin.setShape(shape || [])
    if (!hitShapeLogged) {
      hitShapeLogged = true
      bootLog('双窗口：命中形状 ' + (shape ? shape.length + ' 块' : '整块矩形'))
    }
  } catch (e) {
    if (!hitShapeWarned) {
      hitShapeWarned = true
      bootLog('双窗口：setShape 不可用，退回矩形（' + (e && e.message) + '）')
    }
    try { hitWin.setShape([]) } catch (e2) {}
  }
}

function updateHitWindowBounds() {
  if (!dualEnabled() || !hitRect) return
  const rb = renderBounds()
  if (!rb) return
  // 她可能半出屏：命中窗只取渲染窗内那一段，别把窗口铺到屏幕外
  const x0 = Math.max(0, Math.min(rb.width, hitRect.x))
  const y0 = Math.max(0, Math.min(rb.height, hitRect.y))
  const x1 = Math.max(x0, Math.min(rb.width, hitRect.x + hitRect.w))
  const y1 = Math.max(y0, Math.min(rb.height, hitRect.y + hitRect.h))
  if (x1 - x0 < 2 || y1 - y0 < 2) {
    try { if (hitWin.isVisible()) hitWin.hide() } catch (e) {}
    return
  }
  const x = Math.round(rb.x + x0)
  const y = Math.round(rb.y + y0)
  const w = Math.max(2, Math.round(x1 - x0))
  const h = Math.max(2, Math.round(y1 - y0))
  hitClip = { ox: x0 - hitRect.x, oy: y0 - hitRect.y, w: w, h: h }
  try {
    const b = hitWin.getBounds()
    if (b.x !== x || b.y !== y || b.width !== w || b.height !== h) {
      hitWin.setBounds({ x: x, y: y, width: w, height: h })
    }
  } catch (e) {}
  applyHitShape()
}

function sendHitVisibility(value) {
  if (!dualEnabled()) return
  const v = !!value
  if (hitVisibleSent === v) return
  hitVisibleSent = v
  try { hitWin.webContents.send('hit:visibility', v) } catch (e) {}
}

/** 输入法候选窗会被置顶窗盖住：输入期间临时降下置顶，失焦再恢复。 */
let imeHolding = false
let imeHoldTimer = null

function raiseTopmost(toggle) {
  // 识图遮罩开着：别把主窗/命中窗抬到遮罩上面（遮罩是全屏 screen-saver 级）
  if (shotOpenNow()) return
  // 输入中不要抬回来，否则 IME 候选窗又被盖住
  if (imeHolding && !toggle) return
  try {
    if (win && !win.isDestroyed()) {
      // 已经 topmost 的窗口再设 true 不一定能抢回任务栏上面；
      // 只有窗口压到工作区外（任务栏/屏幕边缘）时才做一次 false→true 重新入栈。
      if (toggle) win.setAlwaysOnTop(false)
      win.setAlwaysOnTop(true, 'screen-saver')
    }
  } catch (e) {}
  if (dualEnabled()) {
    try {
      if (toggle) hitWin.setAlwaysOnTop(false)
      hitWin.setAlwaysOnTop(true, 'screen-saver')
    } catch (e) {}
  }
}

function syncHitWindow() {
  if (!dualEnabled()) return
  // ⚠️ 命中窗也是 screen-saver 级 topmost：输入时它虽然多为隐藏，但 90ms 轮询
  // 一旦把鼠标判成「不在 UI 上」就会重新 showInactive + topmost，把 IME 候选窗盖住。
  // 所以「输入中」直接强制隐藏，失焦后再恢复。
  const visible = !!(
    !imeHolding &&
    !shotOpenNow() &&
    win &&
    !win.isDestroyed() &&
    win.isVisible() &&
    !collapsed &&
    !uiMode &&
    hitRect
  )
  if (!visible) {
    sendHitVisibility(false)
    try { if (hitWin.isVisible()) hitWin.hide() } catch (e) {}
    return
  }
  updateHitWindowBounds()
  try {
    if (!hitWin.isVisible()) hitWin.showInactive()
    hitWin.setAlwaysOnTop(true, 'screen-saver')
  } catch (e) {}
  sendHitVisibility(true)
}

async function queryHitBounds() {
  if (pageDragging) return // 页面内拖动中：命中窗必须留在原地，否则注入坐标会跟丢
  if (!dualWindow || !win || win.isDestroyed() || !win.isVisible()) {
    hitRect = null
    hitRects = null
    syncHitWindow()
    return
  }
  if (hitRectBusy) return
  hitRectBusy = true
  try {
    const r = await win.webContents.executeJavaScript(
      '(function(){try{return {b:(window.DSHPet&&DSHPet.hitBounds?DSHPet.hitBounds():null),r:(window.DSHPet&&DSHPet.hitRects?DSHPet.hitRects():null)}}catch(e){return {b:null,r:null}}})()',
    )
    hitRect = r && r.b && Number(r.b.w) > 1 && Number(r.b.h) > 1 ? r.b : null
    hitRects = r && Array.isArray(r.r) ? r.r : null
  } catch (e) {
    hitRect = null
    hitRects = null
  }
  hitRectBusy = false
  syncHitWindow()
}

function enterUiMode() {
  if (!dualWindow || uiMode) return
  uiMode = true
  setIgnore(false)
  if (dualEnabled()) {
    sendHitVisibility(false)
    try { hitWin.hide() } catch (e) {}
  }
  raiseTopmost()
  bootLog('双窗口：UI 模式（渲染窗可交互，hitVisible=' + (dualEnabled() ? hitWin.isVisible() : false) + '）')
}

function leaveUiMode(force) {
  if (!dualWindow || !uiMode) return
  if (modalMode && !force) return
  uiMode = false
  setIgnore(true)
  syncHitWindow()
  raiseTopmost()
  bootLog('双窗口：命中模式（渲染窗穿透，hitVisible=' + (dualEnabled() ? hitWin.isVisible() : false) + '）')
}

function hitToRender(p) {
  if (!dualEnabled()) return null
  const hb = hitWin.getContentBounds()
  const rb = renderBounds()
  if (!hb || !rb) return null
  return {
    x: Math.round(hb.x - rb.x + Number(p && p.x ? p.x : 0)),
    y: Math.round(hb.y - rb.y + Number(p && p.y ? p.y : 0)),
  }
}

function injectMouse(type, pt, button, clickCount) {
  if (!win || win.isDestroyed() || !pt) return
  const ev = { type: type, x: pt.x, y: pt.y }
  if (type !== 'mouseMove' && type !== 'mouseLeave') {
    ev.button = button || 'left'
    ev.clickCount = clickCount || 1
  }
  try { win.webContents.sendInputEvent(ev) } catch (e) {}
}

function startWindowDrag(at) {
  if (!win || win.isDestroyed() || !win.isVisible()) return false
  if (readFullscreenPrimary()) {
    // 铺满主屏：不搬窗口，让 pet.js 自己的 DOM 拖动跑。
    // 命中窗在拖动期间保持原位（pointer capture 会继续收 move），松手后再 queryHitBounds。
    pageDragging = true
    hitDragging = true
    return true
  }
  // 命中窗给的坐标可能带小数/在窗口搬动后短暂过期；系统光标是拖动的最终真相。
  // 两者差得不多就用命中窗的按下点（少 3px 阈值误差），差太多就用系统光标。
  const cur = screen.getCursorScreenPoint()
  const ax = at && Number.isFinite(at.x) ? at.x : null
  const ay = at && Number.isFinite(at.y) ? at.y : null
  // 用按下点的屏幕坐标（at）作为拖动原点：3px 阈值内光标已经移动了，
  // 用系统光标当原点会把这 3px（测试里 10px）吃掉，松手后宠物停在鼠标旁边。
  // at 只在离谱地远（例如合成输入）时才不用。
  const near = ax != null && ay != null && Math.abs(ax - cur.x) <= 250 && Math.abs(ay - cur.y) <= 250
  dragFrom = {
    mouse: {
      x: Math.round(near ? ax : cur.x),
      y: Math.round(near ? ay : cur.y),
    },
    win: win.getPosition(),
  }
  clearInterval(dragTimer)
  dragTimer = setInterval(() => {
    if (!dragFrom || !win || win.isDestroyed()) return
    const p = screen.getCursorScreenPoint()
    const nx = dragFrom.win[0] + (p.x - dragFrom.mouse.x)
    const ny = dragFrom.win[1] + (p.y - dragFrom.mouse.y)
    // Windows/Electron setPosition 只接受整数；命中窗给来的屏幕坐标可能是小数，
    // 直接传会抛 "conversion failure"，拖动就会一卡一卡、命中窗也跟不上。
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return
    win.setPosition(Math.round(nx), Math.round(ny))
    updateHitWindowBounds()
  }, 16)
  try {
    win.webContents.executeJavaScript("document.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true}))").catch(() => {})
  } catch (e) {}
  return true
}

function stopWindowDrag(endPoint) {
  if (pageDragging) {
    pageDragging = false
    hitDragging = false
    clearInterval(dragTimer)
    dragTimer = null
    dragFrom = null
    // 页面 root 已经移到新位置；稍等一帧再让命中窗跟过去（16ms 足够，别让连续拖动等太久）。
    setTimeout(() => { if (dualEnabled()) queryHitBounds() }, 16)
    return
  }
  // 16ms 定时器可能比鼠标慢一帧：松手时补最后一次位置，
  // 否则她会停在光标左边/右边几像素，下一次按下就落在形状外，表现为“拖不动/回原点”。
  if (dragFrom && win && !win.isDestroyed()) {
    try {
      const os = screen.getCursorScreenPoint()
      const ep = endPoint && Number.isFinite(endPoint.sx) && Number.isFinite(endPoint.sy)
        ? { x: endPoint.sx, y: endPoint.sy }
        : os
      const nx = dragFrom.win[0] + (ep.x - dragFrom.mouse.x)
      const ny = dragFrom.win[1] + (ep.y - dragFrom.mouse.y)
      if (Number.isFinite(nx) && Number.isFinite(ny)) {
        win.setPosition(Math.round(nx), Math.round(ny))
        updateHitWindowBounds()
      }
    } catch (e) {}
  }
  clearInterval(dragTimer)
  dragTimer = null
  dragFrom = null
  hitDragging = false
  // 铺满主屏时窗口位置没有意义，别把拖动后的偏移写进 pos.json，
  // 否则关掉 fullscreenPrimary 后会恢复到一个奇怪的坐标。
  if (!readFullscreenPrimary()) savePos()
  raiseTopmost()
}

function destroyHitWindow() {
  clearInterval(hitSyncTimer)
  hitSyncTimer = null
  if (hitGuard) {
    try { hitGuard.dispose() } catch (e) {}
    hitGuard = null
  }
  if (hitWin && !hitWin.isDestroyed()) {
    try { hitWin.destroy() } catch (e) {}
  }
  hitWin = null
  hitRect = null
  hitRects = null
  hitClip = null
  hitShapeKey = ''
  hitShapeLogged = false
  hitVisibleSent = null
}

function initHitWindow() {
  if (!dualWindow || hitWin) return
  try {
    hitWin = new BrowserWindow({
      width: 2,
      height: 2,
      x: -10000,
      y: -10000,
      frame: false,
      transparent: true,
      resizable: false,
      hasShadow: false,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      focusable: false,
      webPreferences: {
        preload: path.join(__dirname, 'hit', 'preload-hit.js'),
        contextIsolation: true,
        backgroundThrottling: false,
      },
    })
    hitWin.setAlwaysOnTop(true, 'screen-saver')
    hitWin.setMenuBarVisibility(false)
    hitWin.loadFile(path.join(__dirname, 'hit', 'hit.html'))
    hitGuard = createHitGuard({ log: bootLog })
    const ok = hitGuard.prepare(hitWin)
    if (!ok) {
      bootLog('双窗口：守卫不可用，回退单窗口')
      try { hitWin.destroy() } catch (e) {}
      hitWin = null
      dualWindow = false
      return
    }
    hitWin.on('closed', () => {
      clearInterval(hitSyncTimer)
      hitSyncTimer = null
      hitWin = null
    })
    hitWin.webContents.on('did-finish-load', () => { queryHitBounds() })
    hitWin.webContents.on('render-process-gone', (_e, details) => {
      bootLog('双窗口：命中窗进程挂了（' + (details && details.reason) + '），1 秒后重建')
      clearInterval(hitSyncTimer)
      hitSyncTimer = null
      if (hitGuard) { try { hitGuard.dispose() } catch (e) {} hitGuard = null }
      try { hitWin.destroy() } catch (e) {}
      hitWin = null
      setTimeout(() => { if (dualWindow) initHitWindow() }, 1000)
    })
    hitSyncTimer = setInterval(queryHitBounds, 300)
    queryHitBounds()
    bootLog('双窗口：命中窗已创建（hwnd=' + hitGuard.hwnd + '）')
  } catch (e) {
    bootLog('双窗口：命中窗创建失败：' + (e && e.stack ? e.stack : e))
    try { if (hitWin) hitWin.destroy() } catch (err) {}
    hitWin = null
    dualWindow = false
  }
}

ipcMain.on('hit:down', (_e, p) => {
  if (!dualEnabled() || uiMode) return
  const pt = hitToRender(p)
  if (!pt) return
  lastHitPoint = pt
  injectMouse('mouseMove', pt)
  injectMouse('mouseDown', pt, 'left', 1)
})

ipcMain.on('hit:move', (_e, p) => {
  if (!dualEnabled() || uiMode) return
  const pt = hitToRender(p)
  if (!pt) return
  lastHitPoint = pt
  injectMouse('mouseMove', pt)
})

ipcMain.on('hit:up', (_e, p) => {
  if (!dualEnabled() || uiMode) return
  const pt = hitToRender(p) || lastHitPoint
  if (!pt) return
  injectMouse('mouseUp', pt, 'left', 1)
  lastHitPoint = null
})

ipcMain.on('hit:drag-start', (_e, p) => {
  if (!dualEnabled() || uiMode) return
  const sx = Number(p && p.sx)
  const sy = Number(p && p.sy)
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return
  hitDragging = true
  startWindowDrag({ x: Math.round(sx), y: Math.round(sy) })
})

ipcMain.on('hit:drag-end', (_e, endPoint) => {
  if (!dualEnabled()) return
  const pt = lastHitPoint
  stopWindowDrag(endPoint)
  if (pt) injectMouse('mouseUp', pt, 'left', 1)
  lastHitPoint = null
})

ipcMain.on('hit:contextmenu', (_e, p) => {
  if (!dualEnabled() || uiMode) return
  // Shift+右击 = 识图（2026-10-22）。
  // 这里**不注入右键**：页面对这个右键的唯一反应是开钱包 HUD，而 Shift 的语义是
  // 「开一块全屏遮罩」——遮罩是主进程的窗口，页面无事可做。
  // 兜底用 nativeKeys.shiftDown()：命中窗是 WS_EX_NOACTIVATE，键盘消息可能收不到，
  // 渲染进程上报的 e.shiftKey 在某些场景（远程桌面/输入法粘键）会是 false。
  const shift = !!(p && p.shift) || nativeKeys.shiftDown()
  if (shift && tools) {
    const r = tools.startShot()
    if (r && r.ok) return
    if (r && r.reason === 'busy') return
    // 识图关着 / 没配模型：给一句提示，不再开钱包（用户明确按了 Shift，就是想识图）
    if (petServer) {
      try {
        petServer.push({ t: 'control', say: (r && r.hint) || '识图现在用不了…', bubbleMs: 4000 })
      } catch (e) {}
    }
    return
  }
  const pt = hitToRender(p)
  if (!pt) return
  injectMouse('mouseDown', pt, 'right', 1)
  injectMouse('mouseUp', pt, 'right', 1)
})

ipcMain.on('hit:leave', () => {
  // 不再往页面注入 (-20,-20)：鼠标只是划过命中窗形状的空隙/边缘时，
  // 那一下会把 gaze 拽到左上角，表现就是视线一抽一抽。
  // 真实光标位置由 cursorFeed 持续提供。
})

ipcMain.on('hit:wheel', (_e, p) => {
  if (!dualEnabled() || uiMode) return
  const pt = hitToRender(p)
  if (!pt) return
  try {
    win.webContents.sendInputEvent({
      type: 'mouseWheel',
      x: pt.x,
      y: pt.y,
      deltaX: Number(p && p.dx) || 0,
      deltaY: Number(p && p.dy) || 0,
      canScroll: true,
    })
  } catch (e) {}
})

ipcMain.on('hit:cancel', () => {
  if (!dualEnabled()) return
  stopWindowDrag()
  lastHitPoint = null
  try {
    win.webContents.executeJavaScript("document.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true}))").catch(() => {})
  } catch (e) {}
})

async function poll() {
  if (!win || win.isDestroyed() || !win.isVisible()) return
  if (shotOpenNow()) return // 识图遮罩自己吃鼠标，别在这儿来回切 UI 模式
  if (pageDragging) return // 页面内拖动时别抢 UI 模式/别 hide 命中窗
  const p = screen.getCursorScreenPoint()
  const b = win.getBounds()
  if (p.x < b.x || p.x > b.x + b.width || p.y < b.y || p.y > b.y + b.height) {
    lastHit = 'none'
    overPanel = false
    if (dualWindow) {
      leaveUiMode()
      setIgnore(true)
      syncHitWindow()
    } else {
      setIgnore(true)
    }
    return
  }
  if (dragTimer) return // 拖动中不抢事件（否则鼠标一离开她就变穿透，拖动会断）
  try {
    const kind = await win.webContents.executeJavaScript(hitJS(Math.round(p.x - b.x), Math.round(p.y - b.y)))
    if (kind !== lastHit) bootLog('鼠标命中：' + kind)
    lastHit = kind
    if (dualWindow) {
      // 命中模式：渲染窗永远穿透，命中窗收身体点击；
      // UI 模式：命中窗让开，渲染窗变可交互（按钮/面板/输入框才能激活）。
      if (kind === 'panel') {
        overPanel = true
        enterUiMode()
      } else {
        overPanel = false
        leaveUiMode()
        setIgnore(true)
        syncHitWindow()
      }
      return
    }
    overPanel = kind === 'panel'
    setIgnore(kind === 'none')
  } catch (e) {
    setIgnore(true)
    if (dualWindow) syncHitWindow()
  }
}

// ——————————————————————————————————————————————————————————————
// 主窗口
// ——————————————————————————————————————————————————————————————
function createMain() {
  dualWindow = readSettings().dualWindow === true
  if (dualWindow) bootLog('双窗口：settings.json dualWindow=true')
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
  // 别让 Win+Up / 拖到屏幕边缘把窗口最大化/缩放：透明桌宠一旦被系统改成
  // 比屏幕还大，就会出现“尾巴被裁 / 命中窗跑到屏幕外 / 和任务栏抢占图层”。
  try { win.setMaximizable(false) } catch (e) {}
  try { win.setMinimizable(false) } catch (e) {}
  try { win.setFullScreenable(false) } catch (e) {}
  try { win.webContents.setVisualZoomLevelLimits(1, 1) } catch (e) {}
  if (dualWindow) initHitWindow()

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
  win.webContents.on('zoom-changed', () => {
    // Ctrl+滚轮/缩放会把透明窗的 CSS 视口撑到比窗口还大，命中窗和模型都会错位。
    try { win.webContents.setZoomFactor(1) } catch (e) {}
  })
  win.webContents.on('did-finish-load', () => {
    failCount = 0
    try { win.webContents.setZoomFactor(1) } catch (e) {}
    // 页面刷新/崩溃恢复后模态状态已经没了；别让 modalMode 卡住，否则命中窗永远不会回来。
    if (dualWindow) {
      modalMode = false
      if (uiMode) leaveUiMode(true)
      queryHitBounds()
    }
    // 页面刷新后主进程的 pin 状态必须复位：否则 pinHold 会永久挂着，她再也不冒气泡
    if (tools) tools.resetPin()
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
    if (dualWindow) updateHitWindowBounds()
    const now = Date.now()
    if (now - (globalThis.__lastSaveAt || 0) > 400) {
      globalThis.__lastSaveAt = now
      // 铺满主屏时窗口位置恒等于工作区，写盘没有意义，且会污染非铺满模式的位置记忆
      if (!readFullscreenPrimary()) savePos()
    }
  })
  win.on('move', () => { if (dualWindow) updateHitWindowBounds() })
  win.on('resize', () => {
    // ⚠️ 拖动 setPosition 也可能触发 resize；这里只修尺寸，绝不把位置拽回 (0,0)。
    if (readFullscreenPrimary()) applyFullscreenPrimaryBounds(false)
    else if (dualWindow) updateHitWindowBounds()
  })
  win.on('hide', () => { if (dualWindow) syncHitWindow() })
  win.on('show', () => {
    raiseTopmost()
    if (dualWindow) setTimeout(syncHitWindow, 60)
  })
  win.on('closed', () => {
    destroyHitWindow()
    win = null
  })

  // 拖动：页面里按下她 → 交给主进程搬窗口（拖动期间用 16ms 快速轮询，跟手）
  ipcMain.on('drag-start', async (_e, at) => {
    // 双窗口下身体拖动由 hit 窗口接管；渲染窗收到的是注入事件（screenX=0），不能信。
    if (dualWindow) return
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
    startWindowDrag(at)
  })
  ipcMain.on('drag-end', () => stopWindowDrag())
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
      // 详细面板是模态：页面直接通知，别等 90ms 轮询（鼠标可能不在窗口里）
      // 输入法：候选窗是独立顶层窗口，会被 screen-saver 级别的透明窗盖住。
      // 打字时先把置顶降下来（窗口本身仍是活动窗，所以不会跑到别的窗口后面），
      // 失焦/关面板再抬回去；2 秒 watchdog 在 imeHolding 期间跳过。
      case 'ime:on':
        imeHolding = true
        bootLog('输入法：降下置顶（让候选窗可见）')
        try {
          if (win && !win.isDestroyed()) win.setAlwaysOnTop(false)
        } catch (e) {}
        // 命中窗也一起处理：降级 + 隐藏（搜狗这类输入法的候选窗会被它挡住）
        if (dualEnabled()) {
          try {
            hitWin.setAlwaysOnTop(false)
            sendHitVisibility(false)
            if (hitWin.isVisible()) hitWin.hide()
          } catch (e) {}
        }
        clearTimeout(imeHoldTimer)
        imeHoldTimer = setTimeout(() => {
          // 兜底：页面崩了没发 ime:off，也别让她永远沉底
          imeHolding = false
          raiseTopmost(false)
          syncHitWindow()
        }, 120000)
        break
      case 'ime:off':
        imeHolding = false
        clearTimeout(imeHoldTimer)
        raiseTopmost(false)
        syncHitWindow()
        bootLog('输入法：恢复置顶')
        break
      case 'modal:on':
        modalMode = true
        if (dualWindow) enterUiMode()
        break
      case 'modal:off':
        modalMode = false
        if (dualWindow) leaveUiMode(true)
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
      if (!win || win.isDestroyed() || !win.isVisible() || dragTimer || pageDragging) return
      const p = screen.getCursorScreenPoint()
      // 与 macOS 同理：原来 60ms + 3px 死区会让视线目标「跳着给」，看着卡
      if (lastCursor && Math.abs(lastCursor.x - p.x) < 1 && Math.abs(lastCursor.y - p.y) < 1) return
      lastCursor = p
      // 直接用窗口内容坐标，别把“整个显示器”压缩映射到窗口 ——
      // 那会把 y 按 1067→1020 压扁，视线对不准鼠标，和命中窗注入的精确坐标打架就抽。
      const b = win.getContentBounds()
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(p.x - b.x),
        y: Math.round(p.y - b.y),
      })
    } catch (e) {}
  }, 16)
  pollTimer = setInterval(poll, 90)
  // 2 秒一次的安全网：窗口被系统/Aero Snap 放大到比屏幕还大时复位；
  // 顺便把 render/hit 两个窗口重新抬到 topmost，避免任务栏插在它们中间。
  topmostTimer = setInterval(() => {
    if (shotOpenNow()) return // 遮罩期间别复位/别抬顶，否则遮罩会被盖住
    if (!win || win.isDestroyed() || !win.isVisible()) return
    try {
      if (readFullscreenPrimary()) {
        const d = screen.getPrimaryDisplay()
        const b = win.getBounds()
        const maxW = Math.min(d.workArea.width, d.bounds.width)
        const maxH = Math.min(d.workArea.height, d.bounds.height)
        if (b.width > maxW + 20 || b.height > maxH + 20) applyFullscreenPrimaryBounds(true)
        // 窗口压到任务栏/工作区外：先把 topmost 摘掉再挂回去，才能重新压过任务栏。
        const overWork = (
          b.x < d.workArea.x || b.y < d.workArea.y ||
          b.x + b.width > d.workArea.x + d.workArea.width ||
          b.y + b.height > d.workArea.y + d.workArea.height
        )
        raiseTopmost(overWork)
      } else {
        raiseTopmost(false)
      }
    } catch (e) {}
  }, 2000)
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

/**
 * 铺满主屏模式：显示器分辨率/缩放/ HDR 变化后，窗口不会自动跟着变。
 * 不处理的话会出现「窗口还是旧尺寸、比工作区大、她被挤到屏幕外」。
 */
let fullscreenBoundsGuard = false
function applyFullscreenPrimaryBounds(resetPosition) {
  if (fullscreenBoundsGuard) return
  if (!win || win.isDestroyed() || !readFullscreenPrimary()) return
  try {
    const d = screen.getPrimaryDisplay()
    const wa = d.workArea
    const db = d.bounds
    // 有些 DPI/显示器切换的瞬间 workArea 会给出比 bounds 还大的值；
    // 绝不把窗口设成比屏幕还大，否则她会跑到屏幕外、命中窗也一起跑。
    const w = Math.max(200, Math.min(wa.width, db.width))
    const h = Math.max(200, Math.min(wa.height, db.height))
    const x = wa.x
    const y = wa.y
    const b = win.getBounds()
    const sizeWrong = b.width !== w || b.height !== h
    // resetPosition 只在显示器指标变化/尺寸异常 watchdog 时为 true。
    // resize 事件（拖动也可能触发）必须保留当前位置，否则窗口会在鼠标和原点之间来回弹。
    const posWrong = !!resetPosition && (b.x !== x || b.y !== y)
    if (sizeWrong || posWrong) {
      fullscreenBoundsGuard = true
      win.setBounds({
        x: posWrong ? x : b.x,
        y: posWrong ? y : b.y,
        width: w,
        height: h,
      })
      fullscreenBoundsGuard = false
      bootLog('铺满主屏：窗口复位（sizeWrong=' + sizeWrong + ', posWrong=' + posWrong + ' → ' + w + '×' + h + '）')
    }
    if (dualWindow) {
      updateHitWindowBounds()
      queryHitBounds()
    }
  } catch (e) {
    fullscreenBoundsGuard = false
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
  bootLog('收起成小球（page hidden）')
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
  if (dualWindow) syncHitWindow()
  ballDrag = [ballWin.getPosition()[0], ballWin.getPosition()[1]]
  setTimeout(snapBall, 30)
}

function expand() {
  if (!collapsed) return
  bootLog('展开（page shown）')
  collapsed = false
  if (ballWin) {
    ballDrag = null
    ballWin.hide()
  }
  if (win) {
    win.showInactive()
    win.setAlwaysOnTop(true, 'screen-saver')
    win.webContents.executeJavaScript('window.DSHPet && DSHPet.setHidden && DSHPet.setHidden(false)').catch(() => {})
    if (dualWindow) setTimeout(syncHitWindow, 300)
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
    if (dualWindow) syncHitWindow()
    bootLog('托盘：隐藏桌宠')
  } else {
    win.showInactive()
    win.setAlwaysOnTop(true, 'screen-saver')
    win.webContents.executeJavaScript('window.DSHPet && DSHPet.setHidden && DSHPet.setHidden(false)').catch(() => {})
    if (dualWindow) setTimeout(syncHitWindow, 300)
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
    // 心跳放在窗口之后：它要知道「她是不是被收起来了」。
    // 任何异常都不能影响主窗口 —— 这个功能是附加的，坏了也只是没有心跳。
    // 故意在 try 里 require：万一 heart/ 没打进 asar（打包漏了、平台不支持），
    // 也只是「没有心跳」，不能把主窗口一起搞死。
    try {
      const { createHeart } = require('./heart')
      const { patchHeart, sanitizeHeartPatch, redactForLog } = require('./heart/settings')
      const { createModelServer } = require('./heart/server')
      const promptModule = require('./heart/prompt')
      const vision = require('./heart/vision')
      const { CHAT_SYSTEM, createChatMemory } = require('./heart/chat')
      const { createMemo } = require('./heart/memo')
      const { normalize: normalizeHeart } = require('./heart/config')
      modelServer = createModelServer({ log: bootLog })
      // 对话历史按 token 预算裁（默认 16K ≈ 30~40 轮短对话），不再固定 12 轮
      const heartCfg0 = normalizeHeart((readSettings() || {}).heart)
      chatMemory = createChatMemory({
        file: path.join(app.getPath('userData'), 'heart', 'chat.json'),
        maxTokens: heartCfg0.chatMaxTokens,
        minTurns: 6,
      })
      // 她主动搭话的短期记忆（12 条）：重启后不重复自己说过的话
      const heartMemo = createMemo({ file: path.join(app.getPath('userData'), 'heart', 'memo.json'), max: 12 })
      heartSettingsPayload = () => {
        const cfg = heart ? heart.config() : null
        const pub = cfg
          ? {
              enabled: cfg.enabled,
              intervalSec: cfg.intervalSec,
              lookMinGapSec: cfg.lookMinGapSec,
              sayMinGapSec: cfg.sayMinGapSec,
              maxLooksPerHour: cfg.maxLooksPerHour,
              maxSaysPerHour: cfg.maxSaysPerHour,
              lookOpener: cfg.lookOpener,
              mode: cfg.mode,
              audioTrigger: cfg.audioTrigger,
              prompt: cfg.prompt,
              model: {
                provider: cfg.model.provider,
                port: cfg.model.port,
                baseUrl: cfg.model.baseUrl,
                model: cfg.model.model,
                apiKeySet: !!cfg.model.apiKey,
              },
              modelServer: cfg.modelServer,
              // 刷视频：面板要显示「视频口味」和抽帧数
              bili: {
                enabled: cfg.bili.enabled,
                source: cfg.bili.source,
                keywords: cfg.bili.keywords,
                maxFrames: cfg.bili.maxFrames,
                cooldownSec: cfg.bili.cooldownSec,
              },
              // 做梦：配置存 settings.json 的 heart.dream，但由「做梦」页签渲染
              dream: {
                enabled: cfg.dream.enabled,
                cooldownSec: cfg.dream.cooldownSec,
                dir: cfg.dream.dir,
              },
              // 功能面板（划词翻译 / 识图）：apiKey 绝不回传页面，只给布尔
              tools: {
                translate: {
                  enabled: cfg.tools.translate.enabled,
                  engine: cfg.tools.translate.engine,
                  to: cfg.tools.translate.to,
                  maxChars: cfg.tools.translate.maxChars,
                  dragPx: cfg.tools.translate.dragPx,
                  restoreClipboard: cfg.tools.translate.restoreClipboard,
                  skipApps: cfg.tools.translate.skipApps,
                  api: {
                    baseUrl: cfg.tools.translate.api.baseUrl,
                    model: cfg.tools.translate.api.model,
                    apiKeySet: !!cfg.tools.translate.api.apiKey,
                  },
                },
                vision: {
                  enabled: cfg.tools.vision.enabled,
                  minSize: cfg.tools.vision.minSize,
                  maxTokens: cfg.tools.vision.maxTokens,
                  prompt: cfg.tools.vision.prompt,
                },
              },
            }
          : null
        return {
          ok: true,
          config: pub,
          status: heart ? heart.status() : null,
          dreamStatus: heart ? heart.dreamStatus() : null,
          model: modelServer ? modelServer.status() : null,
          defaultPrompt: promptModule.SYSTEM,
        }
      }
      heart = createHeart({
        log: bootLog,
        readSettings,
        memo: heartMemo,
        getWindow: () => win,
        getMaskRects: petMaskRects,
        getAgentState: petAgentState,
        // 看屏幕前的开场白：直接推一条气泡（2.6s 后自然消失，随后的正式台词会覆盖它）
        onOpener: (line) => {
          if (!petServer) return
          try {
            petServer.push({ t: 'control', say: line, bubbleMs: 2600 })
            bootLog('心跳：探头「' + line + '」')
          } catch (e) {}
        },
        // 读图期间的静默开关：采集开始 → 模型出结果，这期间页面的新气泡只排队不显示。
        // 用同一条 control 通道，不新增协议。
        onSeal: (on) => {
          if (!petServer) return
          try {
            petServer.push({ t: 'control', seal: !!on })
          } catch (e) {}
        },
        // 动作出口：推一条 control 到页面（和 /dsh-pet/control 同一条通道、同一套字段）。
        // 不经过 DSH —— 所以 DSH 关着她也能有心跳。
        onAction: (control, action, meta) => {
          if (!petServer) {
            bootLog('心跳：本地服务还没起，动作丢弃')
            return
          }
          try {
            petServer.push(control)
            // 2026-10-19：心跳台词不再写进 chat.json（会挤满对话预算，模型还会接着
            // 自己的独白说「那就好」→「快把白饭端来」）。改由 heart:chat 在请求时
            // 把最近一条拼进 system 当旁白。
            bootLog(
              '心跳 → 页面：' + JSON.stringify({ say: control.say || '', mood: control.mood || '', motion: control.motion || '',
                face: control.expression || '', model: meta && meta.model, ms: meta && meta.ms }),
            )
          } catch (e) {
            bootLog('心跳：推动作失败 ' + ((e && e.message) || e))
          }
        },
        // 刷视频（2026-10-20）：记忆文件放在 userData，和心跳的 memo.json 同级
        biliMemoFile: path.join(app.getPath('userData'), 'bili-memo.json'),
        // 做梦（2026-10-21）：日记默认目录 + 水位线文件；回应模式对话给做梦当素材
        dreamDir: path.join(app.getPath('userData'), '肥鱼日记'),
        dreamStateFile: path.join(app.getPath('userData'), 'dream-state.json'),
        getChat: () => (chatMemory ? chatMemory.messages() : []),
        // 做梦开始/结束 → 页面据此静默拒绝「刷视频 / 看一眼 / 回应模式」
        onDreamState: (on) => {
          if (!petServer) return
          try {
            petServer.push({ t: 'control', dreaming: !!on })
            bootLog('做梦：' + (on ? '开始（本轮要发一次请求）' : '结束'))
          } catch (e) {}
        },
        // 进度（list/pick/detail/frames/watch）——页面可以拿它显示「正在看…」
        onBiliStage: (stage, info) => {
          if (!petServer) return
          try {
            petServer.push({ t: 'control', biliStage: String(stage || ''), biliInfo: info || null })
          } catch (e) {}
        },
        // 详情落进「邮件」面板。silent：正文很长，别再多冒一条气泡盖掉台词。
        onReport: (r) => {
          if (!petServer) return
          try {
            petServer.push({
              t: 'control',
              report: {
                title: r.title, body: r.body, bv: r.bv, url: r.url,
                up: r.up, worth: r.worth, at: r.at, silent: true,
              },
            })
            bootLog('刷视频 → 邮件：《' + r.title + '》 ' + r.bv)
          } catch (e) {}
        },
      })
      heart.start()
      ipcMain.handle('heart:status', () => {
        if (!heart) return { enabled: false, lastReason: 'no-heart' }
        // diag：P0 用来核对「窗口坐标 / 屏幕坐标 / 截图坐标」三套单位。
        // 截图遮罩要按这三个数换算，留在这里排查 DPI/多屏问题最省事。
        let diag = null
        try {
          const d = screen.getPrimaryDisplay()
          diag = {
            content: win && !win.isDestroyed() ? win.getContentBounds() : null,
            bounds: win && !win.isDestroyed() ? win.getBounds() : null,
            display: d.size,
            displayBounds: d.bounds,
            scaleFactor: d.scaleFactor,
          }
        } catch (e) {}
        return Object.assign(heart.status(), { diag })
      })
      ipcMain.handle('heart:capture', (_e, opts) => {
        if (!heart) return { ok: false, reason: 'no-heart' }
        return heart.captureNow(Object.assign({ manual: true }, opts || {}))
      })
      // 调试口：跑一遍完整链路（拍 → 模型 → 仲裁 → 页面）。
      // 默认配置是关闭的，所以 CDP 测试用 {enable:true} 临时打开，不改 settings.json。
      ipcMain.handle('heart:tick', (_e, opts) => {
        if (!heart) return { ok: false, reason: 'no-heart' }
        return heart.tickNow(opts || {})
      })
      ipcMain.handle('heart:providers', () => (heart ? heart.providers() : []))
      // 「刷一条视频」（2026-10-20）：点按钮才跑，冷却与互斥都在 heart 里判。
      // 返回值只告诉页面成败；气泡和邮件由 onAction / onReport 推 control。
      ipcMain.handle('bili:look', async () => {
        if (!heart) return { ok: false, reason: 'no-heart' }
        try {
          return await heart.biliLook()
        } catch (e) {
          bootLog('刷视频：异常 ' + ((e && e.stack) || e))
          return { ok: false, reason: String((e && e.message) || e) }
        }
      })
      ipcMain.handle('bili:status', () => (heart ? heart.biliStatus() : { ok: false, reason: 'no-heart' }))
      /* —— 做梦（2026-10-21）——
       * 页面只负责「她睡了 / 醒了」和「下次睡着立即做梦」这三件事；
       * 素材收集、模型请求、写日记全在主进程（baseUrl/apiKey 不进页面）。
       * 注意 dreamSleep 是**不 await** 的长任务：睡着那一刻就返回，写完/失败只写日志。
       */
      ipcMain.handle('dream:note', (_e, req) => {
        if (!heart) return { ok: false, reason: 'no-heart' }
        const kind = String((req && req.kind) || '')
        const at = Number(req && req.at) > 0 ? Number(req.at) : Date.now()
        if (kind === 'wake') {
          heart.dreamWake(at)
          return { ok: true, kind, at }
        }
        if (kind === 'sleep') {
          heart.dreamSleep(at)
          return { ok: true, kind, at }
        }
        return { ok: false, reason: 'bad-kind' }
      })
      ipcMain.handle('dream:status', () => (heart ? heart.dreamStatus() : { ok: false, reason: 'no-heart' }))
      // 一次性绕过冷却（不是配置项，不写 settings.json）
      ipcMain.handle('dream:force', (_e, req) => {
        if (!heart) return { ok: false, reason: 'no-heart' }
        heart.dreamForceNext(!!(req && req.on))
        return heart.dreamStatus()
      })
      ipcMain.handle('dream:open-dir', async () => {
        if (!heart) return { ok: false, reason: 'no-heart' }
        const st = heart.dreamStatus()
        const dir = String((st && st.dir) || '')
        if (!dir) return { ok: false, reason: 'no-dir' }
        try {
          fs.mkdirSync(dir, { recursive: true })
          const err = await shell.openPath(dir)
          if (err) return { ok: false, reason: err }
          return { ok: true, dir }
        } catch (e) {
          return { ok: false, reason: String((e && e.message) || e) }
        }
      })
      // 调试口（不进面板）：不管冷却立刻做一次梦
      ipcMain.handle('dream:now', async () => {
        if (!heart) return { ok: false, reason: 'no-heart' }
        try {
          return await heart.dreamTest()
        } catch (e) {
          return { ok: false, reason: String((e && e.message) || e) }
        }
      })
      // 「扫描本地端点」按钮：只在这里探测端口；心跳推理本身永远不自动发现
      ipcMain.handle('heart:scan', () => (heart ? heart.scan() : { ok: false, results: [] }))
      // 「确认 API 连接」：真发一条 ping（也能让 llama-swap 把模型加载起来）
      ipcMain.handle('heart:test', () => (heart ? heart.probe() : { ok: false, error: 'no-heart' }))
      // 「回应模式」：对话按钮直接问聊天模型（不走 DSH），带最近 12 轮记忆
      ipcMain.handle('heart:chat', async (_e, req) => {
        if (!heart || !chatMemory) return { ok: false, reason: 'no-heart' }
        // 做梦期间独占模型：静默拒绝（页面据此冒「等一下……本鲸才刚睡醒呢……」）
        if (heart.dreaming()) return { ok: false, reason: 'dreaming' }
        const text = String((req && req.text) || '').trim().slice(0, 1000)
        if (!text) return { ok: false, reason: 'empty' }
        const cfg = heart.config()
        // 心跳台词不写进对话历史，但「接着刚才那句」的能力要保留。
        // ⚠️ 旁白必须放在**最后一条 user 的末尾**，绝不能拼进 system：
        //    前缀缓存是从头匹配的，system 一变整个前缀就废（实测 cache=0）。
        //    放在 user 末尾时，system + 历史 + 这条 user 的前半段仍能命中。
        //    历史里存的仍是原始 text（不带旁白），所以下次请求到 text 结尾的前缀一致。
        const note = heartMemo ? heartMemo.last() : null
        let sideNote = ''
        if (note && note.say && note.at && Date.now() - note.at < 30 * 60 * 1000) {
          sideNote = '\n\n（你刚才自己嘀咕过：「' + note.say.slice(0, 60) + '」。如果和主人现在说的无关，就忽略它，不要硬接。）'
        }
        const messages = [{ role: 'system', content: CHAT_SYSTEM }].concat(chatMemory.messages(), [
          { role: 'user', content: text + sideNote },
        ])
        // 聊天期间让心跳让路：llama-server 只有 -np 1 一个槽位，抢起来会「想好久」
        heart.hold()
        let r = null
        try {
          r = await vision.infer(cfg, messages, {
            // 聊天只要 1~2 句：300 token 时 9B 会啰嗦到 10 秒以上，看起来像「卡住」
            maxTokens: 120,
            timeoutMs: cfg.model.timeoutMs,
            temperature: 0.7,
            enableThinking: cfg.model.enableThinking,
          })
        } finally {
          heart.release()
        }
        if (!r || !r.ok) return { ok: false, reason: (r && r.error) || 'no-response', candidates: (r && r.candidates) || 0 }
        chatMemory.add('user', text)
        chatMemory.add('assistant', r.text)
        bootLog('对话(回应模式)：' + text.slice(0, 40) + ' → ' + String(r.text).slice(0, 60))
        return { ok: true, text: r.text, ms: r.ms, candidate: r.candidate && r.candidate.model }
      })
      ipcMain.handle('heart:chat-clear', () => {
        if (chatMemory) chatMemory.clear()
        return { ok: true }
      })
      // —— 设置面板「心跳」页用 ——
      // 读：配置 + 运行状态 + 模型进程 + 默认提示词（面板要能「恢复默认」）
      ipcMain.handle('heart:settings', () => heartSettingsPayload())
      // 写：只接受白名单字段，合并进 settings.json 的 heart 段，然后按新配置重排定时器
      ipcMain.handle('heart:save', async (_e, patch) => {
        try {
          const clean = sanitizeHeartPatch(patch)
          patchHeart(settingsPath(), clean)
          if (heart) {
            heart.reload()
            heart.start()
          }
          // 注意：**不**在保存 baseUrl 时自动停本地模型。
          // 有人同时用云端 API + 本地模型（llama-swap 自己会换模型），自动停会打断那边。
          // ⚠️ 必须脱敏：clean 里有 model.apiKey / tools.translate.api.apiKey，
          // 原样 dump 等于在 boot.log 里留一份明文副本（2026-10-22 修的）。
          bootLog('心跳：设置已保存 ' + JSON.stringify(redactForLog(clean)))
          // 划词翻译的开关也在 settings.json 的 heart 段里 → 保存后让 tools 重新对齐
          if (tools) tools.sync()
          return heartSettingsPayload()
        } catch (e) {
          return { ok: false, reason: String((e && e.message) || e), config: null }
        }
      })
      // 模型进程：start/stop/status
      ipcMain.handle('heart:model', async (_e, req) => {
        if (!modelServer || !heart) return { ok: false, reason: 'no-heart' }
        const action = (req && req.action) || 'status'
        if (action === 'start') {
          // 自定义 API 优先：配置了地址就不允许再起本地模型（否则又是「API 在跑、9B 也在占显存」）
          const cfg = heart.config()
          if (cfg.model.baseUrl) {
            return { ok: false, reason: '已启用自定义 API（' + cfg.model.baseUrl + '），不会再启动本地模型；要用本地请先清空 API 地址' }
          }
          return modelServer.start(cfg)
        }
        if (action === 'stop') return modelServer.stop()
        return { ok: true, model: modelServer.status() }
      })
      // 调试口：不经过模型/仲裁，直接推一条 control 到页面。
      // 用途：CDP 验「心跳 → 页面」这条通道（以及气泡/动作渲染）而不依赖模型和 DSH。
      ipcMain.handle('heart:act', (_e, payload) => {
        if (!petServer) return { ok: false, reason: 'no-server' }
        const control = Object.assign({ t: 'control' }, payload || {})
        try {
          petServer.push(control)
          return { ok: true, sent: control }
        } catch (e) {
          return { ok: false, reason: String((e && e.message) || e) }
        }
      })
    } catch (e) {
      bootLog('心跳初始化失败（不影响桌宠）: ' + ((e && e.stack) || e))
    }
    // —— 功能面板（划词翻译 / 识图）——
    // 刻意放在心跳的 try 块**外面**：识图只依赖 desktopCapturer，不依赖 heart；
    // heart 挂了（模块没打进 asar / 语法错）功能面板也该能用。
    try {
      const { createTools } = require('./tools')
      nativeKeys.setLog(bootLog)
      tools = createTools({
        log: bootLog,
        getHeart: () => heart,
        // 划词用：光标的落点是不是压在我们真正的 UI 上（复用 90ms 轮询的判定结果）。
        // ⚠️ 不能用 win.getBounds() 代替 —— fullscreenPrimary=true 时它铺满全屏，
        //    「在窗内」恒为真，划词会整条哑火（2026-10-22 真踩）。
        isOverOwnUi: () => lastHit === 'panel',
        // 拖她/点她不该被当成"选了字" —— 否则每拖一下都会往前台应用发一次 Ctrl+C
        isOverPet: () => lastHit === 'model',
        push: (obj) => {
          if (petServer) petServer.push(obj)
        },
        getCfg: () => {
          if (heart) return heart.config()
          // heart 没起（极少见）：用同一套纯函数归一化 settings.json 里的 heart 段，
          // 这样功能面板至少能读到开关，而不是全空
          try {
            const { normalize } = require('./heart/config')
            const all = readSettings() || {}
            return normalize(all.heart)
          } catch (e) {
            return null
          }
        },
      })
      tools.sync()
    } catch (e) {
      bootLog('功能面板初始化失败（不影响桌宠）: ' + ((e && e.stack) || e))
    }
    screen.on('display-metrics-changed', () => applyFullscreenPrimaryBounds(true))
    screen.on('display-added', () => applyFullscreenPrimaryBounds(true))
    screen.on('display-removed', () => applyFullscreenPrimaryBounds(true))
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
  clearInterval(topmostTimer)
  clearInterval(dragTimer)
  destroyHitWindow()
  if (tools) tools.destroy()
  if (heart) heart.stop()
  if (modelServer) modelServer.stop()
  if (audioMeter) audioMeter.stop()
  if (petServer) {
    bootLog('退出：关掉本地服务')
    petServer.close().catch(() => {})
    petServer = null
  }
})
