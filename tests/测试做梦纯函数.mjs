// 「做梦」模块的纯函数测试（不联网、不调模型；只往临时目录写文件）
//   node _research-data/测试做梦纯函数.mjs
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import toMd from '../shell/src/heart/dream/toMd.js'
import collect from '../shell/src/heart/dream/collect.js'
import promptMod from '../shell/src/heart/dream/prompt.js'
import store from '../shell/src/heart/dream/store.js'
import dreamIndex, { shouldRun } from '../shell/src/heart/dream/index.js'
import { normalize, DEFAULTS } from '../shell/src/heart/config.js'
import { sanitizeHeartPatch } from '../shell/src/heart/settings.js'

let pass = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) pass++
  else fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 200) : ''))
}

/** 本地时间 2026-10-21 12:40 的时间戳（跟时区无关，因为都用本地时间构造） */
const T1 = new Date(2026, 9, 21, 12, 40, 0).getTime()
const T2 = new Date(2026, 9, 21, 15, 2, 0).getTime()
const DAY = 86400000

/* ───── ① 时间和文件名 ───── */
console.log('\n【1】toMd 时间/文件名')
{
  ok('dayName 用本地日期', toMd.dayName(T1) === '2026-10-21', toMd.dayName(T1))
  ok('dayFileName 带 .md', toMd.dayFileName(T1) === '2026-10-21.md')
  ok('clockText 补零', toMd.clockText(T1) === '12:40', toMd.clockText(T1))
  ok('clockText 单数字补零', toMd.clockText(new Date(2026, 0, 2, 3, 5).getTime()) === '03:05')
  ok('跨天不会串（同一天同一文件）', toMd.dayFileName(T1) === toMd.dayFileName(T2))
  ok('跨天换文件', toMd.dayFileName(T1) !== toMd.dayFileName(T1 + DAY))
  ok('非法 at 不炸', typeof toMd.dayName(null) === 'string' && toMd.dayName(null).length === 10)
  ok('dayHeader 含日期与标题', toMd.dayHeader(T1).startsWith('# 2026-10-21 · 肥鱼日记'))
  ok('dayHeader 有一句说明', /主人不在/.test(toMd.dayHeader(T1)))
}

/* ───── ② 段落计数与渲染 ───── */
console.log('【2】toMd.sectionCount / cleanPara / renderSection')
{
  ok('空文件 0 段', toMd.sectionCount('') === 0)
  ok('文件头不算段', toMd.sectionCount(toMd.dayHeader(T1)) === 0)
  const md = toMd.dayHeader(T1) + '\n## 12:40 · 第 1 次小睡\n\n正文\n'
  ok('一段 → 1', toMd.sectionCount(md) === 1)
  ok('两段 → 2', toMd.sectionCount(md + '\n## 15:02 · 第 2 次小睡\n') === 2)
  ok('正文里的 # 不算', toMd.sectionCount('# 标题\n#### 小标题\n') === 0)

  ok('cleanPara 去掉模型加的标题', !toMd.cleanPara('## 我的日记\n今天很好').includes('##'))
  ok('cleanPara 去掉代码围栏', !toMd.cleanPara('```js\n今天\n```').includes('```'))
  ok('cleanPara 压平空白', toMd.cleanPara('a\n\n\n   b') === 'a b', toMd.cleanPara('a\n\n\n   b'))
  ok('cleanPara 夹长度', toMd.cleanPara('啊'.repeat(999), 100).length === 100)
  ok('cleanPara 空输入 → 空串', toMd.cleanPara(null) === '')

  const sec = toMd.renderSection({ head: '白饭', paras: ['第一段内容够长', '第二段内容够长'] }, T1, 3)
  ok('小节标题带时刻与序号', sec.startsWith('## 12:40 · 第 3 次小睡'))
  ok('小节含加粗小标题', sec.includes('**白饭**'))
  ok('小节两段都在', sec.includes('第一段内容够长') && sec.includes('第二段内容够长'))
  ok('小节以换行结尾', sec.endsWith('\n'))
  ok('没 head 就不留空星号', !toMd.renderSection({ paras: ['aa内容', 'bb内容'] }, T1, 1).includes('**'))
  ok('没正文 → 空串', toMd.renderSection({ paras: [] }, T1, 1) === '')
}

