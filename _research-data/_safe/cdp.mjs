/**
 * 极简 CDP 客户端（外壳必须带 --remote-debugging-port）。
 * 交接文档坑 #10：透明窗口截不了图，所以一切验证都走"页面内探针"这条路。
 */
export async function connect(port = 9222) {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json')).json()
  const t = list.find((x) => x.type === 'page' && String(x.url).includes('/dsh-pet/')) || list.find((x) => x.type === 'page')
  if (!t) throw new Error('没有 page 目标（外壳没带调试口？）')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('CDP 连接失败')) })
  let seq = 0
  const call = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq
    const to = setTimeout(() => rej(new Error(method + ' 超时')), 20000)
    const on = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id !== id) return
      clearTimeout(to); ws.removeEventListener('message', on)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify({ id, method, params }))
  })
  await call('Runtime.enable', {})
  const evaluate = async (expr) => {
    const r = await call('Runtime.evaluate', {
      expression: 'JSON.stringify((function(){try{return (' + expr + ')}catch(e){return {__error:String(e)}}})())',
      returnByValue: true, awaitPromise: true,
    })
    const v = r && r.result && r.result.value
    if (v == null) return { __raw: r && r.result }
    try { return JSON.parse(v) } catch { return { __raw: v } }
  }
  return { page: t, call, evaluate, close: () => ws.close() }
}
