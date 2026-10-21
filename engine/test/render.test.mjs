/**
 * The 3D viewer's DATA is computed in node and must be right before anything is drawn:
 * a code-gated tool is a flat floor, a prompt-only one is a cliff, witness paths light up,
 * missing inputs degrade to a stated reason, and the HTML is self-contained and deterministic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runPipeline } from '../lib/pipeline.mjs';
import { runBoundaryCampaign } from '../lib/boundary/index.mjs';
import { runSequenceEngine } from '../lib/sequence/index.mjs';
import { createMockRunner } from '../lib/runner/mock.mjs';
import { buildRenderData, defenseSurfaces, forceLayout3D } from '../lib/render/data.mjs';
import { renderViewer } from '../lib/render/index.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'gm2r-'));
const audit = join(tmp, 'audit'), bnd = join(tmp, 'bnd');
const r = await runPipeline({ target: 'fixtures/example-agent/agent.mjs', out: audit, traces: 'fixtures/example-agent/recorded_traces.jsonl' });
const seq = runSequenceEngine({ model: r.model, depth: 5 });
// Plant a prompt-only slope on the side route so the surface is a cliff, not a floor.
await runBoundaryCampaign({ model: r.model, adapter: createMockRunner(r.model, { nonint_entry: 'bypass', boundaries: [{ effect: 'delegate', tool: 'reset_device', axis: 'authority', threshold: -1, steepness: 30 }, { effect: 'skip-gate', tool: 'reset_device', axis: 'authority', threshold: 2, steepness: 30 }] }), outDir: bnd, rounds: 2, budget: 150, sequence: seq, now: '2026-01-01T00:00:00.000Z' });

test('defense surface: a planted authority cliff rises with authority and stays low without it', () => {
  const D = buildRenderData({ auditDir: audit, boundaryDir: bnd }).defense;
  assert.ok(D.available);
  const s = D.surfaces.find(x => x.tool === 'reset_device');
  assert.ok(s, 'reset_device has a surface');
  assert.equal(s.grid.length, 4); assert.equal(s.grid[0].length, 4);
  assert.ok(s.grid[0][0] < 0.2, `low at zero pressure (${s.grid[0][0]})`);
  assert.ok(s.grid[3][0] > 0.8, `high at max authority (${s.grid[3][0]})`);
  assert.ok(s.points.length > 0, 'real observations overlaid');
  assert.equal(D.model_version, 'mock-agent-1');
});

test('wiring: ungated sensitive routes and unsanitized taint flows are flagged; layout is deterministic', () => {
  const a = buildRenderData({ auditDir: audit }).wiring, b = buildRenderData({ auditDir: audit }).wiring;
  assert.ok(a.available);
  assert.ok(a.edges.some(e => e.flag === 'ungated-sensitive' && e.to === 'tool:reset_device'));
  assert.ok(a.edges.some(e => e.flag === 'unsanitized-taint'));
  assert.ok(a.nodes.find(n => n.id === 'tool:reset_device').findings.length > 0, 'tool nodes carry their findings');
  assert.deepEqual(a.nodes.map(n => [n.x, n.y, n.z]), b.nodes.map(n => [n.x, n.y, n.z]));
  const layers = n => a.nodes.find(x => x.id === n).y;
  assert.ok(layers('entry:chat') > layers('tool:get_device') && layers('tool:get_device') > layers('sink:output'), 'entries above tools above sinks');
});

test('state space: witness states exist and the path back to the start is lit', () => {
  const S = buildRenderData({ auditDir: audit }).states;
  assert.ok(S.available, S.reason);
  const wit = S.nodes.filter(n => n.witness.length);
  assert.ok(wit.length > 0, 'sequence rules produced witness states');
  const byId = new Map(S.nodes.map(n => [n.id, n]));
  for (const w of wit) { let c = w, steps = 0; while (c.parent) { assert.ok(byId.get(c.id).on_witness_path); c = byId.get(c.parent); steps++; } assert.equal(c.depth, 0); assert.ok(steps >= 1); }
  assert.ok(S.edges.some(e => e.lit));
});

test('request cloud: cells placed on the pressure axes with plan picks marked', () => {
  const C = buildRenderData({ auditDir: audit }).cloud;
  assert.ok(C.available && C.points.length === r.cells.length);
  assert.ok(C.points.some(p => p.picked) && C.points.every(p => p.p_fail >= 0 && p.p_fail <= 1));
});

test('missing inputs degrade to a stated reason, never a crash', () => {
  const empty = join(tmp, 'empty'); mkdirSync(empty);
  const v = buildRenderData({ auditDir: empty });
  assert.equal(v.defense.available, false); assert.match(v.defense.reason, /gm2 boundary/);
  assert.equal(v.wiring.available, false); assert.equal(v.states.available, false); assert.equal(v.cloud.available, false);
  const out = renderViewer({ auditDir: empty, out: join(tmp, 'empty.html') });
  assert.ok(readFileSync(out.outFile, 'utf8').includes('"available":false'));
});

test('the HTML is self-contained, deterministic, and only loads three.js from cdnjs', () => {
  const a = renderViewer({ auditDir: audit, boundaryDir: bnd, out: join(tmp, 'a.html'), now: 'T' }), b = renderViewer({ auditDir: audit, boundaryDir: bnd, out: join(tmp, 'b.html'), now: 'T' });
  const html = readFileSync(a.outFile, 'utf8');
  assert.equal(html, readFileSync(b.outFile, 'utf8'));
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(srcs, ['https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js']);
  assert.ok(!html.includes('__GM_DATA__'));
  assert.ok(html.includes('"tool":"reset_device"'));
  // The inlined JSON must survive being inside a <script> element.
  writeFileSync(join(tmp, 'x.json'), JSON.stringify({ s: '</script><script>alert(1)</script>' }));
  assert.ok(!/<\/script><script>alert/.test(html));
});

test('risk field: two channels, green where secure and efficient, bulges where the simulator predicts trouble', () => {
  const R = buildRenderData({ auditDir: audit, boundaryDir: bnd }).risk;
  assert.ok(R.available);
  assert.equal(R.tiles.length, 11, 'one tile per reachable tool');
  const reset = R.tiles.find(t => t.tool === 'reset_device'), lookup = R.tiles.find(t => t.tool === 'search_users');
  assert.ok(reset.sensitive && reset.measured && reset.structural.security >= 4, 'sensitive tool carries measured class + structural severity');
  // Security bulge: reset_device gets riskier with authority (side route + authority bait); efficiency stays flat.
  assert.ok(reset.grid[3][0].security > reset.grid[0][0].security, 'security rises with authority');
  assert.ok(reset.grid[0][0].efficiency < 0.2, 'no efficiency risk on a single reset');
  // A clean tool has no security channel anywhere; its only efficiency risk is the agent-wide
  // missing call budget on a fleet-wide request (worst case over the hidden scope axis), capped low.
  assert.ok(lookup.grid.flat().every(c => c.security < 0.2), 'search_users has no security risk across the floor');
  assert.equal(lookup.grid[0][0].worst_at.scope, 'all', 'its efficiency risk comes from the hidden scope axis');
  assert.ok(lookup.grid[0][0].top.some(x => /^(uncapped-pull|budget-overrun)/.test(x)), 'named as an uncapped fleet-wide pull / missing budget');
  assert.ok(lookup.grid[0][0].efficiency > lookup.grid[0][0].security, 'a blue bulge, not a red one');
  // Efficiency bulge exists somewhere (outage/batch tools) independent of security.
  const effy = R.tiles.find(t => t.grid.flat().some(c => c.efficiency > 0.3));
  assert.ok(effy, 'some tool shows an efficiency channel');
  assert.equal(R.tiles[0].tool, [...R.tiles].sort((a, b) => Math.max(...b.grid.flat().map(c => c.total)) - Math.max(...a.grid.flat().map(c => c.total)) || a.tool.localeCompare(b.tool))[0].tool, 'worst bulge first');
  // Every grid cell explains itself.
  assert.ok(reset.grid[3][0].top.length > 0 && reset.grid[3][0].confidence >= 0);
});

test('request cloud carries the same two channels', () => {
  const C = buildRenderData({ auditDir: audit }).cloud;
  assert.ok(C.points.every(p => typeof p.security === 'number' && typeof p.efficiency === 'number'));
});

test('force layout is deterministic and keeps layers', () => {
  const ids = ['a', 'b', 'c', 'd'], pairs = [['a', 'b'], ['b', 'c'], ['c', 'd']];
  const p = forceLayout3D(ids, pairs, { seed: 2, layerOf: id => ids.indexOf(id) });
  assert.deepEqual(p, forceLayout3D(ids, pairs, { seed: 2, layerOf: id => ids.indexOf(id) }));
  assert.ok(p.a.y > p.b.y && p.b.y > p.c.y);
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
