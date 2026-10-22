'use strict'

// 划词翻译的网络层（三档：free / api / local）。
//
// 为什么放在主进程而不是页面里 fetch：
//   1) apiKey 绝不能进页面（与 heart.model 的既有安全模型一致：页面只拿 apiKeySet 布尔）；
//   2) local 档要调本地推理引擎，必须对心跳 `hold()`，否则两边抢同一个 -np 1 槽位；
//   3) 免费档要控分块与限流，放主进程只有一份，页面刷新也不会丢状态。
//
// ⚠️ 刻意**不自动降级**：免费档挂了就报错并提示切 API/本地。
//    静默切本地会突然烧显存、而且慢到用户以为卡死 —— 报错比"神秘变慢"好。

const core = require('./translate-core')
const vision = require('../heart/vision')

const FREE_TIMEOUT_MS = 8000
const CHAT_TIMEOUT_MS = 20000

function createTranslate(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const getHeart = typeof options.getHeart === 'function' ? options.getHeart : () => null
  const report = (m) => {
    try {
      log('[translate] ' + m)
    } catch (e) {}
  }

  async function fetchWithTimeout(url, init, ms) {
    const ac = new AbortController()
    const t = setTimeout(() => {
      try {
        ac.abort()
      } catch (e) {}
    }, ms)
    try {
      return await fetch(url, Object.assign({}, init, { signal: ac.signal }))
    } finally {
      clearTimeout(t)
    }
  }

  function timeoutReason(e) {
    const aborted = !!(e && (e.name === 'AbortError' || /abort/i.test(String(e.message))))
    return aborted ? 'timeout' : 'network'
  }

  /** 免费档：腾讯 Transmart（免 key，国内直连） */
  async function freeChunk(text, to) {
    let res
    try {
      res = await fetchWithTimeout(
        core.QQ_API_URL,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(core.buildQqRequest(text, to)),
        },
        FREE_TIMEOUT_MS,
      )
    } catch (e) {
      return { ok: false, reason: timeoutReason(e) }
    }
    if (!res.ok) return { ok: false, reason: 'free-http-' + res.status }
    let json = null
    try {
      json = await res.json()
    } catch (e) {
      return { ok: false, reason: 'free-empty' }
    }
    return core.extractQqText(json)
  }

  /** api / local 共用：OpenAI 兼容 /chat/completions */
  async function chatChunk(text, opts) {
    const base = vision.normalizeBase(opts.baseUrl)
    if (!base) return { ok: false, reason: 'no-endpoint' }
    if (!opts.model) return { ok: false, reason: 'no-model' }
    let res
    try {
      res = await fetchWithTimeout(
        base + '/chat/completions',
        {
          method: 'POST',
          headers: Object.assign(
            { 'content-type': 'application/json' },
            opts.apiKey ? { authorization: 'Bearer ' + opts.apiKey } : {},
          ),
          body: JSON.stringify({
            model: opts.model,
            messages: core.buildChatMessages(text, opts.to),
            temperature: 0.2,
            max_tokens: Math.max(64, Math.min(2048, Number(opts.maxTokens) || 800)),
            stream: false,
            // 思考模型会把预算全花在 reasoning 上，content 变空 —— 翻译必须关掉
            chat_template_kwargs: { enable_thinking: false },
          }),
        },
        Number(opts.timeoutMs) || CHAT_TIMEOUT_MS,
      )
    } catch (e) {
      return { ok: false, reason: timeoutReason(e) }
    }
    if (!res.ok) {
      if (res.status === 401) return { ok: false, reason: 'chat-http-401' }
      if (res.status === 404) return { ok: false, reason: 'chat-http-404' }
      return { ok: false, reason: 'chat-http-' + res.status }
    }
    let json = null
    try {
      json = await res.json()
    } catch (e) {
      return { ok: false, reason: 'chat-empty' }
    }
    return core.extractChatText(json)
  }

  /** 解析当前配置到底该用哪个端点 */
  function resolveTarget(tl, heart) {
    const engine = tl.engine === 'api' || tl.engine === 'local' ? tl.engine : 'free'
    if (engine === 'free') return { ok: true, engine }
    if (engine === 'api') {
      const a = tl.api || {}
      if (!a.baseUrl) return { ok: false, engine, reason: 'no-endpoint' }
      return { ok: true, engine, baseUrl: a.baseUrl, model: a.model, apiKey: a.apiKey || '' }
    }
    // local：复用心跳那个端点（面板里写明）
    const m = (heart && heart.config && heart.config().model) || {}
    if (!m.baseUrl) return { ok: false, engine, reason: 'no-endpoint' }
    return { ok: true, engine, baseUrl: m.baseUrl, model: m.model, apiKey: m.apiKey || '', viaLocal: true }
  }

  /**
   * 翻译一段文本。返回 { ok, text, engine, ms, chunks } 或 { ok:false, reason, hint }
   */
  async function run(rawText, override) {
    const heart = getHeart()
    const cfg = heart && heart.config ? heart.config() : null
    const tl = (cfg && cfg.tools && cfg.tools.translate) || {}
    const text = String(rawText == null ? '' : rawText)
    if (!text.trim()) return { ok: false, reason: 'empty' }
    const target = resolveTarget(tl, heart)
    if (!target.ok) {
      return {
        ok: false,
        reason: target.reason,
        engine: target.engine,
        hint: target.reason === 'no-endpoint' ? '功能面板里填一下翻译端点（或把引擎切回免费）' : '填一下模型名',
      }
    }
    const to = (override && override.to) || tl.to || 'zh-Hans'
    const t0 = Date.now()
    const isFree = target.engine === 'free'
    const chunks = core.splitChunks(text, isFree ? core.FREE_MAX_CHUNK : core.CHAT_MAX_CHUNK)
    const hold = !!(target.viaLocal && heart && heart.hold)
    if (hold) {
      try {
        heart.hold()
      } catch (e) {}
    }
    const parts = []
    try {
      for (const c of chunks) {
        const r = isFree
          ? await freeChunk(c, to)
          : await chatChunk(c, {
              baseUrl: target.baseUrl,
              model: target.model,
              apiKey: target.apiKey,
              to,
              maxTokens: override && override.maxTokens,
              timeoutMs: override && override.timeoutMs,
            })
        if (!r.ok) {
          return { ok: false, reason: r.reason, hint: core.describeError(r.reason), engine: target.engine }
        }
        parts.push(r.text)
      }
    } catch (e) {
      return { ok: false, reason: 'network', hint: core.describeError('network'), engine: target.engine }
    } finally {
      if (hold && heart && heart.release) {
        try {
          heart.release()
        } catch (e) {}
      }
    }
    const joined = parts.join(isFree ? '\n' : '\n')
    const ms = Date.now() - t0
    report(target.engine + ' 译完 ' + text.length + ' 字 → ' + joined.length + ' 字，' + ms + 'ms / ' + chunks.length + ' 块')
    return { ok: true, text: joined, engine: target.engine, ms, chunks: chunks.length }
  }

  /** 面板上的「测试」按钮：只探通不通，不翻译整段 */
  async function selftest(what) {
    const heart = getHeart()
    const cfg = heart && heart.config ? heart.config() : null
    const tl = (cfg && cfg.tools && cfg.tools.translate) || {}
    if (what === 'free') {
      const r = await freeChunk('hello', tl.to || 'zh-Hans')
      if (!r.ok) return { ok: false, reason: r.reason, hint: core.describeError(r.reason) }
      return { ok: true, detail: '免费引擎已回话：' + r.text.slice(0, 40) }
    }
    const target = resolveTarget(tl, heart)
    if (!target.ok) return { ok: false, reason: target.reason, hint: core.describeError(target.reason) }
    if (target.engine === 'free') {
      return { ok: false, reason: 'engine-free', hint: '当前是免费引擎，没有端点可测' }
    }
    const r = await chatChunk('hello', {
      baseUrl: target.baseUrl,
      model: target.model,
      apiKey: target.apiKey,
      to: tl.to || 'zh-Hans',
      maxTokens: 64,
    })
    if (!r.ok) return { ok: false, reason: r.reason, hint: core.describeError(r.reason) }
    return { ok: true, detail: '端点已回话：' + r.text.slice(0, 40) }
  }

  return { run, selftest, resolveTarget }
}

module.exports = { createTranslate }
