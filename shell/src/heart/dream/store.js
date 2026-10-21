'use strict'
// 「肥鱼日记」的文件读写（依赖 fs；纯逻辑在 toMd.js）。
//
// 目录策略：默认 %APPDATA%/DS-WhaleGirl-Pet/肥鱼日记，允许在「做梦」面板里改（存 settings.json → heart.dream.dir）。
// 一个文件一天：同一天睡几次都追加到同一个 .md，靠 `## HH:MM · 第 N 次小睡` 分段。

const fs = require('node:fs')
const path = require('node:path')
const { dayFileName, dayHeader, sectionCount, renderSection } = require('./toMd')

/** 配置里的路径（可能是空的）→ 真正要用的目录 */
function resolveDir(cfgDir, fallback) {
  const s = String(cfgDir == null ? '' : cfgDir).trim()
  return s || String(fallback || '').trim()
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    return true
  } catch (e) {
    return false
  }
}

function fileOf(dir, at) {
  return path.join(dir, dayFileName(at))
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (e) {
    return ''
  }
}

/** 原子写：先写 .tmp 再 rename（Windows 被占用时退化成直接写） */
function writeText(file, text) {
  const tmp = file + '.tmp-' + process.pid
  try {
    fs.writeFileSync(tmp, text)
  } catch (e) {
    return false
  }
  try {
    fs.renameSync(tmp, file)
    return true
  } catch (e) {
    try {
      fs.writeFileSync(file, text)
      try { fs.unlinkSync(tmp) } catch (e2) {}
      return true
    } catch (e3) {
      try { fs.unlinkSync(tmp) } catch (e4) {}
      return false
    }
  }
}

/** 今天已经写的日记正文（尾部 maxChars 字，喂给模型避免复读） */
function todayText(dir, at, maxChars) {
  const t = readText(fileOf(dir, at))
  const cap = Math.max(200, Number(maxChars) || 1200)
  return t.length > cap ? t.slice(-cap) : t
}

/** 最近 days 天里每一段的小标题（`**head**` 行） */
function recentHeads(dir, at, days) {
  const n = Math.max(0, Number(days) || 3)
  const out = []
  for (let i = 1; i <= n; i++) {
    const txt = readText(fileOf(dir, Number(at) - i * 86400000))
    if (!txt) continue
    for (const line of txt.split('\n')) {
      const m = /^\*\*(.+)\*\*\s*$/.exec(line)
      if (m && m[1].trim()) out.push(m[1].trim().slice(0, 30))
    }
  }
  return out.slice(-8)
}

/**
 * 追加一次做梦。
 * @returns {{ok:boolean, file?:string, n?:number, error?:string}}
 */
function appendDream(dir, at, dream) {
  if (!ensureDir(dir)) return { ok: false, error: 'mkdir-failed: ' + dir }
  const file = fileOf(dir, at)
  const old = readText(file)
  const n = sectionCount(old) + 1
  const sec = renderSection(dream, at, n)
  if (!sec) return { ok: false, error: 'empty-section' }
  const body = (old.trim() ? old.replace(/\s+$/, '') + '\n\n' : dayHeader(at) + '\n') + sec
  if (!writeText(file, body)) return { ok: false, error: 'write-failed: ' + file }
  return { ok: true, file, n }
}

/** 一天里已经写了几段（面板状态行用） */
function countToday(dir, at) {
  return sectionCount(readText(fileOf(dir, at)))
}

module.exports = { resolveDir, ensureDir, fileOf, readText, writeText, todayText, recentHeads, appendDream, countToday }
