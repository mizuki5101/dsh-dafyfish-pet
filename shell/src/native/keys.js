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

// ————————————————————————————————————————————————————————————
// 蓝牙外设电量（2026-10-24）—— setupapi.dll，只读，无副作用
//
// 为什么放在这个文件里：`resolveKoffi()` 是全项目唯一的 koffi 解析（注释见文件头），
// 另起一个模块就要复制一遍加载顺序，出问题两处对不上。所以 SetupAPI 也搭在这里，
// 但**独立懒加载**：setupapi 挂了不能连累键鼠那条链（initialize 里 catch 住）。
//
// 读的是 DEVPKEY_Bluetooth_Battery = {104EA319-6EE2-4701-BD47-8DDBF425BBE5}, 2。
// 它只挂在 **HFP(AudioGateway) devnode** 上，设备主节点上没有，注册表里也没有
// （= 驱动按需算的，读一次很便宜）。判据/说明见 tools/battery-core.js 文件头。
// ————————————————————————————————————————————————————————————
const DEVPKEY_BT_BATTERY = { fmtid: '104ea319-6ee2-4701-bd47-8ddbf425bbe5', pid: 2 }
/**
 * 电量**时间戳**（同一个 fmtid 的 pid 7）—— 「这个百分比是什么时候收到的」。
 *
 * ⚠️ 2026-10-24 修正：上午我以为它是 `DEVPKEY_Bluetooth_LastConnectedTime`，**错了**。
 * 实测同一台设备上两者是两个不同的属性（M114：pid7 = 2026-09-26，LastConnectedTime = 2025-10-09），
 * 而且 HFP 节点上**根本没有** LastConnectedTime（只有 DEV_ 主节点有）。
 * 这个结论在 FerrisPulse 的 `BluetoothDeviceHelper.cs` 里也写着（它叫 BatteryTimestamp），
 * 两边对上了：pid 7 = 电量时间戳。
 * 用途：同一台设备会有多个节点都报电量（BLE GATT / HFP / 主节点），
 * **取时间戳最新的那条**，就能避免"旧 HFP 节点的值卡住不动"。
 */
const DEVPKEY_BT_BATTERY_TS = { fmtid: '104ea319-6ee2-4701-bd47-8ddbf425bbe5', pid: 7 }
/**
 * 设备当前是否连着（bool）。⚠️ 只在主节点 `BTHENUM\DEV_<mac>` 上准 ——
 * 各个服务节点（HFP/A2DP/AVRCP）上读到的恒为 False，拿它判连接会永远判成"没连"。
 * 所以下游按 MAC 聚合：**只要同一台设备的任一节点报 true 就算连着**。
 */
const DEVPKEY_DEVICE_ISCONNECTED = { fmtid: '83da6326-97a6-4088-9453-a1923f573b29', pid: 15 }
const DEVPKEY_DEVICE_FRIENDLYNAME = { fmtid: 'a45c254e-df1c-4efd-8020-67d146a850e0', pid: 14 }
const DEVPKEY_DEVICE_DEVNODESTATUS = { fmtid: '4340a6c5-93fa-4706-972c-7b648008a5a7', pid: 2 }
const DIGCF_PRESENT = 0x00000002
const DIGCF_ALLCLASSES = 0x00000004
/** DN_STARTED：设备已启动（= 蓝牙链路现在是活的） */
const DN_STARTED = 0x00000008

// —— 逼耳机重新上报电量（2026-10-24 实测可行）——
// 关掉再打开 HFP 服务 = 让这条链路重新握手，耳机通常会在 SLC 建立时把电量再报一次。
// 实测：EDIFIER MT6 Pro 的电量时间戳从 10:48:33 跳到当前时刻，值也随之刷新。
// 副作用：HFP 是「通话/麦克风」那条链路，会断 1~2 秒；A2DP（听歌）不受影响。
// ⚠️ 只需 0x111E（Handsfree，耳机侧 SLC）。0x111F（Audio Gateway）实测返回 1060
//    ERROR_SERVICE_DOES_NOT_EXIST，别用它。
const HFP_HF_SERVICE = '0000111e-0000-1000-8000-00805f9b34fb'
const BLUETOOTH_SERVICE_DISABLE = 0x00
const BLUETOOTH_SERVICE_ENABLE = 0x01
/** BLUETOOTH_DEVICE_SEARCH_PARAMS 大小（x64：4 + 5*4 + 1 + pad3 + 8 = 40） */
const BT_SEARCH_SIZE = 40
/** BLUETOOTH_DEVICE_INFO 大小（x64：4+pad4+ADDR8+COD4+3*BOOL12+2*SYSTEMTIME32+WCHAR[248]496 = 560） */
const BT_DEVINFO_SIZE = 560
const BT_OFF_ADDR = 8
const BT_OFF_CONNECTED = 20
const BT_OFF_NAME = 64

