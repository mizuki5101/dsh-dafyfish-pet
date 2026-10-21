'use strict'
// 「做梦」编排：睡着时回顾「上次醒来 → 这次睡着」的素材，写一篇日记。
//
// 和 pet.js 里那个「梦话」（SLEEP_LINES，睡着时冒一句「白饭…再来一碗…」）**没有任何关系**，
// 那个是本地台词表，这个是给模型发一次请求，输出只落进「肥鱼日记」，不冒气泡。
//
// 口径（2026-10-21 用户定）：
//   · 冷却「起跑即计时」：发出请求就算一次，模型回「没值得记」也算。
//   · 素材一条都没有时不发请求（也不吃冷却）—— 主人忙时反复醒了又睡不会刷请求。
//   · 默认关闭，且不要求先开心跳/刷视频；但**必须有可用的模型/API**（提示词里写明）。
//   · 做梦期间被叫醒**不中断**；期间其它要发模型的请求由 heart 那边拦掉。
//   · 「下次睡着时立即做梦」是**一次性**绕过冷却（forceOnce，不落盘、不叠加）。

const { windowOf, collectMaterial, isEmpty, materialText } = require('./collect')
const { SCHEMA, buildMessages } = require('./prompt')
const { parseDream } = require('./toMd')
const store = require('./store')
const { createState } = require('./state')

/** 日记比其它请求都长：2048 token ≈ 1200 汉字（vision.chat 的硬顶已放宽到 2048） */
const DREAM_MAX_TOKENS = 2048
/** 本地 9B 写 1200 字可能 100 秒以上；她反正睡着，给足 */
const DREAM_TIMEOUT_MS = 180000
/** 今天已写日记喂给模型的尾部长度 */
const TODAY_CHARS = 1200
/** 前几天的小标题取几天 */
const RECENT_DAYS = 3

/**
 * 该不该做这一场梦（纯函数，好测「按多次只生效一次」）。
 * 顺序很重要：开关 → 互斥 → 素材 → force → 冷却。
 * force 只越过「冷却」这一条，素材为空照样不跑（也不消费它）。
 */
function shouldRun(o) {
  const x = o || {}
  if (!x.enabled) return { run: false, consumeForce: false, reason: 'disabled' }
  if (x.running) return { run: false, consumeForce: false, reason: 'running' }
  if (!(Number(x.materialCount) > 0)) return { run: false, consumeForce: false, reason: 'no-material' }
  if (x.forceOnce === true) return { run: true, consumeForce: true, reason: 'forced' }
  const cd = Math.max(0, Number(x.cooldownSec) || 0) * 1000
  const last = Number(x.lastDreamAt) > 0 ? Number(x.lastDreamAt) : 0
  const now = Number(x.now) > 0 ? Number(x.now) : Date.now()
  if (cd > 0 && last > 0) {
    const left = cd - (now - last)
    if (left > 0) return { run: false, consumeForce: false, reason: 'cooldown', retryInSec: Math.ceil(left / 1000) }
  }
  return { run: true, consumeForce: false, reason: 'ok' }
}

