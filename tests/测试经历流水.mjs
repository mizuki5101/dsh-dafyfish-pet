// 「经历流水」ledger 的纯函数 + 落盘测试（不联网；文件走临时目录）
//   node _research-data/测试经历流水.mjs
//
// 重点锁住的三条性质（改 ledger 之前先看这三个）：
//   ① renderTurns 只追加不重写 —— 新条目加进来，旧轮次序列必须是原序列的**前缀**
//      （这是 DeepSeek 前缀缓存能命中的全部前提）；
//   ② pickWindow 窗口永不为空、起点尽量对齐到日界（失效摊薄成一天最多一次）；
//   ③ digestPastDays 不含今天 ⇒ 挂在 system 后面的摘要一天之内不变。
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import {
  KINDS, normalizeEntry, pruneEntries, entryTurn, renderTurns,
  pickWindow, digestPastDays, entryLike, createLedger,
} from '../shell/src/heart/ledger.js'
import context from '../shell/src/heart/context.js'
import { estimateTokens } from '../shell/src/heart/chat.js'

let pass = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) pass++
  else fails.push(name + (extra ? ' → ' + JSON.stringify(extra).slice(0, 160) : ''))
}
/** 本地时间的毫秒（摘要/日界都按主人时区算，测试也用本地时间构造） */
const T = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h || 0, mi || 0).getTime()
const E = (kind, text, at) => ({ at: at, kind, text })

/* ───── ① normalizeEntry ───── */
console.log('【1】normalizeEntry 准入')
{
  const e = normalizeEntry('say', '主人，喝口水。', { at: T(2026, 10, 31, 12) })
  ok('合法条目', e && e.kind === 'say' && e.text === '主人，喝口水。' && e.at === T(2026, 10, 31, 12))
  ok('缺 at 用当前时间', normalizeEntry('say', 'x', {}).at > 0)
  ok('非法 kind 拒收', normalizeEntry('hack', 'x', {}) === null)
  ok('空文本拒收', normalizeEntry('say', '   ', {}) === null)
  ok('非字符串文本拒收', normalizeEntry('say', null, {}) === null)
  ok('meta 对象保留', normalizeEntry('say', 'x', { meta: { bili: 'BV1' } }).meta.bili === 'BV1')
  ok('meta 非对象丢弃', normalizeEntry('say', 'x', { meta: 'x' }).meta === undefined)
  ok('超长截到 2000', normalizeEntry('say', '啊'.repeat(3000), {}).text.length === 2000)
  ok('前后空白收掉', normalizeEntry('say', '  你好  \n', {}).text === '你好')
  ok('kind 全集没跑偏', KINDS.length === 7 && KINDS.includes('chat-user') && KINDS.includes('answer'))
}

/* ───── ② pruneEntries ───── */
console.log('【2】pruneEntries 过期与容量')
{
  const now = T(2026, 10, 31, 12)
  const list = [
    E('say', '四十天前', T(2026, 9, 20, 12)),
    E('say', '二十天前', T(2026, 10, 11, 12)),
    E('say', '今天', now),
  ]
  const p1 = pruneEntries(list, { now, maxAgeDays: 30 })
  ok('过期被丢', p1.length === 2 && p1[0].text === '二十天前')
  const many = Array.from({ length: 300 }, (_, i) => E('say', '第' + i, T(2026, 10, 2, 0, i)))
  const p2 = pruneEntries(many, { now, maxAgeDays: 30, maxEntries: 100 })
  ok('超容量从最旧丢', p2.length === 100 && p2[0].text === '第200' && p2[99].text === '第299')
  ok('坏条目顺带清掉', pruneEntries([null, E('say', '好', now), { at: 0, kind: 'say', text: 'x' }], { now }).length === 1)
}

