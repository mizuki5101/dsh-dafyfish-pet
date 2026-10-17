/**
 * 桌宠运行时探针（走 Electron 的 CDP 调试端口）。
 *
 * 为什么需要：交接文档坑 #10 —— 透明窗口截不了图，CopyFromScreen / PrintWindow 都拍不到。
 * 但外壳是 Electron，只要启动时带 --remote-debugging-port=9222，就能用 CDP
 * 直接读页面里的真实状态，比截图可靠得多。
 *
 * 用法：
 *   node 探针.mjs                            # 打印 DSHPet.motionState()
 *   node 探针.mjs "DSHPet.clips()"           # 求值任意表达式
 *   node 探针.mjs --watch 12                 # 采样 12 秒，看根参数是否真的在动
 *   node 探针.mjs --console                  # 重载页面并抓 20 秒控制台输出
 *
 * 前提：外壳用 --remote-debugging-port=9222 启动。
 */
const PORT = 9222
const args = process.argv.slice(2)

async function targets() {
  const r = await fetch('http://127.0.0.1:' + PORT + '/json')
  const list = await r.json()
  return list.filter((t) => t.type === 'page')
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    ws.onopen = () => resolve(ws)
    ws.onerror = (e) => reject(new Error('CDP 连接失败：' + (e.message || e)))
  })
}

let seq = 0
function call(ws, method, params) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(method + ' 超时')), 15000)
    const onMsg = (ev) => {
      let m
      try { m = JSON.parse(ev.data) } catch (e) { return }
      if (m.id !== id) return
      clearTimeout(to)
      ws.removeEventListener('message', onMsg)
      if (m.error) reject(new Error(method + ' 出错：' + JSON.stringify(m.error)))
      else resolve(m.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })
}

async function evaluate(ws, expr) {
  const r = await call(ws, 'Runtime.evaluate', {
    expression: 'JSON.stringify((function(){try{return (' + expr + ')}catch(e){return {__error:String(e)}}})())',
    returnByValue: true,
    awaitPromise: false,
  })
  const v = r && r.result && r.result.value
  if (v == null) return { __raw: r && r.result }
  try { return JSON.parse(v) } catch (e) { return { __raw: v } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const main = async () => {
  const ts = await targets()
  if (!ts.length) {
    console.error('没有找到 page 目标。外壳是不是没带 --remote-debugging-port=9222 启动？')
    process.exit(2)
  }
  const t = ts.find((x) => x.url.includes('/dsh-pet/')) || ts[0]
  console.log('# 目标：' + t.title + '  ' + t.url)
  const ws = await connect(t.webSocketDebuggerUrl)
  await call(ws, 'Runtime.enable', {})

  if (args[0] === '--console') {
    const seen = []
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data) } catch (e) { return }
      if (m.method !== 'Runtime.consoleAPICalled') return
      const txt = (m.params.args || []).map((a) => (a.value !== undefined ? a.value : a.description || a.type)).join(' ')
      seen.push('[' + m.params.type + '] ' + txt)
    })
    await call(ws, 'Page.enable', {})
    console.log('# 重载页面，抓 20 秒控制台…')
    await call(ws, 'Page.reload', { ignoreCache: true })
    await sleep(20000)
    console.log(seen.join('\n'))
    ws.close()
    return
  }

  if (args[0] === '--clip') {
    const name = args[1]
    if (!name) { console.error('用法：--clip "动作名"'); process.exit(2) }
    const list = await evaluate(ws, 'DSHPet.clips()')
    if (!Array.isArray(list) || !list.includes(name)) {
      console.error('动作库里没有「' + name + '」。现有：' + (Array.isArray(list) ? list.join(' / ') : list))
      process.exit(2)
    }
    const played = await evaluate(ws, 'DSHPet.playClip(' + JSON.stringify(name) + ')')
    console.log('# playClip(' + name + ') -> ' + JSON.stringify(played))
    const seen = new Map()
    const t0 = Date.now()
    while (Date.now() - t0 < 4000) {
      const st = await evaluate(ws, 'DSHPet.motionState()')
      if (st && st.debug && st.debug.out) {
        for (const [k, v] of Object.entries(st.debug.out)) {
          if (!seen.has(k)) seen.set(k, [])
          seen.get(k).push(v)
        }
      }
      await sleep(120)
    }
    console.log('# 播放期间「我们写入的偏移量」峰值：')
    let anyArm = false
    for (const [k, v] of seen) {
      const mn = Math.min(...v), mx = Math.max(...v)
      if (Math.abs(mn) < 0.01 && Math.abs(mx) < 0.01) continue
      if (k.startsWith('Param_arm_')) anyArm = true
      console.log('  ' + k.padEnd(15) + ' [' + mn.toFixed(2).padStart(7) + ' , ' + mx.toFixed(2).padStart(7) + ' ]')
    }
    console.log(anyArm ? '# ✓ 手臂参数被驱动了' : '# ✗ 手臂参数没有动')
    const after = await evaluate(ws, 'DSHPet.motionState().clips')
    console.log('# 播放结束后仍在播的 clip：' + JSON.stringify(after))
    ws.close()
    return
  }

  if (args[0] === '--watch') {
    const secs = Number(args[1]) || 10
    const ids = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBreath']
    const hist = new Map(ids.map((i) => [i, []]))
    const t0 = Date.now()
    const clipInfo = []
    while (Date.now() - t0 < secs * 1000) {
      const st = await evaluate(ws, 'DSHPet.motionState()')
      if (st && st.roots) for (const r of st.roots) if (hist.has(r.id)) hist.get(r.id).push(r.applied)
      if (st && st.clips && st.clips.length) clipInfo.push(st.clips.map((c) => c.name + '@' + c.t).join(','))
      await sleep(400)
    }
    console.log('# 采样 ' + secs + 's，共 ' + hist.get('ParamAngleX').length + ' 个点')
    console.log('# ' + '参数'.padEnd(16) + '默认'.padStart(8) + '最小'.padStart(9) + '最大'.padStart(9) + '跨度'.padStart(9) + '  结论')
    for (const id of ids) {
      const v = hist.get(id).filter((x) => x !== null)
      if (!v.length) { console.log('  ' + id.padEnd(16) + ' 没有数据'); continue }
      const mn = Math.min(...v), mx = Math.max(...v), span = mx - mn
      const verdict = span > 0.05 ? '✓ 在动' : '✗ 没动'
      console.log('  ' + id.padEnd(16) + String(v[0]).padStart(8) + mn.toFixed(3).padStart(9) + mx.toFixed(3).padStart(9) + span.toFixed(3).padStart(9) + '  ' + verdict)
    }
    if (clipInfo.length) console.log('# clip 观测：' + clipInfo.slice(0, 8).join(' | '))
    ws.close()
    return
  }

  const expr = args[0] || 'DSHPet.motionState()'
  const out = await evaluate(ws, expr)
  console.log(JSON.stringify(out, null, 1))
  ws.close()
}

main().catch((e) => { console.error(String(e)); process.exit(1) })
