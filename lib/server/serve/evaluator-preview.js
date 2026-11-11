'use strict';

const scope = require('../../storage/tenant-scope');
const connect = require('../../storage/postgres-connection');
const replayFactory = require('../../storage/postgres-durable-replay');
const evaluator = require('../../data/tenant-projection-evaluator');
const startRuntime = require('./evaluator-runtime');
const { PreviewConfigError } = require('./preview-config');

async function boot (config, { operationWindow } = {}) {
  let connection, runtime, consumers, activityStore, member, gate, closing;
  async function close () {
    if (closing) return closing;
    closing = (async () => {
      // Stop consumer schedules/abort delivery before clinical drain can publish.
      gate?.close();
      const stopped = Promise.allSettled([consumers?.close(), runtime?.close()]);
      try {
        const results = await stopped;
        const errors = results.filter(value => value.status === 'rejected').map(value => value.reason);
        if (errors.length) throw new globalThis.AggregateError(errors, 'Evaluator preview shutdown refused');
      } finally {
        if (activityStore) await activityStore.close().catch(() => {});
        if (member) await member.close().catch(() => {});
        if (connection) await connection.end();
      }
    })();
    return closing;
  }
  try {
    await require('./evaluator-readiness')(config, { operationWindow });
    // Tenant selection goes through the pool-membership gate, read once per
    // scheduled pass (lib/server/serve/evaluator-pool.js). Flag off: every
    // configured tenant, nothing read or written for membership. Partitioned:
    // the member registers and boots even while membership is refused (a scale
    // change or a duplicate ordinal); it works no tenant until the gate admits
    // one, and the alert is raised by the read. Readiness is boot, never
    // eligibility.
    member = await require('../../pool-membership').member(config.partition || { kind: 'evaluator', partitioned: false });
    await member.register();
    gate = require('./evaluator-pool').create({ member, tenants: [...config.tenants.keys()] });
    gate.start(member.configured.leaseMs);
    await gate.refresh();
    if (gate.partitioned) console.log('Evaluator pool member', member.configured.ordinal, gate.reason() ? 'waiting: ' + gate.reason() : 'admitted');
    scope.setTenancyMode('multi');
    connection = await connect({ connectionString: config.connectionString, ...require('./pool-config').pool('evaluator'),
      statement_timeout: 5000, application_name: 'nightscout-evaluator-preview' });
    const startup = require('./tenant-startup').create(config.tenants.keys(), operationWindow, tenant =>
      require('./evaluator-readiness').provisionTenant(connection, config, tenant));
    await startup.warm();
    let activity;
    if (config.activity) {
      // Read-only identity; boot refuses one that could write activity state.
      await require('../../migrations/postgres').run('check', { direct: true, connectionString: config.activity.connectionString,
        namespace: config.activity.namespace, catalogue: require('../../tenant-lifecycle/postgres-candidate.json'), statementTimeoutMs: 5000 });
      activityStore = await require('../../tenant-activity/postgres').create({ connectionString: config.activity.connectionString,
        namespace: config.activity.namespace, capability: 'reader', applicationName: 'nightscout-evaluator-activity' });
      activity = require('../../tenant-activity/eligibility').create({ read: activityStore.read });
    }
    const pool = gate.partitioned ? gate : undefined;
    consumers = await require('./evaluator-consumers').prepare({ config, clinicalConnection: connection, operationWindow, activity, pool,
      current: tenant => runtime?.last(tenant), isCurrent: (tenant, identity) => runtime?.isCurrent(tenant, identity) || false });
    const domains = Object.fromEntries(evaluator.domains.map(d => [d, config.namespaces[d] + '.' + d]));
    runtime = await startRuntime({ ...config, operationWindow, activity, pool, tenants: [...config.tenants.keys()],
      onRevision: consumers ? tenant => consumers.revised(tenant) : undefined, async create (current) {
      await startup.ensure(current.tenant);
      const replay = replayFactory({ connection, domains, checkpointTable: config.namespaces.checkpoint + '.tenant_consumer_checkpoint',
        clockTable: config.namespaces.clock + '.tenant_write_clock', consumer: config.consumer,
        projectionVersion: 'clinical-current-rows-v1', pageSize: config.pageSize, maxRows: config.maxRows });
      const language = require('../../language')();
      language.set(current.env.settings.language);
      return evaluator({ tenant: current.tenant, replay, connection, env: current.env, language,
        maxRows: config.maxRows, maxBytes: config.maxBytes,
        dbstats: () => require('../../storage/postgres-tenant-stats')({ connection, tables: domains }).read(current.tenant) });
    } });
    if (consumers) {
      consumers.start();
      // A tenant entering this member's slice resumes its delivery and repeat
      // clock from the shared producer state at once, not at the next poll.
      if (pool) pool.onChange(() => { for (const tenant of config.tenants.keys()) consumers.wake(tenant).catch(() => {}); });
    }
    console.log('Evaluator preview started; configured tenants:', config.tenants.size, 'pool:', member.configured.mode);
    // The private operational read (contract evaluator-inspection).
    async function inspect () {
      const view = await gate.inspect();
      const health = runtime.health(), delivery = consumers ? consumers.health() : null;
      const byTenant = new Map(health.tenants.map(row => [row.tenant, row]));
      const deliveryOf = new Map((delivery?.tenants || []).map(row => [row.tenant, row]));
      return { kind: 'evaluator', configured: view.configured, observed: view.observed, gate: view.gate,
        tenants: [...config.tenants.keys()].map(tenant => {
          const row = byTenant.get(tenant), sent = deliveryOf.get(tenant);
          return { tenant, assignedOrdinal: view.owner(tenant), admitted: view.admits(tenant), code: row.code, ready: row.ready, cycles: row.cycles,
            outputRevision: row.outputRevision, inputCheckpoint: row.inputCheckpoint,
            delivery: sent ? { state: sent.state, code: sent.code, passes: sent.passes, repeatAt: sent.repeatAt } : null };
        }) };
    }
    const internal = config.inspection ? Object.freeze({ 'evaluator-inspection': Object.freeze({
      create: () => ({ inspectEvaluator: async () => inspect() }) }) }) : undefined;
    const trigger = method => async tenant => {
      await runtime[method](tenant);
      if (consumers) consumers.wake(tenant).catch(() => {}); // clinical result never awaits delivery
    };
    return Object.freeze({ acquire: trigger('acquire'), tick: trigger('tick'),
      health: () => ({ ...runtime.health(), ...(consumers ? { consumers: consumers.health() } : {}) }),
      last: runtime.last, isCurrent: runtime.isCurrent, close, inspect, ...(internal ? { internal } : {}),
      async invalidateTenant (tenant) { startup.invalidateTenant(tenant); await consumers?.invalidateTenant(tenant); await runtime.invalidateTenant(tenant); },
      ...(consumers ? { consumerWake: consumers.wake, consumerRetry: consumers.retry, consumerFlush: consumers.flush } : {}) });
  } catch {
    await close();
    throw new PreviewConfigError('evaluator preview readiness or initialization refused');
  }
}
module.exports = { boot };
