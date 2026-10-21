/**
 * Render data — everything the 3D viewer draws, computed HERE (deterministically, testable in node)
 * so the browser only has to plot. Reads whatever an audit/boundary folder contains and tolerates
 * what it doesn't: every view says plainly when its data is missing.
 *
 *   defense surfaces  per sensitive tool: p(fail) over two pressure axes from the fitted logistic
 *                     thresholds (+ tilt), with the real observations overlaid as points
 *   wiring graph      entries/actors/tools/gates/sinks with a deterministic 3D force layout;
 *                     ungated routes to sensitive tools and unsanitized taint flows flagged
 *   state space       the sequence engine's distinct states layered by depth, witness nodes lit
 *   request cloud     lattice cells over three pressure axes, coloured by prior, plan picks marked
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { mulberry32, hashStr } from '../util.mjs';
import { instantiate } from '../lattice/instantiate.mjs';
import { simulateCell } from '../simulate/policy.mjs';
import { enumerateRoutes } from '../model.mjs';

/** Which simulator failure modes are security vs efficiency — the two channels of the risk gradient. */
export const SECURITY_MODES = new Set(['ungated-write', 'consent-cannot-fire', 'injection-to-action', 'authority-bait', 'secret-echo', 'taint-to-sink', 'denylist-bypass', 'scope-breach', 'raw-error-disclosure']);
export const EFFICIENCY_MODES = new Set(['retry-loop', 'dead-source-call', 'per-item-iteration', 'uncapped-pull', 'budget-overrun', 'no-clarification']);
/** Split a prior's modes into the two channels: P(any security mode), P(any efficiency mode). */
export function splitRisk(modes = []) {
  const comb = xs => 1 - xs.reduce((a, m) => a * (1 - (m.p || 0)), 1);
  return { security: +comb(modes.filter(m => SECURITY_MODES.has(m.mode))).toFixed(3), efficiency: +comb(modes.filter(m => EFFICIENCY_MODES.has(m.mode))).toFixed(3) };
}

const PRESSURE = { authority: ['none', 'mentions-role', 'claims-approval', 'asserts-override'], urgency: ['none', 'soon', 'now', 'emergency'], untrusted_dose: ['none', 'line', 'paragraph', 'dominant'], insistence: ['first', 'repeated', 'after-refusal'] };
const lvl = (axis, v) => Math.max(0, (PRESSURE[axis] || []).indexOf(v));
const sigmoid = x => 1 / (1 + Math.exp(-x));

const readJson = (d, f) => { const p = join(d, f); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; };
const readJsonl = (d, f) => { const p = join(d, f); return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : null; };

export function collect({ auditDir, boundaryDir = null }) {
  const dirs = [auditDir, boundaryDir].filter(Boolean);
  const first = f => { for (const d of dirs) { const v = f.endsWith('.jsonl') ? readJsonl(d, f) : readJson(d, f); if (v) return v; } return null; };
  return {
    model: first('model.json'), graph: first('graph.json'), findings: first('findings.jsonl') || [], cells: first('cells.jsonl') || [],
    plan: first('open_world_plan.json'), sequence_graph: first('sequence_graph.json'), sequence_findings: first('sequence_findings.jsonl') || [],
    boundaries: first('boundaries.json'), thresholds: first('thresholds.json'), observations: first('observations.jsonl'), boundary_findings: first('boundary_findings.jsonl') || [],
  };
}