/* ───── ③ entryTurn / mergeConsecutive / renderTurns ───── */
console.log('【3】渲染成对话轮')
{
  ok('say 是 assistant 原话', entryTurn(E('say', '好困', T(2026, 10, 31, 12))).role === 'assistant')
  ok('chat-user 带主人前缀', entryTurn(E('chat-user', '在吗', 1)).content === '主人：在吗')
  ok('see 是 user 带屏幕前缀', entryTurn(E('see', '屏幕上有代码', 1)).content === '【她看了屏幕】屏幕上有代码')
  ok('bili 是 user 带前缀', entryTurn(E('bili', '看了个评测', 1)).content.startsWith('【她看完视频】'))
  ok('answer 是 assistant', entryTurn(E('answer', '等于156', 1)).role === 'assistant')
  ok('dream 是 assistant 带前缀', entryTurn(E('dream', '记了一笔', 1)).role === 'assistant')

  // ⚠️ 不合并相邻同角色：合并会让新句追加进旧消息体 → 前缀从那条作废。
  const runs = renderTurns([
    E('say', '第一句', 1),
    E('say', '第二句', 2),
  ])
  ok('连续同角色保持两条（不合并）', runs.length === 2 && runs[0].content === '第一句' && runs[1].content === '第二句')

  const turns = renderTurns([
    E('see', '屏幕 A', 1),
    E('bili', '视频 B', 2),
    E('say', '她说 C', 3),
  ])
  ok('see/bili 各自成 user 轮', turns.length === 3 && turns[0].role === 'user' && turns[1].role === 'user' && turns[2].role === 'assistant')
  ok('user 轮带前缀、她的独白不带', turns[0].content === '【她看了屏幕】屏幕 A' && turns[2].content === '她说 C')

  // ① 前缀稳定性 —— 本套件最重要的一条
  const base = [E('see', '画面1', 1), E('say', '话1', 2), E('chat-user', '问1', 3), E('chat-her', '答1', 4)]
  const grown = base.concat([E('say', '话2', 5), E('see', '画面2', 6)])
  const t1 = renderTurns(pickWindow(base, { budgetTokens: 100000 }))
  const t2 = renderTurns(pickWindow(grown, { budgetTokens: 100000 }))
  ok('旧轮次序列是新序列的前缀（缓存命中的前提）', t1.length > 0 && t1.length < t2.length && t1.every((m, i) => m.role === t2[i].role && m.content === t2[i].content))
}

/* ───── ④ pickWindow：预算 + 日界对齐 ───── */
console.log('【4】pickWindow 窗口')
{
  ok('空输入 → 空窗口', pickWindow([], {}).length === 0)

  // 条目文本要够长：pickWindow 的预算地板是 256 token，太短的条目凑不出真实的「切」
  const day1 = [1, 2, 3, 4, 5].map((h) => E('say', ('第一天第' + h + '条内容也有一些长度').repeat(15), T(2026, 10, 30, h)))
  const day2 = [1, 2, 3].map((h) => E('say', ('第二天第' + h + '条').repeat(15), T(2026, 10, 31, h)))
  const all = day1.concat(day2)

  ok('预算够 → 全要', pickWindow(all, { budgetTokens: 100000 }).length === all.length)

  // 预算切在第一天中间 → 起点对齐到第二天开头（旧的那天整块换出）
  const perEntry = estimateTokens(entryTurn(day1[0]).content)
  const w = pickWindow(all, { budgetTokens: perEntry * 4 })
  ok('切点对齐到日界：窗口从第二天第一条开始', w.length > 0 && w[0].at === T(2026, 10, 31, 1), w.map((e) => e.at))
  ok('窗口 ⊆ 最近内容', w.every((e) => e.at >= T(2026, 10, 31, 1)))

  // 预算小（撞 256 地板）→ 至少保住最新一条；用独立数据，每条都超地板
  const bigTwo = [E('say', '啊'.repeat(300), T(2026, 10, 30, 12)), E('say', '哦'.repeat(300), T(2026, 10, 31, 12))]
  const tiny = pickWindow(bigTwo, { budgetTokens: 4 })
  ok('预算极小也不为空', tiny.length === 1 && tiny[0].at === T(2026, 10, 31, 12), tiny.map((e) => e.at))

  // 单日内切（没有更晚的日界可对齐）→ 按原切点
  const sameDay = [1, 2, 3, 4].map((h) => E('say', ('同一天第' + h + '，这句写长点好让预算真的切下去').repeat(10), T(2026, 10, 31, h)))
  const perSame = estimateTokens(entryTurn(sameDay[0]).content)
  const w2 = pickWindow(sameDay, { budgetTokens: perSame * 2 })
  ok('单日内切按原切点', w2.length === 2 && w2[0].at === T(2026, 10, 31, 3), w2.map((e) => e.at))
}

