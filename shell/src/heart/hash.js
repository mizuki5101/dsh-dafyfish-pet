'use strict'
// 屏幕指纹（纯函数，不依赖 electron —— 这样可以在纯 Node 里单测）。
//
// 输入约定：Electron NativeImage.toBitmap() 的缓冲，BGRA、每像素 4 字节、行优先。
// 为什么要指纹：心跳每 60 秒「看」一次屏幕，如果画面根本没变，这次调用就是白烧 GPU。
// dHash 对缩放/JPEG 压缩不敏感，只需要 64 次相邻比较；逐像素比对上百万次没必要。
//
// 注意：Windows 上通道顺序是 B,G,R,A。dHash 只比较相邻亮度，通道顺序不影响结果；
// meanLuma 的权重按 BGR 取，通道反了误差也很小（只用来判断「是不是黑图」）。

function grayAt(buf, width, x, y) {
  const i = (y * width + x) * 4
  const b = buf[i]
  const g = buf[i + 1]
  const r = buf[i + 2]
  return 0.114 * b + 0.587 * g + 0.299 * r
}

/** 9x8 采样 → 8 行 × 8 位 = 16 位十六进制。图太小返回 null。 */
function dHash(buf, width, height) {
  if (!buf || !width || !height || width < 9 || height < 8) return null
  if (buf.length < width * height * 4) return null
  const pts = []
  for (let gy = 0; gy < 8; gy++) {
    const y = Math.min(height - 1, Math.floor(((gy + 0.5) * height) / 8))
    for (let gx = 0; gx < 9; gx++) {
      const x = Math.min(width - 1, Math.floor(((gx + 0.5) * width) / 9))
      pts.push(grayAt(buf, width, x, y))
    }
  }
  let hex = ''
  for (let row = 0; row < 8; row++) {
    let byte = 0
    for (let col = 0; col < 8; col++) {
      const a = pts[row * 9 + col]
      const b = pts[row * 9 + col + 1]
      byte = (byte << 1) | (b > a ? 1 : 0)
    }
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/** 平均亮度（0~255）。大图按步长采样，最多 4096 个点。 */
function meanLuma(buf, width, height) {
  if (!buf || !width || !height) return 0
  const total = width * height
  if (!total) return 0
  const step = Math.max(1, Math.floor(total / 4096))
  let sum = 0
  let n = 0
  for (let p = 0; p < total; p += step) {
    const i = p * 4
    if (i + 2 >= buf.length) break
    sum += 0.114 * buf[i] + 0.587 * buf[i + 1] + 0.299 * buf[i + 2]
    n++
  }
  return n ? sum / n : 0
}

/** 两张 dHash 的汉明距离（0~64）。任一侧无效时返回 64 =「当作完全不同」。 */
function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 64
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    if (Number.isNaN(x)) return 64
    while (x) {
      d += x & 1
      x >>= 1
    }
  }
  return d
}

/** 平均亮度低于 3 → 多半是驱动/采集失败的全黑图（不能当「主人不在」） */
function looksBlack(luma) {
  return !Number.isFinite(luma) || luma < 3
}

module.exports = { dHash, meanLuma, hamming, looksBlack }
