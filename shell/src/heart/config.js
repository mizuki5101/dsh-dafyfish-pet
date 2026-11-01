'use strict'
// 心跳配置的归一化（纯函数，不依赖 electron，可单测）。
//
// 为什么不在 pet.js 的 CFG 里：心跳属于外壳（采集 + 模型都在主进程），
// 它的开关和阈值必须能在 DSH 关着的时候也生效，所以读的是 %APPDATA%/DS-WhaleGirl-Pet/settings.json。
// 默认值一律「不打扰、可回退、默认关」——公共仓库里别人不装模型也能用。

const DEFAULTS = {
  enabled: false,
  intervalSec: 15,
  lookMinGapSec: 60,
  maxLooksPerHour: 20,
  sayMinGapSec: 180,
  maxSaysPerHour: 15,
  /** 看屏幕前先冒一句「让我看看主人在干嘛～」，并把这句话交给模型接话头 */
  lookOpener: true,
  /** 对话按钮往哪送：'dsh' = 工作模式（走 DSH 会话）；'pet' = 回应模式（直接问聊天模型） */
  mode: 'dsh',
  /**
   * 回应模式保留的对话历史预算（粗略 token 估算）。
   * 16384 ≈ 30~40 轮短对话；超了才从最旧裁，至少保留 6 轮。
   * 为什么不直接顶到模型窗口上限：首次/换模型没有前缀缓存，全量 prefill
   * 本机 9B 约 977 tok/s，太长会让第一句等几十秒。
   */
  chatMaxTokens: 16384,
  /** 听觉感知 burst 时立刻看一眼（等价「立即看一眼」） */
  audioTrigger: true,
  nightQuiet: true,
  skipWhenIdleSec: 900,
  failBackoffSec: 30,
  requestTimeoutMs: 20000,
  capture: { mode: 'screen', maxEdge: 1280, quality: 72, diffThreshold: 6 },
  gate: { blockedApps: [] },
  model: {
    provider: 'auto',
    port: 19411,
    baseUrl: '',
    model: '',
    apiKey: '',
    timeoutMs: 20000,
    maxTokens: 160,
    downsample: '16x',
    maxSliceNums: 2,
    enableThinking: false,
  },
  escalate: { toDsh: false },
  memory: { enabled: true, storeImages: false, keepDays: 14 },
  /**
   * 「刷一条视频」：点按钮才刷，60 秒冷却。
   * enabled 默认 true —— 它不发任何写请求（只读 B 站公开接口），开关只是给「不想让她上网」的人。
   * source：'search' = 按 keywords 随机挑一个检索（相关、可预期）；
   *         'rcmd'   = 首页推荐流（会刷到不感兴趣的东西，2026-10-20 用户实测后改成 search 默认）。
   * keywords：一天里轮着用；空数组时自动退回 rcmd。
   */
  bili: {
    enabled: true,
    cooldownSec: 60,
    /** 抽帧数（3~10，默认 3）。面板里是滑块；light 档最多用 3 帧。 */
    maxFrames: 3,
    memoMax: 40,
    memoDays: 14,
    source: 'search',
    keywords: ['AI 工具', '大模型 实测', '动画 杂谈', '独立游戏'],
  },
  /** 提示词覆盖（空 = 用 prompt.js 里的默认 SYSTEM） */
  prompt: '',
  /**
   * 「做梦」（2026-10-21）：她睡着时回顾「上次醒来 → 这次睡着」的素材，写一篇日记。
   * 默认**关闭**，且不要求先开心跳/刷视频；但必须有可用的模型/API（面板里写明）。
   * cooldownSec 默认 30 分钟：主人忙时（无互动、鼠标乱划）她会反复醒了又睡，
   *   没有冷却就会一直发这种无用请求。
   * dir 留空 = %APPDATA%/DS-WhaleGirl-Pet/肥鱼日记（面板里可改）。
   */
  dream: { enabled: false, cooldownSec: 1800, dir: '' },
  /**
   * 「功能面板」里的两个工具（2026-10-22）。都挂在 heart 段下 —— 和 bili / dream 一样，
   * 这里其实是「需要模型/需要配置的功能」的集合，不是纯粹的"心跳"。
   *
   * translate：划词翻译。默认**关闭**（要用 koffi 轮询全局左键 + 模拟 Ctrl+C，没配好会白跑）。
   *   engine：'free'  = 腾讯 Transmart 网页接口（默认，免 key、国内直连）
   *           'api'   = 用户自己填的 OpenAI 兼容端点（独立配置，不复用 heart.model）
   *           'local' = 直接用 heart.model 那个本地端点
   *   skipApps：这些进程里**不检测**——终端里模拟 Ctrl+C 会打断正在跑的命令，
   *             风险远大于收益；code.exe 内置终端同理。
   * vision：识图（实验性）。Shift+右击她 → 框一块屏幕 → 让模型描述。
   */
  tools: {
    translate: {
      enabled: false,
      engine: 'free',
      to: 'zh-Hans',
      maxChars: 4000,
      dragPx: 8,
      restoreClipboard: true,
      skipApps: [
        'windowsterminal.exe',
        'conhost.exe',
        'cmd.exe',
        'powershell.exe',
        'pwsh.exe',
        'mintty.exe',
        'wezterm-gui.exe',
        'alacritty.exe',
        'conemu64.exe',
        'code.exe',
      ],
      api: { baseUrl: '', model: '', apiKey: '' },
    },
    // answer：图里有问题就回答（2026-10-27，默认**关**）。
    //   关着 = 只描述，和以前完全一样。开 = 多走一跳，用她的人格答图里的问题。
    //   默认关不是"没做完"，是防注入的主防线：截图里的字可以是别人写的，
    //   而开了这一项，那些字就会变成"要她回答的问题"。见 tools/read-core.js 文件头。
    vision: { enabled: false, minSize: 24, maxTokens: 300, prompt: '', answer: false },
  },
  /** 「一键启动」用的本地引擎配置（空路径 = 需要用户在面板里填） */
  modelServer: { exe: '', model: '', mmproj: '', extraArgs: '' },
  /**
   * 「声音」/TTS（2026-10-24）：让她的台词真正出声。默认**关闭**。
   * backend：'gptsovits' = 本地 GPT-SoVITS api_v2（整合包，主路线，文本不出门）
   *          'gsvlite'   = GSV-TTS-Lite（2026-10-25 加，pip 可装的高性能后端，/tts/single 两步协议）
   *          'openai'    = OpenAI 兼容 /audio/speech（云端克隆留的口子）
   * refAudioPath：3~10 秒参考音频的**本机路径**（api_v2 只收服务器本机路径）；
   * promptText：参考音频的逐字转写（不匹配会明显劣化）。
   * promptAudioPath：GSV-TTS-Lite 的「风格参考」，留空 = 同参考音频（原版零克隆的等价行为）。
   * timeoutMs 给大：CPU 合成 50 字要 2~3 秒，30s 覆盖整段长句。
   */
  tts: {
    enabled: false,
    backend: 'gptsovits',
    baseUrl: 'http://127.0.0.1:9880',
    apiKey: '',
    model: '',
    voice: '',
    refAudioPath: '',
    promptAudioPath: '',
    promptText: '',
    speed: 1,
    maxChars: 120,
    timeoutMs: 30000,
    sources: { chat: true, heart: true, bili: false, work: false },
  },
  /**
   * 连续上下文（2026-10-31）：心跳/对话的提示词改成
   * [稳定 system] + [近况回放=昨天以前的摘要] + [ledger 追加式窗口] + [本次新鲜情境尾]。
   * 历史只追加不重写 ⇒ 相邻请求共享越来越长的公共前缀 ⇒ DeepSeek 的自动前缀缓存
   * （命中约 1/10 价）与本地 llama-server 的 KV cache 都吃到。
   * enabled=false 完全回到旧拼装（ledger 照常记录，只是不喂给模型）。
   * windowTokens = 追加窗口的 token 预算。2026-11-01 博士拍板默认 200000（模型上下文
   * 量级）——代价是底账攒多后每跳的稳定前缀变大（缓存命中部分 1/10 价，整段仍计费）；
   * 超过模型装得下的量会 400，vision.js 的 overflow 阶梯会把窗口逐级砍半自适应（见那里）。
   * summaryDays = 「近况回放」回看几天。
   */
  context: { enabled: true, windowTokens: 200000, summaryDays: 3 },
  /**
   * 模型条目（2026-11-01，AI 面板的数据面）：一条 = 一个 OpenAI 兼容端点。
   * models 为空且 settings.json 里**没有** models 键时，normalize 会从旧字段
   * （heart.model / tools.translate.api）派生（见 deriveModels）——纯派生不落盘，
   * 面板第一次保存才会真正写进 settings.json。字段存在（哪怕空数组）就完全信任。
   */
  models: [],
  /** 板块 → 条目 id（互斥：单值结构天然一板块一模型）。'' = 未分配 → 回落 heart.model。 */
  roles: {},
}

