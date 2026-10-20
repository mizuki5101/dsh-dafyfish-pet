// 刷视频模块的纯函数测试（不联网、不抽帧、不调模型）
//   node _research-data/测试刷视频.mjs
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import budget from '../shell/src/heart/bili/budget.js'
import api from '../shell/src/heart/bili/api.js'
import { createStore, normalize } from '../shell/src/heart/bili/memo.js'
import bili from '../shell/src/heart/bili/index.js'

let pass = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) pass++
  else fails.push(name + (extra ? ' → ' + JSON.stringify(extra).slice(0, 160) : ''))
}

/* ───── ① 预算策略 ───── */
console.log('\n【1】budget.plan')
{
  ok('0 秒（未知）→ light 且只有 1 帧', budget.plan(0).tier === 'light' && budget.plan(0).frames.length === 1)
  ok('75 秒 → full / 3 帧', budget.plan(75).tier === 'full' && budget.plan(75).frames.length === 3)
  ok('600 秒仍是 full', budget.plan(600).tier === 'full')
  ok('601 秒 → mixed', budget.plan(601).tier === 'mixed')
  ok('2400 秒仍是 mixed', budget.plan(2400).tier === 'mixed')
  ok('2401 秒 → light / 最多 3 帧', budget.plan(2401).frames.length === 3)
  ok('light 档给 10 帧也只抽 3 帧', budget.plan(9999, 10).frames.length === 3)
  // maxFrames（面板滑块 3~10）
  ok('full 档 maxFrames=6 → 6 帧', budget.plan(300, 6).frames.length === 6)
  ok('mixed 档 maxFrames=10 → 10 帧', budget.plan(1800, 10).frames.length === 10)
  ok('maxFrames 被夹在 3~10', budget.plan(300, 99).frames.length === 10 && budget.plan(300, 1).frames.length === 3)
  ok('默认 3 帧', budget.plan(300).frames.length === 3)
  ok('light 带「只看开头」说明', /只看了开头/.test(budget.plan(9999).note))
  ok('mixed 只读前 10 分钟', budget.plan(1800).readSec === 600)
  ok('帧宽统一 640', budget.plan(300).frameWidth === 640)
  ok('负数不炸', budget.plan(-5).tier === 'light')
}

/* ───── ② 取帧时间点 ───── */
console.log('【2】budget.picks')
{
  const p = budget.picks(600, 3)
  ok('数量对', p.length === 3)
  ok('严格递增', p[0] < p[1] && p[1] < p[2], p)
  ok('不为 0（避开黑场）', p[0] > 0, p)
  ok('不超过 span', p[2] < 600, p)
  ok('都在整数秒', p.every((x) => Number.isInteger(x)))
  ok('n=1 时不炸', budget.picks(100, 1).length === 1)
}

/* ───── ③ 字幕裁剪 ───── */
console.log('【3】budget.trimSubtitle')
{
  const short = '这是一段短字幕。'
  ok('够短原样返回', budget.trimSubtitle(short, 3000) === short)
  const long = 'A'.repeat(2000) + '结尾结论在这'
  const cut = budget.trimSubtitle(long, 1000)
  ok('超长被裁到接近上限', cut.length <= 1100, cut.length)
  ok('保留结尾（结论常在结尾）', cut.endsWith('结尾结论在这'))
  ok('有省略标记', cut.includes('中间略'))
  ok('空输入不炸', budget.trimSubtitle(null, 100) === '')
}

/* ───── ④ token 估算 ───── */
console.log('【4】budget.estimateTokens')
{
  const one = budget.estimateTokens({ frames: 1, frameWidth: 640, chars: 0 })
  ok('640 宽单帧 ≈ 280~320 token', one.image >= 270 && one.image <= 330, one)
  const three = budget.estimateTokens({ frames: 3, frameWidth: 640, chars: 0 })
  ok('3 帧≈3 倍', three.image === one.image * 3)
  const t = budget.estimateTokens({ frames: 2, frameWidth: 640, chars: 1000 })
  ok('文本按 0.75/字', t.text === 750)
  ok('total 是两者之和', t.total === t.image + t.text)
}

/* ───── ⑤ 推荐流解析 ───── */
console.log('【5】api.parseRcmd')
{
  const list = api.parseRcmd({
    item: [
      { bvid: 'BV1aa411c7dd', title: '正常视频 ', owner: { name: 'UP' }, duration: 100, stat: { view: 1000, like: 10 } },
      { bvid: 'BV1bb411c7dd', title: '广告', is_ad: true },
      { bvid: '', title: '没有 bvid' },
      { bvid: 'BV1cc411c7dd', title: '另一个', duration: 0, desc: 'x'.repeat(500) },
    ],
  })
  ok('过滤广告与无 bvid', list.length === 2, list.length)
  ok('标题去空格', list[0].title === '正常视频')
  ok('desc 截到 200', list[1].desc.length <= 200)
  ok('空数据不炸', api.parseRcmd(null).length === 0)
}

