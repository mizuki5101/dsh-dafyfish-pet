'use strict'
// 心跳可用的「行为词表」——**镜像** pet.js 里的真实表。
//
// 为什么这里要抄一份：模型在主进程调用，而 pet.js 是页面里的（P1 还不方便跨进程取）。
// 以后改成页面启动时把 DSHPet.catalog() 推给主进程（见方案 §6.4），这里就退化成默认值。
// 抄的规矩：**只抄名字，不抄实现**；改名时两边一起改（测试会锁数量）。

const MOODS = [
  'neutral', 'listening', 'thinking', 'reading', 'happy', 'excited', 'love', 'shy', 'pout',
  'smug', 'sad', 'cry', 'grumpy', 'dizzy', 'gloomy', 'sweat', 'confused', 'alert', 'sleepy',
  'tongue', 'dead', 'angry', 'playful',
]

const MOTIONS = [
  '挥手(左)', '挥手(右)', '点头', '摇头', '歪头', '尾巴快摆', '换重心', '伸懒腰',
  '惊讶', '害羞', '思考', '左顾右盼', '要抱抱', '打喷嚏', '叹气',
]

const FACES = [
  '脸红', '生气', '挤眼', '担心嘴', '栗子嘴', '龇牙', '流口水', '脸黑', '圈圈眼',
  '疑惑', '怀疑', '嫌弃', '挑眉',
]

const MOUTHS = ['口型切换', '3嘴', '〇嘴']

const SEES = ['coding', 'meeting', 'video', 'game', 'reading', 'browsing', 'chat', 'away', 'idle']
const ACTS = ['none', 'speak', 'gesture', 'remind', 'report']
const PRIORITIES = ['low', 'normal', 'high']

/** 给 response_format.json_schema 用：全部 required，"" 表示「不做」。 */
const SCHEMA = {
  type: 'object',
  properties: {
    see: { type: 'string', enum: SEES },
    // topic = 「屏幕上最具体的一件事」。2026-10-18 起是必填：
    // 没有它，1B 会退化成「喝口水 / 休息一下」；有它才会去读画面。
    topic: { type: 'string' },
    say: { type: 'string' },
    act: { type: 'string', enum: ACTS },
    mood: { type: 'string', enum: [''].concat(MOODS) },
    motion: { type: 'string', enum: [''].concat(MOTIONS) },
    face: { type: 'string', enum: [''].concat(FACES) },
    priority: { type: 'string', enum: PRIORITIES },
  },
  required: ['see', 'topic', 'say', 'act', 'mood', 'motion', 'face', 'priority'],
  additionalProperties: false,
}

module.exports = { MOODS, MOTIONS, FACES, MOUTHS, SEES, ACTS, PRIORITIES, SCHEMA }
