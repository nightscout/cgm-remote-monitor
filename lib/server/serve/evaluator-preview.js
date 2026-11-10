'use strict';

const scope = require('../../storage/tenant-scope');
const connect = require('../../storage/postgres-connection');
const replayFactory = require('../../storage/postgres-durable-replay');
const evaluator = require('../../data/tenant-projection-evaluator');
const startRuntime = require('./evaluator-runtime');
const { PreviewConfigError } = require('./preview-config');

async function boot (config, { operationWindow } = {}) {
  let connection, runtime, consumers, activityStore, closing;
  async function close () {
    if (closing) return closing;
    closing = (async () => {
      // Stop consumer schedules/abort delivery before clinical drain can publish.
      const stopped = Promise.allSettled([consumers?.close(), runtime?.close()]);
      try {
        const results = await stopped;
        const errors = results.filter(value => value.status === 'rejected').map(value => value.reason);
        if (errors.length) throw new globalThis.AggregateError(errors, 'Evaluator preview shutdown refused');
      } finally {
        if (activityStore) await activityStore.close().catch(() => {});
        if (connection) await connection.end();
      }
    })();
    return closing;
  }
  try {
    await require('./evaluator-readiness')(config, { operationWindow });
    scope.setTenancyMode('multi');
    connection = await connect({ connectionString: config.connectionString, max: 4,
      connectionTimeoutMillis: 5000, statement_timeout: 5000, application_name: 'nightscout-evaluator-preview' });
    const startup = require('./tenant-startup').create(config.tenants.keys(), operationWindow, tenant =>
      require('./evaluator-readiness').provisionTenant(connection, config, tenant));
    await startup.warm();
    let activity;
    if (config.activity) {
      // Read-only identity; boot refuses one that could write activity state.
      await require('../../migrations/postgres').run('check', { direct: true, connectionString: config.activity.connectionString,
        namespace: config.activity.namespace, catalogue: require('../../tenant-activity/postgres-candidate.json'), statementTimeoutMs: 5000 });
      activityStore = await require('../../tenant-activity/postgres').create({ connectionString: config.activity.connectionString,
        namespace: config.activity.namespace, capability: 'reader', applicationName: 'nightscout-evaluator-activity' });
      activity = require('../../tenant-activity/eligibility').create({ read: activityStore.read });
    }
    consumers = await require('./evaluator-consumers').prepare({ config, clinicalConnection: connection, operationWindow, activity,
      current: tenant => runtime?.last(tenant), isCurrent: (tenant, identity) => runtime?.isCurrent(tenant, identity) || false });
    const domains = Object.fromEntries(evaluator.domains.map(d => [d, config.namespaces[d] + '.' + d]));
    runtime = await startRuntime({ ...config, operationWindow, activity, tenants: [...config.tenants.keys()], async create (current) {
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
    if (consumers) consumers.start();
    console.log('Evaluator preview started; configured tenants:', config.tenants.size);
    const trigger = method => async tenant => {
      await runtime[method](tenant);
      if (consumers) consumers.wake(tenant).catch(() => {}); // clinical result never awaits delivery
    };
    return Object.freeze({ acquire: trigger('acquire'), tick: trigger('tick'),
      health: () => ({ ...runtime.health(), ...(consumers ? { consumers: consumers.health() } : {}) }),
      last: runtime.last, isCurrent: runtime.isCurrent, close,
      async invalidateTenant (tenant) { startup.invalidateTenant(tenant); await consumers?.invalidateTenant(tenant); await runtime.invalidateTenant(tenant); },
      ...(consumers ? { consumerWake: consumers.wake, consumerRetry: consumers.retry, consumerFlush: consumers.flush } : {}) });
  } catch {
    await close();
    throw new PreviewConfigError('evaluator preview readiness or initialization refused');
  }
}
module.exports = { boot };
