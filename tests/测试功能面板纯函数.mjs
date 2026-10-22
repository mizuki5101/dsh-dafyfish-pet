// 「功能面板 / 划词翻译 / 识图」的纯函数测试（不联网、不调模型、不起窗口）
//   node _research-data/测试功能面板纯函数.mjs
//
// 覆盖的是「拍脑袋想不出来、只能靠断言的」那部分：
//   ① 剪贴板文本值不值得弹（太短/太长/是文件路径）
//   ② 这次鼠标动作算不算"拖选"（单击、拖窗口、终端里拖动都不算）
//   ③ 气泡什么时候该收（点别处 = 取消选中；点气泡按钮 = 不准收）
//   ④ 免费翻译的协议解析与长文切块
//   ⑤ 区域截图的像素裁剪（DPR 1 / 1.5 / 2）
//   ⑥ 配置五道关：白名单漏字段 = "保存成功但值不变"，这条必须自动抓
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sc from '../shell/src/tools/select-core.js'
import tc from '../shell/src/tools/translate-core.js'
import mask from '../shell/src/heart/mask.js'
import cfgMod from '../shell/src/heart/config.js'
import settingsMod from '../shell/src/heart/settings.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

let pass = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) pass++
  else fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 200) : ''))
}

const { normalize, DEFAULTS, ENGINES } = cfgMod
const { sanitizeHeartPatch } = settingsMod

// ————————————————————————————————————————————————————————————
console.log('\n【1】cleanText：剪贴板文本值不值得弹')
{
  const cfg = { maxChars: 50 }
  ok('空串 → empty', sc.cleanText('', cfg).reason === 'empty')
  ok('全空白 → empty', sc.cleanText('   \n\t ', cfg).reason === 'empty')
  ok('单个字 → too-short', sc.cleanText('a', cfg).reason === 'too-short')
  ok('正常句子 → ok', sc.cleanText('hello world', cfg).ok === true)
  ok('chars 正确', sc.cleanText('hello', cfg).chars === 5)

  const crlf = sc.cleanText('第一行\r\n第二行\r第三行', cfg)
  ok('CRLF/CR 统一成 \\n', crlf.text === '第一行\n第二行\n第三行', crlf.text)
  ok('去首尾空白', sc.cleanText('   abc   ', cfg).text === 'abc')

  const long = 'x'.repeat(200)
  const cut = sc.cleanText(long, cfg)
  ok('超 maxChars 截断', cut.ok && cut.text.length === 50 && cut.truncated === true)
  ok('刚好等长不截断', sc.cleanText('y'.repeat(50), cfg).truncated === false)
  ok('2 万字以上直接放弃', sc.cleanText('z'.repeat(20001), cfg).reason === 'too-long')

  ok('文件路径不弹', sc.cleanText('D:\\a\\b.txt', cfg).reason === 'file-list')
  ok('多行路径不弹', sc.cleanText('D:\\a\\b.txt\nC:\\c\\d.txt', cfg).reason === 'file-list')
  // 别误杀正常句子
  ok('「C: 是系统盘」不算路径', sc.cleanText('C: 是系统盘吗', cfg).ok === true)
  ok('带空格的路径句子不算', sc.looksLikeFileList('C:\\Program Files 是安装目录') === false)
}

// ————————————————————————————————————————————————————————————
console.log('\n【2】误判规则：拖窗口 / 文件列表 / 终端')
{
  const r1 = { left: 0, top: 0, right: 100, bottom: 100 }
  ok('矩形没变 → 不是拖窗口', sc.isWindowDrag(r1, { ...r1 }) === false)
  ok('差 2px 内算没变', sc.isWindowDrag(r1, { left: 2, top: 0, right: 102, bottom: 100 }) === false)
  ok('差 10px → 是拖窗口', sc.isWindowDrag(r1, { left: 10, top: 0, right: 110, bottom: 100 }) === true)
  ok('缺参 → 当作没变（宁可放过）', sc.isWindowDrag(null, r1) === false)

  ok('文件名归一：大写 + 路径', sc.normalizeAppName('C:\\Windows\\System32\\CONHOST.EXE') === 'conhost')
  ok('命中 conhost', sc.isSkippedApp('conhost', ['conhost.exe']) === true)
  ok('命中 conhost.exe', sc.isSkippedApp('CONHOST.EXE', ['conhost']) === true)
  ok('chrome 不命中', sc.isSkippedApp('chrome', ['conhost.exe', 'cmd.exe']) === false)
  ok('空名单不崩', sc.isSkippedApp('chrome', null) === false)
  ok('无名字不命中', sc.isSkippedApp('', ['conhost.exe']) === false)
}

