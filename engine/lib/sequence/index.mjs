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
  }
  return result;
}
