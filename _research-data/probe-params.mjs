#!/usr/bin/env node
/**
 * probe-params.mjs - dump every Cubism parameter range of dfyfish.moc3.
 * Writes: ./params-dump.json   (read-only otherwise)
 *
 * NOTE on the Core API (differs from the Framework!):
 *   CubismCore Model has ONLY: update(), release(), parameters, parts, drawables, canvasinfo.
 *   There is NO getParameterIndex / setParameterValueById / getParameterValueById on the Core
 *   Model - those belong to the cubism4 Framework (PIXI.live2d / CubismModel). Values are
 *   therefore read/written directly through model.parameters.values (Float32Array).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadModel, readParams, shapeOf, CORE_PATH, MOC_PATH } from './cubism-loader.mjs';

const OUT = path.join(import.meta.dirname, 'params-dump.json');
const ARM = ['Param_arm_L1','Param_arm_L2','Param_arm_L3','Param_arm_L4',
             'Param_arm_R1','Param_arm_R2','Param_arm_R3','Param_arm_R4'];

const { model, bytes, attempts, version, waitedMs } = await loadModel();
const params = readParams(model);
const count = params.length;
const byId = {};
for (const r of params) if (!(r.id in byId)) byId[r.id] = r;

const armCheck = {};
for (const id of ARM) {
  const rec = byId[id] ? Object.assign({}, byId[id]) : null;
  armCheck[id] = rec ? { id, found: true, index: rec.index, min: rec.min, max: rec.max, default: rec.default } : { id, found: false };
}

const idCounts = {};
for (const r of params) idCounts[r.id] = (idCounts[r.id] || 0) + 1;
const dupes = Object.entries(idCounts).filter(function (e) { return e[1] > 1; });
const flat = params.filter(function (r) { return r.min === r.max; });
const nonFlat = params.filter(function (r) { return r.min !== r.max; });

const dump = {
  generatedAt: new Date().toISOString(),
  loader: { method: attempts.join(' | '), coreVersionRaw: version, runtimeWaitMs: waitedMs },
  source: { core: CORE_PATH, moc: MOC_PATH, mocBytes: bytes },
  count,
  canvasinfo: model.canvasinfo,
  drawableCount: model.drawables.count,
  parametersShape: shapeOf(model.parameters),
  parameters: params,
  armCheck,
  summary: {
    total: count,
    minEqualsMax: flat.length,
    minNeMax: nonFlat.length,
    minEqualsMaxIds: flat.map(function (r) { return r.id; }),
    nonRangeIds: nonFlat.map(function (r) { return r.id; }),
    duplicateIds: dupes,
  },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(dump, null, 2) + '\n', 'utf8');

console.log('loader method      :', attempts.join(' | '));
console.log('core version raw   :', version, '(0x' + version.toString(16) + ') runtimeWaitMs:', waitedMs);
console.log('moc bytes          :', bytes, ' drawables:', model.drawables.count);
console.log('parameter count    :', count);
console.log('all ids are string :', params.every(function (r) { return typeof r.id === 'string'; }));
console.log('first 3            :', JSON.stringify(params.slice(0, 3)));
console.log('last               :', JSON.stringify(params[count - 1]));
console.log('duplicate ids      :', JSON.stringify(dupes));
console.log('min==max / min!=max:', flat.length, '/', nonFlat.length);
console.log('ARM CHECK:');
for (const id of ARM) console.log('  ', JSON.stringify(armCheck[id]));
console.log('wrote              :', OUT);
