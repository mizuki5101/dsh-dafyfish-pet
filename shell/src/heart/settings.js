'use strict'
// settings.json 的读写（主进程）。
//
// 为什么单独一个文件：设置面板要能改心跳配置，而 settings.json 里还有 dualWindow / linkDsh /
// assetRoots 这些别的键，**不能整份覆盖**。这里只做「读 → 合并 heart 段 → 原子写」。

const fs = require('node:fs')
const path = require('node:path')

function readJson(file, fallback) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return j && typeof j === 'object' ? j : fallback
  } catch (e) {
    return fallback
  }
}

/** 递归合并：对象逐键合并，数组/标量整体替换，undefined 跳过。 */
function deepMerge(base, patch) {
  const out = Object.assign({}, base && typeof base === 'object' ? base : {})
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out
  for (const k of Object.keys(patch)) {
    const v = patch[k]
    if (v === undefined) continue
    const cur = out[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = deepMerge(cur, v)
    } else {
      out[k] = v
    }
  }
  return out
}

/** 原子写：先写 .tmp 再替换，避免写到一半断电把设置写坏。 */
function writeJson(file, obj) {
  const dir = path.dirname(file)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (e) {}
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  try {
    fs.renameSync(tmp, file)
  } catch (e) {
    // Windows 上目标被占用时 rename 会失败：退化成直接写
    fs.writeFileSync(file, JSON.stringify(obj, null, 2))
    try {
      fs.unlinkSync(tmp)
    } catch (e2) {}
  }
}

/** 读整份设置 → 合并 heart 段 → 写回。返回写后的整份设置。 */
function patchHeart(file, patch) {
  const all = readJson(file, {})
  all.heart = deepMerge(all.heart || {}, patch || {})
  writeJson(file, all)
  return all
}

/**
 * 设置面板提交的 patch → 只保留认识的字段（白名单）。
 *
 * 为什么必须有：面板发过来的是**页面构造的对象**，不该什么都能写进 settings.json。
 * 为什么放到这个文件：白名单漏字段的症状极其隐蔽 —— 保存返回 ok、界面刷新了、
 * 但值没变（2026-10-20 的 bili 就是这个：滑块和视频口味全被丢掉）。
 * 放在纯函数文件里才能被测到（见 测试心跳纯函数.mjs 的【5】）。
 */
