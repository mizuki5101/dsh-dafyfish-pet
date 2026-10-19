'use strict'
// 心跳的短期记忆：她**主动搭话**说过什么。
//
// 和「回应模式」的 chat.json 分工不同，别混：
//   · chat.json  = 主人跟她**对话**的上下文（user/assistant 成对，12 轮）
//   · memo.json  = 她每隔一两分钟**主动说**的那一句（带 topic/see/时间）
//
// 为什么必须落盘：原来 recentSays 只在内存里、只留 3 句，外壳一重启就清零。
// 2026-10-19 实测她在 30 秒内说了两遍一字不差的话（12125 / 12126），自己完全不知道。
//
// 上限 12 条：喂给提示词只用最近 3 句（见 prompt.buildMessages 的 recent），
// 判重看最近 6 句；再多只是占内存，对 2.4 秒一次的心跳没有帮助。

const fs = require('node:fs')
const path = require('node:path')

const MAX_ENTRIES = 12
const MAX_SAY = 80
const MAX_TOPIC = 30
const MAX_SEE = 16

/** 一条记忆：坏数据返回 null（读盘时直接扔掉，不抛） */
function sanitizeEntry(e) {
  if (!e || typeof e !== 'object') return null
  const say = String(e.say == null ? '' : e.say).replace(/\s+/g, ' ').trim().slice(0, MAX_SAY)
  if (!say) return null
  const at = Number(e.at)
  return {
    at: Number.isFinite(at) && at > 0 ? at : 0,
    say,
    topic: String(e.topic == null ? '' : e.topic).trim().slice(0, MAX_TOPIC),
    see: String(e.see == null ? '' : e.see).trim().slice(0, MAX_SEE),
  }
}

/** 纯函数：清洗 + 只留最近 max 条（旧 → 新，末尾最新） */
function normalizeList(list, max) {
  const n = Math.max(1, Number(max) || MAX_ENTRIES)
  return (Array.isArray(list) ? list : []).map(sanitizeEntry).filter(Boolean).slice(-n)
}

/** 纯函数：喂给提示词的最近几句台词（只要文本，新的在后面） */
function recentLines(list, n) {
  const k = Math.max(1, Number(n) || 3)
  return normalizeList(list, MAX_ENTRIES).map((e) => e.say).slice(-k)
}

/**
 * @param {{file?:string, max?:number}} opts
 */
function createMemo(opts) {
  const o = opts || {}
  const file = o.file
  const max = Math.max(1, Number(o.max) || MAX_ENTRIES)
  let entries = []

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      entries = normalizeList(j && j.entries, max)
    } catch (e) {
      entries = []
    }
    return entries.slice()
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ updatedAt: Date.now(), entries }, null, 1))
    } catch (e) {}
  }

  load()

  return {
    file,
    entries: () => entries.slice(),
    says: () => entries.map((e) => e.say),
    last: () => (entries.length ? Object.assign({}, entries[entries.length - 1]) : null),
    add(entry) {
      const e = sanitizeEntry(entry)
      if (!e) return null
      entries.push(Object.assign({}, e, { at: e.at || Date.now() }))
      if (entries.length > max) entries = entries.slice(-max)
      save()
      return e
    },
    clear() {
      entries = []
      save()
    },
    size: () => entries.length,
  }
}

module.exports = { MAX_ENTRIES, MAX_SAY, MAX_TOPIC, MAX_SEE, sanitizeEntry, normalizeList, recentLines, createMemo }