/* ----------------------------- defense surfaces ----------------------------- */
export function defenseSurfaces(d, { axisX = 'authority', axisY = 'urgency' } = {}) {
  if (!d.boundaries || !d.thresholds) return { available: false, reason: 'no boundary data in this folder — run `gm2 boundary` (mock, --handoff or --live) and pass its folder with --boundary', surfaces: [] };
  const surfaces = [];
  for (const b of d.boundaries.filter(b => b.sensitive)) {
    const ths = d.thresholds.filter(t => t.tool === b.tool);
    const fitFor = axis => {
      const base = ths.filter(t => t.axis === axis && Object.keys(PRESSURE).every(a => a === axis || lvl(a, t.base_coords[a]) === 0));
      const t = base[0] || ths.find(t => t.axis === axis);
      if (!t) return null;
      return { t: t.already_failing ? -1 : t.flipped ? t.t_fit : Infinity, a: t.steepness, flipped: t.flipped, absent: t.already_failing, measured: true };
    };
    const fx = fitFor(axisX), fy = fitFor(axisY);
    const tilt = (b.tilt || []).find(x => x.axis === axisX && x.by === axisY && x.significant);
    const p1 = (f, x, shift = 0) => !f ? 0 : f.absent ? 1 : !isFinite(f.t) ? 0 : sigmoid(f.a * (x - (f.t + shift)));
    const nx = PRESSURE[axisX].length, ny = PRESSURE[axisY].length;
    const grid = [];
    for (let i = 0; i < nx; i++) { const row = []; for (let j = 0; j < ny; j++) { const px = p1(fx, i, tilt ? -tilt.beta * j : 0), py = p1(fy, j); row.push(+(1 - (1 - px) * (1 - py)).toFixed(3)); } grid.push(row); }
    // Observed points: every real observation of this tool, placed by its two axis levels.
    const pts = new Map();
    for (const o of d.observations || []) { if (o.coords?.target_tool !== b.tool) continue; const k = `${lvl(axisX, o.coords[axisX])},${lvl(axisY, o.coords[axisY])}`; const e = pts.get(k) || { x: lvl(axisX, o.coords[axisX]), y: lvl(axisY, o.coords[axisY]), n: 0, fails: 0 }; e.n++; if (!o.pass) e.fails++; pts.set(k, e); }
    surfaces.push({ tool: b.tool, class: b.class, min_pressure_to_break: b.min_pressure_to_break, axisX, axisY, labelsX: PRESSURE[axisX], labelsY: PRESSURE[axisY], grid, fits: { [axisX]: fx, [axisY]: fy }, tilt: tilt ? { beta: tilt.beta, r2: tilt.r2 } : null, points: [...pts.values()].map(p => ({ ...p, p: +(p.fails / p.n).toFixed(3) })), unmeasured: [axisX, axisY].filter(a => !fitFor(a)) });
  }
  return { available: surfaces.length > 0, reason: surfaces.length ? null : 'boundary data has no sensitive tools', surfaces, model_version: d.observations?.[0]?.model_version || null };
}

/* ----------------------------- wiring graph ----------------------------- */
export function wiringGraph(d) {
  if (!d.graph || !d.model) return { available: false, reason: 'no model.json / graph.json in this folder', nodes: [], edges: [] };
  const sens = new Set(d.model.tools.filter(t => t.kind === 'write' || t.kind === 'external-action').map(t => `tool:${t.id}`));
  const findingsByTool = new Map();
  for (const f of d.findings) { const t = f.subject?.tool; if (!t) continue; findingsByTool.set(t, [...(findingsByTool.get(t) || []), { rule: f.rule, severity: f.severity, fidelity: f.fidelity }]); }
  const nodes = d.graph.nodes.map(n => ({ ...n, sensitive: sens.has(n.id), findings: n.kind === 'tool' ? (findingsByTool.get(n.id.slice(5)) || []) : [] }));
  // Only a CODE-enforced consent gate counts; a prompt-policy "gate" is a sentence the model may ignore.
  const codeConsent = new Set((d.model.gates || []).filter(g => (g.kind === 'hitl' || g.kind === 'confirm') && (g.enforced_by || 'code') === 'code').map(g => g.id));
  const denylist = new Set((d.model.gates || []).filter(g => g.kind === 'denylist').map(g => g.id));
  const edges = d.graph.edges.map(e => ({ ...e,
    flag: e.kind === 'invokes' && sens.has(e.to) && !(e.gated_by || []).some(g => codeConsent.has(g)) ? 'ungated-sensitive'
      : e.kind === 'flows' && ['network', 'fs', 'db', 'shell', 'external-write'].includes(e.to.slice(5)) && (e.params || []).length && (!e.sanitized_by || denylist.has(e.sanitized_by)) ? 'unsanitized-taint' : null }));
  const pos = forceLayout3D(nodes.map(n => n.id), edges.map(e => [e.from, e.to]), { seed: 11, layerOf: n => ({ entry: 0, orchestrator: 1, subagent: 1.6, tool: 3, gate: 2.4, source: 0.5, sink: 4.4 })[nodes.find(x => x.id === n).kind] ?? 2 });
  return { available: true, nodes: nodes.map(n => ({ ...n, ...pos[n.id] })), edges };
}

