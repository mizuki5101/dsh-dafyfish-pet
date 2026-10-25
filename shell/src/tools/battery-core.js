'use strict'

// 「当前外设电量」—— 纯函数层（零 require，可单测）。
//
// 数据从哪来（2026-10-24 在这台机器上实测确认，别再去翻别的路）：
//   Windows 把蓝牙设备的电量存在 devnode 属性里：
//       DEVPKEY_Bluetooth_Battery = {104EA319-6EE2-4701-BD47-8DDBF425BBE5}, 2
//   注意三个「不在」：
//     · 不在设备主节点（BTHENUM\Dev_<mac> 上完全没有这个键）；
//     · 不在注册表里（Enum\BTHENUM 下递归找不到 Properties\{104ea319…}）
//       ⇒ 是驱动**按需算**出来的（读一次很便宜，可以 20~30s 轮询）；
//     · 这台耳机只挂在 HFP 节点上（A2DP / AVRCP 都没有）。
//
// 所以"实时性"的天花板不在我们这边：
//   耳机通过 HFP 的 `+CIEV: battchg,<0-5>` 把电量报给 Windows，Windows 记下来；
//   **它不会主动去问**。很多耳机只在连上的那一刻报一次 ⇒ 值会长时间不动。
//   实测：10:48:33 连上（电量 50%），到 11:28 时间戳一格没走 —— 耳机一次都没再报过。
//   要"现在多少"，只有两条路：让它重连一次（会断 1~2 秒麦克风），或者逆厂商私有协议。
//
// 三个来自实测/参考实现的口径（2026-10-24 修正）：
//   · **pid 7 是电量时间戳**（不是"最后连接时间"，两者是不同的属性）；
//   · **连接状态只有主节点 DEV_<mac> 上的 pid 15 准**，服务节点上恒为 False
//     ⇒ 按 MAC 聚合，"任一节点报 true" 才算连着；
//   · 同一台设备可能有好几个节点都报电量（BLE GATT / HFP / 主节点），
//     **取时间戳最新的那条** —— 否则会卡在旧节点的旧值上。
//     （这三条和 FerrisPulse 的 BluetoothDeviceHelper.cs 对得上，独立验证过。）

/** DEVPKEY_Bluetooth_Battery 的 {fmtid} pid 文本形式（仅用于日志/注释） */
const BT_BATTERY_KEY = '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2'
/** 电量时间戳同 fmtid 的 pid 7 */
const BT_BATTERY_TS_PID = 7
/** Handsfree Audio Gateway / Hands-Free 服务 UUID 片段（instance id 里是小写） */
const HFP_SERVICE = '0000111e'

/** DEVPROP_TYPE_* → 解码方式（只列我们真会遇到的） */
const DEVPROP_TYPE = {
  SBYTE: 0x02,
  BYTE: 0x03,
  INT16: 0x04,
  UINT16: 0x05,
  INT32: 0x06,
  UINT32: 0x07,
  INT64: 0x08,
  UINT64: 0x09,
  BOOLEAN: 0x11,
  STRING: 0x12,
  FILETIME: 0x10,
}

/** FILETIME（1601-01-01 起的 100ns）→ 毫秒时间戳；解不出返回 null */
function filetimeToMs(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n / 10000 - 11644473600000)
}

/**
 * 「这个数多久没更新了」的提示界限（只影响文案，**不再用来过滤设备**）。
 * 2026-10-24 从前把"6 小时内连过"当归一化判据，现在有真正的连接状态了，
 * 这个阈值降级成一句提示：超过 2 小时没更新就在面板上写出来。
 */
const AGED_MS = 2 * 3600 * 1000

/**
 * 把 SetupDiGetDevicePropertyW 吐出来的 (类型, 字节) 解成 JS 值。
 * size 是**字节数**（= RequiredSize）。解不出来返回 null（不要抛，调用方按"没有"处理）。
 *
 * ⚠️ 电量到底是 BYTE 还是 UINT32 我实测前不确定 —— 这台机器上是 BYTE(0x03)。
 *    所以这里按类型分派，别写死 readUInt8。
 */
