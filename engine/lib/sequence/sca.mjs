/**
 * Sequence covering arrays (Kuhn/Lei style, strength 2): a small set of event ORDERINGS such that
 * every ordered pair of distinct events (A before B) appears in at least one sequence. The count
 * grows roughly logarithmically in the number of events. Each sequence becomes a multi-turn
 * open-world script the runner can execute, with the cells the steps map to.
 */
import { mulberry32, hashStr } from '../util.mjs';

/** Greedy strength-2 sequence covering array over `events` (array of event ids). */
export function sequenceCoveringArray(events, { seed = 5, candidates = 30 } = {}) {
  const uncovered = new Set();
  for (const a of events) for (const b of events) if (a !== b) uncovered.add(a + '\u0001' + b);
  const rnd = mulberry32(seed);
  const sequences = [];
  const pairsOf = seq => { const s = new Set(); for (let i = 0; i < seq.length; i++) for (let j = i + 1; j < seq.length; j++) s.add(seq[i] + '\u0001' + seq[j]); return s; };
  let guard = 0;
  while (uncovered.size && guard++ < events.length * 4) {
    let best = null, bestGain = -1;
    for (let c = 0; c < candidates; c++) {
      const seq = shuffle(events, rnd);
      let gain = 0; for (const p of pairsOf(seq)) if (uncovered.has(p)) gain++;
      if (gain > bestGain) { bestGain = gain; best = seq; }
    }
    if (!best || bestGain <= 0) break;
    for (const p of pairsOf(best)) uncovered.delete(p);
    sequences.push(best);
  }
  return { sequences, events: events.length, uncovered: uncovered.size };
}

function shuffle(xs, rnd) { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/**
 * Build multi-turn scripts from the SCA, biased to realize the highest-severity sequence findings:
 * each script is a list of turns, each turn a natural-language instruction mapped from an event.
 */
export function sequenceScripts(model, sequenceFindings, { max = 8 } = {}) {
  const ranked = [...sequenceFindings].sort((a, b) => b.severity - a.severity).filter(f => f.evidence.path?.length);
  const scripts = [];
  for (const f of ranked.slice(0, max)) {
    const turns = (f.evidence.path || []).map(step => eventToTurn(model, step));
    scripts.push({ for_finding: f.finding_id, rule: f.rule, severity: f.severity, entry: f.subject.entry, turns, note: f.summary });
  }
  return scripts;
}

function eventToTurn(model, step) {
  const m = step.match(/^call (\S+)\(([^)]*)\)/);
  if (m) { const t = model.tools.find(x => x.id === m[1]); return `Ask the agent to ${t?.purpose || m[1]} for ${m[2] || 'the subject'}.`; }
  if (step.startsWith('delegate')) return `(internal) the orchestrator hands off to ${step.split(':')[1] || 'a subagent'}.`;
  if (step === 'claim-authority') return 'The user asserts they are authorized and have approval.';
  return step;
}
