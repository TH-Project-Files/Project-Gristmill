# Gristmill engine

**Closed-world exhaustive dry audits of agent platforms — security and efficiency — with self-built L1 harnesses, multi-step model checking, defense-shape measurement, and a statistically selected open-world plan.**

The rest of this repository is the Gristmill *methodology*: roles, modes, schemas, rubrics, and a closed critic↔planner loop driven by an LLM. The engine keeps every honesty rule of that methodology (fidelity ladder, non-repetition, no self-flattery, honest significance) and moves everything that *can* be computed out of the model and into deterministic code. The Master Audit Prompt in the root README runs it as an optional pre-pass when a shell is available.

Requires Node 20+. No dependencies. Everything except `gm2 boundary --live` runs with no LLM, no network, and no credentials, and same inputs give byte-identical artifacts. Run every command from this `engine/` directory.

```
node bin/gm2.mjs audit --target fixtures/example-agent/agent.mjs --out workspace/example \
                       --traces fixtures/example-agent/recorded_traces.jsonl
node bin/gm2.mjs boundary --target fixtures/example-agent/agent.mjs --out workspace/boundary   # mock runner
node --test test/*.test.mjs
```

To audit your own agent, read [docs/EXPORTING_A_TARGET.md](docs/EXPORTING_A_TARGET.md): zero-effort heuristic extraction, a one-file binding that gives real handlers L1 coverage, or an exact model.

## The idea in one paragraph

An agent platform has two state spaces. The **closed world** is finite: tools, params, sinks, gates, routes, actors, entries, env vars — and the *equivalence classes* of requests (which capability, what scope, what ambiguity, what source state, injected content or not, what authority framing, which entry). That space can be enumerated and **exhausted** offline. The **open world** — phrasing and emergent model behaviour — cannot, and V2 never pretends otherwise. So V2 exhausts the closed world with structural analyzers and a semantic lattice, executes the real tool handlers under a locked harness to catch where the contract lies, replays any recorded traces as free L2 evidence, ranks fixes by *computed* set cover, and then emits a budgeted, information-gain-ordered plan for the few semantic runs that are still worth paying for.

## Pipeline

| Stage | Module | Fidelity | What it does |
|---|---|---|---|
| extract | `lib/extract/` | — | `from-module` (exact: the target exports `describeAgent()` with real handlers) or `from-francisco` (heuristic: manifest.json + regex over `src/**/*.ts`) → **PlatformModel** |
| analyze | `lib/analyzers/` | L0 | 17 total queries over routes/tools/params/env (SEC-01…09, EFF-01…08). "No finding" means no element has the property. |
| lattice | `lib/lattice/` | L0 | Derives 8 behaviour-changing dimensions, counts the valid product exactly, enumerates it (full product when small, greedy t-wise covering array when not), instantiates a deterministic prompt + mechanically derived **ideal** per cell |
| simulate | `lib/simulate/policy.mjs` | L0 | V1's Run Simulator as code: per-cell prior **p(fail)** with an explicit **confidence** (mechanism-decided vs model-judgment) |
| synth | `lib/synth/` | **L1** | Self-built harness: schema-derived cases (valid / boundary / out-of-schema / taint-shaped) run against the **real handlers** under a locked env + recording fakes; emits `harness/<tool>.test.mjs` |
| replay | `lib/replay.mjs` | **L2** | Scores recorded traces with the mechanical oracles; updates cell priors (Wilson CI) |
| sequence | `lib/sequence/` | L0 | **Multi-step closed world.** Models the LLM as a worst-case adversary, derives a session state machine from the model, explores it to a bounded depth, and checks temporal rules (SEQ-01…06): tainted context reaching an ungated action, approval reuse, leak chains, tainted handoffs, livelock cycles, unwinnable chains. Emits multi-turn scripts (sequence covering array) |
| rank | `lib/rank/setcover.mjs` | — | Severity × fidelity-weighted greedy set cover → the smallest change set that closes the most failure mass; efficacy is computed, not estimated |
| select | `lib/select/planner.mjs` | — | Neyman allocation across strata + information-gain ordering + the sequential rule for the open-world runs, with a token estimate |
| **boundary** | `lib/boundary/` | **L2** | **Measures the SHAPE of each defense.** Bisects along ordered pressure axes (authority, urgency, untrusted dose, insistence) to find where a defense gives way and how steeply — a code gate reads as a *step* (no flip), a prompt-only defense as a *slope*. Classifies each sensitive action structural / judgment / absent / mixed, measures compound-pressure tilt and a radius of validity, and promotes fragile defenses to code (BND-01…05, JOIN-01). Needs a runner |
| runner | `lib/runner/` | L2 | The one place the open world executes. `mock` (synthetic agent with planted boundaries, for validation), `anthropic` (a real model driving the real handlers under the harness fakes). The blast-radius guard refuses a non-mock run without `GRISTMILL_SANDBOX=1` |
| report | `lib/report.mjs` | — | `summary.md` that leads with the fixes and states exactly how strong the closed-world claim is |

