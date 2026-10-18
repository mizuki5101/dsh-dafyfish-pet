// 预加载脚本：给网页搭一座桥，让 Windows 版和 macOS 版**用同一套前端协议**。
//
// 关键点：前端 pet.js 里判断「我在不在桌面壳里」靠两个东西 ——
//   window.__DSHPET_SHELL__ 和 window.webkit.messageHandlers.dshpetshell.postMessage()
// 这俩是 macOS(WKWebView) 的原生接口。Electron 里没有，所以这里**照着原样补一个**，
// 于是前端一行都不用改，桌面壳里该有的行为（收起成小球、设置页多两项、打开 DSH）自动就有。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__DSHPET_SHELL__', true)
contextBridge.exposeInMainWorld('webkit', {
  messageHandlers: {
    dshpetshell: {
      postMessage: (msg) => ipcRenderer.send('shell-msg', String(msg)),
    },
  },
})
// 提示页用的桥（DSH 没起来时那张卡片上的两个按钮）
contextBridge.exposeInMainWorld('dshpetBridge', {
  install: () => ipcRenderer.send('install-plugin'),
  reload: () => ipcRenderer.send('reload'),
  ballMove: (dx, dy) => ipcRenderer.send('ball-move', dx, dy),
  ballDrop: (moved) => ipcRenderer.send('ball-drop', moved),
  // 心跳（P0：只有眼睛）。模型配置/采图都在主进程，页面只拿到「结果」，
  // 这样 baseUrl/apiKey 不会出现在页面上下文里，页面也没法把图发去别处。
  heart: {
    status: () => ipcRenderer.invoke('heart:status'),
    capture: (opts) => ipcRenderer.invoke('heart:capture', opts || {}),
    // 调试/验收用：跑一遍完整链路（拍 → 模型 → 仲裁 → 页面），或只列可用端点
    tick: (opts) => ipcRenderer.invoke('heart:tick', opts || {}),
    providers: () => ipcRenderer.invoke('heart:providers'),
    act: (payload) => ipcRenderer.invoke('heart:act', payload || {}),
    // 设置面板「心跳」页：读配置 / 存配置 / 一键启停本地模型
    settings: () => ipcRenderer.invoke('heart:settings'),
    save: (patch) => ipcRenderer.invoke('heart:save', patch || {}),
    model: (action) => ipcRenderer.invoke('heart:model', { action: action || 'status' }),
    // 回应模式：对话按钮直接问聊天模型（带最近 12 轮记忆）
    chat: (payload) => ipcRenderer.invoke('heart:chat', payload || {}),
    clearChat: () => ipcRenderer.invoke('heart:chat-clear'),
  },
})

// 拖动：页面里按下她 → 告诉主进程搬窗口（主进程只在鼠标确实压在她身上时才搬，
// 压在面板上时放行给网页，所以设置里的滑块照样能拖）
window.addEventListener('mousedown', (e) => {
  if (e.button === 0) ipcRenderer.send('drag-start', { x: e.screenX, y: e.screenY })
}, true)
window.addEventListener('mouseup', () => ipcRenderer.send('drag-end'), true)
