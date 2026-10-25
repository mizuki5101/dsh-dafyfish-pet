// TTS 模块的纯函数测试（不联网、不开窗口；合成走注入的假 fetch，缓存走临时目录）
//   node _research-data/测试TTS纯函数.mjs
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { cleanSpeechText, cutAtSentence } from '../shell/src/tts/speak-text.js'
import { buildGptsovitsRequest, buildGsvliteRequest, buildOpenaiRequest, synthesize, detectAudio, mapTtsError } from '../shell/src/tts/tts-client.js'
import { isTtsFileName, cacheKey, cacheHas, cacheSave, pruneCache, countCache, cacheUrl, CACHE_MAX } from '../shell/src/tts/tts-cache.js'
import { createTts } from '../shell/src/tts/index.js'
import { DEFAULTS, normalize } from '../shell/src/heart/config.js'
import { sanitizeHeartPatch, redactForLog } from '../shell/src/heart/settings.js'

let pass = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) pass++
  else fails.push(name + (extra ? ' → ' + JSON.stringify(extra).slice(0, 160) : ''))
}

/* ───── ① 台词清洗 ───── */
console.log('【1】speak-text.cleanSpeechText')
{
  ok('普通台词原样', cleanSpeechText('主人，喝口水。', 120) === '主人，喝口水。')
  ok('markdown 强调符号被剥', cleanSpeechText('**主人**，`喝口水`。', 120) === '主人，喝口水。')
  ok('URL 被去掉', !cleanSpeechText('看这个 https://example.com/a?b=1 好玩', 120).includes('http'))
  ok('emoji 被去掉', cleanSpeechText('你好😀呀', 120) === '你好呀')
  ok('换行折叠成空格', cleanSpeechText('第一句\n\n第二句', 120) === '第一句 第二句')
  ok('括号旁注保留（那是台词）', cleanSpeechText('（脸黑了）这个报错了', 120).includes('脸黑了'))
  ok('空/非字符串 → 空', cleanSpeechText('', 120) === '' && cleanSpeechText(null, 120) === '')
  ok('纯符号清洗后为空', cleanSpeechText('😀😀 **', 120) === '')
  ok('上限内不截断', cleanSpeechText('一二三四五', 10) === '一二三四五')
  const cut = cleanSpeechText('第一句。第二句。第三句。', 8)
  ok('按句边界截断', cut === '第一句。第二句。', cut)
  const hard = cutAtSentence('没有句号的超长句子'.repeat(5), 10)
  ok('找不到句号就硬切到上限', hard.length === 10)
  ok('句点太靠前宁可硬切', cutAtSentence('啊。' + 'x'.repeat(20), 12).endsWith('xxxxxxxxxx'))
  ok('引号/书名号不误伤', cleanSpeechText('她说「主人」真爱看《书》', 120) === '她说「主人」真爱看《书》')
  ok('maxChars 非法取默认', cleanSpeechText('一二三四五', 0) === '一二三四五' && cleanSpeechText('x'.repeat(500), NaN).length <= 120)
}

/* ───── ② GPT-SoVITS 适配器 ───── */
console.log('【2】tts-client.buildGptsovitsRequest')
{
  const cfg = { backend: 'gptsovits', baseUrl: 'http://127.0.0.1:9880/', refAudioPath: 'D:/ref.wav', promptText: '参考音频的原话', speed: 1.25 }
  const r = buildGptsovitsRequest(cfg, '主人好')
  ok('拼出 /tts 端点（尾斜杠吃掉）', r.url === 'http://127.0.0.1:9880/tts', r.url)
  const body = JSON.parse(r.init.body)
  ok('文本进 body', body.text === '主人好')
  ok('中文语言标记', body.text_lang === 'zh' && body.prompt_lang === 'zh')
  ok('参考音频走本机路径', body.ref_audio_path === 'D:/ref.wav')
  ok('转写文本进 prompt_text', body.prompt_text === '参考音频的原话')
  ok('语速进 speed_factor', body.speed_factor === 1.25)
  ok('整段非流式 + wav', body.streaming_mode === false && body.media_type === 'wav')
  ok('分句方法 cut5', body.text_split_method === 'cut5')
  ok('没填参考音频在发请求前就拦住', buildGptsovitsRequest({ baseUrl: 'http://x' }, 'hi').error.includes('参考音频'))
  ok('没填地址拦住', buildGptsovitsRequest({ refAudioPath: 'D:/a.wav' }, 'hi').error.includes('地址'))
  ok('语速非法回落 1', JSON.parse(buildGptsovitsRequest({ baseUrl: 'http://x', refAudioPath: 'a', speed: 0 }, 'hi').init.body).speed_factor === 1)
}