// ————————————————————————————————————————————————————————————
console.log('\n【3】reduce 状态机：什么动作才算拖选')
{
  const cfg = { dragPx: 8, skipApps: ['conhost.exe'] }
  const app = { ok: true, name: 'chrome' }
  const rect = { left: 0, top: 0, right: 1000, bottom: 800 }
  const base = () => sc.createState()

  // 单击：down → up，一动没动
  let s = base()
  let r = sc.step(s, { down: true, pt: { x: 100, y: 100 }, rect, app, seq: 5, now: 1000, overOwnUi: false }, cfg)
  s = r.state
  ok('按下不立刻 emit', r.emit === null)
  r = sc.step(s, { down: false, pt: { x: 100, y: 100 }, rect, app, seq: 5, now: 1100, overOwnUi: false }, cfg)
  s = r.state
  ok('单击不触发（双击选词也不触发，这是有意的）', r.emit === null, r.emit)

  // 拖 3px：不算
  s = base()
  s = sc.step(s, { down: true, pt: { x: 100, y: 100 }, rect, app, seq: 5, now: 1000, overOwnUi: false }, cfg).state
  s = sc.step(s, { down: true, pt: { x: 103, y: 100 }, rect, app, seq: 5, now: 1200, overOwnUi: false }, cfg).state
  ok('抖动 3px 不进拖选', s.mouse === 'down', s.mouse)
  r = sc.step(s, { down: false, pt: { x: 103, y: 100 }, rect, app, seq: 5, now: 1300, overOwnUi: false }, cfg)
  ok('3px 松手不触发', r.emit === null, r.emit)

  // 拖 9px 且够时 → 触发 grab
  s = base()
  s = sc.step(s, { down: true, pt: { x: 100, y: 100 }, rect, app, seq: 5, now: 1000, overOwnUi: false }, cfg).state
  s = sc.step(s, { down: true, pt: { x: 109, y: 100 }, rect, app, seq: 5, now: 1200, overOwnUi: false }, cfg).state
  ok('9px 进拖选', s.mouse === 'drag', s.mouse)
  r = sc.step(s, { down: false, pt: { x: 109, y: 100 }, rect, app, seq: 5, now: 1300, overOwnUi: false }, cfg)
  ok('松手触发 grab', r.emit && r.emit.type === 'grab', r.emit)
  ok('grab 带上 app 名', r.emit && r.emit.app === 'chrome')
  ok('grab 带上按下时的剪贴板序号', r.emit && r.emit.expectSeq === 5)
  ok('松手后回到 up', r.state.mouse === 'up')

  // 位移够但太快（<120ms）→ 不算
  s = base()
  s = sc.step(s, { down: true, pt: { x: 100, y: 100 }, rect, app, seq: 5, now: 1000, overOwnUi: false }, cfg).state
  s = sc.step(s, { down: true, pt: { x: 140, y: 100 }, rect, app, seq: 5, now: 1050, overOwnUi: false }, cfg).state
  ok('太快（50ms）不算拖选', s.mouse === 'down', s.mouse)

  // 拖窗口：窗口矩形变了 → 不抓
  s = base()
  s = sc.step(s, { down: true, pt: { x: 100, y: 10 }, rect, app, seq: 5, now: 1000, overOwnUi: false }, cfg).state
  s = sc.step(s, { down: true, pt: { x: 160, y: 10 }, rect, app, seq: 5, now: 1200, overOwnUi: false }, cfg).state
  r = sc.step(
    s,
    { down: false, pt: { x: 160, y: 10 }, rect: { left: 60, top: 10, right: 1060, bottom: 810 }, app, seq: 5, now: 1300, overOwnUi: false },
    cfg,
  )
  ok('拖窗口不抓', r.emit === null, r.emit)

  // 终端：skipApps → 不抓
  s = base()
  s = sc.step(s, { down: true, pt: { x: 100, y: 100 }, rect, app: { ok: true, name: 'conhost' }, seq: 5, now: 1000, overOwnUi: false }, cfg).state
  s = sc.step(s, { down: true, pt: { x: 120, y: 100 }, rect, app: { ok: true, name: 'conhost' }, seq: 5, now: 1200, overOwnUi: false }, cfg).state
  r = sc.step(s, { down: false, pt: { x: 120, y: 100 }, rect, app: { ok: true, name: 'conhost' }, seq: 5, now: 1300, overOwnUi: false }, cfg)
  ok('终端里拖动不抓（Ctrl+C 会打断命令）', r.emit === null, r.emit)

  // 进程查不到（管理员窗口）→ 不抓
  s = base()
  s = sc.step(s, { down: true, pt: { x: 100, y: 100 }, rect, app: { ok: false, reason: 'elevated' }, seq: 5, now: 1000, overOwnUi: false }, cfg).state
  s = sc.step(s, { down: true, pt: { x: 120, y: 100 }, rect, app: { ok: false, reason: 'elevated' }, seq: 5, now: 1200, overOwnUi: false }, cfg).state
  r = sc.step(s, { down: false, pt: { x: 120, y: 100 }, rect, app: { ok: false, reason: 'elevated' }, seq: 5, now: 1300, overOwnUi: false }, cfg)
  ok('管理员窗口不抓（UIPI）', r.emit === null, r.emit)

  // 在自己窗口里拖（她自己的面板里选字）→ 不抓，否则会给自己发 Ctrl+C
  s = base()
  const selfApp = { ok: true, name: 'ds-whalegirl-pet', self: true }
  s = sc.step(s, { down: true, pt: { x: 100, y: 100 }, rect, app: selfApp, seq: 5, now: 1000, overOwnUi: true }, cfg).state
  s = sc.step(s, { down: true, pt: { x: 130, y: 100 }, rect, app: selfApp, seq: 5, now: 1200, overOwnUi: true }, cfg).state
  r = sc.step(s, { down: false, pt: { x: 130, y: 100 }, rect, app: selfApp, seq: 5, now: 1300, overOwnUi: true }, cfg)
  ok('前台是我们自己时拖选不抓（否则会给自己发 Ctrl+C）', r.emit === null, r.emit)

  // ⭐ 回归锁（2026-10-22 哑火事故）：主窗铺满主屏时「落点在我们窗内」恒为真，
  //    当时拿它当"在自己窗口里"的判据 → 所有拖选都不抓。判据必须只认**进程身份**。
  s = base()
  s = sc.step(s, { down: true, pt: { x: 100, y: 100 }, rect, app, seq: 5, now: 1000, overOwnUi: true }, cfg).state
  s = sc.step(s, { down: true, pt: { x: 120, y: 100 }, rect, app, seq: 5, now: 1200, overOwnUi: true }, cfg).state
  r = sc.step(s, { down: false, pt: { x: 120, y: 100 }, rect, app, seq: 5, now: 1300, overOwnUi: true }, cfg)
  ok('落点在我们窗内（铺满屏）也必须能抓', r.emit && r.emit.type === 'grab', r.emit)
}

