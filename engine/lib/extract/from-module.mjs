/**
 * Extractor A — module. The target exports `describeAgent()` (or a default export / `model`)
 * returning a PlatformModel whose tools may carry real `handler(args, ctx)` functions. This is the
 * EXACT extraction path: nothing is guessed, and the harness can execute the handlers (L1).
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function loadTargetModule(path) {
  const mod = await import(pathToFileURL(resolve(path)).href);
  const d = mod.describeAgent || mod.default || mod.model;
  const raw = typeof d === 'function' ? await d() : d;
  if (!raw || !raw.tools) throw new Error(`${path} did not export a PlatformModel (describeAgent()/default/model)`);
  raw.extraction = { method: 'module', confidence: 'exact', notes: [], ...(raw.extraction || {}) };
  return raw;
}
