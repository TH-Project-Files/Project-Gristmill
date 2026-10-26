# Gristmill — notes for any coding agent (Codex, Antigravity, Cursor, others)

This repo audits AI agents. Requires Node 20+, nothing to install.

- **To audit an agent:** `node engine/bin/gm2.mjs quick --target <agent dir or describe.mjs>`
  then report `quick.md` from the output folder (what it looked at, fix first, evidence ceiling,
  viewer path). Dry by default: no model turns, no credentials, no backends.
- **Before any LLM campaign rounds:** `node engine/bin/gm2.mjs feasibility --target <agent>` and
  state the ceiling. If it is L0 for the chosen posture, say that rounds can only produce
  UNCERTAIN findings and get evidence first (`--allow-exec`, a stubbing `describe.mjs`, or
  `--handoff` boundary measurement; see `engine/docs/`).
- **Full campaign:** follow the Master Audit Prompt in `README.md` exactly.
- Sandbox rules: package code only ever runs with `fetch` faked, sockets refused and `process.env`
  scrubbed. Set `GRISTMILL_SANDBOX=1` only inline on a boundary command the person asked for.
  Never supply credentials on their behalf.
- Commits: repository identity only, no co-author trailers. Tests:
  `npm test` (engine tests run from `engine/`, runner tests from the root).