// ————————————————————————————————————————————————————————————
console.log('\n【4】取消选中 / 点气泡按钮 的时序')
{
  const cfg = { dragPx: 8, skipApps: [] }
  const app = { ok: true, name: 'chrome' }
  const rect = { left: 0, top: 0, right: 1000, bottom: 800 }
  const withPin = (now) => sc.markPin(sc.createState(), true, now)

  // 气泡显示中，在窗外点一下 → 松手时 clear
  let s = withPin(1000)
  let r = sc.step(s, { down: true, pt: { x: 500, y: 400 }, rect, app, seq: 5, now: 3000, overOwnUi: false }, cfg)
  s = r.state
  ok('按下时不立刻清（可能马上要拖选）', r.emit === null)
  r = sc.step(s, { down: false, pt: { x: 500, y: 400 }, rect, app, seq: 5, now: 3100, overOwnUi: false }, cfg)
  ok('点别处松手 → clear', r.emit && r.emit.type === 'clear', r.emit)
  ok('clear 后 pin 标记为不可见', r.state.pin.visible === false)

  // 刚弹出来的 600ms 内不算取消（松手边沿会紧跟一个 down）
  s = withPin(3000)
  r = sc.step(s, { down: true, pt: { x: 500, y: 400 }, rect, app, seq: 5, now: 3200, overOwnUi: false }, cfg)
  s = r.state
  r = sc.step(s, { down: false, pt: { x: 500, y: 400 }, rect, app, seq: 5, now: 3250, overOwnUi: false }, cfg)
  ok('600ms 宽限内不清', r.emit === null, r.emit)

  // 点在自己窗口里（= 点气泡按钮）→ 绝不清
  s = withPin(1000)
  r = sc.step(s, { down: true, pt: { x: 500, y: 400 }, rect, app, seq: 5, now: 5000, overOwnUi: true }, cfg)
  s = r.state
  r = sc.step(s, { down: false, pt: { x: 500, y: 400 }, rect, app, seq: 5, now: 5100, overOwnUi: true }, cfg)
  ok('点在主窗内不清（第一道保险）', r.emit === null, r.emit)

  // 页面报 pinHold → 也不清
  s = sc.holdPin(withPin(1000), 5000, 1200)
  r = sc.step(s, { down: true, pt: { x: 500, y: 400 }, rect, app, seq: 5, now: 5500, overOwnUi: false }, cfg)
  s = r.state
  r = sc.step(s, { down: false, pt: { x: 500, y: 400 }, rect, app, seq: 5, now: 5600, overOwnUi: false }, cfg)
  ok('pinHold 期间不清（第二道保险）', r.emit === null, r.emit)
  // hold 过期之后要恢复
  ok('holdPin 设了 holdUntil', sc.holdPin(sc.createState(), 5000, 1200).pin.holdUntil === 6200)

  // 新拖选直接覆盖：不清，而是再 grab 一次
  s = withPin(1000)
  s = sc.step(s, { down: true, pt: { x: 100, y: 100 }, rect, app, seq: 5, now: 5000, overOwnUi: false }, cfg).state
  s = sc.step(s, { down: true, pt: { x: 120, y: 100 }, rect, app, seq: 5, now: 5200, overOwnUi: false }, cfg).state
  r = sc.step(s, { down: false, pt: { x: 120, y: 100 }, rect, app, seq: 5, now: 5300, overOwnUi: false }, cfg)
  ok('新拖选 → 只 grab，不 clear', r.emit && r.emit.type === 'grab', r.emit)

  // 去抖：同一条文本 1.5s 内只弹一次
  let st = sc.createState()
  ok('第一次接受', sc.shouldAcceptText(st, 'hello', 1000) === true)
  st = sc.rememberText(st, 'hello', 1000)
  ok('1s 内相同文本拒绝', sc.shouldAcceptText(st, 'hello', 2000) === false)
  ok('1.6s 后接受', sc.shouldAcceptText(st, 'hello', 2600) === true)
  ok('不同文本立刻接受', sc.shouldAcceptText(st, 'world', 1100) === true)
  ok('空文本拒绝', sc.shouldAcceptText(st, '', 1100) === false)
}