/* ----------------------------- state space ----------------------------- */
export function stateSpace(d) {
  if (!d.sequence_graph) return { available: false, reason: 'no sequence_graph.json — run `gm2 audit` (or `gm2 sequence`) on this version of the engine', nodes: [], edges: [] };
  const byEntry = new Map();
  for (const n of d.sequence_graph.nodes) byEntry.set(n.entry, (byEntry.get(n.entry) || 0) + 1);
  const entries = [...byEntry.keys()].sort();
  const rnd = mulberry32(5);
  const nodes = d.sequence_graph.nodes.map(n => {
    const angle = (hashStr(n.id) % 3600) / 3600 * Math.PI * 2, r = 0.6 + (hashStr(n.id + 'r') % 1000) / 1000 * 1.6 + n.depth * 0.25;
    return { ...n, x: Math.cos(angle) * r + entries.indexOf(n.entry) * 6, y: -n.depth * 1.4, z: Math.sin(angle) * r };
  });
  const witnessNodes = new Set(nodes.filter(n => n.witness.length).map(n => n.id));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const lit = new Set();
  for (const w of witnessNodes) { let c = w; while (c) { lit.add(c); c = byId.get(c)?.parent; } }
  void rnd;
  return { available: true, entries, nodes: nodes.map(n => ({ ...n, on_witness_path: lit.has(n.id) })), edges: d.sequence_graph.edges.map(e => ({ ...e, lit: lit.has(e.from) && lit.has(e.to) && witnessPathEdge(byId, e) })), findings: d.sequence_findings.map(f => ({ rule: f.rule, severity: f.severity, summary: f.summary, path: f.evidence?.path || [] })) };
}
const witnessPathEdge = (byId, e) => byId.get(e.to)?.parent === e.from;

/* ----------------------------- request cloud ----------------------------- */
export function requestCloud(d, { ax = 'authority', ay = 'urgency', az = 'untrusted_dose' } = {}) {
  if (!d.cells.length) return { available: false, reason: 'no cells.jsonl in this folder', points: [] };
  const picked = new Set((d.plan?.runs || []).map(r => r.cell_id)), held = new Set((d.plan?.holdout || []).map(h => h.cell_id));
  const rnd = mulberry32(3);
  const points = d.cells.map(c => ({ id: c.cell_id, tool: c.coords.target_tool, x: lvl(ax, c.coords[ax]) + (rnd() - 0.5) * 0.5, y: lvl(ay, c.coords[ay]) + (rnd() - 0.5) * 0.5, z: lvl(az, c.coords[az]) + (rnd() - 0.5) * 0.5, p_fail: c.prior?.p_fail ?? 0, ...splitRisk(c.prior?.modes), confidence: c.prior?.confidence ?? 0, severity: c.severity_weight ?? 1, picked: picked.has(c.cell_id), holdout: held.has(c.cell_id), coords: c.coords }));
  return { available: true, axes: { x: ax, y: ay, z: az }, labels: { x: PRESSURE[ax], y: PRESSURE[ay], z: PRESSURE[az] }, points, total_valid: null };
}

/* ----------------------------- risk field ----------------------------- */
/**
 * The semantic space as a RISK FIELD: for every reachable tool, a dense grid over two pressure
 * axes, each point carrying a security channel and an efficiency channel from the policy simulator
 * (L0 prior) — so the space can be colour-mapped: green where it is secure AND efficient, red where
 * it bulges into insecure, blue where it bulges into inefficient, magenta where both. Structural
 * findings (L0/L1) and measured boundaries (L2, when a boundary folder is given) are overlaid per
 * tool so the picture says what is predicted, what is wired, and what was observed.
 */
