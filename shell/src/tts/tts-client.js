'use strict'
// TTS 后端的 HTTP 客户端。
//
// 2026-10-24 定案走「本地 GPT-SoVITS v2ProPlus + CPU 常驻」（方案见
// docs/桌宠说话-TTS调研与方案-20261024.md），所以 gptsovits 是主适配器；
// openai 兼容适配器保留着（~30 行）：一是给将来换/加云端克隆留口子，
// 二是排查时可以拿现成的云端服务对照「是链路问题还是音色问题」。
//
// GPT-SoVITS 的 api_v2 契约（RVC-Boss/GPT-SoVITS 的 api_v2.py，2026-10 核实）：
//   POST /tts  JSON { text, text_lang, ref_audio_path, prompt_text, prompt_lang,
//                     text_split_method, media_type, streaming_mode, speed_factor, ... }
//   · ref_audio_path 只收 **服务器本机路径** —— api_v2 不收上传，我们和它同机部署所以没问题；
//   · prompt_text 必须是参考音频的**逐字转写**，不匹配会明显劣化；
//   · 3~10 秒硬校验（16kHz 下 48000~160000 采样），超了直接 400；
//   · 出错返回 JSON {message}，成功返回 audio/wav（streaming_mode=false 时整段返回）。

const AUDIO_MAGIC = [
  { bytes: [0x52, 0x49, 0x46, 0x46], type: 'wav' }, // RIFF
  { bytes: [0x49, 0x44, 0x33], type: 'mp3' }, // ID3
  { bytes: [0xff, 0xfb], type: 'mp3' }, // MPEG 帧头
  { bytes: [0x4f, 0x67, 0x67, 0x53], type: 'ogg' }, // OggS
  { bytes: [0x66, 0x74, 0x79, 0x70], type: 'm4a' }, // ftyp
]

/** 探测返回体是不是音频（纯函数）。GPT-SoVITS 出错时回的是 JSON，不能当 wav 存缓存。 */
function detectAudio(buf) {
  if (!buf || buf.length < 12) return null
  for (const m of AUDIO_MAGIC) {
    if (m.bytes.every((b, i) => buf[i] === b)) return m.type
  }
  return null
}

function joinUrl(base, suffix) {
  return String(base || '').replace(/\/+$/, '') + suffix
}

/**
 * 组 GPT-SoVITS api_v2 请求（纯函数，单测用）。
 * 配置不齐（没填参考音频路径）返回 {error}，调用方在发请求前就能拦住。
 */
function buildGptsovitsRequest(cfg, text) {
  const c = cfg || {}
  if (!c.baseUrl) return { error: '没填 TTS 服务地址' }
  if (!c.refAudioPath) return { error: '还没配参考音频（3~10 秒的那段声音）' }
  const body = {
    text: String(text || ''),
    text_lang: 'zh',
    ref_audio_path: String(c.refAudioPath),
    prompt_text: String(c.promptText || ''),
    prompt_lang: 'zh',
    text_split_method: 'cut5',
    media_type: 'wav',
    streaming_mode: false,
    speed_factor: Number(c.speed) > 0 ? Number(c.speed) : 1,
  }
  return { url: joinUrl(c.baseUrl, '/tts'), init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } }
}

/** OpenAI 兼容 /audio/speech（阶跃/未来云端克隆用）。 */
function buildOpenaiRequest(cfg, text) {
  const c = cfg || {}
  if (!c.baseUrl) return { error: '没填 TTS 服务地址' }
  if (!c.model) return { error: '没填模型名' }
  let base = String(c.baseUrl).replace(/\/+$/, '')
  if (!base.endsWith('/v1')) base += '/v1'
  const headers = { 'Content-Type': 'application/json' }
  if (c.apiKey) headers.Authorization = 'Bearer ' + c.apiKey
  const body = {
    model: c.model,
    voice: c.voice || 'alloy',
    input: String(text || ''),
    speed: Number(c.speed) > 0 ? Number(c.speed) : 1,
    response_format: 'wav',
  }
  return { url: base + '/audio/speech', init: { method: 'POST', headers, body: JSON.stringify(body) } }
}

/**
 * GSV-TTS-Lite（2026-10-25，博士点名的高性能后端）。
 * 契约（仓库 API/fastapi_server_example.py，2026-10 核实）：和原版 api_v2 **不兼容**——
 *   POST /tts/single {text, speaker_audio, prompt_audio, prompt_text, speed, ...}
 *     → {success, audio_len, filename, prompt_text_used}   ← 只回**文件名**
 *   GET  /audio/{filename} → 音频字节
 * 两段式由 synthesize() 处理；这里只组第一步。
 * speaker_audio = 音色参考（决定"像谁"）；prompt_audio = 风格参考（决定语气节奏）。
 * 我们默认**同一段音频兼任两者**（原版零克隆的等价行为），prompt_audio 想分开填 promptAudioPath。
 */
