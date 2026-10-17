'use strict'
/**
 * 桌宠自己的本地 HTTP 服务 —— 「她脱离 DSH 独立存在」的核心。
 *
 * 背景（交接文档「七点九五」）：她本来就是个独立进程，只是**资源全靠 DSH 的 HTTP 服务**：
 *   /dsh-pet/standalone（页面）· /dsh-pet/pet.js（前端）· /dsh-pet/vendor（Live2D 运行时）· /dsh-pet/model（模型）
 * 所以「独立」= 把这四条改成外壳自己提供，DSH 只负责「对话」这一块。
 *
 * 这个文件刻意**不 require('electron')**：它是纯 Node 模块，
 * 于是可以在任何 Node 里起起来做自动化测试（见 _research-data/测试独立桌宠.mjs），
 * 不需要开窗口、不需要 DSH。外壳那边（main.js）只负责发现 DSH、决定什么时候 setUpstream()。
 *
 * 三条硬约束（都踩过坑，别改）：
 *   ① 页面里 pet.js 用的全是相对路径（BASE = '/dsh-pet'），所以本地服务**必须也用 /dsh-pet 前缀**，
 *      否则「前端一行都不用改」这件事就不成立了。
 *   ② 必须过信任栅栏：这是回环上不设防的 HTTP 服务，浏览器里任何网页都能访问回环地址。
 *      所以要有 ① Host 校验（防 DNS rebinding）② Origin 校验 ③ 一次性令牌（cookie / ?k=）。
 *      没有它，任意网页都能借 /dsh-pet/say 往主人的会话里灌消息。
 *   ③ 模型/贴图不放进 asar（29 MB 贴图会让外壳涨到 32MB、每次改前端都要重打包），
 *      而是从「资源根目录」读（exe 同级 pet-assets / 工作区插件目录 / asar 内），按顺序找第一个存在的。
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.moc3': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
}

/**
 * 路由表。键是路径（前缀路由以 / 结尾）。
 * 这张表同时被测试当「契约」用：pet.js 里凡 BASE + '/xxx' 的请求，这里必须都有对应项
 * （见 _research-data/测试独立桌宠.mjs 的「路由覆盖」断言）—— 少一条就是「独立后某个功能悄悄没了」。
 */
const ROUTES = {
  '/dsh-pet/standalone': 'page',
  '/dsh-pet/pet.js': 'script',
  '/dsh-pet/config': 'config',
  '/dsh-pet/state': 'state',
  '/dsh-pet/ping': 'ping',
  '/dsh-pet/events': 'sse',
  '/dsh-pet/hud': 'proxy',
  '/dsh-pet/say': 'proxy',
  '/dsh-pet/cancel': 'proxy',
  '/dsh-pet/control': 'proxy',
  '/dsh-pet/vendor/': 'static',
  '/dsh-pet/model/': 'static',
}

/** 这条路径由本服务负责吗（测试与 404 文案都查它） */
function handles(pathname) {
  if (Object.prototype.hasOwnProperty.call(ROUTES, pathname)) return ROUTES[pathname]
  for (const key of Object.keys(ROUTES)) {
    if (key.endsWith('/') && pathname.startsWith(key)) return ROUTES[key]
  }
  return null
}

/**
 * 独立页。和插件里 /dsh-pet/standalone 的那份**必须等价**：
 *   body 上的 --dsh-pet-standalone:1 是 pet.js 判断「我在桌面外壳里」的判据（交接文档第二节）。
 * 踩过的坑：判据写在内联 style 上读不到（JS 只读内联样式），所以这里写在 style 规则里。
 */
function standalonePage(opts) {
  const title = (opts && opts.title) || 'DS 鲸鱼娘 · 桌宠'
  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + title + '</title>',
    '<style>',
    '  html,body{margin:0;height:100%;overflow:hidden;background:transparent}',
    '  body{--dsh-pet-standalone:1}',
    '</style>',
    '</head><body>',
    '<script src="/dsh-pet/pet.js"></script>',
    '</body></html>',
  ].join('\n')
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return null
  }
}

