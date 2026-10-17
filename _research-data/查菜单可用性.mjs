/** 逐个页签点开菜单，数一数哪些按钮是真的能用（不是灰的/死的）。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const t = list.find((x) => x.type === 'page' && x.url.includes('/dsh-pet/'))
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let seq = 0
const ev = (expr) => new Promise((res, rej) => {
  const id = ++seq
  const to = setTimeout(() => rej(new Error('timeout')), 12000)
  const on = (m) => { const d = JSON.parse(m.data); if (d.id !== id) return; clearTimeout(to); ws.removeEventListener('message', on); const v = d.result?.result?.value; try { res(JSON.parse(v)) } catch (e) { res(v) } }
  ws.addEventListener('message', on)
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify(' + expr + ')', returnByValue: true } }))
})

// 打开菜单：工具栏的 ⋯ 按钮（注意：右键弹的是余额 HUD，不是这个菜单）
await ev('(function(){ if(!DSHPet.menu().open){ var b=document.querySelectorAll(".dshp-dock > *")[1]; if(b) b.click(); } return true })()')
await sleep(500)
const opened = await ev('DSHPet.menu().open')
console.log('菜单已打开:', opened)

const panes = await ev('Array.from(document.querySelectorAll(".dshp-tab-btn")).map(b=>b.textContent)')
console.log('页签:', JSON.stringify(panes))
console.log('')

const all = []
for (let i = 0; i < panes.length; i++) {
  await ev('document.querySelectorAll(".dshp-tab-btn")[' + i + '].click()')
  await sleep(350)
  const chips = await ev(`Array.from(document.querySelectorAll('.dshp-panel.dshp-on .dshp-chip')).map(c=>({label:c.textContent, dead:c.classList.contains('dshp-dead'), title:(c.title||'').split('\\n')[0]}))`)
  const total = chips.length
  const dead = chips.filter((c) => c.dead).length
  all.push({ pane: panes[i], total, dead, chips })
  console.log('【' + panes[i] + '】 按钮 ' + total + ' 个，其中灰掉(不可用) ' + dead + ' 个')
  for (const c of chips) console.log('    ' + (c.dead ? '✗' : '✓') + ' ' + c.label + (c.dead ? '   ← 点了没反应' : ''))
  console.log('')
}

// 关掉菜单
await ev('(function(){ if(DSHPet.menu().open){ var b=document.querySelectorAll(".dshp-dock > *")[1]; if(b) b.click(); } return true })()')
ws.close()
console.log('=== 汇总 ===')
let tt = 0, dd = 0
for (const p of all) { tt += p.total; dd += p.dead; console.log('  ' + p.pane.padEnd(8) + tt_line(p)) }
function tt_line(p) { return '共 ' + p.total + ' 项，可用 ' + (p.total - p.dead) + ' 项' + (p.dead ? '，**不可用 ' + p.dead + ' 项**' : '（全部可用）') }
console.log('  合计：' + tt + ' 项，不可用 ' + dd + ' 项')