/* ───── ③ OpenAI 兼容适配器 ───── */
console.log('【3】tts-client.buildOpenaiRequest')
{
  const r = buildOpenaiRequest({ backend: 'openai', baseUrl: 'http://api.x.com', model: 'm1', voice: 'v1', apiKey: 'k1', speed: 1 }, 'hi')
  ok('自动补 /v1 + /audio/speech', r.url === 'http://api.x.com/v1/audio/speech', r.url)
  ok('带 Bearer', r.init.headers.Authorization === 'Bearer k1')
  const body = JSON.parse(r.init.body)
  ok('模型/音色/文本/格式', body.model === 'm1' && body.voice === 'v1' && body.input === 'hi' && body.response_format === 'wav')
  ok('baseUrl 已带 /v1 不重复', buildOpenaiRequest({ baseUrl: 'http://a/v1/', model: 'm' }, 'x').url === 'http://a/v1/audio/speech')
  ok('没模型名拦住', buildOpenaiRequest({ baseUrl: 'http://a' }, 'x').error.includes('模型'))
}

/* ───── ③b GSV-TTS-Lite 适配器（两步协议）───── */
console.log('【3b】tts-client.buildGsvliteRequest + 两步合成')
{
  const cfg = { backend: 'gsvlite', baseUrl: 'http://127.0.0.1:8000/', refAudioPath: 'D:/ref.wav', promptText: '原话', speed: 1 }
  const r = buildGsvliteRequest(cfg, '主人好')
  ok('Lite 端点 /tts/single（尾斜杠吃掉）', r.url === 'http://127.0.0.1:8000/tts/single', r.url)
  const body = JSON.parse(r.init.body)
  ok('音色参考 = 参考音频', body.speaker_audio === 'D:/ref.wav')
  ok('风格参考默认同一段（原版零克隆的等价行为）', body.prompt_audio === 'D:/ref.wav')
  ok('转写进 prompt_text', body.prompt_text === '原话')
  ok('没参考音频在发请求前拦住', buildGsvliteRequest({ baseUrl: 'http://x' }, 'hi').error.includes('参考音频'))
  const r2 = buildGsvliteRequest({ backend: 'gsvlite', baseUrl: 'http://x', refAudioPath: 'a', promptAudioPath: 'D:/style.wav' }, 'hi')
  ok('风格参考可单独指定', JSON.parse(r2.init.body).prompt_audio === 'D:/style.wav')
  // 两步合成：第一步回 JSON 带文件名，第二步 /audio/{name} 拉字节
  const WAV = Buffer.concat([Buffer.from([0x52, 0x49, 0x46, 0x46]), Buffer.alloc(100)])
  const wavAb = () => WAV.buffer.slice(WAV.byteOffset, WAV.byteOffset + WAV.byteLength)
  const calls = []
  const fakeTwoStep = async (url) => {
    calls.push(String(url))
    if (String(url).endsWith('/tts/single')) {
      return { status: 200, json: async () => ({ success: true, filename: 'abc.wav' }) }
    }
    return { status: 200, arrayBuffer: async () => wavAb() }
  }
  const rr = await synthesize({ backend: 'gsvlite', baseUrl: 'http://x:8000', refAudioPath: 'a' }, 'hi', { fetchImpl: fakeTwoStep })
  ok('两步合成拿到音频', rr.ok && rr.audioType === 'wav', rr)
  ok('第二步确实去拉了 /audio/abc.wav', calls.length === 2 && calls[1].includes('/audio/abc.wav'), calls)
  const rj = await synthesize({ backend: 'gsvlite', baseUrl: 'http://x', refAudioPath: 'a' }, 'hi', {
    fetchImpl: async () => ({ status: 200, json: async () => ({ success: false }) }),
  })
  ok('success=false 报人话原因', !rj.ok && rj.reason.includes('没给音频'), rj.reason)
}

