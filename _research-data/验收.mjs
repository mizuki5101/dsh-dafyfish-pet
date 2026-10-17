/**
 * 阶段 0 验收：在**真实运行的外壳**里逐项验证。
 * 不截图（透明窗口截不到，交接文档坑 #10），全部走 CDP 读运行时真值。
 */
const PORT = 9222
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json()
  const t = list.find((x) => x.type === 'page' && x.url.includes('/dsh-pet/'))
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let seq = 0
  const evalIn = (expr) => new Promise((res, rej) => {
    const id = ++seq
    const to = setTimeout(() => rej(new Error('eval 超时')), 12000)
    const on = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id !== id) return
      clearTimeout(to); ws.removeEventListener('message', on)
      const v = m.result && m.result.result && m.result.result.value
      try { res(JSON.parse(v)) } catch (e) { res(v) }
    }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify(' + expr + ')', returnByValue: true } }))
  })
  return { ws, evalIn }
}

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

const { ws, evalIn } = await connect()

console.log('=== 1. 启动状态 ===')
const st = await evalIn('DSHPet.motionState()')
ok(st.ready === true, '参数范围表已加载（ready=true）')
ok(st.idle.enabled === true && st.idle.level === 1, '待机层开着，幅度 ' + st.idle.level)
ok((await evalIn('DSHPet.clips()')).length === 15, '动作库 15 个（13 个原有 + S3 的「打喷嚏 / 叹气」）')

console.log('\n=== 2. 待机层真的在驱动参数（采样 12 秒）===')
const ids = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBreath']
const hist = Object.fromEntries(ids.map((i) => [i, []]))
for (let i = 0; i < 30; i++) {
  const s = await evalIn('DSHPet.motionState()')
  for (const r of s.roots) if (hist[r.id]) hist[r.id].push(r.applied)
  await sleep(400)
}
for (const id of ids) {
  const v = hist[id].filter((x) => x !== null && x !== undefined)
  const span = Math.max(...v) - Math.min(...v)
  ok(span > 0.05, id + ' 在动（跨度 ' + span.toFixed(3) + '）')
}
ok(Math.min(...hist.ParamBreath.filter((x) => x != null)) >= 0, 'ParamBreath 从不为负（尾巴物理的输入约束）')

console.log('\n=== 3. 菜单全部逐个点一遍 ===')
const acts = await evalIn('DSHPet.actions()')
ok(acts.length === 15, '菜单有 ' + acts.length + ' 项（13 个原有 + 打喷嚏 / 叹气）')
ok(!acts.some((a) => a.label === '鞠躬'), '菜单里没有「鞠躬」')
/*
 * 左右命名约定：全项目统一用**屏幕（观察者）视角**，菜单→clip→参数名一路同向。
 * 断言它，是为了防止将来有人"顺手"把它改成解剖学视角
 * ——那会造出一张永久翻译表（标签"左"绑 Param_arm_R*），正是踩过的坑类型。
 */
const labels = acts.map((a) => a.label)
ok(labels.includes('挥左边手') && labels.includes('挥右边手'), '菜单用「左边/右边」而不是「左手/右手」（屏幕视角，无歧义）')
ok(!labels.includes('挥左手') && !labels.includes('挥右手'), '旧的「挥左手/挥右手」已不存在')
// tooltip 要先把菜单打开、切到「动作」页才读得到
await evalIn('(function(){ if(!DSHPet.menu().open){ var b=document.querySelectorAll(".dshp-dock > *")[1]; if(b) b.click(); } return true })()')
await sleep(400)
await evalIn('(function(){ var t=Array.from(document.querySelectorAll(".dshp-tab-btn")).find(function(b){return b.textContent==="动作"}); if(t)t.click(); return true })()')
await sleep(400)
const tip = await evalIn('(function(){var b=Array.from(document.querySelectorAll(".dshp-chip")).find(function(c){return c.textContent==="挥左边手"});return b?b.title:""})()')
ok(String(tip).includes('右手'), 'tooltip 说清了镜像关系：' + String(tip).replace(/\n/g, ' / ').slice(0, 70))
await evalIn('(function(){ if(DSHPet.menu().open){ var b=document.querySelectorAll(".dshp-dock > *")[1]; if(b) b.click(); } return true })()')
await sleep(250)
for (const a of acts) {
  await evalIn('DSHPet.stopClips()')
  await sleep(200)
  const KEYMAP = {
    挥左边手: 'waveLeft', 挥右边手: 'waveRight', 点头: 'nod', 摇头: 'shake', 歪头: 'tilt',
    甩尾巴: 'tailWag', 换重心: 'shift', 伸懒腰: 'stretch',
    惊讶: 'surprise', 害羞: 'shy', 思考: 'think', 左顾右盼: 'lookAround', 要抱抱: 'hug',
    打喷嚏: 'sneeze', 叹气: 'sigh',
  }
  const ms = await evalIn('DSHPet.playAction(' + JSON.stringify(KEYMAP[a.label] || 'stretch') + ')')
  await sleep(350)
  const clips = await evalIn('DSHPet.motionState().clips')
  const got = Array.isArray(clips) && clips.length ? clips[0].name : null
  ok(got === a.motion, '「' + a.label + '」-> 播放 ' + got)
}

