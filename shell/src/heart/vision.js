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
 * 严格匹配：手动填了模型名，就必须在 /v1/models 里**精确出现**。
 *
 * 为什么不做「像就行」的回退：2026-10-18 的事故就是回退到「第一个带 vision 的模型」，
 * 结果把一个不相干的视觉模型当成了桌宠模型拉起来、连完整提示词一起发了过去。
 * 现在只认精确匹配；不匹配就报错，让用户去改配置。
 *
 * @returns {{ok:true, model:string, models:string[]}|{ok:false, error:string, wanted?:string, models:string[]}}
 */
function matchModel(models, wanted) {
  const list = (models || []).map((x) => String(x).trim()).filter(Boolean)
  const want = String(wanted == null ? '' : wanted).trim()
  if (!want) return { ok: false, error: 'no-model', models: list }
  const hit = list.find((x) => x === want)
  if (hit) return { ok: true, model: hit, models: list }
  return { ok: false, error: 'model-not-found', wanted: want, models: list }
}

/**
 * 解析当前配置的**唯一**端点 —— 不做任何自动发现。
 * 没填 baseUrl 就直接报错，让用户点面板的「扫描」或手填。
 */
async function resolve(cfg) {
  const m = (cfg && cfg.model) || {}
  const base = normalizeBase(m.baseUrl)
  if (!base) {
    return { ok: false, error: 'no-endpoint', hint: '未配置 API 地址：点「扫描」选择本地端点，或手填自定义 API' }
  }
  const models = await listModels(base, { apiKey: m.apiKey, timeoutMs: 1500 })
  if (!models) {
    return { ok: false, error: 'endpoint-unreachable', baseUrl: base, hint: '连不上 ' + base + '/models（服务没起，或不是 OpenAI 兼容）' }
  }
  const mm = matchModel(models, m.model)
  if (!mm.ok) {
    return {
      ok: false, error: mm.error, baseUrl: base, wanted: mm.wanted || '',
      models: mm.models.slice(0, 20),
      hint: mm.error === 'no-model'
        ? '请填模型名，或点「扫描」从列表里选'
        : '模型名「' + mm.wanted + '」不在 ' + base + ' 的 /v1/models 里；可用：' + mm.models.slice(0, 6).join('、'),
    }
  }
  return {
    ok: true,
    candidate: { baseUrl: base, model: mm.model, apiKey: m.apiKey || '', source: 'manual' },
    models,
  }
}

/**
 * 只在用户点「扫描」时调用：探测手填端口 + 常见端口，返回**候选列表**（不自动使用）。
 * @returns {Promise<Array<{baseUrl:string, models:string[], suggested:string, source:string}>>}
 */
async function scan(cfg) {
  const m = (cfg && cfg.model) || {}
  const bases = []
  const manual = normalizeBase(m.baseUrl)
  if (manual) bases.push({ base: manual, source: 'manual' })
  const ports = []
  const preferred = Number(m.port)
  if (preferred > 0 && preferred < 65536) ports.push(preferred)
  for (const p of DEFAULT_PORTS) if (!ports.includes(p)) ports.push(p)
  for (const port of ports) bases.push({ base: 'http://127.0.0.1:' + port + '/v1', source: 'auto:' + port })

  const seen = new Set()
  const out = []
  for (const b of bases) {
    if (seen.has(b.base)) continue
    seen.add(b.base)
    const models = await listModels(b.base, { timeoutMs: 700 })
    if (!models) continue
    out.push({ baseUrl: b.base, models, suggested: pickModelName(models, m.model), source: b.source })
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
    // 硬顶 2048：只有「做梦」会要这么多（写一篇 1200 字的日记）。
    // 其它调用都只要 100~400，所以放宽上限不影响它们。
    max_tokens: Math.max(16, Math.min(2048, Number(o.maxTokens) || 160)),
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
 * 连通性 ping：只要 HTTP 2xx + 合法 OpenAI 响应（有 choices）就算成功。
 *
 * 为什么不能复用 chat()：chat() 要求 content 非空；而开了思考模式的模型
 * （Qwen3.5 / Llama 等）经常把话全放在 reasoning_content 里，content 是空串——
 * 实际连接完全正常，却被判成 empty content。这里显式接受空正文。
 */
async function ping(candidate, opts) {
  const o = opts || {}
  const body = {
    model: candidate.model || 'default',
    messages: [
      { role: 'system', content: '这是连通性测试。只回复 ok 两个字母，不要解释。' },
      { role: 'user', content: 'ping' },
    ],
    temperature: 0,
    max_tokens: 8,
    stream: false,
  }
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
      let j = null
      try {
        j = await r.json()
      } catch (e) {
        return { ok: false, error: 'invalid-json', ms }
      }
      const ch = j && j.choices && j.choices[0]
      if (!ch) return { ok: false, error: 'no-choices', ms }
      const msg = ch.message || {}
      const text = String(msg.content == null ? '' : msg.content).trim()
      const reasoning = String(msg.reasoning_content || msg.reasoning || '').trim()
      return { ok: true, ms, text, reasoning, empty: !text }
    }, o.timeoutMs || 90000)
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 }
  }
}

/**
 * 只打「当前配置的那一个端点」；不自动切换、不探测别的端口。
 * @returns {Promise<{ok:true,text,ms,usage,candidate}|{ok:false,error,candidates:number,detail?:object}>}
 */
async function infer(cfg, messages, opts) {
  const rr = await resolve(cfg)
  if (!rr.ok) return { ok: false, error: rr.error, detail: rr, candidates: 0 }
  const r = await chat(rr.candidate, messages, opts)
  return Object.assign({}, r, { candidate: rr.candidate, candidates: 1 })
}

module.exports = { DEFAULT_PORTS, normalizeBase, pickModelName, matchModel, listModels, resolve, scan, chat, ping, infer }
