/**
 * cubism-loader.mjs - load Live2D Cubism Core + dfyfish.moc3 in plain Node (no browser, no WebGL).
 *
 * HOW IT WORKS (established empirically, see _research/report notes):
 *  - live2dcubismcore.min.js is an Emscripten **wasm2js** build: the module ships its own
 *    "WebAssembly" shim and a ~200 KB compiled-JS module ("new da"), so there is NO external
 *    _em_module.wasm and NO base64 wasm payload. Nothing is fetched from the network.
 *  - Its environment sniffing takes the NODE path, so at load time it dereferences
 *    __dirname / __filename / require (module-scoped in CJS/ESM) -> a bare
 *    vm.runInThisContext() dies with "ReferenceError: __dirname is not defined".
 *    We publish those three as globals for the duration of the load.
 *  - Its base64 data-segment decoder branches on typeof Buffer; without Buffer it needs atob().
 *    Providing Buffer (or atob/btoa) is therefore required.
 *  - Compiling the wasm2js module is ASYNC: right after load, csmGetVersion() throws
 *    ("Cannot read properties of undefined (reading 'apply')") because b.asm is still {}.
 *    About a second later the runtime is live. So we poll csmGetVersion() until it returns
 *    a number. THIS POLL IS MANDATORY - without it Moc.fromArrayBuffer cannot work.
 *
 * Read-only helper (writes nothing).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

// 相对定位：从本文件往上找仓库根，别写死某台机器的路径
export const CORE_PATH = path.join(import.meta.dirname, '..', 'pet-plugin', 'assets', 'vendor', 'live2dcubismcore.min.js');
export const MOC_PATH = path.join(import.meta.dirname, '..', 'pet-plugin', 'assets', 'model', 'dfyfish.moc3');

function installNodeShims(g, target) {
  const added = [];
  if (typeof g.__dirname === 'undefined') { g.__dirname = path.dirname(target); added.push('__dirname'); }
  if (typeof g.__filename === 'undefined') { g.__filename = target; added.push('__filename'); }
  if (typeof g.require !== 'function') { g.require = createRequire(target); added.push('require'); }
  if (typeof g.Buffer === 'undefined' && typeof Buffer !== 'undefined') { g.Buffer = Buffer; added.push('Buffer'); }
  if (typeof g.atob !== 'function') {
    g.atob = function (b64) { return Buffer.from(String(b64), 'base64').toString('binary'); };
    added.push('atob');
  }
  if (typeof g.btoa !== 'function') {
    g.btoa = function (bin) { return Buffer.from(String(bin), 'binary').toString('base64'); };
    added.push('btoa');
  }
  return added;
}

export function loadCoreSync() {
  const code = fs.readFileSync(CORE_PATH, 'utf8');
  const attempts = [];
  try {
    const shims = installNodeShims(globalThis, CORE_PATH);
    attempts.push('runInThisContext(shims=' + shims.join('+') + ')');
    vm.runInThisContext(code, { filename: 'live2dcubismcore.min.js' });
    const ns = globalThis.Live2DCubismCore;
    if (ns && ns.Moc) return { core: ns, attempts };
    attempts.push('namespace-missing');
  } catch (e) {
    attempts.push('error:' + e.constructor.name + ':' + e.message);
  }
  throw new Error('could not load Cubism Core | ' + attempts.join(' || '));
}

/** The wasm2js runtime comes up asynchronously; csmGetVersion() is the readiness probe. */
export async function waitForRuntime(core, timeoutMs) {
  const limit = typeof timeoutMs === 'number' ? timeoutMs : 60000;
  const t0 = Date.now();
  let last = null;
  for (;;) {
    try {
      const v = core.Version.csmGetVersion();
      if (typeof v === 'number') return { version: v, waitedMs: Date.now() - t0, lastError: last };
    } catch (e) { last = e.message; }
    if (Date.now() - t0 > limit) throw new Error('timed out after ' + limit + 'ms waiting for Cubism Core runtime; last error: ' + last);
    await new Promise(function (r) { setTimeout(r, 50); });
  }
}

export function readArrayBuffer(file) {
  const buf = fs.readFileSync(file);
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return { ab, bytes: buf.byteLength };
}

export async function loadModel() {
  const { core, attempts } = loadCoreSync();
  const ready = await waitForRuntime(core);
  const { ab, bytes } = readArrayBuffer(MOC_PATH);
  const moc = core.Moc.fromArrayBuffer(ab);
  if (!moc) throw new Error('Moc.fromArrayBuffer returned falsy');
  const model = core.Model.fromMoc(moc);
  if (!model) throw new Error('Model.fromMoc returned falsy');
  return { core, moc, model, bytes, attempts, version: ready.version, waitedMs: ready.waitedMs };
}

/** parameters.ids is normally a plain string[]; be defensive about csm wrappers. */
export function readParamIds(model) {
  const p = model.parameters;
  const ids = [];
  for (let i = 0; i < p.count; i++) {
    const v = p.ids[i];
    ids.push(typeof v === 'string' ? v : (v == null ? null : String(v.s !== undefined ? v.s : v)));
  }
  return ids;
}

export function readParams(model) {
  const p = model.parameters;
  const ids = readParamIds(model);
  const out = [];
  for (let i = 0; i < p.count; i++) {
    out.push({ index: i, id: ids[i], min: p.minimumValues[i], max: p.maximumValues[i], default: p.defaultValues[i] });
  }
  return out;
}

export function shapeOf(o) {
  if (o == null) return String(o);
  const proto = Object.getPrototypeOf(o);
  return {
    ctor: o.constructor ? o.constructor.name : null,
    isArray: Array.isArray(o),
    typeofLength: typeof o.length,
    length: o.length,
    ownProps: Object.getOwnPropertyNames(o).slice(0, 60),
    protoProps: proto ? Object.getOwnPropertyNames(proto).slice(0, 80) : null,
  };
}
