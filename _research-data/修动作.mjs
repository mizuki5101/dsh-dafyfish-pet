/**
 * 按主人反馈修动作。
 *
 * 反馈 → 原因 → 修法（全部有实测依据，见 全部方向.txt / 点头方向.txt / 眉眼方向.txt）：
 *  1) 「挥左手」手藏到身后，「挥右手」正常
 *     → 镜像骨架：Param_arm_L* 抬手要用**负**值，R* 用**正**值；我两边都写了正号。
 *     → 顺便：Param_arm_L4/R4 满量程只动 1px，直接不用。
 *  2) 点头/歪头看不出 → 幅度太小。点头用满量程的 ~2/3（ParamAngleY 是三轴里最弱的），
 *     摇头 ±16、歪头 +18（ParamAngleZ 是最强的头轴，303px）。
 *  3) 鞠躬没反应 → 站姿立绘没有"弯腰"绑定，只能做成慢速点头，名不副实 → **删掉**。
 *  4) 伸懒腰奇怪 → 手臂符号反了（左臂往身后走）。修符号 + 加强哈欠/仰头。
 *  5) 顺带修两个**死表情**：微笑绑 ParamEyeSmile、生气绑 ParamEyeAnger，
 *     这两个参数在模型里没有任何形变绑定（物理输出且无下游视觉），点了完全没反应。
 *     → 微笑改绑 ParamMouthForm，生气改绑眉毛 ParamBrowLAngle/RAngle（实测往下=皱眉）。
 *  6) 顺带：装饰/场景两页是**完全空的**（鲸鱼娘遗留项全被 EXPR 过滤），把这两个页签删掉。
 */
import fs from 'node:fs'

/*
 * ⚠️ pet.js 是 **CRLF** 换行的（manifest.json 反而是 LF）。
 * 之前用 LF 锚点做字符串匹配一直失败，就是这个原因。
 * 这里统一：读进来归一成 LF 做匹配 → 写回去再转成 CRLF（顺便把之前脚本漏进去的
 * 22 行孤立 LF 也一并收拾干净）。
 */
const PET = 'D:/AI_work_space/live2D桌宠/pet-plugin/assets/pet.js'
const raw = fs.readFileSync(PET, 'utf8')
const crlfCount = (raw.match(/\r\n/g) || []).length
const loneLf = (raw.match(/(?<!\r)\n/g) || []).length
let s = raw.replace(/\r\n/g, '\n')
const before = s.length
const log = []

function cut(a, b, rep, label) {
  const i = s.indexOf(a)
  if (i < 0) throw new Error('[' + label + '] 找不到起点')
  const j = s.indexOf(b, i)
  if (j < 0) throw new Error('[' + label + '] 找不到终点')
  const n = s.slice(i, j).split('\n').length
  s = s.slice(0, i) + rep + s.slice(j)
  log.push(label + '：替换 ' + n + ' 行')
}
function dropLine(frag, label) {
  const esc = frag.replace(/[.*+?^${}()[\]|\\]/g, '\\$&')
  const re = new RegExp('\\n[^\\n]*' + esc + '[^\\n]*', 'g')
  const n = (s.match(re) || []).length
  if (n !== 1) throw new Error('[' + label + '] 期望 1 行，实际 ' + n)
  s = s.replace(re, '')
  log.push(label + '：删除 1 行')
}