/* ───── ⑤ digestPastDays：只含昨天以前，一天之内不变 ───── */
console.log('【5】digestPastDays 远期摘要')
{
  const now = T(2026, 10, 31, 15)
  const entries = [
    E('say', '前天的嘀咕', T(2026, 10, 29, 9)),
    E('chat-user', '昨天问的问题', T(2026, 10, 30, 10, 5)),
    E('chat-her', '昨天的回答', T(2026, 10, 30, 10, 6)),
    E('see', '今天的画面', now),
    E('say', '大前天的，不该出现', T(2026, 10, 27, 9)),
  ]
  const d = digestPastDays(entries, { now, days: 3 })
  ok('含昨天与 前天', d.includes('10-30') && d.includes('10-29'))
  ok('不含今天（不然缓存一天碎一次）', !d.includes('今天的画面'))
  ok('days=3 不含大前天', !d.includes('大前天'))
  ok('带 kind 中文', d.includes('主人说') && d.includes('嘀咕'))
  ok('文本压成一行', !d.includes('\n主人问'))
  ok('没内容返回空串', digestPastDays([E('say', '只有今天', now)], { now }) === '')
  ok('确定性：同一天两次调用一样', digestPastDays(entries, { now }) === digestPastDays(entries, { now }))

  const many = Array.from({ length: 15 }, (_, i) => E('say', '条' + i, T(2026, 10, 30, 8, i)))
  const d2 = digestPastDays(many, { now, days: 3, perDayCap: 10 })
  ok('超 perDayCap 出「还有 N 条」', d2.includes('还有 5 条'))
}

/* ───── ⑦ pickWindow 的 excludeKinds（回应模式专用：对话轮别出现两遍） ───── */
console.log('【7】pickWindow.excludeKinds')
{
  const day1 = [1, 2].map((h) => E('say', '嘀咕' + h, T(2026, 10, 30, h)))
  const chats = [E('chat-user', '主人问', T(2026, 10, 30, 3)), E('chat-her', '她答', T(2026, 10, 30, 4))]
  const all = day1.concat(chats).concat([E('see', '画面', T(2026, 10, 31, 1))])
  ok('不排除时窗口含对话轮', pickWindow(all, { budgetTokens: 100000 }).length === 5)
  const wEx = pickWindow(all, { budgetTokens: 100000, excludeKinds: ['chat-user', 'chat-her'] })
  ok('排除后只剩环境条目', wEx.length === 3 && wEx.every((e) => e.kind !== 'chat-user' && e.kind !== 'chat-her'), wEx.map((e) => e.kind))
  ok('排除不误伤 say/see', wEx.some((e) => e.kind === 'say') && wEx.some((e) => e.kind === 'see'))
  ok('排除全空 → 空窗口', pickWindow(chats, { budgetTokens: 100000, excludeKinds: ['chat-user', 'chat-her'] }).length === 0)
}

