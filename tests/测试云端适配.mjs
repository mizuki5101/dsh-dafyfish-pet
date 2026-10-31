// 云端 API 适配测试（不联网；fetch 全部注入假实现）
//   node _research-data/测试云端适配.mjs
//
// 起因（2026-10-31）：博士接 DeepSeek 官方 API，面板「确认 API 连接」是绿的、真调用全 400 ——
// ping() 不带 response_format，而心跳等真调用带 json_schema，DeepSeek 明确不收。
// 这里锁住 vision.js 的云端适配行为：主机识别、请求体组装、400 拒绝后降级重试、
// 图片被拒的人话提示、/v1/models 短缓存。
import v from '../shell/src/heart/vision.js'
const { normalizeBase, isDeepseekHost, isLoopbackHost, messagesHaveImage, stripImageParts, buildBody, chat, resolve } = v

let pass = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) pass++
  else fails.push(name + (extra ? ' → ' + JSON.stringify(extra).slice(0, 160) : ''))
}

/* ───── ① 主机识别 ───── */
console.log('【1】isDeepseekHost / isLoopbackHost')
{
  ok('deepseek 官方域名', isDeepseekHost('https://api.deepseek.com/v1') === true)
  ok('deepseek 带路径', isDeepseekHost('https://api.deepseek.com/beta') === true)
  ok('大小写不敏感', isDeepseekHost('https://DEEPSEEK.com/v1') === true)
  ok('apifox 中转不算', isDeepseekHost('https://api.deepseekfake.com/v1') === false)
  ok('本地不算', isDeepseekHost('http://127.0.0.1:8080/v1') === false)
  ok('坏 URL 不炸', isDeepseekHost('不是地址') === false)

  ok('localhost 是环回', isLoopbackHost('http://localhost:11434/v1') === true)
  ok('127.0.0.1 是环回', isLoopbackHost('http://127.0.0.1:19411/v1') === true)
  ok('IPv6 环回（带方括号）', isLoopbackHost('http://[::1]:9000/v1') === true)
  ok('云端不是环回', isLoopbackHost('https://api.deepseek.com/v1') === false)
  ok('局域网不是环回（非标准参数不发）', isLoopbackHost('http://192.168.1.5:8080/v1') === false)
  ok('坏 URL 不炸', isLoopbackHost('') === false)
}

/* ───── ② normalizeBase 只认 http/https（既有闸门，锁住别丢） ───── */
console.log('【2】normalizeBase 方案闸门')
{
  ok('ftp 被拒', normalizeBase('ftp://example.com/v1') === '')
  ok('file 被拒', normalizeBase('file:///etc/passwd') === '')
  ok('空被拒', normalizeBase('') === '')
  ok('https 正常补 /v1', normalizeBase('https://api.deepseek.com') === 'https://api.deepseek.com/v1')
  ok('尾部斜杠收掉', normalizeBase('http://127.0.0.1:8080/v1/') === 'http://127.0.0.1:8080/v1')
}