function buildGsvliteRequest(cfg, text) {
  const c = cfg || {}
  if (!c.baseUrl) return { error: '没填 TTS 服务地址' }
  if (!c.refAudioPath) return { error: '还没配参考音频（3~10 秒的那段声音）' }
  const body = {
    text: String(text || ''),
    speaker_audio: String(c.refAudioPath),
    prompt_audio: String(c.promptAudioPath || c.refAudioPath),
    prompt_text: String(c.promptText || ''),
    speed: Number(c.speed) > 0 ? Number(c.speed) : 1,
  }
  return {
    url: joinUrl(c.baseUrl, '/tts/single'),
    init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  }
}

/** 把底层错误翻译成面板能直接显示的人话（纯函数）。 */
function mapTtsError(err, cfg) {
  const msg = String((err && err.message) || err || '')
  if (/abort|timeout|timed out/i.test(msg)) return '合成超时（TTS 还没回话）'
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|connect/i.test(msg)) {
    return '本地 TTS 没连上（' + ((cfg && cfg.baseUrl) || '服务没在跑') + '）'
  }
  return 'TTS 请求失败：' + msg.slice(0, 120)
}

/**
 * 合成一段话。成功返回 { ok:true, buf, audioType }；失败返回 { ok:false, reason } ——
 * 永不抛异常（TTS 是气泡的锦上添花，调用方只看 ok）。
 * @param {object} cfg heart.tts 段（backend/baseUrl/...）
 * @param {string} text 已清洗的朗读文本
 * @param {{timeoutMs?:number, fetchImpl?:function}} opts fetchImpl 给单测注入假服务
 */
async function synthesize(cfg, text, opts) {
  const o = opts || {}
  const fetchImpl = o.fetchImpl || global.fetch
  const timeoutMs = Math.max(1000, Number(o.timeoutMs) || 30000)
  const backend = (cfg && cfg.backend) || 'gptsovits'
  const isLite = backend === 'gsvlite'
  const built =
    backend === 'openai'
      ? buildOpenaiRequest(cfg, text)
      : isLite
        ? buildGsvliteRequest(cfg, text)
        : buildGptsovitsRequest(cfg, text)
  if (built.error) return { ok: false, reason: built.error }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs)
  try {
    const res = await fetchImpl(built.url, Object.assign({}, built.init, { signal: ctrl.signal }))
    if ((res.status || 0) !== 200) {
      let detail = ''
      try {
        const j = await res.json()
        detail = String((j && (j.message || j.error)) || '')
      } catch (e) {
        try {
          detail = (await res.text()).slice(0, 120)
        } catch (e2) {}
      }
      return { ok: false, reason: 'TTS 服务报错（' + res.status + '）：' + (detail || '没有详情') }
    }
    let buf
    if (isLite) {
      // GSV-TTS-Lite 两步：第一步只回文件名，再去 /audio/{filename} 拉音频
      let j
      try {
        j = await res.json()
      } catch (e) {
        return { ok: false, reason: 'GSV-TTS-Lite 返回的不是 JSON（确认跑的是 fastapi_server_example 那个服务）' }
      }
      if (!j || !j.success || !j.filename) {
        return { ok: false, reason: 'GSV-TTS-Lite 没给音频文件：' + JSON.stringify(j).slice(0, 100) }
      }
      const res2 = await fetchImpl(joinUrl(cfg.baseUrl, '/audio/' + encodeURIComponent(j.filename)), { signal: ctrl.signal })
      if ((res2.status || 0) !== 200) return { ok: false, reason: '取音频文件失败（/audio/' + j.filename + ' → ' + res2.status + '）' }
      buf = Buffer.from(await res2.arrayBuffer())
    } else {
      buf = Buffer.from(await res.arrayBuffer())
    }
    const type = detectAudio(buf)
    if (!type) return { ok: false, reason: 'TTS 返回的不是音频（配置可能没生效，看服务端日志）' }
    return { ok: true, buf, audioType: type }
  } catch (err) {
    return { ok: false, reason: mapTtsError(err, cfg) }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { buildGptsovitsRequest, buildGsvliteRequest, buildOpenaiRequest, synthesize, detectAudio, mapTtsError }