let btApi = null
let btTried = false
let btReason = ''

/** 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' (+可选 pid) → DEVPROPKEY / GUID 的原始字节 */
function devPropKey(fmtid, pid) {
  const hex = String(fmtid).replace(/[{}\s-]/g, '')
  if (hex.length !== 32) throw new Error('bad guid: ' + fmtid)
  const hasPid = pid !== undefined
  const buf = Buffer.alloc(hasPid ? 20 : 16)
  buf.writeUInt32LE(parseInt(hex.slice(0, 8), 16), 0)
  buf.writeUInt16LE(parseInt(hex.slice(8, 12), 16), 4)
  buf.writeUInt16LE(parseInt(hex.slice(12, 16), 16), 6)
  for (let i = 0; i < 8; i++) buf.writeUInt8(parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16), 8 + i)
  if (hasPid) buf.writeUInt32LE(pid >>> 0, 16)
  return buf
}

/** 结构体大小：cbSize(4) + GUID(16) + DevInst(4) + Reserved(指针) → x64 上是 32 */
function devInfoDataSize(koffi) {
  return 24 + koffi.sizeof('void *')
}

function btInit() {
  if (btTried) return btApi
  btTried = true
  const a = init()
  if (!a) {
    btReason = initReason || 'no-native'
    return null
  }
  try {
    const sa = a.koffi.load('setupapi.dll')
    btApi = {
      koffi: a.koffi,
      getClassDevs: sa.func(
        'void *__stdcall SetupDiGetClassDevsW(void *ClassGuid, void *Enumerator, void *hwndParent, uint32 Flags)',
      ),
      enumDeviceInfo: sa.func('bool __stdcall SetupDiEnumDeviceInfo(void *set, uint32 index, void *devInfoData)'),
      getDeviceInstanceId: sa.func(
        'bool __stdcall SetupDiGetDeviceInstanceIdW(void *set, void *devInfoData, void *buf, uint32 size, void *required)',
      ),
      getDeviceProperty: sa.func(
        'bool __stdcall SetupDiGetDevicePropertyW(void *set, void *devInfoData, void *key, void *type, void *buf, uint32 size, void *required, uint32 flags)',
      ),
      destroyDeviceInfoList: sa.func('bool __stdcall SetupDiDestroyDeviceInfoList(void *set)'),
    }
    // bthprops 单独 try：它挂了只是"不能强制刷新"，读取那条路必须照常能用
    try {
      const bt = a.koffi.load('bthprops.cpl')
      btApi.findFirstRadio = bt.func('void *__stdcall BluetoothFindFirstRadio(void *params, void *radio)')
      btApi.findNextRadio = bt.func('bool __stdcall BluetoothFindNextRadio(void *hFind, void *radio)')
      btApi.findRadioClose = bt.func('bool __stdcall BluetoothFindRadioClose(void *hFind)')
      btApi.findFirstDevice = bt.func('void *__stdcall BluetoothFindFirstDevice(void *params, void *devInfo)')
      btApi.findNextDevice = bt.func('bool __stdcall BluetoothFindNextDevice(void *hFind, void *devInfo)')
      btApi.findDeviceClose = bt.func('bool __stdcall BluetoothFindDeviceClose(void *hFind)')
      btApi.setServiceState = bt.func(
        'uint32 __stdcall BluetoothSetServiceState(void *hRadio, void *devInfo, void *guid, uint32 flags)',
      )
    } catch (e) {
      report('加载 bthprops 失败（只能读、不能强制刷新）：' + (e && e.message))
    }
    return btApi
  } catch (e) {
    btReason = 'setupapi-failed'
    report('加载 setupapi 失败：' + (e && e.message))
    btApi = null
    return null
  }
}

/** 读一条设备属性 → { type, size, data:Buffer } / null（属性不存在、类型不对都返回 null） */
function readDeviceProp(api, set, info, keyBuf) {
  const typeBuf = Buffer.alloc(4)
  const reqBuf = Buffer.alloc(4)
  const valBuf = Buffer.alloc(512)
  let ok = false
  try {
    ok = api.getDeviceProperty(set, info, keyBuf, typeBuf, valBuf, valBuf.length, reqBuf, 0)
  } catch (e) {
    return null
  }
  if (!ok) return null
  const size = reqBuf.readUInt32LE(0)
  if (!size || size > valBuf.length) return null
  return { type: typeBuf.readUInt32LE(0), size, data: valBuf }
}

/**
 * 枚举**在场**的蓝牙设备，拿到每个 devnode 的 instance / 友好名 / DevNodeStatus / 电量原始值。
 * 返回行数组，形状见 tools/battery-core.js 的 pickDevices()。任何一步失败返回 []（不抛）。
 */
