# 更新日志 / Changelog

## 0.4.13 — 2026-10-17（睡眠状态机 + 唤醒手势）

### 睡着：真的闭眼，不再自己找戏

- **闭眼只写眼形**（`ParamEyeL/ROpen −1`），**故意不用 `PARAM_EXP5`**：那条素材是 >< 挤眼，
  睡着看着像在用力；只写眼形是自然闭眼（用 canvas 截图 A/B 对比过）。
- 待机大脑 / 感知器 / 小戏全部让位：不再伸懒腰、不再对 hover/stare 反应、不再跟鼠标（视线回正），
  只保留呼吸 + 很轻的摇摆（待机幅度 ×0.55）。
- 三张**隐藏睡脸**（不进表情页，表情页仍是 14 项）：`睡·流口水` / `睡·3嘴` / `睡·〇嘴`，
  每 **10~30 秒**硬切一次（不硬切会两张嘴叠 0.3 秒）。
- 梦话：**30~50 秒**随机一句（白饭 / 糖醋鱼 / 主人别走…）。
- 入睡条件改成「**鼠标 / 键盘 / DSH 任一活动**都没有 3 分钟」——
  以前只看 `agent.lastActivity`（DSH 事件），主人玩菜单/动鼠标也会睡。

### 唤醒：明确手势，不再「动一下鼠标就醒」

| 手势 | 判定 |
|---|---|
| 鼠标停在她身上 5 秒 | 掩码内 `inside` 连续 5s；**入睡时已经在身上不算**，必须先移开再放回 |
| 在她周围快速甩鼠标 | 实体包围盒外扩 40px + 速度 >1200px/s（屏幕别处甩、面板上甩都不算） |
| 直接拖动她 | `pointermove` 里判定真的拖起来（>4px） |
| 点击 / 菜单点表情动作 / DSH 消息 | 也唤醒；菜单会等 0.5s 过场后再执行动作 |

- 醒来过场：**硬切**一次「圈圈眼」（500ms，像被叫醒的懵），纯手势唤醒再 **80%** 追加一次「害羞」；不说话。
- 唤醒后 2.9 秒内感知器/待机大脑让位，避免「刚睁眼又歪头」。
- 唤醒是**状态迁移**，不是感知器反应：`wakeUp()` 可以写一次性 override；
  `doReaction` 仍然绝不碰 override（不变量 #6 的例外见交接文档 §十三.10）。

### 调试入口

- 设置页最底下加了「**立即进入睡眠（调试）**」/「**叫醒她（调试）**」——
  走真实 `beginSleep` / `wakeUp`，不用等 3 分钟、也不用开 9222 调试口。
- 按钮文案跟着**真实状态**走：用手势叫醒她（悬停/甩动/拖动/点击）后也会立刻变回「立即进入睡眠」。
  只改文字不重建面板，设置页的滚动位置不会被弹回顶部。

### 顺手修掉的

- 2 秒兜底复位在睡着时必须让位，否则睡脸最多亮 2 秒（旧 `setBase('sleepy')` 就是这样被抹掉的）。
- `MOOD_FACE.sleepy = '闭眼口水'` 在 manifest 里**不存在**，旧睡眠从来没闭过眼——本轮用真实表情替代。
- `setBase('sleepy')` + 9 秒 Zzz 气泡的旧路径删除。

### 测试

- 6 个纯 Node 套件 **464** 项（原 443，+21：5s 悬停两段 / 甩动 / 换嘴与梦话节奏 / 配置覆写）。
- CDP 9 套 234 项不变；合计 **698**。
- 新增 `_research-data/_safe/验证睡眠.mjs`（CDP 28 项，含真机手势模拟与面板防误触），属排障脚本，不计入 698。

## 0.4.12 — 2026-10-17（表情 / 动作增量）

### 新表情 4 个（表情页 9 → 13 项）

- **疑惑**（原叫「撇嘴」，主人按观感改名）：`ParamMouthX +1` + `ParamEyeLOpen −0.3`（轻度半眯）+ `ParamBrowLForm 1` + `ParamBrowLAngle 0.5` + `ParamAngleZ 6`。
  光靠 MouthX 只有 12.9px（屏幕上约 1px），必须搭眼睛/眉毛/歪头才读得出来；但半眯别太狠（−0.55 主人嫌太狠）。
- **怀疑**（主人要的单眼半眯版）：屏幕左眉 `ParamBrowRForm +1` + `ParamBrowRAngle +1`
  + `ParamEyeLOpen −0.4`（另一只眼半眯）+ `ParamEyeBallX −0.35` + `ParamEyeBallY +0.45`
  + `ParamAngleZ −10` + `ParamAngleX −4`。和挑眉区分：挑眉是「一边抬/一边压」，怀疑是「一边眉抬 + 另一只眼半眯」。
- **嫌弃**（原定「委屈」）：`PARAM_EXP3 0.7`（脸黑）+ `ParamEyeLOpen/ROpen −0.4`（眯眼）
  + 双眉 `ParamBrowLAngle/RAngle +1` / `ParamBrowLForm/RForm +0.6`（八字）+ `ParamEyeBallY −0.5`
  + `PARAM_EXP7 −1`（担心嘴）+ `ParamAngleY −6` + `ParamAngleZ −4`。
  主人拍板：没有泪眼，委屈读不出来 → 直接改成「嫌弃」= 脸黑 + 眯眼。脸黑 1.0 会盖住眼睛，0.7 还能看见眯眼。