function decodeDevProp(type, data, size) {
  if (!Buffer.isBuffer(data)) return null
  const n = Number(size) || 0
  if (n <= 0) return null
  try {
    switch (Number(type)) {
      case DEVPROP_TYPE.SBYTE:
        return data.readInt8(0)
      case DEVPROP_TYPE.BYTE:
        return data.readUInt8(0)
      case DEVPROP_TYPE.INT16:
        return data.readInt16LE(0)
      case DEVPROP_TYPE.UINT16:
        return data.readUInt16LE(0)
      case DEVPROP_TYPE.INT32:
        return data.readInt32LE(0)
      case DEVPROP_TYPE.UINT32:
        return data.readUInt32LE(0)
      case DEVPROP_TYPE.INT64:
        return Number(data.readBigInt64LE(0))
      case DEVPROP_TYPE.UINT64:
        return Number(data.readBigUInt64LE(0))
      case DEVPROP_TYPE.BOOLEAN:
        return data.readUInt8(0) !== 0
      case DEVPROP_TYPE.STRING: {
        // UTF-16 字符串，长度按字节；切到第一个 NUL 为止
        const s = data.toString('utf16le', 0, Math.min(n, data.length))
        const z = s.indexOf('\u0000')
        return z >= 0 ? s.slice(0, z) : s
      }
      case DEVPROP_TYPE.FILETIME: {
        if (n < 8) return null
        return filetimeToMs(data.readBigUInt64LE(0))
      }
      default:
        return null
    }
  } catch (e) {
    return null
  }
}

/** 这个 devnode 是不是 HFP（电量只挂在这种节点上） */
function isHfpInstance(instanceId) {
  return String(instanceId || '')
    .toLowerCase()
    .includes(HFP_SERVICE)
}

/**
 * 从 instance id 里抠出蓝牙 MAC（大写、无冒号），拿不到返回 ''。
 * 两种写法都要认：
 *   服务节点  BTHENUM\{0000111e-…}_VID&000105d6_PID&000a\7&14d4b11a&2&6c16297dec57_C00000000
 *   主节点    BTHENUM\DEV_6C16297DEC57\7&14D4B11A&2&BLUETOOTHDEVICE_6C16297DEC57
 * 用处：把同一台设备的多个节点聚到一起（连接状态在主节点上，电量在服务节点上）。
 */
function macOf(instanceId) {
  const s = String(instanceId || '')
  const dev = s.match(/\\DEV_([0-9a-f]{12})/i)
  if (dev) return dev[1].toUpperCase()
  const m = s.match(/&([0-9a-f]{12})_/i)
  return m ? m[1].toUpperCase() : ''
}

/** 百分比夹取：非数字 / 超界一律当"不可用" */
function clampPercent(v) {
  // ⚠️ 必须先挡住 null/''/布尔：Number(null) === 0、Number('') === 0，
  //    否则"没这个属性"会被当成 0%，面板上就是一个 0% 的假电量（测试【4】抓到过）。
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  const i = Math.round(n)
  if (i < 0 || i > 100) return null
  return i
}

/**
 * 面板上显示的名字。友好名带一段 HFP 尾巴（"EDIFIER MT6 Pro Hands-Free AG"），
 * 对用户没意义也不好看 ⇒ 去掉。只处理已知的几种写法，别的原样返回。
 */
function shortName(name) {
  const s = String(name || '').trim()
  const out = s.replace(/\s*(hands-?free(\s+(audio|ag|profile))?|免提(\s*音频)?)\s*$/i, '').trim()
  return out || s
}

/**
 * 把 keys.btRawDevices() 的原始行整理成面板要的列表。
 *
 * 行格式：{ instance, name, devStatus, battery, batteryTs, isConnected }（后三个是 {type,data,size} 或 null）
 *
 * 按 **MAC 聚合**，一台设备出结果一条：
 * 1. `connected` = 这台设备的**任一节点**报 pid15 = true
 *    （只有主节点 DEV_<mac> 这个值是真的，服务节点上恒为 False ⇒ 不能单看一个节点）；
 * 2. `percent` / `at` = 所有带电量节点里**时间戳最新**的那条
 *    （双模设备可能 BLE 和 HFP 各报一份，旧的那个会卡住不动）；
 * 3. 解不出 0~100 的电量 → 那个节点不算数（宁可不显示，也不显示假数）；
 * 4. 只显示**连着**的设备；一台都没连 → 把有的都显示出来并标 stale
 *    （这台机器上真有一台一个月前用过的 M114，至今还能读出 80%）。
 *
 * opts: { now?:ms }
 */