// ═══ 1. 重写动作库 ═══
cut('    var CLIPS = {', '    /*\n     * ASCII 别名。', `    var CLIPS = {
      /*
       * ⚠️ 手臂符号是**实测**出来的，别凭感觉改。
       * 模型是镜像骨架：Param_arm_L* 的"抬手"是**负**值，Param_arm_R* 是**正**值。
       * 两边写同一个正号 → 一边抬起来、另一边转到身后（主人就是这么发现的）。
       * 复现工具：_research-data/测全部方向.mjs
       *
       * 另外 Param_arm_L4/R4（手活动）满量程只动 1px，等于没用，所以动作里不用。
       * 命名按**屏幕**视角：L* = 屏幕左侧那只手（正好也是模型自己的"左"）。
       */
      '挥手(左)': {
        duration: 2.5,
        tracks: [
          { id: 'Param_arm_L1', keys: [[0, 0], [0.32, -25, 'out'], [1.95, -26], [2.35, 0]] },
          { id: 'Param_arm_L2', keys: [[0, 0], [0.36, -9, 'out'], [1.95, -10], [2.35, 0]] },
          { id: 'Param_arm_L3', keys: [[0, 0], [0.5, 0], [0.68, -17, 'inout'], [0.92, 15, 'inout'], [1.16, -17, 'inout'], [1.4, 13, 'inout'], [1.64, -9], [1.95, 0], [2.35, 0]] },
          { id: 'ParamAngleZ', keys: [[0, 0], [0.45, 3.2], [1.95, 3.2], [2.35, 0]] }
        ]
      },
      '挥手(右)': {
        duration: 2.5,
        tracks: [
          { id: 'Param_arm_R1', keys: [[0, 0], [0.32, 25, 'out'], [1.95, 26], [2.35, 0]] },
          { id: 'Param_arm_R2', keys: [[0, 0], [0.36, 9, 'out'], [1.95, 10], [2.35, 0]] },
          { id: 'Param_arm_R3', keys: [[0, 0], [0.5, 0], [0.68, 17, 'inout'], [0.92, -15, 'inout'], [1.16, 17, 'inout'], [1.4, -13, 'inout'], [1.64, 9], [1.95, 0], [2.35, 0]] },
          { id: 'ParamAngleZ', keys: [[0, 0], [0.45, -3.2], [1.95, -3.2], [2.35, 0]] }
        ]
      },
      /*
       * 点头：ParamAngleY 是三条头轴里**最弱**的（满量程最大位移 137px，
       * 摇头 196px、歪头 303px），整颗头满量程只上下移动约 61px（画布高 4992 的 1.2%）。
       * 所以这里直接推到 2/3 量程，并且**加快节奏**让它读起来像个点头。
       * 负 = 低头（实测：-30 比 +30 多低 11px，嘴也跟着往下 23px）。
       */
      '点头': {
        duration: 1.4,
        tracks: [
          { id: 'ParamAngleY', keys: [[0, 0], [0.26, -22, 'inout'], [0.55, 0, 'inout'], [0.82, -18, 'inout'], [1.12, 0]] },
          { id: 'ParamAngleX', keys: [[0, 0], [0.3, 1.5], [0.9, 0]] },
          { id: 'ParamAngleZ', keys: [[0, 0], [0.35, -2], [0.95, 2], [1.3, 0]] }
        ]
      },
      '摇头': {
        duration: 1.7,
        tracks: [
          { id: 'ParamAngleX', keys: [[0, 0], [0.28, 16, 'inout'], [0.66, -16, 'inout'], [1.04, 12, 'inout'], [1.36, -8], [1.62, 0]] },
          { id: 'ParamAngleZ', keys: [[0, 0], [0.32, -3], [1.05, 3], [1.62, 0]] }
        ]
      },
      '歪头': {
        duration: 2.0,
        tracks: [
          { id: 'ParamAngleZ', keys: [[0, 0], [0.5, 18, 'out'], [1.5, 18], [1.95, 0]] },
          { id: 'ParamAngleY', keys: [[0, 0], [0.5, 3], [1.5, 3], [1.95, 0]] }
        ]
      },
      '尾巴快摆': {
        duration: 2.6,
        tracks: [
          { id: 'ParamBreath', keys: [[0, 0.12], [0.28, 0.5, 'inout'], [0.55, 0.14, 'inout'], [0.82, 0.5, 'inout'], [1.09, 0.14, 'inout'], [1.36, 0.47, 'inout'], [1.63, 0.15, 'inout'], [1.9, 0.38], [2.2, 0.08], [2.5, 0]] },
          { id: 'ParamAngleZ', keys: [[0, 0], [0.5, 2.2], [1.3, -2.2], [2.0, 1.2], [2.5, 0]] }
        ]
      },
      '换重心': {
        duration: 4.4,
        tracks: [
          { id: 'ParamAngleZ', keys: [[0, 0], [0.65, 6.5, 'inout'], [1.85, 6.5], [2.5, -6.5, 'inout'], [3.7, -6.5], [4.3, 0]] },
          { id: 'ParamAngleX', keys: [[0, 0], [0.7, 2], [2.5, -2], [4.3, 0]] }
        ]
      },
      /*
       * 伸懒腰：本来两只胳膊要一起往上举，但左臂符号反了 → 一只手跑到身后，
       * 看起来就很怪。现在两边符号各自正确，再配合仰头（+Y）和打哈欠（张嘴）。
       * 注意 ±30 是硬上限，"举过头顶"做不到，只能做到"往两侧上方张开"。
       */
      '伸懒腰': {
        duration: 4.2,
        tracks: [
          { id: 'Param_arm_L1', keys: [[0, 0], [0.8, -26, 'out'], [2.3, -27], [3.6, 0]] },
          { id: 'Param_arm_R1', keys: [[0, 0], [0.8, 26, 'out'], [2.3, 27], [3.6, 0]] },
          { id: 'Param_arm_L2', keys: [[0, 0], [0.85, -8], [2.3, -9], [3.6, 0]] },
          { id: 'Param_arm_R2', keys: [[0, 0], [0.85, 8], [2.3, 9], [3.6, 0]] },
          { id: 'ParamAngleY', keys: [[0, 0], [0.9, 8, 'out'], [2.3, 9], [3.6, 0]] },
          { id: 'ParamAngleZ', keys: [[0, 0], [0.95, -4], [2.3, 4], [3.6, 0]] },
          { id: 'ParamMouthOpenY', keys: [[0.6, 0], [1.1, 0.55], [2.4, 0.5], [3.0, 0]] }
        ]
      }
    }

`, '动作库重写')

