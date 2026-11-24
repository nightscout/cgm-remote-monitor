'use strict';

const roleReadiness = require('./role-readiness');
const diagnostics = require('./startup-diagnostic');

const scope = require('../../storage/tenant-scope');
const connect = require('../../storage/postgres-connection');
const replayFactory = require('../../storage/postgres-durable-replay');
const evaluator = require('../../data/tenant-projection-evaluator');
const startRuntime = require('./evaluator-runtime');
const { PreviewConfigError } = require('./preview-config');

async function boot (config, options = {}) {
  const { operationWindow }=options;
  // Writer-driven input (lib/writer-driven), the only input transport: pending
  // marks, the sweep and the private `changed` hint bring the work.
  if(!config.writerDriven||!config.pgstream||!config.trustedWorker||!config.registry||config.changeFeed!==undefined||config.recoveryIntervalMs!==undefined||config.settingsRefreshMs!==undefined||config.namespaces.changeStamps!==undefined)throw new PreviewConfigError('maintained pgstream evaluator configuration required');
  if(!operationWindow)throw new Error('PGSTREAM_OPERATION_WINDOW_REQUIRED');
  if(config.processAssignment&&options.assignedTenants!==undefined)throw new Error('EVALUATOR_PROCESS_ASSIGNMENT_EXCLUSIVE');
  let assignment=config.processAssignment?{slice:{count:config.processAssignment.count,ordinal:config.processAssignment.ordinal},roster:()=>config.tenants.keys(),currentGeneration:tenant=>operationWindow.currentGeneration(tenant)}:
    options.assignedTenants===undefined?undefined:{tenants:options.assignedTenants,currentGeneration:tenant=>operationWindow.currentGeneration(tenant)};
  const assigned=assignment&&require('../../pgstream/assigned-worker').configure(assignment,{namespace:config.namespaces.checkpoint,consumer:config.consumer});
  // This private boot entry is invoked before listeners or callback-bearing
  // registry/readiness helpers. Capture authority-free scheduling contexts now.
  const contexts = require('./evaluator-job-context');
  const clinicalJobs = operationWindow ? contexts.create('clinical') : undefined;
  const deliveryJobs = operationWindow && config.consumers?.realtime ? contexts.create('delivery') : undefined;
  const clinicalCallback = fn => clinicalJobs ? clinicalJobs.bind(fn) : fn;
  let trusted, operational, connection, runtime, consumers, gate, closing, registrySet, settingsReader, startup, pgstream, workScheduler, outputWake, outputHint;
  // Explicit fixed-roster fixtures retain their existing admission contract.
  const demand = options.assignedTenants === undefined;
  const notificationRecovery = demand && !!config.consumers?.realtime;
  const preparing = new Map();
  const owns = config.processAssignment
    ? require('../../pool-membership/slice').predicate(config.processAssignment.count, config.processAssignment.ordinal)
    : () => true;

  async function admitDemand (tenant) {
    if (!owns(tenant)) return false;
    if (!runtime || !workScheduler || closing) throw new Error('EVALUATOR_NOT_READY');
    const entry = await registrySet.lookup(tenant);
    if (!entry) return false;
    if (config.tenants.get(tenant) === entry) return true;
    if (preparing.has(tenant)) return preparing.get(tenant);
    const job = (async () => {
      await pgstream.store.admit([tenant]);
      if (!trusted.state().available) await operational.verify();
      const rows = await trusted.scan([tenant]);
      await require('../../pgstream/bootstrap')(pgstream.store, rows);
      if (closing || registrySet.tenants.get(tenant) !== entry) throw new Error('TENANT_REGISTRY_ADMISSION_STALE');
      startup.addTenant(tenant);
      gate.addTenant(tenant);
      runtime.addTenant(tenant);
      consumers?.addTenant(tenant);
      config.tenants.set(tenant, entry);
      // Raw delivery accepted before admission was not hinted (outputWake
      // admits only admitted tenants); hint once now.
      outputWake?.wake(tenant);
      return true;
    })();
    preparing.set(tenant, job);
    try { return await job; } finally { preparing.delete(tenant); }
  }
  let startupPhase = 'OPERATION_READINESS';
  let failRole;const failure=new Promise(resolve=>{failRole=resolve;});
  async function close () {
    if (closing) return closing;
    closing = (async () => {
      // Fence clinical output and delivery before awaiting discovery drains.
      // Each component still drains its entered work before resources close.
      const stopped = Promise.allSettled([consumers?.close(), runtime?.close()]);
      // Discovery failure must still drain component-owned work and contexts.
      const preliminary = [];
      await Promise.allSettled(preparing.values());
      try { await workScheduler?.close(); } catch(error) { preliminary.push(error); }
      try { await outputWake?.close(); } catch(error) { preliminary.push(error); }
      try { config.pgstream.outputPeers?.close?.(); outputHint?.close?.(); } catch (error) { preliminary.push(error); }
      try { await pgstream?.close(); } catch(error) { preliminary.push(error); }
      try { await registrySet?.close(); } catch (error) { preliminary.push(error); }
      try { await operational?.close(); } catch (error) { preliminary.push(error); }
      try { gate?.close(); } catch (error) { preliminary.push(error); }
      try { await startup?.close(); } catch (error) { preliminary.push(error); }
      const errors = preliminary;
      try {
        const results = await stopped;
        errors.push(...results.filter(value => value.status === 'rejected').map(value => value.reason));
        try { config.consumers?.realtime?.slicePeers?.close?.(); } catch (error) { errors.push(error); }
      } finally {
        try { if (settingsReader) await settingsReader.close(); } catch (error) { errors.push(error); }
        if (registrySet) await registrySet.close().catch(() => {});
        try { if (connection) await connection.end(); } finally { clinicalJobs?.close(); deliveryJobs?.close(); }
      }
      if (errors.length) throw new globalThis.AggregateError(errors, 'Evaluator preview shutdown refused');
    })();
    return closing;
  }
  try {
    // The role's own start check (decision platform-verification-removal);
    // schema change after the baseline stops the role (decision
    // stable-evaluator-runtime).
    // The ledgers this role reads, the lifecycle catalogue included, must be
    // exactly the reviewed catalogues; one typed refusal.
    await require('../../writer-driven/schema').check([...roleReadiness.ledgers(config, 'evaluator'),
      { connectionString: config.connectionString, namespace: config.writerDriven.lifecycleNamespace,
        catalogue: require('../../tenant-lifecycle/generation-scope').catalogue(operationWindow) }]);
    await roleReadiness.admit(config, 'evaluator');
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
      startupPhase = 'REGISTRY_DISCOVERY';
      const settingsOf = require('./evaluator-config');
      const registry = require('./registry-tenant-set');
      registrySet = await (demand ? registry.openDemand : registry.open)({ settings: config.registry, connectionString: config.connectionString,
        maxTenants: config.maxTenants, build: settingsOf.registryEntry, ...(config.processAssignment?{accept:require('../../pool-membership/slice').predicate(config.processAssignment.count,config.processAssignment.ordinal),selectionKey:()=>assigned.identity}:{}), applicationName: 'nightscout-evaluator-registry' });
      // Registry runtimes may start empty and admit tenants after provisioning.
      const base = config;
      async function refreshEntry (tenant, entry) {
        // A registry revision can stale a cached admission while this tenant is
        // evaluating. Refresh only this already admitted tenant. An entry
        // removed or replaced during the read cannot authorize the old result.
        if (!demand || !entry || config.tenants.get(tenant) !== entry) return false;
        await registrySet.lookup(tenant);
        return registrySet.isActive(tenant) && registrySet.tenants.get(tenant) === entry;
      }
      config = { ...base, tenants: demand ? new Map() : registrySet.tenants,
        async readCurrent (tenant) {
          const entry = registrySet.tenants.get(tenant);
          if (!registrySet.isActive(tenant) && !await refreshEntry(tenant, entry)) return null;
          const current = await settingsOf.withSettings(base, entry, tenant, settingsReader);
          if (!registrySet.isActive(tenant) && !await refreshEntry(tenant, entry)) return null;
          return registrySet.tenants.get(tenant) === entry ? current : null;
        } };
    }
    if(assigned&&!assigned.static){
      if(assigned.tenants.some(tenant=>!config.tenants.has(tenant)))throw new Error('EVALUATOR_ASSIGNMENT_NOT_PROVISIONED');
      const all=config,tenants=new Map(assigned.tenants.map(tenant=>[tenant,all.tenants.get(tenant)]));
      config={...all,tenants,readCurrent:tenant=>tenants.has(tenant)?all.readCurrent(tenant):null};
    }
    startupPhase = 'OPERATION_READINESS';
    // One topology (decision legacy-topology-retirement): a configured hash
    // assignment, or one process owning every tenant. No membership row,
    // lease or heartbeat is read or written.
    gate=require('../../pgstream/static-gate').create({shape:config.processAssignment?{count:config.processAssignment.count,ordinal:config.processAssignment.ordinal}:{count:1,ordinal:0},
      tenants:[...config.tenants.keys()],available:()=>pgstream?.store.available===true});
    if(require('./pool-config').pool('evaluator').max<2)throw new Error('PGSTREAM_EVALUATOR_POOL_BOUND');
    scope.setTenancyMode('multi');
    startupPhase = 'TRUSTED_METADATA';
    connection = await connect({ connectionString: config.connectionString, ...require('./pool-config').pool('evaluator'),
      readStatementPool: require('./pool-config').pool('read'),
      statement_timeout: 5000, application_name: 'nightscout-evaluator-preview' });
    {
      trusted = require('../../trusted-worker/postgres').create({ connection, namespaces: config.trustedWorker, stream:true });
      operational = await require('../../trusted-worker/lifecycle')(trusted);
      // The source open below owns the first metadata snapshot.
    }
    const domains = Object.fromEntries(evaluator.domains.map(d => [d, config.namespaces[d] + '.' + d]));
    const replay = replayFactory({ connection, domains, checkpointTable: config.namespaces.checkpoint + '.tenant_consumer_checkpoint',
      clockTable: config.namespaces.clock + '.tenant_write_clock', consumer: config.consumer,
      projectionVersion: 'clinical-current-rows-v1', pageSize: config.pageSize, maxRows: config.maxRows,
      level: { lifecycleTable: config.writerDriven.lifecycleNamespace + '.tenant_lifecycle_windows',
        // Resident window switch (NS_EVALUATOR_RESIDENT_WINDOW): the completed-work
        // row that carries the writers' window marks.
        ...(require('../../writer-driven/window-mark').enabled() ? { work: { table: config.namespaces.checkpoint + '.tenant_consumer_checkpoint', consumer: config.consumer + '-completed' } } : {}) } });
    // A committed delivery revision is realtime's obligation. The evaluator
    // sends only a coalesced best-effort wake; realtime reconciliation
    // recovers a wake lost here, before startup or across a restart.
    const outputPeers = config.pgstream.outputPeers;
    outputWake=require('../../pgstream/output-wake').create({send:body=>outputPeers ? outputPeers.hint(body) :
      (outputHint=outputHint||require('../internal-api/clients').completedOutput(config.pgstream.outputPeer)).hintCompletedOutput(body),
      bind:clinicalCallback,admits:tenant=>config.tenants.has(tenant),maxTenants:config.maxTenants});
    const onCommit=({tenant,notification})=>{outputWake.wake(tenant);if(config.tenants.has(tenant)&&notification!==false)consumers?.hint(tenant).catch(()=>{});};
    const onRecovered=async store=>{
      // The platform proof was checked at start; only the trusted reader
      // is re-armed after the source recorded its baseline.
      await operational.verify();
      if (!demand) {
        const tenants = [...config.tenants.keys()];
        for (let offset = 0; offset < tenants.length; offset += 64) {
          const rows = await trusted.scan(tenants.slice(offset, offset + 64), {recovery:true});
          await require('../../pgstream/bootstrap')(store, rows);
        }
      }
      // The source becomes available after this callback resolves. Reconcile
      // notification work on the existing next-turn recovery boundary.
      setImmediate(clinicalCallback(()=>Promise.all([workScheduler?.recover(),consumers?.recover?.()]).catch(()=>{})));
    };
    startupPhase = 'WRITER_SOURCE_OPEN';
    pgstream = await require('../../writer-driven/evaluator').open({ config, connection, assignment, notificationRecovery, onCommit, onRecovered,
      onTerminal: code => failRole(Object.assign(new Error(code), { code })) });
    await pgstream.ready();
    // A serving evaluator warms a tenant only when work arrives.
    startupPhase = 'CLINICAL_READINESS';
    const readiness = 'serve';
    const startupConcurrency = require('./pool-config').startupConcurrency();
    startup = require('./tenant-startup').create(config.tenants.keys(), operationWindow, tenant =>
      require('./evaluator-readiness').provisionTenant(connection, config, tenant), { readiness, warmOnStart: false, concurrency: startupConcurrency, dynamic: !!config.registry, maxTenants: config.maxTenants });
    await startup.warm();
    let activity;
    if (config.activity) {
      // Read-only identity; boot refuses one that could write activity state.
      activity = require('../../tenant-activity/eligibility').create({ read: async tenant => { const row=trusted.current(tenant); if(!row)throw new Error('TRUSTED_ACTIVITY_NOT_CURRENT'); return row.activity; } });
    }
    startupPhase = 'CLINICAL_RUNTIME';
    runtime = await startRuntime({ ...config,
      readinessObservation:config.inspection === true,
      completionDelayMs: require('../../diagnostics/completion-delay').fromEnvironment(),
      loadOutput: (tenant, identity) => pgstream.store.output(tenant, identity), recoveryIntervalMs:config.pgstream.bounds.recoveryMs, dynamic: true, externalRecovery: true, operationWindow,
      // Independent predicates for the worker recheck; available stays their conjunction.
      workerState: () => { const state = trusted.state(); return { ...state, readerAvailable: state.available, platformReady: true, available: state.available }; },
      durable:{pendingMs:config.pgstream.bounds.pendingMs,begin:tenant=>pgstream.store.begin(tenant),complete:async(tenant,value)=>{pgstream.assertAvailable();await trusted.scan([tenant]);const row=trusted.current(tenant);if(!row||row.activity.paused||row.activity.suspended)throw new Error('EVALUATOR_COMPLETION_ACTIVITY_CHANGED');const current=await config.readCurrent(tenant);if(!current||current.identity!==value.identity)throw new Error('EVALUATOR_COMPLETION_CONFIG_CHANGED');pgstream.assertAvailable();const completed=await pgstream.store.complete(tenant,{...value,restoreGeneration:operationWindow.currentGeneration(tenant)});if(Number.isSafeInteger(completed.pendingAt))workScheduler?.wake(tenant,'recovery');return completed;}}, jobContext: clinicalJobs, activity, tenants: [...config.tenants.keys()],
      readMetadata: trusted.scan, metadataCurrent: trusted.current, readSource: tenant => registrySet.isActive(tenant) ? config.tenants.get(tenant)?.identity : undefined,
      boot: readiness, bootConcurrency: startupConcurrency, isWarm: startup.isReady,
      checkConcurrency: require('./pool-config').pool('evaluator').max,
      onRevision: tenant => consumers?.revised(tenant), async create (current) {
      await startup.ensure(current.tenant);
      const language = require('../../language')();
      language.set(current.env.settings.language);
      return evaluator({ tenant: current.tenant, replay, connection, env: current.env, language,
        maxRows: config.maxRows, maxBytes: config.maxBytes, includeFrame:true,
        dbstats: () => require('../../storage/postgres-tenant-stats')({ connection, tables: domains }).read(current.tenant) });
    } });
    // Metrics (NS_METRICS): the slice is the configured assignment, read here, never derived.
    require('../../metrics').current.setSlice(config.processAssignment ? config.processAssignment.ordinal : null);
    require('../../metrics').current.evaluator(() => runtime.pendingSummary());
    // Clinical pending work has its own recovery deadline. Delivery recovers
    // its independent durable marker, including output committed during boot.
    {
      workScheduler=require('../../pgstream/activity-scheduler').start({store:pgstream.store,
        bind:clinicalCallback,admits:demand ? owns : tenant=>config.tenants.has(tenant), admitRecovered:demand ? admitDemand : undefined,onPending:(tenant,at)=>runtime.markPending(tenant,at),concurrency:require('./pool-config').pool('evaluator').max-1,
        // The periodic sweep over pending rows is the guarantee.
        sweepMs: config.writerDriven.sweepMs,
        // A real query refusal withdraws the reader. Retry admission only when
        // addressed work arrives, before entering a tenant operation window.
        scan:async tenants=>{if(!trusted.state().available)await operational.verify();return trusted.scan(tenants);},
        async run(tenant, kind) {
          if (demand && !registrySet.isActive(tenant) && !await admitDemand(tenant)) return;
          if (!config.tenants.has(tenant)) return;
          pgstream.assertAvailable();
          await runtime[kind === 'due' ? 'tick' : 'acquire'](tenant);
          const state = runtime.health([tenant]).tenants[0];
          if (!state.ready && !['paused','suspended'].includes(state.activity) && kind !== 'lifecycle') {
            throw new Error(state.code || 'EVALUATOR_ACTIVITY_RETRY');
          }
        }});
      workScheduler.recover().catch(()=>{});
      // Startup sweep: every tenant marked pending while no evaluator ran.
      workScheduler.sweep().catch(()=>{});
    }
    async function notificationOutput (tenant) {
      const local = await runtime.output(tenant);
      if (local || !notificationRecovery || !runtime.canReadColdOutput(tenant)) return local;
      // A cold notification job reads the durable model inside its own
      // generation window. It does not run the clinical executor or revive
      // a model already known by this process to be ineligible.
      const generation = operationWindow.currentGeneration(tenant);
      const current = await config.readCurrent(tenant);
      if (!current || generation === undefined || generation === null) return null;
      const output = await pgstream.store.output(tenant, current.identity, {
        notification: { generation, pendingMs: config.pgstream.bounds.pendingMs }
      });
      return output && { ...output, runtimeId: runtime.runtimeId, eligible: true };
    }
    startupPhase = 'DELIVERY_STARTUP';
    {
      consumers = await require('./evaluator-consumers').prepare({ assertOperational:()=>{if(!trusted.state().available)throw Object.assign(new Error('TRUSTED_WORKER_UNAVAILABLE'),{code:'TRUSTED_WORKER_UNAVAILABLE'});pgstream.assertAvailable();}, config, clinicalConnection: connection, operationWindow,  jobContext: deliveryJobs, activity,
      ...(notificationRecovery ? { notificationRecovery: {
        admit: admitDemand, pending: pgstream.store.notificationPending,
        acknowledge: (tenant, output) => {
          if (String(operationWindow.currentGeneration(tenant)) !== String(output.restoreGeneration)) return;
          return pgstream.store.acknowledgeNotification(tenant, output);
        }
      } } : {}),
      current: notificationOutput, peek: tenant => runtime?.peek(tenant),
      version: require('./notification-version')({ peek: tenant => runtime?.peek(tenant), output: notificationOutput }), isCurrent: (tenant, identity) => runtime?.isCurrent(tenant, identity) || false });
    }
    if (consumers) {
      consumers.start();
    }
    startupPhase = 'REGISTRY_FOLLOW';
    if (demand) registrySet.onRemove(async tenant => {
      config.tenants.delete(tenant);
      replay.forgetTenant(tenant);
      await Promise.allSettled([preparing.get(tenant)]);
      workScheduler.removeTenant(tenant);
      await consumers?.removeTenant(tenant);
      await runtime.removeTenant(tenant);
      trusted.remove(tenant);
      gate.removeTenant(tenant);
      await startup.removeTenant(tenant);
    });
    else if (registrySet && (!assigned||assigned.static)) await registrySet.follow({
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
    console.log('Evaluator preview started; configured tenants:', config.tenants.size, 'assignment:', config.processAssignment ? config.processAssignment.ordinal + '/' + config.processAssignment.count : 'all', 'operation:', operationWindow?.trustedWorker ? 'trusted-worker' : 'scoped', ...(registrySet ? ['registry revision:', registrySet.revision()] : []));
    // The private operational read (contract evaluator-inspection).
    const inspect = require('./evaluator-inspection')({ tenants: config.tenants, gate, runtime, consumers, startup, registry: registrySet, sourceAccess:replay.sourceAccess, witness: tenants => pgstream.store.witness(tenants) });
    const readinessWitness = config.inspection ? require('./evaluator-readiness-witness').create({
      runtimeId:runtime.runtimeId,hasTenant:tenant=>config.tenants.has(tenant),runtimeFacts:selected=>runtime.readinessFacts(selected),
      workerFacts:()=>trusted?.state(),windowFacts:()=>operationWindow?.readinessFacts(),
      platformFacts:()=>({ready:true,code:null}),
      sourceFacts:()=>{const view=pgstream.health();return {healthy:view.healthy,schemaBlocked:view.schemaBlocked,
        schemaInFlight:view.receiver.schemaInFlight,ownerAvailable:view.owner,acceptedCutReady:pgstream.canResumeVerification()};},
      metadataFacts:tenant=>{const row=trusted?.current(tenant);return {registryActive:registrySet?.isActive(tenant),assigned:gate.admits(tenant),
        sourceIdentity:config.tenants.get(tenant)?.identity,settingsVersion:row?.settings,policyGeneration:row?.policy,
        paused:row?.activity?.paused,suspended:row?.activity?.suspended};}
    }) : null;
    const modules = { ...(config.inspection ? {'evaluator-inspection':Object.freeze({
      create: () => ({inspectEvaluator:async (context, body) => inspect(body)})}),
      'evaluator-readiness-witness':Object.freeze({create:()=>({inspectReadinessWitness:(_context,body)=>readinessWitness(body)})})} : {}) };
    // The private `changed` hint (lib/internal-hints, served by
    // serve/internal-listener): a wake for one owned tenant, never data. A
    // tenant this process has not admitted is admitted by the scheduler's run.
    modules.changed = Object.freeze({
      owns: tenant => owns(tenant),
      ready: () => !closing && !!workScheduler && !!runtime,
      receive: clinicalCallback((tenant, fields) => {
        if (closing || !workScheduler) throw new Error('EVALUATOR_NOT_READY');
        if (!config.tenants.has(tenant)) { if (demand) workScheduler.wake(tenant, 'clock'); return; }
        runtime.markPending(tenant, Date.now());
        workScheduler.wake(tenant, 'clock');
        if (!fields?.domains || fields.domains.some(domain => !evaluator.domains.includes(domain))) consumers?.hint(tenant).catch(() => {});
      })
    });
    const internal = Object.freeze(modules);
    const trigger = method => async tenant => {
      if (demand && !await admitDemand(tenant)) throw new Error('Evaluator tenant is not configured');
      await runtime[method](tenant);
      if (consumers) consumers.wake(tenant).catch(() => {}); // clinical result never awaits delivery
    };
    // Explicit useful activity enters the same bounded clinical scheduler.
    async function wake (tenant, hint) {
      if (demand && !await admitDemand(tenant)) throw new Error('Evaluator tenant is not configured');
      await runtime.wake(tenant,hint);
      if (consumers) consumers.wake(tenant).catch(() => {});
    }
    return Object.freeze({ acquire: trigger('acquire'), tick: trigger('tick'), wake,
      ready: () => !closing && !registrySet.stats().failure && pgstream.health().healthy && trusted.state().available,
      health: () => ({ ...runtime.health(), ...(trusted ? { trustedWorker: trusted.health() } : {}),  pgstream:pgstream.health(),assignment:pgstream.store.assignment,pgstreamWork:workScheduler.stats(),sweep:workScheduler.sweepStats(),outputWake:outputWake.stats(), startup: startup.health(),
        ...(registrySet ? { registry: registrySet.stats() } : {}),
        ...(consumers ? { consumers: consumers.health() } : {}) }),
      failure,last: runtime.last, isCurrent: runtime.isCurrent, close, inspect, ...(readinessWitness?{readinessWitness}:{}), internal,
      async invalidateTenant (tenant) {
        if (demand && !config.tenants.has(tenant)) return;
        replay.forgetTenant(tenant);
        trusted?.remove(tenant); startup.invalidateTenant(tenant);
        await consumers?.invalidateTenant(tenant); await runtime.invalidateTenant(tenant, { restoring: true });
        // Restore/invalidation is useful control work. Rehydrate current
        // metadata once so an unchanged durable pause remains recognizable.
        await trusted.scan([tenant], { recovery: true });
      },
      // Decision datastore-loss-recover-in-place: after the datastore's postmaster
      // changed, every configured tenant is invalidated as a restore would, at once.
      async invalidateAll () {
        trusted?.invalidate('restore');
        const results = await Promise.allSettled(runtime.health().tenants.map(async row => {
          replay.forgetTenant(row.tenant);
          if (startup.tenants().includes(row.tenant)) startup.invalidateTenant(row.tenant, { warm: false });
          await consumers?.invalidateTenant(row.tenant); await runtime.invalidateTenant(row.tenant);
        }));
        if (results.some(result => result.status === 'rejected')) throw new Error('Evaluator tenant invalidation refused');
      },
      // The datastore is re-admitted: warm as at boot.
      resume () { Promise.resolve().then(() => operational?.verify()).then(() => startup.warm()).catch(() => {}); },
      ...(consumers ? Object.fromEntries([['consumerWake','wake'],['consumerRetry','retry'],['consumerFlush','flush']].map(([name, method]) => [
        name, async tenant => {
          if (demand && !await admitDemand(tenant)) throw new Error('Evaluator tenant is not configured');
          return consumers[method](tenant);
        }
      ])) : {}) });
  } catch (error) {
    // Fixed vocabulary only, captured before cleanup can fail or lose context.
    try { console.error('Evaluator startup refused', JSON.stringify(diagnostics.classify(error, 'evaluator', startupPhase))); } catch { /* observation cannot replace refusal */ }
    let cleanupCause;
    try { await close(); } catch (failure) { cleanupCause = failure; }
    // Fixed source-admission codes only. Never print a driver/provider message,
    // arbitrary code or nested cause through the operator-facing CLI message.
    const schemaRefused = require('../../writer-driven/schema').CODE;
    const startupCause = [schemaRefused, ...roleReadiness.TERMINAL].includes(error?.code) ? error.code : null;
    const refusal = new PreviewConfigError('evaluator preview readiness or initialization refused' + (startupCause ? ' (' + startupCause + ')' : ''), {cause:error});
    if (cleanupCause !== undefined) Object.defineProperty(refusal, 'cleanupCause', {value:cleanupCause});
    if (roleReadiness.TERMINAL.includes(startupCause) || startupCause === schemaRefused) refusal.code = startupCause;
    throw refusal;
  }
}
module.exports = { boot };
