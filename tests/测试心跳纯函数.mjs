/**
 * 心跳 P0 纯函数单测（纯 Node，不需要外壳）。
 *
 * 覆盖三块：屏幕指纹（hash.js）、门控（gate.js）、配置归一化（config.js）。
 * 采集本身必须在 Electron 里跑，用 CDP/真机验（见 _safe/验心跳.mjs）。
 *
 * 用法：node _research-data/测试心跳纯函数.mjs
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const require = createRequire(import.meta.url)
const H = require('../shell/src/heart/hash.js')
const G = require('../shell/src/heart/gate.js')
const C = require('../shell/src/heart/config.js')
const M2 = require('../shell/src/heart/mask.js')
const MEMO = require('../shell/src/heart/memo.js')
const SET = require('../shell/src/heart/settings.js')

let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✅ ' + name)
  } else {
    fail++
    console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))
  }
}

/** 造一张 BGRA 图：fn(x,y) 返回灰度 0~255 */
function makeBmp(w, h, fn) {
  const buf = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, Math.round(fn(x, y))))
      const i = (y * w + x) * 4
      buf[i] = v
      buf[i + 1] = v
      buf[i + 2] = v
      buf[i + 3] = 255
    }
  }
  return buf
}

console.log('\n【1】屏幕指纹 dHash')
{
  const flat = makeBmp(90, 80, () => 128)
  ok('纯色图 → 全 0 指纹', H.dHash(flat, 90, 80) === '0000000000000000', H.dHash(flat, 90, 80))

  const grad = makeBmp(90, 80, (x) => (x * 255) / 89)
  ok('左暗右亮 → 全 1 指纹', H.dHash(grad, 90, 80) === 'ffffffffffffffff', H.dHash(grad, 90, 80))

  // 注意：不能直接给满幅渐变 +40（会削顶变成另一张图）。
  // 用 0~100 的低对比渐变，加偏移后仍在 0~255 内，才是在测「曝光鲁棒」本身。
  const low = makeBmp(90, 80, (x) => 20 + (x * 100) / 89)
  const lowShift = makeBmp(90, 80, (x) => 120 + (x * 100) / 89)
  ok('整体提亮不影响指纹（对曝光鲁棒）', H.dHash(lowShift, 90, 80) === H.dHash(low, 90, 80), [H.dHash(low, 90, 80), H.dHash(lowShift, 90, 80)])

  const rev = makeBmp(90, 80, (x) => 255 - (x * 255) / 89)
  ok('左右反转是另一张图', H.dHash(rev, 90, 80) !== H.dHash(grad, 90, 80))

  ok('图太小返回 null', H.dHash(makeBmp(8, 8, () => 1), 8, 8) === null)
  ok('缓冲区不够返回 null', H.dHash(Buffer.alloc(10), 90, 80) === null)
}

console.log('\n【2】汉明距离 / 亮度')
{
  ok('同一指纹距离 0', H.hamming('0123456789abcdef', '0123456789abcdef') === 0)
  ok('全 0 对全 f 距离 64', H.hamming('0000000000000000', 'ffffffffffffffff') === 64)
  ok('无效输入当完全不同', H.hamming(null, 'ffffffffffffffff') === 64)
  ok('长度不一致当完全不同', H.hamming('00', 'ffffffffffffffff') === 64)
  ok('一位不同距离 1', H.hamming('0000000000000000', '0000000000000001') === 1)

  const white = makeBmp(40, 30, () => 255)
  const black = makeBmp(40, 30, () => 0)
  ok('白图平均亮度 ≈255', Math.abs(H.meanLuma(white, 40, 30) - 255) < 1)
  ok('黑图平均亮度 0', H.meanLuma(black, 40, 30) === 0)
  ok('黑图判定为黑屏', H.looksBlack(H.meanLuma(black, 40, 30)) === true)
  ok('白图不是黑屏', H.looksBlack(H.meanLuma(white, 40, 30)) === false)
  ok('NaN 当黑屏', H.looksBlack(NaN) === true)
}

