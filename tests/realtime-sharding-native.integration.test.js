'use strict';
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { io } = require('socket.io-client');
const http = require('node:http');
const { enabled } = require('./fixtures/tenant-registry-lab');
const { optInSuite } = require('./support/opt-in');
const hash = value => createHash('sha1').update(value).digest('hex');
optInSuite(enabled(), 'owned PostgreSQL and Vault native sharding')('actual fixed-roster realtime sharding', function () {
  this.timeout(120000);
  it('SHARD_RAW_STORAGE: actual stock clients retain raw CRUD, live high water and expiry independence', async function () {
    const f=require('./fixtures/realtime-sharding-native')(),sockets=[],agents=[];
    const oracle=require('./fixtures/realtime-preview/storage-oracle');
    try {
      const {ns}=await f.setup(),[A,B]=f.tenants,admin=f.lab.admin;
      async function client(tenant,transport){
        const agent=new http.Agent({lookup:(host,options,done)=>options.all?done(null,[{address:'127.0.0.1',family:4}]):done(null,'127.0.0.1',4)});agents.push(agent);
        const socket=io('http://'+f.hosts.get(tenant)+'/storage',{forceNew:true,transports:[transport],agent,reconnection:false}),events=[],disconnects=[];sockets.push(socket);socket.on('disconnect',reason=>disconnects.push(reason));
        for(const event of ['create','update','delete'])socket.on(event,value=>events.push({event,value}));
        const ack=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('SHARD_RAW_SUBSCRIBE_NOACK')),5000);socket.once('connect_error',reject);socket.once('connect',()=>socket.emit('subscribe',{accessToken:f.credentials.get(tenant),collections:['entries','food']},value=>{clearTimeout(timer);resolve(value);}));});
        assert.deepEqual(ack,{success:true,collections:['entries','food']});return {socket,events,transport,disconnects};
      }
      const clients=await Promise.all(['polling','websocket'].map(t=>client(A,t))),foreign=await client(B,'websocket');
      const subscribedTail=(await admin.query('SELECT projection->1 AS tail FROM \"'+ns.evaluatorCheckpoint+'\".tenant_consumer_checkpoint WHERE tenant_id=$1 AND consumer=$2',[A,'evaluator-sharding-native'])).rows[0].tail;
      const table=domain=>'"'+ns[domain]+'"."'+domain+'"';
      const mutate=(deleted,fn)=>require('./fixtures/realtime-preview/clock-write')({admin,namespace:ns.clock,tenant:A,deleted},fn);
      const write=(domain,row)=>mutate(false,stamp=>{row.doc.srvModified=stamp;return admin.query('INSERT INTO '+table(domain)+'(tenant_id,id_kind,doc) VALUES($1,$2,$3::jsonb)',[A,row.id_kind,JSON.stringify(row.doc)]);});
      const expected=async(event,row,domain,group=clients)=>{const want=oracle.single(event,row,domain);try{await f.until(()=>group.every(c=>c.events.some(value=>require('node:util').isDeepStrictEqual(value,want))),'raw '+domain+' '+event);}catch(error){console.log('SHARD_RAW_MISMATCH '+JSON.stringify({want,subscribedTail,rtReceipts:(await admin.query('SELECT consumer,output_received,output_completed,output_owner,output_retry_at FROM \"'+ns.checkpoint+'\".tenant_consumer_checkpoint WHERE tenant_id=$1',[A])).rows,rtHealth:(await f.request(A,'GET','/health',undefined,f.workers.get('a').port)).body,rtStderr:f.workers.get('a').stderr,events:group.map(c=>({transport:c.transport,events:c.events,connected:c.socket.connected,disconnects:c.disconnects})),checkpoint:(await admin.query('SELECT consumer,projection,work_enabled,work_observed,work_completed,delivery_revision,delivery_ack_revision,output_revision,output_restore_generation FROM \"'+ns.evaluatorCheckpoint+'\".tenant_consumer_checkpoint WHERE tenant_id=$1',[A])).rows}));throw error;}assert.deepEqual(foreign.events,[],'SHARD_RAW_FOREIGN_TENANT');};
      const oldId='old-'+randomUUID(),mealId='meal-'+randomUUID(),now=Date.now();
      const old={id_kind:'string',doc:{_id:oldId,identifier:'public-'+oldId,type:'sgv',sgv:139,date:now-4*86400000,dateString:new Date(now-4*86400000).toISOString()}};
      const meal={id_kind:'string',doc:{_id:mealId,identifier:'public-'+mealId,name:'Synthetic raw meal',carbs:12}};
      await write('entries',old);await expected('create',old,'entries');
      await write('food',meal);await expected('create',meal,'food');
      await mutate(false,stamp=>{meal.doc={...meal.doc,carbs:23,srvModified:stamp};return admin.query('UPDATE '+table('food')+' SET doc=$3::jsonb WHERE tenant_id=$1 AND doc->>\'_id\'=$2',[A,mealId,JSON.stringify(meal.doc)]);});await expected('update',meal,'food');
      await mutate(true,()=>admin.query('DELETE FROM '+table('food')+' WHERE tenant_id=$1 AND doc->>\'_id\'=$2',[A,mealId]));await expected('delete',meal,'food');
      const checkpoint='"'+ns.evaluatorCheckpoint+'".tenant_consumer_checkpoint',consumer='evaluator-sharding-native';
      const input=async()=>(await admin.query('SELECT projection->0 AS state FROM '+checkpoint+' WHERE tenant_id=$1 AND consumer=$2',[A,consumer])).rows[0].state;
      // Native acceptance retains compact positions, while completed coverage proves
      // the clinical frame consumed the old entry without making it clinical data.
      const completed=async()=>(await admin.query("SELECT work_completed,projection->0->'output' AS output FROM "+checkpoint+' WHERE tenant_id=$1 AND consumer=$2',[A,consumer+'-completed'])).rows[0];
      const accepted=await input();
      const outside=await f.until(async()=>{const row=await completed();return Number(row?.work_completed?.[5])>=accepted.floor?row:null;},'raw native input clinically covered');
      assert(!outside.output.frame.sgvs.some(row=>String(row._id)===oldId),'SHARD_RAW_OLD_ENTRY_OUTSIDE_CLINICAL_WINDOW');
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM '+table('entries')+" WHERE tenant_id=$1 AND doc->>'_id'=$2",[A,oldId])).rows[0].n,1,'SHARD_RAW_OLD_SOURCE_RETAINED');
      const fresh=await Promise.all(['polling','websocket'].map(t=>client(A,t)));
      const follow={id_kind:'string',doc:{_id:'follow-'+randomUUID(),name:'Synthetic follow',carbs:4}};
      await write('food',follow);await expected('create',follow,'food',[...clients,...fresh]);
      await mutate(true,()=>admin.query('DELETE FROM '+table('food')+' WHERE tenant_id=$1 AND doc->>\'_id\'=$2',[A,follow.doc._id]));await expected('delete',follow,'food',[...clients,...fresh]);
      for(const c of fresh)assert.equal(c.events.length,2,'SHARD_RAW_NO_OFFLINE_REPLAY_AND_NEW_LIVE_EVENTS_EXACTLY_ONCE');
      const edge=Date.now()+5000,expiry={id_kind:'string',doc:{_id:'expiry-'+randomUUID(),type:'sgv',sgv:138,date:edge-2*86400000,dateString:new Date(edge-2*86400000).toISOString()}};
      await write('entries',expiry);await expected('create',expiry,'entries');
      const clock=async()=>String((await admin.query('SELECT last_stamp FROM "'+ns.clock+'".tenant_write_clock WHERE tenant_id=$1',[A])).rows[0].last_stamp),stamp=await clock();
      const acceptedExpiry=await input();
      const work=async()=>(await admin.query('SELECT work_completed_at::text AS at,work_due_at::text AS due,work_completed FROM '+checkpoint+' WHERE tenant_id=$1 AND consumer=$2',[A,consumer+'-completed'])).rows[0];
      const entering=await f.until(async()=>{const row=await work();return Number(row.work_completed?.[5])>=acceptedExpiry.floor?row:null;},'expiry input completed');
      assert(Number(entering.at)<edge&&entering.due!==null&&Number(entering.due)>Number(entering.at)&&Number(entering.due)<=edge+1,'SHARD_RAW_REAL_FUTURE_EXPIRY_DUE');
      const after=await f.until(async()=>{const row=await work();return Number(row.at)>edge&&(row.due===null||Number(row.due)>edge+1)?row:null;},'actual expiry time-only completion');
      assert.equal(await clock(),stamp,'SHARD_RAW_EXPIRY_NO_SOURCE_WRITE');
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM '+table('entries')+' WHERE tenant_id=$1 AND doc->>\'_id\'=$2',[A,expiry.doc._id])).rows[0].n,1,'SHARD_RAW_EXPIRY_SOURCE_RETAINED');
      for(const c of [...clients,...fresh])assert(!c.events.some(e=>e.event==='delete'&&e.value.identifier===expiry.doc._id),'SHARD_RAW_NO_EXPIRY_DELETE');
      await f.setActivity(A,'pause');
      await f.until(()=>clients.every(c=>!c.socket.connected),'actual pause fences storage session');
      assert(foreign.socket.connected,'SHARD_RAW_NEIGHBOR_SURVIVES_PAUSE');
      console.log('SHARD_RAW_STORAGE_PROOF '+JSON.stringify({oldPublicIdentity:old.doc.identifier,foodPublicIdentity:meal.doc.identifier,transports:clients.map(c=>c.transport),freshCountsAfterExpiry:fresh.map(c=>c.events.length),expiry:{stamp,before:entering,after},foreignEvents:foreign.events.length,pauseFenced:true}));
    } finally {for(const socket of sockets)socket.close();for(const agent of agents)agent.destroy();await f.cleanup();}
  });
  it('SHARD_REGISTRY_STATUS: actual unsharded registry API lifecycle status preserves its one exact registry cohort label', async function () {
    const f = require('./fixtures/realtime-sharding-native')();
    try {
      await f.setup({ operation: true, apiOnly: true });
      const request = randomUUID(), status = await require('../lib/server/internal-api/clients').lifecycleParticipant(f.apiInternal).getStatus({request});
      assert.equal(status.request,request); assert.equal(status.version,4); assert.equal(status.ownership,null);
      assert.deepEqual(status.tenants,['registry:'+f.lab.namespaces.registry]); assert.equal(status.participant,'api');
      assert.ok(status.backends.length>0,'actual API backend census accompanies legitimate registry status');
    } finally { await f.cleanup(); }
  });
  it('SHARD_ACTUAL_CENSUS: real API and two realtime cohort producers include held ownership backends; missing worker and unknown clinical actor refuse', async function () {
    const f=require('./fixtures/realtime-sharding-native')();let remote,pin,unknown;
    const cohorts=require('../lib/server/serve/operation-cohort');
    try {
      const {ns}=await f.setup({operation:'sharded'});await f.closeProvisioner();
      const participants=require('../lib/server/serve/operation-cohort-manifest').validate(f.cohortParticipants),A=f.tenants[0];
      remote=await cohorts.createRemote({namespace:f.lab.namespaces.control,tenants:['registry:'+f.lab.namespaces.registry],participants});
      pin=await cohorts.pin(remote,A,{client:f.lab.admin});
      const census=await cohorts.assertComplete(remote,A,{client:f.lab.admin});assert.ok(census.backends>2);
      const owners=(await f.lab.admin.query("SELECT pid FROM pg_stat_activity WHERE usename=$1 AND application_name='nightscout-realtime-owner'",[f.lab.roles.realtime])).rows.map(row=>row.pid);
      assert.equal(owners.length,2);
      const states=await Promise.all(participants.filter(peer=>peer.roles.includes('realtime')).map(peer=>require('../lib/server/internal-api/clients').lifecycleParticipant(peer.endpoint).getStatus({request:randomUUID()})));
      const known=new Set(states.flatMap(state=>state.backends.map(row=>row.pid)));assert.ok(owners.every(pid=>known.has(pid)),'SHARD_ACTUAL_CENSUS actual held resource backends observed, not inferred from labels');
      await assert.rejects(cohorts.createRemote({namespace:f.lab.namespaces.control,tenants:['registry:'+f.lab.namespaces.registry],participants:participants.filter(peer=>peer.slice?.ordinal!==0)}),{code:'REALTIME_STATIC_OWNERSHIP_REFUSED'});
      unknown=new Client({connectionString:f.evaluator.url});await unknown.connect();
      const capability=(await unknown.query("SELECT has_schema_privilege(current_user,$1,'USAGE') AS usage,has_table_privilege(current_user,$2,'SELECT') AS clinical",[ns.entries,ns.entries+'.entries'])).rows[0];
      assert.deepEqual(capability,{usage:true,clinical:true},'SHARD_UNKNOWN_BACKEND_IS_ACTUAL_CLINICAL_READER');
      await assert.rejects(cohorts.assertComplete(remote,A,{client:f.lab.admin}),{code:'RESTORE_COHORT_UNKNOWN_BACKEND'});
      await unknown.end();unknown=null;await cohorts.assertComplete(remote,A,{client:f.lab.admin});
    }finally{await unknown?.end().catch(()=>{});if(pin)await cohorts.releasePin(pin);await remote?.close();await f.cleanup();}
  });
  it('SHARD_ALL_PAUSED: real owners boot and inspect honestly without projection work; one resumed tenant warms while the other stays quiet', async function () {
    const f=require('./fixtures/realtime-sharding-native')();let socket,agent;
    try {
      const {ns}=await f.setup({paused:true}),[A,B]=f.tenants;
      for(const id of ['a','b']){const health=await f.request(A,'GET','/health',undefined,f.workers.get(id).port);assert.equal(health.status,200);assert.equal(health.body.healthy,0);assert.equal(health.body.deferred,1);assert.equal(health.body.tenants[0].ready,false);}
      const completedConsumer='evaluator-sharding-native-completed';
      // Pause/control receipts may be acknowledged without clinical computation.
      const rows=(await f.lab.admin.query('SELECT consumer,output_revision::text AS checkpoint FROM "'+ns.evaluatorCheckpoint+'".tenant_consumer_checkpoint WHERE consumer=$1 ORDER BY tenant_id',[completedConsumer])).rows;
      console.log('SHARD_PAUSED_CLINICAL_PROGRESS '+JSON.stringify({rows:rows.length,consumer:completedConsumer,revisions:rows.map(row=>row.checkpoint)}));
      assert.equal(rows.length,f.tenants.length,'SHARD_ALL_PAUSED actual provisioned clinical output rows');
      assert.ok(rows.every(row=>row.consumer===completedConsumer&&row.checkpoint==='0'),'SHARD_ALL_PAUSED no synthetic clinical output progress');
      assert.equal((await f.request(A,'GET','/socket.io/?EIO=4&transport=polling',undefined,f.workers.get('a').port)).status,403);
      const adapter=require('../lib/server/realtime/alarm-transport').createSliceAdapter({peers:f.peers});
      await assert.rejects(new Promise((resolve,reject)=>adapter.send({tenant:A,id:randomUUID(),attempt:1,notification:{level:1,title:'synthetic paused'},receipts:[]},(error,value)=>error?reject(error):resolve(value))),/REALTIME_HANDOFF_UNAVAILABLE/);
      await f.setActivity(A,'unpause');
      agent=new http.Agent({lookup:(host,options,done)=>options.all?done(null,[{address:'127.0.0.1',family:4}]):done(null,'127.0.0.1',4)});
      socket=io('http://'+f.hosts.get(A),{forceNew:true,transports:['polling'],agent,reconnectionDelay:50,reconnectionDelayMax:200});let frame;
      socket.on('connect',()=>socket.emit('authorize',{secret:hash(f.roots.get(A))}));socket.on('dataUpdate',value=>{frame=value;});
      await f.until(()=>frame?.sgvs.some(row=>row.mgdl===120),'resumed actual tenant current frame');
      const resumed=(await f.lab.admin.query('SELECT output_revision::text AS revision FROM "'+ns.evaluatorCheckpoint+'".tenant_consumer_checkpoint WHERE tenant_id=$1 AND consumer=$2',[A,completedConsumer])).rows;
      assert.equal(resumed.length,1);assert.ok(BigInt(resumed[0].revision)>0n,'SHARD_ALL_PAUSED resumed actual clinical progress is measurable');
      const quiet=(await f.lab.admin.query('SELECT consumer,output_revision::text AS checkpoint FROM "'+ns.evaluatorCheckpoint+'".tenant_consumer_checkpoint WHERE tenant_id=$1 AND consumer=$2',[B,completedConsumer])).rows;
      assert.equal(quiet.length,1);assert.equal(quiet[0].consumer,completedConsumer);
      assert.equal(quiet[0].checkpoint,'0','SHARD_ALL_PAUSED B remains clinically quiet');
    }finally{socket?.close();agent?.destroy();await f.cleanup();}
  });
  it('SHARD_LIVE_ADD: actual running owners admit a new registry tenant only on its assigned shard without process restart', async function () {
    const f = require('./fixtures/realtime-sharding-native')(); let socket, agent;
    try {
      await f.setup();
      const before = new Map([...f.workers].map(([id,row])=>[id,row.child.pid]));
      let tenant; do { tenant=randomUUID(); } while(require('../lib/pool-membership/slice').bucket(tenant,2)!==0);
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
  it('SHARD_NATIVE_REPLACE: polling/WebSocket/API3, alarm origin, receipts and healthy neighbour survive same-ordinal replacement without another input write', async function () {
    const f=require('./fixtures/realtime-sharding-native')(),sockets=[],agents=[];
    const agent=()=>{const value=new http.Agent({keepAlive:true,lookup:(host,options,done)=>options.all?done(null,[{address:'127.0.0.1',family:4}]):done(null,'127.0.0.1',4)});agents.push(value);return value;};
    const frameClient=(tenant,transport)=>{const socket=io('http://'+f.hosts.get(tenant),{forceNew:true,transports:[transport],agent:agent(),reconnectionDelay:50,reconnectionDelayMax:200,timeout:1000}),seen={socket,frames:[],connections:0,errors:[]};socket.on('connect',()=>{seen.connections++;socket.emit('authorize',{secret:hash(f.roots.get(tenant))});});socket.on('connect_error',error=>{if(seen.errors.length<5)seen.errors.push(error.message);});socket.on('dataUpdate',value=>seen.frames.push(value));sockets.push(socket);return seen;};
    const subscription=(tenant,namespace,transport)=>{const socket=io('http://'+f.hosts.get(tenant)+namespace,{forceNew:true,transports:[transport],agent:agent(),reconnectionDelay:50,reconnectionDelayMax:200,timeout:1000}),seen={socket,acks:[],alarms:[],changes:[]};socket.on('connect',()=>socket.emit('subscribe',{accessToken:f.credentials.get(tenant),...(namespace==='/storage'?{collections:['entries']}:{})},reply=>seen.acks.push(reply)));socket.on('alarm',value=>seen.alarms.push(value));for(const event of ['create','update','delete'])socket.on(event,value=>seen.changes.push({event,value}));sockets.push(socket);return seen;};
    const alarm=(adapter,tenant,title)=>new Promise((resolve,reject)=>adapter.send({tenant,id:randomUUID(),attempt:1,notification:{level:1,title,originGeneration:'7'},receipts:[]},(error,value)=>error?reject(error):resolve(value)));
    try{
      const {ns}=await f.setup(),[A,B]=f.tenants;await f.unrelatedScopeControl();
      const a=frameClient(A,'polling'),b=frameClient(B,'websocket'),storage=subscription(A,'/storage','websocket'),alarmA=subscription(A,'/alarm','polling'),alarmB=subscription(B,'/alarm','websocket');
      await f.until(()=>a.frames.length&&b.frames.length&&storage.acks.some(ack=>ack.success)&&alarmA.acks.some(ack=>ack.success)&&alarmB.acks.some(ack=>ack.success),'all real static namespaces authorized');
      assert(a.frames.at(-1).sgvs.some(row=>row.mgdl===120));assert(b.frames.at(-1).sgvs.some(row=>row.mgdl===121));assert.equal(a.socket.io.engine.transport.name,'polling');assert.equal(b.socket.io.engine.transport.name,'websocket');
      const bSession=b.socket.id,bPid=f.workers.get('b').child.pid;
      assert.equal((await f.request(A,'GET','/socket.io/?EIO=4&transport=polling',undefined,f.workers.get('b').port)).status,403,'SHARD_NATIVE_WRONG_OWNER_REFUSED');
      const adapter=require('../lib/server/realtime/alarm-transport').createSliceAdapter({peers:f.peers});assert.equal((await alarm(adapter,A,'synthetic before replacement')).accepted,true);await f.until(()=>alarmA.alarms.length===1,'initial transport handoff');assert.equal(alarmB.alarms.length,0);assert.equal(alarmA.alarms[0].originGeneration,'7');
      const checkpoints=async()=>(await f.lab.admin.query('SELECT consumer,output_completed::text AS checkpoint,contract_digest FROM "'+ns.checkpoint+'".tenant_consumer_checkpoint WHERE tenant_id=$1',[A])).rows;
      await f.until(async()=>BigInt((await checkpoints())[0]?.checkpoint||'0')>0n,'durable output acknowledgement');const before=await checkpoints();assert.equal(before.length,1);
      const baseline=await f.request(A,'GET','/api/v3/entries');assert.equal(baseline.status,200);const removed=baseline.body.result[0].identifier;
      const old=f.workers.get('a'),oldFrameCount=a.frames.length,oldStorageAcks=storage.acks.length,oldAlarmAcks=alarmA.acks.length,stoppedAt=Date.now();
      const status=await require('../lib/server/internal-api/clients').lifecycleParticipant({socketPath:f.map.workers[0].address.socket,maxBytes:1048576,timeoutMs:5000}).getStatus({request:randomUUID()});
      const owners=(await f.lab.admin.query("SELECT pid FROM pg_stat_activity WHERE usename=$1 AND application_name='nightscout-realtime-owner'",[f.lab.roles.realtime])).rows;
      const ownerPid=owners.find(row=>status.backends.some(backend=>backend.pid===row.pid))?.pid;assert(ownerPid,'STATIC_ACTUAL_OWNER_BACKEND_IDENTIFIED');
      await f.lab.admin.query('SELECT pg_terminate_backend($1)',[ownerPid]);await f.until(()=>old.exit,'actual lost owner process exits for platform replacement');assert.equal(old.exit.code,1);await f.stop(old);
      await f.until(()=>!a.socket.connected&&!storage.socket.connected,'old transports closed');
      await assert.rejects(alarm(adapter,A,'synthetic while absent'),/REALTIME_HANDOFF_UNAVAILABLE/);assert.equal(alarmA.alarms.length,1);
      // Commit while A is absent. Its replacement must recover this durable
      // output revision without a second source write to trigger the wake.
      assert.equal((await f.request(A,'DELETE','/api/v3/entries/'+removed)).status,200);
      assert.equal((await f.request(B,'POST','/api/v3/entries',{identifier:'during-a-replacement',type:'sgv',date:Date.now(),utcOffset:0,app:'synthetic-sharding',sgv:155})).status,201);
      await f.until(()=>b.frames.some(frame=>frame.sgvs.some(row=>row.mgdl===155)),'healthy B during A absence');assert.equal(b.socket.id,bSession);assert.equal(f.workers.get('b').child.pid,bPid);
      assert.equal((await alarm(adapter,B,'synthetic B during neighbour absence')).accepted,true);await f.until(()=>alarmB.alarms.length===1,'healthy B handoff');assert.equal(a.frames.length,oldFrameCount,'terminated owner cannot publish');
      const replacement=await f.startRealtime('a');assert.notEqual(replacement.child.pid,old.child.pid);
      await f.until(()=>a.frames.length>oldFrameCount&&storage.acks.length>oldStorageAcks&&alarmA.acks.length>oldAlarmAcks,'same ordinal reconnect/current frame without another input');
      assert.equal(a.frames.at(-1).delta,false);assert.deepEqual(a.frames.at(-1).sgvs,[]);const reloaded=await f.request(A,'GET','/api/v3/entries');assert.equal(reloaded.status,200);assert.deepEqual(reloaded.body.result,[]);
      assert.equal(alarmA.alarms.length,1,'transport acceptance is not replayed by reconnect');assert.equal((await alarm(adapter,A,'synthetic after replacement')).accepted,true);await f.until(()=>alarmA.alarms.length===2,'replacement exact ordinal alarm');
      const after=await checkpoints();assert.equal(after.length,1);assert.equal(after[0].consumer,before[0].consumer);assert.equal(after[0].contract_digest,before[0].contract_digest);assert(BigInt(after[0].checkpoint)>=BigInt(before[0].checkpoint));assert.equal(b.socket.id,bSession);assert.equal(b.connections,1);
      const backends=(await f.lab.admin.query("SELECT application_name,count(*)::int AS count FROM pg_stat_activity WHERE usename=$1 GROUP BY application_name",[f.lab.roles.realtime])).rows;assert.equal(backends.find(row=>row.application_name==='nightscout-realtime-owner')?.count,2);assert((backends.find(row=>row.application_name==='nightscout-realtime-preview')?.count||0)<=8);
      // Revoking an alias closes admission at the actual registry resolver; no
      // static routing table or process restart is needed.
      const canonicalHost=require('../lib/tenant-resolution').hostname(f.hosts.get(A));
      const revoked=await f.lab.admin.query('DELETE FROM "'+f.lab.namespaces.registry+'".tenant_registry_hosts WHERE host=$1 RETURNING host',[canonicalHost]);assert.equal(revoked.rowCount,1,'STATIC_REVOKES_ACTUAL_CANONICAL_ALIAS');
      await f.until(async()=>(await f.request(A,'GET','/socket.io/?EIO=4&transport=polling',undefined,replacement.port)).status===403,'revoked alias refused by actual owner');assert.equal(b.socket.id,bSession);
      console.log('STATIC_REALTIME_REPLACEMENT '+JSON.stringify({sameOrdinal:0,count:2,recoveryMs:Date.now()-stoppedAt,oldTerminated:true,withoutNewInputAfterRestart:true,healthyNeighbourUnchanged:true}));
    }finally{for(const socket of sockets)socket.close();for(const value of agents)value.destroy();await f.cleanup();}
  });
});
