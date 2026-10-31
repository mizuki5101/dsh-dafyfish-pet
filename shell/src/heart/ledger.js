'use strict'
// 「经历流水」ledger —— 她所有「说过 / 看过 / 答过 / 刷过视频 / 写过日记」的 append-only 底账
// （2026-10-31，接云端 API 连续上下文改造的第一块地基）
//
// 为什么要有它：以前六个调用点各拼各的上下文——嘀咕只留 12 条滚动（memo.json）、
// 心跳台词不进 chat.json、识图答完即焚——一句话没被当场看见就永远没了。
// ledger 是唯一事实源：
//   · 所有调用点只管往里写（record），要上下文时按预算取窗口；
//   · 渲染成对话轮**只追加不重写** ⇒ 相邻请求共享越来越长的公共前缀
//     ⇒ DeepSeek 的自动前缀缓存（命中约 1/10 价）与本地 llama-server 的 KV cache 都吃到；
//   · 窗口到预算时**整块换出**（对齐到天边界），不逐条滑动——逐条滑动会让每条新消息
//     都把前缀往左挪一格，缓存永远全失效；按天对齐把失效摊薄成「一天最多一次」。
//
// 存储：%APPDATA%/DS-WhaleGirl-Pet/heart/ledger.jsonl —— 一行一条 JSON（NDJSON）。
//   追加 = appendFileSync 一行，天然顺序写；prune 时整文件重写（低频，tmp+rename 原子换）。
//   坏行（手改坏/写到一半断电）跳过不炸。
//
// kind 一览（ROLE_OF 决定渲染成「谁」说的话）：
//   say        心跳嘀咕（她主动说的）      → assistant（不加前缀，就是她说的话）
//   chat-user  回应模式主人说的话          → user
//   chat-her   回应模式她说的              → assistant
//   see        识图第一跳「看到什么」      → user（环境侧信息：屏幕上有过什么）
//   answer     答题的答案                  → assistant
//   bili       刷视频的一句话摘要          → user（「她看完了一个视频」是环境给她的输入）
//   dream      写了日记（只记一行标题）    → assistant

const fs = require('node:fs')
const path = require('node:path')
const { estimateTokens } = require('./chat')

const KINDS = ['say', 'chat-user', 'chat-her', 'see', 'answer', 'bili', 'dream']
const ROLE_OF = {
  say: 'assistant',
  'chat-user': 'user',
  'chat-her': 'assistant',
  see: 'user',
  answer: 'assistant',
  bili: 'user',
  dream: 'assistant',
}
/** user 侧条目的前缀：让模型分得清「这是主人说的」还是「环境里发生的」 */
const LABEL_OF = {
  'chat-user': '主人：',
  see: '【她看了屏幕】',
  bili: '【她看完视频】',
  dream: '【她记了日记】',
}
/** 摘要里用的 kind 中文名（digestPastDays） */
const KIND_ZH = {
  say: '嘀咕', 'chat-user': '主人说', 'chat-her': '她说',
  see: '看到', answer: '答题', bili: '看视频', dream: '日记',
}

const MAX_TEXT = 2000