console.log('\n【3】门控 shouldLook')
{
  const cfg = C.normalize({ enabled: true, lookMinGapSec: 60, maxLooksPerHour: 20, nightQuiet: true })
  const now = new Date('2026-10-18T15:00:00+08:00').getTime() // 下午 3 点

  ok('关闭时不看', G.shouldLook({ cfg: C.normalize({}), now, hour: 15, lastAt: 0, looks: [] }).reason === 'disabled')
  ok('首次到期', G.shouldLook({ cfg, now, hour: 15, lastAt: 0, looks: [] }).ok === true)
  ok('刚看过（30s）跳过', G.shouldLook({ cfg, now, hour: 15, lastAt: now - 30000, looks: [] }).reason === 'gap')
  ok('超过 60s 再看', G.shouldLook({ cfg, now, hour: 15, lastAt: now - 61000, looks: [] }).ok === true)

  const nightCfg = C.normalize({ enabled: true, lookMinGapSec: 60, nightQuiet: true })
  ok('夜间 60s 还不够（要 360s）', G.shouldLook({ cfg: nightCfg, now, hour: 23, lastAt: now - 61000, looks: [] }).reason === 'gap-night')
  ok('夜间超过 360s 可以看', G.shouldLook({ cfg: nightCfg, now, hour: 23, lastAt: now - 361000, looks: [] }).ok === true)
  ok('夜间降频 = 6 倍间隔', G.lookGapMs(nightCfg, 23) === 360000)
  ok('白天间隔 = 1 倍', G.lookGapMs(nightCfg, 12) === 60000)

  const many = Array.from({ length: 20 }, (_, i) => now - i * 1000)
  ok('预算用尽跳过', G.shouldLook({ cfg, now, hour: 15, lastAt: now - 99999, looks: many }).reason === 'budget')
  const old = Array.from({ length: 20 }, (_, i) => now - 3600 * 1000 - i * 1000)
  ok('一小时前的记录不计入预算', G.hourCount(old, now) === 0)

  ok('窗口收起来不看', G.shouldLook({ cfg, now, hour: 15, lastAt: 0, looks: [], visible: false }).reason === 'hidden')
  ok('正在采集时跳过', G.shouldLook({ cfg, now, hour: 15, lastAt: 0, looks: [], busy: true }).reason === 'busy')
  ok('isNight 边界：23 点是夜', G.isNight(23, true) === true)
  ok('isNight 边界：5 点是夜', G.isNight(5, true) === true)
  ok('isNight 边界：6 点不是夜', G.isNight(6, true) === false)
  ok('nightQuiet=false 时夜间照常', G.isNight(23, false) === false)
}

console.log('\n【4】配置归一化')
{
  const d = C.normalize({})
  ok('默认关闭', d.enabled === false)
  ok('默认 15s 判定 / 60s 最短', d.intervalSec === 15 && d.lookMinGapSec === 60)
  ok('默认 provider=auto', d.model.provider === 'auto')
  ok('默认 16x / 切片 2 / 关思考', d.model.downsample === '16x' && d.model.maxSliceNums === 2 && d.model.enableThinking === false)
  ok('默认不存图', d.memory.storeImages === false)
  ok('默认不升级 DSH', d.escalate.toDsh === false)
  // 2026-10-20：刷视频（只读，默认开；冷却与帧数可调）
  ok('刷视频默认开', d.bili.enabled === true)
  ok('刷视频冷却默认 60s', d.bili.cooldownSec === 60)
  ok('刷视频帧数默认 3', d.bili.maxFrames === 3)
  ok('刷视频冷却被夹在 10~600', C.normalize({ bili: { cooldownSec: 1 } }).bili.cooldownSec === 10 && C.normalize({ bili: { cooldownSec: 9999 } }).bili.cooldownSec === 600)
  ok('刷视频帧数被夹在 3~10', C.normalize({ bili: { maxFrames: 99 } }).bili.maxFrames === 10 && C.normalize({ bili: { maxFrames: 1 } }).bili.maxFrames === 3)
  ok('刷视频可关', C.normalize({ bili: { enabled: false } }).bili.enabled === false)

  const c = C.normalize({
    enabled: 'yes',
    intervalSec: 1,
    lookMinGapSec: 99999,
    maxLooksPerHour: -5,
    nightQuiet: false,
    capture: { maxEdge: 99999, quality: 10 },
    model: { provider: 'foo', downsample: '8x', maxTokens: 99999, apiKey: 'sk-secret' },
    gate: { blockedApps: ['KeePassXC.exe', '', 42, ' 1Password.exe '] },
  })
  ok('enabled 只认布尔 true', c.enabled === false)
  ok('intervalSec 夹到下限 15', c.intervalSec === 15, c.intervalSec)
  ok('lookMinGapSec 夹到上限 600', c.lookMinGapSec === 600, c.lookMinGapSec)
  ok('maxLooksPerHour 夹到下限 1', c.maxLooksPerHour === 1)
  ok('capture.maxEdge 夹到 2560', c.capture.maxEdge === 2560)
  ok('capture.quality 夹到 40', c.capture.quality === 40)
  ok('未知 provider 落回 auto', c.model.provider === 'auto')
  ok('downsample 只认 4x，其它落回 16x', c.model.downsample === '16x')
  ok('maxTokens 夹到 1024', c.model.maxTokens === 1024)
  ok('blockedApps 去空/去非字符串/转小写', JSON.stringify(c.gate.blockedApps) === JSON.stringify(['keepassxc.exe', '1password.exe']), c.gate.blockedApps)
  ok('nightQuiet 布尔可关', c.nightQuiet === false)
  ok('describe 不泄露 apiKey', C.describe(c).indexOf('sk-secret') === -1, C.describe(c))

  // 设置面板新增的字段
  const panel = C.normalize({ model: { port: 99999 }, modelServer: { exe: ' D:\\llama\\x.exe ', model: 'm.gguf' }, prompt: 'x'.repeat(5000) })
  ok('端口夹到 65535', panel.model.port === 65535)
  ok('modelServer 路径去空格', panel.modelServer.exe === 'D:\\llama\\x.exe' && panel.modelServer.model === 'm.gguf')
  ok('modelServer 缺省为空串', panel.modelServer.mmproj === '' && panel.modelServer.extraArgs === '')
  ok('提示词截到 4000 字', panel.prompt.length === 4000)
  ok('默认端口 19411', C.normalize({}).model.port === 19411)
}


