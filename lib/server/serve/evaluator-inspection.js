'use strict';

// Selected private operational reads never visit the full tenant/startup/registry
// roster. The unselected compatibility view retains its existing byte bounds.
// dueAt/reason are existing scheduler observations, never an instruction to run
// work. This unreleased private v2 response requires the paired current schema;
// an older strict v2 client refuses additional fields rather than ignoring them.
module.exports = function inspection ({ tenants, gate, runtime, consumers, startup, registry, changeFeed }) {
  return async function inspect ({ tenants: selected, diagnostics } = {}) {
    if (selected !== undefined && (!Array.isArray(selected) || selected.length > 128 ||
        new Set(selected).size !== selected.length || selected.some(tenant => !tenants.has(tenant)))) {
      throw new Error('Evaluator inspection selector refused');
    }
    if (diagnostics !== undefined && !['change-feed-v1','clinical-result-v1'].includes(diagnostics)) throw new Error('Evaluator diagnostics selector refused');
    if (diagnostics === 'clinical-result-v1' && (!selected || !selected.length)) throw new Error('Evaluator clinical result selector refused');
    const view = await gate.inspect();
    const health = runtime.health(selected), delivery = consumers ? consumers.health(selected) : null;
    const byTenant = new Map(health.tenants.map(row => [row.tenant, row]));
    const deliveryOf = new Map((delivery?.tenants || []).map(row => [row.tenant, row]));
    const runtimeJobKeys = ['running','booting','acquire','time','parentAcquire','parentTime'];
    const validJobs = (jobs, keys) => jobs && typeof jobs === 'object' && Object.keys(jobs).length === keys.length && keys.every(key => typeof jobs[key] === 'boolean');
    const summary = selected === undefined && registry ? (({ revision, configured, active, waiting }) => ({ revision, configured, active, waiting }))(registry.stats()) : undefined;
    return { kind: 'evaluator', runtimeId: health.runtimeId, configured: view.configured, observed: view.observed, gate: view.gate, ...(selected === undefined ? { startup: startup.health() } : {}), ...(summary ? { registry: summary } : {}), ...(diagnostics === 'change-feed-v1' ? { diagnostics: { changeFeed: feedObservation(changeFeed) } } : {}), ...(diagnostics === 'clinical-result-v1' ? { diagnostics: { clinicalResults: { authority: 'cached-result-only', tenants: runtime.clinicalResults(selected) } } } : {}),
      tenants: (selected === undefined ? [...tenants.keys()] : selected).map(tenant => {
        const row = byTenant.get(tenant), sent = deliveryOf.get(tenant);
        const {dueAt, dueReason} = row;
        if (!Object.hasOwn(row, 'dueAt') || !Object.hasOwn(row, 'dueReason') ||
            dueAt !== null && (!Number.isFinite(dueAt) || dueAt < 0) ||
            dueReason !== null && (typeof dueReason !== 'string' || !/^[a-z][a-z0-9:,_-]{0,127}$/.test(dueReason)) ||
            dueAt === null && dueReason !== null) throw new Error('Evaluator due inspection refused');
        if (!validJobs(row.jobs, runtimeJobKeys)) throw new Error('Evaluator job inspection refused');
        return { tenant, jobs: row.jobs, assignedOrdinal: view.owner(tenant), admitted: view.admits(tenant), code: row.code, ready: row.ready, cycles: row.cycles, progress: row.progress, dueAt, dueReason,
          outputRevision: row.outputRevision, inputCheckpoint: row.inputCheckpoint,
          evaluation: { ageMs: row.evaluatedAgeMs, alert: row.alert },
          delivery: sent ? { state: sent.state, code: sent.code, passes: sent.passes, repeatAt: sent.repeatAt } : null };
      }) };
  };
};

// This reads one existing O(1) health snapshot only on explicit request. It does
// not visit startup/registry/tenant maps or acquire authority to run feed work.
function feedObservation (read) {
  if (typeof read !== 'function') return { status: 'not-configured', health: null };
  let health;
  try { health = read(); } catch { return { status: 'unavailable', health: null }; }
  if (health === null) return { status: 'not-configured', health: null };
  const counters = ['pages','checks','hints','refused','reconnects','sweeps','rotated'];
  if (!health || typeof health !== 'object' || Array.isArray(health) ||
      ['live','connected','degraded'].some(key => typeof health[key] !== 'boolean') ||
      ['recoveryRemaining',...counters].some(key => !Number.isSafeInteger(health[key]) || health[key] < 0) ||
      health.heartbeatAgeMs !== null && (!Number.isFinite(health.heartbeatAgeMs) || health.heartbeatAgeMs < 0) ||
      health.refusal !== null && !['FEED_RECONCILIATION_REFUSED','FEED_LISTENER_UNAVAILABLE'].includes(health.refusal)) throw new Error('Evaluator feed inspection refused');
  return { status: 'observed', health: Object.fromEntries(['live','connected','degraded','recoveryRemaining','heartbeatAgeMs','refusal',...counters].map(key => [key,health[key]])) };
}