// ————————————————————————————————————————————————————————————
console.log('\n【5】免费翻译（腾讯）协议与切块')
{
  ok('zh-Hans → zh', tc.mapTargetLang('zh-Hans') === 'zh')
  ok('空 → zh', tc.mapTargetLang('') === 'zh')
  ok('en-US → en', tc.mapTargetLang('en-US') === 'en')
  ok('ja → ja', tc.mapTargetLang('ja') === 'ja')

  const req = tc.buildQqRequest('hello', 'zh-Hans')
  ok('请求带 auto 源语言', req.source.lang === 'auto')
  ok('请求是 text_list 数组', Array.isArray(req.source.text_list) && req.source.text_list[0] === 'hello')
  ok('请求带 client_key', typeof req.header.client_key === 'string' && req.header.client_key.length > 20)
  ok('fn 是 auto_translation', req.header.fn === 'auto_translation')
  ok('target 是 zh', req.target.lang === 'zh')

  ok('正常响应', tc.extractQqText({ header: { ret_code: 'succ' }, auto_translation: ['你好'], src_lang: 'en' }).text === '你好')
  ok('识别出源语言', tc.extractQqText({ header: { ret_code: 'succ' }, auto_translation: ['你好'], src_lang: 'en' }).detected === 'en')
  ok('多段拼起来', tc.extractQqText({ header: { ret_code: 'succ' }, auto_translation: ['a', 'b'] }).text === 'a\nb')
  ok('空数组 → 失败', tc.extractQqText({ header: { ret_code: 'succ' }, auto_translation: [] }).ok === false)
  ok('ret_code 失败 → 带原因', String(tc.extractQqText({ header: { ret_code: 'error' } }).reason).startsWith('free-'))
  ok('非对象不崩', tc.extractQqText(null).ok === false)

  // OpenAI 兼容档
  const msgs = tc.buildChatMessages('hello', 'zh-Hans')
  ok('messages 两条', msgs.length === 2)
  ok('system 要求只输出译文', /只输出译文/.test(msgs[0].content))
  ok('user 带原文', msgs[1].content === 'hello')
  ok('解析 chat 响应', tc.extractChatText({ choices: [{ message: { content: ' 你好 ' } }] }).text === '你好')
  ok('空 content → 失败（思考模型常见）', tc.extractChatText({ choices: [{ message: { content: '' } }] }).ok === false)
  ok('只有 reasoning 也算失败', tc.extractChatText({ choices: [{ message: { reasoning_content: '嗯…' } }] }).ok === false)

  // 切块：总长守恒 + 不切断英文单词
  const short = 'abc'
  ok('短文本单块', tc.splitChunks(short, 4000).length === 1)
  ok('空串 → 空数组', tc.splitChunks('', 4000).length === 0)
  const long = ('这是一句话。'.repeat(500) + ' The quick brown fox jumps. '.repeat(100)).slice(0, 5000)
  const chunks = tc.splitChunks(long, 2000)
  ok('长文本切多块', chunks.length > 1, chunks.length)
  ok('切块总长守恒', chunks.join('') === long)
  ok('每块不超限太多', chunks.every((c) => c.length <= 2000), chunks.map((c) => c.length))
  const words = 'word '.repeat(1000)
  const wc = tc.splitChunks(words, 300)
  // 边界只能落在空格上（= 没把英文单词切成两半）
  ok(
    '不把英文单词切成两半',
    wc.slice(0, -1).every((c) => c.endsWith(' ')),
    wc.slice(0, 3).map((c) => c.slice(-6)),
  )

  ok('错误文案可读', tc.describeError('timeout') === '请求超时')
  ok('未知原因也有兜底', /翻译失败/.test(tc.describeError('whatever')))
}