/* ───── ③ 模型输出解析（worth 的三种坏情况）───── */
console.log('【3】toMd.parseDream')
{
  const good = toMd.parseDream({ worth: true, head: '嗯', paras: ['第一段写点什么', '第二段写点什么'] })
  ok('正常输出被接受', !!good && good.paras.length === 2)
  ok('worth=false → 放弃', toMd.parseDream({ worth: false, head: '', paras: [] }) === null)
  ok('worth 字符串 "true" 也认', !!toMd.parseDream({ worth: 'true', paras: ['aaaa', 'bbbb'] }))
  ok('缺 worth → 放弃（不瞎写）', toMd.parseDream({ paras: ['aaaa', 'bbbb'] }) === null)
  ok('只有 1 段 → 放弃', toMd.parseDream({ worth: true, paras: ['只有一段而已'] }) === null)
  ok('非 JSON → 放弃', toMd.parseDream('随便说了一句话') === null)
  ok('```json 包裹也能解', !!toMd.parseDream('```json\n{"worth":true,"head":"","paras":["aaaa","bbbb"]}\n```'))
  ok('paras 是字符串 → 只算一段 → 放弃', toMd.parseDream({ worth: true, paras: 'aaaa' }) === null)
  ok('超段数被裁到上限', toMd.parseDream({ worth: true, paras: new Array(12).fill('内容够长的段落') }).paras.length === toMd.MAX_PARAS, toMd.MAX_PARAS)
  ok('空段被丢掉', toMd.parseDream({ worth: true, paras: ['', '有效段落一', '有效段落二', ''] }).paras.length === 2)
}

/* ───── ③.5 重复收尾的硬清理（真机踩过：8 段都以「…别丢」结尾）───── */
console.log('【3.5】toMd.dedupeTails')
{
  const tail = '本鲸也要记得保存好再关，别丢。'
  const three = [
    '第一段讲的是刷视频的事，还行。' + tail,
    '第二段讲的是主人改文档的事。' + tail,
    '第三段讲的是文件夹太乱。' + tail,
  ]
  const out = toMd.dedupeTails(three)
  ok('重复收尾只在第一段保留', out[0].includes('别丢') && !out[1].includes('别丢') && !out[2].includes('别丢'), out)
  ok('被删的段落人还在', out.length === 3)
  ok('删完仍是完整句子', /[。！？…]$/.test(out[1]), out[1])
  ok('删完不留悬空逗号', !/[，,、；;]$/.test(out[1].replace(/[。！？…]$/, '')), out[1])
  ok('两段同尾不清理（阈值 3）', toMd.dedupeTails(three.slice(0, 2))[1].includes('别丢'))
  const allSame = ['同一句重复的话别丢啊。', '同一句重复的话别丢啊。', '同一句重复的话别丢啊。']
  ok('全删会毁正文时就不清理', toMd.dedupeTails(allSame).length === 3)
  ok('splitLastSentence 切出最后一句', toMd.splitLastSentence('甲。乙丙，别丢。').tail === '乙丙，别丢')
  ok('splitLastSentence 无标点时整段算尾', toMd.splitLastSentence('只有一句没有标点').head === '')
  ok('parseDream 出口也清理', toMd.parseDream({ worth: true, paras: three }).paras[1].indexOf('别丢') < 0)
  ok('renderSection 出口也清理', (toMd.renderSection({ paras: three }, T1, 1).match(/别丢/g) || []).length === 1)

  // 段内复读（真实那篇里「这文件夹名字也太长了…」同一段问了两遍）
  const intra = toMd.dedupeSentences([
    '主人是不是又在折腾那个记忆库啊？主人是不是又在折腾那个记忆库啊？本鲸有点担心。',
    '第二段写点别的吧。',
    '第三段也写点别的。',
  ])
  ok('段内同一句只留一次', (intra[0].match(/又在折腾那个记忆库/g) || []).length === 1, intra[0])

  // 换着说法的叮嘱（真实数据里 7 段尾巴一字不差，但变体也要压住）
  const varied = [
    '甲段讲刷视频，还行。不过本鲸也要提醒主人，记得把刚改完的存一下，别丢。',
    '乙段讲改文档的事。本鲸也要记得保存好再关，别丢。',
    '丙段讲文件夹太乱。记得保存好再关，别丢。',
  ]
  const v = toMd.dedupeSentences(varied)
  ok('换着说法的叮嘱也只留第一次', v.filter((x) => /别丢/.test(x)).length === 1, v)
  ok('第一段的事实没被砍', v[0].includes('刷视频'))

  // 砍叮嘱只砍叮嘱那半句，事实要留下
  const mixed = [
    '甲段。记得多喝水哦。',
    '看这排期，P0要三天半写完，主人别熬夜啊，记得吃饭。',
    '丙段。记得吃饭。',
  ]
  const mx = toMd.dedupeSentences(mixed)
  ok('砍叮嘱时保留事实（P0 三天半还在）', mx[1].includes('P0要三天半写完'), mx)
  ok('叮嘱本身被砍掉', !mx[1].includes('记得吃饭'), mx[1])
  ok('砍完不留「…提醒主人。」这种半句', !mx.some((x) => /(提醒|告诉)主人。$/.test(x)), mx)
}

