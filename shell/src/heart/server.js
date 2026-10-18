'use strict'
// 本地推理引擎的进程管理（「一键启动/停止本地模型」）。
//
// 只负责一件事：按配置把 llama-server 拉起来、等它 /health 通过、退出时收掉。
// 为什么不内置引擎：公共仓库不能背 300MB 的二进制；面板里填 exe + gguf 路径即可。
//
// 进程生命周期：
//   start() → spawn → 轮询 /health（最多 60s）→ 成功返回；失败就杀掉，避免留下僵尸进程。

const { spawn, execSync } = require('node:child_process')

function splitArgs(s) {
  const out = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(String(s || '')))) out.push(m[1] || m[2] || m[3])
  return out
}

function createModelServer(opts) {
  const o = opts || {}
  const log = typeof o.log === 'function' ? o.log : () => {}
  const fetchImpl = typeof o.fetch === 'function' ? o.fetch : fetch

  let child = null
  /** 端口上已经有一个健康的外部 llama-server（比如上次异常退出留下的），不要重复 spawn */
  let external = false
  let startedAt = 0
  let lastError = ''
  let port = 0
  let exe = ''
  let model = ''
  let tail = []

  function push(line) {
    tail.push(String(line).replace(/\s+$/, '').slice(0, 300))
    if (tail.length > 80) tail.shift()
  }

  function status() {
    return {
      running: !!child || external,
      external,
      pid: child ? child.pid : 0,
      port,
      startedAt,
      lastError,
      exe,
      model,
      tail: tail.slice(-8),
    }
  }

  async function probe(p) {
    try {
      const r = await fetchImpl('http://127.0.0.1:' + p + '/health')
      return !!(r && r.ok)
    } catch (e) {
      return false
    }
  }

  /** 端口上是谁在听？用于停止「上次残留的那个」——不然再点启动会撞端口。 */
  function killByPort(p) {
    if (process.platform !== 'win32') return false
    try {
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      const re = new RegExp('[:.]' + p + '\\s+.*LISTENING\\s+(\\d+)', 'i')
      const m = out.match(re)
      if (!m) return false
      spawn('taskkill', ['/PID', m[1], '/T', '/F'], { windowsHide: true })
      return true
    } catch (e) {
      return false
    }
  }

  async function waitHealth(p, timeoutMs) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      if (!child) return false
      try {
        const r = await fetchImpl('http://127.0.0.1:' + p + '/health')
        if (r && r.ok) return true
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 700))
    }
    return false
  }

  function kill() {
    if (!child) return
    const pid = child.pid
    try {
      child.kill()
    } catch (e) {}
    try {
      // Windows 上 llama-server 会开子进程/线程，必须杀进程树
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    } catch (e) {}
    child = null
  }

  async function start(cfg) {
    if (child) return { ok: true, model: status() }
    const ms = (cfg && cfg.modelServer) || {}
    exe = ms.exe || ''
    model = ms.model || ''
    port = Number(cfg && cfg.model && cfg.model.port) || 19411
    // 端口上已经有一个健康的服务 → 直接复用（常见于上次外壳被强杀、llama-server 残留）
    if (await probe(port)) {
      external = true
      lastError = ''
      log('心跳：端口 ' + port + ' 上已有服务在跑，直接复用')
      return { ok: true, model: status(), note: 'already-running' }
    }
    if (!exe || !model) {
      lastError = 'need-paths'
      log('心跳：模型启动失败 —— 面板里还没填 llama-server / 模型路径')
      return { ok: false, reason: 'need-paths', model: status() }
    }
    const args = ['-m', model]
    if (ms.mmproj) args.push('--mmproj', ms.mmproj)
    args.push('-c', '4096', '-ngl', '99', '-np', '1', '--host', '127.0.0.1', '--port', String(port), '--jinja')
    if (ms.extraArgs) args.push(...splitArgs(ms.extraArgs))
    lastError = ''
    tail = []
    log('心跳：启动模型 ' + exe + ' :' + port)
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      child = null
      lastError = String((e && e.message) || e)
      log('心跳：模型 spawn 失败 ' + lastError)
      return { ok: false, reason: lastError, model: status() }
    }
    child.stdout.on('data', (b) => push(b.toString()))
    child.stderr.on('data', (b) => push(b.toString()))
    child.on('error', (e) => {
      // spawn 失败（路径写错/没权限）时**不会触发 exit**，必须自己把 child 清掉，
      // 否则下一次 start() 会以为「已经在跑」，直接返回 ok —— 面板就会假装启动成功。
      lastError = String((e && e.message) || e)
      push(lastError)
      child = null
    })
    child.on('exit', (code) => {
      push('exit code=' + code)
      log('心跳：模型进程退出 code=' + code)
      child = null
    })
    startedAt = Date.now()
    const ok = await waitHealth(port, 60000)
    if (!ok) {
      if (!lastError) lastError = 'health-timeout'
      log('心跳：模型没就绪（' + lastError + '），已停止')
      kill()
      return { ok: false, reason: lastError, model: status() }
    }
    log('心跳：模型就绪 :' + port)
    return { ok: true, model: status() }
  }

  function stop() {
    if (!child && external) {
      const killed = killByPort(port)
      external = false
      log('心跳：停止外部服务 :' + port + (killed ? '（已按端口结束进程）' : '（没找到进程）'))
      return { ok: killed, model: status(), reason: killed ? '' : 'not-found' }
    }
    if (!child) return { ok: true, model: status() }
    log('心跳：停止模型 pid=' + child.pid)
    kill()
    startedAt = 0
    return { ok: true, model: status() }
  }

  return { start, stop, status, isRunning: () => !!child }
}

module.exports = { createModelServer, splitArgs }
