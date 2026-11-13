'use strict';
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { io } = require('socket.io-client');
const http = require('node:http');
const { enabled } = require('./fixtures/tenant-registry-lab');
const { optInSuite } = require('./support/opt-in');
const lower = require('../lib/storage/postgres-connection');
const hash = value => createHash('sha1').update(value).digest('hex');
optInSuite(enabled(), 'owned PostgreSQL and Vault native sharding')('actual fixed-roster realtime sharding', function () {
  this.timeout(120000);
  it('SHARD_REGISTRY_STATUS: actual unsharded registry API lifecycle status preserves its one exact registry cohort label', async function () {
    const f = require('./fixtures/realtime-sharding-native')();
    try {
      await f.setup({ operation: true, apiOnly: true });
      const request = randomUUID(), status = await require('../lib/server/internal-api/clients').lifecycleParticipant(f.apiInternal).getStatus({request});
      assert.equal(status.request,request); assert.equal(status.version,1);
      assert.deepEqual(status.tenants,['registry:'+f.lab.namespaces.registry]); assert.equal(status.participant,'api');
      assert.ok(status.backends.length>0,'actual API backend census accompanies legitimate registry status');
    } finally { await f.cleanup(); }
  });
  it('SHARD_ACTUAL_CENSUS: real API and two realtime cohort producers include held ownership backends; missing worker and unknown clinical actor refuse', async function () {
    const f=require('./fixtures/realtime-sharding-native')();let remote,pin,unknown;
    const cohorts=require('../lib/server/serve/operation-cohort');
    try {
      await f.setup({operation:'sharded'});await f.closeProvisioner();
      const participants=require('../lib/server/serve/operation-cohort-manifest').validate(f.cohortParticipants),A=f.tenants[0];
      remote=await cohorts.createRemote({namespace:f.lab.namespaces.control,tenants:['registry:'+f.lab.namespaces.registry],participants,placement:f.placement});
      pin=await cohorts.pin(remote,A,{client:f.lab.admin});
      const census=await cohorts.assertComplete(remote,A,{client:f.lab.admin});assert.ok(census.backends>2);
      const owners=(await f.lab.admin.query("SELECT pid FROM pg_stat_activity WHERE usename=$1 AND application_name='nightscout-realtime-owner'",[f.lab.roles.realtime])).rows.map(row=>row.pid);
      assert.equal(owners.length,2);
      const states=await Promise.all(participants.filter(peer=>peer.roles.includes('realtime')).map(peer=>require('../lib/server/internal-api/clients').lifecycleParticipant(peer.endpoint).getStatus({request:randomUUID()})));
      const known=new Set(states.flatMap(state=>state.backends.map(row=>row.pid)));assert.ok(owners.every(pid=>known.has(pid)),'SHARD_ACTUAL_CENSUS actual held resource backends observed, not inferred from labels');
      await assert.rejects(cohorts.createRemote({namespace:f.lab.namespaces.control,tenants:['registry:'+f.lab.namespaces.registry],participants:participants.filter(peer=>peer.worker!=='a'),placement:f.placement}),{code:'RESTORE_COHORT_PLACEMENT_INCOMPLETE'});
      unknown=new Client({connectionString:f.lab.urls.realtime});await unknown.connect();await unknown.query('SELECT 1');
      await assert.rejects(cohorts.assertComplete(remote,A,{client:f.lab.admin}),{code:'RESTORE_COHORT_UNKNOWN_BACKEND'});
      await unknown.end();unknown=null;await cohorts.assertComplete(remote,A,{client:f.lab.admin});
    }finally{await unknown?.end().catch(()=>{});if(pin)await cohorts.releasePin(pin);await remote?.close();await f.cleanup();}
  });
  it('SHARD_ALL_PAUSED: real owners boot and inspect honestly without projection work; one resumed tenant warms while the other stays quiet', async function () {
    const f=require('./fixtures/realtime-sharding-native')();let socket,agent;
    try {
      const {ns}=await f.setup({paused:true}),[A,B]=f.tenants;
      for(const id of ['a','b']){const health=await f.request(A,'GET','/health',undefined,f.workers.get(id).port);assert.equal(health.status,200);assert.equal(health.body.healthy,0);assert.equal(health.body.deferred,1);assert.equal(health.body.tenants[0].ready,false);}
      const rows=(await f.lab.admin.query('SELECT tenant_id::text,checkpoint::text FROM "'+ns.checkpoint+'".tenant_consumer_checkpoint ORDER BY tenant_id')).rows;
      assert.ok(rows.every(row=>row.checkpoint==='0'),'SHARD_ALL_PAUSED no synthetic checkpoint progress');
      assert.equal((await f.request(A,'GET','/socket.io/?EIO=4&transport=polling',undefined,f.workers.get('a').port)).status,403);
      const adapter=require('../lib/server/realtime/alarm-transport').createPlacementAdapter({placement:f.routes});
      await assert.rejects(new Promise((resolve,reject)=>adapter.send({tenant:A,id:randomUUID(),attempt:1,notification:{level:1,title:'synthetic paused'},receipts:[]},(error,value)=>error?reject(error):resolve(value))),/REALTIME_HANDOFF_UNAVAILABLE/);
      await f.setActivity(A,'unpause');
      agent=new http.Agent({lookup:(host,options,done)=>options.all?done(null,[{address:'127.0.0.1',family:4}]):done(null,'127.0.0.1',4)});
      socket=io('http://'+f.hosts.get(A),{forceNew:true,transports:['polling'],agent,reconnectionDelay:50,reconnectionDelayMax:200});let frame;
      socket.on('connect',()=>socket.emit('authorize',{secret:hash(f.roots.get(A))}));socket.on('dataUpdate',value=>{frame=value;});
      await f.until(()=>frame?.sgvs.some(row=>row.mgdl===120),'resumed actual tenant current frame');
      assert.equal((await f.lab.admin.query('SELECT checkpoint::text FROM "'+ns.checkpoint+'".tenant_consumer_checkpoint WHERE tenant_id=$1',[B])).rows[0].checkpoint,'0','SHARD_ALL_PAUSED B remains quiet');
    }finally{socket?.close();agent?.destroy();await f.cleanup();}
  });
  it('SHARD_LIVE_ADD: actual running owners admit a new registry tenant only on its assigned shard without process restart', async function () {
    const f = require('./fixtures/realtime-sharding-native')(); let socket, agent;
    try {
      await f.setup();
      const before = new Map([...f.workers].map(([id,row])=>[id,row.child.pid]));
      let tenant; do { tenant=randomUUID(); } while(require('../lib/realtime-placement').shard(tenant,2)!==0);
      const failure=require('node:path').join(f.directory,'fail-'+tenant);require('node:fs').writeFileSync(failure,'');
      await f.provisionTenant(tenant,'shard-live.example.test');
      await f.until(async()=>{const result=await f.request(tenant,'POST','/api/v3/entries',{identifier:'live-shard',type:'sgv',date:Date.now(),utcOffset:0,app:'synthetic-sharding',sgv:149});return result.status===201;},'new tenant real API write');
      await f.until(async()=>{const status=await f.request(tenant,'GET','/health',undefined,f.workers.get('a').port);return status.body.registry.admissionRefused>0;},'real failed target preparation refuses publication');
      assert.equal((await f.request(tenant,'GET','/socket.io/?EIO=4&transport=polling',undefined,f.workers.get('a').port)).status,403,'failed target is not socket-admitted');
      const healthy=await f.request(f.tenants[1],'GET','/health',undefined,f.workers.get('b').port);assert.equal(healthy.status,200);assert.equal(healthy.body.ready,true);
      require('node:fs').unlinkSync(failure);
      await f.until(async()=>{const status=await f.request(tenant,'GET','/health',undefined,f.workers.get('a').port);return status.body.tenants.some(row=>row.tenant===tenant&&row.ready);},'assigned live tenant warm');
      const other=await f.request(tenant,'GET','/health',undefined,f.workers.get('b').port);
      assert.ok(!other.body.tenants.some(row=>row.tenant===tenant),'unowned live tenant never enters B runtime');
      assert.equal((await f.request(tenant,'GET','/socket.io/?EIO=4&transport=polling',undefined,f.workers.get('b').port)).status,403);
      agent=new http.Agent({lookup:(host,options,callback)=>options.all?callback(null,[{address:'127.0.0.1',family:4}]):callback(null,'127.0.0.1',4)});
      let frame; socket=io('http://'+f.hosts.get(tenant),{transports:['polling'],upgrade:false,agent,reconnection:false});
      socket.on('connect',()=>socket.emit('authorize',{secret:hash(f.roots.get(tenant))}));socket.on('dataUpdate',value=>{frame=value;});
      await f.until(()=>frame?.sgvs.some(row=>row.mgdl===149),'assigned live tenant actual clinical frame');
      for(const [id,row] of f.workers)assert.equal(row.child.pid,before.get(id),'no owner restart for live tenant');
    } finally {socket?.close();agent?.destroy();await f.cleanup();}
  });
  it('SHARD_NATIVE_MOVE: actual polling/WebSocket/API3 and alarm clients follow confirmed ownership; checkpoint continuity and healthy B survive', async function () {
    const f = require('./fixtures/realtime-sharding-native')(), sockets = [], agents = [];
    const agent = () => { const value = new http.Agent({ keepAlive: true, lookup: (host, options, done) => options.all ? done(null,[{address:'127.0.0.1',family:4}]) : done(null,'127.0.0.1',4) }); agents.push(value); return value; };
    let registryConnection, publicationClient, maintenanceClient;
    const frameClient = (tenant, transport) => {
      const socket = io('http://' + f.hosts.get(tenant), { forceNew: true, transports: [transport], agent: agent(), reconnectionDelay: 50, reconnectionDelayMax: 200, timeout: 1000 });
      const seen = { socket, frames: [], connections: 0, errors: [] };
      socket.on('connect', () => { seen.connections++; socket.emit('authorize', { secret: hash(f.roots.get(tenant)) }); });
      socket.on('connect_error', error => { if (seen.errors.length < 5) seen.errors.push(error.message); });
      socket.on('dataUpdate', value => seen.frames.push(value)); sockets.push(socket); return seen;
    };
    const subscription = (tenant, namespace, transport) => {
      const socket = io('http://' + f.hosts.get(tenant) + namespace, { forceNew: true, transports: [transport], agent: agent(), reconnectionDelay: 50, reconnectionDelayMax: 200, timeout: 1000 });
      const seen = { socket, acks: [], alarms: [], changes: [], errors: [] };
      socket.on('connect', () => socket.emit('subscribe', { accessToken: f.credentials.get(tenant), ...(namespace === '/storage' ? { collections: ['entries'] } : {}) }, reply => seen.acks.push(reply)));
      socket.on('connect_error', error => { if (seen.errors.length < 5) seen.errors.push(error.message); });
      socket.on('alarm', value => seen.alarms.push(value));
      for (const event of ['create','update','delete']) socket.on(event, value => seen.changes.push({ event, value }));
      sockets.push(socket); return seen;
    };
    const alarm = (adapter, tenant, title) => new Promise((resolve, reject) => adapter.send({ tenant, id: randomUUID(), attempt: 1, notification: { level: 1, title }, receipts: [] }, (error, value) => error ? reject(new Error('SHARD_NATIVE_HANDOFF '+title+': '+error.message,{cause:error})) : resolve(value)));
    try {
      const { ns, internal } = await f.setup(), [A, B] = f.tenants;
      await f.unrelatedScopeControl();
      const a = frameClient(A, 'polling'), b = frameClient(B, 'websocket');
      const storage = subscription(A, '/storage', 'websocket'), alarmA = subscription(A, '/alarm', 'polling'), alarmB = subscription(B, '/alarm', 'websocket');
      try { await f.until(() => a.frames.length && b.frames.length && storage.acks.some(ack => ack.success) && alarmA.acks.some(ack => ack.success) && alarmB.acks.some(ack => ack.success), 'all real namespaces authorized'); }
      catch (error) { throw new Error(error.message + ': ' + JSON.stringify({ a: { frames: a.frames.length, errors: a.errors }, b: { frames: b.frames.length, errors: b.errors }, storage: { acks: storage.acks, errors: storage.errors }, alarmA: { acks: alarmA.acks, errors: alarmA.errors }, alarmB: { acks: alarmB.acks, errors: alarmB.errors }, healthA: (await f.request(A,'GET','/health',undefined,f.workers.get('a').port)).body, stderrA: f.workers.get('a').stderr }), { cause: error }); }
      assert.ok(a.frames.at(-1).sgvs.some(row => row.mgdl === 120), 'SHARD_NATIVE initial A clinical frame');
      assert.ok(b.frames.at(-1).sgvs.some(row => row.mgdl === 121), 'SHARD_NATIVE initial B clinical frame');
      assert.equal(a.socket.io.engine.transport.name, 'polling'); assert.equal(b.socket.io.engine.transport.name, 'websocket');
      const bSession = b.socket.id;
      // Direct wrong-owner route cannot bypass backend admission.
      assert.equal((await f.request(A,'GET','/socket.io/?EIO=4&transport=polling',undefined,f.workers.get('b').port)).status, 403, 'SHARD_NATIVE_WRONG_OWNER_REFUSED');
      const adapter = require('../lib/server/realtime/alarm-transport').createPlacementAdapter({ placement: f.routes });
      assert.equal((await alarm(adapter, A, 'synthetic before move')).accepted, true);
      await f.until(() => alarmA.alarms.length === 1, 'initial admitted handoff'); assert.equal(alarmB.alarms.length, 0);
      const checkpoints = async () => (await f.lab.admin.query('SELECT consumer,checkpoint::text,contract_digest,projection FROM "' + ns.checkpoint + '".tenant_consumer_checkpoint WHERE tenant_id=$1', [A])).rows;
      const before = await checkpoints(); assert.equal(before.length, 1); assert.equal(before[0].consumer, 'realtime-sharding-native'); assert.ok(BigInt(before[0].checkpoint) > 0n);
      const baseline = await f.request(A, 'GET', '/api/v3/entries'); assert.equal(baseline.status, 200); assert.equal(baseline.body.result.length, 1);
      const removed = baseline.body.result[0].identifier;
      const old = f.workers.get('a'), oldIncarnation = f.map.workers.find(row => row.id === 'a').incarnation;
      const candidate = { ...f.map, generation: 2, owners: ['b','b'], workers: f.map.workers.map(row => row.id === 'a' ? { ...row, incarnation: randomUUID() } : row),
        transition: { previousGeneration: 1, previousOwners: f.map.owners.map(id => ({ worker: id, incarnation: f.map.workers.find(row => row.id === id).incarnation })), stopped: [{ worker: 'a', incarnation: oldIncarnation }] } };
      registryConnection = await lower({ connectionString: f.publisher.url, max: 1 });
      const registry = require('../lib/tenant-registry/postgres').create({ connection: registryConnection, namespace: f.lab.namespaces.registry });
      publicationClient = new Client({ connectionString: f.publisher.url }); await publicationClient.connect();
      maintenanceClient = new Client({ connectionString: f.publisher.url }); await maintenanceClient.connect();
      const publish = (extra = {}) => require('../lib/realtime-placement/publish').publish({ file: require('node:path').join(f.directory, 'placement.json'), candidate, internal, client: publicationClient,
        controlNamespace: f.lab.namespaces.control, registry, maxTenants: 100,
        confirmStopped: async owner => owner.worker === 'a' && owner.incarnation === oldIncarnation && !!old.exit, ...extra });
      // Reachability/route observation alone never constitutes exclusion.
      await assert.rejects(publish(), { code: 'REALTIME_PLACEMENT_OLD_OWNER_UNCONFIRMED' });
      assert.equal(f.placement.current().generation, 1);
      const oldFrameCount = a.frames.length, oldStorageAcks = storage.acks.length, oldAlarmAcks = alarmA.acks.length;
      const hold = require('node:path').join(f.directory,'hold-'+A); require('node:fs').writeFileSync(hold,'');
      assert.equal((await publish({ stopOwners: async owner => {
        assert.deepEqual(owner,{worker:'a',incarnation:oldIncarnation});
        await assert.rejects(require('../lib/realtime-placement/publication-lock').pin(maintenanceClient,f.lab.namespaces.control),{code:'RESTORE_COHORT_PLACEMENT_BUSY'},'SHARD_NATIVE_PIN_EXCLUDED_BEFORE_OLD_STOP');
        await f.stop(old); assert.ok(old.exit,'old actual process exit observed inside fence before publication');
        await f.until(()=>!a.socket.connected && !storage.socket.connected,'old transports closed');
        assert.equal((await f.request(A,'DELETE','/api/v3/entries/'+removed)).status,200);
        assert.equal((await f.request(B,'POST','/api/v3/entries',{identifier:'during-a-move',type:'sgv',date:Date.now(),utcOffset:0,app:'synthetic-sharding',sgv:155})).status,201);
        await f.until(()=>b.frames.some(frame=>frame.sgvs.some(row=>row.mgdl===155)),'healthy B during fenced owner outage');assert.equal(b.socket.id,bSession);
      }, afterAssignment: async () => { f.map=candidate;
      await f.until(()=>require('node:fs').existsSync(hold+'-entered'),'new target projection is really held');
      assert.equal((await f.request(A,'GET','/socket.io/?EIO=4&transport=polling',undefined,f.workers.get('b').port)).status,403,'SHARD_NATIVE no handshake admission during target warm');
      await assert.rejects(alarm(adapter,A,'synthetic while cold'),/REALTIME_HANDOFF_UNAVAILABLE/);
      assert.equal(alarmA.alarms.length,1,'no handoff effect while target is cold');
      assert.equal((await f.request(B,'POST','/api/v3/entries',{identifier:'during-target-warm',type:'sgv',date:Date.now(),utcOffset:0,app:'synthetic-sharding',sgv:156})).status,201);
      await f.until(()=>b.frames.some(frame=>frame.sgvs.some(row=>row.mgdl===156)),'SHARD_NATIVE_B_PROGRESS_DURING_WARM',1500);
      assert.equal((await alarm(adapter,B,'synthetic B during unrelated target warm')).accepted,true,'SHARD_NATIVE_B_ALARM_DURING_WARM');
      await f.until(()=>alarmB.alarms.length===1,'B alarm through unchanged exact owner with old route generation');
      await f.setActivity(A,'pause');
      require('node:fs').unlinkSync(hold);
      await f.until(async()=>{const health=await f.request(B,'GET','/health',undefined,f.workers.get('b').port);return health.body.registry.admissionRefused>0 && health.body.configured===1;},'SHARD_NATIVE_PAUSE_DURING_WARM_REFUSES_ACTIVATION');
      assert.equal(a.frames.length,oldFrameCount);await assert.rejects(alarm(adapter,A,'synthetic paused target'),/REALTIME_HANDOFF_UNAVAILABLE/);
      await f.startRealtime('a');
      await f.setActivity(A,'unpause');
      await f.until(async()=>{const health=await f.request(B,'GET','/health',undefined,f.workers.get('b').port);return health.body.tenants.some(row=>row.tenant===A && row.ready);},'target ready before consumer route publication');
      await assert.rejects(require('../lib/realtime-placement/publication-lock').pin(maintenanceClient,f.lab.namespaces.control),{code:'RESTORE_COHORT_PLACEMENT_BUSY'},'same fence held through target readiness');
      f.publishRoutes();
      } })).generation,2);
      await f.until(() => a.frames.length > oldFrameCount && storage.acks.length > oldStorageAcks && alarmA.acks.length > oldAlarmAcks, 'new owner reconnect/current frame');
      assert.equal(a.frames.at(-1).delta, false); assert.deepEqual(a.frames.at(-1).sgvs, [], 'SHARD_NATIVE deleted row absent from current full frame');
      // API3 subscribe ACK is not offline history reload. The documented client
      // reconnects/subscribes first and explicitly reloads its collection.
      const reloaded = await f.request(A, 'GET', '/api/v3/entries'); assert.equal(reloaded.status, 200); assert.deepEqual(reloaded.body.result, []);
      assert.equal(alarmA.alarms.length, 1, 'accepted old handoff was not replayed by reconnect');
      assert.equal((await alarm(adapter, A, 'synthetic after move')).accepted, true);
      await f.until(() => alarmA.alarms.length === 2, 'alarm routed through same admitted new owner'); assert.equal(alarmB.alarms.length, 1);
      const after = await checkpoints(); assert.equal(after.length, 1); assert.equal(after[0].consumer, before[0].consumer); assert.equal(after[0].contract_digest, before[0].contract_digest);
      assert.ok(BigInt(after[0].checkpoint) >= BigInt(before[0].checkpoint), 'SHARD_NATIVE durable checkpoint monotonic through actual owner move');
      assert.equal(b.socket.id, bSession); assert.equal(b.connections, 1, 'healthy B was not restarted/reconnected');
      const backends = (await f.lab.admin.query("SELECT application_name,count(*)::int AS count FROM pg_stat_activity WHERE usename=$1 GROUP BY application_name", [f.lab.roles.realtime])).rows;
      assert.equal(backends.find(row => row.application_name === 'nightscout-realtime-owner')?.count, 2, 'SHARD_NATIVE one actual held owner connection per worker including idle');
      assert.ok((backends.find(row => row.application_name === 'nightscout-realtime-preview')?.count || 0) <= 8, 'original work pool bound remains4 per worker');
      const idle = await f.request(A, 'GET', '/health', undefined, f.workers.get('a').port); assert.equal(idle.status, 200); assert.equal(idle.body.configured, 0);
    } finally {
      for (const socket of sockets) socket.close(); for (const agent of agents) agent.destroy(); await publicationClient?.end().catch(() => {}); await maintenanceClient?.end().catch(() => {}); await registryConnection?.end().catch(() => {}); await f.cleanup();
    }
  });
});
