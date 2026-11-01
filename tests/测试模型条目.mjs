// 「模型条目系统」的纯函数测试（不联网、不调模型、不起窗口）
//   node _research-data/测试模型条目.mjs
//
// 锁的就是那些「拍脑袋想不出来、只能靠断言」的性质：
//   ① 板块互斥：roles[role] 是单值 —— 一个板块只能挂一个条目，勾到 B 自动从 A 摘除；
//   ② 迁移幂等且可退出：settings.json 里 models 键**不存在**才从旧字段派生；
//      键存在（哪怕空数组）就完全信任 —— 否则面板里删掉的条目会「复活」；
//   ③ 密钥永不回流页面：payload 只给 apiKeySet，保存时 undefined/null 回填旧值、'' 清空；
//   ④ 悬空引用自动摘除：删条目后它负责的板块回到未分配（回落 heart.model），不留死链；
//   ⑤ 200k 窗口的保险丝：isContextOverflow 的措辞匹配（新措辞往 RE_OVERFLOW 里加）。
import cfgMod from '../shell/src/heart/config.js'
import settingsMod from '../shell/src/heart/settings.js'
import vision from '../shell/src/heart/vision.js'
import ttsMod from '../shell/src/tts/index.js'

let pass = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) pass++
  else fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 200) : ''))
}

const { normalize, DEFAULTS, ROLES, normalizeModels, normalizeRoles, deriveModels, assignRole, rolesOfEntry } = cfgMod
const { sanitizeHeartPatch, carryOverEntryKeys } = settingsMod

console.log('【1】normalizeModels：白名单 / id / 没端点的条目直接丢')
{
  const ms = normalizeModels([
    { id: 'a', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'sk-test', timeoutMs: 99999, enableThinking: true, junk: 'x' },
    { name: '', baseUrl: 'http://127.0.0.1:8080/v1' },
    { id: 'c' }, // 没 baseUrl → 丢
    '不是对象',
    null,
  ])
  ok('2 条进来 2 条出（没端点的丢）', ms.length === 2, ms)
  ok('白名单字段都在、junk 没了', ms[0].id === 'a' && ms[0].name === 'DeepSeek' && ms[0].model === 'deepseek-flash' && !('junk' in ms[0]))
  ok('apiKey 原样保留（落盘需要）', ms[0].apiKey === 'sk-test')
  ok('timeoutMs 区间内保留、越界夹回 120000', ms[0].timeoutMs === 99999 && normalizeModels([{ id: 'a', baseUrl: 'http://a', timeoutMs: 999999 }])[0].timeoutMs === 120000)
  ok('enableThinking 布尔化', ms[0].enableThinking === true)
  ok('缺 id 自动补（按序号 m2）', ms[1].id === 'm2' && ms[1].name === '模型 2')
  ok('id 撞车补确定性后缀', normalizeModels([{ id: 'x', baseUrl: 'http://a' }, { id: 'x', baseUrl: 'http://b' }])[1].id === 'x-2')
  ok('超 8 条截断', normalizeModels(Array.from({ length: 12 }, (_, i) => ({ id: 'n' + i, baseUrl: 'http://h' + i }))).length === 8)
}

console.log('【2】normalizeRoles：一板块一模型，悬空自动摘除')
{
  const models = [{ id: 'm1', baseUrl: 'http://a' }, { id: 'm2', baseUrl: 'http://b' }]
  const r = normalizeRoles({ see: 'm1', chat: 'm1', dream: 'm2', translate: 'free', answer: 'ghost', bili: 42, tts: 'm1', junk: 'm1' }, models)
  ok('有效引用保留', r.see === 'm1' && r.chat === 'm1' && r.dream === 'm2' && r.tts === 'm1')
  ok('translate 允许 free', r.translate === 'free')
  ok('悬空 id / 非字符串 → 未分配', r.answer === '' && r.bili === '')
  ok('板块清单固定 7 个，没多没少', Object.keys(r).length === 7 && ROLES.join(',') === 'see,answer,dream,chat,bili,tts,translate')
  // 互斥是结构性的：单值映射，一个板块只有一个值 —— 换绑即摘除，别的板块不受牵连
  ok('互斥由单值结构保证（换绑只动本板块）', (() => { const x = assignRole(r, 'see', 'm2'); return x.see === 'm2' && x.chat === 'm1' && x.dream === 'm2' && x.tts === 'm1' })())
}

