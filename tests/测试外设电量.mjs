// 「外设电量」的纯函数测试（不碰蓝牙、不调系统、不起窗口）
//   node _research-data/测试外设电量.mjs
//
// 覆盖「拍脑袋想不出来、只能靠断言」的那部分：
//   ① DEVPROP 字节 → 数值/字符串/时间（类型是驱动给的，不能写死 readUInt8）
//   ② 哪些设备节点算数（只认 HFP）、同名去重、解不出来就丢掉
//   ③ 新鲜度：断连设备的旧电量必须被挡住（这台机器上真有一台 M114 是 80% 的幽灵值）
//   ④ 文件名/键值的闸门：DEVPKEY 的 fmtid + pid 写错就整条静默失效，必须锁住
//   ⑤ 面板尺寸的闸门：功能面板必须"封顶 + 内部滚动"，否则加内容就顶出屏幕
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import bc from '../shell/src/tools/battery-core.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

let pass = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) pass++
  else fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 200) : ''))
}

const { decodeDevProp, filetimeToMs, isHfpInstance, macOf, clampPercent, shortName } = bc
const { pickDevices, percentLevel, describe, ageText } = bc

// 造一条"属性"：{ type, size, data }
function prop(type, buf, size) {
  return { type, size: size === undefined ? buf.length : size, data: buf }
}
const u8 = (v) => prop(0x03, Buffer.from([v]))
const u32 = (v) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(v, 0)
  return prop(0x07, b)
}
const u64 = (v) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(v), 0)
  return prop(0x09, b)
}
const str = (s) => {
  const b = Buffer.from(s + '\u0000', 'utf16le')
  return prop(0x12, b)
}
const ft = (ms) => {
  const v = (BigInt(Math.round(ms)) + 11644473600000n) * 10000n
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(v, 0)
  return prop(0x10, b)
}

const bool = (v) => prop(0x11, Buffer.from([v ? 1 : 0]))
/** 主节点 instance（连接状态只在它上面准） */
const devNode = (mac) => 'BTHENUM\\DEV_' + mac + '\\7&14D4B11A&2&BLUETOOTHDEVICE_' + mac
/** HFP 服务节点 instance（电量挂在这里） */
const hfpNode = (mac) =>
  'BTHENUM\\{0000111E-0000-1000-8000-00805F9B34FB}_VID&000105D6_PID&000A\\7&14D4B11A&2&' + mac + '_C00000000'

const HFP = 'BTHENUM\\{0000111E-0000-1000-8000-00805F9B34FB}_VID&000105D6_PID&000A\\7&14D4B11A&2&6C16297DEC57_C00000000'
const HFP2 = 'BTHENUM\\{0000111E-0000-1000-8000-00805F9B34FB}_LOCALMFG&0002\\7&14D4B11A&2&141FA4161164_C00000000'
const A2DP = 'BTHENUM\\{0000110B-0000-1000-8000-00805F9B34FB}_VID&000105D6_PID&000A\\7&14D4B11A&2&6C16297DEC57_C00000000'
const NOW = Date.UTC(2026, 9, 24, 3, 0, 0) // 2026-10-24 03:00Z

