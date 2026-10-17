/**
 * 说话语气（@talk-tone）单测 —— 纯 Node，不需要外壳。
 *
 * 被测的是一段**纯函数**：给一句话，判它是 疑问 / 感叹 / 平常。
 * 为什么值得单独测：它决定了说话时眉毛、嘴角、歪头的幅度，
 * 而「一整段里最后一句才决定表情」这条规则很容易被后来的改动破坏
 * （比如有人把判据改成「整段里出现问号就算」，那段话前面一个问句就会让她一直抬着眉毛）。
 *
 * 用法：node _research-data/测试说话语气.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const PET = path.join(import.meta.dirname, '..', 'pet-plugin', 'assets', 'pet.js')
const src = fs.readFileSync(PET, 'utf8')
const a = src.indexOf('/* ==== @talk-tone:start ====')
const b = src.indexOf('/* ==== @talk-tone:end ====')
if (a < 0 || b < 0) throw new Error('找不到 @talk-tone 标记块')
const block = src.slice(src.lastIndexOf('\n', a) + 1, src.lastIndexOf('\n', b))
const T = new Function(block + '\n return DSHPetTalkTone;')()

let pass = 0
const fails = []
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fails.push(name + (extra ? ' —— ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' —— ' + extra : '')) }
}
const eq = (name, got, want) => ok(name, got === want, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want))

console.log('=== 1. 疑问 ===')
for (const s of ['你在吗？', '在吗?', '你在吗', '好不好嘛', '这是什么呢', '怎么了？']) {
  eq('「' + s + '」→ ask', T.classify(s), 'ask')
}

console.log('\n=== 2. 感叹 ===')
for (const s of ['好耶！', '太好了!', '好呀', '太棒了哇', '好开心～']) {
  eq('「' + s + '」→ excl', T.classify(s), 'excl')
}

console.log('\n=== 3. 平常 ===')
for (const s of ['我去看看', '这个交给我', '嗯。', '', null, undefined, '12345']) {
  eq('「' + String(s) + '」→ plain', T.classify(s), 'plain')
}

console.log('\n=== 4. 只看最后一句（这条最容易写错）===')
eq('前面有问句、最后是陈述 → plain', T.classify('你吃了吗？我吃过了。'), 'plain')
eq('最后一句是问句 → ask', T.classify('今天天气不错。你吃了吗？'), 'ask')
eq('最后一句是感叹 → excl', T.classify('我看看。哇！'), 'excl')
eq('多行也要看最后一行', T.classify('第一行。\n第二行吗'), 'ask')

console.log('\n=== 5. 尾随符号不该干扰 ===')
eq('问号后面跟着引号', T.classify('他说「你在吗？」'), 'ask')
// 舞台提示（（笑）（拍手））不该算最后一句 —— 否则「好耶！（拍手）」会被判成平常
eq('感叹号后面跟着括号', T.classify('好耶！（拍手）'), 'excl')
eq('括号里的话不算最后一句', T.lastSentence('好耶！（拍手）').tail, '好耶')
ok('stripAsides 能连剥两层', T.stripAsides('好的（笑）（拍手）') === '好的', JSON.stringify(T.stripAsides('好的（笑）（拍手）')))
// 纯问号也算疑问：这不是「猜」，是标点本身的含义（一行只有问号时，
// 「她在问」比「她在陈述」更合理）。一开始我把期望写成了 plain，是我的错。
eq('纯问号 → ask', T.classify('？？？'), 'ask')
eq('纯句号 → plain', T.classify('。。。'), 'plain')

console.log('\n=== 6. lastSentence ===')
const ls = T.lastSentence('第一句。第二句！')
eq('tail 是最后一句', ls.tail, '第二句')
eq('punct 是句末标点', ls.punct, '！')

console.log('\n=== 7. 参数表 ===')
const plain = T.params('plain'), ask = T.params('ask'), excl = T.params('excl')
const KEYS = ['open', 'amp', 'rate', 'brow', 'form', 'yaw', 'pitch']
for (const [name, v] of [['plain', plain], ['ask', ask], ['excl', excl]]) {
  ok(name + ' 七个键都齐', KEYS.every((k) => typeof v[k] === 'number' && isFinite(v[k])), JSON.stringify(v))
}
ok('疑问会抬眉毛（brow > 0）', ask.brow > 0, String(ask.brow))
ok('感叹会扬嘴角（form > 疑问）', excl.form > ask.form, excl.form + ' vs ' + ask.form)
ok('感叹嘴张得更大（open > 平常）', excl.open > plain.open, excl.open + ' vs ' + plain.open)
ok('感叹吐字更急（rate > 平常）', excl.rate > plain.rate, excl.rate + ' vs ' + plain.rate)
ok('疑问会歪头（yaw > 0）', ask.yaw > 0, String(ask.yaw))
ok('疑问抬头很少、感叹抬头更多', ask.pitch < excl.pitch, ask.pitch + ' vs ' + excl.pitch)
ok('平常档不动眉毛/嘴角（0）', plain.brow === 0 && plain.form === 0 && plain.yaw === 0 && plain.pitch === 0, JSON.stringify(plain))
ok('幅度都很小：眉毛 ≤ 0.4', Math.max(ask.brow, excl.brow) <= 0.4, String(Math.max(ask.brow, excl.brow)))
ok('幅度都很小：嘴角 ≤ 0.3', Math.max(ask.form, excl.form) <= 0.3, String(Math.max(ask.form, excl.form)))
ok('未知语气退回 plain', T.params('nonsense') === plain)
ok('三个语气都在 TONES 里', Object.keys(T.TONES).sort().join(',') === 'ask,excl,plain', Object.keys(T.TONES).join(','))

console.log('\n' + '='.repeat(44))
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项：')
  for (const f of fails) console.log('  · ' + f)
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项')
  process.exit(1)
} else {
  console.log('说话语气单测通过：' + pass + ' 项')
}