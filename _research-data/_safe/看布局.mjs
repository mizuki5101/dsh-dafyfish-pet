import { connect } from './cdp.mjs'
const c = await connect(9222)
const info = await c.evaluate("(function(){ var r=document.querySelector('.dshp-root'); var cs=getComputedStyle(r); return { layout: JSON.parse(localStorage.getItem('dsh-live2d-pet:layout')||'{}'), insetX: r.style.getPropertyValue('--dshp-inset-x'), insetY: r.style.getPropertyValue('--dshp-inset-y'), rootRect: (function(b){return {left:Math.round(b.left),top:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height)}})(r.getBoundingClientRect()), vw: window.innerWidth, vh: window.innerHeight, contentBox: DSHPet.state.contentBox, modelSize: DSHPet.state.modelSize, view: DSHPet.state.view } })()")
console.log(JSON.stringify(info, null, 1))
c.close()
