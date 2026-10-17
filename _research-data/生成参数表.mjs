/**
 * 从 Cubism Core 实测数据 + physics3.json 生成 rig-params.json。
 * 输出到 pet-plugin/assets/model/rig-params.json（由 /dsh-pet/model/* 路由提供服务）。
 */
import fs from 'node:fs';

const P = 'D:/AI_work_space/live2D桌宠/pet-plugin/assets/model/';
const dump = JSON.parse(fs.readFileSync('D:/AI_work_space/live2D桌宠/_research-data/params-dump.json', 'utf8'));
const infl = JSON.parse(fs.readFileSync('D:/AI_work_space/live2D桌宠/_research-data/param-influence.json', 'utf8'));
const cdi = JSON.parse(fs.readFileSync(P + 'dfyfish.cdi3.json', 'utf8'));
const phy = JSON.parse(fs.readFileSync(P + 'dfyfish.physics3.json', 'utf8'));

const influence = Object.fromEntries(infl.results.map(r => [r.id, r]));
const groupName = Object.fromEntries((cdi.ParameterGroups || []).map(g => [g.Id, g.Name]));
const paramGroup = Object.fromEntries((cdi.Parameters || []).map(p => [p.Id, p.GroupId]));

const inSet = new Set(), outSet = new Set();
for (const st of phy.PhysicsSettings) {
  for (const i of (st.Input || [])) inSet.add(i.Source.Id);
  for (const o of (st.Output || [])) outSet.add(o.Destination.Id);
}

// 级联图：参数 -> 直接下游（用于文档/调试）
const downstream = {};
for (const st of phy.PhysicsSettings) {
  for (const i of (st.Input || [])) {
    const k = i.Source.Id;
    downstream[k] = downstream[k] || { settings: [], outputs: [] };
    downstream[k].settings.push(st.Id);
    for (const o of (st.Output || [])) if (!downstream[k].outputs.includes(o.Destination.Id)) downstream[k].outputs.push(o.Destination.Id);
  }
}

const ranges = {}, role = {}, groups = {}, disp = {};
for (const p of dump.parameters) {
  ranges[p.id] = [p.min, p.max, p.default];
  const isIn = inSet.has(p.id), isOut = outSet.has(p.id);
  role[p.id] = isIn && isOut ? 'io' : isIn ? 'in' : isOut ? 'out' : 'free';
  const g = groupName[paramGroup[p.id]];
  if (g) groups[p.id] = g;
  const inf = influence[p.id];
  if (inf) disp[p.id] = Math.round(inf.maxDisplacementPx || 0);
}

const out = {
  version: 1,
  model: 'dfyfish',
  note: '由 Cubism Core 实测生成。ranges: [min, max, default]。role: in=物理输入(可安全驱动) / out=物理输出(会被每帧覆盖, 慎写) / io=既是输入又是输出 / free=与物理无关。disp: 该参数从默认值推到极限时模型顶点的最大位移(模型原生画布像素, 3326x4992)。',
  canvas: dump.canvasinfo,
  drawables: dump.drawableCount,
  rootKnobs: ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBreath'],
  rootKnobsNote: '这 4 个是全部动作的源头。框架已自带 breath(±7.5/±4/±5 与 ±0.25) + focus(最多 ±30)；再加偏移即可让身体/手臂/头发/衣服/耳朵/尾巴全部联动，且带正确的二次运动。',
  cascade: downstream,
  ranges, role, groups, disp,
};
fs.writeFileSync(P + 'rig-params.json', JSON.stringify(out), 'utf8');
console.log('wrote rig-params.json:', fs.statSync(P + 'rig-params.json').size, 'bytes');
console.log('params:', Object.keys(ranges).length);
const tally = {};
for (const v of Object.values(role)) tally[v] = (tally[v] || 0) + 1;
console.log('role tally:', JSON.stringify(tally));
console.log('rootKnobs downstream:', JSON.stringify(out.rootKnobs.map(k => ({ k, outs: (downstream[k] || {}).outputs.length }))));
console.log('sample:', JSON.stringify({ ranges: Object.entries(ranges).slice(0, 3), role: Object.entries(role).slice(0, 3) }));