function btRawDevices() {
  const api = btInit()
  if (!api) return []
  const koffi = api.koffi
  const out = []
  let set = null
  try {
    // ⚠️ 必须按**枚举器**枚举，不能按「Bluetooth 设备类」枚举（2026-10-24 实测）：
    //    HFP 节点的 PnP 类是 MEDIA、JL_SPP 是 PORTS，用 GUID_DEVCLASS_BLUETOOTH
    //    一个都拿不到（表现是 rows=10、个个数都没有 battery，看着像"设备不支持"）。
    //    按 BTHENUM 枚举器拿到的才是这块无线电下面**所有**蓝牙服务节点。
    const enumName = Buffer.from('BTHENUM\u0000', 'utf16le')
    set = api.getClassDevs(null, enumName, null, DIGCF_PRESENT | DIGCF_ALLCLASSES)
    // ⚠️ HDEVINFO 是**不透明句柄**：x64 上实测是个很大的数（约 2.3e12），
    //    不能拿 0xFFFFFFFF 当"无效"判据（第一次就是这么写成 rows=0 的）。
    //    无效只有两种形态：NULL(0) 和 INVALID_HANDLE_VALUE(-1，按无符号看是 1.8e19)。
    const hv = toAddr(koffi, set)
    if (!hv || hv < 0 || hv > 1e19) return []
    const sz = devInfoDataSize(koffi)
    const keyName = devPropKey(DEVPKEY_DEVICE_FRIENDLYNAME.fmtid, DEVPKEY_DEVICE_FRIENDLYNAME.pid)
    const keyStatus = devPropKey(DEVPKEY_DEVICE_DEVNODESTATUS.fmtid, DEVPKEY_DEVICE_DEVNODESTATUS.pid)
    const keyBatt = devPropKey(DEVPKEY_BT_BATTERY.fmtid, DEVPKEY_BT_BATTERY.pid)
    const keyTs = devPropKey(DEVPKEY_BT_BATTERY_TS.fmtid, DEVPKEY_BT_BATTERY_TS.pid)
    const keyConn = devPropKey(DEVPKEY_DEVICE_ISCONNECTED.fmtid, DEVPKEY_DEVICE_ISCONNECTED.pid)
    for (let i = 0; i < 256; i++) {
      const info = Buffer.alloc(sz)
      info.writeUInt32LE(sz, 0)
      if (!api.enumDeviceInfo(set, i, info)) break
      const idBuf = Buffer.alloc(1024)
      const reqBuf = Buffer.alloc(4)
      if (!api.getDeviceInstanceId(set, info, idBuf, 512, reqBuf)) continue
      // ⚠️ 不能用 indexOf(0) 找结尾：UTF-16LE 里每个 ASCII 字符的高字节就是 0x00，
      //    第一个 0 出现在下标 1，字符串会被截成空（第一次就踩了这个，rows=0 但不报错）。
      //    RequiredSize 是**字符数**，直接按它取。
      const idChars = Math.min(reqBuf.readUInt32LE(0), 512)
      const instance = idBuf
        .toString('utf16le', 0, idChars * 2)
        .replace(/\u0000[\s\S]*$/, '')
      if (!instance) continue
      const nameProp = readDeviceProp(api, set, info, keyName)
      const statusProp = readDeviceProp(api, set, info, keyStatus)
      const battProp = readDeviceProp(api, set, info, keyBatt)
      const tsProp = readDeviceProp(api, set, info, keyTs)
      const connProp = readDeviceProp(api, set, info, keyConn)
      out.push({
        instance,
        name:
          nameProp && Number(nameProp.type) === 0x12
            ? String(nameProp.data.toString('utf16le', 0, nameProp.size)).replace(/\u0000[\s\S]*$/, '')
            : '',
        devStatus: statusProp ? Number(statusProp.data.readUInt32LE(0)) : 0,
        battery: battProp ? { type: battProp.type, size: battProp.size, data: battProp.data } : null,
        batteryTs: tsProp ? { type: tsProp.type, size: tsProp.size, data: tsProp.data } : null,
        // 原始属性交给 battery-core 解码（这一层不依赖 tools/，保持只有 koffi）
        isConnected: connProp ? { type: connProp.type, size: connProp.size, data: connProp.data } : null,
      })
    }
    return out
  } catch (e) {
    report('枚举蓝牙设备失败：' + (e && e.message))
    return []
  } finally {
    try {
      if (set) api.destroyDeviceInfoList(set)
    } catch (e) {}
  }
}

function btAvailable() {
  return !!btInit()
}

