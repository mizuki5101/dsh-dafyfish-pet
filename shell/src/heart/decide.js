'use strict'
// 解析 + 夹取 + 仲裁 + 「这句话值不值得说」的质量检查（纯函数）。
//
// 2026-10-18 加质量检查的原因：1B 会稳定地说「主人，喝口水？」——语法完美、内容为零。
// 拆开看是两类问题：
//   · 笼统（generic）：万能关心句，和画面无关；
//   · 退化（garbled）：把动作词表念出来（「尾巴快摆，尾巴快摆」）或输出 <think> 残片。
// 这里只负责**标记**，重试与否交给调用方（heart/index.js）。

const { MOODS, MOTIONS, FACES, SEES, ACTS, PRIORITIES } = require('./catalog')

const MAX_SAY = 50
const MAX_TOPIC = 20
const MAX_NOTE = 30
const MAX_SAYS_PER_HOUR = 12
const MOTION_MIN_GAP_MS = 60 * 1000

/** 从一段可能带 markdown/说明的文字里取出 JSON 对象；失败返回 null */
function extractJson(text) {
  const s = String(text == null ? '' : text).trim()
  if (!s) return null
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1].trim() : s
  try {
    const v = JSON.parse(body)
    if (v && typeof v === 'object' && !Array.isArray(v)) return v
  } catch (e) {}
  const i = body.indexOf('{')
  const j = body.lastIndexOf('}')
  if (i >= 0 && j > i) {
    try {
      const v = JSON.parse(body.slice(i, j + 1))
      if (v && typeof v === 'object' && !Array.isArray(v)) return v
    } catch (e) {}
  }
  return null
}

