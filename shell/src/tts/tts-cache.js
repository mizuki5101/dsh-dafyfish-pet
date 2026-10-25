'use strict'
// 合成结果的磁盘缓存。
//
// 为什么要有：心跳会复读（同一句话隔几轮又说一遍）、待机台词也是池子里挑的 ——
// 命中缓存 = 零合成成本零延迟。键 = 配置 + 文本 的 SHA-256（截 32 位 hex）；配置任何一项变了
// （换参考音频 / 换语速 / 换后端）键就变，不会串音。
//
// 安全：文件名永远是自己算出来的 32 位 hex（SHA-256 截断），页面拿到的 URL 也只有这种形状。
// petserver 的路由用 isTtsFileName() 做白名单，路径穿越根本进不来。

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

/** 上一轮默认上限（条）。一条 50 字台词的 wav 约 200~500KB，200 条 ≈ 100MB 封顶。 */
const CACHE_MAX = 200

/** 缓存文件名白名单（petserver 路由用同一个函数，别在两处各写一份正则）。 */
function isTtsFileName(name) {
  return /^[0-9a-f]{32}\.wav$/.test(String(name || ''))
}

/** 稳定缓存键：只取影响声音的字段，apiKey/baseUrl 里易变的部分不进键
 *  （baseUrl 变了重新合成一次没坏处，但 key 里放 apiKey 会在磁盘上留下可辨识痕迹）。 */
function cacheKey(cfg, text) {
  const c = cfg && typeof cfg === 'object' ? cfg : {}
  const basis = JSON.stringify({
    backend: c.backend || '',
    model: c.model || '',
    voice: c.voice || '',
    ref: c.refAudioPath || '',
    prompt: c.promptText || '',
    speed: Number(c.speed) || 1,
    text: String(text == null ? '' : text),
  })
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 32)
}

function cachePath(dir, key) {
  return path.join(dir, key + '.wav')
}

function cacheHas(dir, key) {
  try {
    const s = fs.statSync(cachePath(dir, key))
    // 小于 44 字节连 WAV 头都装不下，当不存在
    return s.isFile() && s.size > 44
  } catch (e) {
    return false
  }
}

function cacheSave(dir, key, buf) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(cachePath(dir, key), buf)
    return true
  } catch (e) {
    return false
  }
}

/** LRU 清理：按 mtime 留最新的 max 条。返回删了几条。 */
function pruneCache(dir, max) {
  const cap = Math.max(10, Number(max) || CACHE_MAX)
  let entries = []
  try {
    entries = fs
      .readdirSync(dir)
      .filter((n) => isTtsFileName(n))
      .map((n) => {
        const p = path.join(dir, n)
        try {
          return { p, m: fs.statSync(p).mtimeMs }
        } catch (e) {
          return null
        }
      })
      .filter(Boolean)
  } catch (e) {
    return 0
  }
  if (entries.length <= cap) return 0
  entries.sort((a, b) => b.m - a.m)
  let removed = 0
  for (const e of entries.slice(cap)) {
    try {
      fs.unlinkSync(e.p)
      removed++
    } catch (e2) {}
  }
  return removed
}

function countCache(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => isTtsFileName(n)).length
  } catch (e) {
    return 0
  }
}

/** 页面拿到的同源 URL（petserver 的 /dsh-pet/tts/ 路由）。 */
function cacheUrl(key) {
  return '/dsh-pet/tts/' + key + '.wav'
}

module.exports = { CACHE_MAX, isTtsFileName, cacheKey, cachePath, cacheHas, cacheSave, pruneCache, countCache, cacheUrl }
