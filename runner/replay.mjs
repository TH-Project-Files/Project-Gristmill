/**
 * Write a finished Workflow campaign's artifacts to disk.
 * ======================================================
 * The bundled campaign runs inside the Workflow tool with an in-memory io (Workflow scripts have
 * no filesystem). Every agent() call it made carried a deterministic tag (`[gm-call:<label>]`) on
 * its first line. This script reads the run's journal (result per agent) and each agent's
 * transcript (its first prompt, so the tag), then re-runs the SAME control flow from
 * runner/core.js under node, answering each agent() call from that map, with the real
 * filesystem io. Same inputs + same answers = the same artifacts the workflow computed in memory.
 *
 * Refuses when: the campaign's memory changed since bundling (append-only history would
 * diverge), the run directory already exists (it would double-append), or the replay asks for a
 * call the journal has no answer for while the workflow had one (divergence). Missing answers
 * that were also missing in the workflow (a skipped or dead agent) replay as null, exactly as the
 * workflow saw them.
 *
 * Usage:
 *   node runner/replay.mjs --campaign workspace/<id> --transcripts <dir with journal.jsonl> --now <ISO> [--expect <result.json>]
 * Writes the full artifact chain plus runs/<run>/agent_calls.jsonl (every tagged call and its
 * answer: the judges' justifications and the verifiers' reasons live there), then validates
 * every artifact against schemas/.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as core from './core.js';
import { nodeIo } from './gristmill.workflow.js';
import { memorySeed, seedHash, coreBody } from './bundle.mjs';
import { validateValue } from './validate.mjs';
import { createHash } from 'node:crypto';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAG_RE = /\[gm-call:([^\]\s]+)\]/;

function argv() {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) out[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
  return out;
}

const firstPromptText = (line) => {
  const rec = JSON.parse(line);
  const c = rec && rec.message && rec.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(p => (typeof p === 'string' ? p : p && p.text) || '').join('\n');
  return '';
};

/**
 * tag -> result, from a Workflow run's journal.jsonl + agent-<id>.jsonl transcripts.
 *
 * A resumed run can hold two agents for one tag: the original (a result, or killed in flight) and
 * a live re-run, because resume only reuses the unchanged prefix of calls. The workflow used the
 * LATEST result, so replay does too: among agents with a result, the one whose result line comes
 * last in the journal wins. An agent with no result is ignored when another has one.
 */
export function readCalls(transcriptDir) {
  const journal = path.join(transcriptDir, 'journal.jsonl');
  if (!existsSync(journal)) throw new Error(`no journal.jsonl in ${transcriptDir}`);
  const resultByAgent = new Map();
  const order = new Map();
  readFileSync(journal, 'utf8').split('\n').filter(Boolean).forEach((line, i) => {
    const r = JSON.parse(line);
    if (r.type === 'result' && r.agentId) { resultByAgent.set(r.agentId, r.result); order.set(r.agentId, i); }
  });
  const best = new Map(); // tag -> { agentId, at } where at = journal line of its result, or -1
  const untagged = [];
  let duplicates = 0;
  for (const f of readdirSync(transcriptDir).filter(f => /^agent-.*\.jsonl$/.test(f))) {
    const agentId = f.slice('agent-'.length, -'.jsonl'.length);
    const first = readFileSync(path.join(transcriptDir, f), 'utf8').split('\n').find(Boolean);
    if (!first) continue;
    // The Workflow runtime prepends its own provenance preamble (~425 chars) and indents the
    // computed task, so the tag is the FIRST match near the top, not at column 0.
    const m = TAG_RE.exec(firstPromptText(first).slice(0, 4000));
    if (!m) { untagged.push(agentId); continue; }
    const at = order.has(agentId) ? order.get(agentId) : -1;
    const cur = best.get(m[1]);
    if (cur) duplicates++;
    if (!cur || at > cur.at) best.set(m[1], { agentId, at });
  }
  const calls = new Map([...best].map(([tag, { agentId, at }]) => [tag, at >= 0 ? resultByAgent.get(agentId) : null]));
  return { calls, untagged, duplicates };
}

