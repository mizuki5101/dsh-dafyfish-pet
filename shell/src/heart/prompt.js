'use strict'
// 拼提示词（纯函数）。
//
// 2026-10-18 实测（MiniCPM-V 4.7 1B）总结出的四条硬经验：
//   1. **动作词表必须放在 system**。放在用户消息里、和图片挨着，1B 会把「尾巴快摆」当成屏幕上的内容，
//      于是台词变成「尾巴快摆，尾巴快摆」。挪进 system 后 topic 立刻回到屏幕（DeepSeek/文档/模型状态）。
//   2. **示例只能给格式，不能给内容**。给一个「猫踩奶」的完整示例，它会把猫抄进台词、甚至无视真实画面。
//      用占位符（<屏幕上的具体事>）当示例，既教会字段又不会污染。
//   3. **「新场景必须开口」要放在用户消息最后一行**（1B 对末尾最敏感）；只写在 system 规则里它会 act=none。
//   4. **topic 先行**：先让它写「看到的最具体的一件事」，再说 1~2 句；没有 topic 它就会退化成「喝口水」。

const { MOODS, MOTIONS, FACES, SCHEMA } = require('./catalog')

const SYSTEM = [
  '你是桌面宠物「大肥鱼」的旁白小脑：看一眼屏幕，主动跟主人搭句话。',
  '人设：爱吃白饭；不接受被叫胖；说话短、口语，称呼对方「主人」。',
  '可选动作（只能填进 motion 字段，**不是屏幕内容**）：' + MOTIONS.join(' / '),
  '写法：',
  '1) topic：截屏里最具体的一件事（≤15 字），只写真正看到的应用/文字/内容；',
  '2) say：**每一轮都要说**，1~2 句、≤50 字，像熟人搭话（评价/吐槽/提问都行），不要只是复述画面；',
  '   能提到 topic 里的细节最好；实在没看懂画面，就说一句泛泛的关心（提醒喝水/休息也可以），但别每轮都一样；',
  '   不要念动作名，不要提自己的尾巴/身体；',
  '3) 没有值得说的画面也要说 —— 她只做动作的话主人看不出区别；',
  '4) 只输出 JSON 对象，不要解释、不要 markdown。',
  // 示例为什么给两条、而且值都不一样：2026-10-19 实测 8/8 条回复全是 see=chat、mood=thinking，
  // 因为旧示例把这两个字段写成了实值 —— 模型直接照抄，她的表情就永远是「思考中」。
  // 枚举字段（see/mood/motion）不能写占位符（json_schema 会拒绝），只能给两个不同合法值让它知道有选择。
  '格式示例（topic/say 是占位符必须换成你看到的；see/mood/motion 要按实际画面和情绪自己挑，' +
    '下面两条只是两个不同例子，不要固定抄成 coding/happy/点头）：',
  '{"see":"coding","topic":"<屏幕上的具体事>","say":"<针对这件事的一句具体的话>","act":"speak","mood":"happy","motion":"点头","face":"","priority":"normal"}',
  '{"see":"browsing","topic":"<另一个画面里最具体的事>","say":"<换一个角度的一句具体的话>","act":"speak","mood":"shy","motion":"左顾右盼","face":"","priority":"normal"}',
].join('\n')

/** 情境：一行 JSON，避免模型去猜时间/上下文 */
function situationText(s) {
  const x = s || {}
  return JSON.stringify({
    time: x.time || '',
    day: x.weekday || '',
    last: x.lastNote || null,
    same: Number(x.same) || 0,
    saidRecently: Number(x.saidRecently) || 0,
    idleMin: Number.isFinite(x.idleMin) ? x.idleMin : null,
  })
}

/**
 * @param {object} opts
 *   imageDataUrl / newScene / situation / systemOverride / nudge（重试时的追加要求）
 */
function buildMessages(opts) {
  const o = opts || {}
  const text = [
    '情境：' + situationText(o.situation),
    o.lastText ? '上次说过：' + String(o.lastText).slice(0, 50) : '',
    // 最近 3 句：15 秒一轮时同一画面很容易复读，明确列出来让它换角度
    Array.isArray(o.recent) && o.recent.length
      ? '最近说过：' + o.recent.slice(-3).map((x) => String(x).slice(0, 40)).join(' / ') + '（不要重复这些话）'
      : '',
    // 她刚才探头说的那句（会真的显示在气泡上）。给模型接话头用，但要求它别复读。
    o.opener ? '你刚才探头说了句：「' + String(o.opener).slice(0, 40) + '」，接着这句往下说，不要重复它。' : '',
    // ⚠️ 动作词表不在这里（在 system）。这条位置只放「这一轮的硬要求」。
    // 用户要求「每轮都说话」：不再用新/旧场景决定说不说，只决定说什么。
    '这一轮必须 act=speak，say 非空；没新细节就换个角度聊（吐槽/提问/提醒都行）。',
    o.nudge ? String(o.nudge).slice(0, 200) : '',
  ]
    .filter(Boolean)
    .join('\n')

  const content = [{ type: 'text', text }]
  if (o.imageDataUrl) content.push({ type: 'image_url', image_url: { url: o.imageDataUrl } })

  // 面板里改过提示词就用改过的；空 = 默认人设。
  const sys = typeof o.systemOverride === 'string' && o.systemOverride.trim() ? o.systemOverride.trim() : SYSTEM
  return [
    { role: 'system', content: sys },
    { role: 'user', content },
  ]
}

module.exports = { SYSTEM, SCHEMA, situationText, buildMessages }
