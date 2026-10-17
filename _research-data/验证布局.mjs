/**
 * 布局不变量（真机 CDP）：气泡和工具栏在各种位置下都必须「挂在身上、整块在屏幕里」。
 *
 * 为什么要有它（2026-10-17 收尾）：气泡和工具栏的锚点/夹取刚抽成一处（placeViewportAnchored），
 * 这种重构不能只看「现在看着没问题」——要把不变量写成断言，以后谁再动这段都得过。
 *
 * 四个位置各验一遍：居中、不越界、挂在正确的一侧、该翻的时候翻。
 * 用法：node _research-data/验证布局.mjs [调试口]
 */
import { connect } from './_safe/cdp.mjs'

const port = Number(process.argv[2] || 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
const fails = []
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fails.push(name + (extra ? ' —— ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' —— ' + extra : '')) }
}

const c = await connect(port)
const PAD = 10

async function sample(left, top) {
  await c.evaluate(`(function(){ var r=document.querySelector('.dshp-root'); r.style.left='${left}px'; r.style.top='${top}px'; DSHPet.say('布局不变量测试的气泡', { ttl: 6000 }); return 1 })()`);
  // 等布局稳定（inset 是渐进测出来的）
  let last = null, same = 0
  for (let i = 0; i < 60; i++) {
    await sleep(120)
    const cur = JSON.stringify(await c.evaluate("(function(){var r=document.querySelector('.dshp-root');var b=r.getBoundingClientRect();return [Math.round(b.left),Math.round(b.top),Math.round(b.width),Math.round(b.height),r.style.getPropertyValue('--dshp-inset-x'),r.style.getPropertyValue('--dshp-inset-y')]})()"))
    if (cur === last) { if (++same >= 2) break } else { same = 0; last = cur }
  }
  await sleep(300)
  return c.evaluate(`(function(){
    var r = document.querySelector('.dshp-root');
    var rb = r.getBoundingClientRect();
    function inset(axis){ var v = parseFloat(r.style.getPropertyValue(axis === 'x' ? '--dshp-inset-x' : '--dshp-inset-y')) || 0; return v }
    var ixc = inset('x'), iyc = inset('y');
    var bodyW = Math.max(20, rb.width - ixc * 2);
    var bodyH = Math.max(20, rb.height - iyc * 2);
    function R(sel){ var e=document.querySelector(sel); if(!e) return null; var b=e.getBoundingClientRect(); return { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height), cx: Math.round(b.left + b.width/2) } }
    return { vw: window.innerWidth, vh: window.innerHeight, bubble: R('.dshp-bubble'), dock: R('.dshp-dock'),
             body: { left: rb.left + ixc, top: rb.top + iyc, bottom: rb.top + iyc + bodyH, cx: rb.left + ixc + bodyW / 2 } };
  })()`);
}

const cases = [
  { name: '右下默认', left: 1105, top: 437 },
  { name: '左上角', left: 40, top: 40 },
  { name: '下边缘', left: 700, top: 820 },
  { name: '右边缘', left: 1780, top: 300 },
];

for (const cs of cases) {
  console.log('\n=== ' + cs.name + ' ===');
  const s = await sample(cs.left, cs.top);
  ok('气泡存在（内容够不够长都不该影响摆放）', !!s.bubble, JSON.stringify(s.bubble))
  ok('工具栏存在', !!s.dock, JSON.stringify(s.dock))
  if (!s.bubble || !s.dock) continue;

  // ① 完整在视口内（这是硬要求：越界就点不到/看不见）
  ok('气泡整块在视口内（' + s.bubble.left + '..' + s.bubble.right + ' / ' + s.bubble.top + '..' + s.bubble.bottom + '）',
    s.bubble.left >= PAD - 1 && s.bubble.right <= s.vw - PAD + 1 && s.bubble.top >= PAD - 1 && s.bubble.bottom <= s.vh - PAD + 1)
  ok('工具栏整块在视口内（' + s.dock.left + '..' + s.dock.right + ' / ' + s.dock.top + '..' + s.dock.bottom + '）',
    s.dock.left >= PAD - 1 && s.dock.right <= s.vw - PAD + 1 && s.dock.top >= PAD - 1 && s.dock.bottom <= s.vh - PAD + 1)

  // ② 水平方向：以她的「可见部分」为中心（误差 ≤ 2px；贴边时允许被夹）
  const bodyCx = s.body.cx;
  const centered = Math.abs(s.bubble.cx - bodyCx) <= 2;
  const clampedAtEdge = s.bubble.left <= PAD + 1 || s.bubble.right >= s.vw - PAD - 1;
  ok('气泡对准她可见部分的中心（气泡 ' + s.bubble.cx + ' vs 她 ' + Math.round(bodyCx) + '）', centered || clampedAtEdge,
    'centered=' + centered + ' clampedAtEdge=' + clampedAtEdge)

  // ③ 竖直方向：气泡优先在上方；上方放不下就必须在下方
  const above = s.bubble.bottom <= s.body.top + 1;
  const below = s.bubble.top >= s.body.bottom - 1;
  ok('气泡在她头上一侧或脚下一侧（不压在她身上）', above || below, 'above=' + above + ' below=' + below + ' body=' + JSON.stringify(s.body))
  ok('头顶放得下时必须在上方', !(s.body.top - s.bubble.h - 12 >= PAD) || above,
    '她的头顶 y=' + Math.round(s.body.top) + '，气泡高 ' + s.bubble.h)

  // ④ 工具栏：优先下方，否则翻上去
  const dockBelow = s.dock.top >= s.body.bottom - 1;
  const dockAbove = s.dock.bottom <= s.body.top + 1;
  ok('工具栏在她脚下一侧或头上一侧', dockBelow || dockAbove, 'below=' + dockBelow + ' above=' + dockAbove);
  ok('脚下放得下时必须在下方', !(s.body.bottom + 8 + s.dock.h <= s.vh - PAD) || dockBelow,
    '她的脚 y=' + Math.round(s.body.bottom) + '，工具栏高 ' + s.dock.h);
}

// 回位，别把主人看到的留在奇怪的地方
await c.evaluate("(function(){ var r=document.querySelector('.dshp-root'); r.style.left='1105px'; r.style.top='437px'; DSHPet.say('回位了', { ttl: 1200 }); return 1 })()")
c.close()
console.log('\n' + '='.repeat(44))
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项：')
  for (const f of fails) console.log('  · ' + f)
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项')
  process.exit(1)
} else {
  console.log('布局不变量通过：' + pass + ' 项')
}