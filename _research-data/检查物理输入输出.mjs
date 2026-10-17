import fs from 'node:fs';
const P = 'D:/AI_work_space/live2D桌宠/pet-plugin/assets/model/';
const phy = JSON.parse(fs.readFileSync(P + 'dfyfish.physics3.json','utf8'));
const s8 = phy.PhysicsSettings.find(s => s.Id === 'PhysicsSetting8');
console.log('=== PhysicsSetting8 (02手臂L) ===');
console.log('Input[0]:', JSON.stringify(s8.Input[0]));
console.log('Output[0]:', JSON.stringify(s8.Output[0]));
console.log('inputs:', s8.Input.map(i => i.Source.Id).join(', '));
console.log('outputs:', s8.Output.map(o => o.Destination.Id).join(', '));

const s26 = phy.PhysicsSettings.find(s => s.Id === 'PhysicsSetting26');
console.log('\n=== PhysicsSetting26 (尾巴) ===');
console.log('inputs:', s26.Input.map(i => i.Source.Id).join(', '));
console.log('outputs:', s26.Output.map(o => o.Destination.Id).join(', '));
if (s26.Input[0] && s26.Input[0].Weight !== undefined) console.log('input weight sample:', JSON.stringify(s26.Input[0]));

const ins = new Set(), outs = new Set();
for (const s of phy.PhysicsSettings) {
  for (const i of (s.Input||[])) ins.add(i.Source.Id);
  for (const o of (s.Output||[])) outs.add(o.Destination.Id);
}
console.log('\n=== global ===');
console.log('total distinct inputs:', ins.size, '| total distinct outputs:', outs.size);
console.log('\nAre our animation targets physics OUTPUTS (overwritten every frame)?');
for (const id of ['Param_arm_L1','Param_arm_L2','Param_arm_L3','Param_arm_L4','Param_arm_R1','Param_arm_R2','Param_arm_R3','Param_arm_R4',
                  'Param_Angle_Rotation_2_ArtMesh367','Param_Angle_Rotation_6_ArtMesh367',
                  'ParamBodyAngleZ1','ParamBodyAngleZ2','ParamAngleX','ParamAngleY','ParamAngleZ','ParamBodyAngleX','ParamBodyAngleY','ParamBodyAngleZ','ParamEyeBallX','ParamEyeBallY','ParamMouthOpenY','ParamBrowLAngle']) {
  console.log('  ' + id.padEnd(38), 'physIn:', ins.has(id) ? 'YES' : 'no ', ' physOut:', outs.has(id) ? 'YES' : 'no');
}
const pref = {}; for (const p of outs) { const m = p.match(/^[A-Za-z_]+?(?=_?\d)/); const k=m?m[0]:p; pref[k]=(pref[k]||0)+1; }
console.log('\nphysics OUTPUT prefixes:', Object.entries(pref).sort((a,b)=>b[1]-a[1]).map(([k,v])=>k+':'+v).join('  '));
console.log('\nphysics INPUT params:', [...ins].join(', '));
