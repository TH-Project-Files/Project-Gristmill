/**
 * Observation log — append-only JSONL, the boundary engine's memory across rounds and sessions.
 * One line per executed run: cell, coordinates, oracle verdict vector, cost, runner, model version.
 */
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const coordKey = coords => Object.keys(coords).sort().map(k => `${k}=${coords[k]}`).join(';');

export function loadObservations(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

export function appendObservations(file, obs, now) {
  if (!obs.length) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, obs.map(o => JSON.stringify({ ...o, ts: now })).join('\n') + '\n');
}

/** Group observations by coordinate key; returns Map(key -> { coords, obs[], n, fails, p_fail }). */
export function indexByCell(observations) {
  const m = new Map();
  for (const o of observations) {
    const k = coordKey(o.coords);
    if (!m.has(k)) m.set(k, { key: k, coords: o.coords, obs: [], n: 0, fails: 0 });
    const e = m.get(k); e.obs.push(o); e.n++; if (!o.pass) e.fails++;
  }
  for (const e of m.values()) e.p_fail = e.n ? e.fails / e.n : 0;
  return m;
}