function createDream(opts) {
  const o = opts || {}
  const log = typeof o.log === 'function' ? o.log : () => {}
  const clock = typeof o.now === 'function' ? o.now : () => Date.now()
  const state = createState({ file: o.stateFile })
  const dirDefault = String(o.dirDefault || '').trim()
  const onState = typeof o.onState === 'function' ? o.onState : null

  let running = false
  /** 一次性绕过冷却（不落盘、不是计数） */
  let forceOnce = false
  /** 最近一次结果（面板状态行用，内存） */
  let last = null

  function cfgOf() {
    try {
      return (typeof o.getCfg === 'function' ? o.getCfg() : o.cfg) || {}
    } catch (e) {
      return {}
    }
  }

  function dirOf() {
    return store.resolveDir(cfgOf().dir, dirDefault)
  }

  function cooldownLeft() {
    const cd = Math.max(0, Number(cfgOf().cooldownSec) || 0) * 1000
    const s = state.get()
    if (!cd || !s.lastDreamAt) return 0
    return Math.max(0, Math.ceil((s.lastDreamAt + cd - clock()) / 1000))
  }

  function material(prev) {
    const s = prev && typeof prev === 'object' ? prev : state.get()
    const now = clock()
    const win = windowOf({ lastWakeAt: s.lastWakeAt, lastSleptAt: s.lastSleptAt, lastDreamAt: s.lastDreamAt, now })
    const chk = (fn) => {
      try {
        return typeof fn === 'function' ? fn() : []
      } catch (e) {
        return []
      }
    }
    const m = collectMaterial({
      says: chk(o.getSays),
      chats: chk(o.getChat),
      videos: chk(o.getBili),
      since: win.since,
      until: win.until,
    })
    return { win, m }
  }

  /** 页面报「她醒了」 */
  function noteWake(at) {
    const t = Number(at) > 0 ? Math.round(Number(at)) : clock()
    state.patch({ lastWakeAt: t })
    return t
  }

  /** 页面报「她睡着了」—— 触发一场梦（不 await，失败只写日志） */
  function noteSleep(at) {
    const t = Number(at) > 0 ? Math.round(Number(at)) : clock()
    // ⚠️ 先取**旧**状态再落盘：这一觉的入睡时间如果先写进去，windowOf 的兜底
    //    会把它当成窗口起点（since = until），窗口空 ⇒ 永远 no-material。
    //    （2026-10-21 被测试抓到的真 bug：页面上报过 wake 时看不出来，没上报就必现。）
    const before = state.get()
    state.patch({ lastSleptAt: t })
    const p = run({ at: t, prev: before })
    if (p && typeof p.catch === 'function') p.catch((e) => log('做梦：异常 ' + ((e && e.stack) || e)))
    return p
  }

  function forceNext(on) {
    if (on === undefined) return forceOnce
    forceOnce = !!on
    log('做梦：下次睡着立即做梦 = ' + (forceOnce ? '已就绪' : '取消'))
    return forceOnce
  }

  async function run(opts2) {
    const x = opts2 || {}
    const t = Number(x.at) > 0 ? Math.round(Number(x.at)) : clock()
    const cfg = cfgOf()
    // prev = 「这一觉之前」的水位线（见 noteSleep 的注释）；调试口没有就用当前状态
    const before = x.prev && typeof x.prev === 'object' ? x.prev : state.get()
    if (running && !x.force) return { ok: false, reason: 'running' }
    // 模型正被别的任务占用（刷视频 / 回应模式）——本地 llama-server 只有 -np 1 一个槽位，
    // 并发只会让两边都变慢。跳过且**不吃冷却**：这叫「没轮到」，不是「做过了」。
    if (typeof o.isBusy === 'function' && o.isBusy()) {
      last = { at: t, ok: false, result: 'busy', skip: true }
      log('做梦：跳过（模型正被占用）')
      return { ok: false, reason: 'busy' }
    }
    const m = material(before).m
    const decision = shouldRun({
      enabled: cfg.enabled === true,
      running,
      materialCount: m.count,
      forceOnce: forceOnce || x.force === true,
      now: t,
      lastDreamAt: before.lastDreamAt,
      cooldownSec: cfg.cooldownSec,
    })
    if (!decision.run) {
      last = { at: t, ok: false, result: decision.reason, skip: true }
      log('做梦：跳过（' + decision.reason + (decision.retryInSec ? ' · 还剩 ' + decision.retryInSec + 's' : '') + '）')
      // 统一返回形状（和其它分支一样带 ok，别让调用方为「跳过」写第二套判断）
      return { ok: false, reason: decision.reason, retryInSec: decision.retryInSec }
    }
    // ★起跑即计时 + 消费一次性开关
    if (decision.consumeForce) forceOnce = false
    running = true
    state.patch({ lastDreamAt: t, lastDiaryDate: '' })
    if (onState) {
      try {
        onState(true)
      } catch (e) {}
    }

    const dir = dirOf()
    const t0 = clock()
    try {
      const messages = buildMessages({
        material: materialText(m),
        todayDiary: store.todayText(dir, t, TODAY_CHARS),
        recentHeads: store.recentHeads(dir, t, RECENT_DAYS),
      })
      const r = await o.chat(messages, {
        schema: SCHEMA,
        maxTokens: DREAM_MAX_TOKENS,
        temperature: 0.8,
        timeoutMs: DREAM_TIMEOUT_MS,
        enableThinking: (cfg.enableThinking === true),
      })
      if (!r || !r.ok) throw new Error(String((r && r.error) || 'no-response'))
      const dream = parseDream(r.text)
      if (!dream) {
        last = { at: t, ok: true, result: 'empty', wrote: false, ms: clock() - t0 }
        state.patch({ lastResult: 'empty', lastError: '' })
        log('做梦：这段时间没什么值得记的（' + (clock() - t0) + 'ms）')
        return { ok: true, wrote: false, reason: 'empty' }
      }
      const w = store.appendDream(dir, t, dream)
      if (!w.ok) throw new Error(String(w.error || 'append-failed'))
      last = { at: t, ok: true, result: 'written', wrote: true, file: w.file, n: w.n, ms: clock() - t0 }
      state.patch({ lastResult: 'written', lastError: '', lastDiaryDate: String(w.file).slice(-13, -3) })
      log('做梦：写了《' + String(dream.head || '') + '》 → ' + w.file + ' 第 ' + w.n + ' 段 · ' + (clock() - t0) + 'ms')
      return { ok: true, wrote: true, file: w.file, n: w.n, ms: clock() - t0 }
    } catch (e) {
      const msg = String((e && e.message) || e)
      last = { at: t, ok: false, result: 'error', error: msg, ms: clock() - t0 }
      state.patch({ lastResult: 'error', lastError: msg })
      log('做梦：失败 —— ' + msg)
      return { ok: false, reason: 'error', error: msg }
    } finally {
      running = false
      if (onState) {
        try {
          onState(false)
        } catch (e) {}
      }
    }
  }

  function status() {
    const cfg = cfgOf()
    const s = state.get()
    const dir = dirOf()
    return {
      ok: true,
      enabled: cfg.enabled === true,
      cooldownSec: Math.max(0, Number(cfg.cooldownSec) || 0),
      dir,
      dirDefault,
      forceNext: forceOnce,
      running,
      cooldownLeft: cooldownLeft(),
      lastDreamAt: s.lastDreamAt,
      lastWakeAt: s.lastWakeAt,
      lastSleptAt: s.lastSleptAt,
      lastResult: s.lastResult,
      lastError: s.lastError,
      lastDiaryDate: s.lastDiaryDate,
      todayCount: store.countToday(dir, clock()),
      last,
    }
  }

  return {
    noteWake,
    noteSleep,
    /** 调试口：不管冷却立刻做一次（CDP 用）。窗口放宽到 12 小时，
     *  否则刚睡完再点会是一段空窗口（什么都取不到） */
    testOnce: () => {
      const s = state.get()
      return run({ at: clock(), force: true, prev: Object.assign({}, s, { lastSleptAt: 0 }) })
    },
    forceNext,
    running: () => running,
    status,
    cooldownLeft,
    reload: () => state.reload(),
    _shouldRun: shouldRun,
  }
}

module.exports = { createDream, shouldRun, DREAM_MAX_TOKENS, DREAM_TIMEOUT_MS }