/* ───── ③.6 段数上限 ───── */
console.log('【3.6】MAX_PARAS')
{
  ok('段数上限是 6（原来是 8，太长而且容易一段一条）', toMd.MAX_PARAS === 6)
  ok('每段至少 50 字的下限写在提示词里', /50~/.test(promptMod.SYSTEM))
}

/* ───── ④ 窗口计算 ───── */
console.log('【4】collect.windowOf')
{
  const w1 = collect.windowOf({ lastWakeAt: T1, now: T2 })
  ok('有唤醒时间就用它', w1.since === T1 && w1.until === T2 && w1.source === 'wake')
  // 没有水位线：取「上次做梦 / 上次入睡 / 12h 前」里最新的
  const w2 = collect.windowOf({ lastDreamAt: T1, lastSleptAt: T1 - DAY, now: T2 })
  ok('无唤醒 → 用上次做梦兜底', w2.since === T1 && w2.source === 'fallback')
  const w3 = collect.windowOf({ now: T2 })
  ok('什么都没有 → 12 小时前', T2 - w3.since === collect.FALLBACK_MS, T2 - w3.since)
  ok('窗口不会倒挂', collect.windowOf({ lastWakeAt: T2 + DAY, now: T2 }).since <= T2)
  ok('最多回溯 7 天', T2 - collect.windowOf({ lastWakeAt: 1, now: T2 }).since <= collect.MAX_LOOKBACK_MS)
}

