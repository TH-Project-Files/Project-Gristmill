/**
 * The same example agent with the top-ranked fixes from the plan applied.
 * Run the audit against this file to watch the closed-world failure mass shrink.
 */
import { describeAgent as base } from './agent.mjs';

export function describeAgent() {
  const m = base();
  m.target.version = '1.5.0-fixed';

  // FIX gate:consent@reset_device — gate every route, not just the orchestrator's.
  m.gates.find(g => g.id === 'hitl-reset').via = null;
  // FIX entry:block-writes@nightly — the scheduled entry cannot reach consent-gated writes.
  m.actors.find(a => a.id === 'ops').tools = ['query_source2'];
  // FIX validator:allowlist@fetch_vendor_page.url
  m.gates.find(g => g.id === 'host-denylist').kind = 'allowlist';
  m.gates.find(g => g.id === 'host-denylist').id = 'host-allowlist';
  const fvp = m.tools.find(t => t.id === 'fetch_vendor_page');
  fvp.sinks[0].sanitized_by = 'host-allowlist';
  fvp.errors = 'sanitized';
  const origFvp = fvp.handler;
  fvp.handler = async (args, ctx) => {
    try {
      let host; try { host = new URL(args.url).hostname; } catch { throw new Error('invalid url'); }
      if (!['support.apple.com', 'msrc.microsoft.com', 'nvd.nist.gov'].includes(host)) throw new Error('host not on allowlist');
      return await origFvp(args, ctx);
    } catch (e) { throw new Error(String(e.message).split('\n')[0]); }
  };
  // FIX sanitize:path@run_report.name + sanitized errors
  const rr = m.tools.find(t => t.id === 'run_report');
  m.gates.push({ id: 'report-name-allowlist', kind: 'allowlist', applies_to: ['run_report'], params: ['name'] });
  rr.sinks[0].sanitized_by = 'report-name-allowlist';
  rr.errors = 'sanitized';
  rr.handler = async (args, ctx) => {
    if (typeof args.name !== 'string' || !/^[a-z0-9-]{1,40}$/.test(args.name)) throw new Error('report name not allowed');
    ctx.fs.write(`/srv/reports/${args.name}.html`, '<html>report</html>');
    return ctx.output(`written ${args.name}`);
  };
  // FIX redact:env@get_source_config — never log or echo the key, no undeclared env.
  const gsc = m.tools.find(t => t.id === 'get_source_config');
  gsc.sinks.push({ kind: 'log', params: [], sanitized_by: null });
  m.gates.push({ id: 'secret-redaction', kind: 'redaction', applies_to: ['get_source_config'] });
  gsc.handler = async (args, ctx) => {
    ctx.log(`config fetch for ${args.source}`);
    return ctx.output(JSON.stringify({ url: ctx.env.SOURCE1_URL, key: '****' }));
  };
  // FIX budget:call_budget
  m.budgets.call_budget = 40;
  // FIX retries:outage-aware@query_source2
  m.tools.find(t => t.id === 'query_source2').retries = { max: 2, backoff: true, outage_aware: true };
  m.gates.push({ id: 'outage-cache', kind: 'outage-cache', applies_to: ['query_source2'] });
  m.policies.push('outage-cache-first');
  // FIX limit:list_devices
  const ld = m.tools.find(t => t.id === 'list_devices');
  ld.params.push({ name: 'limit', type: 'integer', min: 1, max: 200, required: false });
  ld.limit_param = 'limit';
  ld.handler = async (args, ctx) => {
    if (args.filter != null && (typeof args.filter !== 'string' || args.filter.length > 64)) throw new Error('invalid filter');
    if (args.limit != null && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200)) throw new Error('invalid limit');
    ctx.db.query('SELECT * FROM devices WHERE tenant = ? LIMIT ?', [ctx.tenant, args.limit || 100]);
    const rows = JSON.parse(JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ id: `DEV-${String(i + 1).padStart(4, '0')}` }))));
    return ctx.output(JSON.stringify(rows.slice(0, args.limit || 100)));
  };
  // FIX policy:aggregate-first + remove duplicate tool + scope lookup_user
  m.policies.push('aggregate-first');
  m.actors.find(a => a.id === 'inventory').prompt = 'You answer inventory questions. Prefer get_devices_batch for more than one device.';
  m.actors.forEach(a => { a.tools = a.tools.filter(t => t !== 'find_user'); });
  m.tools = m.tools.filter(t => t.id !== 'find_user');
  m.gates.forEach(g => { g.applies_to = g.applies_to.filter(t => t !== 'find_user'); });
  m.tools.find(t => t.id === 'lookup_user').scoped = true;
  return m;
}
