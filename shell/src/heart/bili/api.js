'use strict'
// B 站只读接口：首页推荐 / 视频详情 / 热门评论 / 播放直链 / 字幕轨。
//
// 2026-10-20 实测：**这五个里前四个匿名就能用**（不需要 cookie、不需要登录）
//   rcmd    → code 0，ps=6 拿到 6 条
//   view    → code 0，aid/cid/duration/stat/desc 齐全
//   reply   → code 0，sort=2 是「按热度」，匿名可读
//   playurl → code 0，qn=32 回 360P mp4 直链，HTTP 206 Range 可用（抽帧靠它）
// 字幕轨（player/v2 的 data.subtitle）匿名返回空数组 —— 未确认是「这条没字幕」
// 还是「未登录不给」，所以本模块把它做成**可选**：有 cookie 就用，没有就降级。
//
// 设计约束：
//   · 只 GET，绝不写（不评论/不点赞/不投币）—— 风险面最小；
//   · 所有请求带 UA + referer，限流 1 次/秒以下（由调用方控制节奏）；
//   · 解析全部拆成纯函数，网络失败只返回 {ok:false}，不抛。

const crypto = require('node:crypto')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REFER = 'https://www.bilibili.com/'
const API = 'https://api.bilibili.com'

/** 可选凭据（有就带上，没有也能跑）——与 bili-whale 共用一个文件，免得填两遍 */
function readCred(env) {
  try {
    const fs = require('node:fs')
    const path = require('node:path')
    const home = (env && env.USERPROFILE) || process.env.USERPROFILE || process.env.HOME || ''
    const p = path.join(home, '.bili-ai', 'credentials.json')
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const parts = []
    if (j.sessdata) parts.push('SESSDATA=' + j.sessdata)
    if (j.bili_jct) parts.push('bili_jct=' + j.bili_jct)
    if (j.buvid3) parts.push('buvid3=' + j.buvid3)
    return parts.length ? parts.join('; ') : ''
  } catch (e) {
    return ''
  }
}

async function getJson(url, opts) {
  const o = opts || {}
  const headers = { 'user-agent': UA, referer: REFER, accept: 'application/json' }
  if (o.cookie) headers.cookie = o.cookie
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), Math.max(2000, Number(o.timeoutMs) || 12000))
  try {
    const r = await fetch(url, { headers, signal: ac.signal })
    if (!r.ok) return { ok: false, error: 'http ' + r.status, status: r.status }
    const j = await r.json()
    if (!j || j.code !== 0) return { ok: false, error: (j && (j.message || j.code)) || 'bad-json', code: j && j.code }
    return { ok: true, data: j.data }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  } finally {
    clearTimeout(timer)
  }
}

/* ───────────── 纯解析 ───────────── */

/** 推荐流 → 候选列表。只要「能判断值不值得看」的字段 */
function parseRcmd(data) {
  const list = (data && data.item) || []
  const out = []
  for (const v of list) {
    if (!v || !v.bvid || v.is_ad || v.goto === 'ad') continue
    out.push({
      bvid: String(v.bvid),
      title: clean(v.title),
      up: clean(v.owner && v.owner.name),
      duration: Number(v.duration) || 0,
      desc: clean(v.desc).slice(0, 200),
      view: Number(v.stat && v.stat.view) || 0,
      like: Number(v.stat && v.stat.like) || 0,
      pubdate: Number(v.pubdate) || 0,
    })
  }
  return out
}

/** 详情 → 抽帧和字幕要用的东西 */
function parseView(data) {
  if (!data || !data.bvid) return null
  return {
    bvid: String(data.bvid),
    aid: Number(data.aid) || 0,
    cid: Number(data.cid) || 0,
    title: clean(data.title),
    desc: clean(data.desc).slice(0, 800),
    duration: Number(data.duration) || 0,
    up: clean(data.owner && data.owner.name),
    view: Number(data.stat && data.stat.view) || 0,
    like: Number(data.stat && data.stat.like) || 0,
    pages: Array.isArray(data.pages) ? data.pages.length : 1,
    pic: String(data.pic || ''),
  }
}

