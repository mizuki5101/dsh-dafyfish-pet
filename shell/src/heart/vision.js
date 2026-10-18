'use strict'
// 本地 VLM 的客户端（主进程）。
//
// 设计目标：**用户不需要先知道自己的推理引擎在哪**。
//   · auto（默认）：按端口表探测常见 OpenAI 兼容端点（本项目 sidecar / Ollama / LM Studio / vLLM / llama.cpp），
//     谁在、谁能返回模型列表，就用谁；请求失败就试下一个。
//   · 手动：settings 里写死 baseUrl+model（用户自己知道跑在哪），alt 永远第一优先。
// 只认 OpenAI 兼容协议 —— 这样换引擎不用改代码（见 docs 方案的路径 A/B/C/E）。
//
// 注意：MiniCPM 的 downsample_mode / max_slice_nums 是「处理器参数」，不是 OpenAI 协议的一部分；
// llama.cpp 的 server 不通过 API 暴露它们（只能用 --mmproj 选 4x/16x 权重）。所以这里不发，
// 配置项留着给以后接 Python 服务时用。

const DEFAULT_PORTS = [19411, 11434, 1234, 8000, 8080]
const MODEL_HINT = /(minicpm|qwen.*(vl|vision)|llava|moondream|internvl|glm.*v|pixtral|vision|vl)/i

function normalizeBase(u) {
  const s = String(u || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) return ''
  return /\/v1$/.test(s) ? s : s + '/v1'
}

function pickModelName(models, wanted) {
  const list = (models || []).map((m) => String(m)).filter(Boolean)
  if (!list.length) return ''
  const want = String(wanted || '').trim()
  if (want) {
    const exact = list.find((m) => m === want)
    if (exact) return exact
    const loose = list.find((m) => m.includes(want) || want.includes(m))
    if (loose) return loose
  }
  const hinted = list.find((m) => MODEL_HINT.test(m))
  return hinted || list[0]
}

function authHeaders(apiKey) {
  const h = { 'content-type': 'application/json' }
  if (apiKey) h.authorization = 'Bearer ' + apiKey
  return h
}

async function withTimeout(fn, ms) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), Math.max(200, ms))
  try {
    return await fn(ctl.signal)
  } finally {
    clearTimeout(timer)
  }
}

/** 列模型；失败返回 null（端点不存在/不是 OpenAI 兼容） */
async function listModels(baseUrl, opts) {
  const o = opts || {}
  try {
    return await withTimeout(async (signal) => {
      const r = await fetch(baseUrl + '/models', { signal, headers: authHeaders(o.apiKey) })
      if (!r.ok) return null
      const j = await r.json()
      const arr = (j && (j.data || j.models)) || []
      const ids = arr.map((x) => (typeof x === 'string' ? x : x && (x.id || x.name))).filter(Boolean)
      return ids.length ? ids : null
    }, o.timeoutMs || 800)
  } catch (e) {
    return null
  }
}

/**
 * 候选端点（按优先级）。
 * @param {object} cfg heart 配置
 * @returns {Promise<Array<{baseUrl:string, model:string, apiKey:string, source:string}>>}
 */
async function resolveCandidates(cfg) {
  const m = (cfg && cfg.model) || {}
  const manual = normalizeBase(m.baseUrl)
  const out = []

  if (manual) {
    const models = await listModels(manual, { apiKey: m.apiKey, timeoutMs: 1200 })
    out.push({ baseUrl: manual, model: pickModelName(models || [m.model], m.model), apiKey: m.apiKey || '', source: 'manual' })
  }
  if (m.provider === 'openai' || m.provider === 'separate' || manual) return out

  // 用户填的端口排第一（面板里的「API 端口」）；其余常见端口兜底。
  const ports = []
  const preferred = Number(m.port)
  if (preferred > 0 && preferred < 65536) ports.push(preferred)
  for (const p of DEFAULT_PORTS) if (!ports.includes(p)) ports.push(p)

  for (const port of ports) {
    const base = 'http://127.0.0.1:' + port + '/v1'
    if (manual && base === manual) continue
    const models = await listModels(base, { timeoutMs: 700 })
    if (!models) continue
    out.push({ baseUrl: base, model: pickModelName(models, m.model), apiKey: '', source: 'auto:' + port })
  }
  return out
}

/**
 * 调一次 chat/completions。
 * @returns {Promise<{ok:true,text:string,ms:number,usage:object|null}|{ok:false,error:string,status?:number}>}
 */
async function chat(candidate, messages, opts) {
  const o = opts || {}
  const body = {
    model: candidate.model || 'default',
    messages,
    temperature: Number.isFinite(o.temperature) ? o.temperature : 0.2,
    max_tokens: Math.max(16, Math.min(1024, Number(o.maxTokens) || 160)),
    stream: false,
  }
  if (o.schema) body.response_format = { type: 'json_schema', json_schema: { name: 'heart', strict: true, schema: o.schema } }
  else if (o.jsonObject) body.response_format = { type: 'json_object' }
  // Qwen/MiniCPM 的思考模式会吃掉结构化输出的预算；关掉是官方实测里性价比最高的一项。
  if (o.enableThinking === false) body.chat_template_kwargs = { enable_thinking: false }

  const t0 = Date.now()
  try {
    return await withTimeout(async (signal) => {
      const r = await fetch(candidate.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: authHeaders(candidate.apiKey),
        body: JSON.stringify(body),
        signal,
      })
      const ms = Date.now() - t0
      if (!r.ok) {
        let detail = ''
        try {
          detail = (await r.text()).slice(0, 200)
        } catch (e) {}
        return { ok: false, error: 'http ' + r.status + (detail ? ' ' + detail : ''), status: r.status, ms }
      }
      const j = await r.json()
      const ch = j && j.choices && j.choices[0]
      const text = ch && ch.message && (ch.message.content || '')
      if (!text) return { ok: false, error: 'empty content', ms }
      return { ok: true, text, ms, usage: (j && j.usage) || null }
    }, o.timeoutMs || 20000)
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 }
  }
}

/**
 * 自动挑一个能用的端点并请求；前一个失败就换下一个。
 * @returns {Promise<{ok:true,text,ms,usage,candidate}|{ok:false,error,candidates:number}>}
 */
async function infer(cfg, messages, opts) {
  const cands = await resolveCandidates(cfg)
  if (!cands.length) return { ok: false, error: 'no-endpoint', candidates: 0 }
  let lastErr = ''
  for (const c of cands.slice(0, 3)) {
    const r = await chat(c, messages, opts)
    if (r.ok) return Object.assign({}, r, { candidate: c })
    lastErr = r.error || 'unknown'
  }
  return { ok: false, error: lastErr || 'all-failed', candidates: cands.length }
}

module.exports = { DEFAULT_PORTS, normalizeBase, pickModelName, listModels, resolveCandidates, chat, infer }