/* ───── ③ buildBody：response_format / chat_template_kwargs 的分发 ───── */
console.log('【3】buildBody 组装')
{
  const msgs = [{ role: 'user', content: 'hi' }]
  const local = { baseUrl: 'http://127.0.0.1:19411/v1', model: 'qwen-vl', apiKey: '' }
  const cloud = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'k' }

  const b1 = buildBody(local, msgs, { schema: { type: 'object' }, enableThinking: false }, {})
  ok('本地：json_schema 照发', b1.response_format && b1.response_format.type === 'json_schema' && b1.response_format.json_schema.strict === true)
  ok('本地：enable_thinking 照发', b1.chat_template_kwargs && b1.chat_template_kwargs.enable_thinking === false)
  ok('本地：默认温度 0.2 / 160 token', b1.temperature === 0.2 && b1.max_tokens === 160 && b1.stream === false)

  const b2 = buildBody(cloud, msgs, { schema: { type: 'object' }, enableThinking: false }, {})
  ok('DeepSeek：json_schema 不发', b2.response_format === undefined)
  ok('DeepSeek：本地思考参数不发', b2.chat_template_kwargs === undefined)
  ok('DeepSeek：关思考用 thinking.type=disabled', b2.thinking && b2.thinking.type === 'disabled', b2.thinking)
  ok('DeepSeek：model/messages 照常', b2.model === 'deepseek-chat' && b2.messages === msgs)

  const other = { baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: '' }
  const b6 = buildBody(other, msgs, { enableThinking: false }, {})
  ok('非 deepseek 云端：两套思考参数都不发', b6.thinking === undefined && b6.chat_template_kwargs === undefined)
  const b7 = buildBody(cloud, msgs, {}, {})
  ok('没要求关思考就不发 thinking', b7.thinking === undefined)

  // DeepSeek 的 schema 请求：什么都不发（json_schema 400、json_object 会退化成空白正文）
  const jsonMsgs = [{ role: 'system', content: '只输出 JSON 对象，不要解释' }, { role: 'user', content: 'hi' }]
  const b8 = buildBody(cloud, jsonMsgs, { schema: { type: 'object' } }, {})
  ok('DeepSeek：schema 请求裸发（json_object 实测会退化成空白）', b8.response_format === undefined, b8.response_format)
  const b10 = buildBody(cloud, jsonMsgs, { schema: { type: 'object' } }, { noFormat: true })
  ok('记仇后同样裸发', b10.response_format === undefined)

  const b3 = buildBody(local, msgs, { schema: { type: 'object' }, enableThinking: false }, { noFormat: true })
  ok('记仇后：response_format 不发', b3.response_format === undefined)
  ok('记仇后：本地思考参数保留', b3.chat_template_kwargs && b3.chat_template_kwargs.enable_thinking === false)

  const b4 = buildBody(cloud, msgs, { jsonObject: true }, {})
  ok('DeepSeek 的 json_object 照发（它支持）', b4.response_format && b4.response_format.type === 'json_object')
  const b5 = buildBody(cloud, msgs, { jsonObject: true }, { noFormat: true })
  ok('记仇后 json_object 也不发', b5.response_format === undefined)

  ok('maxTokens 硬顶 2048', buildBody(cloud, msgs, { maxTokens: 99999 }, {}).max_tokens === 2048)
  ok('maxTokens 缺省 160', buildBody(cloud, msgs, {}, {}).max_tokens === 160)
}

/* ───── ④ messagesHaveImage ───── */
console.log('【4】messagesHaveImage')
{
  const withImg = [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'data:...' } }] }]
  const textOnly = [{ role: 'user', content: [{ type: 'text', text: 'x' }] }]
  ok('带图识别', messagesHaveImage(withImg) === true)
  ok('纯文本不误报', messagesHaveImage(textOnly) === false)
  ok('字符串 content 不误报', messagesHaveImage([{ role: 'user', content: 'hi' }]) === false)
  ok('空消息', messagesHaveImage([]) === false && messagesHaveImage(null) === false)
}

