/**
 * Bounded search over the session state machine, plus delegation-cycle detection.
 * BFS to `depth` from each entry's initial state, deduplicating on stateKey so the frontier stays
 * small, and keeping the SHORTEST path to every state. Exhaustive to the stated depth, and says so.
 */
import { initialState, stateKey, events, apply, describeEvent } from './state.mjs';

/**
 * Returns, per entry, EVERY transition's resulting state+path (so a property check never misses a
 * witness to dedup) while only RECURSING from newly-seen states (so the frontier stays bounded).
 * `states` therefore holds the shortest path to each distinct state AND every transition's state.
 */
export function explore(model, { depth = 5, entries = null } = {}) {
  const results = [];
  for (const e of (entries || model.entries.map(x => x.id))) {
    const start = initialState(model, e);
    const seen = new Set([stateKey(start)]);
    const all = [{ state: start, path: [] }];
    let frontier = [{ state: start, path: [] }];
    let expanded = 0;
    for (let d = 0; d < depth && frontier.length; d++) {
      const next = [];
      for (const { state, path } of frontier) for (const ev of events(model, state)) {
        const ns = apply(model, state, ev);
        expanded++;
        const k = stateKey(ns);
        const isNew = !seen.has(k);
        // Retain a transition only when it is a new state (BFS needs it) or it carries a just_*
        // marker (a rule's witness) — everything else is bulk the rules never read, and dropping
        // it keeps memory linear in distinct states rather than in raw expansions.
        if (isNew || ns.just_ungated || ns.just_reused || ns.just_leaked || ns.just_handoff) {
          const rec = { state: ns, path: [...path, describeEvent(ev)] };
          all.push(rec);
          if (isNew) { seen.add(k); next.push(rec); }
        }
      }
      frontier = next;
    }
    results.push({ entry: e, states: all, distinct: seen.size, expanded, depth });
  }
  return results;
}

/** Tarjan SCC over the actor delegation graph; returns cycles (SCCs with >1 node or a self-loop). */
export function delegationCycles(model) {
  const adj = new Map(model.actors.map(a => [a.id, a.can_delegate_to]));
  let index = 0;
  const idx = new Map(), low = new Map(), onStack = new Set(), stack = [], sccs = [];
  const strong = v => {
    idx.set(v, index); low.set(v, index); index++; stack.push(v); onStack.add(v);
    for (const w of adj.get(v) || []) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) { const comp = []; let w; do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v); sccs.push(comp); }
  };
  for (const a of model.actors) if (!idx.has(a.id)) strong(a.id);
  return sccs.filter(c => c.length > 1 || (adj.get(c[0]) || []).includes(c[0]));
}
