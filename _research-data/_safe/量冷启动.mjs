import { connect } from './cdp.mjs'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const c = await connect(9222)
// 冷加载：忽略缓存重新拉一遍（这是「第一次开她」的真实代价）
await c.call('Page.enable', {})
const t0 = Date.now()
await c.call('Page.reload', { ignoreCache: true })
let ready = 0
for (let i = 0; i < 80; i++) {
  await sleep(150)
  try {
    const s = await c.evaluate('(window.DSHPet && DSHPet.state && DSHPet.state.modelSize) || null')
    if (s) { ready = Date.now() - t0; break }
  } catch (e) {}
}
console.log('冷启动（忽略缓存）→ 模型就绪：' + (ready / 1000).toFixed(2) + ' 秒')
const timing = await c.evaluate("(function(){ try { return performance.getEntriesByType('resource').filter(function(x){ return /texture_00|moc3/.test(x.name) }).map(function(x){ return { f: x.name.split('/').pop(), ms: Math.round(x.duration), kb: Math.round((x.transferSize||x.encodedBodySize||0)/1024) } }) } catch (err) { return [] } })()")
for (const t of timing || []) console.log('  ' + t.f + '  ' + t.kb + ' KB  ' + t.ms + ' ms')
c.close()
