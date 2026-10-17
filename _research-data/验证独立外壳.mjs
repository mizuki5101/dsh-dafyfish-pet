/**
 * 独立外壳的真机验收（走 CDP，不用截图 —— 交接文档坑 #10）。
 *
 * 验的是「她真的不靠 DSH 也能活」这件事在**真实外壳里**成立：
 *   · 页面 origin 是外壳自己的本地服务（不再是 19387）
 *   · boot 注入在 pet.js 之前（老实现拼在后面 → 配置文件从来没生效过）
 *   · 旧 origin 的存档迁移过来了（她的大小/位置不是默认值）
 *   · 模型 / 表情 / 待机层都是本地服务给的，且真的跑起来了
 *   · 连没连上 DSH 由外壳告诉我们（linkState）
 *
 * 用法：node _research-data/验证独立外壳.mjs [调试口，默认 9222]
 */
import { connect } from './_safe/cdp.mjs'

const port = Number(process.argv[2] || 9222)
let pass = 0
const fails = []
const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fails.push(name + (extra ? ' —— ' + extra : ''))
    console.log('  ✗ ' + name + (extra ? ' —— ' + extra : ''))
  }
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const c = await connect(port)
const url = c.page.url
console.log('页面:', url)

console.log('\n=== 1. 页面由外壳自己的服务提供 ===')
ok('origin 不再是 DSH 的 19387（独立了）', !url.includes(':19387/'), url)
ok('页面来自 127.0.0.1 的本地服务', /^http:\/\/127\.0\.0\.1:\d+\/dsh-pet\/standalone/.test(url), url)
const portMatch = /127\.0\.0\.1:(\d+)/.exec(url)
const localPort = portMatch ? Number(portMatch[1]) : 0
ok('本地端口记下了：' + localPort, localPort > 1024)

console.log('\n=== 2. boot 注入（老实现是坏的，这条是回归锁）===')
const boot = await c.evaluate('window.DSHPet.boot()')
ok('页面拿得到 boot', !!boot)
eq('boot.local = true', boot && boot.local, true)
eq('boot.version', boot && boot.version, '0.1.0')
ok('boot.config 是对象', boot && typeof boot.config === 'object')
ok('boot.seed 带上了旧存档', boot && boot.seed && typeof boot.seed === 'object')

console.log('\n=== 3. 旧 origin 的存档迁移过来了 ===')
const layout = await c.evaluate("(function(){try{return JSON.parse(localStorage.getItem('dsh-live2d-pet:layout')||'{}')}catch(e){return {}}})()")
ok('localStorage 有了新 origin 的存档', !!layout && Object.keys(layout).length > 0, JSON.stringify(layout).slice(0, 120))
const st = await c.evaluate('DSHPet.state')
ok('她的大小是主人调过的 720（不是默认 180）', layout && layout.height === 720, 'height=' + (layout && layout.height))
ok('灵动度预设也迁移过来了（idleStrength 1.6）', layout && layout.cfg && layout.cfg.idleStrength === 1.6, JSON.stringify(layout && layout.cfg))
ok('位置迁移过来了', layout && Number(layout.x) > 0 && Number(layout.y) > 0, 'x=' + (layout && layout.x) + ' y=' + (layout && layout.y))

console.log('\n=== 4. 模型/表情/待机层（资源全来自本地服务）===')
ok('模型加载出来了', !!(st && st.modelSize), JSON.stringify(st && st.modelSize))
eq('模型是 3326×4992 的大肥鱼画布', st && Math.round(st.modelSize.w) + 'x' + Math.round(st.modelSize.h), '3326x4992')
ok('表情表是从本地 manifest 读的（13 个以上）', st && st.expressions && st.expressions.length >= 13, 'len=' + (st && st.expressions && st.expressions.length))
const motion = await c.evaluate('DSHPet.motionState()')
ok('待机层在跑（motion.ready）', !!(motion && motion.ready))
ok('待机节奏引擎在位（mood 有值）', !!(motion && motion.idle && motion.idle.mood), JSON.stringify(motion && motion.idle && motion.idle.mood))

console.log('\n=== 5. 与 DSH 的连接 ===')
const link = await c.evaluate('DSHPet.linkState()')
ok('页面知道连接状态（linkState.known）', !!(link && link.known), JSON.stringify(link))
ok('此刻已连上 DSH（DSH 正开着，应该连上）', !!(link && link.online), JSON.stringify(link))
eq('连的是 DSH 的 19387', link && link.port, 19387)
// ⚠️ 这里不能走 c.evaluate()：它会对表达式结果直接 JSON.stringify，
// 而 fetch 返回的是 Promise（stringify 出来是 {}，我第一版就栽在这）。
const rawState = await c.call('Runtime.evaluate', {
  expression: "fetch('/dsh-pet/state').then(r=>r.json()).then(j=>JSON.stringify(j))",
  returnByValue: true,
  awaitPromise: true,
})
let stateHttp = null
try {
  stateHttp = JSON.parse(rawState.result.value)
} catch (e) {}
ok('本地服务的 /dsh-pet/state 可用', !!(stateHttp && stateHttp.local), JSON.stringify(stateHttp).slice(0, 140))
ok('本地服务报了资源根', Array.isArray(stateHttp && stateHttp.assetRoots) && stateHttp.assetRoots.length > 0)

