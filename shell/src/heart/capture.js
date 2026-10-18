'use strict'
// 屏幕采集（只在 Electron 主进程里可用）。
//
// 为什么不用 PowerShell/GDI：① 要起子进程 ② 拿不到多屏/DPI 的可靠信息
// ③ GDI 那条路拍不到 transparent layered 窗口 —— 2026-10-18 实测：
//    GDI 截图里没有她，但 **desktopCapturer 里能拍到她**（见 _shots/heart-p0-desktopcapturer.jpg）。
//    所以「她自己」必须由调用方给出矩形、在这里涂掉，不能指望采集天然干净。
//
// 约定：只采主屏（默认决策 #5），长边缩到 maxEdge，返回 JPEG + dHash + 平均亮度。
// 遮罩发生在算指纹之前 —— 她挪位置不该被当成「屏幕内容变了」，否则门控会被自己的动画刷爆。

const { desktopCapturer, screen, nativeImage } = require('electron')
const { dHash, meanLuma, looksBlack } = require('./hash')
const { toImageRect, maskImage } = require('./mask')

async function captureScreen(opts) {
  const o = opts || {}
  const maxEdge = Math.max(320, Math.min(2560, Number(o.maxEdge) || 1280))
  const quality = Math.max(40, Math.min(95, Number(o.quality) || 72))
  const wantImage = o.includeImage === true
  const pad = Number.isFinite(Number(o.maskPad)) ? Math.max(0, Math.min(64, Number(o.maskPad))) : 6
  const t0 = Date.now()

  let display = null
  try {
    display = screen.getPrimaryDisplay()
  } catch (e) {
    return { ok: false, reason: 'no-display', error: String((e && e.message) || e), ms: Date.now() - t0 }
  }
  const size = display.size || { width: 1280, height: 720 }
  const dpr = Number(display.scaleFactor) || 1
  const scale = Math.min(1, maxEdge / Math.max(size.width * dpr, size.height * dpr))
  const reqW = Math.max(64, Math.round(size.width * dpr * scale))
  const reqH = Math.max(64, Math.round(size.height * dpr * scale))

  let sources = []
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: reqW, height: reqH },
      fetchWindowIcons: false,
    })
  } catch (e) {
    return { ok: false, reason: 'get-sources-failed', error: String((e && e.message) || e), ms: Date.now() - t0 }
  }
  if (!sources || !sources.length) return { ok: false, reason: 'no-source', ms: Date.now() - t0 }

  const pick = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0]
  const img = pick && pick.thumbnail
  if (!img || (typeof img.isEmpty === 'function' && img.isEmpty())) {
    return { ok: false, reason: 'empty-image', name: pick && pick.name, ms: Date.now() - t0 }
  }

  let bmp = null
  let dim = { width: 0, height: 0 }
  try {
    dim = img.getSize()
    bmp = img.toBitmap() // BGRA（Windows）
  } catch (e) {
    return { ok: false, reason: 'bitmap-failed', error: String((e && e.message) || e), ms: Date.now() - t0 }
  }

  // —— 遮罩：屏幕 DIP 矩形 → 图像像素，涂成中性灰 ——
  let masked = { rects: [], pixels: 0 }
  let maskCount = 0
  try {
    const rects = []
    for (const r of Array.isArray(o.maskRects) ? o.maskRects : []) {
      const ir = toImageRect(r, display.bounds || { x: 0, y: 0, width: size.width, height: size.height }, dim.width, dim.height, pad)
      if (ir) rects.push(ir)
    }
    if (rects.length) {
      masked = maskImage(bmp, dim.width, dim.height, rects, 118)
      maskCount = masked.rects.length
    }
  } catch (e) {
    // 遮罩失败不能挡住采集，但必须留下痕迹（隐私相关的失败要能查）
    return { ok: false, reason: 'mask-failed', error: String((e && e.message) || e), ms: Date.now() - t0 }
  }

  const hash = dHash(bmp, dim.width, dim.height)
  const luma = meanLuma(bmp, dim.width, dim.height)

  let jpeg = null
  try {
    if (maskCount) {
      const ni = nativeImage.createFromBitmap(bmp, { width: dim.width, height: dim.height })
      jpeg = ni.toJPEG(quality)
    } else {
      jpeg = img.toJPEG(quality)
    }
  } catch (e) {
    return { ok: false, reason: 'jpeg-failed', error: String((e && e.message) || e), ms: Date.now() - t0 }
  }

  const out = {
    ok: true,
    width: dim.width,
    height: dim.height,
    bytes: jpeg.length,
    hash,
    luma: Math.round(luma * 10) / 10,
    black: looksBlack(luma),
    source: (pick && pick.name) || '',
    dpr,
    masks: maskCount,
    maskedPixels: masked.pixels,
    ms: Date.now() - t0,
  }
  if (wantImage) out.jpeg = jpeg.toString('base64')
  return out
}

module.exports = { captureScreen }