/* ───── ④ 合成（注入假 fetch）───── */
console.log('【4】tts-client.synthesize')
{
  // ⚠️ 不能直接给 arrayBuffer() 返回 WAV.buffer：Buffer.concat 会落进 8KB 池，
  // byteOffset 可能非 0，Buffer.from(整个 pool) 开头就不是 RIFF 了 —— 必须 slice 出独立副本。
  const wavAb = (n) => {
    const b = Buffer.concat([Buffer.from([0x52, 0x49, 0x46, 0x46]), Buffer.alloc(n)])
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  }
  const fakeOk = async () => ({ status: 200, arrayBuffer: async () => wavAb(60) })
  let r = await synthesize({ backend: 'gptsovits', baseUrl: 'http://x', refAudioPath: 'a' }, '主人', { fetchImpl: fakeOk })
  ok('正常合成返回音频', r.ok && r.audioType === 'wav')
  ok('RIFF 识别为 wav', detectAudio(Buffer.concat([Buffer.from([0x52, 0x49, 0x46, 0x46]), Buffer.alloc(60)])) === 'wav')
  ok('ID3 识别为 mp3', detectAudio(Buffer.concat([Buffer.from([0x49, 0x44, 0x33]), Buffer.alloc(20)])) === 'mp3')
  ok('短 buffer / 非 audio 返回 null', detectAudio(Buffer.from('{"message":"x"}')) === null)
  r = await synthesize({ baseUrl: 'http://x', refAudioPath: 'a' }, 'hi', {
    fetchImpl: async () => ({ status: 400, json: async () => ({ message: '参考音频在3~10秒范围外，请更换！' }) }),
  })
  ok('400 带上服务端信息', !r.ok && r.reason.includes('3~10秒'), r.reason)
  r = await synthesize({ baseUrl: 'http://x', refAudioPath: 'a' }, 'hi', { fetchImpl: async () => ({ status: 500, json: async () => { throw new Error('no json') }, text: async () => 'boom' }) })
  ok('非 JSON 错误也有详情', !r.ok && r.reason.includes('boom'))
  r = await synthesize({ baseUrl: 'http://x', refAudioPath: 'a' }, 'hi', { fetchImpl: async () => { throw new Error('fetch failed') } })
  ok('连不上翻译成人话', !r.ok && r.reason.includes('没连上'), r.reason)
  r = await synthesize({ baseUrl: 'http://x', refAudioPath: 'a' }, 'hi', { fetchImpl: async () => ({ status: 200, arrayBuffer: async () => Buffer.from('not audio').buffer }) })
  ok('返回不是音频要报出来', !r.ok && r.reason.includes('不是音频'))
  r = await synthesize({ baseUrl: '', refAudioPath: 'a' }, 'hi', { fetchImpl: fakeOk })
  ok('配置不齐不发请求', !r.ok && r.reason.includes('地址'))
  ok('mapTtsError 超时', mapTtsError(new Error('This operation was aborted')).includes('超时'))
  ok('mapTtsError 兜底带原文', mapTtsError(new Error('EPIPE broken')).includes('EPIPE'))
}

