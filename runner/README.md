# Reference runner

`gristmill.workflow.js` automates one campaign end-to-end. It has one control flow
(`runCampaign`, in the import-free `core.js`) and two interchangeable **engines**:

- **offlineEngine** — deterministic, dependency-free role stand-ins driven by a built-in
  `SimulationAdapter`. No LLM, no network. This is what runs when you invoke the file directly,
  and it exists so the *methodology* (loop, schemas, non-repetition, scoring math, artifact chain)
  is verifiable without any live target or model.
- **workflowEngine** — the same role methods, each backed by a real subagent via the Claude Code
  Workflow tool's `agent()` global, using the prompts in `../roles/*.md` and the schemas in
  `../schemas/*.json`. This is how you run a *real* campaign against a *real* target.

## Run the offline dry run (verify the kit works)

```bash
# from the kit root
node runner/gristmill.workflow.js
# or with your own config:
node runner/gristmill.workflow.js path/to/run-config.json
```

It writes a full campaign under `workspace/<campaign_id>/`:
```
memory/target_profile.json
memory/scenario_fingerprints.jsonl     # every accepted scenario's fingerprint (dedup history)
memory/long_term_findings.jsonl        # append-only findings
memory/score_timeseries.jsonl          # append-only score trend
memory/issue_clusters.json             # ranked clusters (rewritten each round)
memory/regression_watchlist.json       # cumulative fragile domains
runs/<date>-run-001/
  config.json  scenarios.jsonl  traces.jsonl  scores.jsonl
  raw_traces/<scenario_id>.<fidelity>.json   # a promoted scenario keeps both its L0 and L2 trace
  coverage_matrix.json                       # per-cell n / n_confirmed / mean (statistics §1)
  plan.json  regression.json  summary.md
```
Run it twice with the same `campaign_id`: the second run's round log shows scenarios rejected by
the fingerprint gate — proof the non-repetition engine works across runs.

## What the control flow enforces (either engine)

These live in `runCampaign`, not in any role prompt, so they hold no matter what the model does:

- **Similarity gate** — `fingerprintSimilarity` implements `rubrics/statistics.md` §2 verbatim
  (including the trigram-cosine text term); candidates are rejected mechanically, never by the
  Smith's self-assessment.
- **Blind panel split** — per `scoring.blind_fraction`, blind judges receive inputs with the
  Smith's hypothesis (`expected_ideal_path`, `likely_failure_risks`) and the Simulator's
  derivations (`ideal_path`, `divergence`) stripped; each round reports the blind-vs-sighted
  delta as the hypothesis-anchoring diagnostic.
- **CONFIRMED requires L1+** — verify over an L0 finding is clamped to UNCERTAIN
  (`rubrics/fidelity-ladder.md` rule 7).
- **Post-score promotion** — L2 promotion runs *after* judging so `highest-risk-first` ranks on
  observed severity/consensus; each promoted scenario's L0 predictions are reconciled against
  the executed trace (re-observed → upgraded, contradicted → REFUTED, ladder rules 5–6).
- **Two-condition stopping** — the dry streak only advances when no new cluster appeared *and*
  the top clusters' cells meet `min_samples_per_cell`; a zero-accept round stops as
  "generator dry."
- **Evidence loop-back** — Skeptic `needs-more-evidence` verdicts trigger one targeted L2 pass
  on the gated clusters' representatives, then re-cluster and re-gate the plan.
- **Honest-significance cap** — `plan.evidence_confidence` is capped at `directional` when the
  stopping rule didn't fire or judge agreement < 0.8 (`rubrics/statistics.md` §6).

## Run a real campaign (Workflow tool)

Workflow scripts have no imports and no filesystem, so a real campaign is three steps:
**bundle** (node), **run** (the Workflow tool), **replay** (node).