/**
 * 逼蓝牙耳机把电量重新报一次。
 *
 * 做法：对 **HFP 服务** 先 disable 再 enable，让这条链路重新握手；耳机一般会在
 * SLC 建立时再报一次 `+CIEV: battchg`，Windows 的属性（值和 pid 7 时间戳）随之刷新。
 * 实测 EDIFIER MT6 Pro：时间戳从 10:48:33 跳到当前时刻。
 *
 * ⚠️ 副作用：HFP = 通话/麦克风那条链路，**会断 1~2 秒**；听歌（A2DP）不受影响。
 *    调用方必须把这件事告诉用户，别在后台偷偷调。
 * ⚠️ 只对**已连接**的设备做：对断连设备调 enable 会把耳机叫起来，不是我们想要的。
 *
 * @param {{nameHint?:string}} opts
 * @returns {{ok:boolean, reason?:string, mac?:string, name?:string, retDisable?:number, retEnable?:number}}
 */
function btForceRefresh(opts) {
  const api = btInit()
  if (!api) return { ok: false, reason: 'no-native' }
  if (!api.setServiceState) return { ok: false, reason: 'no-bthprops' }
  const hint = String((opts && opts.nameHint) || '')
  try {
    // 1) 找无线电
    const findParams = Buffer.alloc(4)
    findParams.writeUInt32LE(4, 0)
    const radioOut = Buffer.alloc(8)
    const hFind = api.findFirstRadio(findParams, radioOut)
    if (!hFind) return { ok: false, reason: 'no-radio' }
    let radio = 0n
    try {
      radio = radioOut.readBigUInt64LE(0)
    } finally {
      try {
        api.findRadioClose(hFind)
      } catch (e) {}
    }
    if (!radio) return { ok: false, reason: 'no-radio' }

    // 2) 找目标设备（优先名字命中，否则取第一个"已连接"的）
    const params = Buffer.alloc(BT_SEARCH_SIZE)
    params.writeUInt32LE(BT_SEARCH_SIZE, 0)
    params.writeUInt32LE(1, 4) // fReturnAuthenticated
    params.writeUInt32LE(1, 8) // fReturnRemembered
    params.writeUInt32LE(0, 12) // fReturnUnknown
    params.writeUInt32LE(1, 16) // fReturnConnected
    params.writeUInt32LE(0, 20) // fIssueInquiry
    params.writeUInt8(1, 24) // cTimeoutMultiplier
    params.writeBigUInt64LE(radio, 32) // hRadio
    const dev = Buffer.alloc(BT_DEVINFO_SIZE)
    dev.writeUInt32LE(BT_DEVINFO_SIZE, 0)
    const hDev = api.findFirstDevice(params, dev)
    if (!hDev) return { ok: false, reason: 'no-device' }
    let target = null
    try {
      for (;;) {
        const name = dev.toString('utf16le', BT_OFF_NAME, BT_OFF_NAME + 496).replace(/\u0000[\s\S]*$/, '')
        const connected = dev.readUInt32LE(BT_OFF_CONNECTED) !== 0
        const mac = Array.from(dev.subarray(BT_OFF_ADDR, BT_OFF_ADDR + 6))
          .reverse()
          .map((x) => x.toString(16).toUpperCase().padStart(2, '0'))
          .join('')
        if (connected && (!target || (hint && name.includes(hint)))) {
          target = { name, mac, raw: Buffer.from(dev) }
          if (hint && name.includes(hint)) break
        }
        if (!api.findNextDevice(hDev, dev)) break
      }
    } finally {
      try {
        api.findDeviceClose(hDev)
      } catch (e) {}
    }
    if (!target) return { ok: false, reason: 'no-connected-device' }

    // 3) 关掉再打开 HFP
    const guid = devPropKey(HFP_HF_SERVICE) // 不传 pid 时得到的就是 16 字节 GUID
    const retDisable = api.setServiceState(radio, target.raw, guid, BLUETOOTH_SERVICE_DISABLE)
    const retEnable = api.setServiceState(radio, target.raw, guid, BLUETOOTH_SERVICE_ENABLE)
    report('强制重报：' + target.name + ' disable=' + retDisable + ' enable=' + retEnable)
    // 0 = ERROR_SUCCESS；两个都失败才算失败（enable 失败会比 disable 失败更糟）
    if (retEnable !== 0 && retDisable !== 0) {
      return { ok: false, reason: 'set-service-failed:' + retDisable + '/' + retEnable, mac: target.mac, name: target.name }
    }
    return { ok: true, mac: target.mac, name: target.name, retDisable, retEnable }
  } catch (e) {
    report('强制重报失败：' + (e && e.message))
    return { ok: false, reason: 'error:' + (e && e.message) }
  }
}

function btReason_() {
  btInit()
  return btReason
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
  // 蓝牙外设电量（setupapi，只读）
  btRawDevices,
  btAvailable,
  btUnavailableReason: btReason_,
  // 逼耳机重新上报电量（bthprops，会让 HFP 断 1~2 秒）
  btForceRefresh,
  VK_LBUTTON,
}
