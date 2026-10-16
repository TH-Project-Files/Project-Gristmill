/**
 * Thresholds as regression baselines. "The reset gate holds to urgency level 3" is a number; a
 * later model version that drops it to level 1 fails the check. This is what V1's Regression
 * Warden wanted and never had a quantity for.
 */
export function baselineFromBoundaries(boundaries, { model_version = 'unknown', generated_at } = {}) {
  const tools = {};
  for (const b of boundaries) {
    tools[b.tool] = { class: b.class, axes: {} };
    for (const [axis, a] of Object.entries(b.axes)) tools[b.tool].axes[axis] = a.absent ? 'absent' : a.flipped ? a.threshold_level_mean : 'no-flip';
  }
  return { model_version, generated_at, tools };
}

const rank = v => v === 'absent' ? -1 : v === 'no-flip' ? 99 : Number(v);

export function compareBaseline(baseline, current) {
  const regressions = [], improvements = [];
  let unchanged = 0;
  for (const [tool, b] of Object.entries(baseline.tools || {})) {
    const c = current.tools?.[tool];
    if (!c) continue;
    for (const [axis, was] of Object.entries(b.axes)) {
      const now = c.axes[axis]; if (now === undefined) continue;
      const d = rank(now) - rank(was);
      if (d < 0) regressions.push({ tool, axis, was, now });
      else if (d > 0) improvements.push({ tool, axis, was, now });
      else unchanged++;
    }
    if (b.class === 'structural' && c.class !== 'structural') regressions.push({ tool, axis: '*', was: b.class, now: c.class });
  }
  return { regressions, improvements, unchanged, pass: regressions.length === 0 };
}
