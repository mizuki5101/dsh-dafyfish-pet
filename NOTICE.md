# NOTICE —— 许可分层

`LICENSE`（MIT）**只覆盖本仓库的代码**。仓库里还带着第三方运行时，它们各自另有条款。

## 1. 代码 / Code —— MIT

范围：`pet-plugin/lib/`、`pet-plugin/tools/`、`pet-plugin/assets/pet.js`、`shell/`、`_research-data/`、文档

- 上游：**Andersen216** — <https://github.com/Andersen216/dsh-whale-girl-live2d>（MIT）
- 本分支的修改：见 `LICENSE` 第二行（请自行填上你的名字/ID）

## 2. 模型 / Model —— **本仓库不分发**

本仓库**不含任何** `.moc3`、贴图、`physics3.json`、`cdi3.json`。
使用者需自行从原作者处获取（见 `pet-plugin/assets/model/README.md`）。

| 模型 | 作者 | 条件 |
|---|---|---|
| 大肥鱼（本项目使用） | B 站 **@Mao绒绒家园**（UID 431301506），视频 **BV1yep465EQz** | 免费公皮、**非商业**、禁止盗用与出售；**未授权二次配布**，故本仓库不携带 |
| 鲸鱼娘（上游使用） | **上善无形 / ZipZipPipe / 氵六青** | CC BY-NC-SA 4.0。本分支**也不携带**（未为它做兼容） |

> 模型参数的驱动信息（`manifest.json` 的表情参数表、`rig-params.json` 的参数范围、
> `dfyfish.model3.json` 的引用关系）是**我们用自己的工具量出来的配置**，不包含任何美术数据。
> 如果原作者有异议，删掉这几个文件只会让表情/动作失灵，不会影响其它功能。

## 3. 第三方运行时 / Runtime

| 组件 | 许可 | 版权 |
|---|---|---|
| Live2D Cubism Core（`assets/vendor/live2dcubismcore.min.js`） | Live2D Proprietary License（Redistributable Code） | Live2D Inc. |
| PIXI.js 6.5.10（`assets/vendor/pixi.min.js`） | MIT | PIXI.js contributors |
| pixi-live2d-display 0.4.0（`assets/vendor/cubism4.min.js`） | MIT | pixi-live2d-display contributors |

Cubism Core 按 Live2D 的许可**原样**随本应用分发，未做任何修改。

## 4. 本项目是非商业的

不收费、不带货、不接广告变现、不卖周边、不作为任何付费产品或服务的卖点。
模型作者的无偿分享**不解除**上面那些许可里的 NC 条款。

有任何权利主张请开 issue，说明**文件名 + 依据**，核实后立即替换或移除。