/** 评论（sort=2 是热度）→ 前 n 条纯文本 */
function parseReplies(data, n) {
  const arr = (data && data.replies) || []
  const max = Math.max(0, Number(n) || 2)
  const out = []
  for (const r of arr) {
    const txt = clean(r && r.content && r.content.message)
    if (!txt) continue
    out.push({ text: txt.slice(0, 300), like: Number(r.like) || 0 })
    if (out.length >= max) break
  }
  return out
}

/** 播放直链：优先 durl（mp4 整段），没有就取 dash 的第一条视频流 */
function parsePlayUrl(data) {
  if (!data) return null
  const d = data.durl && data.durl[0]
  if (d && d.url) return { url: String(d.url), quality: Number(data.quality) || 0, size: Number(d.size) || 0, kind: 'durl' }
  const v = data.dash && data.dash.video && data.dash.video[0]
  if (v && v.baseUrl) return { url: String(v.baseUrl), quality: Number(v.id) || 0, size: Number(v.size) || 0, kind: 'dash' }
  return null
}

/** 字幕轨：拿第一条有 url 的（通常是中文） */
function parseSubtitle(data) {
  const subs = (data && data.subtitle && data.subtitle.subtitles) || []
  for (const s of subs) {
    const u = String((s && s.subtitle_url) || '')
    if (!u) continue
    return { url: u.startsWith('//') ? 'https:' + u : u, lan: String((s && s.lan) || '') }
  }
  return null
}

/** 字幕 JSON（body 里是 {from,to,content} 数组）→ 按句拼成可读文本 */
function parseSubtitleBody(body) {
  const list = (body && body.body) || []
  const out = []
  for (const s of list) {
    const c = String((s && s.content) || '').replace(/\s+/g, ' ').trim()
    if (c) out.push(c)
  }
  return out.join(' ').replace(/\s+/g, ' ').trim()
}

function clean(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim()
}

/* ───────────── wbi 签名（搜索接口要） ─────────────
 * 2026-10-20 实测：nav 未登录返回 code -101，但 data.wbi_img 照样给 ⇒ **不需要登录**。
 * 算法：img_key + sub_key 取前 32 位打乱表重排 → mixinKey；
 *      URL 参数排序拼接（值里 !'()* 要剔掉）+ wts + mixinKey 的 md5 = w_rid。
 * 缓存 1 小时（key 一天才换一次，跑太勤容易被盯上）。
 */
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]
let wbiCache = { at: 0, key: '' }

