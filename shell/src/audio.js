/**
 * 系统声音峰值（Windows WASAPI IAudioMeterInformation）。
 *
 * 为什么单独一个模块：pet.js 在渲染进程里看不到系统的声音；Electron 也没有现成的
 * 「系统是否在播放」API。这里用一个长驻的 PowerShell 5.1 子进程读默认输出设备的 peak，
 * 主进程把它推给页面（/dsh-pet/events 的 {t:'audio'}）。
 *
 * 设计约束：
 *   · 不读音频内容、不读标题/进程名，只拿一个 0~1 的峰值 —— 隐私面最小；
 *   · 页面设置里可以整个关掉（audio:off → stop()），关掉后不留后台进程；
 *   · 页面重载会再发 audio:on，start() 幂等；
 *   · PowerShell 脚本带 BOM（PS 5.1 不认无 BOM 的 UTF-8 中文）；每次启动写临时文件；
 *   · 子进程自带父 PID 看门狗，外壳崩了不会留下孤儿 PowerShell。
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PS_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const SRC = path.join(__dirname, 'audio-meter.ps1')

function createAudioMeter(opts) {
  const log = (opts && opts.log) || (() => {})
  const onSample = (opts && opts.onSample) || (() => {})
  let child = null
  let stopping = false
  let tempFile = ''
  let ready = false
  let restarts = 0
  let buf = ''

  function writeTemp() {
    let script = fs.readFileSync(SRC, 'utf8')
    // PS 5.1 不认无 BOM 的 UTF-8 中文：源码里有没有都补一个，避免编辑工具把 BOM 吃掉
    if (script.charCodeAt(0) !== 0xfeff) script = '\ufeff' + script
    tempFile = path.join(os.tmpdir(), 'dsh-pet-audio-' + process.pid + '-' + Date.now().toString(36) + '.ps1')
    fs.writeFileSync(tempFile, script, 'utf8')
    return tempFile
  }

  function cleanup() {
    if (tempFile) {
      try { fs.unlinkSync(tempFile) } catch (e) {}
      tempFile = ''
    }
    buf = ''
  }

  function handleLine(line) {
    if (!line) return
    if (line === 'READY') {
      ready = true
      restarts = 0
      log('音频峰值：就绪')
      return
    }
    if (line.indexOf('PEAK ') === 0) {
      const v = Number(line.slice(5))
      if (isFinite(v)) onSample(Math.max(0, Math.min(1, v)))
      return
    }
    if (line.indexOf('ERR ') === 0) log('音频峰值：' + line.slice(4))
  }

  function start() {
    if (child) return
    stopping = false
    let file
    try {
      file = writeTemp()
    } catch (e) {
      log('音频峰值：写临时脚本失败 ' + (e && e.message))
      return
    }
    try {
      child = spawn(
        PS_EXE,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-ParentPid', String(process.pid)],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (e) {
      log('音频峰值：启动失败 ' + (e && e.message))
      cleanup()
      return
    }
    log('音频峰值：启动（pid ' + child.pid + '）')
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        handleLine(line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (s) => {
      const t = String(s || '').trim()
      if (t) log('音频峰值 stderr：' + t.slice(0, 300))
    })
    child.on('error', (e) => log('音频峰值：进程错误 ' + (e && e.message)))
    child.on('exit', (code, signal) => {
      child = null
      ready = false
      cleanup()
      if (stopping) return
      if (restarts < 3) {
        restarts++
        const delay = 1500 * restarts
        log('音频峰值：进程退出（' + (code == null ? signal : code) + '），' + delay + 'ms 后重启')
        setTimeout(() => { if (!stopping) start() }, delay)
      } else {
        log('音频峰值：连续退出，停止重试')
      }
    })
  }

  function stop() {
    stopping = true
    ready = false
    const c = child
    child = null
    if (c) {
      try { c.kill() } catch (e) {}
    }
    cleanup()
  }

  return {
    start: start,
    stop: stop,
    isRunning: () => !!child,
    isReady: () => ready,
  }
}

module.exports = { createAudioMeter }