function sanitizeHeartPatch(p) {
  const src = p && typeof p === 'object' ? p : {}
  const out = {}
  if (typeof src.enabled === 'boolean') out.enabled = src.enabled
  for (const k of ['intervalSec', 'lookMinGapSec', 'sayMinGapSec', 'maxLooksPerHour', 'maxSaysPerHour']) {
    if (src[k] !== undefined && Number.isFinite(Number(src[k]))) out[k] = Math.round(Number(src[k]))
  }
  if (typeof src.lookOpener === 'boolean') out.lookOpener = src.lookOpener
  if (typeof src.prompt === 'string') out.prompt = src.prompt.slice(0, 4000)
  if (src.mode === 'dsh' || src.mode === 'pet') out.mode = src.mode
  if (typeof src.audioTrigger === 'boolean') out.audioTrigger = src.audioTrigger
  if (src.model && typeof src.model === 'object') {
    const m = {}
    if (typeof src.model.provider === 'string') m.provider = src.model.provider
    if (src.model.port !== undefined && Number.isFinite(Number(src.model.port))) m.port = Math.round(Number(src.model.port))
    if (typeof src.model.baseUrl === 'string') m.baseUrl = src.model.baseUrl.trim().slice(0, 300)
    if (typeof src.model.model === 'string') m.model = src.model.model.trim().slice(0, 200)
    if (typeof src.model.apiKey === 'string') m.apiKey = src.model.apiKey.slice(0, 500)
    if (Object.keys(m).length) out.model = m
  }
  if (src.modelServer && typeof src.modelServer === 'object') {
    const s = {}
    for (const k of ['exe', 'model', 'mmproj', 'extraArgs']) {
      if (typeof src.modelServer[k] === 'string') s[k] = src.modelServer[k].slice(0, 500)
    }
    if (Object.keys(s).length) out.modelServer = s
  }
  // 刷视频：视频口味 + 抽帧数（2026-10-20）
  if (src.bili && typeof src.bili === 'object') {
    const b = {}
    if (typeof src.bili.enabled === 'boolean') b.enabled = src.bili.enabled
    if (src.bili.source === 'search' || src.bili.source === 'rcmd') b.source = src.bili.source
    // 空数组要放行：这是「清空口味、退回首页推荐」的合法操作
    if (Array.isArray(src.bili.keywords)) {
      b.keywords = src.bili.keywords
        .filter((x) => typeof x === 'string' && x.trim())
        .map((x) => x.trim().slice(0, 24))
        .slice(0, 10)
    }
    if (src.bili.maxFrames !== undefined && Number.isFinite(Number(src.bili.maxFrames))) {
      b.maxFrames = Math.round(Number(src.bili.maxFrames))
    }
    if (src.bili.cooldownSec !== undefined && Number.isFinite(Number(src.bili.cooldownSec))) {
      b.cooldownSec = Math.round(Number(src.bili.cooldownSec))
    }
    if (Object.keys(b).length) out.bili = b
  }
  // 做梦（2026-10-21）：开关 + 冷却 + 日记目录
  // ⚠️ 漏了这段的症状：面板显示保存成功、界面刷新了，值却没变
  if (src.dream && typeof src.dream === 'object') {
    const d = {}
    if (typeof src.dream.enabled === 'boolean') d.enabled = src.dream.enabled
    if (src.dream.cooldownSec !== undefined && Number.isFinite(Number(src.dream.cooldownSec))) {
      d.cooldownSec = Math.round(Number(src.dream.cooldownSec))
    }
    // 空串是合法值：表示「回到默认目录」
    if (typeof src.dream.dir === 'string') d.dir = src.dream.dir.trim().slice(0, 300)
    if (Object.keys(d).length) out.dream = d
  }
  // 划词翻译 / 识图（2026-10-22）。
  // ⚠️ 漏了这段 = 又一次「保存成功、界面刷新、值没变」；空串/空数组都要放行
  //    （清空 apiKey、清空 skipApps 都是合法操作，normalize 会补回默认值或保持为空）。
  if (src.tools && typeof src.tools === 'object') {
    const t = {}
    const st = src.tools.translate
    if (st && typeof st === 'object') {
      const x = {}
      if (typeof st.enabled === 'boolean') x.enabled = st.enabled
      if (typeof st.engine === 'string') x.engine = st.engine
      if (typeof st.to === 'string') x.to = st.to.trim().slice(0, 20)
      for (const k of ['maxChars', 'dragPx']) {
        if (st[k] !== undefined && Number.isFinite(Number(st[k]))) x[k] = Math.round(Number(st[k]))
      }
      if (typeof st.restoreClipboard === 'boolean') x.restoreClipboard = st.restoreClipboard
      if (Array.isArray(st.skipApps)) {
        x.skipApps = st.skipApps
          .filter((v) => typeof v === 'string' && v.trim())
          .map((v) => v.trim().slice(0, 80))
          .slice(0, 20)
      }
      if (st.api && typeof st.api === 'object') {
        const a = {}
        if (typeof st.api.baseUrl === 'string') a.baseUrl = st.api.baseUrl.trim().slice(0, 300)
        if (typeof st.api.model === 'string') a.model = st.api.model.trim().slice(0, 200)
        if (typeof st.api.apiKey === 'string') a.apiKey = st.api.apiKey.slice(0, 500)
        if (Object.keys(a).length) x.api = a
      }
      if (Object.keys(x).length) t.translate = x
    }
    const sv = src.tools.vision
    if (sv && typeof sv === 'object') {
      const v = {}
      if (typeof sv.enabled === 'boolean') v.enabled = sv.enabled
      for (const k of ['minSize', 'maxTokens']) {
        if (sv[k] !== undefined && Number.isFinite(Number(sv[k]))) v[k] = Math.round(Number(sv[k]))
      }
      if (typeof sv.prompt === 'string') v.prompt = sv.prompt.slice(0, 2000)
      // 「回答问题」开关（2026-10-27）：漏了这一行 = 面板点了保存、返回 ok、值不变
      if (typeof sv.answer === 'boolean') v.answer = sv.answer
      if (Object.keys(v).length) t.vision = v
    }
    if (Object.keys(t).length) out.tools = t
  }
  // 「声音」/TTS（2026-10-24）。空串都要放行（清空 apiKey / 换参考音频路径是合法操作）。
  // ⚠️ 漏了这段 = 又一次「保存成功、界面刷新、值没变」。
  if (src.tts && typeof src.tts === 'object') {
    const t = {}
    if (typeof src.tts.enabled === 'boolean') t.enabled = src.tts.enabled
    if (src.tts.backend === 'gptsovits' || src.tts.backend === 'gsvlite' || src.tts.backend === 'openai') t.backend = src.tts.backend
    if (typeof src.tts.baseUrl === 'string') t.baseUrl = src.tts.baseUrl.trim().slice(0, 300)
    if (typeof src.tts.apiKey === 'string') t.apiKey = src.tts.apiKey.slice(0, 500)
    if (typeof src.tts.model === 'string') t.model = src.tts.model.trim().slice(0, 200)
    if (typeof src.tts.voice === 'string') t.voice = src.tts.voice.trim().slice(0, 200)
    if (typeof src.tts.refAudioPath === 'string') t.refAudioPath = src.tts.refAudioPath.trim().slice(0, 500)
    if (typeof src.tts.promptAudioPath === 'string') t.promptAudioPath = src.tts.promptAudioPath.trim().slice(0, 500)
    if (typeof src.tts.promptText === 'string') t.promptText = src.tts.promptText.slice(0, 300)
    for (const k of ['speed', 'maxChars', 'timeoutMs']) {
      if (src.tts[k] !== undefined && Number.isFinite(Number(src.tts[k]))) t[k] = Number(src.tts[k])
    }
    if (src.tts.sources && typeof src.tts.sources === 'object') {
      const s = {}
      for (const k of ['chat', 'heart', 'bili', 'work']) {
        if (typeof src.tts.sources[k] === 'boolean') s[k] = src.tts.sources[k]
      }
      if (Object.keys(s).length) t.sources = s
    }
    if (Object.keys(t).length) out.tts = t
  }
  // 连续上下文（2026-10-31）。漏了这段 = 又一次「保存成功、界面刷新、值没变」。
  if (src.context && typeof src.context === 'object') {
    const t = {}
    if (typeof src.context.enabled === 'boolean') t.enabled = src.context.enabled
    for (const k of ['windowTokens', 'summaryDays']) {
      if (src.context[k] !== undefined && Number.isFinite(Number(src.context[k]))) t[k] = Math.round(Number(src.context[k]))
    }
    if (Object.keys(t).length) out.context = t
  }
  // 模型条目（2026-11-01）：数组整体替换（deepMerge 对数组就是覆盖）。
  // apiKey 只有字符串才收：undefined/null = 保留旧值（carryOverEntryKeys 回填），'' = 明确清空。
  if (Array.isArray(src.models)) {
    out.models = src.models
      .filter((m) => m && typeof m === 'object')
      .slice(0, 8)
      .map((m) => {
        const e = {}
        if (typeof m.id === 'string' && m.id.trim()) e.id = m.id.trim().slice(0, 40)
        if (typeof m.name === 'string') e.name = m.name.trim().slice(0, 30)
        if (typeof m.baseUrl === 'string') e.baseUrl = m.baseUrl.trim().slice(0, 300)
        if (typeof m.model === 'string') e.model = m.model.trim().slice(0, 200)
        if (typeof m.apiKey === 'string') e.apiKey = m.apiKey.slice(0, 500)
        if (m.timeoutMs !== undefined && Number.isFinite(Number(m.timeoutMs))) e.timeoutMs = Math.round(Number(m.timeoutMs))
        if (typeof m.enableThinking === 'boolean') e.enableThinking = m.enableThinking
        // 「声音细节」跟条目走（2026-11-01）：只有这个条目负责「声音」板块时才有意义
        if (m.tts && typeof m.tts === 'object' && !Array.isArray(m.tts)) {
          const t = {}
          for (const k of ['backend', 'voice', 'refAudioPath', 'promptAudioPath', 'promptText']) {
            if (typeof m.tts[k] === 'string') t[k] = m.tts[k].slice(0, 500)
          }
          for (const k of ['speed', 'maxChars', 'timeoutMs']) {
            if (m.tts[k] !== undefined && Number.isFinite(Number(m.tts[k]))) t[k] = Number(m.tts[k])
          }
          if (Object.keys(t).length) e.tts = t
        }
        return e
      })
      .filter((e) => Object.keys(e).length)
  }
  if (src.roles && typeof src.roles === 'object' && !Array.isArray(src.roles)) {
    const r = {}
    for (const k of ['see', 'answer', 'dream', 'chat', 'bili', 'tts', 'translate']) {
      const v = src.roles[k]
      if (typeof v === 'string') r[k] = v.trim().slice(0, 40)
    }
    if (Object.keys(r).length) out.roles = r
  }
  return out
}

