'use strict'

// 识图遮罩窗的桥：只暴露两个方法，别的什么都不给（遮罩是临时窗口，不该能碰主进程的其它东西）。

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('shotAPI', {
  rect: (r) => ipcRenderer.invoke('shot:rect', r || {}),
  cancel: (reason) => ipcRenderer.invoke('shot:cancel', { reason: String(reason || '') }),
  // 遮罩窗是**复用**的（每次只 hide/show）：再次弹出时必须把上一次的 done/框复位，
  // 否则第二次 Shift+右击会完全没反应。
  onReset: (cb) => ipcRenderer.on('shot:reset', () => {
    try {
      cb()
    } catch (e) {}
  }),
})
