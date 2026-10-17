import { connect } from './cdp.mjs'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const c = await connect(9222)
// 重新加载页面，量「页面开始 → 模型就绪」多久（29MB 贴图的真实代价）
await c.call('Runtime.evaluate', { expression: 'location.reload()' })
const t0 = Date.now()
let ready = 0
let size = null
for (let i = 0; i < 60; i++) {
  await sleep(200)
  try {
    size = await c.evaluate('(window.DSHPet && DSHPet.state && DSHPet.state.modelSize) || null')
  } catch (e) {
    size = null
  }
  if (size) { ready = Date.now() - t0; break }
}
console.log('从 reload 到模型就绪：' + (ready / 1000).toFixed(2) + ' 秒')
console.log('画布：' + (size ? Math.round(size.w) + '×' + Math.round(size.h) : '没出来'))
const timing = await c.evaluate("(function(){ try { var e = performance.getEntriesByType('resource').filter(function(x){ return /texture_00|moc3|physics3|cdi3/.test(x.name) }); return e.map(function(x){ return { f: x.name.split('/').pop(), ms: Math.round(x.duration), kb: Math.round((x.transferSize||x.encodedBodySize||0)/1024) } }) } catch (err) { return [] } })()")
console.log('关键资源：')
for (const t of timing || []) console.log('  ' + t.f + '  ' + t.kb + ' KB  ' + t.ms + ' ms')
const mem = await c.evaluate('(window.performance && performance.memory) ? Math.round(performance.memory.usedJSHeapSize/1048576) : null')
console.log('JS 堆占用：' + mem + ' MB')
c.close()