const PROVIDERS = ['auto', 'separate', 'ollama', 'openai']
/** 翻译引擎白名单（面板里三选一；非法值一律回落默认的免费引擎） */
const ENGINES = ['free', 'api', 'local']

// ———— 模型条目系统（2026-11-01）————

/** 板块清单：谁要用模型。tts 走 TTS 适配器（端点跟条目，声音细节存 entry.tts），translate 额外允许 'free'。 */
const ROLES = ['see', 'answer', 'dream', 'chat', 'bili', 'tts', 'translate']
const MAX_MODELS = 8

/** 条目里的「声音细节」（entry.tts 白名单；端点 = 条目自己的 baseUrl/apiKey） */
const TTS_FIELDS = ['backend', 'voice', 'refAudioPath', 'promptAudioPath', 'promptText']

function normalizeEntryTts(raw) {
  const t = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  if (!t) return undefined
  const out = {}
  for (const k of TTS_FIELDS) {
    if (typeof t[k] === 'string') out[k] = t[k].slice(0, 500)
  }
  for (const k of ['speed', 'maxChars', 'timeoutMs']) {
    if (t[k] !== undefined && Number.isFinite(Number(t[k]))) out[k] = Number(t[k])
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * 条目白名单化。没有 baseUrl 的条目直接丢（引用它的板块在 normalizeRoles 里同步摘除）。
 * id 缺失/撞车时补一个稳定的（序号优先，撞车加随机尾巴）。
 */
function normalizeModels(raw) {
  const out = []
  const seen = new Set()
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!r || typeof r !== 'object') continue
    const baseUrl = str(r.baseUrl, '').trim().slice(0, 300)
    if (!baseUrl) continue
    let id = str(r.id, '').trim().slice(0, 40)
    if (!id) id = 'm' + (out.length + 1)
    if (seen.has(id)) {
      // 撞车补确定性后缀（不用随机数：id 要在多次保存之间保持稳定）
      let n = 2
      while (seen.has(id + '-' + n)) n++
      id = id + '-' + n
    }
    seen.add(id)
    const entry = {
      id,
      name: str(r.name, '').trim().slice(0, 30) || '模型 ' + (out.length + 1),
      baseUrl,
      model: str(r.model, '').trim().slice(0, 200),
      apiKey: str(r.apiKey, '').slice(0, 500),
      timeoutMs: num(r.timeoutMs, DEFAULTS.model.timeoutMs, 1000, 120000),
      enableThinking: r.enableThinking === true,
    }
    const tts = normalizeEntryTts(r.tts)
    if (tts) entry.tts = tts
    out.push(entry)
    if (out.length >= MAX_MODELS) break
  }
  return out
}