console.log('【3】assignRole / rolesOfEntry：分配器纯函数')
{
  let r = {}
  r = assignRole(r, 'see', 'm1')
  r = assignRole(r, 'answer', 'm1')
  r = assignRole(r, 'dream', 'm2')
  ok('分配生效', r.see === 'm1' && r.answer === 'm1' && r.dream === 'm2')
  r = assignRole(r, 'see', 'm2') // 勾到 B = 自动从 A 摘除（单值覆盖）
  ok('换绑自动摘除', r.see === 'm2' && rolesOfEntry(r, 'm1').join(',') === 'answer')
  r = assignRole(r, 'see', '')
  ok("'' = 取消分配", r.see === '' && rolesOfEntry(r, 'm2').join(',') === 'dream')
  r = assignRole(r, 'translate', 'free')
  ok("translate 可以 'free'", r.translate === 'free')
  ok("其它板块塞 'free' 被当普通字符串挡掉（normalize 兜底）", assignRole({}, 'see', 'free').see === 'free' && normalizeRoles(assignRole({}, 'see', 'free'), [{ id: 'm1', baseUrl: 'http://a' }]).see === '')
  ok('非法板块名不动', assignRole({ see: 'm1' }, 'hack', 'm1').hack === undefined && assignRole({ see: 'm1' }, 'hack', 'm1').see === 'm1')
  ok('不 mutate 原对象', (() => { const orig = { see: 'm1' }; assignRole(orig, 'see', 'm2'); return orig.see === 'm1' })())
  ok('rolesOfEntry 反查', rolesOfEntry({ see: 'm1', chat: 'm1', dream: 'm2' }, 'm1').join(',') === 'see,chat')
}

console.log('【4】deriveModels：旧字段 → 条目（幂等派生，不落盘）')
{
  const legacy = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'sk-legacy', timeoutMs: 20000, enableThinking: false }
  const d = deriveModels(legacy, { engine: 'free', api: {} })
  ok('默认模型条目接走全部 LLM 板块', d.models.length === 1 && d.models[0].id === 'm1' &&
    ['see', 'answer', 'dream', 'chat', 'bili'].every((r) => d.roles[r] === 'm1'))
  ok('tts 不迁移（P3 做声音细节折叠区）', d.roles.tts === '')
  ok('translate free 档 → free', d.roles.translate === 'free')

  const dApi = deriveModels(legacy, { engine: 'api', api: { baseUrl: 'http://127.0.0.1:9911/v1', model: 'qwen', apiKey: 'sk-t' } })
  ok('api 档另起「翻译专用」条目', dApi.models.length === 2 && dApi.models[1].id === 'translate' && dApi.models[1].name === '翻译专用' && dApi.roles.translate === 'translate')

  const dLocal = deriveModels(legacy, { engine: 'local', api: {} })
  ok('local 档归默认模型（同一端点，行为等价）', dLocal.models.length === 1 && dLocal.roles.translate === 'm1')

  const dNone = deriveModels({ baseUrl: '' }, {})
  ok('没配端点 → 不生成条目，板块全空（回落旧路径）', dNone.models.length === 0 && Object.values(dNone.roles).every((v) => v === ''))
}

console.log('【5】normalize 迁移开关：models 键不存在才派生（键存在就完全信任）')
{
  const legacy = {
    model: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'sk-legacy' },
    tools: { translate: { engine: 'free' } },
  }
  // 没写 models 键 → 派生
  const a = normalize(legacy)
  ok('键不存在 → 派生出 1 条', a.models.length === 1 && a.models[0].name === '默认模型')
  ok('派生的 roles 接走 LLM 板块', a.roles.see === 'm1' && a.roles.chat === 'm1')
  // 明确的空数组 = 面板已接管（用户可能故意清空）→ 绝不复活
  const b = normalize(Object.assign({}, legacy, { models: [] }))
  ok('键存在（空数组）→ 完全信任，不复活', b.models.length === 0 && Object.values(b.roles).every((v) => v === ''))
  // 显式条目 → 原样白名单化
  const c = normalize(Object.assign({}, legacy, {
    models: [{ id: 'z9', name: '九B', baseUrl: 'http://127.0.0.1:8080/v1', model: 'qwen' }],
    roles: { see: 'z9', dream: 'z9' },
  }))
  ok('显式条目被信任', c.models.length === 1 && c.models[0].id === 'z9' && c.roles.see === 'z9' && c.roles.dream === 'z9')
  ok('没勾的板块 = 未分配（回落 heart.model；translate 未勾 = 走旧引擎逻辑）', c.roles.chat === '' && c.roles.translate === '')
  // 幂等：normalize(normalize 的输出) 不变形
  const twice = normalize(JSON.parse(JSON.stringify(a)))
  ok('幂等：派生结果再 normalize 不变形', JSON.stringify(twice.models) === JSON.stringify(a.models) && JSON.stringify(twice.roles) === JSON.stringify(a.roles))
}

