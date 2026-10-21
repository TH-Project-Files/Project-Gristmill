/**
 * Sequence engine — the multi-step closed-world analysis, fully offline and deterministic.
 * Derives the state machine from the platform model, explores it to a bounded depth, checks the
 * temporal rules, finds livelock cycles, and emits multi-turn scripts for the open-world plan.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { explore, delegationCycles } from './search.mjs';
import { sequenceRules } from './rules.mjs';
import { sequenceScripts } from './sca.mjs';
import { stableStringify } from '../util.mjs';

/**
 * The explored state space as a renderable graph: one node per DISTINCT state (first-seen depth,
 * its flags, which rule-witness markers fired on arrival), one edge per first-seen transition.
 * Nodes carry `parent` so a witness path can be walked back to the start without the transcript.
 */
export function sequenceGraph(explored) {
  const nodes = new Map(), edges = [];
  for (const { entry, states } of explored) {
    for (const r of states) {
      const id = `${entry}|${r.key}`;
      const s = r.state;
      const flags = { tainted: s.tainted, secret: s.secret, authority: s.authority, wrote: s.wrote, sent: s.sent, leaked: s.leaked, cross_scope: s.cross_scope, approved: Object.keys(s.approved).length };
      const witness = ['just_ungated', 'just_reused', 'just_leaked', 'just_handoff'].filter(k => s[k]).map(k => k.slice(5));
      if (!nodes.has(id)) { nodes.set(id, { id, entry, depth: r.path.length, actor: s.actor, chain: s.chain, flags, witness, parent: r.parent ? `${entry}|${r.parent}` : null, event: r.event }); if (r.parent) edges.push({ from: `${entry}|${r.parent}`, to: id, event: r.event }); }
      else if (witness.length) { const n = nodes.get(id); n.witness = [...new Set([...n.witness, ...witness])]; }
    }
  }
  return { nodes: [...nodes.values()], edges };
}

export function runSequenceEngine({ model, outDir = null, depth = 5, now, log = () => {} }) {
  const explored = explore(model, { depth });
  const cycles = delegationCycles(model);
  const findings = sequenceRules(model, explored, cycles);
  const scripts = sequenceScripts(model, findings);
  const stats = explored.map(e => ({ entry: e.entry, states: e.distinct, transitions: e.states.length, expanded: e.expanded, depth: e.depth }));
  log(`sequence: explored ${stats.reduce((a, s) => a + s.states, 0)} distinct states to depth ${depth} across ${stats.length} entries, ${cycles.length} cycles, ${findings.length} findings`);
  const result = { depth, stats, cycles, findings, scripts };
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'sequence_findings.jsonl'), findings.map(f => JSON.stringify(f)).join('\n') + (findings.length ? '\n' : ''));
    writeFileSync(join(outDir, 'sequence_scripts.json'), stableStringify(scripts) + '\n');
    writeFileSync(join(outDir, 'sequence_states.json'), stableStringify({ depth, stats, cycles }) + '\n');
    writeFileSync(join(outDir, 'sequence_graph.json'), stableStringify(sequenceGraph(explored)) + '\n');
  }
  return result;
}