/**
 * 板块映射白名单化：值必须是「现存条目 id」（或 translate 的 'free'），
 * 否则一律记成 ''（未分配 → 调用侧回落 heart.model 旧路径）。
 * 删条目后它负责的板块会自动回到未分配 —— 不会留下悬空引用。
 */
function normalizeRoles(raw, models) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const ids = new Set((models || []).map((m) => m.id))
  const out = {}
  for (const role of ROLES) {
    const v = str(src[role], '')
    if (v && ids.has(v)) out[role] = v
    else if (role === 'translate' && v === 'free') out[role] = 'free'
    else out[role] = ''
  }
  return out
}

/**
 * 旧配置 → 条目的**纯派生迁移**（幂等，不写盘；面板第一次保存才落 settings.json）：
 *   · heart.model 有端点 → 「默认模型」条目接走全部 LLM 板块；
 *   · translate 引擎 'api' 且填了 api 端点 → 另起「翻译专用」条目；
 *     'local' → 也归「默认模型」（同一端点，行为等价）；'free'/没填 → 'free'。
 * settings.json 里 models 键**不存在**才派生 —— 键存在（哪怕空数组）代表面板已经
 * 接管（用户可能故意清空），绝不能再从旧字段变出来，否则条目删不掉。
 */
function deriveModels(model, tl) {
  const models = []
  const roles = {}
  const m = model || {}
  const t = tl || {}
  if (str(m.baseUrl, '').trim()) {
    const id = 'm1'
    models.push({
      id,
      name: '默认模型',
      baseUrl: str(m.baseUrl, '').trim().slice(0, 300),
      model: str(m.model, '').trim().slice(0, 200),
      apiKey: str(m.apiKey, '').slice(0, 500),
      timeoutMs: num(m.timeoutMs, DEFAULTS.model.timeoutMs, 1000, 120000),
      enableThinking: m.enableThinking === true,
    })
    for (const r of ['see', 'answer', 'dream', 'chat', 'bili']) roles[r] = id
    roles.tts = ''
    roles.translate = t.engine === 'local' ? id : 'free'
  } else {
    for (const r of ROLES) roles[r] = ''
  }
  const api = t.api || {}
  if (t.engine === 'api' && str(api.baseUrl, '').trim()) {
    models.push({
      id: 'translate',
      name: '翻译专用',
      baseUrl: str(api.baseUrl, '').trim().slice(0, 300),
      model: str(api.model, '').trim().slice(0, 200),
      apiKey: str(api.apiKey, '').slice(0, 500),
      timeoutMs: num(api.timeoutMs, 30000, 1000, 120000),
      enableThinking: false,
    })
    roles.translate = 'translate'
  }
  return { models, roles }
}

