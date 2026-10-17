const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const t = list.find((x) => x.type === 'page' && x.url.includes('/dsh-pet/'))
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let seq = 0
const ev = (expr) => new Promise((res, rej) => {
  const id = ++seq
  const to = setTimeout(() => rej(new Error('timeout')), 10000)
  const on = (m) => { const d = JSON.parse(m.data); if (d.id !== id) return; clearTimeout(to); ws.removeEventListener('message', on); const r = d.result || {}; res(r.result ? r.result.value : (r.exceptionDetails ? 'THREW: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text) : undefined)) }
  ws.addEventListener('message', on)
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
})

console.log('root 元素:', await ev('(document.querySelector(".dshp-root")||{}).className'))
console.log('tab 按钮:', await ev('(document.querySelector(".dshp-tab")||{}).outerHTML?.slice(0,80)'))
console.log('menu 面板:', await ev('Array.from(document.querySelectorAll(".dshp-panel")).map(p=>p.className).join(" | ")'))
console.log('')
console.log('--- 点一下 tab ---')
console.log('click 返回:', await ev('(function(){var e=document.querySelector(".dshp-tab"); if(!e) return "没有 tab"; e.click(); return "clicked"})()'))
await sleep(600)
console.log('root 现在:', await ev('(document.querySelector(".dshp-root")||{}).className'))
console.log('on 面板:', await ev('Array.from(document.querySelectorAll(".dshp-panel.dshp-on")).map(p=>p.className).join(" | ") || "(无)"'))
console.log('')
console.log('--- 直接调 renderPane 看会不会抛 ---')
console.log('renderPane 可见?', await ev('typeof renderPane'))
console.log('DSHPet.menu():', await ev('JSON.stringify(DSHPet.menu()).slice(0,300)'))
ws.close()
