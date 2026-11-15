'use strict';

const scope = require('../../storage/tenant-scope');
const connect = require('../../storage/postgres-connection');
const replayFactory = require('../../storage/postgres-durable-replay');
const evaluator = require('../../data/tenant-projection-evaluator');
const startRuntime = require('./evaluator-runtime');
const { PreviewConfigError } = require('./preview-config');

function selection(config,{operationWindow,intakeBinding,partitionParticipants,partitionParticipant}){
 const raw=config.selectedIntake;if(!raw||!config.partition?.partitioned||![0,1].includes(config.partition.ordinal))throw new Error('PGSTREAM_SELECTED_RUNTIME_REQUIRED');
 const profile=require('../../pgstream/intake-profile').validate(raw.profile),p=profile.binding,ordinal=config.partition.ordinal;
 if(!require('../../tenant-lifecycle/operation-window').isWindow(operationWindow)||operationWindow.intakeProfileDigest!==profile.digest||operationWindow.namespace!==p.lifecycleNamespace||p.namespace!==config.namespaces.checkpoint||p.consumer!==config.consumer||p.members!==2||p.membershipNamespace!==config.partition.namespace||config.intakeStateSync?.assignmentRevision!==p.revision||!config.consumers?.realtime?.partitionMetadata)throw new Error('PGSTREAM_SELECTED_RUNTIME_BINDING');
 const manifest=require('./operation-cohort-manifest');
 if(!Array.isArray(partitionParticipants)||partitionParticipants.some(peer=>!manifest.isParticipant(peer))||!manifest.isParticipant(partitionParticipant)||!Array.isArray(raw.workers)||raw.workers.length!==2||new Set(raw.workers).size!==2)throw new Error('PGSTREAM_SELECTED_PARTICIPANTS');
 const peers=raw.workers.map(id=>{const rows=partitionParticipants.filter(peer=>peer.id===id&&peer.roles.includes('evaluator'));if(rows.length!==1)throw new Error('PGSTREAM_SELECTED_PARTICIPANTS');return rows[0];});
 if(ordinal===0){const endpoint=require('./evaluator-consumer-config').endpoint;if(decodeURIComponent(new URL(raw.controlConnectionString).username)===config.pgstream.streamRole||[raw.connectionString,raw.controlConnectionString].some(uri=>typeof uri!=='string'||endpoint(uri)!==endpoint(config.connectionString))||decodeURIComponent(new URL(raw.connectionString).username)!==p.role||new Set([config.connectionString,raw.connectionString,raw.controlConnectionString].map(uri=>decodeURIComponent(new URL(uri).username))).size!==3)throw new Error('PGSTREAM_SELECTED_PRINCIPAL_BINDING');}
 if(peers[ordinal]!==partitionParticipant||ordinal===0&&typeof intakeBinding!=='function'||ordinal===1&&(raw.connectionString!==undefined||raw.controlConnectionString!==undefined))throw new Error('PGSTREAM_SELECTED_PARTICIPANTS');
 return Object.freeze({profile,peers:Object.freeze(peers)});
}