console.log('【6】entryCandidate / resolveRole：板块 → 端点候选')
{
  ok('没 baseUrl → null（回落旧路径）', vision.entryCandidate({ id: 'x', model: 'm' }) === null)
  const c = vision.entryCandidate({ id: 'e1', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'sk', timeoutMs: 5000, enableThinking: true })
  ok('baseUrl 规整（补 /v1）', c.baseUrl === 'https://api.deepseek.com/v1')
  ok('source 带条目 id', c.source === 'entry:e1')
  ok('条目级 timeout/思考透传', c.timeoutMs === 5000 && c.enableThinking === true)

  const cfg = normalize({
    models: [{ id: 'e1', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }],
    roles: { see: 'e1', chat: '', translate: 'free' },
  })
  ok('分配的板块 → 候选', (() => { const x = vision.resolveRole(cfg, 'see'); return x && x.baseUrl === 'https://api.deepseek.com/v1' && x.model === 'deepseek-flash' })())
  ok("未分配 / 'free' → null（走旧路径）", vision.resolveRole(cfg, 'chat') === null && vision.resolveRole(cfg, 'translate') === null)
  ok('悬空引用 → null（normalize 本不该产生，兜底）', vision.resolveRole(Object.assign({}, cfg, { roles: { see: 'ghost' } }), 'see') === null)
}

console.log('【7】isContextOverflow：200k 窗口的保险丝')
{
  ok('OpenAI 措辞', vision.isContextOverflow(400, 'http 400 {"error":{"message":"This model\'s maximum context length is 131072 tokens"}}'))
  ok('llama.cpp 措辞', vision.isContextOverflow(400, 'http 400 the request exceeds the available context size (context length 8192)'))
  ok('context_length_exceeded 代号', vision.isContextOverflow(400, 'context_length_exceeded'))
  ok('reduce the length 措辞', vision.isContextOverflow(400, 'please reduce the length of the messages'))
  ok('200/500 不算', !vision.isContextOverflow(200, 'maximum context length') && !vision.isContextOverflow(500, 'maximum context length'))
  ok('其它 400（如 response_format 拒绝）不算', !vision.isContextOverflow(400, 'This response_format type is unavailable now'))
  ok('空串/非字符串不炸', vision.isContextOverflow(400, '') === false && vision.isContextOverflow(null, null) === false)
}

console.log('【8】窗口预算：默认 200000（博士拍板）+ 归一化夹取')
{
  ok('DEFAULTS.context.windowTokens = 200000', DEFAULTS.context.windowTokens === 200000)
  ok('越界夹回上限', normalize({ context: { windowTokens: 999999 } }).context.windowTokens === 200000)
  ok('越界夹回下限', normalize({ context: { windowTokens: 1 } }).context.windowTokens === 512)
  ok('非法回落默认', normalize({ context: { windowTokens: 'abc' } }).context.windowTokens === 200000)
  ok('老用户的 2048 原样保留', normalize({ context: { windowTokens: 2048 } }).context.windowTokens === 2048)
}

console.log('【9】sanitizeHeartPatch：models / roles 白名单（漏字段 = 保存成功但值不变）')
{
  const p = sanitizeHeartPatch({
    models: [
      { id: 'e1', name: 'DS', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'sk-new', timeoutMs: 5000, enableThinking: true, junk: 1 },
      { id: 'e2', baseUrl: 'http://127.0.0.1:8080/v1' }, // 没 apiKey 字段 = 页面没碰它（回填旧值）
      null,
    ],
    roles: { see: 'e1', dream: 'ghost', translate: 'free', junk: 'x' },
    context: { enabled: false, windowTokens: 4096 },
  })
  ok('models 数组放行且白名单化', Array.isArray(p.models) && p.models.length === 2)
  ok('条目字段白名单', p.models[0].id === 'e1' && p.models[0].apiKey === 'sk-new' && !('junk' in p.models[0]))
  ok('roles 只认 7 个板块', p.roles.see === 'e1' && p.roles.dream === 'ghost' && p.roles.translate === 'free' && !('junk' in p.roles))
  ok('context 照旧放行', p.context.windowTokens === 4096 && p.context.enabled === false)
  ok('models 不是数组 → 整个丢弃', sanitizeHeartPatch({ models: 'hack' }).models === undefined)
  ok('roles 是数组 → 丢弃', sanitizeHeartPatch({ roles: ['x'] }).roles === undefined)
  ok('空 patch 不炸', Object.keys(sanitizeHeartPatch({})).length === 0)
}

