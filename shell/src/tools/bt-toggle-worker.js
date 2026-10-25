'use strict'

// 「强制刷新电量」的执行体 —— 单独放在 **worker 线程**里跑。
//
// 为什么不能直接在主进程调：`BluetoothSetServiceState` 关一次再开一次**同步阻塞约 6 秒**
// （实测 6271ms，等链路拆干净才返回）。放主进程里会让整个外壳卡 6 秒：
// 拖她、命中判定、置顶维护的定时器全被冻住。worker 有自己的事件循环，
// 主线程这边只是"等一个消息"，照常跑。
//
// 通信：workerData 传 { nameHint }，postMessage 回 keys.btForceRefresh() 的结果。
const { parentPort, workerData } = require('node:worker_threads')
const keys = require('../native/keys')

let r
try {
  r = keys.btForceRefresh({ nameHint: (workerData && workerData.nameHint) || '' })
} catch (e) {
  r = { ok: false, reason: 'error:' + ((e && e.message) || e) }
}
try {
  parentPort.postMessage(r)
} catch (e) {}
