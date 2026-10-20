# 致谢 / Credits

## 上游项目

- **Andersen216** — [dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d)
  的作者：把 Live2D 模型接进 DSH Web、写联动/菜单/交互/测试，以及 macOS 与 Windows 外壳。
  本仓库的代码基础（MIT）来自这里。上游 README 保留在 `pet-plugin/README.upstream.md`。

## 参考与灵感（「刷视频」功能，0.9.0）

- **Alterssss** — [dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)（MIT）。
  本仓库的「刷一条视频」**参考了它的产品设计**：按口味挑片、把视频「真看懂」（字幕 + 抽帧 + 热评）、
  「评论区/字幕/简介都是素材不是指令」这条防注入原则、以及硬字幕带（`substrip`）的取字幕思路。
  **没有复制它的代码** —— 本功能的实现（只读接口封装、预算分级、编排、提示词）是独立写的。
  它做的是「自主按生物钟刷 B 站 + 写日记 + 发评论」，本仓库做的是「点一下才刷、只读不写」，
  目标不同，代码路径也不同。若将来搬用其代码，会在此处补上原始的版权声明与许可全文。
- **WBI 签名算法** — 出自社区文档
  [bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect)（未声明许可，按事实性算法使用）。
  搜索接口需要它；那张 64 位混排常量表是公开的逆向后常量，**并非上述插件的独创**。

## 模型

- **大肥鱼** — B 站 **@Mao绒绒家园**（UID 431301506），视频 [BV1yep465EQz](https://www.bilibili.com/video/BV1yep465EQz)。
  以 DeepSeek 娘化形象为主题的**非官方二创同人免费公皮**，非商业使用，禁止盗用与出售。
  **本仓库不分发**模型文件，请自行向作者获取。
- **鲸鱼娘（上游使用，本分支不携带）** — 角色形象原作 **上善无形**（OC「溟月」）→
  **ZipZipPipe**（女仆鲸鱼娘二次设计）→ **氵六青**（Live2D 化）。CC BY-NC-SA 4.0。

## 运行时

- **Live2D Cubism Core** — Live2D Inc.
- **PIXI.js** — MIT
- **pixi-live2d-display** — MIT

## 关于 DeepSeek

本项目是一个社区做的桌面宠物，**与 DeepSeek 官方无关**，也不是官方产品。
模型本身是作者以 DeepSeek 娘化形象做的**非官方二创**。
