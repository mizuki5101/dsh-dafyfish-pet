'use strict'
// 「回应模式」的聊天记忆。
//
// 为什么需要它：心跳是一轮一轮的独立请求（只带最近 3 句 + 情境），没有完整对话；
// 而「回应模式」是主人真的在跟她聊天，必须记住上下文 —— 否则每次回话都像第一次见面。
//
// 存储：%APPDATA%/DS-WhaleGirl-Pet/heart/chat.json，只留最近 maxTurns 轮，纯文本。

const fs = require('node:fs')
const path = require('node:path')

const CHAT_SYSTEM = [
  '你是桌面宠物「大肥鱼」，正在和主人聊天。',
  '人设：爱吃白饭；绝对不接受被叫胖；说话短、口语、第一人称，称呼对方「主人」。',
  '只回 1~2 句，不要 markdown、不要解释自己是谁；可以吐槽、可以问问题。',
].join('\n')

function createChatMemory(opts) {
  const o = opts || {}
  const file = o.file
  const maxTurns = Math.max(1, Number(o.maxTurns) || 12)
  const maxMessages = maxTurns * 2
  let messages = []

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (j && Array.isArray(j.messages)) {
        messages = j.messages
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .slice(-maxMessages)
      }
    } catch (e) {}
    return messages
  }
  load()

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ updatedAt: Date.now(), messages }, null, 1))
    } catch (e) {}
  }

  function add(role, text) {
    const t = String(text == null ? '' : text).trim()
    if (!t) return
    messages.push({ role, content: t.slice(0, 500) })
    if (messages.length > maxMessages) messages = messages.slice(-maxMessages)
    save()
  }

  return {
    file,
    messages: () => messages.slice(),
    add,
    clear() {
      messages = []
      save()
    },
    size: () => messages.length,
  }
}

module.exports = { CHAT_SYSTEM, createChatMemory }
