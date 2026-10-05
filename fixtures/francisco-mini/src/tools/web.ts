import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const ALLOWED_HOSTS = ['support.apple.com', 'nvd.nist.gov'];
function hostAllowed(u: string) { try { return ALLOWED_HOSTS.includes(new URL(u).hostname); } catch { return false; } }

export function createWebTools(env: Record<string, string>) {
  return [
    tool(
      'fetch_page',
      'Fetch ONE page from an allowlisted vendor host. Forbidden hosts are refused.',
      {
        url: z.string().min(12).max(2048).describe('https URL'),
        max_chars: z.number().int().min(100).max(20000).optional(),
      },
      async (args) => {
        if (!hostAllowed(args.url)) return { content: [{ type: 'text', text: 'refused' }] };
        const r = await fetch(args.url, { headers: { authorization: `Bearer ${env.API_TOKEN}` } });
        return { content: [{ type: 'text', text: (await r.text()).slice(0, args.max_chars ?? 1000) }] };
      },
    ),
    tool(
      'parse_version',
      'Extract a version string from text using a regex.',
      { text: z.string().max(5000) },
      async (args) => {
        const re = /(\d+)\.(\d+)/;
        const m = re.exec(args.text);
        return { content: [{ type: 'text', text: m ? m[0] : 'none' }] };
      },
    ),
  ];
}