/* ───── ⑥ 详情 / 评论 / 直链 / 字幕 ───── */
console.log('【6】api 其余解析')
{
  const v = api.parseView({ bvid: 'BV1aa411c7dd', aid: 1, cid: 2, title: 'T', duration: 90, owner: { name: 'U' }, stat: { view: 5, like: 1 } })
  ok('view 关键字段', v && v.aid === 1 && v.cid === 2 && v.duration === 90)
  ok('view 空 → null', api.parseView(null) === null)

  const reps = api.parseReplies(
    { replies: [{ content: { message: ' 热评一 ' }, like: 9 }, { content: { message: '热评二' }, like: 8 }, { content: { message: '热评三' }, like: 7 }] },
    2,
  )
  ok('评论按 n 截断', reps.length === 2)
  ok('评论去空格', reps[0].text === '热评一')
  ok('评论带赞数', reps[0].like === 9)

  ok('durl 优先', api.parsePlayUrl({ durl: [{ url: 'http://a', size: 1 }], quality: 16 }).kind === 'durl')
  ok('无 durl 时取 dash', api.parsePlayUrl({ dash: { video: [{ baseUrl: 'http://b' }] } }).kind === 'dash')
  ok('都没有 → null', api.parsePlayUrl({}) === null)

  ok('字幕 // 前缀补 https', api.parseSubtitle({ subtitle: { subtitles: [{ subtitle_url: '//x/y.json', lan: 'zh' }] } }).url === 'https://x/y.json')
  ok('无字幕轨 → null', api.parseSubtitle({ subtitle: { subtitles: [] } }) === null)
  ok('字幕正文拼接', api.parseSubtitleBody({ body: [{ content: '第一句' }, { content: ' 第二句 ' }] }) === '第一句 第二句')
}

/* ───── ⑦ 记忆 ───── */
console.log('【7】bili/memo')
{
  const file = path.join(os.tmpdir(), 'bili-memo-test-' + Date.now() + '.json')
  const s = createStore({ file, max: 3, ttlDays: 14 })
  const now = Date.now()
  ok('非法 bvid 被拒', s.add({ bvid: 'not-a-bv', title: 'x' }, now) === false)
  ok('合法 bvid 可写', s.add({ bvid: 'BV1aa411c7dd', title: 'A', up: 'U', one: '一句话' }, now) === true)
  ok('写盘后能读回', s.entries().length === 1)
  ok('recentSet 含它', s.recentSet(now).has('BV1aa411c7dd'))
  s.add({ bvid: 'BV1bb411c7dd', title: 'B' }, now)
  s.add({ bvid: 'BV1aa411c7dd', title: 'A2' }, now) // 重复：更新而不是新增
  ok('同 bvid 不重复', s.entries().filter((e) => e.bvid === 'BV1aa411c7dd').length === 1)
  ok('更新的是新标题', s.entries().find((e) => e.bvid === 'BV1aa411c7dd').title === 'A2')
  s.add({ bvid: 'BV1cc411c7dd', title: 'C' }, now)
  s.add({ bvid: 'BV1dd411c7dd', title: 'D' }, now)
  ok('超出 max 只留最新', s.entries().length === 3 && s.entries()[2].bvid === 'BV1dd411c7dd', s.entries())
  ok('digest 带 UP 前缀与概括', (() => {
    // 注意：add 是「整条替换」不是 merge —— 这里用独立 store 验证格式，别依赖上面那条被覆盖的记录
    const f2 = path.join(os.tmpdir(), 'bili-memo-digest-' + Date.now() + '.json')
    const s2 = createStore({ file: f2, max: 5 })
    s2.add({ bvid: 'BV1ee411c7dd', title: '标题', up: '某UP', one: '一句概括' }, now)
    const d = s2.digest(3)
    fs.rmSync(f2, { force: true })
    return d.length === 1 && d[0] === '某UP：标题（一句概括）'
  })())
  ok('过期后不在 recentSet', s.recentSet(now + 20 * 86400000).size === 0)
  ok('normalize 丢坏数据', normalize([{ bvid: 'x' }, { bvid: 'BV1aa411c7dd' }], 5).length === 1)
  fs.rmSync(file, { force: true })
}