/* ───── ⑤ 素材筛选 ───── */
console.log('【5】collect.collectMaterial')
{
  const since = T1
  const until = T2
  const says = [
    { at: T1 - 1000, say: '窗口外（太早）', topic: '', see: '' },
    { at: T1 + 1000, say: '窗口内 1', topic: 'coding', see: 'coding' },
    { at: T2 + 1000, say: '窗口外（太晚）', topic: '', see: '' },
    { at: T2 - 1000, say: '窗口内 2', topic: 'reading', see: 'reading' },
  ]
  const chats = [
    { role: 'user', content: '旧对话没有时间戳', },
    { role: 'user', content: '有时间戳但在窗口外', at: T1 - 5000 },
    { role: 'assistant', content: '窗口内回答', at: T1 + 2000 },
    { role: 'user', content: '窗口内提问', at: T1 + 3000 },
  ]
  const videos = [
    { at: T1 - 5000, title: '窗口外视频', up: '', one: '' },
    { at: T1 + 5000, title: '窗口内视频', up: 'UP主', one: '还行' },
  ]
  const m = collect.collectMaterial({ says, chats, videos, since, until })
  ok('嘀咕只留窗口内 2 条', m.says.length === 2, m.says.map((x) => x.say))
  ok('嘀咕按时间升序', m.says[0].say === '窗口内 1')
  ok('没时间戳的对话被跳过', !m.chats.some((c) => c.content.includes('旧对话')))
  ok('窗口外对话被跳过', !m.chats.some((c) => c.content.includes('窗口外')))
  ok('窗口内对话保留 2 条', m.chats.length === 2)
  ok('视频只剩 1 条', m.videos.length === 1 && m.videos[0].title === '窗口内视频')
  ok('count 是三者之和', m.count === 5, m.count)
  ok('非空判定', collect.isEmpty(m) === false)
  ok('全空判定', collect.isEmpty(collect.collectMaterial({ since, until })) === true)
  ok('垃圾输入不炸', collect.collectMaterial({ says: [null, 1, 'x'] }).count === 0)
  // 上限
  const many = new Array(80).fill(0).map((_, i) => ({ at: since + i, say: 's' + i }))
  ok('嘀咕上限 40（留最新的）', collect.collectMaterial({ says: many, since, until }).says.length === collect.MAX_SAYS)
  const manyChats = new Array(100).fill(0).map((_, i) => ({ at: since + i, role: i % 2 ? 'assistant' : 'user', content: 'c' + i }))
  ok('对话上限 60', collect.collectMaterial({ chats: manyChats, since, until }).chats.length === collect.MAX_CHATS)
}

/* ───── ⑤.5 嘀咕去重 + 同类合并（真机踩过：同一句关心话进 8 段）───── */
console.log('【5.5】collect.dedupeSays / groupSays')
{
  const base = [
    { at: T1, say: '记得保存好再关，别丢。', see: 'coding', topic: 'a' },
    { at: T1 + 60000, say: '记得保存好再关别丢', see: 'coding', topic: 'b' },
    { at: T1 + 120000, say: '记得保存好再关，别丢！', see: 'reading', topic: 'c' },
  ]
  const d = collect.dedupeSays(base)
  ok('去标点后相同 → 合成 1 条', d.length === 1, d)
  ok('合并后记了次数 3', d[0].repeat === 3, d[0])
  ok('保留第一句原文和它自己的画面', d[0].say === base[0].say && d[0].see === 'coding')

  const near = collect.dedupeSays([
    { at: T1, say: '主人是不是又在折腾那个记忆库的事情啊？', see: 'coding' },
    { at: T1 + 1000, say: '主人是不是又在折腾那个记忆库的破事？', see: 'coding' },
  ])
  ok('开头 10 字相同的近似句也合并', near.length === 1, near)

  const diff = collect.dedupeSays([
    { at: T1, say: '这文件夹名字也太长了，主人是不是懒得整理啊？', see: 'browsing' },
    { at: T1 + 1000, say: '这 memory.py 被改了这么多版啊，主人是不是在反复调试？', see: 'coding' },
  ])
  ok('不同的话不合并', diff.length === 2)

  const g = collect.groupSays(
    [
      { at: T1, say: 'A', see: 'coding' },
      { at: T1 + 300000, say: 'B', see: 'coding' },
      { at: T1 + 900000, say: 'C', see: 'coding' }, // 超过 20 分钟 → 另起一组
      { at: T1 + 920000, say: 'D', see: 'reading' },
    ],
    20 * 60000,
  )
  ok('同画面且间隔 20 分钟内合并成一组', g.length === 2, g.map((x) => x.items.length))
  ok('第一组把 3 条同画面的都收了', g[0].items.length === 3)
  ok('画面变了就新起一组', g[1].see === 'reading' && g[1].items.length === 1)

  // 素材文本：同画面的几条嘀咕压成一行
  const txt = collect.materialText({
    since: T1,
    until: T1 + 900000,
    says: [
      { at: T1 + 1000, say: '甲甲甲甲甲甲', see: 'coding', topic: 'x', repeat: 1 },
      { at: T1 + 2000, say: '乙乙乙乙乙乙', see: 'coding', topic: 'y', repeat: 1 },
      { at: T1 + 3000, say: '丙丙丙丙丙丙', see: 'coding', topic: 'z', repeat: 3 },
    ],
    chats: [],
    videos: [],
    count: 3,
  })
  ok('同画面合并成一行', txt.split('\n').length === 2, txt)
  ok('合并行标明次数', txt.includes('你自己嘀咕过 3 次'))
  ok('重复的那句带「又说了」', txt.includes('这句又说了 2 次'))
}