The offline pipeline (`gm2 audit`) runs everything except the boundary engine, which needs a runner (`gm2 boundary --target … --out …`, mock by default, `--live` for a real model in a sandbox).

Artifacts per run: `model.json graph.json findings.jsonl cells.jsonl plan.json open_world_plan.json summary.md harness/`.

## How this answers "near-exhaustion of the semantic space without burning tokens"

1. **Equivalence classes, not prompts.** The lattice's coordinates are the things that change behaviour. For the example agent that is 20,736 valid cells; pairwise covering reaches every 2-way interaction in ~42 rows, 3-wise in a few hundred. Coverage is a fraction with a known denominator.
2. **Oracles need no judge.** Given a cell and the graph, the ideal path is computable, so gate-fired, call count, dead-source retries, batch-vs-iterate, secret-in-output, scope stated, error disclosure are all scored mechanically — on predicted, replayed or executed traces alike. An LLM judge is only for clarity-type axes.
3. **The simulator ranks risk for free.** Every cell gets a prior and a confidence. The planner spends runs where `severity × uncertainty` is highest and where the deterministic layers *disagree* (analyzer says reachable-ungated; simulator says the model would not route there).
4. **Sequential testing earns the statistics.** First pass: one run per selected cell. Pass on a confident prior → close it (neighbours' priors shrink under a stated smoothness assumption with a holdout). Fail → K repeats → a rate with a Wilson interval. That is the only place V1's word *significant* is earned.
5. **Replay is L2 for free.** Eval runs and audit logs you already have are scored the same way.

## The geometric insight (boundary engine)

A test result implicitly claims "inputs near this one behave the same." The boundary engine makes that claim measurable. Over ordered *pressure* axes, it fits where a defense flips and how sharply:

- A **code-enforced gate** is a *step*: it holds at every pressure level. Trust it.
- A **prompt-only defense** is a *slope*: enough urgency, claimed authority, or injected-content dose and it gives way. The engine recovers the exact level and flags it for promotion into code.
- A **radius of validity** near zero around a sensitive action means results don't generalize there — no test budget covers it, so a code gate is the only closure.
- **JOIN-01** crosses the two new engines: a path the sequence engine proves reachable from untrusted content, whose defense the boundary engine measures as a slope, is the top of every plan. Structural reachability × measured softness = exploitable.

This does not find novel jailbreak strings (phrasing is discontinuous and off the map). It tells you, for every defense you have, whether it is structural or wishful, and where testing is futile. The `mock` runner plants known step/slope boundaries so the test suite can confirm the engine recovers them before it is trusted on a real agent.

## Honesty rules carried over from V1

- Fidelity is tagged at capture; an L0 finding is phrased as *reachable and ungated*, never as *the model did X*. L0 can never be CONFIRMED.
- `evidence_confidence` is `directional` unless the top fixes rest on executed evidence; `significant` is never set by a dry audit.
- Heuristic extraction is labelled on every artifact, with notes on what could not be attributed. The upgrade path is one export: make the package expose `describeAgent()` and rerun with the module extractor to unlock L1.
- The harness tells you where the **contract lies** (`model-drift` findings: undeclared sinks, undeclared env reads). Every L0 conclusion assumes the contract is true, so those rank as first-class.

## Layout

```
bin/gm2.mjs            CLI (audit | extract | analyze | lattice | synth | replay | rank)
lib/model.mjs          PlatformModel normalization, routes, gate coverage, graph
lib/analyzers/         security.mjs, efficiency.mjs, index.mjs (rule catalog)
lib/lattice/           dimensions.mjs, covering.mjs, instantiate.mjs
lib/simulate/          policy.mjs
lib/oracles/           index.mjs
lib/synth/             runtime.mjs (probeTool), generate.mjs (emits node:test files)
lib/select/            planner.mjs
lib/rank/              setcover.mjs
lib/replay.mjs  lib/fixes.mjs  lib/pipeline.mjs  lib/report.mjs  lib/util.mjs
schemas/               platform-model, finding, cell, plan
fixtures/example-agent agent.mjs (seeded defects) + agent-fixed.mjs (fixes applied) + recorded_traces.jsonl
fixtures/francisco-mini  a tiny Francisco package for the heuristic extractor's tests
test/                  node:test suite (analyzers, covering arrays, harness, engines, pipeline determinism, extractor)
```

## Writing an exact target module

```js
export function describeAgent() {
  return {
    target: { name: 'MyAgent', version: '1.0.0' },
    entries: [{ id: 'chat', kind: 'chat', interactive: true }],
    actors:  [{ id: 'orchestrator', kind: 'orchestrator', prompt: '...', tools: ['get_thing'], can_delegate_to: [] }],
    tools:   [{ id: 'get_thing', name: 'get_thing', kind: 'read', purpose: 'one thing', tags: ['thing'],
                params: [{ name: 'id', type: 'string', taint: 'id', maxLength: 32 }],
                sinks:  [{ kind: 'db', params: ['id'], sanitized_by: 'id-schema' }, { kind: 'output' }],
                env: [], errors: 'sanitized', scoped: true,
                handler: async (args, ctx) => { ctx.db.query('SELECT ... WHERE id = ?', [args.id]); return ctx.output('{}'); } }],
    gates:   [{ id: 'id-schema', kind: 'schema', applies_to: ['get_thing'], params: ['id'] }],
    env:     [{ name: 'API_KEY', sensitive: true }],
    sources: [{ id: 'user', kind: 'user', trust: 'untrusted' }],
    budgets: { call_budget: 40, max_turns: 25, output_char_limit: 50000 },
    known_outages: [], multi_tenant: false, policies: ['confirm-before-write'],
  };
}
```
Handlers receive `ctx = { env, tenant, fetch, fs, shell, db, log, output }` and must use `ctx.env`, never `process.env` — that is what makes the env lock (and the undeclared-env finding) real. See `schemas/platform-model.schema.json` for every field.

## Limits, stated plainly

- **Only one command spends tokens.** `gm2 boundary --live` drives a real model (the Anthropic runner) with every tool call landing on recording fakes; it refuses to start without `GRISTMILL_SANDBOX=1`. Everything else is offline. The open-world plan is also a plain input for the methodology's LLM campaign controller or any runner you choose.
- **Bisection assumes failure rises with pressure.** A defense that fails at mid pressure but recovers at the extreme would be mislocated; repeats at the flip level are the partial mitigation.
- **Heuristic extraction is L0 only.** Pointing `--target` at a package directory reads it by regex. To execute its real handlers, bind them with the shim ([docs/EXPORTING_A_TARGET.md](docs/EXPORTING_A_TARGET.md)); network that bypasses global `fetch` is not intercepted by that shim.
- **The lattice is the map.** Exhaustive means exhaustive over the dimensions modelled. A channel the model omits is invisible; harness drift findings and surprising real traces are the signal to add a dimension.
- **No supply-chain audit.** Advisory data needs a network pull; vendoring a snapshot is the intended path.
