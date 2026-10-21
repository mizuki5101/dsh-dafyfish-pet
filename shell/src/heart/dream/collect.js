'use strict'
// 「做梦」的素材收集（纯函数，不碰 fs / 网络）。
//
// 素材三源（都在 userData 里，格式见各自的模块）：
//   · heart/memo.json   她自己嘀咕的台词 —— 有 at / say / topic / see
//   · heart/chat.json   回应模式的对话     —— 2026-10-21 起有 at（旧条目没有，跳过）
//   · bili-memo.json    刷过的视频         —— 有 at / title / up / one
//
// 窗口 = 「上次醒来」→「这次睡着」。没有水位线时兜底，见 windowOf。

const { clockText } = require('./toMd')

/** 没有 lastWakeAt 时最多往回捞多久（12 小时：再长素材也没意义，memo 只留 12 条） */
const FALLBACK_MS = 12 * 3600 * 1000
/** 再保守一点：绝对不回溯超过 7 天 */
const MAX_LOOKBACK_MS = 7 * 86400 * 1000

const MAX_SAYS = 40
const MAX_CHATS = 60
const MAX_VIDEOS = 6

function toNum(v, d) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/**
 * 算出这次要做梦的时间窗口。
 * @param {{lastWakeAt?:number, lastSleptAt?:number, lastDreamAt?:number, now?:number}} o
 * @returns {{since:number, until:number, source:'wake'|'fallback'}}
 */
function windowOf(o) {
  const x = o || {}
  const now = Math.max(1, toNum(x.now, Date.now()))
  const until = now
  const wake = toNum(x.lastWakeAt, 0)
  const since0 = wake > 0 && wake <= now ? wake : 0
  if (since0) return { since: Math.max(now - MAX_LOOKBACK_MS, since0), until, source: 'wake' }
  // 兜底：取「上次做梦 / 上次入睡 / 12 小时前」里最新的那个 —— 宁可少记，不要重复记
  const pool = [toNum(x.lastDreamAt, 0), toNum(x.lastSleptAt, 0), now - FALLBACK_MS].filter((t) => t > 0 && t <= now)
  const since = Math.max(now - MAX_LOOKBACK_MS, pool.length ? Math.max.apply(null, pool) : now - FALLBACK_MS)
  return { since: Math.min(since, until), until, source: 'fallback' }
}

function inWin(at, since, until) {
  const t = toNum(at, 0)
  return t >= since && t <= until
}

function byAt(a, b) {
  return (toNum(a && a.at, 0) || 0) - (toNum(b && b.at, 0) || 0)
}

/**
 * 按窗口筛素材。
 * @param {{says?:Array, chats?:Array, videos?:Array, since:number, until:number}} o
 * @returns {{since,until,says,chats,videos,count}}
 */
function collectMaterial(o) {
  const x = o || {}
  const since = toNum(x.since, 0)
  const until = toNum(x.until, Date.now())
  const says = dedupeSays(
    (Array.isArray(x.says) ? x.says : [])
      .filter((e) => e && typeof e.say === 'string' && e.say.trim() && inWin(e.at, since, until))
      .map((e) => ({ at: toNum(e.at, 0), say: String(e.say), topic: String(e.topic || ''), see: String(e.see || '') }))
      .sort(byAt),
  ).slice(-MAX_SAYS)
  const chats = (Array.isArray(x.chats) ? x.chats : [])
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim() &&
        toNum(m.at, 0) > 0 && // ⚠️ 旧条目没有时间戳 → 无法判断是否在窗口内，直接跳过
        inWin(m.at, since, until),
    )
    .map((m) => ({ at: toNum(m.at, 0), role: m.role, content: String(m.content).slice(0, 600) }))
    .sort(byAt)
    .slice(-MAX_CHATS)
  const videos = (Array.isArray(x.videos) ? x.videos : [])
    .filter((v) => v && v.title && inWin(v.at, since, until))
    .map((v) => ({ at: toNum(v.at, 0), title: String(v.title), up: String(v.up || ''), one: String(v.one || '') }))
    .sort(byAt)
    .slice(-MAX_VIDEOS)
  return { since, until, says, chats, videos, count: says.length + chats.length + videos.length }
}

/** 一条素材都没有 → 不发请求（省一次调用，也不吃冷却） */
function isEmpty(m) {
  return !m || Number(m.count) <= 0
}

/** 判重用的「骨」：去掉空白和标点（「记得保存好再关，别丢。」≈「记得保存好再关别丢」） */
function coreOf(s) {
  return String(s == null ? '' : s)
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。！？、；：…“”‘’"'）（()【】\[\],.!?;:%~～—\-]/g, '')
}

/**
 * 嘀咕去重（2026-10-21 真机踩出来的）。
 *
 * 起因：20:47 那篇日记 8 段，每段结尾都是「…别丢」—— 因为那半小时她的嘀咕
 * **反复在说同一句关心话**，而我把素材一条一行列出来，模型就一段对一条照搬。
 *
 * 两条规则：
 *   ① 去标点后完全相同 → 合并，记 repeat 次数；
 *   ② 开头 10 个字相同、长度接近 → 视为同一句话的变体，也合并。
 * 合并只发生在**素材层**：模型拿到的是一条「这句话说了 3 次」，而不是 3 条一样的话。
 */