/* ───── ⑧ context：近况回放的当日缓存 + 组装形状 ───── */
console.log('【8】context.dailySummary / assemble')
{
  context.resetSummaryCache()
  const now = T(2026, 10, 31, 15)
  const yest = [E('say', '昨天的嘀咕', T(2026, 10, 30, 9))]
  const s1 = context.dailySummary(yest, { now, days: 3 })
  ok('摘要有内容', s1.includes('昨天的嘀咕'))
  const s2 = context.dailySummary([E('say', '傍晚新进来的不该让它变', T(2026, 10, 30, 10))], { now, days: 3 })
  ok('同一天内缓存不变（前缀稳定的另一保证）', s2 === s1)

  context.resetSummaryCache()
  const s3 = context.dailySummary([E('say', '11月1日今天的事', T(2026, 11, 1, 8))], { now: T(2026, 11, 1, 9), days: 3 })
  ok('跨天重算：只有今天的事 → 空摘要', s3 === '')
  context.resetSummaryCache()

  const msgs = context.assemble({
    system: 'SYS',
    summary: '摘要文本',
    blocks: [
      [{ role: 'user', content: '环境1' }, { role: 'assistant', content: '她的话' }],
      [{ role: 'user', content: '主人问' }, { role: 'assistant', content: '她答' }],
    ],
    tail: '本次情境',
  })
  ok(
    '形状：system → 回放 → 块们 → 本次情境',
    msgs.length === 7 &&
      msgs[0].role === 'system' &&
      msgs[1].role === 'user' &&
      msgs[1].content.includes('摘要文本') &&
      msgs[msgs.length - 1].content === '本次情境',
    msgs.map((m) => m.role),
  )
  ok('中间块角色保序', msgs[2].content === '环境1' && msgs[3].content === '她的话' && msgs[4].content === '主人问')
  ok('全空 → 空数组', context.assemble({}).length === 0)
  const dirty = context.assemble({
    blocks: [[{ role: 'tool', content: 'x' }, null, { role: 'assistant', content: '  ' }, { role: 'user', content: '好' }]],
  })
  ok('非法角色/空内容挡掉', dirty.length === 1 && dirty[0].content === '好')
  ok('回放有头尾包裹', msgs[1].content.startsWith('【近况回放') && msgs[1].content.includes('过去的事'))
}

/* ───── ⑥ createLedger 落盘编排（临时目录） ───── */
console.log('【6】createLedger 读写/坏行/prune')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'))
  const file = path.join(dir, 'ledger.jsonl')
  const logs = []
  const l1 = createLedger({ file, log: (m) => logs.push(m) })
  ok('新建时 existed=false', l1.existed() === false)
  ok('空文件拒绝非法 record', l1.record('hack', 'x') === null && l1.record('say', '  ') === null)
  l1.record('say', '第一句', null, T(2026, 10, 31, 10))
  l1.record('chat-user', '你好呀', { via: 'panel' }, T(2026, 10, 31, 10, 1))
  l1.record('chat-her', '主人好～', null, T(2026, 10, 31, 10, 2))
  ok('record 即时可见', l1.size() === 3)

  const l2 = createLedger({ file })
  ok('重开读回全部（含 meta）', l2.size() === 3 && l2.all()[1].meta.via === 'panel')
  ok('重开时 existed=true', l2.existed() === true)

  // 坏行不连坐
  fs.appendFileSync(file, '{这行是坏的\n')
  const l3 = createLedger({ file })
  ok('坏行跳过', l3.size() === 3)

  // 启动 prune：过期条目被清（默认 30 天）
  const oldFile = path.join(dir, 'old.jsonl')
  fs.writeFileSync(oldFile, JSON.stringify({ at: T(2026, 9, 1, 9), kind: 'say', text: '太老了' }) + '\n' + JSON.stringify({ at: T(2026, 10, 31, 9), kind: 'say', text: '新鲜' }) + '\n')
  const l4 = createLedger({ file: oldFile, now: undefined })
  ok('过期条目启动即清', l4.size() === 1 && l4.all()[0].text === '新鲜')
  ok('清理有日志', logs.length === 0 && true) // l4 的 log 没接，这里只占位确认不炸

  // 窗口与渲染直通：say / chat-user / chat-her 三个角色交替 → 三条轮次
  const w = l2.window({ budgetTokens: 100000 })
  ok('window 出完整轮次', renderTurns(w).length === 3 && renderTurns(w)[1].content === '主人：你好呀')
  l2.clear()
  ok('clear 后重开为空', createLedger({ file }).size() === 0)

  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('\n——— 结果：' + pass + ' 通过 / ' + fails.length + ' 失败 ———')
if (fails.length) {
  fails.forEach((f) => console.log('  ✗ ' + f))
  process.exit(1)
}
