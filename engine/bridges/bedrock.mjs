#!/usr/bin/env node
/**
 * Bedrock bridge for `--complete-cmd`. Reads one neutral completion request on stdin, calls
 * Anthropic-on-Bedrock through the AWS CLI (which does the SigV4 signing with whatever credentials
 * your harness already has: profile, SSO, env, instance role), and writes {text, tool_uses, usage}
 * on stdout. No dependencies; the engine stays provider-blind.
 *
 *   --complete-cmd 'node bridges/bedrock.mjs'
 *
 * Env:
 *   BEDROCK_MODEL_ID   required — the Bedrock model or inference-profile id for the Claude model you
 *                      want, e.g. the id `aws bedrock list-inference-profiles` shows for it
 *   AWS_REGION / AWS_PROFILE   as usual for the AWS CLI
 *   BEDROCK_MAX_TOKENS optional, default 1024
 *   GM_AWS_CMD         optional, path to the aws executable (tests point it at a stub)
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const read = () => new Promise(r => { let s = ''; process.stdin.on('data', d => (s += d)).on('end', () => r(s)); });

const req = JSON.parse((await read()).trim());
const modelId = process.env.BEDROCK_MODEL_ID;
if (!modelId) { process.stderr.write('bedrock bridge: set BEDROCK_MODEL_ID\n'); process.exit(2); }

// The neutral request is already the Anthropic Messages shape; Bedrock wants it with a version tag.
const body = { anthropic_version: 'bedrock-2023-05-31', max_tokens: +(process.env.BEDROCK_MAX_TOKENS || 1024), system: req.system || undefined, messages: req.messages, ...(req.tools?.length ? { tools: req.tools } : {}) };

const dir = mkdtempSync(join(tmpdir(), 'gm-bedrock-'));
try {
  const inFile = join(dir, 'in.json'), outFile = join(dir, 'out.json');
  writeFileSync(inFile, JSON.stringify(body));
  const aws = process.env.GM_AWS_CMD || 'aws';
  const args = ['bedrock-runtime', 'invoke-model', '--model-id', modelId, '--content-type', 'application/json', '--accept', 'application/json', '--body', `fileb://${inFile}`, outFile];
  const r = spawnSync(aws, args, { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) { process.stderr.write(`bedrock bridge: aws exited ${r.status}: ${(r.stderr || r.error?.message || '').slice(0, 400)}\n`); process.exit(1); }
  const j = JSON.parse(readFileSync(outFile, 'utf8'));
  const blocks = j.content || [];
  process.stdout.write(JSON.stringify({
    text: blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'),
    tool_uses: blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input || {} })),
    usage: { input_tokens: j.usage?.input_tokens || 0, output_tokens: j.usage?.output_tokens || 0 },
  }));
} finally { rmSync(dir, { recursive: true, force: true }); }
