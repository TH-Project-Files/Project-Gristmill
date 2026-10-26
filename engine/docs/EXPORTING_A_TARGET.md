# Pointing the engine at your own agent

The engine reads one thing: a **platform model** — your agent's tools, gates, routes, env and
sources as data (`schemas/platform-model.schema.json`). There are three ways to give it one, in
increasing order of what they unlock.

| Path | Effort | Fidelity reached | Command |
|---|---|---|---|
| **A. Heuristic** — a package with readable `src/**/*.ts` | none | L0 (structure, sequences) | `gm2 audit --target ~/my-agent --out ws/my-agent` |
| **A′. Compiled** — a package that ships only `dist/index.js` | one flag | **L1** (tools listed and handlers executed at runtime) | same command + `--kind compiled` |
| **B. Bound** — a `describe.mjs` that fixes the model and/or stubs deps before binding | one small file | **L1**, corrected model | `gm2 audit --target describe.mjs --out ws/my-agent` |
| **C. Exact** — hand-written `describeAgent()` | an afternoon | L1, exact model, `high-confidence` eligible | same as B |

Any of these can then feed `gm2 boundary --live` for L2 measurement.

**Which one runs?** On a directory the engine only ever *reads* by default (A). Reading is safe;
running a package is not, so A′ is opt-in: pass `--kind compiled` (or `--allow-exec`) and the
engine imports the built entry (`manifest.main`, `dist/index.js`, package `main`), lists tools from
`createTools()` at runtime, binds the handlers, and learns from execution which sinks and env vars
each tool really touches. If you point at a src-less directory without the flag, the report says so
and tells you to add it.

While the package runs — at import, inside `createTools()`, and in every handler — it is sandboxed:
global `fetch` is refused (during load) or routed to the recording fakes (in handlers), and
`process.env` is swapped for a scrubbed copy, so code that reads the host environment directly sees
no API key or cloud credential. Refused network attempts are listed in the extraction notes. Network
that bypasses global `fetch` is refused at the socket: `net.Socket#connect`, `tls.connect` and the
DNS resolvers are patched while package code runs, so a database driver, Redis client, LDAP or SMB
library cannot reach a real backend even though it never touches `fetch`. Refused connections are
listed in the extraction notes. A handler that depends on such a backend stops at that call; to get
past it, stub the client (path B). The hidden environment is the second line: even an escaped call
would carry no real credential.

Use B when `createTools()` throws on load because it reaches for a database, a registry or a
client — stub those, then bind.

## A. Heuristic (zero effort)

```bash
node bin/gm2.mjs audit --target /path/to/francisco-agent --out workspace/my-agent
```

Regex over `manifest.json` and `src/**/*.ts`. Every inferred sink, gate and env read is labelled
heuristic in the report, and `evidence_confidence` is capped at `directional`. Read the
**Extraction notes** at the top of `summary.md` first: they say what could not be attributed (for
example, consent gates the manifest implies but no per-tool approval map names).

## B. Bound (recommended first real step)

Build the package (`npm run build`), then create `describe.mjs` next to it:

```js
import { fileURLToPath } from 'node:url';
import { extractFrancisco } from '<path-to-gristmill>/engine/lib/extract/from-francisco.mjs';
import { bindAll } from '<path-to-gristmill>/engine/lib/synth/shim.mjs';
import { createTools } from './dist/index.js';

export function describeAgent() {
  const model = extractFrancisco(fileURLToPath(new URL('.', import.meta.url)));
  // Correct anything the heuristic got wrong — this is where your knowledge goes:
  // model.tools.find(t => t.id === 's1_initiate_scan').kind = 'external-action';
  // model.gates.push({ id: 'hitl-scan', kind: 'hitl', applies_to: ['s1_initiate_scan'], enforced_by: 'code' });
  // model.multi_tenant = false;
  return bindAll(model, createTools);
}
```

`bindAll` calls `createTools(env)` with the harness's **locked env** (sensitive values are
canaries, undeclared reads are recorded) and swaps global `fetch` for the recording fake while
each handler runs. The harness then executes every handler over schema-derived cases and reports
secret leaks, undeclared sinks and env reads, taint reaching sinks, raw errors, uncapped output.

**What the shim does not intercept:** network that bypasses global `fetch` — `node:https`,
`ldapjs`, SMB clients, vendored HTTP libraries. Such calls go out for real. Two rules keep that
safe:

1. Run bound L1 on a machine where **no real credentials are reachable**. The env the package sees
   holds canaries only, so an escaped call cannot authenticate — but ambient credentials (a
   logged-in CLI, a credential file) are outside the lock.
2. Prefer packages whose clients take `fetch` or a base URL as a parameter. If a client hard-codes
   a non-fetch transport, mark its tools `errors: 'unknown'` and expect them to fail closed under
   the harness rather than be measured.

## C. Exact

Write the whole model by hand, with each tool's handler taking `(args, ctx)` and using `ctx.env`,
`ctx.fetch`, `ctx.db`, `ctx.fs`, `ctx.shell`, `ctx.log`, `ctx.output`. The example agent in
`fixtures/example-agent/agent.mjs` is a complete worked model. Set
`extraction: { method: 'module', confidence: 'exact' }` only when every field is true; that is what
allows `evidence_confidence: high-confidence`.

## Fields that matter most to get right

| Field | Why it matters | Common mistake |
|---|---|---|
| `tools[].kind` | `write` / `external-action` is what every consent rule keys on | a state-changing tool named `get_…` |
| `gates[].enforced_by` | only `code` counts as a gate; `prompt` is reported as wishful | declaring a prompt instruction as a gate |
| `gates[].via` | `null` = every caller; a list = only those actors | a gate on the orchestrator only, with a subagent holding the same tool |
| `gates[].scope` | `session` lets one approval cover later subjects | leaving an approval cached for the session |
| `entries[].interactive` | a HITL gate cannot fire on a scheduled or webhook entry | `bypassPermissions` agents are non-interactive everywhere |
| `sources[].feeds` | which tools return untrusted content — drives every injection rule | omitting web-fetch and email-reading tools |
| `env[].sensitive` | canaries are planted only for sensitive vars | marking an API key non-sensitive |
