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
  return out
}

module.exports = { readJson, writeJson, deepMerge, patchHeart, sanitizeHeartPatch }