// ————————————————————————————————————————————————————————————
console.log('\n【1】decodeDevProp：驱动给什么类型就按什么类型解')
{
  ok('BYTE 50', decodeDevProp(0x03, Buffer.from([50]), 1) === 50)
  ok('SBYTE -2', decodeDevProp(0x02, Buffer.from([0xfe]), 1) === -2)
  ok('BYTE 255 不当成 0', decodeDevProp(0x03, Buffer.from([255]), 1) === 255)

  const b16 = Buffer.alloc(2); b16.writeUInt16LE(300, 0)
  ok('UINT16 300', decodeDevProp(0x05, b16, 2) === 300)
  ok('UINT32 70000', decodeDevProp(0x07, u32(70000).data, 4) === 70000)
  ok('UINT64 5e9', decodeDevProp(0x09, u64(5e9).data, 8) === 5e9)
  ok('BOOLEAN true', decodeDevProp(0x11, Buffer.from([1]), 1) === true)
  ok('BOOLEAN false', decodeDevProp(0x11, Buffer.from([0]), 1) === false)

  ok('STRING 去 NUL', decodeDevProp(0x12, str('EDIFIER MT6 Pro').data, str('EDIFIER MT6 Pro').size) === 'EDIFIER MT6 Pro')
  // 驱动可能给的 size 比实际短，不能因此多读出一个尾巴
  const s = str('AB')
  ok('STRING size 截断', decodeDevProp(0x12, s.data, 4) === 'AB', decodeDevProp(0x12, s.data, 4))

  ok('未知类型 → null', decodeDevProp(0x0d, Buffer.alloc(16), 16) === null)
  ok('size=0 → null', decodeDevProp(0x03, Buffer.from([50]), 0) === null)
  ok('不是 Buffer → null', decodeDevProp(0x03, null, 1) === null)
  ok('数据太短不抛异常', (() => {
    try { return decodeDevProp(0x09, Buffer.from([1, 2]), 8) === null } catch (e) { return false }
  })())
}

// ————————————————————————————————————————————————————————————
console.log('\n【2】FILETIME：Unix 纪元那一点必须是 0')
{
  // 1970-01-01T00:00:00Z = FILETIME 116444736000000000
  ok('1970 → 0', filetimeToMs(116444736000000000) === 0, filetimeToMs(116444736000000000))
  ok('0 → null', filetimeToMs(0) === null)
  ok('负数 → null', filetimeToMs(-1) === null)
  const p = ft(NOW)
  ok('FILETIME 往返一致', decodeDevProp(0x10, p.data, p.size) === NOW, decodeDevProp(0x10, p.data, p.size))
}

// ————————————————————————————————————————————————————————————
console.log('\n【3】节点判据与名字')
{
  ok('HFP 认得', isHfpInstance(HFP))
  ok('HFP 小写也认得', isHfpInstance(HFP.toLowerCase()))
  ok('A2DP 不算', !isHfpInstance(A2DP))
  ok('空串不算', !isHfpInstance(''))
  ok('null 不算', !isHfpInstance(null))

  ok('MAC 抽取', macOf(HFP) === '6C16297DEC57', macOf(HFP))
  ok('MAC 抽取2', macOf(HFP2) === '141FA4161164', macOf(HFP2))
  // 主节点是另一种写法（DEV_<mac>），连接状态只在它上面准，必须也能抠出来
  ok('主节点 DEV_ 的 MAC', macOf('BTHENUM\\DEV_6C16297DEC57\\7&14D4B11A&2&BLUETOOTHDEVICE_6C16297DEC57') === '6C16297DEC57')
  ok('没有 MAC → 空', macOf('BTHENUM\\{0000111E-0000-1000-8000-00805F9B34FB}') === '')

  ok('夹取 50', clampPercent(50) === 50)
  ok('夹取 50.4 → 50', clampPercent(50.4) === 50)
  ok('夹取 101 → null', clampPercent(101) === null)
  ok('夹取 -1 → null', clampPercent(-1) === null)
  ok('夹取 NaN → null', clampPercent('abc') === null)
  ok('夹取 null → null', clampPercent(null) === null)
  ok('夹取 0 有效', clampPercent(0) === 0)

  ok('去 HFP 尾巴', shortName('EDIFIER MT6 Pro Hands-Free AG') === 'EDIFIER MT6 Pro', shortName('EDIFIER MT6 Pro Hands-Free AG'))
  ok('去 Hansfree', shortName('M114 Handsfree') === 'M114')
  ok('去 免提', shortName('某耳机 免提音频') === '某耳机')
  ok('普通名字不动', shortName('AirPods Pro') === 'AirPods Pro')
  ok('去完变空就原样返回', shortName('Hands-Free AG') === 'Hands-Free AG', shortName('Hands-Free AG'))
  ok('null → 空串', shortName(null) === '')
}

