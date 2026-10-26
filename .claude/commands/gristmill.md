---
description: Run a Gristmill audit campaign on an agent (the Master Audit Prompt), or a quick dry audit
argument-hint: [quick] <agent directory or describe.mjs>
---

You are about to audit an AI agent with Gristmill from this repository.

If `$ARGUMENTS` starts with `quick` (or is empty), run the no-decisions path and relay the result:
`node engine/bin/gm2.mjs quick --target <the path given, else the current directory>`, then read
`quick.md` in the output folder and tell the person: what it looked at, what to fix first, the
evidence ceiling, and where `viewer.html` is. Stop there.

Otherwise, run the full campaign: open `README.md`, find the fenced block under
"Getting Started — the Gristmill Master Audit Prompt", and act as that CAMPAIGN CONTROLLER exactly,
treating `$ARGUMENTS` as the answer to question 1 (the target). Before Phase 4 spends any model
turns, run `node engine/bin/gm2.mjs feasibility --target <target>` and state the evidence ceiling
for the chosen posture; if it is L0, say plainly that LLM rounds can only yield UNCERTAIN findings
and recommend getting evidence first. Begin Phase 1 now.
