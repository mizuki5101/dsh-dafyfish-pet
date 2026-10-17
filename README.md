# 大肥鱼桌宠 · Live2D 桌面宠物（DSH 插件 + 独立外壳）

一个常驻桌面的 Live2D 桌宠。她会呼吸、会换表情、会自己找点事做；
你在 DSH 里干活时她会跟着切换状态（思考 / 调用工具 / 说话），**说话时脸会跟着语气变**。

**她可以完全独立运行**：DSH 没开的时候她照常在桌面上待机，只失去「对话」这一块；
DSH 开起来之后 8 秒内自动连上，不需要重启她。

> ⚠️ **本仓库不含任何 Live2D 模型文件**。模型版权归原作者，请自己获取（见下方「第 1 步」）。
> ⚠️ **非官方**：不是 DeepSeek 官方产品，也不是上游插件的官方分支（见文末「来源与致谢」）。
> ⚠️ **非商业**：本项目不收费、不带货、不接广告。这是上面几份许可唯一能同时满足的用法。

---

## 特性

| | |
|---|---|
| **独立运行** | 页面 / 前端 / Live2D 运行时 / 模型都由外壳自己的本地服务提供（`127.0.0.1:19400`）。DSH 关掉她不退出、刷新不白屏 |
| **连通 DSH** | 外壳每 8 秒发现一次 DSH，连上就把 agent 的事件流转发给她；断开静默降级（托盘有「连接 DSH：自动/关闭」开关） |
| **待机灵动** | 待机节奏三档（发呆 7~16s / 常态 / 活跃 1.5~3.5s 连做 2~3 件）+ 13 个动作 + 5 段成套小戏 |
| **语气表情** | 说话时按**最后一句**的语气动脸：疑问抬眉毛歪头、感叹张嘴扬嘴角（`@talk-tone`） |
| **互动感知** | 凑近 / 盯着看 / 甩鼠标 / 打字 / 停打字 —— 各有冷却与优先级，不会一惊一乍 |
| **姿态脉冲** | 甩鼠标会**真甩头**（0.62 秒的根参数脉冲），而不是借「点头」动作凑 |
| **托盘开关** | 显示/隐藏 · 连接状态 · 连接 DSH 开关 · 低性能模式 · 彻底退出 |

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
  build.mjs           打包 asar → 装到外壳目录
_research-data/       测试与排障工具（见下）
docs                  交接文档 / 桌面外壳 / 待机行为改造方案 / 动作系统
```

## 开发

- 改 `pet-plugin/assets/pet.js` / `manifest.json` → **重启外壳**即可（前端每次启动都重新拉）
- 改 `pet-plugin/lib/index.js` → **必须重启 DSH**（后端只在启动时加载）
- 改 `shell/src/*` → `node shell/build.mjs --install` 再重启外壳
- 语法检查：`node _research-data/_safe/查语法.mjs`（本机 `node --check` 在中文路径下会崩）

## 测试

```bash
# 纯 Node（不需要外壳）：6 个套件
node _research-data/测试动作引擎.mjs
node _research-data/测试待机节奏.mjs
node _research-data/测试互动感知.mjs
node _research-data/测试成套小戏.mjs
node _research-data/测试独立桌宠.mjs
node _research-data/测试说话语气.mjs

# 需要外壳带 --remote-debugging-port=9222：9 个套件
node _research-data/回归检查.mjs
node _research-data/验证移除邮件.mjs
node _research-data/验证表情.mjs
node _research-data/验收.mjs
node _research-data/验证独立外壳.mjs
node _research-data/验证断开降级.mjs
node _research-data/验证新待机行为.mjs
node _research-data/验证说话语气.mjs
node _research-data/验证布局.mjs
```

合计 **648 项**。其中纯 Node 的 6 个套件是从 `pet.js` 里把带标记的纯函数块**原样抠出来**跑的，
所以测的就是线上那份代码，不存在「测试副本和线上不一致」。

## 已知限制

- 文档（`交接文档.md` / `桌面外壳.md` 等）里出现的 `D:\<你的仓库>`、`%USERPROFILE%` 是**作者本机路径**的占位，
  以及部分 `_research-data/*.mjs` 里写死了作者机器的绝对路径 —— 那些是一次性排障脚本，按你的环境改一下即可

- 模型是「书桌场景」整张画布（3326×4992），贴图 8192²（显存约 256 MB）；低端机/核显会吃力
- 没有 `HitAreas`，所以不能分部位点击（摸头 / 戳腰那种）
- `LipSync` 参数组是空的，口型只能用 `ParamMouthOpenY` 近似
- 工作区路径里含中文会让某些 Node API 崩（`node --check`、`spawn`），本仓库因此提供 `_safe/查语法.mjs`

## 许可

- **代码**（`pet-plugin/lib`、`assets/pet.js`、`shell/`、`_research-data/`）：**MIT**
- **模型**：**不随本仓库分发**。大肥鱼模型归 B 站 @Mao绒绒家园 所有（非商业、禁止盗用与出售）
- **运行时**：Live2D Cubism Core（Live2D Inc.）、PIXI.js（MIT）、pixi-live2d-display（MIT）

详见 [`NOTICE.md`](NOTICE.md) 与 [`CREDITS.md`](CREDITS.md)。

## 来源与致谢

本仓库是 [**Andersen216/dsh-whale-girl-live2d**](https://github.com/Andersen216/dsh-whale-girl-live2d)
的**魔改分支**：上游做的是「鲸鱼娘」桌宠（DSH 插件 + macOS/Windows 外壳），
这个分支换了模型、加了待机灵动/互动感知/成套小戏/语气表情，并把外壳改成了**能独立运行**。

上游的 README 原样保留在 [`pet-plugin/README.upstream.md`](pet-plugin/README.upstream.md)，
许可分层见 [`NOTICE.md`](NOTICE.md)。
