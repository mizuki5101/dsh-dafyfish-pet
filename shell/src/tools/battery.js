'use strict'

// 「当前外设电量」—— 读 + 缓存 + 变化时间。
//
// 分工：
//   · 取值/解码全是纯函数在 battery-core.js（有单测）；
//   · 真正碰系统的只有 native/keys.js 的 btRawDevices()（setupapi，只读）；
//   · 这里只做三件事：节流、记住"这个数字什么时候变的"、把失败讲清楚。
//
// 没有定时器：**面板开着时由页面每 30s 问一次**。面板关着就不读，
// 省得在后台无意义地翻设备树（而且这数据本来也不会自己变）。

const path = require('node:path')
const { Worker } = require('node:worker_threads')
const keys = require('../native/keys')
const core = require('./battery-core')

/** 两次真实读取之间的最小间隔（页面重复打开面板、连点刷新都不该真去翻设备树） */
const MIN_GAP_MS = 3000
/** 两次「强制刷新」之间的最小间隔：它会让 HFP 断一下，别让人连点（从**完成**时刻算起） */
const FORCE_GAP_MS = 10 * 1000
/**
 * 强制刷新后等它重新握手：**轮询到时间戳真的变新**就返回，别死等固定时间。
 * 实测关一次再开大约要 8 秒才稳定（SetupAPI 在服务重启期间会短暂查不到节点），
 * 但很多时候 2~3 秒就有新值了 —— 所以用轮询，快就快走。
 */
const FORCE_TIMEOUT_MS = 12000
const FORCE_POLL_MS = 600

