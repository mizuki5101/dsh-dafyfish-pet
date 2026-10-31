'use strict'
// 统一上下文组装（2026-10-31，接云端 API 连续上下文改造）。
//
// 所有模型调用的消息都拼成同一个形状：
//   [system 人设/规则 —— 不变]
//   [user   「近况回放」= 昨天以前的确定性摘要（出自 ledger.digestPastDays，一天之内不变）]
//   [...    追加式块（ledger 窗口 / 对话历史）—— 只追加不重写]
//   [user   本次新鲜情境 —— 变化的东西永远在最后]
//
// 为什么执着于前缀稳定：DeepSeek 按公共前缀自动缓存，命中的部分约 1/10 价；
// 本地 llama-server 的 KV cache 同理。旧拼装（情境 JSON 塞 system、历史从头滑）缓存永远 0。
// 摘要故意只含「到昨天为止」：今天的动态全走追加窗口，摘要一天一换不打碎缓存。
//
// 这个文件只做组装，不碰 fs、不碰网络（纯函数 + 进程内缓存），可单独测。

const { digestPastDays } = require('./ledger')

const SUMMARY_HEAD = '【近况回放 · 到昨天为止的事】\n'
const SUMMARY_TAIL = '\n（以上是过去的事，不用逐条回应，接着现在聊就好。）'

/** 当日缓存：同一天内摘要内容不变 ⇒ 前缀稳定。跨天或外部 reset 才重算。 */
const SUMMARY_CACHE = { date: '', text: '' }

function dayKeyNow(now) {
  const d = new Date(now)
  return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate()
}

/**
 * 近况回放（带当日缓存）。
 * ⚠️ 一旦某天生成了**非空**摘要，当天内即使 ledger 又进了新东西也不再重算 ——
 * 这是刻意的（回放里少几条傍晚的事，换来整天的缓存命中；今天的动态本来就在窗口里）。
 * 空摘要不缓存（头几天可能确实没有历史，别把「空」钉死一整天）。
 */
function dailySummary(entries, opts) {
  const o = opts || {}
  const now = Number(o.now) > 0 ? Number(o.now) : Date.now()
  const key = dayKeyNow(now)
  if (SUMMARY_CACHE.date !== key) {
    SUMMARY_CACHE.date = key
    SUMMARY_CACHE.text = ''
  }
  if (!SUMMARY_CACHE.text) {
    SUMMARY_CACHE.text = digestPastDays(entries, { now, days: o.days })
  }
  return SUMMARY_CACHE.text
}

/** 测试用：把当日缓存清掉 */
function resetSummaryCache() {
  SUMMARY_CACHE.date = ''
  SUMMARY_CACHE.text = ''
}

/**
 * 组装：[system] + [近况回放] + blocks（若干组追加式轮次）+ [tail]。
 * 非法角色/空内容在这里挡掉；system/summary/blocks/tail 缺哪个就跳哪段。
 * @param {{system?:string, summary?:string, blocks?:Array<Array<{role,content}>>, tail?:string}} opts
 */
function assemble(opts) {
  const o = opts || {}
  const msgs = []
  if (o.system) msgs.push({ role: 'system', content: String(o.system) })
  if (o.summary) msgs.push({ role: 'user', content: SUMMARY_HEAD + String(o.summary) + SUMMARY_TAIL })
  for (const block of o.blocks || []) {
    for (const t of block || []) {
      if (t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim()) {
        msgs.push({ role: t.role, content: t.content })
      }
    }
  }
  if (o.tail) msgs.push({ role: 'user', content: String(o.tail) })
  return msgs
}

module.exports = { SUMMARY_HEAD, SUMMARY_TAIL, dailySummary, resetSummaryCache, assemble }
