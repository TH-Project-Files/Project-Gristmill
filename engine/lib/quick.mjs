/**
 * `gm2 quick` — the default path for people who don't want to choose anything.
 *
 * Every decision is made for you, always on the safe side:
 *   - DRY: no model, no network, no credentials, no target backends. Nothing is executed that you
 *     didn't write yourself — a compiled package is READ, not run, unless you add --allow-exec.
 *   - FULL MAPPING: every offline layer runs — structural rules over every route, the multi-step
 *     sequence engine, the semantic lattice with pairwise coverage, the L1 harness wherever handlers
 *     are available, set-cover ranking, and the open-world plan.
 *   - LOW EFFORT: pairwise (not 3-wise) coverage, sequence depth 4, a 20-run open-world plan. On a
 *     typical agent this finishes in seconds.
 * It ends with a short brief in plain language: what it looked at, what to fix first, how much to
 * trust it, and only the next steps that actually apply to this target.
 */
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { runPipeline } from './pipeline.mjs';
import { enumerateRoutes } from './model.mjs';

export const QUICK_PRESET = { strength: 2, depth: 4, budget: 20, fullIfAtMost: 2000, allowExec: false };

/** Pick a target when none is given: the current directory, if it looks like an agent. */
export function resolveQuickTarget(target, cwd = process.cwd()) {
  if (target) return resolve(target);
  for (const f of ['describe.mjs', 'agent.mjs']) if (existsSync(join(cwd, f))) return join(cwd, f);
  if (existsSync(join(cwd, 'manifest.json')) || existsSync(join(cwd, 'src'))) return cwd;
  return null;
}

export async function runQuick({ target, out, allowExec = false, now, log = () => {} } = {}) {
  const t = resolveQuickTarget(target);
  if (!t) throw new Error('No target given and the current directory does not look like an agent (no manifest.json, src/, describe.mjs or agent.mjs). Pass --target <agent directory or describe.mjs>.');
  const name = basename(statSync(t).isDirectory() ? t : resolve(t, '..')).replace(/[^\w.-]+/g, '-') || 'target';
  const outDir = resolve(out || join('workspace', `quick-${name}`));
  const r = await runPipeline({ target: t, out: outDir, ...QUICK_PRESET, allowExec, now, log });
  const brief = writeBrief(r, { target: t, allowExec });
  writeFileSync(join(outDir, 'quick.md'), brief);
  return { ...r, brief, outDir };
}

function writeBrief(r, { target, allowExec }) {
  const { model, plan, lattice, sequence, harness } = r;
  const notes = model.extraction.notes || [];
  const routes = enumerateRoutes(model).length;
  const tasks = (plan.groups || []).slice(0, 5);
  const L = [];
  L.push(`# Quick audit: ${model.target.name} ${model.target.version || ''}`.trim(), '');
  L.push(`Dry run. No model, network or credentials were used${allowExec ? '; the package was executed inside the sandbox' : ' and no package code was executed'}.`, '');

  L.push('## What it looked at', '');
  L.push(`- ${model.tools.length} tools, ${model.actors.length} actors, ${routes} routes, read via ${model.extraction.method} (${model.extraction.confidence}).`);
  if (sequence) L.push(`- ${sequence.stats.reduce((a, s) => a + s.states, 0)} reachable multi-step states, explored to depth ${sequence.depth}.`);
  if (lattice) L.push(`- ${lattice.valid_cells_total.toLocaleString()} kinds of request, covered pairwise by ${lattice.enumerated_cells} representative cells.`);
  L.push(`- ${harness?.length || 0} tool handlers executed against fakes (L1).`, '');

  if (model.tools.length === 0) L.push('**It saw no tools, so the findings below say almost nothing about this agent.** See the next steps.', '');

  L.push('## Fix first', '');
  if (!tasks.length) L.push('Nothing to fix was found in what it could see.');
  for (const g of tasks) L.push(`${g.order}. **${g.group_id}** — ${g.description} *(closes ${g.closes_findings} finding${g.closes_findings === 1 ? '' : 's'}, lowest evidence ${g.min_fidelity})*`);
  L.push('');

  L.push('## How much to trust it', '');
  L.push(`Confidence: **${plan.evidence_confidence}**. Findings at L0 are facts about the wiring ("this action is reachable without a gate"), not observations of what the model does. L1 findings ran real handler code.`, '');

  const steps = nextSteps({ model, notes, allowExec, target, harness });
  L.push('## Next steps (only the ones that apply)', '');
  steps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
  L.push('', `Full detail: summary.md and plan.json in this folder. To see it in 3D (risk field colour-mapped secure/efficient vs. insecure/inefficient): \`node bin/gm2.mjs render --in <this folder>\`.`, '');
  return L.join('\n');
}

function nextSteps({ model, notes, allowExec, target, harness }) {
  const s = [];
  const compiledUnrun = notes.some(n => n.includes('--kind compiled'));
  const threw = notes.some(n => n.includes('createTools() threw'));
  if (compiledUnrun) s.push(`This target ships only compiled code, so it was read but not run. To list its real tools and run them against fakes (sandboxed: network refused, host secrets hidden), rerun with \`--allow-exec\`:\n   \`node bin/gm2.mjs quick --target ${target} --allow-exec\``);
  if (threw) s.push('The package failed while loading its tools (it reaches for a database, registry or client). Stub those in a small `describe.mjs` — see docs/EXPORTING_A_TARGET.md, path B.');
  if (!compiledUnrun && !threw && model.extraction.confidence !== 'exact' && !(harness?.length)) s.push('To run your real handlers (L1) and get findings about actual code, add a one-file `describe.mjs` that binds them — see docs/EXPORTING_A_TARGET.md, path B.');
  s.push('To measure how each defense holds under pressure (a code gate versus a prompt instruction), run the boundary engine with your harness\'s model access — see docs/PORTABLE_RUNNER.md. It is optional and spends tokens.');
  return s.slice(0, 3);
}
