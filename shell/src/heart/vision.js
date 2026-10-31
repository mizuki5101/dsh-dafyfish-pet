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
//
// 2026-10-31 起也对接云端 OpenAI 兼容 API（博士接了 DeepSeek 官方）。云端的脾气，实测/核实：
//   · response_format: json_schema 明确不收（400 "This response_format type is unavailable now"）
//     —— 而「确认连接」的 ping() 不带这个字段，所以会出现「连接是通的、真调用全挂」。
//     ⇒ deepseek 主机的 schema 请求**什么都不发**：json_schema 它 400；json_object 它会
//     概率性退化成「200 + 一串空格正文」（四路二分钉死，见 buildBody 内注释与交接文档）。
//     格式合规靠提示词 + decide.RETRY_JSON 的 bad-json 强制重试。其它端点被 400 拒一次就记住再降级。
//   · chat_template_kwargs（enable_thinking）是 llama.cpp / vLLM 的本地参数 ⇒ 只发给环回地址。
//   · 视觉：DeepSeek 已有多模态（deepseek-flash 系，收 base64 data URL 的 image_url，
//     2026-10 官方文档核实）⇒ 不需要 modelVision 双端点分流，一个端点全包。

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

// ———— 云端适配（2026-10-31）：主机识别 / 请求体组装 / 拒绝降级 ————

/** response_format 被端点拒绝时的识别（DeepSeek 原话 "This response_format type is unavailable now"） */
const RE_FORMAT_REJECT = /response_format|json_schema|json mode|must contain the word/i

function hostOf(baseUrl) {
  try {
    return new URL(String(baseUrl)).hostname.toLowerCase()
  } catch (e) {
    return ''
  }
}

/** DeepSeek 官方不收 json_schema；它的 json_object 又要求提示词里必须出现 "json" 一词。
 *  两个条件都太挑 ⇒ 它的主机一律不发 response_format，靠提示词约束 + 上层解析容错
 *  （decide.js 本来就有 garbled/重试闸门）。 */
function isDeepseekHost(baseUrl) {
  const h = hostOf(baseUrl)
  return h === 'deepseek.com' || h.endsWith('.deepseek.com')
}

/** 非标准参数（chat_template_kwargs）只发给本机引擎：llama.cpp / vLLM 认它，
 *  云端不认识，有的会整个请求 400。环回地址 = 「本地引擎」最可靠的信号。 */
function isLoopbackHost(baseUrl) {
  const h = hostOf(baseUrl)
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'
}

/** 消息里带不带图（云端纯文本模型收到图会 400，提示要指路视觉端点） */
function messagesHaveImage(messages) {
  for (const m of messages || []) {
    if (Array.isArray(m && m.content) && m.content.some((p) => p && p.type === 'image_url')) return true
  }
  return false
}

/** 去掉消息里的图（保留文本部分）。2026-10-31 真机实测：某些屏幕内容会让模型
 *  返回 200 + 空白正文（疑似内容触发的回避），去掉图再试一次通常就正常。 */
function stripImageParts(messages) {
  return (messages || []).map((m) => {
    if (!m || !Array.isArray(m.content)) return m
    const kept = m.content.filter((p) => !p || p.type !== 'image_url')
    return Object.assign({}, m, { content: kept })
  })
}

/**
 * 请求体组装（纯函数，可单测）。
 * caps：该端点已知的「不收」能力（noFormat = 别再发 response_format），
 * 由 chat() 在被 400 拒后记住，同一进程内不再撞第二次。
 */