console.log('\n=== 6. 她还在动（不是白屏/静止）===')
const t1 = await c.evaluate('DSHPet.motionState().idle.t')
await sleep(1200)
const t2 = await c.evaluate('DSHPet.motionState().idle.t')
ok('待机时间在推进（' + t1 + ' → ' + t2 + '）', t2 > t1, 't1=' + t1 + ' t2=' + t2)
const eye = await c.evaluate('DSHPet.eyeState()')
ok('眼睛参数正常（眨眼系统没被破坏）', eye && eye.L !== undefined && eye.L !== null, JSON.stringify(eye))

console.log('\n=== 7. 设置面板：连接状态 + 重新连按钮（2026-10-17）===')
// 那三个「连哪个宿主」的按钮在独立模式下已经隐藏；这一节验的是替上去的状态行与重连按钮。
const panel = await c.call('Runtime.evaluate', {
  expression: `(function(){
    try {
      var dock = document.querySelector('.dshp-dock')
      if (!dock) return JSON.stringify({ err: 'no dock' })
      dock.children[1].click()
      var tabs = document.querySelectorAll('.dshp-tab-btn')
      for (var i = 0; i < tabs.length; i++) if (tabs[i].dataset.tab === 'setting') tabs[i].click()
      var menu = document.querySelector('.dshp-menu')
      var btns = []
      var bs = menu ? menu.querySelectorAll('.dshp-btn') : []
      for (var j = 0; j < bs.length; j++) btns.push(bs[j].textContent)
      var hints = []
      var hs = menu ? menu.querySelectorAll('.dshp-hint') : []
      for (var k = 0; k < hs.length; k++) hints.push(hs[k].textContent)
      var closeBtn = menu ? menu.querySelector('.dshp-close') : null
      if (closeBtn) closeBtn.click()
      return JSON.stringify({ btns: btns, hints: hints })
    } catch (e) { return JSON.stringify({ err: String(e && e.message) }) }
  })()`,
  returnByValue: true,
  awaitPromise: true,
})
let pn = {}
try {
  pn = JSON.parse(panel.result.value)
} catch (e) {}
ok('设置面板打开了（没报错）', !pn.err, JSON.stringify(pn).slice(0, 120))
ok('有「重新连 DSH」按钮：' + (pn.btns || []).filter((t) => /连/.test(t)).join(' / '), (pn.btns || []).some((t) => t.indexOf('连') >= 0))
const statusLine = (pn.hints || []).find((h) => h.indexOf('DSH') >= 0) || ''
ok('状态行写出「已连上 DSH」：' + statusLine.slice(0, 40), statusLine.indexOf('已连上 DSH') >= 0, statusLine)
ok('状态行前面有 ● 圆点', statusLine.indexOf('●') >= 0, statusLine)
ok('不再出现「连哪个宿主」那三个按钮', !(pn.btns || []).some((t) => t === '自动' || t === '桌面版' || t === '网页版'), JSON.stringify(pn.btns))

// 真点一下那个按钮：应该立刻冒出气泡（说明按钮不是个摆设，也不抛异常）
const clicked = await c.call('Runtime.evaluate', {
  expression: `(function(){
    try {
      var dock = document.querySelector('.dshp-dock')
      dock.children[1].click()
      var tabs = document.querySelectorAll('.dshp-tab-btn')
      for (var i = 0; i < tabs.length; i++) if (tabs[i].dataset.tab === 'setting') tabs[i].click()
      var btns = document.querySelectorAll('.dshp-menu .dshp-btn')
      var hit = null
      for (var j = 0; j < btns.length; j++) if (btns[j].textContent.indexOf('连') >= 0) hit = btns[j]
      if (!hit) return JSON.stringify({ err: '没找到重连按钮' })
      hit.click()
      var b = document.querySelector('.dshp-bubble')
      var text = b ? b.textContent : ''
      var closeBtn = document.querySelector('.dshp-menu .dshp-close')
      if (closeBtn) closeBtn.click()
      return JSON.stringify({ text: text })
    } catch (e) { return JSON.stringify({ err: String(e && e.message) }) }
  })()`,
  returnByValue: true,
  awaitPromise: true,
})
let ck = {}
try {
  ck = JSON.parse(clicked.result.value)
} catch (e) {}
ok('点「重新连 DSH」会冒出气泡：' + String(ck.text || '').slice(0, 30), !ck.err && /DSH/.test(ck.text || ''), JSON.stringify(ck).slice(0, 120))

c.close()
console.log('\n' + '='.repeat(44))
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项：')
  for (const f of fails) console.log('  · ' + f)
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项')
  process.exit(1)
} else {
  console.log('独立外壳验收通过：' + pass + ' 项')
}
