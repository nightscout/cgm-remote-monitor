'use strict';

const scope = require('../../storage/tenant-scope');
const connect = require('../../storage/postgres-connection');
const replayFactory = require('../../storage/postgres-durable-replay');
const evaluator = require('../../data/tenant-projection-evaluator');
const startRuntime = require('./evaluator-runtime');
const { PreviewConfigError } = require('./preview-config');

async function boot (config, { operationWindow } = {}) {
  // This private boot entry is invoked before listeners or callback-bearing
  // registry/readiness helpers. Capture authority-free scheduling contexts now.
  const contexts = require('./evaluator-job-context');
  const clinicalJobs = operationWindow ? contexts.create('clinical') : undefined;
  const deliveryJobs = operationWindow && config.consumers?.realtime ? contexts.create('delivery') : undefined;
  const clinicalCallback = fn => clinicalJobs ? clinicalJobs.bind(fn) : fn;
  const deliveryCallback = fn => deliveryJobs ? deliveryJobs.bind(fn) : fn;
  let connection, runtime, consumers, activityStore, member, gate, closing, registrySet, feed;
  async function close () {
    if (closing) return closing;
    closing = (async () => {
      // Discovery failure must still drain component-owned work and contexts.
      const preliminary = [];
      try { await registrySet?.close(); } catch (error) { preliminary.push(error); }
      try { await feed?.close(); } catch (error) { preliminary.push(error); }
      try { gate?.close(); } catch (error) { preliminary.push(error); }
      const stopped = Promise.allSettled([consumers?.close(), runtime?.close()]);
      try {
        const results = await stopped;
        const errors = preliminary.concat(results.filter(value => value.status === 'rejected').map(value => value.reason));
        if (errors.length) throw new globalThis.AggregateError(errors, 'Evaluator preview shutdown refused');
      } finally {
        if (activityStore) await activityStore.close().catch(() => {});
        if (member) await member.close().catch(() => {});
        if (registrySet) await registrySet.close().catch(() => {});
        try { if (connection) await connection.end(); } finally { clinicalJobs?.close(); deliveryJobs?.close(); }
      }
    })();
    return closing;
  }
  try {
    if (config.registry) {
      // Registry discovery follows committed revisions; admission prepares all
      // runtime resources before making a newly provisioned tenant visible.
      const settingsOf = require('./evaluator-config');
      registrySet = await require('./registry-tenant-set').open({ settings: config.registry, connectionString: config.connectionString,
        maxTenants: config.maxTenants, build: settingsOf.registryEntry, applicationName: 'nightscout-evaluator-registry' });
      // Registry runtimes may start empty and admit tenants after provisioning.
      const base = config;
      config = { ...base, tenants: registrySet.tenants,
        async readCurrent (tenant) { return registrySet.isActive(tenant) ? settingsOf.withSettings(base, registrySet.tenants.get(tenant), tenant) : null; } };
    }
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
    // Decision readiness-serve-then-warm: 'serve' (default) opens once the role's
    // own dependencies are up; tenants warm in the background (bounded), and
    // the runtime acquires warm tenants first. 'all' keeps today's behaviour.
    const readiness = require('./pool-config').tenantReadiness();
    const startupConcurrency = require('./pool-config').startupConcurrency();
    const startup = require('./tenant-startup').create(config.tenants.keys(), operationWindow, tenant =>
      require('./evaluator-readiness').provisionTenant(connection, config, tenant), { readiness, concurrency: startupConcurrency, dynamic: !!config.registry, maxTenants: config.maxTenants });
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
    consumers = await require('./evaluator-consumers').prepare({ config, clinicalConnection: connection, operationWindow, jobContext: deliveryJobs, activity, pool,
      current: tenant => runtime?.last(tenant), isCurrent: (tenant, identity) => runtime?.isCurrent(tenant, identity) || false });
    const domains = Object.fromEntries(evaluator.domains.map(d => [d, config.namespaces[d] + '.' + d]));
    // Decision write-clock-complete: the backstop reads every tenant's write
    // clock pair through the change-stamp function, one statement per pass,
    // when its namespace is configured; otherwise each component reads its
    // own tenant's pair.
    const stampReader = config.namespaces.changeStamps === undefined ? null : require('../../change-stamps/postgres').create({ connection,
      namespace: config.namespaces.changeStamps, clockNamespace: config.namespaces.clock });
    runtime = await startRuntime({ ...config, dynamic: !!config.registry, externalRecovery: !!config.changeFeed, operationWindow, jobContext: clinicalJobs, activity, pool, tenants: [...config.tenants.keys()],
      ...(stampReader ? { readStamps: stampReader.clock } : {}),
      boot: readiness, ...(readiness === 'serve' ? { bootConcurrency: startupConcurrency, isWarm: startup.isReady } : {}),
      checkConcurrency: require('./pool-config').pool('evaluator').max,
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
    if (config.changeFeed) feed = await require('../../change-feed/consumer').start({ config: config.changeFeed, tenants: config.tenants.keys(), dynamic: !!config.registry, maxTenants: config.maxTenants, check: clinicalCallback(async (selected,{ hints }) => { await runtime.backstop(selected); if (consumers) for (const [tenant,kind] of hints) if (kind !== 'data') consumers.wake(tenant).catch(() => {}); }) });
    if (consumers) {
      consumers.start();
      // A tenant entering this member's slice resumes its delivery and repeat
      // clock from the shared producer state at once, not at the next poll.
      if (pool) pool.onChange(deliveryCallback(() => { for (const tenant of config.tenants.keys()) consumers.wake(tenant).catch(() => {}); }));
    }
    if (registrySet) await registrySet.follow({
      prepare: async (tenant, entry) => {
        const cleanup = async () => { feed?.removeTenant(tenant); await runtime.removeTenant(tenant); await consumers?.removeTenant(tenant); gate.removeTenant(tenant); await startup.removeTenant(tenant); };
        try {
          if (activity && !(await activity.check('evaluator',tenant)).eligible) throw Object.assign(new Error('TENANT_ACTIVITY_DEFERRED'),{code:'TENANT_ACTIVITY_DEFERRED'});
          await require('./evaluator-config').withSettings(config, entry, tenant);
          startup.addTenant(tenant);
          // An unowned pool slice has no data warm/evaluation on this member.
          if (gate.admits(tenant)) {
            if (!await require('./tenant-startup').attempt(operationWindow,tenant,()=>startup.ensure(tenant))) throw new Error('Tenant operation deferred');
            if (consumers && !await consumers.prepareTenant(tenant)) throw new Error('Tenant consumer deferred');
          }
          gate.addTenant(tenant);consumers?.addTenant(tenant);runtime.addTenant(tenant);feed?.addTenant(tenant);
          return cleanup;
        } catch(error) { await cleanup();throw error; }
      },
      activate: clinicalCallback(tenant => { runtime.acquire(tenant).catch(()=>{}); if(consumers)consumers.wake(tenant).catch(()=>{}); }),
      remove: async tenant => { feed?.removeTenant(tenant); await runtime.removeTenant(tenant); await consumers?.removeTenant(tenant); gate.removeTenant(tenant);await startup.removeTenant(tenant); }
    });
    console.log('Evaluator preview started; configured tenants:', config.tenants.size, 'pool:', member.configured.mode, ...(registrySet ? ['registry revision:', registrySet.revision()] : []));
    // The private operational read (contract evaluator-inspection).
    const inspect = require('./evaluator-inspection')({ tenants: config.tenants, gate, runtime, consumers, startup, registry: registrySet });
    const internal = config.inspection ? Object.freeze({ 'evaluator-inspection': Object.freeze({
      create: () => ({ inspectEvaluator: async (context, body) => inspect(body) }) }) }) : undefined;
    const trigger = method => async tenant => {
      await runtime[method](tenant);
      if (consumers) consumers.wake(tenant).catch(() => {}); // clinical result never awaits delivery
    };
    // The wake seam for a later change source (a slot reader's NOTIFY); the
    // backstop pass and the due-time timers run inside the runtime.
    async function wake (tenant, hint) {
      await runtime.wake(tenant, hint);
      if (consumers) consumers.wake(tenant).catch(() => {});
    }
    return Object.freeze({ acquire: trigger('acquire'), tick: trigger('tick'), wake,
      health: () => ({ ...runtime.health(), ...(feed ? { changeFeed: feed.health() } : {}), startup: startup.health(), ...(stampReader ? { changeStamps: stampReader.stats() } : {}),
        ...(registrySet ? { registry: registrySet.stats() } : {}),
        ...(consumers ? { consumers: consumers.health() } : {}) }),
      last: runtime.last, isCurrent: runtime.isCurrent, close, inspect, ...(internal ? { internal } : {}),
      async invalidateTenant (tenant) { startup.invalidateTenant(tenant); await consumers?.invalidateTenant(tenant); await runtime.invalidateTenant(tenant); },
      ...(consumers ? { consumerWake: consumers.wake, consumerRetry: consumers.retry, consumerFlush: consumers.flush } : {}) });
  } catch {
    await close();
    throw new PreviewConfigError('evaluator preview readiness or initialization refused');
  }
}
module.exports = { boot };
