const { contextBridge, ipcRenderer } = require('electron')

// 命中窗只做一件事：把真实 pointer 的屏幕/客户区坐标交给主进程。
// 渲染窗是纯视图，由主进程用 sendInputEvent 注入；这样 pet.js 的现有处理器不用改。
contextBridge.exposeInMainWorld('hitAPI', {
  down: (p) => ipcRenderer.send('hit:down', p),
  move: (p) => ipcRenderer.send('hit:move', p),
  up: (p) => ipcRenderer.send('hit:up', p),
  dragStart: (p) => ipcRenderer.send('hit:drag-start', p),
  dragEnd: (p) => ipcRenderer.send('hit:drag-end', p),
  contextMenu: (p) => ipcRenderer.send('hit:contextmenu', p),
  leave: () => ipcRenderer.send('hit:leave'),
  wheel: (p) => ipcRenderer.send('hit:wheel', p),
  cancel: () => ipcRenderer.send('hit:cancel'),
  onVisibility: (cb) => ipcRenderer.on('hit:visibility', (_e, v) => cb(!!v)),
})