/**
 * 板块分配（纯函数，返回新对象不 mutate）。互斥由 roles[role] 的**单值**结构天然保证
 * （一个板块只能记一个条目 id；勾到 B 条目 = 自动从 A 摘除）。
 * @param modelId 条目 id | ''（取消分配）| 'free'（仅 translate）
 */
function assignRole(roles, role, modelId) {
  const out = Object.assign({}, roles || {})
  if (!ROLES.includes(role)) return out
  if (modelId === 'free' && role === 'translate') out[role] = 'free'
  else if (!modelId) out[role] = ''
  else out[role] = String(modelId).slice(0, 40)
  return out
}

/** 反查：这个条目负责哪些板块（AI 面板的勾选框要读它） */
function rolesOfEntry(roles, entryId) {
  return ROLES.filter((r) => roles && roles[r] === entryId)
}

function num(v, def, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** num 的可变精度版：speed 这种 0.5 步进的值不能 Math.round（1.5 会变 2） */
function numF(v, def, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, n))
}

function str(v, def) {
  return typeof v === 'string' ? v : def
}

function bool(v, def) {
  return typeof v === 'boolean' ? v : def
}

/** 把用户写的（可能残缺/越界的）heart 段变成一份可信配置 */
function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const cap = src.capture && typeof src.capture === 'object' ? src.capture : {}
  const gate = src.gate && typeof src.gate === 'object' ? src.gate : {}
  const model = src.model && typeof src.model === 'object' ? src.model : {}
  const esc = src.escalate && typeof src.escalate === 'object' ? src.escalate : {}
  const mem = src.memory && typeof src.memory === 'object' ? src.memory : {}
  const ms = src.modelServer && typeof src.modelServer === 'object' ? src.modelServer : {}
  const tsrc = src.tools && typeof src.tools === 'object' ? src.tools : {}
  const tl = tsrc.translate && typeof tsrc.translate === 'object' ? tsrc.translate : {}
  const tlApi = tl.api && typeof tl.api === 'object' ? tl.api : {}
  const vi = tsrc.vision && typeof tsrc.vision === 'object' ? tsrc.vision : {}
  const tt = src.tts && typeof src.tts === 'object' ? src.tts : {}
  const ttsSrc = tt.sources && typeof tt.sources === 'object' ? tt.sources : {}
  const cx = src.context && typeof src.context === 'object' ? src.context : {}
  const out = {
    enabled: src.enabled === true,
    // 2026-10-18 起：看屏间隔与说话间隔统一 15~600s（面板只有一个滑块）。
    intervalSec: num(src.intervalSec, DEFAULTS.intervalSec, 15, 600),
    lookMinGapSec: num(src.lookMinGapSec, DEFAULTS.lookMinGapSec, 15, 600),
    maxLooksPerHour: num(src.maxLooksPerHour, DEFAULTS.maxLooksPerHour, 1, 600),
    sayMinGapSec: num(src.sayMinGapSec, DEFAULTS.sayMinGapSec, 15, 600),
    maxSaysPerHour: num(src.maxSaysPerHour, DEFAULTS.maxSaysPerHour, 1, 600),
    lookOpener: bool(src.lookOpener, DEFAULTS.lookOpener),
    mode: src.mode === 'pet' ? 'pet' : 'dsh',
    chatMaxTokens: num(src.chatMaxTokens, DEFAULTS.chatMaxTokens, 2048, 131072),
    audioTrigger: bool(src.audioTrigger, DEFAULTS.audioTrigger),
    nightQuiet: bool(src.nightQuiet, DEFAULTS.nightQuiet),
    skipWhenIdleSec: num(src.skipWhenIdleSec, DEFAULTS.skipWhenIdleSec, 0, 86400),
    failBackoffSec: num(src.failBackoffSec, DEFAULTS.failBackoffSec, 5, 3600),
    requestTimeoutMs: num(src.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 1000, 120000),
    capture: {
      mode: cap.mode === 'window' ? 'window' : 'screen',
      maxEdge: num(cap.maxEdge, DEFAULTS.capture.maxEdge, 320, 2560),
      quality: num(cap.quality, DEFAULTS.capture.quality, 40, 95),
      diffThreshold: num(cap.diffThreshold, DEFAULTS.capture.diffThreshold, 0, 64),
    },
    gate: {
      blockedApps: Array.isArray(gate.blockedApps)
        ? gate.blockedApps.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().toLowerCase())
        : [],
    },
    model: {
      provider: PROVIDERS.includes(model.provider) ? model.provider : 'auto',
      port: num(model.port, DEFAULTS.model.port, 1, 65535),
      baseUrl: str(model.baseUrl, '').trim(),
      model: str(model.model, '').trim(),
      apiKey: str(model.apiKey, ''),
      timeoutMs: num(model.timeoutMs, DEFAULTS.model.timeoutMs, 1000, 120000),
      maxTokens: num(model.maxTokens, DEFAULTS.model.maxTokens, 16, 1024),
      downsample: model.downsample === '4x' ? '4x' : '16x',
      maxSliceNums: num(model.maxSliceNums, DEFAULTS.model.maxSliceNums, 1, 36),
      enableThinking: model.enableThinking === true,
    },
    escalate: { toDsh: esc.toDsh === true },
    bili: {
      enabled: bool((src.bili || {}).enabled, DEFAULTS.bili.enabled),
      cooldownSec: num((src.bili || {}).cooldownSec, DEFAULTS.bili.cooldownSec, 10, 600),
      maxFrames: num((src.bili || {}).maxFrames, DEFAULTS.bili.maxFrames, 3, 10),
      memoMax: num((src.bili || {}).memoMax, DEFAULTS.bili.memoMax, 5, 200),
      memoDays: num((src.bili || {}).memoDays, DEFAULTS.bili.memoDays, 1, 90),
      source: (src.bili || {}).source === 'rcmd' ? 'rcmd' : 'search',
      keywords: Array.isArray((src.bili || {}).keywords)
        ? (src.bili || {}).keywords
            .filter((x) => typeof x === 'string' && x.trim())
            .map((x) => x.trim().slice(0, 24))
            .slice(0, 10)
        : DEFAULTS.bili.keywords.slice(),
    },
    memory: {
      enabled: bool(mem.enabled, DEFAULTS.memory.enabled),
      storeImages: mem.storeImages === true,
      keepDays: num(mem.keepDays, DEFAULTS.memory.keepDays, 1, 365),
    },
    prompt: str(src.prompt, '').slice(0, 4000),
    dream: {
      enabled: bool((src.dream || {}).enabled, DEFAULTS.dream.enabled),
      // 5 分钟 ~ 3 小时：短了没意义（她一小时也睡不着两次），长了等于关掉
      cooldownSec: num((src.dream || {}).cooldownSec, DEFAULTS.dream.cooldownSec, 300, 10800),
      dir: str((src.dream || {}).dir, '').trim().slice(0, 300),
    },
    // 划词翻译 / 识图：字段一多就容易「面板保存了但值没变」，
    // 白名单在 settings.js 的 sanitizeHeartPatch，两边必须同步（测试【6】有交叉锁）。
    tools: {
      translate: {
        enabled: bool(tl.enabled, DEFAULTS.tools.translate.enabled),
        engine: ENGINES.includes(tl.engine) ? tl.engine : DEFAULTS.tools.translate.engine,
        to: str(tl.to, DEFAULTS.tools.translate.to).trim().slice(0, 20) || DEFAULTS.tools.translate.to,
        maxChars: num(tl.maxChars, DEFAULTS.tools.translate.maxChars, 100, 20000),
        dragPx: num(tl.dragPx, DEFAULTS.tools.translate.dragPx, 4, 40),
        restoreClipboard: bool(tl.restoreClipboard, DEFAULTS.tools.translate.restoreClipboard),
        skipApps: Array.isArray(tl.skipApps)
          ? tl.skipApps
              .filter((x) => typeof x === 'string' && x.trim())
              .map((x) => x.trim().toLowerCase())
              .slice(0, 20)
          : DEFAULTS.tools.translate.skipApps.slice(),
        api: {
          baseUrl: str(tlApi.baseUrl, '').trim().slice(0, 300),
          model: str(tlApi.model, '').trim().slice(0, 200),
          apiKey: str(tlApi.apiKey, '').slice(0, 500),
        },
      },
      vision: {
        enabled: bool(vi.enabled, DEFAULTS.tools.vision.enabled),
        // 小于 24 DIP 的框基本是误触（4×4 的噪点丢给模型纯浪费）
        minSize: num(vi.minSize, DEFAULTS.tools.vision.minSize, 24, 400),
        maxTokens: num(vi.maxTokens, DEFAULTS.tools.vision.maxTokens, 64, 1024),
        prompt: str(vi.prompt, '').slice(0, 2000),
        answer: bool(vi.answer, DEFAULTS.tools.vision.answer),
      },
    },
    modelServer: {
      exe: str(ms.exe, '').trim(),
      model: str(ms.model, '').trim(),
      mmproj: str(ms.mmproj, '').trim(),
      extraArgs: str(ms.extraArgs, '').trim().slice(0, 500),
    },
    // 「声音」/TTS（2026-10-24）：白名单在 settings.js 的 sanitizeHeartPatch，两边同步
    tts: {
      enabled: bool(tt.enabled, DEFAULTS.tts.enabled),
      backend: ['gptsovits', 'gsvlite', 'openai'].includes(tt.backend) ? tt.backend : DEFAULTS.tts.backend,
      baseUrl: str(tt.baseUrl, DEFAULTS.tts.baseUrl).trim().slice(0, 300) || DEFAULTS.tts.baseUrl,
      apiKey: str(tt.apiKey, '').slice(0, 500),
      model: str(tt.model, '').trim().slice(0, 200),
      voice: str(tt.voice, '').trim().slice(0, 200),
      refAudioPath: str(tt.refAudioPath, '').trim().slice(0, 500),
      promptAudioPath: str(tt.promptAudioPath, '').trim().slice(0, 500),
      promptText: str(tt.promptText, '').slice(0, 300),
      speed: numF(tt.speed, DEFAULTS.tts.speed, 0.5, 2),
      maxChars: num(tt.maxChars, DEFAULTS.tts.maxChars, 20, 300),
      timeoutMs: num(tt.timeoutMs, DEFAULTS.tts.timeoutMs, 1000, 120000),
      sources: {
        chat: bool(ttsSrc.chat, DEFAULTS.tts.sources.chat),
        heart: bool(ttsSrc.heart, DEFAULTS.tts.sources.heart),
        bili: bool(ttsSrc.bili, DEFAULTS.tts.sources.bili),
        work: bool(ttsSrc.work, DEFAULTS.tts.sources.work),
      },
    },
    // 连续上下文（2026-10-31）：白名单在 settings.js 的 sanitizeHeartPatch，两边同步
    context: {
      enabled: bool(cx.enabled, DEFAULTS.context.enabled),
      // 上限 200000 = 博士拍板的默认（2026-11-01）；超过模型上下文会 400，由
      // vision.js 的 overflow 阶梯逐级砍半自适应。下限 512 够放一条像样的话。
      windowTokens: num(cx.windowTokens, DEFAULTS.context.windowTokens, 512, 200000),
      summaryDays: num(cx.summaryDays, DEFAULTS.context.summaryDays, 1, 7),
    },
  }
  // 模型条目：settings.json 里 models 键不存在才做旧字段派生（键存在就完全信任，
  // 哪怕是空数组 —— 否则面板里删掉的条目会在下次读取时「复活」）。
  if (!Array.isArray(src.models)) {
    const d = deriveModels(out.model, out.tools.translate)
    out.models = normalizeModels(d.models)
    out.roles = normalizeRoles(d.roles, out.models)
  } else {
    out.models = normalizeModels(src.models)
    out.roles = normalizeRoles(src.roles, out.models)
  }
  return out
}

/** 写日志用：**永远不要**把 apiKey 打出去 */
function describe(cfg) {
  const m = (cfg && cfg.model) || {}
  return (
    (m.provider || 'auto') +
    (m.baseUrl ? ' @ ' + m.baseUrl : '') +
    (m.model ? ' · ' + m.model : '') +
    ' · 16x/4x=' + (m.downsample || '16x') +
    ' · thinking=' + (m.enableThinking ? 'on' : 'off')
  )
}

module.exports = {
  DEFAULTS, PROVIDERS, ENGINES, normalize, describe,
  // 模型条目系统（2026-11-01）—— 导出便于纯函数单测与 AI 面板
  ROLES, MAX_MODELS, TTS_FIELDS, normalizeModels, normalizeRoles, deriveModels, assignRole, rolesOfEntry,
}
