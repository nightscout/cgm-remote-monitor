'use strict';

const scope = require('../../storage/tenant-scope');
const connect = require('../../storage/postgres-connection');
const replayFactory = require('../../storage/postgres-durable-replay');
const evaluator = require('../../data/tenant-projection-evaluator');
const startRuntime = require('./evaluator-runtime');
const { PreviewConfigError } = require('./preview-config');

async function boot (config, { operationWindow } = {}) {
  if(config.pgstream&&!operationWindow)throw new Error('PGSTREAM_OPERATION_WINDOW_REQUIRED');
  const coldAdmission = require('../../storage/connection-admission').coldAdmission();
  // This private boot entry is invoked before listeners or callback-bearing
  // registry/readiness helpers. Capture authority-free scheduling contexts now.
  const contexts = require('./evaluator-job-context');
  const clinicalJobs = operationWindow ? contexts.create('clinical') : undefined;
  const deliveryJobs = operationWindow && config.consumers?.realtime ? contexts.create('delivery') : undefined;
  const clinicalCallback = fn => clinicalJobs ? clinicalJobs.bind(fn) : fn;
  const deliveryCallback = fn => deliveryJobs ? deliveryJobs.bind(fn) : fn;
  let trusted, operational, connection, runtime, consumers, activityStore, member, gate, closing, registrySet, feed, settingsReader, startup, pgstream, workTimer, workDrain;
  let failRole;const failure=new Promise(resolve=>{failRole=resolve;});
  async function close () {
    if (closing) return closing;
    closing = (async () => {
      // Discovery failure must still drain component-owned work and contexts.
      const preliminary = [];
      if(workTimer)clearInterval(workTimer);
      try { await pgstream?.close(); } catch(error) { preliminary.push(error); }
      try { await registrySet?.close(); } catch (error) { preliminary.push(error); }
      try { await feed?.close(); } catch (error) { preliminary.push(error); }
      try { await operational?.close(); } catch (error) { preliminary.push(error); }
      try { gate?.close(); } catch (error) { preliminary.push(error); }
      try { await startup?.close(); } catch (error) { preliminary.push(error); }
      const stopped = Promise.allSettled([consumers?.close(), runtime?.close()]);
      const errors = preliminary;
      try {
        const results = await stopped;
        errors.push(...results.filter(value => value.status === 'rejected').map(value => value.reason));
      } finally {
        try { if (settingsReader) await settingsReader.close(); } catch (error) { errors.push(error); }
        if (activityStore) await activityStore.close().catch(() => {});
        if (member) await member.close().catch(() => {});
        if (registrySet) await registrySet.close().catch(() => {});
        try { if (connection) await connection.end(); } finally { clinicalJobs?.close(); deliveryJobs?.close(); }
      }
      if (errors.length) throw new globalThis.AggregateError(errors, 'Evaluator preview shutdown refused');
    })();
    return closing;
  }
  try {
    if (config.tenantSettings) {
      // Trusted workers retain settings by version and verify their operational
      // contract independently. Legacy configurations keep the strict reader.
      const settingsConfiguration = structuredClone(config.tenantSettings);
      settingsReader = { ...(config.trustedWorker ? {
        read: tenant => trusted.read(tenant), close: () => trusted?.close()
      } : require('../../tenant-settings/presentation-reader')(settingsConfiguration, { revalidate: true, preserveErrors: true,
        concurrency: require('../../tenant-settings/effective-postgres').POOL_MAX, maxPending: config.maxTenants })),
        matches: current => require('node:util').isDeepStrictEqual(current, settingsConfiguration) };
      const base = config;
      config = typeof base.readCurrent === 'function'
        ? { ...base, readCurrent: tenant => base.readCurrent(tenant, settingsReader) } : base;
    }
    if (config.registry) {
      // Registry discovery follows committed revisions; admission prepares all
      // runtime resources before making a newly provisioned tenant visible.
      const settingsOf = require('./evaluator-config');
      registrySet = await require('./registry-tenant-set').open({ settings: config.registry, connectionString: config.connectionString,
        maxTenants: config.maxTenants, build: settingsOf.registryEntry, applicationName: 'nightscout-evaluator-registry' });
      // Registry runtimes may start empty and admit tenants after provisioning.
      const base = config;
      config = { ...base, tenants: registrySet.tenants,
        async readCurrent (tenant) { return registrySet.isActive(tenant) ? settingsOf.withSettings(base, registrySet.tenants.get(tenant), tenant, settingsReader) : null; } };
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
    if(config.pgstream && require('./pool-config').pool('evaluator').max<2)throw new Error('PGSTREAM_EVALUATOR_POOL_BOUND');
    if(config.pgstream && gate.partitioned)throw new Error('PGSTREAM_EVALUATOR_PARTITION_UNQUALIFIED');
    scope.setTenancyMode('multi');
    connection = await connect({ connectionString: config.connectionString, ...require('./pool-config').pool('evaluator'),
      statement_timeout: 5000, application_name: 'nightscout-evaluator-preview' });
    if (config.trustedWorker) {
      trusted = require('../../trusted-worker/postgres').create({ connection, namespaces: config.trustedWorker, settingsRefreshMs: config.settingsRefreshMs });
      operational = await require('../../trusted-worker/lifecycle')(trusted, {
        ...(operationWindow?.trustedWorker ? {
        verifyWorker: () => {
          trusted.invalidate();
          return operationWindow.verifyOperational(async () => {
            await connect.readopt(operationWindow);
            await consumers?.verifyOperational?.();
            await trusted.verify();
          });
        }
      } : {}) });
      await trusted.scan([...config.tenants.keys()].filter(tenant => gate.admits(tenant)));
    }
    if(config.pgstream){
      const hint=require('../internal-api/clients').completedOutput(config.pgstream.outputPeer);
      pgstream=await require('../../pgstream/evaluator').open({config,connection,
        onInput:clinicalCallback(async(tenant,kind)=>{
          if(!config.tenants.has(tenant))return;
          await trusted.scan([tenant]);
          await runtime?.acquire(tenant);
          if(kind!=='clock')consumers?.wake(tenant).catch(()=>{});
        }),
        onOutput:tenant=>{hint.hintCompletedOutput({tenant}).catch(()=>{});},
        onUnavailable:async(code,details)=>{trusted.invalidate();if(details)console.error('Pgstream unavailable',JSON.stringify(details));},onTerminal:(code,details)=>{if(details)console.error('Pgstream terminal',JSON.stringify(details));failRole(Object.assign(new Error(code),{code}));},
        onSchema:async()=>{
          trusted.invalidate();await require('./evaluator-readiness')(config,{operationWindow});
          await operational.verify();await trusted.scan([...config.tenants.keys()],{recovery:true});
          if(runtime)for(const tenant of config.tenants.keys())await runtime.invalidateTenant(tenant);
          setImmediate(clinicalCallback(()=>runtime?.backstop([...config.tenants.keys()],{recovery:true}).catch(()=>{})));
        },
        onRecovered:async store=>{
          await operational.verify();
          const rows=await trusted.scan([...config.tenants.keys()],{recovery:true});
          await require('../../pgstream/bootstrap')(store,rows);
          setImmediate(clinicalCallback(()=>runtime?.backstop([...config.tenants.keys()],{recovery:true}).catch(()=>{})));
        }});
      await pgstream.ready();
    }
    // Decision readiness-serve-then-warm: 'serve' (default) opens once the role's
    // own dependencies are up; tenants warm in the background (bounded), and
    // the runtime acquires warm tenants first. 'all' keeps today's behaviour.
    const readiness = require('./pool-config').tenantReadiness();
    const startupConcurrency = require('./pool-config').startupConcurrency();
    startup = require('./tenant-startup').create(config.tenants.keys(), operationWindow, tenant =>
      require('./evaluator-readiness').provisionTenant(connection, config, tenant), { readiness, ...(coldAdmission ? {coldAdmission} : {}), concurrency: startupConcurrency, dynamic: !!config.registry, maxTenants: config.maxTenants });
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
    consumers = await require('./evaluator-consumers').prepare({ ...(config.pgstream ? {assertOperational:()=>{if(!trusted.state().available)throw new Error('TRUSTED_WORKER_UNAVAILABLE');pgstream.assertAvailable();}} : {}), config, clinicalConnection: connection, operationWindow, ...(coldAdmission ? {coldAdmission} : {}), jobContext: deliveryJobs, activity, pool,
      current: tenant => runtime?.last(tenant), isCurrent: (tenant, identity) => runtime?.isCurrent(tenant, identity) || false });
    const domains = Object.fromEntries(evaluator.domains.map(d => [d, config.namespaces[d] + '.' + d]));
    // Decision write-clock-complete: the backstop reads every tenant's write
    // clock pair through the change-stamp function, one statement per pass,
    // when its namespace is configured; otherwise each component reads its
    // own tenant's pair.
    const stampReader = config.namespaces.changeStamps === undefined ? null : require('../../change-stamps/postgres').create({ connection,
      namespace: config.namespaces.changeStamps, clockNamespace: config.namespaces.clock });
    const bootVerification = operational?.version();
    runtime = await startRuntime({ ...config, dynamic: !!config.registry, externalRecovery: !!config.changeFeed || !!pgstream, operationWindow,
      ...(pgstream?{durable:{begin:pgstream.store.begin,complete:async(tenant,value)=>{pgstream.assertAvailable();const current=await config.readCurrent(tenant);if(!current||current.identity!==value.identity)throw new Error('EVALUATOR_COMPLETION_CONFIG_CHANGED');pgstream.assertAvailable();return pgstream.store.complete(tenant,{...value,restoreGeneration:operationWindow.currentGeneration(tenant)});}}}:{}), jobContext: clinicalJobs, activity, pool, tenants: [...config.tenants.keys()],
      ...(trusted ? { readMetadata: trusted.scan, metadataCurrent: trusted.current, readSource: tenant => config.tenants.get(tenant)?.identity } : stampReader ? { readStamps: stampReader.clock } : {}),
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
        maxRows: config.maxRows, maxBytes: config.maxBytes, ...(pgstream?{includeFrame:true}:{}),
        dbstats: () => require('../../storage/postgres-tenant-stats')({ connection, tables: domains }).read(current.tenant) });
    } });
    if(pgstream){
      operational.activateRefresh(clinicalCallback(async () => {
        pgstream.assertAvailable();
        await runtime.backstop([...config.tenants.keys()], { recovery: true });
      }), config.settingsRefreshMs ?? 600000, bootVerification);
      const drain=clinicalCallback(async()=>{
        if(workDrain)return workDrain;
        workDrain=(async()=>{pgstream.assertAvailable();
          const rows=await pgstream.store.work();
          await require('./tenant-startup').limited(rows.filter(row=>config.tenants.has(row.tenant)),require('./pool-config').pool('evaluator').max-1,async row=>{
            await trusted.scan([row.tenant]);
            await runtime[row.pendingAt!==null?'acquire':'tick'](row.tenant);
          });
        })().finally(()=>{workDrain=null;});return workDrain;
      });
      workTimer=setInterval(()=>drain().catch(()=>{}),config.pgstream.bounds.heartbeatMs);workTimer.unref?.();
      drain().catch(()=>{});
    }
    if (config.changeFeed) feed = await require('../../change-feed/consumer').start({ config: config.changeFeed, tenants: config.tenants.keys(), dynamic: !!config.registry, maxTenants: config.maxTenants, check: clinicalCallback(async (selected,{ hints, recovery }) => { await runtime.backstop(selected, { recovery }); if (consumers) for (const [tenant,kind] of hints) if (kind !== 'data') consumers.wake(tenant).catch(() => {}); }) });
    if (consumers) {
      consumers.start();
      // A tenant entering this member's slice resumes its delivery and repeat
      // clock from the shared producer state at once, not at the next poll.
      if (pool) pool.onChange(deliveryCallback(() => { for (const tenant of config.tenants.keys()) consumers.wake(tenant).catch(() => {}); }));
    }
    // A slice change is this member's own admission changing, not a tenant
    // write: no hint arrives for it, so hint every tenant instead of waiting
    // for the healthy rotation (change-feed sweepMs).
    if (pool && feed) pool.onChange(() => feed.resync());
    if (registrySet) await registrySet.follow({
      prepare: async (tenant, entry) => {
        const cleanup = async () => { feed?.removeTenant(tenant); await runtime.removeTenant(tenant); trusted?.remove(tenant); await consumers?.removeTenant(tenant); gate.removeTenant(tenant); await startup.removeTenant(tenant); };
        try {
          if (activity && !(await activity.check('evaluator',tenant)).eligible) throw Object.assign(new Error('TENANT_ACTIVITY_DEFERRED'),{code:'TENANT_ACTIVITY_DEFERRED'});
          await require('./evaluator-config').withSettings(config, entry, tenant, settingsReader);
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
      remove: async tenant => { feed?.removeTenant(tenant); await runtime.removeTenant(tenant); trusted?.remove(tenant); await consumers?.removeTenant(tenant); gate.removeTenant(tenant);await startup.removeTenant(tenant); }
    });
    console.log('Evaluator preview started; configured tenants:', config.tenants.size, 'pool:', member.configured.mode, 'operation:', operationWindow?.trustedWorker ? 'trusted-worker' : 'scoped', ...(registrySet ? ['registry revision:', registrySet.revision()] : []));
    // The private operational read (contract evaluator-inspection).
    const inspect = require('./evaluator-inspection')({ tenants: config.tenants, gate, runtime, consumers, startup, registry: registrySet, changeFeed: () => feed ? feed.health() : null });
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
      health: () => ({ ...runtime.health(), ...(trusted ? { trustedWorker: trusted.health() } : {}), ...(feed ? { changeFeed: feed.health() } : {}), ...(pgstream?{pgstream:pgstream.health()}:{}), startup: startup.health(), ...(stampReader ? { changeStamps: stampReader.stats() } : {}),
        ...(registrySet ? { registry: registrySet.stats() } : {}),
        ...(consumers ? { consumers: consumers.health() } : {}) }),
      ...(pgstream?{failure}:{}),last: runtime.last, isCurrent: runtime.isCurrent, close, inspect, ...(internal ? { internal } : {}),
      async invalidateTenant (tenant) { trusted?.remove(tenant); startup.invalidateTenant(tenant); await consumers?.invalidateTenant(tenant); await runtime.invalidateTenant(tenant); },
      // Decision datastore-loss-recover-in-place: after the datastore's postmaster
      // changed, every configured tenant is invalidated as a restore would, at once.
      async invalidateAll () {
        trusted?.invalidate();
        const results = await Promise.allSettled(runtime.health().tenants.map(async row => {
          if (startup.tenants().includes(row.tenant)) startup.invalidateTenant(row.tenant, { warm: false });
          await consumers?.invalidateTenant(row.tenant); await runtime.invalidateTenant(row.tenant);
        }));
        if (results.some(result => result.status === 'rejected')) throw new Error('Evaluator tenant invalidation refused');
      },
      // The datastore is re-admitted: warm as at boot.
      resume () { Promise.resolve().then(() => operational?.verify()).then(() => startup.warm()).catch(() => {}); },
      ...(consumers ? { consumerWake: consumers.wake, consumerRetry: consumers.retry, consumerFlush: consumers.flush } : {}) });
  } catch {
    await close();
    throw new PreviewConfigError('evaluator preview readiness or initialization refused');
  }
}
module.exports = { boot };