// ————————————————————————————————————————————————————————————
console.log('\n【4】pickDevices：按 MAC 聚合、取时间戳最新、解不出就丢')
{
  const DEVN = 'BTHENUM\\DEV_6C16297DEC57\\7&14D4B11A&2&BLUETOOTHDEVICE_6C16297DEC57'
  const BLE = 'BTHLE\\DEV_6C16297DEC57\\8&1&2'
  const rows = [
    // 主节点：没有电量，但**只有它**报的连接状态是真的
    { instance: DEVN, name: 'EDIFIER MT6 Pro', battery: null, batteryTs: null, isConnected: bool(true) },
    // HFP 节点：电量 50，时间戳 60 秒前；连接状态恒为 false（实测如此，不能拿来判连接）
    { instance: HFP, name: 'EDIFIER MT6 Pro Hands-Free AG', battery: u8(50), batteryTs: ft(NOW - 60e3), isConnected: bool(false) },
    // BLE 节点：电量 55，时间戳更近 → 应该它赢
    { instance: BLE, name: 'EDIFIER MT6 Pro', battery: u8(55), batteryTs: ft(NOW - 10e3), isConnected: null },
  ]
  const list = pickDevices(rows, { now: NOW })
  ok('同一台设备的多个节点聚合成 1 条', list.length === 1, list.length)
  ok('取时间戳最新的那条电量 55', list[0].percent === 55, list[0].percent)
  ok('at 就是那条的时间戳', list[0].at === NOW - 10e3, list[0].at)
  ok('服务节点的 false 不会盖掉主节点的 true', list[0].connected === true)
  ok('连着的设备不标 stale', list[0].stale === false)
  ok('mac 正确', list[0].mac === '6C16297DEC57')
  ok('label 去掉 AG 尾巴', list[0].label === 'EDIFIER MT6 Pro', list[0].label)

  // 时间戳反过来的话，旧的节点不该赢
  const rows2 = [
    { instance: HFP, name: 'X Hands-Free AG', battery: u8(50), batteryTs: ft(NOW - 10e3), isConnected: null },
    { instance: BLE, name: 'X', battery: u8(55), batteryTs: ft(NOW - 60e3), isConnected: null },
  ]
  ok('旧的 BLE 值不抢占', pickDevices(rows2, { now: NOW })[0].percent === 50)

  // 电量解不出来（类型不认识 / size 0 / 超界）→ 丢掉，不要显示假数
  const bad = [
    { instance: HFP, name: 'A', battery: prop(0x0d, Buffer.alloc(16), 16), batteryTs: ft(NOW) },
    { instance: HFP, name: 'B', battery: prop(0x03, Buffer.from([50]), 0), batteryTs: ft(NOW) },
    { instance: HFP, name: 'C', battery: u8(250), batteryTs: ft(NOW) }, // 250% 明显是脏数据
  ]
  ok('脏数据全丢', pickDevices(bad, { now: NOW }).length === 0, pickDevices(bad, { now: NOW }).length)

  // 没有电量的节点（主节点）不该自己变成一条
  ok('只有主节点 → 无结果', pickDevices([{ instance: DEVN, name: 'X', battery: null, isConnected: bool(true) }], { now: NOW }).length === 0)

  // 名字优先用主节点的：服务节点那个"…Avrcp 传输"既难看、枚举顺序还不固定
  const nm = pickDevices([
    { instance: 'BTHENUM\\{0000110E-0000-1000-8000-00805F9B34FB}_VID&1_PID&2\\7&x&2&AABBCCDDEE01_C00000000', name: '耳机 Avrcp 传输', battery: null },
    { instance: hfpNode('AABBCCDDEE01'), name: '耳机 Hands-Free AG', battery: u8(44), batteryTs: ft(NOW) },
    { instance: devNode('AABBCCDDEE01'), name: '耳机', battery: null },
  ], { now: NOW })
  ok('名字取主节点的', nm.length === 1 && nm[0].label === '耳机', nm[0] && nm[0].label)

  // 不同 MAC → 两条
  const two = pickDevices([
    { instance: hfpNode('6C16297DEC57'), name: 'A Hands-Free AG', battery: u8(40), batteryTs: ft(NOW) },
    { instance: hfpNode('141FA4161164'), name: 'B Hands-Free AG', battery: u8(70), batteryTs: ft(NOW) },
  ], { now: NOW })
  ok('不同设备各出一条', two.length === 2, two.length)

  ok('空数组安全', Array.isArray(pickDevices([], { now: NOW })) && pickDevices([], { now: NOW }).length === 0)
  ok('非数组安全', pickDevices(null, { now: NOW }).length === 0)
  ok('行里有 null 不崩', pickDevices([null, undefined, { instance: HFP, name: 'Z', battery: u8(10), batteryTs: ft(NOW) }], { now: NOW }).length === 1)
}

