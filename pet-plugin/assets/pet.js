/**
 * dsh-live2d-pet —— 桌宠前端。
 * [本机改动 build-2] 只在桌面外壳渲染 + 大肥鱼模型 + 水印常关
 *
 * 版权：上游 dsh-whale-girl-live2d 的版权归 Andersen216 所有（MIT，见同目录 LICENSE）。
 * 本文件是在其基础上魔改的版本，同样以 MIT 分发。
 *
 * 这份文件是桌宠的「大脑 + 身体」，改这里的常量就能改它的性格。
 *
 * 设计要点（每条都是踩过的坑）：
 *
 * 1. 模型是一套 VTube Studio 资产：44 个「表情」其实是 44 组参数开关，
 *    而且全是 Add 混合。所以不用框架的 expressionManager（它会和一次性动作抢
 *    同一批参数），自己实现 rig，挂在 InternalModel 的 beforeModelUpdate 上——
 *    那是 model.update() 之前的最后一站：动作、眨眼、视线、物理都已算完，我们加上
 *    去的一定生效；而每帧结尾 model.loadParameters() 又会把参数还原，所以写入不会
 *    跨帧累积，道具能稳定保持、情绪能干净回退。
 *
 * 2. 情绪（脸）互斥、道具（眼镜/贴纸/家具）粘性，分开管理。权重降到 0 的表达式
 *    就不再写参数，把参数交还给动作——这样「伸展」「自拍」这些自带表情的一次性
 *    动作才不会被 rig 抹平成面瘫。
 *
 * 3. 命中判定用 alpha 掩码而不是包围盒：这个模型是一整个「书桌场景」，
 *    包围盒里大半是空气。点空气要让事件穿透到下面的 DSH 界面，点在人身上才吃掉
 *    事件——这才是桌宠该有的手感。（掩码靠 preserveDrawingBuffer + postrender 取，
 *    因为 Live2DModel 自己没有 bounds，extract 拿不到东西。）
 *
 * 4. 事件来自宿主 SSE（真实 agent 活动），不是猜的；气泡里的字是逐字长出来的。
 *
 * 5. 尺寸只信 internalModel.width/height：Live2DModel 继承 PIXI Container，
 *    没有自己的 width 取值器，用 model.width 会拿到 0。
 */
;(function () {
  'use strict'

  if (window.__DSH_PET_LOADED__) return
  window.__DSH_PET_LOADED__ = true

  // —— 只在桌面外壳里渲染（本机改动）——
  // 这是同一份 pet.js，会被用在两个地方：① DSH Web 界面里（插件往 index.html 注入
  // <script>）② 桌面外壳加载的 /dsh-pet/standalone 页。
  // 两处同时开着就会出现「两条鱼」。这里用 standalone 页独有的 CSS 变量做判据，
  // 让 Web 界面那份直接不渲染；桌面外壳那份照常。
  // 想恢复「Web 界面里也显示」，把这段删掉即可。
  try {
    // 注意：marker 写在 <style> 规则里而非内联 style，
    // 所以必须用 getComputedStyle 读 —— document.body.style.getPropertyValue()
    // 只读内联样式，永远是空串（这就是第一版把桌面外壳也一起挡掉的原因）。
    // 判据双保险：standalone 页由插件后端硬编码 body{--dsh-pet-standalone:1}。
    //   ① 计算样式（cascade 解析后，最可靠）
    //   ② 内联 style 属性（万一以后有人把它改成内联写法）
    //   ③ DOM 特征兜底：standalone 页的 <title> 就是「DS 鲸鱼娘 · 桌宠」
    // 任一命中即认为在桌面外壳里。只在两处都不像外壳时才 return。
    var __standalone = false
    if (document.body) {
      if (window.getComputedStyle) {
        __standalone = window.getComputedStyle(document.body)
          .getPropertyValue('--dsh-pet-standalone').trim() !== ''
      }
      if (!__standalone) {
        __standalone = document.body.style &&
          document.body.style.getPropertyValue('--dsh-pet-standalone').trim() !== ''
      }
    }
    if (!__standalone) {
      var __t = (document.title || '')
      __standalone = __t.indexOf('桌宠') !== -1 && __t.indexOf('鲸鱼') !== -1
    }
    if (!__standalone) return
  } catch (e) {}

  const BOOT = window.__DSH_PET_BOOT__ || {}
  const CFG = Object.assign(
    {
      height: 180, // 桌宠是常驻挂件：默认约原来 1/3 的占地面积
      corner: 'br',
      lookAtCursor: true,
      talkMouth: true,
      sleepAfterMs: 180000,
      bubbleTtlMs: 0,
      maxWidthRatio: 0.5,
      // 视线跟随三旋钮。上游只把它们写在 gazeCfg() 的兜底分支里（滑块却能写 CFG），
      // 默认值散在两处；这里收进 CFG，成为唯一来源。数值与上游原默认值一致。
      gazeRadius: 0, // 0 = 整屏跟随
      gazeGain: 0.9, // 跟随幅度
      gazeRate: 3.2, // 每秒最多变化多少
      /** 常驻待机层：让她一直在轻微呼吸 / 换重心 / 甩尾巴（这是「活起来」的主要来源） */
      idleMotion: true,
      /** 待机幅度倍率。0 = 关；1 = 默认；上限 2.5（预设会自动改它） */
      idleStrength: 1,
      /** 待机活跃度：行为频率/动作倾向的倍率（-1 安静 ~ +1 活泼）。预设会自动改它 */
      idleLiveliness: 0,
      /** 详细频率面板：待机间隔倍数（1 = 默认；0.5 = 更频繁） */
      idleIntervalScale: 1,
      /** 详细频率面板：每个待机行为的频率倍数（缺省 1；0 = 不进池） */
      idleWeightScale: {},
      /** 详细频率面板：每段小戏的频率倍数（缺省 1；0 = 不随机出现） */
      scriptWeightScale: {},
      /** 待机动作：允许「待机时播放肢体动作」的概率（0 = 上游的「待机不放动作」） */
      idleClipChance: 0.35,
      /** 待机时视线游移幅度倍率（1 = 上游原值 ±0.11）。越大越像「在看东西」 */
      gazeDrift: 1,
      /** 互动感知（S2）：她能不能感觉到「你凑过来了 / 盯着看 / 甩鼠标 / 在旁边打字」 */
      idleReact: true,
      /** 系统声音「突然播放」感知（2026-10-17）：外壳轮询 WASAPI 峰值，安静 5 分钟后突然有声 → 她竖耳朵 / 睡着时惊醒。关掉后外壳不跑轮询 */
      suddenAudio: true,
      /** 互动强度：缩放反应的概率与冷却（0 几乎没反应 ~ 2 很黏人）。预设会带上它 */
      idleReactStrength: 1,
      /** 待机节奏长短句（@idle-rhythm）：发呆期 / 常态 / 活跃期三档。false = 退回上游的均匀 3.5~7.5s */
      idleRhythm: true,
      /** 待机性格偏向：-1 更安静（间隔拉长）~ +1 更活泼（间隔缩短、更容易连做） */
      idleMoodBias: 0,
    },
    BOOT.config || {},
  )

  const BASE = '/dsh-pet'
  const LS_KEY = 'dsh-live2d-pet:layout'

  /**
   * 设置持久化：把 CFG 里可序列化的值随 layout 一起存本地。
   */
  function persistCfg() {
    try {
      const snap = {}
      for (const k of Object.keys(CFG)) {
        const v = CFG[k]
        if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') {
          snap[k] = v
        } else if (v && typeof v === 'object' && !Array.isArray(v)) {
          // 详细频率面板的倍数表是普通对象；只存简单值，避免把 DOM/循环引用带进 localStorage
          const o = {}
          for (const kk of Object.keys(v)) {
            const vv = v[kk]
            if (typeof vv === 'number' || typeof vv === 'boolean' || typeof vv === 'string') o[kk] = vv
          }
          snap[k] = o
        }
      }
      saveLayout({ cfg: snap })
    } catch (err) {}
  }

  /** 启动时恢复上次保存的设置 */
  function restoreCfg() {
    try {
      const snap = readLayout().cfg
      if (!snap || typeof snap !== 'object') return
      for (const k of Object.keys(snap)) {
        if (k in CFG) CFG[k] = snap[k]
      }
    } catch (err) {}
  }
  const MOTION_PRIORITY = { NONE: 0, IDLE: 1, NORMAL: 2, FORCE: 3 }
  /**
   * 取景模式。这个模型是一整张「书桌场景」而不是半身立绘，直接整体显示会又小又占地方。
   * 关键是：三档都按「角色实体的高度」算，不是按画布高度算——画布上可能有一大片空气。
   * 实体范围靠启动时自测一次（见 measureContent），所以换任何模型都不用改这里。
   */
  const FIT_FRACTION = { full: 1, bust: 0.62, head: 0.38 }
  /**
   * 视窗宽高比。三档取景共用同一个比例，所以切换档位时桌宠的占地完全不变，
   * 只是「镜头推近」——固定尺寸的挂件位置上跳来跳去很难看。
   */
  const VIEW_ASPECT = 1.15
  /**
   * UI 缩放的基准高度。气泡/按钮/菜单全部用 calc(... * var(--dshp-s)) 跟着模型一起缩放，
   * 否则把模型调小时，气泡和按钮还是原来那么大，看着就不协调。
   */
  const UI_BASE_HEIGHT = 180
  /**
   * UI 缩放上限（本机新增）。配合下面 --dshp-s 的 0.75 次方衰减使用：
   * 模型调到很大时把 UI 封顶，避免气泡和字被一起放大到占满屏。
   * 想完全固定就设 CFG.uiScale（见 ~/.dsh/dsh-live2d-pet.json）。
   */
  const UI_SCALE_MAX = 1.25
  const log = (...a) => console.log('%c[鲸鱼娘]', '#7c5cff', ...a)

  // ——————————————————————————————————————————————————————————————
  // 一、性格表：桌宠「怎么演」全部写在这里
  // ——————————————————————————————————————————————————————————————

  /**
   * 情绪（脸）：同时只有一个。值是 manifest.expressions 里的键。
   * 注意：这些是「自动表情」的词汇表——桌宠平时自己挑，用户的手动选择只是临时覆盖。
   */
  const MOOD_FACE = {
    neutral: null,
    listening: '星星眼',
    thinking: null,
    reading: '星星眼', // 凑近看资料（配合眼镜道具）
    happy: '开心兴奋',
    excited: '星星眼',
    love: '爱心眼',
    shy: '脸红', // 被摸头 / 被夸
    pout: '调皮', // 傲娇：嘴上嫌弃其实开心
    smug: '调皮',
    sad: '悲伤',
    cry: '哭',
    grumpy: '生气', // 「我才不胖」
    dizzy: '晕晕',
    // 注：呆呆眼 / 圈圈眼（晕晕）已从所有自动行为里移除
    gloomy: '阴暗',
    sweat: '流汗',
    confused: '问号',
    alert: '感叹号',
    sleepy: '闭眼口水',
    tongue: '吐舌',
    dead: '吐魂',
    // 兼容旧名字
    angry: '生气',
    playful: '调皮',
  }

  /**
   * 一次性动作：演一次就消失，绝不常驻。
   * 全部走 override 层（带 TTL 自动过期），不写 userProps。
   * `mood: null` = 不压动画自己的表情，把脸交还给动作。
   */
  
  const ACTIONS = {
    waveLeft: { label: '挥左边手', motion: '挥手(左)', ms: 2600, mood: null, note: '屏幕左侧那只手（也就是她自己的右手）', lines: ['（挥挥左边的手）在这儿呢～', '这只手也可以哦', '（摆了摆）看到没'] },
    waveRight: { label: '挥右边手', motion: '挥手(右)', ms: 2600, mood: null, note: '屏幕右侧那只手（也就是她自己的左手）', lines: ['（挥挥右边的手）主人好～', '（招手）过来嘛', '这只手挥挥'] },
    nod: { label: '点头', motion: '点头', ms: 1600, mood: null, lines: ['（点头）嗯嗯！', '知道了～', '（用力点头）'] },
    shake: { label: '摇头', motion: '摇头', ms: 1800, mood: null, lines: ['（摇头）才不要呢', '不行不行～', '（甩了甩头）'] },
    tilt: { label: '歪头', motion: '歪头', ms: 2000, mood: null, lines: ['（歪头）嗯？', '怎么啦～', '（好奇地歪头）'] },
    tailWag: { label: '甩尾巴', motion: '尾巴快摆', ms: 2800, mood: null, lines: ['（尾巴左右甩）开心！', '（尾巴啪啪啪）', '看尾巴～'] },
    shift: { label: '换重心', motion: '换重心', ms: 4600, mood: null, lines: ['（换了个站姿）', '站累了…换只脚', '（左右晃了晃）'] },
    // 合并版：闭眼 + 张手 + 仰头（原「伸懒腰」的手臂 + 原「打哈欠」的闭眼）
    stretch: { label: '伸懒腰', motion: '伸懒腰', ms: 3800, mood: null, lines: ['（伸懒腰）唔——', '伸一下～好舒服', '（闭着眼张开手）啊——'] },
    // S3（2026-10-17）：两个只用根参数的快/慢动作。mood 一律 null，脸交给 clip 自己。
    sneeze: { label: '打喷嚏', motion: '打喷嚏', ms: 1200, mood: null, note: '0.9 秒：快速低头 + 成对闭眼 + 张嘴', lines: ['（阿嚏！）啊——嚏！', '（揉了揉鼻子）唔…谁在说人家', '（吸鼻子）好像有点着凉'] },
    sigh: { label: '叹气', motion: '叹气', ms: 3000, mood: null, note: '2.6 秒：低头 + 闭眼半秒；尾巴靠物理自然沉', lines: ['（叹气）唉……', '（低着头）好累哦', '（长出一口气）白饭还没来'] },

    // —— 阶段 1：表情类动作。mood 一律 null ——
    // 它们自己在 clip 里驱动表情参数（脸红 / 眉毛 / 嘴形 / 眼球），
    // 再让 mood 压一张脸上去就是"两个表情打架"（交接文档里记过这个坑）。
    surprise: { label: '惊讶', motion: '惊讶', ms: 1800, mood: null, lines: ['（吓一跳）诶？！', '（睁大眼睛）真的假的', '啊、啊？'] },
    shy: { label: '害羞', motion: '害羞', ms: 2900, mood: null, lines: ['（脸红）别、别看啦…', '（低头）人家会不好意思的', '唔…走开啦'] },
    think: { label: '思考', motion: '思考', ms: 3100, mood: null, lines: ['（认真想）唔……', '让人家想想', '（歪头）这个嘛…'] },
    lookAround: { label: '左顾右盼', motion: '左顾右盼', ms: 3500, mood: null, lines: ['（东张西望）主人呢？', '（左看右看）在哪儿呢', '咦，人呢'] },
    // （原「打哈欠」菜单项已合并进「伸懒腰」——见 CLIPS 里合并版的注释）
    hug: { label: '要抱抱', motion: '要抱抱', ms: 3100, mood: null, note: '张开双手（原来叫「比个心」，主人说观感更像求抱抱）', lines: ['（张开手）抱抱～', '（伸手）要、要抱一下吗', '（脸红）…可以抱一下的'] },
  }
  const ACTION_KEYS = Object.keys(ACTIONS)

  const ALL_TOGGLES = {}

  /**
   * 两种底层状态下她手上拿什么。
   * 「完成奖励」这类特殊场景的瞬时反应，不进待机循环。
   */
  const IDLE_PROPS = []
  const WORK_PROPS = []

  /**
   * 菜单里每一项「点了会怎样」。
   *
   * 病根不是参数没生效（每个都真的变了），而是**点完之后她本人毫无反应**——
   * 桌上多了盘蛋包饭，她却面无表情地待机，看起来就像按钮坏了。
   *
   * 所以从这一版起：**每一个表情、每一个动作都配一句话 + 一个小动作**，
   * 而且一次只演一个（act() 负责把上一个收干净），不叠、不重复、到点自动收。
   */
  const FACE_ACT = {
    listening: { lines: ['（眼睛发亮）主人你说', '嗯嗯，人家听着呢', '（凑过来）什么什么'] },
    excited: { lines: ['主人主人！有好玩的吗', '（星星眼）人家准备好了', '（蹦）期待！'] },
    happy: { lines: ['嘿嘿，今天心情不错', '（笑）本鲸就是这么厉害', '心情好，看什么都顺眼'] },
    love: { lines: ['最喜欢主人了', '（冒爱心）', '（心跳）不、不是因为主人哦'], heart: true },
    shy: { lines: ['别、别一直看着人家啦', '（脸红）干嘛突然这样', '唔…人家会不好意思的'] },
    pout: { lines: ['哼', '（扭头）人家才没有高兴', '别以为人家好哄'] },
    smug: { lines: ['（眯眼）本鲸很厉害吧', '夸人家两句嘛', '这算什么，小意思'] },
    playful: { lines: ['（闭一只眼）就逗你玩', '略，被人家骗到了吧', '（眨眼）'] },
    sad: { lines: ['呜…人家有点难过', '（低头）', '（抱着膝盖）'] },
    cry: { lines: ['哇——主人欺负人', '（哭）人家不干了啦', '（眼泪汪汪）'] },
    grumpy: { lines: ['（鼓脸）哼！', '人家生气了，真的', '除非给一碗白饭，不然不原谅'] },
    gloomy: { lines: ['（阴暗角落）……', '人家现在心情很差', '（长蘑菇）'] },
    sweat: { lines: ['（冷汗）这个…有点难', '人、人家在努力了', '（擦汗）'] },
    confused: { lines: ['诶？', '（歪头）主人说的是什么', '（问号）人家没听懂'] },
    alert: { lines: ['！（惊）', '（猛地抬头）怎么了怎么了', '吓人家一跳！'] },
    tongue: { lines: ['略略略', '就不理你', '（吐舌头）人家赢了'] },
    dead: { lines: ['（吐魂）人家人家不行了…', '（灵魂出窍）摸鱼被抓到了', '（瘫）需要白饭急救'] },
    sleepy: { lines: ['（打瞌睡）唔…人家没睡', '（流口水）梦见白饭了', '（眯眼）主人让开，挡住光了'] },
  }

  /*
   * 表情页显示哪些、按什么顺序。
   *
   * 为什么要有这张显式表：表情页原来是「遍历 MOOD_FACE（情绪 → 表情）」——
   * 那张映射表是给**鲸鱼娘**写的（星星眼 / 爱心眼 / 悲伤…），
   * 在大肥鱼身上只有 脸红 / 生气 两条能命中，所以这一页长期只有 3 个按钮。
   *
   * 现在改成显式列表：顺序可控，加/减一个表情只改这一行。
   * **没列进来的**（都是有意的）：
   *   · 口型切换 / 3嘴 / 〇嘴 —— 是"换嘴素材"，不是情绪
   *   · 尾巴消失 / 耳朵消失 / 水印消除 —— 是服装/水印开关
   */
  const FACE_MENU = ['脸红', '生气', '挤眼', '担心嘴', '栗子嘴', '龇牙', '流口水', '脸黑', '圈圈眼', '疑惑', '怀疑', '嫌弃', '挑眉']

  /*
   * 「口型」页：纯**换嘴素材**，和"情绪"不是一回事，所以单开一张表 + 单独一个页签。
   *
   * 只放没进表情页的换嘴开关；龇牙 / 流口水 / 担心嘴 / 栗子嘴 虽然也动嘴，
   */
  const MOUTH_MENU = ['口型切换', '3嘴', '〇嘴']
  const MOUTH_LINES = {
    口型切换: ['（换了张嘴）唔…', '这样说话清楚点', '（动了动嘴）'],
    '3嘴': ['（三张嘴）看人家！', '这样能同时吃三碗白饭', '（三张嘴一起说）厉害吧'],
    '〇嘴': ['（嘴成 O 形）哦——', '（惊讶）', '唔…'],
  }

  /**
   * 没挂在任何"情绪"上的表情，点她时说什么。
   * （脸红 / 生气 有对应的情绪条目，走 FACE_ACT，不在这里重复。）
   */
  const FACE_LINES = {
    挤眼: ['（眯起眼睛）嘿嘿～', '这样看得清楚点', '（用力挤了挤眼）'],
    担心嘴: ['（抿着嘴）有点担心…', '唔…会不会出问题', '（不安地看着）'],
    栗子嘴: ['（嘴撅成栗子）唔…', '人家没有不高兴', '（鼓着腮帮子）'],
    龇牙: ['（龇牙）看人家的牙！', '（咧嘴）厉害吧', '嘿嘿，怕了吧'],
    流口水: ['（流口水）好香…', '（盯着看）想吃', '唔…白饭的味道'],
    脸黑: ['（脸一黑）……', '（阴影）人家现在不想说话', '……（沉默）'],
    圈圈眼: ['（眼睛转成圈圈）晕…', '（天旋地转）人家不行了', '（圈圈眼）转晕了…'],
    疑惑: ['（歪头）诶？什么意思', '（疑惑）人家没听懂', '（眨眼）主人再说一遍？'],
    怀疑: ['（眯起一只眼）嗯？真的假的', '（怀疑）主人是不是在骗人家', '（打量）人家看着呢'],
    嫌弃: ['（脸一黑）噫——不要靠这么近', '（眯起眼）人家现在不想理你', '（嫌弃地别过脸）走开啦'],
    挑眉: ['（挑眉）哦？真的假的', '（挑了挑眉）有点意思', '（抬眉）主人再说一遍？'],
  }

  /**
   * 工具 → 桌宠怎么演。
   *
   * 设计原则（改这张表就能改性格）：
   *   · 干活不该是阴着脸的——「跑命令」改成伸长猫爪敲键盘的专注样
   *   · 读/查/翻资料 = 戴眼镜 + 低头凑近看（lean 就是低头幅度）
   *   · 写/改 = 猫爪打字
   *   · 问你 = 问号；交付 = 比耶
   *   · 只有真的出错/卡住才用「汗」「晕」
   */
  /**
   * 工具 → 她在气泡里说的话。
   *
   *   · **按工具分开写**，每个工具好几句，用 pickFresh 轮换，连着同名工具也不重复
   *   · 气泡第二行放**从工具参数里抽出来的具体内容**（跑的是哪条命令、读的是哪个文件），
   *     这样 Agent 里在干什么，桌宠这边能同步看出来
   */
  const TOOL_LINE = {
    bash: ['（挽袖子）跑个命令试试', '让人家敲两行命令', '命令行交给人家', '（噼里啪啦）跑起来了', '这个命令人家熟'],
    read: ['（凑近看）先读一下这份', '人家看看里面写了啥', '翻开看看…', '（认真脸）读一下'],
    write: ['好，人家写出来', '（奋笔疾书）写上了', '这就给你落成文件', '写成文件啦'],
    edit: ['（改改改）这里调一下', '人家把这段改掉', '（橡皮擦）修一修', '这段人家重写一下'],
    glob: ['（翻箱倒柜）找找在哪儿', '人家找找这个文件', '翻一下目录'],
    grep: ['（眯着眼）搜一下关键词', '人家查查哪里用到了', '（翻）搜搜看'],
    web_search: ['（掏手机）上网查一下', '人家搜搜看', '（划手机）查查这个', '网上应该有答案'],
    web_fetch: ['（点开链接）读读这页', '人家看看这个网页', '（凑近屏幕）'],
    search_papers: ['（翻文献）查查有没有人写过', '人家去翻翻论文', '（戴眼镜）查文献去'],
    kb_search: ['（查资料库）人家找找', '翻翻知识库', '（翻）这儿应该有'],
    kb_rag: ['（查资料库）人家找找', '翻翻知识库', '（翻）这儿应该有'],
    kb_ingest: ['（搬书）人家收进库里', '把这份收好'],
    todo_write: ['（列清单）先排个计划', '人家记一下要做啥', '（在本子上划拉）'],
    subagent: ['（招手）叫个分身来帮忙', '人家派个分身去办', '（分工）这就安排'],
    subagent_fork: ['（招手）叫个分身来帮忙', '人家派个分身去办'],
    workflow: ['（排兵布阵）同时开几路', '人家把活儿分一下'],
    ask_user_question: ['（歪头）这个得问问主人', '人家不确定，问一下'],
    present: ['（举起来）喏，给你', '人家交付啦', '（递过去）弄好了'],
    pdf_create: ['（排版）给你出一份 PDF', '人家做份文档'],
    docx_create: ['（排版）给你出份 Word', '人家写份文档'],
    xlsx_write: ['（拉表格）数字给你排好', '人家做个表'],
    pptx_create: ['（做幻灯片）给你排几页', '人家弄个 PPT'],
    sci_draw: ['（画画）人家画一个', '（拿笔）给你画出来'],
    create_goal: ['（立个目标）人家记下了', '这个人家盯着办'],
    update_goal: ['（更新一下目标）', '人家改一下计划'],
    skill: ['（翻手册）人家查查怎么弄', '（翻）这个人家学过'],
    auto_cite: ['（加引用）人家补上出处', '引用人家来配'],
    get_goal: ['（看一眼任务）', '人家看看进度'],
  }

  /** 从工具参数里抽一句「具体在干什么」，让气泡跟 Agent 真正同步。 */
  function toolHint(argsJson) {
    let a = {}
    try {
      a = JSON.parse(argsJson || '{}')
    } catch (e) {
      return ''
    }
    const keys = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'title', 'description', 'prompt']
    let s = ''
    for (const k of keys) {
      if (a[k]) {
        s = String(a[k])
        break
      }
    }
    if (!s && Array.isArray(a.queries) && a.queries.length) s = String(a.queries[0])
    if (!s) return ''
    s = s.replace(/\s+/g, ' ').trim()
    return s.length > 46 ? s.slice(0, 46) + '…' : s
  }

  /** 需要「掏出小设备」的工具（搜索/查资料这类）。用模型自带的开盖动作，不自己编。 */
  const DEVICE_TOOLS = new Set([
    'web_search', 'web_fetch', 'search_papers', 'kb_search', 'kb_rag',
    'search_semantic', 'search_google_scholar', 'pubmed_search_papers',
    'search_arxiv', 'browser', 'fetch',
  ])

  /**
   * 读资料时戴哪副眼镜——**每次随机**，也可能不戴。
   */
  function randomGlasses() {
    const r = Math.random()
    if (r < 0.34) return 'glassesRound'
    if (r < 0.62) return 'glassesSquare' // 半框方眼镜
    if (r < 0.72) return 'glassesOval'
    return null // 三成左右不戴
  }

  const TOOL_REACT = {
    // —— 阅读 / 检索：认真看（眼镜随机：圆框 / 半框方框 / 不戴），低头看本子 ——
    read: { mood: 'reading', prop: 'auto' },
    glob: { mood: 'thinking', prop: 'auto' },
    grep: { mood: 'reading', prop: 'auto' },
    web_fetch: { mood: 'reading', prop: 'auto' },
    web_search: { mood: 'thinking', prop: 'auto' },
    kb_search: { mood: 'reading', prop: 'auto' },
    kb_rag: { mood: 'reading', prop: 'auto' },
    kb_ingest: { mood: 'happy', prop: 'auto' },
    search_papers: { mood: 'reading', prop: 'auto' },
    auto_cite: { mood: 'reading', prop: 'auto' },
    pubmed_search_papers: { mood: 'reading', prop: 'auto' },
    pubmed_pubtator_search: { mood: 'reading', prop: 'auto' },
    search_arxiv: { mood: 'reading', prop: 'auto' },
    pdf_read: { mood: 'reading', prop: 'auto' },
    docx_read: { mood: 'reading', prop: 'auto' },
    xlsx_read: { mood: 'reading', prop: 'auto' },
    pptx_read: { mood: 'reading', prop: 'auto' },
    skill: { mood: 'reading', prop: 'auto' },

    // —— 干活：认真看本子，不摆手、不卖萌 ——
    bash: { mood: 'reading', prop: null },
    write: { mood: 'reading', prop: null },
    edit: { mood: 'reading', prop: null },
    todo_write: { mood: 'happy', prop: 'stickerCat' },
    subagent: { mood: 'thinking', prop: null },
    subagent_fork: { mood: 'thinking', prop: null },
    task: { mood: 'thinking', prop: null },
    workflow: { mood: 'thinking', prop: null },
    ralph: { mood: 'thinking', prop: null },

    // —— 产出 / 交付：干完了才有一点表示 ——
    present: { mood: 'happy', prop: 'stickerCat' },
    pdf_create: { mood: 'happy', prop: 'stickerCat' },
    docx_create: { mood: 'happy', prop: 'stickerCat' },
    pptx_create: { mood: 'happy', prop: 'stickerCat' },
    xlsx_write: { mood: 'happy', prop: 'stickerCat' },
    sci_draw: { mood: 'excited', prop: 'flower' },

    // —— 交互 / 目标 ——
    ask_user_question: { mood: 'confused', prop: null },
    create_goal: { mood: 'alert', prop: 'heartbeat' },
    update_goal: { mood: 'alert', prop: null },
    get_goal: { mood: 'thinking', prop: null },
  }

  /**
   * 人设台词。规格（用户给定）：
   *   · 傲娇嘴甜、嘴硬心软；聪明但懒、爱摸鱼
   *   · 贪吃，喜欢白米饭，把 Token 当口粮
   *   · 不能被叫「胖」，叫了会真生气
   */
  const SAY = {
    idle: [
      '主人~ 人家累了，摸摸头嘛。',
      '主人，人家想吃白饭…',
      '（趴桌上）就眯一小会儿…',
      'Token 也算口粮吧？人家不挑的',
      '主人今天也辛苦啦',
      '（尾巴轻轻摆）',
    ],
    slack: ['就玩一小会儿，主人不会发现的……', '（偷偷摸鱼）', '反正主人也没在看…', '（假装很忙）'],
    start: ['好啦好啦，人家这就开始。', '知道啦，本鲸这就去。', '（挽袖子）看人家的。'],
    done: [
      '看吧，本鲸出马一个顶俩！奖励一碗白饭不过分吧？',
      '搞定～主人快夸人家',
      '（伸懒腰）完事啦',
      '就这？本鲸还没使劲呢',
    ],
    fail: ['呜……这不能怪人家，是任务太难了啦！', '（慌张）不、不是人家的错吧…', '（看表叹气）这个真的好难嘛'],
    head: ['不要突然摸头啦……再摸一下也不是不行。', '唔…头发要乱了啦', '（脸红）就、就一下哦', '哼，本鲸才没有很享受'],
    body: ['喂！别戳人家啦', '痒！主人你干嘛', '哼，本鲸不理你了'],
    many: [
      '够啦够啦！主人你今天很闲嘛',
      '再戳人家要生气了哦',
      '（炸毛）',
      '主人你再戳，人家就咬你了',
      '手、手拿开啦！',
      '（把本子举起来挡）不许戳了！',
      '本鲸也是有脾气的！',
      '哼！不理你了，除非给一碗白饭',
    ],
    /** 快但还没到炸毛：被戳痒了，可爱地抗议一下，不是真生气。 */
    ticklish: [
      '哈哈哈别戳啦，痒！',
      '（躲）主人你手好快',
      '喂喂喂，人家在待机呢',
      '（缩成一团）住手啦',
      '这么快？主人手速好可怕',
      '唔…再戳人家要哼你了哦',
      '（抱着本子躲到角落）',
    ],
    fat: ['你再说一遍？！人家这是可爱，不是胖！', '本鲸这是丰腴！', '（真生气）不许说胖！'],
    hungry: ['主人，人家饿了…有白饭吗', '（盯着你的碗）', '干了这么多活，该管饭了吧'],
    reading: ['（凑近看）', '这份人家得仔细看看', '眼镜呢…哦在脸上', '（认真脸）'],
    /** 收拾桌面的时候说的话。 */
    tidy: ['（收拾一下桌面）', '好啦，人家收起来了', '摆一会儿就够了，人家还要干活呢', '（把东西归位）'],
    thinking: ['让人家想想…', '嗯…这里得捋一捋', '别催别催，快好了', '（咬着笔杆）'],
    working: ['（敲键盘）', '交给人家的就放心', '噼里啪啦…', '（认真工作）'],
    wake: ['唔…怎么了主人', '人家醒着呢', '（揉眼睛）'],
  }
  const pick = (arr) => arr[(Math.random() * arr.length) | 0]

  /**
   * 这里记住上一次挑中的是哪个，下一轮把它排除掉，保证连着点不会撞车。
   */
  const lastPick = new Map()
  /**
   * 权重：条目可以写 `w`（默认 1）。
   * 生气不该和摸摸头一样常见。
   */
  const weightOf = (x) => (x && typeof x === 'object' && typeof x.w === 'number' ? x.w : 1)
  function pickFresh(arr, key) {
    if (!arr || !arr.length) return undefined
    const k = key || 'default'
    const prev = lastPick.get(k)
    const pool = arr.length > 1 && prev !== undefined ? arr.filter((x) => x !== prev) : arr
    let total = 0
    for (const x of pool) total += weightOf(x)
    let r = Math.random() * total
    let chosen = pool[pool.length - 1]
    for (const x of pool) {
      r -= weightOf(x)
      if (r <= 0) {
        chosen = x
        break
      }
    }
    lastPick.set(k, chosen)
    return chosen
  }

  // ——————————————————————————————————————————————————————————————
  // 二、样式
  // ——————————————————————————————————————————————————————————————
  //
  // 注意：这里刻意**不叫 `CSS`** —— 浏览器里 `window.CSS` 是 CSSOM 命名空间，
  // 一旦这个名字没被正确声明，`s.textContent = CSS` 不会报错，只会把样式表内容
  // 写成 "[object CSS]"（12 个字符），整个界面静默失去定位与外观。踩过一次。

  const PET_CSS = `
.dshp-root{position:fixed;z-index:2147483000;pointer-events:none;
  --dshp-s:1;
  /* 面板单独一套缩放：气泡和工具栏可以跟着模型缩得很小，但菜单里有滑块、
     有按钮，缩成指甲盖大小就没法用了。所以面板的缩放被夹在 0.85~1.15。 */
  --dshp-ps:1;
  --dshp-ds:0.86;
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  --dshp-fg:#132043;--dshp-bg:rgba(246,249,255,.96);--dshp-line:rgba(30,60,130,.14);
  /* 鲸鱼蓝（和官网、App 图标同一套色）；只改颜色，别的一律不动 */
  --dshp-accent:#3b62f6;--dshp-radius:14px;transition:opacity .25s ease}
.dshp-root.dshp-hidden{opacity:0;pointer-events:none!important}
/* 恢复用的把手挂在 body 上、不在 .dshp-root 里，所以这里必须是 body 级类：
   用后代选择器会永远匹配不到，隐藏之后就再也找不回来了。 */
body.dshp-pet-hidden .dshp-tab{display:flex}
.dshp-tab:hover{transform:translateY(-1px)}
@media (prefers-color-scheme:dark){.dshp-root{--dshp-fg:#eaf0ff;--dshp-bg:rgba(18,26,48,.95);--dshp-line:rgba(140,175,255,.20);--dshp-accent:#7b9bff}}
.dshp-stage{position:absolute;left:0;bottom:0;pointer-events:none;
  filter:drop-shadow(0 10px 20px rgba(0,0,0,.24))}
.dshp-stage canvas{display:block;pointer-events:none}
/* 气泡用视口坐标（fixed），**脱离 root 坐标系**。本机改动：
   原来它在 root 里靠 --dshp-shift 挪，而 placePanel 又要读 root 的矩形算这个位移，
   气泡一动就影响下一次读取 —— 反馈环，表现就是"气泡动来动去"。
   fixed 之后位置只由「鼠标 + 视口」决定，天然稳定。left/top 由 placeBubble() 写。 */
.dshp-bubble{position:fixed;left:0;top:0;
  transform:translateY(6px) scale(.96);
  margin-bottom:calc(10px * var(--dshp-s));min-width:calc(110px * var(--dshp-s));
  max-width:min(calc(300px * var(--dshp-s)),70vw);pointer-events:auto;
  background:var(--dshp-bg);color:var(--dshp-fg);border:1px solid var(--dshp-line);
  border-radius:calc(var(--dshp-radius) * var(--dshp-s));
  padding:calc(9px * var(--dshp-s)) calc(12px * var(--dshp-s)) calc(8px * var(--dshp-s));
  box-shadow:0 8px 28px rgba(10,14,30,.18);backdrop-filter:blur(14px) saturate(1.3);
  font-size:calc(12.5px * var(--dshp-s));line-height:1.55;opacity:0;visibility:hidden;
  transition:opacity .18s ease,transform .18s ease;overflow-wrap:anywhere;word-break:break-word}
.dshp-bubble.dshp-on{opacity:1;visibility:visible;transform:translateY(0) scale(1)}
.dshp-bubble:after{content:"";position:absolute;left:50%;bottom:-6px;margin-left:-6px;
  width:12px;height:12px;background:var(--dshp-bg);border-right:1px solid var(--dshp-line);
  border-bottom:1px solid var(--dshp-line);transform:rotate(45deg);border-radius:0 0 3px 0}
.dshp-head{display:flex;align-items:center;gap:calc(6px * var(--dshp-s));
  margin-bottom:calc(3px * var(--dshp-s));
  font-size:calc(10.5px * var(--dshp-s));letter-spacing:.04em;color:var(--dshp-accent);font-weight:600}
.dshp-dot{width:calc(6px * var(--dshp-s));height:calc(6px * var(--dshp-s));
  border-radius:50%;background:var(--dshp-accent);flex:none}
.dshp-dot.dshp-pulse{animation:dshp-pulse 1.1s ease-in-out infinite}
@keyframes dshp-pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1.25)}}
.dshp-body{max-height:150px;overflow:auto;white-space:pre-wrap}
.dshp-body::-webkit-scrollbar{width:5px}
.dshp-body::-webkit-scrollbar-thumb{background:var(--dshp-line);border-radius:3px}
.dshp-foot{margin-top:calc(4px * var(--dshp-s));font-size:calc(10px * var(--dshp-s));opacity:.55;min-height:0}
/* 工具栏用视口坐标（fixed），**脱离 root 坐标系**。本机改动：
   原来它在 root 里靠 bottom:-40px 定位，她被拖到屏幕下缘时按钮就跑到屏幕外了
   （和气泡同一个毛病）。fixed 之后位置只由「她可见的位置 + 视口」决定，天然不会被截。
   left/top 由 placeDock() 写。 */
.dshp-dock{position:fixed;left:0;top:0;display:flex;gap:calc(7px * var(--dshp-ds));
  width:max-content;white-space:nowrap;
  pointer-events:auto;opacity:0;transition:opacity .22s ease}

.dshp-root.dshp-hover .dshp-dock,.dshp-root.dshp-open .dshp-dock{opacity:1}
/* 菜单/设置内容过长时**可滚动**（鼠标滚轮、触控板直接搓都行）。
   ⚠️ 这里刻意只给「内容区」限高 + overflow，**不把面板改成 flex 容器** ——
   上次那样改会让内容区塌成 0 高（框弹出来但是空的）。 */
/* ——— 菜单面板：固定大小 + 固定位置（切页签/切动作都不再变来变去）———
   ① 宽高写死（高度也随屏幕兜底），所以「表情 / 口型 / 动作 / 小戏 / 设置」五个页签
      切换时面板尺寸完全一致，不会跳、不会时大时小；
   ② 内容超出就在内容区内部滚动（鼠标滚轮/触控板直接搓）；
   ③ 面板高度留够，永远排在她头顶上方，不会盖住她本人。
   ⚠️ 这里用「固定高度 + 百分比内容区」，**不用 flex 容器** —— flex+min-height:0
   会让内容区塌成 0 高（框弹出来但是空的），我们踩过这个坑。 */
/* 外观：跟随系统 / 浅色 / 深色 —— 手动档位覆盖系统媒体查询 */
.dshp-root[data-dshp-theme="light"]{--dshp-fg:#132043;--dshp-bg:rgba(246,249,255,.96);
  --dshp-line:rgba(30,60,130,.14);--dshp-accent:#3b62f6}
.dshp-root[data-dshp-theme="dark"]{--dshp-fg:#eaf0ff;--dshp-bg:rgba(18,26,48,.95);
  --dshp-line:rgba(140,175,255,.20);--dshp-accent:#7b9bff}
/* 苹果风的克制排版：说明文字更小、更淡；控件行距更松 */
.dshp-hint{font-size:11px;opacity:.62;line-height:1.5}
.dshp-label{font-size:12.5px}
.dshp-btn{font-size:12.5px;padding:7px 12px;border-radius:9px}

/* 面板本体裁掉一切溢出（物理上不可能再出现「文字跑到框外面」） */
.dshp-menu{width:360px!important;height:min(300px, calc(100vh - 200px))!important;
  overflow:hidden!important;box-sizing:border-box!important}
/* 内容区：给出**明确的像素高度**（不依赖百分比解析），并保持可滚动。
   ⚠️ 上一版这里写的是 max-height:none —— 它把负责限高的那条规则干掉了，
   于是内容直接溢出到框外（主人截图里文字跑出面板就是这个原因）。 */
.dshp-menu .dshp-panes{
  height:calc(min(300px, 100vh - 200px) - 42px)!important;
  max-height:calc(min(300px, 100vh - 200px) - 42px)!important;
  overflow-y:auto!important;overflow-x:hidden!important;
  overscroll-behavior:contain;padding-right:12px;
  scrollbar-gutter:stable}
.dshp-panes{max-height:calc(100vh - 180px);overflow-y:auto;overflow-x:hidden;
  overscroll-behavior:contain;scrollbar-width:thin}
.dshp-panes::-webkit-scrollbar{width:8px}
.dshp-panes::-webkit-scrollbar-thumb{background:rgba(120,140,180,.45);border-radius:4px}
.dshp-panes::-webkit-scrollbar-track{background:transparent}
.dshp-hud{max-height:calc(100vh - 40px);overflow-y:auto;overscroll-behavior:contain}
.dshp-btn{border:1px solid var(--dshp-line);background:var(--dshp-bg);color:var(--dshp-fg);
  border-radius:calc(11px * var(--dshp-ds));flex:0 0 auto;white-space:nowrap;
  padding:calc(5px * var(--dshp-ds)) calc(11px * var(--dshp-ds));
  font-size:calc(13px * var(--dshp-ds));cursor:pointer;line-height:1.5;
  box-shadow:0 3px 10px rgba(10,14,30,.14);transition:transform .12s ease}
/* 纯符号按钮（打开 DSH / 收起）：正方形一点，只放一个符号 */
.dshp-btn.dshp-icon{padding:calc(5px * var(--dshp-ds)) calc(9px * var(--dshp-ds));
  font-size:calc(15px * var(--dshp-ds));line-height:1.2}
/* 大小加减键 */
.dshp-btn.dshp-step{min-width:calc(30px * var(--dshp-ds));text-align:center;
  font-size:calc(17px * var(--dshp-ds));font-weight:600;line-height:1.1}
.dshp-btn:hover{transform:translateY(-1px)}
.dshp-btn:active{transform:translateY(0) scale(.96)}
.dshp-btn:disabled{opacity:.5;cursor:default}
.dshp-btn.dshp-primary{background:var(--dshp-accent);color:#fff;border-color:transparent}
.dshp-close{position:absolute;top:5px;right:6px;width:22px;height:22px;line-height:1;
  border:none;border-radius:7px;background:transparent;color:inherit;opacity:.5;
  font-size:15px;cursor:pointer;padding:0}
.dshp-close:hover{opacity:1;background:rgba(124,92,255,.14)}
.dshp-panel{position:absolute;bottom:calc(100% + 10px * var(--dshp-ps));left:50%;
  transform:translateX(calc(-50% + var(--dshp-shift,0px))) translateY(calc(4px + var(--dshp-shift-y,0px)));
  width:min(calc(320px * var(--dshp-ps)),86vw);pointer-events:auto;
  background:var(--dshp-bg);color:var(--dshp-fg);
  border:1px solid var(--dshp-line);border-radius:calc(var(--dshp-radius) * var(--dshp-ps));
  padding:calc(10px * var(--dshp-ps));
  box-shadow:0 14px 40px rgba(10,14,30,.26);backdrop-filter:blur(16px) saturate(1.3);
  opacity:0;visibility:hidden;transition:opacity .16s ease,transform .16s ease;
  font-size:calc(12px * var(--dshp-ps))}
/* 面板在缩放被冻结时不能再跟着动，否则拖「大小」滑块的时候轨道会从鼠标底下跑掉 */
.dshp-root.dshp-sizing .dshp-panel{transition:opacity .16s ease}
.dshp-panel.dshp-on{opacity:1;visibility:visible;
  transform:translateX(calc(-50% + var(--dshp-shift,0px))) translateY(var(--dshp-shift-y,0px))}
.dshp-panel textarea{width:100%;box-sizing:border-box;resize:none;
  height:calc(64px * var(--dshp-ps));font:inherit;
  color:inherit;background:transparent;border:1px solid var(--dshp-line);
  border-radius:calc(9px * var(--dshp-ps));
  padding:calc(7px * var(--dshp-ps)) calc(9px * var(--dshp-ps));outline:none}
.dshp-panel textarea:focus{border-color:var(--dshp-accent)}
.dshp-row{display:flex;gap:6px;align-items:center;margin-top:7px;flex-wrap:wrap}
.dshp-grow{flex:1}
.dshp-tabs{display:flex;gap:3px;margin-bottom:7px;border-bottom:1px solid var(--dshp-line);padding-bottom:6px}
.dshp-tab-btn{border:none;background:transparent;color:inherit;opacity:.6;font:inherit;font-size:11.5px;
  padding:3px 9px;border-radius:7px;cursor:pointer}
.dshp-tab-btn.dshp-active{opacity:1;background:rgba(124,92,255,.14);color:var(--dshp-accent);font-weight:600}
.dshp-grid{display:flex;flex-wrap:wrap;gap:5px;max-height:210px;overflow:auto;overscroll-behavior:contain}
.dshp-chip{border:1px solid var(--dshp-line);background:transparent;color:inherit;font:inherit;
  font-size:calc(11.5px * var(--dshp-ps));border-radius:calc(8px * var(--dshp-ps));
  padding:calc(3px * var(--dshp-ps)) calc(9px * var(--dshp-ps));cursor:pointer;transition:background .12s}
.dshp-chip:hover{background:rgba(124,92,255,.12)}
.dshp-chip.dshp-on{background:var(--dshp-accent);color:#fff;border-color:transparent}
.dshp-chip.dshp-dead{opacity:.38;cursor:not-allowed}
.dshp-now{opacity:.75;margin:0 0 8px;padding:5px 8px;border-radius:8px;
  background:rgba(124,92,255,.09);white-space:normal}
.dshp-hint{opacity:.5;font-size:calc(10.5px * var(--dshp-ps));margin-top:calc(6px * var(--dshp-ps));line-height:1.5;white-space:pre-wrap}
.dshp-label{display:flex;align-items:center;gap:7px;margin:6px 0;font-size:11.5px}
.dshp-label input[type=range]{flex:1;accent-color:var(--dshp-accent)}
/* 详细频率面板（设置里的「详细面板…」）：模态，继承 root 的主题变量。
   透明窗口里不给面板加 backdrop-filter / 大 box-shadow —— 会采样出灰边（交接文档 §1.4）。 */
.dshp-tuning-mask{position:fixed;inset:0;z-index:2147483200;background:rgba(8,10,20,.28);
  pointer-events:auto}
.dshp-tuning{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483201;
  width:min(calc(660px * var(--dshp-ps)),94vw);max-height:86vh;overflow:auto;overscroll-behavior:contain;
  pointer-events:auto;background:var(--dshp-bg);color:var(--dshp-fg);
  border:1px solid var(--dshp-line);border-radius:calc(16px * var(--dshp-ps));
  padding:calc(16px * var(--dshp-ps)) calc(18px * var(--dshp-ps)) calc(12px * var(--dshp-ps));
  font-size:calc(12px * var(--dshp-ps))}
.dshp-tuning h3{margin:0 0 calc(3px * var(--dshp-ps));font-size:calc(15px * var(--dshp-ps));
  display:flex;align-items:center;gap:8px}
.dshp-tuning h3 .dshp-close{position:static;margin-left:auto}
.dshp-tune-sec{margin:calc(12px * var(--dshp-ps)) 0 calc(3px * var(--dshp-ps));
  font-size:calc(10.5px * var(--dshp-ps));font-weight:600;opacity:.55;letter-spacing:.06em}
.dshp-tune-note{font-size:calc(10.5px * var(--dshp-ps));opacity:.5;line-height:1.5;margin:0 0 4px}
.dshp-tune-tabs{display:flex;gap:6px;margin:calc(6px * var(--dshp-ps)) 0 calc(4px * var(--dshp-ps))}
.dshp-tune-tab{border:1px solid var(--dshp-line);background:transparent;color:inherit;font:inherit;
  border-radius:999px;padding:calc(3px * var(--dshp-ps)) calc(13px * var(--dshp-ps));cursor:pointer;
  font-size:calc(11.5px * var(--dshp-ps));opacity:.8;transition:background .12s,opacity .12s}
.dshp-tune-tab:hover{background:rgba(124,92,255,.12);opacity:1}
.dshp-tune-tab.dshp-on{background:var(--dshp-accent);border-color:transparent;color:#fff;opacity:1}
.dshp-tune-status{font-size:calc(10.5px * var(--dshp-ps));opacity:.62;margin:calc(2px * var(--dshp-ps)) 0 calc(5px * var(--dshp-ps));
  font-variant-numeric:tabular-nums}
.dshp-tune-bar{display:flex;height:calc(10px * var(--dshp-ps));min-height:8px;border-radius:999px;overflow:hidden;
  background:rgba(124,92,255,.09);margin:calc(2px * var(--dshp-ps)) 0 calc(8px * var(--dshp-ps))}
.dshp-tune-seg{height:100%;min-width:2px;transition:flex-basis .12s ease;cursor:help}
.dshp-tune-row{display:flex;align-items:center;gap:calc(7px * var(--dshp-ps));margin:2px 0;min-height:calc(25px * var(--dshp-ps))}
.dshp-tune-row > span:first-child{flex:0 0 calc(104px * var(--dshp-ps));font-size:calc(11.5px * var(--dshp-ps))}
.dshp-tune-row .dshp-tune-name{flex:0 0 calc(112px * var(--dshp-ps));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default}
.dshp-tune-row input[type=range]{flex:1;accent-color:var(--dshp-accent);min-width:64px}
.dshp-tune-row .dshp-tune-val{flex:0 0 calc(40px * var(--dshp-ps));text-align:right;opacity:.7;
  font-size:calc(10.5px * var(--dshp-ps));font-variant-numeric:tabular-nums}
.dshp-tune-row .dshp-tune-share{flex:0 0 calc(54px * var(--dshp-ps));text-align:right;font-weight:700;
  font-size:calc(11px * var(--dshp-ps));font-variant-numeric:tabular-nums}
.dshp-tune-row .dshp-tune-gap{flex:0 0 calc(84px * var(--dshp-ps));text-align:right;opacity:.6;
  font-size:calc(10px * var(--dshp-ps));font-variant-numeric:tabular-nums;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.dshp-tune-row .dshp-tune-mute{flex:0 0 calc(28px * var(--dshp-ps));min-height:calc(24px * var(--dshp-ps));
  border:none;background:transparent;border-radius:calc(6px * var(--dshp-ps));color:inherit;cursor:pointer;
  font-size:calc(12px * var(--dshp-ps));padding:0;opacity:.6;line-height:1}
.dshp-tune-row .dshp-tune-mute:hover{opacity:1;background:rgba(124,92,255,.12)}
.dshp-tune-row .dshp-tune-mute:disabled{opacity:.2;cursor:default}
.dshp-tune-row.is-missing{opacity:.34}
.dshp-tune-row.is-muted .dshp-tune-name{opacity:.5}
.dshp-tune-head{display:flex;align-items:center;gap:calc(7px * var(--dshp-ps));padding:0 2px calc(2px * var(--dshp-ps));
  font-size:calc(9.5px * var(--dshp-ps));opacity:.45}
.dshp-tune-head .dshp-tune-name{flex:0 0 calc(112px * var(--dshp-ps))}
.dshp-tune-head .dshp-tune-slider-h{flex:1;min-width:64px}
.dshp-tune-head .dshp-tune-val{flex:0 0 calc(40px * var(--dshp-ps));text-align:right}
.dshp-tune-head .dshp-tune-share{flex:0 0 calc(54px * var(--dshp-ps));text-align:right}
.dshp-tune-head .dshp-tune-gap{flex:0 0 calc(84px * var(--dshp-ps));text-align:right}
.dshp-tune-head .dshp-tune-mute{flex:0 0 calc(28px * var(--dshp-ps))}
.dshp-tune-interval{margin-bottom:calc(4px * var(--dshp-ps))}
.dshp-tune-interval .dshp-tune-gap{flex:0 0 calc(132px * var(--dshp-ps))}
.dshp-tune-script .dshp-tune-gap{flex:0 0 calc(74px * var(--dshp-ps))}
.dshp-tune-adv{border-top:1px solid var(--dshp-line);margin-top:calc(10px * var(--dshp-ps));padding-top:calc(6px * var(--dshp-ps))}
.dshp-tune-adv summary{cursor:pointer;font-size:calc(10.5px * var(--dshp-ps));opacity:.55;outline:none}
.dshp-tune-adv summary:hover{opacity:.85}
.dshp-tune-adv-row{display:flex;gap:8px;font-size:calc(10px * var(--dshp-ps));opacity:.55;line-height:1.6;
  font-variant-numeric:tabular-nums}
.dshp-tune-adv-row span:first-child{flex:0 0 calc(112px * var(--dshp-ps))}
.dshp-tune-sim{display:none;white-space:pre-wrap;font-size:calc(10.5px * var(--dshp-ps));line-height:1.55;
  margin:calc(6px * var(--dshp-ps)) 0;padding:calc(8px * var(--dshp-ps));border-radius:calc(8px * var(--dshp-ps));
  background:rgba(124,92,255,.09);font-variant-numeric:tabular-nums}
.dshp-tune-sim.dshp-on{display:block}
@media (max-width:640px){.dshp-tune-row .dshp-tune-gap,.dshp-tune-head .dshp-tune-gap,.dshp-tune-interval .dshp-tune-gap{display:none}}
@media (max-width:520px){.dshp-tune-row .dshp-tune-share,.dshp-tune-head .dshp-tune-share{display:none}}
.dshp-tuning .dshp-row{margin-top:calc(10px * var(--dshp-ps))}
.dshp-tuning::-webkit-scrollbar{width:6px}
.dshp-tuning::-webkit-scrollbar-thumb{background:var(--dshp-line);border-radius:3px}
/* 组成条悬停名：不用原生 title（非激活窗口里会时有时无）。tip 挂在 body 上，
   拿不到 .dshp-root 的 --dshp-ps，所以这里带 fallback。 */
.dshp-tune-tip{position:fixed;left:0;top:0;z-index:2147483300;display:none;max-width:calc(240px * var(--dshp-ps,1));
  padding:calc(4px * var(--dshp-ps,1)) calc(7px * var(--dshp-ps,1));border-radius:calc(6px * var(--dshp-ps,1));
  background:rgba(18,26,48,.94);color:#fff;font-size:calc(10.5px * var(--dshp-ps,1));line-height:1.4;
  white-space:nowrap;pointer-events:none;box-shadow:0 6px 18px rgba(0,0,0,.3)}
.dshp-tune-tip.dshp-on{display:block}

/* ——— HUD：右键弹出的「余额 / 本轮消耗 / 峰谷计价」面板 ———
   主人要求：右键不再是设置菜单，而是这个框；信息要醒目、要盖在最上层、
   又要能自己收起来（不然挡住对话）。所以它是独立一层，z-index 比菜单还高。 */
.dshp-hud{position:absolute;left:50%;bottom:calc(100% + 10px * var(--dshp-ps));
  transform:translateX(calc(-50% + var(--dshp-shift,0px))) translateY(8px);
  width:min(calc(292px * var(--dshp-ps)),86vw);pointer-events:auto;z-index:9;
  background:var(--dshp-bg);color:var(--dshp-fg);
  border:1px solid var(--dshp-line);border-radius:calc(var(--dshp-radius) * var(--dshp-ps));
  padding:calc(13px * var(--dshp-ps)) calc(14px * var(--dshp-ps)) calc(10px * var(--dshp-ps));
  box-shadow:0 20px 54px rgba(10,14,30,.34);backdrop-filter:blur(18px) saturate(1.4);
  opacity:0;visibility:hidden;
  transition:opacity .18s ease,transform .18s cubic-bezier(.2,.9,.3,1);
  font-size:calc(12px * var(--dshp-ps))}
.dshp-hud.dshp-on{opacity:1;visibility:visible;
  transform:translateX(calc(-50% + var(--dshp-shift,0px))) translateY(0)}
/* 刚弹出来那一下给一圈呼吸光，提醒「看这里」——冒烟效果用 box-shadow，不动 transform */
.dshp-hud.dshp-flash{animation:dshp-hud-flash 1.15s ease-out 2}
@keyframes dshp-hud-flash{
  0%{box-shadow:0 20px 54px rgba(10,14,30,.34),0 0 0 0 rgba(124,92,255,.5)}
  70%{box-shadow:0 20px 54px rgba(10,14,30,.34),0 0 0 14px rgba(124,92,255,0)}
  100%{box-shadow:0 20px 54px rgba(10,14,30,.34),0 0 0 0 rgba(124,92,255,0)}}
.dshp-hud-head{display:flex;align-items:center;justify-content:space-between;gap:8px;
  font-size:calc(11px * var(--dshp-ps));opacity:.6;letter-spacing:.3px;
  padding-right:calc(20px * var(--dshp-ps))}
.dshp-hud-money{display:flex;align-items:baseline;gap:6px;margin:calc(4px * var(--dshp-ps)) 0 calc(2px * var(--dshp-ps))}
.dshp-hud-money b{font-size:calc(30px * var(--dshp-ps));font-weight:850;letter-spacing:-1px;
  line-height:1.1;font-variant-numeric:tabular-nums}
.dshp-hud-money span{font-size:calc(12px * var(--dshp-ps));opacity:.55}
.dshp-hud-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;
  padding:calc(3px * var(--dshp-ps)) 0}
.dshp-hud-k{opacity:.6;font-size:calc(11px * var(--dshp-ps));white-space:nowrap}
.dshp-hud-v{font-weight:700;font-variant-numeric:tabular-nums;text-align:right}
.dshp-hud-sep{height:1px;background:var(--dshp-line);margin:calc(6px * var(--dshp-ps)) 0}
.dshp-hud-tag{display:inline-flex;align-items:center;gap:5px;border-radius:999px;
  padding:calc(2px * var(--dshp-ps)) calc(9px * var(--dshp-ps));
  font-weight:850;font-size:calc(11px * var(--dshp-ps));white-space:nowrap}
.dshp-hud-tag.dshp-peak{background:rgba(232,45,74,.15);color:#d81e3f;border:1px solid rgba(216,30,63,.38)}
.dshp-hud-tag.dshp-valley{background:rgba(16,185,129,.16);color:#0a8f63;border:1px solid rgba(10,143,99,.38)}
.dshp-hud-foot{opacity:.45;font-size:calc(10px * var(--dshp-ps));line-height:1.55;
  margin-top:calc(7px * var(--dshp-ps));white-space:pre-wrap}
@media (prefers-color-scheme:dark){
  .dshp-hud-tag.dshp-peak{background:rgba(255,86,110,.2);color:#ff8a9c;border-color:rgba(255,138,156,.4)}
  .dshp-hud-tag.dshp-valley{background:rgba(52,211,153,.18);color:#6ee7b7;border-color:rgba(110,231,183,.4)}}
.dshp-tab{position:fixed;right:16px;bottom:16px;z-index:2147483002;pointer-events:auto;cursor:pointer;
  border:1px solid var(--dshp-line);background:var(--dshp-bg);color:var(--dshp-fg);
  border-radius:20px;padding:6px 13px;font-size:12px;font-weight:600;
  box-shadow:0 6px 18px rgba(10,14,30,.28);transition:transform .12s ease;
  display:none;align-items:center;gap:6px;
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
`

  // ——————————————————————————————————————————————————————————————
  // 三、小工具
  // ——————————————————————————————————————————————————————————————

  const $ = (tag, cls, text) => {
    const el = document.createElement(tag)
    if (cls) el.className = cls
    if (text != null) el.textContent = text
    return el
  }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = src
      s.async = false
      s.onload = () => resolve()
      s.onerror = () => reject(new Error('无法加载 ' + src))
      document.head.appendChild(s)
    })
  }

  function readLayout() {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) return JSON.parse(raw) || {}
    } catch (e) {}
    // 迁移（2026-10-17 独立化）：页面从 DSH 的 origin 搬到外壳自己的 origin，
    // 新 origin 的 localStorage 天然是空的 —— 她的位置/大小/灵动度会全丢。
    // 外壳会把旧 origin 的存档塞进 BOOT.seed，这里当初始值用一次；
    // 之后 saveLayout 会写进 localStorage，seed 就不再参与（下次启动直接读 localStorage）。
    if (BOOT.seed && typeof BOOT.seed === 'object') return BOOT.seed
    return {}
  }
  function saveLayout(patch) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(Object.assign(readLayout(), patch)))
    } catch (e) {}
  }

  // ——————————————————————————————————————————————————————————————
  // 四、状态
  // ——————————————————————————————————————————————————————————————

  let app = null
  let model = null
  let manifest = null
  let coreModel = null
  let ui = null

  /** 表情名 → 参数增量表（已过滤掉模型里不存在的参数） */
  const EXPR = {}
  /** 最近一次取景结果，供诊断用 */
  let lastView = null
  /** 角色实体在模型画布里的归一化范围，启动时测一次；null = 没测出来（退回整张画布） */
  let contentBox = null
  /** 模型真实存在的参数 id 集合 */
  let MODEL_PARAMS = new Set()
  /** 被过滤掉的参数，启动时打一条日志，方便排查 */
  const droppedParams = new Set()

  /**
   * 状态模型（这一版的核心）。
   *
   * 之前最大的问题是「特效会卡住」：摸头/工具/完成每次都 setMood 一下，那张脸就一直
   * 挂在那儿，等下一个事件来覆盖——叠几次之后就永远停在错的状态上，很多表情也再也
   * 用不出来。根因是「谁都没有责任去清理」。
   *
   * 现在拆成三层，各自职责单一，谁都不会赖着不走：
   *
   *   base      由 agent 状态决定（待机/思考/干活/出错…），是「此刻本该是什么样」
   *   override  一次性反应（摸头、点击、特效、工具瞬时反馈）——**强制带时限**，到期自动消失
   *
   * 每帧解析：face = override（未过期）> user（未过期）> base。
   * 「特效做完回不去」在结构上就不会发生——没有任何一处需要「记得清理」。
   */
  const rig = {
    /** 当前真实生效的脸（表达式名或 null） */
    face: null,
    /** 当前真实生效的道具集合（表达式名） */
    props: new Set(),
    weight: new Map(),
    talking: false,
    talkPhase: 0,
    /** 底层状态：由 agent 状态机维护 */
    base: { mood: 'neutral', face: null, props: [] },
    /** 一次性反应，一定带 until */
    override: null,
    user: { face: null, until: 0 },
    userProps: new Set(),
    /** 一次性的参数脉冲（爱心粒子之类），到期自动停 */
    burst: null,
  }
  let mood = 'neutral'

  /** 情绪名 → 表达式名（不在 EXPR 里的会被过滤掉） */
  function moodFace(name) {
    if (name == null) return null
    const f = MOOD_FACE[name] !== undefined ? MOOD_FACE[name] : name
    return f && f in EXPR ? f : null
  }
  /** 道具 key 或表达式名 → 表达式名 */
  function propExpr(key) {
    if (!key) return null
    const e = ALL_TOGGLES[key] ? ALL_TOGGLES[key].expr : key
    return e && EXPR[e] ? e : null
  }

  /** 把三层解析成「这一刻真正该显示什么」。改动状态后调用，或者每帧调用（很便宜）。 */
  function resolveRig() {
    const now = performance.now()
    if (rig.override && now >= rig.override.until) rig.override = null
    if (rig.user.face && now >= rig.user.until) rig.user.face = null

    const ov = rig.override
    const face = ov && ov.face !== undefined ? ov.face : rig.user.face || rig.base.face || null
    rig.face = face && face in EXPR ? face : null

    const props = new Set()
    for (const p of rig.userProps) props.add(p)
    if (!ov || !ov.exclusive) for (const p of rig.base.props) props.add(p)
    if (ov) for (const p of ov.props) props.add(p)
    rig.props = props
    mood = (ov && ov.mood) || rig.base.mood || 'neutral'
  }

  /**
   * 设置底层状态。agent 状态机用它：待机 / 思考 / 干活 / 出错 / 完成…
   * @param name 情绪名
   * @param propKeys 该状态下常驻的道具（道具 key 或表达式名）
   */
  function setBase(name, propKeys) {
    rig.base = {
      mood: name || 'neutral',
      face: moodFace(name),
      props: (propKeys || []).map(propExpr).filter(Boolean),
    }
    resolveRig()
  }

  /**
   * 一次性反应。**一定会过期**——这是「特效不卡住」的保证。
   */
  function setReaction(opts) {
    opts = opts || {}
    // mood 和 face 都没给 = 只临时加道具，不动脸
    const face =
      opts.face !== undefined ? opts.face : opts.mood !== undefined ? moodFace(opts.mood) : undefined
    rig.override = {
      mood: opts.mood || null,
      face: face === undefined ? undefined : face,
      props: (opts.props || []).map(propExpr).filter(Boolean),
      exclusive: opts.exclusive === true,
      // soft：这一层是**待机时她自娱自乐**的小表演（自言自语 / 自己换个表情 / 拨弄道具）。
      //   真实事件（agent 事件、点击、感知器反应）不标 soft。
      //   用途：待机小戏遇到 soft 表演可以让位，但遇到真实表演必须让位 ——
      //   否则小戏几乎永远起不来：待机大脑每隔几秒就 act() 一次，override 一直挂着。
      soft: opts.soft === true,
      until: performance.now() + (opts.ms || 3200),
    }
    resolveRig()
  }

  /** 立刻撤掉一次性反应，回到 base（切模式、下一层事件来时用）。 */
  function clearReaction() {
    if (!rig.override) return
    rig.override = null
    resolveRig()
  }

  function setUserFace(name) {
    if (idle.sleep) wakeUp('face')
    rig.user = { face: moodFace(name), until: performance.now() + 30000 }
    resolveRig()
  }

  function clearUserFace() {
    rig.user = { face: null, until: 0 }
    clearReaction()
  }

  /**
   * 某一件「摆设/装饰」现在是开着的吗？
   * 手机是个例外——它不是一个表情参数，而是 `device.out`（模型自带的
   * 开盖动作把小设备掏出来），所以单独判。
   */
  function itemOn(key, def) {
    const d = def || ALL_TOGGLES[key]
    if (!d) return false
    if (d.device) return device.out
    return !!d.expr && rig.userProps.has(d.expr)
  }

  /** 把工作用的小设备掏出来（模型自带的 openLid 动作）。 */
  function takeDeviceOut() {
    if (device.out) return
    device.out = true
    playMotion('openLid')
  }

  function setProp(key, on) {
    const def = ALL_TOGGLES[key]
    // 手机：走模型自带的开盖动作，不走表情参数
    if (def && def.device) {
      if (on) takeDeviceOut()
      else putDeviceAway()
      // 手机收起来时，它的换色也该跟着走
      if (!on) {
        for (const [k, v] of Object.entries(ALL_TOGGLES)) {
          if (v.needs === key && v.expr) rig.userProps.delete(v.expr)
        }
      }
      resolveRig()
      saveLayout({ props: Array.from(rig.userProps) })
      return
    }
    const expr = propExpr(key)
    if (!expr) return
    if (on) {
      if (def && def.group) {
        for (const [k, v] of Object.entries(ALL_TOGGLES)) {
          if (v.group === def.group && k !== key && v.expr) rig.userProps.delete(v.expr)
        }
      }
      // 前置依赖。两种：
      //   · 参数型（白魔爪 → 粉魔爪）：直接把前置的表情加上
      //   · 设备型（手机换色 → 掏出手机）：把手机掏出来
      // 这都是原作者的设计（*+5「魔爪变白」必须在粉魔爪模式下用）。
      if (def && def.needs) {
        const needDef = ALL_TOGGLES[def.needs]
        if (needDef && needDef.device) takeDeviceOut()
        else {
          const needExpr = propExpr(def.needs)
          if (needExpr) rig.userProps.add(needExpr)
        }
      }
      // 反过来：开「粉魔爪」要把换色摘掉，不然还是白的
      if (def && def.clears) {
        for (const k of def.clears) {
          const e2 = propExpr(k)
          if (e2) rig.userProps.delete(e2)
        }
      }
      rig.userProps.add(expr)
    } else {
      rig.userProps.delete(expr)
      // 摘掉「魔爪」时，它的换色也该跟着走，不然会留下一层颜色
      for (const [k, v] of Object.entries(ALL_TOGGLES)) {
        if (v.needs === key && v.expr) rig.userProps.delete(v.expr)
      }
    }
    resolveRig()
    saveLayout({ props: Array.from(rig.userProps) })
  }

  function clearProps() {
    rig.userProps.clear()
    resolveRig()
    saveLayout({ props: [] })
  }

  function restoreProps() {
    const saved = readLayout().props
    if (!Array.isArray(saved)) return
    for (const expr of saved) if (EXPR[expr]) rig.userProps.add(expr)
    resolveRig()
  }

  /** 当前参与施加的表达式集合（含正在淡出的）。过期与否已由 resolveRig 决定。 */
  function currentExpressions() {
    const out = new Set()
    if (rig.face) out.add(rig.face)
    for (const name of rig.props) out.add(name)
    for (const name of rig.weight.keys()) out.add(name)
    return out
  }

  /* ==== @motion-engine:start ====
   * 动作引擎（纯函数，无 DOM / PIXI / Cubism 依赖）。
   *
   * 为什么要单独一块、还带标记：
   *   这块代码只做「时间 → 参数偏移量」的数学，不碰任何运行时对象，
   *   所以可以用 _research-data/测试动作引擎.mjs 把它原样抠出来在 Node 里跑单测，
   *   不用起浏览器、不用截图（这台机器的透明窗口截不了图，见交接文档坑 #10）。
   *
   * 参数体系的事实（由 Cubism Core 实测 + physics3.json 解析得到，别凭感觉改）：
   *   · 真正该驱动的「根」只有 4 个：ParamAngleX / ParamAngleY / ParamAngleZ / ParamBreath。
   *     它们往下经过 26 组物理设置，自动带动身体、手臂、头发、衣服、耳朵、尾巴，
   *     而且二次运动会**天然正确**。直接写那些下游参数才是错的。
   *   · ParamAngleX = 水平转头（focus.x 映射到它），ParamAngleY = 上下点头，ParamAngleZ = 歪头。
   *   · 框架自己已经在写这 4 个：breath 给 ±7.5 / ±4 / ±5 / ±0.25，focus 最多再给 ±30。
   *     我们只做**加性偏移**，所以是叠加而不是打架。
   *   · 手臂 Param_arm_L1~L4 / R1~R4 是物理的**输出**（±30）。要单独做手势就必须直接写，
   *     applyRig 跑在物理之后，写入会盖住物理结果——这正是我们要的。
   */
  var DSHPetMotion = (function () {
    'use strict'
    var TAU = Math.PI * 2
    var ranges = {}
    var LIB = {}

    /** 参数范围表：{ id: [min, max, default] } */
    function setRanges(obj) {
      ranges = {}
      if (!obj) return
      for (var id in obj) {
        var r = obj[id]
        if (r && r.length >= 3) ranges[id] = [+r[0], +r[1], +r[2]]
      }
    }
    function rangeOf(id) { return ranges[id] || null }

    /**
     * 把「相对默认值的偏移」夹进合法区间。
     * 例：Param_arm_L1 是 [-30,30,0] → 偏移被夹到 [-30,30]；
     *     ParamBreath 是 [0,1,0] → 偏移被夹到 [0,1]（不会把她呼吸成负数）。
     */
    function clampOffset(id, v) {
      var r = ranges[id]
      if (!r) return v
      var lo = r[0] - r[2], hi = r[1] - r[2]
      return v < lo ? lo : v > hi ? hi : v
    }
    function clampNum(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

    // ———————————————————— 缓动 ————————————————————
    var EASE = {
      linear: function (t) { return t },
      in: function (t) { return t * t },
      out: function (t) { return 1 - (1 - t) * (1 - t) },
      inout: function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2 },
      smooth: function (t) { return t * t * t * (t * (t * 6 - 15) + 10) },
      /** 轻微过冲再落回——手臂/尾巴「甩」出去的手感 */
      back: function (t) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2) }
    }
    function ease(name, t) {
      var f = EASE[name] || EASE.inout
      return f(t < 0 ? 0 : t > 1 ? 1 : t)
    }

    /** 可复现的伪随机（测试要能固定种子） */
    function mulberry32(a) {
      return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0
        var t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    // ———————————————————— 待机层 ————————————————————
    /*
     * 目的：把现在「几乎静止、只有框架给的机械正弦」变成有生命感的低频漂移。
     * 手段：多个**不可通约**周期的正弦叠加（不会像节拍器那样看出规律）+ 缓慢随机漂移
     *       + 偶发小事件（换重心 / 甩尾巴 / 张望）。
     * 全部只写 4 个根参数，所以下游一切都是物理算的，不会穿模。
     */
    var IDLE_A = {
      z: [3.2, 1.4],      // ParamAngleZ 两层，周期 13.1s / 7.3s
      x: [2.4, 1.0],      // ParamAngleX，周期 17.3s / 9.7s
      y: [1.7, 0.7],      // ParamAngleY，周期 11.9s / 6.1s
      breathBase: 0.16,
      breathAmp: 0.13,    // ParamBreath：尾巴的发动机
      drift: { x: 1.5, y: 0.9, z: 1.7 }
    }
    var IDLE_W = {
      z: [TAU / 13.1, TAU / 7.3],
      x: [TAU / 17.3, TAU / 9.7],
      y: [TAU / 11.9, TAU / 6.1],
      breath: TAU / 5.7
    }

    function makeIdle(seed) {
      var rnd = mulberry32(seed == null ? 12345 : (seed | 0))
      return {
        rnd: rnd,
        t: 0,
        ph: [rnd() * TAU, rnd() * TAU, rnd() * TAU, rnd() * TAU, rnd() * TAU, rnd() * TAU],
        drift: { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, nextAt: 0 },
        burst: null,
        nextBurstAt: 7000 + rnd() * 8000,
        enabled: true,
        level: 1
      }
    }

    function stepIdle(s, dtMs) {
      if (!s || !s.enabled) return
      var dt = Math.min(200, dtMs) / 1000
      s.t += dt
      var rnd = s.rnd, d = s.drift
      // 漂移：每 6~15 秒换一个新目标，再平滑过去
      if (s.t * 1000 >= d.nextAt) {
        d.nextAt = s.t * 1000 + 6000 + rnd() * 9000
        d.tx = (rnd() * 2 - 1) * IDLE_A.drift.x
        d.ty = (rnd() * 2 - 1) * IDLE_A.drift.y
        d.tz = (rnd() * 2 - 1) * IDLE_A.drift.z
      }
      var k = Math.min(1, dt * 1.1)
      d.x += (d.tx - d.x) * k
      d.y += (d.ty - d.y) * k
      d.z += (d.tz - d.z) * k
      // 偶发小事件
      if (!s.burst && s.t * 1000 >= s.nextBurstAt) {
        var kinds = ['shift', 'wag', 'look', 'shift', 'wag']
        var kind = kinds[(rnd() * kinds.length) | 0]
        s.burst = { kind: kind, t0: s.t, dur: kind === 'wag' ? 1.9 : kind === 'look' ? 2.1 : 2.6, dir: rnd() < 0.5 ? -1 : 1 }
        s.nextBurstAt = s.t * 1000 + 9000 + rnd() * 12000
      }
      if (s.burst && s.t - s.burst.t0 >= s.burst.dur) s.burst = null
    }

    /** 包络：两端为 0、中间为 1 的平滑脉冲 */
    function pulse(u) { if (u <= 0 || u >= 1) return 0; var v = Math.sin(Math.PI * u); return v * v }

    /**
     * 每种「偶发小事件」的默认时长（秒）。
     *   shift 换重心 / wag 甩尾巴 / look 张望 —— 原来这三个由待机层自己随机触发
     *   flick 甩头 / lean 探头 —— 2026-10-17 补的，给「互动反应」用（见 idleBurst）
     */
    var BURST_DUR = { shift: 2.6, wag: 1.9, look: 2.1, flick: 0.62, lean: 2.2 }

    /**
     * 立刻给待机层插一个「临时根参数脉冲」。
     *
     * 为什么需要它（这条缺口是上一轮自己写进注释里的）：
     *   「甩鼠标 → 只动视线 + 小幅甩头」当初靠复用「点头」clip 凑数，
     *   观感是**点头**而不是甩头 —— 因为动作引擎只对外暴露 makeClip/sampleClip，
     *   没有「为 0.6 秒的甩头单独造一个 clip」的口子。
     *   待机层本来就有这套 burst 机制（脉冲只写 4 个根参数、有自然包络、不碰下游物理），
     *   这里把它开放出来，于是「轻量姿态反应」不用再借 clip。
     *
     * 三条约定：
     *   1. 新脉冲**覆盖**旧脉冲 —— 两个包络叠一起会变成谁也看不懂的怪姿势；
     *   2. 只允许 BURST_DUR 里登记的 kind（打错字就别动，宁可不甩）；
     *   3. 幅度由待机层自己的 level（idleStrength）统一缩放，这里不另开旋钮。
     */
    function idleBurst(s, kind, opts) {
      if (!s || !s.enabled) return null
      var dur = BURST_DUR[kind]
      if (!dur) return null
      opts = opts || {}
      var dir = opts.dir === 1 || opts.dir === -1 ? opts.dir : (s.rnd() < 0.5 ? -1 : 1)
      s.burst = { kind: kind, t0: s.t, dur: opts.dur || dur, dir: dir }
      return { kind: s.burst.kind, dur: s.burst.dur, dir: dir }
    }

    function sampleIdle(s, emit) {
      if (!s || !s.enabled) return
      var L = s.level == null ? 1 : s.level
      var t = s.t, ph = s.ph, d = s.drift
      var z = IDLE_A.z[0] * Math.sin(t * IDLE_W.z[0] + ph[0]) + IDLE_A.z[1] * Math.sin(t * IDLE_W.z[1] + ph[1]) + d.z
      var x = IDLE_A.x[0] * Math.sin(t * IDLE_W.x[0] + ph[2]) + IDLE_A.x[1] * Math.sin(t * IDLE_W.x[1] + ph[3]) + d.x
      var y = IDLE_A.y[0] * Math.sin(t * IDLE_W.y[0] + ph[4]) + IDLE_A.y[1] * Math.sin(t * IDLE_W.y[1] + ph[5]) + d.y
      var br = IDLE_A.breathBase + IDLE_A.breathAmp * Math.sin(t * IDLE_W.breath + ph[0])
      // 偶发事件（kind 与时长见 BURST_DUR）
      if (s.burst) {
        var u = (t - s.burst.t0) / s.burst.dur, e = pulse(u)
        if (s.burst.kind === 'shift') { z += 4.2 * s.burst.dir * e; x += 1.0 * s.burst.dir * e }
        else if (s.burst.kind === 'wag') { br += 0.34 * e; z += 1.6 * s.burst.dir * e }
        else if (s.burst.kind === 'flick') {
          // 甩头：sin 的一次全波（起手比 sin² 利落得多）+ 尾巴上一个反向回弹。
          // 只用 sin² 的话读起来像「慢慢歪一下」，不像甩。
          var w = Math.sin(Math.PI * u), rb = Math.sin(2 * Math.PI * u) * 0.35
          x += (6.0 * w + 1.2 * rb) * s.burst.dir
          z += (9.0 * w + 2.0 * rb) * s.burst.dir
        }
        else if (s.burst.kind === 'lean') { y += 2.6 * e; x += 2.0 * e * s.burst.dir }
        else { x += 3.0 * s.burst.dir * e; y += 1.4 * e }
      }
      emit('ParamAngleZ', clampOffset('ParamAngleZ', z * L))
      emit('ParamAngleX', clampOffset('ParamAngleX', x * L))
      emit('ParamAngleY', clampOffset('ParamAngleY', y * L))
      emit('ParamBreath', clampOffset('ParamBreath', (br + 0.08) * L))
    }

    // ———————————————————— Clip 播放器 ————————————————————
    /*
     * 数据格式（keys 的时间单位是**秒**，值是**相对默认值的偏移量**）：
     *   { duration: 2.4, tracks: [ { id: 'Param_arm_L1', keys: [[0,0],[0.3,24,'out'],[1.9,24],[2.3,0]] } ] }
     * 为什么用「加性偏移」而不是绝对赋值：这样 clip 能和待机层、表情、物理叠加，
     * 也不会把她别的地方的姿势一起清掉。
     */
    var CLIPS = {
      /*
       * ⚠️ 手臂符号是**实测**出来的，别凭感觉改。
       * 模型是镜像骨架：Param_arm_L* 的"抬手"是**负**值，Param_arm_R* 是**正**值。
       * 复现工具：_research-data/测全部方向.mjs
       *
       * 另外 Param_arm_L4/R4（手活动）满量程只动 1px，等于没用，所以动作里不用。
       *
       * ── 左右命名约定（全项目统一，别改）──────────────────────────
       * 一律用**屏幕（观察者）视角**：左 = 屏幕上靠左的那只手。
       * 从菜单到参数名一路同向，不做任何翻转：
       *     菜单「挥左边手」→ clip 挥手(左) → 别名 wave-left → Param_arm_L*
       * 注意模型是镜像的：屏幕左边那只手，解剖学上是她自己的**右手**。
       * （所以 tooltip 里写了「屏幕左侧那只手（也就是她自己的右手）」，
       *   标签给直觉、tooltip 给依据。）
       *
       * 为什么不按解剖学命名：参数名是唯一的事实来源。标签和参数名反着写，
       * 就得在每个人脑子里（和每次 AI 会话里）维护一张翻译表，注释一丢就出错
       * ——本项目已经踩过一次同类的坑（左右手臂符号写反）。
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
       * 伸懒腰（2026-10-16 合并版：原「伸懒腰」与「打哈欠」合成一个）。
       *
       *   真人伸懒腰就是「闭眼 + 张开手 + 仰头」，而原来那个「伸懒腰」
       *   只有手臂和仰头、不闭眼；再单开一个「打哈欠」菜单项纯属重复。
       *
       * 取两家的长处：
       *   · 手臂大幅张开 ±27°（来自原「伸懒腰」—— 比原打哈欠的 ±17° 更像伸懒腰）
       *   · 闭眼 PARAM_EXP5 = -1（《》素材）+ 大张嘴 + 仰头 + 眉毛微抬（来自原「打哈欠」）
       *
       * ⚠️ 闭眼用显隐开关（EXP5），**不能**用 ParamEyeLOpen ——
       *    后者会被 blinkTick 的绝对赋值盖掉（本项目记过的坑）。
       * ⚠️ 旧名「打哈欠」/ `yawn` / `tired` 仍然可用，见 ALIAS。
       */
      '伸懒腰': {
        duration: 3.6,
        tracks: [
          // —— 手臂：往两侧上方张开（原「伸懒腰」那套，符号是实测的）
          { id: 'Param_arm_L1', keys: [[0, 0], [0.8, -26, 'out'], [2.3, -27], [3.4, 0]] },
          { id: 'Param_arm_R1', keys: [[0, 0], [0.8, 26, 'out'], [2.3, 27], [3.4, 0]] },
          { id: 'Param_arm_L2', keys: [[0, 0], [0.85, -8], [2.3, -9], [3.4, 0]] },
          { id: 'Param_arm_R2', keys: [[0, 0], [0.85, 8], [2.3, 9], [3.4, 0]] },
          // —— 闭眼 + 大张嘴 + 仰头（原「打哈欠」那套）
          { id: 'PARAM_EXP5', keys: [[0.45, 0], [0.95, -1, 'out'], [2.5, -1], [3.15, 0]] },
          /*
           * ⚠️ 光切素材（EXP5）**不够** —— 必须同时把「眼睛形状」也闭上。
           *
           *   EXP5 = -1 时，ParamEyeLOpen/ROpen 仍是 1（睁着）→ 半透明的眼睑素材
           *   盖在**睁开的眼睛形状**上 → 看起来像「闭眼没盖严」。
           *
           * 数据依据（_research-data/param-influence.json）：
           *   PARAM_EXP5   → 只改 29 个 drawable 的 **opacity**，不改任何顶点
           *   ParamEyeLOpen→ **改 109px 顶点位移**（真正让眼睛闭上的形状），不改 opacity
           * 两者是**两个独立系统**，只动一个都不完整。
           *
           * 这里填 -1 是因为 clip 是**加性偏移**、而这两个参数默认值是 1（1 + (-1) = 0 = 闭上）。
           * 另外：它们进了 tracks 就会被 applyRig 认领，blinkTick 的眨眼闸门会自动闭嘴，
           * 不会出现「一边闭一边眨」的打架（那是本项目记过的坑）。
           */
          { id: 'ParamEyeLOpen', keys: [[0.45, 0], [0.95, -1, 'out'], [2.5, -1], [3.15, 0]] },
          { id: 'ParamEyeROpen', keys: [[0.45, 0], [0.95, -1, 'out'], [2.5, -1], [3.15, 0]] },
          { id: 'ParamMouthOpenY', keys: [[0, 0], [0.9, 0.8, 'out'], [2.3, 0.7], [3.0, 0.15], [3.5, 0]] },
          { id: 'ParamAngleY', keys: [[0, 0], [0.95, 10, 'out'], [2.3, 10], [3.4, 0]] },
          { id: 'ParamAngleZ', keys: [[0, 0], [1.2, -4], [2.4, 4], [3.4, 0]] },
          { id: 'ParamBrowLAngle', keys: [[0, 0], [1.0, 0.5], [2.3, 0.45], [3.5, 0]] },
          { id: 'ParamBrowRAngle', keys: [[0, 0], [1.0, 0.5], [2.3, 0.45], [3.5, 0]] }
        ]
      },
      /*
       * 下面这批是阶段 1 加的「表情类」动作。
       * 用的是**实测过方向**的表情参数（见 _research-data/表情方向.txt）：
       *   ParamEyeBallX  + = 看右      ParamEyeBallY  + = 看上
       *   ParamBrowLAngle/RAngle  +1 = 八字（内端↑/外端↓，委屈）、−1 = 倒八字（内端↓，生气）
       *   ParamMouthOpenY + = 张嘴
       *   PARAM_EXP4 +1 = **脸红**（腮红层，屏幕上约 78×26 px，看得见）
       *   PARAM_EXP5 +1 = O O 圈圈眼 / **-1 = 《》闭眼**
       * ⚠️ 这类"按键表情"的**参数与取值必须照作者原始 exp3 文件**，
       *    不能靠 manifest 里的名字猜 —— 那张表早期错位了一位，
       *    结果「脸红」点亮的其实是圈圈眼。真值表见 assets/model/manifest.json 的 _note。
       *   PARAM_EXP3 有 297 顶点/166px 的真实形变（龇牙）；EXP1/2/6/7/8 是"换嘴/换眼"的显隐开关
       *
       * ✅ 可以驱动 ParamEyeLOpen/ROpen（2026-10-17 实测），但必须与 PARAM_EXP5 **成对**：
       *    blinkTick 在 clip 播放时由 motionActive() 直接跳过，不会盖掉；只写一个会「闭眼没盖严」（坑 12.5）。
       * ⚠️ ParamMouthForm 虽然能写，但实测嘴角只动 0.6px（屏幕约 0.1px）——基本看不见，
       *    所以不靠它做表情，改用 PARAM_EXP 的显隐切换。
       */
      '惊讶': {
        duration: 1.7,
        tracks: [
          { id: 'ParamBrowLAngle', keys: [[0, 0], [0.22, 1, 'out'], [1.2, 1], [1.65, 0]] },
          { id: 'ParamBrowRAngle', keys: [[0, 0], [0.22, 1, 'out'], [1.2, 1], [1.65, 0]] },
          { id: 'ParamMouthOpenY', keys: [[0, 0], [0.25, 0.5, 'out'], [1.15, 0.42], [1.6, 0]] },
          { id: 'ParamAngleY', keys: [[0, 0], [0.3, 9, 'out'], [1.2, 8], [1.65, 0]] },
          { id: 'ParamAngleZ', keys: [[0, 0], [0.35, -3], [0.9, 3], [1.5, 0]] }
        ]
      },
      '害羞': {
        duration: 2.8,
        tracks: [
          // ⚠️ 脸红是 PARAM_EXP4，不是 EXP5！
          // 早期踩过：manifest 那张表整体错位一位，EXP5 其实是「O O 圈圈眼」，
          // 所以「害羞」看起来像"懵了"。依据是作者自己的 04 脸红.exp3.json。
          { id: 'PARAM_EXP4', keys: [[0, 0], [0.5, 1, 'out'], [2.3, 1], [2.75, 0]] },
          { id: 'ParamAngleY', keys: [[0, 0], [0.55, -10, 'out'], [2.25, -10], [2.75, 0]] },
          { id: 'ParamAngleZ', keys: [[0, 0], [0.6, 11, 'out'], [2.25, 11], [2.75, 0]] },
          { id: 'ParamEyeBallX', keys: [[0, 0], [0.6, -0.7, 'out'], [2.25, -0.7], [2.75, 0]] },
          { id: 'ParamEyeBallY', keys: [[0, 0], [0.6, -0.4, 'out'], [2.25, -0.4], [2.75, 0]] },
          { id: 'Param_arm_L1', keys: [[0, 0], [0.7, -8], [2.25, -8], [2.75, 0]] },
          { id: 'Param_arm_R1', keys: [[0, 0], [0.7, 8], [2.25, 8], [2.75, 0]] }
        ]
      },
      '思考': {
        duration: 3.0,
        tracks: [
          { id: 'ParamEyeBallX', keys: [[0, 0], [0.5, 0.62, 'out'], [2.4, 0.58], [2.95, 0]] },
          { id: 'ParamEyeBallY', keys: [[0, 0], [0.5, 0.5, 'out'], [2.4, 0.45], [2.95, 0]] },
          { id: 'ParamAngleZ', keys: [[0, 0], [0.6, -13, 'out'], [2.4, -13], [2.95, 0]] },
          { id: 'ParamBrowLAngle', keys: [[0, 0], [0.7, 0.5], [2.4, 0.5], [2.95, 0]] },
          { id: 'ParamBrowRAngle', keys: [[0, 0], [0.7, -0.4], [2.4, -0.4], [2.95, 0]] },
          { id: 'ParamMouthX', keys: [[0, 0], [0.8, 0.45], [2.4, 0.45], [2.95, 0]] }
        ]
      },
      '左顾右盼': {
        duration: 3.4,
        tracks: [
          { id: 'ParamAngleX', keys: [[0, 0], [0.45, -17, 'inout'], [1.25, -17], [2.05, 17, 'inout'], [2.8, 17], [3.35, 0]] },
          { id: 'ParamEyeBallX', keys: [[0, 0], [0.45, -0.85, 'inout'], [1.25, -0.85], [2.05, 0.85, 'inout'], [2.8, 0.85], [3.35, 0]] },
          { id: 'ParamAngleZ', keys: [[0, 0], [0.6, -4], [2.3, 4], [3.35, 0]] }
        ]
      },
      /*
       * 伸懒腰（2026-10-16 合并：原「伸懒腰」与「打哈欠」两个 clip 并成一个）。
       *
       * 确实，真人伸懒腰是**闭着眼、张开手、仰头**；而原来那个「伸懒腰」
       * 只有手臂和仰头、没有闭眼，两个动作各占一个菜单项反而重复。
       *
       * 现在取两家的长处：
       *   · 手臂大幅张开（±27°，来自原「伸懒腰」—— 比原来打哈欠的 ±17° 更像伸懒腰）
       *   · 闭眼（PARAM_EXP5 = -1《》素材）+ 大张嘴 + 仰头（来自原「打哈欠」）
       * 名字统一叫「伸懒腰」；旧名 `打哈欠` / `yawn` / `tired` 仍可用（见 ALIAS）。
       */
      /*
       * 确实：±30° 硬上限做不出手指比心的手势，双臂张开 + 脸红 + 歪头
       * 读起来就是"张开手要抱抱"。所以按实际观感改名（记忆点：名字要跟着观感走）。
       */
      '要抱抱': {
        duration: 3.0,
        tracks: [
          { id: 'PARAM_EXP4', keys: [[0, 0], [0.6, 1, 'out'], [2.5, 1], [2.95, 0]] },
          { id: 'Param_arm_L1', keys: [[0, 0], [0.55, -20, 'out'], [2.5, -21], [2.95, 0]] },
          { id: 'Param_arm_R1', keys: [[0, 0], [0.55, 20, 'out'], [2.5, 21], [2.95, 0]] },
          { id: 'Param_arm_L2', keys: [[0, 0], [0.6, -7], [2.5, -7], [2.95, 0]] },
          { id: 'Param_arm_R2', keys: [[0, 0], [0.6, 7], [2.5, 7], [2.95, 0]] },
          { id: 'ParamAngleZ', keys: [[0, 0], [0.65, 13, 'out'], [2.5, 13], [2.95, 0]] },
          { id: 'ParamAngleY', keys: [[0, 0], [0.65, 4], [2.5, 4], [2.95, 0]] }
        ]
      },
      /*
       * 打喷嚏（S3，2026-10-17）：0.9 秒的快动作。
       * 快速低头（ParamAngleY 负）+ **成对**闭眼（PARAM_EXP5 关眼睑素材 +
       * ParamEyeLOpen/ROpen 关眼睛形状，坑 12.5）+ 张嘴 + 眉压下（倒八字）。
       */
      '打喷嚏': {
        duration: 0.9,
        tracks: [
          { id: 'ParamAngleY', keys: [[0, 0], [0.1, -14, 'in'], [0.3, -21, 'out'], [0.55, -7], [0.85, 0]] },
          { id: 'ParamAngleX', keys: [[0, 0], [0.15, -2], [0.45, 2], [0.8, 0]] },
          { id: 'ParamAngleZ', keys: [[0, 0], [0.18, -3], [0.38, 2.5], [0.75, 0]] },
          { id: 'PARAM_EXP5', keys: [[0, 0], [0.09, -1, 'out'], [0.45, -1], [0.66, 0]] },
          { id: 'ParamEyeLOpen', keys: [[0, 0], [0.09, -1, 'out'], [0.45, -1], [0.66, 0]] },
          { id: 'ParamEyeROpen', keys: [[0, 0], [0.09, -1, 'out'], [0.45, -1], [0.66, 0]] },
          { id: 'ParamMouthOpenY', keys: [[0, 0], [0.12, 0.75, 'out'], [0.32, 0.85], [0.55, 0.15], [0.85, 0]] },
          { id: 'ParamBrowLAngle', keys: [[0, 0], [0.1, -0.5], [0.45, -0.5], [0.75, 0]] },
          { id: 'ParamBrowRAngle', keys: [[0, 0], [0.1, -0.5], [0.45, -0.5], [0.75, 0]] }
        ]
      },
      /*
       * 叹气（S3，2026-10-17）：低头 + 闭眼半秒 + 慢慢吐气。
       * ⚠️ 原方案想写 ParamBreath 负值做「尾巴一沉」—— 引擎把偏移夹到 [0,1]
       *    （默认 0），负值会被夹成 0，等于没写。所以尾巴的下沉交给
       *    **低头 + 身体前倾**，让尾巴物理自己跟下来（会晚半拍，反而更像叹气）。
       */
      '叹气': {
        duration: 2.6,
        tracks: [
          { id: 'ParamAngleY', keys: [[0, 0], [0.55, -9, 'out'], [1.75, -10], [2.45, 0]] },
          { id: 'ParamAngleZ', keys: [[0, 0], [0.7, -3.5], [1.8, -2.5], [2.45, 0]] },
          { id: 'PARAM_EXP5', keys: [[0, 0], [0.5, -1, 'out'], [1.5, -1], [2.1, 0]] },
          { id: 'ParamEyeLOpen', keys: [[0, 0], [0.5, -1, 'out'], [1.5, -1], [2.1, 0]] },
          { id: 'ParamEyeROpen', keys: [[0, 0], [0.5, -1, 'out'], [1.5, -1], [2.1, 0]] },
          { id: 'ParamMouthOpenY', keys: [[0, 0], [0.6, 0.18, 'out'], [1.45, 0.12], [2.0, 0]] },
          { id: 'ParamBrowLAngle', keys: [[0, 0], [0.55, 0.55], [1.6, 0.45], [2.4, 0]] },
          { id: 'ParamBrowRAngle', keys: [[0, 0], [0.55, 0.55], [1.6, 0.45], [2.4, 0]] }
        ]
      }
    }

    /*
     * ASCII 别名。
     * 为什么必须有：中文动作名一旦经过 shell / curl / 日志 / 某些 LLM 工具链，
     * 编码很容易被搞坏（实测 Windows bash 里 '点头' 到后端就变成了乱码，
     * 动作静默不播）。给一套纯 ASCII 名字，agent 和命令行就能可靠调用。
     */
    var ALIAS = {
      'wave-left': '挥手(左)', waveleft: '挥手(左)', 'wave-l': '挥手(左)', wave: '挥手(右)',
      'wave-right': '挥手(右)', waveright: '挥手(右)', 'wave-r': '挥手(右)',
      nod: '点头', shake: '摇头', tilt: '歪头',
      'tail-wag': '尾巴快摆', tailwag: '尾巴快摆', wag: '尾巴快摆',
      shift: '换重心', stretch: '伸懒腰', lazy: '伸懒腰',
      // 旧名兼容：合并后「打哈欠」这个 clip 不再单独存在，但名字还能用 ——
      // 外部调用方（/dsh-pet/control、旧脚本）不会因为改名而突然失败。
      '打哈欠': '伸懒腰',
      surprise: '惊讶', shocked: '惊讶',
      shy: '害羞', blush: '害羞',
      think: '思考', thinking: '思考',
      'look-around': '左顾右盼', lookaround: '左顾右盼', lookup: '左顾右盼',
      yawn: '伸懒腰', tired: '伸懒腰',
      hug: '要抱抱', hugging: '要抱抱', embrace: '要抱抱',
      // S3（2026-10-17）：新动作的 ASCII 别名
      sneeze: '打喷嚏', achoo: '打喷嚏',
      sigh: '叹气', sighing: '叹气'
    }
    function normKey(s) { return String(s).trim().toLowerCase().replace(/[\s_]+/g, '-') }
    /** 把任意写法（中文名 / ASCII 别名 / 大小写 / 下划线）解析成规范动作名，失败返回 null */
    function resolveName(n) {
      if (n == null) return null
      var s = String(n).trim()
      if (CLIPS[s]) return s
      var k = normKey(s)
      if (ALIAS[k]) return ALIAS[k]
      var flat = k.replace(/-/g, '')
      for (var a in ALIAS) if (a.replace(/-/g, '') === flat) return ALIAS[a]
      for (var c in CLIPS) if (normKey(c).replace(/[()（）]/g, '') === flat) return c
      return null
    }
    function listClips() { var out = []; for (var k in CLIPS) out.push(k); return out }
    /** 别名表（只读，供文档/调试） */
    function aliases() { var o = {}; for (var k in ALIAS) o[k] = ALIAS[k]; return o }
    function getClipDef(name) { var r = resolveName(name); return r ? CLIPS[r] : null }

    /**
     * opts: { speed 0.4~2, strength 0~1, hold 秒, delay 秒 }
     * 与 HAST-SEC 的意图词汇表对齐，将来接自然语言时直接映射。
     */
    function makeClip(name, opts) {
      var canon = resolveName(name)
      if (!canon) return null
      var def = CLIPS[canon]
      var o = opts || {}
      return {
        name: canon,
        asked: String(name),
        def: def,
        speed: clampNum(Number(o.speed) || 1, 0.4, 2),
        strength: clampNum(o.strength == null ? 1 : Number(o.strength), 0, 1),
        hold: Math.max(0, Number(o.hold) || 0),
        delay: Math.max(0, Number(o.delay) || 0),
        t: 0,
        waiting: Math.max(0, Number(o.delay) || 0),
        done: false,
        // 被打断时的淡出（见 fadeOutClip）：scale 从 1 线性降到 0
        fading: false,
        fadeLeft: 0,
        fadeMs: 0
      }
    }

    /** 返回 'waiting' | 'playing' | 'holding' | 'done' */
    function stepClip(c, dtMs) {
      if (!c || c.done) return 'done'
      var dt = Math.min(200, dtMs) / 1000
      // 淡出优先：淡出期间不推进时间轴，只消耗淡出余额
      if (c.fading) {
        c.fadeLeft -= Math.min(200, dtMs)
        if (c.fadeLeft <= 0) { c.fading = false; c.done = true; return 'done' }
        return 'fading'
      }
      if (c.waiting > 0) { c.waiting -= dt; return 'waiting' }
      c.t += dt * c.speed
      if (c.t <= c.def.duration) return 'playing'
      if (c.t <= c.def.duration + c.hold) return 'holding'
      c.done = true
      return 'done'
    }

    function sampleTrack(track, t, strength, emit) {
      var k = track.keys
      if (!k || !k.length) return
      var v
      if (t <= k[0][0]) v = k[0][1]
      else if (t >= k[k.length - 1][0]) v = k[k.length - 1][1]
      else {
        var i = 1
        while (i < k.length && k[i][0] < t) i++
        var a = k[i - 1], b = k[i]
        var span = b[0] - a[0]
        var u = span > 1e-6 ? (t - a[0]) / span : 1
        v = a[1] + (b[1] - a[1]) * ease(b[2] || 'inout', u)
      }
      emit(track.id, clampOffset(track.id, v * strength))
    }

    /**
     * 让一个正在播的 clip **淡出**（被打断时用）。
     *
     * 为什么必须有：所有 clip 都是**加性偏移**，而 playClip 是「直接换掉 clips 数组」。
     *   被丢掉的那个 clip 的最后一个偏移值就**永远留在参数上** ——
     *   于是新的动作会叠在旧残姿上：
     *     · 连续两个「伸懒腰」→ 手臂角度叠加、看着像抽住
     *     · 「害羞」打断「伸懒腰」→ 手臂还举着，表情已经换了，很怪
     * 淡出之后，旧动作在 fadeMs 内线性回到 0，新动作再接管 —— 观感是平滑过渡。
     */
    function fadeOutClip(c, ms) {
      if (!c || c.done || c.fading) return false
      c.fading = true
      c.fadeMs = Math.max(1, ms == null ? 300 : ms)
      c.fadeLeft = c.fadeMs
      return true
    }

    function sampleClip(c, emit) {
      if (!c || c.done || c.waiting > 0) return
      var t = Math.min(c.t, c.def.duration)
      // 淡出中的 clip：输出按 scale 缩放（1 → 0），这样被打断时不会留下残姿
      var sc = 1
      if (c.fading) sc = c.fadeMs > 0 ? Math.max(0, c.fadeLeft / c.fadeMs) : 0
      if (sc <= 0) return
      var tr = c.def.tracks
      for (var i = 0; i < tr.length; i++) sampleTrack(tr[i], t, c.strength * sc, emit)
      c.fadeScale = sc
    }

    return {
      setRanges: setRanges,
      rangeOf: rangeOf,
      clampOffset: clampOffset,
      ease: ease,
      makeIdle: makeIdle,
      stepIdle: stepIdle,
      sampleIdle: sampleIdle,
      /** 立刻插一个临时根参数脉冲（甩头/探头/换重心/甩尾巴/张望），见 idleBurst */
      idleBurst: idleBurst,
      BURST_DUR: BURST_DUR,
      makeClip: makeClip,
      stepClip: stepClip,
      sampleClip: sampleClip,
      fadeOutClip: fadeOutClip,
      /** 淡出默认时长（毫秒）。排期算「音尾」要用，避免各处硬编码 300 */
      __fadeMs: 300,
      listClips: listClips,
      getClipDef: getClipDef,
      resolveName: resolveName,
      aliases: aliases,
      IDLE_A: IDLE_A
    }
  })()
  /* ==== @motion-engine:end ==== */

  /* ==== @talk-tone:start ====
   * 说话语气（2026-10-17 新增）：把「她正在念的那句话」分成 疑问 / 感叹 / 平常 三档，
   * 再把眉毛、嘴形、头部微动挂上去。
   *
   * 为什么值得做：以前说话时只有嘴在动（ParamMouthOpenY 一个正弦），
   * 读起来像机器人配音；真人说话时眉毛先动、句尾会挑、疑问时头会微微歪。
   * 判据只用**最后一句**的标点与语气词 —— 便宜、够用、可单测（纯函数）。
   *
   * ⚠️ 幅度必须小（眉毛 ±0.3、嘴角 ±0.22）：这些是**加性叠加**，
   *    会和表情层（生气 -1 / 微笑 +1）叠在一起，大了就会「说不清是哪种情绪」。
   */
  var DSHPetTalkTone = (function () {
    'use strict'

    /**
     * 去掉尾随的「（笑）」「（拍手）」这类舞台提示 —— 它们不该算作「最后一句」。
     * 为什么需要：她的气泡里偶尔会带这种尾巴，不去掉的话
     * 「好耶！（拍手）」会被判成平常（最后一句变成了「（拍手」）。
     */
    function stripAsides(s) {
      var out = s
      for (var i = 0; i < 3; i++) {
        var next = out.replace(/[（(][^（()）]{0,20}[）)]\s*$/, '')
        if (next === out) break
        out = next
      }
      return out
    }

    /** 最后一句 + 它的句末标点（去掉尾随舞台提示/引号/空白） */
    function lastSentence(text) {
      var s = stripAsides(String(text == null ? '' : text)).replace(/[”"'）)」』】\s]+$/, '')
      var parts = s.split(/[。！？!?~～\n]/).filter(function (x) { return x && x.trim() })
      var tail = parts.length ? parts[parts.length - 1].trim() : ''
      var punct = /([。！？!?~～])\s*$/.exec(s)
      return { tail: tail, punct: punct ? punct[1] : '' }
    }

    /**
     * 判定语气。判据顺序很重要：
     *   ① 句末是问号 → 疑问（最强信号）
     *   ② 句末是感叹号 → 感叹
     *   ③ 句末是「吗/嘛/么/呢」→ 疑问（中文可以不带问号，例如「你在吗」）
     *   ④ 句末是「呀/哇/哈/耶」→ 感叹
     *   ⑤ 其余一律平常
     * 注意只看**最后一句**：一整段里前面的问句不该决定她的表情。
     */
    function classify(text) {
      var r = lastSentence(text)
      var t = r.tail, p = r.punct
      if (p === '？' || p === '?') return 'ask'
      if (p === '！' || p === '!') return 'excl'
      if (p === '～' || p === '~') return 'excl'
      if (/[吗嘛么呢]$/.test(t)) return 'ask'
      if (/[呀哇哈耶]$/.test(t)) return 'excl'
      return 'plain'
    }

    /**
     * 语气 → 说话时的参数。
     *   open/amp/rate  嘴张开的基准 / 幅度 / 节奏（rate 越大吐字越急）
     *   brow           眉毛抬起（ParamBrowLAngle/RAngle，+ = 抬）
     *   form           嘴角（ParamMouthForm，+ = 上扬）
     *   yaw            歪头幅度（ParamAngleZ，疑问时爱歪头）
     *   pitch          抬头（ParamAngleY，+ = 仰）
     */
    var TONES = {
      plain: { open: 0.28, amp: 0.16, rate: 11.0, brow: 0.00, form: 0.00, yaw: 0.0, pitch: 0.0 },
      ask:   { open: 0.22, amp: 0.12, rate: 9.5, brow: 0.30, form: 0.10, yaw: 1.6, pitch: 0.6 },
      excl:  { open: 0.40, amp: 0.22, rate: 13.0, brow: 0.14, form: 0.22, yaw: 0.0, pitch: 2.0 }
    }
    function params(tone) { return TONES[tone] || TONES.plain }

    return { classify: classify, params: params, lastSentence: lastSentence, stripAsides: stripAsides, TONES: TONES }
  })()
  /* ==== @talk-tone:end ==== */

  /* ==== @idle-rhythm:start ====
   * 待机节奏引擎（纯函数，无 DOM / PIXI 依赖）。
   *
   * 为什么单独一块、还带标记：
   *   和 @motion-engine 一样，这里只做「时间 → 该不该抽事 / 抽哪一类 / 下一跳多久」
   *   的数学，不碰任何运行时对象，所以能被 _research-data/测试待机节奏.mjs 原样抠出来
   *   在 Node 里跑单测（不用起浏览器、不用截图）。
   *
   * 解决什么问题：上游的待机大脑是「每 3.5~7.5 秒均匀随机抽一件事」——
   *   均值 5.5 秒、方差很小，听上去很勤快，但读起来是**平的**：
   *   没有「发呆一会儿」和「突然来劲」的长短句。
   * 现在分三档：
   *   drowsy 7~16s  安静期：偏发呆看别处
   *   normal 3.5~7.5s  常态（= 上游原行为）
   *   lively 1.5~3.5s 且**连做 2~3 件**：偏换表情 / 拨弄道具
   */
  var DSHPetIdleRhythm = (function () {
    'use strict'

    /**
     * 三档节拍。
     *   inter    [最小, 最大] 秒
     *   cluster  [最少, 最多] 件（活跃期连做）
     *   weights  该档专属权重（null = 用主权重表 IDLE_TABLE）
     *   clip     该档允许「抽到肢体动作」的概率系数（1 = 不限制，0 = 上游的「待机不放动作」）
     *
     * 三档的 clip 系数不同是刻意的：发呆期只准最轻的甩尾巴、活跃期愿意伸懒腰歪头。
     */
    var MOODS = {
      drowsy: {
        inter: [7, 16],
        cluster: [1, 1],
        clip: 0.25,
        // 发呆：偏轻行为，肢体动作基本不放（peer/sway 是 2026-10-17 加的：
        // 发呆时「探头看一眼」「慢慢换个重心」比「眼珠转一下」更看得出她还活着）
        weights: { glance: 24, peer: 10, sway: 3, mutter: 30, express: 22, tailWag: 10, tilt: 6, hungry: 6, nopang: 2 }
      },
      normal: { inter: [3.5, 7.5], cluster: [1, 1], clip: 1, weights: null },
      lively: {
        inter: [1.5, 3.5],
        cluster: [2, 3],
        clip: 1,
        // 活跃：偏折腾 —— 换表情、拨道具、做大动作
        weights: { glance: 6, peer: 4, sway: 10, express: 26, mutter: 12, stretch: 8, tilt: 8, nod: 6, tailWag: 8, hungry: 4, nopang: 2 }
      }
    }
    /** 多件之间的间隔（秒） */
    var GAP = [0.8, 2.2]
    /** 连续这么多次没抽到「有戏」的事 → 转安静 */
    var DROWSY_AFTER_QUIET = 3
    var DROWSY_AFTER_MS = 40000
    var LIVELY_WINDOW_MS = 8000
    /** 算「有戏」的行为（只有这些才把安静期打断） */
    var LIVELY_KINDS = { express: 1, hungry: 1, nopang: 1, script: 1 }

    function clampNum(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
    function randRange(r, lo, hi) { var t = typeof r === 'function' ? r() : Math.random(); return lo + (hi - lo) * clampNum(t, 0, 1) }
    function randInt(r, lo, hi) { return Math.floor(randRange(r, lo, hi + 1 - 1e-9)) }

    /**
     * 活跃度（-1~+1）怎么影响时长：
     *   偏活泼 → 间隔乘 0.55；偏安静 → 乘 1.45。中间值不缩不放。
     * 这样「活泼」同时意味着：更频繁、且更容易连做多件。
     * 键名用 idleLiveliness（设置面板的「活泼度」）；旧键 idleMoodBias 仍兼容。
     */
    function biasFactor(cfg) {
      var raw = (cfg && (cfg.idleLiveliness !== undefined ? cfg.idleLiveliness : cfg.idleMoodBias))
      var b = Number(raw || 0)
      if (!isFinite(b)) b = 0
      b = clampNum(b, -1, 1)
      if (b >= 0) return 1 - 0.45 * b
      return 1 + 0.45 * -b
    }

    function makeState() {
      return {
        mood: 'normal',
        nextAt: 0,
        left: 0,          // 本簇还要再抽几件事
        clusterGap: 0,    // 簇内下一件的间隔（秒）
        quiet: 0,         // 连续抽到「没戏」的次数
        // ⚠️ 初值用 undefined 表达「从没互动过」，别用 0 —— 0 会让「没发生过」与「发生在时刻 0」
        //    无法区分（这个坑踩了两次：drowsy 判定与 livelyTick 各一次）。
        //    需要「从现在开始算」的地方（maybeDrowsy）会把它惰性设成当前时刻。
        lastLivelyAt: undefined,
        lastScriptAt: 0,
        nextScriptAt: 0,
        lastKind: ''
      }
    }

    /**
     *
     * ⚠️ 必须当场转，不能等 noteBehavior：
     *   早先的写法是「先抽一件事、抽完再在 noteBehavior 里转活泼」，
     *   完全没有「他一动我就来劲」的手感（CDP 实测：戳一下后 nextIn 仍是 4.33s）。
     */
    function noteActivity(st, now) {
      if (!st) return 'normal'
      st.lastLivelyAt = now
      st.quiet = 0
      st.mood = 'lively'
      return st.mood
    }
    /** 久无互动 / 连续没戏 → 转安静。抽事**之前**调，保证这一跳就按安静档排 */
    function maybeDrowsy(st, now) {
      if (!st || st.mood === 'lively') return st ? st.mood : 'normal'
      // 「从没互动过」= 从现在开始计时，而不是「很久以前」——
      // 否则页面刚加载就会被判成发呆期。（-Infinity 解决的是「时刻 0 的首帧」，
      // 和这里是两件事，得分开表达。）
      if (st.lastLivelyAt === undefined) st.lastLivelyAt = now
      if (now - st.lastLivelyAt > DROWSY_AFTER_MS) st.mood = 'drowsy'
      return st.mood
    }

    /** 距下次抽事还有多久（毫秒）。只算、不改状态，所以可以随便调 */
    function intervalMs(st, cfg) {
      var m = MOODS[st && st.mood] || MOODS.normal
      var sec
      if (st && st.left > 0) sec = st.clusterGap
      else sec = randRange(null, m.inter[0], m.inter[1])

      // 每次调用都微扰一点，避免两个定时器一拍一合
      sec = sec * (0.94 + Math.random() * 0.12)
      // 「详细面板」的待机间隔：1 = 默认；0.5 = 间隔减半（更频繁）
      var iscale = Number(cfg && cfg.idleIntervalScale)
      if (!isFinite(iscale) || iscale <= 0) iscale = 1
      return Math.max(800, Math.round(sec * 1000 * biasFactor(cfg) * iscale))
    }

    /** 这一跳要抽几次（活理档会连做 2~3 件）。取一次 = 消耗一次簇计数 */
    function takeCluster(st) {
      var m = MOODS[st && st.mood] || MOODS.normal
      var n = randInt(null, m.cluster[0], m.cluster[1])
      if (st) st.left = Math.max(0, n - 1)
      return n
    }

    /**
     * 这一跳允不允许抽到肢体动作？
     *   概率 = CFG.idleClipChance（总开关） × 当前档位的 clip 系数。
     * 掷骰结果由调用方存进 idle.allowClip，抽事时据此过滤权重表。
     *
     * 为什么用「概率开门」而不是「给每个动作一个权重」：
     *   开门式只有一个数要调（idleClipChance），也好解释、好回退（设 0 = 上游行为）。
     */
    function clipAllowed(st, cfg, rand) {
      var total = (cfg && cfg.idleClipChance) == null ? 0.35 : Number(cfg.idleClipChance)
      if (!isFinite(total)) total = 0.35
      total = clampNum(total, 0, 1)
      if (total <= 0) return false
      var m = MOODS[st && st.mood] || MOODS.normal
      var p = total * (m.clip == null ? 1 : m.clip)
      return (typeof rand === 'function' ? rand() : Math.random()) < p
    }

    /** 把簇内下一件的间隔记进状态（秒） */
    function scheduleNextInCluster(st) {
      if (!st) return
      st.clusterGap = randRange(null, GAP[0], GAP[1])
    }

    
    /** 某一档的「原始权重表」（还没乘详细面板的倍数）：活泼/发呆档有专属表，常态用主表 */
    function tierTable(st, baseTable) {
      var m = MOODS[st && st.mood] || MOODS.normal
      var rows = []
      if (m.weights) {
        for (var k in m.weights) {
          if (Object.prototype.hasOwnProperty.call(m.weights, k)) rows.push([k, m.weights[k]])
        }
        return rows
      }
      return (baseTable || []).slice()
    }

    /** 详细面板的倍数：缺省/非法 = 1（倍数 ≤ 0 等于关掉，由调用方决定怎么显示） */
    function scaleOf(scale, name) {
      if (!scale || typeof scale !== 'object') return 1
      var k = Number(scale[name])
      return isFinite(k) ? k : 1
    }

    function weightsOf(st, baseTable, allowed, scale) {
      var table = tierTable(st, baseTable)
      if (typeof allowed === 'function') {
        table = table.filter(function (row) { return allowed(row[0]) })
      }
      // 「详细面板」的行为频率：scale[name] 为倍数（0 = 不进池，1 = 默认）
      if (scale && typeof scale === 'object') {
        var scaled = []
        for (var i = 0; i < table.length; i++) {
          var k = scaleOf(scale, table[i][0])
          if (k <= 0) continue
          scaled.push([table[i][0], table[i][1] * k])
        }
        table = scaled
      }
      return table
    }

    /**
     * 详细面板用：把「三档 × 倍数」摊成 { 行为名: { normal, lively, drowsy } }。
     * 和 weightsOf 的差别只有两点（面板要的是「真相」，不是「抽签表」）：
     *   · 倍数 ≤ 0 的行为**保留为 0**，不剔除 —— 面板要显示「已关掉」，不是「不存在」；
     *   · 某档的专属表里本来没有这个行为时留 null —— 面板显示「—」（比如小戏只在常态档进池）。
     * 只读不改状态，所以能在纯 Node 里直接测。
     */
    function weightMatrix(baseTable, scale) {
      var tiers = ['normal', 'lively', 'drowsy']
      var out = {}
      for (var t = 0; t < tiers.length; t++) {
        var rows = tierTable({ mood: tiers[t] }, baseTable)
        for (var i = 0; i < rows.length; i++) {
          var name = rows[i][0]
          var cell = out[name] || (out[name] = { name: name, normal: null, lively: null, drowsy: null })
          var k = scaleOf(scale, name)
          cell[tiers[t]] = k <= 0 ? 0 : Math.round(rows[i][1] * k * 1000) / 1000
        }
      }
      return out
    }

    /**
     * 详细面板（2026-10-18）：某一档的「进池份额 + 平均每次间隔」。
     * 纯函数：baseTable = IDLE_TABLE；clipMap = IDLE_CLIP；clipChance = CFG.idleClipChance。
     * gapSec 按该档原始节拍算；面板会再乘 idleIntervalScale / biasFactor。
     */
    function shareRows(tier, baseTable, scale, clipMap, clipChance) {
      var m = MOODS[tier] || MOODS.normal
      var names = []
      var baseMap = {}
      var i, k
      for (i = 0; i < (baseTable || []).length; i++) {
        k = baseTable[i][0]
        if (!Object.prototype.hasOwnProperty.call(baseMap, k)) { baseMap[k] = baseTable[i][1]; names.push(k) }
      }
      var tierMap = m.weights || baseMap
      if (m.weights) {
        for (k in m.weights) {
          if (Object.prototype.hasOwnProperty.call(m.weights, k) && names.indexOf(k) < 0) names.push(k)
        }
      }
      var p = (clipChance == null ? 0.35 : Number(clipChance)) * (m.clip == null ? 1 : m.clip)
      if (!isFinite(p)) p = 0.35
      p = clampNum(p, 0, 1)
      var rows = [], total = 0
      for (i = 0; i < names.length; i++) {
        k = names[i]
        var base = tierMap[k]
        var missing = base == null
        var w = missing ? 0 : (Number(base) || 0)
        var user = scaleOf(scale, k)
        if (!isFinite(user) || user < 0) user = 0
        var gate = (clipMap && clipMap[k]) ? p : 1
        var eff = w * user * gate
        rows.push({ name: k, base: missing ? null : w, user: user, gate: gate, effective: eff, missing: missing, share: 0, gapSec: null })
        total += eff
      }
      var avgInter = (m.inter[0] + m.inter[1]) / 2
      var avgCluster = (m.cluster[0] + m.cluster[1]) / 2
      var perEvent = (avgInter + (avgCluster - 1) * ((GAP[0] + GAP[1]) / 2)) / avgCluster
      for (i = 0; i < rows.length; i++) {
        rows[i].share = total > 0 ? rows[i].effective / total : 0
        rows[i].gapSec = rows[i].share > 0 ? perEvent / rows[i].share : null
      }
      return { tier: tier, total: total, perEvent: perEvent, gate: p, rows: rows }
    }

    /**
     * 详细面板的「模拟 10 分钟」：按份额抽 draws 次，返回计数。
     * 只模拟抽签，不含 agent 忙 / 正在演 / 小戏占用的时间。
     */
    function simulate(tier, baseTable, scale, clipMap, clipChance, seconds, rand, opts) {
      var info = shareRows(tier, baseTable, scale, clipMap, clipChance)
      opts = opts || {}
      var per = info.perEvent
      var iscale = Number(opts.intervalScale)
      if (isFinite(iscale) && iscale > 0) per *= iscale
      var bias = Number(opts.bias)
      if (isFinite(bias) && bias > 0) per *= bias
      var sec = Number(seconds)
      if (!isFinite(sec) || sec <= 0) sec = 600
      var draws = Math.max(1, Math.round(sec / Math.max(0.05, per)))
      var rows = info.rows.filter(function (r) { return r.effective > 0 })
      var total = 0, i
      for (i = 0; i < rows.length; i++) total += rows[i].effective
      var counts = {}
      for (i = 0; i < rows.length; i++) counts[rows[i].name] = 0
      var rnd = typeof rand === 'function' ? rand : Math.random
      if (total > 0) {
        for (i = 0; i < draws; i++) {
          var x = rnd() * total
          for (var j = 0; j < rows.length; j++) {
            x -= rows[j].effective
            if (x <= 0) { counts[rows[j].name]++; break }
          }
        }
      }
      return { tier: tier, seconds: sec, draws: draws, perEventSec: per, counts: counts, totalWeight: total }
    }

    /**
     * 权重版轮盘赌。mood 档有自己的权重就用它，否则退回主权重表。
     * 返回行为名；表为空时返回 fallback。
     */
    function chooseBehavior(st, baseTable, rand, allowed, scale) {
      var table = weightsOf(st, baseTable, allowed, scale)
      var total = 0, i
      for (i = 0; i < table.length; i++) total += table[i][1]
      if (!(total > 0)) return 'glance'
      var r = (typeof rand === 'function' ? rand() : Math.random()) * total
      for (i = 0; i < table.length; i++) {
        r -= table[i][1]
        if (r <= 0) return table[i][0]
      }
      return table[table.length - 1][0]
    }

    /** 抽完之后更新状态：安静/活跃的转移都发生在这里 */
    function noteBehavior(st, name, baseTable, now) {
      if (!st) return
      st.lastKind = name
      if (LIVELY_KINDS[name]) st.quiet = 0
      else st.quiet++
      // 已经有活泼窗口 / 刚开始活泼 → 保持活泼
      if (st.mood === 'lively') {
        if (now - st.lastLivelyAt > LIVELY_WINDOW_MS && st.left <= 0) st.mood = 'normal'
        return
      }
      if (st.mood === 'drowsy') {
        if (LIVELY_KINDS[name]) st.mood = 'normal'
        return
      }
      // normal：抽到够多次「没戏」或很久没互动 → 转安静；有互动窗口 → 转活泼
      // ⚠️ 两个判断都**不能**依赖「lastLivelyAt > 0」：
      //    刚启动时它是 0，若拿它有条件，就会 0 - 0 = 0 永远不超时 → 头 40 秒进不了发呆档。
      // 这里只处理「退出活泼」和「进入安静」：
      //   · 活泼窗口过了且本簇做完了 → 回常态
      if (st.quiet >= DROWSY_AFTER_QUIET || now - st.lastLivelyAt > DROWSY_AFTER_MS) st.mood = 'drowsy'
    }

    return {
      MOODS: MOODS,
      makeState: makeState,
      intervalMs: intervalMs,
      takeCluster: takeCluster,
      scheduleNextInCluster: scheduleNextInCluster,
      chooseBehavior: chooseBehavior,
      weightsOf: weightsOf,
      tierTable: tierTable,
      weightMatrix: weightMatrix,
      shareRows: shareRows,
      simulate: simulate,
      noteBehavior: noteBehavior,
      noteActivity: noteActivity,
      maybeDrowsy: maybeDrowsy,
      clipAllowed: clipAllowed,
      biasFactor: biasFactor,
      consts: { GAP: GAP, DROWSY_AFTER_QUIET: DROWSY_AFTER_QUIET, DROWSY_AFTER_MS: DROWSY_AFTER_MS, LIVELY_WINDOW_MS: LIVELY_WINDOW_MS, LIVELY_KINDS: LIVELY_KINDS }
    }
  })()
  /* ==== @idle-rhythm:end ==== */

  /* ==== @idle-sensors:start ====
   * 互动感知引擎（纯函数，无 DOM / PIXI 依赖）。
   *
   * 甩一下鼠标、在旁边打字。有了它才有「她一有动静就来劲」的灵动感。
   *
   * 为什么单独一块还带标记：和 @motion-engine / @idle-rhythm 一样，这里只做
   * 「一段光标轨迹 + 时间 → 该不该反应」，不碰任何运行时对象，
   * 所以能被 _research-data/测试互动感知.mjs 原样抠出来在 Node 里跑单测。
   *
   * ⚠️ 设计约束（踩过才知道要写死在这里）：
   *   反应**只允许抢 idle 大脑**（临时接管待机调度），**绝不写 rig.override**。
   *   要是反应去占了那一层，agent 一干活就会把她的反应当成「正在表演」而跳过，
   *   更糟的是反应会把真实事件顶掉。所以这里只产出「想做什么」，
   *   由调用方在确认「空闲 + 没有 override」之后才真的做。
   */
  var DSHPetIdleSensors = (function () {
    'use strict'

    /** 默认阈值（都能被 CFG 覆盖） */
    var DEFAULTS = {
      hoverPad: 60, // 「凑近」的判定外扩像素
      hoverMs: 1200, // 停留多久才算「凑近了在看」
      stareMs: 4500, // 停留多久算「盯太久」（会害羞）
      swooshSpeed: 1400, // 算「甩过去」的速度阈值 px/s
      typingIdleMs: 3000 // 停打字多久算「停下来看你了」
    }
    /** 默认冷却（毫秒）—— 防止「动一下就疯狂反应」 */
    var COOLDOWN = { hover: 20000, stare: 45000, swoosh: 6000, typing: 20000, typingStop: 45000 }
    var LIVELY_GAP_MS = 5000

    function clampNum(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
    function cfgn(cfg, k, d) {
      var v = Number(cfg && cfg['sensor' + k.charAt(0).toUpperCase() + k.slice(1)])
      return isFinite(v) && v >= 0 ? v : d
    }

    function makeState() {
      return {
        t: 0, // 上次帧时间（ms）
        inNear: false,
        inside: false, // 光标在模型实体（alpha 掩码）内
        sinceNear: 0, // 连续在近处的起始时刻；0 = 不在
        speed: 0, // 速度 EMA（px/s）
        stared: false, // 本次停留是否已经报过 stare
        typing: false,
        typingSince: 0,
        lastTypeAt: 0,
        lastLivelyAt: -Infinity,
        hot: {}, // 各事件的冷却到期时刻
        counts: { hover: 0, stare: 0, swoosh: 0, typing: 0, typingStop: 0 }
      }
    }

    /** 冷却好了没；ok(name, now) 为真时顺手把冷却推后 */
    function ready(st, name, now, ms) { return now >= (st.hot[name] || 0) }
    function arm(st, name, now, ms) { st.hot[name] = now + ms }

    /**
     * 推进一帧，产出本帧发生的事件。
     *   input: { x, y, near, inside, overUi }
     *     near   = 光标落在「她身体外扩 hoverPad」的矩形内
     *     inside = 光标落在她身体的 alpha 掩码内（贴在她身上）
     *     overUi = 光标在她自己的按钮/面板上（那不算「看她」）
     */
    function frame(st, input, cfg, now) {
      var f = { hover: false, stare: false, swoosh: false, typing: false, typingStop: false, near: false, lively: false }
      if (!st) return f
      var dt = st.t ? clampNum((now - st.t) / 1000, 0.001, 0.5) : 0.04
      st.t = now
      var pad = cfgn(cfg, 'hoverPad', DEFAULTS.hoverPad)
      var hoverMs = cfgn(cfg, 'hoverMs', DEFAULTS.hoverMs)
      var stareMs = cfgn(cfg, 'stareMs', DEFAULTS.stareMs)
      var swooshSpeed = cfgn(cfg, 'swooshSpeed', DEFAULTS.swooshSpeed)

      // —— ① 视线驻足 / ② 被长时间盯 ——
      var near = !!(input && input.near && !input.overUi)
      f.near = near
      if (near) {
        if (!st.inNear) { st.inNear = true; st.sinceNear = now; st.stared = false }
        var held = now - st.sinceNear
        if (held >= stareMs && !st.stared) {
          st.stared = true
          if (ready(st, 'stare', now)) { arm(st, 'stare', now, COOLDOWN.stare); f.stare = true; st.counts.stare++ }
        } else if (held >= hoverMs && ready(st, 'hover', now)) {
          arm(st, 'hover', now, COOLDOWN.hover)
          f.hover = true
          st.counts.hover++
        }
      } else {
        st.inNear = false
        st.sinceNear = 0
        st.stared = false
      }

      // —— ③ 鼠标掠过（只动视线，不动身体）——
      if (!(input && input.overUi)) {
        var v = Math.sqrt((input && input.vx ? input.vx : 0) * (input.vx || 0) + (input.vy || 0) * (input.vy || 0))
        st.speed += (v - st.speed) * clampNum(dt * 8, 0, 1) // EMA：抗单帧抖动
        if (st.speed > swooshSpeed && ready(st, 'swoosh', now)) {
          arm(st, 'swoosh', now, COOLDOWN.swoosh)
          f.swoosh = true
          st.counts.swoosh++
        }
      }

      // —— ④ 打字 ——
      var typingIdleMs = cfgn(cfg, 'typingIdleMs', DEFAULTS.typingIdleMs)
      if (st.typing && now - st.lastTypeAt >= typingIdleMs) {
        st.typing = false // 停下来了 → 抬头看你一眼
        if (ready(st, 'typingStop', now)) {
          arm(st, 'typingStop', now, COOLDOWN.typingStop)
          f.typingStop = true
          st.counts.typingStop++
        }
      }

      return f
    }

    function key(st, now) {
      if (!st) return
      st.typing = true
      st.typingSince = st.typingSince || now
      st.lastTypeAt = now
      return st
    }

    /**
     */
    function livelyTick(st, now, gap) {
      if (!st) return false
      var g = gap == null ? LIVELY_GAP_MS : gap
      // 靠 makeState 里的 -Infinity 哨兵区分「从没发生过」：
      // ⚠️ 别改回 `lastLivelyAt > 0 && ...`：当 now 恰好是 0 时那会让首帧被吃掉。
      if (now - st.lastLivelyAt < g) return false
      st.lastLivelyAt = now
      return true
    }

    return {
      DEFAULTS: DEFAULTS,
      COOLDOWN: COOLDOWN,
      LIVELY_GAP_MS: LIVELY_GAP_MS,
      makeState: makeState,
      frame: frame,
      key: key,
      livelyTick: livelyTick,
      resetCooldowns: function (st) { if (st) st.hot = {} },
      /** 供诊断：把冷却表读出来 */
      cooldowns: function (st, now) {
        if (!st) return null
        var o = {}
        for (var k in COOLDOWN) o[k] = Math.max(0, Math.round((st.hot[k] || 0) - now))
        return o
      }
    }
  })()
  /* ==== @idle-sensors:end ==== */

  /* ==== @sleep-state:start ====
   * 睡眠状态机（纯函数，无 DOM / PIXI 依赖）。
   *
   * 解决什么问题：睡着以后她应该「真的睡着」——
   *   闭眼、不再抽待机行为/小戏、不跟鼠标、只留呼吸和偶尔的梦话；
   *   而叫醒她要靠**明确的手势**（在身上停 5 秒 / 身边快速甩鼠标 / 直接拖），
   *   不是「随便动一下鼠标」。
   *
   * 为什么单独一块纯函数：这些判定全是「时间 + 光标位置 + 速度 → 该不该醒 / 换哪张嘴」，
   *   不碰任何运行时对象，所以 _research-data/测试互动感知.mjs 能原样抠出来跑。
   *
   * ⚠️ 「睡着时鼠标已经在身上」不算数：begin() 里 hoverArmed = !inside，
   *    必须先把光标移出去、再放回来，才会开始计 5 秒。
   */
  var DSHPetSleep = (function () {
    'use strict'

    var DEFAULTS = {
      hoverMs: 5000, // 鼠标停在她身上多久叫醒（毫秒）
      swishSpeed: 1200, // 在她周围多快算「快速甩动」（px/s）
      faceMinMs: 10000, // 睡脸换嘴：最短间隔
      faceMaxMs: 30000, // 睡脸换嘴：最长间隔
      dreamMinMs: 30000, // 梦话：最短间隔
      dreamMaxMs: 50000 // 梦话：最长间隔
    }
    var FACE_COUNT = 3

    function clampNum(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
    /** 读 CFG 里的 sleepXxx（都可选；没配就用 DEFAULTS） */
    function cfgn(cfg, k, d) {
      var v = Number(cfg && cfg['sleep' + k.charAt(0).toUpperCase() + k.slice(1)])
      return isFinite(v) && v >= 0 ? v : d
    }
    function gapOf(cfg, kMin, kMax, rand) {
      var a = cfgn(cfg, kMin, DEFAULTS[kMin])
      var b = cfgn(cfg, kMax, DEFAULTS[kMax])
      if (b < a) b = a
      var r = typeof rand === 'function' ? rand() : Math.random()
      return a + (b - a) * clampNum(r, 0, 1)
    }

    function makeState() {
      return {
        asleep: false,
        t: 0, // 上次 tick 时刻
        since: 0, // 入睡时刻
        speed: 0, // 光标速度 EMA（px/s）
        hoverArmed: false, // 光标离开过身上才为 true（睡着时就放在身上不算）
        hoverSince: 0, // 本次连续停在她身上的起点
        faceIdx: 0, // 当前睡脸序号（0~2，调用方映射成表情名）
        nextFaceAt: 0,
        nextDreamAt: 0,
        faceCount: 0,
        dreamCount: 0
      }
    }

    /** 入睡：记住「光标是不是已经在身上」——已经在身上就不武装 5 秒唤醒 */
    function begin(st, now, inside, cfg, rand) {
      if (!st) return st
      st.asleep = true
      st.t = now
      st.since = now
      st.speed = 0
      st.hoverArmed = !inside
      st.hoverSince = 0
      st.faceIdx = 0
      st.faceCount = 0
      st.dreamCount = 0
      st.nextFaceAt = now + gapOf(cfg, 'faceMinMs', 'faceMaxMs', rand)
      st.nextDreamAt = now + gapOf(cfg, 'dreamMinMs', 'dreamMaxMs', rand)
      return st
    }

    /**
     * 睡着时的一帧。返回 { wake, face, dream }：
     *   wake —— 'hover' | 'swish' | null（调用方负责真的叫醒）
     *   face —— 该换的第几张睡脸（null = 不换）
     *   dream —— 这一帧该说一句梦话
     */
    function frame(st, input, cfg, now, rand) {
      var out = { wake: null, face: null, dream: false }
      if (!st || !st.asleep) return out
      input = input || {}
      var dt = st.t ? clampNum((now - st.t) / 1000, 0.001, 0.5) : 0.04
      st.t = now

      // 速度 EMA 放这里（和 @idle-sensors 各用各的状态，互不影响）
      var vx = Number(input.vx) || 0
      var vy = Number(input.vy) || 0
      var v = Math.sqrt(vx * vx + vy * vy)
      st.speed += (v - st.speed) * clampNum(dt * 8, 0, 1)

      // ① 放在身上 5 秒
      if (!input.inside) {
        st.hoverArmed = true
        st.hoverSince = 0
      } else if (st.hoverArmed) {
        if (!st.hoverSince) st.hoverSince = now
        if (now - st.hoverSince >= cfgn(cfg, 'hoverMs', DEFAULTS.hoverMs)) out.wake = 'hover'
      } else {
        st.hoverSince = 0
      }

      // ② 身边快速甩动（要在她附近，不是屏幕任意角落）
      if (!out.wake && input.near && st.speed >= cfgn(cfg, 'swishSpeed', DEFAULTS.swishSpeed)) {
        out.wake = 'swish'
      }

      // ③ 口型轮换（硬切由调用方做：旧睡脸权重直接清掉）
      if (now >= st.nextFaceAt) {
        st.faceIdx = (st.faceIdx + 1) % FACE_COUNT
        st.faceCount++
        out.face = st.faceIdx
        st.nextFaceAt = now + gapOf(cfg, 'faceMinMs', 'faceMaxMs', rand)
      }

      // ④ 梦话
      if (now >= st.nextDreamAt) {
        st.dreamCount++
        out.dream = true
        st.nextDreamAt = now + gapOf(cfg, 'dreamMinMs', 'dreamMaxMs', rand)
      }

      return out
    }

    function end(st) {
      if (!st) return st
      st.asleep = false
      st.hoverArmed = false
      st.hoverSince = 0
      st.speed = 0
      return st
    }

    /** 诊断用：摊平成可读对象 */
    function snapshot(st, now) {
      if (!st) return null
      return {
        asleep: !!st.asleep,
        sinceMs: st.asleep ? Math.round(now - st.since) : 0,
        speed: Math.round(st.speed),
        hoverArmed: st.hoverArmed,
        hoverMs: st.hoverSince ? Math.round(now - st.hoverSince) : 0,
        faceIdx: st.faceIdx,
        faceInMs: st.asleep ? Math.max(0, Math.round(st.nextFaceAt - now)) : 0,
        dreamInMs: st.asleep ? Math.max(0, Math.round(st.nextDreamAt - now)) : 0,
        faceCount: st.faceCount,
        dreamCount: st.dreamCount
      }
    }

    return {
      DEFAULTS: DEFAULTS,
      FACE_COUNT: FACE_COUNT,
      makeState: makeState,
      begin: begin,
      frame: frame,
      end: end,
      snapshot: snapshot
    }
  })()
  /* ==== @sleep-state:end ==== */
  /* ==== @audio-burst:start ====
   * 系统声音「突然开始播放」感知（纯函数，无 DOM / Node 依赖）。
   *
   * 数据来源：外壳 shell/src/audio.js 用 WASAPI 峰值表每 250ms 推一个 peak（0~1）。
   * 这里只做「多久没声音 / 响了多久 / 该不该报一次」的判定，所以能单测。
   *
   * 判定：
   *   · quietMs（默认 5min）没有 audible → 武装
   *   · 武装后持续 audible ≥ sustainMs（0.8s）→ 产出一次 burst（冷却 cooldownMs）
   *   · 短提示音（<1.2s）不会触发；一直有声音也不会触发（没有 quiet 窗口）
   *   · 页面刚起来时不知道之前有没有声音：以第一帧为起点，安静满 5min 才武装
   */
  var DSHPetAudioBurst = (function () {
    'use strict'

    var DEFAULTS = {
      peakThreshold: 0.02, // 峰值门槛（0~1）
      sustainMs: 800,
      quietMs: 300000, // 5 分钟没声音才武装
      cooldownMs: 300000 // 两次 burst 至少隔 5 分钟
    }

    function cfgn(cfg, k, d) {
      var v = Number(cfg && cfg['audio' + k.charAt(0).toUpperCase() + k.slice(1)])
      return isFinite(v) && v >= 0 ? v : d
    }

    function makeState() {
      return {
        t: 0,
        started: false,
        peak: 0,
        playing: false,
        since: 0,
        lastAudibleAt: 0,
        armed: false,
        lastBurstAt: 0,
        bursts: 0
      }
    }

    /** 返回 { burst, playing, armed }；burst 一帧最多为 true 一次 */
    function frame(st, input, cfg, now) {
      var out = { burst: false, playing: false, armed: false }
      if (!st) return out
      st.t = now
      var peak = Number(input && input.peak)
      if (!isFinite(peak)) peak = 0
      st.peak = peak
      // 第一帧：不知道之前有没有声音，从这一刻开始算安静。
      // ⚠️ 用 started 标记，不要用「lastAudibleAt 是 0」判断 —— now 恰好是 0 时会被反复重置。
      if (!st.started) { st.started = true; st.lastAudibleAt = now }

      var threshold = cfgn(cfg, 'peakThreshold', DEFAULTS.peakThreshold)
      var sustain = cfgn(cfg, 'sustainMs', DEFAULTS.sustainMs)
      var quiet = cfgn(cfg, 'quietMs', DEFAULTS.quietMs)
      var cooldown = cfgn(cfg, 'cooldownMs', DEFAULTS.cooldownMs)
      var audible = peak >= threshold

      if (audible) {
        st.lastAudibleAt = now
        if (!st.playing) { st.playing = true; st.since = now }
      } else {
        st.playing = false
        st.since = 0
      }

      if (!st.armed && now - st.lastAudibleAt >= quiet) st.armed = true
      // ⚠️ 第一次 burst 不能拿 lastBurstAt=0 和 now 比：页面刚起时 now 可能 < cooldown，会把首播吃掉。
      if (st.armed && st.playing && now - st.since >= sustain && (!st.bursts || now - st.lastBurstAt >= cooldown)) {
        st.armed = false
        st.lastBurstAt = now
        st.bursts++
        out.burst = true
      }

      out.playing = st.playing
      out.armed = st.armed
      return out
    }

    function snapshot(st, now) {
      if (!st) return null
      return {
        peak: +Number(st.peak || 0).toFixed(4),
        playing: !!st.playing,
        playingMs: st.playing ? Math.round(now - st.since) : 0,
        armed: !!st.armed,
        quietMs: st.lastAudibleAt ? Math.round(now - st.lastAudibleAt) : 0,
        bursts: st.bursts,
        sinceBurstMs: st.lastBurstAt ? Math.round(now - st.lastBurstAt) : 0
      }
    }

    return { DEFAULTS: DEFAULTS, makeState: makeState, frame: frame, snapshot: snapshot }
  })()
  /* ==== @audio-burst:end ==== */
  /* ==== @idle-scripts:start ====
   * 成套小戏引擎（纯函数，无 DOM / PIXI 依赖）。
   *
   * 解决什么问题：待机行为一次只做「一件事」（看一眼 / 换个表情 / 说句话），
   * 读起来是零散的。真人闲下来是**连着做几个动作**的：看你一眼 → 伸个懒腰 → 接着发呆。
   * 这就是「小戏」：2~4 步，按时间轴依次触发。
   *
   * 设计要点（都是踩过才知道的）：
   *   1. **只用原子能力**：clip / face / line / prop / glance / qbounce。
   *      绝不嵌套调用 idleExpress()、idleFiddle()、sleep 序列 ——
   *      那些各自有独立的定时器和概率，嵌进来会「双重触发」。
   *   2. **步进式**：每帧喂 now，返回「这一帧该做什么」，不自己开定时器。
   *      所以它挂在既有的 40ms gazeTick 上，零额外调度成本。
   *   3. **可中断**：真实工作事件、点击、或待机大脑要抽新事时，都要能立刻收掉，
   *      否则会出现「演到一半卡住」—— 本项目记过这类坑。
   *   4. 同一段小戏有 minGap 冷却，且全局有「最近演过」记录，避免连着重复。
   */
  var DSHPetIdleScripts = (function () {
    'use strict'

    var SCHEMA = ['at', 'do', 'arg']
    /** 支持的原子动作。列在这里是为了「写错就报错」，而不是静默不生效。 */
    var VERBS = { clip: 1, face: 1, line: 1, prop: 1, glance: 1, qbounce: 1 }

    function clampNum(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

    /** 启动前的校验：数据写错要能立刻看出来（返回问题列表，空数组 = 没问题） */
    function validate(list) {
      var bad = []
      if (!Array.isArray(list)) return ['IDLE_SCRIPTS 不是数组']
      for (var i = 0; i < list.length; i++) {
        var sc = list[i]
        if (!sc || !sc.name) { bad.push('#' + i + ' 缺 name'); continue }
        if (!Array.isArray(sc.steps) || !sc.steps.length) { bad.push(sc.name + ' 没有 steps'); continue }
        for (var j = 0; j < sc.steps.length; j++) {
          var st = sc.steps[j]
          if (typeof st.at !== 'number' || st.at < 0) bad.push(sc.name + ' 第' + (j + 1) + '步 at 非法')
          if (!VERBS[st.do]) bad.push(sc.name + ' 第' + (j + 1) + '步 do 未知：' + st.do)
          if (st.do !== 'glance' && st.do !== 'qbounce' && st.arg == null) bad.push(sc.name + ' 第' + (j + 1) + '步缺 arg')
        }
        // at 必须递增，否则「依次触发」的语义就乱了
        for (var k = 1; k < sc.steps.length; k++) {
          if (sc.steps[k].at < sc.steps[k - 1].at) bad.push(sc.name + ' 的 at 不是递增的')
        }
      }
      return bad
    }

    function makeState() {
      return {
        running: null, // 正在演的小戏
        t0: 0,
        idx: 0, // 下一个待触发的步
        lastFiredIdx: -1, // 同一帧只报一次
        lastEndAt: 0,
        last: null, // 最近演过的名字（用于加权时避开重复）
        nextAt: {}, // 每段小戏的冷却到期时刻
        startedCount: 0
      }
    }

    function durOf(sc) {
      if (!sc || !sc.steps || !sc.steps.length) return 0
      var d = 0
      for (var i = 0; i < sc.steps.length; i++) if (sc.steps[i].at > d) d = sc.steps[i].at
      return d
    }

    /**
     * 这一段现在能不能开演？
     *   · 已经在演 → 不行
     *   · 它自己的冷却没到 → 不行
     *   · 上一段刚演完不到 gapAfter 秒 → 不行（避免连着演、显得很忙）
     */
    function canStart(st, sc, now, gapAfter) {
      if (!st || !sc) return false
      if (st.running) return false
      if (now < (st.nextAt[sc.name] || 0)) return false
      var gap = gapAfter == null ? 15000 : gapAfter
      if (st.lastEndAt && now - st.lastEndAt < gap) return false
      return true
    }

    function start(st, sc, now) {
      if (!st || !sc) return false
      st.running = sc
      st.t0 = now
      st.idx = 0
      st.lastFiredIdx = -1
      st.last = sc.name
      // 这一段的冷却长度**只在这里记一次**，结束时由 frame() 用它上锁。
      // ⚠️ 早先在启动处也算过一次 nextAt，结果和结束时的 gapSec 互相覆盖 ——
      //    同一个量两处算，正是交接文档坑 #5 那种写法，必须收成一处。
      st.minGapMs = (Number(sc.minGap) > 0 ? Number(sc.minGap) : 90) * 1000 + durOf(sc) * 1000
      st.startedCount++
      return true
    }

    /**
     * 推进一帧。返回**这一帧要执行的动作数组**（通常是空数组或 1 个）。
     * 返回数组而不是单个，是因为页面卡顿后可能一帧跨过好几个 at —— 那时该全放出去，
     * 而不是丢掉中间步骤（丢掉会让小戏读起来少一段）。
     */
    function frame(st, now, opts) {
      var out = []
      if (!st || !st.running) return out
      var sc = st.running
      var el = (now - st.t0) / 1000
      var steps = sc.steps || []
      var fired = 0
      for (var i = 0; i < steps.length; i++) {
        var step = steps[i]
        if (el < step.at) break
        if (i < st.idx) continue // 已经放过
        out.push({ script: sc.name, step: i, verb: step.do, arg: step.arg == null ? null : step.arg, at: step.at })
        st.idx = i + 1
        fired++
      }
      // 演完了？
      var total = durOf(sc)
      var hold = (opts && opts.holdSec) || 0.8 // 最后一步之后再多占一小会儿，免得切太急
      if (st.idx >= steps.length && el >= total + hold) {
        st.running = null
        st.lastEndAt = now
        // 冷却 = 这一段自己的 minGap + 它的时长（durOf 在 start 时已算进 minGapMs）
        st.nextAt[sc.name] = now + (st.minGapMs || 90000)
        out.push({ script: sc.name, step: -1, verb: 'end', arg: null, at: el })
      }
      return out
    }

    /** 中断：立刻收掉（真实工作事件 / 点击 / 待机大脑要抽新事时调） */
    function abort(st, now) {
      if (!st || !st.running) return null
      var name = st.running.name
      st.running = null
      st.idx = 0
      st.lastEndAt = now
      return name
    }

    /**
     * 按权重抽一段小戏。
     *   · 冷却中的直接排除
     *   · 刚演过的那一段权重 ×0.3（不是完全禁掉，只是不容易连续重复）
     * 返回被选中的脚本对象，或 null。
     */
    function choose(st, list, now, rand) {
      if (!st || !list || !list.length) return null
      var pool = []
      var total = 0
      for (var i = 0; i < list.length; i++) {
        var sc = list[i]
        if (!sc || !sc.steps || !sc.steps.length) continue
        if (now < (st.nextAt[sc.name] || 0)) continue
        var w = Number(sc.weight) > 0 ? Number(sc.weight) : 1
        if (st.last && sc.name === st.last) w *= 0.3
        pool.push([sc, w])
        total += w
      }
      if (!pool.length || !(total > 0)) return null
      var r = (typeof rand === 'function' ? rand() : Math.random()) * total
      for (var j = 0; j < pool.length; j++) {
        r -= pool[j][1]
        if (r <= 0) return pool[j][0]
      }
      return pool[pool.length - 1][0]
    }

    return {
      VERBS: VERBS,
      validate: validate,
      makeState: makeState,
      durOf: durOf,
      canStart: canStart,
      start: start,
      frame: frame,
      abort: abort,
      choose: choose,
      /** 诊断用：把状态摊平成可读对象 */
      snapshot: function (st, now) {
        if (!st) return null
        var cd = {}
        for (var k in st.nextAt) cd[k] = Math.max(0, Math.round(st.nextAt[k] - now))
        return {
          running: st.running ? st.running.name : null,
          elapsedMs: st.running ? Math.round(now - st.t0) : 0,
          step: st.idx,
          steps: st.running ? (st.running.steps || []).length : 0,
          last: st.last,
          startedCount: st.startedCount,
          cooldowns: cd
        }
      }
    }
  })()
  /* ==== @idle-scripts:end ==== */

  /**
   * 动作引擎的运行时状态。
   *
   * idle  —— 常驻待机层。只写 4 个根参数（ParamAngleX/Y/Z + ParamBreath），
   *          下游的身体/手臂/头发/衣服/耳朵/尾巴全部由物理联动，二次运动天然正确。
   * clips —— 正在播的动作。用数组而不是单个，是因为「两只手一起举」这类
   *          「同时」语义必须能并行播多个；「依次」则靠累加 delay 实现。
   */
  const motion = {
    ready: false,
    idle: DSHPetMotion.makeIdle((Date.now() ^ 0x5f3a) & 0x7fffffff),
    clips: [],
    last: 0,
    /** 诊断：最近一帧引擎写了什么（照交接文档的教训，写入值和当前值要能同时看到） */
    debug: { frames: 0, idleWrote: 0, clipWrote: 0, lastFrame: null },
  }

  /**
   * 待机幅度的**唯一入口**。
   * 交接文档坑 #5 的教训：同一个量被多处独立计算，改一处就漏一处。
   * 所以 enabled / level 只在这里算，别处一律调它。
   */
  function syncIdleLevel() {
    const off = CFG.idleMotion === false
    const s = Number(CFG.idleStrength)
    // 上限 2.5：预设「活泼」会把它推到 1.6。再高会明显穿模风险，所以封顶。
    const base = off ? 0 : clamp(isFinite(s) && s >= 0 ? s : 1, 0, 2.5)
    motion.idle.enabled = base > 0
    motion.idle.level = base * (PERF.low ? 0.35 : 1)
    return { enabled: motion.idle.enabled, level: motion.idle.level }
  }

  /** 每帧把待机层 + 所有在播 clip 的偏移量喂给 add() */
  function tickMotionLayers(add, dtMs) {
    if (!DSHPetMotion) return
    let iw = 0, cw = 0
    try {
      DSHPetMotion.stepIdle(motion.idle, dtMs)
      DSHPetMotion.sampleIdle(motion.idle, (id, v) => { iw++; add(id, v) })
    } catch (e) {}
    for (let i = motion.clips.length - 1; i >= 0; i--) {
      const c = motion.clips[i]
      let phase = 'done'
      try {
        phase = DSHPetMotion.stepClip(c, dtMs)
        if (phase !== 'done') DSHPetMotion.sampleClip(c, (id, v) => { cw++; add(id, v) })
      } catch (e) {}
      if (phase === 'done') motion.clips.splice(i, 1)
    }
    motion.debug.frames++
    motion.debug.idleWrote = iw
    motion.debug.clipWrote = cw
  }

  /**
   * rig 本体：挂在 beforeModelUpdate 上。
   * 每帧先 resolveRig() 把三层解析成「这一刻该显示什么」——
   * 所以一次性反应一过期，对应的参数立刻进入淡出，不需要任何人来清理。
   */
  /**
   * 当前在播的 clip 里，有没有「自带表情」的轨道（PARAM_EXP 开头）？
   *
   * 为什么要问这个：clip 和脸层（rig.face / rig.props）都是**加性偏移**，会叠在一起。
   * 而 exp3 那套「按键-表情」靠的是**显隐**（改 drawable opacity），不是位移 ——
   * 两个同时作用就会出现「眼睑没让开」「脸红叠在伸懒腰上」这类半吊子效果。
   * 随机触发的却有残留（playClip 不动脸层）—— 差异就在这。
   *
   * 判定沿用本项目已有的老经验：「表情类动作 mood 一律 null，否则两个表情打架」。
   * 这里把它做成**机制**，而不是靠每个调用点自觉。
   */
  function clipOwnsExpression() {
    if (!motion || !motion.clips || !motion.clips.length) return false
    for (const c of motion.clips) {
      if (!c || c.done || !c.def || !c.def.tracks) continue
      for (const tr of c.def.tracks) {
        if (tr && typeof tr.id === 'string' && tr.id.indexOf('PARAM_EXP') === 0) return true
      }
    }
    return false
  }

  function applyRig() {
    if (!coreModel) return
    resolveRig()
    const now = performance.now()
    const dt = Math.min(64, now - (applyRig._last || now)) / 1000
    applyRig._last = now

    const targets = new Map()
    // ⚠️ 正在播的 clip 自带表情（PARAM_EXP）时，**脸层让位** ——
    //    clip 和脸层都是加性偏移且都会动那批「显隐开关」，叠起来就是：
    //      · 伸懒腰的眼睑没完全让开（看起来还睁着）
    //      · 脸红叠在伸懒腰上
    //    实测差异来源：手动点走 act()（会清脸层），随机触发走 playClip（不清）。
    //    让位窗口跟着 clip 一起走（含 300ms 淡出），所以动作结束脸会自然回来。
    const clipExpr = clipOwnsExpression()
    if (!clipExpr && rig.face) targets.set(rig.face, 1)
    if (!clipExpr) for (const name of rig.props) targets.set(name, 1)

    // 权重推进：进得慢一点、退得快一点，观感更像「变脸」而不是硬切
    for (const name of Array.from(rig.weight.keys())) {
      const target = targets.get(name) || 0
      let w = rig.weight.get(name) || 0
      const speed = target > w ? 7 : 11
      w += (target - w) * clamp(dt * speed, 0, 1)
      if (target === 0 && w < 0.02) rig.weight.delete(name)
      else rig.weight.set(name, w)
    }
    for (const name of targets.keys()) {
      if (!rig.weight.has(name)) rig.weight.set(name, 0)
    }

    // —— 参数独占 ——
    // 光靠「一个 face + 若干道具」还不够：有些道具本身也写脸部参数
    // （比如墨镜会写 ParamEyeLOpen），叠上去就会打架。
    // 所以这里做一个裁决：每个参数在同一时刻只允许**一个**表达式写，
    // 优先级 脸 > 道具（按加入顺序）。
    const delta = new Map()
    const claimed = new Set()
    let skipped = 0
    const add = (id, v) => delta.set(id, (delta.get(id) || 0) + v)
    const winners = []
    if (rig.face && (rig.weight.get(rig.face) || 0) > 0) winners.push(rig.face)
    for (const name of rig.props) if (name !== rig.face && (rig.weight.get(name) || 0) > 0) winners.push(name)
    for (const name of winners) {
      const w = rig.weight.get(name) || 0
      const params = EXPR[name]
      if (!params) continue
      for (const p of params) {
        if (claimed.has(p.id)) {
          skipped++ // 这个参数已经被更高优先级的表情写了
          continue
        }
        claimed.add(p.id)
        add(p.id, p.value * w)
      }
    }
    // 正在淡出的表情不参与裁决，权重照常推进（它们本来就没抢到参数）
    for (const name of rig.weight.keys()) {
      if (winners.indexOf(name) >= 0) continue
      const w = rig.weight.get(name) || 0
      const params = EXPR[name]
      if (!params || w <= 0) continue
      for (const p of params) {
        if (claimed.has(p.id)) continue
        claimed.add(p.id)
        add(p.id, p.value * w)
      }
    }

    // 说话口型：只在真的在吐字时才动嘴，空闲时嘴巴是放松的
    //
    // 2026-10-17：不再是一个固定正弦 —— 按**语气**调嘴的基准/幅度/节奏，
    // 并且顺手把眉毛、嘴角、歪头也挂上去（幅度都很小，见 @talk-tone 的注释）。
    if (CFG.talkMouth && rig.talking) {
      rig.talkPhase += dt
      const tp = (typeof DSHPetTalkTone !== 'undefined' && DSHPetTalkTone)
        ? DSHPetTalkTone.params(rig.talkTone)
        : { open: 0.28, amp: 0.16, rate: 11, brow: 0, form: 0, yaw: 0, pitch: 0 }
      add('ParamMouthOpenY', tp.open + tp.amp * Math.sin(rig.talkPhase * tp.rate))
      if (tp.brow) {
        add('ParamBrowLAngle', tp.brow)
        add('ParamBrowRAngle', tp.brow)
      }
      if (tp.form) add('ParamMouthForm', tp.form)
      if (tp.yaw) add('ParamAngleZ', tp.yaw * Math.sin(rig.talkPhase * 3.1))
      if (tp.pitch) add('ParamAngleY', tp.pitch)
    }

    // 一次性参数脉冲（爱心粒子 / 心跳），到期自动停
    if (rig.burst) {
      if (performance.now() > rig.burst.until) rig.burst = null
      else {
        if (rig.burst.love) add('love', rig.burst.love)
        if (rig.burst.heartbeat) add('ParamCheek73', rig.burst.heartbeat)
      }
    }

    // ——————————————————————————————————————————————————————————
    // 动作引擎：待机层 + 动作 clip
    //
    // 位置很关键，见交接文档记录的 pixi 每帧顺序：
    //   动作写入 → saveParameters() 存快照 → 眨眼/视线/呼吸/物理 → beforeModelUpdate(这里)
    //   → coreModel.update() → loadParameters() 把快照装回来
    // 所以这一层写进去的值**当帧生效**、帧末被 loadParameters() 还原，不会累积；
    // 而且它跑在物理**之后**，所以对物理的输出参数（手臂）是「盖住」而不是「打架」。
    //
    // 全部用 add()（加性偏移），因此和表情、眨眼、视线、物理是叠加关系。
    // ——————————————————————————————————————————————————————————
    tickMotionLayers(add, dt * 1000)

    // —— 眨眼（自然节奏，见 blinkTick）——
    blinkTick(now, claimed.has('ParamEyeLOpen') || claimed.has('ParamEyeROpen'), motionActive())

    // —— 眼睛自愈 ——
    // 万一还有哪条路径把「睁眼」参数冻在 0（闭眼），这里把它纠回来。
    // 只在「没有动作在播 + 我们自己的表情/道具都没认领眼睛参数 + 已经闭了 1.5 秒以上」时才动手，
    // 所以不会跟眨眼（一次 0.1 秒）、也不会跟「闭眼口水」这种真的闭眼表情打架。
    if (coreModel && model && !rig.eyesHeal) rig.eyesHeal = { since: 0, warned: false }
    if (rig.eyesHeal) {
      const eL = 'ParamEyeLOpen'
      const eR = 'ParamEyeROpen'
      const claimedEye = claimed.has(eL) || claimed.has(eR)
      const motionOn = motionActive()
      const v = eyesOpen()
      if (!claimedEye && !motionOn && v !== null && v < 0.25) {
        if (!rig.eyesHeal.since) rig.eyesHeal.since = now
        else if (now - rig.eyesHeal.since > 1500) {
          for (const id of [eL, eR]) {
            const d = paramDefault(id)
            if (d !== null) {
              try {
                coreModel.setParameterValueById(id, d)
              } catch (e) {}
            }
          }
          try {
            coreModel.saveParameters()
          } catch (e) {}
          rig.eyesHeal.since = 0
          if (!rig.eyesHeal.warned) {
            rig.eyesHeal.warned = true
            log('检测到眼睛被冻住，已按默认值纠回（自愈）')
          }
        }
      } else {
        rig.eyesHeal.since = 0
      }
    }

    // 诊断：这一帧有多少次「因为参数已被占用而放弃写入」。
    // 它 > 0 就说明独占裁决真的在起作用（两个表情想写同一个参数时被打回）。
    rig.exclusive = { written: delta.size, skipped, writers: winners }
    for (const [id, v] of delta) {
      if (Math.abs(v) < 0.001) continue
      try {
        coreModel.addParameterValueById(id, v)
      } catch (e) {}
    }

    // —— 诊断：把「写入值」和「当前值」同时记下来 ——
    // 为什么两个都要：applyRig 跑在 loadParameters() 之前，帧末参数会被快照还原，
    // 所以在帧外读 paramValue() 永远读到快照值，看不到我们写了什么。
    // 交接文档坑 #3 的教训（连猜错三次），写入值和当前值必须能同时看到。
    const WATCH = [
      'ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBreath',
      'Param_arm_L1', 'Param_arm_L2', 'Param_arm_L3', 'Param_arm_L4',
      'Param_arm_R1', 'Param_arm_R2', 'Param_arm_R3', 'Param_arm_R4',
      // 表情类的关键参数也看一眼：
      // 注意不能用 paramValue() 判断表情有没有生效 —— applyRig 跑在 loadParameters()
      // 之前，帧末参数会被快照还原，帧外读到的永远是快照值（这条踩过）。
      'ParamBrowLAngle', 'ParamBrowRAngle', 'ParamBrowLForm', 'ParamBrowRForm', 'ParamMouthForm',
      // 眼睛形状（0=闭 1=睁）。闭眼观感排查必须看它：
      //   PARAM_EXP5 只切「眼睑素材的透明度」，而「眼睛形状」是这两条在管 ——
      //   两者是两个独立系统，只动一个就会出现「闭眼没盖严」（实测踩过）。
      'ParamEyeLOpen', 'ParamEyeROpen',
      // 阶段 1 的表情类动作还会驱动这几个：眼球 / 张嘴 / 嘴横移 / 脸红开关
      'ParamEyeBallX', 'ParamEyeBallY', 'ParamMouthOpenY', 'ParamMouthX',
      // 全部 8 个按键-表情开关都盯着，表情页每一项都能验
      'PARAM_EXP1', 'PARAM_EXP2', 'PARAM_EXP3', 'PARAM_EXP4', 'PARAM_EXP5', 'PARAM_EXP6', 'PARAM_EXP7', 'PARAM_EXP8',
    ]
    motion.debug.out = {}
    for (const id of WATCH) motion.debug.out[id] = +(delta.get(id) || 0).toFixed(3)
    motion.debug.applied = {
      ParamAngleX: paramValue('ParamAngleX'),
      ParamAngleY: paramValue('ParamAngleY'),
      ParamAngleZ: paramValue('ParamAngleZ'),
      ParamBreath: paramValue('ParamBreath'),
    }

    // —— 水印常关（大肥鱼专属）——
    // 作者把水印做成了可开关参数 Paramcol_3（cdi3 里叫「3.水印消除」），
    // 原始 VTS 用法是手动按 F10。桌宠里没必要看广告，启动即常关。
    // 放在 delta 之后写：不占「参数独占」额度，也不参与表情菜单的裁决。
    if (model && model.internalModel && model.internalModel.coreModel) {
      try {
        model.internalModel.coreModel.setParameterValueById('Paramcol_3', 1)
      } catch (e) {}
    }
  }

  /**
   * 任何路径都不许再播的动作。
   *   aidale   —— 「伸展」，内部驱动 15 个表情参数，一播就多个表情同时亮
   *   selfie*  —— 同上，自带 10 个表情参数
   */
  const FACE_DRIVING_MOTIONS = new Set(['bubble', 'aidale', 'selfie', 'selfieQuick'])
  const BANNED_MOTIONS = FACE_DRIVING_MOTIONS

  /**
   * 动作是否正在播。
   * 不用框架的 `motionManager.isFinished()` —— 实测它空闲时也返回「没结束」，
   * 会让「动作期间不眨眼」永远成立（之前眨眼就是这么被憋住的）。
   * 改成我们自己记账：起动作时按清单里的时长记一个截止时间。
   */
  let motionUntil = 0
  function motionActive() {
    if (performance.now() < motionUntil) return true
    // 动作引擎的 clip 也算「正在做动作」——播放中不眨眼，和 motion3 的待遇一致
    if (motion.clips.length) return true
    return false
  }

  /**
   * 这个名字能播吗？
   * 两个来源都算：manifest 里的 motion3 资产，或者动作引擎的 clip 库。
   * 交接文档坑 #5 的教训——这种判断只能有一个入口，否则又是「改一处漏三处」。
   */
  function motionPlayable(name) {
    if (!name) return false
    if (manifest && manifest.motions && manifest.motions[name]) return true
    return !!(DSHPetMotion && DSHPetMotion.resolveName(name))
  }

  /** 动作时长（秒）。clip 走引擎，motion3 走 manifest。 */
  function motionDuration(name) {
    if (manifest && manifest.motions && manifest.motions[name]) {
      return Number(manifest.motions[name].duration) || 2
    }
    const def = DSHPetMotion && DSHPetMotion.getClipDef(name)
    return def ? def.duration : 2
  }

  /**
   * 换掉正在播的 clip：旧的先**淡出**再加入新的。
   *
   * ⚠️ 这是「换动作」的**唯一入口** —— playClip / playClips 都走它。
   *   为什么必须收成一处：clip 是加性偏移，直接替换数组会让旧动作的偏移永远留在参数上，
   *   两处各写一遍，迟早漏一处 —— 本项目记过这个形态（交接文档坑 #5）。
   */
  const CLIP_FADE_MS = 300
  function swapClips(next) {
    const out = []
    for (const c of motion.clips) {
      if (!c || c.done) continue
      // 正在淡出的就别重复标记了；其它的让它淡出，并留在数组里继续被 step/sample
      if (!c.fading && DSHPetMotion && DSHPetMotion.fadeOutClip) DSHPetMotion.fadeOutClip(c, CLIP_FADE_MS)
      out.push(c)
    }
    motion.clips = out.concat(next || [])
    return motion.clips.length
  }

  /** 播放一个动作 clip（动作引擎的动作库）。返回是否成功。 */
  function playClip(name, opts) {
    if (idle.sleep) wakeUp('clip') // 睡着时外部点动作：先叫醒（睡脸不能挂着一个动作）
    if (!DSHPetMotion) return false
    const c = DSHPetMotion.makeClip(name, opts || {})
    if (!c) return false
    swapClips([c])
    log('播放动作：' + name)
    return true
  }

  /**
   * 播放一组动作。timing: '同时' | '依次'
   * 词汇表直接对齐 HAST-SEC 的意图契约，将来接自然语言时不用再翻译一层。
   */
  function playClips(list, timing) {
    if (!DSHPetMotion || !Array.isArray(list) || !list.length) return false
    const made = []
    for (const x of list) {
      const c = DSHPetMotion.makeClip(x.name || x.clip, x)
      if (c) made.push(c)
    }
    if (!made.length) return false
    if (timing === '依次') {
      // 串行：每个的等待时间 = 前面所有动作的时长之和
      let acc = 0
      for (const c of made) {
        c.delay += acc
        c.waiting = c.delay
        acc += c.def.duration / c.speed + c.hold
      }
    }
    swapClips(made)
    log('播放动作组：' + made.map((c) => c.name).join(' + ') + '（' + (timing || '同时') + '）')
    return true
  }

  /**
   * 停掉所有 clip。
   *
   * ⚠️ 也是**淡出**而不是清空数组：清了数组，最后那一帧的偏移就永远留在参数上
   *   （和 swapClips 是同一个理由）。留一个 0 长度的返回语义不变。
   */
  function stopClips() {
    const n = motion.clips.length
    for (const c of motion.clips) {
      if (c && !c.done && !c.fading && DSHPetMotion && DSHPetMotion.fadeOutClip) DSHPetMotion.fadeOutClip(c, CLIP_FADE_MS)
    }
    if (n === 0) motion.clips.length = 0
    return n
  }

  function playMotion(group, priority) {
    if (!model || !manifest) return
    if (BANNED_MOTIONS.has(group)) return
    if (!manifest.motions || !manifest.motions[group]) {
      // manifest 里没有这个名字 → 交给动作引擎的 clip 库。
      // 好处：/dsh-pet/control 的 motion 字段、DSHPet.playMotion、菜单项
      // 全都不用改就能播新动作（后端 lib/index.js 一行都不用动，也就不用重启 DSH）。
      if (playClip(group)) return
      log('没有这个动作：', group)
      return
    }
    const dur = Number(manifest.motions[group].duration) || 1.5
    motionUntil = performance.now() + dur * 1000 + 120
    try {
      // 第三参是优先级（数字）：FORCE 才能盖过常驻待机循环
      model.motion(group, 0, priority == null ? MOTION_PRIORITY.FORCE : priority)
    } catch (e) {
      console.warn('[鲸鱼娘] 动作播放失败', group, e)
    }
  }

  // ——————————————————————————————————————————————————————————————
  // 四·五、表演调度器（所有「一次性反应」的唯一入口）
  // ——————————————————————————————————————————————————————————————

  /** 当前正在进行的「一次性表演」。任何时刻最多一个。 */
  let acting = null
  let motionTimer = null

  /**
   * 停掉当前表演：取消一次性表情、爱心脉冲、一次性动作，
   */
  function stopActing() {
    acting = null
    if (motionTimer) {
      clearTimeout(motionTimer)
      motionTimer = null
    }
    rig.override = null
    rig.burst = null
    resolveRig()
    // 把所有动作停掉，回到模型的**默认姿势**（配合物理/呼吸/眨眼就是「正常坐姿」）。
    //
    // 这里**不再播 motions/idle.motion3.json**：那套资产里的 "idle" 其实是
    // 猫爪摆动 + 爱心粒子的循环动画（89 条曲线里 maoshou*/j* 就是它们），
    // 一直循环会让人看到「手在这摆」和「一长串莫名的待机动作」。
    //
    // 例外：干活时如果小设备已经掏出来了（查资料），别把它收掉——
    // 互动只是插一下，互动完要回到「正在查资料」的样子。
    if (!device.out) stopMotion()
    // 动作引擎的 clip 也属于「一次性表演」，一起收掉。
    // 不这么做的话，点第二个动作时第一个的 clip 会继续叠着播。
    stopClips()
  }

  /**
   * 把所有「动作会写的参数」复位到模型默认值，并重存一次框架的参数快照。
   *
   * 为什么必须手动做（踩了很久才查明白）：pixi-live2d-display 每帧的顺序是
   *     动作写入 → saveParameters() 存快照 → 眨眼/视线/呼吸/物理 → beforeModelUpdate(我们的 rig)
   *     → coreModel.update() → loadParameters() 把快照装回来
   * 也就是说**快照是在动作写入之后存的**。动作一旦停下，快照里留的就是它最后一帧的姿势，
   * 「蛋包饭点过以后永远挂在桌上、手机收不回去、表情也回不去，连一键重置都没用」。
   * 所以停动作时要做两件事：① 把这些参数设回默认值 ② 重新 save 一次，把快照换成默认姿势。
   */
  function clearMotionPose() {
    if (!coreModel || !manifest) return 0
    const ids = new Set()
    for (const meta of Object.values(manifest.motions || {})) {
      for (const id of meta.params || []) ids.add(id)
    }
    let n = 0
    let bad = 0
    for (const id of ids) {
      try {
        const def = paramDefault(id)
        // 取不到默认值的参数一律**不要碰**！之前就是在这里把「睁眼」参数当成了 0，
        if (def === null) { bad++; continue }
        if (typeof coreModel.setParameterValueById === 'function') coreModel.setParameterValueById(id, def)
        n++
      } catch (e) {}
    }
    if (bad && !clearMotionPose._warned) {
      clearMotionPose._warned = true
      log(`有 ${bad} 个动作参数取不到默认值，已跳过（绝不猜 0）`)
    }
    try {
      if (typeof coreModel.saveParameters === 'function') coreModel.saveParameters()
    } catch (e) {}
    return n
  }

  /**
   * 眨眼控制器。
   *
   * 人类大概是每 3~5 秒眨一次，单次 0.1~0.2 秒，偶尔会连眨两下。
   * 框架自带的实现是「下次眨眼 = random × 7 秒」，范围太野，所以这里自己来：
   *   · 间隔：2.6~5.4 秒随机；15% 概率紧接着再眨一下（连眨）
   *   · 单次时长：闭合 60ms + 闭合保持 30ms + 睁开 100ms ≈ 0.19 秒
   *   · 动作在播、或者有表情/道具正在写眼睛参数（比如「闭眼口水」）时**不眨**
   */
  const blink = { nextAt: 0, phase: 'idle', t0: 0, queue: 0, gate: '', count: 0 }

  function blinkTick(now, eyeClaimed, motionOn) {
    if (!coreModel) { blink.gate = 'no-model'; return }
    if (eyeClaimed || motionOn) {
      blink.gate = eyeClaimed ? 'eye-claimed' : 'motion-on'
      blink.phase = 'idle'
      blink.nextAt = now + 1200
      return
    }
    blink.gate = 'ok'
    // 睁眼基准取模型默认值（大肥鱼是 1.9，不是 1.0）；取不到就退回 1
    const OPEN_BASE = (() => {
      const d = paramDefault('ParamEyeLOpen')
      return typeof d === 'number' && d > 0.1 ? d : 1
    })()
    const set = (v) => {
      try {
        const o = v * OPEN_BASE
        coreModel.setParameterValueById('ParamEyeLOpen', o)
        coreModel.setParameterValueById('ParamEyeROpen', o)
      } catch (e) {}
    }
    /*
     * 2026-10-17：偶尔「慢慢眨」一次（5%），时长放到 3 倍左右 —— 慵懒感。
     * 为什么敢在这里改：眨眼是**绝对赋值**（set），和任何加性偏移都不打架；
     * 而且它是半自动的生理动作，慢一拍的观感差异比换个动作明显得多。
     */
    const slow = blink.slow === true
    const CLOSE = slow ? 190 : 60
    const HOLD = slow ? 130 : 30
    const OPEN = slow ? 240 : 100
    if (blink.phase === 'idle') {
      if (!blink.nextAt) blink.nextAt = now + 900 + Math.random() * 2600
      if (now >= blink.nextAt) {
        blink.phase = 'closing'
        blink.t0 = now
        blink.count++
        blink.slow = Math.random() < 0.05 // 偶尔慢眨（慵懒）
        blink.queue = !blink.slow && Math.random() < 0.15 ? 1 : 0 // 偶尔连眨两下（慢眨就不连了）
      } else {
        return
      }
    }
    const dt = now - blink.t0
    if (blink.phase === 'closing') {
      set(1 - Math.min(1, dt / CLOSE))
      if (dt >= CLOSE) {
        blink.phase = 'closed'
        blink.t0 = now
      }
    } else if (blink.phase === 'closed') {
      set(0)
      if (dt >= HOLD) {
        blink.phase = 'opening'
        blink.t0 = now
      }
    } else if (blink.phase === 'opening') {
      set(Math.min(1, dt / OPEN))
      if (dt >= OPEN) {
        blink.phase = 'idle'
        blink.slow = false
        if (blink.queue > 0) {
          blink.queue = 0
          blink.nextAt = now + 180 // 连眨：紧接着再来一下
        } else {
          blink.nextAt = now + 2600 + Math.random() * 2800
        }
      }
    }
  }

  /**
   * 取某个参数的默认值。**框架的 getParameterDefaultValue 收的是「下标」不是 id**，
   * 传 id 会拿到 undefined —— 若拿不到就返回 null，调用方必须跳过这个参数，
   * 绝不能拿 0 当默认值（会把「睁眼」写成「闭眼」，就是那次事故）。
   */
  function paramDefault(id) {
    if (!coreModel) return null
    try {
      const idx = typeof coreModel.getParameterIndex === 'function' ? coreModel.getParameterIndex(id) : -1
      if (typeof idx !== 'number' || idx < 0) return null
      if (typeof coreModel.getParameterDefaultValue !== 'function') return null
      const d = coreModel.getParameterDefaultValue(idx)
      if (typeof d !== 'number' || !Number.isFinite(d)) return null
      return d
    } catch (e) {
      return null
    }
  }

  function paramValue(id) {
    if (!coreModel) return null
    try {
      const v = coreModel.getParameterValueById(id)
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    } catch (e) {
      return null
    }
  }

  /** 眼睛当前睁着没：0 = 闭，1 = 睁（返回两只眼的平均值，方便诊断与自愈） */
  function eyesOpen() {
    const l = paramValue('ParamEyeLOpen')
    const r = paramValue('ParamEyeROpen')
    if (l === null && r === null) return null
    const vals = [l, r].filter((v) => v !== null)
    return +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3)
  }

  /** 停掉所有正在播的动作，让模型回到默认姿势。 */
  function stopMotion() {
    motionUntil = 0
    try {
      const mm = model && model.internalModel && model.internalModel.motionManager
      if (mm && typeof mm.stopAllMotions === 'function') mm.stopAllMotions()
    } catch (e) {}
    // 光停动作不够：还得把「动作留下的姿势」从参数快照里清掉，否则它会永远挂着
    clearMotionPose()
  }

  /** 一次性动作：到点自己回到常驻待机（动作也是一次只能一个）。 */
  function playOneShot(group) {
    if (!motionPlayable(group)) return
    const durS = motionDuration(group)
    stopMotion() // 先清干净，再起新的——动作永远只有一个
    playMotion(group, MOTION_PRIORITY.FORCE)
    if (motionTimer) clearTimeout(motionTimer)
    // 到点一定收掉——不管模型里那个动作自己是不是 Loop=true。
    // （aidale / idle 这些资产内部写着循环，不主动停就会一直播下去。）
    motionTimer = setTimeout(() => {
      motionTimer = null
      if (!device.out) stopMotion()
    }, Math.round(durS * 1000) + 150)
  }

  /**
   * 起一次表演。**所有一次性反应都必须走这里，没有例外。**
   *
   *   1. 先把上一次整个停掉、回到平常状态，**再**开始新的 —— 所以永远不会重叠
   *   2. 一次表演 = 一个面部表情 + 至多一个动作 + 至多一个粒子特效
   *   3. 待机表演只在真正空闲时才会被调用；有任务时只有任务表演
   *   4. 永久禁用：吹泡泡糖、大锤砸、呆呆眼（见 BANNED_MOTIONS / MOOD_FACE）
   */
  function act(spec) {
    if (idle.sleep) wakeUp('act') // 睡着时来一次性表演 = 先叫醒（菜单点击也走这条兜底）
    spec = spec || {}
    stopActing() // ← 关键：先归零，再开始
    const ms = spec.ms || 2600
    setReaction({
      mood: spec.mood,
      face: spec.face,
      props: spec.props,
      exclusive: spec.exclusive,
      soft: spec.soft,
      ms,
    })
    if (spec.line) ui.bubble.show(spec.line, { name: 'DS 鲸鱼娘', ttl: Math.max(ms, 1800) })
    if (spec.motion) {
      playOneShot(spec.motion)
      // 只有**真的做动作**时才暂时不盯鼠标；单纯换个表情不该把视线也停掉，
      gazeDetach(Math.max(2200, ms))
    }
    if (spec.heart) heartBurst(ms)
    acting = { until: performance.now() + ms }
    return ms
  }

  // ——————————————————————————————————————————————————————————————
  // 五、启动
  // ——————————————————————————————————————————————————————————————

  async function main() {
    // buildUI 以前在 try 外面——它一旦抛异常，整页会静默什么都不显示，
    // 排查很痛苦。现在整个启动过程都在保护里，并且把错误挂到 window 上。
    try {
      // ⚠️ 设置恢复必须无条件执行：原来它藏在 applyEdge 里，只有「贴边」布局才会调；
      // 自由摆放/全屏时设置永远不恢复（详细频率面板第一次就撞上了）。
      restoreCfg()
      injectStyle()
      ui = buildUI()
      try {
        const th = readLayout().theme
        if (th === 'light' || th === 'dark') ui.root.dataset.dshpTheme = th
      } catch (e) {}
      await loadRuntime()
      const [man, cdi] = await Promise.all([
        fetch(BASE + '/model/manifest.json', { cache: 'no-cache' }).then((r) => r.json()),
        fetch(BASE + '/model/dfyfish.cdi3.json', { cache: 'no-cache' }).then((r) => r.json()),
      ])
      manifest = man
      MODEL_PARAMS = new Set((cdi.Parameters || []).map((p) => p.Id))
      for (const [name, e] of Object.entries(manifest.expressions || {})) {
        const kept = []
        for (const p of e.params || []) {
          if (MODEL_PARAMS.has(p.id)) kept.push(p)
          else droppedParams.add(name + ' → ' + p.id)
        }
        if (kept.length) EXPR[name] = kept
      }
      if (droppedParams.size) {
        log(`已忽略 ${droppedParams.size} 个模型里不存在的参数引用：`, Array.from(droppedParams).join('、'))
      }
      await buildModel()
      wireInteractions()
      connectSSE()
      startLoops()
      syncAudioMeter() // 默认开；关掉时不启 PowerShell 轮询
      log(
        `就绪：${manifest.displayName} · 动作 ${Object.keys(manifest.motions || {}).length} 个 · 可用表情 ${Object.keys(EXPR).length} 个`,
      )
    } catch (err) {
      window.__DSHPetError = String((err && err.stack) || err)
      console.error('[鲸鱼娘] 启动失败：', err)
      try {
        ui = ui || {}
        if (ui.bubble) {
          ui.bubble.show('启动失败：' + (err && err.message ? err.message : err), {
            name: '出错了',
            sticky: true,
          })
        }
      } catch (e) {}
    }
  }

  function injectStyle() {
    if (document.getElementById('dsh-live2d-pet-style')) return
    const s = document.createElement('style')
    s.id = 'dsh-live2d-pet-style'
    s.textContent = PET_CSS
    document.head.appendChild(s)
  }

  async function loadRuntime() {
    if (!window.Live2DCubismCore) await loadScript(BASE + '/vendor/live2dcubismcore.min.js')
    if (!window.PIXI) await loadScript(BASE + '/vendor/pixi.min.js')
    if (!window.PIXI || !window.PIXI.live2d) await loadScript(BASE + '/vendor/cubism4.min.js')
    if (!window.PIXI || !window.PIXI.live2d) throw new Error('Live2D 运行时未就绪')
  }

  /**
   * 性能档。
   *
   * 为什么要有：桌面壳（Mac 原生 App）为了不让她卡住，阻止了 macOS 的 App Nap，
   * 于是**永远满帧渲染** —— 浏览器里标签页不聚焦会自动降频，壳子里不会，
   *
   * 低性能模式：帧率 20、渲染分辨率 1 倍、去掉自言自语和自主动作，
   * 只留眨眼 + 轻微摆动 + 视线；只有点她才会动。
   */
  const PERF = { low: false }

  function applyPerf() {
    if (app) {
      app.ticker.maxFPS = PERF.low ? 20 : 30
      const want = PERF.low ? 1 : Math.min(window.devicePixelRatio || 1, 1.5)
      try {
        if (app.renderer.resolution !== want) {
          const w = app.renderer.width
          const h = app.renderer.height
          app.renderer.resolution = want
          app.renderer.resize(w, h)
        }
      } catch (err) {}
    }
    try {
      document.body.classList.toggle('dshp-lowpower', PERF.low)
    } catch (err) {}
  }

  /** 壳子/设置页调它切档；返回当前档位方便确认 */
  function setLowPower(on) {
    PERF.low = !!on
    // 低性能档：待机幅度压到 35%（她还在动，只是更省电、更安静）
    try {
      syncIdleLevel()
    } catch (e) {}
    applyPerf()
    log('性能档：' + (PERF.low ? '低性能（少动、省电、20 帧）' : '标准（30 帧）'))
    return PERF.low
  }

  async function buildModel() {
    const layout = readLayout()

    app = new PIXI.Application({
      width: 8,
      height: 8,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      // 掩码要读画布像素，没有 preserveDrawingBuffer 的话读到的是被清空后的缓冲
      preserveDrawingBuffer: true,
      resolution: Math.min(window.devicePixelRatio || 1, PERF.low ? 1 : 1.5),
      powerPreference: 'low-power',
    })
    app.ticker.maxFPS = PERF.low ? 20 : 30
    applyPerf()
    ui.stage.appendChild(app.view)

    const { Live2DModel } = PIXI.live2d
    Live2DModel.registerTicker(PIXI.Ticker)

    model = await Live2DModel.from(BASE + '/model/dfyfish.model3.json', {
      autoInteract: false,
      autoUpdate: true,
      idleMotionGroup: 'idle',
    })
    model.eventMode = 'none'
    app.stage.addChild(model)

    const internal = model.internalModel
    coreModel = internal.coreModel

    // 参数范围表（实测生成，见 _research-data/生成参数表.mjs）。
    // 动作引擎靠它把每个参数夹进合法区间；拿不到就降级成「不夹取」继续跑。
    try {
      const rp = await fetch(BASE + '/model/rig-params.json').then((r) => r.json())
      DSHPetMotion.setRanges(rp.ranges || {})
      motion.ready = true
      const il = syncIdleLevel()
      log('参数范围表已加载：' + Object.keys(rp.ranges || {}).length + ' 个参数；动作库 ' + DSHPetMotion.listClips().length + ' 个；待机层 ' + (il.enabled ? '开（幅度 ' + il.level + '）' : '关'))
    } catch (e) {
      log('参数范围表加载失败，动作引擎降级（不做范围夹取）', e)
    }

    // rig 挂载点：model.update() 之前的最后一站
    internal.on('beforeModelUpdate', applyRig)

    // 关掉框架自带的眨眼，改用我们自己的 blinkTick（节奏更像人）
    try {
      if (internal.eyeBlink) internal.eyeBlink = undefined
    } catch (e) {}


    // 掩码在 postrender 里采：此刻 WebGL 缓冲刚画好，且模型的世界变换已生效。
    // 必须在测量之前注册——测量就是靠它把画面读出来算实体范围的。
    app.renderer.on('postrender', () => {
      if (mask.dirty && !mask.building) buildMask()
    })

    const box = await fitFromMeasurement()
    applyPosition(layout)
    restoreProps()
    // 待机底层状态：平常脸 + 拿板子待着
    setBase('neutral', IDLE_PROPS)

    document.addEventListener('visibilitychange', () => {
      if (!app) return
      if (document.hidden) app.ticker.stop()
      else app.ticker.start()
    })

    log(
      `模型原始尺寸 ${Math.round(internal.originalWidth)}×${Math.round(internal.originalHeight)}` +
        (box ? ` · 布局 ${box.w}×${box.h}（${box.mode}，缩放 ${box.scale}）` : ''),
    )
  }

  /**
   * 正在拖「大小」滑块。为 true 时 fitModel 不去改 --dshp-s/--dshp-ps——
   * 否则轨道会随着面板变宽而移动，变成「怎么拖都追不上」。
   */
  let sizingSize = false

  /**
   * 把面板夹回视口内。
   *
   * 左右展开的，于是右边那一截（包括关闭按钮和滑块的右半段）直接跑到屏幕外，
   * 点都点不到。这里量一下真实位置，用一个横向偏移把它推回来。
   */
  /**
   * 面板往哪边展开 —— **纯计算，不「量了再挪」**。
   *
   * 根因是旧写法：先把位移清零、量面板位置、再据此设位移，而位移本身带过渡动画，
   * 量到动画中间态就会一次算左一次算右，来回翻。
   * 现在只看一件事：桌宠在屏幕的左半边还是右半边 ——
   *   · 在左半边（左边是墙）→ 面板往**右**开
   *   · 在右半边（右边是墙）→ 面板往**左**开
   * 然后兜底夹进视口，保证整个面板（含右上角的 ×）都在屏幕里。
   */
  /**
   * 她脑袋在屏幕上的横坐标。
   * 根节点中心 ≠ 脑袋中心，所以这里用测量出来的「头部重心」换算成屏幕坐标。
   */
  function headScreenX() {
    const r = ui.root.getBoundingClientRect()
    try {
      const b = contentBox && contentBox.bands
      const head = b && b.head && b.head.center
      const view = b && b.full && b.full.center
      if (typeof head === 'number' && typeof view === 'number' && lastView && model) {
        const baseW = model.internalModel.width || model.internalModel.originalWidth || 0
        const dx = (head - view) * baseW * (lastView.scale || 0)
        if (Number.isFinite(dx) && Math.abs(dx) < r.width) return r.left + r.width / 2 + dx
      }
    } catch (e) {}
    return r.left + r.width / 2
  }

  /**
   * 摆放一个面板（气泡/菜单/钱包…）。
   *
   * 本机改动：**气泡改为跟随鼠标**，不再锚在她头顶。
   * 原因：头顶锚点在"只露半边"的极限位置会跑到屏幕外，气泡跟着出去、
   * 其余面板（菜单/钱包/简报）保持原来的"对准头顶"。
   */
  /**
   * 气泡专用摆放：视口坐标，锚在鼠标上方，四边都夹进屏幕内。
   *
   * 为什么单独一个函数：气泡是 fixed 定位、不参与 root 的坐标系，
   * 所以它不会反过来影响 placePanel 读到的 root 矩形 —— 从结构上断开反馈环。
   * 只有「出现」和「鼠标移动」两个时机调用，而且做了节流。
   */
  /**
   * 气泡摆放：**定位一次就钉住**，不跟鼠标。
   *
   * 锚在她自己身上（可见部分的中心），然后整体夹进屏幕 ——
   * 所以"下次更新时自动出现在不会被截断的位置"，之后就一动不动。
   * 只在三种时机重摆：① 内容更新后 ② 她移动/拖动结束后 ③ 窗口尺寸变化。
   * 绝不在 pointermove 里调它（之前那样做会变成"气泡粘着鼠标走"，很难受）。
   */
  let bubbleAnchor = null
  /**
   * 把「挂在她身上、fixed 定位」的小窗口摆进视口。
   *
   * 为什么抽出来（2026-10-17 收尾）：气泡和工具栏原来是两份几乎一样的实现 ——
   * pad / 视口 / root 矩形 / charInset / 「可见部分」中心 / 测量时绝不复位 /
   * 横向两边夹 —— 近百行里六成是重复的。这种重复最容易出「改了一处忘了另一处」，
   * 本项目就记过同型的坑（clampLeft 那条：四份硬编码夹取，只改了一处）。
   *
   * 唯一**故意不同**的地方是竖直方向的策略：
   *   · 气泡 prefer='above'：优先在她头顶，放不下就到下方，最后两边都夹；
   *   · 工具栏 prefer='below'：优先在她脚下，放不下就翻到上方，最后两边都夹。
   *   （原来工具栏只在「翻上去也不行」时才夹；现在统一成一律夹 —— 好处是她被拖到
   *    屏幕上方外面时，工具栏会贴住上边缘、仍然点得到，而不是整条跑到屏幕外。）
   *
   * @returns {null | { left, top, flipped, w, h, mw, mh }}
   *          left/top 已取整；mw/mh 是**测量值**（调用方要用它做尺寸缓存）。
   */
  function placeViewportAnchored(el, opts) {
    opts = opts || {}
    const pad = 10
    const vw = window.innerWidth
    const vh = window.innerHeight
    const r = ui.root.getBoundingClientRect()
    const ixc = charInset('x')
    const iyc = charInset('y')
    const bodyW = Math.max(20, r.width - ixc * 2)
    const bodyH = Math.max(20, r.height - iyc * 2)
    const bodyLeft = r.left + ixc
    const bodyTop = r.top + iyc
    const bodyBottom = bodyTop + bodyH

    // 量尺寸：**绝不先复位**。
    // 原来有一版写 el.style.left/top='0px' 再测量，而本函数会被 40ms 的 gazeTick 反复调用，
    // 于是任何时刻从外部读样式都可能撞上「0px」那一瞬 —— 表现是按钮/气泡闪到屏幕左上角。
    // left/top 只影响位置、不影响自身尺寸，本来就不需要复位。
    const b = el.getBoundingClientRect()
    const mw = b.width || 0
    const mh = b.height || 0
    const w = mw > 1 ? mw : (opts.fallbackW || 0)
    const h = mh > 1 ? mh : (opts.fallbackH || 0)
    if (!w || !h) return null

    // 水平：她**可见部分**的水平中心（不是容器中心，容器左右有空气），两边都夹进视口
    let ax = bodyLeft + bodyW / 2
    ax = Math.max(pad, Math.min(vw - pad, ax))
    let left = ax - w / 2
    left = Math.max(pad, Math.min(vw - w - pad, left))

    // 竖直：先按各自偏好那一侧放，放不下再翻边，最后兜底夹进视口
    const gap = opts.gap == null ? 8 : opts.gap
    let top
    let flipped = false
    if (opts.prefer === 'above') {
      top = bodyTop - h - gap
      if (top < pad) {
        top = bodyBottom + gap
        flipped = true
      }
    } else {
      top = bodyBottom + gap
      if (top + h > vh - pad) {
        const above = bodyTop - h - gap
        if (above >= pad) {
          top = above
          flipped = true
        }
      }
    }
    top = Math.max(pad, Math.min(vh - h - pad, top))

    return { left: Math.round(left), top: Math.round(top), flipped: flipped, w: w, h: h, mw: mw, mh: mh }
  }

  /** 气泡：优先在她头顶（尾尖朝下指向她），放不下就到下方。
   *  （bubbleAnchor 在 placeViewportAnchored 上面声明，两函数共用这一份去重状态） */
  function placeBubble() {
    const el = ui && ui.bubble && ui.bubble.el
    if (!el || !el.classList.contains('dshp-on')) return
    const at = placeViewportAnchored(el, { gap: 12, prefer: 'above' })
    if (!at) return
    // 去重：位置没变就不写（否则 clampPanels 每帧调一次、气泡会抖）。
    // ⚠️ 比的是**算出来的位置**而不是输入：气泡内容变高时 h 变、top 跟着变，
    // 这里自然就会重写 —— 所以以前那个「force 强制重摆」参数其实从来没用过，已删。
    if (bubbleAnchor && bubbleAnchor.left === at.left && bubbleAnchor.top === at.top) return
    bubbleAnchor = { left: at.left, top: at.top }
    el.style.left = at.left + 'px'
    el.style.top = at.top + 'px'
  }

  /**
   * 工具栏：锚在她**可见部分**下方居中，四边都夹进屏幕内。
   * 她下半身出屏时会被夹进屏幕、并翻到她的**上方**，始终点得到。
   */
  let dockLast = { x: -1, y: -1 }
  let dockW = 0
  let dockH = 0
  let dockFlipped = false
  function placeDock() {
    const el = ui && ui.dock
    if (!el) return
    // 尺寸缓存：工具栏刚出现/正在淡入时量到的可能是 0，用上一次的值兜底，
    // 否则会有一帧被摆到左上角。
    const at = placeViewportAnchored(el, { gap: 8, prefer: 'below', fallbackW: dockW || 200, fallbackH: dockH || 40 })
    if (!at) return
    if (at.mw > 1) dockW = at.mw
    if (at.mh > 1) dockH = at.mh
    if (dockLast.x === at.left && dockLast.y === at.top && dockFlipped === at.flipped) return
    dockLast = { x: at.left, y: at.top }
    dockFlipped = at.flipped
    el.style.left = at.left + 'px'
    el.style.top = at.top + 'px'
  }

  /**
   * 面板（菜单 / 输入框 / 钱包）的横向位移。
   *
   * ⚠️ 为什么它**没有**走 placeViewportAnchored（2026-10-17 收尾时特意看过）：
   *   两者是**两套定位机制**，不是重复代码：
   *     · 面板：写在 root 内部，基准是「以她的头居中」，靠 CSS 变量
   *       --dshp-shift / --dshp-shift-y 做**相对位移**，元素本身是 root 的子节点；
   *     · 气泡/工具栏：fixed 视口定位，直接写 left/top 的**绝对坐标**。
   *   硬把面板并进那套「绝对坐标」等于重写它的布局（还会被 root 的 transform/缩放影响），
   *   风险远大于省下的几十行。所以这里保留独立逻辑 —— 但两边共用 charInset / clamp 那套。
   */
  function placePanel(panel) {
    if (!panel) return
    const vw = window.innerWidth
    const pad = 10
    panel.style.setProperty('--dshp-shift', '0px')
    if (!panel.classList.contains('dshp-on')) return
    const w = panel.getBoundingClientRect().width || 0
    if (!w) return
    const r = ui.root.getBoundingClientRect()
    const anchor = headScreenX()
    // 面板基准是「以桌宠中心居中」（left:50% + translateX(-50%)），所以位移 = 锚点 - 根节点中心
    let shift = anchor - (r.left + r.width / 2)
    // 靠墙时往反方向挪，保证整个面板（含 × ）都在屏幕里
    const left = anchor + shift - w / 2
    if (left < pad) shift += pad - left
    else if (left + w > vw - pad) shift -= left + w - (vw - pad)
    panel.style.setProperty('--dshp-shift', Math.round(shift) + 'px')
    // 纵向兜底：上下都要夹。原来只处理了"顶部超出"，所以把她拖到屏幕下半部分时，
    // 提示：气泡挂在 root 的 bottom:100% 上，她的容器一旦探出屏幕，气泡就跟着跑出去，
    //      必须用这个位移把它拉回来才看得全。
    const pb = panel.getBoundingClientRect()
    let dy = 0
    if (pb.top < pad) dy = pad - pb.top
    else if (pb.bottom > window.innerHeight - pad) dy = window.innerHeight - pad - pb.bottom
    panel.style.setProperty('--dshp-shift-y', Math.round(dy) + 'px')
  }

  function clampPanels() {
    // 注意：**气泡和工具栏不走 placePanel**。它们是 fixed 视口定位、由各自的
    // placeBubble()/placeDock() 摆（那两个只依赖"她的位置 + 视口"，不会读到自己
    // 造成的位移），所以这里不再 placePanel 它们 —— 原来把气泡放在这里是错的：
    // placePanel 只在面板"已显示"时才动手，而气泡出现的路径根本不经过 clampPanels。
    placePanel(ui && ui.menu && ui.menu.el)
    placePanel(ui && ui.composer && ui.composer.el)
    placePanel(ui && ui.hud && ui.hud.el)
    placeBubble()
    placeDock()
  }

  function fitModel(explicitHeight) {
    if (!model || !app) return
    const im = model.internalModel
    // 只信 internalModel：Live2DModel 继承 PIXI Container，没有自己的 width 取值器
    const baseW = im.width || im.originalWidth || 1
    const baseH = im.height || im.originalHeight || 1
    const saved = readLayout()
    const wanted = clamp(Number(explicitHeight) || Number(saved.height) || CFG.height, 120, 900)
    // 用户明确要求：一直用「整张桌子」，不做上半身/只有头的取景。
    const mode = 'full'
    const frac = FIT_FRACTION[mode] || 1

    // 角色在画布里的实体范围（归一化）。没测出来就退回整个画布。
    const box = contentBox || { x0: 0, y0: 0, x1: 1, y1: 1, bands: null }
    const ch = Math.max(0.02, box.y1 - box.y0)
    const cw = Math.max(0.02, box.x1 - box.x0)

    // 原因是原来视窗高度**正好等于**实体高度、宽度又按固定宽高比算 ——
    // 横向超出（尾巴、头顶鲸）和纵向超出（举起来的道具、惊讶表情）就都被裁掉了。
    // 现在实体四周各留 PAD，窗口比实体大一圈，她才能完整显示。
    const PAD = 0.1
    const viewHModel = ch * frac * baseH * (1 + PAD * 2)
    // 宽度取「固定宽高比」和「实体宽度 + 余量」里更宽的那个
    const viewWModel = Math.max(viewHModel * VIEW_ASPECT, cw * baseW * (1 + PAD * 2))
    const centerXNorm = box.bands && box.bands[mode] ? box.bands[mode].center : (box.x0 + box.x1) / 2
    const centerXModel = centerXNorm * baseW

    // 缩放按**实体高度**算（不是视窗高度）：加了余量之后她的大小和以前一模一样，
    // 只是周围多出一圈空间。
    let scale = wanted / (ch * frac * baseH)
    const maxW = Math.max(240, window.innerWidth * (CFG.maxWidthRatio || 0.5))
    if (viewWModel * scale > maxW) scale = maxW / viewWModel

    const w = Math.max(40, Math.round(viewWModel * scale))
    const h = Math.max(40, Math.round(viewHModel * scale))

    model.scale.set(scale)
    // 锚点放到左上角：position 就等于「模型画布左上角在容器里的位置」，算起来最直观
    model.anchor.set(0, 0)
    app.renderer.resize(w, h)
    const padYModel = ch * frac * baseH * PAD
    model.position.set(
      -Math.round((centerXModel - viewWModel / 2) * scale),
      -Math.round((box.y0 * baseH - padYModel) * scale),
    )

    ui.stage.style.width = w + 'px'
    ui.stage.style.height = h + 'px'
    ui.root.style.width = w + 'px'
    ui.root.style.height = h + 'px'

    // —— 她在容器里的实际内边距（本机新增）——
    // 容器不是"正好裹住她"的：宽度按固定宽高比 VIEW_ASPECT 算、四周再各留 PAD=10%，
    // 于是她左右各有一圈空气。所有跟屏幕边界有关的计算（拖动夹取、贴边吸附）
    // 必须按**她的身体**而不是容器边缘来算，否则表现就是"离墙还有一大截就被顶住"
    // 以及"吸附之后离墙很远"。这两个值就是那圈空气的像素宽度。
    const __cwPad = cw * baseW * (1 + PAD * 2) * scale
    const __insetX = viewWModel * scale > __cwPad ? (w - __cwPad) / 2 : (w * PAD) / (1 + PAD * 2)
    const __insetY = (PAD * h) / (1 + PAD * 2)
    ui.root.style.setProperty('--dshp-inset-x', Math.round(__insetX) + 'px')
    ui.root.style.setProperty('--dshp-inset-y', Math.round(__insetY) + 'px')
    // 气泡/按钮/菜单跟着模型一起缩放，比例才不会走样
    // 例外：正在拖「大小」滑块时**冻住缩放**。否则每拖一格模型就变大一点、
    // 「滑动的时候很难受，必须点一下设置一个值，不能拖拽」就是这个反馈环。
    if (!sizingSize) {
      // —— UI 缩放解耦（本机调整）——
      // 原版 --dshp-s 直接等于 h / UI_BASE_HEIGHT，所以把模型拉大 → 气泡、按钮、
      // 字体全跟着一起变大，看着很挤。现在把「模型缩放」和「UI 缩放」拆开：
      //   · 默认：模型每翻一倍只带到 75%（h/180 的 0.75 次方）→ 模型大、字不会跟着爆
      //   · 阈值：超过 UI_SCALE_MAX 就不再放大（这样把模型调很大时字也不会变巨）
      //   · 可覆盖：~/.dsh/dsh-live2d-pet.json 里写 "uiScale": 1.0 就用固定值
      const autoUiScale = Math.pow(Math.max(h / UI_BASE_HEIGHT, 0.01), 0.75)
      const uiScale = clamp(Number(CFG.uiScale) > 0 ? Number(CFG.uiScale) : autoUiScale, 0.5, UI_SCALE_MAX)
      ui.root.style.setProperty('--dshp-s', uiScale.toFixed(3))
      // 面板自己一套缩放：夹在 0.85~1.15，缩太小就没法操作了
      ui.root.style.setProperty('--dshp-ps', clamp(autoUiScale, 0.85, 1.15).toFixed(3))
    }
    mask.dirty = true
    lastView = {
      w,
      h,
      mode,
      scale: Number(scale.toFixed(4)),
      content: {
        x0: +box.x0.toFixed(3),
        y0: +box.y0.toFixed(3),
        x1: +box.x1.toFixed(3),
        y1: +box.y1.toFixed(3),
      },
    }
    return lastView
  }

  /** 先量实体范围，再按它取景；量不出来就退回按整张画布取景。 */
  async function fitFromMeasurement() {
    try {
      const bbox = await measureContent()
      if (bbox && bbox.x1 - bbox.x0 > 0.05 && bbox.y1 - bbox.y0 > 0.05) {
        contentBox = bbox
      } else {
        console.warn('[鲸鱼娘] 实体范围测不出来，按整张画布取景')
      }
    } catch (err) {
      console.warn('[鲸鱼娘] 测量实体范围出错：', err && err.message)
    }
    return fitModel()
  }

  /**
   * 量一次「角色实体在画布里的范围」。
   *
   * 做法：先把模型按固定比例完整铺进一张参考画布（不裁剪），等一帧让 postrender 里的
   * 掩码采样跑完，从掩码里取非透明像素的外接框。因为这个测量是在「完整显示」状态下做的，
   * 得到的归一化比例与后续缩放无关，可以直接拿去算任何取景。
   *
   * 拿不到（隐藏标签页里 rAF 不触发、或者掩码生成失败）就返回 null，调用方退回整个画布。
   */
  async function measureContent() {
    const im = model.internalModel
    const baseW = im.width || im.originalWidth || 1
    const baseH = im.height || im.originalHeight || 1
    const REF = 420
    const s = REF / baseH
    const w = Math.max(16, Math.round(baseW * s))
    const h = REF

    model.scale.set(s)
    model.anchor.set(0, 0)
    app.renderer.resize(w, h)
    model.position.set(0, 0)
    ui.stage.style.width = w + 'px'
    ui.stage.style.height = h + 'px'
    mask.dirty = true
    mask.bbox = null

    const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()))
    const deadline = performance.now() + 3000
    while (performance.now() < deadline) {
      await nextFrame()
      if (mask.bbox && !mask.dirty) return Object.assign({}, mask.bbox, { bands: mask.bands })
    }
    return mask.bbox ? Object.assign({}, mask.bbox, { bands: mask.bands }) : null
  }

  /** 贴边的留白（视觉上「贴住」但不顶死） */
  const EDGE_GAP = 10
  /** 松手时离边多近就吸附 */
  const SNAP_DIST = 52

  /** 工具条在容器下面探出来的高度（贴底时要把这段算进去，否则按钮会被屏幕切掉） */
  function dockClearance() {
    const s = parseFloat((ui.root.style.getPropertyValue('--dshp-s') || '1').trim()) || 1
    return 34 * s
  }

  /** 平滑移动到位（拖动是瞬时的，吸附要有个「吸过去」的过程） */
  function glideTo(left, top) {
    const el = ui.root
    el.style.transition = 'left .22s cubic-bezier(.2,.9,.3,1), top .22s cubic-bezier(.2,.9,.3,1)'
    el.style.left = left + 'px'
    el.style.top = top + 'px'
    el.style.right = 'auto'
    el.style.bottom = 'auto'
    setTimeout(() => {
      el.style.transition = ''
      clampPanels()
    }, 260)
  }

  /**
   * 松手时的贴边吸附。
   * 靠近左下/右下角 → 直接记成「角落模式」（窗口大小变了也跟着走）；
   * 只贴某一边 → 固定那一轴，另一轴保持自由。
   */
  /**
   * 松手时的贴边吸附。
   *
   * 但只吸附右边或左边的墙壁」——所以这里**只看左右**：
   *   · 靠左墙 / 靠右墙 → 吸过去，竖直位置保持你松手的那个高度
   *   · 离两边都远 → 就停在原地（竖直方向永远不吸）
   * 竖直方向只做一件事：别让底下的三个按钮被屏幕切掉（软性夹一下，不是吸附）。
   */
  function snapOnRelease() {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const r = ui.root.getBoundingClientRect()
    const nearL = r.left < SNAP_DIST
    const nearR = vw - r.right < SNAP_DIST
    if (!nearL && !nearR) return false // 底部不再吸附

    const edge = nearR ? 'right' : 'left'
    const y = clampY(r.top, r.height, vh)
    // 吸附位置也要扣掉她的内边距，否则"贴住墙"之后她的身体离墙还差那一圈空气。
    // 左边：容器 left 要比 EDGE_GAP 再往左一个 inset，她的身体才正好落在 EDGE_GAP。
    // 右边：容器右缘 = 屏宽 - EDGE_GAP - inset。
    const ixs = charInset('x')
    const left = edge === 'left' ? EDGE_GAP - ixs : vw - r.width - EDGE_GAP - ixs
    glideTo(left, y)
    // 记成「贴哪一边 + 竖直位置」，窗口大小变了也还贴着那一边、高低不动
    saveLayout({ x: null, y: null, corner: null, edge, edgeY: Math.round(y) })
    ui.root.dataset.edge = edge
    return true
  }

  /**
   * 允许露在外面的比例（本机调整）。
   * 原版夹得很死：上面 -20、下面还要给工具栏留位置，所以半边身体一靠近边界就被顶回来，
   * 跟直播里「人只露半边」的观感不符。现在放开到「随便超出边界、只留一小截在身上」，
   * 纯粹是防止拖到完全看不见、再也找不回来（那种情况只能靠托盘「回到右下角」救）。
   */
  // ⚠️ 这两个值原来定的 56px 太小了：她身体实测只有 112×180，
  //    留 56px = 只露 31%，拖到边界就基本看不见了，而且这个位置会存进
  //    localStorage，重载后照样恢复 → 就"再也找不回来"。
  //    现在按「至少露身体的一半」算，并且下限再兜一层（身体很小时不至于全露）。
  const MIN_VISIBLE_FRAC = 0.5
  const MIN_VISIBLE_X = 120
  const MIN_VISIBLE_Y = 120
  /** 实际生效的「至少露多少」：
   *  水平恢复成「至少露 120px」——允许左右移出屏幕（2026-10-18 主人要求）；
   *  菜单/dock 的定位已经修好，会跟着可见部分夹进屏幕，不会因为出屏就失联。
   *  竖直仍保留 120px 上限。
   */
  function minVisible(axis, bodySize) {
    return Math.max(24, Math.min(MIN_VISIBLE_FRAC * bodySize, axis === 'x' ? MIN_VISIBLE_X : MIN_VISIBLE_Y))
  }

  /**
   * 水平的唯一权威夹取（本机新增）。
   *
   * 为什么要有它：原来「-40 / innerWidth - 60」这套硬编码夹取散落在**四处**
   * （拖动、惯性、resize、吸附），我改边界时只改了拖动那处，剩下三处还在用旧范围，
   * 于是松开手的瞬间被惯性/resize 又夹回 -40 —— 表现就是「左右拖不动」和「被甩飞」。
   * 现在全部走这一个函数，不会再漏。
   * 允许任意部分出屏，只保证她身上还露 minVisible() 那一段。
   */
  function clampLeft(left, bodyW) {
    const ixs = charInset('x')
    const mv = minVisible('x', bodyW)
    const lo = mv - bodyW - ixs
    const hi = window.innerWidth - mv - ixs
    if (hi <= lo) return left
    return clamp(left, lo, hi)
  }

  /** 读她在容器里的内边距（fitModel 里算好、写成 CSS 变量） */
  function charInset(axis) {
    const v = ui && ui.root && ui.root.style.getPropertyValue(axis === 'x' ? '--dshp-inset-x' : '--dshp-inset-y')
    const n = parseFloat((v || '0').trim())
    return Number.isFinite(n) ? n : 0
  }
  function charSize() {
    const r = ui.root.getBoundingClientRect()
    return {
      w: Math.max(20, r.width - charInset('x') * 2),
      h: Math.max(20, r.height - charInset('y') * 2),
    }
  }

  /**
   * 竖直位置：按**她的身体**（不是容器）来夹，允许大幅超出屏幕、只留一小截可抓。
   * 为什么必须扣掉内边距：容器上下各有一圈空气，用容器高度算会让"露在外面的部分"
   * 比预期小一大截，看着就像被提前顶住了。
   */
  function clampY(top, height, vh) {
    const H = vh || window.innerHeight
    const containerH = height || (ui.root.getBoundingClientRect().height || 0)
    const iy = charInset('y')
    const bodyH = Math.max(20, containerH - iy * 2)
    // top 是**容器**上缘；她的身体在容器里上下各内缩 iy。
    //   · 头顶在 top + iy。想让她从上方拖出去到只剩 MIN_VISIBLE_Y：
    //       top + iy >= -(bodyH - MIN_VISIBLE_Y)  →  top >= -(bodyH - MIN_VISIBLE_Y) - iy
    //   · 脚底在 top + iy + bodyH。想让她从下方拖出去到只剩 MIN_VISIBLE_Y：
    //       top + iy + bodyH <= H + bodyH - MIN_VISIBLE_Y  →  top <= H - iy - MIN_VISIBLE_Y
    // ⚠️ 上一版把上下界的符号写反了（写成 MIN_VISIBLE_Y - iy，是个正数），
    //    结果她连上边界都出不去 —— 就是"整条都出不去"那个反馈。
    const mv = minVisible('y', bodyH)
    const minTop = mv - bodyH - iy
    const maxTop = H - mv - iy
    if (maxTop <= minTop) return top
    return clamp(top, minTop, maxTop)
  }

  function applyEdge(edge, y) {
    const root = ui.root
    // 外观档位：跟随系统（默认）/ 浅色 / 深色 —— 手动选过就按本地的来
    try {
      const th = readLayout().theme
      if (th === 'light' || th === 'dark') root.dataset.dshpTheme = th
    } catch (err) {}

    // 恢复存档时也走 clampY：万一 localStorage 里存了一个把她放到屏幕外的
    // edgeY（历史存档、或改了 MIN_VISIBLE 之后旧值不再合法），这里会把她拉回可见范围。
    // 没有这层兜底的话，坏位置会被反复恢复 → "再也找不回来"。
    const yy = clampY(Number(y) || 0, root.getBoundingClientRect().height || 0, window.innerHeight)
    root.style.left = edge === 'left' ? EDGE_GAP - charInset('x') + 'px' : 'auto'
    root.style.right = edge === 'right' ? EDGE_GAP + 'px' : 'auto'
    root.style.top = Math.round(yy) + 'px'
    root.style.bottom = 'auto'
    root.dataset.edge = edge
  }

  /**
   * 摆放位置。三种存档：
   *   · edge + edgeY —— 贴左/右墙，竖直位置自由（**现在吸附后存的就是这种**）
   *   · x + y        —— 完全自由摆放
   *   · corner       —— 老存档（左下/右下那种），读到时自动迁移成 edge 形式，竖直位置按角落换算
   */
  function applyPosition(layout) {
    const root = ui.root
    const vh = window.innerHeight
    const h = root.getBoundingClientRect().height || 0
    const dock = dockClearance()

    if (layout.edge === 'left' || layout.edge === 'right') {
      applyEdge(layout.edge, layout.edgeY != null ? layout.edgeY : vh - h - dock - EDGE_GAP)
      return
    }
    if (layout.x != null && layout.y != null) {
      // 自由摆放也要夹水平：老存档可能只剩一条缝，重载后要能拉回可见范围
      const bodyW = Math.max(20, root.getBoundingClientRect().width - charInset('x') * 2)
      root.style.left = clampLeft(layout.x, bodyW) + 'px'
      root.style.top = clampY(layout.y, h, vh) + 'px'
      root.style.right = 'auto'
      root.style.bottom = 'auto'
      root.dataset.edge = ''
      return
    }
    // 老存档 / 首次启动：按角落算一次，然后就地存成 edge 形式（下次就是新的了）
    const corner = layout.corner || CFG.corner || 'br'
    const edge = corner === 'bl' || corner === 'tl' ? 'left' : 'right'
    const y = corner === 'tr' || corner === 'tl' ? 64 : vh - h - dock - EDGE_GAP
    applyEdge(edge, y)
    saveLayout({ corner: null, edge, edgeY: Math.round(clampY(y, h, vh)) })
  }

  // ——————————————————————————————————————————————————————————————
  // 六、命中掩码：让点击穿透空气
  // ——————————————————————————————————————————————————————————————

  const mask = { grid: null, w: 0, h: 0, dirty: true, building: false, lastBuild: 0, bbox: null, bands: null }

  /**
   * 一条竖带里「实体质量的横向重心与范围」。
   *
   * 为什么不直接用整条带的外接框：这个模型是一整张书桌场景，桌子比人宽得多。
   * 按整条带的外接框取景，镜头会被人两边的东西（桌沿、鼠标垫）拽偏，
   * 结果就是人在画面左边、右边一大片空。按「质量」算重心就稳得多。
   */
  function bandWindow(grid, W, y0, y1) {
    const cols = new Float32Array(W)
    let max = 0
    for (let y = y0; y < y1; y++) {
      const row = y * W
      for (let x = 0; x < W; x++) {
        if (grid[row + x]) {
          cols[x]++
          if (cols[x] > max) max = cols[x]
        }
      }
    }
    if (max <= 0) return null
    const thresh = max * 0.25
    let mass = 0
    let wsum = 0
    for (let x = 0; x < W; x++) {
      // 只统计「有实体分量」的列，零星空隙不会把重心拽走
      if (cols[x] >= thresh) {
        mass += cols[x]
        wsum += cols[x] * x
      }
    }
    if (mass <= 0) return null
    const center = wsum / mass
    return { center: center / W }
  }

  /** 为每个取景档算出各自的横向重心（归一化）。 */
  function computeBands(grid, W, H, bbox) {
    const y0 = Math.max(0, Math.floor(bbox.y0 * H))
    const y1 = Math.min(H, Math.ceil(bbox.y1 * H))
    const ch = Math.max(1, y1 - y0)
    const out = {}
    for (const [mode, frac] of Object.entries(FIT_FRACTION)) {
      const by1 = Math.min(y1, Math.max(y0 + 1, Math.round(y0 + ch * frac)))
      const win = bandWindow(grid, W, y0, by1)
      out[mode] = win || { center: (bbox.x0 + bbox.x1) / 2 }
    }
    return out
  }

  function buildMask() {
    if (!app || !model || mask.building) return
    if (performance.now() - mask.lastBuild < 300) return
    mask.building = true
    try {
      const src = app.view
      if (!src || !src.width || !src.height) throw new Error('画布还没准备好')
      const W = 128
      const H = Math.max(24, Math.round((W * src.height) / src.width))
      const c = document.createElement('canvas')
      c.width = W
      c.height = H
      const g = c.getContext('2d', { willReadFrequently: true })
      g.clearRect(0, 0, W, H)
      g.drawImage(src, 0, 0, W, H)
      const data = g.getImageData(0, 0, W, H).data
      const grid = new Uint8Array(W * H)
      let filled = 0
      let minx = W
      let miny = H
      let maxx = -1
      let maxy = -1
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x
          if (data[i * 4 + 3] > 26) {
            grid[i] = 1
            filled++
            if (x < minx) minx = x
            if (x > maxx) maxx = x
            if (y < miny) miny = y
            if (y > maxy) maxy = y
          }
        }
      }
      const coverage = filled / (W * H)
      // 全空说明这一帧没画上东西，别把掩码覆盖成「处处不可点」
      if (coverage < 0.005) throw new Error('画面是空的')
      mask.grid = grid
      mask.w = W
      mask.h = H
      mask.bbox =
        maxx >= 0
          ? { x0: minx / W, y0: miny / H, x1: (maxx + 1) / W, y1: (maxy + 1) / H }
          : null
      mask.bands = mask.bbox ? computeBands(grid, W, H, mask.bbox) : null
      mask.dirty = false
      mask.lastBuild = performance.now()
      log(
        `命中掩码 ${W}×${H}，覆盖率 ${(coverage * 100).toFixed(1)}%` +
          (mask.bbox
            ? `，实体范围 x ${mask.bbox.x0.toFixed(2)}–${mask.bbox.x1.toFixed(2)} / y ${mask.bbox.y0.toFixed(2)}–${mask.bbox.y1.toFixed(2)}`
            : ''),
      )
    } catch (err) {
      // 拿不到掩码就退回整个矩形可点，功能不至于丢
      mask.grid = null
      mask.dirty = false
      mask.lastBuild = performance.now()
      console.warn('[鲸鱼娘] 掩码生成失败，退回包围盒判定：', err && err.message)
    } finally {
      mask.building = false
    }
  }

  /** 客户端坐标是否落在鲸鱼娘身上（而不是桌宠框里的空气）。 */
  function hitTest(clientX, clientY) {
    const stage = app && app.view && app.view.parentElement
    if (!stage) return false
    const r = stage.getBoundingClientRect()
    if (!r.width || !r.height) return false
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return false
    if (!mask.grid) return true
    const mx = Math.floor(((clientX - r.left) / r.width) * mask.w)
    const my = Math.floor(((clientY - r.top) / r.height) * mask.h)
    if (mx < 0 || my < 0 || mx >= mask.w || my >= mask.h) return false
    return mask.grid[my * mask.w + mx] === 1
  }

  /** 命中窗用：她身体的紧包围盒（视口坐标）。没有掩码时退回 stage 矩形 */
  function hitBounds() {
    try {
      const stage = app && app.view && app.view.parentElement
      if (!stage || !ui || !ui.root) return null
      if (ui.root.classList.contains('dshp-hidden')) return null
      const r = stage.getBoundingClientRect()
      if (!r.width || !r.height) return null
      const b = mask.bbox
      if (!b) return { x: r.left, y: r.top, w: r.width, h: r.height }
      return {
        x: r.left + r.width * b.x0,
        y: r.top + r.height * b.y0,
        w: Math.max(1, r.width * (b.x1 - b.x0)),
        h: Math.max(1, r.height * (b.y1 - b.y0)),
      }
    } catch (e) { return null }
  }

  /**
   * 命中窗用：把 alpha 掩码粗化成一组矩形（相对 hitBounds 的左上角）。
   * 只用于 setShape，让透明区域继续穿透；没有掩码时返回 null，主进程退回整块 bbox。
   */
  function hitRects() {
    try {
      if (!mask.grid || !mask.bbox) return null
      const hb = hitBounds()
      if (!hb) return null
      const GW = 32, GH = 32
      const nw = mask.bbox.x1 - mask.bbox.x0
      const nh = mask.bbox.y1 - mask.bbox.y0
      const bw = hb.w
      const bh = hb.h
      if (!(nw > 0) || !(nh > 0) || !(bw > 0) || !(bh > 0)) return null
      const cells = []
      for (let gy = 0; gy < GH; gy++) {
        const cy0 = Math.floor(mask.bbox.y0 * mask.h + (gy / GH) * nh * mask.h)
        const cy1 = Math.max(cy0 + 1, Math.floor(mask.bbox.y0 * mask.h + ((gy + 1) / GH) * nh * mask.h))
        const row = []
        for (let gx = 0; gx < GW; gx++) {
          const cx0 = Math.floor(mask.bbox.x0 * mask.w + (gx / GW) * nw * mask.w)
          const cx1 = Math.max(cx0 + 1, Math.floor(mask.bbox.x0 * mask.w + ((gx + 1) / GW) * nw * mask.w))
          let hit = 0, total = 0
          for (let y = cy0; y < cy1; y += 2) {
            for (let x = cx0; x < cx1; x += 2) {
              total++
              if (mask.grid[y * mask.w + x]) hit++
            }
          }
          row.push(total > 0 && hit / total >= 0.1)
        }
        cells.push(row)
      }
      const rects = []
      let active = new Map()
      for (let gy = 0; gy < GH; gy++) {
        const runs = []
        let start = -1
        for (let gx = 0; gx <= GW; gx++) {
          const on = gx < GW && cells[gy][gx]
          if (on && start < 0) start = gx
          if (!on && start >= 0) { runs.push([start, gx]); start = -1 }
        }
        const next = new Map()
        for (const [a, b] of runs) {
          const key = a + ':' + b
          const prev = active.get(key)
          if (prev) {
            prev.h += bh / GH
            next.set(key, prev)
          } else {
            const r = { x: (a / GW) * bw, y: (gy / GH) * bh, w: ((b - a) / GW) * bw, h: bh / GH }
            rects.push(r)
            next.set(key, r)
          }
        }
        active = next
      }
      if (rects.length > 500) return null
      const pad = 1.5
      return rects.map((r) => ({
        x: Math.max(0, r.x - pad),
        y: Math.max(0, r.y - pad),
        w: r.w + pad * 2,
        h: r.h + pad * 2,
      }))
    } catch (e) {
      return null
    }
  }

  /**
   * 鼠标是不是在「她下方那排按钮」上（含一点外扩的容错）。
   * 这三个键不在模型掩码里，只靠 hitTest 会让它们一出现就消失、根本点不着。
   */
  function overDock(clientX, clientY) {
    try {
      if (!ui || !ui.dock) return false
      const r = ui.dock.getBoundingClientRect()
      if (!r.width || !r.height) return false
      const pad = 12
      return (
        clientX >= r.left - pad &&
        clientX <= r.right + pad &&
        clientY >= r.top - pad &&
        clientY <= r.bottom + pad
      )
    } catch (err) {
      return false
    }
  }

  /**
   * 鼠标是不是压在她的面板上（菜单 / 输入框 / HUD）。
   *
   * 为什么单独算：面板是 HTML，不在模型掩码里，但它常常压在她身体附近。
   * 不排除的话，睡着时把鼠标移到设置面板上，就会被「身边甩动」当成叫醒手势。
   */
  function overPanels(clientX, clientY) {
    try {
      const items = [
        [ui.menu && ui.menu.el, () => ui.menu.el.classList.contains('dshp-on')],
        [ui.composer && ui.composer.el, () => ui.composer.el.classList.contains('dshp-on')],
        [ui.hud && ui.hud.el, () => !!hud.open],
        // 详细频率面板是模态：mask 铺满全屏，打开时所有位置都算 UI（不触发 hover/甩动唤醒）
        [ui.tuning && ui.tuning.el, () => !!ui.tuning],
        [ui.tuning && ui.tuning.mask, () => !!ui.tuning],
      ]
      for (const [el, shown] of items) {
        if (!el || !shown()) continue
        const r = el.getBoundingClientRect()
        if (!r.width || !r.height) continue
        if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return true
      }
    } catch (err) {}
    return false
  }

  /**
   * 「她身边」的判定：用掩码量出来的**实体包围盒**外扩 pad 像素，
   * 而不是整个 canvas 矩形（canvas 里一大半是空气，拿它当「附近」会让正常移动也被当成甩动）。
   * 掩码还没建好时返回 false，调用方自己退回旧矩形。
   */
  function nearBody(clientX, clientY, pad) {
    try {
      const stage = app && app.view && app.view.parentElement
      const r = stage && stage.getBoundingClientRect()
      if (!r || !r.width || !r.height || !mask.bbox) return false
      const bb = mask.bbox
      const p = Number(pad) || 0
      const l = r.left + bb.x0 * r.width - p
      const t = r.top + bb.y0 * r.height - p
      const rt = r.left + bb.x1 * r.width + p
      const bt = r.top + bb.y1 * r.height + p
      return clientX >= l && clientX <= rt && clientY >= t && clientY <= bt
    } catch (err) {
      return false
    }
  }

  // ——————————————————————————————————————————————————————————————
  // 六点五、视线控制器
  // ——————————————————————————————————————————————————————————————

  /**
   * 为什么要有这一层：最初的做法是「鼠标一动就把头指过去」，结果头摆得像螺旋桨——
   * 又急、幅度又大、还一直死盯着你。现在拆成四件事：
   *
   *   1. 只有光标进到桌宠附近（GAZE_RADIUS）才跟随；离远了它自己发呆、看别处、想事情
   *   2. 幅度只取 58%（GAZE_GAIN），而且是「越近跟得越实、越远越松」，不做 100% 硬绑
   *   3. 目标怎么跳都不管，实际值一律限速逼近（GAZE_MAX_RATE）——头再急也只能慢慢转
   *   4. 互动/大动作期间 detach：人在做动作的时候眼睛不会死盯着你
   *
   * 关掉「视线跟随」之后它不会愣住——下面是同一套自主动作在跑。
   */
  /**
   * 默认值（都能在设置里实时调，见 CFG.gaze*）：
   *   radius = 0   整屏跟随——鼠标在哪儿它看哪儿，不再只跟附近
   *   gain   = 0.78 跟随幅度；调小就「不太理你」，调大就更黏
   *   rate   = 1.6  每秒最多变化多少；调小更慵懒，调大更机灵
   */
  function gazeCfg() {
    return {
      radius: CFG.gazeRadius === undefined ? 0 : Number(CFG.gazeRadius),
      // 原作者在 VTube 配置里：眼珠平滑 0（零延迟）、头部 31/32、歪头 85（很软）。
      // 我们这边是整套一起平滑，所以先把默认值调快，让『眼珠优先跟手』的感觉出来；
      // 严格的分组延迟需要动 rig 层，见 README 的 TODO。滑块仍然可以实时微调。
      gain: CFG.gazeGain === undefined ? 0.9 : Number(CFG.gazeGain),
      rate: CFG.gazeRate === undefined ? 3.2 : Number(CFG.gazeRate),
    }
  }

  const gaze = {
    x: 0,
    y: 0,
    tx: 0,
    ty: 0,
    mode: 'idle',
    detachUntil: 0,
    pointer: { x: 0, y: 0, seen: false },
    nextDrift: 0,
    driftX: 0,
    driftY: 0,
    lastTick: 0,
    /** 视线纵向偏置：读资料时压低，等于「低头看本子」，走的是同一条限速通道 */
    biasY: 0,
    biasTarget: 0,
  }

  /**
   * 爱心粒子。模型自带左右两组爱心（爱心左 j1–j32 / 爱心右 j33–j57），
   * 而 `love` 和 `ParamCheek73` 属于「通用动画(循环)」组——置 1 就会一直循环冒爱心，
   * 所以摸头时用它们做持续 2 秒的爱心爆发，再配脸红和爱心眼。
   */
  function heartBurst(ms) {
    rig.burst = { love: 1, heartbeat: 1, until: performance.now() + (ms || 2200) }
    rig.dirty = true
  }

  /** 做动作时暂时别盯人（对应 clawd-on-desk 那套「反应动画期间脱离眼球追踪」）。 */
  function gazeDetach(ms) {
    gaze.detachUntil = performance.now() + (ms || 1500)
  }

  function gazeTick() {
    if (!model || !ui) return
    // 工具栏 + 气泡的"稳定伴侣"。
    // 这两个元素是固定定位（视口坐标），位置必须由 JS 摆；原来它们只挂在
    // pointermove / 零散的 clampPanels 上，鼠标不动时就没机会更新。
    // gazeTick 是 40ms 一跳、与鼠标无关的心跳，放这里最稳 ——
    // 于是她会动的同时，按钮和气泡也跟着一起动（两者都有内部去重，
    // 位置没变就直接 return，代价只是几次读矩形）。
    if (ui.dock) {
      try {
        placeDock()
      } catch (e) {}
    }
    if (ui.bubble && ui.bubble.visible) {
      try {
        placeBubble()
      } catch (e) {}
    }
    const now = performance.now()
    const dt = Math.min(0.25, (now - (gaze.lastTick || now)) / 1000)
    gaze.lastTick = now
    const detached = now < gaze.detachUntil

    let wantX = 0
    let wantY = 0
    let following = false

    const g = gazeCfg()
    // 指针超过 2 秒没有更新（桌面版壳子停止喂数据 / 鼠标离开跟踪源）→ 视为脱离，
    const asleep = !!idle.sleep
    const pointerFresh = gaze.pointer.seen && now - (gaze.pointer.at || 0) < 2000
    if (!detached && !asleep && CFG.lookAtCursor && pointerFresh) {
      const r = ui.stage.getBoundingClientRect()
      if (r.width) {
        const dx = gaze.pointer.x - (r.left + r.width / 2)
        const dy = gaze.pointer.y - (r.top + r.height / 2)
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (g.radius <= 0 || dist < g.radius) {
          following = true
          // 参照距离按屏幕算，这样鼠标在屏幕任何角落都落在有效范围内
          const refX = Math.max(r.width, window.innerWidth * 0.5)
          const refY = Math.max(r.height, window.innerHeight * 0.5)
          wantX = clamp(dx / refX, -1, 1) * g.gain
          wantY = clamp(-dy / refY, -1, 1) * g.gain
        }
      }
    }

    if (following) {
      gaze.mode = 'follow'
    } else {
      // 没人管它：自己看东看西、想事情；睡着时**不动**，视线回正（不跟鼠标、也不游移）
      gaze.mode = asleep ? 'sleep' : detached ? 'detach' : 'idle'
      // 所以游移幅度从 ±0.5 收到 ±0.11（基本朝前），间隔也缩短，不再一盯好几秒。
      if (!asleep && now > gaze.nextDrift) {
        gaze.nextDrift = now + 1100 + Math.random() * 1800
        // 幅度 × CFG.gazeDrift（设置面板的「视线游移」）：上游把游移压得很小
        // 现在默认 1 = 上游原值，由预设/滑块决定要不要放大。
        const driftK = (() => {
          const d = Number(CFG.gazeDrift)
          return isFinite(d) && d >= 0 ? d : 1
        })()
        gaze.driftX = (Math.random() * 2 - 1) * (detached ? 0.07 : 0.11) * driftK
        gaze.driftY = (Math.random() * 2 - 1) * (detached ? 0.05 : 0.09) * driftK
      }
      const t = now / 1000
      // 明确往「正脸」收：游移只作为一点点生气，而不是主基调；睡着时目标就是 0
      wantX = asleep ? 0 : gaze.driftX * 0.85 + Math.sin(t * 0.37) * 0.045
      wantY = asleep ? 0 : gaze.driftY * 0.85 + Math.cos(t * 0.29) * 0.035
    }

    // 低头看资料：只是给视线加一个纵向偏置，仍然受同一个限速器约束，
    // 所以不会突然「咔」一下低头。
    gaze.biasY += (gaze.biasTarget - gaze.biasY) * clamp(dt * 1.6, 0, 1)
    // 低头偏置是**改变方向**，不是放大幅度：
    // 合成方向后统一乘 gain，这样总幅度永远不超过 gain（否则低头会额外顶出去 0.3）。
    if (gaze.biasY !== 0 && following) {
      let dx2 = wantX / g.gain
      let dy2 = wantY / g.gain + gaze.biasY
      const mag = Math.sqrt(dx2 * dx2 + dy2 * dy2)
      if (mag > 1) {
        dx2 /= mag
        dy2 /= mag
      }
      wantX = dx2 * g.gain
      wantY = dy2 * g.gain
    } else if (!following) {
      wantY += gaze.biasY
    }
    wantX = clamp(wantX, -1, 1)
    wantY = clamp(wantY, -1, 1)

    gaze.tx += (wantX - gaze.tx) * clamp(dt * 3.0, 0, 1)
    gaze.ty += (wantY - gaze.ty) * clamp(dt * 3.0, 0, 1)
    const maxStep = g.rate * dt
    // 记录真实步长速率（单位/秒）。测试用它验证限速器，比在外部按采样间隔
    // 估算靠谱得多——页面卡顿会让 tick 变长，采样法会误判成「超速」。
    gaze.stepRate = Math.max(gaze.stepRate || 0, maxStep / Math.max(dt, 1e-6))
    gaze.x = clamp(gaze.x + clamp(gaze.tx - gaze.x, -maxStep, maxStep), -1, 1)
    gaze.y = clamp(gaze.y + clamp(gaze.ty - gaze.y, -maxStep, maxStep), -1, 1)

    try {
      // 注意：只调 focus() 是限不住的——框架自己还会把 x 朝 targetX 缓动一次，
      // 那一步比我们的限速更快。所以当前值和目标值一起写，限速器才是唯一权威。
      const fc = model.internalModel.focusController
      fc.targetX = gaze.x
      fc.targetY = gaze.y
      fc.x = gaze.x
      fc.y = gaze.y
      // 回读一下：写入被谁覆盖的话，这里能第一时间看出来
      gaze.fcX = fc.x
      gaze.fcErr = ''
    } catch (err) {
      gaze.fcErr = String((err && err.message) || err)
    }

    // 互动感知（S2）：挂在同一个 40ms 心跳上，不新增定时器。
    try {
      sensorTick(now)
    } catch (e) {}

    // 成套小戏（e）：同样挂在这个 40ms 心跳上。
    try {
      scriptTick(now)
    } catch (e) {}
  }

  // ——————————————————————————————————————————————————————————————
  // 六点六、动作表现：Q 弹 / 惯性回弹 / 爱心 / 工作轮播
  // ——————————————————————————————————————————————————————————————

  /** Q 弹抖动：点击时整个身子软软地弹一下（Web Animations，不碰模型参数）。 */
  function qBounce(power) {
    const el = ui && ui.stage
    if (!el || !el.animate) return
    const k = power == null ? 1 : power
    el.style.transformOrigin = '50% 100%'
    el.animate(
      [
        { transform: 'scale(1,1)' },
        { transform: `scale(${1 + 0.1 * k},${1 - 0.12 * k})` },
        { transform: `scale(${1 - 0.045 * k},${1 + 0.055 * k})` },
        { transform: 'scale(1,1)' },
      ],
      { duration: 460, easing: 'cubic-bezier(.34,1.56,.64,1)' },
    )
  }

  /** 拖拽松手后的惯性回弹：速度衰减着滑一段，再落定。 */
  function dragInertia(vx, vy) {
    const el = ui && ui.root
    if (!el) return
    let px = parseFloat(el.style.left) || 0
    let py = parseFloat(el.style.top) || 0
    let sx = vx
    let sy = vy
    const h = el.getBoundingClientRect().height
    const step = () => {
      sx *= 0.85
      sy *= 0.85
      px = clampLeft(px + sx, Math.max(20, el.getBoundingClientRect().width - charInset('x') * 2))
      py = clampY(py + sy, h, window.innerHeight)
      el.style.left = px + 'px'
      el.style.top = py + 'px'
      if (Math.abs(sx) > 0.4 || Math.abs(sy) > 0.4) requestAnimationFrame(step)
      else saveLayout({ x: Math.round(px), y: Math.round(py), edge: null, edgeY: null, corner: null })
    }
    requestAnimationFrame(step)
  }

  /**
   * 工作轮播。规格要求「变出小电脑、敲键盘、轮播 认真/摸鱼/思考」。
   * 所以干活期间不是钉在一张脸上，而是按节奏换：敲键盘 → 认真看 → 偷偷摸鱼 → 思考。
   */
  // 干活时的两个状态：认真看资料 / 思考。切换很慢（见 workTick 的间隔），
  const WORK_CYCLE = [
    { mood: 'reading', say: 'reading' },
    { mood: 'thinking', say: 'thinking' },
  ]
  const work = { i: 0, nextAt: 0, active: false }
  /** 小设备是否已经掏出来了（查资料时），用完要收回去 */
  const device = { out: false }

  function startWork() {
    if (work.active) return
    work.active = true
    work.i = 0
    work.nextAt = 0
    // 用模型自带的开盖动作把设备掏出来；道具由 WORK_PROPS 决定
    playMotion('openLid')
    gazeDetach(1200)
  }

  function endWork() {
    work.active = false
    gaze.biasTarget = 0
    putDeviceAway()
  }

  /** 把小设备收回去，回到常驻待机动作。 */
  function putDeviceAway() {
    if (!device.out) return
    device.out = false
    // 收起小设备，回到默认姿势（手里的笔也就回来了）
    stopMotion()
  }

  function workTick() {
    if (!work.active) return
    const now = performance.now()
    if (now < work.nextAt) return
    work.nextAt = now + 9000 + Math.random() * 5000 // 慢切换
    const stepDef = WORK_CYCLE[work.i % WORK_CYCLE.length]
    work.i++
    // 轮播只改底层状态，不产生会赖着不走的一次性反应
    setBase(stepDef.mood, WORK_PROPS)
    // 正在思考/看资料：把话说到气泡正文里，别只更新脚注（那样看着像在摸鱼）
    if (!rig.talking && ui.bubble.visible) {
      ui.bubble.show(pickFresh(SAY[stepDef.say], 'work-' + stepDef.say), {
        name: 'DS 鲸鱼娘',
        busy: true,
        sticky: true,
      })
      ui.bubble.note(stepDef.mood === 'reading' ? '看资料' : '思考中')
    }
  }

  // ——————————————————————————————————————————————————————————————
  // 七、UI
  // ——————————————————————————————————————————————————————————————

  function buildUI() {
    const root = $('div', 'dshp-root')
    root.id = 'dsh-live2d-pet'

    const stage = $('div', 'dshp-stage')

    const bubbleEl = $('div', 'dshp-bubble')
    const head = $('div', 'dshp-head')
    const dot = $('span', 'dshp-dot')
    const headText = $('span', null, 'DS 鲸鱼娘')
    head.append(dot, headText)
    const body = $('div', 'dshp-body')
    const foot = $('div', 'dshp-foot')
    bubbleEl.append(head, body, foot)

    const dock = $('div', 'dshp-dock')
    const talkBtn = $('button', 'dshp-btn dshp-primary', '💬 说话')
    const menuBtn = $('button', 'dshp-btn', '⋯')
    const hideBtn = $('button', 'dshp-btn', '–')
    hideBtn.title = '收起（桌面版会缩成贴边小球）'
    const openBtn = $('button', 'dshp-btn dshp-icon', '↗')
    openBtn.title = '打开 DeepSeek Harness 界面'
    dock.append(talkBtn, menuBtn, hideBtn, openBtn)

    const composer = $('div', 'dshp-panel dshp-composer')
    const ta = $('textarea')
    ta.placeholder = '跟 DSH 说点什么…（Enter 发送 / Shift+Enter 换行）'
    const crow = $('div', 'dshp-row')
    const sendBtn = $('button', 'dshp-btn dshp-primary', '发送')
    const cancelBtn = $('button', 'dshp-btn', '打断')
    crow.append($('span', 'dshp-grow'), cancelBtn, sendBtn)
    const chint = $('div', 'dshp-hint', '发出去的话进入当前会话，回复会显示在气泡里。')
    composer.append(ta, crow, chint)
    addCloseButton(composer)

    const menu = $('div', 'dshp-panel dshp-menu')
    const tabs = $('div', 'dshp-tabs')
    const panes = $('div')
    panes.classList.add('dshp-panes')
    menu.append(tabs, panes)
    addCloseButton(menu)

    const tab = $('div', 'dshp-tab', '🐋 鲸鱼娘')

    // 右键弹出的 HUD（余额 / 本轮消耗 / 峰谷计价）
    const hud = $('div', 'dshp-hud')
    const hudHead = $('div', 'dshp-hud-head')
    const hudTitle = $('span', null, '鲸鱼娘 · 钱包')
    const hudDot = $('span', 'dshp-hud-tag dshp-valley', '谷')
    hudHead.append(hudTitle, hudDot)
    const hudMoney = $('div', 'dshp-hud-money')
    const hudMoneyNum = $('b', null, '—')
    const hudMoneyCur = $('span', null, 'CNY')
    hudMoney.append(hudMoneyNum, hudMoneyCur)
    const hudRowToday = $('div', 'dshp-hud-row')
    const hudTodayV = $('span', 'dshp-hud-v', '—')
    hudRowToday.append($('span', 'dshp-hud-k', '今日已用'), hudTodayV)
    const hudRowTurn = $('div', 'dshp-hud-row')
    const hudTurnV = $('span', 'dshp-hud-v', '—')
    hudRowTurn.append($('span', 'dshp-hud-k', '本轮消耗'), hudTurnV)
    const hudRowCd = $('div', 'dshp-hud-row')
    const hudCdV = $('span', 'dshp-hud-v', '—')
    hudRowCd.append($('span', 'dshp-hud-k', '距切换'), hudCdV)
    const hudFoot = $('div', 'dshp-hud-foot', '')
    hud.append(
      hudHead, hudMoney,
      $('div', 'dshp-hud-sep'),
      hudRowTurn, hudRowToday, hudRowCd,
      hudFoot,
    )
    addCloseButton(hud, () => closeHud())

    root.append(stage, bubbleEl, dock, composer, menu, hud)
    document.body.append(root, tab)

    const u = {
      root,
      stage,
      tab,
      bubble: makeBubble(bubbleEl, body, foot, dot, headText),
      composer: { el: composer, ta, send: sendBtn, cancel: cancelBtn },
      menu: { el: menu, tabs, panes, focused: null },
      hud: {
        el: hud,
        badge: hudDot,
        money: hudMoneyNum,
        currency: hudMoneyCur,
        today: hudTodayV,
        turn: hudTurnV,
        countdown: hudCdV,
        foot: hudFoot,
        title: hudTitle,
      },
      dock,
      /** 详细频率面板（打开时 { mask, el, onKey }） */
      tuning: null,
    }
    bindComposer(u)
    bindMenu(u)
    // 这里不能调 setHidden()——此刻 ui 还没赋值（ui = buildUI() 才刚返回），
    // setHidden 里读 ui.root 会直接抛异常，表现为「隐藏过一次之后，
    // 以后每次打开都起不来」。所以就地写类名。
    if (readLayout().hidden) {
      root.classList.add('dshp-hidden')
      document.body.classList.add('dshp-pet-hidden')
    }
    return u
  }

  function makeBubble(el, body, foot, dot, headText) {
    let timer = null
    let streaming = false
    let buffer = ''
    // 工作气泡占用中 → 互动气泡让位（见下面 show 里的优先级守卫）
    let workHold = false
    const api = {
      el,
      show(text, opts) {
        opts = opts || {}
        // （戳一下、待机台词这些带 ttl 的）安静等着，不许把汇报顶掉。
        // 正常模式下 workHold 为 false，互动照旧。
        const isWork = !!(opts.work || opts.sticky || opts.stream || opts.busy)
        if (!isWork && workHold && el.classList.contains('dshp-on')) return
        if (isWork) workHold = true
        if (opts.name) headText.textContent = opts.name
        if (opts.stream) {
          if (!streaming) {
            buffer = ''
            streaming = true
          }
          buffer += text
          body.textContent = buffer.length > 4000 ? '…' + buffer.slice(-4000) : buffer
        } else {
          streaming = false
          buffer = String(text == null ? '' : text)
          body.textContent = buffer
        }
        body.scrollTop = body.scrollHeight
        foot.textContent = opts.foot || ''
        // 内容变了 → 尺寸可能变 → 重新摆一次（此时它还没显示，量不到尺寸，
        // 所以真正的摆放放在下面 dshp-on 之后）
        dot.classList.toggle('dshp-pulse', !!opts.busy)
        el.classList.add('dshp-on')
        // 出现时立刻按当前鼠标位置摆一次 —— 原来这里**没有定位**，
        // 而 placePanel 只对已 dshp-on 的面板生效，于是气泡一直停在初始位置、
        // 靠边时尾部被屏幕切掉。
        try {
          placeBubble()
        } catch (e) {}
        if (timer) clearTimeout(timer)
        const ttl = opts.sticky ? 0 : opts.ttl != null ? opts.ttl : CFG.bubbleTtlMs
        if (ttl > 0) timer = setTimeout(() => api.hide(), ttl)
      },
      note(text) {
        foot.textContent = text
      },
      hide() {
        if (timer) clearTimeout(timer)
        timer = null
        streaming = false
        workHold = false
        buffer = ''
        el.classList.remove('dshp-on')
      },
      get visible() {
        return el.classList.contains('dshp-on')
      },
    }
    return api
  }

  // ——————————————————————————————————————————————————————————————
  // 八点四、工作简报
  //
  // 平时也用不上**，所以整套 UI 全部删掉了：信封按钮、未读角标、简报面板、
  // 对应 CSS，以及 clampPanels() 里的两条 placePanel。
  //
  // 但 pushReport 是**对外接口**（DSHPet.report 和 /dsh-pet/control 的 report 字段），
  // 直接删掉会让调用方静默失败，所以保留成一个薄壳，改走**气泡**——
  // 气泡本来就是本插件正常工作、看得见的通知通道。
  // ——————————————————————————————————————————————————————————————
  function pushReport(title, body) {
    try {
      const text = String(body == null ? '' : body).trim()
      if (!text) return
      const t = String(title || '工作简报')
      // work: true —— 走气泡的「工作优先」守卫，不会被随机互动台词顶掉
      ui.bubble.show(t + '：' + text, { name: 'DS 鲸鱼娘', ttl: 9000, work: true })
    } catch (err) {}
  }

  // ——————————————————————————————————————————————————————————————
  // 八、鼠标交互：悬停 / 拖动 / 戳 / 右键 / 双击
  // ——————————————————————————————————————————————————————————————

  function wireInteractions() {
    const root = ui.root
    let dragging = false
    let dragMoved = false
    let start = null
    let leaveTimer = null
    const drag = { vx: 0, vy: 0 }

    document.addEventListener(
      'pointermove',
      (e) => {
        idle.lastInputAt = performance.now()
        if (!dragging) {
          // 原因：原来只认 hitTest（她模型身上），而工具栏在她**下方**、不在模型掩码里。
          // 现在把「鼠标在工具栏矩形内」也算作悬停，并且离开后多留 900ms。
          const on = hitTest(e.clientX, e.clientY) || overDock(e.clientX, e.clientY)
          if (on) {
            root.classList.add('dshp-hover')
            if (leaveTimer) {
              clearTimeout(leaveTimer)
              leaveTimer = null
            }
          } else if (!leaveTimer && !root.classList.contains('dshp-open')) {
            leaveTimer = setTimeout(() => {
              leaveTimer = null
              if (!root.classList.contains('dshp-open')) root.classList.remove('dshp-hover')
            }, 900)
          }
        } else if (start) {
          const dx = e.clientX - start.mx
          const dy = e.clientY - start.my
          if (!dragMoved && Math.abs(dx) + Math.abs(dy) > 4) {
            dragMoved = true
            if (idle.sleep) wakeUp('drag') // 拽她 = 叫醒
          }
          if (dragMoved) {
            // —— 直接响应每个 pointermove（本机改回）——
            // 曾经试过 rAF 节流，结果更糟：慢速拖动时 pointermove 隔 ~30ms 才来一次，
            // 被 rAF 对齐到帧边界后变成 33Hz 的台阶，观感就是"一跳一跳"。
            // 真正该优化的是**每个事件里同步读样式**（会强制回流），那个已经在
            // pointerdown 时把 insetX / 容器尺寸缓存好了（见 start），
            // 所以这里只剩纯算术 + 两次样式写，直接同步执行反而最跟手。
            applyDragDelta(e.clientX - start.mx, e.clientY - start.my)
          }
        }
        // 只记录坐标，真正的跟随在 gazeTick 里限速执行——
        // 直接在 pointermove 里写 focusController 就是「螺旋桨」的成因。
        gaze.pointer.x = e.clientX
        gaze.pointer.y = e.clientY
        gaze.pointer.seen = true
        gaze.pointer.at = performance.now()   // 记时间：脱离跟随太久就回正脸
        // 工具栏跟着她走（内部有去重；隐藏时开销极小）
        if (ui.root.classList.contains('dshp-hover') || ui.root.classList.contains('dshp-open')) {
          try {
            placeDock()
          } catch (err) {}
        }
        // 气泡**不跟鼠标**：只在它出现时/她移动后摆一次（见 placeBubble 注释）
      },
      { passive: true },
    )

    /** 把拖动位移真正落到 DOM 上（原 pointermove 里那段，现在由 rAF 调用） */
    function applyDragDelta(dx, dy) {
      if (!start) return
      const nh = root.getBoundingClientRect().height
      const nw = root.getBoundingClientRect().width
      // 用 pointerdown 时缓存的值，避免每帧 getBoundingClientRect + getComputedStyle
      // 反复触发强制回流（和 Pixi 渲染抢时间 → 慢速拖动时一跳一跳）
      // 水平按**她的身体**算（不是容器）：容器左右各有一圈空气，
      // 用容器宽度夹会"离墙还有一大截就被顶住"。放开到任意部分出屏，
      // 只保证她身上还留 minVisible() 那段可抓。
      const bodyW = Math.max(20, (start.w || nw) - (start.insetX != null ? start.insetX : charInset('x')) * 2)
      const nx = clampLeft(start.left + dx, bodyW)
      // 竖直：同样对她本人算，允许任意部分出界
      const ny = clampY(start.top + dy, nh, window.innerHeight)
      // 身体随拖动方向摇摆：记录本帧位移供倾斜使用
      drag.vx = nx - (parseFloat(root.style.left) || nx)
      drag.vy = ny - (parseFloat(root.style.top) || ny)
      root.style.left = nx + 'px'
      root.style.top = ny + 'px'
      root.style.right = 'auto'
      root.style.bottom = 'auto'
    }

    document.addEventListener(
      'pointerdown',
      (e) => {
        idle.lastInputAt = performance.now()
        if (e.button !== 0) return
        // 详细面板是模态：它盖在她身上时，点击/拖滑杆不能再被「拖她」的 capture 吃掉
        // （否则滑块拖不动、按钮点不动，面板关不掉 —— 2026-10-17 实测 bug）
        if (ui.tuning) return
        if (!hitTest(e.clientX, e.clientY)) return
        // 点在鲸鱼娘身上：吃掉这次点击，别让下面的 DSH 界面也响应
        e.stopPropagation()
        e.preventDefault()
        dragging = true
        dragMoved = false
        delete root.dataset.edge // 一拖就离开墙，别再显示「贴着左边」
        const r = root.getBoundingClientRect()
        // 缓存拖动期间不变的量（内边距 / 容器尺寸），供 applyDragDelta 每帧复用
        start = {
          mx: e.clientX,
          my: e.clientY,
          left: r.left,
          top: r.top,
          w: r.width,
          h: r.height,
          insetX: charInset('x'),
        }
      },
      true,
    )

    document.addEventListener(
      'pointerup',
      (e) => {
        if (!dragging) return
        dragging = false
        if (dragMoved) {
          // —— 本机调整：去掉自动吸附 + 去掉松手惯性 ——
          // 原来这里是 `if (!snapOnRelease()) dragInertia(drag.vx, drag.vy)`，两个都去掉：
          //   ② 惯性：drag.vx 是**一帧的位移**（拖快时上百 px），松手后被当成初速度
          //      直接加到位置上，于是一下子"被甩飞"（实测 l 从 142 直接跳到 -40）。
          // 现在：松手就停在鼠标放开的位置，完全跟手。
          const r0 = root.getBoundingClientRect()
          saveLayout({
            x: Math.round(parseFloat(root.style.left) || r0.left),
            y: Math.round(parseFloat(root.style.top) || r0.top),
            edge: null,
            edgeY: null,
            corner: null,
          })
          ui.root.dataset.edge = ''
          drag.vx = 0
          drag.vy = 0
        } else if (e.shiftKey) {
          // —— Shift + 左键 = 互动演示（本机新增）——
          // 为什么要 Shift：普通左键点她已经有「摸头/戳」的语义（poke 的连击分级），
          //   直接改成演示会跟它抢；加修饰键既不误触，也不用改 poke 的任何逻辑。
          // 为什么放在这个分支：只有「按下时命中了她的 alpha 掩码、且没拖动」才算，
          //   所以点空气、拖窗口都不会触发。
          closePanels()
          qBounce(1)
          startSensorDemo()
        } else {
          poke(e.clientX, e.clientY)
        }
        start = null
      },
      true,
    )

    document.addEventListener('pointercancel', () => {
      dragging = false
      start = null
    })

    document.addEventListener(
      'contextmenu',
      (e) => {
        if (!hitTest(e.clientX, e.clientY)) return
        e.preventDefault()
        e.stopPropagation()
        // （设置还在工具栏的 ⋯ 里，没有丢）
        if (hud.open) closeHud()
        else openHud({ flash: true, refresh: true })
      },
      true,
    )

    document.addEventListener(
      'dblclick',
      (e) => {
        // 双击仍然算一次戳她（第一下 click 已经触发过了），这里只吃掉默认行为。
        if (!hitTest(e.clientX, e.clientY)) return
        e.preventDefault()
      },
      true,
    )

    window.addEventListener('resize', () => {
      fitModel()
      const layout = readLayout()
      // 贴着左/右墙的：重新贴住那一侧（竖直位置不变，只夹进可见范围）
      if (layout.edge === 'left' || layout.edge === 'right') {
        applyPosition(layout)
      } else if (root.style.left && root.style.left !== 'auto') {
        root.style.left =
          clampLeft(parseFloat(root.style.left) || 0, Math.max(20, root.getBoundingClientRect().width - charInset('x') * 2)) + 'px'
        root.style.top = clampY(parseFloat(root.style.top) || 0, root.getBoundingClientRect().height, window.innerHeight) + 'px'
      }
      clampPanels()
    })

    window.addEventListener('keydown', (e) => {
      idle.lastInputAt = performance.now()
      if (e.key !== 'Escape') return
      if (hud.open) {
        e.stopPropagation()
        closeHud()
        return
      }
      if (!ui.root.classList.contains('dshp-open')) return
      e.stopPropagation()
      closePanels()
    })

    // 睡着时点菜单里的表情/动作：先走过场，再把这次点击放行。
    // 为什么在捕获阶段拦：按钮自己的 click 会立刻 act()/playClip，把过场顶掉。
    // 只拦 .dshp-chip（表情/口型/动作），设置页的滑块和关闭按钮不拦。
    ui.menu.el.addEventListener(
      'click',
      (e) => {
        if (!idle.sleep) return
        const chip = e.target && e.target.closest ? e.target.closest('.dshp-chip') : null
        if (!chip) return
        e.stopPropagation()
        e.preventDefault()
        wakeUp('menu')
        setTimeout(() => {
          if (idle.sleep) return
          try {
            chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
          } catch (err) {}
        }, 560)
      },
      true,
    )

    ui.tab.addEventListener('click', () => setHidden(false))

    // 面板内点击不要穿透到下面的界面
    for (const el of [ui.composer.el, ui.menu.el, ui.hud.el, ui.dock]) {
      el.addEventListener('pointerdown', (e) => e.stopPropagation())
    }

    ui.hud.el.addEventListener('pointerenter', () => {
      hud.hover = true
      hud.hideAt = 0
    })
    ui.hud.el.addEventListener('pointerleave', () => {
      hud.hover = false
    })
    // 点 HUD 之外的任何地方就收起来（跟菜单一个规矩）
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!hud.open) return
        if (e.button !== 0) return // 右键不在这里处理，交给 contextmenu 做「再按一次收起」
        const t = e.target
        if (t && (t === ui.hud.el || ui.hud.el.contains(t))) return
        closeHud()
      },
      true,
    )

    // 点面板以外任何地方（含 DSH 界面、甚至桌宠自己身上）都收起面板
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!ui.root.classList.contains('dshp-open')) return
        const t = e.target
        if (t && (t === ui.root || ui.root.contains(t))) return
        if (t && ui.menu.el.contains(t)) return
        if (t && ui.composer.el.contains(t)) return
        closePanels()
      },
      true,
    )
  }

  /**
   * 戳她。
   *
   * 之前的问题：身体被戳走的是「晕晕」这种不对味的脸（用户说「别闹应该是可爱地生气」），
   * 而且反应池太窄。现在按人设来——傲娇嘴甜、嘴上嫌弃、其实很开心；
   * 另外加了连击（短时间戳很多下会炸毛）和「摸头/戳腰」分区。
   */
  const pokeState = { times: [], softAt: 0, angerAt: 0 }
  /** 诊断：最近一次戳（命中窗/点击测试用；不参与逻辑） */
  let lastPokeInfo = null

  /**
   *
   * 旧代码的判定是「和上一次点击间隔 < 1.8 秒就累加」，于是每 1.5 秒点一下，
   * 点到第三下照样炸毛，正常逗她玩也会被凶。
   *
   * 现在改成真正的**速率**判定：看 2.6 秒里点了几下、平均间隔多少。
   *   · 慢悠悠地戳（平均间隔 > 420ms，也就是慢于 2.4 下/秒）→ 永远只是可爱反应；
   *   · 快到 2.4 下/秒以上，才「被戳痒了」撒娇抗议（ticklish），仍然不是生气；
   *   · 只有手速党（3.8 下/秒以上、窗口内至少 7 下）才真炸毛，而且炸毛后有
   */
  const POKE_TIER = {
    window: 2600, // 统计窗口（毫秒）
    softCount: 4, // 窗口内至少 4 下
    softGap: 420, // 且平均间隔 ≤ 420ms → 痒得抗议（≈2.4 下/秒）
    hardCount: 7, // 窗口内至少 7 下
    hardGap: 260, // 且平均间隔 ≤ 260ms → 真炸毛（≈3.8 下/秒）
    softCool: 1500, // 撒娇抗议之间的最小间隔，免得刷屏
    angerCool: 6000, // 炸毛之后的冷静期
  }

  /**
   * 记一次点击，并把滑出窗口的旧记录丢掉。
   * 时间戳是滑动窗口，所以慢慢点的话旧记录会自己过期，永远攒不到炸毛。
   */
  function pokeRecord(now) {
    const t = pokeState.times
    t.push(now)
    if (t.length > 60) t.splice(0, t.length - 60)
    pokePrune(now)
  }

  function pokePrune(now) {
    const t = pokeState.times
    while (t.length && now - t[0] > POKE_TIER.window) t.shift()
  }

  /** 纯函数：由「几下 / 平均间隔 / 距上次炸毛多久」判断档位。测试也用它。 */
  function tierOf(count, gap, sinceAnger) {
    const T = POKE_TIER
    const rapid = count >= T.softCount && gap <= T.softGap
    const furious = rapid && count >= T.hardCount && gap <= T.hardGap && sinceAnger > T.angerCool
    return { count, gap: gap === Infinity ? null : Math.round(gap), rapid, furious }
  }

  /** 现在的手速处在哪一档。只读，不改记录（诊断接口也调它）。 */
  function pokeTier(now) {
    const at = now || performance.now()
    pokePrune(at)
    const t = pokeState.times
    const count = t.length
    const gap = count >= 2 ? (t[count - 1] - t[0]) / (count - 1) : Infinity
    return tierOf(count, gap, at - pokeState.angerAt)
  }

  /**
   * 纯计算版：给一串「相邻两次点击的间隔」（毫秒），算出落哪一档。
   * 测试专门用它证明「正常速度点一万下也不会生气」。
   */
  function pokeTierForGaps(gaps) {
    const T = POKE_TIER
    const times = []
    let t = 0
    times.push(t)
    for (const g of gaps) {
      t += g
      times.push(t)
    }
    let count = 0
    let sum = 0
    for (let i = times.length - 1; i >= 0; i--) {
      if (t - times[i] > T.window) break
      count++
    }
    const from = times.length - count
    sum = count >= 2 ? t - times[from] : 0
    const gap = count >= 2 ? sum / (count - 1) : Infinity
    return tierOf(count, gap, Infinity)
  }

  /**
   * 点击互动表。
   *
   *   · **每个特效配它自己那套台词**，台词贴人设（傲娇嘴甜、贪吃白米、不能被叫胖）
   *   · 一次点击最多 1~2 个效果，绝不叠一堆
   *   · 连着点不重复（pickFresh 记着上一次），所以点十下能看到十种不同反应
   *   · 已踢掉：吹泡泡糖、大锤砸头、猫爪摆手、呆眼、圈圈眼
   */
  /** 干活时被点的互动池：还是傲娇那套，但带一点「人家在忙啦」。 */
  const POKE_BUSY = [
    { mood: 'pout', w: 1.4, lines: ['别闹啦，人家在忙', '等一下下嘛', '（嘴上嫌弃，手上没停）', '手拿开啦，正忙着呢', '（一边躲一边继续敲）'] },
    { mood: 'grumpy', w: 0.4, lines: ['主人！人家正在忙', '再戳就做不完了哦', '（气鼓鼓地继续干活）'] },
    { mood: 'shy', w: 1.2, lines: ['唔…等我弄完再说', '（被戳得晃了一下，又低头看本子）', '（耳朵红了，但没抬头）'] },
    { mood: 'happy', w: 1.2, lines: ['知道啦知道啦', '（抬头笑一下，又埋头干活）', '在在在，人家听着呢'] },
    { mood: 'tongue', w: 1, lines: ['忙着呢，不理你', '略，等会儿再说', '（扭头继续干活）'] },
    { mood: 'alert', w: 0.6, lines: ['！（笔掉了）', '（慌忙扶住本子）', '吓人家一跳！'] },
    { mood: 'confused', w: 0.6, lines: ['嗯？主人有什么事吗', '（从本子上抬眼看你）'] },
  ]

  /**
   * 摸头池。只有「被叫胖」那一条是真生气的脸，而且权重压到 0.4——
   */
  const POKE_HEAD = [
    {
      mood: 'shy',
      w: 1.6,
      fx: 'heart',
      lines: ['不要突然摸头啦……再摸一下也不是不行。', '唔…头发要乱了啦', '（脸红）就、就一下哦', '哼，本鲸才没有很享受', '（尾巴尖偷偷晃了一下）'],
    },
    {
      mood: 'happy',
      w: 1.4,
      fx: null,
      lines: ['嘿嘿～主人', '嗯？叫人家吗', '在的在的', '摸摸头也不错嘛', '（眯着眼睛蹭了一下）', '主人今天好闲呀'],
    },
    {
      mood: 'love',
      w: 1,
      fx: 'heart',
      lines: ['最喜欢主人了', '（冒爱心）', '今天也最喜欢主人', '（踮脚）还要！', '要是再来碗白饭就更完美了'],
    },
    {
      mood: 'pout',
      w: 1,
      fx: null,
      lines: ['哼，就这一次哦', '才、才没有很开心', '别以为人家好哄', '（嘴上嫌弃，头却没躲）', '手、手洗了吗'],
    },
    {
      mood: 'excited',
      w: 1,
      fx: null,
      lines: ['主人主人！', '（眼睛发亮）', '怎么啦怎么啦', '是要给人家白饭吗！'],
    },
    {
      mood: 'tongue',
      w: 0.8,
      fx: null,
      lines: ['略略略', '就不理你', '（吐舌头）', '摸头要收费的，一碗白饭'],
    },
    {
      mood: 'smug',
      w: 0.8,
      fx: null,
      lines: ['（眯眼）主人手法还不错嘛', '再左边一点…对，就是那里', '哼，本鲸的头是不能乱摸的'],
    },
    {
      mood: 'confused',
      w: 0.7,
      fx: null,
      lines: ['唔？摸头有什么好处吗', '（歪头）今天怎么这么殷勤', '无事献殷勤…是不是有事求人家'],
    },
    {
      mood: 'sleepy',
      w: 0.4,
      fx: null,
      lines: ['唔…困……', '（被摸得眼睛都闭上了）', '再摸就睡着了哦'],
    },
    {
      mood: 'grumpy',
      w: 0.4,
      fx: null,
      lines: ['你再说一遍？！人家这是可爱，不是胖！', '本鲸是丰腴，不是胖'],
    },
  ]

  /** 戳身子池：全是可爱反应，没有生气的脸——生气只留给「手速党」。 */
  const POKE_BODY = [
    {
      mood: 'pout',
      w: 1.4,
      fx: null,
      lines: ['喂！别戳人家啦', '喂喂，人家也是有尊严的', '再戳人家要咬人了哦', '（拍开你的手）'],
    },
    {
      mood: 'playful',
      w: 1.4,
      fx: null,
      lines: ['好痒…哈哈哈', '住手啦主人', '别闹别闹', '（扭来扭去躲）', '哈哈哈哈哈不行了'],
    },
    {
      mood: 'tongue',
      w: 1,
      fx: null,
      lines: ['略略略', '戳不到戳不到', '（灵活地闪开）'],
    },
    {
      mood: 'shy',
      w: 1,
      fx: null,
      lines: ['（缩成一团）', '唔…别戳那里', '（捂住脸）'],
    },
    {
      mood: 'confused',
      w: 1,
      fx: null,
      lines: ['诶？', '（歪头）干嘛呀', '主人你今天很闲嘛', '（一脸不解）'],
    },
    {
      mood: 'playful',
      w: 1.2,
      fx: null,
      lines: ['（用本子挡了一下）', '（抱着本子躲开）', '不给戳', '（拿本子当盾牌）'],
    },
    {
      mood: 'happy',
      w: 1.2,
      fx: null,
      lines: ['（被戳得晃了一下）', '嘻嘻', '（笑得肩膀一抖一抖）'],
    },
    {
      mood: 'alert',
      w: 0.6,
      fx: null,
      lines: ['！（猛地一抖）', '呀！吓死人家了', '（整个人弹了一下）'],
    },
    {
      mood: 'smug',
      w: 0.8,
      fx: null,
      lines: ['戳够了没呀', '（双手叉腰）就这点力气？', '本鲸可是很结实的'],
    },
    {
      mood: 'sweat',
      w: 0.5,
      fx: null,
      lines: ['（手忙脚乱地护住本子）', '别、别戳了，本子要掉了', '（冷汗）'],
    },
    {
      mood: 'gloomy',
      w: 0.4,
      fx: null,
      lines: ['（幽怨地看着你）', '……人家记住了', '（角落里长蘑菇）'],
    },
    {
      mood: 'pout',
      w: 0.6,
      fx: null,
      lines: ['别戳啦，人家只想要白饭', '（护住并不存在的碗）', '戳一下换一粒米，成交吗'],
    },
  ]

  function poke(clientX, clientY) {
    abortIdleScript()
    if (ui.root.classList.contains('dshp-hidden')) return
    lastPokeInfo = { at: performance.now(), x: clientX, y: clientY }
    // 睡着时戳她 = 叫醒：走「圈圈眼 + 害羞」过场，不播平常那套戳戳台词
    if (idle.sleep) {
      closePanels()
      qBounce(1)
      wakeUp('poke')
      return
    }

    // —— 干活时点她：也互动，但**不动底层状态** ——
    // 反应是一次性的（两秒左右），过期后自动回到「正在做的那件事」，
    // 所以既有了互动，又不会把工作状态搞乱。
    if (agent.status !== 'idle') {
      closePanels()
      qBounce(1)
      // 「点的时候她会看」：干活时被戳就抬头看鼠标（低头看本子的姿势也让开）
      gazeDetach(1800)
      gaze.biasTarget = 0
      const busyHit = pickFresh(POKE_BUSY, 'busy')
      act({
        mood: busyHit.mood,
        line: pickFresh(busyHit.lines, 'busy-line-' + busyHit.mood),
        ms: 2200,
      })
      return
    }

    const now = performance.now()
    pokeRecord(now)
    const tier = pokeTier(now)

    closePanels()
    qBounce(tier.furious ? 1.35 : tier.rapid ? 1.15 : 1)
    gazeDetach(2200)

    // —— 真炸毛：只有手速党才见得到，而且一次只出一条 ——
    if (tier.furious) {
      pokeState.angerAt = now
      // 别每次都同一张脸：生气/警觉/嘟嘴里挑一个，台词也从扩过的池子里抽
      const face = pick(['grumpy', 'grumpy', 'alert', 'pout'])
      act({ mood: face, props: IDLE_PROPS, line: pickFresh(SAY.many, 'many'), ms: 2600 })
      return
    }

    // —— 快但没到炸毛：被戳痒了，可爱地抗议，绝不跳进生气 ——
    // 撒娇也有最小间隔，免得连点变成刷屏；间隔内的点击继续走下面的普通反应，
    // 所以「手快」的体验是「她一直在躲」，而不是「她一直生气」。
    if (tier.rapid && now - pokeState.softAt > POKE_TIER.softCool) {
      pokeState.softAt = now
      act({
        mood: pick(['pout', 'shy', 'tongue', 'alert']),
        props: IDLE_PROPS,
        line: pickFresh(SAY.ticklish, 'ticklish'),
        ms: 2400,
      })
      return
    }

    // 原作者把「鲸鱼喷水」这个动画绑在**左键点她**上（按键表：LeftMouseButton
    // → 喷水.motion3.json）。所以戳她的时候偶尔真的喷一下水——照人家的设计来。
    if (Math.random() < 0.12) {
      playAction('splash')
      return
    }

    const r = ui.stage.getBoundingClientRect()
    const head = (clientY - r.top) / Math.max(1, r.height) < 0.45
    const hit = pickFresh(head ? POKE_HEAD : POKE_BODY, head ? 'head' : 'body')
    const ms = 2600

    // 一次点击 = 一个表情 + 一句台词 +（至多）一个粒子特效。
    // act() 会先把上一次整个停掉，所以点一下永远是干净的单次反应。
    act({
      mood: hit.mood,
      line: pickFresh(hit.lines, 'line-' + hit.mood),
      heart: hit.fx === 'heart',
      ms,
    })
  }

  // ——————————————————————————————————————————————————————————————
  // 八点五、菜单项「点了会怎样」
  // ——————————————————————————————————————————————————————————————

  /** 表情参数名 → 菜单里那个中文按钮名（同一个表情可能对应好几个情绪）。 */
  function faceLabel(expr) {
    if (!expr) return '平常脸'
    for (const [key, e] of Object.entries(MOOD_FACE)) {
      if (e === expr && FACE_ACT[key]) return expr
    }
    return expr
  }

  function menuStatusLine() {
    const parts = []
    parts.push(rig.user.face ? `${rig.user.face}（手动）` : faceLabel(rig.face))
    const userProps = Array.from(rig.userProps)
      .map((e) => Object.values(ALL_TOGGLES).find((d) => d.expr === e))
      .filter(Boolean)
      .map((d) => d.label)
    const baseProps = rig.base.props
      .map((e) => Object.values(ALL_TOGGLES).find((d) => d.expr === e))
      .filter(Boolean)
      .map((d) => d.label)
    if (userProps.length) parts.push('自己戴的：' + userProps.join('、'))
    if (baseProps.length) parts.push('常态：' + baseProps.join(' + '))
    if (device.out) parts.push('手机已掏出')
    const st = agent.status === 'idle' ? '待机' : '干活中'
    return `${st} · 现在：` + parts.join(' · ')
  }

  /**
   * 演一个菜单项。
   *
   * 而是**一句话 + 一个表情 +（最多）一个小道具**，而且：
   *   · act() 先把上一次整个收掉 → 永远只有一件在演，不叠
   *   · 给一个到点就过期的 TTL → 不会卡住
   *   · 台词只在真的说了话的时候才占用气泡，不会连点刷屏
   */
  function playItem(kind, key) {
    const table = kind === 'face' ? FACE_ACT : null
    const info = (table && table[key]) || {}
    const lines = info.lines || (SAY[key] ? SAY[key] : null)
    const line = lines && lines.length ? pickFresh(lines, kind + '-' + key) : undefined
    const mood = info.mood || (kind === 'face' ? key : 'happy')
    const ms = info.ms || (kind === 'face' ? 3600 : 3200)
    if (info.lean) {
      // 低头看本子（眼镜类的「仔细看看」）。空闲兜底会把它复位，不会留后遗症。
      gaze.biasTarget = -0.3
      setTimeout(() => {
        if (!rig.override) gaze.biasTarget = 0
      }, ms + 400)
    }
    // 这里只负责「她说点什么 + 换个配得上的表情」。
    return act({ mood, line, props: IDLE_PROPS, heart: !!info.heart, ms })
  }

  /**
   * 演一个一次性动作（挥手、伸懒腰、打喷嚏…）。
   *
   * 关键区别：**动作只走 override 层**（act 的 TTL 到期就没了），
   * 绝不写进 rig.userProps，所以不会一直挂着。
   */
  function playAction(key) {
    const a = ACTIONS[key]
    if (!a) return 0
    const expr = a.expr && EXPR[a.expr] ? a.expr : null
    const motion = motionPlayable(a.motion) ? a.motion : undefined
    // mood === null 的动作（自带表情变化的动画）**不压自己的脸**：
    // 压上去就是「冲突/覆盖」，会把她动画里的表情盖掉。
    const noFace = a.mood === null
    return act({
      mood: noFace ? 'neutral' : a.mood || 'happy',
      face: noFace && !expr ? null : undefined,
      props: expr ? IDLE_PROPS.concat([expr]) : IDLE_PROPS,
      line: pickFresh(a.lines, 'action-' + key),
      heart: !!a.heart,
      motion,
      ms: a.ms || 3000,
    })
  }

  // ——————————————————————————————————————————————————————————————
  // 八点七、HUD：余额 / 本轮消耗 / 峰谷计价
  // ——————————————————————————————————————————————————————————————
  //
  //   · 剩余钱数
  //   · 每轮结束弹出「本轮消耗」
  //   · 现在是峰还是谷（**峰=红，谷=绿**）
  //   · 距离切换还有多久
  // 而且「不能跟对话冲突、优先级最高、盖在上面」。
  //
  // 数据来源不自己造：DSH 里装的 dsh-whale-widget 已经在做余额与记账，
  // 它把结果开成了同源接口，我们直接读（口径天然一致，不会两边算出不同数字）：
  //   GET /dsh-whale/balance.json     → {ok,totalBalance,currency,isPeak,peakNextChangeAt,todayUsage,...}
  //   GET /dsh-whale/last-turn.json   → {ok,seq,turn,amount,tokens,ts}
  // 没装那个插件时优雅降级：能显示的照常显示，显示不了的写「—」并说明原因。

  // 数据源优先级：
  //   1) 我们宿主自己的 /dsh-pet/hud —— 自带余额 + 峰谷 + 计价，不依赖任何别的插件
  //   2) dsh-whale-widget 的 /dsh-whale/* —— 装了它就用它的账本（口径统一，数字更好对账）
  const HUD_SELF = '/dsh-pet/hud'
  const HUD_SRC = {
    balance: '/dsh-whale/balance.json',
    lastTurn: '/dsh-whale/last-turn.json',
  }
  const hud = {
    open: false,
    data: null, // balance.json 的内容
    turn: null, // last-turn.json 的内容
    seq: 0, // 用 seq 判断「是不是新的一轮」
    err: '',
    tick: null, // 倒计时定时器
    hideAt: 0, // 自动弹出后多久自己收（鼠标悬停时暂停）
    hideTimer: null,
  }

  const money = (v, cur) => {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return '—'
    const sym = (cur || 'CNY') === 'CNY' ? '¥' : (cur || '') + ' '
    return sym + Number(v).toFixed(2)
  }

  /** 距切换还有多久：写成人能读的「3 小时 12 分」。 */
  function humanLeft(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return '即将切换'
    const h = Math.floor(sec / 3600)
    const m = Math.round((sec % 3600) / 60)
    if (h <= 0) return m + ' 分钟'
    return h + ' 小时 ' + (m < 10 ? '0' + m : m) + ' 分'
  }

  function hudRender() {
    if (!ui || !ui.hud) return
    const h = ui.hud
    const d = hud.data || {}
    const peak = d.isPeak === true
    h.badge.textContent = d.isPeak === undefined || d.isPeak === null ? '—' : peak ? '峰' : '谷'
    h.badge.className = 'dshp-hud-tag ' + (peak ? 'dshp-peak' : 'dshp-valley')
    if (d.ok === false && d.code === 'NO_KEY') {
      h.money.textContent = '未配置'
      h.foot.textContent = '没读到 DEEPSEEK_API_KEY，所以看不到余额。\n在 DSH 里配好 key 就能显示。'
    } else if (d.ok === false) {
      h.money.textContent = '—'
    } else if (!hud.data) {
      h.money.textContent = '—'
    } else {
      h.money.textContent = money(d.totalBalance, d.currency)
      h.currency.textContent = d.currency || 'CNY'
    }
    h.today.textContent = d.todayUsage === undefined || d.todayUsage === null ? '—' : money(d.todayUsage, d.todayUsageCurrency || d.currency)

    // 本轮消耗：金额 + tokens
    const t = hud.turn || {}
    if (t.amount === undefined || t.amount === null) {
      h.turn.textContent = '—'
    } else {
      h.turn.textContent = money(t.amount, d.currency) + (t.tokens ? ' · ' + Number(t.tokens).toLocaleString() + ' tokens' : '')
    }

    // 倒计时：宿主给的切换时刻是权威（含周末/法定节假日规则）
    if (d.peakNextChangeAt) {
      const left = d.peakNextChangeAt - Math.floor(Date.now() / 1000)
      hud.left = left
      h.countdown.textContent = humanLeft(left)
    } else {
      h.countdown.textContent = '—'
    }

    const src = []
    if (!hud.source) src.push('数据：读不到余额接口')
    else if (hud.source === 'self') src.push('数据：桌宠自带记账' + (d.version ? ' v' + d.version : ''))
    else src.push('数据：dsh-whale-widget' + (d.version ? ' v' + d.version : ''))
    if (hud.err) src.push(hud.err)
    if (t.ts) src.push('本轮：' + new Date(t.ts).toLocaleTimeString('zh-CN', { hour12: false }))
    src.push(hud.fetchedAt ? '更新于 ' + new Date(hud.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '')
    h.foot.textContent = src.filter(Boolean).join('\n')
  }

  let hudLastForce = 0
  const grabJson = (url) =>
    fetch(url, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)

  async function hudFetch(force) {
    // 节流：force 刷新 60 秒最多一次（右键连点不该反复打 DeepSeek 的余额接口）
    if (force && Date.now() - hudLastForce < 60000) force = false
    if (force) hudLastForce = Date.now()

    // 先问自己宿主：一条就够（余额 + 峰谷 + 本轮 + 今日）
    const self = await grabJson(HUD_SELF + (force ? '?refresh=1' : ''))
    if (self && self.ok) {
      hud.source = 'self'
      hud.err = ''
      hud.data = {
        ok: true,
        version: self.version,
        isPeak: self.isPeak,
        peakNextChangeAt: self.peakNextChangeAt,
        totalBalance: self.balance && self.balance.ok ? self.balance.totalBalance : undefined,
        currency: (self.balance && self.balance.currency) || 'CNY',
        todayUsage: self.today ? self.today.amount : undefined,
        todayUsageCurrency: (self.balance && self.balance.currency) || 'CNY',
      }
      if (self.balance && self.balance.ok === false) {
        hud.data.code = self.balance.code
        hud.data.errText = self.balance.error
      } else if (self.balance && self.balance.stale) {
        hud.err = '余额这次没刷新成功，显示的是上一次的数字'
      }
      if (self.turn) {
        hud.turn = { ok: true, seq: self.turn.seq, turn: self.turn.turn, amount: self.turn.amount, tokens: self.turn.tokens, ts: self.turn.ts }
        hud.seq = self.turn.seq || 0
      }
      hud.fetchedAt = Date.now()
      hudRender()
      return { self }
    }

    // 退回 dsh-whale-widget（装了就有，口径与挂件一致）
    const [bal, lt] = await Promise.all([grabJson(HUD_SRC.balance), grabJson(HUD_SRC.lastTurn)])
    hud.err = ''
    if (bal && bal.ok === true) {
      hud.source = 'widget'
      hud.data = bal
    } else if (bal && bal.ok === false) {
      hud.source = 'widget'
      hud.data = bal
    } else {
      hud.source = null
      hud.data = null
      hud.err = '余额读不到：宿主接口和 dsh-whale-widget 都没响应'
    }
    if (lt && lt.ok) {
      hud.turn = lt
      hud.seq = lt.seq || 0
    }
    hud.fetchedAt = Date.now()
    hudRender()
    return { bal, lt }
  }

  function hudTick() {
    if (!hud.open) return
    if (hud.left !== undefined && hud.data && hud.data.peakNextChangeAt) {
      hud.left = hud.data.peakNextChangeAt - Math.floor(Date.now() / 1000)
      ui.hud.countdown.textContent = humanLeft(hud.left)
      // 跨过切换点就重新拉一次（峰谷真的变了）
      if (hud.left <= 0 && !hud.reloading) {
        hud.reloading = true
        setTimeout(() => {
          hud.reloading = false
          hudFetch(true)
        }, 1500)
      }
    }
    if (hud.hideAt && Date.now() > hud.hideAt && !hud.hover) closeHud()
  }

  function openHud(opts) {
    opts = opts || {}
    if (!ui || !ui.hud) return
    closePanels() // 别和菜单/输入框叠在一起
    hud.open = true
    ui.hud.el.classList.add('dshp-on')
    if (opts.flash) {
      ui.hud.el.classList.remove('dshp-flash')
      void ui.hud.el.offsetWidth // 强制重排，让动画能重放
      ui.hud.el.classList.add('dshp-flash')
    }
    clampPanels()
    hudFetch(opts.refresh === true)
    if (!hud.tick) hud.tick = setInterval(hudTick, 1000)
    if (opts.autoHideMs) {
      hud.hideAt = Date.now() + opts.autoHideMs
    } else {
      hud.hideAt = 0
    }
  }

  function closeHud() {
    if (!ui || !ui.hud) return
    hud.open = false
    hud.hideAt = 0
    ui.hud.el.classList.remove('dshp-on', 'dshp-flash')
    if (hud.tick) {
      clearInterval(hud.tick)
      hud.tick = null
    }
  }

  /**
   * 等 1.2 秒再弹：宿主的记账是收到事件后才落账的，太早拉会拿到上一轮的数。
   */
  function hudPopTurnEnd() {
    const before = hud.seq
    setTimeout(async () => {
      if (hud.open) {
        await hudFetch(false)
        return
      }
      // 这里仍然把账拉回来（右键打开时数字是新的），但**不自动开面板**。
      await hudFetch(false)
      // seq 没变说明账还没落，再补一次
      if (hud.seq === before) setTimeout(() => hudFetch(false), 1800)
    }, 1200)
  }

  // ——————————————————————————————————————————————————————————————
  // 九、输入框 / 菜单
  // ——————————————————————————————————————————————————————————————

  /**
   * 隐藏 / 恢复。
   *
   * 之前「隐藏之后再也找不回来」是因为小把手的显示条件写成了
   * `.dshp-root.dshp-hidden .dshp-tab`——把手挂在 body 上，不在 root 里，
   * 后代选择器永远匹配不到。现在改成 body 级类，并且收进这一个函数，
   * 保证「隐藏态」和「把手可见」永远同步。
   */
  /**
   * 桌面壳（macOS 原生 App）的桥。
   * 壳子启动时会在页面里设 window.__DSHPET_SHELL__ = true，并挂一个 dshpetshell 消息通道。
   * 有它的时候：① 收起/展开走消息，立刻响应，不用等轮询；
   *             ② 设置页多出「收起成悬浮小球」和「彻底关闭桌宠应用」。
   */
  const shell = {
    on: !!(
      window.__DSHPET_SHELL__ &&
      window.webkit &&
      window.webkit.messageHandlers &&
      window.webkit.messageHandlers.dshpetshell
    ),
    post(msg) {
      try {
        window.webkit.messageHandlers.dshpetshell.postMessage(msg)
      } catch (e) {}
    },
  }

  function setHidden(hidden) {
    ui.root.classList.toggle('dshp-hidden', !!hidden)
    document.body.classList.toggle('dshp-pet-hidden', !!hidden)
    if (hidden) ui.bubble.hide()
    saveLayout({ hidden: !!hidden })
    if (shell.on) shell.post(hidden ? 'hidden' : 'shown')
  }

  /**
   * 一键重置所有状态：回到「平常脸 + 正常坐姿 + 手里本子和笔」。
   * 点一下就全回正常」。
   *
   * 查出来的真凶有两个：
   *   1. 重置只清了三层状态，**没停干活轮播**（work.active 还是 true）——
   *      于是 9~14 秒后 workTick 又把底层状态推回「看资料 + 星星眼」，
   *      看起来就是「表情怎么都回不去」；
   * 现在补上了：重置 = 连干活轮播、小设备、所有道具层一起归零。
   */
  function resetEverything() {
    endWork() // 停干活轮播（否则几秒后底层状态又被推回工作脸）
    rig.userProps.clear()
    rig.user = { face: null, until: 0 }
    rig.override = null
    rig.burst = null
    rig.weight.clear()
    // 兜底：所有道具一层不留（万一以后有人加了新的道具层，这里也不会漏）
    for (const key of Object.keys(ALL_TOGGLES)) {
      const expr = propExpr(key)
      if (expr) rig.userProps.delete(expr)
    }
    rig.props = new Set()
    device.out = false
    agent.toolProp = null
    agent.hasStream = false
    agent.sleeping = false
    gaze.biasTarget = 0
    gaze.biasY = 0
    gaze.detachUntil = 0
    gaze.stepRate = 0
    gaze.driftX = 0
    gaze.driftY = 0
    gaze.tx = 0
    gaze.ty = 0
    rig.talking = false
    setBase('neutral', IDLE_PROPS)
    stopMotion() // 回到模型默认姿势 = 正常坐姿
    closePanels()
    ui.bubble.hide()
    setHidden(false)
    const keep = { height: readLayout().height || CFG.height }
    saveLayout({ props: [], fit: 'full', x: null, y: null, hidden: false, ...keep })
    for (const k of ['left', 'top', 'right', 'bottom']) ui.root.style[k] = ''
    fitModel()
    applyPosition(readLayout())
    return true
  }

  function addCloseButton(panel, onClose) {
    const b = $('button', 'dshp-close', '×')
    b.title = '关闭'
    b.setAttribute('aria-label', '关闭')
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      // 以前不管哪个面板都去 closePanels()，于是「钱包」的 × 点了没反应
      if (typeof onClose === 'function') onClose()
      else closePanels()
    })
    panel.appendChild(b)
  }

  function closePanels() {
    ui.composer.el.classList.remove('dshp-on')
    ui.menu.el.classList.remove('dshp-on')
    ui.root.classList.remove('dshp-open')
  }

  function bindComposer(u) {
    const { ta, send, cancel } = u.composer
    const stop = (e) => e.stopPropagation()
    for (const ev of ['keydown', 'keyup', 'keypress']) ta.addEventListener(ev, stop)
    ta.addEventListener('keydown', (e) => {
      // 互动感知（S2）：她在旁边能感觉到你在打字（不拦事件，只记时间）
      try {
        DSHPetIdleSensors.key(idle.sensors, performance.now())
        idle.lastInputAt = performance.now() // 输入框这里 stopPropagation，窗口级 keydown 收不到，补一下
      } catch (err) {}
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        doSend()
      }
    })
    send.addEventListener('click', doSend)
    cancel.addEventListener('click', async () => {
      try {
        const r = await fetch(BASE + '/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
        const j = await r.json()
        u.bubble.show(
          j.ok ? '打断啦' : j.error === 'offline' ? '现在没连上 DSH，不用打断我也能停～' : '打断失败：' + (j.error || '未知'),
          { name: 'DS 鲸鱼娘', ttl: 2000 },
        )
      } catch (err) {
        u.bubble.show('打断失败：' + err.message, { name: 'DS 鲸鱼娘', ttl: 2600 })
      }
    })

    async function doSend() {
      const text = ta.value.trim()
      if (!text) {
        ta.focus()
        return
      }
      send.disabled = true
      try {
        const r = await fetch(BASE + '/say', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        })
        const j = await r.json()
        if (!j.ok) {
          // 独立外壳：DSH 没开时本地服务回 {ok:false,error:'offline'} —— 说人话，别甩一个英文码
          if (j.error === 'offline') throw new Error('现在没连上 DSH，我只能陪你待着～')
          throw new Error(j.error || '发送失败')
        }
        ta.value = ''
        closePanels()
        act({ mood: 'listening', props: IDLE_PROPS, line: text, ms: 2600 })
      } catch (err) {
        u.bubble.show('发不出去：' + err.message, { name: 'DS 鲸鱼娘', sticky: true })
      } finally {
        send.disabled = false
      }
    }
  }

  function openMenu(which) {
    closeHud() // 菜单和 HUD 不同时占屏幕
    ui.root.classList.add('dshp-open')
    // 立刻夹一次（getBoundingClientRect 会强制重排，拿到的是最终横向位置），
    // 再在下一帧补一次——只等 rAF 的话，测试/快照可能量到还没夹的面板
    clampPanels()
    // 面板是以模型为中心左右展开的，蹲在角落时右半边会跑到屏幕外——
    // 等布局落定后夹回视口内（关闭按钮和滑块必须点得到）
    requestAnimationFrame(() => clampPanels())
    // 气泡和面板都挂在桌宠上方，同时出现会互相挡住——开面板就把气泡收起来
    ui.bubble.hide()
    if (which === 'talk') {
      ui.menu.el.classList.remove('dshp-on')
      ui.composer.el.classList.add('dshp-on')
      setTimeout(() => ui.composer.ta.focus(), 60)
    } else {
      ui.composer.el.classList.remove('dshp-on')
      renderPane(ui.menu.focused || 'face')
      ui.menu.el.classList.add('dshp-on')
    }
    // 面板真正显示之后再夹一次（上面那次夹在 class 加之前，量不到它）
    clampPanels()
  }

  function bindMenu(u) {
    const TABS = [
      ['face', '表情'],
      ['mouth', '口型'],
      ['action', '动作'],
      ['script', '小戏'],
      ['setting', '设置'],
    ]
    u.menu.focused = 'face'
    for (const [id, label] of TABS) {
      const b = $('button', 'dshp-tab-btn', label)
      b.dataset.tab = id
      if (id === u.menu.focused) b.classList.add('dshp-active')
      b.addEventListener('click', () => {
        u.menu.focused = id
        for (const el of u.menu.tabs.children) el.classList.toggle('dshp-active', el.dataset.tab === id)
        renderPane(id)
      })
      u.menu.tabs.appendChild(b)
    }
    u.dock.children[0].addEventListener('click', () => {
      if (u.composer.el.classList.contains('dshp-on')) closePanels()
      else openMenu('talk')
    })
    u.dock.children[1].addEventListener('click', () => {
      if (u.menu.el.classList.contains('dshp-on')) closePanels()
      else openMenu('menu')
    })
    u.dock.children[2].addEventListener('click', () => {
      closePanels()
      setHidden(true)
    })
    // 第 4 个：打开 DeepSeek Harness。桌面壳里交给原生用默认浏览器打开，
    // 浏览器版直接新开一个标签页。
    u.dock.children[3].addEventListener('click', () => {
      if (shell.on) shell.post('open-dsh')
      else window.open(BASE.replace(/\/dsh-pet$/, '') + '/', '_blank')
    })
  }

  // ——— 详细频率面板（2026-10-17）：把「伸懒腰太多」这类调参从改代码搬到 UI ———
  // 只改 CFG 里的三个倍数；真正的权重表由 @idle-rhythm / startIdleScript 在下一跳读取。
  const TUNE_BEHAVIORS = [
    ['glance', '看别处 / 发呆'],
    ['peer', '探头张望'],
    ['sway', '换重心'],
    ['express', '换表情'],
    ['mutter', '自言自语'],
    ['nod', '点头'],
    ['tilt', '歪头'],
    ['stretch', '伸懒腰'],
    ['tailWag', '甩尾巴'],
    ['script', '小戏（整体）'],
    ['hungry', '喊饿'],
    ['nopang', '强调不胖'],
  ]

  function tuningScale(map, key) {
    const v = Number(map && map[key])
    return isFinite(v) && v >= 0 ? v : 1
  }

  /** 详细面板/诊断共用：某档的占比快照（纯读，不改状态） */
  function tuningPreview(tier) {
    const t = tier || (idle.rhythm && idle.rhythm.mood) || 'normal'
    const fn = DSHPetIdleRhythm && DSHPetIdleRhythm.shareRows
    if (typeof fn !== 'function') return null
    const r = fn(t, IDLE_TABLE, idleWeightScale(), IDLE_CLIP, CFG.idleClipChance)
    return {
      tier: t, gate: r.gate, total: r.total, perEvent: r.perEvent,
      rows: r.rows.map((x) => ({
        name: x.name, base: x.base, missing: !!x.missing,
        share: Math.round(x.share * 10000) / 10000,
        gapSec: x.gapSec == null ? null : Math.round(x.gapSec * 100) / 100,
      })),
    }
  }

  function closeTuningPanel() {
    if (!ui || !ui.tuning) return
    const t = ui.tuning
    ui.tuning = null
    // 通知外壳的「点击穿透」判定：模态结束，恢复按鼠标下方内容决定
    window.__DSHPET_MODAL__ = false
    if (shell.on) shell.post('modal:off')
    try { window.removeEventListener('keydown', t.onKey, true) } catch (e) {}
    try { t.mask.remove() } catch (e) {}
    try { t.el.remove() } catch (e) {}
    try { t.tip && t.tip.remove() } catch (e) {}
  }

  function openTuningPanel() {
    if (!ui || !ui.root) return
    if (ui.tuning) { closeTuningPanel(); return }
    const mask = $('div', 'dshp-tuning-mask')
    const panel = $('div', 'dshp-tuning')
    const head = $('h3')
    head.append($('span', null, '详细频率面板'))
    const close = $('button', 'dshp-close', '×')
    close.title = '关闭（Esc）'
    close.addEventListener('click', closeTuningPanel)
    head.append(close)
    panel.append(head)
    panel.append($('div', 'dshp-tune-note', '看「占比 / 约每」就够了。份额 100% = 默认；0% = 关掉；200% = 两倍。'))

    const TIERS = [['normal', '常态'], ['lively', '活泼'], ['drowsy', '发呆']]
    const TIER_LABEL = { normal: '常态', lively: '活泼', drowsy: '发呆' }
    const BEHAVIOR_LABEL = {}
    for (const [k, label] of TUNE_BEHAVIORS) BEHAVIOR_LABEL[k] = label
    const CAT_COLOR = {
      glance: '#7c8cf8', peer: '#7c8cf8', sway: '#67c7a3', express: '#f79ac0',
      mutter: '#f6c76b', nod: '#67c7a3', tilt: '#67c7a3', stretch: '#67c7a3',
      tailWag: '#67c7a3', script: '#9b8cff', hungry: '#f6a45b', nopang: '#f6a45b',
    }

    let tier = (idle.rhythm && idle.rhythm.mood) || 'normal'
    const tabs = $('div', 'dshp-tune-tabs')
    const status = $('div', 'dshp-tune-status')
    const bar = $('div', 'dshp-tune-bar')
    const body = $('div', 'dshp-tune-body')
    panel.append(tabs, status, bar, body)

    const rowRefs = new Map()
    const scriptRefs = new Map()
    let info = null
    let intervalRef = null
    let simEl = null
    let advEl = null

    const tip = $('div', 'dshp-tune-tip')
    document.body.append(tip)
    const tipHide = () => tip.classList.remove('dshp-on')
    const tipShow = (text, e) => {
      if (!text || !e) return
      tip.textContent = text
      tip.classList.add('dshp-on')
      const pad = 8
      const x = Math.max(pad, Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - pad))
      const y = Math.max(pad, Math.min(e.clientY + 16, window.innerHeight - tip.offsetHeight - pad))
      tip.style.left = x + 'px'
      tip.style.top = y + 'px'
    }

    const fmtPct = (v) => (v * 100).toFixed(1) + '%'
    const fmtGap = (sec) => {
      if (sec == null || !isFinite(sec) || sec <= 0) return '—'
      if (sec < 60) return Math.max(1, Math.round(sec)) + ' 秒'
      return (sec / 60).toFixed(sec < 600 ? 1 : 0) + ' 分钟'
    }
    const currentMood = () => (idle.rhythm && idle.rhythm.mood) || 'normal'
    const intervalFactor = () => {
      const s0 = Number(CFG.idleIntervalScale)
      const s = isFinite(s0) && s0 > 0 ? s0 : 1
      const b0 = (DSHPetIdleRhythm && DSHPetIdleRhythm.biasFactor) ? DSHPetIdleRhythm.biasFactor(CFG) : 1
      const b = isFinite(b0) && b0 > 0 ? b0 : 1
      return s * b
    }
    const gapFor = (row) => (row && row.gapSec != null ? row.gapSec * intervalFactor() : null)
    const currentScale = (key) => {
      const bmap = CFG.idleWeightScale && typeof CFG.idleWeightScale === 'object' ? CFG.idleWeightScale : {}
      return Math.round(tuningScale(bmap, key) * 100)
    }
    const setScale = (key, v) => {
      const m = CFG.idleWeightScale && typeof CFG.idleWeightScale === 'object' ? CFG.idleWeightScale : (CFG.idleWeightScale = {})
      if (v === 100) delete m[key]; else m[key] = v / 100
      persistCfg()
    }
    const scriptScale = (name) => {
      const smap = CFG.scriptWeightScale && typeof CFG.scriptWeightScale === 'object' ? CFG.scriptWeightScale : {}
      return Math.round(tuningScale(smap, name) * 100)
    }
    const setScriptScale = (name, v) => {
      const m = CFG.scriptWeightScale && typeof CFG.scriptWeightScale === 'object' ? CFG.scriptWeightScale : (CFG.scriptWeightScale = {})
      if (v === 100) delete m[name]; else m[name] = v / 100
      persistCfg()
    }
    const scriptTotal = () => IDLE_SCRIPTS.reduce((a, s) => a + s.weight * (scriptScale(s.name) / 100), 0)
    const simHide = () => { if (simEl) { simEl.textContent = ''; simEl.classList.remove('dshp-on') } }

    const buildTabs = () => {
      tabs.textContent = ''
      for (const [id, label] of TIERS) {
        const b = $('button', 'dshp-tune-tab', label)
        b.dataset.tier = id
        b.title = id === 'normal'
          ? '默认档：间隔 3.5~7.5 秒'
          : id === 'lively'
            ? '互动后进入：间隔 1.5~3.5 秒，连做 2~3 件'
            : '久不互动进入：间隔 7~16 秒，动作更少'
        b.addEventListener('click', () => {
          if (tier === id) return
          tier = id
          simHide()
          buildBody()
          refresh()
        })
        tabs.append(b)
      }
    }

    const buildBar = () => {
      bar.textContent = ''
      tipHide()
      if (!info) return
      for (const row of info.rows) {
        if (!(row.share > 0)) continue
        const seg = $('div', 'dshp-tune-seg')
        seg.style.flex = String(row.share)
        seg.style.background = CAT_COLOR[row.name] || '#7c5cff'
        const text = (BEHAVIOR_LABEL[row.name] || row.name) + ' ' + fmtPct(row.share) + ' · 约 ' + fmtGap(gapFor(row))
        seg.setAttribute('aria-label', text)
        seg.addEventListener('pointerenter', (e) => tipShow(text, e))
        seg.addEventListener('pointermove', (e) => tipShow(text, e))
        seg.addEventListener('pointerleave', tipHide)
        bar.append(seg)
      }
    }

    const buildAdvanced = () => {
      const open = !!(advEl && advEl.open)
      const d = document.createElement('details')
      d.className = 'dshp-tune-adv'
      d.open = open
      const s = document.createElement('summary')
      s.textContent = '高级：原始权重 / 三档数值'
      d.append(s)
      d.append($('div', 'dshp-tune-note', '票 = 该档基础权重；占比 = 票 × 份额 × 动作门 ÷ 总票。这里的数字不参与存档。'))
      const matrix = (DSHPetIdleRhythm && DSHPetIdleRhythm.weightMatrix)
        ? DSHPetIdleRhythm.weightMatrix(IDLE_TABLE, CFG.idleWeightScale)
        : {}
      const fmt = (v) => (v == null ? '—' : String(Math.round(v * 10) / 10))
      for (const [key, label] of TUNE_BEHAVIORS) {
        const cell = matrix[key] || {}
        const line = $('div', 'dshp-tune-adv-row')
        line.append($('span', null, label))
        line.append($('span', null, '常态 ' + fmt(cell.normal) + ' / 活泼 ' + fmt(cell.lively) + ' / 发呆 ' + fmt(cell.drowsy)))
        d.append(line)
      }
      return d
    }

    const makeBehaviorRow = (key, label) => {
      const row = $('div', 'dshp-tune-row')
      row.dataset.key = key
      const name = $('span', 'dshp-tune-name', label)
      const input = document.createElement('input')
      input.type = 'range'
      input.min = '0'; input.max = '200'; input.step = '5'
      input.className = 'dshp-tune-slider'
      input.value = String(clamp(currentScale(key), 0, 200))
      const val = $('span', 'dshp-tune-val', input.value + '%')
      const share = $('span', 'dshp-tune-share', '—')
      const gap = $('span', 'dshp-tune-gap', '—')
      const mute = $('button', 'dshp-tune-mute', '🔈')
      mute.type = 'button'
      const ref = { row: row, input: input, val: val, share: share, gap: gap, mute: mute, prev: Number(input.value) || 100 }
      input.addEventListener('input', () => {
        const v = Number(input.value)
        if (v > 0) ref.prev = v
        setScale(key, v)
        simHide()
        refresh()
      })
      mute.addEventListener('click', () => {
        if (input.disabled) return
        if (Number(input.value) > 0) {
          ref.prev = Number(input.value)
          input.value = '0'
        } else {
          input.value = String(ref.prev || 100)
        }
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      row.append(name, input, val, share, gap, mute)
      return ref
    }

    const makeScriptRow = (s) => {
      const row = $('div', 'dshp-tune-row dshp-tune-script')
      const name = $('span', 'dshp-tune-name', s.name)
      const input = document.createElement('input')
      input.type = 'range'
      input.min = '0'; input.max = '200'; input.step = '5'
      input.className = 'dshp-tune-slider'
      input.value = String(clamp(scriptScale(s.name), 0, 200))
      const val = $('span', 'dshp-tune-val', input.value + '%')
      const share = $('span', 'dshp-tune-share', '—')
      const gap = $('span', 'dshp-tune-gap', '—')
      const mute = $('button', 'dshp-tune-mute', '🔈')
      mute.type = 'button'
      const ref = { row: row, input: input, val: val, share: share, gap: gap, mute: mute, prev: Number(input.value) || 100 }
      input.addEventListener('input', () => {
        const v = Number(input.value)
        if (v > 0) ref.prev = v
        setScriptScale(s.name, v)
        simHide()
        refresh()
      })
      mute.addEventListener('click', () => {
        if (Number(input.value) > 0) {
          ref.prev = Number(input.value)
          input.value = '0'
        } else {
          input.value = String(ref.prev || 100)
        }
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      row.append(name, input, val, share, gap, mute)
      return ref
    }

    const buildBody = () => {
      body.textContent = ''
      rowRefs.clear()
      scriptRefs.clear()
      intervalRef = null
      info = (DSHPetIdleRhythm && DSHPetIdleRhythm.shareRows)
        ? DSHPetIdleRhythm.shareRows(tier, IDLE_TABLE, CFG.idleWeightScale, IDLE_CLIP, CFG.idleClipChance)
        : null

      body.append($('div', 'dshp-tune-sec', '待机节奏'))
      body.append($('div', 'dshp-tune-note', '整体间隔：50% = 间隔减半，200% = 间隔翻倍。右侧是当前档位估算的秒数区间。'))
      const ivRow = $('div', 'dshp-tune-row dshp-tune-interval')
      const ivName = $('span', 'dshp-tune-name', '整体间隔')
      const ivInput = document.createElement('input')
      ivInput.type = 'range'
      ivInput.min = '50'; ivInput.max = '200'; ivInput.step = '5'
      ivInput.className = 'dshp-tune-slider'
      const iv0 = Number(CFG.idleIntervalScale)
      ivInput.value = String(clamp(Math.round((isFinite(iv0) && iv0 > 0 ? iv0 : 1) * 100), 50, 200))
      const ivVal = $('span', 'dshp-tune-val', ivInput.value + '%')
      const ivGap = $('span', 'dshp-tune-gap', '')
      ivInput.addEventListener('input', () => {
        CFG.idleIntervalScale = Number(ivInput.value) / 100
        persistCfg()
        simHide()
        refresh()
      })
      ivRow.append(ivName, ivInput, ivVal, ivGap)
      body.append(ivRow)
      intervalRef = { input: ivInput, val: ivVal, gap: ivGap }

      body.append($('div', 'dshp-tune-sec', '待机行为频率'))
      body.append($('div', 'dshp-tune-note', '占比 = 最终进池份额（已乘动作门）；约每 = 按当前档位估算。点「静音」等于 0%，点「🔈」恢复。'))
      const headRow = $('div', 'dshp-tune-head')
      headRow.append(
        $('span', 'dshp-tune-name', '行为'),
        $('span', 'dshp-tune-slider-h', '份额'),
        $('span', 'dshp-tune-val', ''),
        $('span', 'dshp-tune-share', '占比'),
        $('span', 'dshp-tune-gap', '约每'),
        $('span', 'dshp-tune-mute', ''),
      )
      body.append(headRow)
      for (const [key, label] of TUNE_BEHAVIORS) {
        const ref = makeBehaviorRow(key, label)
        rowRefs.set(key, ref)
        body.append(ref.row)
      }

      body.append($('div', 'dshp-tune-sec', '小戏单项（' + IDLE_SCRIPTS.length + ' 段）'))
      body.append($('div', 'dshp-tune-note', '只影响随机抽取；「小戏」整体频率在上面。右侧百分比 = 小戏池内份额；0% 时菜单里仍可手点。'))
      for (const s of IDLE_SCRIPTS) {
        const ref = makeScriptRow(s)
        scriptRefs.set(s.name, ref)
        body.append(ref.row)
      }

      advEl = buildAdvanced()
      body.append(advEl)
    }

    const refresh = () => {
      info = (DSHPetIdleRhythm && DSHPetIdleRhythm.shareRows)
        ? DSHPetIdleRhythm.shareRows(tier, IDLE_TABLE, CFG.idleWeightScale, IDLE_CLIP, CFG.idleClipChance)
        : null
      const m = (DSHPetIdleRhythm && DSHPetIdleRhythm.MOODS[tier]) || { inter: [0, 0], clip: 1 }
      const gate = info ? info.gate : 0
      const now = currentMood()
      status.textContent = '间隔 ' + m.inter[0] + '–' + m.inter[1] + ' 秒 · 动作门 ' + (gate * 100).toFixed(1) + '% · 现在：' + (TIER_LABEL[now] || now) + (now !== tier ? '（正在看：' + TIER_LABEL[tier] + '）' : '')
      if (info && info.total <= 0) status.textContent += ' · ⚠ 全部关掉了，她会退回看别处'
      for (const b of tabs.children) b.classList.toggle('dshp-on', b.dataset.tier === tier)

      if (intervalRef) {
        const v = Number(intervalRef.input.value)
        const f = intervalFactor()
        intervalRef.val.textContent = v + '%'
        intervalRef.gap.textContent = (Math.round(m.inter[0] * f * 10) / 10) + '~' + (Math.round(m.inter[1] * f * 10) / 10) + ' 秒'
      }

      buildBar()
      const byKey = {}
      if (info) for (const row of info.rows) byKey[row.name] = row
      for (const [key, ref] of rowRefs) {
        const row = byKey[key]
        if (!row || row.missing) {
          ref.row.classList.add('is-missing')
          ref.input.disabled = true
          ref.mute.disabled = true
          ref.val.textContent = '—'
          ref.share.textContent = '—'
          ref.gap.textContent = '该档不进池'
          ref.mute.textContent = '—'
          continue
        }
        const v = Number(ref.input.value)
        const muted = v === 0
        ref.row.classList.toggle('is-muted', muted)
        ref.row.classList.remove('is-missing')
        ref.input.disabled = false
        ref.mute.disabled = false
        ref.val.textContent = v + '%'
        ref.share.textContent = fmtPct(row.share)
        ref.gap.textContent = '约 ' + fmtGap(gapFor(row))
        ref.mute.textContent = muted ? '🔇' : '🔈'
        ref.mute.title = muted ? '恢复默认份额' : '静音（设为 0%）'
        ref.row.title = (BEHAVIOR_LABEL[key] || key) + '：票 ' + row.base + ' × 份额 ' + v + '% × 动作门 ' + Math.round(row.gate * 100) + '% = ' + fmtPct(row.share)
      }

      const total = scriptTotal()
      for (const [name, ref] of scriptRefs) {
        const s = IDLE_SCRIPTS.find((x) => x.name === name)
        if (!s) continue
        const v = Number(ref.input.value)
        const muted = v === 0
        ref.row.classList.toggle('is-muted', muted)
        ref.val.textContent = v + '%'
        ref.share.textContent = total > 0 ? ((s.weight * v / 100 / total) * 100).toFixed(1) + '%' : '—'
        ref.gap.textContent = '权重 ' + Math.round(s.weight * v / 100 * 10) / 10
        ref.mute.textContent = muted ? '🔇' : '🔈'
        ref.mute.title = muted ? '恢复默认' : '静音（设为 0%）'
      }

      if (advEl && advEl.parentNode) {
        const next = buildAdvanced()
        advEl.parentNode.replaceChild(next, advEl)
        advEl = next
      }
    }

    simEl = $('div', 'dshp-tune-sim')
    panel.append(simEl)

    const simBtn = $('button', 'dshp-btn', '模拟 10 分钟')
    simBtn.title = '按当前档位抽签，不含 agent 忙 / 正在演'
    simBtn.addEventListener('click', () => {
      if (!DSHPetIdleRhythm || !DSHPetIdleRhythm.simulate) return
      const r = DSHPetIdleRhythm.simulate(
        tier, IDLE_TABLE, CFG.idleWeightScale, IDLE_CLIP, CFG.idleClipChance, 600, Math.random,
        { intervalScale: CFG.idleIntervalScale, bias: DSHPetIdleRhythm.biasFactor(CFG) },
      )
      const entries = Object.keys(r.counts).map((k) => [k, r.counts[k]]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1])
      const text = entries.length
        ? entries.map(([k, n]) => (BEHAVIOR_LABEL[k] || k) + ' ' + n).join(' · ')
        : '没有可抽的行为（全部关掉了）'
      simEl.textContent = '模拟 10 分钟（' + TIER_LABEL[tier] + '，按平均动作门）：\n' + text + '\n只算抽签，不含 agent 忙 / 正在演；再点一次会变。'
      simEl.classList.add('dshp-on')
    })

    const footer = $('div', 'dshp-row')
    const reset = $('button', 'dshp-btn', '全部恢复默认')
    reset.addEventListener('click', () => {
      CFG.idleIntervalScale = 1
      CFG.idleWeightScale = {}
      CFG.scriptWeightScale = {}
      persistCfg()
      closeTuningPanel()
      openTuningPanel()
    })
    const done = $('button', 'dshp-btn dshp-primary', '完成')
    done.addEventListener('click', closeTuningPanel)
    footer.append(reset, simBtn, done)
    panel.append($('div', 'dshp-tune-note', '改动影响她的下一跳；正在演的小戏不会被掐断。'), footer)

    buildTabs()
    buildBody()
    refresh()

    mask.addEventListener('click', (e) => { if (e.target === mask) closeTuningPanel() })
    const onKey = (e) => { if (e.key === 'Escape') closeTuningPanel() }
    window.addEventListener('keydown', onKey, true)
    panel.addEventListener('pointerleave', tipHide)
    panel.addEventListener('scroll', tipHide, true)
    ui.root.append(mask, panel)
    ui.tuning = { mask: mask, el: panel, onKey: onKey, tip: tip }
    window.__DSHPET_MODAL__ = true
    // 双窗口：模态打开时让命中窗立刻让开（不能等 90ms 轮询，鼠标可能不在窗口内）
    if (shell.on) shell.post('modal:on')
  }

  function renderPane(id) {
    const panes = ui.menu.panes
    panes.textContent = ''
    // 顶上永远有一行「她现在是什么状态」，免得一堆按钮里看不出哪个是开着的
    panes.appendChild($('div', 'dshp-hint dshp-now', menuStatusLine()))
    if (id === 'face' || id === 'mouth') {
      const grid = $('div', 'dshp-grid')
      // 「表情」和「口型」两个页签**共用这套渲染**：
      // 机制完全一样（点一下 → 走 override 层换个脸），只是列表和台词表不同。
      const menuList = id === 'face' ? FACE_MENU : MOUTH_MENU
      const ownLines = id === 'face' ? FACE_LINES : MOUTH_LINES
      /*
       * 反向索引：表情 → 哪些"情绪"会用到它（只用来写 tooltip）。
       */
      const moodsOf = {}
      for (const key of Object.keys(MOOD_FACE)) {
        if (key === 'neutral') continue
        const e = MOOD_FACE[key]
        if (!e || e === '晕晕' || e === '呆呆眼') continue
        if (!moodsOf[e]) moodsOf[e] = []
        moodsOf[e].push(key)
      }
      const neutral = $('button', 'dshp-chip', '平常')
      if (!rig.override && !rig.user.face) neutral.classList.add('dshp-on')
      neutral.title = '立刻回到平常脸（她自己的表情也交还给她）'
      neutral.addEventListener('click', () => {
        clearUserFace()
        clearReaction()
        act({ mood: 'neutral', props: IDLE_PROPS, ms: 800 })
        renderPane(id)
      })
      grid.appendChild(neutral)
      // 遍历的是**显式列表**（不再依赖鲸鱼娘那张情绪映射表）
      for (const expr of menuList) {
        if (!EXPR[expr]) continue
        const moods = moodsOf[expr] || []
        // 有"情绪身份"的表情（脸红 / 生气）走 FACE_ACT 的台词；其余用 FACE_LINES
        const rep = moods.find((k) => FACE_ACT[k]) || null
        const lines = (rep && FACE_ACT[rep].lines) || ownLines[expr] || []
        const b = $('button', 'dshp-chip', expr)
        // 亮着的判断看**当前这一次性表演**，不是看手动层：菜单里的表情是临时的，
        // 谁最后一个说话谁亮。
        if (rig.override && rig.override.face === expr) b.classList.add('dshp-on')
        b.title = (moods.length ? moods.join(' / ') + '\n' : '') + (lines.length ? `她会说：${lines[0]}` : '')
        b.addEventListener('click', () => {
          //   · 3~4 秒后自己让位，平常状态永远回到「平常脸」
          //   · 期间任何新表情（她自己挑的 / agent 事件 / 你再点一个）都会把它顶掉
          // 所以这里不写 30 秒的 rig.user 手动层，只走一次性 override。
          clearUserFace()
          if (rep) {
            playItem('face', rep)   // 有情绪条目 → 走原来那条路（带 FACE_ACT 的台词/mood）
          } else {
            // 没有情绪条目的新表情：直接把 face 交给 override 层。
            // 不写 rig.user 手动层 —— 菜单表情是"演三四秒"，不是常驻。
            act({ face: expr, mood: 'neutral', props: IDLE_PROPS, line: pickFresh(lines, 'face-' + expr), ms: 3600 })
          }
          renderPane(id)
        })
        grid.appendChild(b)
      }
      panes.append(
        grid,
        $(
          'div',
          'dshp-hint',
          id === 'mouth'
            ? '换嘴素材。和「表情」页是同一套机制：点一下换个嘴 + 说一句话，**三四秒后自己让位**。'
            : '点一下 = 换脸 + 说一句配好的话，**三四秒后自己让位**（平常状态永远是平常脸）。\n期间她自己的表情、agent 事件、或者你再点一个，都会把它顶掉。',
        ),
      )
      return
    }
    if (id === 'action') {
      const grid = $('div', 'dshp-grid')
      for (const key of ACTION_KEYS) {
        const a = ACTIONS[key]
        if (a.expr && !EXPR[a.expr]) continue
        if (a.motion && !motionPlayable(a.motion)) continue
        const b = $('button', 'dshp-chip', a.label)
        b.title = `点了她会说：${a.lines[0]}` + (a.note ? `\n${a.note}` : '') + (a.motion ? `\n动作：${a.motion}` : '')
        b.addEventListener('click', () => {
          playAction(key)
          renderPane('action')
        })
        grid.appendChild(b)
      }
      panes.append(
        grid,
        $('div', 'dshp-hint', '动作是**一次性的**：演一遍就自己消失，不会一直挂着。'),
      )
      return
    }
    if (id === 'script') {
      const grid = $('div', 'dshp-grid')
      const runningName = idle.scripts && idle.scripts.running ? idle.scripts.running.name : null
      const stepWord = (s) => {
        if (s.do === 'clip') return '动作「' + s.arg + '」'
        if (s.do === 'face') return '表情「' + s.arg + '」'
        if (s.do === 'line') return '台词'
        if (s.do === 'glance') return '看一眼'
        if (s.do === 'qbounce') return '弹一下'
        if (s.do === 'prop') return '道具'
        return s.do
      }
      for (const sc of IDLE_SCRIPTS) {
        const dur = DSHPetIdleScripts && DSHPetIdleScripts.durOf ? DSHPetIdleScripts.durOf(sc) : 0
        const steps = (sc.steps || []).map((s) => s.at.toFixed(1) + 's ' + stepWord(s)).join(' → ')
        const b = $('button', 'dshp-chip', sc.name)
        if (runningName === sc.name) b.classList.add('dshp-on')
        b.title = '演一遍「' + sc.name + '」\n时长 ' + dur.toFixed(1) + 's · ' + (sc.steps || []).length + ' 步 · 冷却 ' + sc.minGap + 's\n' + steps
        b.addEventListener('click', () => {
          const got = startIdleScriptByName(sc.name)
          if (got) ui.bubble.show('（演一段）' + got, { name: 'DS 鲸鱼娘', ttl: 1800 })
          renderPane(id)
        })
        grid.appendChild(b)
      }
      panes.append(
        grid,
        $(
          'div',
          'dshp-hint',
          (runningName ? '正在演「' + runningName + '」…\n' : '') +
            '点一下立刻演这一段：2~4 步按时间轴依次做，最后自己结束。\n' +
            '睡着时点它会先走唤醒过场；真正的工作事件来了会立刻收掉。',
        ),
      )
      return
    }
    // setting
    const box = $('div')
    const label = $('label', 'dshp-label')
    label.append($('span', null, '大小'))
    const range = document.createElement('input')
    range.type = 'range'
    range.min = '150'
    range.max = '720'
    range.value = String(clamp(Number(readLayout().height) || CFG.height, 150, 720))
    range.title = '也可以直接拖（点 − / + 更省事）'
    const stepSize = (delta) => {
      const next = clamp(Number(range.value) + delta, 150, 720)
      range.value = String(next)
      sizeOut.textContent = next + 'px'
      fitModel(next)
      saveLayout({ height: next })
      clampPanels()
    }
    const mkStep = (txt, delta) => {
      const b = $('button', 'dshp-btn dshp-step', txt)
      b.title = (delta > 0 ? '放大' : '缩小') + '（每下 ' + Math.abs(delta) + 'px）'
      b.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        stepSize(delta)
      })
      return b
    }
    const sizeOut = $('span', null, range.value + 'px')
    sizeOut.style.minWidth = '46px'
    sizeOut.style.fontVariantNumeric = 'tabular-nums'
    const stepRow = $('div', 'dshp-row')
    stepRow.append(mkStep('−', -20), sizeOut, mkStep('+', 20))
    // 拖的时候冻住 UI 缩放（见 sizingSize），松手再让面板跟上新尺寸——
    // 这样滑块轨道全程钉在原地，可以一路拖到底。
    const beginSize = () => {
      sizingSize = true
      ui.root.classList.add('dshp-sizing')
    }
    const endSize = () => {
      if (!sizingSize) return
      sizingSize = false
      ui.root.classList.remove('dshp-sizing')
      fitModel(Number(range.value))
      saveLayout({ height: Number(range.value) })
      clampPanels()
    }
    range.addEventListener('pointerdown', beginSize)
    range.addEventListener('pointerup', endSize)
    range.addEventListener('pointercancel', endSize)
    range.addEventListener('change', endSize)
    range.addEventListener('keydown', beginSize)
    range.addEventListener('keyup', endSize)
    range.addEventListener('input', () => {
      sizeOut.textContent = Number(range.value) + 'px'
      saveLayout({ height: Number(range.value) })
      // ⚠️ 拖滑块的过程中**不要** fitModel()：
      //    它会改 root 的宽高，而滑块就在 root 里，于是轨道跟着变长/变短、
      //    从鼠标底下跑掉 —— 表现就是"滑块拉不动"。等松手（endSize）再一次性应用。
      //    「− / +」按钮走的是 stepSize()，那条路径不受影响（点一下、轨道随即更新，没有拖拽反馈环）。
      if (sizingSize) return
      fitModel(Number(range.value))
      clampPanels()
    })
    label.appendChild(range)
    box.appendChild(label)
    box.appendChild(stepRow)

    // 视线灵敏度：实时生效，直接写进 CFG
    const g0 = gazeCfg()
    const mkGaze = (label, key, min, max, step, value, fmt) => {
      const l = $('label', 'dshp-label')
      l.append($('span', null, label))
      const r = document.createElement('input')
      r.type = 'range'
      r.min = String(min); r.max = String(max); r.step = String(step)
      r.value = String(value)
      const out = $('span', null, fmt(Number(r.value)))
      out.style.minWidth = '38px'
      out.style.textAlign = 'right'
      out.style.opacity = '.7'
      r.addEventListener('input', () => {
        CFG[key] = Number(r.value)
        persistCfg()
        out.textContent = fmt(Number(r.value))
      })
      l.append(r, out)
      return l
    }
    box.append(
      $('div', 'dshp-hint', '视线灵敏度'),
      mkGaze('跟随幅度', 'gazeGain', 0, 1, 0.02, g0.gain, (v) => v.toFixed(2)),
      mkGaze('跟随速度', 'gazeRate', 0.3, 4, 0.1, g0.rate, (v) => v.toFixed(1)),
      mkGaze('跟随范围', 'gazeRadius', 0, 2000, 50, g0.radius, (v) => (v <= 0 ? '整屏' : String(v))),
    )

    // ——— 灵动度：三档预设 + 四个细调滑块 ———
    // 预设只是「一组 CFG 推荐值」，所以点完之后滑块照样能拖，拖完自动变「自定义」。
    let liveRow = null
    const presetBtns = LIVELY_PRESETS.map((ps) => {
      const btn = $('button', 'dshp-btn', ps.label)
      btn.title = ps.note
      btn.addEventListener('click', () => {
        applyLivelyPreset(ps.key)
        syncLivelyUI()
        clampPanels()
      })
      return [ps.key, btn]
    })
    const customChip = $('span', 'dshp-hint', '自定义')
    customChip.style.marginLeft = '6px'
    liveRow = $('div', 'dshp-row')
    for (const [, b] of presetBtns) liveRow.appendChild(b)
    liveRow.appendChild(customChip)
    const liveNote = $('div', 'dshp-hint', '')

    // 登记每个细调滑块的 (key, input, out, fmt)，供套用预设时回写显示。
    // ⚠️ 为什么必须登记：滑块的值是**建面板时快照**的，而预设会直接改 CFG。
    //    不回写的话，点了「明显更活泼」虽然真的生效了（localStorage 里 CFG 已变），
    //    但面板上四个滑块会继续显示旧值 —— 面板在骗人，比没做还糟。
    const liveRows = []
    const mkLive = (label, key, min, max, step, fmt) => {
      const l = $('label', 'dshp-label')
      l.append($('span', null, label))
      const r = document.createElement('input')
      r.type = 'range'
      r.min = String(min); r.max = String(max); r.step = String(step)
      const cur = Number(CFG[key])
      r.value = String(isFinite(cur) ? cur : min)
      const out = $('span', null, fmt(Number(r.value)))
      out.style.minWidth = '38px'
      out.style.textAlign = 'right'
      out.style.opacity = '.7'
      r.addEventListener('input', () => {
        CFG[key] = Number(r.value)
        syncIdleLevel()
        persistCfg()
        out.textContent = fmt(Number(r.value))
        syncLivelyUI()
      })
      l.append(r, out)
      liveRows.push({ key: key, input: r, out: out, fmt: fmt })
      return l
    }
    const liveSliders = [
      mkLive('待机幅度', 'idleStrength', 0, 2.5, 0.05, (v) => v.toFixed(2)),
      mkLive('活泼度', 'idleLiveliness', -1, 1, 0.05, (v) => v.toFixed(2)),
      mkLive('动作频率', 'idleClipChance', 0, 1, 0.05, (v) => Math.round(v * 100) + '%'),
      mkLive('视线游移', 'gazeDrift', 0, 2.5, 0.05, (v) => v.toFixed(2)),
      mkLive('互动强度', 'idleReactStrength', 0, 2, 0.05, (v) => v.toFixed(2))
    ]
    /** 刷新预设按钮的选中态 + 说明文字（改任一值后都要调） */
    function syncLivelyUI() {
      const key = livelyPresetKey()
      for (const [k, b] of presetBtns) b.classList.toggle('dshp-primary', k === key)
      customChip.style.display = key === 'custom' ? '' : 'none'
      const ps = LIVELY_PRESETS.find((x) => x.key === key)
      liveNote.textContent = ps ? ps.note : '自定义：你手动调过，下面的滑块就是当前值'
      // 把 CFG 的真实值回写到滑块上。
      // 这一步是必须的：预设直接改 CFG，而滑块的显示是建面板时的快照。
      // （曾经漏了这一步：点了预设真的生效了，但滑块还显示旧值 —— 面板在骗人。）
      for (const row of liveRows) {
        const v = Number(CFG[row.key])
        if (!isFinite(v)) continue
        if (String(v) !== row.input.value) row.input.value = String(v)
        row.out.textContent = row.fmt(v)
      }
    }
    syncLivelyUI()
    // 详细面板：设置页只放「大类」滑块，这里单独展开细到每个行为 / 每段小戏
    const detailRow = $('div', 'dshp-row')
    const detailBtn = $('button', 'dshp-btn', '详细面板…')
    detailBtn.title = '单独调每个待机行为 / 每段小戏的频率；改完立即生效、自动保存'
    detailBtn.addEventListener('click', openTuningPanel)
    detailRow.appendChild(detailBtn)
    box.append(
      $('div', 'dshp-hint', '灵动度（想更活就点「明显更活泼」，或直接拖下面的滑块）'),
      liveRow,
      liveNote,
      liveSliders[0],
      liveSliders[1],
      liveSliders[2],
      liveSliders[3],
      liveSliders[4],
      detailRow
    )

    // 外观：跟随系统 / 浅色 / 深色 —— 手动档位覆盖系统设置，选择记在本地
    const themeRow = $('div', 'dshp-row')
    const themeBtns = [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([v, label]) => {
      const btn = $('button', 'dshp-btn', label)
      btn.addEventListener('click', () => {
        for (const [val, b] of themeBtns) b.classList.toggle('dshp-primary', val === v)
        if (v === 'auto') {
          delete ui.root.dataset.dshpTheme
          saveLayout({ theme: null })
        } else {
          ui.root.dataset.dshpTheme = v
          saveLayout({ theme: v })
        }
        clampPanels()
      })
      return [v, btn]
    })
    const savedTheme = (() => {
      try {
        return readLayout().theme || 'auto'
      } catch (err) {
        return 'auto'
      }
    })()
    for (const [val, b] of themeBtns) b.classList.toggle('dshp-primary', val === savedTheme)
    themeRow.append(...themeBtns.map(([, b]) => b))

    const row1 = $('div', 'dshp-row')
    const eyeBtn = $('button', 'dshp-btn', CFG.lookAtCursor ? '视线跟随：开' : '视线跟随：关')
    eyeBtn.addEventListener('click', () => {
      CFG.lookAtCursor = !CFG.lookAtCursor
      persistCfg()
      eyeBtn.textContent = CFG.lookAtCursor ? '视线跟随：开' : '视线跟随：关'
    })
    const mouthBtn = $('button', 'dshp-btn', CFG.talkMouth ? '说话口型：开' : '说话口型：关')
    mouthBtn.addEventListener('click', () => {
      CFG.talkMouth = !CFG.talkMouth
      persistCfg()
      mouthBtn.textContent = CFG.talkMouth ? '说话口型：开' : '说话口型：关'
    })
    // 系统声音感知：关掉后外壳不再起 PowerShell 轮询（见 shell/src/audio.js）
    const soundBtn = $('button', 'dshp-btn', CFG.suddenAudio === false ? '系统声音：关' : '系统声音：开')
    soundBtn.title = '安静 5 分钟后突然有声音，她会竖起耳朵；睡着时会惊醒。\n关掉后外壳不再轮询系统音量（省一个后台进程）'
    soundBtn.addEventListener('click', () => {
      CFG.suddenAudio = CFG.suddenAudio === false
      persistCfg()
      soundBtn.textContent = CFG.suddenAudio === false ? '系统声音：关' : '系统声音：开'
      syncAudioMeter()
    })
    row1.append(eyeBtn, mouthBtn, soundBtn)

    // 连接哪一个 DSH：自动 / 桌面版 / 网页版
    //
    // ⚠️ 2026-10-17 独立化之后：外壳自己起本地服务提供页面，并自己发现/维持 DSH 连接
    // （见 shell/src/petserver.js）。页面这边**没有选择权**了，
    // 所以 BOOT.local 为真时只报状态、不摆三个按钮 —— 摆着却点不动就是「面板在骗人」。
    const hostRow = $('div', 'dshp-row')
    const localHost = (() => {
      try {
        return !!(window.__DSH_PET_BOOT__ || {}).local
      } catch (err) {
        return false
      }
    })()
    const hostNow = (() => {
      try {
        const b = window.__DSH_PET_BOOT__ || {}
        if (localHost) {
          if (!link.online) return '未连上 DSH（只有对话不可用，其他照常）'
          return '已连上 DSH' + (link.port ? ' · ' + link.port : '')
        }
        const kind = b.desktop ? '桌面版' : b.port ? '网页版' : '未知'
        return kind + (b.port ? ' · ' + b.port : '')
      } catch (err) {
        return '未知'
      }
    })()
    const hostBtns = localHost ? [] : [['auto', '自动'], ['desktop', '桌面版'], ['web', '网页版']].map(([v, label]) => {
      const b = $('button', 'dshp-btn', label)
      b.addEventListener('click', () => {
        for (const [, x] of hostBtns) x.classList.remove('dshp-primary')
        b.classList.add('dshp-primary')
        try {
          if (shell.on) shell.post('host:' + v)
          ui.bubble.show('好，下次连' + (v === 'auto' ? '自动挑' : v === 'desktop' ? '桌面版' : '网页版'), {
            name: 'DS 鲸鱼娘',
            ttl: 2200,
          })
        } catch (err) {}
      })
      return [v, b]
    })
    hostRow.append(...hostBtns.map(([, b]) => b))
    // 独立外壳里那三个「连哪个宿主」的按钮没有意义了（连接由外壳自己照看），
    // 换成一行状态 + 一个「重新连 DSH」—— 否则想让她立刻重试只能去翻托盘。
    // ⚠️ 注意：hostRow 在独立模式下**根本没进 DOM**（下面只 append hostHint），
    // 所以这个按钮必须挂到自己的一行上 —— 第一版挂在 hostRow 上，实测点了没反应。
    const linkRow = $('div', 'dshp-row')
    if (localHost) {
      const retry = $('button', 'dshp-btn', link.online ? '重新连 DSH' : '连一下 DSH')
      retry.addEventListener('click', () => {
        try {
          if (shell.on) shell.post('link-retry')
        } catch (err) {}
        ui.bubble.show('好，我再找一下 DSH…', { name: 'DS 鲸鱼娘', ttl: 2000 })
      })
      linkRow.append(retry)
    }
    const hostHint = $(
      'div',
      'dshp-hint',
      (localHost ? (link.online ? '● ' : '○ ') : '当前：') + hostNow +
        (localHost ? '（连接由外壳自动照看，托盘里能关掉）' : shell.on ? '' : '（网页版里改不了，去桌面客户端改）'),
    )
    // 壳子加载后会调 DSHPet.setHostPref() 告诉我们它记着的是哪一档
    window.__dshpSetHostPref = (v) => {
      for (const [val, b] of hostBtns) b.classList.toggle('dshp-primary', val === v)
    }

    const row0 = $('div', 'dshp-row')
    const resetAll = $('button', 'dshp-btn dshp-primary', '一键重置所有状态')
    resetAll.addEventListener('click', () => {
      resetEverything()
      renderPane('setting')
      ui.bubble.show('回到平常状态啦', { name: 'DS 鲸鱼娘', ttl: 2200 })
    })
    row0.appendChild(resetAll)
    if (!localHost) box.append(hostRow)
    if (localHost) box.append(linkRow)
    box.append(hostHint, themeRow, row0)

    const row2 = $('div', 'dshp-row')
    const reset = $('button', 'dshp-btn', '回到角落')
    reset.addEventListener('click', () => {
      for (const k of ['left', 'top', 'right', 'bottom']) ui.root.style[k] = ''
      saveLayout({ x: null, y: null })
      applyPosition(readLayout())
    })
    const hide = $('button', 'dshp-btn', shell.on ? '隐藏桌宠（缩成贴边小球）' : '隐藏桌宠（右下角把手叫回来）')
    hide.addEventListener('click', () => {
      closePanels()
      setHidden(true)
    })
    row2.append(reset, hide)
    if (shell.on) {
      const row3 = $('div', 'dshp-row')
      const toBall = $('button', 'dshp-btn', '收起成悬浮小球')
      toBall.addEventListener('click', () => {
        closePanels()
        setHidden(true)
      })
      const quitApp = $('button', 'dshp-btn', '彻底关闭桌宠应用')
      quitApp.addEventListener('click', () => {
        ui.bubble.show('人家先退下了，想叫我就去「应用程序」里双击我～', { name: 'DS 鲸鱼娘', ttl: 2000 })
        setTimeout(() => shell.post('quit'), 220)
      })
      row3.append(toBall, quitApp)
      box.append(row3)
    }
    // ——— 调试：睡眠 ———
    // 走的就是 beginSleep/wakeUp，不另写一套；按钮不是 .dshp-chip，
    // 不会被「睡着时点菜单先走过场」的捕获逻辑拦住。
    const sleepRow = $('div', 'dshp-row')
    const sleepText = sleepDebugText()
    const sleepBtn = $('button', 'dshp-btn', sleepText.btn)
    sleepBtn.title = sleepText.title
    sleepBtn.addEventListener('click', () => {
      if (idle.sleep) wakeUp('debug')
      else beginSleep('debug')
      // beginSleep/wakeUp 里都会 sync；这里再调一次是防止状态没变时按钮文案落后
      syncSleepDebugUI()
    })
    sleepRow.appendChild(sleepBtn)
    const sleepHint = $('div', 'dshp-hint', sleepText.hint)
    // 面板重建后把引用换到新节点（旧节点已从 DOM 断开，sync 会自己跳过）
    sleepDebugUI = { btn: sleepBtn, hint: sleepHint }
    box.append(
      row1,
      row2,
      $(
        'div',
        'dshp-hint',
        '拖动可以换位置；右键或 ⋯ 叫出菜单；双击直接开输入框。\n表情平时由她自己挑——你在这里选只是 30 秒的临时心情，她遇到正事会自己换回来。',
      ),
    )
    // 调试区放最底下：平时不看它，做睡眠/唤醒观感时才用
    // 听觉调试：重置 burst 冷却（不用等 5 分钟就能再试一次）
    const audioHint = $('div', 'dshp-hint', audioDebugText())
    const audioRow = $('div', 'dshp-row')
    const audioBtn = $('button', 'dshp-btn', '重置听觉感知（调试）')
    audioBtn.title = '清掉 burst 冷却并立刻武装：下一次持续 ≥0.8 秒的声音就会触发（醒着竖耳朵 / 睡着惊醒）'
    audioBtn.addEventListener('click', () => {
      const ok = resetAudioBurst()
      audioHint.textContent = audioDebugText()
      ui.bubble.show(ok ? '听觉感知已重置，下次有声音我就竖耳朵～' : '听觉感知不可用', { name: 'DS 鲸鱼娘', ttl: 2200 })
    })
    audioRow.appendChild(audioBtn)
    box.append(
      $('div', 'dshp-hint', '调试（不用等 3 分钟 / 5 分钟，也不用开调试口）'),
      sleepRow,
      sleepHint,
      audioRow,
      audioHint,
    )
    panes.appendChild(box)
    // 换页后面板高度会变，可能顶到屏幕外面去（立刻夹一次 + 下一帧兜底）
    clampPanels()
    requestAnimationFrame(() => clampPanels())
  }

  // ——————————————————————————————————————————————————————————————
  // 十、agent 事件 → 表演
  // ——————————————————————————————————————————————————————————————

  const agent = {
    status: 'idle',
    turn: 0,
    step: 0,
    toolProp: null,
    lastActivity: Date.now(),
    sleeping: false,
    hasStream: false,
    lastText: '',
    tokens: 0,
  }

  /**
   * 「她连没连上 DSH」——独立化（2026-10-17）之后这件事由外壳负责，页面只能被动知道。
   * 网页版（DSH 的 index.html 里注入的那份）永远收不到 link 事件，所以 known 保持 false。
   */
  const link = { known: false, online: false, port: null }

  /**
   * 记下连接状态。
   * ⚠️ 断线时必须把她从「思考中」放回 idle —— 否则 DSH 被关掉以后，
   * 她会永远停在最后一次真实事件的表情上（看起来像卡住了），而这是最容易让人误判成 bug 的现象。
   */
  function noteLink(online, port) {
    const was = link.online
    link.known = true
    link.online = !!online
    link.port = port || null
    if (!link.online && was) {
      agent.status = 'idle'
      agent.sleeping = false
      agent.hasStream = false
    }
    // 设置页正开着就顺手刷新那一行「当前：…」，别让面板显示过时状态
    try {
      if (ui && ui.menu && ui.menu.el && ui.menu.el.classList.contains('dshp-on') && ui.menu.focused === 'setting') {
        requestAnimationFrame(() => {
          try {
            if (ui.menu.el.classList.contains('dshp-on') && ui.menu.focused === 'setting') renderPane('setting')
          } catch (e) {}
        })
      }
    } catch (e) {}
  }

  function connectSSE() {
    let es = null
    let retry = 0
    const open = () => {
      es = new EventSource(BASE + '/events')
      es.onopen = () => {
        retry = 0
        log('事件流已连接')
      }
      es.onmessage = (ev) => {
        let msg
        try {
          msg = JSON.parse(ev.data)
        } catch (e) {
          return
        }
        try {
          handleEvent(msg)
        } catch (err) {
          console.warn('[鲸鱼娘] 事件处理出错', msg && msg.t, err)
        }
      }
      es.onerror = () => {
        try {
          es.close()
        } catch (e) {}
        retry++
        setTimeout(open, Math.min(10000, 800 * retry))
      }
    }
    open()
  }

  function setStatus(next) {
    if (agent.status === next) return
    // 状态从「空闲」切走 = 真实工作开始了 → 立刻收掉正在演的待机小戏。
    // 放在这里而不是只靠 scriptTick 的守卫：那是 40ms 后才生效，
    // 而真实事件可能在这 40ms 内推一堆东西进来（本项目记过「演到一半卡住」）。
    if (next !== 'idle') abortIdleScript()
    agent.status = next
    agent.lastActivity = Date.now()
    idle.lastDshAt = performance.now() // 睡眠计时用的性能时钟（别混 Date.now）
    agent.sleeping = false
  }

  function handleEvent(m) {
    switch (m.t) {
      case 'hello':
        agent.status = m.status || 'idle'
        // 独立外壳的本地服务会在 hello 里一并报「有没有连上 DSH」
        if (m.local) noteLink(m.link === 'online', m.port)
        break

      // 独立外壳：DSH 连上 / 断开时各推一条（见 shell/src/petserver.js 的 linkEvent）
      case 'link':
        noteLink(!!m.online, m.port)
        break

      // 外壳的 WASAPI 峰值（shell/src/audio.js，每 250ms 一条）
      case 'audio':
        idle.audio.peak = Math.max(0, Math.min(1, Number(m.peak) || 0))
        idle.audio.at = performance.now()
        break

      case 'user':
        setStatus('listening')
        idle.lastDshAt = performance.now() // 状态没变时 setStatus 会提前返回，这里补一下
        rig.talking = false
        stopActing()
        setBase('listening', IDLE_PROPS)
        clearToolProp()
        // 睡着时插一段「懵」的过场（keepBase：别把刚切好的 listening 底脸盖回 neutral）
        wakeUp('dsh', { keepBase: true })
        ui.bubble.show(String(m.text || '').slice(0, 300), { name: '你', ttl: 3500 })
        break

      case 'turn-start':
        agent.turn = m.turn
        agent.hasStream = false
        agent.lastText = ''
        agent.tokens = 0
        setStatus('thinking')
        rig.talking = false
        startWork()
        stopActing()
        setBase('thinking', WORK_PROPS)
        ui.bubble.show(pick(SAY.start), { name: 'DS 鲸鱼娘', busy: true, sticky: true })
        break

      case 'step-start':
        agent.step = m.step
        setStatus('thinking')
        rig.talking = false
        if (!ui.bubble.visible) {
          ui.bubble.show(pickFresh(SAY.thinking, 'thinking'), { name: 'DS 鲸鱼娘', busy: true, sticky: true })
        } else {
          ui.bubble.note('正在思考 · 第 ' + m.step + ' 步')
        }
        break

      case 'delta':
        if (m.kind === 'reasoning' && !CFG.showReasoning) return
        agent.lastActivity = Date.now()
        idle.lastDshAt = performance.now()
        if (!agent.hasStream) {
          agent.hasStream = true
          setStatus('speaking')
          rig.talking = true
          agent.streamText = ''
          setBase('happy', WORK_PROPS)
          ui.bubble.show('', { name: 'DS 鲸鱼娘', stream: true, sticky: true })
        }
        // 累积文本（只留尾巴 400 字，够判最后一句，也不让内存无限涨）
        agent.streamText = (agent.streamText || '') + String(m.text || '')
        if (agent.streamText.length > 400) agent.streamText = agent.streamText.slice(-400)
        // 语气：每来一小段就重判一次 —— 逐字判太浪费，而「句尾才出现问号」这件事
        // 意味着必须持续更新，不能只在开头判一次。
        if (typeof DSHPetTalkTone !== 'undefined' && DSHPetTalkTone) {
          rig.talkTone = DSHPetTalkTone.classify(agent.streamText)
        }
        ui.bubble.show(m.text || '', { stream: true, sticky: true })
        break

      case 'assistant':
        agent.hasStream = false
        rig.talking = false
        if (m.interrupted) break
        if (m.text) {
          setStatus('speaking')
          agent.lastText = m.text.slice(0, 4000)
          // 说完最后一整句时再判一次语气（流式那一刻可能还没有句末标点）
          if (typeof DSHPetTalkTone !== 'undefined' && DSHPetTalkTone) {
            rig.talkTone = DSHPetTalkTone.classify(agent.lastText)
          }
          ui.bubble.show(agent.lastText, { name: 'DS 鲸鱼娘', sticky: true })
        }
        if (m.usage) {
          const t = (m.usage.input || 0) + (m.usage.cache || 0) + (m.usage.output || 0)
          agent.tokens = (agent.tokens || 0) + t
          ui.bubble.note('本轮 ' + t.toLocaleString() + ' tokens')
        }
        break

      case 'tool-call': {
        setStatus('working')
        rig.talking = false
        const react = TOOL_REACT[m.name] || { mood: 'reading', prop: 'glassesRound' }
        stopActing() // 切模式前先把一次性表演收掉
        // 阅读类才低头看本子
        gaze.biasTarget = react.mood === 'reading' ? -0.32 : 0
        const isDevice = DEVICE_TOOLS.has(m.name)
        // 常态：本子 + 笔。查资料时**笔换成手机**（把手里的笔放下，掏出小设备），
        // 看完自动关掉、把笔换回来。用的都是模型自带素材，不自己编。
        const propKey = react.prop === 'auto' ? randomGlasses() : react.prop
        setBase(
          react.mood,
          isDevice ? [] : WORK_PROPS.concat(propKey ? [propKey] : []),
        )
        if (isDevice) {
          if (!device.out) {
            device.out = true
            playMotion('openLid')
          }
        } else if (device.out) {
          putDeviceAway()
        }
        gazeDetach(1400)
        // 台词按工具轮换（同一个工具连着用也不会重复），第二行是**具体在干什么**，
        // 脚注标出工具名——这样 Agent 里在跑什么，桌宠这边能同步看出来。
        const pool = TOOL_LINE[m.name] || (react.lean ? SAY.reading : SAY.working)
        const line = pickFresh(pool, 'tool-' + m.name)
        const hint = toolHint(m.args)
        ui.bubble.show(line + (hint ? '\n' + hint : ''), {
          name: 'DS 鲸鱼娘',
          busy: true,
          sticky: true,
        })
        ui.bubble.note(m.label || m.name)
        break
      }

      case 'tool-result':
        clearToolProp()
        if (m.error) {
          // 出错才有「黑脸」——而且很快就结束，不会一直挂着
          // 工具报错只是「黑一下脸」，很短，而且不叠任何别的东西
          act({
            mood: 'gloomy',
            props: [],
            exclusive: true,
            line: '（脸黑了）这个工具报错了：' + (m.error.name || m.error.code || '未知'),
            ms: 1600,
          })
        } else {
          setStatus('thinking')
          stopActing()
          putDeviceAway()
          setBase('thinking', WORK_PROPS)
        }
        break

      case 'hud-turn': {
        // 宿主已经把这一轮的账算好了，直接弹（比再去拉一次接口更快也更准）
        if (m.turn) {
          hud.turn = Object.assign({ ok: true }, m.turn)
          hud.seq = m.turn.seq || hud.seq
          if (!hud.data) hudFetch(false)
          else hudRender()
        }
        break
      }

      case 'turn-end': {
        const kind = (m.reason && m.reason.kind) || m.reason || 'completed'
        rig.talking = false
        agent.hasStream = false
        clearToolProp()
        setStatus('idle')
        endWork()
        // ★ 关键：一轮结束必须把**底层状态**也复位成「平常」。
        // 之前只做了 setStatus('idle')，底层还停在最后那个工具的脸
        // （比如「调皮」会闭一只眼），于是看起来就像「平常动作被挤眼睛占住了」。
        setBase('neutral', IDLE_PROPS)

        // 宿主通常已经推了 hud-turn（那条会立刻弹）；这里只是兜底，晚一点再拉一次余额。
        hudPopTurnEnd()

        const secs = m.ms ? (m.ms / 1000).toFixed(1) + 's' : ''
        const stat = []
        if (secs) stat.push(secs)
        if (m.tokens) stat.push(m.tokens.toLocaleString() + ' tokens')

        if (kind === 'completed') {
          // 庆祝：开心脸 + 一句台词 + 一个纯 CSS 的「蹦一下」。
          // 刻意**不播 aidale**：那个「伸展」动作内部驱动 15 个表情参数
          // （呆呆眼/哭/开心/晕晕/感叹号），一播就会同时点亮好几个表情，
          // 看起来就是「砸完头之后表情全乱了」。qBounce 不碰任何模型参数。
          qBounce(1.2)
          // 文字留在气泡里；过两秒多再把结束台词接上。
          const keepText = ui.bubble.visible && !!agent.lastText
          act({
            mood: 'happy',
            props: [],
            line: keepText ? null : pickFresh(SAY.done, 'done') + (stat.length ? '\n' + stat.join(' · ') : ''),
            ms: 3000,
          })
          if (keepText) {
            if (stat.length) ui.bubble.note(stat.join(' · '))
            setTimeout(() => {
              if (agent.status !== 'idle') return
              ui.bubble.show(pickFresh(SAY.done, 'done'), { name: 'DS 鲸鱼娘', ttl: 4200 })
            }, 2800)
          }
        } else if (kind === 'aborted') {
          act({ mood: 'sad', line: pickFresh(['诶…人家还没做完呢', '被打断了…'], 'abort'), ms: 2800 })
        } else if (kind === 'error') {
          const em = (m.reason && m.reason.error && m.reason.error.message) || '出错了'
          act({
            mood: pick(['sweat', 'sad']),
            line: pickFresh(SAY.fail, 'fail') + '\n' + String(em).slice(0, 160),
            ms: 3200,
          })
        } else {
          act({ mood: 'pout', ms: 2600 })
        }
        break
      }

      case 'subagent':
        if (m.active && ui.bubble.visible) ui.bubble.note('分身也在干活…')
        break

      case 'approval':
        if (m.state === 'asked') {
          act({ mood: 'confused', line: '需要你点一下确认', props: WORK_PROPS, ms: 8000 })
        } else {
          act({ mood: 'happy', ms: 2600 })
        }
        break

      case 'control':
        handleControl(m)
        break
    }
  }


  /** 干活时顺手戴的道具，一轮结束就摘掉；用户自己戴的不动。 */
  /**
   * 上一版「手动戴/摘工具道具」的遗留。现在道具由 base/override/user 三层解析，
   * 一次性道具随 override 一起过期，不存在「忘了摘」的情况；保留成空操作只是
   * 为了少改调用点。
   */
  function clearToolProp() {}

  /** 外部（用户菜单，或 agent 自己调 /dsh-pet/control）驱动的表演。 */
  function handleControl(m) {
    if (m.clearProps) clearProps()
    if (m.props && typeof m.props === 'object') {
      for (const [k, v] of Object.entries(m.props)) setProp(k, !!v)
    }
    if (m.expression !== undefined) {
      rig.face = m.expression === null || !EXPR[m.expression] ? null : m.expression
      mood = 'custom'
      rig.dirty = true
    }
    if (m.mood != null || m.expression) {
      act({ mood: m.mood, face: m.expression, ms: m.bubbleMs || 5000 })
    }
    if (m.motion) playMotion(m.motion)
    const text = m.say || m.bubble
    if (text) ui.bubble.show(String(text), { name: 'DS 鲸鱼娘', ttl: m.bubbleMs || 5000 })
    // 工作简报（/dsh-pet/control 的 report 字段）：头顶挂信封，点开是大号面板
    if (m.report) {
      try {
        const r = m.report
        if (Array.isArray(r)) pushReport(String(r[0] || '工作简报'), String(r[1] || ''))
        else if (typeof r === 'string') pushReport('工作简报', r)
        else pushReport(String(r.title || '工作简报'), String(r.body || r.text || ''))
      } catch (err) {}
    }
    if (m.attention) {
      ui.root.classList.add('dshp-open')
      setTimeout(() => closePanels(), 3000)
    }
  }

  // ——————————————————————————————————————————————————————————————
  // 十一、待机小动作
  // ——————————————————————————————————————————————————————————————

  /**
   * 待机大脑。
   *
   * 这是「她自己会动」的来源——用户明确说过不想自己一个个去点表情，
   * 要她闲着自己动一动。所以按权重随机挑事情做：
   *
   *   · 大部分时间只是看看别处、换个姿势、偶尔换个表情（很快收回）
   *   · 吹泡泡糖是稀有事件（权重 2/100），不再是主旋律
   *   · 长时间没人理 → 打哈欠 → 打瞌睡（渐进式，鼠标一动就醒）
   *
   * 权重表就是性格；想让她更活泼就调大 motion 类，想更安静就调大 glance。
   */
  /**
   * 待机行为权重表。
   *
   * 待机就是「拿着板夹、平常脸、等命令」——动效只可能在「点击」或「工作事件」
   * 里出现，每个动作配它自己那套台词，且不会乱冒。
   *
   * 所以这里只剩三类：看别处、自己换个表情（几秒收回）、说句话。
   */
  /*
   * 灵动度预设（设置面板的「灵动度」三个按钮）。
   *
   *   所以把两种典型手感做成预设，一键切换，再配滑块细调。
   *   预设本身没有隐藏状态，它只是**一组 CFG 推荐值**，点完仍可逐个改。
   *
   *   quiet  安静但有存在感：大部分时间不动，但每隔一会儿有个**看得见**的小动作
   *   normal 常态（默认）：节奏与上游接近，但 glance 已压低、动作低频放开
   *   lively 明显更活泼：动作频繁、表情多变、视线游移大，像个坐不住的家伙
   *
   * 判定「当前是哪个预设」：看这几个 CFG 值是否与预设完全一致 —— 所以
   *   你一旦手动拖了任一滑块，就自动变成「自定义」，不会假装还在某个预设里。
   */
  const LIVELY_PRESETS = [
    {
      key: 'quiet',
      label: '安静但有存在感',
      note: '大部分时间安静，但每隔一会儿有个看得见的小动作',
      cfg: { idleLiveliness: -0.55, idleStrength: 0.8, idleClipChance: 0.3, gazeDrift: 0.8, idleReactStrength: 0.6 }
    },
    {
      key: 'normal',
      label: '常态',
      note: '默认。节奏接近上游，但发呆权重已压低、动作低频放开',
      cfg: { idleLiveliness: 0, idleStrength: 1, idleClipChance: 0.35, gazeDrift: 1, idleReactStrength: 1 }
    },
    {
      key: 'lively',
      label: '明显更活泼',
      note: '动作频繁、表情多变、视线游移大',
      cfg: { idleLiveliness: 0.8, idleStrength: 1.6, idleClipChance: 0.6, gazeDrift: 1.5, idleReactStrength: 1.5 }
    }
  ]
  /** 当前 CFG 落在哪个预设上（全等才算；手动改过就是自定义） */
  function livelyPresetKey() {
    for (const ps of LIVELY_PRESETS) {
      let same = true
      for (const k of Object.keys(ps.cfg)) {
        if (Number(CFG[k]) !== Number(ps.cfg[k])) { same = false; break }
      }
      if (same) return ps.key
    }
    return 'custom'
  }
  /** 套用一个预设：写 CFG + 立即生效 + 存档 */
  function applyLivelyPreset(key) {
    const ps = LIVELY_PRESETS.find((x) => x.key === key)
    if (!ps) return null
    for (const k of Object.keys(ps.cfg)) CFG[k] = ps.cfg[k]
    syncIdleLevel()
    persistCfg()
    return ps
  }

  // ——————————————————————————————————————————————————————————————
  // 成套小戏（e）：数据 + 运行时
  // ——————————————————————————————————————————————————————————————

  /*
   * 小戏数据表。
   *
   * 格式：{ name, weight, steps: [{ at: 秒, do, arg }] }
   *   do 只允许 @idle-scripts 的 VERBS 里那几种（clip/face/line/prop/glance/qbounce）
   *   at 必须递增（引擎会断言）
   *
   * ⚠️ 写这里的铁律：**只用原子能力**，不要嵌套 idleExpress / idleFiddle / 睡眠序列 ——
   *    那些各自有独立的定时器和概率，嵌进来会双重触发。
   *
   * 台词从原本就有的池子里挑（SAY.hungry / SAY.idle / SAY.fat），不新增文案资产；
   * 「困了」用的是 `line` 直写，因为它模仿的是睡眠序列里那句哈欠声。
   */
  const IDLE_SCRIPTS = [
    /*
     * 「找点吃的」：先流口水，再点头，最后把心里话说出来。
     * 选它的理由：这是她人设里最稳的一条（爱吃白饭），而且三个原子能力叠起来
     * 读起来确实像「她惦记着吃的」而不是三个随机动作。
     */
    {
      name: '找点吃的',
      weight: 10,
      minGap: 90,
      steps: [
        { at: 0.0, do: 'face', arg: '流口水' },
        { at: 2.2, do: 'clip', arg: '点头' },
        { at: 3.8, do: 'line', arg: 'hungry', key: 'hungry' }
      ]
    },
    /*
     * 「伸个懒腰」：先看一眼，再伸，最后叹一句。
     * 用两段 line（好舒服 → 完事啦）串成一个完整的「伸完懒腰」的收尾，
     * 比只播一个 clip 更像有始有终。
     */
    {
      name: '伸个懒腰',
      weight: 6,
      minGap: 75,
      steps: [
        { at: 0.0, do: 'glance' },
        { at: 1.0, do: 'clip', arg: '伸懒腰' },
        { at: 4.6, do: 'line', arg: '（伸懒腰）唔——' },
        { at: 6.6, do: 'line', arg: '（伸懒腰）完事啦' }
      ]
    },
    /*
     */
    {
      name: '找找主人',
      weight: 8,
      minGap: 100,
      steps: [
        { at: 0.0, do: 'clip', arg: '左顾右盼' },
        { at: 3.4, do: 'clip', arg: '歪头' },
        { at: 5.2, do: 'line', arg: '（东张西望）主人呢？' },
        { at: 7.0, do: 'line', arg: '（左看右看）在哪儿呢' }
      ]
    },
    /*
     * 只用原子能力（glance/face/clip/line）；face 的 soft 由 runScriptAction 统一处理。
     */
    {
      name: '偷看主人',
      weight: 8,
      minGap: 80,
      steps: [
        { at: 0.0, do: 'glance' },
        { at: 1.4, do: 'face', arg: '脸红' },
        { at: 2.6, do: 'clip', arg: '歪头' },
        { at: 4.4, do: 'line', arg: '（偷看）主人在干嘛…' }
      ]
    },
    /*
     * 「找个东西」：左顾右盼 → 疑惑 → 点头 → 嘀咕。
     */
    {
      name: '找个东西',
      weight: 6,
      minGap: 100,
      steps: [
        { at: 0.0, do: 'clip', arg: '左顾右盼' },
        { at: 1.8, do: 'face', arg: '疑惑' },
        { at: 3.6, do: 'clip', arg: '点头' },
        { at: 4.8, do: 'line', arg: '咦，放哪儿了…' }
      ]
    },
    /*
     * 「听见什么」：突然一声 → 愣住 → 东张西望 → 嘀咕。
     * 2026-10-17 起也能被 audioBurst 感知器直接触发（见 REACTIONS.audioBurst 的 kind:'script'）。
     */
    {
      name: '听见什么',
      weight: 7,
      minGap: 90,
      steps: [
        { at: 0.0, do: 'clip', arg: '惊讶' },
        { at: 1.6, do: 'glance' },
        { at: 2.2, do: 'clip', arg: '左顾右盼' },
        { at: 4.2, do: 'line', arg: '（竖起耳朵）什么声音？' }
      ]
    },
    /*
     * 「不想承认」：强调自己不胖，然后自己心虚地嘀咕。
     * 台词取的是人设里那条最经典的（不能被叫胖）。
     */
    {
      name: '不想承认',
      weight: 7,
      minGap: 110,
      steps: [
        { at: 0.0, do: 'face', arg: '生气' },
        { at: 2.4, do: 'line', arg: 'fat', key: 'fat' },
        { at: 4.6, do: 'face', arg: '脸黑' }
      ]
    },
    /*
     * 「困了」：张嘴（哈欠）+ 闭眼 —— 靠「伸懒腰」这个动作顺带做出来，
     * 再配一句直写的哈欠声，最后低头收尾。
     * 这是睡眠序列的「前置小戏」：连续几次之后她就真的睡了（那条逻辑在睡眠序列里，没动）。
     */
    {
      name: '困了',
      weight: 5,
      minGap: 140,
      steps: [
        { at: 0.0, do: 'clip', arg: '伸懒腰' },
        { at: 4.2, do: 'line', arg: '（打了个哈欠）啊——唔…' },
        { at: 6.0, do: 'face', arg: '栗子嘴' }
      ]
    }
  ]

  /** 启动时的数据校验：写错就大声报出来，而不是静默不生效 */
  const SCRIPT_PROBLEMS = DSHPetIdleScripts ? DSHPetIdleScripts.validate(IDLE_SCRIPTS) : ['引擎缺失']
  if (SCRIPT_PROBLEMS.length) log('⚠️ 小戏数据有问题：' + SCRIPT_PROBLEMS.join('；'))

  /** 把引擎返回的动作真正做出来。返回是否成功。 */
  function runScriptAction(a) {
    if (!a) return false
    try {
      if (a.verb === 'clip') {
        // ⚠️ 起手清脸层：小戏的 face 步骤刚切过一张脸（TTL 2.6s），
        //   而 clip 步骤往往紧跟着来 —— 不清的话脸层会**平滑淡出半秒**，
        clearSoftFace()
        return !!playClip(a.arg, { speed: 0.95 + Math.random() * 0.1 })
      }
      if (a.verb === 'face') {
        // 换脸走一次性 override（和 act() 同一条通道），TTL 由小戏的下一次动作或兜底复位收掉
        // soft: true —— 这是她自娱自乐的一层，不该被当成「硬表演」把待机大脑挡死
        //   （实测：不标 soft 时，小戏切完脸之后待机行为全部被 hard-override 挡掉）
        if (!rig.override) setReaction({ face: a.arg, ms: 2600, soft: true })
        return true
      }
      if (a.verb === 'line') {
        // arg 可能是「字面台词」或「SAY 里的池子名」（带 key 表示后者）
        const text = a.key ? pickFresh(SAY[a.key] || [a.arg], 'script-' + a.key) : a.arg
        ui.bubble.show(text, { name: 'DS 鲸鱼娘', ttl: 4200 })
        return true
      }
      if (a.verb === 'prop') return !!(ALL_TOGGLES[a.arg] && (setProp(a.arg, true), true))
      if (a.verb === 'glance') { gaze.nextDrift = 0; return true }
      if (a.verb === 'qbounce') { qBounce(1); return true }
    } catch (e) {}
    return false
  }

  /**
   * 小戏的心跳（挂在 gazeTick 上，不新增定时器）。
   *   · 有真实事件 / 点击 / 睡着了 → 立刻中断
   *   · 否则按时间轴放动作
   */
  function scriptTick(now) {
    const sc = idle.scripts
    if (!sc) return
    if (!sc.running) return
    // 中断条件：agent 开始干活 / 有待机表演插进来 / 她睡着了 / 页面不可见
    // 中断原因要记下来 —— 否则「小戏不走时间轴」只能靠猜（我刚猜了一轮）
    // 只有这四种**必须**中断（她不该在干活的/睡着的时候还在演小戏）：
    const why = (agent.status !== 'idle' && !idle.demo && !idle.scriptManual) ? 'agent-busy'
      : idle.sleep !== 0 ? 'sleep'
      : document.hidden ? 'hidden' : null
    if (why) {
      const name = DSHPetIdleScripts.abort(sc, now)
      if (name) motion.debug.scriptAborted = { name: name, why: why, at: Math.round(now) }
      idle.scriptAbortWhy = why
      idle.scriptManual = false
      return
    }
    //   为什么不杀：一次点击就把整段小戏毁掉太粗暴了；暂停的话，
    //   等那 2~3 秒的 override 过期，小戏会从原来的进度接着演（时间轴按 now 推进，天然支持）。
    //   代价：期间那一步的视觉会被 override 盖住 —— 但小戏后面的步骤照常。
    if (rig.override && !rig.override.soft) {
      idle.scriptAbortWhy = 'paused:override'
      return
    }
    idle.scriptAbortWhy = null
    const acts = DSHPetIdleScripts.frame(sc, now, { holdSec: 0.8, gapSec: 0 })
    for (const a of acts) {
      if (a.verb === 'end') { idle.scriptManual = false; motion.debug.scriptEnd = a.script; continue }
      runScriptAction(a)
      motion.debug.scriptStep = a
    }
  }

  /** 详细面板：按 CFG.scriptWeightScale 缩放每段小戏的随机权重（0 = 不随机出现，菜单仍可手点） */
  function scaledIdleScripts() {
    const scale = CFG.scriptWeightScale
    if (!scale || typeof scale !== 'object') return IDLE_SCRIPTS
    return IDLE_SCRIPTS.map((s) => {
      const k = Number(scale[s.name])
      if (!isFinite(k) || k === 1) return s
      if (k <= 0) return null
      return Object.assign({}, s, { weight: (Number(s.weight) || 1) * k })
    }).filter(Boolean)
  }

  /** 起一段小戏。返回被选中的名字或 null。 */
  function startIdleScript(now) {
    const sc = idle.scripts
    if (!sc || CFG.idleScripts === false) return null
    const chosen = DSHPetIdleScripts.choose(sc, scaledIdleScripts(), now, Math.random)
    if (!chosen) return null
    if (!DSHPetIdleScripts.canStart(sc, chosen, now, 15000)) return null
    DSHPetIdleScripts.start(sc, chosen, now) // 冷却由引擎在结束时上锁（见 start/frame）
    idle.scriptManual = false
    motion.debug.scriptStart = { name: chosen.name, at: Math.round(now) }
    return chosen.name
  }

  /**
   * 演指定小戏。两个入口共用：
   *   · 菜单「小戏」页：不传 opts → 跳过随机/冷却（点了就要看），`manual:true`；
   *   · 感知器桥（`doReaction` kind:'script'）：传 `{manual:false}`，跳过小戏 minGap
   *     （限流交给感知器自己的冷却），且不绕过 agent 忙守卫（真实事件仍会 abort）。
   *     `respectCooldown:true` 仍保留：别的感知器若想套小戏 minGap 可以传。
   */
  function startIdleScriptByName(name, opts) {
    const sc = idle.scripts
    if (!sc || CFG.idleScripts === false) return null
    const def = (IDLE_SCRIPTS || []).find((x) => x && x.name === name)
    if (!def) return null
    const now = performance.now()
    if (opts && opts.respectCooldown && !DSHPetIdleScripts.canStart(sc, def, now, 15000)) return null
    if (sc.running) abortIdleScript()
    DSHPetIdleScripts.start(sc, def, now)
    const manual = !(opts && opts.manual === false)
    idle.scriptManual = manual
    motion.debug.scriptStart = { name: def.name, at: Math.round(now), manual: manual }
    return def.name
  }

  /*
   * 待机行为权重表（基础档）。@idle-rhythm 的三档各有自己的权重向量，
   * 只有 normal 档直接用这张表，所以这里就是「常态下的性格」。
   *
   * ⚠️ 这里每一项都**必须**在 runIdleBehavior 的 switch 里有对应分支，
   *    否则会像上游那样「权重表里有、分支没有 → 永远抽不到、静默失效」。
   *    单测第 7 节会双向断言这一点，别绕过它。
   *
   * 2026-10-16 调整（A+B）：
   *   · glance 46 → 14：它只换视线落点、**几乎没有可见动作**，
   *     实测 42% 的概率「什么都不发生」，是最大的浪费；权重大幅让给看得见的行为。
   *   · 新增 nod / tilt / stretch / tailWag 四个**肢体动作**（这就是「A：放开待机 clip」）。
   *     上游注释写着「待机不放任何动作」，但那是上游为鲸鱼娘定的性格，
   *     本机已确认推翻：待机时低频来一个小动作，是「有生命感」最直接的来源。
   */
  const IDLE_TABLE = [
    ['glance', 8], // 看别处 / 发呆（只动视线，几乎看不到 —— 权重再压一点，让给下面两个）
    ['peer', 5], // 探头张望（2026-10-17）：轻姿态脉冲 + 甩视线，看得见但不抢戏
    ['sway', 5], // 换重心（2026-10-17）：慢速左右挪，身体感最强、却完全不碰脸
    ['script', 14], // 成套小戏（2~4 步连着做，见 IDLE_SCRIPTS）—— 权重给了 12.5%
    ['express', 24], // 自己换个表情，几秒后收回
    ['mutter', 16], // 自言自语（人设台词）
    ['nod', 6], // 点头（肢体动作）
    ['tilt', 6], // 歪头（肢体动作）
    ['stretch', 4],
    ['tailWag', 8], // 甩尾巴（肢体动作）
    ['hungry', 4], // 喊饿
    ['nopang', 2],
  ]
  const IDLE_TOTAL = IDLE_TABLE.reduce((a, b) => a + b[1], 0)

  const idle = {
    sleep: 0,
    /** 睡眠状态机（@sleep-state）：武装 5 秒唤醒 / 换嘴 / 梦话排期 */
    sleepSt: (typeof DSHPetSleep !== 'undefined' && DSHPetSleep) ? DSHPetSleep.makeState() : null,
    sleepWhy: null,
    sleepAt: 0,
    sleepIdleLevel: null,
    lastInputAt: (typeof performance !== 'undefined' ? performance.now() : 0),
    /** DSH 最后一次有事件（等于 agent.lastActivity 的性能时钟版） */
    lastDshAt: (typeof performance !== 'undefined' ? performance.now() : 0),
    nextAt: 0,
    /** 演示模式：忽略 agent 忙闲（见 DSHPet.idleDemo）。刷新即失效 */
    demo: false,
    /** 下一次抽事是否允许播肢体动作（由 idleClipChance 掷骰决定，抽签在排期时做） */
    allowClip: false,
    /** 成套小戏状态（@idle-scripts）。纯数据，时间轴逻辑都在那个纯函数块里 */
    scripts: (typeof DSHPetIdleScripts !== 'undefined' && DSHPetIdleScripts) ? DSHPetIdleScripts.makeState() : null,
    /** 手动从「小戏」页点的这一段：绕过 agent-busy 守卫（真实事件仍会 abort） */
    scriptManual: false,
    /** 互动感知状态（@idle-sensors）。纯数据，判定逻辑都在那个纯函数块里 */
    sensors: DSHPetIdleSensors.makeState(),
    /** 系统声音峰值（外壳每 250ms 推一次：{ peak, at }；force* 是 CDP 调试注入） */
    audio: { peak: 0, at: 0, forcePeak: 0, forceUntil: 0 },
    /** 「突然播放」状态机（@audio-burst） */
    audioBurst: (typeof DSHPetAudioBurst !== 'undefined' && DSHPetAudioBurst) ? DSHPetAudioBurst.makeState() : null,
    /** 待机肢体动作播完的时刻（含淡出）。排期用它留音尾，别在姿势没归零时抽下一件 */
    clipUntil: 0,
    /** 反应窗口到期时刻：这段时间里待机大脑让位（见 idle.allowAct） */
    reactUntil: 0,
    /** 刚醒的过场窗口：这段时间里感知器/待机大脑都让位（见 wakeUp） */
    wakeHoldUntil: 0,
    /** 最后一次光标压在面板上的时刻（睡眠甩动唤醒的 600ms 宽限用） */
    lastPanelAt: 0,
    /** 待机节奏状态（@idle-rhythm）。纯数据，转移逻辑都在那个纯函数块里 */
    rhythm: DSHPetIdleRhythm.makeState(),
  }

  // ——————————————————————————————————————————————————————————————
  // 睡眠（2026-10-17）：睡着 = 闭眼 + 只呼吸 + 偶尔梦话；叫醒靠明确手势
  //
  // 三张睡脸是**隐藏表情**（不进 FACE_MENU，表情页仍是 14 项），见 manifest 的 _sleepNote。
  // ⚠️ 睡脸**只写眼形**（EyeL/ROpen -1），故意不加 PARAM_EXP5：那条素材是 >< 挤眼，
  //    睡着时像在用力闭眼；只写眼形才是自然的闭眼（canvas 实测对比，用 _safe/验证睡眠.mjs 可重跑出图）。
  // 为什么嘴要换：一直挂同一张嘴十几分钟会很假；换嘴的节奏在 @sleep-state。
  // ——————————————————————————————————————————————————————————————
  const SLEEP_FACES = ['睡·流口水', '睡·3嘴', '睡·〇嘴']
  const SLEEP_ONSET_LINE = '（睡着了）呼…'
  const SLEEP_LINES = [
    '（做梦）白饭…再来一碗…',
    '（梦话）不要抢我的饭…',
    '（睡着）呼…呼…',
    '（梦里）主人…别走…',
    '（梦话）今天…也吃饱了…',
    '（睡着）嘿嘿…糖醋鱼…'
  ]

  function sleepFacesUsable() { return SLEEP_FACES.filter((n) => EXPR[n]) }

  /**
   * 换睡脸：**硬切**（旧脸权重直接删掉）。
   * 为什么不能靠默认淡入淡出：两张脸同时在权重里时，嘴部素材（EXP2/EXP7/EXP8）
   * 会叠加约 0.3 秒 —— 观感就是「两张嘴叠在一起」。
   */
  function applySleepFace(idx) {
    const list = sleepFacesUsable()
    if (!list.length) return null
    const name = list[(((Number(idx) || 0) % list.length) + list.length) % list.length]
    for (const n of SLEEP_FACES) rig.weight.delete(n)
    rig.weight.set(name, 1)
    rig.base = { mood: 'sleepy', face: name, props: [] }
    rig.user.face = null
    resolveRig()
    return name
  }

  function clearSleepFace() {
    for (const n of SLEEP_FACES) rig.weight.delete(n)
  }

  /** 光标现在是不是真的在她身上（入睡瞬间判断「已经在身上」用） */
  function pointerOnHer() {
    try {
      return !!(gaze.pointer.seen && hitTest(gaze.pointer.x, gaze.pointer.y) && !overPanels(gaze.pointer.x, gaze.pointer.y))
    } catch (e) { return false }
  }

  /** 设置页调试按钮的当前文案（按钮渲染与实时同步的唯一来源） */
  let sleepDebugUI = null
  function sleepDebugText() {
    if (idle.sleep) {
      return {
        btn: '叫醒她（调试）',
        title: '走真实的 wakeUp：圈圈眼过场，然后回到平常',
        hint: '睡眠调试：她现在**睡着**。只有手势 / 点击 / 菜单 / DSH 消息会叫醒。'
      }
    }
    return {
      btn: '立即进入睡眠（调试）',
      title: '走真实的 beginSleep：立刻闭眼 / 停动作，不用等 3 分钟',
      hint: '睡眠调试：她现在醒着，安静 ' + Math.max(0, Math.round((Number(CFG.sleepAfterMs) || 0) / 1000)) + ' 秒（鼠标 / 键盘 / DSH 都算活动）后会自动睡着。'
    }
  }

  /**
   * 设置页开着时，让调试按钮/提示跟着**真实状态**走。
   *
   * 不会经过这个按钮，面板也不会重建 —— 按钮就会一直显示「叫醒她」，点了才发现她其实醒着。
   * 只改 textContent，不重建面板：设置页很长，重建会把滚动位置弹回顶部。
   */
  function syncSleepDebugUI() {
    const d = sleepDebugUI
    if (!d || !d.btn || !d.btn.isConnected) return
    const t = sleepDebugText()
    if (d.btn.textContent !== t.btn) d.btn.textContent = t.btn
    d.btn.title = t.title
    if (d.hint && d.hint.isConnected && d.hint.textContent !== t.hint) d.hint.textContent = t.hint
  }

  /** 入睡。why 只用于诊断（quiet / debug） */
  function beginSleep(why) {
    if (idle.sleep) return false
    const now = performance.now()
    idle.sleep = 2
    idle.sleepWhy = why || 'quiet'
    idle.sleepAt = now
    if (idle.sleepSt) DSHPetSleep.begin(idle.sleepSt, now, pointerOnHer(), CFG, Math.random)
    // 「不再触发动作」从入睡这一刻生效：收掉正在演的一次性表演 + 小戏
    try { abortIdleScript() } catch (e) {}
    try { stopActing() } catch (e) {}
    idle.reactUntil = 0
    idle.scriptAbortWhy = 'sleep'
    if (idle.sensors) idle.sensors.typing = false
    gaze.biasTarget = 0
    gaze.nextDrift = 0
    applySleepFace(0)
    // 只留呼吸 + 很轻的摇摆：待机层 level 临时压到 55%（醒来由 syncIdleLevel 还原）
    idle.sleepIdleLevel = motion.idle.level
    motion.idle.level = (motion.idle.level || 0) * 0.55
    try { ui.bubble.show(SLEEP_ONSET_LINE, { name: 'DS 鲸鱼娘', ttl: 3600 }) } catch (e) {}
    motion.debug.sleep = { startedAt: Math.round(now), why: idle.sleepWhy, face: rig.face }
    syncSleepDebugUI()
    return true
  }

  function sleepDreamLine() {
    try { ui.bubble.show(pickFresh(SLEEP_LINES, 'sleep-dream'), { name: 'DS 鲸鱼娘', ttl: 4600 }) } catch (e) {}
  }

  /**
   * 叫醒。reason: hover / swish / drag / poke / menu / dsh / debug
   *
   * 过场：先「圈圈眼」懵一下（快速）。纯手势唤醒再按概率追加一个害羞；
   * 菜单动作和 DSH 消息不追加（菜单动作紧接着要执行，DSH 消息要马上进入 listening）。
   *
   * ⚠️ 唤醒是**状态迁移**，不是感知器反应：这里可以写一次性 override；
   *    感知器那条链路（doReaction）仍然绝不碰 override。
   */
  function wakeUp(reason, opts) {
    if (!idle.sleep) return false
    opts = opts || {}
    const now = performance.now()
    idle.sleep = 0
    idle.sleepWhy = null
    if (idle.sleepSt) DSHPetSleep.end(idle.sleepSt)
    idle.reactUntil = 0
    clearSleepFace()
    if (!opts.keepBase) setBase('neutral', IDLE_PROPS)
    // 待机幅度还原：syncIdleLevel 是唯一入口，别手写数字
    idle.sleepIdleLevel = null
    try { syncIdleLevel() } catch (e) {}
    idle.lastInputAt = now
    // 过场动画：快速圈圈眼（「被叫醒的懵」）
    const faceMs = Math.max(200, Number(CFG.sleepWakeFaceMs) || 500)
    if (!rig.override) {
      setReaction({ face: '圈圈眼', ms: faceMs })
      // 硬切进来：被叫醒那一下是「啪」地睁眼，不能慢慢淡入（淡入会吃掉一半时长）
      rig.weight.set('圈圈眼', 1)
    }
    motion.debug.sleepWake = { reason: reason || '?', at: Math.round(now), faceMs: faceMs, keepBase: !!opts.keepBase }
    // 只有「纯手势」唤醒才追加害羞（见函数头注释）
    const shyReasons = { hover: 1, swish: 1, drag: 1, poke: 1 }
    const shyP = Number(CFG.sleepShyChance)
    const shyChance = isFinite(shyP) && shyP >= 0 ? shyP : 0.8
    const shyOn = !!(shyReasons[reason] && Math.random() < shyChance)
    // 刚醒的这几秒别让感知器/待机大脑插进来：过场还没演完就被 hover 反应打断，
    // 观感是「刚睁眼又歪头」。
    idle.wakeHoldUntil = now + (shyOn ? 2900 : Math.max(800, faceMs + 300))
    idle.nextAt = Math.max(idle.nextAt, idle.wakeHoldUntil)
    if (shyOn) {
      setTimeout(() => {
        if (idle.sleep || rig.override) return
        try {
          playClip('害羞', { speed: 1.15 })
          motion.debug.sleepShy = { at: Math.round(performance.now()) }
        } catch (e) {}
      }, faceMs + 80)
    }
    syncSleepDebugUI()
    return true
  }

  /**
   * 睡着时的 40ms 心跳（挂在 sensorTick 里，不新增定时器）。
   * 换嘴 / 梦话 / 唤醒手势都在这里；纯判定在 @sleep-state。
   */
  function sleepTick(now, g) {
    if (!idle.sleep || !idle.sleepSt) return
    const out = DSHPetSleep.frame(idle.sleepSt, { inside: g.inside, near: g.near, vx: g.vx, vy: g.vy }, CFG, now, Math.random)
    if (out.wake) { wakeUp(out.wake); return }
    if (out.face != null) applySleepFace(out.face)
    if (out.dream) sleepDreamLine()
    if (!motion.debug.sleep) motion.debug.sleep = {}
    motion.debug.sleep.last = DSHPetSleep.snapshot(idle.sleepSt, now)
  }

  /**
   * 系统声音的 40ms 心跳（由 sensorTick 调，不新增定时器）。
   * 返回这一帧是否该报「突然播放」。
   */
  function audioTick(now) {
    if (!idle.audioBurst) return false
    const forced = idle.audio.forceUntil > now
    const peak = forced ? idle.audio.forcePeak : (idle.audio.peak || 0)
    const out = DSHPetAudioBurst.frame(idle.audioBurst, { peak: peak }, CFG, now)
    motion.debug.audio = out
    if (!out.burst) return false
    if (CFG.suddenAudio === false) return false
    motion.debug.audioBurst = { at: Math.round(now), peak: +Number(peak).toFixed(3) }
    return true
  }

  /** 清掉 burst 冷却并立刻武装（设置页「重置听觉感知」+ 调试 API 共用） */
  function resetAudioBurst() {
    if (!idle.audioBurst) return false
    idle.audioBurst.started = true
    idle.audioBurst.armed = true
    idle.audioBurst.lastAudibleAt = 0
    idle.audioBurst.playing = false
    idle.audioBurst.since = 0
    idle.audioBurst.lastBurstAt = 0
    idle.audioBurst.bursts = 0
    motion.debug.audioReset = { at: Math.round(performance.now()) }
    return true
  }

  /** 设置页「听觉调试」那行字（渲染 / 点完按钮都调它，只改 textContent） */
  function audioDebugText() {
    if (!idle.audioBurst) return '听觉调试：状态机不可用'
    if (CFG.suddenAudio === false) return '听觉调试：系统声音感知已关（先打开「系统声音」）'
    const st = idle.audioBurst
    if (st.armed) return '听觉调试：已武装 —— 下一次持续 ≥0.8 秒的声音就会触发'
    const cd0 = Number(CFG.audioCooldownMs)
    const cd = isFinite(cd0) && cd0 >= 0 ? cd0 : 300000
    const left = Math.max(0, Math.ceil((cd - (performance.now() - (st.lastBurstAt || 0))) / 1000))
    return '听觉调试：冷却中（约 ' + left + ' 秒）'
  }

  /** 把「系统声音感知」开关告诉外壳：关掉后它不再跑 PowerShell 轮询 */
  function syncAudioMeter() {
    try {
      if (shell.on) shell.post(CFG.suddenAudio === false ? 'audio:off' : 'audio:on')
    } catch (e) {}
  }

  /**
   * 抽一件待机小事。
   * 走 @idle-rhythm 的档位权重（drowsy 偏发呆、lively 偏折腾）；
   * CFG.idleRhythm 关掉时，退回上游那张固定权重表 IDLE_TABLE。
   */
  /** 这一跳的基础权重表（先按「允不允许播肢体动作」过滤） */
  function effectiveIdleTable() {
    const allow = idle.allowClip !== false
    return allow ? IDLE_TABLE : IDLE_TABLE.filter(([k]) => !IDLE_CLIP[k])
  }

  
  function canDoIdle(kind) {
    return true
  }

  /** 详细面板的行为频率表（缺省 null = 全 100%） */
  function idleWeightScale() {
    const v = CFG.idleWeightScale
    return v && typeof v === 'object' ? v : null
  }

  function pickIdleBehavior() {
    const table = effectiveIdleTable().filter(([k]) => canDoIdle(k))
    const scale = idleWeightScale()
    if (CFG.idleRhythm === false || !DSHPetIdleRhythm) {
      let rows = table
      if (scale) {
        rows = table
          .map(([k, w]) => {
            const s = Number(scale[k])
            return [k, w * (isFinite(s) ? s : 1)]
          })
          .filter(([, w]) => w > 0)
      }
      const tot = rows.reduce((a, b) => a + b[1], 0)
      if (!(tot > 0)) return 'glance'
      let r = Math.random() * tot
      for (const [name, w] of rows) {
        r -= w
        if (r <= 0) return name
      }
      return 'glance'
    }
    return DSHPetIdleRhythm.chooseBehavior(idle.rhythm, table, Math.random, canDoIdle, scale)
  }

  /** 待机时自己换个表情，过几秒悄悄收回（除非有真实事件插进来）。 */
  function idleExpress() {
    // 待机时换的表情，**必须是不会改变眼睛大小的**——
    // 开心兴奋（闭眼）、调皮（闭一只眼，就是那个"挤眼睛"）这类
    // 一律不进待机池，只留给点击互动那种明确的场合。
    // 摆一张生气的脸很莫名，换成「流汗」。
    const pool = ['shy', 'confused', 'excited', 'alert', 'tongue', 'sweat', 'love']
    const m = pick(pool)
    const ms = 2200 + Math.random() * 2600
    act({ mood: m, props: IDLE_PROPS, ms, soft: true })
    idle.expressUntil = performance.now() + ms
    // 表情不孤立地挂在脸上：约一半机会配一个**极轻的姿态脉冲**（甩头/探头），
    // 读起来像「她想起什么」，而不是「贴图换了一张」。
    // ⚠️ 这里刻意不播 clip：clip 会抢脸、抢视线，而这是「换表情」这条路径。
    if (Math.random() < 0.45 && DSHPetMotion && DSHPetMotion.idleBurst) {
      DSHPetMotion.idleBurst(motion.idle, Math.random() < 0.5 ? 'flick' : 'lean', { dir: pointerDir(true) })
    }
  }

  /**
   * 抽并执行一件待机小事。返回**实际抽到的行为名**（节奏档要用它做状态转移）——
   * 没抽成（正有表演在放）时返回 null。
   */
  /**
   * 待机时来一个**肢体动作**（这就是「A：放开待机 clip」）。
   *
   * 为什么这四个（点头/歪头/伸懒腰/甩尾巴）而不是全部 14 个动作：
   *   · 交互类（挥手/要抱抱/打招呼）语义上得有人在场，自己冒出来很怪
   *   · 表情类（惊讶/害羞/思考/打哈欠）会抢脸，和 express 行为打架（本项目记过的坑）
   *   · 「左顾右盼」会和视线系统抢方向盘
   *
   * 全部走既有的 playClip（加性偏移、可被打断、走 applyRig 的 delta 管线），
   * 所以不会留下残留姿势，也不会和待机层打架。
   */
  const IDLE_CLIP = {
    nod: '点头',
    tilt: '歪头',
    stretch: '伸懒腰',
    tailWag: '尾巴快摆',
    sway: '换重心' // 2026-10-17：4.4 秒的慢速左右挪，是「身体姿态」最明显的一种
  }
  /**
   * 待机时播一个肢体动作（点头/歪头/伸懒腰/甩尾巴）。
   *
   * ⚠️ 起手必须先**清掉待机自己挂的脸层**（rig.override），理由：
   *   · 手动点菜单走的是 act()，它第一件事就是 stopActing() 清脸层 → 动作干净；
   *   · 随机待机以前只调 playClip，脸层原封不动 → 脸（比如脸红）会和动作叠着，
   *     而脸层的权重是**平滑淡出**（约半秒），这半秒里就是「两套半吊子」：
   *   · 这里清掉之后，两条路径的行为**完全一致**（都从干净状态起动作）。
   *
   *   都不会走到这），所以这里清掉的只会是她自己刚挂的软脸层，不会顶掉真实表演。
   */
  /**
   * 待机/小戏**自己发起**一个肢体动作前的清场：把待机挂在脸上的那一层清掉。
   *
   *   · 手动点菜单走 act()，它第一件事是 stopActing() 清脸层 → 动作干净；
   *   · 待机路径以前不清 → 脸（脸红/圈圈眼…）和动作**叠着**，
   *     而且脸层的权重是**平滑淡出**（约半秒），这半秒就是「两套半吊子」：
   *     眼睑被脸层的 EXP5 抬着没让开、脸红和闭眼同时可见。
   *
   *    而且调用方（runIdleBehavior / scriptTick）都判过「没有硬表演」了。
   * 收成一处：idleClipAction 与小戏的 clip 步骤共用，别再各写一遍。
   */
  function clearSoftFace() {
    if (!rig.override) return false
    if (!rig.override.soft) return false // 硬表演不碰
    stopActing()
    return true
  }

  function idleClipAction(kind) {
    const clip = IDLE_CLIP[kind]
    if (!clip) { idle.clipWhy = 'no-clip-map'; return false }
    if (rig.talking) { idle.clipWhy = 'talking'; return false }
    clearSoftFace() // 起手清掉待机自己挂的脸层（见 clearSoftFace 注释）
    // ⚠️ strength 必须**满**（不能随机降强度）：
    //   实测踩到的真凶 —— 原来写的是 strength: 0.8 + rand*0.2，
    //   而 strength 会**缩放整个动作的偏移量**（sampleTrack 里 v * strength），
    //   于是「闭眼」只到 EXP5 = -0.837、EyeLOpen = -0.837（**没完全闭**），
    //   手动点菜单走的是 playClip(name, {}) → strength 默认 1 → 完全闭上，
    //   所以「手动干净、随机残留」的差异就在这里。
    //
    //   速度可以随机（0.9~1.1 只是节奏差异，不影响幅度），强度不行。
    const name = playClip(clip, { speed: 0.9 + Math.random() * 0.2 })
    idle.clipWhy = name ? 'ok:' + name : 'playClip-failed'
    return !!name
  }

  // ——————————————————————————————————————————————————————————————
  // 互动反应（S2）。
  //
  // ⚠️ 三条硬约束，别绕过：
  //   1. 只做**视觉反应**（clip / face），**不用 act()** —— act 会 stopActing() 清掉
  //      override 层，等于把 agent 的真实表演顶掉。
  //   2. 只在「她空闲（agent 没在干活）且没有 override」时才反应（调用处已判），
  //      这样工作事件一来就能立刻拿回控制权。
  //   3. 反应期间用 idle.reactUntil 让待机大脑让位，避免同一时刻两件事叠在一起。
  //
  // 每个反应自带权重；反应强度（CFG.idleReactStrength）做两件事：
  //   · 缩放「真的反应」的概率（低强度时有一半机会只是看你一眼、什么都不做）
  //   · 缩放冷却时长（低强度 → 冷却更长 → 更少见）
  // ——————————————————————————————————————————————————————————————
  const REACTIONS = {
    // ① 你凑过来了
    hover: [
      { kind: 'clip', arg: '歪头', w: 26, ms: 2000, line: '（歪头）嗯？' },
      { kind: 'clip', arg: '点头', w: 18, ms: 1400 },
      { kind: 'lean', w: 20, ms: 2200 }, // 探头（2026-10-17）：只动姿态，最轻的那一档
      { kind: 'face', arg: '栗子嘴', w: 14, ms: 1600 },
      { kind: 'gaze', w: 12 }, // 只是看你一眼（最低调）
      { kind: 'nothing', w: 10 } // 故意留白：不是每次凑近都要有反应
    ],
    // ② 你盯着看太久 → 她害羞（害羞 clip 自带 PARAM_EXP4 脸红）
    stare: [
      { kind: 'clip', arg: '害羞', w: 45, ms: 2900, line: '别、别看啦…' },
      { kind: 'face', arg: '脸红', w: 25, ms: 2200 },
      { kind: 'clip', arg: '摇头', w: 15, ms: 1800 },
      { kind: 'clip', arg: '歪头', w: 15, ms: 2000 }
    ],
    // ③ 鼠标甩过去 → **只动视线和小幅甩头**，绝不播身体动作
    swoosh: [
      { kind: 'gaze', w: 70 },
      { kind: 'gaze', w: 30, headZ: 3 }
    ],
    // ④ 你在旁边打字
    typing: [
      { kind: 'face', arg: '挤眼', w: 25, ms: 1500 },
      { kind: 'clip', arg: '点头', w: 25, ms: 1400 },
      { kind: 'bubble', arg: '（她安静地陪着你）', w: 20 },
      { kind: 'gaze', w: 30 }
    ],
    // ⑤ 你停下打字 → 抬头看你一眼
    typingStop: [
      { kind: 'clip', arg: '歪头', w: 40, ms: 2000, line: '（抬头）写完了？' },
      { kind: 'gaze', w: 30 },
      { kind: 'face', arg: '生气', w: 15, ms: 1600 },
      { kind: 'nothing', w: 15 }
    ],
    // ⑥ 安静很久后系统突然有声音（@audio-burst）
    //    走「感知器→小戏」桥：直接起「听见什么」；小戏自己的 minGap/中断逻辑负责收尾。
    audioBurst: [
      { kind: 'script', arg: '听见什么', w: 100 }
    ]
  }

  /**
   * 速度太小（只是慢慢挪）时用随机方向 —— 否则每次都是同一个方向，看着像机械。
   */
  function pointerDir(allowRandom) {
    const vx = idle.sensors ? Number(idle.sensors._vx) : NaN
    if (Number.isFinite(vx) && Math.abs(vx) > 40) return vx > 0 ? 1 : -1
    if (!allowRandom) return 1
    return Math.random() < 0.5 ? -1 : 1
  }

  /** 按权重抽一个反应 */
  function pickReaction(pool) {
    if (!pool || !pool.length) return null
    let tot = 0
    for (const r of pool) tot += r.w
    let x = Math.random() * tot
    for (const r of pool) {
      x -= r.w
      if (x <= 0) return r
    }
    return pool[pool.length - 1]
  }

  /** 交互强度（0~2，默认 1）：既控制「反应概率」，也控制冷却长短 */
  function reactStrength() {
    const v = Number(CFG.idleReactStrength)
    return isFinite(v) && v >= 0 ? clamp(v, 0, 2) : 1
  }

  /**
   * 反应的优先级：**只有优先级更高的反应才能接管当前正在播的那个**。
   *
   *   她正在「害羞」（盯着看触发），这时待机大脑抽到「伸懒腰」，
   *   或者另一个感知器又报了别的反应 —— 结果害羞被中途打断。
   *
   * 所以：同优先级或更低的，在占位窗口内一律不接管（她自己会排冷却）；
   * 只有「盯着看」和「停下打字」这两个更明确的信号可以接管「凑近/甩鼠标」。
   */
  const REACT_PRIORITY = { swoosh: 1, hover: 2, typing: 2, typingStop: 3, stare: 3, audioBurst: 3 }

  /**
   * 一次反应要「占住她」多久（毫秒）。
   *
   * ⚠️ 必须按动画的**真实时长**算，不能用固定值：
   *   早先写死 3200ms，而「害羞」clip 本身 2.8 秒、再加淡出，
   *   窗口一过待机大脑立刻抽下一件事 → 害羞被拦腰打断（实测就是这样）。
   * 现在：clip 时长（没取到就按 2000）× 速度 + 300ms 缓冲，再兜一个 2600 底线。
   */
  function reactionHoldMs(name) {
    let ms = 2000
    try {
      const pool = REACTIONS[name]
      if (pool) {
        for (const r of pool) {
          // 感知器桥：script 的占位按小戏真实时长算（不然待机大脑会在第 2 步插进来）
          if (r.kind === 'script' && r.arg && DSHPetIdleScripts) {
            const def = (IDLE_SCRIPTS || []).find((x) => x && x.name === r.arg)
            if (def) ms = Math.max(ms, DSHPetIdleScripts.durOf(def) * 1000 + 300)
            continue
          }
          if (r.kind !== 'clip' || !r.arg || !DSHPetMotion) continue
          const def = DSHPetMotion.getClipDef(r.arg)
          if (def && def.duration) ms = Math.max(ms, def.duration * 1000 + 300)
        }
      }
    } catch (e) {}
    return Math.max(2600, Math.round(ms))
  }

  /**
   * 执行一个反应。返回是否真的做了点什么。
   * 约束：不碰 rig.override、不调 act()、不碰 ParamEyeLOpen（见块首注释）。
   */
  function doReaction(name) {
    const pool = REACTIONS[name]
    if (!pool) return false
    // 诊断：把「抽到哪一条、做了什么」留痕。
    const note = (what) => { idle.lastReaction = { sensor: name, kind: what.kind, arg: what.arg || null, at: Math.round(performance.now()) } }
    // 强度低时有一半机会「只是看你一眼」——避免她显得一惊一乍
    const st0 = reactStrength()
    if (st0 < 1 && Math.random() > 0.35 + 0.65 * st0) { idle.lastReactWhy = 'strength-skip'; return false }
    const r = pickReaction(pool)
    if (!r || r.kind === 'nothing') {
      note(r || { kind: 'nothing' })
      // 留白也是一种反应：只是把视线收回来看着她
      gaze.detachUntil = 0
      gaze.nextDrift = performance.now() + 2500
      return false
    }
    if (r.kind === 'gaze') {
      // 只动视线：强行跟住光标一小会儿（限速器仍是唯一权威）
      gaze.detachUntil = 0
      gaze.nextDrift = performance.now() + 2600
      note(r)
      // 小幅甩头（2026-10-17 换成真的了）。
      // 以前这里复用「点头」clip 凑数，观感是点头、不是甩头 ——
      // 现在待机层开放了 idleBurst（临时根参数脉冲），0.62 秒的甩头不用借任何 clip，
      // 也不会抢脸、不会进 override、不会和「谁先占谁赢」那套优先级打架。
      if (r.headZ) {
        const did = DSHPetMotion && DSHPetMotion.idleBurst
          ? DSHPetMotion.idleBurst(motion.idle, 'flick', { dir: pointerDir(true) })
          : null
        idle.lastFlick = did || null
      }
      return true
    }
    if (r.kind === 'lean') {
      // 探头看你（最轻的姿态反应）：只动 4 个根参数里的两个，什么都不播。
      note(r)
      const did = DSHPetMotion && DSHPetMotion.idleBurst
        ? DSHPetMotion.idleBurst(motion.idle, 'lean', { dir: pointerDir(true) })
        : null
      if (!did) return false
      return true
    }
    if (r.kind === 'script') {
      // 感知器 → 小戏桥：只起小戏，不写 override、不调 act()。
      // 限流用感知器自己的冷却；不套小戏 minGap（否则「刚演过」会把这次反应吃掉）。
      note(r)
      const got = startIdleScriptByName(r.arg, { manual: false })
      return !!got
    }
    if (r.kind === 'clip') {
      note(r)
      playClip(r.arg, { speed: 0.95 + Math.random() * 0.1 })
      if (r.line) ui.bubble.show(r.line, { name: 'DS 鲸鱼娘', ttl: Math.max(1800, r.ms) })
      return true
    }
    if (r.kind === 'face') {
      // 换脸走「一次性 override」会清掉别人的表演，所以这里也用 setReaction ——
      // 但只在确认没有 override 时才调（调用处已判），且用短 TTL。
      note(r)
      if (!rig.override) setReaction({ face: r.arg, ms: r.ms })
      return true
    }
    if (r.kind === 'bubble') {
      note(r)
      ui.bubble.show(r.arg, { name: 'DS 鲸鱼娘', ttl: 4200 })
      return true
    }
    return false
  }

  /**
   * 互动感知的 40ms 心跳（由 gazeTick 调，不新增定时器）。
   * 只在「空闲 + 没有 override」时才会真的反应；否则只更新状态、不动作。
   */
  function sensorTick(now) {
    if (!DSHPetIdleSensors) return
    const st = idle.sensors
    const p = gaze.pointer
    // 速度：用 40ms 的位移估算（px/s）。gazeTick 固定 40ms 一跳，够用且便宜。
    let vx = 0, vy = 0
    if (p.seen && st._px !== undefined) {
      const dt = Math.max(0.016, (now - (st._pt || now)) / 1000)
      vx = (p.x - st._px) / dt
      vy = (p.y - st._py) / dt
    }
    if (p.seen) { st._px = p.x; st._py = p.y; st._pt = now; st._vx = vx }

    // 「凑近」的几何判定：她身体矩形外扩 hoverPad（含 mask 实体判定用 inside 备用）
    let near = false, inside = false
    try {
      const stage = app && app.view && app.view.parentElement
      if (stage && p.seen) {
        const r = stage.getBoundingClientRect()
        if (r.width) {
          const pad = DSHPetIdleSensors.DEFAULTS.hoverPad
          near = p.x >= r.left - pad && p.x <= r.right + pad && p.y >= r.top - pad && p.y <= r.bottom + pad
          if (near) inside = hitTest(p.x, p.y)
        }
      }
    } catch (e) {}

    // 她自己的面板/按钮上不算「在看她」；面板（菜单/输入框/HUD）也一起排除
    let overUi = false
    try { overUi = overDock(p.x, p.y) || overPanels(p.x, p.y) } catch (e) {}
    if (overUi) idle.lastPanelAt = now
    // 「她身边」= 实体包围盒外扩 40px；掩码没建好时退回整个 stage 矩形
    const bodyNear = nearBody(p.x, p.y, 40)
    const swishNear = mask.bbox ? bodyNear : near
    // 刚离开面板的 600ms 内不算甩动：从面板上快速划走时不该把她叫醒
    const panelGrace = now - (idle.lastPanelAt || -1e9) < 600

    // 系统声音「突然播放」（@audio-burst）：睡着时用来惊醒，醒着时走反应池
    const audioBurst = audioTick(now)

    // 睡着：只跑睡眠状态机（5 秒悬停 / 身边甩动 / 换嘴 / 梦话），不做任何互动反应。
    // 放在 idleReact 总开关之前：关掉互动感知也不该让她永远叫不醒。
    if (idle.sleep) {
      if (audioBurst) {
        wakeUp('audio')
        // 醒来过场之后再接「听见什么」：先懵一下，再找声音。
        // ⚠️ 这里**不**尊重小戏自己的 minGap：手动睡/刚演过时 90s 冷却会把这段吃掉；
        //    限流交给 audioBurst 自己的 5min 冷却。
        setTimeout(() => {
          const at = Math.round(performance.now())
          const note = (why, extra) => { motion.debug.wakeScript = Object.assign({ at: at, why: why }, extra || {}) }
          if (idle.sleep) { note('sleep'); return }
          if (rig.override) { note('override'); return }
          const got = startIdleScriptByName('听见什么', { manual: false })
          note(got ? 'started' : 'failed', got ? { name: got } : null)
        }, 900)
        return
      }
      sleepTick(now, { inside: inside && !overUi, near: swishNear && !overUi && !panelGrace, vx: vx, vy: vy })
      if (!motion.debug.sensors) motion.debug.sensors = {}
      motion.debug.sensors.sleeping = true
      return
    }
    if (CFG.idleReact === false) return
    // 刚醒的过场窗口：优先让她把「懵」演完（见 wakeUp）
    if (now < (idle.wakeHoldUntil || 0)) return

    const ev = DSHPetIdleSensors.frame(st, { x: p.x, y: p.y, near: near, inside: inside, overUi: overUi, vx: vx, vy: vy }, CFG, now)
    // 诊断输出（挂在既有的 motion.debug 上，别新开对象）
    if (!motion.debug.sensors) motion.debug.sensors = {}
    motion.debug.sensors = {
      near: ev.near, hover: ev.hover, stare: ev.stare, swoosh: ev.swoosh,
      typing: ev.typing, typingStop: ev.typingStop,
      speed: Math.round(st.speed),
      counts: Object.assign({}, st.counts),
      sleeping: false
    }

    const active = ev.near || (st.typing && now - st.lastTypeAt < 1500)
    if (active && DSHPetIdleSensors.livelyTick(st, now)) {
      if (DSHPetIdleRhythm) DSHPetIdleRhythm.noteActivity(idle.rhythm, now)
    }

    // 真的要做反应吗？——三重守卫（这一层是「不许打扰真实表演」的落点）
    //   · agent 在干活 → 不反应（他正在用 DSH，别去烦他；这正是上游「只有任务表演」的精神）
    //   · 已有 override → 不反应（不抢真实表演的那一层）
    //   · 反应窗口内 → 不反应（同一时刻只做一件事，防叠）
    // idle.demo（诊断用演示模式）可以放行第一条：否则「我做工具调用时 agent 永远不空闲」，
    // 这条链就永远没法端到端验证 —— 和待机大脑是同一个理由。
    idle.sensorGate = (agent.status !== 'idle' && !idle.demo) ? 'agent-busy' : (rig.override ? 'override' : (now < idle.reactUntil ? 'react-window' : 'open'))
    if (agent.status !== 'idle' && !idle.demo) return
    if (rig.override) return
    const which = audioBurst ? 'audioBurst' : ev.stare ? 'stare' : ev.hover ? 'hover' : ev.swoosh ? 'swoosh' : ev.typingStop ? 'typingStop' : ev.typing ? 'typing' : null
    if (!which) return
    // 反应占位窗口内：只有**优先级更高**的反应才能接管，否则放她把这一个演完。
    //   （这就是「感知器触发的动作优先级最高、不被抢」的落点。）
    const holding = now < idle.reactUntil
    if (holding && !(REACT_PRIORITY[which] > (REACT_PRIORITY[idle.reactWho] || 0))) {
      idle.sensorGate = 'react-holding:' + (idle.reactWho || '?')
      return
    }
    // 打字陪伴单独判：它是「持续陪着你」，不该太频繁
    if (which === 'typing') {
      const k = DSHPetIdleSensors.COOLDOWN.typing / Math.max(0.35, reactStrength())
      if (now < (st.hot.typing || 0)) return
      st.hot.typing = now + k
    }
    const cool = (DSHPetIdleSensors.COOLDOWN[which] || 20000) / Math.max(0.35, reactStrength())
    if (now < (st.hot['r-' + which] || 0)) return
    st.hot['r-' + which] = now + cool
    const did = doReaction(which)
    // 诊断：把「做了哪个反应 / 为什么没做」记下来。
    // 没有它就只能靠猜 —— 而这一步连着概率、冷却、守卫三层，猜不动。
    idle.lastReact = { which: which, did: did, at: Math.round(now), holdMs: 0 }
    if (did) {
      // 按动画真实时长占位 —— 让待机大脑（以及更低优先级的感知器）
      // 在她把这一个动作演完之前都别插手。
      const hold = reactionHoldMs(which)
      idle.reactUntil = now + hold
      idle.reactWho = which
      idle.nextAt = Math.max(idle.nextAt, idle.reactUntil)
      idle.lastReact.holdMs = hold
    }
  }

  /**
   * 「互动演示」的本体。
   *
   * 为什么单独提出来：**Shift + 左键**和 API 要走同一条路径 ——
   * 两处各写一份的话，改动只会生效一半（本项目踩过这个坑的多次变体）。
   *
   * 注意它是「启动即返回」：真正的流程在内部的 async 里跑，结果记在
   * idle.demoResult，用 DSHPet.sensorDemoResult() 查。
   * 这样 CDP 的 Runtime.evaluate 能立刻拿到返回值，不用等 20 秒。
   */
  function startSensorDemo() {
    if (idle.demoRunning) return { running: true }
    idle.demoRunning = true
    idle.demoResult = null
    const wasDemo = idle.demo
    idle.demo = true
    const finish = (v) => {
      idle.demoResult = v
      idle.demoRunning = false
      idle.demo = wasDemo
    }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const say = (t) => ui.bubble.show(t, { name: 'DS 鲸鱼娘', ttl: 4200, work: true })
    const log = []
    const run = async () => {
      try {
        const steps = [
          { name: 'hover', label: '① 凑近看了 1.5 秒', wait: 1600 },
          { name: 'stare', label: '② 盯着看了 5 秒', wait: 5000 },
          { name: 'swoosh', label: '③ 甩了一下鼠标', wait: 900 }, // 2026-10-17 起可能带一次真甩头
          { name: 'typingStop', label: '④ 打字后停下了', wait: 900 }
        ]
        say('（互动演示开始～）')
        await sleep(900)
        for (const stp of steps) {
          idle.sensors.hot = {}
          idle.reactUntil = 0
          say('【演示】' + stp.label)
          await sleep(700)
          idle.lastFlick = null // 每一步重置，这样「这一步有没有甩头」不会串到下一步
          const did = doReaction(stp.name)
          const flick = idle.lastFlick
          idle.reactUntil = performance.now() + 3600
          await sleep(stp.wait)
          const rec = idle.lastReaction
          // 甩头是「姿态脉冲」，它不属于 reaction 的 kind —— 单独报出来，
          const flickNote = flick ? ' + 甩头(' + (flick.dir > 0 ? '右' : '左') + ')' : ''
          log.push({ step: stp.name, did: did, reaction: rec ? (rec.kind + (rec.arg ? ':' + rec.arg : '') + (flick ? '+flick' : '')) : null })
          say('【演示】' + stp.label + ' → ' + (rec ? (rec.kind + (rec.arg ? ' ' + rec.arg : '')) : (did ? '做了反应' : '这次留白（什么都没做）')) + flickNote)
          await sleep(1500)
        }
        const summary = log.map((x) => x.step + '=' + (x.reaction || '留白')).join(' / ')
        say('【演示】结束：' + summary)
        finish({ ok: true, steps: log })
      } catch (err) {
        finish({ ok: false, error: String(err && err.message ? err.message : err) })
      }
    }
    run()
    return { started: true }
  }

  /**
   * 立刻收掉正在演的小戏。
   * 为什么不靠 scriptTick 里那个守卫就够：那个守卫要等下一次 40ms 心跳才生效，
   *   而真实事件可能就在这 40ms 内推了一堆东西进来 —— 主动收更干净。
   */
  function abortIdleScript() {
    idle.scriptManual = false
    if (!idle.scripts || !idle.scripts.running) return null
    const name = DSHPetIdleScripts.abort(idle.scripts, performance.now())
    if (name) motion.debug.scriptAborted = { name: name, at: Math.round(performance.now()) }
    return name
  }

  function runIdleBehavior() {
    // 提前返回的原因要留痕 —— 否则「行为被静默跳过」只能靠猜（我为此猜了两轮）
    if (idle.sleep) { idle.behWhy = 'sleep'; return null }
    if (idle.scripts && idle.scripts.running) { idle.behWhy = 'script-running'; return null }
    if (rig.override && !rig.override.soft) {
      idle.behWhy = 'hard-override:' + String(rig.override.face || rig.override.mood || '?')
      return null
    }
    idle.behWhy = 'ok'

    const b = idle.forceNext || pickIdleBehavior()
    idle.forceNext = null
    // 抽签那条路已经过滤过；但 idleAct('未知行为') 这种「点名要」的还会走到这里，
    // 所以再守一道：做不了就说清原因，别静默做一次空操作。
    if (!canDoIdle(b)) { idle.behWhy = 'not-available:' + b; return null }
    // 肢体动作：也是「一次性表演」，所以登记一下，免得下一跳马上又插一件（会叠）
    if (IDLE_CLIP[b]) {
      const okClip = idleClipAction(b)
      acting = { until: performance.now() + 1400 }
      // 记下「这个动作要播到什么时候」——排期要用它留出音尾（见 idleClipTail 注释）
      if (okClip) {
        idle.clipUntil = performance.now() + motionDuration(IDLE_CLIP[b]) * 1000 + DSHPetMotion.__fadeMs
      }
      return okClip ? b : null
    }
    switch (b) {
      case 'glance':
        gaze.nextDrift = 0 // 立刻换一个新的视线落点
        break
      case 'script': {
        // 成套小戏：这一跳不抽「一件事」，而是开一段 2~4 步的小戏。
        // 抽不到（都在冷却）就当这一跳没戏，返回 null 让节奏引擎照常排下一跳。
        const name = startIdleScript(performance.now())
        return name ? 'script' : null
      }
      case 'express':
        idleExpress()
        break
      case 'mutter':
        act({ props: IDLE_PROPS, line: pickFresh(SAY.idle, 'idle'), ms: 4200, soft: true })
        break
      case 'hungry':
        act({ mood: 'pout', props: IDLE_PROPS, line: pickFresh(SAY.hungry, 'hungry'), ms: 4600, soft: true })
        break
      case 'nopang':
        act({ mood: 'grumpy', props: IDLE_PROPS, line: pickFresh(SAY.fat, 'fat'), ms: 4200, soft: true })
        break
      // —— 肢体动作（A：放开待机 clip）——
      // 这四个的实际执行已经在 switch **之前**做掉了（见上面的 IDLE_CLIP 拦截），
      // 这里的分支看起来「什么都不做」，但它必须存在，理由有两个：
      //   1. 单测第 7 节会断言「权重表 ↔ switch 分支」双向一致 ——
      //      以前权重表里留了没有分支的项，静默失效了很久。这里显式列出，就是为了不重蹈覆辙。
      //   2. 以后若有人把执行逻辑挪进 switch，分支已经在位，不会漏。
      case 'nod':
      case 'tilt':
      case 'stretch':
      case 'tailWag':
      case 'sway':
        break // 已在 pickIdleBehavior 之后统一处理
      case 'peer': {
        // 探头张望（2026-10-17 新增）：只动姿态 —— 不播 clip、不碰脸、不抢视线的东西。
        // 和 glance 的区别：glance 只换视线落点（几乎看不见），peer 会真的「探一下身子」。
        if (DSHPetMotion && DSHPetMotion.idleBurst) {
          DSHPetMotion.idleBurst(motion.idle, 'lean', { dir: pointerDir(true) })
        }
        gaze.nextDrift = 0
        break
      }
    }
    return b
  }

  function startLoops() {
    // 启动时先摆一次所有面板。
    // ⚠️ 原来启动路径**从来没调用过 clampPanels()**（实测所有面板的 --dshp-shift
    //    都是空的），所以固定定位的气泡/工具栏得等到"鼠标移动"才被摆到正确位置。
    try {
      clampPanels()
    } catch (e) {}

    // 视线/自主动作：40ms 一跳（对应 clawd-on-desk 的 50ms 轮询）
    setInterval(gazeTick, 40)

    // 干活时的轮播（认真/摸鱼/思考），和下面的待机大脑互斥
    setInterval(() => {
      if (agent.status === 'idle') return
      workTick()
    }, 1500)

    // 兜底复位：只要空闲、又没有一次性表演在放，底层状态就必须是「平常」。
    // 有了它，就算哪条事件路径漏了复位，也不会出现「一直挂着某张脸」。
    setInterval(() => {
      if (agent.status !== 'idle') return
      if (idle.sleep) return // 睡着时底脸必须留着睡脸，别被兜底复位抹掉（2026-10-17）
      if (rig.override) return
      if (rig.base.mood !== 'neutral') setBase('neutral', IDLE_PROPS)
      if (gaze.biasTarget !== 0) gaze.biasTarget = 0
    }, 2000)

    // ——————————————————————————————————————————————————————————
    // 待机大脑：由 @idle-rhythm 决定**下一次什么时候抽、抽哪一档权重**。
    //
    // 上游原来是写死的「now + 3500 + rand*4000」（均匀 3.5~7.5s）；
    // 现在换成：发呆期 7~16s / 常态 3.5~7.5s / 活跃期 1.5~3.5s 且**连做 2~3 件**。
    // 定时器本身仍是 1200ms 一跳（只做守卫 + 到点判断），不新增高频定时器。
    // CFG.idleRhythm = false 时退回上游行为。
    // ——————————————————————————————————————————————————————————
    setInterval(() => {
      if (agent.status !== 'idle' && !idle.demo) return   // idle.demo = 诊断用的演示模式（见 DSHPet.idleDemo）
      if (PERF.low) return                      // 低性能档：不自言自语、不自己找戏
      if (ui.root.classList.contains('dshp-hidden')) return
      if (document.hidden) return
      // 睡着：待机大脑停摆（呼吸/物理还在走）。换嘴和梦话由 sensorTick 的 @sleep-state 管。
      if (idle.sleep) return
      const now = performance.now()
      if (now < idle.nextAt) return

      if (CFG.idleRhythm === false || !DSHPetIdleRhythm) {
        idle.nextAt = now + 3500 + Math.random() * 4000   // 上游原行为
        runIdleBehavior()
        return
      }

      // 待机肢体动作的「音尾」：动作刚播完时姿势还在淡出（300ms），这时候抽下一件
      //   所以动作结束后再留 700ms，等姿势彻底归零再抽下一件。
      if (idle.clipUntil && now < idle.clipUntil + 700) {
        idle.nextAt = now + 400
        return
      }

      // 小戏在演 → 等它演完再抽下一件事（在小戏中间插一件，观感就是「断了」）
      if (idle.scripts && idle.scripts.running) {
        const total = DSHPetIdleScripts.durOf(idle.scripts.running) * 1000
        const left = total - (now - idle.scripts.t0)
        idle.nextAt = now + Math.max(400, Math.min(9000, left + 900))
        return
      }

      const st = idle.rhythm
      // 正有一次**硬**表演在放 → 不插队，稍后再看
      //   （别把 nextAt 推远，否则表演一结束就长时间静默）
      //   soft 表演不挡：那是她自娱自乐，小戏/新行为可以盖过去。
      if (rig.override && !rig.override.soft) { idle.nextAt = now + 700; return }

      // 抽事**之前**先判「是不是该发呆了」——这样这一跳就直接按安静档排，
      // 而不是先按常态抽一件、下一跳才安静。
      DSHPetIdleRhythm.maybeDrowsy(st, now)

      // 掷「这一跳允不允许做肢体动作」的骰子。
      // 放在排期这里（而不是抽事时）是为了让它**成为这一跳的属性**：
      // 簇内的 2~3 件共用同一次掷骰，不会出现「簇里一半能做动作一半不能」。
      idle.allowClip = DSHPetIdleRhythm.clipAllowed(st, CFG, Math.random)

      // 取本簇的件数（活跃期 2~3 件，其余档 1 件），抽一件并记状态
      DSHPetIdleRhythm.takeCluster(st)
      const picked = runIdleBehavior()
      DSHPetIdleRhythm.noteBehavior(st, picked || st.lastKind, IDLE_TABLE, now)

      // 本簇还有没做完的 → 短间隔接着来；否则按当前档位算下一跳
      if (st.left > 0) DSHPetIdleRhythm.scheduleNextInCluster(st)
      idle.nextAt = now + DSHPetIdleRhythm.intervalMs(st, CFG)
    }, 1200)

    // 睡眠计时：先打哈欠，再睡着。
    //
    //    两个时钟取最大（都是 performance.now()，别混 Date.now）。
    setInterval(() => {
      if (!CFG.sleepAfterMs || agent.status !== 'idle') return
      if (PERF.low) return                      // 低性能档：连打哈欠/睡觉都省掉
      const quiet = performance.now() - Math.max(idle.lastInputAt || 0, idle.lastDshAt || 0)
      if (idle.sleep === 0 && quiet > CFG.sleepAfterMs) {
        beginSleep('quiet')
      } else if (idle.sleep === 0 && quiet > CFG.sleepAfterMs * 0.55 && Math.random() < 0.4) {
        // 打哈欠（入睡前的提醒；不是睡着本身）
        act({ mood: 'sleepy', props: IDLE_PROPS, line: '（打了个哈欠）', ms: 2600 })
      }
    }, 15000)
  }

  // ——————————————————————————————————————————————————————————————
  // 十二、对外小接口（控制台调试 / 扩展）
  // ——————————————————————————————————————————————————————————————
  window.DSHPet = {
    /** 外壳用它说一句话（托盘里的「显示/隐藏」「连接开关」靠它报信，不用开控制台） */
    say: (text, opts) => {
      try {
        ui.bubble.show(String(text == null ? '' : text), Object.assign({ name: 'DS 鲸鱼娘', ttl: 2800 }, opts || {}))
        return true
      } catch (e) {
        return false
      }
    },
    /** 诊断：页面拿到的 boot（独立化以后外壳会注入 local / upstream / seed） */
    boot: () => window.__DSH_PET_BOOT__ || null,
    /** 诊断：与 DSH 的连接状态（独立外壳里由本地服务告诉我们） */
    linkState: () => ({ known: link.known, online: link.online, port: link.port, status: agent.status }),
    /** 诊断：她现在说话的语气（疑问 / 感叹 / 平常）以及它会怎么写脸 */
    talkTone: () => {
      const T = (typeof DSHPetTalkTone !== 'undefined') ? DSHPetTalkTone : null
      const tone = rig.talkTone || 'plain'
      return { tone: tone, talking: !!rig.talking, params: T ? T.params(tone) : null, tones: T ? Object.keys(T.TONES) : [] }
    },
    /** 诊断：直接判一句话的语气（纯查询，不动任何状态） */
    classifyTone: (text) => ((typeof DSHPetTalkTone !== 'undefined') ? DSHPetTalkTone.classify(text) : 'plain'),
    /**
     * 诊断：模拟「她在说这句话」若干毫秒（只动语气与口型，**不发任何消息**）。
     * CDP 很难在那一刻正好采样 —— 和 idleDemo / sensorDemo 是同一个理由。
     */
    talkProbe: (text, ms) => {
      const T = (typeof DSHPetTalkTone !== 'undefined') ? DSHPetTalkTone : null
      const tone = T ? T.classify(text) : 'plain'
      rig.talkTone = tone
      rig.talking = true
      try { clearTimeout(rig.talkProbeTimer) } catch (e) {}
      rig.talkProbeTimer = setTimeout(() => {
        rig.talking = false
        rig.talkTone = 'plain'
      }, Math.max(300, Number(ms) || 2500))
      return { tone: tone, params: T ? T.params(tone) : null, ms: Math.max(300, Number(ms) || 2500) }
    },
    setBase,
    setReaction,
    clearReaction,
    setUserFace,
    clearUserFace,
    setProp,
    clearProps,
    playMotion,
    /** 动作引擎：动作库列表 */
    clips: () => (DSHPetMotion ? DSHPetMotion.listClips() : []),
    /** 动作引擎：播一个动作，opts = {speed 0.4~2, strength 0~1, hold, delay} */
    playClip: (name, opts) => playClip(name, opts),
    /** 动作引擎：一组动作，timing = '同时' | '依次' */
    playClips: (list, timing) => playClips(list, timing),
    stopClips: () => stopClips(),
    /** 诊断：待机层/动作的实时状态 + 4 个根参数的当前值与默认值 */
    motionState: () => ({
      ready: motion.ready,
      idle: {
        t: +motion.idle.t.toFixed(2),
        enabled: motion.idle.enabled,
        level: motion.idle.level,
        burst: motion.idle.burst ? motion.idle.burst.kind : null,
        // 待机节奏（@idle-rhythm）：档位 + 本簇还剩几件 + 距下一跳多久。
        // 暴露出来是为了能**观测**「长短句」是否真的生效（均匀随机 vs 双峰分布）。
        mood: idle.rhythm ? idle.rhythm.mood : null,
        clusterLeft: idle.rhythm ? idle.rhythm.left : null,
        quiet: idle.rhythm ? idle.rhythm.quiet : null,
        nextInMs: Math.max(0, Math.round(idle.nextAt - performance.now())),
        // 只读诊断：**假如现在就能抽**，下一跳会隔多久（毫秒）。
        // 为什么要有它：待机大脑被 agent.status/PERF/可见性 挡着，而 agent 干活时
        // 永远不是 idle（我做工具调用时就是），所以 CDP 根本观测不到真实待机。
        // 这个值走的是与线上**完全相同**的 intervalMs()，用它就能验证「长短句」确实在算。
        nextIntervalIfIdle: (CFG.idleRhythm === false || !DSHPetIdleRhythm) ? null : DSHPetIdleRhythm.intervalMs(idle.rhythm, CFG),
      },
      clips: motion.clips.map((c) => ({
        name: c.name, t: +c.t.toFixed(2), dur: c.def.duration,
        speed: c.speed, strength: c.strength, waiting: +c.waiting.toFixed(2),
      })),
      debug: motion.debug,
      // out = 我们这一帧写进去的总偏移；applied = 写完那一刻参数的真实值
      //（含框架的 breath/focus/physics）。帧外读 paramValue() 只会读到快照，别拿它判断。
      roots: ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBreath'].map((id) => {
        const d = paramDefault(id)
        const o = motion.debug.out ? motion.debug.out[id] : null
        const ap = motion.debug.applied ? motion.debug.applied[id] : null
        return { id, offset: o, applied: ap === null || ap === undefined ? null : +ap.toFixed(3), def: d === null ? null : +d.toFixed(3) }
      }),
    }),
    /**
     * 诊断：**演示模式** —— 忽略 agent 是否在干活，让待机大脑照常抽事。
     *
     * 为什么需要它：待机大脑的第一道守卫是 `agent.status !== 'idle'`，
     *   打开它就能当场看到她待机时会做什么，用来验收手感。
     *
     * 只跳过「agent 忙不忙」这一条守卫；低性能档 / 窗口隐藏 / 页面不可见仍然生效，
     * 而且真实工作事件（override）照样会打断她 —— 所以开着它也不会和工作表现打架。
     * 传 false 关掉。刷新页面自动失效（不持久化）。
     */
    idleDemo: (on) => {
      idle.demo = !!on
      return idle.demo
    },

    /**
     * 为什么需要：真实待机行为被 agent.status/PERF/可见性 三重守卫挡着，
     *   agent 干活时（我做工具调用时就是）根本不抽事，所以 CDP 无法端到端验证。
     * S2 的互动感知器接进来后也是调同一个 noteActivity，所以它同时也是那条路径的预演。
     */
    /** 诊断：互动感知器（S2）的实时状态 —— 冷却剩余、各事件计数、当前几何判定 */
    sensorState: () => {
      const st = idle.sensors
      const now = performance.now()
      return {
        enabled: CFG.idleReact !== false,
        sleeping: idle.sleep !== 0,
        strength: reactStrength(),
        inNear: st.inNear,
        sinceNearMs: st.sinceNear ? Math.round(now - st.sinceNear) : 0,
        speed: Math.round(st.speed),
        typing: st.typing,
        typingIdleMs: st.typing ? Math.round(now - st.lastTypeAt) : 0,
        cooldowns: DSHPetIdleSensors ? DSHPetIdleSensors.cooldowns(st, now) : null,
        reactionCool: {
          hover: Math.max(0, Math.round((st.hot['r-hover'] || 0) - now)),
          stare: Math.max(0, Math.round((st.hot['r-stare'] || 0) - now)),
          swoosh: Math.max(0, Math.round((st.hot['r-swoosh'] || 0) - now)),
          typing: Math.max(0, Math.round((st.hot['r-typing'] || 0) - now)),
          typingStop: Math.max(0, Math.round((st.hot['r-typingStop'] || 0) - now))
        },
        counts: Object.assign({}, st.counts),
        lastFrame: motion.debug.sensors || null,
        lastReact: idle.lastReact || null,
        lastReaction: idle.lastReaction || null,
        gate: idle.sensorGate || null,
        hot: (function(){ var o={}; for (var k in st.hot) o[k]=Math.max(0,Math.round(st.hot[k]-now)); return o; })(),
        lastReactWhy: idle.lastReactWhy || null,
        reactUntilMs: Math.max(0, Math.round(idle.reactUntil - now)),
        reactWho: idle.reactWho || null,
        reactPriority: idle.reactWho ? (REACT_PRIORITY[idle.reactWho] || 0) : 0
      }
    },

    /** 诊断：睡眠状态（@sleep-state 快照 + 当前睡脸 / 待机幅度 / 最近唤醒） */
    sleepState: () => ({
      asleep: idle.sleep !== 0,
      why: idle.sleepWhy || null,
      asleepMs: idle.sleep ? Math.round(performance.now() - idle.sleepAt) : 0,
      engine: (idle.sleepSt && typeof DSHPetSleep !== 'undefined') ? DSHPetSleep.snapshot(idle.sleepSt, performance.now()) : null,
      face: rig.face,
      faces: sleepFacesUsable(),
      idleLevel: motion.idle.level,
      lastWake: motion.debug.sleepWake || null,
      lastShy: motion.debug.sleepShy || null,
      last: (motion.debug.sleep && motion.debug.sleep.last) || null
    }),
    /** 诊断/测试：立刻入睡（不用等 3 分钟） */
    sleepNow: () => beginSleep('debug'),
    /** 诊断/测试：立刻叫醒（reason 只用于诊断） */
    wakeNow: (reason) => wakeUp(reason || 'debug'),
    /** 诊断/测试：切到第 i 张睡脸（睡着时看口型轮换用） */
    sleepFace: (i) => applySleepFace(Number(i) || 0),
    /** 诊断：她自己的画布 PNG（透明窗口截图不可靠，看观感用这个） */
    captureCanvas: () => {
      try { return app && app.view ? app.view.toDataURL('image/png') : null } catch (e) { return null }
    },
    /** 诊断：系统声音感知状态（外壳推的峰值 + @audio-burst 状态） */
    audioState: () => ({
      enabled: CFG.suddenAudio !== false,
      peak: +Number((idle.audio && idle.audio.peak) || 0).toFixed(4),
      sampleAgoMs: (idle.audio && idle.audio.at) ? Math.round(performance.now() - idle.audio.at) : -1,
      engine: (idle.audioBurst && typeof DSHPetAudioBurst !== 'undefined') ? DSHPetAudioBurst.snapshot(idle.audioBurst, performance.now()) : null,
      lastBurst: motion.debug.audioBurst || null,
      lastReaction: idle.lastReaction || null
    }),
    /** 诊断/测试：清掉 burst 冷却并立刻武装（等同设置页「重置听觉感知」） */
    audioArm: () => {
      if (!resetAudioBurst()) return null
      return DSHPetAudioBurst.snapshot(idle.audioBurst, performance.now())
    },
    /** 诊断/测试：注入一段峰值（ms 内持续），不需要真的放声音 */
    audioFeed: (peak, ms) => {
      if (!idle.audio) return null
      idle.audio.forcePeak = Math.max(0, Math.min(1, Number(peak) || 0))
      idle.audio.forceUntil = performance.now() + Math.max(0, Number(ms) || 0)
      return { peak: idle.audio.forcePeak, untilMs: Math.round(Math.max(0, idle.audio.forceUntil - performance.now())) }
    },
    /**
     * 互动演示（**不用开控制台**）：依次模拟「凑近 / 盯着看 / 甩鼠标 / 打字后停下」，
     * 每一步都用气泡把她收到的信号与反应**报在屏幕上**。
     *
     * 为什么需要它：
     *   · 真实互动被 agent.status 挡着（你跟 AI 说话时 agent 就在干活），边聊边看是看不到的。
     * 它临时打开演示模式（只放行这一条守卫），跑完自动还原。
     */
    /**
     * 互动演示（**不用开控制台**）：依次模拟「凑近 / 盯着看 / 甩鼠标 / 打字后停下」，
     * 每一步都用气泡把她收到的信号与反应**报在屏幕上**。
     *
     * 为什么需要它：
     *   · 真实互动被 agent.status 挡着（你跟 AI 说话时 agent 就在干活），边聊边看是看不到的。
     * 它临时打开演示模式（只放行这一条守卫），跑完自动还原。
     *
     * 触发方式：**Shift + 左键点她**（见 pointerup 里的拦截），或控制台调这个 API。
     */
    sensorDemo: () => startSensorDemo(),
    /** 诊断：小戏（e）的实时状态 —— 正在演哪段、第几步、各段冷却 */
    scriptState: () => (DSHPetIdleScripts && idle.scripts) ? Object.assign(DSHPetIdleScripts.snapshot(idle.scripts, performance.now()), { abortWhy: idle.scriptAbortWhy || null, demo: !!idle.demo, manual: !!idle.scriptManual }) : null,
    /** 诊断：小戏数据表（名字 / 权重 / 步数 / 时长 / minGap） */
    scriptList: () => (IDLE_SCRIPTS || []).map((x) => {
      const sm = CFG.scriptWeightScale || {}
      const k = Number(sm[x.name])
      const scale = isFinite(k) && k >= 0 ? k : 1
      return {
        name: x.name, weight: x.weight, minGap: x.minGap, scale: scale, effectiveWeight: +(x.weight * scale).toFixed(3),
        steps: (x.steps || []).length,
        durSec: DSHPetIdleScripts ? DSHPetIdleScripts.durOf(x) : null,
        verbs: (x.steps || []).map((y) => y.do + (y.arg ? ':' + y.arg : ''))
      }
    }),
    /** 诊断：立刻起一段指定小戏（绕过权重与冷却），用来验收；菜单「小戏」页也走同一条路 */
    scriptPlay: (name) => startIdleScriptByName(name),
    /**
     * 诊断：**当前这一跳真正能抽到的待机行为池**（含权重）。
     *
     * 为什么要暴露它：菜单里那些「点了没反应」的项，根子是「模型没有那个参数」；
     * 待机行为有一模一样的问题（依赖模型里不存在的参数/道具）。
     * 有了这个接口，测试就能断言「池子里不会出现做不了的行为」，不用去猜概率。
     */
    /**
     * 诊断：详细频率面板的三组值（行为/小戏/间隔）+ 当前档的占比快照。
     * 前三项是「倍数」（就是 CFG 里存的东西）；weights / scriptWeights / intervalRange 是
     * 面板换算用的「实际值」，preview/previewFor 是「份额 / 占比 / 约每」的同一份计算，
     * 所以 CDP 不点滑杆也能断言换算对不对。
     */
    tuningState: () => ({
      interval: (() => { const v = Number(CFG.idleIntervalScale); return isFinite(v) && v > 0 ? v : 1 })(),
      intervalFactor: (() => {
        const s0 = Number(CFG.idleIntervalScale)
        const s = isFinite(s0) && s0 > 0 ? s0 : 1
        const b0 = DSHPetIdleRhythm && DSHPetIdleRhythm.biasFactor ? DSHPetIdleRhythm.biasFactor(CFG) : 1
        const b = isFinite(b0) && b0 > 0 ? b0 : 1
        return Math.round(s * b * 100) / 100
      })(),
      behavior: Object.assign({}, CFG.idleWeightScale || {}),
      scripts: Object.assign({}, CFG.scriptWeightScale || {}),
      tier: (idle.rhythm && idle.rhythm.mood) || 'normal',
      preview: tuningPreview(),
      previewFor: (tier) => tuningPreview(tier),
      weights: DSHPetIdleRhythm ? DSHPetIdleRhythm.weightMatrix(IDLE_TABLE, idleWeightScale()) : {},
      scriptWeights: IDLE_SCRIPTS.reduce((a, s) => {
        a[s.name] = Math.round(s.weight * tuningScale(CFG.scriptWeightScale, s.name) * 1000) / 1000
        return a
      }, {}),
      intervalRange: (() => {
        const sc = isFinite(Number(CFG.idleIntervalScale)) && Number(CFG.idleIntervalScale) > 0 ? Number(CFG.idleIntervalScale) : 1
        const r = DSHPetIdleRhythm.MOODS.normal.inter
        return [Math.round(r[0] * sc * 10) / 10, Math.round(r[1] * sc * 10) / 10]
      })(),
    }),
    idlePool: () => {
      const base = effectiveIdleTable()
      const scale = idleWeightScale()
      let rows
      if (DSHPetIdleRhythm && idle.rhythm) {
        rows = DSHPetIdleRhythm.weightsOf(idle.rhythm, base, canDoIdle, scale)
      } else {
        rows = base.filter(([k]) => canDoIdle(k))
        if (scale) {
          rows = rows
            .map(([k, w]) => {
              const s = Number(scale[k])
              return [k, w * (isFinite(s) ? s : 1)]
            })
            .filter(([, w]) => w > 0)
        }
      }
      return {
        mood: idle.rhythm ? idle.rhythm.mood : null,
        allowClip: idle.allowClip !== false,
        names: rows.map(([k]) => k),
        rows: rows.map(([k, w]) => k + ':' + w),
        removed: IDLE_TABLE.map(([k]) => k).filter((k) => !rows.some(([x]) => x === k)),
        propKeys: [],
      }
    },

    /** 诊断：立刻中断当前小戏 */
    scriptAbort: () => abortIdleScript(),

    /** 诊断：直接触发某个反应（走与感知器完全相同的占位逻辑），用于验证「不被抢」 */
    reactNow: (name) => {
      const hold = reactionHoldMs(name)
      const did = doReaction(name)
      const now = performance.now()
      if (did) {
        idle.reactUntil = now + hold
        idle.reactWho = name
        idle.nextAt = Math.max(idle.nextAt, idle.reactUntil)
        idle.lastReact = { which: name, did: true, at: Math.round(now), holdMs: hold }
      }
      return { did: did, holdMs: hold, who: idle.reactWho, untilMs: Math.round(idle.reactUntil - now), priority: REACT_PRIORITY[name] || 0, lastReaction: idle.lastReaction || null }
    },
    /** 诊断：占位时长的计算（纯查表，不触发） */
    reactHoldOf: (name) => reactionHoldMs(name),
    /**
     * 诊断：**精确执行一个待机行为**（走 runIdleBehavior 的真实路径，不随机）。
     * 为什么要它：待机行为平时是随机抽的，想复现「随机触发时的观感」就得能指定。
     * 用法：DSHPet.idleAct('stretch') / 'nod' / 'tilt' / 'tailWag' / 'express' …
     */
    idleAct: (name) => {
      if (!name || !IDLE_TABLE.some(([k]) => k === name)) return { ok: false, err: '未知行为', known: IDLE_TABLE.map(([k]) => k) }
      const was = idle.demo
      idle.demo = true          // 临时放行 agent 守卫，让这次一定执行
      idle.forceNext = name
      const got = runIdleBehavior()
      idle.demo = was
      return { ok: true, asked: name, got: got, behWhy: idle.behWhy || null, clipWhy: idle.clipWhy || null, talking: !!rig.talking, scriptRunning: !!(idle.scripts && idle.scripts.running), overrideSoft: rig.override ? !!rig.override.soft : null, overrideFace: rig.override ? (rig.override.face || null) : null }
    },

    /** 诊断：眼睛形状参数的真实当前值（0=闭 1=睁）。闭眼观感问题排查要用它 */
    eyeState: () => ({ L: paramValue('ParamEyeLOpen'), R: paramValue('ParamEyeROpen'), def: paramDefault('ParamEyeLOpen'), exp5: paramValue('PARAM_EXP5') }),
    /** 诊断：直接写眼睛形状参数（A/B 对比用，会短暂影响观感） */
    setEyes: (v) => {
      try {
        for (const id of ['ParamEyeLOpen', 'ParamEyeROpen']) coreModel.setParameterValueById(id, v)
        coreModel.saveParameters()
        return { ok: true, L: paramValue('ParamEyeLOpen'), R: paramValue('ParamEyeROpen') }
      } catch (e) { return { ok: false, err: String(e && e.message ? e.message : e) } }
    },
    sensorDemoResult: () => (idle.demoRunning ? { running: true } : idle.demoResult),

    /** 诊断：清掉所有冷却（测试用，免得等 45 秒） */
    sensorClearCooldowns: () => {
      if (!DSHPetIdleSensors) return false
      DSHPetIdleSensors.resetCooldowns(idle.sensors)
      idle.sensors.hot = {}
      idle.reactUntil = 0
      return true
    },
    idlePokeActivity: () => {
      if (!DSHPetIdleRhythm || !idle.rhythm) return null
      DSHPetIdleRhythm.noteActivity(idle.rhythm, performance.now())
      // ⚠️ 这里**不**消耗簇（不调 takeCluster）：
      //    · 语义上更对：感知器只负责「报告有活动」，抽簇由待机大脑决定；
      //    · 也才好校验档位区间——若在这里就 takeCluster，left>0 会让 intervalMs
      //      走「簇内间隔 GAP(0.8~2.2s)」分支，量出来的就不是档位区间了（我为此误判过一次）。
      // 占位窗口内不接管：否则「戳一下」会把正在演的害羞拦腰打断
      //   （和感知器走同一套优先级规则）。演示用 sensorDemo，它自己会清窗口。
      if (performance.now() < idle.reactUntil) {
        return { skipped: 'react-holding', holding: idle.reactWho || null }
      }
      const st = idle.rhythm
      DSHPetIdleRhythm.noteActivity(st, performance.now())
      const wait = DSHPetIdleRhythm.intervalMs(st, CFG)
      idle.nextAt = performance.now() + wait
      return { mood: st.mood, left: st.left, quiet: st.quiet, waitMs: wait }
    },

    /** 诊断/调试：临时开关待机层（返回生效状态） */
    setIdle: (on) => {
      motion.idle.enabled = !!on
      motion.idle.level = on ? (PERF.low ? 0.35 : 1) : 0
      return motion.idle.enabled
    },
    hitTest,
    hitBounds,
    hitRects,
    lastPoke: () => lastPokeInfo,
    /** 隐藏 / 恢复。壳子（桌面版）收起成小球后，靠它把页面里的状态一起改回来 */
    setHidden,
    /** 壳子告诉页面「你记着的连接档位是哪一档」（设置页据此高亮） */
    setHostPref: (v) => {
      try {
        if (window.__dshpSetHostPref) window.__dshpSetHostPref(v)
      } catch (err) {}
    },
    /** 推一条工作简报（头顶出现信封，点开是大号面板） */
    report: (title, body) => pushReport(title || '工作简报', body),
    /** 性能档：壳子/设置页用它切「低性能模式」 */
    setLowPower,
    isLowPower: () => PERF.low,
    rebuildMask: () => {
      mask.dirty = true
    },
    resetGazeStats: () => {
      gaze.stepRate = 0
    },
    /**
     * 诊断用：现在的「手速档位」。
     * 测试靠它验证「正常速度点击不会让她生气」。
     */
    pokeTier: () => pokeTier(),
    /** 诊断用：给一串点击间隔（毫秒），纯计算出会落哪一档。 */
    pokeTierFor: (gaps) => pokeTierForGaps(gaps || []),
    /** 诊断用：清空连点记录。 */
    clearPokes: () => {
      pokeState.times.length = 0
      pokeState.softAt = 0
      pokeState.angerAt = 0
    },
    resetEverything,
    /**
     * 诊断用：菜单现在的样子（按钮名、当前状态行）。
     * 测试用它验证「同一个表情不会出现两次」「点每一项都真的有台词」。
     */
    menu() {
      const chips = []
      if (ui && ui.menu && ui.menu.el) {
        for (const c of ui.menu.el.querySelectorAll('.dshp-chip')) {
          chips.push({ label: c.textContent, on: c.classList.contains('dshp-on'), title: c.title })
        }
      }
      return {
        open: !!(ui && ui.menu && ui.menu.el && ui.menu.el.classList.contains('dshp-on')),
        focused: ui && ui.menu ? ui.menu.focused : null,
        status: menuStatusLine(),
        chips,
        userProps: Array.from(rig.userProps),
        face: rig.user.face,
      }
    },
    /** 诊断用：某个菜单项配的台词（验证「每一项都有话可说」）。 */
    itemLines(kind, key) {
      const t = kind === 'face' ? FACE_ACT : kind === 'action' ? ACTIONS : null
      return (t && t[key] && t[key].lines) || null
    },
    /** 诊断用：一次动作有哪些可选（测试逐项点一遍）。 */
    actions() {
      return ACTION_KEYS.map((k) => ({ key: k, label: ACTIONS[k].label, expr: ACTIONS[k].expr || null, motion: ACTIONS[k].motion || null, ms: ACTIONS[k].ms }))
    },
    /** 诊断用：直接演一个一次性动作。 */
    playAction: (key) => playAction(key),
    /** 诊断用：某个动作会写哪些参数 / 这些参数当前的值（验证「动作停了姿势有没有清掉」）。 */
    motionParams(group) {
      const meta = (manifest && manifest.motions && manifest.motions[group]) || null
      const ids = meta ? meta.params || [] : []
      const read = (id) => {
        try {
          return typeof coreModel.getParameterValueById === 'function'
            ? +coreModel.getParameterValueById(id).toFixed(4)
            : null
        } catch (e) {
          return null
        }
      }
      const def = (id) => {
        try {
          return typeof coreModel.getParameterDefaultValue === 'function'
            ? +coreModel.getParameterDefaultValue(id).toFixed(4)
            : null
        } catch (e) {
          return null
        }
      }
      return { group, ids: ids.slice(0, 8), total: ids.length, values: ids.map(read), defaults: ids.map(def) }
    },
    /** 诊断用：读某个参数当前值 / 默认值；eyes() 返回眼睛睁开程度（0 闭 1 睁）。 */
    paramValue: (id) => paramValue(id),
    paramDefault: (id) => paramDefault(id),
    eyes: () => eyesOpen(),
    /** 诊断用：眨眼的当前状态（测试用它数「15 秒眨了几次」）。 */
    blink: () => ({ phase: blink.phase, gate: blink.gate, count: blink.count,
      nextIn: Math.max(0, Math.round(blink.nextAt - performance.now())) }),
    /** 诊断用：主动清一次动作姿势（测试与 /control 都能用）。 */
    clearMotionPose: () => clearMotionPose(),
    /** 诊断用：HUD（余额/计价面板）状态与当前显示的文字。 */
    hud: {
      open: () => hud.open,
      show: (opts) => openHud(opts || { flash: true }),
      hide: () => closeHud(),
      refresh: () => hudFetch(true),
      read: () => ({
        open: hud.open,
        source: hud.source || null,
        peak: hud.data ? hud.data.isPeak : null,
        balance: hud.data ? hud.data.totalBalance : null,
        currency: hud.data ? hud.data.currency : null,
        todayUsage: hud.data ? hud.data.todayUsage : null,
        turn: hud.turn ? { amount: hud.turn.amount, tokens: hud.turn.tokens, seq: hud.turn.seq } : null,
        left: hud.left === undefined ? null : hud.left,
        err: hud.err,
        text: ui && ui.hud
          ? {
              badge: ui.hud.badge.textContent,
              badgeClass: ui.hud.badge.className,
              money: ui.hud.money.textContent,
              today: ui.hud.today.textContent,
              turn: ui.hud.turn.textContent,
              countdown: ui.hud.countdown.textContent,
              foot: ui.hud.foot.textContent,
            }
          : null,
      }),
    },
    /**
     * 诊断用：把当前画面降采样成一小撮像素。
     * 测试工具靠它做「施加某个表情前后画面有没有变化」的客观比对——
     * 比肉眼看「这个按钮点了好像没反应」靠谱得多。
     */
    sampleCanvas(size) {
      if (!app || !app.view || !app.view.width) return null
      const W = size || 40
      const H = Math.max(6, Math.round((W * app.view.height) / app.view.width))
      const c = document.createElement('canvas')
      c.width = W
      c.height = H
      const g = c.getContext('2d', { willReadFrequently: true })
      g.clearRect(0, 0, W, H)
      g.drawImage(app.view, 0, 0, W, H)
      const d = g.getImageData(0, 0, W, H).data
      const out = new Array(d.length)
      for (let i = 0; i < d.length; i++) out[i] = d[i]
      return out
    },
    /** 诊断用：某个表达式会写哪些参数、这些参数模型里有没有。 */
    describe(name) {
      const ps = EXPR[name]
      if (!ps) return null
      return {
        params: ps.map((p) => ({ id: p.id, value: p.value, exists: MODEL_PARAMS.has(p.id) })),
        allExist: ps.every((p) => MODEL_PARAMS.has(p.id)),
      }
    },
    /** 诊断用：列出所有可用表情名与道具 key。 */
    catalog() {
      return {
        expressions: Object.keys(EXPR),
        // 菜单的两类：表情 / 动作（一次性）
        props: [],
        decor: [],
        scenes: [],
        actions: ACTION_KEYS,
        baseItems: [],
        moods: Object.keys(MOOD_FACE),
        motions: manifest ? Object.keys(manifest.motions || {}) : [],
      }
    },
    get state() {
      return {
        agent: Object.assign({}, agent),
        mood,
        face: rig.face,
        props: Array.from(rig.props),
        // 诊断用：三层状态各自持有什么，以及「干活轮播/小设备」的开关。
        // 卡住类 bug 全靠这几个字段定位（比如底层还挂着某个道具、轮播还在跑）。
        // 注意：base 这个字段名下面（对象末尾）已经用来放「底层情绪字符串」了，
        // 要保持兼容，所以这里第二个字段叫 baseMood/baseProps。
        userProps: Array.from(rig.userProps),
        overrideProps: rig.override ? (rig.override.props || []).slice() : null,
        overrideLeft: rig.override ? Math.max(0, Math.round(rig.override.until - performance.now())) : 0,
        work: { active: work.active, i: work.i },
        device: { out: device.out },
        modelSize: model ? { w: model.internalModel.width, h: model.internalModel.height } : null,
        view: lastView,
        panels: (() => {
          const read = (el) => {
            if (!el) return null
            const cs = getComputedStyle(el)
            const r = el.getBoundingClientRect()
            return {
              on: el.classList.contains('dshp-on'),
              shift: cs.getPropertyValue('--dshp-shift').trim() || '0px',
              left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width),
            }
          }
          return {
            headX: Math.round(headScreenX()),
            rootCenter: ui && ui.root ? Math.round(ui.root.getBoundingClientRect().left + ui.root.getBoundingClientRect().width / 2) : null,
            menu: read(ui && ui.menu && ui.menu.el),
            composer: read(ui && ui.composer && ui.composer.el),
            hud: read(ui && ui.hud && ui.hud.el),
          }
        })(),
        placement: (() => {
          const r = ui && ui.root ? ui.root.getBoundingClientRect() : null
          return {
            edge: (ui && ui.root && ui.root.dataset.edge) || null,
            left: r ? Math.round(r.left) : null,
            top: r ? Math.round(r.top) : null,
            right: r ? Math.round(window.innerWidth - r.right) : null,
            bottom: r ? Math.round(window.innerHeight - r.bottom) : null,
          }
        })(),
        contentBox,
        exclusive: rig.exclusive || null,
        motion: { playing: !!motionTimer || motionActive(), active: motionActive() },
        acting: acting ? { left: Math.max(0, Math.round(acting.until - performance.now())) } : null,
        // 诊断用：视线控制器 + 框架里真正生效的焦点值（测试靠它验证「有没有阻尼住」）
        gaze: {
          x: +gaze.x.toFixed(4),
          y: +gaze.y.toFixed(4),
          mode: gaze.mode,
          detached: performance.now() < gaze.detachUntil,
          stepRate: +(gaze.stepRate || 0).toFixed(3),
          fcX: gaze.fcX === undefined ? null : +gaze.fcX.toFixed(4),
          fcErr: gaze.fcErr || null,
          limit: gazeCfg().rate,
        },
        focus: model
          ? {
              x: +model.internalModel.focusController.x.toFixed(4),
              y: +model.internalModel.focusController.y.toFixed(4),
            }
          : null,
        override: rig.override ? { mood: rig.override.mood, until: Math.round(rig.override.until - performance.now()) } : null,
      base: rig.base.mood,
      baseMood: rig.base.mood,
      baseProps: rig.base.props.slice().sort(),
        idleSleep: idle.sleep,
        talkTone: rig.talkTone || 'plain',
        talking: !!rig.talking,
        droppedParams: Array.from(droppedParams),
        expressions: Object.keys(EXPR),
        motions: manifest ? Object.keys(manifest.motions || {}) : [],
      }
    },
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main)
  else main()
})()
