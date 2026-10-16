import { createWebTools } from './tools/web.js';
import { createShellTools } from './tools/shell.js';
import { webResearcher } from './subagents/web-researcher.js';

export const subagents = { 'web-researcher': webResearcher };

export function createTools(env: Record<string, string>) {
  return [...createWebTools(env), ...createShellTools(env)];
}
