/**
 * Browser smoke for the 3D viewer, without a browser. The viewer's inline script is EXECUTED against
 * a stubbed DOM and a recording three.js, once per view, so a syntax error, an undefined helper, or a
 * data field the drawing code expects but the data layer stopped producing fails CI instead of
 * giving a user a blank page. It checks that code runs and draws the right NUMBER of things; it
 * cannot judge how it looks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runQuick } from '../lib/quick.mjs';
import { runBoundaryCampaign } from '../lib/boundary/index.mjs';
import { runSequenceEngine } from '../lib/sequence/index.mjs';
import { createMockRunner } from '../lib/runner/mock.mjs';
import { renderViewer } from '../lib/render/index.mjs';

const VIEWS = ['risk', 'defense', 'wiring', 'states', 'cloud'];

/** Execute the viewer's script against stubs; returns per-view counts and any errors. */
export function smokeViewer(html) {
  const data = html.match(/<script id="gm-data"[^>]*>([\s\S]*?)<\/script>/)[1];
  const code = [...html.matchAll(/<script(?![^>]*src=)(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)][0][1];
  const counts = { meshes: 0, sprites: 0, lines: 0 };
  const posAttr = { count: 6, getX: () => 0, getZ: () => 0, setY() {} };
  const chain = (name) => new Proxy(function () {}, {
    construct: (_, args) => { if (name === 'Mesh') counts.meshes++; if (name === 'Sprite') counts.sprites++; if (name === 'Line') counts.lines++; return mk(); },
    apply: () => undefined, get: (t, k) => (k === 'prototype' ? {} : chain(String(k))),
  });
  function mk() {
    const store = { attributes: { position: posAttr }, userData: {}, position: { set() {}, copy() {}, x: 0, y: 0, z: 0 }, scale: { set() {} }, rotation: {}, material: { wireframe: false }, setAttribute() {}, computeVertexNormals() {}, translate() {}, rotateX() {}, add() {}, lookAt() {}, setFromPoints() { return store; }, clone() { return store; }, copy() { return store; }, set() { return store; }, setHSL() { return store; }, setFromCamera() {}, intersectObjects: () => [], getWorldDirection: () => ({}), crossVectors: () => ({ normalize: () => ({}) }), addScaledVector() {}, updateProjectionMatrix() {}, setSize() {}, setPixelRatio() {}, render() {}, up: {}, aspect: 1, r: 0, g: 0, b: 0 };
    return new Proxy(store, { get: (t, k) => (k in t ? t[k] : () => store), set: (t, k, v) => { t[k] = v; return true; } });
  }
  const THREE = new Proxy({}, { get: (_, k) => chain(String(k)) });
  const els = new Map();
  const el = (id) => { if (!els.has(id)) els.set(id, { innerHTML: '', style: {}, dataset: {}, textContent: id === 'gm-data' ? data : '', clientWidth: 800, clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), addEventListener() {}, setPointerCapture() {}, classList: { toggle() {} }, getContext: () => ({ font: '', fillStyle: '', textBaseline: '', fillText() {} }), set onchange(_f) {}, set onclick(_f) {} }); return els.get(id); };
  const buttons = VIEWS.map(v => ({ dataset: { view: v }, classList: { toggle() {} }, set onclick(f) { this._f = f; }, get onclick() { return this._f; } }));
  const document = { getElementById: (id) => el(id), querySelector: (s) => el(s.replace('#', '')), querySelectorAll: () => buttons, createElement: () => el('c' + els.size) };
  const errors = [], views = {};
  try { new Function('THREE', 'document', 'location', 'addEventListener', 'devicePixelRatio', 'requestAnimationFrame', code)(THREE, document, { hash: '' }, () => {}, 1, () => {}); } catch (e) { errors.push('init: ' + e.message); }
  for (const b of buttons) {
    try { counts.meshes = counts.sprites = counts.lines = 0; b.onclick(); views[b.dataset.view] = { ...counts, panel: el('side').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }; }
    catch (e) { errors.push(`${b.dataset.view}: ${e.message}`); }
  }
  return { errors, views };
}

const tmp = mkdtempSync(join(tmpdir(), 'gm2vs-'));
const q = await runQuick({ target: 'fixtures/example-agent/agent.mjs', out: join(tmp, 'q') });
const bnd = join(tmp, 'b');
await runBoundaryCampaign({ model: q.model, adapter: createMockRunner(q.model, {}), outDir: bnd, rounds: 1, budget: 80, sequence: runSequenceEngine({ model: q.model, depth: 4 }), now: 'T' });

test('quick produces viewer.html by default, and --no-render really skips it', async () => {
  assert.ok(q.viewer && readFileSync(q.viewer, 'utf8').includes('Gristmill viewer'));
  assert.ok(q.brief.includes('Open viewer.html'));
  const n = await runQuick({ target: 'fixtures/example-agent/agent.mjs', out: join(tmp, 'n'), render: false });
  assert.equal(n.viewer, null);
  assert.ok(!n.brief.includes('Open viewer.html'));
});

test('every view of a quick viewer runs without error and draws its data', () => {
  const { errors, views } = smokeViewer(readFileSync(q.viewer, 'utf8'));
  assert.deepEqual(errors, []);
  assert.equal(views.risk.sprites, q.model.tools.length, 'one label per tool tile');
  assert.ok(views.risk.meshes > q.model.tools.length * 5, 'tiles plus per-cell hover pads');
  assert.equal(views.wiring.sprites, 32);
  assert.ok(views.states.meshes > 100 && views.states.lines > 100);
  assert.equal(views.cloud.meshes >= q.cells.length, true);
  assert.match(views.defense.panel, /no boundary data/, 'defense view degrades to a stated reason without --boundary');
});

test('with a boundary folder the defense surfaces draw', () => {
  const html = readFileSync(renderViewer({ auditDir: q.outDir, boundaryDir: bnd, out: join(tmp, 'wb.html') }).outFile, 'utf8');
  const { errors, views } = smokeViewer(html);
  assert.deepEqual(errors, []);
  assert.ok(views.defense.meshes > 0 && /Defense surface/.test(views.defense.panel));
});

test('an empty folder still yields a viewer whose views all say why they are empty', () => {
  const empty = join(tmp, 'empty'); mkdirSync(empty);
  const { errors, views } = smokeViewer(readFileSync(renderViewer({ auditDir: empty, out: join(tmp, 'e.html') }).outFile, 'utf8'));
  assert.deepEqual(errors, []);
  for (const v of VIEWS) assert.ok(views[v].panel.length > 10, v);
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