- **挑眉**：屏幕**左**眉 `ParamBrowRForm +1` + `ParamBrowRAngle +1`，屏幕右眉 `ParamBrowLForm −0.5`
  + `ParamBrowLAngle −0.4` + `ParamEyeBallY +0.45` + `ParamEyeBallX −0.35` + `ParamAngleZ −12` + `ParamAngleX −5`
  （主人说“另一只”上挑后还是不明显 → 加对侧眉压低 + 歪头 12° + 转头 5°）。

> 🐛 主人五轮实测：
> ①「三个都不明显、撇嘴没有半眯眼」→ `ParamEyeLOpen` 写成 **+0.7**，被夹回 max=1，等于没写；改成负值。
> ②「撇嘴眼睛太狠、委屈像嫌弃、挑眉怪」→ 撇嘴 **−0.55 → −0.3**；挑眉换到屏幕左眉、歪头 15° → 8°。
> ③「这个委屈完全是傲娇；没有泪眼看不出委屈」→ 把「委屈」改成「嫌弃」，用脸黑 + 眯眼；
> 脸红/浅阴影方案作废。
> ④「撇嘴改名疑惑更合适；挑眉还是不明显」→ 改名「疑惑」；挑眉加对侧眉压低 + 歪头 12° + 转头 5°。
> ⑤「想看看单眼半眯那个版本，单开一个怀疑」→ 新增「怀疑」（与挑眉区分）；
> `验证表情.mjs` 的 4 条「观感锁」同步更新。

### 新动作 2 个（动作库 13 → 15）

- **打喷嚏**（0.9s）：快速低头 + `PARAM_EXP5` 与 `ParamEyeL/ROpen` **成对**闭眼 + 张嘴 + 眉压。
- **叹气**（2.6s）：低头 + 闭眼 1 秒 + 八字眉 + 小张口。
  ⚠️ 原计划的「ParamBreath 反向（尾巴一沉）」不可做：偏移夹到 `[0,1]`，负值会被夹成 0；
  尾巴的下沉交给低头/前倾让物理带下去。

### 量方向（S1）

`测眉眼方向.mjs` 重写：每参数显式 +1/−1，眉形分**内端/外端**，嘴形分**左右嘴角**。
真值写进 `_research-data/眉眼方向.txt`、`表情方向.txt` 和 `manifest.json` 的 `_note`。

**两处与原计划相反**（已纠正）：

- `ParamBrowLAngle/RAngle`：**+1 = 八字（委屈）**，**−1 = 倒八字（生气）**。现役「生气」= −1 是对的。
- `ParamBrowLForm/RForm`：**+1 = 八字/抬眉**，**−1 = 倒八字/生气**。
- 原「委屈 = Form −1 + Angle −0.4」实测是**更凶的倒八字**，别照旧表抄。

### 测试

677 项全绿（纯 Node 443 + CDP 234）。动作引擎 96 → 115；表情验证 16 → 24；验收 49 → 51。
顺手修了两个独立化后失效的测试：控制通道改走外壳 19400 + `dsh_pet_local`；独立外壳不再写死 DSH 端口 19387。

## 0.4.11 — 2026-10-17（本机改动 · 收尾）

### 重构：气泡与工具栏的「锚点 + 夹取」抽成一处（行为零变化）

两者原来各有一份近百行的实现，六成是重复的（pad / 视口 / root 矩形 / `charInset` /
「可见部分」中心 / 测量时绝不复位 / 横向两边夹 / 纵向翻边）。现在都走
`placeViewportAnchored(el, { gap, prefer })`，竖直策略仍各自保留（气泡优先上方、工具栏优先下方）。

**怎么保证没改坏**：先写 `_safe/布局快照.mjs` 拍「改前」快照（4 个位置 × 气泡/工具栏矩形 +
当次输入），换回旧代码拍一遍、换上新代码再拍一遍，**逐字段一致**才提交。
（第一次比对撞了两个坑：没记录输入、没等布局稳定 —— 都在脚本注释里写清了。）
另外新增 `验证布局.mjs` 36 项不变量：整块在视口内、对准她可见部分中心、该在哪一侧在哪一侧。

### 顺带

- 工具栏原来只在「翻上去也不行」时才夹进视口；现在统一成一律夹 ——
  她拖到屏幕上方外面时，工具栏会贴住上边缘、仍然点得到。
- `placePanel` 补了注释：它跟气泡/工具栏是**两套定位机制**（root 内相对位移 vs fixed 视口），
  不是重复代码，别硬合并。

## 0.4.10 — 2026-10-17（本机改动 · 收尾）

### 修：`fiddle` 是一个「什么都没发生」的待机行为，却占着 10~14 的权重

`fiddle`（拨弄道具）依赖 `PROPS` 里的道具表达式 —— 那一堆**全是鲸鱼娘模型专属**的
（圆眼镜 / 猫猫贴纸 / 桌布 / 魔爪…），大肥鱼一个都没有。于是每次抽到它都：
抽一件「事」→ 什么都不做 → 还把节奏引擎的 quiet 计数冲掉（fiddle 属于「有戏」）。