/* ───── ⑤ chat：response_format 被拒 → 记住 → 降级重试 ───── */
console.log('【5】chat 的 400 降级重试（假 fetch）')
{
  const realFetch = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/chat/completions')) {
      const b = JSON.parse(init.body)
      bodies.push(b)
      if (b.response_format) {
        return {
          ok: false, status: 400,
          text: async () => '{"error":{"message":"This response_format type is unavailable now (request_id: 8d5e)"}}',
          json: async () => ({}),
        }
      }
      return { ok: true, status: 200, text: async () => 'ok', json: async () => ({ choices: [{ message: { content: '你好呀' } }], usage: { total_tokens: 5 } }) }
    }
    return { ok: true, status: 200, text: async () => '[]', json: async () => ({ data: [] }) }
  }
  try {
    const cand = { baseUrl: 'https://api.example.com/v1', model: 'm1', apiKey: 'k' }
    const msgs = [{ role: 'user', content: '在吗' }]
    const r1 = await chat(cand, msgs, { schema: { type: 'object' }, maxTokens: 100, timeoutMs: 3000 })
    ok('重试后成功', r1.ok === true && r1.text === '你好呀', r1)
    ok('恰好打了两次（拒一次+重试一次）', bodies.length === 2, bodies.length)
    ok('第一次带了 json_schema', bodies[0] && !!bodies[0].response_format)
    ok('第二次降级成裸请求', bodies[1] && bodies[1].response_format === undefined)
    ok('云端不带本地思考参数', bodies.every((b) => b.chat_template_kwargs === undefined))

    const r2 = await chat(cand, msgs, { schema: { type: 'object' }, maxTokens: 100, timeoutMs: 3000 })
    ok('记仇后一次就成', r2.ok === true && bodies.length === 3, bodies.length)
    ok('记仇后请求体没 response_format', bodies[2] && bodies[2].response_format === undefined)

    await chat({ baseUrl: 'https://api.example.com/v1', model: 'm2', apiKey: 'k' }, msgs, { schema: {}, timeoutMs: 3000 })
    ok('换模型要重新撞一次（键含 model）', bodies.length === 5, bodies.length)

    // 图片被拒 → 人话提示（不重试，response_format 无关）
    bodies.length = 0
    globalThis.fetch = async (url, init) => {
      bodies.push(JSON.parse(init.body))
      return {
        ok: false, status: 400,
        text: async () => '{"error":{"message":"deepseek-chat does not support image input"}}',
        json: async () => ({}),
      }
    }
    const imgMsgs = [{ role: 'user', content: [{ type: 'text', text: '看' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,xx' } }] }]
    const r3 = await chat({ baseUrl: 'https://api.example.com/v1', model: 'chat-only' }, imgMsgs, { maxTokens: 10, timeoutMs: 3000 })
    ok('只打一次（无 response_format 可降）', bodies.length === 1, bodies.length)
    ok('带「看不了图」人话提示', r3.ok === false && r3.hint && r3.hint.includes('看不了图'), r3)

    // 空正文（思考型模型吃光预算）→ 加大 max_tokens 重试一次
    bodies.length = 0
    let emptyCalls = 0
    globalThis.fetch = async (url, init) => {
      bodies.push(JSON.parse(init.body))
      emptyCalls++
      if (emptyCalls === 1) {
        return {
          ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: '', reasoning_content: '我想想啊……'.repeat(50) } }], usage: {} }),
          text: async () => 'ok',
        }
      }
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: '{"see":"ok"}' } }], usage: {} }),
        text: async () => 'ok',
      }
    }
    const r4 = await chat({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' }, [{ role: 'user', content: 'hi' }], { maxTokens: 160, timeoutMs: 3000, enableThinking: false })
    ok('空正文后加大预算重试', r4.ok === true && r4.text === '{"see":"ok"}' && r4.bumpedTokens >= 1024, r4)
    ok('重试体 max_tokens 变大', bodies[1] && bodies[1].max_tokens >= 1024, bodies[1] && bodies[1].max_tokens)
    ok('重试体带 thinking=disabled', bodies.every((b) => b.thinking && b.thinking.type === 'disabled'))

    bodies.length = 0
    emptyCalls = 0
    globalThis.fetch = async (url, init) => {
      bodies.push(JSON.parse(init.body))
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: '', reasoning_content: '还在想' } }], usage: {} }),
        text: async () => 'ok',
      }
    }
    const r5 = await chat({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' }, [{ role: 'user', content: 'hi' }], { maxTokens: 1600, timeoutMs: 3000 })
    ok('预算已经够大就不补（只打一次）', r5.ok === false && bodies.length === 1, bodies.length)
    ok('空正文错误说破原因', r5.error.includes('思考'), r5.error)

    // 空白正文（真机 22:50 踩过：content=一串空格）必须视同空，而不是当成有效正文
    bodies.length = 0
    emptyCalls = 0
    globalThis.fetch = async (url, init) => {
      bodies.push(JSON.parse(init.body))
      emptyCalls++
      if (emptyCalls === 1) {
        return {
          ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: '   ', finish_reason: 'stop' } }], usage: { completion_tokens: 3 } }),
          text: async () => 'ok',
        }
      }
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: '{"see":"ok"}' } }], usage: {} }),
        text: async () => 'ok',
      }
    }
    const r6 = await chat({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' }, [{ role: 'user', content: 'hi' }], { maxTokens: 160, timeoutMs: 3000, enableThinking: false })
    ok('空白正文视同空并重试', r6.ok === true && r6.text === '{"see":"ok"}', r6)

    // 带图时空正文：加预算仍空 → 去图再试一次
    bodies.length = 0
    emptyCalls = 0
    const imgPart = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,xx' } }
    globalThis.fetch = async (url, init) => {
      bodies.push(JSON.parse(init.body))
      emptyCalls++
      if (emptyCalls < 3) {
        return {
          ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: '', reasoning_content: '', finish_reason: 'stop' } }], usage: { completion_tokens: 1 } }),
          text: async () => 'ok',
        }
      }
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: '{"see":"ok"}' } }], usage: {} }),
        text: async () => 'ok',
      }
    }
    const r7 = await chat(
      { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
      [{ role: 'user', content: [{ type: 'text', text: '看' }, imgPart] }],
      { maxTokens: 160, timeoutMs: 3000, enableThinking: false },
    )
    ok('加预算仍空 → 去图重试成功', r7.ok === true && r7.droppedImage === true, r7)
    ok('第三次请求已经没有图', bodies.length === 3 && !bodies[2].messages.some((x) => Array.isArray(x.content) && x.content.some((p) => p.type === 'image_url')), bodies.length)
    ok('stripImageParts 保文本去图', JSON.stringify(stripImageParts([{ role: 'user', content: [{ type: 'text', text: '看' }, imgPart] }])) === '[{"role":"user","content":[{"type":"text","text":"看"}]}]')
  } finally {
    globalThis.fetch = realFetch
  }
}

