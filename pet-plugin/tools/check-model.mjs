#!/usr/bin/env node
/**
 * 检查大肥鱼模型文件齐不齐。
 *
 * 为什么需要它：本仓库**不随附**模型本体（作者没授权再分发，见同目录 README.md），
 * 所以 clone 下来的人必须先自己去作者那儿下载。这个脚本把「缺什么、放哪里」说清楚，
 * 而不是让他对着一个空白窗口猜。
 *
 * 用法：node pet-plugin/tools/check-model.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODEL = path.join(HERE, '..', 'assets', 'model')

const REQUIRED = [
  { file: 'dfyfish.moc3', min: 500 * 1024, what: '模型本体' },
  { file: 'dfyfish.8192/texture_00.png', min: 5 * 1024 * 1024, what: '贴图（8192²，≈28.6 MB）' },
  { file: 'dfyfish.cdi3.json', min: 1024, what: '显示信息' },
  { file: 'dfyfish.physics3.json', min: 1024, what: '物理' },
]
const OURS = ['dfyfish.model3.json', 'manifest.json', 'rig-params.json']

let bad = 0
console.log('模型目录：' + MODEL);
for (const r of REQUIRED) {
  const abs = path.join(MODEL, r.file)
  let st = null
  try { st = fs.statSync(abs) } catch (e) {}
  if (!st) {
    bad++
    console.log('  ✗ 缺 ' + r.file + '（' + r.what + '）')
  } else if (st.size < r.min) {
    bad++
    console.log('  ✗ ' + r.file + ' 只有 ' + Math.round(st.size / 1024) + ' KB，像是坏的（' + r.what + '）')
  } else {
    console.log('  ✓ ' + r.file + '  ' + Math.round(st.size / 1024) + ' KB  ' + r.what)
  }
}

for (const f of OURS) {
  const abs = path.join(MODEL, f)
  console.log(fs.existsSync(abs) ? '  ✓ ' + f + '（仓库自带）' : '  ✗ ' + f + ' 不见了 —— 这个应该由仓库提供，别删');
}

if (bad) {
  console.log('\n缺 ' + bad + ' 个模型文件。它们**不随仓库分发**，请自己去拿：');
  console.log('  · B 站作者：@Mao绒绒家园（UID 431301506），视频 BV1yep465EQz');
  console.log('  · 拿到后把上面缺的文件放进：' + MODEL);
  console.log('  · 细节见同目录 README.md');
  process.exit(1);
}
console.log('\n模型文件齐了 ✅');