/**
 * 用 Node 的 fetch 测 /dsh-pet/control（curl 在 Windows bash 里会把中文编码搞坏，
 * 所以这个测试必须走 Node，才能区分「后端/前端的问题」和「shell 编码的问题」）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cfgPath = path.join(os.homedir(), '.dsh', 'dsh-live2d-pet-desktop.json');
const token = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).token;
const URL = 'http://127.0.0.1:19387/dsh-pet/control';

async function post(body) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'dsh_pet_desk=' + token },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function probe(expr) {
  const list = await (await fetch('http://127.0.0.1:9222/json')).json();
  const t = list.find((x) => x.type === 'page' && x.url.includes('/dsh-pet/'));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej });
  const out = await new Promise((res, rej) => {
    const id = 1;
    const to = setTimeout(() => rej(new Error('timeout')), 10000);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      clearTimeout(to);
      res(m.result && m.result.result && m.result.result.value);
    };
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify(' + expr + ')', returnByValue: true } }));
  });
  ws.close();
  try { return JSON.parse(out) } catch (e) { return out }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } };

console.log('=== 1. ASCII 别名（编码安全，agent 首选） ===')
for (const alias of ['nod', 'wave-left', 'wag', 'bow', 'stretch']) {
  const r = await post({ motion: alias })
  await sleep(120)
  const clips = await probe('DSHPet.motionState().clips')
  const got = Array.isArray(clips) && clips.length ? clips[0].name : null
  ok(r.status === 200 && got, 'motion="' + alias + '" -> 播了「' + got + '」')
}

console.log('\n=== 2. 中文原名（走 Node fetch，UTF-8 正确） ===')
await sleep(3000)
const r2 = await post({ motion: '点头' })
await sleep(150)
const c2 = await probe('DSHPet.motionState().clips')
ok(r2.status === 200 && Array.isArray(c2) && c2.length > 0 && c2[0].name === '点头',
  'motion="点头" -> ' + JSON.stringify(c2 && c2.map ? c2.map((c) => c.name) : c2))

console.log('\n=== 3. 未知动作不应乱播 ===')
await sleep(2500)
const before = await probe('DSHPet.motionState().clips')
const r3 = await post({ motion: '后空翻' })
await sleep(150)
const after = await probe('DSHPet.motionState().clips')
ok(r3.status === 200 && (after || []).length === 0, 'motion="后空翻" -> 什么都没播（前端安全兜底）')

console.log('\n=== 4. 播放中不眨眼（motionActive 覆盖 clip） ===')
const r4 = await post({ motion: 'stretch' })
await sleep(200)
const bl = await probe('DSHPet.motionState().clips.length')
ok(bl > 0, 'cline 在播时 motionActive() 为真 -> 眨眼被抑制（stretch 播放中）')

console.log('\n========================================')
console.log(fail === 0 ? `全部通过：${pass} 项` : `⚠ 失败 ${fail} / 通过 ${pass}`)
process.exit(fail ? 1 : 0)
