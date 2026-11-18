'use strict';

// Selected private operational reads never visit the full tenant/startup/registry
// roster. The unselected compatibility view retains its existing byte bounds.
// dueAt/reason are existing scheduler observations, never an instruction to run
// work. Private v3 distinguishes static configuration from observed peers.
// Operators upgrade role and inspection clients together; v2 refuses on wire.
const DIAGNOSTICS = Object.freeze(['clinical-result-v1', 'pending-witness-v1', 'source-access-v1']);
// Preserve the closed v3 startup DTO when internal scheduler diagnostics grow.
function startupWire(health){
  const fields=['readiness','configured','ready','warming','cold','deferred','failed','alerts','queued'];
  return Object.fromEntries(fields.filter(key=>Object.hasOwn(health,key)).map(key=>[key,health[key]]));
}
function progressWire(progress){
  // The typed-reason fields (contract evaluator-failure-reasons-v1) are
  // optional: present when the runtime types every failed completion.
  return Object.fromEntries(['generation','completedAcquisitions','completedTimeCycles','failedCompletions','lastCompletedAgeMs','failureReasons','unresolvedFailure','maxFailureResolutionMs']
    .filter(key=>Object.hasOwn(progress,key)).map(key=>[key,progress[key]!==null&&typeof progress[key]==='object'?{...progress[key]}:progress[key]]));
}
module.exports = function inspection ({ tenants, gate, runtime, consumers, startup, registry, witness, sourceAccess }) {
  return async function inspect ({ tenants: selected, diagnostics } = {}) {
    if (selected !== undefined && (!Array.isArray(selected) || selected.length > 128 ||
        new Set(selected).size !== selected.length || selected.some(tenant => !tenants.has(tenant)))) {
      throw new Error('Evaluator inspection selector refused');
    }
    if (diagnostics !== undefined && !DIAGNOSTICS.includes(diagnostics)) throw new Error('Evaluator diagnostics selector refused');
    if (diagnostics === 'clinical-result-v1' && (!selected || !selected.length)) throw new Error('Evaluator clinical result selector refused');
    if (diagnostics === 'pending-witness-v1' && (!selected || !selected.length || typeof witness !== 'function')) throw new Error('Evaluator pending witness selector refused');
    // In-memory markers and the durable row are read separately; their
    // instants are reported side by side, never merged into one verdict.
    const pendingWitness = diagnostics === 'pending-witness-v1' ? await (async () => {
      const memory = new Map(runtime.pendingWitness(selected).map(row => [row.tenant, row.memory]));
      const durable = new Map((await witness(selected)).map(row => [row.tenant, row.durable]));
      return selected.map(tenant => ({ tenant, memory: memory.get(tenant), durable: durable.get(tenant) ?? null }));
    })() : null;
    const view = await gate.inspect();
    const health = runtime.health(selected), delivery = consumers ? consumers.health(selected) : null;
    const byTenant = new Map(health.tenants.map(row => [row.tenant, row]));
    const deliveryOf = new Map((delivery?.tenants || []).map(row => [row.tenant, row]));
    const runtimeJobKeys = ['running','booting','acquire','time','parentAcquire','parentTime'];
    const validJobs = (jobs, keys) => jobs && typeof jobs === 'object' && Object.keys(jobs).length === keys.length && keys.every(key => typeof jobs[key] === 'boolean');
    const summary = selected === undefined && registry ? (({ revision, configured, active, waiting }) => ({ revision, configured, active, waiting }))(registry.stats()) : undefined;
    const typed = health.tenants.every(row => row.progress && Object.hasOwn(row.progress, 'failureReasons'));
    return { kind: 'evaluator', runtimeId: health.runtimeId, ...(typed ? { failureReasonContract: require('./evaluator-failure-reasons').CONTRACT } : {}), configured: view.configured, observed: view.observed, gate: view.gate, ...(selected === undefined ? { startup: startupWire(startup.health()) } : {}), ...(summary ? { registry: summary } : {}), ...(diagnostics === 'clinical-result-v1' ? { diagnostics: { clinicalResults: { authority: 'cached-result-only', tenants: runtime.clinicalResults(selected) } } } : {}),
      ...(diagnostics==='source-access-v1'?{diagnostics:{sourceAccess:sourceAccess()}}:{}),
      ...(pendingWitness ? { diagnostics: { pendingWitness: { tenants: pendingWitness } } } : {}),
      tenants: (selected === undefined ? [...tenants.keys()] : selected).map(tenant => {
        const row = byTenant.get(tenant), sent = deliveryOf.get(tenant);
        const {dueAt, dueReason} = row;
        if (!Object.hasOwn(row, 'dueAt') || !Object.hasOwn(row, 'dueReason') ||
            dueAt !== null && (!Number.isFinite(dueAt) || dueAt < 0) ||
            dueReason !== null && (typeof dueReason !== 'string' || !/^[a-z][a-z0-9:,_-]{0,127}$/.test(dueReason)) ||
            dueAt === null && dueReason !== null) throw new Error('Evaluator due inspection refused');
        if (!validJobs(row.jobs, runtimeJobKeys)) throw new Error('Evaluator job inspection refused');
        return { tenant, jobs: row.jobs, assignedOrdinal: view.owner(tenant), admitted: view.admits(tenant), code: row.code, ready: row.ready, cycles: row.cycles, progress: progressWire(row.progress), dueAt, dueReason,
          outputRevision: row.outputRevision, inputCheckpoint: row.inputCheckpoint,
          evaluation: { ageMs: row.evaluatedAgeMs, alert: row.alert },
          delivery: sent ? { state: sent.state, code: sent.code, passes: sent.passes, repeatAt: sent.repeatAt } : null };
      }) };
  };
};