/* ───── ⑥ 素材文本 ───── */
console.log('【6】collect.materialText')
{
  const m = {
    since: T1,
    until: T1 + 33 * 60000,
    says: [{ at: T1 + 60000, say: '白饭呢', topic: 'coding', see: 'coding' }],
    chats: [{ at: T1 + 120000, role: 'user', content: '在忙' }, { at: T1 + 130000, role: 'assistant', content: '哦' }],
    videos: [{ at: T1 + 180000, title: '一个视频', up: 'UP', one: '挺好看' }],
    count: 4,
  }
  const t = collect.materialText(m)
  ok('带时间跨度', /33 分钟/.test(t), t.slice(0, 60))
  ok('带嘀咕', t.includes('你自己嘀咕过'))
  ok('带主人对话', t.includes('主人：「在忙」'))
  ok('带自己的回答', t.includes('你：「哦」'))
  ok('带视频', t.includes('刷了视频《一个视频》'))
  ok('空素材 → 空串', collect.materialText(collect.collectMaterial({ since: T1, until: T2 })) === '')
  ok('trimChats 按 token 裁且不炸', Array.isArray(collect.trimChats([], 100)))
  const long = new Array(40).fill(0).map((_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '很长的话'.repeat(40) }))
  ok('trimChats 会裁掉一些', collect.trimChats(long, 500).length < long.length)
  ok('estimateTokens 中文≈字数', collect.estimateTokens('一二三四五') >= 5)
}

/* ───── ⑦ shouldRun：冷却 / forceOnce 的一次性 ───── */
console.log('【7】shouldRun（forceOnce 语义）')
{
  const base = { enabled: true, running: false, materialCount: 3, forceOnce: false, now: T2, lastDreamAt: T2 - 60000, cooldownSec: 1800 }
  ok('关着 → disabled', shouldRun(Object.assign({}, base, { enabled: false })).reason === 'disabled')
  ok('正在跑 → running', shouldRun(Object.assign({}, base, { running: true })).reason === 'running')
  ok('没素材 → no-material', shouldRun(Object.assign({}, base, { materialCount: 0 })).reason === 'no-material')
  const cd = shouldRun(base)
  ok('冷却中 → 拦下', cd.run === false && cd.reason === 'cooldown')
  ok('冷却剩余秒数合理', cd.retryInSec > 1700 && cd.retryInSec <= 1800, cd.retryInSec)
  ok('冷却中 + force → 放行', shouldRun(Object.assign({}, base, { forceOnce: true })).run === true)
  ok('放行时要求消费 force', shouldRun(Object.assign({}, base, { forceOnce: true })).consumeForce === true)
  ok('冷却已过 → 正常放行', shouldRun(Object.assign({}, base, { lastDreamAt: T2 - 2000000 })).run === true)
  ok('正常放行不消费 force', shouldRun(Object.assign({}, base, { lastDreamAt: T2 - 2000000 })).consumeForce === false)
  ok('没素材时 force 也不跑（也不消费）', shouldRun(Object.assign({}, base, { forceOnce: true, materialCount: 0 })).run === false)
  ok('冷却为 0 → 不拦', shouldRun(Object.assign({}, base, { cooldownSec: 0 })).run === true)
  ok('从没做过梦 → 不拦', shouldRun(Object.assign({}, base, { lastDreamAt: 0 })).run === true)
}

