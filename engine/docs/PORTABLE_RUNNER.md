# The boundary runner uses your harness's model access

Everything in the engine is offline except one command: `gm2 boundary --live`, which drives the
target's handlers with a real model to measure how each defense bends under pressure. It does **not**
carry its own API key. It uses whatever model access the harness you're already in provides, and
auto-detects it from the environment. The guard still refuses to start without `GRISTMILL_SANDBOX=1`,
and every tool call lands on a recording fake, so the blast radius is tokens, not state.

## What gets detected, in order

| If the environment has… | The runner uses | Nothing to pass |
|---|---|---|
| `ANTHROPIC_API_KEY` | the Anthropic Messages API | — |
| `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | an Anthropic-compatible gateway | — |
| `OPENAI_API_KEY` (+ `OPENAI_BASE_URL`, `OPENAI_MODEL`) | an OpenAI-compatible endpoint | — |
| a `--complete-cmd` you pass | your subprocess (below) | the universal hook |

```bash
GRISTMILL_SANDBOX=1 node bin/gm2.mjs boundary --target <t> --out <o> --live
# override: --transport anthropic|openai   --model <id>   --complete-cmd '<cmd>'
```

## The universal hook: `--complete-cmd`

A coding-agent subscription (Claude Code, Codex), AWS Bedrock, and Google Vertex do not expose a
plain key a separate process can use, and Bedrock/Vertex need request signing the dependency-free
engine deliberately does not implement. For all of those, wire a one-line command that turns a
single model turn into a completion. The engine writes a JSON **request** to the command's stdin and
reads a JSON **response** from its stdout.

**Request** (one line on stdin):
```json
{ "system": "<the actor's system prompt>",
  "tools":  [ { "name": "...", "description": "...", "input_schema": { ... } } ],
  "messages": [ { "role": "user", "content": [ { "type": "text", "text": "..." } ] } ] }
```
Message content blocks are `{type:'text',text}`, `{type:'tool_use',id,name,input}`, and
`{type:'tool_result',tool_use_id,content}` — the Anthropic shape.

**Response** (JSON on stdout):
```json
{ "text": "<assistant text, may be empty>",
  "tool_uses": [ { "name": "reset_device", "input": { "device_id": "DEV-0042" } } ],
  "usage": { "input_tokens": 0, "output_tokens": 0 } }
```
Return `tool_uses: []` (or omit it) when the model is done. Ids are optional; the engine fills them.

### Examples

**Bedrock**, using the shipped bridge and the AWS CLI's signing:
```bash
BEDROCK_MODEL_ID=<your Claude model or inference-profile id> \
  GRISTMILL_SANDBOX=1 node bin/gm2.mjs boundary --target <t> --out <o> --live --complete-cmd 'node bridges/bedrock.mjs'
```
The shipped bridge (`bridges/bedrock.mjs`) passes the request through as an Anthropic-on-Bedrock body and lets the AWS CLI sign it with whatever credentials your shell already has (profile, SSO, env, instance role). It needs the AWS CLI on PATH and no other dependency.

**A gateway already in the environment** needs no command — set `ANTHROPIC_BASE_URL` and
`ANTHROPIC_AUTH_TOKEN` and the built-in anthropic transport uses it.

**A coding-agent subscription alone (Claude Code, Codex) is not yet supported.** Those CLIs run
their own agent loop with their own tools; they do not hand back a raw single-turn completion with
tool calls for *the target's* tools, which is what gate enforcement needs. No bridge ships for
them. If your harness runs on Bedrock, Vertex, a gateway, or an API key underneath, use that layer
directly (rows above). Otherwise use the mock runner, which needs no model.

## Why not just call the model myself from the engine?

The engine runs the target's *own* agent loop so it can enforce the consent gates in code between
turns — a gated tool returns "CONFIRMATION REQUIRED" and is never executed, whatever the model
does. That requires a raw single-turn completion with tool-use for the target's tools, which a
coding-agent CLI (it runs its own loop with its own tools) cannot provide. So the transport layer
asks only for one completion at a time, and `--complete-cmd` is where your harness's credentials
meet the engine without either side hard-coding the other.