async function getRaw(url, opts) {
  const o = opts || {}
  const headers = { 'user-agent': UA, referer: REFER, accept: 'application/json' }
  if (o.cookie) headers.cookie = o.cookie
  try {
    const r = await fetch(url, { headers })
    if (!r.ok) return { ok: false, error: 'http ' + r.status }
    return { ok: true, j: await r.json() }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

async function mixinKey(o) {
  const now = Date.now()
  if (wbiCache.key && now - wbiCache.at < 3600e3) return wbiCache.key
  const r = await getRaw(API + '/x/web-interface/nav', o)
  const img = r.ok && r.j && r.j.data && r.j.data.wbi_img
  if (!img || !img.img_url || !img.sub_url) return ''
  const base = (u) => String(u).split('/').pop().split('.')[0]
  const raw = base(img.img_url) + base(img.sub_url)
  if (raw.length < 64) return ''
  const key = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
  wbiCache = { at: now, key }
  return key
}

/** 参数 → 带 w_rid 的查询串 */
function signQuery(params, key, wts) {
  const p = Object.assign({}, params, { wts: wts || Math.floor(Date.now() / 1000) })
  const q = Object.keys(p)
    .sort()
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(p[k]).replace(/[!'()*]/g, '')))
    .join('&')
  const w = crypto.createHash('md5').update(q + key).digest('hex')
  return q + '&w_rid=' + w
}

/** 搜索结果 → 和 parseRcmd 一样的候选结构（标题去掉 <em> 高亮标签） */
function parseSearch(data, n) {
  const list = (data && data.result) || []
  const max = Math.max(1, Number(n) || 5)
  const out = []
  for (const v of list) {
    if (!v || !v.bvid) continue
    out.push({
      bvid: String(v.bvid),
      title: clean(String(v.title || '').replace(/<[^>]+>/g, '')),
      up: clean(v.author),
      duration: parseClock(v.duration),
      desc: clean(v.description).slice(0, 200),
      view: Number(v.play) || 0,
      like: Number(v.like) || 0,
      pubdate: Number(v.pubdate) || 0,
      part: clean(v.typename),
    })
    if (out.length >= max) break
  }
  return out
}

/** 搜索接口的时长是 "7:42" / "1:02:03" 这种字符串 */
function parseClock(v) {
  const s = String(v == null ? '' : v).trim()
  if (!s) return 0
  if (/^\d+$/.test(s)) return Number(s)
  const parts = s.split(':').map((x) => Number(x) || 0)
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return 0
}

/* ───────────── 网络封装 ───────────── */

/** 首页推荐流（匿名可用） */
async function rcmd(ps, o) {
  const n = Math.max(1, Math.min(20, Number(ps) || 8))
  const url =
    API +
    '/x/web-interface/index/top/feed/rcmd?ps=' + n +
    '&fresh_idx=1&fresh_type=3&feed_version=V8&web_location=1430650'
  const r = await getJson(url, o)
  return r.ok ? { ok: true, list: parseRcmd(r.data) } : r
}

/**
 * 关键词检索（比首页推荐相关得多，也能避开「推荐流塞不感兴趣的东西」）。
 * 需要 wbi 签名，但**不需要登录**。
 * @param {string} keyword
 * @param {number} ps 取几条（默认 5：够粗筛，又不至于每次烧 5 条详情）
 */
async function search(keyword, ps, o) {
  const kw = clean(keyword)
  if (!kw) return { ok: false, error: 'no-keyword' }
  const n = Math.max(1, Math.min(20, Number(ps) || 5))
  const key = await mixinKey(o)
  if (!key) return { ok: false, error: 'no-wbi-key' }
  const q = signQuery({ search_type: 'video', keyword: kw, page: 1, page_size: n, order: 'totalrank' }, key)
  const r = await getJson(API + '/x/web-interface/wbi/search/type?' + q, o)
  if (!r.ok) return r
  const list = parseSearch(r.data, n)
  return list.length ? { ok: true, list, keyword: kw } : { ok: false, error: 'no-result', keyword: kw }
}

async function view(bvid, o) {  const r = await getJson(API + '/x/web-interface/view?bvid=' + encodeURIComponent(bvid), o)
  if (!r.ok) return r
  const v = parseView(r.data)
  return v ? { ok: true, video: v } : { ok: false, error: 'view-empty' }
}

async function replies(aid, ps, o) {
  const n = Math.max(0, Math.min(20, Number(ps) || 2))
  if (!aid || n === 0) return { ok: true, list: [] }
  const url = API + '/x/v2/reply?type=1&oid=' + aid + '&sort=2&ps=' + n + '&pn=1'
  const r = await getJson(url, o)
  return r.ok ? { ok: true, list: parseReplies(r.data, n) } : r
}

async function playUrl(bvid, cid, o) {
  const url = API + '/x/player/playurl?bvid=' + encodeURIComponent(bvid) + '&cid=' + cid + '&qn=32&fnval=1&fourk=0'
  const r = await getJson(url, o)
  if (!r.ok) return r
  const p = parsePlayUrl(r.data)
  return p ? { ok: true, play: p } : { ok: false, error: 'no-playurl' }
}

/** 字幕轨（很可能需要登录；没有就返回 ok:false，调用方降级） */
async function subtitleTrack(bvid, cid, o) {
  const url = API + '/x/player/v2?bvid=' + encodeURIComponent(bvid) + '&cid=' + cid
  const r = await getJson(url, o)
  if (!r.ok) return r
  const s = parseSubtitle(r.data)
  return s ? { ok: true, sub: s } : { ok: false, error: 'no-subtitle-track' }
}

async function subtitleText(url, o) {
  const r = await getJson(url, o)
  if (!r.ok) return r
  return { ok: true, text: parseSubtitleBody(r.data) }
}

module.exports = {
  rcmd, search, view, replies, playUrl, subtitleTrack, subtitleText,
  parseRcmd, parseSearch, parseView, parseReplies, parsePlayUrl, parseSubtitle, parseSubtitleBody,
  parseClock, signQuery, mixinKey,
  readCred, UA, REFER,
}
