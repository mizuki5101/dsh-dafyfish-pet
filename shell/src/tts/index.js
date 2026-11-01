'use strict'
// 「让桌宠说话」的编排层（2026-10-24 开工，方案见 docs/桌宠说话-TTS调研与方案-20261024.md）。
//
// 触发点在 main.js：回应模式的回复（heart:chat）、心跳/刷视频的台词（onAction）。
// 本模块只做五件事：清洗 → 查缓存 → 合成 → 落盘 → 推 {t:'tts-play'} 给页面。
// 播放、口型、和气泡的时长校正在 pet.js（渲染进程）里。
//
// 时序语义（为什么不用更复杂的队列）：
//   · 文字永远先行，语音异步跟上 —— 慢/失败绝不拖累气泡；
//   · **同一时刻只认最新一条**（代次计数 gen）：新 speak() 让在途的旧合成作废。
//     心跳 15s 一句、聊天一来一回，这个节奏下排队没有意义，最新才有效；
//   · 页面发的 tts:stop 只是「音频已停」的通知，**不**取消在途合成 ——
//     否则聊天气泡总是先渲染、后收到 tts-play，一停就永远没声音了。
//     真正的打断 = 新的 speak（气泡被顶掉时页面会停旧音频，合成作废走 gen）。

const { cleanSpeechText } = require('./speak-text')
const { synthesize } = require('./tts-client')
const { cacheKey, cacheHas, cacheSave, pruneCache, countCache, cacheUrl } = require('./tts-cache')

const TEST_TEXT = '你好呀主人，我是大肥鱼，这是我用本地声音说的第一句话。'

/**
 * 生效的 TTS 配置（2026-11-01，模型条目系统）：roles.tts 指到条目 →
 * 端点（baseUrl/apiKey）用条目的，「声音细节」优先条目的 entry.tts、缺的回落全局 heart.tts。
 * 没分配（或条目没了）→ 原样返回 heart.tts —— 与 v2.1 行为完全一致。
 * enabled / sources 永远是全局的（那是「哪些场合出声」，不是「用哪个端点」）。纯函数，可单测。
 */
function resolveTtsTarget(cfg) {
  const base = (cfg && cfg.tts) || {}
  const roles = (cfg && cfg.roles) || {}
  const models = Array.isArray(cfg && cfg.models) ? cfg.models : []
  const e = models.find((m) => m && m.id && m.id === roles.tts)
  if (!e) return base
  const t = e.tts && typeof e.tts === 'object' ? e.tts : {}
  const numOr = (k) => {
    const n = Number(t[k])
    return Number.isFinite(n) && n > 0 ? n : base[k]
  }
  return Object.assign({}, base, {
    baseUrl: e.baseUrl || base.baseUrl,
    apiKey: e.apiKey || base.apiKey,
    backend: t.backend || base.backend,
    voice: t.voice || base.voice,
    refAudioPath: t.refAudioPath || base.refAudioPath,
    promptAudioPath: t.promptAudioPath || base.promptAudioPath,
    promptText: t.promptText || base.promptText,
    speed: numOr('speed') || base.speed,
    maxChars: numOr('maxChars') || base.maxChars,
    timeoutMs: numOr('timeoutMs') || base.timeoutMs,
  })
}

function createTts(opts) {
  const o = opts || {}
  const log = o.log || (() => {})
  const dir = o.dir || '.'
  const push = o.push || (() => {})
  const getCfg = o.getCfg || (() => null)

  const state = {
    gen: 0, // 代次：每次 speak 自增；合成返回时对不上号 = 已被更新的一条顶掉
    busy: false,
    lastOkAt: 0,
    lastError: '',
    lastErrorAt: 0,
    lastText: '',
    stops: 0,
    hits: 0,
  }

  function ok(text, key, source, test) {
    state.lastOkAt = Date.now()
    state.lastError = ''
    state.lastText = String(text).slice(0, 80)
    push({ t: 'tts-play', id: key + '-' + state.gen, url: cacheUrl(key), source: source || '', test: !!test })
  }

  function fail(reason) {
    state.lastError = String(reason).slice(0, 160)
    state.lastErrorAt = Date.now()
    log('TTS：' + state.lastError)
  }

  /** 合成 + 推送的核心。配置不齐/被顶掉/失败都静默返回，绝不打断文字链路。 */
  async function run(source, rawText, test) {
    const cfg = getCfg()
    if (!cfg) return { ok: false, reason: 'no-config' }
    if (!test) {
      if (!cfg.enabled) return { ok: false, reason: 'disabled' }
      if (!(cfg.sources && cfg.sources[source])) return { ok: false, reason: 'source-off' }
    }
    const text = cleanSpeechText(rawText, cfg.maxChars)
    if (!text) return { ok: false, reason: 'empty' }
    const my = ++state.gen
    const key = cacheKey(cfg, text)

    if (!test && cacheHas(dir, key)) {
      state.hits++
      ok(text, key, source)
      return { ok: true, cached: true }
    }
    state.busy = true
    let r
    try {
      r = await synthesize(cfg, text, { timeoutMs: cfg.timeoutMs })
    } finally {
      state.busy = false
    }
    if (!r.ok) {
      // 只有仍然是最新的那条才记错误：被顶掉的失败不算数（是旧请求的噪音）
      if (state.gen === my) fail(r.reason)
      return r
    }
    if (state.gen !== my) return { ok: false, reason: 'stale' }
    if (!cacheSave(dir, key, r.buf)) {
      if (state.gen === my) fail('音频写不进缓存目录（磁盘满了？）')
      return { ok: false, reason: 'cache-write' }
    }
    pruneCache(dir)
    if (state.gen === my) ok(text, key, source, test)
    return { ok: true }
  }

  return {
    /** 触发点入口：source = 'chat' | 'heart' | 'bili' | 'work' */
    speak: (source, text) => run(source, text, false),
    /** 面板「试听」：只绕过 enabled/sources 开关，其余一样（配置没配好照样报原因）。 */
    test: () => run('test', TEST_TEXT, true),
    /** 页面来消息说音频停了（气泡关了/被顶了）。只记数，不取消在途合成（见文件头注释）。 */
    noteStop: () => {
      state.stops++
    },
    /** heart:save 之后对齐一下（顺手清一次过期缓存）。 */
    sync: () => {
      try {
        pruneCache(dir)
      } catch (e) {}
    },
    status: () => ({
      enabled: !!(getCfg() && getCfg().enabled),
      busy: state.busy,
      cacheCount: countCache(dir),
      lastOkAt: state.lastOkAt,
      lastError: state.lastError,
      lastErrorAt: state.lastErrorAt,
      lastText: state.lastText,
      stops: state.stops,
      hits: state.hits,
    }),
    _state: state,
  }
}

module.exports = { createTts, resolveTtsTarget, TEST_TEXT }