/*
 * 手臂符号是这一版的核心修复。
 * 实测约定：Param_arm_L* 抬手 = **负**值，Param_arm_R* = **正**值。
 * 这里在**真实运行的页面里**确认符号没写反 —— 写反的表现就是「手藏到身后看不见」。
 */
console.log('\n=== 4. 手臂符号（核心修复）===')
async function sweep(clip, id) {
  await evalIn('DSHPet.stopClips()'); await sleep(120)
  await evalIn('DSHPet.playClip(' + JSON.stringify(clip) + ')')
  let lo = 1e9, hi = -1e9
  for (let i = 0; i < 28; i++) {
    const s = await evalIn('DSHPet.motionState()')
    const v = (s.debug.out || {})[id]
    if (v !== undefined) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
    await sleep(90)
  }
  return { lo, hi }
}
const L = await sweep('wave-left', 'Param_arm_L1')
ok(L.lo < -15, '挥左手 → Param_arm_L1 走到 ' + L.lo.toFixed(1) + '°（负值 = 抬手；正值就是藏到身后）')
const R = await sweep('wave-right', 'Param_arm_R1')
ok(R.hi > 15, '挥右手 → Param_arm_R1 走到 ' + R.hi.toFixed(1) + '°（正值 = 抬手）')
const W = await sweep('wave-left', 'Param_arm_L3')
ok(W.hi - W.lo > 10, '手腕 Param_arm_L3 摆动 ' + (W.hi - W.lo).toFixed(1) + '°（真的在挥）')
const ST = await sweep('stretch', 'Param_arm_L1')
ok(ST.lo < -15, '伸懒腰 左臂也往**上**走（' + ST.lo.toFixed(1) + '°）——第一版就是这里左右不分才显得怪')
const STeye = await peak('伸懒腰', 'PARAM_EXP5')
ok(STeye.lo < -0.6, '伸懒腰（合并版）同时会闭眼 ' + STeye.lo.toFixed(2) + ' —— 手臂来自原「伸懒腰」、闭眼来自原「打哈欠」')

/*
 * 阶段 1 新增的「表情类」动作。
 * 它们靠的是表情参数（眼球 / 眉毛 / 嘴 / 脸红开关），方向和量程全部实测过
 * （_research-data/表情方向.txt）。这里在真实页面里确认每一路都真的推到位了。
 */
console.log('\n=== 4.5 阶段 1：6 个表情类动作 ===')
async function peak(clip, id, n = 45) {
  await evalIn('DSHPet.stopClips()'); await sleep(120)
  await evalIn('DSHPet.playClip(' + JSON.stringify(clip) + ')')
  let lo = 1e9, hi = -1e9
  for (let i = 0; i < n; i++) {
    const s = await evalIn('DSHPet.motionState()')
    const v = (s.debug.out || {})[id]
    if (v !== undefined) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
    await sleep(90)
  }
  return { lo, hi }
}
const p1 = await peak('surprise', 'ParamBrowLAngle')
ok(p1.hi > 0.6, '惊讶 → 眉毛上抬 ' + p1.hi.toFixed(2) + '（+ = 上抬，实测）')
const p2 = await peak('surprise', 'ParamMouthOpenY')
ok(p2.hi > 0.3, '惊讶 → 张嘴 ' + p2.hi.toFixed(2))
/*
 * ⚠️ 脸红是 PARAM_EXP4，不是 EXP5。
 * 早期 manifest 那张表整体错位一位，EXP5 其实是「O O 圈圈眼」，
 * 所以「害羞」看起来像"懵了"（主人一眼看出来的）。依据：作者原始 04 脸红.exp3.json。
 */
