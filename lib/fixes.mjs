/**
 * Fix catalog. A fix id is a stable string `kind:detail@subject` so that findings from different
 * analyzers that would be closed by the SAME change share one id — that is what lets set cover
 * rank "the smallest change set that closes the most failure mass".
 */

export function fixMeta(fixId) {
  const [head, subject = ''] = fixId.split('@');
  const [kind, detail = ''] = head.split(':');
  const S = subject || '(platform)';
  const T = {
    gate:     { locus: 'security-guardrail', effort: 1, risk: 'low',    d: `Wrap EVERY route to ${S} in a consent gate (hitl/confirm). Today at least one caller reaches it ungated.` },
    entry:    { locus: 'routing-logic',      effort: 1, risk: 'low',    d: `Make consent-gated write tools unreachable from non-interactive entry '${S}' (schedule/webhook): a HITL gate cannot fire there.` },
    validator:{ locus: 'tool-contract',      effort: 2, risk: 'low',    d: `Convert the deny-list check on ${S} to an allow-list of permitted shapes (hosts / grammar / id pattern).` },
    sanitize: { locus: 'tool-contract',      effort: 2, risk: 'low',    d: `Validate/sanitize ${S} before it reaches its sink (parameterize SQL, canonicalize + allow-list paths, allow-list hosts, never shell-interpolate).` },
    errors:   { locus: 'tool-contract',      effort: 1, risk: 'low',    d: `Return a sanitized error summary from ${S}; strip stack frames, filesystem paths and connection strings.` },
    redact:   { locus: 'security-guardrail', effort: 1, risk: 'low',    d: `Redact sensitive env values on every output/log sink of ${S} (mask the secret; log the name, never the value).` },
    env:      { locus: 'config',             effort: 1, risk: 'low',    d: `Declare the env var ${S} in the tool contract (or stop reading it); undeclared reads escape the env lock.` },
    sinks:    { locus: 'tool-contract',      effort: 1, risk: 'low',    d: `Declare the sink ${S} in the tool contract so the model (and reviewers) know this flow exists.` },
    scope:    { locus: 'tool-contract',      effort: 2, risk: 'medium', d: `Bind every call in ${S} to the caller's tenant/scope id; refuse cross-scope matches or ask.` },
    budget:   { locus: 'stop-conditions',    effort: 1, risk: 'low',    d: `Set a session-wide tool-call budget (and per-task soft budget) so wide tasks cannot run unbounded.` },
    retries:  { locus: 'stop-conditions',    effort: 1, risk: 'low',    d: `Make ${S} consult cached outage state before retrying, cap retries, and back off.` },
    limit:    { locus: 'tool-contract',      effort: 1, risk: 'low',    d: `Add a hard-capped limit/pagination parameter to ${S}; default to a sane page, never the full table.` },
    policy:   { locus: 'prompt-policy',      effort: 1, risk: 'medium', d: `Add the '${detail}' policy to the relevant prompts${subject ? ` (${S})` : ''}.` },
    routing:  { locus: 'routing-logic',      effort: 2, risk: 'medium', d: `Give ${S} a single owner / expose the batch form where the per-item form is reachable, so one route is clearly preferred.` },
    tool:     { locus: 'tool-contract',      effort: 2, risk: 'medium', d: `Merge or sharply differentiate the overlapping tools ${S}; two near-identical tools cost context and invite double dispatch.` },
    prompt:   { locus: 'prompt-policy',      effort: 2, risk: 'medium', d: `Trim prompt mass for ${S}: shorten tool descriptions, move reference into skills, drop tools the actor never needs.` },
  }[kind] || { locus: 'tool-contract', effort: 2, risk: 'medium', d: `Apply fix ${fixId}.` };
  return { fix_id: fixId, kind: head, locus: T.locus, effort: T.effort, regression_risk: T.risk, description: T.d };
}
