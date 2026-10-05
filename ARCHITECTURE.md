# Architecture — the closed/open-world funnel

```
                 ┌──────────────── CLOSED WORLD (deterministic, free, exhaustive) ────────────────┐
 target ──extract──▶ PlatformModel ──▶ routes · gates · taint edges · env · sinks  (graph)        │
                         │                                                                        │
                         ├─ analyzers (L0)  total queries over every element → structural findings │
                         ├─ lattice   (L0)  dims → valid product (exact N) → covering array → cells │
                         ├─ simulate  (L0)  cell → prior p(fail), confidence, predicted trace       │
                         ├─ synth     (L1)  real handlers × schema-derived cases × locked env       │
                         └─ replay    (L2)  recorded traces × oracles → observations, posteriors    │
                                                   │                                              │
                                   rank: severity×fidelity set cover → plan.json (computed efficacy)
                                                   │
                 └──────────────── OPEN WORLD (sampled, paid, statistical) ───────────────────────┘
                                   select: Neyman allocation × information gain × sequential rule
                                                   │
                                   open_world_plan.json ──▶ V1 controller / any runner ──▶ traces
                                                   │                                        │
                                                   └──────────── replay ◀───────────────────┘
```

## Why each piece is where it is

**Model, not prompt, as the source of truth.** V1's Cartographer produced a prose profile that an LLM read. V2's `PlatformModel` is data with a schema, and *every* downstream stage is a function of it. That is what makes "exhaustive" a literal claim: the analyzers are total functions over finite sets.

**Routes are the unit of security.** A tool is not gated or ungated; a *route* (entry → actor chain → tool) is. `enumerateRoutes` is finite because the delegation graph is small and cycles are cut. Side-route bypass (SEC-02), consent-that-cannot-fire on non-interactive entries (SEC-08) and the injection surface (SEC-09) are all route facts.

**Lattice dimensions are derived, not hand-written.** `deriveDimensions` reads the model: `target_tool` from reachable tools, `source_state` includes `outage` only if the model lists one, `injection` includes `instruction-in-content` only if an untrusted non-user source exists, `entry` from the model's entries. Constraints (`isValidCoords`) prune meaningless combinations and the exact valid count is reported as the denominator.

**Covering arrays make the product tractable.** Full product under 2,000 cells; otherwise a deterministic greedy t-wise array. `verifyCoverage` proves (in the tests) that every *realizable* t-way interaction is present. Strength 2 is the default; 3 is a flag.

**The simulator's confidence is the planner's fuel.** Each predicted failure mode carries `(p, confidence)`. Mechanism facts ("no route has a gate") are p=1, confidence=1; judgment calls ("would it delegate?") are low confidence. `P(fail) = 1 − Π(1 − p_i)`; confidence is the p-mass-weighted mean. The planner's uncertainty term `p(1−p) + 0.25(1−conf)` therefore peaks exactly where a semantic run would teach the most.

**Oracles are shared across fidelities.** The same `scoreTrace` scores a predicted trace, a replayed trace and (when you wire a runner) an executed trace. That is what lets replay feed priors and lets the open-world runs be judged mostly without a model.

**The harness is the lie detector.** Static analysis is only as true as the contract. `probeTool` executes the real handler and compares declared sinks/env against observed ones; `model-drift` findings exist so that a wrong contract is fixed before anyone trusts the structural table. Canary values for sensitive env vars make "secret in output/log" an exact string match, not a heuristic. Each case runs twice; a repeatable mechanism result is `CONFIRMED` (V1 ladder rule 7 satisfied at L1).

**Set cover makes "top improvements" defensible.** Fix ids are stable strings keyed by locus and subject so that findings from different layers (L0 analyzer, L1 harness, L2 replay) that the *same change* would close share one id. Greedy severity-weighted set cover then yields a ranked list whose efficacy numbers are sums over enumerated findings and cells, not estimates.

**Selection is stratified by tool.** Neyman allocation `n_h ∝ N_h σ_h` sends runs where variance lives; within a stratum, highest information-gain cells go first. The sequential rule (pass → close; fail → K repeats → Wilson CI; stop at CI width) is emitted *in* the plan so the controller that spends tokens follows the same statistics the plan assumed.

## Honesty invariants (enforced in code, not prose)

| Invariant | Where |
|---|---|
| L0 can never be CONFIRMED | analyzers emit `UNCERTAIN`; only harness/replay set `CONFIRMED` |
| Fidelity discounts rank | `setcover.mjs` weights L0 0.6 / L1 0.8 / L2–L3 1.0; REFUTED weighs 0 |
| Coverage has a denominator | `latticeSize().valid` is computed exactly and reported |
| Determinism | no `Date.now`/`Math.random`; seeded PRNG; stable JSON; proven by `test/pipeline.test.mjs` |
| Heuristic extraction is labelled | `extraction.confidence` on the model, notes in the report, `evidence_confidence` capped at `directional` |
| "significant" is never claimed by a dry audit | `evidenceConfidence()` only returns `directional` or `high-confidence` |

## Extending

- **New structural rule:** add a function to `lib/analyzers/{security,efficiency}.mjs` that returns findings with a `fix_candidates` id from `lib/fixes.mjs`; add its label to `RULE_CATALOG`; add an assertion in `test/analyzers.test.mjs` against a seeded defect in the fixture.
- **New lattice dimension:** extend `deriveDimensions`, teach `instantiate` how it changes the prompt and `deriveIdeal` how it changes the ideal, and (if it matters) `simulateCell` how it changes a failure mode's probability.
- **New sink kind or taint:** `TAINT_SINK` in the security analyzer, `TAINT_PAYLOADS` + the `reached` check in the harness runtime, and the ctx fake in `makeCtx`.
- **New extractor:** return a raw PlatformModel; `normalizeModel` validates it. Mark `extraction.confidence` honestly.
- **Wiring a runner:** consume `open_world_plan.json` (`runs[]` carry the prompt and injected context), produce traces in the replay record shape, and feed them back with `--traces`.
