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
  /** 提示词覆盖（空 = 用 prompt.js 里的默认 SYSTEM） */
  prompt: '',
  /** 「一键启动」用的本地引擎配置（空路径 = 需要用户在面板里填） */
  modelServer: { exe: '', model: '', mmproj: '', extraArgs: '' },
}

const PROVIDERS = ['auto', 'separate', 'ollama', 'openai']

function num(v, def, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.round(n)))
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
  return {
    enabled: src.enabled === true,
    // 2026-10-18 起：看屏间隔与说话间隔统一 15~600s（面板只有一个滑块）。
    intervalSec: num(src.intervalSec, DEFAULTS.intervalSec, 15, 600),
    lookMinGapSec: num(src.lookMinGapSec, DEFAULTS.lookMinGapSec, 15, 600),
    maxLooksPerHour: num(src.maxLooksPerHour, DEFAULTS.maxLooksPerHour, 1, 600),
    sayMinGapSec: num(src.sayMinGapSec, DEFAULTS.sayMinGapSec, 15, 600),
    maxSaysPerHour: num(src.maxSaysPerHour, DEFAULTS.maxSaysPerHour, 1, 600),
    lookOpener: bool(src.lookOpener, DEFAULTS.lookOpener),
    mode: src.mode === 'pet' ? 'pet' : 'dsh',
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
    memory: {
      enabled: bool(mem.enabled, DEFAULTS.memory.enabled),
      storeImages: mem.storeImages === true,
      keepDays: num(mem.keepDays, DEFAULTS.memory.keepDays, 1, 365),
    },
    prompt: str(src.prompt, '').slice(0, 4000),
    modelServer: {
      exe: str(ms.exe, '').trim(),
      model: str(ms.model, '').trim(),
      mmproj: str(ms.mmproj, '').trim(),
      extraArgs: str(ms.extraArgs, '').trim().slice(0, 500),
    },
  }
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

module.exports = { DEFAULTS, PROVIDERS, normalize, describe }
