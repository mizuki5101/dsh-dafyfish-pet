'use strict'
// 截图遮罩（纯函数，可单测）。
//
// 为什么要遮：2026-10-18 实测 desktopCapturer **会**把她自己拍进去
// （_research-data/_shots/heart-p0-desktopcapturer.jpg 右下角就是她）。
// 不遮的话模型会看见「一条鱼在屏幕上盯着自己」，判断和台词都会跑偏；
// 气泡、dock、面板上的文字也会混进画面。
//
// 坐标：输入是「屏幕 DIP」（Electron 的 display.size / getContentBounds 单位），
// 输出是截图像素。中间用两张图的尺寸比换算，不假设 DPR=1（本机 DPR=1.5）。

/** 屏幕 DIP 矩形 → 截图像素矩形（含 pad 像素外扩，并夹到图内）。无效返回 null。 */
function toImageRect(rect, display, imgW, imgH, pad) {
  if (!rect || !display || !imgW || !imgH) return null
  const dw = Number(display.width)
  const dh = Number(display.height)
  if (!(dw > 0) || !(dh > 0)) return null
  const sx = imgW / dw
  const sy = imgH / dh
  const p = Math.max(0, Number(pad) || 0)
  const x0 = Math.floor((Number(rect.x) - Number(display.x || 0)) * sx) - p
  const y0 = Math.floor((Number(rect.y) - Number(display.y || 0)) * sy) - p
  const x1 = Math.ceil((Number(rect.x) - Number(display.x || 0) + Number(rect.w)) * sx) + p
  const y1 = Math.ceil((Number(rect.y) - Number(display.y || 0) + Number(rect.h)) * sy) + p
  const x = Math.max(0, Math.min(imgW, x0))
  const y = Math.max(0, Math.min(imgH, y0))
  const w = Math.max(0, Math.min(imgW, x1) - x)
  const h = Math.max(0, Math.min(imgH, y1) - y)
  if (w < 1 || h < 1) return null
  return { x, y, w, h }
}

/** 在 BGRA 缓冲上填一块灰（R=G=B=value，A 保持 255）。返回改了多少像素。 */
function fillRect(buf, width, height, rect, value) {
  if (!buf || !width || !height || !rect) return 0
  const v = Math.max(0, Math.min(255, Math.round(Number(value) == null ? 128 : Number(value))))
  const x0 = Math.max(0, Math.floor(rect.x))
  const y0 = Math.max(0, Math.floor(rect.y))
  const x1 = Math.min(width, Math.floor(rect.x + rect.w))
  const y1 = Math.min(height, Math.floor(rect.y + rect.h))
  if (x1 <= x0 || y1 <= y0) return 0
  let n = 0
  for (let y = y0; y < y1; y++) {
    let i = (y * width + x0) * 4
    for (let x = x0; x < x1; x++) {
      buf[i] = v
      buf[i + 1] = v
      buf[i + 2] = v
      buf[i + 3] = 255
      i += 4
      n++
    }
  }
  return n
}

/** 一次遮多块（并集），返回 { rects, pixels } */
function maskImage(buf, width, height, rects, value) {
  const out = []
  let pixels = 0
  for (const r of rects || []) {
    const n = fillRect(buf, width, height, r, value)
    if (n > 0) {
      out.push(r)
      pixels += n
    }
  }
  return { rects: out, pixels }
}

/**
 * 从 BGRA 大图里裁一块出来（2026-10-22，「识图」的区域截图用）。
 *
 * 为什么不用 nativeImage.crop：capture.js 里的位图是 `img.toBitmap()` 拿到的裸 BGRA 缓冲，
 * 裁剪后再 `createFromBitmap` 比"转成 nativeImage → crop → toJPEG"少一次拷贝，
 * 而且这段是纯函数，DPR 1 / 1.5 / 2 的换算能在 node 里直接断言。
 *
 * 返回 { buf, w, h } 或 null（rect 无效 / 完全在图外）。
 */
function cropBitmap(buf, width, height, rect) {
  if (!buf || !width || !height || !rect) return null
  const x0 = Math.max(0, Math.floor(Number(rect.x)))
  const y0 = Math.max(0, Math.floor(Number(rect.y)))
  const x1 = Math.min(width, Math.floor(Number(rect.x) + Number(rect.w)))
  const y1 = Math.min(height, Math.floor(Number(rect.y) + Number(rect.h)))
  const w = x1 - x0
  const h = y1 - y0
  if (!(w > 0) || !(h > 0)) return null
  const out = Buffer.allocUnsafe(w * h * 4)
  const srcStride = width * 4
  const dstStride = w * 4
  for (let y = 0; y < h; y++) {
    const from = (y0 + y) * srcStride + x0 * 4
    buf.copy(out, y * dstStride, from, from + dstStride)
  }
  return { buf: out, w, h }
}

module.exports = { toImageRect, fillRect, maskImage, cropBitmap }