/** 只接受回环地址上的本机请求（DNS rebinding 的防线） */
function hostOk(req, port) {
  const host = String(req.headers.host || '').toLowerCase()
  return host === '127.0.0.1:' + port || host === 'localhost:' + port
}

/** 带 Origin 的请求必须是本站（浏览器对同源 POST 也会带 Origin） */
function originOk(req, port) {
  const o = req.headers.origin
  if (!o) return true
  return o === 'http://127.0.0.1:' + port || o === 'http://localhost:' + port
}

function cookieOf(req, name) {
  const raw = String(req.headers.cookie || '')
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1)
  }
  return null
}

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/**
 * 起一个本地服务。
 *
 * @param {object} opts
 *   assetRoots  string[]  资源根目录（按顺序找，越前越优先）
 *   configFile  string    ~/.dsh/dsh-live2d-pet.json（用户配置；**只读原文件，不填默认值**）
 *   seedFile    string    旧 origin 的 localStorage 存档（一次性迁移用，可选）
 *   version     string    版本串（诊断用）
 *   log         Function  日志
 *   token       string    覆盖令牌（测试用；不传就随机）
 *   host        string    监听地址（默认 127.0.0.1）
 */
function createPetServer(opts) {
  opts = opts || {}
  const assetRoots = (opts.assetRoots || []).filter((r) => typeof r === 'string' && r)
  const configFile = typeof opts.configFile === 'string' ? opts.configFile : ''
  const seedFile = typeof opts.seedFile === 'string' ? opts.seedFile : ''
  const version = String(opts.version || '0.0.0')
  const token = String(opts.token || crypto.randomBytes(16).toString('hex'))
  const host = String(opts.host || '127.0.0.1')
  const log = typeof opts.log === 'function' ? opts.log : () => {}

  /** 运行态。全部集中在这里，方便 /dsh-pet/state 与测试一次性读出来 */
  const st = {
    port: 0,
    online: false,
    upstreamBase: null,
    upstreamToken: null,
    upstreamPort: null,
    status: 'idle',
    clients: 0,
    lastFrameAt: 0,
    framesDown: 0,
    framesUp: 0,
    upstreamLost: 0,
    lastServedFrom: null,
  }
  const clients = new Set()
  let server = null
  let upstreamReq = null
  let upstreamRes = null

  // ————————————————————————————————————————————————————————————
  // 静态资源：按根目录顺序找第一个存在的文件
  // ————————————————————————————————————————————————————————————
  function findAsset(rel) {
    let decoded
    try {
      decoded = decodeURIComponent(String(rel || ''))
    } catch (e) {
      return null
    }
    if (decoded.indexOf('\u0000') !== -1) return null
    const clean = path.normalize(decoded).replace(/^[/\\]+/, '')
    if (!clean || clean.startsWith('..') || path.isAbsolute(clean)) return null
    for (const root of assetRoots) {
      const base = path.resolve(root)
      const abs = path.resolve(base, clean)
      if (abs !== base && !abs.startsWith(base + path.sep)) continue
      try {
        const s = fs.statSync(abs)
        if (s.isFile()) {
          st.lastServedFrom = base
          return abs
        }
      } catch (e) {}
    }
    return null
  }

  /** 静态文件：带 ETag（贴图 29MB，重启后靠 304 省一次全量下载） */
  function serveFile(req, res, abs, cache) {
    let stat
    try {
      stat = fs.statSync(abs)
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const tag = '"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"'
    if (String(req.headers['if-none-match'] || '') === tag) {
      res.writeHead(304, { ETag: tag, 'Cache-Control': cache })
      res.end()
      return
    }
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream'
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': String(stat.size),
      'Cache-Control': cache,
      ETag: tag,
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = fs.createReadStream(abs)
    stream.on('error', () => {
      try {
        res.destroy()
      } catch (e) {}
    })
    stream.pipe(res)
  }

  // ————————————————————————————————————————————————————————————
  // pet.js：热读 + 注入 boot
  // ————————————————————————————————————————————————————————————
  const hot = new Map()
  function readHot(abs) {
    const s = fs.statSync(abs)
    const hit = hot.get(abs)
    if (hit && hit.mtime === s.mtimeMs) return hit.text
    const text = fs.readFileSync(abs, 'utf8')
    hot.set(abs, { mtime: s.mtimeMs, text })
    return text
  }

  function userConfig() {
    // ⚠️ 只回「用户自己写的那几个键」，不填默认值。
    // pet.js 自己的 CFG 里就有一套默认值（两处填默认值 = 交接文档坑 #5「同一份数据被多处独立计算」）。
    return readJson(configFile) || {}
  }

  function bootObject() {
    const seed = seedFile ? readJson(seedFile) : null
    const boot = {
      config: userConfig(),
      version,
      desktop: true, // 页面跑在 Electron 外壳里
      local: true, // ← 这个标记让前端知道「宿主是外壳自己的服务」
      port: st.upstreamPort, // DSH 的端口（没连上就是 null）
      upstream: { online: st.online, port: st.upstreamPort, base: st.upstreamBase },
    }
    if (seed && typeof seed === 'object') boot.seed = seed
    return boot
  }

  /**
   * ⚠️ boot 必须**放在 pet.js 前面**。
   * 老实现（插件的 /dsh-pet/pet.js）是拼在**后面**的，而 pet.js 是同步 IIFE，
   * 在它执行时 window.__DSH_PET_BOOT__ 还不存在 → BOOT 恒为空对象，
   * 于是配置文件里的 height / corner / 灵动度**从来没有生效过**（2026-10-17 查出来的真 bug）。
   * 回归锁：测试断言 boot 的位置在 __DSH_PET_LOADED__ 之前。
   */
  function handlePetJs(req, res) {
    const abs = findAsset('pet.js')
    if (!abs) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('找不到 pet.js（资源根目录都不含它）：\n' + assetRoots.join('\n'))
      return
    }
    let body
    try {
      body = readHot(abs)
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('pet.js 读不出来：' + e.message)
      return
    }
    const head = '/* dsh-pet-local ' + version + ' · assets=' + abs + ' */\n;window.__DSH_PET_BOOT__=' +
      JSON.stringify(bootObject()) + ';\n'
    const doc = head + body
    res.writeHead(200, {
      'Content-Type': MIME['.js'],
      'Content-Length': String(Buffer.byteLength(doc)),
      'Cache-Control': 'no-store',
    })
    res.end(doc)
  }

  // ————————————————————————————————————————————————————————————
  // SSE：本地这一端当成一个「枢纽」
  //
  // 为什么不让页面直连 DSH：① 独立运行时 DSH 可能根本没开 ② DSH 一重启，
  // 页面原来那条 EventSource 会不停重连（还跨源、要带通行证）。
  // 改成「页面只连本地，本地负责连 DSH」，于是 DSH 开关对她来说完全透明。
  // ————————————————————————————————————————————————————————————
  function sseSend(res, obj) {
    try {
      res.write('data: ' + JSON.stringify(obj) + '\n\n')
      st.framesUp++
      return true
    } catch (e) {
      return false
    }
  }

  function broadcast(obj) {
    for (const res of clients) {
      if (!sseSend(res, obj)) clients.delete(res)
    }
    st.clients = clients.size
  }

  function linkEvent() {
    broadcast({ t: 'link', online: st.online, port: st.upstreamPort, base: st.upstreamBase, ts: Date.now() })
  }

  function handleEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    // 连上先给一份当前状态（和 DSH 那边的 hello 同形），页面不用等下一件事
    sseSend(res, {
      t: 'hello',
      status: st.status || 'idle',
      link: st.online ? 'online' : 'offline',
      port: st.upstreamPort,
      local: true,
      ts: Date.now(),
    })
    clients.add(res)
    st.clients = clients.size
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch (e) {
        clearInterval(ping)
        clients.delete(res)
        st.clients = clients.size
      }
    }, 15000)
    const cleanup = () => {
      clearInterval(ping)
      clients.delete(res)
      st.clients = clients.size
    }
    req.on('close', cleanup)
    req.on('error', cleanup)
    res.on('error', cleanup)
  }

  // ————————————————————————————————————————————————————————————
  // 上游：连 DSH 的事件流（可选；连不上就静默降级）
  // ————————————————————————————————————————————————————————————
  function closeUpstream() {
    if (upstreamReq) {
      try {
        upstreamReq.destroy()
      } catch (e) {}
    }
    if (upstreamRes) {
      try {
        upstreamRes.destroy()
      } catch (e) {}
    }
    upstreamReq = null
    upstreamRes = null
  }

  function setUpstream(base, tokenIn, meta) {
    clearUpstream()
    let u
    try {
      u = new URL(base)
    } catch (e) {
      return false
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    st.upstreamBase = u.origin
    st.upstreamToken = String(tokenIn || '')
    st.upstreamPort = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
    if (meta && Number(meta.port)) st.upstreamPort = Number(meta.port)
    const req = http.request(
      {
        hostname: u.hostname,
        port: Number(u.port) || 80,
        path: '/dsh-pet/events',
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Cookie: 'dsh_pet_desk=' + st.upstreamToken,
          'x-dsh-pet-desk': st.upstreamToken,
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          log('上游 /dsh-pet/events 返回 ' + res.statusCode + '，当作未连接')
          try {
            res.destroy()
          } catch (e) {}
          markOffline('status ' + res.statusCode)
          return
        }
        // ⚠️ 连上以后必须把「连接超时」撤掉。
        // 事件流可能长时间一帧都没有（我这边在等主人说话时就是这样），
        // 而 req.setTimeout 是**socket 空闲**超时 —— 不撤掉就会每 4 秒被我自己的超时踢断，
        // 表现是 upstreamLost 一路往上飙、她每隔几秒「失忆」一次（2026-10-17 用 42 次断线抓到）。
        try {
          req.setTimeout(0)
          res.setTimeout(0)
        } catch (e) {}
        upstreamRes = res
        st.online = true
        log('已连上 DSH：' + st.upstreamBase)
        linkEvent()
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          buf += chunk
          let i
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, i)
            buf = buf.slice(i + 2)
            relayFrame(frame)
          }
          if (buf.length > 512 * 1024) buf = ''
        })
        res.on('end', () => markOffline('end'))
        res.on('close', () => markOffline('close'))
        res.on('error', () => markOffline('error'))
      },
    )
    req.setTimeout(4000, () => {
      try {
        req.destroy(new Error('timeout'))
      } catch (e) {}
    })
    req.on('error', (e) => {
      upstreamReq = null
      markOffline('connect ' + (e && e.message))
    })
    req.end()
    upstreamReq = req
    return true
  }

  /** 解析一帧 SSE（多行 data: 按规范用换行连起来），拿到 JSON 就转发 */
  function relayFrame(frame) {
    const dataLines = []
    for (const line of String(frame).split('\n')) {
      if (!line || line.startsWith(':')) continue
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    if (!dataLines.length) return
    const payload = dataLines.join('\n')
    let obj = null
    try {
      obj = JSON.parse(payload)
    } catch (e) {}
    st.lastFrameAt = Date.now()
    st.framesDown++
    if (obj && obj.t) noteStatusFromEvent(obj)
    broadcastRaw(payload)
  }

  /**
   * 把 DSH 的事件翻成「她忙不忙」。
   * 为什么不能直接读事件里的 status：DSH 推的是 turn-start / tool-call / turn-end 这类**事件名**，
   * 只有 hello 会带一个 status 字段。这里只做粗粒度判断（working / idle），
   * 目的也不是替代前端的 handleEvent，而是让**新连上的页面**在 hello 里拿到一个当下的状态，
   * 不用等下一个事件才知道自己该不该待机。
   */
  const BUSY_EVENTS = new Set([
    'attempt-start', 'tool-draft', 'user', 'turn-start', 'step-start',
    'assistant', 'tool-call', 'tool-result', 'approval',
  ])
  const IDLE_EVENTS = new Set(['turn-end', 'attempt-end'])
  function noteStatusFromEvent(obj) {
    if (typeof obj.status === 'string') {
      st.status = obj.status
      return
    }
    if (BUSY_EVENTS.has(obj.t)) st.status = 'working'
    else if (IDLE_EVENTS.has(obj.t)) st.status = 'idle'
  }

  /** 原样转发（不重新序列化：DSH 那边的字段一个都不该丢） */
  function broadcastRaw(payload) {
    for (const res of clients) {
      try {
        res.write('data: ' + payload + '\n\n')
        st.framesUp++
      } catch (e) {
        clients.delete(res)
      }
    }
    st.clients = clients.size
  }

  function markOffline(why) {
    const was = st.online
    st.online = false
    closeUpstream()
    if (was) {
      st.upstreamLost++
      log('与 DSH 的连接断了（' + why + '），她照常待机')
    }
    st.status = 'idle'
    linkEvent()
  }

  function clearUpstream() {
    if (st.online) markOffline('clear')
    else closeUpstream()
    st.upstreamBase = null
    st.upstreamToken = null
  }

  // ————————————————————————————————————————————————————————————
  // 反向通道：/say /cancel /control /hud → 转发给 DSH
  // ————————————————————————————————————————————————————————————
  const OFFLINE = { ok: false, error: 'offline', message: '现在没连上 DSH' }

  /** 直接向上游要一个 JSON（只读、小、超时短）。ping 用它问「DSH 那边能不能接话」 */
  function upstreamJson(pathname, timeoutMs) {
    return new Promise((resolve, reject) => {
      let u
      try {
        u = new URL(st.upstreamBase)
      } catch (e) {
        return reject(new Error('no upstream'))
      }
      const req2 = http.request(
        {
          hostname: u.hostname,
          port: Number(u.port) || 80,
          path: pathname,
          method: 'GET',
          headers: { cookie: 'dsh_pet_desk=' + st.upstreamToken, accept: 'application/json' },
        },
        (r) => {
          let b = ''
          r.setEncoding('utf8')
          r.on('data', (c) => (b += c))
          r.on('end', () => {
            if ((r.statusCode || 0) !== 200) return reject(new Error('status ' + r.statusCode))
            try {
              resolve(JSON.parse(b))
            } catch (e) {
              reject(new Error('bad json'))
            }
          })
        },
      )
      req2.setTimeout(timeoutMs || 2000, () => {
        try {
          req2.destroy(new Error('timeout'))
        } catch (e) {}
      })
      req2.on('error', reject)
      req2.end()
    })
  }

  /**
   * `/dsh-pet/ping` —— **只读探针**。
   *
   * 为什么要有它（2026-10-17 我踩的那一脚）：
   *   想验「反向通道通不通」时，最自然的写法是打一下 /say —— 但那是**写操作**，
   *   会真的往主人的会话里塞一条消息（还会排队执行）。当时 DSH 里就多了几条「在吗」。
   *   所以专门开一个只读的探针：它能回答「现在能不能说话」，但什么都不发。
   *   ⚠️ 以后写探针一律用它，别再用 /say。
   */
  function handlePing(req, res) {
    if (!st.online) {
      json(res, 200, { ok: true, local: true, online: false, canSay: false, port: null, note: '未连上 DSH' })
      return
    }
    upstreamJson('/dsh-pet/state', 2000).then(
      (j) => {
        json(res, 200, {
          ok: true,
          local: true,
          online: true,
          port: st.upstreamPort,
          canSay: !!(j && j.hasSessionController),
          sessionId: (j && j.sessionId) || null,
          note: '',
        })
      },
      (e) => {
        json(res, 200, {
          ok: true,
          local: true,
          online: true,
          port: st.upstreamPort,
          canSay: null,
          note: 'DSH 的 /state 取不到：' + (e && e.message),
        })
      },
    )
  }

  /**
   * `/dsh-pet/say` 的入口。
   *
   * 除了正常转发，这里多挡一道 `dryRun: true` —— 只校验形状、**不发送**。
   * 为什么在外壳这一层也要挡（插件里也有同样的一道）：
   *   · 外壳是每次调用的必经之路，挡在这儿，下次谁写探针都不会误发；
   *   · 副作用：dryRun 的语义在两处都成立，看着像重复，其实是两层门 —— 别再合并成一处。
   */
  function handleSay(req, res) {
    if (!st.online) {
      json(res, 503, OFFLINE)
      return
    }
    readBody(req, 64 * 1024).then(
      (body) => {
        let parsed = null
        try {
          parsed = JSON.parse(body)
        } catch (e) {}
        if (parsed && parsed.dryRun === true) {
          json(res, 200, {
            ok: true,
            dryRun: true,
            wouldSend: String(parsed.text || '').trim().length,
            note: '只校验形状，没有发送',
          })
          return
        }
        proxy(req, res, '/dsh-pet/say', body)
      },
      () => json(res, 400, { ok: false, error: 'bad body' }),
    )
  }

  /** 读请求正文（有小上限，避免被灌爆） */
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size > limit) {
          reject(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  function proxy(req, res, pathname, body) {
    if (!st.online) {
      json(res, 503, OFFLINE)
      return
    }
    let u
    try {
      u = new URL(st.upstreamBase)
    } catch (e) {
      json(res, 503, OFFLINE)
      return
    }
    const headers = {}
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type']
    if (req.headers.accept) headers.accept = req.headers.accept
    if (st.upstreamToken) headers.cookie = 'dsh_pet_desk=' + st.upstreamToken
    const q = req.url.indexOf('?')
    const up = http.request(
      {
        hostname: u.hostname,
        port: Number(u.port) || 80,
        path: pathname + (q >= 0 ? req.url.slice(q) : ''),
        method: req.method,
        headers,
      },
      (r) => {
        const out = {}
        for (const k of ['content-type', 'cache-control', 'content-length']) {
          if (r.headers[k]) out[k] = r.headers[k]
        }
        res.writeHead(r.statusCode || 502, out)
        r.pipe(res)
      },
    )
    up.setTimeout(20000, () => {
      try {
        up.destroy(new Error('timeout'))
      } catch (e) {}
    })
    up.on('error', () => {
      // ⚠️ 这里**不** markOffline：一次 /say 失败不代表事件流断了。
      // 上游死活的唯一判据是那条 SSE（unreachable 时它自己会 end/error）。
      if (!res.headersSent) json(res, 503, OFFLINE)
      else {
        try {
          res.destroy()
        } catch (e) {}
      }
    })
    if (body !== undefined) up.end(body)
    else if (req.method === 'GET' || req.method === 'HEAD') up.end()
    else req.pipe(up)
  }

  // ————————————————————————————————————————————————————————————
  // 总入口
  // ————————————————————————————————————————————————————————————
  function route(req, res) {
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1')
    } catch (e) {
      res.writeHead(400).end()
      return
    }
    const pathname = url.pathname

    // ① 信任栅栏：Host / Origin / 令牌，三关都要过
    if (!hostOk(req, st.port)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('forbidden host')
      return
    }
    if (!originOk(req, st.port)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('forbidden origin')
      return
    }
    const hasToken = cookieOf(req, 'dsh_pet_local') === token
    if (!hasToken) {
      // 唯一例外：页面首次加载带上 ?k=<令牌>，通过后写 cookie（之后就靠 cookie）
      if (pathname === '/dsh-pet/standalone' && url.searchParams.get('k') === token) {
        res.setHeader('Set-Cookie', 'dsh_pet_local=' + token + '; Path=/; HttpOnly; SameSite=Strict')
      } else {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('forbidden token')
        return
      }
    }

    const kind = handles(pathname)
    if (!kind) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found: ' + pathname + '\n路由表见 petserver.js 的 ROUTES')
      return
    }
    try {
      switch (kind) {
        case 'page':
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' })
          res.end(standalonePage({ title: 'DS 鲸鱼娘 · 桌宠' }))
          return
        case 'script':
          handlePetJs(req, res)
          return
        case 'config':
          json(res, 200, { local: true, version, config: userConfig() })
          return
        case 'state':
          json(res, 200, {
            ok: true,
            local: true,
            version,
            online: st.online,
            upstream: st.upstreamBase,
            upstreamPort: st.upstreamPort,
            status: st.status,
            clients: st.clients,
            framesDown: st.framesDown,
            framesUp: st.framesUp,
            upstreamLost: st.upstreamLost,
            lastFrameAt: st.lastFrameAt,
            assetRoots,
            lastServedFrom: st.lastServedFrom,
          })
          return
        case 'sse':
          handleEvents(req, res)
          return
        case 'ping':
          handlePing(req, res)
          return
        case 'proxy':
          if (pathname === '/dsh-pet/say') handleSay(req, res)
          else proxy(req, res, pathname)
          return
        case 'static': {
          const isVendor = pathname.startsWith('/dsh-pet/vendor/')
          const prefix = isVendor ? '/dsh-pet/vendor/' : '/dsh-pet/model/'
          const rel = pathname.slice(prefix.length)
          const abs = findAsset(path.posix.join(isVendor ? 'vendor' : 'model', rel))
          if (!abs) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('not found: ' + pathname)
            return
          }
          serveFile(req, res, abs, 'no-cache')
          return
        }
        default:
          res.writeHead(500).end()
      }
    } catch (e) {
      log('处理 ' + pathname + ' 出错：' + (e && e.stack ? e.stack : e))
      try {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('local server error: ' + (e && e.message))
      } catch (err) {}
    }
  }

  /** 起服务。port 传 0 = 系统分配。返回 Promise<{port, token}> */
  function listen(port) {
    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => route(req, res))
      const onErr = (e) => {
        server = null
        reject(e)
      }
      server.on('error', onErr)
      server.listen(port === undefined ? 0 : port, host, () => {
        server.removeListener('error', onErr)
        st.port = server.address().port
        log('本地服务已就绪：http://' + host + ':' + st.port + '/dsh-pet/standalone（资源根：' + assetRoots.join(' | ') + '）')
        resolve({ port: st.port, token })
      })
    })
  }

  /** 优雅收尾：断上游、关客户端、关服务 */
  function close() {
    for (const res of clients) {
      try {
        res.end()
      } catch (e) {}
    }
    clients.clear()
    st.clients = 0
    closeUpstream()
    return new Promise((resolve) => {
      if (!server) return resolve()
      const s = server
      server = null
      s.close(() => resolve())
    })
  }

  return {
    listen,
    close,
    setUpstream,
    clearUpstream,
    state: () => Object.assign({}, st, { clients: clients.size, assetRoots: assetRoots.slice() }),
    /** 给外壳用：往页面推一条本地事件（比如「没连上 DSH」的提示） */
    push: (obj) => broadcast(obj),
    url: (extra) => 'http://' + host + ':' + st.port + '/dsh-pet/standalone' + (extra || ''),
    token: () => token,
  }
}

module.exports = { createPetServer, handles, ROUTES, MIME, standalonePage }
