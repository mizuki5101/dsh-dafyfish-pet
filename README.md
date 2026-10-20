# 大肥鱼桌宠 · Live2D 桌面宠物（DSH 插件 + 独立外壳）

一个常驻桌面的 Live2D 桌宠。她会呼吸、会换表情、会自己找点事做；
你在 DSH 里干活时她会跟着切换状态（思考 / 调用工具 / 说话），**说话时脸会跟着语气变**。

**她可以完全独立运行**：DSH 没开的时候她照常在桌面上待机，只失去「对话」这一块；
DSH 开起来之后 8 秒内自动连上，不需要重启她。

> ⚠️ **本仓库不含任何 Live2D 模型文件**。模型版权归原作者，请自己获取（见下方「第 1 步」）。
> ⚠️ **非官方**：不是 DeepSeek 官方产品，也不是上游插件的官方分支（见文末「来源与致谢」）。
> ⚠️ **非商业**：本项目不收费、不带货、不接广告。这是上面几份许可唯一能同时满足的用法。

---

## 维护状态（请先看这段）

这是一个**个人练手项目**：作者不是专业开发者，代码基本是「和 AI 一起写出来的」，
**没有能力、也没有精力做长期维护**。所以先说清楚，免得你写了详细的报告却石沉大海：

| | |
|---|---|
| 🐢 Issue | **不一定回**（尤其是「能不能加个功能」这类） |
| 🐢 PR | **不一定会合**（太复杂/看不懂的改动作者 review 不了） |
| 🐢 更新 | **不定期** —— 可能几个月只修自己遇到的 bug |

**这不代表你不重要**，只是提前说清，省得你期待落空。真想要改动时，更靠谱的是：

1. **Fork 一份自己改** —— 代码是 MIT，随便改，不用问作者
2. 改好了**欢迎提 PR**，但请写清「为什么改 + 怎么验证」（见 [CONTRIBUTING.md](CONTRIBUTING.md)）
3. 只是想要某个新功能：**自己加，比等作者快**

> **Maintenance status (EN)**: This is a personal hobby project, not a maintained library.
> The author is not a professional developer and has no bandwidth for long-term maintenance.
> Issues **may not be answered**, PRs **may not be reviewed or merged**, updates are **irregular**.
> The code is MIT — please **fork and modify freely** instead of waiting.
> If your issue gets no reply, it is not personal: it is most likely unseen or simply beyond the author's ability.

---

## 特性