function clampText(v, max) {
  return String(v == null ? '' : v)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** 去掉思考链残片（1B 偶尔漏出来） */
function stripArtifacts(s) {
  return String(s == null ? '' : s)
    .replace(/<\/?think>/gi, ' ')
    .replace(/<\/?(?:s|s>)?\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function pickFrom(v, list) {
  const s = String(v == null ? '' : v).trim()
  return list.includes(s) ? s : ''
}

const NULL_WORDS = ['none', 'null', 'n/a', 'na', 'nil', 'undefined', '无', '没有', '不说', 'nothing']

function cleanSay(v, max) {
  let s = stripArtifacts(clampText(v, max))
  s = s.replace(/^["'\u201c\u201d]+/, '').replace(/["'\u201c\u201d]+$/, '').trim()
  if (NULL_WORDS.includes(s.toLowerCase())) return ''
  return s
}

/** 万能关心句（和画面无关的那一类） */
const GENERIC_RES = [
  /喝[点口]?水/,
  /休息一下/,
  /休息休息/,
  /注意身体/,
  /别太累/,
  /不要太累/,
  /加油/,
  /早点睡/,
  /起来动一动/,
  /放松一下/,
]

function bigrams(s) {
  const out = new Set()
  const t = String(s || '').replace(/[\s\p{P}]/gu, '')
  for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2))
  return out
}

/** 和 topic 有 ≥2 个共同二字片段 = 有具体指向 */
function overlapsTopic(say, topic) {
  const a = bigrams(say)
  const b = bigrams(topic)
  let n = 0
  for (const x of b) if (a.has(x)) n++
  return n
}

/**
 * 笼统：命中万能句，且没有任何「具体信号」（数字/英文/引号/和 topic 有交集）。
 * 注意：宁可放过，不要误杀 —— 误杀了她就真的哑了。
 */
function isGeneric(say, topic) {
  const s = String(say || '')
  if (!s) return false
  if (!GENERIC_RES.some((re) => re.test(s))) return false
  if (/[0-9]/.test(s)) return false
  if (/[A-Za-z]{2,}/.test(s)) return false
  if (/[\u201c\u201d"「『]/.test(s)) return false
  if (topic && overlapsTopic(s, topic) >= 2) return false
  return true
}

/** 退化：思考链残片、短片段重复 ≥3 次、动作名被念进台词 */
function looksGarbled(text) {
  const s = stripArtifacts(text)
  if (!s) return false
  if (/<\/?think>/i.test(String(text || ''))) return true

  // 动作名被当成台词念出来（「尾巴快摆，尾巴快摆」）——这是 1B 最典型的退化
  let motionHits = 0
  for (const m of MOTIONS) if (m && s.includes(m)) motionHits++
  if (motionHits >= 2) return true
  for (const m of MOTIONS) {
    if (!m) continue
    let n = 0
    let idx = -1
    while ((idx = s.indexOf(m, idx + 1)) >= 0) n++
    if (n >= 3) return true
  }

  // 去掉标点后，任意 3~8 字片段出现 ≥3 次
  const t = s.replace(/[\s\p{P}\p{S}]/gu, '')
  if (t.length < 9) return false
  const maxL = Math.min(8, Math.floor(t.length / 3))
  for (let L = 3; L <= maxL; L++) {
    for (let i = 0; i + L <= t.length; i++) {
      const gram = t.slice(i, i + L)
      let n = 0
      let idx = -1
      while ((idx = t.indexOf(gram, idx + 1)) >= 0) n++
      if (n >= 3) return true
    }
  }
  return false
}

/**
 * 把模型输出变成可信的动作。
 * @returns {{ok:true, action:object, flags:{generic:boolean,garbled:boolean,emptySpeech:boolean}}|{ok:false, reason:string}}
 */
function sanitize(raw) {
  const obj = raw && typeof raw === 'object' ? raw : extractJson(raw)
  if (!obj) return { ok: false, reason: 'bad-json' }

  const act = ACTS.includes(String(obj.act || '').trim()) ? String(obj.act).trim() : 'none'
  const sayRaw = clampText(obj.say, MAX_SAY)
  const action = {
    see: SEES.includes(String(obj.see || '').trim()) ? String(obj.see).trim() : 'idle',
    topic: clampText(obj.topic, MAX_TOPIC),
    note: clampText(obj.note, MAX_NOTE),
    say: cleanSay(obj.say, MAX_SAY),
    act,
    mood: pickFrom(obj.mood, MOODS),
    motion: pickFrom(obj.motion, MOTIONS),
    face: pickFrom(obj.face, FACES),
    priority: PRIORITIES.includes(String(obj.priority || '').trim()) ? String(obj.priority).trim() : 'normal',
  }

  const garbled = looksGarbled(sayRaw)
  const generic = isGeneric(action.say, action.topic)
  // act=none 时一律不说话、不动 —— 模型偶尔会「说一句但标 none」，按 none 处理最安全。
  if (action.act === 'none') {
    action.say = ''
    action.motion = ''
    action.face = ''
  }
  const emptySpeech = action.act === 'speak' && !action.say
  return { ok: true, action, flags: { generic, garbled, emptySpeech } }
}

/** 这一条要不要重试一次（换一句更具体的） */
function needsRetry(flags, action) {
  if (!action) return false
  if (flags && flags.garbled) return true
  // 2026-10-18 用户要求：万能话不再重试（她只做动作看不出来，说点泛泛的也比不说强）。
  // 但「退化」和「一个字都没有」还是要重试，否则会输出乱码或静默动作。
  if (!action.say) return true
  return false
}

const RETRY_NUDGE =
  '上一版没有给出有效台词（或把动作名念了出来）。请重写：这一轮必须 act=speak 且 say 非空，像跟主人说话；能提到画面里的细节最好，没看懂就自然地说一句关心的话也可以。'

/** 和最近说过的话太像（同一张截图时 9B 很容易复读） */
const RETRY_DUP =
  '上一句和最近说过的几乎一样。请换个角度或说法重写，不要重复最近说过的话。'

/**
 * 第二次重试**不带图**时用：逼它离开屏幕，换个话题。
 *
 * 为什么需要：2026-10-19 实测，静止桌面（图标墙）上第一版几乎必然和上一轮重复
 * （12125/12126 相隔 30 秒、台词一字不差），而**带着同一张图重试仍然落在同一件事上**
 * （12132→12133「这么多程序挤在一起」前缀一字不差）。再看一眼没有新信息，
 * 只能换个输入：不给图，让它聊主人/自己/时间。
 */
const RETRY_TOPIC =
  '这次不用再看屏幕了：这个画面你刚刚已经说过。请换个话题 —— 问问主人在忙什么、说说你自己、或者提醒一下时间/该休息了；topic 填空字符串，不要再提屏幕上的东西。'

/** 两句台词的相似度（二字片段 Jaccard）；用于「防复读」 */
function isDuplicate(say, recent) {
  const norm = (s) => String(s || '').replace(/[\s\p{P}]/gu, '')
  const a = norm(say)
  if (a.length < 6) return false
  const A = bigrams(a)
  for (const r of Array.isArray(recent) ? recent : []) {
    const b = norm(r)
    if (!b || b.length < 6) continue
    if (a === b) return true
    const B = bigrams(b)
    let inter = 0
    for (const x of A) if (B.has(x)) inter++
    const uni = A.size + B.size - inter
    if (uni > 0 && inter / uni >= 0.6) return true
  }
  return false
}

function hourCount(list, now) {
  return (Array.isArray(list) ? list : []).filter((t) => Number.isFinite(t) && now - t < 3600 * 1000).length
}

/**
 * 「同一个画面看了第几次」。
 *
 * 用**画面指纹**判断，不用 topic 文本：topic 是模型自由生成的
 * （「桌面图标密密麻麻排满」vs「密密麻麻的图标墙」永远不相等），
 * 旧实现按字符串全等比较 ⇒ 计数恒为 0，「坐太久了」那条感知从没触发过。
 *
 * @param {number} prev          上一次的计数
 * @param {boolean} sameByImage  画面指纹判定为同一画面
 * @param {boolean} sameBySee    see 枚举相同（首帧没有指纹时的兜底）
 * @param {boolean} hasBaseline  之前看过至少一次
 */
function nextSameCount(prev, sameByImage, sameBySee, hasBaseline) {
  if (!hasBaseline) return 0
  if (!sameByImage && !sameBySee) return 0
  return Math.max(0, Number(prev) || 0) + 1
}

/**
 * 重试时要不要把图去掉。
 *
 * 画面没变、或台词重复时，再看同一张图只会说同一件事（2026-10-19 实测）；
 * 去掉图既省约 1100 视觉 token，又能逼模型换个话题。
 * garbled 例外：它需要看着画面才能修正。
 */
function retryWithoutImage(flags, dup, diff, threshold) {
  if (dup) return true
  if (flags && flags.garbled) return false
  return typeof diff === 'number' && diff <= threshold
}

function isNightHour(hour) {
  return hour >= 23 || hour < 6
}

/**
 * 仲裁：这一条到底发不发、发哪些字段。
 * @param {object} action sanitize 的结果
 * @param {object} state  {agentStatus, sleeping, lastSayAt, lastMotionAt, says[], hour}
 * @param {object} cfg    heart 配置
 * @param {number} now
 * @param {object} [opts]  {forceSay:true} —— 手动「立即看一眼」时跳过 say-gap / say-budget
 */
function arbitrate(action, state, cfg, now, opts) {
  const a = Object.assign({}, action)
  const s = state || {}
  const notes = []
  const forceSay = !!(opts && opts.forceSay)
  const hour = Number.isFinite(s.hour) ? s.hour : new Date(now || Date.now()).getHours()

  // 只做动作不说话 = 主人看不出区别（用户原话）。所以「没台词」一律不发。
  if (!a.say) return { ok: false, reason: 'silent' }

  // DSH 正在干活 / 她正在演：默认不许插队，只有「高优先级提醒」例外。
  if (s.agentStatus && s.agentStatus !== 'idle') {
    if (!(a.priority === 'high' && a.act === 'remind')) return { ok: false, reason: 'busy' }
  }
  if (s.sleeping && !(a.priority === 'high' && a.act === 'remind')) return { ok: false, reason: 'sleeping' }

  if (a.say) {
    if (forceSay) {
      // 2026-10-20 用户要求：手动「立即看一眼」是主人的显式操作，不该被自动节流静默吃掉。
      // 原来它只绕过 gate 的 busy/sleeping，走到这里照样被 say-gap 拦 —— 表现是
      // 「点了一下，模型明明生成了，屏幕上什么都没有」，而且 motion/face 也被一起丢弃。
      // 这里连每小时上限一起放开；busy / sleeping 仍在上面的分支里判，不受影响。
      notes.push('force-say')
    } else {
      const gap = Math.max(0, Number((cfg && cfg.sayMinGapSec) || 180)) * 1000
      if (now - (Number(s.lastSayAt) || 0) < gap) return { ok: false, reason: 'say-gap' }
      // 每小时上限可配（默认 15）；面板的「话痨」档会把它调高
      const cap = Math.max(1, Number((cfg && cfg.maxSaysPerHour) || MAX_SAYS_PER_HOUR))
      if (hourCount(s.says, now) >= cap) return { ok: false, reason: 'say-budget' }
    }
  }

  // 动作/表情是「锦上添花」：冷却中或深夜就剥掉，不必整条丢弃。
  if ((a.motion || a.face) && now - (Number(s.lastMotionAt) || 0) < MOTION_MIN_GAP_MS) {
    a.motion = ''
    a.face = ''
    notes.push('motion-gap')
  }
  if (isNightHour(hour) && a.motion) {
    a.motion = ''
    notes.push('night')
  }

  if (!a.say && !a.motion && !a.face) return { ok: false, reason: notes[0] || 'empty' }
  return { ok: true, action: a, notes }
}

/** 动作 → 页面 /dsh-pet/control 的字段（SSE 直接推这个形状） */
function toControl(action, ms) {
  // heart=true：这是**心跳主动说的那一句**（不是 DSH 工具气泡、也不是看屏前的开场白）。
  // 页面据此把它排到「等读图回复」的队首，别的气泡只能排在它后面。
  const out = { t: 'control', heart: true }
  if (action.say) out.say = action.say
  if (action.mood) out.mood = action.mood
  if (action.motion) out.motion = action.motion
  if (action.face) out.expression = action.face
  out.bubbleMs = Number(ms) > 0 ? Number(ms) : 7000
  return out
}

module.exports = {
  MAX_SAY, MAX_TOPIC, MAX_NOTE, MAX_SAYS_PER_HOUR, MOTION_MIN_GAP_MS, RETRY_NUDGE,
  extractJson, clampText, stripArtifacts, sanitize, needsRetry, arbitrate, toControl,
  hourCount, isNightHour, isGeneric, looksGarbled, overlapsTopic, isDuplicate, RETRY_DUP, RETRY_TOPIC,
  nextSameCount, retryWithoutImage,
}