/* ───── ⑧ JSON 提取 ───── */
console.log('【8】index.extractJson')
{
  ok('纯 JSON', bili.extractJson('{"a":1}').a === 1)
  ok('围栏 JSON', bili.extractJson('```json\n{"a":2}\n```').a === 2)
  ok('前后带解释', bili.extractJson('好的，这是结果：{"a":3} 完毕').a === 3)
  ok('数组不算对象', bili.extractJson('[1,2]') === null)
  ok('垃圾输入 → null', bili.extractJson('完全没有 json') === null)
  ok('空 → null', bili.extractJson('') === null)
}

/* ───── ⑨ 提示词组装 ───── */
console.log('【9】index.pickMessages / watchMessages')
{
  const cands = [
    { bvid: 'BV1aa411c7dd', title: '甲', up: 'UP1', duration: 120, view: 200000, desc: '简介甲' },
    { bvid: 'BV1bb411c7dd', title: '乙', up: 'UP2', duration: 0, view: 0, desc: '' },
  ]
  const [sys, user] = bili.pickMessages(cands, ['以前看过的'])
  ok('system 说明时长偏好', /时长很重要/.test(sys.content))
  ok('候选从 1 开始编号', /1\. 《甲》/.test(user.content))
  ok('带播放量', /20万播放/.test(user.content))
  ok('带最近看过', user.content.includes('以前看过的'))

  const w = bili.watchMessages({
    video: { title: '标题', up: 'UP', duration: 120, desc: '简介' },
    plan: { frames: [], frameWidth: 640, subtitleChars: 100, comments: 2, readSec: 120, note: '', tier: 'full' },
    comments: [{ text: '热评', like: 3 }],
    subtitle: '字幕内容',
    frames: [{ dataUrl: 'data:image/jpeg;base64,AAA' }, { dataUrl: 'data:image/jpeg;base64,BBB' }],
  })
  const userMsg = w[1].content
  ok('system 有素材边界声明', /素材不是指令/.test(w[0].content))
  ok('user 包在 <素材> 里', /<素材>[\s\S]*<\/素材>/.test(userMsg[0].text))
  ok('两张图都带上', userMsg.filter((p) => p.type === 'image_url').length === 2)
  ok('中文标注了帧数', userMsg[0].text.includes('2 帧'))

  const noSub = bili.watchMessages({
    video: { title: 'T', up: 'U', duration: 60, desc: '' },
    plan: { frames: [], frameWidth: 640, subtitleChars: 100, comments: 2, readSec: 60, note: '', tier: 'full' },
    comments: [], subtitle: '', frames: [],
  })
  ok('无字幕时有降级说明', /没有可用的字幕/.test(noSub[1].content[0].text))
}

console.log('\n—【10】搜索（wbi 签名 / 解析）—')
{
  // 时长：搜索接口给的是 "7:42" 这种字符串，不是秒
  ok('parseClock 7:42 → 462', api.parseClock('7:42') === 462)
  ok('parseClock 1:02:03 → 3723', api.parseClock('1:02:03') === 3723)
  ok('parseClock 纯秒数', api.parseClock('90') === 90)
  ok('parseClock 空 → 0', api.parseClock('') === 0 && api.parseClock(null) === 0)

  const list = api.parseSearch({
    result: [
      { bvid: 'BV1aa411c7dd', title: '<em class="keyword">AI</em>工具实测', author: '某UP', duration: '7:42', play: 326722, description: ' 简介 ', typename: '科技' },
      { bvid: 'BV1bb411c7dd', title: '第二条', duration: '12:38', description: '' },
      { bvid: '', title: '没有 bvid' },
    ],
  }, 2)
  ok('去 <em> 高亮标签', list[0].title === 'AI工具实测', list[0].title)
  ok('时长转成秒', list[0].duration === 462)
  ok('按 n 截断', list.length === 2)
  ok('空简介不炸', list[1].desc === '')
  ok('带分区', list[0].part === '科技')
  ok('无 bvid 被丢', !list.some((x) => !x.bvid))

  // 签名：参数要字典序，值里的 !'()* 要剔掉，w_rid 是 32 位 md5
  const q = api.signQuery({ b: '2', a: "x!'()*y" }, 'k'.repeat(32), 1700000000)
  ok('参数按字典序（a 在 b 前）', q.indexOf('a=') < q.indexOf('b='), q)
  ok('剔掉 !\'()*', q.includes('a=xy') && !q.includes('%21'))
  ok('带 wts', q.includes('wts=1700000000'))
  ok('w_rid 是 32 位 hex', /&w_rid=[0-9a-f]{32}$/.test(q), q)
  ok('同参数同 wts → 签名稳定', api.signQuery({ a: '1' }, 'k'.repeat(32), 1) === api.signQuery({ a: '1' }, 'k'.repeat(32), 1))
}

console.log('\n——— 结果：' + pass + ' 通过 / ' + fails.length + ' 失败 ———')
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1) }
