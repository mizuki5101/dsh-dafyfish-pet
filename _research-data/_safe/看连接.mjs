/** 小探针：她现在认为 agent 是什么状态、事件流收到多少帧、本地服务怎么说。
 *  用法：node _research-data/_safe/看连接.mjs [调试口] */
import { connect } from './cdp.mjs'

const c = await connect(Number(process.argv[2] || 9222))
const agent = await c.evaluate('DSHPet.state.agent')
console.log('页面 agent   =', JSON.stringify(agent))
console.log('页面 link    =', JSON.stringify(await c.evaluate('DSHPet.linkState()')))
console.log('boot         =', JSON.stringify(await c.evaluate('({local:DSHPet.boot().local, upstream:DSHPet.boot().upstream})')))
const raw = await c.call('Runtime.evaluate', {
  expression: "fetch('/dsh-pet/state').then(r=>r.json()).then(j=>JSON.stringify(j))",
  returnByValue: true,
  awaitPromise: true,
})
console.log('本地服务态   =', raw.result.value)
c.close()