现在待机行为多了一层「这一项现在做得了吗」的判定（`canDoIdle`）：
- 抽签时直接不进池（权重按剩下的自动归一，不用改任何数字）
- 点名要它（`DSHPet.idleAct('fiddle')`）会明确返回 `behWhy: 'not-available:fiddle'`
- 新增诊断 `DSHPet.idlePool()`：**当前这一跳真正能抽到哪些行为、哪些被剔掉了**

### 顺带清掉的死代码

- `placeBubble(force)` 的 `force` 参数（去重比的是算出来的位置，它从来没用）
- `idle.expressTimer` / `idle.propTimer`（上游遗留字段）
- 给 `PROPS / SCENES` 与 decor/scene 渲染分支补了注释：**它们是鲸鱼娘模型的回退资产，别只删数据**

## 0.4.9 — 2026-10-17（本机改动）

### 说话时脸会跟着语气变

以前说话只有一个固定正弦的 `ParamMouthOpenY`（像机器人配音）。现在按**语气**分三档：

| 语气 | 判据（只看最后一句） | 变化 |
|---|---|---|
| 疑问 | `？/?` 或结尾「吗/嘛/么/呢」 | 抬眉毛、嘴角微扬、头微歪 |
| 感叹 | `！/!/～` 或结尾「呀/哇/哈/耶」 | 嘴张得更大更急、嘴角扬、抬头 |
| 平常 | 其它 | 原行为 |

舞台提示（「（笑）」）先剥掉，否则「好耶！（拍手）」会被判成平常。
诊断：`DSHPet.talkTone()` / `classifyTone(text)` / `talkProbe(text, ms)`（后者不发任何消息）。

### `/say` 加了 `dryRun`；另开只读探针 `/dsh-pet/ping`

`/say` 是**写操作**（会真的往会话里塞消息）。2026-10-17 我拿它当连通性探针，
结果 DSH 里被塞进了几条「在吗」。现在：
- `{dryRun: true}` → 只校验形状、返回 `wouldSend`，**不发送**（外壳与插件两层都挡）
- `GET /dsh-pet/ping` → 只读探针，回 `{online, canSay}`，专门给「能不能说话」用

> ⚠️ 插件的这层改动要**重启 DSH** 才生效；外壳那层已经在线上了。

## 0.4.8 — 2026-10-17（本机改动）

### 待机更活：真·甩头 + 两个身体姿态 + 表情的小动作

- **动作引擎开放 `idleBurst()`**：可以立刻插一个「临时根参数脉冲」（0.6~2.6 秒，
  只写 4 个根参数、有自然包络、新脉冲覆盖旧的）。以前想甩一下头只能借「点头」clip。
- **甩鼠标（swoosh）= 真甩头**：0.62 秒的一次甩出 + 回弹，方向跟着鼠标横向速度走。
- **两个新待机行为**：`peer`（探头张望，姿态脉冲）与 `sway`（换重心，播现成的 4.4 秒 clip），
  三档权重各自登记；`glance` 从 12 降到 8 让位（它只换视线落点、几乎看不见）。
- **表情更活**：换表情时有 45% 机会配一个极轻的姿态脉冲；眨眼有 5% 概率变成「慢眨」；
  凑近反应多了一档「探头」（最轻的那种，什么都不播）。

测试：动作引擎 73 → 96 项；新增真机验收 `验证新待机行为.mjs` 16 项。

## 0.4.7 — 2026-10-17（本机改动）

### 修：注入的 boot 在 pet.js **之后**执行 → 配置文件从来没生效过

`/dsh-pet/pet.js` 原来拼成 `版本注释 + pet.js 全文 + boot`。
但 pet.js 是**同步 IIFE**，执行到第 69 行就把 `window.__DSH_PET_BOOT__` 读成常量了，
后面那行赋值再执行已经没人读它 —— 所以 `~/.dsh/dsh-live2d-pet.json` 里的
`height` / `corner` / 灵动度**从来没有生效过**，一直靠前端默认值撑着。

现在改成 `版本注释 + boot + pet.js`。

> 桌面外壳（`shell/src/petserver.js`）里有一份同样的实现，两边都必须是「boot 在前」；
> 回归锁在 `_research-data/测试独立桌宠.mjs`（断言 boot 出现在 `__DSH_PET_LOADED__` 之前）。

### 顺带

- 本机把桌面外壳改成了「自己提供静态资源」（见仓库根 `桌面外壳.md`）：
  插件这侧的路由、事件流、信任栅栏**一行没改**，仍然是「对话」的唯一来源。

## 0.4.6 — 2026-10-01

### 宿主识别：不再依赖固定端口，任何人任何端口都能自动对上

之前客户端靠「候选端口列表（19387 / 3080 …）」猜宿主 —— 那只是本机的端口，
别人的 DSH 可能跑在完全不同的端口上，属于"恰巧碰中"。

现在三段式，逐级兜底，**不靠猜**：

1. **插件写下的真实端口**：插件跑在宿主里，能直接读到 `ctx.webServer.port`，写进
   `~/.dsh/dsh-live2d-pet-desktop.json` 的 `port` 字段（老文件缺 port 会自动补写）。