function pickDevices(rows, opts) {
  if (!Array.isArray(rows)) return []
  const o = opts || {}
  const now = Number.isFinite(o.now) ? o.now : Date.now()
  const groups = new Map()
  for (const r of rows) {
    if (!r) continue
    const mac = macOf(r.instance)
    const name = String(r.name || '').trim()
    const key = mac || (name ? 'n:' + name.toLowerCase() : '')
    if (!key) continue
    let g = groups.get(key)
    if (!g) {
      g = { mac, nameDev: '', nameBat: '', conn: null, percent: null, at: null, instance: '', via: '' }
      groups.set(key, g)
    }
    // 名字：**主节点**的最干净（"EDIFIER MT6 Pro"），服务节点的是
    // "…Avrcp 传输""…Hands-Free AG" 这种带尾巴的、而且枚举顺序还随机。
    if (name) {
      if (/\\DEV_[0-9a-f]{12}/i.test(String(r.instance || ''))) {
        if (!g.nameDev) g.nameDev = name
      } else if (!g.nameBat) {
        g.nameBat = name
      }
    }
    // conn: null=这台设备没有任何节点给出连接状态（老系统/异常） / true / false
    if (r.isConnected) {
      const v = decodeDevProp(r.isConnected.type, r.isConnected.data, r.isConnected.size)
      if (v === true) g.conn = true
      else if (v === false && g.conn === null) g.conn = false
    }
    if (!r.battery) continue
    const p = clampPercent(decodeDevProp(r.battery.type, r.battery.data, r.battery.size))
    if (p === null) continue
    // decodeDevProp 对 FILETIME 已经换成毫秒了，这里不要再换一次
    const tsRaw = r.batteryTs ? decodeDevProp(r.batteryTs.type, r.batteryTs.data, r.batteryTs.size) : null
    const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? tsRaw : null
    const better = g.percent === null || (ts !== null && (g.at === null || ts > g.at))
    if (better) {
      g.percent = p
      g.at = ts
      g.instance = String(r.instance || '')
      g.via = isHfpInstance(r.instance) ? 'hfp' : 'other'
      if (name && !g.nameBat) g.nameBat = name
    }
  }
  let list = Array.from(groups.values())
    .filter((g) => g.percent !== null)
    .map((g) => {
      const nm = g.nameDev || g.nameBat || g.mac || '未知设备'
      return {
        name: nm,
        label: shortName(nm) || g.mac,
        percent: g.percent,
      mac: g.mac,
      instance: g.instance,
      via: g.via,
      connected: g.conn,
      /** 这个百分比是 Windows **什么时候**收到的（null = 没有时间戳） */
      at: g.at,
      ageMs: g.at === null ? null : Math.max(0, now - g.at),
      // 只有**确认没连**才算旧值；没有连接状态信息时不做判断（不要凭空污名）
      stale: g.conn === false,
      }
    })
  const anyConnected = list.some((d) => d.connected === true)
  if (anyConnected) list = list.filter((d) => d.connected === true)
  list.sort((a, b) => {
    if (a.stale !== b.stale) return a.stale ? 1 : -1
    const ax = a.at === null ? 0 : a.at
    const bx = b.at === null ? 0 : b.at
    if (ax !== bx) return bx - ax
    return a.percent - b.percent
  })
  return list
}

/** 电量档位（只用于配色/文案，不影响数值） */
function percentLevel(p) {
  const n = clampPercent(p)
  if (n === null) return 'unknown'
  if (n <= 10) return 'critical'
  if (n <= 20) return 'low'
  if (n <= 50) return 'mid'
  return 'ok'
}

/**
 * 一行状态文案（页面直接显示）。
 * 刻意写"Windows 收到的值"而不是"实时值" —— 我们拿到的就是缓存，别夸大。
 */
function describe(devices) {
  const list = Array.isArray(devices) ? devices : []
  if (!list.length) return '没读到电量 —— 现在没有设备向 Windows 上报过电量'
  const parts = list.map((d) => (d.label || d.name) + ' ' + d.percent + '%' + (d.stale ? '（旧值）' : ''))
  return parts.join(' · ')
}

/** 「3 天前」这类人话，给面板上的次要说明用 */
function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const m = Math.floor(ms / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return m + ' 分钟前'
  const h = Math.floor(m / 60)
  if (h < 24) return h + ' 小时前'
  return Math.floor(h / 24) + ' 天前'
}

module.exports = {
  BT_BATTERY_KEY,
  BT_BATTERY_TS_PID,
  HFP_SERVICE,
  DEVPROP_TYPE,
  AGED_MS,
  filetimeToMs,
  decodeDevProp,
  isHfpInstance,
  macOf,
  clampPercent,
  shortName,
  pickDevices,
  percentLevel,
  describe,
  ageText,
}
