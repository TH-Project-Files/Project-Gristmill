/**
 * Dependency-free JSON Schema validator (subset) for Gristmill artifacts.
 * Supports: type, required, properties, items, enum, $ref (local file + in-doc #/$defs),
 * minimum/maximum, minItems, additionalProperties:false. Enough to conformance-check the
 * schemas/ contracts and any campaign's produced artifacts without pulling in ajv.
 *
 * Usage:
 *   node runner/validate.mjs                       # validate schemas parse + example-campaign
 *   node runner/validate.mjs <schema> <data.json>  # validate one file
 *   node runner/validate.mjs <schema> <data.jsonl> # validate each line
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KIT = resolve(__dirname, '..');
const SCHEMAS = join(KIT, 'schemas');
const cache = new Map();

function loadSchema(idOrPath) {
  if (cache.has(idOrPath)) return cache.get(idOrPath);
  let p = idOrPath;
  if (idOrPath.startsWith('https://gristmill.kit/schemas/')) p = join(SCHEMAS, idOrPath.split('/').pop());
  const s = JSON.parse(readFileSync(p, 'utf8'));
  cache.set(idOrPath, s);
  return s;
}

function validate(schema, data, path, root, errors) {
  if (schema.$ref) {
    if (schema.$ref.startsWith('#/$defs/')) return validate(root.$defs[schema.$ref.split('/').pop()], data, path, root, errors);
    const sub = loadSchema(schema.$ref);
    return validate(sub, data, path, sub, errors);
  }
  const t = schema.type;
  if (t === 'object' || (schema.properties && typeof data === 'object')) {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) { errors.push(`${path}: expected object`); return; }
    for (const req of schema.required || []) if (!(req in data)) errors.push(`${path}: missing required '${req}'`);
    if (schema.additionalProperties === false && schema.properties) {
      for (const k of Object.keys(data)) if (!(k in schema.properties)) errors.push(`${path}.${k}: unexpected property`);
    }
    for (const [k, v] of Object.entries(data)) {
      if (schema.properties && schema.properties[k]) validate(schema.properties[k], v, `${path}.${k}`, root, errors);
    }
  } else if (t === 'array') {
    if (!Array.isArray(data)) { errors.push(`${path}: expected array`); return; }
    if (schema.minItems && data.length < schema.minItems) errors.push(`${path}: minItems ${schema.minItems}`);
    if (schema.items) data.forEach((el, i) => validate(schema.items, el, `${path}[${i}]`, root, errors));
  } else {
    if (Array.isArray(schema.type)) { /* union, skip strict */ }
    else if (schema.type === 'string' && typeof data !== 'string') errors.push(`${path}: expected string`);
    else if ((schema.type === 'number' || schema.type === 'integer') && typeof data !== 'number') errors.push(`${path}: expected number`);
    else if (schema.type === 'boolean' && typeof data !== 'boolean') errors.push(`${path}: expected boolean`);
  }
  if (schema.enum && !schema.enum.includes(data)) errors.push(`${path}: '${data}' not in enum`);
  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) errors.push(`${path}: < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && data > schema.maximum) errors.push(`${path}: > maximum ${schema.maximum}`);
  }
}

function check(schemaFile, dataFile) {
  const schema = loadSchema(schemaFile);
  const raw = readFileSync(dataFile, 'utf8').trim();
  let rows;
  if (dataFile.endsWith('.jsonl')) rows = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
  else {
    const parsed = JSON.parse(raw);
    // A top-level JSON array validated against a per-item schema (e.g. issue_clusters.json vs
    // cluster.schema.json) is checked element-by-element.
    rows = Array.isArray(parsed) && schema.type !== 'array' ? parsed : [parsed];
  }
  let bad = 0;
  rows.forEach((row, i) => {
    const errors = [];
    validate(schema, row, `${dataFile.split(/[\\/]/).pop()}[${i}]`, schema, errors);
    if (errors.length) { bad++; errors.forEach(e => console.error('  FAIL ' + e)); }
  });
  console.log(`${bad ? 'FAIL' : 'ok  '} ${dataFile.split(/[\\/]/).pop()} (${rows.length} record${rows.length === 1 ? '' : 's'}) against ${schemaFile.split(/[\\/]/).pop()}`);
  return bad === 0;
}

/** Errors (empty = valid) for one value against a schema file name or path in schemas/. */
export function validateValue(schemaFile, data) {
  const p = /[\\/]/.test(schemaFile) ? schemaFile : join(SCHEMAS, schemaFile);
  const schema = loadSchema(p);
  const errors = [];
  validate(schema, data, '$', schema, errors);
  return errors;
}

export { check };

function cli() {
  if (process.argv[2] && process.argv[3]) {
    process.exit(check(process.argv[2], process.argv[3]) ? 0 : 1);
  }
  // Default: schemas parse + validate the example-campaign artifacts.
  let ok = true;
  const camp = join(KIT, 'workspace', 'example-campaign');
  const runs = existsSync(join(camp, 'runs')) ? readdirSync(join(camp, 'runs')) : [];
  const runDir = runs.length ? join(camp, 'runs', runs[0]) : null;
  const pairs = [
    ['target-profile.schema.json', join(camp, 'memory', 'target_profile.json')],
    ['fingerprint.schema.json', join(camp, 'memory', 'scenario_fingerprints.jsonl')],
    ['finding.schema.json', join(camp, 'memory', 'long_term_findings.jsonl')],
    ['cluster.schema.json', join(camp, 'memory', 'issue_clusters.json')],
    runDir && ['scenario.schema.json', join(runDir, 'scenarios.jsonl')],
    runDir && ['trace.schema.json', join(runDir, 'traces.jsonl')],
    runDir && ['score.schema.json', join(runDir, 'scores.jsonl')],
    runDir && ['plan.schema.json', join(runDir, 'plan.json')],
    runDir && ['regression.schema.json', join(runDir, 'regression.json')],
    runDir && ['run-config.schema.json', join(runDir, 'config.json')],
  ].filter(Boolean);
  for (const [s, d] of pairs) {
    if (!existsSync(d)) { console.log(`skip ${d.split(/[\\/]/).pop()} (not present)`); continue; }
    ok = check(join(SCHEMAS, s), d) && ok;
  }
  process.exit(ok ? 0 : 1);
}

// The CLI runs only under plain node, never on import.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