console.log('\n【4.5】保存白名单 sanitizeHeartPatch')
{
  const b = SET.sanitizeHeartPatch({ bili: { maxFrames: 6, keywords: ['AI 工具', ' 独立游戏 评测 ', '', 123] } })
  ok('bili.maxFrames 放行', b.bili && b.bili.maxFrames === 6, b.bili)
  ok('keywords 去空 / 去空格 / 只留字符串',
    JSON.stringify(b.bili.keywords) === JSON.stringify(['AI 工具', '独立游戏 评测']), b.bili)
  ok('空数组放行（清空口味 → 退回推荐）', Array.isArray(SET.sanitizeHeartPatch({ bili: { keywords: [] } }).bili.keywords))
  ok('keywords 最多 10 个', SET.sanitizeHeartPatch({ bili: { keywords: Array(20).fill('k') } }).bili.keywords.length === 10)
  ok('未知顶层字段被丢', SET.sanitizeHeartPatch({ nope: 1 }).nope === undefined)
  ok('未知子字段被丢', SET.sanitizeHeartPatch({ bili: { nope: 1 } }).bili === undefined)
  ok('坏数字不进（maxFrames=x）', SET.sanitizeHeartPatch({ bili: { maxFrames: 'x' } }).bili === undefined)
  ok('原有字段照旧（intervalSec 取整）', SET.sanitizeHeartPatch({ intervalSec: '30.6' }).intervalSec === 31)
  ok('空 patch 不炸', JSON.stringify(SET.sanitizeHeartPatch(null)) === '{}')
}

