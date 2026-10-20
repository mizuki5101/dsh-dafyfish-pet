'use strict'
// 按视频时长决定「看懂它」要花多少预算。
//
// 为什么要这个：2026-10-20 定方案时算过账 —— 5 张全屏帧约 6500 token，
// 光图片就超了 5000 的预算。所以帧数/宽度/字幕长度必须按时长动态收缩，
// 而不是拍一个固定的数。
//
// 换算依据（Qwen 系视觉编码）：一张图的 token ≈ (W/28)×(H/28)。
//   1280×800 ≈ 1300   640×360 ≈ 290
// 实测过一张 PNG：prompt_tokens=1543（含约 140 文本），与公式吻合。
//
// 纯函数，不碰网络不碰磁盘 —— 测试见 _research-data/测试刷视频.mjs。

/** 一小时 */
const HOUR = 3600

/**
 * 三档策略。
 *   full  —— ≤10 分钟：maxFrames 帧 + 字幕 3000 字
 *   mixed —— 10~40 分钟：maxFrames 帧 + 头尾字幕 2400 字（v1 只做前 10 分钟）
 *   light —— >40 分钟：最多 3 帧 + 只给标题简介和热评，明说「太长了只看开头」
 * @param {number} durationSec
 * @param {number} [maxFrames] 用户要的抽帧数（3~10，默认 3）。light 档最多用 3 ——
 *        两小时视频在前 5 分钟里抽 10 帧，多半是同一幕的近似重复，白烧 token。
 * @returns {{tier:string, frames:number[], frameWidth:number, subtitleChars:number, comments:number, readSec:number, note:string}}
 */
function plan(durationSec, maxFrames) {
  const d = Math.max(0, Number(durationSec) || 0)
  const mf = Math.max(3, Math.min(10, Math.round(Number(maxFrames) || 3)))
  if (d === 0) {
    // 时长未知（接口偶尔不给）：按最短路径走，别赌
    return { tier: 'light', frames: [0], frameWidth: 640, subtitleChars: 800, comments: 2, readSec: 0, note: '时长未知' }
  }
  if (d <= 600) {
    return { tier: 'full', frames: picks(d, mf), frameWidth: 640, subtitleChars: 3000, comments: 2, readSec: d, note: '' }
  }
  if (d <= 2400) {
    // v1 只读前 10 分钟：后面的内容靠字幕头尾补齐，不下载整段
    return { tier: 'mixed', frames: picks(600, mf), frameWidth: 640, subtitleChars: 2400, comments: 2, readSec: 600, note: '视频较长，只看了前 10 分钟' }
  }
  return { tier: 'light', frames: picks(300, Math.min(mf, 3)), frameWidth: 640, subtitleChars: 800, comments: 2, readSec: 300, note: '视频太长了，只看了开头一小段' }
}

/** 在 [0, span] 里均匀取 n 个时间点，避开 0 秒（常是黑场/片头）和末尾（常是关注引导） */
function picks(span, n) {
  const s = Math.max(1, Number(span) || 1)
  const k = Math.max(1, Number(n) || 1)
  const out = []
  for (let i = 0; i < k; i += 1) {
    const p = 0.12 + (0.72 * i) / Math.max(1, k - 1 || 1)
    out.push(Math.round(Math.min(s - 0.5, s * p)))
  }
  return out
}

/**
 * 字幕按预算裁：**不硬截断在半句**（会把结论切掉，而结论常在结尾）。
 *   · 够短 → 整段
 *   · 太长 → 头 60% + 尾 30%，中间用省略标记接起来
 * @param {string} text 已按句拼好的字幕
 * @param {number} maxChars
 */
function trimSubtitle(text, maxChars) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  const max = Math.max(100, Number(maxChars) || 3000)
  if (s.length <= max) return s
  const head = Math.floor(max * 0.6)
  const tail = Math.floor(max * 0.3)
  return s.slice(0, head) + ' ……（中间略）…… ' + s.slice(-tail)
}

/** 大概算一下这份素材值多少 token（只用于日志和预算告警，不追求精确） */
function estimateTokens(o) {
  const frames = Math.max(0, Number(o.frames) || 0)
  const w = Number(o.frameWidth) || 640
  const perFrame = Math.round(((w / 28) * (w * 0.5625 / 28)))
  const chars = Math.max(0, Number(o.chars) || 0)
  return { image: frames * perFrame, text: Math.ceil(chars * 0.75), total: frames * perFrame + Math.ceil(chars * 0.75) }
}

module.exports = { plan, picks, trimSubtitle, estimateTokens, HOUR }