function dedupeSays(list) {
  const out = []
  const byCore = new Map()
  for (const e of list) {
    const core = coreOf(e.say)
    if (!core) continue
    const hit = byCore.get(core)
    if (hit) {
      hit.repeat = (hit.repeat || 1) + 1
      continue
    }
    let merged = false
    for (const prev of out) {
      const pc = coreOf(prev.say)
      const n = Math.min(pc.length, core.length, 10)
      const near = Math.abs(pc.length - core.length) <= Math.max(6, core.length * 0.5)
      if (n >= 10 && pc.slice(0, n) === core.slice(0, n) && near) {
        prev.repeat = (prev.repeat || 1) + 1
        byCore.set(core, prev)
        merged = true
        break
      }
    }
    if (merged) continue
    const item = { at: e.at, say: e.say, topic: e.topic || '', see: e.see || '', repeat: 1 }
    out.push(item)
    byCore.set(core, item)
  }
  return out
}

/** 同一画面、时间挨着的嘀咕合并成一组（少几行 = 少几段，但不丢内容） */
function groupSays(list, gapMs) {
  const gap = Math.max(0, Number(gapMs) || 20 * 60000)
  const out = []
  for (const s of list) {
    const last = out[out.length - 1]
    if (last && last.see && s.see && last.see === s.see && s.at - last.until <= gap) {
      last.items.push(s)
      last.until = s.at
    } else {
      out.push({ see: s.see || '', since: s.at, until: s.at, items: [s] })
    }
  }
  return out
}

function pad2(n) {
  const v = Math.floor(Number(n)) || 0
  return (v < 10 ? '0' : '') + v
}

/** 素材里的时间戳：MM-DD HH:MM（跨天也不会混淆） */
function stamp(at) {
  const d = new Date(Number(at) > 0 ? Number(at) : Date.now())
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

/** 粗略 token：中日韩字符按 1，其余 4 字符按 1（和 chat.js 同一口径） */
const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/
function estimateTokens(text) {
  const s = String(text == null ? '' : text)
  if (!s) return 0
  let cjk = 0
  for (const ch of s) if (CJK.test(ch)) cjk++
  return Math.ceil(cjk + (s.length - cjk) / 4)
}

/** 对话太长就只留最近的部分（从新往旧累加，保证第一句是 user） */
function trimChats(list, maxTokens) {
  const arr = Array.isArray(list) ? list : []
  const cap = Math.max(200, toNum(maxTokens, 4000))
  let total = 0
  let cut = 0
  for (let i = arr.length - 1; i >= 0; i--) {
    total += estimateTokens(arr[i].content) + 4
    if (total > cap && arr[i].role === 'user') {
      cut = i
      break
    }
  }
  return arr.slice(cut)
}

/**
 * 素材 → 提示词里的纯文本（给模型看的那一段）。
 * 只给「发生了什么」，不给任何写好的句子 —— 不然模型会照抄。
 *
 * 2026-10-21 改过：嘀咕**按画面合并成一行**（同 see、间隔 ≤20 分钟），
 * 不再一条嘀咕一行 —— 一条一行会让 8 条素材变成 8 段日记，一段对一条。
 */
function materialText(m, opts) {
  const o = opts || {}
  if (isEmpty(m)) return ''
  const since = toNum(m.since, 0)
  const until = toNum(m.until, Date.now())
  const mins = Math.max(0, Math.round((until - since) / 60000))
  const span = mins >= 60 ? Math.floor(mins / 60) + ' 小时 ' + (mins % 60) + ' 分钟' : mins + ' 分钟'
  const events = []

  // ① 嘀咕：同类合并
  for (const g of groupSays(m.says || [])) {
    if (g.items.length === 1) {
      const s = g.items[0]
      let line = stamp(s.at) + ' 你自己嘀咕过：「' + String(s.say).slice(0, 80) + '」'
      if (s.repeat > 1) line += '（这句又说了 ' + (s.repeat - 1) + ' 次）'
      if (s.topic) line += '（当时画面：' + String(s.topic).slice(0, 20) + '）'
      events.push({ at: g.since, line })
    } else {
      const parts = g.items.map((s) => {
        let x = '「' + String(s.say).slice(0, 80) + '」'
        if (s.repeat > 1) x += '（这句又说了 ' + (s.repeat - 1) + ' 次）'
        return x
      })
      let line = stamp(g.since) + '~' + clockText(g.until) + ' 你自己嘀咕过 ' + g.items.length + ' 次：' + parts.join('；')
      if (g.see) line += '（这几句都是看着 ' + g.see + ' 说的）'
      events.push({ at: g.since, line })
    }
  }

  // ② 对话（保留逐句，语气和上下文都在这里）
  for (const c of trimChats(m.chats, o.maxChatTokens)) {
    events.push({
      at: c.at,
      line: stamp(c.at) + ' ' + (c.role === 'user' ? '主人' : '你') + '：「' + String(c.content).slice(0, 200) + '」',
    })
  }

  // ③ 视频
  for (const v of m.videos || []) {
    let line = stamp(v.at) + ' 你刷了视频《' + String(v.title).slice(0, 40) + '》'
    if (v.up) line += '（UP：' + String(v.up).slice(0, 16) + '）'
    if (v.one) line += '，你当时的感受：' + String(v.one).slice(0, 80)
    events.push({ at: v.at, line })
  }

  events.sort(byAt)
  const lines = ['【主人不在的这段时间：' + stamp(since) + ' → ' + stamp(until) + '，约 ' + span + '】']
  for (const e of events) lines.push('· ' + e.line)
  return lines.join('\n')
}

module.exports = {
  FALLBACK_MS,
  MAX_LOOKBACK_MS,
  MAX_SAYS,
  MAX_CHATS,
  MAX_VIDEOS,
  windowOf,
  collectMaterial,
  isEmpty,
  coreOf,
  dedupeSays,
  groupSays,
  stamp,
  estimateTokens,
  trimChats,
  materialText,
}