2. **扫描本机所有监听端口**：macOS 用 `lsof -nP -iTCP -sTCP:LISTEN`、Windows 用
   `netstat -ano -p tcp`，**不看进程名、不看固定端口**；逐个探 `/dsh-pet/pet.js`：
   200 就是它，401 说明插件在但票不对（也先进去）。端口没监听会被立刻拒绝，所以扫描很快。
3. **常见端口兜底**：19387 / 3080 / 8080 / 3000（仅在前两步都失败时使用）。

实测：文件里 `port=3080` 时客户端连 3080；两个宿主同时开着时以插件最后写入的为准。
macOS 与 Windows 两端实现同一套顺序。

## 0.4.5 — 2026-10-01

### 明确兼容范围：对齐最新宿主（0.2.0-rc.x）

- README 增加「兼容性」表：**目标版本 DSH 0.2.0-rc.1 / 0.2.0-rc.2**（官方桌面版当前版本）；
  **0.1.x 不支持**（会报 `failed to import` / `did not activate`）
- 依据：宿主插件 API 在 0.1.x → 0.2.x 之间发生过变动（`connection.requestRejection`
  在 0.1.0-rc.3 上不存在、0.1.5-rc.2 上才有）；本插件只依赖 Node 内置模块、无第三方依赖，
  因此加载失败属于宿主 API 不匹配，而非缺依赖
- 对应 GitHub Issue #1（桌面版 0.1.7-rc.2 安装报错）：建议升级宿主后重装

## 0.4.4 — 2026-09-30

> **English summary**: mouse-move stutter on macOS is fixed. Two causes, both in the shell:
> (1) `ignoresMouseEvents` was re-assigned every 90 ms tick, making the window server redo hit
> testing constantly; (2) every tick did a JS round-trip into the page (`elementFromPoint` + per-pixel
> alpha sampling) even though she occupies ~10 % of the window. Now the shell caches her bounds and
> the panel rects once per second and answers the common case locally — measured:
> `探针统计：本地判定 575 次 / 进网页 0 次` in one minute.

### 修：macOS 鼠标一动就卡

两个原因，都在外壳里（前端一行没改）：

1. **`ignoresMouseEvents` 每 90ms 重复赋值** —— 即使值没变也赋，窗口服务器于是不停重算命中测试。
   现在只在真正变化时赋值。
2. **每 90ms 都往网页里问一次「鼠标在不在她身上」** —— 一次 IPC + `elementFromPoint` +
   逐像素 alpha 采样；而她的可见范围只占 560×900 窗口的约 10%，**九成询问是浪费**。
   现在：壳子每秒缓存一次她的范围和面板矩形，之后 90% 的探针**本地纯计算**得出结果。

实测（重启后运行一分钟）：`探针统计：本地判定 575 次 / 进网页 0 次`；
壳子主进程 3.2%、WebContent 4.8% —— 鼠标移动不再触发任何 JS 往返。

（还加了「探针统计」日志，每 60 秒一行，以后再卡可以直接看数字定位。）

补充（同一天）：窗口从 560×900 缩到 **460×700** —— 面板最大 471 高、聊天框 370 宽，
加上她约 200px，留足余量即可。实测（程序模拟鼠标连续移动 6 秒量 WindowServer）：
桌宠在跑 66.4% → 关掉桌宠 78.8%（说明卡顿的主因不在本应用，见 README 排错）；
缩窗后同场景 58.3%。


## 0.4.3 — 2026-09-30

> **English summary**: the macOS shell no longer hard-codes the DSH port. It discovers the host at
> launch (listening ports owned by `DeepSeek` / `node`, probed with the desk token) so it works with
> both the **official DSH desktop app** (Electron, port chosen by the host — 19387 here) and a
> manually started `dsh web`. The plugin itself needed no changes. Verified in the log:
> `找到宿主（票有效）: http://127.0.0.1:19387`.

### 适配官方桌面版（只改 macOS App，插件零改动）

DSH 官方桌面版（`DeepSeek Harness.app` 0.2.0-rc.2，Electron）会自己起一个本地 web 服务，
端口由宿主决定（本机实测 `127.0.0.1:19387`，而手动的 `dsh web` 是 3080）。
外壳原来把 3080 写死了，所以连不上官方桌面版。

现在改成**启动时发现宿主**：

1. `lsof` 列出本机监听端口，挑出 `DeepSeek` / `dsh` / `node` 这些进程占用的端口
2. 逐个探 `HEAD/GET /dsh-pet/pet.js`（带通行证）：`200` 就用它；只有 `401` 时也先进去（票可能过期）
3. 兜底候选：19387（官方桌面版实测端口）、3080、8080、3000
4. ↗ 按钮和诊断页也跟着发现出来的宿主走

实测：日志输出 `找到宿主（票有效）: http://127.0.0.1:19387`，
页面 `DSHPet=yes` —— 官方桌面版下正常。插件侧不需要任何适配（`desktop` profile 里已装好）。

## 0.4.2 — 2026-09-27

> **English summary**: macOS only — the drag "air wall" is gone. AppKit constrains windows to the
> screen by default (so a title bar cannot go above the menu bar); for a borderless pet window that
> clamped the window's top at the visible frame's top. Overriding `constrainFrameRect` makes her
> draggable anywhere, including partially off-screen.

