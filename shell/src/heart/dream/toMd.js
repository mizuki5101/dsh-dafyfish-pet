'use strict'
// 「做梦」的 JSON → Markdown（纯函数）。
//
// 为什么单独一层：模型只负责「写什么」（JSON），文件格式由这里保证稳定。
// 不能让模型的自由发挥污染结构 —— 它要是自己加个 `# 标题`，整个文件的分段编号就废了。
//
// 格式（每天一个文件，同一天第 N 次睡追加一段）：
//   # 2026-10-21 · 肥鱼日记
//
//   > 主人不在的时候，我自己记一点。
//
//   ## 12:40 · 第 1 次小睡
//
//   **小标题**
//
//   第一段
//
//   第二段

const DAY_TITLE = '肥鱼日记'
const DAY_NOTE = '> 主人不在的时候，我自己记一点。'
const MAX_HEAD = 24
const MAX_PARA = 300
const MAX_PARAS = 6
const MIN_PARAS = 2

function pad2(n) {
  const v = Math.floor(Number(n)) || 0
  return (v < 10 ? '0' : '') + v
}

/** 本地日期 YYYY-MM-DD（按入睡时刻算，不是 UTC） */
function dayName(at) {
  const d = new Date(Number(at) > 0 ? Number(at) : Date.now())
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

function dayFileName(at) {
  return dayName(at) + '.md'
}

/** 本地时刻 HH:MM */
function clockText(at) {
  const d = new Date(Number(at) > 0 ? Number(at) : Date.now())
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

function dayHeader(at) {
  return '# ' + dayName(at) + ' · ' + DAY_TITLE + '\n\n' + DAY_NOTE + '\n'
}

/** 已有文件里已经有几段（`## ` 开头的行数）—— 用来算「第 N 次小睡」 */
function sectionCount(md) {
  const s = String(md == null ? '' : md)
  let n = 0
  for (const line of s.split('\n')) if (/^##\s/.test(line)) n++
  return n
}

/** 一段正文的清洗：去掉模型自己加的标题/围栏，压平空白，夹长度 */
function cleanPara(s, max) {
  let t = String(s == null ? '' : s)
  t = t.replace(/```[a-zA-Z]*/g, ' ')
  t = t.replace(/^[\s>]*#{1,6}\s*/gm, '')
  t = t.replace(/\s+/g, ' ').trim()
  const cap = Math.max(20, Number(max) || MAX_PARA)
  return t.slice(0, cap)
}

/** 判重用的「骨」：去掉空白和标点 */
function normTail(s) {
  return String(s == null ? '' : s)
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。！？、；：…“”‘’"'）（()【】\[\],.!?;:%~～—\-]/g, '')
}

/**
 * 「叮嘱式收尾」的识别。
 *
 * 真实那篇日记里 8 段，尾巴不是一模一样，而是**换了说法**：
 *   「…记得把刚改完的存一下，别丢」「…本鲸也要记得保存好再关，别丢」「…记得吃饭」
 * 只按「一字不差」判重只能抓到一半，所以这里再来一条：**叮嘱类收尾整类只留第一次**。
 */
const CARE = /(记得|别忘|别丢|千万别|一定要|注意身体|小心|多喝水|别熬夜|保存好)/

/** 把一段切成「除最后一句」+「最后一句」（句末标点先摘掉） */
function splitLastSentence(p) {
  const s = String(p == null ? '' : p).trim()
  const body = s.replace(/[。！？!?…；;]+$/, '')
  let idx = -1
  for (const ch of ['。', '！', '？', '!', '?', '…', '；', ';']) {
    const i = body.lastIndexOf(ch)
    if (i > idx) idx = i
  }
  if (idx < 0) return { head: '', tail: body }
  return { head: body.slice(0, idx + 1), tail: body.slice(idx + 1) }
}

/** 把一段切成句子（标点跟着前一句，尽量不破坏原文） */
function splitSentences(p) {
  const s = String(p == null ? '' : p)
  const out = []
  let buf = ''
  for (const ch of s) {
    buf += ch
    if ('。！？…；!?;'.includes(ch)) {
      out.push(buf)
      buf = ''
    }
  }
  if (buf.trim()) out.push(buf)
  return out.filter((x) => x.trim())
}

/** 去掉句末悬空的标点/逗号，并保证以句末标点收尾 */
function tidyEnd(t) {
  const s = String(t == null ? '' : t).trim().replace(/[，,、；;：:\s]+$/, '')
  if (!s) return ''
  return /[。！？!?…]$/.test(s) ? s : s + '。'
}

/**
 * 只删「叮嘱那半句」，留下前面的事实。
 * 「看这排期，P0要三天半写完，主人别熬夜啊，记得吃饭。」
 *   → 「看这排期，P0要三天半写完。」
 * 整句都是叮嘱（第一个分句就命中）才返回空串。
 */
function stripCareClause(s) {
  const parts = String(s == null ? '' : s).split('，')
  let cut = -1
  for (let i = 0; i < parts.length; i++) {
    if (CARE.test(parts[i])) {
      cut = i
      break
    }
  }
  if (cut <= 0) return ''
  const head = parts.slice(0, cut).join('，')
  // 砍完只剩「不过本鲸也要提醒主人」这种引导语 → 一起丢掉，别留半句
  if (/(提醒|告诉|嘱咐|劝|建议)(主人|你|您)?$/.test(head.trim())) return ''
  return tidyEnd(head)
}

/**
 * 句级去重（2026-10-21 真机踩出来的，原名 dedupeTails）。
 *
 * 起因：第一篇日记 8 段，段段以「…别丢」结尾，中间还各重复一遍问句 ——
 *   素材里那句关心话就重复了 7 次，只靠提示词压不住 1B/9B。
 * 做什么（全部是**硬保证**，不依赖模型听话）：
 *   ① 同一段里同一句（去标点后 ≥8 字）出现两次 → 只留第一次；
 *   ② 同一句在 ≥3 段里出现 → 只留第一次；
 *   ③ 「叮嘱类」句子（记得/别丢/别熬夜…）**换个说法也算同一类**，跨 ≥3 段就只留第一次。
 * 防护：删到不足 2 段就原样返回（宁可留着，也不把正文删没）。
 */
function dedupeSentences(paras, minLen, minCount) {
  const list = Array.isArray(paras) ? paras : []
  if (list.length < 2) return list
  const min = Math.max(4, Number(minLen) || 8)
  const need = Math.max(2, Number(minCount) || 3)

  // 第一遍：统计每个 key 出现在哪些段
  const where = new Map()
  const add = (key, i) => {
    if (!where.has(key)) where.set(key, new Set())
    where.get(key).add(i)
  }
  list.forEach((p, i) => {
    for (const s of splitSentences(p)) {
      const k = normTail(s)
      if (k.length >= min) add(k, i)
      if (CARE.test(s) && k.length >= 4) add('$care', i)
    }
  })

  // 第二遍：按段落重建
  const seenGlobal = new Set()
  const out = []
  list.forEach((p) => {
    const seenLocal = new Set()
    const kept = []
    for (const s of splitSentences(p)) {
      const k = normTail(s)
      const exactKey = k.length >= min ? k : ''
      const isCare = CARE.test(s) && k.length >= 4
      let dropWhole = false
      let dropCare = false

      if (exactKey && seenLocal.has(exactKey)) dropWhole = true
      if (!dropWhole && isCare && seenLocal.has('$care')) dropCare = true

      if (!dropWhole && exactKey) {
        const cnt = where.get(exactKey)
        if (cnt && cnt.size >= need) {
          if (seenGlobal.has(exactKey)) dropWhole = true
          else seenGlobal.add(exactKey)
        }
      }
      if (!dropWhole && !dropCare && isCare) {
        const cnt = where.get('$care')
        if (cnt && cnt.size >= need) {
          if (seenGlobal.has('$care')) dropCare = true
          else seenGlobal.add('$care')
        }
      }

      if (dropWhole) continue
      if (dropCare) {
        // 只砍叮嘱那半句，别把「P0 三天半」这种事实一起砍掉
        const keptClause = stripCareClause(s)
        if (keptClause) kept.push(keptClause)
        continue
      }
      if (exactKey) seenLocal.add(exactKey)
      if (isCare) seenLocal.add('$care')
      kept.push(s)
    }
    const t = tidyEnd(kept.join(''))
    if (t) out.push(t)
  })
  return out.length >= MIN_PARAS ? out : list
}

/** 旧名字，保留给已有调用/测试 */
const dedupeTails = dedupeSentences

/**
 * 模型输出 → 可信对象（纯函数）。
 * 返回 null = 这次放弃写（worth=false / 结构不对 / 正文太短）。
 */
function parseDream(raw) {
  let j = raw
  if (typeof raw === 'string') {
    const s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    try {
      j = JSON.parse(s)
    } catch (e) {
      return null
    }
  }
  if (!j || typeof j !== 'object') return null
  // worth 兼容 true / "true" / 1；缺字段按「不值得记」
  const w = j.worth
  const worth = w === true || w === 'true' || w === 1
  if (!worth) return null
  const head = cleanPara(j.head || '', MAX_HEAD)
  const list = Array.isArray(j.paras) ? j.paras : typeof j.paras === 'string' ? [j.paras] : []
  const paras = dedupeTails(
    list.map((x) => cleanPara(x, MAX_PARA)).filter((x) => x.length >= 4),
  ).slice(0, MAX_PARAS)
  // 至少要 2 段（本项目 1B/9B 的老脾气：要求写短它就只写一行）
  if (paras.length < MIN_PARAS) return null
  return { worth: true, head, paras }
}

/** 一次做梦 → Markdown 小节（末尾带一个换行） */
function renderSection(dream, at, n) {
  const d = dream && typeof dream === 'object' ? dream : {}
  const paras = dedupeTails(
    (Array.isArray(d.paras) ? d.paras : []).map((x) => cleanPara(x, MAX_PARA)).filter(Boolean),
  )
  if (!paras.length) return ''
  const idx = Math.max(1, Math.round(Number(n) || 1))
  const lines = ['## ' + clockText(at) + ' · 第 ' + idx + ' 次小睡', '']
  const head = cleanPara(d.head || '', MAX_HEAD)
  if (head) lines.push('**' + head + '**', '')
  lines.push(paras.join('\n\n'))
  return lines.join('\n') + '\n'
}

module.exports = {
  DAY_TITLE,
  DAY_NOTE,
  MAX_HEAD,
  MAX_PARA,
  MAX_PARAS,
  MIN_PARAS,
  dayName,
  dayFileName,
  clockText,
  dayHeader,
  sectionCount,
  cleanPara,
  splitLastSentence,
  splitSentences,
  dedupeSentences,
  dedupeTails,
  parseDream,
  renderSection,
}
