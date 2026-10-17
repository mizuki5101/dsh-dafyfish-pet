# dsh-pet-live2d-local

这是「大肥鱼桌宠」的 DSH 插件部分 —— 后端（`lib/index.js`）+ 前端（`assets/pet.js`）+ 模型配置。

**完整说明看根目录的 [README.md](../README.md)**（安装、模型获取、测试、许可）。

上游版本（鲸鱼娘）的 README 原样保留在 [README.upstream.md](README.upstream.md)。

## 这个插件负责什么

1. 静态资源：把 Live2D 运行时、模型、前端脚本挂到 DSH Web 的 `/dsh-pet/*`
2. 事件桥：把 agent 的真实活动（轮次 / 思考 / 工具 / 逐字输出 / 结束）用 SSE 推给桌宠
3. 反向通道：桌宠输入框的文字经 `sessionController.prompt` 送回会话（`/dsh-pet/say`，支持 `dryRun`）
4. 把桌面外壳拉起来（DSH 启动时，已在跑就不重复开）

## 注意

- 改 `lib/index.js` 必须**重启 DSH** 才生效
- 改 `assets/pet.js` 只需**重启外壳**
- **模型文件不在本仓库里**：先跑 `node tools/check-model.mjs` 看看缺什么