### 修：拖到屏幕中上部就撞上一堵「空气墙」（macOS）

拖动日志是铁证 —— 连拖 5 次，窗口 y 每次都停在 **150**：
`150 + 900（窗口高）= 1050` = 屏幕可用区顶边，一个像素都不差。

原因不在我们的逻辑，而在 AppKit 的默认行为：`NSWindow.constrainFrameRect(_:to:)`
会把窗口约束在屏幕内（防止标题栏顶到菜单栏上方）。桌宠是无边框窗口、本来就该能拖到任意位置，
所以覆写它、原样返回 frame 即可。

现在她可以拖到屏幕任何地方，包括拖到菜单栏那一片、甚至半出屏。

## 0.4.1 — 2026-09-27

> **English summary**: UI colour unified to the whale blue used by the site and the app icon (CSS
> variables only, no layout changes); the desktop shell now decides drag ownership at the moment the
> drag starts (previously a 90 ms-stale hit-test could hand the drag to the page, which can only move
> her inside the window — that felt like an invisible boundary); and the panel-clipping experiments
> were reverted back to the known-good placement code.

### 修 / 改

- **配色统一成鲸鱼蓝**（`#3b62f6`，与官网、App 图标同一套）；只动颜色变量，没碰任何布局代码
- **桌面版拖动不再有"隐形边界"**：拖动的归属改成在**拖动开始那一刻**判定 ——
  之前如果鼠标按下时探针的上一次结果恰好是「面板」，这次拖动就会被交给网页，
  而网页只能在她自己的窗口范围内挪动，于是撞到窗口的边（看着像"拖不出这块区域"）
- **回退面板相关的试验改动**：退回 08098af 的定位代码（主人认可的「只是稍微被截」那版），
  真浏览器自检 99/0

## 0.4.0 — 2026-09-26