// ═══ 2. 删掉菜单里的「鞠躬」═══
dropLine("bow: { label: '鞠躬'", '删「鞠躬」菜单项')

// ═══ 3. 删掉空页签「装饰 / 场景」═══
dropLine("['decor', '装饰'],", '删「装饰」页签')
dropLine("['scene', '场景'],", '删「场景」页签')

fs.writeFileSync(PET, s.replace(/\n/g, '\r\n'), 'utf8')
log.push('换行符：原 ' + crlfCount + ' 行 CRLF + ' + loneLf + ' 行孤立 LF → 统一 CRLF')
log.push('pet.js 体积 ' + before + ' -> ' + s.length + ' 字符（LF 计数）')

// ═══ 4. 修 manifest 里两个死表情 ═══
const MP = 'D:/AI_work_space/live2D桌宠/pet-plugin/assets/model/manifest.json'
let m = fs.readFileSync(MP, 'utf8')
const smileOld = `    "微笑": {
      "params": [
        {
          "id": "ParamEyeSmile",
          "value": 1,
          "blend": "Add"
        }
      ]
    },`
const smileNew = `    "微笑": {
      "params": [
        {
          "id": "ParamMouthForm",
          "value": 1,
          "blend": "Add"
        }
      ]
    },`
if (!m.includes(smileOld)) throw new Error('[微笑] manifest 没匹配上')
m = m.replace(smileOld, smileNew)
log.push('manifest「微笑」：ParamEyeSmile(死) → ParamMouthForm(活，334 点/17.8px)')

const angryOld = `    "生气": {
      "params": [
        {
          "id": "ParamEyeAnger",
          "value": 1,
          "blend": "Add"
        }
      ]
    }`
const angryNew = `    "生气": {
      "params": [
        {
          "id": "ParamBrowLAngle",
          "value": -1,
          "blend": "Add"
        },
        {
          "id": "ParamBrowRAngle",
          "value": -1,
          "blend": "Add"
        }
      ]
    }`
if (!m.includes(angryOld)) throw new Error('[生气] manifest 没匹配上')
m = m.replace(angryOld, angryNew)
log.push('manifest「生气」：ParamEyeAnger(死) → 两条眉毛往下(皱眉，279 点/43.8px)')
fs.writeFileSync(MP, m, 'utf8')
JSON.parse(m)   // 确保还是合法 JSON
log.push('manifest JSON 校验通过')

console.log(log.join('\n'))