// ————————————————————————————————————————————————————————————
console.log('\n【6】区域截图的像素裁剪（DPR 1 / 1.5 / 2）')
{
  // 造一张 8×4 的 BGRA 图，像素值 = y*8+x，方便断言"裁到的是哪一块"
  const W = 8
  const H = 4
  const buf = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const v = y * 8 + x
      buf[i] = v
      buf[i + 1] = v
      buf[i + 2] = v
      buf[i + 3] = 255
    }
  }
  const c = mask.cropBitmap(buf, W, H, { x: 2, y: 1, w: 3, h: 2 })
  ok('裁剪尺寸正确', c && c.w === 3 && c.h === 2, c && { w: c.w, h: c.h })
  ok('首像素对应源坐标 (2,1)=10', c && c.buf[0] === 10, c && c.buf[0])
  ok('次像素是 (3,1)=11', c && c.buf[4] === 11, c && c.buf[4])
  ok('第二行首像素是 (2,2)=18', c && c.buf[12] === 18, c && c.buf[12])
  ok('越界被夹住', mask.cropBitmap(buf, W, H, { x: 6, y: 3, w: 10, h: 10 }).w === 2)
  ok('整块在图外 → null', mask.cropBitmap(buf, W, H, { x: 20, y: 20, w: 5, h: 5 }) === null)
  ok('0 宽 → null', mask.cropBitmap(buf, W, H, { x: 1, y: 1, w: 0, h: 5 }) === null)
  ok('缺参不崩', mask.cropBitmap(null, W, H, { x: 0, y: 0, w: 1, h: 1 }) === null)

  // 屏幕 DIP → 图像像素：toImageRect 用 imgW/display.width 换算，不假设 DPR=1
  const display = { x: 0, y: 0, width: 1280, height: 800 }
  const region = { x: 100, y: 100, w: 200, h: 100 }
  const r1 = mask.toImageRect(region, display, 1280, 800, 0)
  ok('DPR1 不缩放', r1.x === 100 && r1.y === 100 && r1.w === 200 && r1.h === 100, r1)
  const r15 = mask.toImageRect(region, display, 1920, 1200, 0)
  ok('DPR1.5 乘 1.5', r15.x === 150 && r15.y === 150 && r15.w === 300 && r15.h === 150, r15)
  const r2 = mask.toImageRect(region, display, 2560, 1600, 0)
  ok('DPR2 乘 2', r2.x === 200 && r2.y === 200 && r2.w === 400 && r2.h === 200, r2)
  // 换算完能不能真的裁（端到端）
  const big = Buffer.alloc(4 * 4 * 4)
  const cc = mask.cropBitmap(big, 4, 4, mask.toImageRect({ x: 1, y: 1, w: 2, h: 2 }, { x: 0, y: 0, width: 4, height: 4 }, 4, 4, 0))
  ok('换算+裁剪能串起来', cc && cc.w === 2 && cc.h === 2)
}

