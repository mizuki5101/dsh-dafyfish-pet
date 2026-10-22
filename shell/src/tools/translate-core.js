'use strict'

// 翻译引擎的**纯协议层**：拼请求、解析响应、切块、错误归一。
// 零 require —— 网络那一层在 translate.js，这里只做能被 node 直接测的部分。
//
// 三档引擎：
//   free  ：腾讯 Transmart 的网页接口（免 key、国内直连、2000 字约 420ms）
//   api   ：OpenAI 兼容 /chat/completions（用户自己填端点 + key）
//   local ：同上，但端点取 heart.model（本地推理引擎）
//
// ⚠️ 2026-10-22 实测记录（别再走回头路）：
//   - 微软 Edge 的 `https://edge.microsoft.com/translate/auth` 现在返回 **404**（空 body），
//     原计划拿它的匿名 JWT 再用 api-edge.cognitive.microsofttranslator.com —— 已不可用。
//   - `translate.googleapis.com/translate_a/single?client=gtx` 本机 **fetch failed**（直连不通）。
//   - `www.bing.com/ttranslatev3` 需要页面里的 IG/IID 且返回空 body，不可靠。
//   - `fanyi.youdao.com/translate?...` 已退化成返回整页 HTML。
//   - 腾讯 `transmart.qq.com/api/imt` **可用**：auto 检测源语言、保留换行、中文原样返回。
//     所以免费档就是它；以后若它挂了，只有这一处需要换（buildQqRequest / extractQqText）。

const QQ_API_URL = 'https://transmart.qq.com/api/imt'
/** Transmart 的网页端固定 client_key（不是用户凭据，公开前端里就有） */
const QQ_CLIENT_KEY = 'browser-chrome-110.0.0-Mac OS-df4bd4c5-a65d-44b2-a40f-42f34f3535f2-1677486696487'
/** 免费档单块上限：2000 字实测 420ms，再长容易撞限流 */
const FREE_MAX_CHUNK = 2000
/** OpenAI 兼容档单块上限（中文 1500 字 ≈ 2000~3000 token，本地小模型也扛得住） */
const CHAT_MAX_CHUNK = 1500

/** 面板上的 to（'zh-Hans'）→ Transmart 的 lang（'zh'） */
function mapTargetLang(to) {
  const t = String(to || '').toLowerCase()
  if (!t) return 'zh'
  if (t.startsWith('zh')) return 'zh'
  if (t.startsWith('en')) return 'en'
  if (t.startsWith('ja')) return 'ja'
  if (t.startsWith('ko')) return 'ko'
  return t.split('-')[0]
}

/** 免费档请求体。source.lang='auto' = 自动检测源语言 */
function buildQqRequest(text, to) {
  return {
    header: { fn: 'auto_translation', client_key: QQ_CLIENT_KEY },
    type: 'plain',
    model_category: 'normal',
    source: { lang: 'auto', text_list: [String(text == null ? '' : text)] },
    target: { lang: mapTargetLang(to) },
  }
}

/** 免费档响应 → 译文 */
function extractQqText(json) {
  const ret = json && json.header && json.header.ret_code
  if (ret && ret !== 'succ') return { ok: false, reason: 'free-' + String(ret) }
  const arr = json && Array.isArray(json.auto_translation) ? json.auto_translation : []
  const text = arr
    .map((x) => (typeof x === 'string' ? x : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
  if (!text) return { ok: false, reason: 'free-empty' }
  return { ok: true, text, detected: (json && json.src_lang) || '' }
}

/** 给 api / local 两档共用的 system 提示词 */
function buildChatSystem(to) {
  const target = to === 'zh-Hans' || !to ? '简体中文' : String(to)
  return (
    '你是翻译引擎。把用户发来的文本翻译成' +
    target +
    '。\n' +
    '规则：\n' +
    '1) 只输出译文，不要解释、不要加引号、不要 markdown、不要"译文："这种前缀；\n' +
    '2) 原文已经是' +
    target +
    '就原样返回；\n' +
    '3) 保留原文的换行与段落；技术术语/代码/专有名词不要翻成奇怪的东西；\n' +
    '4) 不确定的地方宁可直译，不要自己编内容。'
  )
}

function buildChatMessages(text, to) {
  return [
    { role: 'system', content: buildChatSystem(to) },
    { role: 'user', content: String(text == null ? '' : text) },
  ]
}

/** OpenAI 兼容响应 → 译文。思考模型会把内容放进 reasoning_content，这里只认 content */
function extractChatText(json) {
  const msg = json && json.choices && json.choices[0] && json.choices[0].message
  const content = msg && typeof msg.content === 'string' ? msg.content.trim() : ''
  if (!content) return { ok: false, reason: 'chat-empty' }
  return { ok: true, text: content }
}

/**
 * 长文本切块：**保留分隔符**，所以 chunks.join('') === 原串（总长守恒，可断言）。
 * 优先在中文句末/换行处切，其次在英文句末，最后才硬切；不切断英文单词。
 */
function splitChunks(text, maxLen) {
  if (typeof text !== 'string' || !text) return []
  const max = Math.max(200, Math.round(Number(maxLen) || 4000))
  if (text.length <= max) return [text]
  const out = []
  let i = 0
  const half = Math.floor(max * 0.5)
  while (i < text.length) {
    let end = Math.min(text.length, i + max)
    if (end < text.length) {
      const from = i + half
      const win = text.slice(from, end)
      let cut = -1
      for (const mark of ['。', '！', '？', '\n', '. ', '! ', '? ', '；', '; ']) {
        const idx = win.lastIndexOf(mark)
        if (idx >= 0) cut = Math.max(cut, idx + mark.length)
      }
      if (cut > 0) end = from + cut
    }
    if (end < text.length && /[A-Za-z0-9]/.test(text[end - 1]) && /[A-Za-z0-9]/.test(text[end])) {
      const sp = text.lastIndexOf(' ', end)
      if (sp > i + half) end = sp + 1
    }
    if (end <= i) end = Math.min(text.length, i + max)
    out.push(text.slice(i, end))
    i = end
  }
  return out
}

/** 错误归一：给面板/气泡看的一句话，不暴露内部堆栈 */
function describeError(reason) {
  const map = {
    'free-empty': '免费翻译没返回译文',
    'free-http-429': '免费翻译被限流了，等一会儿再试',
    'chat-empty': '模型返回了空内容（可能把预算花在思考上了）',
    'chat-http-401': 'API Key 不对',
    'chat-http-404': 'API 地址或模型名不对',
    'no-endpoint': '没配端点',
    'no-model': '没配模型名',
    timeout: '请求超时',
    network: '网络不通',
    empty: '没有可翻译的文本',
    'too-short': '选中的字太少',
    'too-long': '选中的内容太长（超过 2 万字）',
  }
  if (map[reason]) return map[reason]
  if (typeof reason === 'string' && reason.startsWith('http-')) return '接口返回 HTTP ' + reason.slice(5)
  if (typeof reason === 'string' && reason.startsWith('free-')) return '免费翻译接口异常（' + reason + '）'
  return '翻译失败（' + (reason || '未知原因') + '）'
}

module.exports = {
  QQ_API_URL,
  QQ_CLIENT_KEY,
  FREE_MAX_CHUNK,
  CHAT_MAX_CHUNK,
  mapTargetLang,
  buildQqRequest,
  extractQqText,
  buildChatSystem,
  buildChatMessages,
  extractChatText,
  splitChunks,
  describeError,
}
