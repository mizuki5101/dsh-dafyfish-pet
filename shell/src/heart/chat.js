'use strict'
// 「回应模式」的聊天记忆。
//
// 为什么需要它：心跳是一轮一轮的独立请求（只带最近 3 句 + 情境），没有完整对话；
// 而「回应模式」是主人真的在跟她聊天，必须记住上下文 —— 否则每次回话都像第一次见面。
//
// 存储：%APPDATA%/DS-WhaleGirl-Pet/heart/chat.json
//
// 2026-10-19 起：**按 token 预算裁，不再按固定轮数**。
//   · 12 轮对短对话太紧（用户反馈「不太够用」）；
//   · 但也不能无限长：前缀缓存命中时增量很便宜，**首次/换模型**仍按全量 prefill
//     （本机 9B 实测 977 tok/s），所以留一个预算上限；
//   · 默认 16384 token，至少保留 minTurns 轮（防止一条超长消息把历史清空）；
//   · 可选 maxTurns 硬上限，仅为兼容旧调用/测试。
//
// 估算用字符数而不是 tokenizer：中文 1 字≈1 token、英文 4 字符≈1 token，
// 这个精度足够决定「该不该裁」，不值得为它引一个分词器依赖。

const fs = require('node:fs')
const path = require('node:path')

const CHAT_SYSTEM = [
  '你是桌面宠物「大肥鱼」，正在和主人聊天。',
  '人设：爱吃白饭；绝对不接受被叫胖；说话短、口语、第一人称，称呼对方「主人」。',
  '只回 1~2 句，不要 markdown、不要解释自己是谁；可以吐槽、可以问问题。',
].join('\n')

const DEFAULT_MAX_TOKENS = 16384
const DEFAULT_MIN_TURNS = 6
/** 每条消息的角色/格式开销（近似） */
const MSG_OVERHEAD = 4

const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/

/** 粗估 token 数：中日韩字符按 1，其余按 4 字符 = 1 */
function estimateTokens(text) {
  const s = String(text == null ? '' : text)
  if (!s) return MSG_OVERHEAD
  let cjk = 0
  for (const ch of s) if (CJK.test(ch)) cjk++
  return Math.ceil(cjk + (s.length - cjk) / 4) + MSG_OVERHEAD
}

/**
 * 裁剪历史（纯函数）。
 *
 * 从**最新**往旧累加，超过预算且已经保留够 minTurns 轮就在那一轮的 user 处截断 ——
 * 所以裁完的第一条一定是 user，不会出现「有回答没有提问」的半截对话。
 *
 * @param {Array} list  [{role, content}]
 * @param {{maxTokens?:number, minTurns?:number, maxTurns?:number}} opts
 */
function trimMessages(list, opts) {
  const o = opts || {}
  const maxTokens = Math.max(256, Number(o.maxTokens) || DEFAULT_MAX_TOKENS)
  const minTurns = Math.max(1, Number(o.minTurns) || DEFAULT_MIN_TURNS)
  const maxTurns = Number(o.maxTurns) > 0 ? Math.max(1, Number(o.maxTurns)) : 0

  let arr = (Array.isArray(list) ? list : []).filter(
    (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim(),
  )
  if (maxTurns > 0) arr = arr.slice(-maxTurns * 2)

  let total = 0
  let turns = 0
  let cut = 0
  for (let i = arr.length - 1; i >= 0; i--) {
    total += estimateTokens(arr[i].content)
    if (arr[i].role === 'user') turns++
    if (total > maxTokens && turns >= minTurns) {
      cut = i
      break
    }
  }
  return arr.slice(cut)
}

/**
 * @param {{file?:string, maxTokens?:number, minTurns?:number, maxTurns?:number}} opts
 */
function createChatMemory(opts) {
  const o = opts || {}
  const file = o.file
  const maxTokens = Math.max(256, Number(o.maxTokens) || DEFAULT_MAX_TOKENS)
  const minTurns = Math.max(1, Number(o.minTurns) || DEFAULT_MIN_TURNS)
  const maxTurns = Number(o.maxTurns) > 0 ? Math.max(1, Number(o.maxTurns)) : 0
  let messages = []

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ updatedAt: Date.now(), messages }, null, 1))
    } catch (e) {}
  }

  function trim() {
    messages = trimMessages(messages, { maxTokens, minTurns, maxTurns })
  }

  function load() {
    let before = 0
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (j && Array.isArray(j.messages)) {
        messages = j.messages.filter(
          (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
        )
        before = messages.length
      }
    } catch (e) {}
    // 旧版本把心跳独白也写成 assistant（main.js 的 onAction），历史开头会留一串
    // 「有答无问」的条目 —— 它们不是真实对话，直接丢掉（只丢第一条 user 之前那段）。
    const firstUser = messages.findIndex((m) => m.role === 'user')
    if (firstUser < 0) messages = []
    else if (firstUser > 0) messages = messages.slice(firstUser)
    trim()
    // 裁过头了就顺手落盘，别让文件里一直躺着用不到的旧轮次
    if (messages.length !== before) save()
    return messages.slice()
  }

  /**
   * @param {string} role 'user' | 'assistant'
   * @param {string} text
   * @param {number} [at] epoch 毫秒。2026-10-21 起每条消息都带时间戳 ——
   *   「做梦」要按「上次醒来 → 这次睡着」的窗口取对话。旧文件里的条目没有 at，
   *   做梦那边会当成「窗口外」跳过（无法判断，宁可不记）。
   */
  function add(role, text, at) {
    const t = String(text == null ? '' : text).trim()
    if (!t) return
    const when = Number(at) > 0 ? Math.round(Number(at)) : Date.now()
    messages.push({ role, content: t.slice(0, 2000), at: when })
    trim()
    save()
  }

  load()

  return {
    file,
    maxTokens,
    minTurns,
    messages: () => messages.slice(),
    add,
    clear() {
      messages = []
      save()
    },
    size: () => messages.length,
    /** 当前历史粗估 token（面板/调试用） */
    tokens: () => messages.reduce((n, m) => n + estimateTokens(m.content), 0),
  }
}

module.exports = {
  CHAT_SYSTEM,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MIN_TURNS,
  estimateTokens,
  trimMessages,
  createChatMemory,
}