// ————————————————————————————————————————————————————————————
console.log('\n【7】配置五道关（白名单漏字段 = 保存成功但值不变）')
{
  ok('引擎白名单只有三档', ENGINES.length === 3 && ENGINES.includes('free') && ENGINES.includes('api') && ENGINES.includes('local'))

  const def = normalize(DEFAULTS)
  ok('默认：划词关', def.tools.translate.enabled === false)
  ok('默认：识图关', def.tools.vision.enabled === false)
  ok('默认：免费引擎', def.tools.translate.engine === 'free')
  ok('默认：目标语言中文', def.tools.translate.to === 'zh-Hans')
  ok('默认：终端在黑名单里', def.tools.translate.skipApps.includes('conhost.exe'))
  ok('默认：还原剪贴板', def.tools.translate.restoreClipboard === true)

  const bad = normalize({ tools: { translate: { engine: 'EDGE', maxChars: 999999, dragPx: -5 }, vision: { minSize: 1 } } })
  ok('非法引擎回落 free', bad.tools.translate.engine === 'free', bad.tools.translate.engine)
  ok('maxChars 夹到上限', bad.tools.translate.maxChars === 20000)
  ok('dragPx 夹到下限', bad.tools.translate.dragPx === 4)
  ok('minSize 夹到 24', bad.tools.vision.minSize === 24)

  const patch = sanitizeHeartPatch({
    tools: {
      translate: {
        enabled: true,
        engine: 'api',
        to: 'zh-Hans',
        maxChars: 3000,
        dragPx: 12,
        restoreClipboard: false,
        skipApps: ['conhost.exe', '  ', 'code.exe'],
        api: { baseUrl: 'https://x/v1', model: 'm', apiKey: '' },
        unknownField: 'should-be-dropped',
      },
      vision: { enabled: true, minSize: 30, maxTokens: 400, prompt: '只看字' },
      junk: 1,
    },
  })
  ok('tools 段被保留', !!patch.tools)
  ok('translate 开关透传', patch.tools.translate.enabled === true)
  ok('未知字段被丢', patch.tools.translate.unknownField === undefined)
  ok('空白 skipApps 被过滤', patch.tools.translate.skipApps.length === 2, patch.tools.translate.skipApps)
  ok('空 apiKey 要放行（清空是合法操作）', 'apiKey' in patch.tools.translate.api)
  ok('vision 段透传', patch.tools.vision.maxTokens === 400)
  ok('未知段被丢', patch.tools.junk === undefined)

  // ⭐ 核心断言：DEFAULTS 里的每个叶子，白名单都必须认得（漏一个就是 bili 那个事故）
  const defTools = JSON.parse(JSON.stringify(DEFAULTS.tools))
  const passed = sanitizeHeartPatch({ tools: defTools })
  const leaves = (o, prefix) => {
    const out = []
    for (const k of Object.keys(o)) {
      const v = o[k]
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...leaves(v, prefix + k + '.'))
      else out.push(prefix + k)
    }
    return out
  }
  const want = leaves(defTools, '')
  const got = new Set(leaves(passed.tools || {}, ''))
  const missing = want.filter((k) => !got.has(k))
  ok('DEFAULTS.tools 的每个字段都能过白名单', missing.length === 0, missing)

  // 关开关不能把别的字段清掉（deepMerge + 部分 patch）
  ok('只发 enabled 也能落地', sanitizeHeartPatch({ tools: { translate: { enabled: false } } }).tools.translate.enabled === false)
}