export async function replay({ campaignDir, transcriptDir, now, expect }) {
  const inputs = JSON.parse(readFileSync(path.join(campaignDir, 'workflow', 'inputs.json'), 'utf8'));
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  if (sha(coreBody()) !== inputs.core_sha) throw new Error('runner/core.js changed since bundling: replay would not run the code the workflow ran');
  const seed = memorySeed(campaignDir, inputs.config.campaign_id);
  if (seedHash(seed) !== inputs.memory_seed_sha) throw new Error('campaign memory changed since bundling: re-bundle (and re-run) instead of replaying');
  const runDir = path.join(KIT, 'workspace', inputs.config.campaign_id, 'runs', `${now.slice(0, 10)}-run-001`);
  if (existsSync(runDir)) throw new Error(`${runDir} already exists: replaying would double-append to it`);

  const { calls, untagged, duplicates } = readCalls(transcriptDir);
  const asked = [];
  const agent = async (prompt) => {
    const m = TAG_RE.exec(prompt);
    asked.push(m[1]);
    return calls.has(m[1]) ? calls.get(m[1]) : undefined;
  };
  const engine = core.workflowEngine({ agent, texts: inputs.texts, schemas: inputs.schemas, config: inputs.config });
  const res = await core.runCampaign({ config: inputs.config, engine, adapter: core.dataAdapter(inputs.adapter), io: nodeIo, kitDir: KIT, now, log: (m) => console.error(m) });

  const missing = asked.filter(t => !calls.has(t));
  const unused = [...calls.keys()].filter(t => !asked.includes(t));
  writeFileSync(path.join(res.runDir, 'agent_calls.jsonl'), asked.map(t => JSON.stringify({ tag: t, result: calls.has(t) ? calls.get(t) : null })).join('\n') + '\n');

  // Validate every artifact the run wrote.
  const mem = path.join(campaignDir, 'memory');
  const pairs = [
    ['target-profile.schema.json', path.join(mem, 'target_profile.json')],
    ['fingerprint.schema.json', path.join(mem, 'scenario_fingerprints.jsonl')],
    ['finding.schema.json', path.join(mem, 'long_term_findings.jsonl')],
    ['cluster.schema.json', path.join(mem, 'issue_clusters.json')],
    ['scenario.schema.json', path.join(res.runDir, 'scenarios.jsonl')],
    ['trace.schema.json', path.join(res.runDir, 'traces.jsonl')],
    ['score.schema.json', path.join(res.runDir, 'scores.jsonl')],
    ['plan.schema.json', path.join(res.runDir, 'plan.json')],
    ['regression.schema.json', path.join(res.runDir, 'regression.json')],
    ['run-config.schema.json', path.join(res.runDir, 'config.json')],
  ];
  const invalid = [];
  for (const [schema, file] of pairs) {
    if (!existsSync(file)) continue;
    const raw = readFileSync(file, 'utf8').trim();
    const rows = file.endsWith('.jsonl') ? raw.split('\n').filter(Boolean).map(l => JSON.parse(l)) : (() => { const p = JSON.parse(raw); return Array.isArray(p) ? p : [p]; })();
    rows.forEach((row, i) => { for (const e of validateValue(schema, row)) invalid.push(`${path.basename(file)}[${i}] ${e}`); });
  }

  let matches = null;
  if (expect) {
    const want = JSON.parse(readFileSync(expect, 'utf8'));
    const keys = ['converged', 'rounds', 'findings', 'clusters', 'evidence_confidence', 'evidence_loopback'];
    matches = keys.every(k => want[k] === res[k]) && (!want.summary || want.summary === readFileSync(path.join(res.runDir, 'summary.md'), 'utf8'));
  }
  return { ...res, calls_answered: asked.length - missing.length, calls_missing: missing, calls_unused: unused, untagged_agents: untagged.length, resumed_duplicate_agents: duplicates, invalid, matches_workflow_result: matches };
}

async function main() {
  const a = argv();
  if (!a.campaign || !a.transcripts || !a.now) { console.error('usage: node runner/replay.mjs --campaign workspace/<id> --transcripts <dir> --now <ISO> [--expect <result.json>]'); process.exit(2); }
  const out = await replay({ campaignDir: path.resolve(a.campaign), transcriptDir: path.resolve(a.transcripts), now: a.now, expect: a.expect });
  console.log(JSON.stringify(out, null, 2));
  const bad = out.invalid.length || out.calls_unused.length || out.matches_workflow_result === false;
  process.exit(bad ? 1 : 0);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) main().catch(e => { console.error(e.message || e); process.exit(1); });