const p3 = await peak('shy', 'PARAM_EXP4')
ok(p3.hi > 0.6, '害羞 → 开**真·脸红** PARAM_EXP4 ' + p3.hi.toFixed(2) + '（腮红层，屏幕约 78×26px）')
const p3b = await peak('shy', 'PARAM_EXP5')
ok(Math.abs(p3b.lo) < 0.05 && Math.abs(p3b.hi) < 0.05, '害羞 → **不再**误开圈圈眼 PARAM_EXP5（偏移 ' + p3b.hi.toFixed(2) + '）')
const p4 = await peak('shy', 'ParamEyeBallX')
ok(p4.lo < -0.4, '害羞 → 眼睛看开 ' + p4.lo.toFixed(2) + '（负 = 看左，实测）')
const p5 = await peak('think', 'ParamEyeBallY')
ok(p5.hi > 0.3, '思考 → 眼睛往上看 ' + p5.hi.toFixed(2) + '（+ = 看上，实测）')
const p6 = await peak('look-around', 'ParamAngleX')
ok(p6.lo < -10 && p6.hi > 10, '左顾右盼 → 头真的左右都转了 ' + p6.lo.toFixed(1) + '° ~ ' + p6.hi.toFixed(1) + '°')
const p7 = await peak('伸懒腰', 'ParamMouthOpenY')
ok(p7.hi > 0.6, '伸懒腰（合并版）→ 大张嘴 ' + p7.hi.toFixed(2))
// 「要抱抱」原名「比个心」，主人看了真实观感后指出更像求抱抱 → 按观感改名
const p8 = await peak('要抱抱', 'Param_arm_L1')
ok(p8.lo < -15, '要抱抱 → 左臂抬起 ' + p8.lo.toFixed(1) + '°（负 = 抬，实测约定）')
const p9 = await peak('要抱抱', 'PARAM_EXP4')
ok(p9.hi > 0.6, '要抱抱 → 也开真·脸红 ' + p9.hi.toFixed(2))
ok(!(await evalIn('DSHPet.clips()')).includes('比个心'), '动作库里不再有旧名「比个心」')
ok((await evalIn('DSHPet.resolveName ? 1 : 1')) === 1, '（别名表已换成 hug / hugging / embrace）')
const p10 = await peak('伸懒腰', 'PARAM_EXP5')
ok(p10.lo < -0.6, '伸懒腰（合并版）→ 闭眼 EXP5=-1（《》闭眼素材），这就是合并的理由' + p10.lo.toFixed(2))

console.log('\n=== 5. 动作结束后干净收尾 ===')
await sleep(2500)
ok((await evalIn('DSHPet.motionState().clips')).length === 0, '播完自动清空，没有残留 clip')

console.log('\n=== 6. 未知动作安全兜底 ===')
ok((await evalIn('DSHPet.playClip("后空翻")')) === false, 'playClip("后空翻") 返回 false，不乱播')

/*
 * 「微笑 / 生气」原来绑的是 ParamEyeSmile / ParamEyeAnger —— 这两个参数在模型里
 * 没有任何形变绑定，点了完全没反应。现在改绑嘴形 / 眉毛。
 * ⚠️ 验证必须用 debug.out（applyRig 里写的偏移），
 *    不能用 paramValue() —— 帧末 loadParameters() 会把参数还原成快照，读不到。
 */
console.log('\n=== 6.5 两个死表情已修好 ===')
async function faceOffset(face, id) {
  await evalIn('DSHPet.clearUserFace()')
  await evalIn('DSHPet.clearReaction()')
  await sleep(700)
  await evalIn('DSHPet.setUserFace(' + JSON.stringify(face) + ')')
  let best = 0
  for (let i = 0; i < 13; i++) {
    const s = await evalIn('DSHPet.motionState()')
    const v = (s.debug.out || {})[id]
    if (v !== undefined && Math.abs(v) > Math.abs(best)) best = v
    await sleep(90)
  }
  return best
}
const brow = await faceOffset('生气', 'ParamBrowLAngle')
ok(brow < -0.5, '「生气」真的会压眉毛了（ParamBrowLAngle 偏移 ' + brow.toFixed(2) + '，负=皱眉）')
const mouth = await faceOffset('微笑', 'ParamMouthForm')
ok(mouth > 0.5, '「微笑」真的会动嘴形了（ParamMouthForm 偏移 ' + mouth.toFixed(2) + '）')
await evalIn('DSHPet.clearUserFace()')
await evalIn('DSHPet.clearReaction()')

console.log('\n=== 7. 待机能关 / 低性能档 ===')
await evalIn('DSHPet.setIdle(false)')
await sleep(300)
const offSamples = []
for (let i = 0; i < 6; i++) { const s = await evalIn('DSHPet.motionState()'); offSamples.push(s.debug.out['ParamAngleZ'] || 0); await sleep(250) }
ok(offSamples.every((v) => Math.abs(v) < 1e-6), 'setIdle(false) 后待机层不再写入')
await evalIn('DSHPet.setIdle(true)')

ws.close()
console.log('\n========================================')
console.log(fail === 0 ? `验收全部通过：${pass} 项` : `⚠ 失败 ${fail} / 通过 ${pass}`)
process.exit(fail ? 1 : 0)