console.log('\n【5】截图遮罩 mask')
{
  const D = { x: 0, y: 0, width: 1707, height: 1067 }
  // 本机实测：hitBounds 在视口 (1519,555,307,623)，截图 1280x800
  const r = M2.toImageRect({ x: 1519.23, y: 555.24, w: 306.9, h: 622.5 }, D, 1280, 800, 6)
  ok('换算到截图像素（DIP→图）', !!r && r.x >= 1125 && r.x <= 1140 && r.y >= 400 && r.y <= 420, r)
  // 她的 bbox 右边缘在 1826 DIP，已经超出屏幕宽 1707（尾巴被屏幕切掉，交接文档里记过），
  // 所以遮罩的右边界会**夹到图像右边**（1280）——这是正确行为，不是 bug。
  ok('右下角覆盖到她（右/下夹到图边）', r && r.x + r.w === 1280 && r.y + r.h === 800, r && { x2: r.x + r.w, y2: r.y + r.h })
  ok('矩形在图内', r && r.x >= 0 && r.y >= 0 && r.x + r.w <= 1280 && r.y + r.h <= 800)
  ok('pad 会外扩', (() => { const a = M2.toImageRect({ x: 100, y: 100, w: 50, h: 50 }, D, 1280, 800, 0); const b = M2.toImageRect({ x: 100, y: 100, w: 50, h: 50 }, D, 1280, 800, 10); return b.x === a.x - 10 && b.w >= a.w + 18 })())
  ok('无效输入返回 null', M2.toImageRect(null, D, 1280, 800, 0) === null && M2.toImageRect({ x: 0, y: 0, w: 1, h: 1 }, { width: 0, height: 0 }, 1280, 800, 0) === null)
  ok('负坐标被夹到图内', (() => { const z = M2.toImageRect({ x: -50, y: -50, w: 40, h: 40 }, D, 1280, 800, 0); return z === null })())

  const buf = Buffer.alloc(10 * 10 * 4, 200)
  const n = M2.fillRect(buf, 10, 10, { x: 2, y: 3, w: 4, h: 2 }, 118)
  ok('填了 4x2=8 个像素', n === 8, n)
  const at = (x, y) => buf[(y * 10 + x) * 4]
  ok('框内是灰色', at(2, 3) === 118 && at(5, 4) === 118)
  ok('框外没动', at(1, 3) === 200 && at(6, 3) === 200 && at(2, 5) === 200)
  ok('越界不报错（自动夹）', M2.fillRect(buf, 10, 10, { x: -5, y: -5, w: 8, h: 8 }, 0) === 9)

  const buf2 = Buffer.alloc(20 * 20 * 4, 255)
  const m = M2.maskImage(buf2, 20, 20, [{ x: 0, y: 0, w: 5, h: 5 }, { x: 15, y: 15, w: 10, h: 10 }], 0)
  ok('并集两块都遮', m.rects.length === 2 && m.pixels === 25 + 25, m)
  ok('完全在外的矩形被丢掉', M2.maskImage(buf2, 20, 20, [{ x: 50, y: 50, w: 5, h: 5 }], 0).rects.length === 0)
}

console.log('\n【6】短期记忆 memo（落盘 + 清洗）')
{
  ok('坏条目被丢掉', MEMO.normalizeList([{ say: 'x' }, null, { say: '' }, { say: 'y' }], 10).length === 2)
  ok('只留最近 max 条（旧→新）', (() => {
    const l = Array.from({ length: 20 }, (_, i) => ({ say: 's' + i }))
    const r = MEMO.normalizeList(l, 12)
    return r.length === 12 && r[0].say === 's8' && r[11].say === 's19'
  })())
  ok('recentLines 只要文本、新的在后', (() => {
    const r = MEMO.recentLines([{ say: 'a' }, { say: 'b' }, { say: 'c' }, { say: 'd' }], 3)
    return r.length === 3 && r[0] === 'b' && r[2] === 'd'
  })())
  ok('过长台词被截断', MEMO.sanitizeEntry({ say: '一'.repeat(200) }).say.length === MEMO.MAX_SAY)

  const file = path.join(os.tmpdir(), 'dshp-memo-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json')
  try {
    const m = MEMO.createMemo({ file, max: 12 })
    ok('新文件为空', m.size() === 0 && m.last() === null)
    ok('空台词不入库', m.add({ say: '   ' }) === null && m.size() === 0)

    m.add({ at: 1, say: '第一句', topic: '桌面', see: 'browsing' })
    m.add({ say: '第二句' })
    ok('add 后有条目', m.size() === 2 && m.last().say === '第二句')
    ok('没给时间时自动补', m.last().at > 0)

    const m2 = MEMO.createMemo({ file, max: 12 })
    ok('重开后还记得（真落盘）', m2.size() === 2 && m2.says()[0] === '第一句' && m2.says()[1] === '第二句')
    ok('topic/see 一起存了', m2.entries()[0].topic === '桌面' && m2.entries()[0].see === 'browsing')

    for (let i = 0; i < 20; i++) m2.add({ say: '灌' + i })
    ok('超过上限只留最近 12', m2.size() === 12 && m2.last().say === '灌19')
    m2.clear()
    ok('clear 清空并落盘', m2.size() === 0 && MEMO.createMemo({ file }).size() === 0)
  } finally {
    try { fs.unlinkSync(file) } catch (e) {}
  }
}
console.log('\n——— 结果：' + pass + ' 通过 / ' + fail + ' 失败 ———')
process.exit(fail ? 1 : 0)