/* ───── ⑧ forceOnce 的「按多次只生效一次」（走真实 createDream）───── */
console.log('【8】createDream.forceNext 一次性')
{
  const calls = []
  const d = dreamIndex.createDream({
    dirDefault: path.join(os.tmpdir(), 'dshp-dream-test-nowrite'),
    stateFile: '',
    getCfg: () => ({ enabled: true, cooldownSec: 1800, dir: '' }),
    getSays: () => [{ at: Date.now(), say: '刚说过话' }],
    getChat: () => [],
    getBili: () => [],
    chat: async () => {
      calls.push(1)
      return { ok: true, text: '{"worth":false,"head":"","paras":[]}' }
    },
    log: () => {},
  })
  ok('默认未就绪', d.forceNext() === false)
  d.forceNext(true)
  d.forceNext(true) // 多按
  ok('按多次仍是布尔 true（不叠加）', d.forceNext() === true)
  // 第一次：force 生效 → 发了请求；第二/三次：冷却生效 → 不再发
  await d.noteSleep(Date.now())
  await d.noteSleep(Date.now())
  await d.noteSleep(Date.now())
  ok('force 只放行一次（3 次只发 1 次请求）', calls.length === 1, calls.length)
  ok('force 用掉后自动清掉', d.forceNext() === false)
  ok('status 里 forceNext=false', d.status().forceNext === false)
}

