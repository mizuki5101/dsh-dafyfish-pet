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

module.exports = { readJson, writeJson, deepMerge, patchHeart }