console.log('【10】carryOverEntryKeys：密钥不因「页面看不见它」而被洗掉')
{
  const prev = [{ id: 'e1', name: 'DS', apiKey: 'sk-keep' }, { id: 'e2', apiKey: '' }]
  ok('undefined → 回填旧值', carryOverEntryKeys(prev, [{ id: 'e1', name: 'DS 改名' }])[0].apiKey === 'sk-keep')
  ok('null → 回填旧值', carryOverEntryKeys(prev, [{ id: 'e1', apiKey: null }])[0].apiKey === 'sk-keep')
  ok("'' → 明确清空，不回填", carryOverEntryKeys(prev, [{ id: 'e1', apiKey: '' }])[0].apiKey === '')
  ok('非空字符串 → 尊重页面（改密钥）', carryOverEntryKeys(prev, [{ id: 'e1', apiKey: 'sk-new' }])[0].apiKey === 'sk-new')
  ok('旧条目本来就没密钥 → 原样', carryOverEntryKeys(prev, [{ id: 'e2' }])[0].apiKey === undefined)
  ok('新条目（prev 里没有 id）→ 原样不炸', carryOverEntryKeys(prev, [{ id: 'e9', baseUrl: 'http://x' }])[0].apiKey === undefined)
  ok('prev 空 / 非数组 → 全部原样', carryOverEntryKeys(null, [{ id: 'e1' }])[0].apiKey === undefined)
  ok('不 mutate 输入', (() => { const inp = [{ id: 'e1' }]; carryOverEntryKeys(prev, inp); return inp[0].apiKey === undefined })())
}

console.log('【11】声音跟条目走：entry.tts 白名单 + resolveTtsTarget（2026-11-01 P3）')
{
  const { resolveTtsTarget } = ttsMod
  const globalTts = {
    enabled: true, backend: 'gptsovits', baseUrl: 'http://127.0.0.1:9880', apiKey: '',
    voice: '', refAudioPath: 'D:\\global-ref.wav', promptText: '全局转写', speed: 1, maxChars: 120,
    timeoutMs: 30000, sources: { chat: true, heart: true, bili: false, work: false },
  }
  // 没分配 → 原样返回（与 v2.1 一致）
  const noRole = { tts: globalTts, models: [{ id: 'e1', baseUrl: 'http://x' }], roles: { tts: '' } }
  ok('未分配 → 原样返回 heart.tts', resolveTtsTarget(noRole) === noRole.tts)

  // 分配到条目：端点跟条目，细节优先条目、缺的回落全局
  const withEntry = {
    tts: globalTts,
    models: [{ id: 'e1', baseUrl: 'http://127.0.0.1:9884', apiKey: 'sk-e', tts: { backend: 'gsvlite', refAudioPath: 'D:\\entry-ref.wav', speed: 1.3 } }],
    roles: { tts: 'e1' },
  }
  const eff = resolveTtsTarget(withEntry)
  ok('端点/密钥用条目的', eff.baseUrl === 'http://127.0.0.1:9884' && eff.apiKey === 'sk-e')
  ok('条目细节优先', eff.backend === 'gsvlite' && eff.refAudioPath === 'D:\\entry-ref.wav' && eff.speed === 1.3)
  ok('条目没填的回落全局', eff.promptText === '全局转写' && eff.maxChars === 120 && eff.timeoutMs === 30000)
  ok('enabled/sources 永远全局', eff.enabled === true && eff.sources.chat === true)

  // 条目没带 tts 对象 → 端点换、细节全回落
  const bare = resolveTtsTarget({ tts: globalTts, models: [{ id: 'e2', baseUrl: 'http://y' }], roles: { tts: 'e2' } })
  ok('条目无声音细节 → 细节全回落全局、端点换条目', bare.baseUrl === 'http://y' && bare.backend === 'gptsovits' && bare.refAudioPath === 'D:\\global-ref.wav')

  // 悬空引用 → 原样（normalize 本不该产生）
  const dangling = resolveTtsTarget({ tts: globalTts, models: [], roles: { tts: 'ghost' } })
  ok('悬空引用 → 原样返回', dangling === globalTts)

  // 归一化/白名单两侧都要收 entry.tts
  const nm = cfgMod.normalizeModels([{ id: 'e1', baseUrl: 'http://x', tts: { backend: 'gsvlite', voice: 'lx', speed: 1.2, junk: 1 } }])
  ok('normalizeModels 收 tts 白名单、丢 junk', nm[0].tts && nm[0].tts.backend === 'gsvlite' && nm[0].tts.voice === 'lx' && nm[0].tts.speed === 1.2 && !('junk' in nm[0].tts))
  ok('tts 空对象 → 不带 tts 字段', cfgMod.normalizeModels([{ id: 'e1', baseUrl: 'http://x', tts: {} }])[0].tts === undefined)
  const sp = sanitizeHeartPatch({ models: [{ id: 'e1', baseUrl: 'http://x', tts: { backend: 'openai', maxChars: 200 } }] })
  ok('sanitize 放行 models[].tts 白名单', sp.models[0].tts && sp.models[0].tts.backend === 'openai' && sp.models[0].tts.maxChars === 200)
}

console.log('\n——— 结果：' + pass + ' 通过 / ' + fails.length + ' 失败 ———')
if (fails.length) {
  fails.forEach((f) => console.log('  ✗ ' + f))
  process.exit(1)
}
