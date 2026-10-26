# Gristmill — operating notes for an agent working in this repo

Gristmill audits other AI agents. Two ways in, pick by what the person asked for:

**They want an answer about an agent (most requests).** Run the engine's no-decisions path and give them
the brief and the picture. It is dry: no model turns, no credentials, no backends, no package code
executed unless `--allow-exec` is added.

```
node engine/bin/gm2.mjs quick --target <agent directory or describe.mjs>
```

Then read `quick.md` in the output folder and relay: what it looked at, what to fix first, the
**evidence ceiling** (what fidelity this target can reach under each posture, and the exact command
that raises it), and the viewer path. Never present an L0 finding as observed behaviour.

**They want a full campaign.** Use the Master Audit Prompt in `README.md` ("Getting Started"), or the
`/gristmill` command. Before spending model turns on LLM rounds, run
`node engine/bin/gm2.mjs feasibility --target <agent>` and tell them the ceiling: on a target whose
handlers need a database, cache or directory, dry rounds produce only UNCERTAIN findings. Get real
evidence first (`--allow-exec`, a stubbing `describe.mjs`, or `--handoff` boundary measurement).

## Rules that always apply
- Every run is sandboxed when package code executes: `fetch` goes to fakes, raw sockets are refused,
  `process.env` is scrubbed. Do not set `GRISTMILL_SANDBOX` except inline on a boundary command
  the person asked for. Never supply an API key on their behalf.
- Commit as the repository's own identity; no co-author trailers.
- Tests: `npm test` (engine tests run from `engine/`, runner tests from the root). Keep output deterministic
  (no `Date.now`/`Math.random` in engine code paths).
- `engine/` is the deterministic engine; `runner/` is the methodology's LLM campaign runner;
  `safety/` is the one blast-radius guard both use. Target-specific adapters are never committed.