> **English summary / 英文摘要**
>
> **New: a macOS desktop shell.** The plugin can now live on your desktop instead of inside a browser tab:
> a native transparent, borderless, always-on-top window with **click-through** (only the pixels she
> actually covers take the mouse), drag-to-move, an **edge-snapping frosted-glass ball** when collapsed,
> a 🐋 menu-bar entry, "quit the app" in her own settings, a **low-power mode**, and a proper app icon.
> It is shipped as a separate download in Releases — the plugin itself (the web version) is unchanged and
> still supports Windows / macOS / Linux.
>
> **Fixed**: her tail and out-of-frame expressions were being clipped (the viewport was exactly the
> character's bounding box, with no margin); a large white rectangle behind her in the desktop shell
> (the private `WKWebView` background key is `_setDrawsBackground:`, not `setDrawsBackground:`);
> typing was impossible in the shell (borderless windows need `canBecomeKey`); the collapse button was
> a one-way trip (the restore handle was missing from the click-through whitelist); and the ball could
> disappear with no way back.
>
> **Performance**: frame rate is now capped (30 fps standard / 20 fps low-power) instead of running at
> display refresh (up to 120 fps on ProMotion), the render resolution was lowered from 2× to 1.5×
> (1× in low-power), the desktop shell releases its App Nap exemption while collapsed, and the hit-test
> probe was slowed down. Measured on this machine: shell process 0.5–0.8 % CPU, WebKit renderer 0.2–0.4 %.

### 新增：macOS 桌面版（原生壳）

她可以**搬到桌面上**，不再只活在浏览器标签页里 —— 透明、无边框、永远置顶的原生窗口：

- **点击穿透**：只有她真正占的像素才收鼠标事件（用模型自己的 alpha 掩码判定），
  其余地方点一下就穿到下面的 App —— 不会挡你干活
- **拖她 = 拖窗口**，松手位置记住；拖动不会被误判成「摸头」
- **收起 = 贴边悬浮球**：瞬间出现在离她最近的那一侧，深色玻璃球 + DSH 图标，
  悬停微放大、拖动跟手、松手动画贴边
- 菜单栏 🐋：重新加载 / 回到右下角 / 收起成小球 / 展开 / 小球大小 / **低性能模式** / 保存截图 / **彻底退出**
- 她自己的设置页里也多了「收起成悬浮小球」「彻底关闭桌宠应用」
- **App 图标**：蓝色渐变圆角框 + 她的平常脸立绘
- 只安装一处：`~/Applications/DS 鲸鱼娘桌宠.app`（刻意不在仓库里留第二份）

**装法**：先在 DSH 里装插件（就是下面那些），再去 Releases 下载
`DS-WhaleGirl-Pet-macOS-*.zip`。完整说明见 [`desktop/README.md`](desktop/README.md)。

### 修：尾巴和出格的表情被截掉

原来视窗高度**正好等于**角色实体高度、宽度按固定宽高比算，所以横向超出的尾巴、
纵向超出的表情都被画布裁掉。现在实体四周各留 10% 余量，宽度取「固定宽高比」与
「实体宽度+余量」中更宽者；缩放改成按实体高度算 —— 她**屏幕上的大小不变**，周围多出空间。

### 修：桌面壳里的四个硬伤

1. **大白框**：`WKWebView` 关白底的老写法查的是 `setDrawsBackground:`，但这个私有属性在
   运行时真名是 `_setDrawsBackground:`（KVC 找得到），于是一直被判「不支持」而跳过 → 白底常驻。
   现在两个真键都调上，并递归拆掉内部 `NSScrollView` 的白底。
2. **打不了字**：无边框窗口 `canBecomeKey` 默认 false，键盘事件进不到窗口。
   现在是 `PetWindow` 子类 + 点她时 `NSApp.activate` + 焦点交给网页。
3. **一收起就再也点不回来**：恢复把手是 `.dshp-tab`，而点击穿透的判定写死了一张类名白名单，
   恰好没它。现在改成「`elementFromPoint` 返回的任何她自己的 DOM 都算可交互」。
4. **收起后小球不见了**：加了「页面隐藏但两个窗口都不见 → 自动把球叫回来」的自愈。

### 性能：她之前是满帧满分辨率在跑

- 帧率上限 **30 帧**（低性能档 20 帧）—— 之前跟着显示器刷新率跑，ProMotion 上就是 120 帧
- 渲染分辨率从 2 倍降到 **1.5 倍**（低性能档 1 倍）
- 桌面壳**收起成小球时释放 App Nap 豁免** —— 之前的写法让她永远满速渲染，
  浏览器里标签页不聚焦会自动降频、壳子里不会，这就是「浏览器不卡、壳子卡」的原因
- 点击穿透探针 50ms → 90ms，健康检查 6s → 20s，去掉开发期的自动截图
- 新增**低性能模式**（菜单栏 🐋 可切）：不自己找戏、不自言自语、不弹瞌睡台词，
  只留眨眼 + 轻微摆动 + 视线；点了她才动

## 0.3.3 — 2026-09-25

> **English summary / 英文摘要**
>
> Fixed the eyes being frozen **closed** — a regression introduced in 0.3.2. The framework's
> `getParameterDefaultValue()` takes an *index*, not a parameter id; passing an id returned `undefined`, the
> fallback treated it as `0`, and the eye-open parameter was written as 0 and snapshotted for good. Ids are now
> converted to indices and skipped when unknown, plus a self-heal that restores the default when the eyes stay
> closed for 1.5 s with nobody claiming them. Blinking now runs on a natural schedule (every 2.6–5.4 s,
> ~0.19 s per blink, 15% double blinks, none while a motion or an eye-controlling expression is active).
> Bubbles, menus, the wallet and the composer are anchored to the top of her head (0–1 px off centre, pushed
> inside the viewport near a wall). Tests: 159 static + 99 in-browser, all green.

### 修：眼睛被永久冻成「闭着」（0.3.2 引入的，我的错）

0.3.2 里我加了「停动作时把参数复位到默认值」，但框架的 `getParameterDefaultValue(t)`
收的是**下标**不是 id —— 我传了 id，拿到 `undefined`，兜底又把它当成 0，
于是「睁眼」参数被写成 0（闭眼）并永久存进参数快照。现在：id 先转下标、取不到就**跳过**
（绝不猜 0），另外加了一层「眼睛自愈」兜底：没人认领眼睛参数、又闭了 1.5 秒以上，就按默认值纠回来。

### 眨眼：改成自然的节奏

框架自带的是「下次眨眼 = random × 7 秒」，有时连着眨两下、有时七八秒不眨。
现在自己控制：间隔 2.6~5.4 秒、单次约 0.19 秒（闭 60ms + 停 30ms + 睁 100ms）、
15% 概率连眨两下；**动作播放中或表情在管眼睛时不眨**。实测 12 秒眨 3 次。
（判断「动作在播」不能用框架的 `isFinished()`，它空闲时也返回「没结束」——
这就是第一版眨眼一次都不眨的原因，改成我们自己按动作时长记账。）

### 聊天框对准她的头顶

以前面板以「根节点中心」居中，而根节点包含整张书桌场景，中心 ≠ 脑袋中心，所以看着总偏。
现在用测量出来的头部重心当锚点：中间时**偏差 0~1px**，靠左/右墙时自动往屏内让，不会被墙切掉。
眼神跟随鼠标这一套完全没动（幅度 58%、限速 1.6/秒）。


## 0.3.2 — 2026-09-25

> **English summary / 英文摘要**
>
> Two real bugs. **(1)** After using the omurice action it stayed on the desk forever, even after a
> reset: the framework snapshots parameters *after* motions write them, so a stopped motion's last frame was
> reloaded every frame. Stopping a motion now resets those parameters to the model defaults and re-saves the
> snapshot — the same fix covers phones and expressions that would not go away. **(2)** Popups opened left one
> time and right the next and were half-clipped at a wall; positioning is pure computation now. Also: the Speak
> button became a toggle, and dragging can no longer clip the bottom toolbar.

### 「蛋包饭永远挂着」的根因修掉了（真 bug，藏在框架里）

pixi-live2d-display 每帧的顺序是：动作写入 → `saveParameters()` 存快照 → 眨眼/视线/呼吸/物理
→ 我们的 rig → `update()` → `loadParameters()` 把快照装回来。
**快照是在动作写入之后存的**，所以动作一停，快照里留的就是它最后一帧的姿势，每帧都被装回来 ——
这就是主人看到的「用过蛋包饭之后它永远挂在桌上，连一键重置都没用」。
现在 `stopMotion()` 会顺手 `clearMotionPose()`：把动作写过的参数设回 `getParameterDefaultValue()`，
再重新存一次快照。手机 / 表情「回不去」这一整类问题都一起解决了。
回归测试直接读**模型参数**（不是我们自己的状态）：动画中 12 个参数被改动，结束后全部回到默认。

### 弹窗不再一次左一次右

旧写法是「把位移清零 → 量面板位置 → 据此设位移」，而位移本身有过渡动画，
量到动画中间态就会一次算左一次算右，靠墙时还会卡进墙里一半。
现在 `placePanel()` 是纯计算：桌宠在屏幕左半边就往右开、右半边就往左开，再兜底夹进视口。
气泡、菜单、钱包、输入框都走它。测试连开三次，位置必须逐个字符一致。

### 其它

- 「说话」按钮改成开关：点一次开、再点一次关（以前再点只会重新打开，像关不掉）。
- 气泡也支持纵向兜底位移，桌宠拖到屏幕顶端时不会被切掉。
- 竖直位置的安全夹（别让底下三个按钮被屏幕切掉）在拖动和惯性里也生效了。


## 0.3.1 — 2026-09-25

> **English summary / 英文摘要**
>
> All of these were reported by users: snapping is **side-only** (the vertical position stays exactly
> where you put her), the composer only opens from the Speak button (double-clicking the model no longer opens
> it), the wallet's × closes the wallet instead of the menu, right-click toggles it, and a freely-dropped pet is
> no longer pulled back to the wall after a reload.

### 交互修正（都是主人报的）

- **输入框不再乱弹**：以前双击模型会弹出输入框，现在只有点工具栏「说话」才开；
  双击仍然算戳她一下。
- **钱包的 × 修好了**：以前那个 × 一律去关菜单，钱包不是菜单管的，所以点了没反应。
- **右键变成开关**：点一次开钱包，再点一次收起（以前第二次右键会被「点外面就关」抢先关掉再被打开）。
- **只吸左右墙，不吸底部**：松手时靠左/右墙就吸过去，**竖直位置保持你放的高度**；
  离两侧都远就停在原地。竖直方向只做「别让底下三个按钮被屏幕切掉」的软夹。
  存档从 `corner`（左下/右下角）改成 `{edge, edgeY}`，老存档自动迁移。
- 顺带修掉：从墙边拖到自由位置后，存档里还留着旧的 `edge`，重载会被拉回墙上。


## 0.3.0 — 2026-09-25

> **English summary / 英文摘要**
>
> New: **right-click opens a wallet HUD** — remaining balance (DeepSeek's official `user/balance`
> endpoint), this turn's cost (auto-popped when a turn ends: money + tokens), today's total, peak hours in red /
> off-peak in green, and a countdown to the next price change. The accounting is computed inside the host and
> does **not** depend on `dsh-whale-widget`. The HUD never fights the chat for screen space. Host-side changes
> need a DSH restart.

### 右键 = 钱包 HUD（余额 / 本轮消耗 / 峰谷计价）

- **右键不再弹设置**，改成弹一个醒目的框：剩余余额、本轮消耗、今日已用、**峰（红）/谷（绿）**、距下一次峰谷切换还有多久。
- 每一轮结束**自动弹出**「本轮消耗」（金额 + tokens），9 秒后自己收；鼠标停上去不会被打断。
- **计价自己做在宿主里**，不依赖任何别的插件：DeepSeek 官方 `user/balance` 取余额
  （key 走 DSH 凭据服务 `DEEPSEEK_API_KEY`），峰谷按官方规则（工作日 9–12 / 14–18 为高峰，
  周末、调休上班日、法定节假日全天为谷），按 命中/未命中/输出 三个口径分别计价
  （Flash 0.02/1/4，高峰 ×2；Pro 为 3 倍）。
- 新增宿主接口 `GET /dsh-pet/hud` 与 SSE 事件 `hud-turn`。
- 前端优先读自己的接口；装了 `dsh-whale-widget` 时回退用它的账本对账（实测那个插件被停用后其接口是 404，所以才要自带）。
- **不与对话抢屏幕**：开菜单时 HUD 自动收起、点击别处/`Esc` 可关、面板会被夹回视口内不会被切掉。
- 测试：静态/宿主 **158 项**、浏览器端 **127 项**（含「计价公式正确」「宿主接口挂了要能降级」）。


## 0.2.0 — 2026-09-25

> **English summary / 英文摘要**
>
> First release: the Live2D whale girl as a desktop pet inside the DeepSeek Harness Web UI. A
> four-tab menu — expressions / accessories / scenes / actions, with temporary / persistent / persistent /
> one-shot lifetimes — every one of them mapped from the original model author's 52-hotkey sheet. One-click
> reset, and she no longer gets angry from casual clicking. Code MIT © 2026 Andersen216; artwork
> CC BY-NC-SA 4.0, non-commercial, credited to 上善无形 / ZipZipPipe / 氵六青.

这一版把「菜单里点了没用」「工作模式卡死」「老是生气」这几个体验问题集中修掉了，
并且**把动作表整个换成原作者自己的按键表**。

### 按原作者的按键表重建了动作体系

- 读了模型包里的 `按键表.txt` 与 `c_0120.vtube.json`（52 条热键），逐条对照后重排菜单：
  **表情 / 装饰 / 场景 / 动作** 四页，规矩分别是「临时 3~4 秒 / 常驻 / 常驻 / 一次性」。
  逐条对照见 [`docs/作者按键表-对照.md`](docs/作者按键表-对照.md)。
- **装饰**：四副眼镜、三张贴纸、情绪花花、单边马尾、发箍、头顶鲸鱼 —— 一直存在，同类互斥。
- **场景**：深色桌布、鲸鱼放桌上、巴菲、粉/白魔爪、掏出手机、手机换色 —— 一直存在。
- **动作**（新增一批）：猫爪摆手、喵喵手、双手比耶、冒爱心、心跳、MoeMoeQ~、
  橡皮擦、撤回、蛋包饭、自拍、快速自拍、鲸鱼喷水 —— 演一遍就消失。
- 照搬作者的前置依赖：**白魔爪 → 粉魔爪**、**手机换色 / 自拍 / 快速自拍 → 掏出手机**
  （点的时候自动补前置，不会再出现「素材没亮所以看不出效果」）。
- 自带表情变化的动画（自拍、喷水、番茄酱、猫爪）**不再叠一张我们的脸**，
  交还给动画本身，避免「冲突 / 覆盖」。
- 作者把「鲸鱼喷水」绑在左键上，所以戳她的时候也会偶尔喷一下水。
- 「闭眼口水」按作者按键表（Alt+T）恢复；呆呆眼 / 晕晕 / 泡泡糖 / 重锤出击仍然不上。

### 菜单表情改成「临时」

- 点菜单里的表情只演 **3.6 秒**（一次性层），到点自己让位，平常状态永远是**平常脸**。
- 期间她自己的表情、agent 事件、或者你再点一个，都会立刻把它顶掉。
- 不再使用 30 秒的手动常驻层；「表情」页按**表情**去重（星星眼只出现一次）。

### 修掉「工作模式卡死」（主人报的 bug）

- 病根：一键重置**没有停掉干活轮播**，9~14 秒后底层状态又被推回「看资料 + 星星眼」，
  看起来就是「重置也救不回来」。
- 现在重置 = 停轮播 + 清空所有道具层（含手机）+ 清掉临时表演 + 脸回平常，
  重置后 8 秒内的采样必须一直是「本子 + 笔 + 平常脸」（回归测试盯着）。
- 蛋包饭按主人要求做成**一次性**：挤完番茄酱就消失，绝不留在桌上。

### 点她不再动不动就生气

- 旧的连点判定是「两次点击间隔 < 1.8 秒就累加」，于是每 1.5 秒点一下，第三下就炸毛。
- 现在是**滑动窗口 + 平均间隔**的真速率判定：
  ≤ 2 次/秒 永远是可爱反应；2.4 次/秒以上只是撒娇抗议；3.8 次/秒以上且窗口内 ≥7 下才真炸毛，
  而且炸毛后有 6 秒冷静期。
- 平常戳身子池里已经没有任何「生气的脸」；摸头池里「被叫胖」那条权重压到 0.4。
- 待机不再无缘无故摆生气脸（换成了流汗）。

### UI

- **底下三个按钮**原来被 `left:50%` 挤成 104px 宽、文字折行后高 66px；现在
  `width:max-content` + 缩小一号 → 48×20，排成一行。
- **大小滑块现在可以一路拖到底**：拖的时候冻结 UI 缩放，滑块轨道不会再从鼠标底下跑掉。
- 菜单面板不再被屏幕边缘切掉（自动夹回视口内），`Esc` 可关，顶部多了「现在是什么状态」。
- 每个菜单项都有配好的台词（鼠标悬停能看到她会说什么）。

### 发布相关

- 插件改名为 **`dsh-whale-girl-live2d`**（中文名「鲸鱼娘桌宠 —— DSH 里的 Live2D 鲸鱼娘」）。
  原因：`dsh-whale-girl` / `dsh-whale-girl-pet` / `dsh-whale-pet` 在 npm 上**都已被别人的
  鲸鱼娘桌宠占用**，撞名会导致市场装错包。
- 署名：**Andersen216**（插件作者）；模型/角色：上善无形、ZipZipPipe、氵六青（CC BY-NC-SA 4.0，非商业）。
- 新增 `AUTHORS.md`、`docs/发布到插件市场.md`、`docs/投稿条目.yml`、
  `npm run release:github` / `npm run release:check`（一条命令建仓库 + 推代码 + 提市场 PR）。

### 新增测试与工具

- `npm run test:catalog`：把 44 个表情 / 11 个装饰 / 6 个场景 / 12 个动作逐个点一遍，
  用像素差客观测「点了到底有没有反应」（现在 0 个哑按钮）。
- `npm run test:e2e:ui`：用 CDP 真鼠标事件验证滑块拖拽与按钮尺寸。
- `npm run repro:stuck`：复现「工作模式 + 互动 + 一键重置」那条链路的时序。
- 回归测试总数：静态 149 项、浏览器端 97 项，全绿。

## 0.1.0 — 2026-09-24

- 第一版：模型常驻 DSH Web GUI，由 agent 事件驱动表情与动作，气泡说话，
  点击/拖拽/贴边、右键菜单、一键重置、隐藏与找回、按 mtime 热更新。
