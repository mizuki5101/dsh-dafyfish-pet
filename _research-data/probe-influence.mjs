#!/usr/bin/env node
/**
 * probe-influence.mjs - per-parameter VISUAL INFLUENCE test for dfyfish.moc3 (pure Cubism Core).
 *
 * For every parameter: reset ALL parameters to their defaults, model.update(), snapshot the
 * whole drawable state, then set ONE parameter to max (resp. min), model.update(), snapshot
 * again and measure:
 *   - movedVertsMax / movedVertsMin : #vertices whose (x,y) moved > EPS units
 *   - maxDisplacementPx             : largest vertex delta * canvasinfo.PixelsPerUnit
 *   - opacityChangedMax / Min       : #drawables whose opacity changed (switch-type params)
 *   - colorChangedMax / Min         : #drawables whose multiply/screen colour changed
 * The whole parameter array is reset before every measurement, so nothing leaks.
 *
 * Physics note: Cubism Core does NOT execute physics3.json - that is the Framework layer
 *   (cubism4.min.js CubismPhysics), which writes parameter values before model.update().
 *   Motion measured here is therefore intrinsic to the .moc3 (deformer/glue bindings).
 *
 * Writes: ./param-influence.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadModel, readParams } from './cubism-loader.mjs';

const OUT = path.join(import.meta.dirname, 'param-influence.json');
const EPS = 1e-5;
const PHYSICS_PREFIXES = ['ParamHF_', 'ParamTWL', 'ParamYFWL', 'ParamGSFWL'];

const { model, version, waitedMs } = await loadModel();
const params = readParams(model);
const P = model.parameters;
const D = model.drawables;
const PPU = model.canvasinfo.PixelsPerUnit;
const canvas = model.canvasinfo;

const offsets = [];
let acc = 0;
for (let i = 0; i < D.count; i++) { offsets.push(acc); acc += D.vertexCounts[i] * 2; }
const TOTAL = acc;
console.log('drawables:', D.count, '| vertices:', TOTAL / 2, '| vertexPositions[0]:', D.vertexPositions[0].constructor.name);

function snapVerts() {
  const out = new Float32Array(TOTAL);
  for (let i = 0; i < D.count; i++) out.set(D.vertexPositions[i], offsets[i]);
  return out;
}
function snapState() {
  const op = new Float32Array(D.count);
  const col = new Float32Array(D.count * 8);
  const vis = new Uint8Array(D.count);
  for (let i = 0; i < D.count; i++) {
    op[i] = D.opacities[i];
    col.set(D.multiplyColors[i], i * 8);
    col.set(D.screenColors[i], i * 8 + 4);
    vis[i] = D.dynamicFlags[i] & 1;
  }
  return { op: op, col: col, vis: vis };
}
function resetAll() { P.values.set(P.defaultValues); }

function diffVerts(base, cur) {
  let moved = 0, maxD = 0, maxIdx = -1;
  const perDrawable = [];
  for (let i = 0; i < D.count; i++) {
    const off = offsets[i], n = D.vertexCounts[i];
    let dm = 0;
    for (let v = 0; v < n; v++) {
      const k = off + v * 2;
      const dx = cur[k] - base[k], dy = cur[k + 1] - base[k + 1];
      if (Math.abs(dx) > EPS || Math.abs(dy) > EPS) {
        moved++; dm++;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > maxD) { maxD = dist; maxIdx = i; }
      }
    }
    if (dm) perDrawable.push([i, dm]);
  }
  perDrawable.sort(function (a, b) { return b[1] - a[1]; });
  return { moved: moved, maxD: maxD, maxIdx: maxIdx, perDrawable: perDrawable };
}
function diffState(a, b) {
  let opChanged = 0, colChanged = 0, visChanged = 0;
  for (let i = 0; i < D.count; i++) {
    if (Math.abs(a.op[i] - b.op[i]) > 1e-6) opChanged++;
    if (a.vis[i] !== b.vis[i]) visChanged++;
    for (let k = 0; k < 8; k++) if (Math.abs(a.col[i * 8 + k] - b.col[i * 8 + k]) > 1e-6) { colChanged++; break; }
  }
  return { opChanged: opChanged, colChanged: colChanged, visChanged: visChanged };
}

// --- sanity ---
const idxAngleX = params.findIndex(function (r) { return r.id === 'ParamAngleX'; });
resetAll(); model.update();
const z0v = snapVerts(), z0s = snapState();
P.values[idxAngleX] = 30; model.update();
console.log('SANITY ParamAngleX=30 -> movedVerts', diffVerts(z0v, snapVerts()).moved);
resetAll(); model.update();

const results = [];
const t0 = Date.now();
for (let i = 0; i < params.length; i++) {
  const r = params[i];
  const rec = {
    id: r.id, index: i, min: r.min, max: r.max, default: r.default,
    flat: r.min === r.max,
    physicsPrefixed: PHYSICS_PREFIXES.some(function (p) { return r.id.indexOf(p) === 0; }),
    movedVertsMax: 0, movedVertsMin: 0,
    maxDisplacementUnits: 0, maxDisplacementPx: 0, maxDir: null,
    opacityChangedMax: 0, opacityChangedMin: 0,
    colorChangedMax: 0, colorChangedMin: 0,
    visibilityChangedMax: 0, visibilityChangedMin: 0,
    movedDrawableIds: [],
  };
  if (r.min !== r.max) {
    resetAll(); model.update();
    const bv = snapVerts(), bs = snapState();
    P.values[i] = r.max; model.update();
    const dv = diffVerts(bv, snapVerts()), ds = diffState(bs, snapState());
    rec.movedVertsMax = dv.moved;
    rec.opacityChangedMax = ds.opChanged;
    rec.colorChangedMax = ds.colChanged;
    rec.visibilityChangedMax = ds.visChanged;
    if (dv.maxD > rec.maxDisplacementUnits) {
      rec.maxDisplacementUnits = dv.maxD;
      rec.maxDisplacementPx = dv.maxD * PPU;
      rec.maxDir = 'max';
    }
    rec.movedDrawableIds = dv.perDrawable.slice(0, 5).map(function (e) { return D.ids[e[0]] + ':' + e[1]; });

    resetAll(); model.update();
    const bv2 = snapVerts(), bs2 = snapState();
    P.values[i] = r.min; model.update();
    const dv2 = diffVerts(bv2, snapVerts()), ds2 = diffState(bs2, snapState());
    rec.movedVertsMin = dv2.moved;
    rec.opacityChangedMin = ds2.opChanged;
    rec.colorChangedMin = ds2.colChanged;
    rec.visibilityChangedMin = ds2.visChanged;
    if (dv2.maxD * PPU > rec.maxDisplacementPx) {
      rec.maxDisplacementUnits = dv2.maxD;
      rec.maxDisplacementPx = dv2.maxD * PPU;
      rec.maxDir = 'min';
      rec.movedDrawableIds = dv2.perDrawable.slice(0, 5).map(function (e) { return D.ids[e[0]] + ':' + e[1]; });
    }
  }
  results.push(rec);
  if ((i + 1) % 60 === 0) console.log('  ...', i + 1, '/', params.length, ((Date.now() - t0) / 1000).toFixed(1) + 's');
}
resetAll(); model.update();

const ARM = ['Param_arm_L1','Param_arm_L2','Param_arm_L3','Param_arm_L4',
             'Param_arm_R1','Param_arm_R2','Param_arm_R3','Param_arm_R4'];
const byId = {};
for (const r of results) byId[r.id] = r;
const ranking = results.slice().sort(function (a, b) { return b.maxDisplacementPx - a.maxDisplacementPx; });

const out = {
  generatedAt: new Date().toISOString(),
  method: 'pure Cubism Core: reset all params to defaults -> model.update() -> snapshot -> set ONE param to max/min -> model.update() -> compare drawable vertexPositions / opacities / colours. eps=' + EPS + ' model units.',
  coreVersionRaw: version,
  runtimeWaitMs: waitedMs,
  canvasinfo: canvas,
  pixelsPerUnit: PPU,
  epsilonUnits: EPS,
  drawableCount: D.count,
  totalVertices: TOTAL / 2,
  physicsNote: 'Cubism Core does not execute physics3.json; physics is a Framework-layer (cubism4.min.js CubismPhysics) feature that writes parameter values, then calls model.update(). Any motion measured here is intrinsic to the .moc3.',
  physicsPrefixes: PHYSICS_PREFIXES,
  armResults: ARM.map(function (id) { return byId[id] || { id: id, missing: true }; }),
  top30ByDisplacementPx: ranking.slice(0, 30).map(function (r) {
    return { id: r.id, maxDisplacementPx: r.maxDisplacementPx, movedVertsMax: r.movedVertsMax, movedVertsMin: r.movedVertsMin, opacityChangedMax: r.opacityChangedMax, opacityChangedMin: r.opacityChangedMin, min: r.min, max: r.max, default: r.default, movedDrawableIds: r.movedDrawableIds };
  }),
  counts: {
    total: results.length,
    flatRange: results.filter(function (r) { return r.flat; }).length,
    zeroVertexInfluence: results.filter(function (r) { return !r.flat && r.maxDisplacementPx === 0; }).length,
    zeroEverything: results.filter(function (r) { return !r.flat && r.maxDisplacementPx === 0 && !r.opacityChangedMax && !r.opacityChangedMin && !r.colorChangedMax && !r.colorChangedMin && !r.visibilityChangedMax && !r.visibilityChangedMin; }).length,
    opacityOnly: results.filter(function (r) { return !r.flat && r.maxDisplacementPx === 0 && (r.opacityChangedMax || r.opacityChangedMin || r.visibilityChangedMax || r.visibilityChangedMin || r.colorChangedMax || r.colorChangedMin); }).length,
  },
  results: results,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');

console.log('elapsed', ((Date.now() - t0) / 1000).toFixed(1) + 's  counts:', JSON.stringify(out.counts));
console.log('ARM RESULTS:');
for (const id of ARM) {
  const r = byId[id];
  console.log('  ', id, JSON.stringify({ min: r.min, max: r.max, default: r.default, movedVertsMax: r.movedVertsMax, movedVertsMin: r.movedVertsMin, maxDisplacementPx: +r.maxDisplacementPx.toFixed(1), maxDir: r.maxDir, drawables: r.movedDrawableIds }));
}
console.log('zero-influence (vertex) ids:', JSON.stringify(results.filter(function (r) { return !r.flat && r.maxDisplacementPx === 0; }).map(function (r) { return r.id; })));
console.log('of those, opacity/colour switches:', JSON.stringify(results.filter(function (r) { return !r.flat && r.maxDisplacementPx === 0 && (r.opacityChangedMax || r.opacityChangedMin || r.colorChangedMax || r.colorChangedMin || r.visibilityChangedMax || r.visibilityChangedMin); }).map(function (r) { return r.id + '(op' + Math.max(r.opacityChangedMax, r.opacityChangedMin) + ',col' + Math.max(r.colorChangedMax, r.colorChangedMin) + ',vis' + Math.max(r.visibilityChangedMax, r.visibilityChangedMin) + ')'; })));
console.log('truly inert ids:', JSON.stringify(results.filter(function (r) { return !r.flat && r.maxDisplacementPx === 0 && !r.opacityChangedMax && !r.opacityChangedMin && !r.colorChangedMax && !r.colorChangedMin && !r.visibilityChangedMax && !r.visibilityChangedMin; }).map(function (r) { return r.id; })));
console.log('TOP 30:');
for (const r of ranking.slice(0, 30)) console.log('  ', r.id.padEnd(26), 'px=' + r.maxDisplacementPx.toFixed(1).padStart(9), 'mvMax=' + String(r.movedVertsMax).padStart(5), 'mvMin=' + String(r.movedVertsMin).padStart(5), 'op=' + Math.max(r.opacityChangedMax, r.opacityChangedMin), 'col=' + Math.max(r.colorChangedMax, r.colorChangedMin), '[' + r.min + ',' + r.max + '] def=' + r.default);
console.log('wrote:', OUT);
