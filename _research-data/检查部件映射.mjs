import fs from 'node:fs';
const OUT = [];
const say = (...a) => OUT.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
import { loadModel } from 'file:///D:/AI_work_space/_research/cubism-loader.mjs';

const { model, core, attempts } = await loadModel();
say('load:', attempts.join(' || '));
say('runtimeReady ok');

const dm = model.drawables, pm = model.parts;
say('drawables:', dm.count, '| parts:', pm.count);
say('parts keys:', Object.getOwnPropertyNames(pm).slice(0,15).join(','));
say('drawables keys:', Object.getOwnPropertyNames(dm).slice(0,25).join(','));

const partIds = pm.ids.map(v => typeof v === 'string' ? v : String(v));
const parentPart = Array.from(dm.parentPartIndices || []);

const cdi = JSON.parse(fs.readFileSync('D:/AI_work_space/live2D桌宠/pet-plugin/assets/model/dfyfish.cdi3.json','utf8'));
const partName = Object.fromEntries((cdi.Parts||[]).map(p => [p.Id, p.Name]));

const drawableIds = dm.ids ? dm.ids.map(v => typeof v === 'string' ? v : String(v)) : [];
const idx = {};
for (let i = 0; i < dm.count; i++) idx[drawableIds[i] || ('#'+i)] = i;

say('\n=== which PART do the arm ArtMeshes belong to? ===');
for (const name of ['ArtMesh234','ArtMesh235','ArtMesh231','ArtMesh232','ArtMesh233','ArtMesh236']) {
  const i = idx[name];
  if (i === undefined) { say(name, '-> not found'); continue; }
  const p = parentPart[i];
  const pid = partIds[p];
  say(name.padEnd(12), '-> part', String(p).padStart(3), pid, '=', partName[pid] ?? '(no cdi3 name)');
}

// list ALL drawables that belong to arm-ish parts
say('\n=== parts whose name mentions 手/臂/袖 ===');
const hit = [];
for (const [pid, nm] of Object.entries(partName)) {
  if (/[手臂袖]/.test(nm || '')) hit.push([pid, nm]);
}
say(hit.map(([a,b]) => a + '=' + b).join(' | ') || '(none)');
for (const [pid, nm] of hit) {
  const pIdx = partIds.indexOf(pid);
  const meshes = [];
  for (let i = 0; i < dm.count; i++) if (parentPart[i] === pIdx) meshes.push(drawableIds[i] || ('#'+i));
  say('  part', pid, nm, '-> drawables:', meshes.join(', ') || '(none direct)');
}

fs.writeFileSync('D:/AI_work_space/_research/armprobe/part-map-out.txt', OUT.join('\n'), 'utf8');