function buildBody(candidate, messages, opts, caps) {
  const o = opts || {}
  const c = caps || {}
  const body = {
    model: candidate.model || 'default',
    messages,
    temperature: Number.isFinite(o.temperature) ? o.temperature : 0.2,
    // 硬顶 2048：只有「做梦」会要这么多（写一篇 1200 字的日记）。
    // 其它调用都只要 100~400，所以放宽上限不影响它们。
    max_tokens: Math.max(16, Math.min(2048, Number(o.maxTokens) || 160)),
    stream: false,
  }
  if (!c.noFormat) {
    if (o.schema && !isDeepseekHost(candidate.baseUrl)) {
      body.response_format = { type: 'json_schema', json_schema: { name: 'heart', strict: true, schema: o.schema } }
    } else if (o.jsonObject) {
      body.response_format = { type: 'json_object' }
    }
    // ⚠️ DeepSeek 的 schema 请求**什么都不发**（2026-10-31 四路二分的结论，试云端心跳.mjs --replay）：
    //   json_schema 它 400；json_object 它会退化成「200 + 一串空格正文」——原样重放复现空白、
    //   去掉 json_object 立刻好好说话、去掉图照样空白 ⇒ 触发器就是 json_object 本身，且概率性
    //   （同样的请求有时正常，更不能靠）。格式合规交给提示词 + bad-json 时的 RETRY_JSON 强制重试。
  }
  // 关思考（2026-10-31 实测补的第二课）：
  //   本地引擎（llama.cpp/vLLM）认 chat_template_kwargs.enable_thinking；
  //   DeepSeek 官方认 thinking.type='disabled'（enable_thinking 会被它忽略）。
  //   忽略的后果是思考型模型（deepseek-flash 等）把 max_tokens 全花在 reasoning_content 上
  //   —— HTTP 200、正文空串，心跳 30 秒等来一个「没说话」（boot.log: empty content）。
  if (o.enableThinking === false) {
    if (isLoopbackHost(candidate.baseUrl)) body.chat_template_kwargs = { enable_thinking: false }
    else if (isDeepseekHost(candidate.baseUrl)) body.thinking = { type: 'disabled' }
  }
  return body
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
 * /v1/models 的短缓存：以前每次 infer 都先打一发 models —— 本地无所谓，
 * 接云端后等于每句话两倍请求数 + 白白多一截延迟（2026-10-31）。
 * 只缓存「命中」的列表；一旦匹配不上（换模型 / llama-swap 换了模型）就强制刷新一次再判，
 * 所以缓存永远不会把用户困在过时列表里。
 */
let MODEL_CACHE = { key: '', at: 0, models: null }
const MODEL_CACHE_TTL = 5 * 60 * 1000

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
  const listOpts = { apiKey: m.apiKey, timeoutMs: 1500 }
  const cached = MODEL_CACHE.key === base && MODEL_CACHE.models && Date.now() - MODEL_CACHE.at < MODEL_CACHE_TTL
  let models = cached ? MODEL_CACHE.models : null
  if (!models) {
    models = await listModels(base, listOpts)
    if (models) MODEL_CACHE = { key: base, at: Date.now(), models }
  }
  if (!models) {
    return { ok: false, error: 'endpoint-unreachable', baseUrl: base, hint: '连不上 ' + base + '/models（服务没起，或不是 OpenAI 兼容）' }
  }
  let mm = matchModel(models, m.model)
  if (!mm.ok && cached) {
    models = await listModels(base, listOpts)
    if (models) {
      MODEL_CACHE = { key: base, at: Date.now(), models }
      mm = matchModel(models, m.model)
    }
  }
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

/** 同一进程内记住「哪个端点不收 response_format」，别每次调用都撞一次 400。 */
const FORMAT_CAPS = new Map()
function capsKey(candidate) {
  return String((candidate && candidate.baseUrl) || '') + '|' + String((candidate && candidate.model) || '')
}

async function postChat(candidate, body, timeoutMs) {
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
      const msg = (ch && ch.message) || {}
      // ⚠️ 必须 trim：真机遇到过 content = 一串空格（200/stop），不 trim 会被当成有效正文
      const text = String(msg.content || '').trim()
      if (!text) {
        // 空正文把能拿到的证据全说破：思考长度（思考没关掉？）/ finish_reason / 完成了多少 token
        const reasoning = String(msg.reasoning_content || msg.reasoning || '').trim()
        const finish = (ch && ch.finish_reason) || ''
        const done = j && j.usage && j.usage.completion_tokens
        return {
          ok: false,
          error:
            'empty content' +
            (reasoning ? '（思考了 ' + reasoning.length + ' 字没写正文）' : '') +
            (finish ? '（finish=' + finish + (Number.isFinite(done) ? '，completion=' + done + ' token' : '') + '）' : ''),
          ms,
          reasoning: reasoning.slice(0, 2000),
        }
      }
      return { ok: true, text, ms, usage: (j && j.usage) || null }
    }, timeoutMs)
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 }
  }
}

/**
 * 调一次 chat/completions。
 * 云端适配（2026-10-31）：response_format 被拒（400）就记住并降级重试一次；
 * 纯文本端点收到截图也会 400 —— 报错带人话提示（真正的分流靠 modelVision，见交接文档）。
 * @returns {Promise<{ok:true,text:string,ms:number,usage:object|null}|{ok:false,error:string,status?:number,hint?:string}>}
 */
async function chat(candidate, messages, opts) {
  const o = opts || {}
  const timeoutMs = o.timeoutMs || 20000
  const key = capsKey(candidate)
  const caps = FORMAT_CAPS.get(key) || {}
  const body = buildBody(candidate, messages, o, caps)
  let r = await postChat(candidate, body, timeoutMs)
  if (!r.ok && r.status === 400 && body.response_format && RE_FORMAT_REJECT.test(r.error || '')) {
    caps.noFormat = true
    FORMAT_CAPS.set(key, caps)
    r = await postChat(candidate, buildBody(candidate, messages, o, caps), timeoutMs)
  }
  // 空正文兜底（2026-10-31 实测）：思考参数万一没被认，思考照样吃光小预算。
  // 加大 max_tokens 再试一次 —— 思维链写完还有地方放正文。只补一次，不无限重试。
  if (!r.ok && String(r.error || '').startsWith('empty content') && Number(o.maxTokens) < 1024) {
    const bigger = Math.min(2048, Math.max(1024, (Number(o.maxTokens) || 160) * 4))
    r = await postChat(candidate, buildBody(candidate, messages, Object.assign({}, o, { maxTokens: bigger }), caps), timeoutMs)
    if (r.ok) r.bumpedTokens = bigger
  }
  // 空正文第二级兜底（2026-10-31 真机）：去掉图再试一次。某些屏幕内容会让模型
  // 返回 200 + 空白正文，去掉图就好了。只在还带着图时才走这一步。
  if (!r.ok && String(r.error || '').startsWith('empty content') && messagesHaveImage(messages)) {
    r = await postChat(candidate, buildBody(candidate, stripImageParts(messages), o, caps), timeoutMs)
    if (r.ok) r.droppedImage = true
  }
  if (!r.ok && r.status === 400 && messagesHaveImage(messages) && /image|vision|multi.?modal|visual|图片/i.test(r.error || '')) {
    r.hint = '这个端点看不了图：心跳看屏/识图要在「视觉端点」里另配一个能看图的模型'
  }
  return r
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

module.exports = {
  DEFAULT_PORTS, normalizeBase, pickModelName, matchModel, listModels, resolve, scan, chat, ping, infer,
  // 云端适配（2026-10-31）—— 导出便于纯函数单测
  isDeepseekHost, isLoopbackHost, messagesHaveImage, stripImageParts, buildBody,
}
