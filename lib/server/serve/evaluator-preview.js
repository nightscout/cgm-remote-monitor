'use strict';

const scope = require('../../storage/tenant-scope');
const connect = require('../../storage/postgres-connection');
const replayFactory = require('../../storage/postgres-durable-replay');
const evaluator = require('../../data/tenant-projection-evaluator');
const startRuntime = require('./evaluator-runtime');
const { PreviewConfigError } = require('./preview-config');

async function boot (config, { operationWindow, intakeBinding } = {}) {
  if(!config.pgstream||!config.trustedWorker||!config.registry||config.changeFeed!==undefined||config.recoveryIntervalMs!==undefined||config.settingsRefreshMs!==undefined||config.namespaces.changeStamps!==undefined)throw new PreviewConfigError('maintained pgstream evaluator configuration required');
  if(config.partition?.partitioned)require('./evaluator-config').assertSupportedPartition(config.partition);
  if(config.intakeStateSync !== undefined && (config.partition?.ordinal !== 0 || typeof intakeBinding !== 'function')) throw new Error('INTAKE_BINDING_REQUIRED');
  if(!operationWindow)throw new Error('PGSTREAM_OPERATION_WINDOW_REQUIRED');
  const coldAdmission = require('../../storage/connection-admission').coldAdmission();
  // This private boot entry is invoked before listeners or callback-bearing
  // registry/readiness helpers. Capture authority-free scheduling contexts now.
  const contexts = require('./evaluator-job-context');
  const clinicalJobs = operationWindow ? contexts.create('clinical') : undefined;
  const deliveryJobs = operationWindow && config.consumers?.realtime ? contexts.create('delivery') : undefined;
  const clinicalCallback = fn => clinicalJobs ? clinicalJobs.bind(fn) : fn;
  let trusted, operational, connection, runtime, consumers, member, gate, closing, registrySet, settingsReader, startup, pgstream, workScheduler, metadataRecovery = false;
  let failRole;const failure=new Promise(resolve=>{failRole=resolve;});
  async function close () {
    if (closing) return closing;
    closing = (async () => {
      // Fence clinical output and delivery before awaiting discovery drains.
      // Each component still drains its entered work before resources close.
      const stopped = Promise.allSettled([consumers?.close(), runtime?.close()]);
      // Discovery failure must still drain component-owned work and contexts.
      const preliminary = [];
      try { await workScheduler?.close(); } catch(error) { preliminary.push(error); }
      try { await pgstream?.close(); } catch(error) { preliminary.push(error); }
      try { await registrySet?.close(); } catch (error) { preliminary.push(error); }
      try { await operational?.close(); } catch (error) { preliminary.push(error); }
      try { gate?.close(); } catch (error) { preliminary.push(error); }
      try { await startup?.close(); } catch (error) { preliminary.push(error); }
      const errors = preliminary;
      try {
        const results = await stopped;
        errors.push(...results.filter(value => value.status === 'rejected').map(value => value.reason));
      } finally {
        try { if (settingsReader) await settingsReader.close(); } catch (error) { errors.push(error); }
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
      const settingsConfiguration = structuredClone(config.tenantSettings);
      settingsReader = { read: tenant => trusted.read(tenant), close: () => trusted?.close(),
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
    // The qualified evaluator owns the global shard. Its standalone gate
    // retains existing inspection and tenant-admission semantics without a
    // partition lease; unsupported partition config was refused before boot.
    member = await require('../../pool-membership').member(config.partition || { kind: 'evaluator', partitioned: false });
    await member.register();
    gate = require('./evaluator-pool').create({ member, tenants: [...config.tenants.keys()] });
    gate.start(member.configured.leaseMs);
    await gate.refresh();
    if (gate.partitioned) console.log('Evaluator pool member', member.configured.ordinal, gate.reason() ? 'waiting: ' + gate.reason() : 'admitted');
    if(require('./pool-config').pool('evaluator').max<2)throw new Error('PGSTREAM_EVALUATOR_POOL_BOUND');
    if(gate.partitioned)throw new Error('PGSTREAM_EVALUATOR_PARTITION_UNQUALIFIED');
    scope.setTenancyMode('multi');
    connection = await connect({ connectionString: config.connectionString, ...require('./pool-config').pool('evaluator'),
      statement_timeout: 5000, application_name: 'nightscout-evaluator-preview' });
    {
      trusted = require('../../trusted-worker/postgres').create({ connection, namespaces: config.trustedWorker, eventDriven:true });
      operational = await require('../../trusted-worker/lifecycle')(trusted, {
        ...(operationWindow?.trustedWorker ? {
        verifyWorker: periodic => {
          const verify = () => { metadataRecovery = metadataRecovery || !trusted.state().available;
          return operationWindow.verifyOperational(async () => {
            await connect.readopt(operationWindow);
            await consumers?.verifyOperational?.();
            await trusted.verify();
          }); };
          return periodic && runtime ? runtime.verifyOperational(verify) : verify();
        }
      } : {}) });
      await trusted.scan([...config.tenants.keys()].filter(tenant => gate.admits(tenant)));
    }
    {
      pgstream=await require('../../pgstream/evaluator').open({config,connection, ...(config.intakeStateSync ? {intakeBinding} : {}),
        onInput:clinicalCallback(async(tenant,kind,pendingAt)=>{
          if(!config.tenants.has(tenant))return;
          runtime?.markPending(tenant,pendingAt);
          workScheduler?.wake(tenant,kind);
          if(kind!=='clock')consumers?.wake(tenant).catch(()=>{});
        }),
        onCommit:()=>{workScheduler?.wakeDelivery();},
        onUnavailable:async(code,details)=>{metadataRecovery=true;trusted.invalidate();if(details)console.error('Pgstream unavailable',JSON.stringify(details));},onTerminal:(code,details)=>{if(details)console.error('Pgstream terminal',JSON.stringify(details));failRole(Object.assign(new Error(code),{code}));},
        onSchema:async()=>{
          trusted.invalidate();await require('./evaluator-readiness')(config,{operationWindow});
          await operational.verify();await trusted.scan([...config.tenants.keys()],{recovery:true});
          if(runtime)for(const tenant of config.tenants.keys()){await runtime.invalidateTenant(tenant);workScheduler?.wake(tenant,'schema');}
          setImmediate(clinicalCallback(()=>workScheduler?.recover().catch(()=>{})));
        },
        onRecovered:async store=>{
          await operational.verify();
          const rows=await trusted.scan([...config.tenants.keys()],{recovery:true});
          await require('../../pgstream/bootstrap')(store,rows);
          metadataRecovery=false;
          if(runtime)for(const tenant of config.tenants.keys())workScheduler?.wake(tenant,'recovery');
          setImmediate(clinicalCallback(()=>workScheduler?.recover().catch(()=>{})));
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
      activity = require('../../tenant-activity/eligibility').create({ read: async tenant => { const row=trusted.current(tenant); if(!row)throw new Error('TRUSTED_ACTIVITY_NOT_CURRENT'); return row.activity; } });
    }
    const domains = Object.fromEntries(evaluator.domains.map(d => [d, config.namespaces[d] + '.' + d]));
    const bootVerification = operational?.version();
    runtime = await startRuntime({ ...config, recoveryIntervalMs:config.pgstream.bounds.recoveryMs, dynamic: true, externalRecovery: true, operationWindow,
      durable:{pendingMs:config.pgstream.bounds.pendingMs,begin:pgstream.store.begin,complete:async(tenant,value)=>{pgstream.assertAvailable();const current=await config.readCurrent(tenant);if(!current||current.identity!==value.identity)throw new Error('EVALUATOR_COMPLETION_CONFIG_CHANGED');pgstream.assertAvailable();return pgstream.store.complete(tenant,{...value,restoreGeneration:operationWindow.currentGeneration(tenant)});}}, jobContext: clinicalJobs, activity, tenants: [...config.tenants.keys()],
      readMetadata: trusted.scan, metadataCurrent: trusted.current, readSource: tenant => config.tenants.get(tenant)?.identity,
      boot: readiness, ...(readiness === 'serve' ? { bootConcurrency: startupConcurrency, isWarm: startup.isReady } : {}),
      checkConcurrency: require('./pool-config').pool('evaluator').max,
      onRevision: tenant => consumers?.revised(tenant), async create (current) {
      await startup.ensure(current.tenant);
      const replay = replayFactory({ connection, domains, checkpointTable: config.namespaces.checkpoint + '.tenant_consumer_checkpoint',
        clockTable: config.namespaces.clock + '.tenant_write_clock', consumer: config.consumer,
        projectionVersion: 'clinical-current-rows-v1', pageSize: config.pageSize, maxRows: config.maxRows });
      const language = require('../../language')();
      language.set(current.env.settings.language);
      return evaluator({ tenant: current.tenant, replay, connection, env: current.env, language,
        maxRows: config.maxRows, maxBytes: config.maxBytes, includeFrame:true,
        dbstats: () => require('../../storage/postgres-tenant-stats')({ connection, tables: domains }).read(current.tenant) });
    } });
    // Clinical pending work has its own recovery deadline. Start it before
    // preparing the independent delivery roster; consumers.start() below
    // sweeps durable current output, including revisions completed here.
    consumers = await require('./evaluator-consumers').prepare({ assertOperational:()=>{if(!trusted.state().available)throw new Error('TRUSTED_WORKER_UNAVAILABLE');pgstream.assertAvailable();}, config, clinicalConnection: connection, operationWindow, ...(coldAdmission ? {coldAdmission} : {}), jobContext: deliveryJobs, activity,
      current: tenant => runtime?.last(tenant), isCurrent: (tenant, identity) => runtime?.isCurrent(tenant, identity) || false });
    {
      operational.activateRefresh(clinicalCallback(async () => {
        pgstream.assertAvailable();
        if(metadataRecovery){
          const rows=await trusted.scan([...config.tenants.keys()],{recovery:true});
          await require('../../pgstream/bootstrap')(pgstream.store,rows);
          metadataRecovery=false;
          await workScheduler.recover();
        }
      }), 2147483647, bootVerification);
      const hint=require('../internal-api/clients').completedOutput(config.pgstream.outputPeer);
      workScheduler=require('../../pgstream/activity-scheduler').start({store:pgstream.store,
        bind:clinicalCallback,admits:tenant=>config.tenants.has(tenant),maxTenants:config.maxTenants,onPending:(tenant,at)=>runtime.markPending(tenant,at),concurrency:require('./pool-config').pool('evaluator').max-1,
        scan:tenants=>trusted.scan(tenants),
        run:async(tenant,kind)=>{if(!config.tenants.has(tenant))return;pgstream.assertAvailable();await runtime[kind==='due'?'tick':'acquire'](tenant);const state=runtime.health([tenant]).tenants[0];if(!state.ready&&!['paused','suspended'].includes(state.activity)&&kind!=='lifecycle')throw new Error(state.code||'EVALUATOR_ACTIVITY_RETRY');},
        send:value=>hint.hintCompletedOutput(value)});
      workScheduler.recover().catch(()=>{});
      workScheduler.wakeDelivery();
    }
    if (consumers) {
      consumers.start();
    }
    if (registrySet) await registrySet.follow({
      prepare: async (tenant, entry) => {
        const cleanup = async () => { workScheduler?.removeTenant(tenant); await runtime.removeTenant(tenant); trusted?.remove(tenant); await consumers?.removeTenant(tenant); gate.removeTenant(tenant); await startup.removeTenant(tenant); };
        try {
          await pgstream.store.admit([tenant]);const rows=await trusted.scan([tenant]);await require('../../pgstream/bootstrap')(pgstream.store,rows);
          if (activity && !(await activity.check('evaluator',tenant)).eligible) throw Object.assign(new Error('TENANT_ACTIVITY_DEFERRED'),{code:'TENANT_ACTIVITY_DEFERRED'});
          await require('./evaluator-config').withSettings(config, entry, tenant, settingsReader);
          startup.addTenant(tenant);
          // An unowned pool slice has no data warm/evaluation on this member.
          if (gate.admits(tenant)) {
            if (!await require('./tenant-startup').attempt(operationWindow,tenant,()=>startup.ensure(tenant))) throw new Error('Tenant operation deferred');
            if (consumers && !await consumers.prepareTenant(tenant)) throw new Error('Tenant consumer deferred');
          }
          gate.addTenant(tenant);consumers?.addTenant(tenant);runtime.addTenant(tenant);
          return cleanup;
        } catch(error) { await cleanup();throw error; }
      },
      activate: clinicalCallback(tenant => { workScheduler.wake(tenant,'registry'); if(consumers)consumers.wake(tenant).catch(()=>{}); }),
      remove: async tenant => { workScheduler?.removeTenant(tenant); await runtime.removeTenant(tenant); trusted?.remove(tenant); await consumers?.removeTenant(tenant); gate.removeTenant(tenant);await startup.removeTenant(tenant); }
    });
    console.log('Evaluator preview started; configured tenants:', config.tenants.size, 'pool:', member.configured.mode, 'operation:', operationWindow?.trustedWorker ? 'trusted-worker' : 'scoped', ...(registrySet ? ['registry revision:', registrySet.revision()] : []));
    // The private operational read (contract evaluator-inspection).
    const inspect = require('./evaluator-inspection')({ tenants: config.tenants, gate, runtime, consumers, startup, registry: registrySet });
    const modules = { ...(config.inspection ? {'evaluator-inspection':Object.freeze({
      create: () => ({inspectEvaluator:async (context, body) => inspect(body)})})} : {}),
      ...(config.intakeStateSync ? {'intake-state':Object.freeze({create:()=>({inspectIntake:async (context, body)=>pgstream.inspectIntake(body)})})} : {}) };
    const internal = Object.keys(modules).length ? Object.freeze(modules) : undefined;
    const trigger = method => async tenant => {
      await runtime[method](tenant);
      if (consumers) consumers.wake(tenant).catch(() => {}); // clinical result never awaits delivery
    };
    // Explicit useful activity enters the same bounded clinical scheduler.
    async function wake (tenant, hint) {
      await runtime.wake(tenant,hint);
      if (consumers) consumers.wake(tenant).catch(() => {});
    }
    return Object.freeze({ acquire: trigger('acquire'), tick: trigger('tick'), wake,
      health: () => ({ ...runtime.health(), ...(trusted ? { trustedWorker: trusted.health() } : {}),  pgstream:pgstream.health(),pgstreamWork:workScheduler.stats(), startup: startup.health(),
        ...(registrySet ? { registry: registrySet.stats() } : {}),
        ...(consumers ? { consumers: consumers.health() } : {}) }),
      failure,last: runtime.last, isCurrent: runtime.isCurrent, close, inspect, ...(internal ? { internal } : {}),
      async invalidateTenant (tenant) {
        trusted?.remove(tenant); startup.invalidateTenant(tenant);
        await consumers?.invalidateTenant(tenant); await runtime.invalidateTenant(tenant);
        // Restore/invalidation is useful control work. Rehydrate current
        // metadata once so an unchanged durable pause remains recognizable.
        await trusted.scan([tenant], { recovery: true });
      },
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