| | |
|---|---|
| **独立运行** | 页面 / 前端 / Live2D 运行时 / 模型都由外壳自己的本地服务提供（`127.0.0.1:19400`）。DSH 关掉她不退出、刷新不白屏 |
| **连通 DSH** | 外壳每 8 秒发现一次 DSH，连上就把 agent 的事件流转发给她；断开静默降级（托盘有「连接 DSH：自动/关闭」开关） |
| **多模态心跳**（可选，默认关） | 每 15~600 秒看一眼屏幕（截屏自动遮住她自己和可见 UI），用本地视觉模型或任意 OpenAI 兼容 API 生成 1~2 句**和画面内容有关**的话 + 一个动作；设置面板「心跳」页可开关、调话痨程度、一键启停 llama-server、改提示词、填自定义 API |
| **对话双模式** | 「工作模式」消息进 DSH；「回应模式」直接问聊天模型（带最近 12 轮记忆），输入框提示会变成「想和大肥鱼说什么…」 |
| **待机灵动** | 待机节奏三档（发呆 7~16s / 常态 / 活跃 1.5~3.5s 连做 2~3 件）+ **15 个动作** + 8 段成套小戏（菜单「小戏」页可手动演）+ 表情页 13 项 |
| **详细频率面板** | 设置 → 灵动度 → 详细面板…：12 个待机行为 / 8 段小戏 / 整体间隔逐项 0–200%，改完立即生效、自动保存；每行右侧标出「实际」权重（常态 / 活泼 / 发呆 三档），面板顶部解释三档是怎么切的 |
| **不抢前台 / 双窗口** | 点身体不会把 DSH 或游戏挤到后台（命中窗 `WS_EX_NOACTIVATE` + Chromium 守卫，只有点进聊天框才临时要键盘）；渲染窗始终穿透，dock / 面板 / 输入框才临时可交互。双窗口需要 Koffi（`resources/koffi`），缺失会自动回退单窗口 |
| **语气表情** | 说话时按**最后一句**的语气动脸：疑问抬眉毛歪头、感叹张嘴扬嘴角（`@talk-tone`） |
| **互动感知** | 凑近 / 盯着看 / 甩鼠标 / 打字 / 停打字 —— 各有冷却与优先级，不会一惊一乍 |
| **声音感知** | 安静 5 分钟后系统**突然**有声音（WASAPI 峰值），她会演「听见什么」；睡着时被惊醒。设置里可整个关掉 |
| **睡眠 / 唤醒** | 安静 3 分钟后真的睡着（闭眼 + 只呼吸 + 换嘴 + 梦话）；身上停 5 秒 / 身边甩动 / 拖动 / 点击 / 菜单 / DSH 消息都能叫醒，醒来先「圈圈眼」懵一下 |
| **姿态脉冲** | 甩鼠标会**真甩头**（0.62 秒的根参数脉冲），而不是借「点头」动作凑 |
| **托盘开关** | 显示/隐藏 · 连接状态 · 连接 DSH 开关 · 低性能模式 · 彻底退出 |
| **刷视频**（可选） | dock 上点「🎬 刷视频」，她自己按你设的**视频口味**（关键词）去 B 站搜一条、拉字幕/抽帧**真看懂**，然后说一句并写进「📮」里（气泡消失后还能翻、能复制 BV）。60 秒冷却；只读公开接口，**不评论不点赞**。见 [§ 刷视频](#刷视频可选只读-b-站公开接口) |

## 快速开始

### 第 1 步：拿模型（必须，本仓库不带）

大肥鱼模型是 B 站作者 **@Mao绒绒家园**（UID 431301506）的免费公皮，
视频 **BV1yep465EQz**（非官方二创、非商业、禁止盗用与出售）。

拿到后，把下表的文件放进 `pet-plugin/assets/model/`：

| 文件 | 说明 |
|---|---|
| `dfyfish.moc3` | 模型本体 |
| `dfyfish.8192/texture_00.png` | 贴图（8192×8192，≈28.6 MB） |
| `dfyfish.physics3.json`、`dfyfish.cdi3.json` | 物理 / 显示信息 |

然后自检：

```bash
node pet-plugin/tools/check-model.mjs      # 或 npm run check:model
```

细节见 [`pet-plugin/assets/model/README.md`](pet-plugin/assets/model/README.md)。

### 第 2 步：让她跑起来

**方式 A：桌面外壳（推荐，Windows）**

本仓库提供外壳的**源码**（`shell/src/`），但**不含 Electron 可执行文件**。
把这个 asar 打进你手上的 Electron 外壳目录即可：

```powershell
node shell/build.mjs --verify     # 打包 + 自检
node shell/build.mjs --install    # 装到外壳目录（默认 D:\whalepet，可用 DSH_PET_SHELL_DIR 指定）
```

装完重启外壳：她会自己起本地服务并加载模型。

**方式 B：浏览器标签页（最省事，不用 Electron）**

在 DSH 里装好本插件并重启 DSH，然后用浏览器打开：

```
http://127.0.0.1:19387/dsh-pet/standalone?k=<你的桌面通行证>
```

通行证在 `~/.dsh/dsh-live2d-pet-desktop.json` 的 `token` 字段。
（用 Chrome 的 `--app` 参数打开就是无地址栏的小窗。）

### 第 3 步：装 DSH 插件（只有想联动对话才需要）

```bash
dsh plugin --profile desktop add <本仓库路径>
```

然后**重启 DSH**（插件后端只在启动时加载）。

### 第 4 步：开多模态心跳（可选，默认关闭）

心跳**不随仓库分发模型和推理引擎**，两种接法：

1. **本地 llama.cpp**：设置面板 →「心跳」→ 填 `llama-server`、模型 `.gguf`、`mmproj` 三个路径 →「启动模型」。
   模型建议 MiniCPM-V 4.7 1B（省显存，约 2 GB）或 Qwen3.5-9B（更像聊天，约 6.6 GB）；
   llama.cpp 建议 **≥ b11582**（旧版不认 4.7 的视觉投影）。
2. **自定义 API**：填 OpenAI 兼容的「API 地址 / 模型名 / API Key」，不需要本地模型。

> 隐私：开启后，**遮掉她和 UI 的截图**会发给你配置的那个模型（本地或远端）；默认关闭，随时可关。
> 她睡着、或 DSH 正在跑一轮时，心跳不会采集。

## 刷视频（可选，只读 B 站公开接口）

dock 上多两个按钮：

- **🎬 刷视频** —— 她按「视频口味」里随机一个关键词去 B 站搜 5 条，先用标题挑 1 条，
  再拉字幕 + 抽 3~10 帧**真看懂**，然后冒一句气泡，并把完整介绍写进「📮」。**60 秒冷却**，冷却期间按钮显示剩余秒数。
- **📮** —— 她刷过的视频都在这里：标题、介绍、`复制 BV`、`打开`。气泡会消失，这个不会。

设置 → 鲸鱼娘 → 心跳 里可调：

| 项 | 说明 |
|---|---|
| **视频口味** | 关键词，逗号分隔，最多 10 个；每次随机挑一个去搜。留空则退回首页推荐（推荐流容易刷到不感兴趣的东西，建议填） |
| **抽帧数** | 3~10，默认 3。帧越多看得越细也越慢：3 帧约 9 秒，10 帧约 20 秒。超过 40 分钟的视频最多用 3 帧 |

判定与预算（写在 `shell/src/heart/bili/budget.js`）：

- ≤10 分钟看全片，10~40 分钟只读前 10 分钟，>40 分钟只看开头一小段 —— 并且**她会主动告诉你她只看了开头**，
  不会假装看全了去评价后面的内容
- 候选里有 3 条以上短视频时，超过 25 分钟的会被直接筛掉（只在提示词里说没用，实测压不住）
- 看过的视频记在 `%APPDATA%\DS-WhaleGirl-Pet\bili-memo.json`（40 条 / 14 天），不会重复推同一个

### 免责

这个功能**只读** B 站的公开接口（首页推荐、搜索、视频详情、热门评论、播放直链），
**不评论、不点赞、不投币、不关注、不发私信**，也不写入任何账号状态，因此**不需要登录、不需要 cookie**。

- 请你遵守 [B 站用户协议](https://www.bilibili.com/blackboard/protocol.html) 与 `robots.txt`，**不要**调小冷却、不要写脚本批量刷。
- 接口是逆向得来的，B 站随时可能改字段或加风控；本项目不保证长期可用，也不对由此产生的任何后果负责。
- 字幕轨在未登录状态下通常拿不到（实测 6/6 为空），此时她只能靠画面 + 标题 + 简介 + 热评理解，
  介绍会明显更含糊 —— 这不是 bug。
- 视频内容、评论、字幕的版权归原作者；本仓库不分发任何视频内容，只把链接给你。

## 目录结构

```
pet-plugin/           DSH 插件（后端 + 前端 + 模型配置）
  lib/index.js        后端：静态资源 / SSE 事件桥 / 反向通道 / 拉外壳
  assets/pet.js       前端：性格、表情、动作引擎、待机、小戏、感知、语气（约 8000 行）
  assets/model/       模型配置（**不含模型本体**）
  tools/              命令行小工具（含 check-model）
  skill/              给 agent 用的技能说明
shell/                独立桌面外壳
  src/main.js         主进程：起本地服务、连 DSH、托盘、拖动、点击穿透
  src/petserver.js    本地 HTTP 服务（页面/脚本/运行时/模型 + 反向代理 + 信任栅栏）
  src/heart/          多模态心跳（采集/遮罩/调度/推理/裁决/模型进程/聊天记忆）
  build.mjs           打包 asar → 装到外壳目录
tests/                纯 Node 测试（8 套，CI 跑这些）
```

## 开发

- 改 `pet-plugin/assets/pet.js` / `manifest.json` → **重启外壳**即可（前端每次启动都重新拉）
- 改 `pet-plugin/lib/index.js` → **必须重启 DSH**（后端只在启动时加载）
- 改 `shell/src/*` → `node shell/build.mjs --install` 再重启外壳
- 语法检查：`node tests/_safe/查语法.mjs`（本机 `node --check` 在中文路径下会崩）

## 测试

```bash
# 纯 Node（不需要外壳、不需要模型文件）：8 个套件
node tests/测试动作引擎.mjs
node tests/测试待机节奏.mjs
node tests/测试互动感知.mjs
node tests/测试成套小戏.mjs
node tests/测试独立桌宠.mjs
node tests/测试说话语气.mjs
node tests/测试心跳纯函数.mjs
node tests/测试心跳决策.mjs

# 语法检查（本机 node --check 在中文路径下会崩）
node tests/_safe/查语法.mjs
```

合计 **774 项**。这 8 个套件是从 `pet.js` 里把带标记的纯函数块**原样抠出来**跑的，
所以测的就是线上那份代码，不存在「测试副本和线上不一致」。

> 真机（CDP）套件需要桌面外壳 + 调试口，属于开发时的排障工具，不在这个仓库里。

## 已知限制

- 壳里有些路径是按作者本机写的（`D:\whalepet` 安装位、工作区路径），换机器时改 `shell/build.mjs` 里的 `SHELL_DIR`
  或设环境变量 `DSH_PET_SHELL_DIR`

- 模型是「书桌场景」整张画布（3326×4992），贴图 8192²（显存约 256 MB）；低端机/核显会吃力
- 没有 `HitAreas`，所以不能分部位点击（摸头 / 戳腰那种）
- `LipSync` 参数组是空的，口型只能用 `ParamMouthOpenY` 近似
- 工作区路径里含中文会让某些 Node API 崩（`node --check`、`spawn`），本仓库因此提供 `tests/_safe/查语法.mjs`

## 许可

- **代码**（`pet-plugin/lib`、`assets/pet.js`、`shell/`、`tests/`）：**MIT**
- **模型**：**不随本仓库分发**。大肥鱼模型归 B 站 @Mao绒绒家园 所有（非商业、禁止盗用与出售）
- **运行时**：Live2D Cubism Core（Live2D Inc.）、PIXI.js（MIT）、pixi-live2d-display（MIT）

详见 [`NOTICE.md`](NOTICE.md) 与 [`CREDITS.md`](CREDITS.md)。

## 来源与致谢

本仓库是 [**Andersen216/dsh-whale-girl-live2d**](https://github.com/Andersen216/dsh-whale-girl-live2d)
的**魔改分支**：上游做的是「鲸鱼娘」桌宠（DSH 插件 + macOS/Windows 外壳），
这个分支换了模型、加了待机灵动/互动感知/成套小戏/语气表情，并把外壳改成了**能独立运行**。

上游的 README 原样保留在 [`pet-plugin/README.upstream.md`](pet-plugin/README.upstream.md)，
许可分层见 [`NOTICE.md`](NOTICE.md)。