```bash
# 1. Bundle: inline runner/core.js + roles, modes, rubrics, schemas, the run-config, the
#    adapter's data and the campaign's current memory into one self-contained script.
node runner/bundle.mjs --campaign workspace/<campaign_id> --adapter target-adapters/<x>.adapter.mjs
#    -> workspace/<campaign_id>/workflow/campaign.workflow.js  (+ inputs.json for replay)

# 2. Run it from Claude Code (the time comes from the real clock, never invented):
#    Workflow({ scriptPath: "workspace/<campaign_id>/workflow/campaign.workflow.js",
#               args: { now: "2026-10-26T17:25:35Z" } })

# 3. Replay: re-run the same control flow under node, answering every agent() call from the
#    finished run's journal, and write + validate the artifact chain on disk.
node runner/replay.mjs --campaign workspace/<campaign_id>   --transcripts ~/.claude/projects/<project>/<session>/subagents/workflows/<wf_run_id> --now <same ISO>
```

Every `agent()` call carries a deterministic tag (`[gm-call:<label>]`) on its first line;
replay maps tag -> result from the journal and the agent transcripts. Same inputs + same answers
= the same artifacts the workflow computed in memory. Replay refuses when `core.js` or the
campaign memory changed since bundling, or when the run directory already exists (it would
double-append). It also writes `runs/<run>/agent_calls.jsonl`: every call and its answer, which
is where the judges' axis justifications and the verifiers' reasons live.

Each role is one subagent per call, with its `roles/NN-*.md` prompt and a schema derived from
`schemas/*.schema.json` (harness-owned fields removed):

| Control-flow step | Role prompt | Calls | Harness computes (never the subagent) |
|---|---|---|---|
| characterize | `roles/01-cartographer.md` | 1, or 0 when the adapter carries a validated profile | `captured_at` |
| generate | `roles/02-scenario-smith.md` | 1 per mode per round (the mode's whole allocation) | ids, `normalized_text`, `coverage_cell`, `created_round`, the similarity gate |
| run | `roles/03-run-simulator.md` | 1 per scenario | `fidelity` (L0 unless the adapter executed a mechanism), `cost.estimated`, enum filtering |
| score | `roles/04-trace-judge.md` | `judge_panel_size` per scenario, concurrent; blind ones get redacted inputs | `overall`, `pass`, `sub_scores`, finding ids/fidelity/`verify_status`, panel merge |
| verify | `roles/04` (Verify mode) | 1 per scenario with findings, a separate context told to refute | the L0 cap (CONFIRMED -> UNCERTAIN) |
| cluster | `roles/05-root-cause-analyst.md` | 1 per round | every aggregate, `rank_score`, stability; unplaced findings still clustered |
| plan | `roles/06-remediation-planner.md` | 1 | priority, unknown regression ids dropped, unaddressed clusters deferred with a reason |
| skeptic | `roles/07-skeptic.md` | 1 | `accepted` without a CONFIRMED L1+ member -> `needs-more-evidence`; confidence ceiling |
| regression | `roles/08-regression-warden.md` | 1, or 0 when nothing was accepted/narrowed | baselines from consensus scores |

A skipped or dead subagent is a hole, never a crash: a scenario without a trace or any judge is
reported as unscored; a missing verifier leaves findings UNCERTAIN; a missing Root-Cause Analyst
falls back to issue_class grouping; a missing Skeptic verdict is `needs-more-evidence`.

The workflow engine never executes the target: `simulator(..., 'L2'|'L3')` throws, and the
bundler refuses adapters that export `execute()`. Real runs go only through
`safety/safe-execute.mjs`.

Tests: `node --test runner/test/` (offline determinism, the honesty guarantees under a
deliberately dishonest fake agent, blinding, and the bundle -> run -> replay round trip).

## Swapping in your target's adapter

`runCampaign({ config, engine, adapter })` takes the adapter as a parameter. Replace
`makeSimulationAdapter()` with your own object implementing `describe()` and (for real fidelity)
`simulate()` / `execute()` per `../adapters/ADAPTER_CONTRACT.md`. See
`../adapters/example-cli-adapter.md` for a real `execute()` and
`../adapters/example-simulation-adapter.md` for a mechanism harness.

## Determinism

No `Date.now()` / `Math.random()` — a seeded PRNG drives all variation and a fixed `now` stamps
artifacts. Same config + same adapter ⇒ byte-identical artifacts, so a real (LLM) run can be
diffed against the deterministic baseline and regressions in the *harness* are distinguishable
from changes in the *target*.
