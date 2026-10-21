/**
 * `gm2 render` — one self-contained HTML viewer for an audit (+ optional boundary) folder.
 * All data is computed in node (render/data.mjs) and inlined; the page only draws. Three.js comes
 * from cdnjs; nothing else is fetched, so the file opens from disk in any browser.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRenderData } from './data.mjs';
import { stableStringify } from '../util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function renderViewer({ auditDir, boundaryDir = null, out = null, now = null }) {
  const data = buildRenderData({ auditDir: resolve(auditDir), boundaryDir: boundaryDir ? resolve(boundaryDir) : null });
  data.generated_at = now;
  const template = readFileSync(join(HERE, 'viewer.html'), 'utf8');
  const json = stableStringify(data, 0).replace(/<\/script/gi, '<\\/script');
  const html = template.replace('__GM_DATA__', json);
  const outFile = resolve(out || join(auditDir, 'viewer.html'));
  writeFileSync(outFile, html);
  return { outFile, data };
}
