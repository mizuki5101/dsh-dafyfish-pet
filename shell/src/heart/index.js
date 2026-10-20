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
const { MAX_ENTRIES: MEMO_MAX } = require('./memo')
const biliModule = require('./bili')
const biliFrames = require('./bili/frames')
const { createStore: createBiliMemo } = require('./bili/memo')

/** 判重要对照最近几句（喂给提示词的只有 3 句，判重可以多看几句） */
const DUP_LOOKBACK = 6

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
  /** 读图开始/结束（true/false）：页面据此静音，期间不许冒新气泡 */
  const onSeal = typeof o.onSeal === 'function' ? o.onSeal : null
  /**
   * seal 用**计数**而不是布尔：定时 tick 和「听到声音立刻看一眼」可能并发，
   * 两个都 seal(true) 时，先结束的那个不能替另一个解封。
   */
  let sealDepth = 0
  let sealSent = false
  function setSeal(on) {
    sealDepth = Math.max(0, sealDepth + (on ? 1 : -1))
    const want = sealDepth > 0
    if (!onSeal || want === sealSent) return
    sealSent = want
    try { onSeal(want) } catch (e) {}
  }
  const clock = typeof o.now === 'function' ? o.now : () => Date.now()
  /** 短期记忆（memo.json）：重启后她还知道自己刚才说过什么。没有就退化回内存 */
  const memo = o.memo || null

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
  /** 最近说过的台词（防复读）；有 memo 时从磁盘恢复，外壳重启也不清零 */
  let recentSays = memo ? memo.says() : []
  let lastSayAt = 0
  let lastMotionAt = 0
  let lastText = memo && memo.last() ? memo.last().say : ''
  let lastAction = null
  /** 上一次「看到的画面」类别（不管说没说）—— 用来判断「这个场景是不是第一次见」 */
  let lastSeenNote = null
  /** 上一次的 see（枚举，稳定）—— 画面指纹拿不到时当「同一场景」的兜底判据 */
  let lastSee = null
  /** 同一个画面连续看了几次（用来触发「坐太久了，提醒一下」） */
  let sameSeenCount = 0
  let lastInferMs = 0
  /** 最近一次**成功**调用的端点：{ baseUrl, model, source, at } */
  let lastEndpoint = null
  /** 最近一次推理失败的原因（字符串，含 hint），成功或未调用时为空 */
  let lastInferError = null
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
    // 改了配置（尤其是模型/API）就把失败退避清掉：
    // 否则用户刚改对地址，还要干等 20 秒才会重试，看起来像「配置没生效」。
    backoffUntil = 0
    inferFails = 0
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
  async function think(cap, openerLine, forceIdle, ignoreBackoff, forceSay) {
    const t = clock()
    // 手动「立即看一眼」/调试口不受失败退避限制；定时心跳才退避
    if (!ignoreBackoff && backoffUntil && t < backoffUntil) return { ok: false, reason: 'backoff' }
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
    /**
     * 第二次重试是否**不带图**。
     * 画面没变（或台词重复）时，再看同一张图只会说同一件事 —— 2026-10-19 实测；
     * 不带图还顺带省掉约 1100 个视觉 token（prefill 从 ~1.2s 降到 ~0.2s）。
     */
    let retryNoImage = false
    const sameDiff = cap.diff
    while (attempts < 2) {
      const useImage = !(attempts > 0 && retryNoImage)
      const messages = buildMessages({
        imageDataUrl: useImage ? 'data:image/jpeg;base64,' + cap.jpeg : '',
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
        const detail = r.detail || {}
        lastInferError = (detail.baseUrl ? detail.baseUrl + ' · ' : '') +
          (detail.hint || r.error) +
          (detail.models && detail.models.length ? '（列表里前几个：' + detail.models.slice(0, 6).join('、') + '）' : '')
        lastEndpoint = null
        const wait = Math.min(300, cfg.failBackoffSec * Math.min(8, inferFails))
        backoffUntil = t + wait * 1000
        log('心跳：推理失败 ' + r.error + (detail.baseUrl ? ' @ ' + detail.baseUrl : '') +
          (detail.hint ? ' — ' + detail.hint : '') + '（' + wait + 's 后再试）')
        return { ok: false, reason: lastSkip, candidates: r.candidates || 0, error: lastInferError }
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
      const dup = p.action.say ? decide.isDuplicate(p.action.say, recentSays.slice(-DUP_LOOKBACK)) : false
      if (attempts === 0 && (decide.needsRetry(p.flags, p.action) || dup)) {
        retryWhy = dup ? 'duplicate' : p.flags.garbled ? 'garbled' : 'empty-speech'
        retryNudge = dup ? decide.RETRY_DUP : decide.RETRY_NUDGE
        // 重复，或者画面跟上一帧几乎一样 ⇒ 第二次不给图（garbled 除外：它需要看着画面修正）
        retryNoImage = decide.retryWithoutImage(p.flags, dup, sameDiff, cfg.capture.diffThreshold)
        if (retryNoImage) retryNudge = decide.RETRY_TOPIC
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
    // 配置是一回事，**实际打中的端点**是另一回事 —— 状态面板要显示后者
    if (r && r.ok && r.candidate) {
      lastEndpoint = { baseUrl: r.candidate.baseUrl, model: r.candidate.model, source: r.candidate.source, at: t }
      lastInferError = null
    }

    // 本轮最终那次请求带没带图：无图重试拿到的 topic/see 是猜的，不能拿来更新场景记录
    const hadImage = !(attempts > 0 && retryNoImage)
    if (parsed && parsed.ok) {
      // 「是不是同一个画面」用**画面指纹**判断，不用 topic 文本：
      // topic 是模型自由生成的（「桌面图标密密麻麻排满」vs「密密麻麻的图标墙」永远不相等），
      // 以前按字符串全等比较 ⇒ sameSeenCount 恒为 0，「坐太久了」那条感知从没触发过。
      // see 只在拿不到指纹（首帧）时兜底。
      const sameByImage = typeof sameDiff === 'number' && sameDiff <= cfg.capture.diffThreshold
      const sameBySee = hadImage && !!parsed.action.see && parsed.action.see === lastSee
      sameSeenCount = decide.nextSameCount(sameSeenCount, sameByImage, sameBySee, lastSeenNote !== null)
      const seen = parsed.action.topic || parsed.action.note || parsed.action.see || ''
      if (hadImage) {
        lastSeenNote = seen || lastSeenNote
        if (parsed.action.see) lastSee = parsed.action.see
      }
    }
    if (!parsed || !parsed.ok) {
      lastSkip = 'decide:' + ((parsed && parsed.reason) || retryWhy || 'unknown')
      lastReason = 'bad-json'
      log('心跳：模型输出解析失败 —— ' + String((lastCall && lastCall.text) || '').slice(0, 120))
      return { ok: false, reason: lastSkip, text: (lastCall && lastCall.text) || '' }
    }
    if (retryWhy) log('心跳：第一次输出不合格（' + retryWhy + '），已重试一次' + (retryNoImage ? '（这次不带图，换话题）' : ''))

    const stRaw = await getAgentState().catch(() => null)
    const st = { status: forceIdle ? 'idle' : (stRaw && stRaw.status), sleeping: !!(stRaw && stRaw.sleeping) }
    const arb = decide.arbitrate(parsed.action, {
      agentStatus: st && st.status,
      sleeping: !!(st && st.sleeping),
      lastSayAt,
      lastMotionAt,
      says,
      hour: now.getHours(),
    }, cfg, t, { forceSay: !!forceSay })

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
      if (recentSays.length > MEMO_MAX) recentSays = recentSays.slice(-MEMO_MAX)
      // 落盘：连 topic/see 一起存 —— 以后要按「这个场景我说过什么」检索时不用改存储格式
      if (memo) memo.add({ at: t, say: arb.action.say, topic: arb.action.topic, see: arb.action.see })
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
    // 读图期间静默：从采集开始到模型给出动作（或失败）为止，页面不许冒新气泡。
    // 开场白在上面已经推过了 —— 它是「探头」提示，属于读图之前。
    // 注意：think() 里的 onAction（正式台词）也在这段之内，所以它会先入队、unseal 后显示。
    setSeal(true)
    try {
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
      return think(cap, openerLine, debugIdle, force, !!(opts2 && opts2.forceSay))
    } finally {
      setSeal(false)
    }
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
    // forceSay：手动点「立即看一眼」时跳过 say-gap / 每小时上限 —— 那是主人的显式操作。
    //   听觉触发（trigger=audio）**不享受**这条：麦克风一响就说会把嘴彻底放开。
    return tickBody(true, {
      ignoreBusy: o2.ignoreBusy === true,
      forceSay: o2.trigger !== 'audio',
    })
  }

  /**
   * 面板「确认 API 连接」：真发一条最小 ping。
   * 好处：① 验证地址/模型名/鉴权；② llama-swap 收到请求会自动加载对应模型。
   * 只写 lastEndpoint/lastInferError，不碰台词、不碰聊天记忆。
   */
  async function probe() {
    reload()
    const rr = await vision.resolve(cfg)
    if (!rr.ok) {
      lastEndpoint = null
      lastInferError = (rr.baseUrl ? rr.baseUrl + ' · ' : '') + (rr.hint || rr.error)
      return { ok: false, error: rr.error, detail: rr }
    }
    const c = rr.candidate
    // 用 ping：接受「有 choices 但 content 为空」的思考模型（reasoning_content 也算合法回复）
    const r = await vision.ping(c, { timeoutMs: 90000 })
    if (!r.ok) {
      lastEndpoint = null
      lastInferError = c.baseUrl + ' · ' + r.error
      return { ok: false, error: r.error, endpoint: c }
    }
    lastEndpoint = { baseUrl: c.baseUrl, model: c.model, source: c.source, at: clock() }
    lastInferError = null
    return {
      ok: true,
      text: String(r.text || '').trim().slice(0, 80),
      reasoning: String(r.reasoning || '').trim().slice(0, 120),
      empty: !!r.empty,
      ms: r.ms,
      endpoint: lastEndpoint,
    }
  }

  /** 主动扫描（面板按钮）：返回候选，不自动应用 */
  async function scan() {
    reload()
    const results = await vision.scan(cfg)
    return { ok: true, at: clock(), results }
  }

  async function providers() {
    reload()
    const results = await vision.scan(cfg)
    return results.map((c) => ({ baseUrl: c.baseUrl, model: c.suggested, source: c.source }))
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
      /** 实际打中的端点（成功过才有） */
      endpoint: lastEndpoint,
      lastInferError,
      running: !!timer,
    }
  }

  /* ——————————————————————————————————————————————————————————————
   * 刷一条视频（2026-10-20，v2）
   *   点按钮才刷；60 秒冷却；读视频全程 seal（页面不许冒别的气泡）。
   *   只读 B 站公开接口，不发任何写请求 —— 不需要登录、不会影响主人的登录态。
   * —————————————————————————————————————————————————————————————— */
  let biliStore = null
  let biliCooldownUntil = 0
  let biliRunning = false
  let lastBili = null

  function biliMemo() {
    if (biliStore) return biliStore
    if (!o.biliMemoFile) return null
    try {
      biliStore = createBiliMemo({ file: o.biliMemoFile, max: cfg.bili.memoMax, ttlDays: cfg.bili.memoDays })
    } catch (e) {
      biliStore = null
    }
    return biliStore
  }

  function biliCooldownLeft() {
    return Math.max(0, Math.ceil((biliCooldownUntil - clock()) / 1000))
  }

  function biliStatus() {
    return {
      ok: true,
      enabled: cfg.bili.enabled,
      cooldownLeft: biliCooldownLeft(),
      running: biliRunning,
      last: lastBili,
      memo: biliStore ? biliStore.entries().length : 0,
    }
  }

  /**
   * 刷一条：取候选 → 粗筛 → 深看 → 气泡 + 邮件。
   * 失败原因会原样返回（disabled / cooldown / running / list / detail / watch），
   * 页面据此显示「冷却 42s」或一条错误气泡，不要静默返回。
   */
  async function biliLook() {
    const t = clock()
    if (!cfg.bili.enabled) return { ok: false, reason: 'disabled' }
    if (biliRunning) return { ok: false, reason: 'running' }
    const left = biliCooldownLeft()
    if (left > 0) return { ok: false, reason: 'cooldown', retryInSec: left }

    biliRunning = true
    biliCooldownUntil = t + Math.max(1, cfg.bili.cooldownSec) * 1000
    // 让定时心跳让路：不然两个请求抢同一个实例，显存和上下文互相拖
    // （hold()/release() 是返回对象上的方法，这里直接用计数变量）
    holds++
    // 读视频期间禁止别的气泡（复用「读图静默」）。注意页面侧有 60s 兜底，
    // 而一轮可能超过 60s —— 所以页面那边每 25s 续一次，见 pet.js 的 sealHeartbeat。
    setSeal(true)
    const stage = typeof o.onBiliStage === 'function' ? o.onBiliStage : null
    try {
      const chat = async (messages, op) => {
        const r = await vision.infer(cfg, messages, {
          schema: op && op.schema,
          maxTokens: (op && op.maxTokens) || 400,
          temperature: op && op.temperature,
          timeoutMs: Math.max(cfg.model.timeoutMs, 120000),
          enableThinking: cfg.model.enableThinking,
        })
        return r.ok ? { ok: true, text: r.text } : { ok: false, error: r.error }
      }
      const ff = await biliFrames.available()
      log('刷视频：开始（ffmpeg=' + (ff ? 'on' : 'off') + '）')
      const r = await biliModule.look({
        chat,
        grab: ff ? biliFrames.grab : null,
        store: biliMemo(),
        // 关键词检索优先：首页推荐会塞不感兴趣的东西（2026-10-20 用户反馈）
        source: cfg.bili.source,
        keywords: cfg.bili.keywords,
        pickCount: 5,
        maxFrames: cfg.bili.maxFrames,
        onStage: (s, info) => {
          try {
            if (stage) stage(s, info)
          } catch (e) {}
        },
      })
      if (!r.ok) {
        lastBili = { at: t, ok: false, stage: r.stage, error: r.error }
        log('刷视频：失败于 ' + r.stage + ' —— ' + r.error)
        return r
      }
      const it = r.item
      lastBili = { at: t, ok: true, bvid: it.bvid, title: it.title, ms: it.ms, frames: it.frames, tokens: it.tokens }
      log('刷视频：《' + it.title + '》 ' + it.frames + ' 帧 · 约 ' + it.tokens + ' token · ' + it.ms + 'ms')
      // 气泡：和心跳同一条通道，所以排队/最少停留/force 语义都一致
      if (onAction) {
        try {
          const action = {
            see: 'browsing', topic: String(it.title || '').slice(0, 20), note: '',
            say: it.say, act: 'speak', mood: '', motion: '', face: '', priority: 'normal',
          }
          const control = decide.toControl(action, Math.max(6000, it.say.length * 240))
          onAction(control, action, { bili: it.bvid, ms: it.ms })
        } catch (e) {}
      }
      // 邮件：详情落进面板，气泡消失后还能翻
      if (typeof o.onReport === 'function') {
        try {
          o.onReport({ title: it.title, body: it.detail, bv: it.bvid, url: it.url, up: it.up, worth: it.worth, at: t })
        } catch (e) {}
      }
      return { ok: true, item: it }
    } finally {
      setSeal(false)
      holds = Math.max(0, holds - 1)
      biliRunning = false
    }
  }

  return {
    start,
    stop,
    status,
    captureNow,
    tickNow,
    biliLook,
    biliStatus,
    providers,
    scan,
    probe,
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
