'use strict'
// 「做梦」的提示词与输出 schema（纯函数）。
//
// 设计要点（都是本项目踩过的坑）：
//   1. **示例只能给格式不能给内容** —— 给了具体内容，模型会把那件事写进日记（1B/9B 都这样）。
//   2. **硬要求放最后一行** —— 对 1B 最敏感的位置。
//   3. **「不许编」要说人话**：不是「请确保真实性」这种空话，而是「没写在素材里的事不许写」。
//   4. 素材是「发生了什么」的清单，不是写好的句子 —— 句子它会照抄，清单它会改写。
//   5. 允许碎碎念、联想、吐槽、心情，这才是「日记」而不是「日志」。

const { MAX_HEAD, MAX_PARA, MAX_PARAS } = require('./toMd')

const PERSONA = [
  '你是桌面宠物「大肥鱼」——鲸类的小萝莉，傲娇又甜，爱吃白饭，绝对不接受被叫胖。',
  '自称「本鲸」，称呼主人为「主人」。第一人称写。',
].join('\n')

const SYSTEM = [
  PERSONA,
  '现在你刚睡了一觉（主人以为你睡着，其实你在做梦）。',
  '你会在梦里把「上一次醒来之后到刚才睡着之前」这段时间过一遍，写成一段只给自己看的日记。',
  '写法：',
  '1) 日记是写给自己看的，不是给主人的汇报；可以碎碎念、吐槽、联想、写心情、惦记白饭、想主人；',
  '2) **只能写下面素材里真实发生过的事**，素材里没有的事一律不许编；',
  // 2026-10-21 实测：它把素材里的「科索沃」写成了「科西嘉」——
  // 专有名词必须点名要求照抄，否则小模型会"顺手润色"成别的词。
  '   地名、人名、项目名、视频标题这些**专有名词要原样照抄**，一个字都不许换；',
  '3) 联想和情绪随便加，但事实要准：刷了哪个视频、主人说了什么、你自己嘀咕了什么，都要和素材对得上；',
  '   素材里的句子**不要原样照抄**，用你自己的话换着说；',
  '4) 写 2~' + MAX_PARAS + ' 段，每段 50~' + MAX_PARA + ' 字，段落之间自然转折，不要写成「1. 2. 3.」的清单；',
  '   素材有几条**不等于**要写几段：同一类、同一时段的事合并成一段叙述，别一条素材写一段；',
  // 2026-10-21 真机踩的坑：8 段段段以「…别丢」收尾，因为素材里那句就重复。
  // 提示词里必须点名禁止「同一句收尾」，不能只说"别重复"（它不知道什么算重复）。
  '5) **同一个意思只写一次**：不要每段都用同一句关心话收尾，也不要在同一段里把同一个问句问两遍；',
  '6) 如果这段时间确实没什么值得记的新事（素材很淡、都是重复的、或者只是空白照常），就把 worth 设成 false，什么都别写；',
  '7) head 是这次小睡的一句小标题（≤12 字），worth=false 时留空；',
  '8) 只输出 JSON 对象，不要解释、不要 markdown、不要在正文里加 # 标题。',
].join('\n')

/**
 * 给 response_format.json_schema 用。
 * ⚠️ strict 模式要求：所有字段都进 required、additionalProperties=false。
 * 不写 enum/minItems —— llama.cpp 对它们的支持不稳，长度靠 toMd.parseDream 在代码层夹。
 */
const SCHEMA = {
  type: 'object',
  properties: {
    worth: { type: 'boolean' },
    head: { type: 'string' },
    paras: { type: 'array', items: { type: 'string' } },
  },
  required: ['worth', 'head', 'paras'],
  additionalProperties: false,
}

/**
 * @param {{material:string, todayDiary?:string, recentHeads?:string[], window?:{since:number,until:number}, nudge?:string}} o
 * @returns {Array<{role:string,content:string}>}
 */
function buildMessages(o) {
  const x = o || {}
  const parts = []
  parts.push('【这段时间发生了什么】')
  parts.push(String(x.material || '（素材为空）'))

  const heads = Array.isArray(x.recentHeads) ? x.recentHeads.filter(Boolean).slice(-8) : []
  if (heads.length) {
    parts.push('')
    parts.push('【前几天你写过的日记小标题（这些事已经记过了，别再写一遍）】')
    for (const h of heads) parts.push('· ' + String(h).slice(0, 30))
  }

  const today = String(x.todayDiary || '').trim()
  if (today) {
    parts.push('')
    parts.push('【今天你已经写过的日记（最后一段）—— 不要重复里面的内容，接着往后写】')
    parts.push(today.slice(-1200))
  }

  parts.push('')
  parts.push(
    '这一轮必须给出 worth。值得记时：2~' + MAX_PARAS + ' 段、每段 50~' + MAX_PARA + ' 字、' +
      '同一类的事合并成一段、**不要每段用同一句收尾**、专有名词照抄；' +
      '不值得记时 worth=false、head 留空、paras 留空数组。',
  )
  if (x.nudge) parts.push(String(x.nudge).slice(0, 200))

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: parts.join('\n') },
  ]
}

module.exports = { PERSONA, SYSTEM, SCHEMA, MAX_HEAD, buildMessages }
