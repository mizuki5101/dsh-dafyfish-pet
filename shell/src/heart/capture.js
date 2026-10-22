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
const { toImageRect, maskImage, cropBitmap } = require('./mask')

async function captureScreen(opts) {
  const o = opts || {}
  const maxEdge = Math.max(320, Math.min(2560, Number(o.maxEdge) || 1280))
  const quality = Math.max(40, Math.min(95, Number(o.quality) || 72))
  const wantImage = o.includeImage === true
  const pad = Number.isFinite(Number(o.maskPad)) ? Math.max(0, Math.min(64, Number(o.maskPad))) : 6
  // 区域截图（2026-10-22 识图）：只想看框里那一块
  const region = o.region && Number(o.region.w) > 0 && Number(o.region.h) > 0 ? o.region : null
  const t0 = Date.now()

  let display = null
  try {
    display = screen.getPrimaryDisplay()
  } catch (e) {
    return { ok: false, reason: 'no-display', error: String((e && e.message) || e), ms: Date.now() - t0 }
  }
  const size = display.size || { width: 1280, height: 720 }
  const dpr = Number(display.scaleFactor) || 1
  // region 模式**不缩**：目标只有几百像素，再按 maxEdge 压一遍就只剩几十像素，字全糊了。
  // 代价是一次全屏 BGRA（4K 约 33MB），一次性操作可接受；夹 3840 防 5K 屏。
  const scale = region ? 1 : Math.min(1, maxEdge / Math.max(size.width * dpr, size.height * dpr))
  const rawW = Math.round(size.width * dpr * scale)
  const rawH = Math.round(size.height * dpr * scale)
  const reqW = Math.max(64, region ? Math.min(3840, rawW) : rawW)
  const reqH = Math.max(64, region ? Math.min(3840, rawH) : rawH)

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
  // region 模式**跳过遮罩**：用户框住的可能就是她自己，涂灰会把主体抹掉。
  let masked = { rects: [], pixels: 0 }
  let maskCount = 0
  try {
    const rects = []
    for (const r of region ? [] : Array.isArray(o.maskRects) ? o.maskRects : []) {
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

  // —— 区域裁剪（识图）——
  let crop = null
  if (region) {
    const ir = toImageRect(
      region,
      display.bounds || { x: 0, y: 0, width: size.width, height: size.height },
      dim.width,
      dim.height,
      0,
    )
    crop = ir ? cropBitmap(bmp, dim.width, dim.height, ir) : null
    if (!crop) return { ok: false, reason: 'region-empty', ms: Date.now() - t0 }
  }

  const pxBuf = crop ? crop.buf : bmp
  const pxW = crop ? crop.w : dim.width
  const pxH = crop ? crop.h : dim.height

  const hash = dHash(pxBuf, pxW, pxH)
  const luma = meanLuma(pxBuf, pxW, pxH)

  let jpeg = null
  try {
    if (crop) {
      // 区域截图给高画质：整屏压到 72 还能看字，几百像素的小图必须 92
      const ni = nativeImage.createFromBitmap(crop.buf, { width: crop.w, height: crop.h })
      jpeg = ni.toJPEG(Math.max(quality, 92))
    } else if (maskCount) {
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
    width: pxW,
    height: pxH,
    bytes: jpeg.length,
    hash,
    luma: Math.round(luma * 10) / 10,
    black: looksBlack(luma),
    source: (pick && pick.name) || '',
    dpr,
    masks: maskCount,
    maskedPixels: masked.pixels,
    cropped: !!crop,
    ms: Date.now() - t0,
  }
  if (wantImage) out.jpeg = jpeg.toString('base64')
  return out
}

module.exports = { captureScreen }
