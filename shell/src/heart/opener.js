'use strict'
// 看屏幕前的「开场白」。
//
// 为什么要有：她盯屏幕这件事本身是看不见的（截图在后台发生），主人只会突然收到一句评论，
// 有时会觉得莫名其妙。先冒一句「让我看看主人在干嘛～」既解释了行为，又给了模型一个话头。
// 这句会**一起发给模型**（prompt.buildMessages 的 opener 参数），所以它接得上。

const OPENERS = [
  '让我看看主人在干嘛～',
  '主人在忙吗，我来看看……',
  '偷偷瞄一眼…',
  '嗯…屏幕上有什么呢？',
  '看看主人又在摸鱼没～',
  '凑近看看～',
]

function pickOpener(rand, list) {
  const arr = Array.isArray(list) && list.length ? list : OPENERS
  const r = typeof rand === 'function' ? rand : Math.random
  const i = Math.floor(r() * arr.length)
  return arr[Math.max(0, Math.min(arr.length - 1, i))]
}

module.exports = { OPENERS, pickOpener }