/* ───── ⑤ 缓存 ───── */
console.log('【5】tts-cache')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-tts-'))
  ok('文件名白名单只认 32hex.wav', isTtsFileName('a'.repeat(32) + '.wav') && !isTtsFileName('../etc.wav') && !isTtsFileName('a.wav'))
  const k1 = cacheKey({ backend: 'gptsovits', speed: 1 }, '主人好')
  ok('键是 32 位 hex', /^[0-9a-f]{32}$/.test(k1))
  ok('同输入同键', cacheKey({ backend: 'gptsovits', speed: 1 }, '主人好') === k1)
  ok('文本变键变', cacheKey({ backend: 'gptsovits', speed: 1 }, '主人坏') !== k1)
  ok('语速变键变', cacheKey({ backend: 'gptsovits', speed: 1.5 }, '主人好') !== k1)
  ok('参考音频变键变', cacheKey({ backend: 'gptsovits', refAudioPath: 'b' }, '主人好') !== k1)
  ok('apiKey 不进键（磁盘不留可辨识痕迹）', cacheKey({ backend: 'gptsovits', apiKey: 'A' }, 'x') === cacheKey({ backend: 'gptsovits', apiKey: 'B' }, 'x'))
  ok('没存过 = 没有', !cacheHas(dir, k1))
  cacheSave(dir, k1, Buffer.alloc(100))
  ok('存了就有（>44 字节）', cacheHas(dir, k1))
  ok('URL 形状', cacheUrl(k1) === '/dsh-pet/tts/' + k1 + '.wav')
  // LRU：塞满 + 5 条，只留最新的 CACHE_MAX 条
  for (let i = 0; i < CACHE_MAX + 5; i++) {
    const f = path.join(dir, String(i).padStart(32, '0') + '.wav')
    fs.writeFileSync(f, Buffer.alloc(100))
    const st = fs.statSync(f)
    fs.utimesSync(f, new Date(st.atimeMs + i * 1000), new Date(st.mtimeMs + i * 1000))
  }
  const removed = pruneCache(dir)
  // 目录里还躺着上面 cacheSave 的那条，所以是 CACHE_MAX+1 条里清到上限
  ok('超限清理到上限', removed >= 5 && countCache(dir) === CACHE_MAX, { removed, count: countCache(dir) })
  ok('没超限不动手', pruneCache(dir) === 0)
  fs.rmSync(dir, { recursive: true, force: true })
}

/* ───── ⑥ 配置五道关 ───── */
console.log('【6】heart.tts 的 DEFAULTS / normalize / 白名单')
{
  const d = DEFAULTS.tts
  ok('默认关、默认本地后端', d.enabled === false && d.backend === 'gptsovits')
  ok('默认地址 9880', d.baseUrl === 'http://127.0.0.1:9880')
  ok('默认来源：chat/heart 开、bili/work 关', d.sources.chat === true && d.sources.heart === true && d.sources.bili === false && d.sources.work === false)
  const n = normalize({ tts: { enabled: true, backend: 'openai', speed: 0.2, maxChars: 9999, timeoutMs: 1, sources: { bili: true }, refAudioPath: ' D:/a.wav ' } })
  ok('normalize 保留合法值', n.tts.enabled === true && n.tts.backend === 'openai')
  ok('语速夹在 0.5~2（不取整！）', n.tts.speed === 0.5, n.tts.speed)
  ok('maxChars 夹到 300', n.tts.maxChars === 300)
  ok('timeoutMs 夹到下限 1000', n.tts.timeoutMs === 1000)
  ok('路径去空格', n.tts.refAudioPath === 'D:/a.wav')
  ok('来源合并不整丢', n.tts.sources.bili === true && n.tts.sources.chat === true)
  ok('非法后端回落 gptsovits', normalize({ tts: { backend: 'xxx' } }).tts.backend === 'gptsovits')
  ok('gsvlite 后端放行', normalize({ tts: { backend: 'gsvlite' } }).tts.backend === 'gsvlite')
  ok('风格参考路径过白名单', sanitizeHeartPatch({ tts: { promptAudioPath: ' D:/s.wav ' } }).tts.promptAudioPath === 'D:/s.wav')
  ok('speed 1.5 不被取整', normalize({ tts: { speed: 1.5 } }).tts.speed === 1.5)
  const clean = sanitizeHeartPatch({ tts: { enabled: true, baseUrl: ' http://x ', apiKey: 'k', junk: 1, sources: { chat: false }, speed: 1.2 } })
  ok('白名单放行认识的字段', clean.tts && clean.tts.enabled === true && clean.tts.baseUrl === 'http://x' && clean.tts.apiKey === 'k')
  ok('白名单丢掉垃圾字段', !('junk' in clean.tts))
  ok('sources 只放行布尔', clean.tts.sources.chat === false && Object.keys(clean.tts.sources).length === 1)
  ok('speed 保留小数（不 round）', clean.tts.speed === 1.2)
  ok('空 patch 不产生 tts 段', !sanitizeHeartPatch({ tts: 'junk' }).tts)
  {
    const r = sanitizeHeartPatch({ tts: { apiKey: 'SECRET' } })
    ok('日志脱敏覆盖 tts.apiKey', JSON.stringify(redactForLog(r)).includes('"apiKey":"***"'))
  }
}