// ————————————————————————————————————————————————————————————
console.log('\n【8】主进程里的出口字段（防"存了但读不到"）')
{
  const main = fs.readFileSync(path.join(ROOT, 'shell/src/main.js'), 'utf8')
  ok('heartSettingsPayload 回传 tools', /tools:\s*\{\s*\n\s*translate:/.test(main))
  ok('apiKey 只回布尔（绝不回原文）', /apiKeySet:\s*!!cfg\.tools\.translate\.api\.apiKey/.test(main))
  ok('识图开关回传', /vision:\s*\{\s*\n\s*enabled:\s*cfg\.tools\.vision\.enabled/.test(main))
  ok('heart:save 之后会 sync 功能面板', /if \(tools\) tools\.sync\(\)/.test(main))
  ok('页面刷新会复位 pin', /if \(tools\) tools\.resetPin\(\)/.test(main))

  const pet = fs.readFileSync(path.join(ROOT, 'pet-plugin/assets/pet.js'), 'utf8')
  ok('makeBubble 有 pinHold 早退', /if \(pinHold\) return/.test(pet))
  ok('hitJS 认得 .dshp-pin', pet.includes('.dshp-pin'))
  ok('页面有 pin 事件分支', /case 'pin':/.test(pet))
}

// ————————————————————————————————————————————————————————————
console.log('\n【9】日志脱敏（密钥不许进 boot.log）')
{
  const red = settingsMod.redactForLog
  ok('导出存在', typeof red === 'function')

  const src = {
    enabled: true,
    model: { baseUrl: 'http://127.0.0.1:8080/v1', model: 'm', apiKey: 'sk-abcdef123456' },
    tools: { translate: { enabled: true, engine: 'api', api: { baseUrl: 'https://x/v1', model: 'gpt', apiKey: 'sk-zzz' } } },
    prompt: '你好',
  }
  const r = red(src)
  ok('顶层 apiKey 打码', r.model.apiKey === '***', r.model.apiKey)
  ok('嵌套 apiKey 打码', r.tools.translate.api.apiKey === '***', r.tools.translate.api.apiKey)
  ok('非密钥字段原样', r.model.baseUrl === 'http://127.0.0.1:8080/v1' && r.model.model === 'm')
  ok('开关原样', r.tools.translate.enabled === true && r.tools.translate.engine === 'api')
  ok('中文提示词原样', r.prompt === '你好')
  ok('不动传入对象（纯函数）', src.model.apiKey === 'sk-abcdef123456' && src.tools.translate.api.apiKey === 'sk-zzz')
  ok('返回的是新对象', r.model !== src.model)

  // 空串 / 布尔要保留：日志得能看出"到底设没设"
  ok('空 apiKey 保持空串', red({ model: { apiKey: '' } }).model.apiKey === '')
  ok('apiKeySet 布尔不被当密钥', red({ model: { apiKeySet: true } }).model.apiKeySet === true)
  ok('apiKeySet:false 也保留', red({ api: { apiKeySet: false } }).api.apiKeySet === false)

  // 其他叫法的密钥也要挡
  ok('token 打码', red({ token: 'abc' }).token === '***')
  ok('secret 打码', red({ clientSecret: 'abc' }).clientSecret === '***')
  ok('password 打码', red({ password: 'p' }).password === '***')
  ok('大小写不敏感', red({ APIKEY: 'x' }).APIKEY === '***')

  // 边界
  ok('null 不崩', red(null) === null)
  ok('字符串原样', red('abc') === 'abc')
  ok('数组递归', Array.isArray(red([{ apiKey: 'x' }])) && red([{ apiKey: 'x' }])[0].apiKey === '***')
  ok('深嵌套有上限（不死循环）', typeof red({ a: { b: { c: { d: { e: { f: { g: { apiKey: 'x' } } } } } } } }) === 'object')

  // 闸门：main.js 里那句日志必须走脱敏
  const mainSrc = fs.readFileSync(path.join(ROOT, 'shell/src/main.js'), 'utf8')
  ok('heart:save 的日志走 redactForLog', /设置已保存 ' \+ JSON\.stringify\(redactForLog\(clean\)\)/.test(mainSrc))
  ok('不再有裸 JSON.stringify(clean) 进日志', !/设置已保存 ' \+ JSON\.stringify\(clean\)/.test(mainSrc))
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