// ————————————————————————————————————————————————————————————
console.log('\n【5】连接判定：断开设备的旧电量必须被挡住')
{
  const live = [
    { instance: devNode('6C16297DEC57'), name: '在用耳机', battery: null, isConnected: bool(true) },
    { instance: hfpNode('6C16297DEC57'), name: '在用耳机 Hands-Free AG', battery: u8(50), batteryTs: ft(NOW - 10 * 60e3) },
  ]
  const dead = [
    { instance: devNode('141FA4161164'), name: '一个月前用过的', battery: null, isConnected: bool(false) },
    { instance: hfpNode('141FA4161164'), name: '一个月前用过的 Hands-Free AG', battery: u8(80), batteryTs: ft(NOW - 30 * 24 * 3600e3) },
  ]

  const both = pickDevices(live.concat(dead), { now: NOW })
  ok('有连着的设备时只显示连着的', both.length === 1, both.length)
  ok('显示的是在用的那台', both[0].name === '在用耳机', both[0].name)

  const onlyDead = pickDevices(dead, { now: NOW })
  ok('一台都没连 → 旧的也显示出来', onlyDead.length === 1)
  ok('并且标 stale', onlyDead[0].stale === true)

  // 没有连接状态信息（老系统 / 属性缺失）→ 不要凭空污名
  const unknown = pickDevices([{ instance: hfpNode('AABBCCDDEEFF'), name: '未知连接', battery: u8(66), batteryTs: ft(NOW) }], { now: NOW })
  ok('没有连接状态时不标 stale', unknown.length === 1 && unknown[0].stale === false && unknown[0].connected === null)

  // 都断开时按电量时间戳倒序（最近用过的排前面）
  const mix = pickDevices([
    { instance: hfpNode('000000000001'), name: 'A Hands-Free AG', battery: u8(20), batteryTs: ft(NOW - 200 * 24 * 3600e3) },
    { instance: hfpNode('000000000002'), name: 'B Hands-Free AG', battery: u8(60), batteryTs: ft(NOW - 100 * 24 * 3600e3) },
  ], { now: NOW })
  ok('都断开时按时间戳倒序', mix[0].name === 'B Hands-Free AG', mix.map((x) => x.name))
}

// ————————————————————————————————————————————————————————————
console.log('\n【6】显示层：档位 / 文案 / 时间人话')
{
  ok('10% → critical', percentLevel(10) === 'critical')
  ok('20% → low', percentLevel(20) === 'low')
  ok('21% → mid', percentLevel(21) === 'mid')
  ok('51% → ok', percentLevel(51) === 'ok')
  ok('null → unknown', percentLevel(null) === 'unknown')

  ok('空列表给一句人话', describe([]).includes('没读到电量'))
  ok('单设备文案', describe([{ label: 'EDIFIER MT6 Pro', percent: 50, stale: false }]) === 'EDIFIER MT6 Pro 50%')
  ok('旧值带标注', describe([{ label: 'X', percent: 80, stale: true }]).includes('旧值'))
  ok('多设备用 · 连起来', describe([{ label: 'A', percent: 1 }, { label: 'B', percent: 2 }]) === 'A 1% · B 2%')

  ok('ageText 刚刚', ageText(30e3) === '刚刚')
  ok('ageText 分钟', ageText(5 * 60e3) === '5 分钟前')
  ok('ageText 小时', ageText(3 * 3600e3) === '3 小时前')
  ok('ageText 天', ageText(3 * 24 * 3600e3) === '3 天前')
  ok('ageText NaN → 空', ageText(NaN) === '')
}

