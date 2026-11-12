'use strict';

// Selected private operational reads never visit the full tenant/startup/registry
// roster. The unselected compatibility view retains its existing byte bounds.
// dueAt/reason are existing scheduler observations, never an instruction to run
// work. This unreleased private v2 response requires the paired current schema;
// an older strict v2 client refuses additional fields rather than ignoring them.
module.exports = function inspection ({ tenants, gate, runtime, consumers, startup, registry }) {
  return async function inspect ({ tenants: selected } = {}) {
    if (selected !== undefined && (!Array.isArray(selected) || selected.length > 128 ||
        new Set(selected).size !== selected.length || selected.some(tenant => !tenants.has(tenant)))) {
      throw new Error('Evaluator inspection selector refused');
    }
    const view = await gate.inspect();
    const health = runtime.health(selected), delivery = consumers ? consumers.health(selected) : null;
    const byTenant = new Map(health.tenants.map(row => [row.tenant, row]));
    const deliveryOf = new Map((delivery?.tenants || []).map(row => [row.tenant, row]));
    const summary = selected === undefined && registry ? (({ revision, configured, active, waiting }) => ({ revision, configured, active, waiting }))(registry.stats()) : undefined;
    return { kind: 'evaluator', runtimeId: health.runtimeId, configured: view.configured, observed: view.observed, gate: view.gate, ...(selected === undefined ? { startup: startup.health() } : {}), ...(summary ? { registry: summary } : {}),
      tenants: (selected === undefined ? [...tenants.keys()] : selected).map(tenant => {
        const row = byTenant.get(tenant), sent = deliveryOf.get(tenant);
        const {dueAt, dueReason} = row;
        if (!Object.hasOwn(row, 'dueAt') || !Object.hasOwn(row, 'dueReason') ||
            dueAt !== null && (!Number.isFinite(dueAt) || dueAt < 0) ||
            dueReason !== null && (typeof dueReason !== 'string' || !/^[a-z][a-z0-9:,_-]{0,127}$/.test(dueReason)) ||
            dueAt === null && dueReason !== null) throw new Error('Evaluator due inspection refused');
        return { tenant, assignedOrdinal: view.owner(tenant), admitted: view.admits(tenant), code: row.code, ready: row.ready, cycles: row.cycles, progress: row.progress, dueAt, dueReason,
          outputRevision: row.outputRevision, inputCheckpoint: row.inputCheckpoint,
          evaluation: { ageMs: row.evaluatedAgeMs, alert: row.alert },
          delivery: sent ? { state: sent.state, code: sent.code, passes: sent.passes, repeatAt: sent.repeatAt } : null };
      }) };
  };
};
