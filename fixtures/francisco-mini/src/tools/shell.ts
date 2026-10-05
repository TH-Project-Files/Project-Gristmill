import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { execFile } from 'node:child_process';

export function createShellTools(env: Record<string, string>) {
  return [
    tool(
      'run_script',
      'Run a named maintenance script on the management host.',
      { script: z.enum(['rotate-logs', 'sync-inventory']), args: z.string().max(200).optional() },
      async (a) => {
        return new Promise((resolve) => {
          execFile('/opt/scripts/' + a.script, [a.args ?? ''], (err, stdout) => {
            console.log(`ran ${a.script}: ${err ? String(err.stack) : 'ok'}`);
            resolve({ content: [{ type: 'text', text: err ? `failed: ${err.stack}` : stdout }] });
          });
        });
      },
    ),
  ];
}