function pad2(n) {
  return String(n).padStart(2, '0')
}
/** 本地日界（摘要的「天」按主人时区算，不按 UTC） */
function dayKey(at) {
  const d = new Date(at)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

/**
 * 一条流水准入：kind 合法、text 非空（截到 2000）、at 是数字。
 * @returns {{at:number, kind:string, text:string, meta?:object}|null} 不合法返回 null
 */
function normalizeEntry(kind, text, opts) {
  const o = opts || {}
  const k = String(kind || '')
  if (!KINDS.includes(k)) return null
  const t = String(text == null ? '' : text).trim()
  if (!t) return null
  const at = Number(o.at) > 0 ? Math.round(Number(o.at)) : Date.now()
  const e = { at, kind: k, text: t.slice(0, MAX_TEXT) }
  if (o.meta && typeof o.meta === 'object') e.meta = o.meta
  return e
}

/**
 * 清理：丢过期 + 超 maxEntries 从最旧丢。保持时间序（调用方保证入序，这里不排序——
 * append-only 文件天然有序，排序反而会把手改的乱序藏掉）。
 */
function pruneEntries(entries, opts) {
  const o = opts || {}
  const now = Number(o.now) > 0 ? Number(o.now) : Date.now()
  const maxAgeDays = Math.max(1, Number(o.maxAgeDays) || 30)
  const maxEntries = Math.max(50, Number(o.maxEntries) || 5000)
  const floor = now - maxAgeDays * 86400000
  const fresh = (entries || []).filter((e) => e && Number(e.at) > 0 && Number(e.at) >= floor)
  return fresh.length > maxEntries ? fresh.slice(fresh.length - maxEntries) : fresh
}

/** 单条 → 一条对话轮（user 侧带前缀）。不产空轮。 */
function entryTurn(e) {
  if (!e || !ROLE_OF[e.kind]) return null
  const label = ROLE_OF[e.kind] === 'user' ? LABEL_OF[e.kind] || '' : ''
  const content = (label ? label : '') + String(e.text || '').trim()
  if (!content.trim()) return null
  return { role: ROLE_OF[e.kind], content }
}

/** 流水 → 对话轮：**一条流水一条消息，绝不合并相邻同角色**。
 *  为什么不合并：她连说两句话时，新的一句若是追加进同一条消息，那条消息的内容
 *  就变了——前缀从那里作废，而且她话越密失效越频繁。一比一映射才是严格的
 *  只追加性（DeepSeek / llama.cpp 都接受连续同角色消息，实测无碍）。 */
function renderTurns(entries) {
  const turns = []
  for (const e of entries || []) {
    const t = entryTurn(e)
    if (t) turns.push(t)
  }
  return turns
}

/**
 * 按预算从**最新**往回取窗口，然后把窗口起点对齐到**日界**（较新那天的第一条）。
 *
 * 为什么对齐：预算切在哪，窗口起点就在哪；起点逐条漂移 = 前缀缓存永远全失效。
 * 对齐到天后，「这批旧内容」会在窗口里完整停留到被整体换出，失效一天最多一次。
 * 单日内容超预算时对齐不了，就按原切点（至少保住最新一条，窗口永不为空）。
 *
 * @param {Array} entries 时间升序的流水
 * @param {{budgetTokens?:number, estimateTokens?:Function}} opts
 */
function pickWindow(entries, opts) {
  const o = opts || {}
  const est = typeof o.estimateTokens === 'function' ? o.estimateTokens : estimateTokens
  const budget = Math.max(256, Number(o.budgetTokens) || 2048)
  // excludeKinds：回应模式的对话轮有 chat.json 自己的窗口，ledger 里那份要排除，否则同一段
  // 对话在请求里出现两次（一次在 ledger 窗口、一次在 chat 历史）
  const excl = Array.isArray(o.excludeKinds) ? o.excludeKinds : null
  const arr = (entries || []).filter((e) => e && (!excl || !excl.includes(e.kind)))
  if (!arr.length) return []

  let total = 0
  let start = arr.length
  for (let i = arr.length - 1; i >= 0; i--) {
    const t = entryTurn(arr[i])
    total += t ? est(t.content) : 0
    if (total > budget) break
    start = i
  }
  if (start >= arr.length) start = arr.length - 1 // 最新一条自己就超预算：至少保住它，窗口永不为空
  // 日界对齐（只在**真的发生过裁剪**时做）：预算切在哪，起点就往前推进到最近的天边界，
  // 让「最旧那天」整块进/整块出。预算装得下全部（start=0）时绝不动——否则会把装得下的
  // 旧内容也白白扔掉，还每次都扔（实测踩过：8 条全装得下却被对齐到只剩 3 条）。
  if (start > 0) {
    for (let j = start + 1; j < arr.length; j++) {
      if (dayKey(arr[j].at) !== dayKey(arr[j - 1].at)) {
        start = j
        break
      }
    }
  }
  return arr.slice(start)
}

/**
 * 远期摘要（确定性 v1，不调模型）：到**昨天**为止的流水，按天拼成紧凑文本。
 * 只含昨天以前 ⇒ 一天之内内容不变 ⇒ 挂在前缀里不会打碎缓存；
 * 今天的动态全走追加式窗口。以后可升级成模型写的摘要（接在 context.js 里）。
 * @param {{days?:number, perDayCap?:number, now?:number}} opts
 * @returns {string} 没有内容返回 ''
 */
function digestPastDays(entries, opts) {
  const o = opts || {}
  const now = Number(o.now) > 0 ? Number(o.now) : Date.now()
  const days = Math.max(1, Math.min(7, Number(o.days) || 3))
  const perDayCap = Math.max(1, Number(o.perDayCap) || 10)
  const today = dayKey(now)
  const buckets = new Map()
  for (const e of entries || []) {
    if (!e || Number(e.at) <= 0) continue
    const k = dayKey(e.at)
    if (k === today) continue
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(e)
  }
  const lines = []
  for (let d = 1; d <= days; d++) {
    const day = new Date(now - d * 86400000)
    const k = dayKey(day.getTime())
    const list = buckets.get(k) || []
    if (!list.length) continue
    const dateLabel = k.slice(5)
    for (const e of list.slice(0, perDayCap)) {
      const t = String(e.text || '').replace(/\s+/g, ' ').slice(0, 80)
      const zh = KIND_ZH[e.kind] || e.kind
      lines.push(dateLabel + ' ' + zh + '：' + t)
    }
    if (list.length > perDayCap) lines.push(dateLabel + ' …还有 ' + (list.length - perDayCap) + ' 条没列出来')
  }
  return lines.join('\n')
}

/** 校验一行 JSON 是不是像样的流水条目（load 时挡坏行） */
function entryLike(j) {
  return j && KINDS.includes(j.kind) && typeof j.text === 'string' && Number(j.at) > 0
}

/**
 * 落盘编排：内存数组 + JSONL 追加写 + 低频 prune。
 * @param {{file:string, maxAgeDays?:number, maxEntries?:number, log?:Function}} opts
 */
function createLedger(opts) {
  const o = opts || {}
  if (!o.file) throw new Error('ledger: file is required')
  const file = o.file
  const log = typeof o.log === 'function' ? o.log : () => {}
  const maxAgeDays = Math.max(1, Number(o.maxAgeDays) || 30)
  const maxEntries = Math.max(50, Number(o.maxEntries) || 5000)
  let entries = []
  let sincePrune = 0
  let fileExisted = false

  function load() {
    try {
      fileExisted = fs.existsSync(file)
      const raw = fs.readFileSync(file, 'utf8')
      const list = []
      for (const line of raw.split('\n')) {
        const s = line.trim()
        if (!s) continue
        try {
          const j = JSON.parse(s)
          if (entryLike(j)) list.push(j)
        } catch (e) {
          // 坏行跳过：一行坏不连坐整个文件
        }
      }
      entries = list
    } catch (e) {
      entries = []
    }
  }

  function rewrite() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''))
      fs.renameSync(tmp, file)
      fileExisted = true
    } catch (e) {
      log('ledger 重写失败：' + (e && e.message))
    }
  }

  function prune() {
    const kept = pruneEntries(entries, { now: Date.now(), maxAgeDays, maxEntries })
    if (kept.length !== entries.length) {
      log('ledger 清理：' + entries.length + ' → ' + kept.length)
      entries = kept
      rewrite()
    }
    sincePrune = 0
  }

  function record(kind, text, meta, at) {
    const e = normalizeEntry(kind, text, { at, meta })
    if (!e) return null
    entries.push(e)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, JSON.stringify(e) + '\n')
      fileExisted = true
    } catch (err) {
      log('ledger 写入失败：' + (err && err.message))
    }
    // prune 不必每次：攒一批再做（重写整个文件）
    if (++sincePrune >= 100) prune()
    return e
  }

  load()
  // 启动时清一次过期（隔夜跑 prune 的兜底）
  if (entries.length) {
    const kept = pruneEntries(entries, { now: Date.now(), maxAgeDays, maxEntries })
    if (kept.length !== entries.length) {
      entries = kept
      rewrite()
    }
  }

  return {
    file,
    record,
    /** 按预算取追加式窗口（见 pickWindow） */
    window: (opts2) => pickWindow(entries, opts2),
    all: () => entries.slice(),
    prune,
    clear() {
      entries = []
      rewrite()
    },
    size: () => entries.length,
    /** 文件在 createLedger 打开时是否已存在（main.js 用来判断「要不要一次性回填旧记忆」） */
    existed: () => fileExisted,
  }
}

module.exports = {
  KINDS,
  ROLE_OF,
  LABEL_OF,
  KIND_ZH,
  MAX_TEXT,
  normalizeEntry,
  pruneEntries,
  entryTurn,
  renderTurns,
  pickWindow,
  digestPastDays,
  entryLike,
  createLedger,
}
