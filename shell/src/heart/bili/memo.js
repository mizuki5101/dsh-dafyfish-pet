'use strict'
// 「她看过哪些视频」的落盘记忆。
//
// 为什么要独立一个文件、不复用 heart/memo.js：
//   memo.json 存的是**她主动搭话的台词**（say 限 80 字、topic 限 30 字），
//   而这里要存的是「BV + 标题 + 一句话概括」，字段和长度都不兼容。
//   混在一起会让 memo 的判重逻辑（最近 6 句）被视频标题污染。
//
// 这份记忆有两个用处：
//   ① 防重复推荐 —— 同一 BV 不再推（除非过期很久）；
//   ② 喂给粗筛 —— 「我最近看过这些」能让筛选更像「她自己的口味」。

const fs = require('node:fs')
const path = require('node:path')

const MAX_ENTRIES = 40
const MAX_TITLE = 60
const MAX_ONE = 120

function clean(v, n) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n)
}

function sanitizeEntry(e) {
  if (!e || typeof e !== 'object') return null
  const bvid = clean(e.bvid, 16)
  if (!/^BV[0-9A-Za-z]{8,}$/.test(bvid)) return null
  return {
    at: Number(e.at) > 0 ? Number(e.at) : 0,
    bvid,
    title: clean(e.title, MAX_TITLE),
    up: clean(e.up, 24),
    one: clean(e.one, MAX_ONE),
    tier: clean(e.tier, 8),
  }
}

function normalize(list, max) {
  const n = Math.max(1, Number(max) || MAX_ENTRIES)
  return (Array.isArray(list) ? list : []).map(sanitizeEntry).filter(Boolean).slice(-n)
}

/**
 * @param {{file:string, max?:number, ttlDays?:number}} opts
 */
function createStore(opts) {
  const o = opts || {}
  const file = o.file
  const max = Math.max(1, Number(o.max) || MAX_ENTRIES)
  const ttlMs = Math.max(1, Number(o.ttlDays) || 14) * 86400000
  let entries = []

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      entries = normalize(j && j.entries, max)
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

  /** 最近看过（ttlDays 内）的 BV 集合 —— 判重只认这个窗口，不是永久拉黑 */
  function recentSet(now) {
    const t = Number(now) || Date.now()
    const s = new Set()
    for (const e of entries) if (!e.at || t - e.at <= ttlMs) s.add(e.bvid)
    return s
  }

  function add(entry, now) {
    const e = sanitizeEntry(Object.assign({}, entry, { at: (entry && entry.at) || Number(now) || Date.now() }))
    if (!e) return false
    entries = entries.filter((x) => x.bvid !== e.bvid)
    entries.push(e)
    entries = entries.slice(-max)
    save()
    return true
  }

  /** 喂给粗筛 prompt 的一行行摘要（新的在后） */
  function digest(n) {
    const k = Math.max(1, Number(n) || 6)
    return entries.slice(-k).map((e) => (e.up ? e.up + '：' : '') + e.title + (e.one ? '（' + e.one + '）' : ''))
  }

  load()

  return { file, entries: () => entries.slice(), recentSet, add, digest, reload: load }
}

module.exports = { createStore, sanitizeEntry, normalize, MAX_ENTRIES }