/**
 * 条目密钥回填（纯函数，可单测）：payload 给页面的是 apiKeySet 布尔，页面编辑条目后
 * 存回来的 patch 里没有明文密钥 —— models 又是**数组整体替换**，不回填就会把密钥洗掉。
 * 规则：patch 条目 apiKey 为 undefined/null → 沿用旧条目（按 id 对上）的密钥；
 *       '' 或非空字符串 = 页面明确要 清空/设置，尊重不填。
 */
function carryOverEntryKeys(prev, next) {
  const byId = new Map((Array.isArray(prev) ? prev : []).map((m) => (m && m.id ? [m.id, m] : null)).filter(Boolean))
  return (Array.isArray(next) ? next : []).map((m) => {
    if (!m || typeof m !== 'object') return m
    if (m.apiKey === undefined || m.apiKey === null) {
      const old = byId.get(m.id)
      if (old && typeof old.apiKey === 'string' && old.apiKey) return Object.assign({}, m, { apiKey: old.apiKey })
    }
    return m
  })
}

/**
 * 打日志专用：把任何密钥字段换成 '***'，其余原样（纯函数，可单测）。
 *
 * 为什么需要：`heart:save` 以前直接 `JSON.stringify(clean)` 写进 boot.log，
 * 而 clean 里有 `model.apiKey`（还有 2026-10-22 新加的 tools.translate.api.apiKey）
 * —— 等于在 %APPDATA% 里留一份明文副本。
 *
 * 规则：键名像密钥（apiKey / secret / token / password / credential）且值是**非空字符串**
 * 才替换；布尔（apiKeySet）和空串保持原样，否则日志会看不出"到底设没设"。
 * 数组/对象递归处理，不认识的类型原样返回。
 */
const SECRET_KEY_RE = /(apikey|api_key|secret|token|password|passwd|credential)/i

function redactForLog(input, depth) {
  const d = Number(depth) || 0
  if (d > 6) return '[deep]'
  if (input == null) return input
  if (Array.isArray(input)) return input.map((x) => redactForLog(x, d + 1))
  if (typeof input !== 'object') return input
  const out = {}
  for (const k of Object.keys(input)) {
    const v = input[k]
    if (SECRET_KEY_RE.test(k) && typeof v === 'string' && v) out[k] = '***'
    else out[k] = redactForLog(v, d + 1)
  }
  return out
}

module.exports = { readJson, writeJson, deepMerge, patchHeart, sanitizeHeartPatch, redactForLog, carryOverEntryKeys }
