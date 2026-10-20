'use strict'
// 用 ffmpeg 从 B 站直链上「就地抽帧」——不下载整段视频。
//
// 为什么这样：一段 10 分钟 360P 视频约 30~60MB，全下下来再抽帧既慢又占盘。
// playurl 给的直链支持 HTTP Range，`-ss` 放在 `-i` 之前就是**输入侧 seek**，
// ffmpeg 会只抓需要的那一段 —— 单帧通常 1 秒内。
//
// 坑（都踩过）：
//   · 直链要带 UA + referer，否则 403 —— 用 `-headers` 传，且必须在 `-i` 之前；
//   · Windows 上 `-headers` 的分隔必须是真实的 CRLF；
//   · 输出缩到 640 宽：1 张 1280×800 约 1300 token，640×360 只要约 290。

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', args, { windowsHide: true })
    let err = ''
    const timer = setTimeout(() => { try { p.kill() } catch (e) {} }, Math.max(5000, timeoutMs || 30000))
    p.stderr.on('data', (d) => { err += String(d) })
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e.message || e) }) })
    p.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? { ok: true } : { ok: false, error: (err || 'exit ' + code).slice(-300) })
    })
  })
}

/**
 * @param {{url:string, at:number[], width?:number, timeoutMs?:number}} o
 * @returns {Promise<{ok:boolean, frames?:Array<{at:number,dataUrl:string,bytes:number}>, error?:string}>}
 */
async function grab(o) {
  const opt = o || {}
  const url = String(opt.url || '')
  if (!url) return { ok: false, error: 'no-url' }
  const width = Math.max(160, Math.min(1280, Number(opt.width) || 640))
  const at = Array.isArray(opt.at) && opt.at.length ? opt.at : [1]
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bili-frame-')).catch(() => '')
  if (!dir) return { ok: false, error: 'mkdtemp-failed' }

  const frames = []
  const headers = 'User-Agent: ' + UA + '\r\nReferer: https://www.bilibili.com/\r\n'
  try {
    // 并行抽：实测单帧 0.6~0.95s，但串行跑过一次 17s（CDN 冷启动 + 长视频 moov 位置）
    // ⇒ 并行既省时又让"某一帧卡住"不至于拖垮整轮；每一帧单独超时，失败就少一帧。
    const one = async (t) => {
      const out = path.join(dir, 'f' + Math.round(Number(t) || 0) + '.jpg')
      const args = [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-ss', String(Math.max(0, Number(t) || 0)),
        '-headers', headers,
        '-i', url,
        '-frames:v', '1',
        '-vf', "scale='min(" + width + ",iw)':-2",
        '-q:v', '5',
        out,
      ]
      const r = await runFfmpeg(args, opt.timeoutMs || 12000)
      if (!r.ok) return null
      const buf = await fs.promises.readFile(out).catch(() => null)
      if (!buf || !buf.length) return null
      return { at: Number(t) || 0, dataUrl: 'data:image/jpeg;base64,' + buf.toString('base64'), bytes: buf.length }
    }
    const got = await Promise.all(at.map(one))
    for (const f of got) if (f) frames.push(f)
    frames.sort((a, b) => a.at - b.at)
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {}
  }
  if (!frames.length) return { ok: false, error: 'no-frame' }
  return { ok: true, frames }
}

/** ffmpeg 在不在 */
function available() {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version'], { windowsHide: true })
    p.on('error', () => resolve(false))
    p.on('close', (c) => resolve(c === 0))
  })
}

module.exports = { grab, available }