function createBattery(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const report = (m) => {
    try {
      log('[battery] ' + m)
    } catch (e) {}
  }

  /**
   * 在 worker 里执行"关掉再打开 HFP"（同步阻塞约 6 秒，见 bt-toggle-worker.js）。
   * 返回的原因是 'worker-unavailable' 时调用方才回退到主线程内联执行 —— 别的情况
   * （超时/异常退出）**不能**重试：那可能已经切过一次，再切一次会把链路反复折腾。
   */
  function toggleInWorker(nameHint) {
    return new Promise((resolve) => {
      let settled = false
      const done = (v) => {
        if (settled) return
        settled = true
        resolve(v)
      }
      let w = null
      try {
        w = new Worker(path.join(__dirname, 'bt-toggle-worker.js'), { workerData: { nameHint } })
      } catch (e) {
        done({ ok: false, reason: 'worker-unavailable:' + ((e && e.message) || e) })
        return
      }
      const kill = () => {
        try {
          w.terminate()
        } catch (e) {}
      }
      const timer = setTimeout(() => {
        done({ ok: false, reason: 'worker-timeout' })
        kill()
      }, 20000)
      w.on('message', (m) => {
        clearTimeout(timer)
        done(m && typeof m === 'object' ? m : { ok: false, reason: 'worker-empty' })
        kill()
      })
      w.on('error', (e) => {
        clearTimeout(timer)
        done({ ok: false, reason: 'worker-error:' + ((e && e.message) || e) })
        kill()
      })
      w.on('exit', (code) => {
        clearTimeout(timer)
        done({ ok: false, reason: 'worker-exit:' + code })
      })
    })
  }

  let devices = []
  let readAt = 0
  let changedAt = 0
  let lastSig = ''
  let rows = 0
  let lastError = ''
  let lastForceAt = 0
  /** 正在强制刷新：连点/并发的第二下直接回 busy，别把 HFP 连着切两轮 */
  let forcing = false

  /**
   * 读一次（带节流）。
   * force=true 只越过节流，不做任何"刷新设备状态"的动作 ——
   * 我们的值本来就是个缓存，逼它更新的唯一办法是让 Windows 重连 HFP，
   * 那个会断一下麦克风，博士 2026-10-24 明确说"先不做"。
   */
  function read(force) {
    const now = Date.now()
    if (!force && readAt && now - readAt < MIN_GAP_MS) return status()
    readAt = now
    try {
      const all = keys.btRawDevices()
      rows = all.length
      const next = core.pickDevices(all, { now })
      // ⚠️ 强制刷新那 6 秒里 HFP 节点会短暂消失，这时读到的是"空"。
      //    不能拿它覆盖上一次的结果，否则面板会在刷新中途闪一下"没读到电量"。
      if (forcing && !next.length && devices.length) return status()
      devices = next
      const sig = devices.map((d) => d.name + ':' + d.percent).join('|')
      if (sig !== lastSig) {
        lastSig = sig
        changedAt = now
        if (sig) report('电量：' + core.describe(devices))
      }
      lastError = ''
    } catch (e) {
      lastError = String((e && e.message) || e)
      report('读取失败：' + lastError)
    }
    return status()
  }

  function status() {
    const avail = keys.btAvailable()
    return {
      ok: avail && !lastError,
      available: avail,
      reason: avail ? lastError : 'no-native:' + keys.btUnavailableReason(),
      devices,
      text: core.describe(devices),
      at: readAt,
      changedAt,
      /** 设备树里一共多少个节点（排查用：0 说明枚举没拿到东西） */
      rows,
      pollMs: 30000,
      /** 最近一次强制刷新的时间（0 = 还没用过） */
      forcedAt: lastForceAt,
      forceGapMs: FORCE_GAP_MS,
    }
  }

  /**
   * **强制刷新**：逼耳机把当前电量重新报一次。
   *
   * 为什么必须这么做：Windows 侧的值只在耳机主动上报时才变（见 battery-core 文件头），
   * 光"再读一遍"永远是同一个数。关掉再打开 HFP 服务能让链路重新握手，
   * 耳机一般会在 SLC 建立时再报一次 —— 2026-10-24 实测有效（时间戳当场跳到现在）。
   *
   * ⚠️ 副作用：HFP 是通话/麦克风那条链路，**会断 1~2 秒**；听歌不受影响。
   *    所以只在用户**明确点了按钮**时调用，绝不在后台自动做。
   */
  async function forceRefresh() {
    if (forcing) return Object.assign(status(), { force: { ok: false, reason: 'busy' } })
    const now = Date.now()
    const wait = FORCE_GAP_MS - (now - lastForceAt)
    if (lastForceAt && wait > 0) {
      return Object.assign(status(), { force: { ok: false, reason: 'throttled', retryInMs: wait } })
    }
    forcing = true
    const t0 = Date.now()
    try {
      const before = devices[0] ? devices[0].at : null
      const cur = devices[0]
      const hint = cur ? cur.label || cur.name : ''
      let r = await toggleInWorker(hint)
      if (!r.ok && String(r.reason || '').startsWith('worker-unavailable')) {
        // worker 起不来（极少见）：退回主线程内联执行。宁可卡 6 秒，也不能功能整条哑掉。
        report('worker 不可用，改在主线程执行（这 6 秒她会卡一下）')
        r = keys.btForceRefresh({ nameHint: hint })
      }
      const toggleMs = Date.now() - t0
      if (!r.ok) {
        report('强制刷新失败：' + r.reason + '（' + toggleMs + 'ms）')
        return Object.assign(status(), { force: r })
      }
      // 轮询到"电量时间戳比之前新"为止；期间设备节点可能短暂消失，所以 read 失败不算错
      const deadline = t0 + FORCE_TIMEOUT_MS
      let st = read(true)
      let sawNew = false
      for (;;) {
        const d = st.devices[0]
        if (d && d.at && (!before || d.at > before)) {
          sawNew = true
          break
        }
        if (Date.now() >= deadline) break
        await new Promise((res) => setTimeout(res, FORCE_POLL_MS))
        st = read(true)
      }
      report(
        '强制刷新鲜：切换 ' + toggleMs + 'ms，共用 ' + (Date.now() - t0) + 'ms，' + (sawNew ? '已拿到新值' : '超时未见新值'),
      )
      st.force = Object.assign({ ok: true, fresh: sawNew, elapsedMs: Date.now() - t0 }, r)
      return st
    } catch (e) {
      report('强制刷新异常：' + ((e && e.message) || e))
      return Object.assign(status(), { force: { ok: false, reason: 'error:' + ((e && e.message) || e) } })
    } finally {
      forcing = false
      // ⚠️ 节流从**完成**时刻算起：切换本身就要 8 秒左右，从开始算的话防连点几乎失效
      lastForceAt = Date.now()
    }
  }

  return { read, status, forceRefresh }
}

module.exports = { createBattery }