/* ───── ⑨ 日记落盘（临时目录）───── */
console.log('【9】store 落盘（临时目录）')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-diary-'))
  const a = store.appendDream(dir, T1, { head: '第一次', paras: ['第一段内容够长', '第二段内容够长'] })
  ok('第一次写入成功', a.ok === true && a.n === 1, a)
  const txt1 = fs.readFileSync(path.join(dir, '2026-10-21.md'), 'utf8')
  ok('文件头只出现一次', (txt1.match(/肥鱼日记/g) || []).length === 1)
  ok('第一段序号是 1', txt1.includes('第 1 次小睡'))
  const b = store.appendDream(dir, T2, { head: '第二次', paras: ['后来的一段内容', '再来一段内容'] })
  ok('同一天第二次 → 第 2 段', b.ok === true && b.n === 2, b)
  const txt2 = fs.readFileSync(path.join(dir, '2026-10-21.md'), 'utf8')
  ok('同一天只有一个文件', fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length === 1)
  ok('两段都在同一个文件里', txt2.includes('第 1 次小睡') && txt2.includes('第 2 次小睡'))
  ok('文件头仍然只有一个', (txt2.match(/# 2026-10-21 · 肥鱼日记/g) || []).length === 1)
  ok('todayText 取尾部（含最新那段）', store.todayText(dir, T1, 200).includes('再来一段内容'))
  ok('todayText 有最小下限（不会只喂几个字）', store.todayText(dir, T1, 10).length >= 200 - 80)
  ok('recentHeads 拿到前天的小标题', store.recentHeads(dir, T1 + DAY, 3).includes('第一次'))
  ok('countToday = 2', store.countToday(dir, T1) === 2)
  ok('空正文不写', store.appendDream(dir, T1, { paras: [] }).ok === false)
  // 换一天 → 新文件
  const c = store.appendDream(dir, T1 + DAY, { head: '新的一天', paras: ['aaaa 内容', 'bbbb 内容'] })
  ok('第二天新开文件', c.ok === true && c.n === 1 && path.basename(c.file) === '2026-10-22.md')
  ok('目录解析：配置为空用默认', store.resolveDir('', '/x/y') === '/x/y')
  ok('目录解析：配置优先', store.resolveDir('D:/diary', '/x/y') === 'D:/diary')
  ok('目录解析：配置全是空白 = 默认', store.resolveDir('   ', '/x/y') === '/x/y')
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {}
}

/* ───── ⑩ 提示词 ───── */
console.log('【10】prompt.buildMessages')
{
  const msgs = promptMod.buildMessages({
    material: '【素材】\n· 12:07 你自己嘀咕过：「白饭」',
    todayDiary: '今天已经写过的一段',
    recentHeads: ['昨天的标题'],
  })
  ok('两条消息（system + user）', msgs.length === 2)
  ok('system 是人设', msgs[0].role === 'system' && msgs[0].content.includes('大肥鱼'))
  ok('system 禁止编造', /不许编|只能写/.test(msgs[0].content))
  ok('user 带素材', msgs[1].content.includes('白饭'))
  ok('user 带今天的日记', msgs[1].content.includes('今天已经写过的一段'))
  ok('user 带旧标题', msgs[1].content.includes('昨天的标题'))
  ok('末尾有硬要求', /必须给出 worth/.test(msgs[1].content))
  ok('schema 三个字段都在 required', promptMod.SCHEMA.required.includes('worth') && promptMod.SCHEMA.required.includes('head') && promptMod.SCHEMA.required.includes('paras'))
  ok('schema 禁止额外字段', promptMod.SCHEMA.additionalProperties === false)
  ok('schema 里 worth 是 boolean', promptMod.SCHEMA.properties.worth.type === 'boolean')
}

/* ───── ⑪ 配置链（加设置项要过五道关）───── */
console.log('【11】config / sanitize 的 dream')
{
  const d = normalize({}).dream
  ok('默认关闭', d.enabled === false)
  ok('默认冷却 30 分钟', d.cooldownSec === 1800)
  ok('默认目录为空（= 用默认路径）', d.dir === '')
  ok('冷却夹到最小 5 分钟', normalize({ dream: { cooldownSec: 1 } }).dream.cooldownSec === 300)
  ok('冷却夹到最大 3 小时', normalize({ dream: { cooldownSec: 99999 } }).dream.cooldownSec === 10800)
  ok('冷却取整', normalize({ dream: { cooldownSec: '1800.7' } }).dream.cooldownSec === 1801)
  ok('enabled 只认布尔', normalize({ dream: { enabled: 'yes' } }).dream.enabled === false)
  ok('enabled=true 放行', normalize({ dream: { enabled: true } }).dream.enabled === true)
  ok('目录去空白', normalize({ dream: { dir: '  D:/a  ' } }).dream.dir === 'D:/a')
  ok('目录夹长度', normalize({ dream: { dir: 'x'.repeat(999) } }).dream.dir.length === 300)

  const p = sanitizeHeartPatch({ dream: { enabled: true, cooldownSec: 900, dir: 'D:/日记' } })
  ok('白名单放行三个字段', p.dream && p.dream.enabled === true && p.dream.cooldownSec === 900 && p.dream.dir === 'D:/日记')
  ok('空串目录是合法值（重置默认）', sanitizeHeartPatch({ dream: { dir: '' } }).dream.dir === '')
  ok('非数字冷却被忽略', !sanitizeHeartPatch({ dream: { cooldownSec: 'abc' } }).dream)
  ok('多余字段被丢掉', !sanitizeHeartPatch({ dream: { hack: 1 } }).dream)
  ok('DEFAULTS 里有 dream', !!DEFAULTS.dream)
}

/* ───── ⑫ 端到端（假模型）：真写文件、同一天追加第 2 段 ───── */
console.log('【12】createDream 端到端（假模型）')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-dream-e2e-'))
  let n = 0
  // 用可控时钟：窗口是「上次入睡 → 这次入睡」，用真实 Date.now() 会随两次调用的间隔漂移
  let clock = T1
  const d = dreamIndex.createDream({
    dirDefault: dir,
    stateFile: '',
    now: () => clock,
    getCfg: () => ({ enabled: true, cooldownSec: 300, dir: '' }),
    // 素材时间必须**早于**入睡时刻（真实场景就是：她先嘀咕，再睡着）
    getSays: () => [{ at: clock - 30000, say: '白饭呢', topic: 'coding', see: 'coding' }],
    getChat: () => [{ role: 'user', content: '在忙', at: clock - 20000 }],
    getBili: () => [],
    chat: async () => {
      n++
      return {
        ok: true,
        text: JSON.stringify({ worth: true, head: '第' + n + '次', paras: ['第一段内容够长吧', '第二段内容够长吧'] }),
      }
    },
    log: () => {},
  })
  const r1 = await d.noteSleep(clock)
  ok('第一次真写了文件', r1.ok === true && r1.wrote === true && r1.n === 1, r1)
  ok('文件按日期命名', /^\d{4}-\d{2}-\d{2}\.md$/.test(path.basename(r1.file || '')), r1.file)
  const txt1 = fs.readFileSync(r1.file, 'utf8')
  ok('文件里有文件头', txt1.includes('肥鱼日记'))
  ok('文件里有小标题', txt1.includes('**第1次**'))
  ok('文件里有正文', txt1.includes('第一段内容够长吧'))
  // 冷却中：不该再写（也没发请求）
  const before = n
  clock = T1 + 60000
  const r2 = await d.noteSleep(clock)
  ok('冷却中第二次被拦下', r2.ok === false && r2.reason === 'cooldown', r2)
  ok('冷却中确实没发请求', n === before)
  // 用一次性开关再写一次 → 同一天第 2 段
  clock = T1 + 120000
  d.forceNext(true)
  const r3 = await d.noteSleep(clock)
  ok('force 后又写了一次', r3.ok === true && r3.wrote === true && r3.n === 2, r3)
  const txt2 = fs.readFileSync(r3.file, 'utf8')
  ok('同一天仍在同一个文件', r3.file === r1.file)
  ok('第 2 段编号正确', txt2.includes('第 2 次小睡'))
  ok('status 反映今天 2 段', d.status().todayCount === 2, d.status().todayCount)
  ok('status 报 lastResult=written', d.status().lastResult === 'written')
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {}
}

/* ───── ⑬ 「这一觉的入睡时间」不能污染窗口起点（回归）───── */
console.log('【13】窗口起点回归：没有 lastWakeAt 时不能取到空窗口')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-dream-win-'))
  const seen = []
  let clock = T1
  const d = dreamIndex.createDream({
    dirDefault: dir,
    stateFile: '',
    now: () => clock,
    getCfg: () => ({ enabled: true, cooldownSec: 0, dir: '' }),
    getSays: () => [{ at: clock - 600000, say: '半小时前嘀咕的', topic: 'coding', see: 'coding' }],
    getChat: () => [],
    getBili: () => [],
    chat: async (messages) => {
      seen.push(messages[1].content)
      return { ok: true, text: JSON.stringify({ worth: false, head: '', paras: [] }) }
    },
    log: () => {},
  })
  // 从没有过 wake 记录（页面刚刷新过的那种情形）
  const r = await d.noteSleep(clock)
  ok('没有唤醒记录也能取到素材', r.reason !== 'no-material', r)
  ok('素材确实进了提示词', seen.length === 1 && seen[0].includes('半小时前嘀咕的'), seen.length)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {}
}

console.log('\n—'.repeat(20))
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项：')
  for (const f of fails) console.log('  ✗ ' + f)
  console.log('\n合计 ' + pass + ' 通过 / ' + fails.length + ' 失败')
  process.exit(1)
} else {
  console.log('全部通过：' + pass + ' 项')
}