async function boot (config, { operationWindow, intakeBinding, partitionParticipants, partitionParticipant } = {}) {
  const selected=selection(config,{operationWindow,intakeBinding,partitionParticipants,partitionParticipant}),profile=selected.profile,ordinal=config.partition.ordinal;
  const allTenants=profile.binding.tenants,ownTenants=allTenants.filter(tenant=>profile.assignment.owner(tenant)===ordinal);
  const assertRoster=()=>{if(JSON.stringify([...config.tenants.keys()].sort())!==JSON.stringify(allTenants)||registrySet&&([...registrySet.activeIds()].sort().join(',')!==allTenants.join(',')||registrySet.waiting()!==0)){failRole(new Error('PGSTREAM_FIXED_REGISTRY_CHANGED'));throw new Error('PGSTREAM_FIXED_REGISTRY_CHANGED');}};
  let workerStore,intakeConnection,controlConnection,intakeHealth,healthTimer,healthRunning,stopping=false;
  if(!config.pgstream||!config.trustedWorker||!config.registry||config.changeFeed!==undefined||config.recoveryIntervalMs!==undefined||config.settingsRefreshMs!==undefined||config.namespaces.changeStamps!==undefined)throw new PreviewConfigError('maintained pgstream evaluator configuration required');


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
    stopping = true;
    closing = (async () => {
      if(healthTimer)clearInterval(healthTimer);
      // Fence clinical output and delivery before awaiting discovery drains.
      // Each component still drains its entered work before resources close.
      const stopped = Promise.allSettled([consumers?.close(), runtime?.close()]);
      // Discovery failure must still drain component-owned work and contexts.
      const preliminary = [];
      try { await workScheduler?.close(); } catch(error) { preliminary.push(error); }
      // A failed health drain must not strand the held worker-owner backend:
      // connection.end() waits for that owner to release its checked-out client.
      for (const drain of [() => intakeHealth?.close(), () => healthRunning,
        () => pgstream?.close(), () => workerStore?.close()]) {
        try { await drain(); } catch (error) { preliminary.push(error); }
      }
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
        try { await intakeConnection?.end();await controlConnection?.end();if (connection) await connection.end(); } finally { clinicalJobs?.close(); deliveryJobs?.close(); }
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
    await require('./evaluator-readiness')(config, { operationWindow, intakeProfile:profile,ordinal });
    // The SQL-backed member registers the fixed count before its first slice.
    // Desired revision/count changes refuse this selected runtime; no resize.
    assertRoster();
    member = await require('../../pool-membership').member(config.partition,{fixedProtocol:true,intakeProfile:profile,operationWindow});
    await member.register();
    gate = require('./evaluator-pool').create({ member, tenants: [...config.tenants.keys()] });
    gate.start(member.configured.leaseMs);
    await gate.refresh();
    if (gate.partitioned) console.log('Evaluator pool member', member.configured.ordinal, gate.reason() ? 'waiting: ' + gate.reason() : 'admitted');
    if(require('./pool-config').pool('evaluator').max<2)throw new Error('PGSTREAM_EVALUATOR_POOL_BOUND');

    scope.setTenancyMode('multi');
    connection = await connect({ connectionString: config.connectionString, ...require('./pool-config').pool('evaluator'),
      statement_timeout: 5000, application_name: 'nightscout-evaluator-preview' });
    const self=Object.freeze({memberId:member.configured.memberId,ordinal,rule:member.configured.rule});
    const partition=Object.freeze({assignment:profile.assignment,self,currentGeneration:operationWindow.currentGeneration,membershipNamespace:profile.binding.membershipNamespace,lifecycleNamespace:profile.binding.lifecycleNamespace});
    workerStore=require('../../pgstream/checkpoint').create({connection,namespace:config.namespaces.checkpoint,consumer:config.consumer,maxBytes:config.maxBytes*2,timeIntervalMs:config.timeIntervalMs,typed:true,partition,intakeProfile:profile,onCommit:()=>workScheduler?.wakeDelivery()});
    await workerStore.own(()=>{trusted?.invalidate();failRole(new Error('EVALUATOR_PARTITION_OWNER_LOST'));});
    await workerStore.admit(ownTenants);
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
      // The stream recovery boundary below owns the first metadata snapshot.
      // Nothing consumes metadata before ready; scanning here would be repeated
      // after startup DDL and again for durable bootstrap.
    }
    {
      if(ordinal===0){
      intakeConnection=await connect({connectionString:config.selectedIntake.connectionString,max:1,connectionTimeoutMillis:5000,statement_timeout:5000,application_name:'nightscout-pgstream-intake'});
      controlConnection=await connect({connectionString:config.selectedIntake.controlConnectionString,max:1,connectionTimeoutMillis:5000,statement_timeout:5000,application_name:'nightscout-pgstream-control'});
      const hint=require('../../pgstream/input-hints').router({assignment:profile.assignment,peers:selected.peers.map(peer=>require('../internal-api/clients').pgstreamInput(peer.endpoint))});
      pgstream=await require('../../pgstream/evaluator').open({config,connection:intakeConnection,controlConnection,intakeProfile:profile,intakeBinding,
        onInput:clinicalCallback(async(tenant,kind,pendingAt)=>{
          assertRoster();if(!config.tenants.has(tenant))return;
          if(profile.assignment.owner(tenant)===ordinal){runtime?.markPending(tenant,pendingAt);workScheduler?.wake(tenant,kind);if(kind!=='clock')consumers?.wake(tenant).catch(()=>{});}
          else await hint(tenant,kind);
        }),
        onCommit:()=>{workScheduler?.wakeDelivery();},
        onUnavailable:async(code,details)=>{metadataRecovery=true;trusted.invalidate();if(details)console.error('Pgstream unavailable',JSON.stringify(details));},onTerminal:(code,details)=>{if(details)console.error('Pgstream terminal',JSON.stringify(details));failRole(Object.assign(new Error(code),{code}));},
        onSchema:async()=>{
          trusted.invalidate();await require('./evaluator-readiness')(config,{operationWindow,intakeProfile:profile,ordinal});
          await operational.verify();
          // Invalidation already fenced metadata/settings by worker generation.
          // Live instances still drain below; their scheduled acquisition reads
          // fresh metadata in bounded batches before it can publish output.
          // Startup has no instances, so schema ACK needs no tenant snapshot.
          if(runtime)for(const tenant of ownTenants){await runtime.invalidateTenant(tenant);workScheduler?.wake(tenant,'schema');}
          setImmediate(clinicalCallback(()=>workScheduler?.recover().catch(()=>{})));
        },
        onRecovered:async store=>{
          await operational.verify();
          const rows=await trusted.scan(ordinal===0?allTenants:ownTenants,{recovery:true});
          await require('../../pgstream/bootstrap')(store,rows);
          metadataRecovery=false;
          if(runtime)for(const tenant of ownTenants)workScheduler?.wake(tenant,'recovery');
          setImmediate(clinicalCallback(()=>workScheduler?.recover().catch(()=>{})));
        }});
      await pgstream.ready();
      }
    }
    const assertFeed=()=>{assertRoster();if(ordinal===0)pgstream.assertAvailable();else{if(!intakeHealth)throw new Error('INTAKE_WORKER_UNAVAILABLE');intakeHealth.assertAvailable();}};
    if(ordinal===1){
      intakeHealth=require('../../pgstream/intake-state').worker({peer:selected.peers[0],binding:config.intakeStateSync,bounds:config.pgstream.bounds,intakeProfileDigest:profile.digest,
        invalidate:async()=>{trusted.invalidate();
          // Shutdown already fenced both components and retains their close
          // promises. Do not ask a closed consumer to start another invalidation.
          if(stopping)return;
          await Promise.all(ownTenants.map(async tenant=>{await consumers?.invalidateTenant(tenant);await runtime?.invalidateTenant(tenant);}));},
        revalidate:async()=>{assertRoster();await operational.verify();await workerStore.admit(ownTenants);},
        reconcile:async()=>{await trusted.scan(ownTenants,{recovery:true});}});
      const until=performance.now()+config.pgstream.bounds.recoveryMs;
      while(!intakeHealth.available){try{await intakeHealth.synchronize();}catch(error){if(performance.now()>=until)throw error;}if(!intakeHealth.available){if(performance.now()>=until)throw new Error('INTAKE_BOOT_RECOVERY_EXHAUSTED');await new Promise(resolve=>setTimeout(resolve,Math.min(100,config.pgstream.bounds.heartbeatMs)));}}
    }
    // Decision readiness-serve-then-warm: 'serve' (default) opens once the role's
    // own dependencies are up; tenants warm in the background (bounded), and
    // the runtime acquires warm tenants first. 'all' keeps today's behaviour.
    const readiness = require('./pool-config').tenantReadiness();
    const startupConcurrency = require('./pool-config').startupConcurrency();
    startup = require('./tenant-startup').create(ownTenants, operationWindow, tenant =>
      require('./evaluator-readiness').provisionTenant(connection, config, tenant), { readiness, ...(coldAdmission ? {coldAdmission} : {}), concurrency: startupConcurrency, dynamic: !!config.registry, maxTenants: config.maxTenants });
    await startup.warm();
    let activity;
    if (config.activity) {
      // Read-only identity; boot refuses one that could write activity state.
      await require('../../migrations/postgres').run('check', { direct: true, connectionString: config.activity.connectionString,
        namespace: config.activity.namespace, catalogue: require('../../tenant-lifecycle/operation-window').catalogue(operationWindow), statementTimeoutMs: 5000 });
      activity = require('../../tenant-activity/eligibility').create({ read: async tenant => { const row=trusted.current(tenant); if(!row)throw new Error('TRUSTED_ACTIVITY_NOT_CURRENT'); return row.activity; } });
    }
    const domains = Object.fromEntries(evaluator.domains.map(d => [d, config.namespaces[d] + '.' + d]));
    const bootVerification = operational?.version();
    runtime = await startRuntime({ ...config, recoveryIntervalMs:config.pgstream.bounds.recoveryMs, dynamic: true, externalRecovery: true, operationWindow,pool:gate,
      durable:{pendingMs:config.pgstream.bounds.pendingMs,begin:workerStore.begin,complete:async(tenant,value)=>{assertFeed();const current=await config.readCurrent(tenant);if(!current||current.identity!==value.identity)throw new Error('EVALUATOR_COMPLETION_CONFIG_CHANGED');assertFeed();return workerStore.complete(tenant,{...value,restoreGeneration:operationWindow.currentGeneration(tenant)});}}, jobContext: clinicalJobs, activity, tenants: ownTenants,
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
    consumers = await require('./evaluator-consumers').prepare({ assertOperational:()=>{if(!trusted.state().available)throw new Error('TRUSTED_WORKER_UNAVAILABLE');assertFeed();}, config,partition:{...partition,intakeProfile:profile,checkpointNamespace:profile.binding.namespace,consumer:config.consumers.realtime.route.id,evaluatorConsumer:config.consumer+'-completed'},onUnavailable:()=>{trusted.invalidate();failRole(new Error('NOTIFICATION_PARTITION_OWNER_LOST'));},pool:gate, clinicalConnection: connection, operationWindow, ...(coldAdmission ? {coldAdmission} : {}), jobContext: deliveryJobs, activity,
      current: tenant => runtime?.last(tenant), isCurrent: (tenant, identity) => runtime?.isCurrent(tenant, identity) || false });
    {
      operational.activateRefresh(clinicalCallback(async () => {
        assertFeed();
        if(metadataRecovery){
          const rows=await trusted.scan(ordinal===0?allTenants:ownTenants,{recovery:true});
          if(ordinal===0)await require('../../pgstream/bootstrap')(pgstream.store,rows);
          metadataRecovery=false;
          await workScheduler.recover();
        }
      }), 2147483647, bootVerification);
      const hint=require('../internal-api/clients').completedOutput(config.pgstream.outputPeer);
      workScheduler=require('../../pgstream/activity-scheduler').start({store:workerStore,
        bind:clinicalCallback,admits:tenant=>config.tenants.has(tenant)&&gate.admits(tenant),maxTenants:config.maxTenants,onPending:(tenant,at)=>runtime.markPending(tenant,at),concurrency:require('./pool-config').pool('evaluator').max-1,
        scan:tenants=>trusted.scan(tenants),
        run:async(tenant,kind)=>{if(!config.tenants.has(tenant))return;assertFeed();await runtime[kind==='due'?'tick':'acquire'](tenant);const state=runtime.health([tenant]).tenants[0];if(!state.ready&&!['paused','suspended'].includes(state.activity)&&kind!=='lifecycle')throw new Error(state.code||'EVALUATOR_ACTIVITY_RETRY');},
        send:value=>hint.hintCompletedOutput(value)});
      workScheduler.recover().catch(()=>{});
      workScheduler.wakeDelivery();
    }
    if (consumers) {
      consumers.start();
    }
    gate.onChange(clinicalCallback(()=>{metadataRecovery=true;if(gate.reason()){trusted.invalidate();Promise.all(ownTenants.map(async tenant=>{await consumers?.invalidateTenant(tenant);await runtime.invalidateTenant(tenant);})).catch(()=>{});}}));
    const healthPass=()=>{if(healthRunning)return healthRunning;healthRunning=(async()=>{assertRoster();if(intakeHealth)await intakeHealth.synchronize();await gate.refresh();if(!trusted.state().available&&!gate.reason())await operational.verify();if((ordinal===0?pgstream.health().healthy:intakeHealth.available)&&!gate.reason()){await workScheduler.recover();workScheduler.wakeDelivery();}})().catch(()=>{trusted.invalidate();}).finally(()=>{healthRunning=null;});return healthRunning;};
    healthTimer=setInterval(clinicalCallback(healthPass),Math.max(1,Math.floor(Math.min(config.pgstream.bounds.stallMs,config.partition.leaseMs)/3)));healthTimer.unref?.();
    console.log('Evaluator preview started; configured tenants:', config.tenants.size, 'pool:', member.configured.mode, 'operation:', operationWindow?.trustedWorker ? 'trusted-worker' : 'scoped', ...(registrySet ? ['registry revision:', registrySet.revision()] : []));
    // The private operational read (contract evaluator-inspection).
    const inspect = require('./evaluator-inspection')({ tenants: config.tenants, gate, runtime, consumers, startup, registry: registrySet });
    const modules = { ...(config.inspection ? {'evaluator-inspection':Object.freeze({
      create: () => ({inspectEvaluator:async (context, body) => inspect(body)})})} : {}),
      ...(ordinal===0 ? {'intake-state':Object.freeze({create:()=>({inspectIntake:async (context, body)=>pgstream.inspectIntake(body)})})} : {}) };
    modules['pgstream-input']=Object.freeze({create:()=>({hintEvaluatorInput:require('../../pgstream/input-hints').handler({assignment:profile.assignment,ordinal,wake:async(tenant,kind)=>{assertFeed();workScheduler.wake(tenant,kind);workScheduler.wakeDelivery();if(kind!=='clock')consumers?.wake(tenant).catch(()=>{});}})})});
    const internal = Object.freeze(modules);
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
      health: () => ({ ...runtime.health(), ...(trusted ? { trustedWorker: trusted.health() } : {}),  pgstream:ordinal===0?pgstream.health():{healthy:intakeHealth.available,source:'ordinal-zero'},pgstreamWork:workScheduler.stats(), startup: startup.health(),
        ...(registrySet ? { registry: registrySet.stats() } : {}),
        ...(consumers ? { consumers: consumers.health() } : {}) }),
      failure,cohortBackends:()=>member.backends(),last: runtime.last, isCurrent: runtime.isCurrent, close, inspect, ...(internal ? { internal } : {}),
      async invalidateTenant (tenant) {
        if(profile.assignment.owner(tenant)!==ordinal)return;
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
module.exports = { boot, selection };