/* ───── ⑥ resolve：/v1/models 短缓存（命中不重打、失配强制刷新） ───── */
console.log('【6】resolve 的 models 缓存')
{
  const realFetch = globalThis.fetch
  let modelCalls = 0
  let chatCalls = 0
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/models')) {
      modelCalls++
      return {
        ok: true, status: 200,
        json: async () => ({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }),
        text: async () => '[]',
      }
    }
    chatCalls++
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }),
      text: async () => 'ok',
    }
  }
  try {
    const cfg = { model: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'k' } }
    const r1 = await resolve(cfg)
    ok('首次解析成功', r1.ok === true && r1.candidate.model === 'deepseek-chat', r1)
    ok('密钥进 candidate（不回传页面）', r1.candidate.apiKey === 'k')
    ok('只打了一次 /models', modelCalls === 1, modelCalls)

    await resolve(cfg)
    ok('缓存命中：不再打 /models', modelCalls === 1, modelCalls)

    const r3 = await resolve({ model: { baseUrl: 'https://api.deepseek.com', model: 'nope', apiKey: 'k' } })
    ok('失配报 model-not-found', r3.ok === false && r3.error === 'model-not-found', r3)
    ok('失配时强制刷新过一次', modelCalls === 2, modelCalls)

    const r4 = await resolve({ model: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-reasoner', apiKey: 'k' } })
    ok('刷新后的缓存直接可用', r4.ok === true && r4.candidate.model === 'deepseek-reasoner' && modelCalls === 2, modelCalls)
    ok('chat 通道没被这几下碰过', chatCalls === 0, chatCalls)
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log('\n——— 结果：' + pass + ' 通过 / ' + fails.length + ' 失败 ———')
if (fails.length) {
  fails.forEach((f) => console.log('  ✗ ' + f))
  process.exit(1)
}
