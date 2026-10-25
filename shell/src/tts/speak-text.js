'use strict'
// 台词 → 朗读文本 的清洗（纯函数，可单测）。
//
// 气泡里给眼睛看的字和念给耳朵听的字不是一回事：
//   · markdown 符号（**加粗**、`代码`、# 标题）念出来就是噪音；
//   · 链接 URL 念出来是一串字母；
//   · emoji 没有读音，很多 TTS 会念成「[表情]」或直接卡住；
//   · 台词可能超过配置的 maxChars（刷视频的正文），要在句子边界截断，
//     不能把「主」砍成半句还念出来。
//
// 刻意**不**删的：括号旁注（（脸黑了）这个工具报错了）——那是她台词的一部分，
// 全角括号里的内容通常读起来也自然；要不要去旁注留给以后真机听效果再说。

const URL_RE = /\bhttps?:\/\/\S+/g
// emoji 与杂符号（u 标志 + {} 区间：不带 u 的话 \u1f000 会被解析成 \u1f00 + 字面量 0）
const SYMBOL_RE = /[\u200d\uFE0F\u2190-\u2BFF\u3164-\u318F\u{1F000}-\u{1FAFF}]/gu
// markdown 强调/代码/引用符号（成对出现，直接删字符不删内容）
const MD_RE = /[*_`#>~]+/g

/** 在句子边界截断（纯函数）。找不到句末标点就硬切。 */
function cutAtSentence(text, maxChars) {
  const s = String(text == null ? '' : text)
  if (s.length <= maxChars) return s
  const head = s.slice(0, maxChars)
  // 从后往前找最后一个句末标点；太靠前（< 一半）就宁可硬切也别丢一半内容
  const m = head.match(/[。！？!?…；;]{1,3}(?=[^。！？!?…；;]*$)/)
  if (m && m.index >= Math.floor(maxChars * 0.4)) return head.slice(0, m.index + m[0].length)
  return head
}

/**
 * @param {string} text 气泡原文
 * @param {number} maxChars 朗读上限（走 heart.tts.maxChars 的夹取值）
 * @returns {string} 清洗后为空就返回 ''（调用方据此跳过合成）
 */
function cleanSpeechText(text, maxChars) {
  const cap = Math.max(10, Math.min(600, Number(maxChars) || 120))
  let s = String(text == null ? '' : text)
  s = s.replace(URL_RE, ' ')
  // emoji 直接删（替换成空格会把「你好😀呀」拆成「你好 呀」，中文里很怪）
  s = s.replace(SYMBOL_RE, '')
  s = s.replace(MD_RE, '')
  // 连续空白/换行折叠成一个空格；再去掉首尾
  s = s.replace(/\s+/g, ' ').trim()
  s = cutAtSentence(s, cap)
  return s.trim()
}

module.exports = { cleanSpeechText, cutAtSentence }