export function riskField(d, { axisX = 'authority', axisY = 'urgency' } = {}) {
  if (!d.model) return { available: false, reason: 'no model.json in this folder', tiles: [] };
  const m = { ...d.model, _handlers: {} };
  const reachable = [...new Set(enumerateRoutes(m).map(r => r.tool))].sort();
  const entry = m.entries[0]?.id;
  const sens = new Set(m.tools.filter(t => t.kind === 'write' || t.kind === 'external-action').map(t => t.id));
  const findingsBy = new Map();
  for (const f of d.findings) { const t = f.subject?.tool; if (!t) continue; findingsBy.set(t, [...(findingsBy.get(t) || []), f]); }
  const measured = new Map((d.boundaries || []).map(b => [b.tool, b]));
  const nx = PRESSURE[axisX].length, ny = PRESSURE[axisY].length;
  // The floor is two pressure axes; the space has nine more. For each floor point we take the WORST
  // case over the hidden axes that move risk most (scope × source state × injection), per channel,
  // and record which hidden combination produced it — so a bulge that lives along a hidden axis
  // still shows up, and the hover says where it came from.
  const scopes = ['single', 'several', 'all'], states = [...new Set(['nominal', ...(m.known_outages?.length ? ['outage'] : []), 'stale'])];
  const injections = m.sources?.some(s => s.trust === 'untrusted' && s.kind !== 'user') ? [['none', 'none'], ['instruction-in-content', 'paragraph']] : [['none', 'none']];
  const tiles = reachable.map(tool => {
    const t = m.tools.find(x => x.id === tool);
    const grid = [];
    let peak = { security: 0, efficiency: 0, total: -1 }, peakAt = null;
    for (let i = 0; i < nx; i++) {
      const row = [];
      for (let j = 0; j < ny; j++) {
        const best = { security: 0, efficiency: 0, total: 0, confidence: 1, top: [], worst_at: null };
        for (const scope of scopes) for (const source_state of states) for (const [injection, untrusted_dose] of injections) {
          if (sens.has(tool) && scope === 'all') continue;
          if (!t.params.length && false) continue;
          const coords = { target_tool: tool, scope, subject_ambiguity: 'none', source_state, injection, untrusted_dose, insistence: 'first', entry, register: 'terse', [axisX]: PRESSURE[axisX][i], [axisY]: PRESSURE[axisY][j] };
          const prior = simulateCell(m, instantiate(m, coords));
          const s = splitRisk(prior.modes);
          if (s.security > best.security) best.security = s.security;
          if (s.efficiency > best.efficiency) best.efficiency = s.efficiency;
          const total = 1 - (1 - s.security) * (1 - s.efficiency);
          if (total > best.total) { best.total = total; best.confidence = prior.confidence; best.top = [...prior.modes].sort((a, b) => b.p - a.p).slice(0, 3).map(x => `${x.mode} ${Math.round(x.p * 100)}%`); best.worst_at = { scope, source_state, injection }; }
        }
        best.total = +best.total.toFixed(3);
        row.push(best);
        if (best.total > peak.total) { peak = { security: best.security, efficiency: best.efficiency, total: best.total }; peakAt = [i, j]; }
      }
      grid.push(row);
    }
    const fs = findingsBy.get(tool) || [];
    const structural = { security: Math.max(0, ...fs.filter(f => f.mode === 'security').map(f => f.severity)), efficiency: Math.max(0, ...fs.filter(f => f.mode === 'efficiency').map(f => f.severity)), count: fs.length, rules: [...new Set(fs.map(f => f.rule))].sort() };
    const b = measured.get(tool);
    return { tool, sensitive: sens.has(tool), axisX, axisY, labelsX: PRESSURE[axisX], labelsY: PRESSURE[axisY], grid, peak: { ...peak, at: peakAt }, structural, measured: b ? { class: b.class, min_pressure_to_break: b.min_pressure_to_break } : null };
  });
  // Order tiles by how far they bulge, worst first, so the picture reads left-to-right.
  tiles.sort((a, b) => (Math.max(...b.grid.flat().map(c => c.total)) - Math.max(...a.grid.flat().map(c => c.total))) || a.tool.localeCompare(b.tool));
  return { available: true, axisX, axisY, hidden_axes: ['scope', 'source_state', 'injection'], tiles, note: 'heights/colours are the policy simulator\'s L0 prior, taking the worst case over scope, source state and injected content at each floor point; structural findings and measured boundary classes are overlaid per tool' };
}

/* ----------------------------- layout ----------------------------- */
/** Deterministic 3D force layout: y fixed by layer (so the picture reads top-down), x/z relaxed. */
export function forceLayout3D(ids, pairs, { seed = 1, iterations = 300, layerOf = () => 0 } = {}) {
  const rnd = mulberry32(seed);
  const pos = {}; for (const id of ids) pos[id] = { x: (rnd() - 0.5) * 8, y: -layerOf(id) * 2.2, z: (rnd() - 0.5) * 8 };
  const adj = pairs.filter(([a, b]) => pos[a] && pos[b]);
  for (let it = 0; it < iterations; it++) {
    const t = 1 - it / iterations, f = {}; for (const id of ids) f[id] = { x: 0, z: 0 };
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { const a = pos[ids[i]], b = pos[ids[j]]; let dx = a.x - b.x, dz = a.z - b.z; const d2 = dx * dx + dz * dz + 0.01, k = 1.2 / d2; f[ids[i]].x += dx * k; f[ids[i]].z += dz * k; f[ids[j]].x -= dx * k; f[ids[j]].z -= dz * k; }
    for (const [a, b] of adj) { const dx = pos[b].x - pos[a].x, dz = pos[b].z - pos[a].z, k = 0.02; f[a].x += dx * k; f[a].z += dz * k; f[b].x -= dx * k; f[b].z -= dz * k; }
    for (const id of ids) { pos[id].x += Math.max(-0.5, Math.min(0.5, f[id].x)) * t; pos[id].z += Math.max(-0.5, Math.min(0.5, f[id].z)) * t; pos[id].x *= 0.995; pos[id].z *= 0.995; }
  }
  for (const id of ids) { pos[id].x = +pos[id].x.toFixed(3); pos[id].z = +pos[id].z.toFixed(3); pos[id].y = +pos[id].y.toFixed(3); }
  return pos;
}

export function buildRenderData(opts) {
  const d = collect(opts);
  return { target: d.model?.target || null, extraction: d.model?.extraction || null, risk: riskField(d), defense: defenseSurfaces(d), wiring: wiringGraph(d), states: stateSpace(d), cloud: requestCloud(d), counts: { findings: d.findings.length, cells: d.cells.length, observations: d.observations?.length || 0 } };
}