/* ───── ⑦ 编排层（假 fetch + 临时目录，走完整 speak 流程）───── */
console.log('【7】tts/index 编排')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-tts2-'))
  const pushed = []
  const WAV = Buffer.concat([Buffer.from([0x52, 0x49, 0x46, 0x46]), Buffer.alloc(200)])
  const wavAb = () => WAV.buffer.slice(WAV.byteOffset, WAV.byteOffset + WAV.byteLength)
  const cfg = () => ({
    enabled: true,
    backend: 'gptsovits',
    baseUrl: 'http://127.0.0.1:9880',
    refAudioPath: 'D:/ref.wav',
    promptText: 'ref',
    speed: 1,
    maxChars: 120,
    timeoutMs: 3000,
    sources: { chat: true, heart: true, bili: false, work: false },
  })
  const tts = createTts({
    dir,
    push: (m) => pushed.push(m),
    getCfg: cfg,
  })
  // createTts 不透传 fetchImpl（编排层不做 I/O 注入面），合成走全局 fetch —— 用 stub 顶上
  const realFetch = global.fetch
  global.fetch = async () => ({ status: 200, arrayBuffer: async () => wavAb() })
  try {
    let r = await tts.speak('heart', '主人，坐下休息一会儿。')
    ok('首次合成成功并推送', r.ok && pushed.length === 1 && pushed[0].t === 'tts-play', { r, pushed: pushed.length })
    ok('推送带同源 url', pushed.length > 0 && /^\/dsh-pet\/tts\/[0-9a-f]{32}\.wav$/.test(pushed[0].url), pushed.length > 0 ? pushed[0].url : null)
    ok('来源标记 heart', pushed.length > 0 && pushed[0].source === 'heart')
    r = await tts.speak('heart', '主人，坐下休息一会儿。')
    ok('第二遍命中缓存（不再合成）', r.ok && r.cached === true && pushed.length === 2)
    r = await tts.speak('bili', '刷视频的正文')
    ok('来源关掉就不合成', !r.ok && r.reason === 'source-off')
  } finally {
    global.fetch = realFetch
  }
  const ttsOff = createTts({ dir, push: () => {}, getCfg: () => Object.assign(cfg(), { enabled: false }) })
  const rOff = await ttsOff.speak('heart', 'x')
  ok('总开关关闭 → disabled', !rOff.ok && rOff.reason === 'disabled')
  const ttsEmpty = createTts({ dir, push: () => {}, getCfg: () => Object.assign(cfg(), { enabled: true }) })
  const rEmpty = await ttsEmpty.speak('heart', '😀😀 **')
  ok('清洗后为空 → empty', !rEmpty.ok && rEmpty.reason === 'empty')
  const ttsFail = createTts({ dir, push: () => {}, getCfg: cfg })
  const rf = global.fetch
  global.fetch = async () => { throw new Error('fetch failed') }
  const rFail = await ttsFail.speak('heart', '会失败的一句')
  global.fetch = rf
  ok('失败不抛异常、有原因', !rFail.ok && rFail.reason.includes('没连上'), rFail.reason)
  ok('失败记进状态', ttsFail.status().lastError.includes('没连上'))
  ok('状态里有缓存条数', tts.status().cacheCount >= 1)
  ok('试听绕过来源但不绕配置（没配 sources 之外的照样报）', (await createTts({ dir, push: () => {}, getCfg: () => null }).test()).reason === 'no-config')
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('\n——— 结果：' + pass + ' 通过 / ' + fails.length + ' 失败 ———')
if (fails.length) {
  fails.forEach((f) => console.log('  ✗ ' + f))
  process.exit(1)
}
