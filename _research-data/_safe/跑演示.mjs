import { connect } from './cdp.mjs'
const c = await connect(9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await c.evaluate('DSHPet.sensorDemo()')
let res = null
for (let i = 0; i < 45; i++) {
  await sleep(1000)
  try { res = await c.evaluate('DSHPet.sensorDemoResult()') } catch (e) {}
  if (res && res.ok) break
}
console.log('演示结果:', JSON.stringify(res))
c.close()
