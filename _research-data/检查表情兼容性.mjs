import fs from 'node:fs';
const dump = JSON.parse(fs.readFileSync('D:/AI_work_space/_research/params-dump.json','utf8')).parameters;
const known = new Set(dump.map(p => p.id));
const dir = 'D:/AI_work_space/live2D桌宠/pet-plugin/assets/model/expressions/';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.exp3.json'));
let okAll = 0, dead = 0;
const rows = [];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(dir + f, 'utf8'));
  const ids = (j.Parameters || []).map(p => p.Id);
  const alive = ids.filter(id => known.has(id));
  const ratio = ids.length ? alive.length / ids.length : 0;
  rows.push({ f, n: ids.length, alive: alive.length, ratio: +ratio.toFixed(2), sample: ids.slice(0,3) });
  if (ratio === 1) okAll++; else if (ratio === 0) dead++;
}
console.log('total exp3 files:', files.length, '| fully-compatible:', okAll, '| fully-dead:', dead);
console.log('\nfiles with ANY live param:');
for (const r of rows.filter(r => r.alive > 0)) console.log(' ', r.f.padEnd(32), 'params', String(r.n).padStart(3), 'alive', String(r.alive).padStart(3), 'ratio', r.ratio, '|', r.sample.join(','));
const d0 = rows.find(r => r.alive === 0);
if (d0) console.log('\nsample fully-dead file:', d0.f, JSON.stringify(JSON.parse(fs.readFileSync(dir + d0.f,'utf8')).Parameters.slice(0,5)));
const m3 = JSON.parse(fs.readFileSync('D:/AI_work_space/live2D桌宠/pet-plugin/assets/model/c_0120.model3.json','utf8'));
console.log('\nc_0120.model3.json FileReferences keys:', Object.keys(m3.FileReferences).join(','));
console.log('  Expressions entries:', (m3.FileReferences.Expressions||[]).length);
console.log('  Motions groups:', Object.keys(m3.FileReferences.Motions||{}).join(','));
