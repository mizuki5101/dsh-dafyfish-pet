'use strict'
// 心跳：眼睛 + 嘴（P1）。
//
// 链路：gate（该不该看）→ capture（拍 + 遮 + 指纹）→ vision（1B/9B 出 JSON）→ decide（夹取 + 仲裁）→ onAction（主进程推 SSE）。
//
// 默认关闭：settings.json 里 heart.enabled 不是 true 时，连定时器都不建。
// 关闭时 captureNow / tickNow(force) 仍然可用 —— 那是 CDP 调试口，P1 接模型前要按配置收紧。

const { captureScreen } = require('./capture')
const { normalize, describe } = require('./config')
const { hamming } = require('./hash')
const { SCHEMA: PROMPT_SCHEMA, buildMessages } = require('./prompt')
const decide = require('./decide')
const vision = require('./vision')
const gate = require('./gate')
const { pickOpener } = require('./opener')

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function createHeart(opts) {
  const o = opts || {}
  const log = typeof o.log === 'function' ? o.log : () => {}
  const readSettings = typeof o.readSettings === 'function' ? o.readSettings : () => ({})
  const getWindow = typeof o.getWindow === 'function' ? o.getWindow : () => null
  const getMaskRects = typeof o.getMaskRects === 'function' ? o.getMaskRects : null
  const getAgentState = typeof o.getAgentState === 'function' ? o.getAgentState : async () => ({ status: 'idle', sleeping: false })
  const onAction = typeof o.onAction === 'function' ? o.onAction : null
  const onOpener = typeof o.onOpener === 'function' ? o.onOpener : null
  const clock = typeof o.now === 'function' ? o.now : () => Date.now()

  let cfg = normalize({})
  let timer = null
  let busy = false
  let stopped = false
  let lastAt = 0
  let lastHash = null
  let lastDiff = null
  let lastLuma = null
  let lastError = null
  let lastReason = 'never'
  let looks = []
  let okCount = 0
  let failCount = 0
  let says = []
  /** 最近 3 句台词（防 15 秒一轮时复读） */
  let recentSays = []
  let lastSayAt = 0
  let lastMotionAt = 0
  let lastText = ''
  let lastAction = null
  /** 上一次「看到的画面」类别（不管说没说）—— 用来判断「这个场景是不是第一次见」 */
  let lastSeenNote = null
  /** 同一个画面连续看了几次（用来触发「坐太久了，提醒一下」） */
  let sameSeenCount = 0
  let lastInferMs = 0
  /** 上一轮因为「笼统/退化」重试了几次（0 或 1） */
  let lastRetries = 0
  /** 调试口：下一次 tick 强制冒一句开场白（CDP 验收用，绕过「DSH 空闲」检查） */
  let forceOpenerOnce = false
  /** 对话（回应模式）进行中时不要抢模型：>0 时所有 tick 直接跳过 */
  let holds = 0
  let lastSkip = ''
  let inferFails = 0
  let backoffUntil = 0

  function reload() {
    try {
      cfg = normalize((readSettings() || {}).heart)
    } catch (e) {
      cfg = normalize({})
    }
    return cfg
  }

  function visible() {
    const win = getWindow()
    if (win && typeof win.isVisible === 'function') return !!win.isVisible()
    return true
  }

  async function captureNow(captureOpts) {
    const co = captureOpts || {}
    if (busy) return { ok: false, reason: 'busy' }
    busy = true
    try {
      let maskRects = null
      if (getMaskRects && co.noMask !== true) {
        try {
          maskRects = await getMaskRects()
        } catch (e) {
          maskRects = null
        }
      }
      const r = await captureScreen({
        maxEdge: cfg.capture.maxEdge,
        quality: cfg.capture.quality,
        includeImage: co.includeImage === true,
        maskRects,
      })
      const t = clock()
      if (r.ok) {
        const diff = lastHash ? hamming(lastHash, r.hash) : null
        r.diff = diff
        lastAt = t
        lastHash = r.hash
        lastDiff = diff
        lastLuma = r.luma
        lastError = null
        lastReason = 'ok'
        looks.push(t)
        okCount++
        if (co.manual !== true) {
          log(
            '心跳：看了一次 ' + r.width + 'x' + r.height + ' ' + Math.round(r.bytes / 1024) + 'KB ' +
              'luma=' + r.luma + ' diff=' + (diff === null ? '首帧' : diff) + ' 遮罩=' + (r.masks || 0) +
              ' 耗时=' + r.ms + 'ms',
          )
        }
      } else {
        lastError = r.reason || 'unknown'
        lastReason = 'error:' + lastError
        failCount++
        log('心跳：采集失败 ' + lastError + (r.error ? ' — ' + r.error : ''))
      }
      return r
    } catch (e) {
      lastError = String((e && e.message) || e)
      lastReason = 'error:exception'
      failCount++
      log('心跳：采集异常 ' + lastError)
      return { ok: false, reason: 'exception', error: lastError }
    } finally {
      busy = false
    }
  }

  /**
   * 看一眼 → 让模型判断 → 仲裁 → 交给主进程执行。
   * 只有这里会真正「花 GPU」；调用方负责先过 gate。
   */
  async function think(cap, openerLine, forceIdle) {
    const t = clock()
    if (backoffUntil && t < backoffUntil) return { ok: false, reason: 'backoff' }
    if (!cap || !cap.jpeg) return { ok: false, reason: 'no-image' }

    const now = new Date(t)
    // 「新场景」用画面指纹判断：首帧，或者和上一次看的时候差得够多。
    const isNew = !lastSeenNote || (typeof cap.diff === 'number' && cap.diff > cfg.capture.diffThreshold)
    const situation = {
      time: now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0'),
      weekday: WEEKDAYS[now.getDay()],
      lastNote: lastSeenNote,
      same: sameSeenCount,
      saidRecently: decide.hourCount(says, t),
    }

    // —— 最多两次：第一次不满意（笼统/退化/空话）就追加一句要求重试 ——
    // 为什么不是「无限重试」：1B 的失败是系统性的，重试三次以上基本是浪费 GPU；
    // 一次重试能把「喝口水」救成「这个面板的路径框快撑爆了」，性价比最高。
    let parsed = null
    let lastCall = null
    let totalMs = 0
    let attempts = 0
    let retryWhy = ''
    let retryNudge = decide.RETRY_NUDGE
    while (attempts < 2) {
      const messages = buildMessages({
        imageDataUrl: 'data:image/jpeg;base64,' + cap.jpeg,
        newScene: isNew,
        systemOverride: cfg.prompt,
        situation,
        lastText,
        recent: recentSays,
        opener: openerLine || '',
        nudge: attempts > 0 ? retryNudge : '',
      })
      const r = await vision.infer(cfg, messages, {
        schema: PROMPT_SCHEMA,
        maxTokens: cfg.model.maxTokens,
        timeoutMs: cfg.model.timeoutMs,
        enableThinking: cfg.model.enableThinking,
        // 温度：第一次 0.6（有点变化），重试时 0.95（硬拽出另一种说法）。
        // 实测 0.2 在同一张截图上会一字不差地复读。
        temperature: attempts > 0 ? 0.95 : 0.6,
      })
      if (!r.ok) {
        inferFails++
        lastSkip = 'infer:' + r.error
        lastReason = 'infer-failed'
        const wait = Math.min(300, cfg.failBackoffSec * Math.min(8, inferFails))
        backoffUntil = t + wait * 1000
        log('心跳：推理失败 ' + r.error + '（' + (r.candidates || 0) + ' 个候选端点，' + wait + 's 后再试）')
        return { ok: false, reason: lastSkip, candidates: r.candidates || 0 }
      }
      totalMs += r.ms
      lastCall = r
      const p = decide.sanitize(r.text)
      if (!p.ok) {
        retryWhy = 'bad-json'
        attempts++
        continue
      }
      parsed = p
      // 复读也要重试：同一画面里 9B 会把上一句几乎一字不差地再说一遍。
      const dup = p.action.say ? decide.isDuplicate(p.action.say, recentSays) : false
      if (attempts === 0 && (decide.needsRetry(p.flags, p.action) || dup)) {
        retryWhy = dup ? 'duplicate' : p.flags.garbled ? 'garbled' : 'empty-speech'
        retryNudge = dup ? decide.RETRY_DUP : decide.RETRY_NUDGE
        attempts++
        continue
      }
      break
    }

    inferFails = 0
    backoffUntil = 0
    lastInferMs = totalMs
    lastRetries = attempts
    const r = lastCall || { ok: false, error: 'no-call', candidate: null, ms: 0 }

    if (parsed && parsed.ok) {
      // 场景跟踪用 topic（比 note/see 更具体）
      const seen = parsed.action.topic || parsed.action.note || parsed.action.see || ''
      if (lastSeenNote && seen && seen === lastSeenNote) sameSeenCount++
      else sameSeenCount = 0
      lastSeenNote = seen || lastSeenNote
    }
    if (!parsed || !parsed.ok) {
      lastSkip = 'decide:' + ((parsed && parsed.reason) || retryWhy || 'unknown')
      lastReason = 'bad-json'
      log('心跳：模型输出解析失败 —— ' + String((lastCall && lastCall.text) || '').slice(0, 120))
      return { ok: false, reason: lastSkip, text: (lastCall && lastCall.text) || '' }
    }
    if (retryWhy) log('心跳：第一次输出不合格（' + retryWhy + '），已重试一次')

    const stRaw = await getAgentState().catch(() => null)
    const st = { status: forceIdle ? 'idle' : (stRaw && stRaw.status), sleeping: !!(stRaw && stRaw.sleeping) }
    const arb = decide.arbitrate(parsed.action, {
      agentStatus: st && st.status,
      sleeping: !!(st && st.sleeping),
      lastSayAt,
      lastMotionAt,
      says,
      hour: now.getHours(),
    }, cfg, t)

    if (!arb.ok) {
      lastSkip = 'arb:' + arb.reason
      lastReason = 'skipped:' + arb.reason
      log('心跳：看完了但不说 —— ' + arb.reason + '（' + (parsed.action.topic || parsed.action.see) + '）')
      return { ok: false, reason: lastSkip, action: parsed.action }
    }

    lastAction = arb.action
    lastText = arb.action.say || lastText
    if (arb.action.say) {
      lastSayAt = t
      says.push(t)
      recentSays.push(arb.action.say)
      if (recentSays.length > 3) recentSays = recentSays.slice(-3)
    }
    if (arb.action.motion || arb.action.face) lastMotionAt = t
    lastReason = 'acted'
    lastSkip = ''

    const control = decide.toControl(arb.action, 7000)
    if (onAction) {
      try {
        onAction(control, arb.action, { model: r.candidate && r.candidate.model, baseUrl: r.candidate && r.candidate.baseUrl, ms: r.ms })
      } catch (e) {
        log('心跳：执行动作失败 ' + ((e && e.message) || e))
      }
    }
    log(
      '心跳：说了一句「' + (arb.action.say || '') + '」 mood=' + (arb.action.mood || '-') +
        ' motion=' + (arb.action.motion || '-') + ' 模型=' + (r.candidate && r.candidate.model) +
        ' 耗时=' + r.ms + 'ms' + (arb.notes.length ? '（' + arb.notes.join(',') + '）' : ''),
    )
    return { ok: true, action: arb.action, control, ms: r.ms, candidate: r.candidate }
  }

  async function tickBody(force, opts2) {
    const debugIdle = !!(opts2 && opts2.ignoreBusy)
    // 主人正在跟她聊天：别让心跳抢 llama-server 的单槽位
    if (holds > 0) {
      lastReason = 'chat-hold'
      return { ok: false, reason: 'chat-hold' }
    }
    const t = clock()
    const decision = force
      ? { ok: true, reason: 'forced' }
      : gate.shouldLook({
          cfg, now: t, hour: new Date(t).getHours(), lastAt, looks,
          visible: visible(), busy, stopped,
        })
    if (!decision.ok) {
      lastReason = decision.reason
      return { ok: false, reason: decision.reason }
    }
    const forcedOpener = forceOpenerOnce
    forceOpenerOnce = false

    // DSH 正在跑一轮时**连看都不看**：以前是「拍了、推理了、再被仲裁丢掉」，
    // 等于每秒都在白烧 GPU，还会让开场白盖掉 DSH 的工具气泡。
    // 放在采集之前，既省显存也省心。
    // debugIdle 只忽略「DSH 忙」，**不忽略睡眠**：睡着了就是睡着了。
    const st0 = forcedOpener
      ? { status: 'idle', sleeping: false }
      : await getAgentState().catch(() => null)
    if (!force && !debugIdle && !forcedOpener && st0 && st0.status && st0.status !== 'idle') {
      lastReason = 'busy'
      return { ok: false, reason: 'busy' }
    }
    // 她睡着了就别看屏幕了：连采集都省掉（以前只是「不播动作」，GPU 照样在烧）
    if (!force && !forcedOpener && st0 && st0.sleeping) {
      lastReason = 'sleeping'
      return { ok: false, reason: 'sleeping' }
    }

    // 看之前先冒一句（可选）：解释「她在看屏幕」，同时把这句话交给模型接话头。
    // 只在 DSH 空闲、她没睡的时候冒 —— 否则会盖掉 DSH 的工具气泡。
    let openerLine = ''
    // 15 秒一轮时每轮都冒「让我看看」会很吵：只在「有一阵子没说话了」或调试强制时才冒。
    const openerDue = !lastSayAt || t - lastSayAt > 60000
    if (cfg.lookOpener && onOpener && (forcedOpener || openerDue)) {
      try {
        if (!st0 || (st0.status === 'idle' && !st0.sleeping)) {
          openerLine = pickOpener()
          onOpener(openerLine)
        }
      } catch (e) {}
    }
    const cap = await captureNow({ manual: false, includeImage: true })
    if (!cap.ok) return cap

    // 2026-10-18 用户要求「每轮都说话」，所以**不再**因为「画面没变」跳过推理：
    // 静态文档前她也要能说「主人在看文档呀，这页好像有点长」。
    // 代价是静态画面每轮都会推理一次；要省电就把间隔调大（面板 15~600s）。
    void cap.diff
    if (!cfg.model.provider && !cfg.model.baseUrl) {
      // 理论上 normalize 保证 provider 有值；这里只是防御
      return { ok: false, reason: 'no-model-config' }
    }
    return think(cap, openerLine, debugIdle)
  }

  async function tick() {
    if (stopped) return
    await tickBody(false)
  }

  /** CDP 调试口：跳过 gate 跑一遍完整链路（不写「看过」的计数由 captureNow 自己记） */
  async function tickNow(opts) {
    const o2 = opts || {}
    if (busy) return { ok: false, reason: 'busy' }
    // 听觉触发的「立即看一眼」：主进程复核开关（页面只管发，不决定要不要看）
    if (o2.trigger === 'audio') {
      reload()
      if (!cfg.enabled) return { ok: false, reason: 'disabled' }
      if (!cfg.audioTrigger) return { ok: false, reason: 'audio-off' }
    }
    if (o2.forceOpener === true) forceOpenerOnce = true
    // 注意：这里**不改** cfg.enabled —— 调试口只跳过 gate，不改变「用户开没开」这个事实。
    // 否则调一次 tick 之后 status.enabled 会变成 true，看起来像自己把自己打开了。
    // ignoreBusy：CDP 验收用，DSH 正在跑一轮时也走完整链路（否则永远看不到真气泡）。
    return tickBody(true, { ignoreBusy: o2.ignoreBusy === true })
  }

  async function providers() {
    reload()
    const list = await vision.resolveCandidates(cfg)
    return list.map((c) => ({ baseUrl: c.baseUrl, model: c.model, source: c.source }))
  }

  function start() {
    stopped = false
    reload()
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    if (!cfg.enabled) {
      log('心跳：未启用（settings.json → heart.enabled=true 才开；默认不采集、不加载模型）')
      return
    }
    log(
      '心跳：已启用 · 每 ' + cfg.intervalSec + 's 判定 · 最短 ' + cfg.lookMinGapSec + 's 看一次 · ' +
        '每小时≤' + cfg.maxLooksPerHour + ' · 夜间×6 · 模型 ' + describe(cfg),
    )
    timer = setInterval(() => {
      tick().catch((e) => log('心跳：tick 异常 ' + ((e && e.message) || e)))
    }, cfg.intervalSec * 1000)
    if (timer.unref) timer.unref()
  }

  function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
  }

  function status() {
    const t = clock()
    return {
      enabled: cfg.enabled,
      intervalSec: cfg.intervalSec,
      lookMinGapSec: cfg.lookMinGapSec,
      maxLooksPerHour: cfg.maxLooksPerHour,
      night: gate.isNight(new Date(t).getHours(), cfg.nightQuiet),
      lastAt,
      lastHash,
      lastDiff,
      lastLuma,
      lastReason,
      lastError,
      lastSkip,
      lastText,
      lastAction,
      lastInferMs,
      lastRetries,
      looksThisHour: gate.hourCount(looks, t),
      saysThisHour: decide.hourCount(says, t),
      okCount,
      failCount,
      model: describe(cfg),
      running: !!timer,
    }
  }

  return {
    start,
    stop,
    status,
    captureNow,
    tickNow,
    providers,
    reload,
    config: () => cfg,
    /** 回应模式占用模型期间，让心跳让路（成对调用） */
    hold: () => {
      holds++
    },
    release: () => {
      holds = Math.max(0, holds - 1)
    },
  }
}

module.exports = { createHeart }