// ————————————————————————————————————————————————————————————
console.log('\n【7】闸门：键值 / 枚举方式 / 面板尺寸 —— 改错了要在这里红')
{
  const keysSrc = fs.readFileSync(path.join(ROOT, 'shell/src/native/keys.js'), 'utf8')
  ok('DEVPKEY 的 fmtid 没被改', keysSrc.includes("104ea319-6ee2-4701-bd47-8ddbf425bbe5"))
  ok('电量是 pid 2', /DEVPKEY_BT_BATTERY\s*=\s*\{[^}]*pid:\s*2\s*\}/.test(keysSrc))
  // pid 7 = 电量时间戳（**不是** LastConnectedTime：实测两者是不同的属性）
  ok('电量时间戳是 pid 7', /DEVPKEY_BT_BATTERY_TS\s*=\s*\{[^}]*pid:\s*7\s*\}/.test(keysSrc))
  // 连接状态只有主节点准，键不能换
  ok('连接状态是 83da6326… pid 15', /DEVPKEY_DEVICE_ISCONNECTED\s*=\s*\{[^}]*83da6326[^}]*pid:\s*15\s*\}/.test(keysSrc))
  // 按枚举器枚举（BTHENUM）—— 按 Bluetooth 类枚举会一个 HFP 节点都拿不到
  ok('用 BTHENUM 枚举器', keysSrc.includes("'BTHENUM\\u0000'"))
  ok('枚举时不传设备类 GUID', /getClassDevs\(null,\s*enumName/.test(keysSrc))
  ok('带 DIGCF_ALLCLASSES', keysSrc.includes('DIGCF_ALLCLASSES'))
  // 实例 id 的第一版用 indexOf(0) 找结尾，UTF-16 下必然截成空串
  ok('实例 id 不靠 indexOf(0)', !/idBuf\.indexOf\(0/.test(keysSrc))

  const petSrc = fs.readFileSync(path.join(ROOT, 'pet-plugin/assets/pet.js'), 'utf8')
  ok('功能面板有高度上限', /\.dshp-tools\{[^}]*max-height/.test(petSrc))
  ok('功能面板不再 360 宽', !/\.dshp-tools\{width:min\(calc\(360px/.test(petSrc))
  ok('有独立滚动容器', petSrc.includes('.dshp-tools-body{') && /\.dshp-tools-body\{[^}]*overflow-y:auto/.test(petSrc))
  ok('滚动容器 min-height:0（flex 里不写就压不下去）', /\.dshp-tools-body\{[^}]*min-height:0/.test(petSrc))
  ok('× 挪进标题栏（static）', /\.dshp-tools-head \.dshp-close\{position:static/.test(petSrc))
  ok('电量轮询是 30s', petSrc.includes('refreshBattery(false), 30000'))
  ok('关面板会停轮询', /stopBatteryPoll\(\)/.test(petSrc))

  // 强制刷新（2026-10-24 实测有效）：只对 HFP(HF) 那条服务做，GUID 写错就静默无效
  ok('强制刷新用 HFP 0x111E', keysSrc.includes("const HFP_HF_SERVICE = '0000111e-0000-1000-8000-00805f9b34fb'"))
  ok('不用 0x111F（实测返回 1060）', !/HFP_HF_SERVICE = '0000111f/.test(keysSrc))
  ok('刷新按钮走 batteryForce', petSrc.includes('tb.batteryForce()'))
  ok('页面有强制刷新通道', fs.readFileSync(path.join(ROOT, 'shell/src/preload.js'), 'utf8').includes("'tools:battery-force'"))
  ok('主进程注册了强制刷新', fs.readFileSync(path.join(ROOT, 'shell/src/tools/index.js'), 'utf8').includes('battery.forceRefresh()'))
}

// ————————————————————————————————————————————————————————————
if (fails.length) {
  console.log('\n失败 ' + fails.length + ' 项：')
  for (const f of fails) console.log('  ✗ ' + f)
  console.log('\n合计 ' + pass + ' 通过 / ' + fails.length + ' 失败')
  process.exit(1)
} else {
  console.log('\n全部通过：' + pass + ' 项')
}
