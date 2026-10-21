'use strict'
// 「做梦」的水位线：上次醒来 / 上次睡着 / 上次做梦 —— 存 userData/dream-state.json。
//
// 为什么要落盘：窗口是「上次醒来 → 这次睡着」。外壳重启后页面那边的醒来时间就没了，
// 没有水位线的话每次重启都会退化成「12 小时前」这种模糊窗口，同一段事被反复记。
//
// ⚠️ 「下次睡着时立即做梦」那个一次性开关**不在这里**（不落盘，见 dream/index.js 的 forceOnce）。

const fs = require('node:fs')
const path = require('node:path')

const EMPTY = {
  lastWakeAt: 0,
  lastSleptAt: 0,
  lastDreamAt: 0,
  lastDiaryDate: '',
  lastResult: '',
  lastError: '',
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

function clean(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  return {
    lastWakeAt: num(s.lastWakeAt),
    lastSleptAt: num(s.lastSleptAt),
    lastDreamAt: num(s.lastDreamAt),
    lastDiaryDate: typeof s.lastDiaryDate === 'string' ? s.lastDiaryDate.slice(0, 10) : '',
    lastResult: typeof s.lastResult === 'string' ? s.lastResult.slice(0, 40) : '',
    lastError: typeof s.lastError === 'string' ? s.lastError.slice(0, 300) : '',
  }
}

function createState(opts) {
  const o = opts || {}
  const file = o.file
  let s = Object.assign({}, EMPTY)

  function load() {
    try {
      s = clean(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch (e) {
      s = Object.assign({}, EMPTY)
    }
    return Object.assign({}, s)
  }

  function save() {
    if (!file) return false
    const dir = path.dirname(file)
    const tmp = file + '.tmp-' + process.pid
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(s, null, 1))
      try {
        fs.renameSync(tmp, file)
      } catch (e) {
        fs.writeFileSync(file, JSON.stringify(s, null, 1))
        try { fs.unlinkSync(tmp) } catch (e2) {}
      }
      return true
    } catch (e) {
      return false
    }
  }

  load()

  return {
    file,
    get: () => Object.assign({}, s),
    reload: load,
    patch(p) {
      s = clean(Object.assign({}, s, p || {}))
      save()
      return Object.assign({}, s)
    },
  }
}

module.exports = { EMPTY, clean, createState }
