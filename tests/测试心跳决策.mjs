/**
 * 心跳 P1 纯函数单测（纯 Node，不需要外壳）。
 *
 * 覆盖：JSON 提取/夹取、仲裁（忙/睡/冷却/预算/夜间）、control 映射、提示词与 schema、端点归一化。
 * 真机那一半用 _safe/验心跳.mjs（P1 会加「跑一次完整链路」的断言）。
 *
 * 用法：node _research-data/测试心跳决策.mjs
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const D = require('../shell/src/heart/decide.js')
const P = require('../shell/src/heart/prompt.js')
const V = require('../shell/src/heart/vision.js')
const C = require('../shell/src/heart/catalog.js')

let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}
const NOW = new Date('2026-10-18T15:00:00+08:00').getTime()

console.log('\n【1】从模型输出里取 JSON')
{
  ok('纯 JSON', D.extractJson('{"act":"none"}') && D.extractJson('{"act":"none"}').act === 'none')
  ok('markdown 围栏', D.extractJson('\u0060\u0060\u0060json\n{"a":1}\n\u0060\u0060\u0060') && D.extractJson('\u0060\u0060\u0060json\n{"a":1}\n\u0060\u0060\u0060').a === 1)
  ok('前后有解释文字', D.extractJson('好的，结果如下：{"a":2} 以上') && D.extractJson('好的，结果如下：{"a":2} 以上').a === 2)
  ok('坏 JSON 返回 null', D.extractJson('{oops') === null)
  ok('空串返回 null', D.extractJson('') === null)
  ok('数组不算（要对象）', D.extractJson('[1,2]') === null)
}

console.log('\n【2】白名单夹取')
{
  const r = D.sanitize({ see: 'coding', note: '在写代码', say: '主人又在敲代码啦', act: 'speak', mood: 'happy', motion: '点头', face: '脸红', priority: 'normal' })
  ok('正常输出原样保留', r.ok && r.action.mood === 'happy' && r.action.motion === '点头' && r.action.face === '脸红', r.action)
  ok('see 合法', r.action.see === 'coding')

  const bad = D.sanitize({ see: 'xxx', note: 'x', say: 'y', act: 'dance', mood: '兴奋', motion: '跳舞', face: '星星眼' })
  ok('未知 see → idle', bad.action.see === 'idle')
  ok('未知 act → none', bad.action.act === 'none')
  ok('未知 mood/motion/face → 空', bad.action.mood === '' && bad.action.motion === '' && bad.action.face === '')

  const none = D.sanitize({ act: 'none', say: '不该出现', motion: '点头', face: '脸红', mood: 'happy' })
  ok('act=none 时清空 say/motion/face', none.action.say === '' && none.action.motion === '' && none.action.face === '' && none.action.mood === 'happy')

  const long = D.sanitize({ act: 'speak', say: '一'.repeat(80), note: ' 多  空格 ', mood: '', motion: '', face: '' })
  ok('say 截到 50 字', long.action.say.length === 50)
  ok('note 合并空白', long.action.note === '多 空格')

  const badPriority = D.sanitize({ act: 'speak', say: 'hi', priority: 'urgent' })
  ok('未知 priority → normal', badPriority.action.priority === 'normal')

  ok('say="none" 视为没说', D.sanitize({ act: 'speak', say: 'none' }).action.say === '')
  ok('say="无" 视为没说', D.sanitize({ act: 'speak', say: '无' }).action.say === '')
  ok('say 去掉包裹引号', D.sanitize({ act: 'speak', say: '"主人好"' }).action.say === '主人好')

  const topicCase = D.sanitize({ act: 'speak', topic: 'DeepSeek 在跑心跳代码', say: '这个面板的路径框快撑爆了，要不要我帮你缩一下？' })
  ok('topic 被保留', topicCase.action.topic === 'DeepSeek 在跑心跳代码', topicCase.action.topic)
  ok('具体台词不判笼统', topicCase.flags.generic === false)
  ok('具体台词不判退化', topicCase.flags.garbled === false)

  const generic = D.sanitize({ act: 'speak', topic: 'DeepSeek 页面', say: '主人，喝口水吧' })
  ok('万能句标记 generic', generic.flags.generic === true)
  const genericButTopic = D.sanitize({ act: 'speak', topic: '喝水提醒的小窗', say: '这个喝水提醒的小窗该关了吧？' })
  ok('和 topic 有交集时不算笼统', genericButTopic.flags.generic === false)

  const leak = D.sanitize({ act: 'speak', topic: 'x', say: '尾巴快摆，换重心，点头。' })
  ok('念动作名标记 garbled', leak.flags.garbled === true)
  const emptySay = D.sanitize({ act: 'speak', topic: 'x', say: '' })
  ok('说要做但没词 → emptySpeech', emptySay.flags.emptySpeech === true)

  ok('needsRetry: garbled', D.needsRetry({ garbled: true }, { act: 'speak', say: 'x' }) === true)
  ok('needsRetry: 万能话不再重试（用户要求放宽）', D.needsRetry({ generic: true }, { act: 'speak', say: '主人喝口水吧' }) === false)
  ok('needsRetry: 空话', D.needsRetry({}, { act: 'speak', say: '' }) === true)
  ok('needsRetry: 正常不重试', D.needsRetry({}, { act: 'speak', say: '这个面板的路径框快撑爆了' }) === false)
  ok('RETRY_NUDGE 要求非空台词', /必须 act=speak 且 say 非空/.test(D.RETRY_NUDGE))
  ok('isDuplicate: 近似句判定重复', D.isDuplicate('主人，DeepSeek 这窗口开着，我有点想进去说句话，它理我吗？', ['主人，这窗口开着，我有点想进去说句话，它理我吗？']) === true)
  ok('isDuplicate: 不同句不判重', D.isDuplicate('今天想吃白饭', ['主人，喝口水吧']) === false)
  ok('isDuplicate: 太短不判重', D.isDuplicate('嗯嗯', ['嗯嗯']) === false)
  ok('RETRY_DUP 要求换说法', /换个角度|不要重复/.test(D.RETRY_DUP))
  ok('RETRY_TOPIC 要求离开屏幕换话题', /不用再看屏幕/.test(D.RETRY_TOPIC) && /topic 填空字符串/.test(D.RETRY_TOPIC))
  ok('RETRY_TOPIC 和 RETRY_DUP 不是同一套指令', D.RETRY_TOPIC !== D.RETRY_DUP)

  // 2026-10-19：同一画面计数（旧实现按 topic 文本全等 ⇒ 恒为 0）
  ok('nextSameCount: 首帧不计数', D.nextSameCount(0, true, true, false) === 0)
  ok('nextSameCount: 画面没变累加', D.nextSameCount(2, true, false, true) === 3)
  ok('nextSameCount: 画面变了归零', D.nextSameCount(2, false, false, true) === 0)
  ok('nextSameCount: 只靠 see 兜底也算同一画面', D.nextSameCount(1, false, true, true) === 2)
  ok('nextSameCount: 坏输入不炸', D.nextSameCount(undefined, true, false, true) === 1)

  // 2026-10-19：第二次重试不带图（省视觉 token + 逼它换话题）
  ok('retryWithoutImage: 台词重复 ⇒ 不带图', D.retryWithoutImage({}, true, 99, 6) === true)
  ok('retryWithoutImage: 画面没变 ⇒ 不带图', D.retryWithoutImage({}, false, 3, 6) === true)
  ok('retryWithoutImage: 画面变了 ⇒ 带图', D.retryWithoutImage({}, false, 20, 6) === false)
  ok('retryWithoutImage: garbled 必须带图修正', D.retryWithoutImage({ garbled: true }, false, 2, 6) === false)
  ok('retryWithoutImage: 首帧 diff=null ⇒ 带图', D.retryWithoutImage({}, false, null, 6) === false)

  const badJson = D.sanitize('not json')
  ok('非 JSON → bad-json', badJson.ok === false && badJson.reason === 'bad-json')
  ok('模型说 n/a 也不当台词', D.sanitize({ act: 'gesture', say: 'n/a', motion: '歪头' }).action.say === '')
}

console.log('\n【3】仲裁')
{
  const cfg = { sayMinGapSec: 180 }
  const base = { see: 'coding', note: 'x', say: '主人加油', act: 'speak', mood: 'happy', motion: '点头', face: '', priority: 'normal' }
  const idle = { agentStatus: 'idle', sleeping: false, lastSayAt: NOW - 200000, lastMotionAt: NOW - 120000, says: [], hour: 15 }

  ok('空闲 + 到点 → 放行', D.arbitrate(base, idle, cfg, NOW).ok === true)
  ok('DSH 忙 → busy', D.arbitrate(base, Object.assign({}, idle, { agentStatus: 'working' }), cfg, NOW).reason === 'busy')
  ok('忙 + high/remind 例外', D.arbitrate(Object.assign({}, base, { act: 'remind', priority: 'high' }), Object.assign({}, idle, { agentStatus: 'working' }), cfg, NOW).ok === true)
  ok('睡着 → sleeping', D.arbitrate(base, Object.assign({}, idle, { sleeping: true }), cfg, NOW).reason === 'sleeping')
  ok('睡 + high/remind 例外', D.arbitrate(Object.assign({}, base, { act: 'remind', priority: 'high' }), Object.assign({}, idle, { sleeping: true }), cfg, NOW).ok === true)
  ok('刚说过（30s）→ say-gap', D.arbitrate(base, Object.assign({}, idle, { lastSayAt: NOW - 30000 }), cfg, NOW).reason === 'say-gap')
  ok('一小时说了 12 次 → say-budget', D.arbitrate(base, Object.assign({}, idle, { says: Array.from({ length: 12 }, (_, i) => NOW - i * 1000) }), cfg, NOW).reason === 'say-budget')

  // 2026-10-20：手动「立即看一眼」要能把话放出去（否则点了一下屏幕上什么都没有）
  const forcedGap = D.arbitrate(base, Object.assign({}, idle, { lastSayAt: NOW - 30000 }), cfg, NOW, { forceSay: true })
  ok('forceSay 绕过 say-gap', forcedGap.ok === true && forcedGap.action.say === '主人加油', forcedGap)
  ok('forceSay 留痕', forcedGap.notes.includes('force-say'))
  ok('forceSay 绕过每小时上限',
    D.arbitrate(base, Object.assign({}, idle, { says: Array.from({ length: 40 }, (_, i) => NOW - i * 1000) }), cfg, NOW, { forceSay: true }).ok === true)
  ok('forceSay 不能绕过 busy', D.arbitrate(base, Object.assign({}, idle, { agentStatus: 'working' }), cfg, NOW, { forceSay: true }).reason === 'busy')
  ok('forceSay 不能绕过 sleeping', D.arbitrate(base, Object.assign({}, idle, { sleeping: true }), cfg, NOW, { forceSay: true }).reason === 'sleeping')
  ok('不带 forceSay 时 say-gap 照旧生效', D.arbitrate(base, Object.assign({}, idle, { lastSayAt: NOW - 30000 }), cfg, NOW, {}).reason === 'say-gap')
  ok('没台词 → silent（只做动作看不出来）', D.arbitrate({ say: '', motion: '点头', face: '' }, idle, cfg, NOW).reason === 'silent')

  const freshMotion = D.arbitrate(base, Object.assign({}, idle, { lastMotionAt: NOW - 5000 }), cfg, NOW)
  ok('动作冷却中：剥掉 motion，话照说', freshMotion.ok && freshMotion.action.motion === '' && freshMotion.action.say === '主人加油', freshMotion)
  ok('剥动作会留痕', freshMotion.notes.includes('motion-gap'))

  const night = D.arbitrate(base, Object.assign({}, idle, { hour: 23 }), cfg, NOW)
  ok('夜里禁 motion', night.ok && night.action.motion === '' && night.notes.includes('night'), night)

  const onlyMotion = D.arbitrate({ say: '', motion: '点头', face: '', priority: 'normal' }, Object.assign({}, idle, { hour: 23 }), cfg, NOW)
  ok('夜里只有动作 → 也按 silent 丢弃', onlyMotion.ok === false && onlyMotion.reason === 'silent')
}

console.log('\n【4】control 映射')
{
  const c = D.toControl({ say: 'hi', mood: 'shy', motion: '歪头', face: '脸红' }, 7000)
  ok('字段映射正确', c.say === 'hi' && c.mood === 'shy' && c.motion === '歪头' && c.expression === '脸红' && c.bubbleMs === 7000, c)
  ok('默认 t=control', c.t === 'control')
  ok('空字段不出现', !('expression' in D.toControl({ say: 'x', mood: '', motion: '', face: '' })))
}

console.log('\n【5】提示词与 schema')
{
  const msgs = P.buildMessages({ imageDataUrl: 'data:image/jpeg;base64,AAA', situation: { time: '15:00', weekday: '周日' } })
  ok('两条消息', msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user')
  ok('system 里有人设', /大肥鱼/.test(msgs[0].content) && /主人/.test(msgs[0].content))
  const parts = msgs[1].content
  ok('用户消息含图', parts.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/jpeg;base64,')))
  ok('用户消息含情境', parts.some((p) => p.type === 'text' && /15:00/.test(p.text)))
  const newSceneMsgs = P.buildMessages({ imageDataUrl: 'data:image/jpeg;base64,AAA', newScene: true, situation: {} })
  ok('每轮都要求在末尾（1B 对末尾最敏感）', /必须 act=speak，say 非空/.test(newSceneMsgs[1].content[0].text))
  const oldSceneMsgs = P.buildMessages({ imageDataUrl: 'data:image/jpeg;base64,AAA', newScene: false, situation: {} })
  ok('旧场景也要求说话（换个角度）', /必须 act=speak/.test(oldSceneMsgs[1].content[0].text))
  ok('允许泛泛的关心话', /泛泛的关心/.test(newSceneMsgs[0].content))
  ok('动作词表不在用户消息里（会污染画面识别）', !/尾巴快摆/.test(newSceneMsgs[1].content[0].text))
  ok('动作词表在 system 里', /尾巴快摆/.test(newSceneMsgs[0].content))
  // 2026-10-19：旧示例把 see/mood 写成实值，实测 8/8 条回复全是 chat/thinking（表情永远「思考中」）
  ok('示例给了两个不同的 see（不锁死 chat）',
    /"see":"coding"/.test(msgs[0].content) && /"see":"browsing"/.test(msgs[0].content) && !/"see":"chat"/.test(msgs[0].content))
  ok('示例给了两个不同的 mood（不锁死 thinking）',
    /"mood":"happy"/.test(msgs[0].content) && /"mood":"shy"/.test(msgs[0].content) && !/"mood":"thinking"/.test(msgs[0].content))
  ok('明确要求按实际自己挑，不要照抄', /不要固定抄/.test(msgs[0].content))
  ok('情境行可解析', (() => { try { JSON.parse(P.situationText({ time: '1', weekday: 'x' })); return true } catch (e) { return false } })())

  const s = P.SCHEMA
  ok('schema 必填齐全（含 topic）', ['see', 'topic', 'say', 'act', 'mood', 'motion', 'face', 'priority'].every((k) => s.required.includes(k)))
  ok('schema 有 topic 字段', !!s.properties.topic)
  ok('mood 枚举覆盖词表 + 空', s.properties.mood.enum.length === C.MOODS.length + 1 && s.properties.mood.enum[0] === '')
  ok('motion 枚举覆盖词表 + 空', s.properties.motion.enum.length === C.MOTIONS.length + 1)
  ok('face 枚举覆盖词表 + 空', s.properties.face.enum.length === C.FACES.length + 1)
  ok('不含额外字段', s.additionalProperties === false)
}

console.log('\n【6】词表镜像 / 端点归一化')
{
  ok('情绪 23 个（和 pet.js MOOD_FACE 一致）', C.MOODS.length === 23, C.MOODS.length)
  ok('动作 15 个（和 pet.js CLIPS 一致）', C.MOTIONS.length === 15, C.MOTIONS.length)
  ok('表情 13 个（和 FACE_MENU 一致）', C.FACES.length === 13, C.FACES.length)
  ok('词表无重复', new Set(C.MOODS.concat(C.MOTIONS, C.FACES)).size === C.MOODS.length + C.MOTIONS.length + C.FACES.length)

  ok('baseUrl 补 /v1', V.normalizeBase('http://127.0.0.1:19411') === 'http://127.0.0.1:19411/v1')
  ok('已有 /v1 不重复', V.normalizeBase('http://127.0.0.1:19411/v1') === 'http://127.0.0.1:19411/v1')
  ok('末尾斜杠去掉', V.normalizeBase('http://x:1/v1/') === 'http://x:1/v1')
  ok('非法协议返回空', V.normalizeBase('ftp://x') === '' && V.normalizeBase('') === '')

  ok('模型名精确匹配优先', V.pickModelName(['qwen3.5-9b', 'MiniCPM-V-4.7-1B'], 'MiniCPM-V-4.7-1B') === 'MiniCPM-V-4.7-1B')
  ok('没给名字时挑视觉模型', V.pickModelName(['qwen3.5-9b', 'minicpm-v-4.7'], '') === 'minicpm-v-4.7')
  ok('都不像就取第一个', V.pickModelName(['a', 'b'], '') === 'a')
  ok('空列表返回空串', V.pickModelName([], 'x') === '')
  ok('严格匹配：精确命中', V.matchModel(['qwen3.5-9b', 'minicpm-v4.7-1b'], 'minicpm-v4.7-1b').ok === true)
  ok('严格匹配：不做模糊回退', V.matchModel(['bonsai2-27b-v3-vision', 'qwen3.5-9b'], 'minicpm-v4.7-1b').ok === false)
  ok('严格匹配：未命中返回候选列表', (() => { const r = V.matchModel(['a', 'b'], 'c'); return r.error === 'model-not-found' && r.models.length === 2 })())
  ok('严格匹配：空模型名报 no-model', V.matchModel(['a'], '').error === 'no-model')
  ok('严格匹配：大小写敏感', V.matchModel(['MiniCPM-V-4.7-1B'], 'minicpm-v4.7-1b').ok === false)
  ok('严格匹配：自动去空格', V.matchModel([' qwen3.5-9b '], 'qwen3.5-9b').ok === true)

  ok('hourCount 只看最近一小时', D.hourCount([NOW - 1000, NOW - 7200000], NOW) === 1)
  ok('isNightHour 边界', D.isNightHour(23) && D.isNightHour(5) && !D.isNightHour(6))
}

console.log('\n【7】设置补丁合并 / 启动参数')
{
  const S = require('../shell/src/heart/settings.js')
  const SRV = require('../shell/src/heart/server.js')
  const base = { dualWindow: true, heart: { enabled: false, model: { port: 19411 } } }
  const merged = S.deepMerge(base, { heart: { enabled: true, model: { port: 19415 }, prompt: 'p' } })
  ok('深合并保留其它键', merged.dualWindow === true)
  ok('深合并覆盖嵌套值', merged.heart.model.port === 19415)
  ok('深合并不丢同级旧键', merged.heart.enabled === true && merged.heart.prompt === 'p')
  ok('undefined 不覆盖', S.deepMerge({ a: 1 }, { a: undefined }).a === 1)
  ok('数组整体替换', JSON.stringify(S.deepMerge({ a: [1, 2] }, { a: [3] }).a) === '[3]')
  ok('原对象不被改写', base.heart.enabled === false)

  ok('启动参数按空格切', JSON.stringify(SRV.splitArgs('-a b --c=d')) === '["-a","b","--c=d"]')
  ok('启动参数支持引号', JSON.stringify(SRV.splitArgs('-m "D:/my models/x.gguf" --x')) === '["-m","D:/my models/x.gguf","--x"]', SRV.splitArgs('-m "D:/my models/x.gguf" --x'))

  // 写盘：面板保存不能把 settings.json 里别的键弄丢
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const tmp = path.join(os.tmpdir(), 'heart-settings-test-' + Date.now() + '.json')
  fs.writeFileSync(tmp, JSON.stringify({ dualWindow: true, linkDsh: false, heart: { enabled: false } }))
  S.patchHeart(tmp, { enabled: true, model: { port: 19415 }, prompt: 'p' })
  const saved = JSON.parse(fs.readFileSync(tmp, 'utf8'))
  ok('写盘保留其它顶层键', saved.dualWindow === true && saved.linkDsh === false)
  ok('写盘合并 heart 段', saved.heart.enabled === true && saved.heart.model.port === 19415 && saved.heart.prompt === 'p')
  ok('写盘原子性（没有 .tmp 残留）', !fs.existsSync(tmp + '.tmp-' + process.pid))
  fs.unlinkSync(tmp)
}

console.log('\n【8】开场白 / 话痨参数')
{
  const O = require('../shell/src/heart/opener.js')
  ok('默认开场白 ≥4 条', O.OPENERS.length >= 4, O.OPENERS.length)
  ok('开场白无重复', new Set(O.OPENERS).size === O.OPENERS.length)
  ok('pickOpener 按随机数取', O.pickOpener(() => 0) === O.OPENERS[0] && O.pickOpener(() => 0.999) === O.OPENERS[O.OPENERS.length - 1])
  ok('pickOpener 支持自定义列表', O.pickOpener(() => 0, ['a', 'b']) === 'a')
  ok('pickOpener 空列表回落默认', O.OPENERS.includes(O.pickOpener(() => 0, [])))

  const msg = P.buildMessages({ imageDataUrl: 'data:image/jpeg;base64,AAA', opener: '让我看看主人在干嘛～', situation: {} })
  ok('开场白进了用户消息', /让我看看主人在干嘛/.test(msg[1].content[0].text))
  const recentMsg = P.buildMessages({ imageDataUrl: 'data:image/jpeg;base64,AAA', recent: ['第一句', '第二句'], situation: {} })
  ok('最近说过的话会列出来防复读', /最近说过：第一句/.test(recentMsg[1].content[0].text) && /不要重复/.test(recentMsg[1].content[0].text))
  ok('要求接着说不重复', /不要重复它/.test(msg[1].content[0].text))

  const cfg = { sayMinGapSec: 0, maxSaysPerHour: 2 }
  const action = { say: '说一句', motion: '', face: '', priority: 'normal', act: 'speak' }
  const state = { agentStatus: 'idle', sleeping: false, lastSayAt: 0, lastMotionAt: 0, says: [NOW - 1000, NOW - 2000], hour: 15 }
  ok('每小时上限来自配置（2 句）', D.arbitrate(action, state, cfg, NOW).reason === 'say-budget')
  ok('调大上限就能说', D.arbitrate(action, state, { sayMinGapSec: 0, maxSaysPerHour: 5 }, NOW).ok === true)

  const CFG = require('../shell/src/heart/config.js')
  const c = CFG.normalize({})
  ok('默认开启看屏提示', c.lookOpener === true)
  ok('默认每小时 15 句', c.maxSaysPerHour === 15)
  ok('上限夹取', CFG.normalize({ maxSaysPerHour: 9999 }).maxSaysPerHour === 600)
}

console.log('\n【9】回应模式：聊天记忆 / 自定义 API 配置')
{
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const CH = require('../shell/src/heart/chat.js')
  const tmp = path.join(os.tmpdir(), 'heart-chat-test-' + Date.now() + '.json')
  const mem = CH.createChatMemory({ file: tmp, maxTurns: 2 })
  ok('初始为空', mem.size() === 0)
  mem.add('user', '你好')
  mem.add('assistant', '主人好呀')
  ok('追加两条', mem.size() === 2 && mem.messages()[1].role === 'assistant')
  ok('落盘可读', JSON.parse(fs.readFileSync(tmp, 'utf8')).messages.length === 2)
  const mem2 = CH.createChatMemory({ file: tmp, maxTurns: 2 })
  ok('重开后还记得', mem2.size() === 2 && mem2.messages()[0].content === '你好')
  mem2.add('user', 'a'); mem2.add('assistant', 'b'); mem2.add('user', 'c')
  ok('超过轮数只留最近', mem2.size() === 4, mem2.size())
  mem2.clear()
  ok('清空后为空', mem2.size() === 0 && JSON.parse(fs.readFileSync(tmp, 'utf8')).messages.length === 0)
  fs.unlinkSync(tmp)
  ok('CHAT_SYSTEM 有「大肥鱼」人设', /大肥鱼/.test(CH.CHAT_SYSTEM) && /主人/.test(CH.CHAT_SYSTEM))

  // 2026-10-19：历史改成 token 预算（默认 16K），不再固定 12 轮
  const tmp2 = tmp + '.b'
  ok('estimateTokens：中文≈1 字 1 token', (() => { const t = CH.estimateTokens('一二三四五六七八九十'); return t >= 10 && t <= 20 })())
  ok('estimateTokens：英文≈4 字符 1 token', (() => { const t = CH.estimateTokens('abcdefgh'); return t >= 4 && t <= 10 })())
  const mem3 = CH.createChatMemory({ file: tmp2 })
  ok('默认预算 16K', mem3.maxTokens === 16384 && CH.DEFAULT_MAX_TOKENS === 16384)
  const many = []
  for (let i = 0; i < 40; i++) {
    many.push({ role: 'user', content: '问题 ' + i + '：' + '字'.repeat(200) })
    many.push({ role: 'assistant', content: '回答 ' + i + '：' + '字'.repeat(200) })
  }
  const trimmed = CH.trimMessages(many, { maxTokens: 4096, minTurns: 6 })
  ok('超预算会裁掉旧轮次', trimmed.length < many.length && trimmed.length > 0)
  ok('裁完第一条是 user（不会只有回答没有提问）', trimmed[0].role === 'user')
  ok('至少保留 minTurns 轮', trimmed.filter((m) => m.role === 'user').length >= 6, trimmed.filter((m) => m.role === 'user').length)
  ok('保留的是最新内容', /回答 39/.test(trimmed[trimmed.length - 1].content))
  try { fs.unlinkSync(tmp2) } catch (e) {}

  // 旧数据：开头一串 assistant（心跳独白）没有对应的 user，应被清掉
  const tmp3 = tmp + '.c'
  fs.writeFileSync(tmp3, JSON.stringify({
    messages: [
      { role: 'assistant', content: '独白1' },
      { role: 'assistant', content: '独白2' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '主人好' },
    ],
  }))
  const mem4 = CH.createChatMemory({ file: tmp3 })
  ok('旧数据里的孤儿独白被清掉', mem4.size() === 2 && mem4.messages()[0].content === '你好', mem4.messages())
  try { fs.unlinkSync(tmp3) } catch (e) {}

  const CFG = require('../shell/src/heart/config.js')
  ok('默认工作模式', CFG.normalize({}).mode === 'dsh')
  ok('回应模式保留', CFG.normalize({ mode: 'pet' }).mode === 'pet')
  ok('未知模式回落 dsh', CFG.normalize({ mode: 'x' }).mode === 'dsh')
  ok('听觉联默认开', CFG.normalize({}).audioTrigger === true)
  ok('听觉联可关', CFG.normalize({ audioTrigger: false }).audioTrigger === false)
  ok('自定义 API 字段保留', (() => { const n = CFG.normalize({ model: { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' } }); return n.model.baseUrl === 'https://x/v1' && n.model.model === 'm' && n.model.apiKey === 'k' })())
}

console.log('\n——— 结果：' + pass + ' 通过 / ' + fail + ' 失败 ———')
process.exit(fail ? 1 : 0)
