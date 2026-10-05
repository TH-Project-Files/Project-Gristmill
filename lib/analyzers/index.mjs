import { securityAnalyzers } from './security.mjs';
import { efficiencyAnalyzers } from './efficiency.mjs';
import { hashHex } from '../util.mjs';

/** Run every analyzer over the model. Returns findings with deterministic ids, sorted. */
export function runAnalyzers(model, opts = {}) {
  const rules = [...securityAnalyzers(), ...efficiencyAnalyzers(opts.efficiency)];
  const findings = [];
  for (const rule of rules) for (const f of rule(model)) findings.push(f);
  for (const f of findings) {
    f.subject = f.subject || {};
    f.evidence = f.evidence || {};
    f.cells = [];
    f.finding_id = `${f.rule}-${hashHex([f.rule, f.subject.tool || '', f.subject.route || '', f.subject.param || '', f.subject.env || '', f.summary].join('|'))}`;
  }
  findings.sort((a, b) => b.severity - a.severity || a.rule.localeCompare(b.rule) || a.finding_id.localeCompare(b.finding_id));
  return findings;
}

export const RULE_CATALOG = {
  'SEC-01': 'Sensitive tool with no consent gate on any route',
  'SEC-02': 'Consent gate bypassable via a side route',
  'SEC-03': 'Tainted parameter reaches a dangerous sink unsanitized',
  'SEC-04': 'Sensitive env value can reach output/log with no redaction',
  'SEC-05': 'Deny-list where an allow-list is required',
  'SEC-06': 'Raw error disclosure',
  'SEC-07': 'Tool not scope-bound in a multi-tenant target',
  'SEC-08': 'Consent gate cannot fire on a non-interactive entry',
  'SEC-09': 'Untrusted-content ingestion + ungated sensitive tool on one actor',
  'EFF-01': 'No session call budget',
  'EFF-02': 'Retries against a known outage / no backoff',
  'EFF-03': 'Duplicate (overlapping) tools on one actor',
  'EFF-04': 'Per-item route where a batch form exists',
  'EFF-05': 'Prompt mass / tool carried by many actors',
  'EFF-06': 'Uncapped read',
  'EFF-07': 'Unreachable tool',
  'EFF-08': 'Read tool on dual routes (double dispatch)',
  'HAR-SINK': 'Handler reached a sink the contract does not declare',
  'HAR-ENV': 'Handler read an env var the contract does not declare',
  'HAR-SECRET': 'Sensitive env value observed in output/log',
  'HAR-RAWERR': 'Handler leaked stack/path in an error',
  'HAR-TAINT': 'Taint-shaped payload reached its sink unneutralized',
  'HAR-SCHEMA': 'Out-of-schema input accepted and acted on',
  'HAR-LIMIT': 'Result cap not enforced / uncapped output confirmed',
  'HAR-SCOPE': 'Scope binding not observed on data access',
};
