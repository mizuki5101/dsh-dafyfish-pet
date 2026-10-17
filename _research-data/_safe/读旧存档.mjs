/** 一次性迁移：把旧 origin（DSH 19387）里的桌宠 localStorage 存档读出来。
 *  为什么需要：独立外壳把页面搬到 127.0.0.1:<本地端口>，origin 变了 → localStorage 是空的，
 *  主人调过的大小/位置/灵动度会全丢。读出来交给新服务做种（seed）。
 *  用法：node _research-data/_safe/读旧存档.mjs [端口] [输出文件]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connect } from './cdp.mjs'

const port = Number(process.argv[2] || 9222)
const out = process.argv[3] || path.join(process.env.APPDATA || os.homedir(), 'DS-WhaleGirl-Pet', 'layout-seed.json')

const c = await connect(port)
const url = c.page.url
const raw = await c.evaluate("localStorage.getItem('dsh-live2d-pet:layout')")
const keys = await c.evaluate('Object.keys(localStorage)')
c.close()

const text = typeof raw === 'string' ? raw : null
console.log('页面:', url)
console.log('localStorage 键:', JSON.stringify(keys))
console.log('存档长度:', text ? text.length : 0)
if (text) {
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, text, 'utf8')
  console.log('已写出:', out)
  console.log('内容:', text.slice(0, 400))
}
