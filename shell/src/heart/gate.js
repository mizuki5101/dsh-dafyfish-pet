'use strict'
// 心跳门控（纯函数，可单测）。
//
// 「该不该看这一眼」全部收在这里：开关、预算、最小间隔、夜间降频、窗口被收起来。
// 运行时（index.js）只负责数时间和真的去采集；这样门控规则改起来不用动采集代码，
// 也符合项目里 @idle-sensors / @idle-rhythm 那套「纯函数 + 单测」的写法。

function isNight(hour, nightQuiet) {
  if (!nightQuiet) return false
  return hour >= 23 || hour < 6
}

function lookGapMs(cfg, hour) {
  const base = Math.max(1, Number(cfg.lookMinGapSec) || 60) * 1000
  return isNight(hour, cfg.nightQuiet) ? base * 6 : base
}

function hourCount(looks, now) {
  if (!Array.isArray(looks)) return 0
  return looks.filter((t) => Number.isFinite(t) && now - t < 3600 * 1000).length
}

/**
 * @param {object} s  { cfg, now, hour, lastAt, looks, visible, busy, stopped }
 * @returns {{ok:boolean, reason:string}}
 */
function shouldLook(s) {
  const cfg = (s && s.cfg) || {}
  const now = Number(s && s.now) || 0
  const hour = Number.isFinite(s && s.hour) ? s.hour : new Date(now).getHours()
  if (!cfg.enabled) return { ok: false, reason: 'disabled' }
  if (s.stopped) return { ok: false, reason: 'stopped' }
  if (s.busy) return { ok: false, reason: 'busy' }
  if (hourCount(s.looks, now) >= (Number(cfg.maxLooksPerHour) || 20)) return { ok: false, reason: 'budget' }
  const lastAt = Number(s.lastAt) || 0
  if (lastAt && now - lastAt < lookGapMs(cfg, hour)) {
    return { ok: false, reason: isNight(hour, cfg.nightQuiet) ? 'gap-night' : 'gap' }
  }
  if (s.visible === false) return { ok: false, reason: 'hidden' }
  return { ok: true, reason: 'due' }
}

module.exports = { isNight, lookGapMs, hourCount, shouldLook }
