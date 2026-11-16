'use strict';
// Connected actual /storage proof inside the existing owned recovery cohort.
// Synthetic typed-ID mutations commit through the actual product clock.
// The separate client-write parity phase still owns public API mutation equivalence.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const oracle=require('./storage-oracle');
module.exports=async function start({input,roles,admin,connect,realtimeConfig}){
  const clockWrite=require('./clock-write');
  const config=roles.config,clients=[],foreign=[],ownedSockets=[],subscriptions=[],observations={classification:'actual connected storage; inherited typed-ID delete-wire ambiguity; no universal client-cache or native binary claim'};
  const limits={maxRows:realtimeConfig.maxRows,maxBytes:realtimeConfig.maxBytes};
  const identifier=crypto.randomBytes(12).toString('hex'),marker='synthetic-revoked-'+crypto.randomUUID();let exercised=false,closed=false;
  const q=name=>{assert.match(name,/^[a-z][a-z0-9_]{0,62}$/);return '"'+name+'"';};
  const food=q(config.namespaces.food)+'.food';
  const entries=q(config.entriesNamespace)+'.entries',clock=q(config.clockNamespace)+'.tenant_write_clock',checkpoint=q(realtimeConfig.completedOutput.namespace)+'.tenant_consumer_checkpoint';
  const mutate=(deleted,write)=>clockWrite({admin,namespace:config.clockNamespace,tenant:config.tenant,deleted},write);
  const grants=q(config.authorizationNamespace)+'.tenant_authorization_subject_roles';
  function record(extra={}){Object.assign(observations,extra);fs.writeFileSync(path.join(input.captureDir,'actual-storage-proof.json'),JSON.stringify(observations,null,2)+'\n');}
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function wait(check,label){const deadline=Date.now()+config.timeoutMs;while(Date.now()<deadline){const value=await check();if(value)return value;await pause(10);}throw new Error(label);}
  const rows=async tenant=>oracle.bounded((await admin.query('SELECT id_kind,doc FROM '+entries+' WHERE tenant_id=$1 ORDER BY id_kind,doc->>\'_id\' LIMIT $2',[tenant,limits.maxRows+1])).rows,limits);
  const floor=async()=> (await admin.query('SELECT last_stamp FROM '+clock+' WHERE tenant_id=$1',[config.tenant])).rows;
  const events=group=>oracle.eventSnapshots(group,limits);
  async function projection(check){return wait(async()=>{
    const row=(await admin.query('SELECT checkpoint,projection FROM '+checkpoint+' WHERE tenant_id=$1 AND consumer=$2',[config.tenant,realtimeConfig.completedOutput.consumer+'-completed'])).rows[0];
    record({lastCheckpoint:row});return check(row)?row:null;
  },'STORAGE_ACTUAL_PROJECTION_BOUNDARY_NOT_OBSERVED');}
  async function socket(transport,host,credentialEnv,target){
    const credential=JSON.parse(input.env[credentialEnv]);assert.equal(typeof credential.token,'string','actual signed main token required');
    const client=await connect({transport,host,namespace:'/storage'});ownedSockets.push(client);const item={socket:client,transport,events:[]};target.push(item);
    for(const event of ['create','update','delete'])client.on(event,value=>{item.events.push({event,value});oracle.bounded(item.events,limits);record({clients:events(clients),foreignClients:events(foreign)});});
    const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('STORAGE_SUBSCRIBE_NOACK')),config.timeoutMs);
      client.emit('subscribe',{accessToken:credential.token,collections:['entries','food']},value=>{clearTimeout(timer);resolve(value);});});
    subscriptions.push({tenant:host===config.host?'A':'B',transport,host,result});record({subscriptions});assert.deepEqual(result,{success:true,collections:['entries','food']});return credential.token;
  }
  async function close(){if(closed)return;closed=true;for(const socket of ownedSockets)socket.close();record({socketsClosed:true});}
  try{
    assert.equal(roles.owned.tenant,config.tenant);assert.equal(roles.owned.foreignTenant,config.foreignTenant);
    assert.equal(roles.owned.entriesNamespace,config.entriesNamespace);assert.equal(roles.owned.authorizationNamespace,config.authorizationNamespace);
    const resource=roles.owned.resources.filter(row=>row.kind==='postgres');assert.equal(resource.length,1);
    const endpoint=new URL(input.env.NS_TEST_POSTGRES_ADMIN_URI);assert.equal(endpoint.hostname,resource[0].host);assert.equal(Number(endpoint.port||5432),resource[0].port);assert.equal(decodeURIComponent(endpoint.pathname.slice(1)),resource[0].database);
    assert(Number.isSafeInteger(config.observationMs)&&config.observationMs>0&&config.observationMs<=60000);
    let token;
    for(const transport of ['polling','websocket']){
      token=await socket(transport,config.host,config.credentialEnv,clients);
      await socket(transport,config.foreignHost,config.foreignCredentialEnv,foreign);
    }
    const beforeForeign=await rows(config.foreignTenant),beforeClock=await floor();assert.equal(beforeClock.length,1);
    const beforeA=await rows(config.tenant);assert(!beforeA.some(row=>row.doc._id===identifier));
    record({baseline:{clock:beforeClock,foreignRows:beforeForeign,rows:beforeA,consumer:realtimeConfig.completedOutput.consumer+'-completed',checkpointNamespace:realtimeConfig.completedOutput.namespace}});
    const now=Date.now(),base={_id:identifier,type:'sgv',date:now,dateString:new Date(now).toISOString(),device:'synthetic-storage-proof'};
    const object={id_kind:'objectid',doc:{...base,sgv:111}},string={id_kind:'string',doc:{...base,sgv:222}},updated={id_kind:'string',doc:{...base,sgv:333}};
    const expected=[];
    const stage=async(name,twins)=>{
      const physical={stage:name,id:identifier,twins:(await rows(config.tenant)).filter(row=>row.doc._id===identifier),
        clockBefore:beforeClock,clockAfter:await floor(),foreignBefore:beforeForeign,foreignAfter:await rows(config.foreignTenant),clients:events(clients),foreignClients:events(foreign)};
      oracle.typed(physical,{twins,events:expected},record);
    };
    return Object.freeze({
      async exercise(){
        assert(!exercised);exercised=true;
        await mutate(false,stamp=>{object.doc.srvModified=stamp;string.doc.srvModified=stamp;return admin.query('INSERT INTO '+entries+' (tenant_id,id_kind,doc) VALUES($1,$2,$3::jsonb),($1,$4,$5::jsonb)',[config.tenant,'objectid',JSON.stringify(object.doc),'string',JSON.stringify(string.doc)]);});
        expected.push(oracle.single('create',object),oracle.single('create',string));
        await wait(()=>clients.every(client=>client.events.filter(row=>row.event==='create'&&row.value.doc?.identifier===identifier).length>=2),'STORAGE_TYPED_CREATES_NOT_OBSERVED');
        await stage('create',[object,string]);
        await mutate(false,stamp=>{updated.doc.srvModified=stamp;return admin.query('UPDATE '+entries+' SET doc=$3::jsonb WHERE tenant_id=$1 AND id_kind=\'string\' AND doc->>\'_id\'=$2',[config.tenant,identifier,JSON.stringify(updated.doc)]);});
        expected.push(oracle.single('update',updated));
        await wait(()=>clients.every(client=>client.events.some(row=>row.event==='update'&&row.value.doc?.identifier===identifier&&row.value.doc.sgv===333)),'STORAGE_TYPED_UPDATE_NOT_OBSERVED');
        await stage('update',[object,updated]);
        await mutate(true,()=>admin.query('DELETE FROM '+entries+' WHERE tenant_id=$1 AND id_kind=\'objectid\' AND doc->>\'_id\'=$2',[config.tenant,identifier]));expected.push(oracle.single('delete',object));
        await wait(()=>clients.every(client=>client.events.some(row=>row.event==='delete'&&row.value.identifier===identifier)),'STORAGE_TYPED_DELETE_NOT_OBSERVED');
        await stage('delete',[updated]);record({typedWireAmbiguity:{identifier,physicalKinds:['objectid','string'],normalizedIdentifierShared:true,deleteDoesNotIdentifyKind:true}});
        // Live raw CRUD is independent of clinical membership. Use public IDs
        // distinct from physical IDs so FULL old identity is observable on wire.
        const oldId='synthetic-old-'+crypto.randomUUID(),foodId='synthetic-food-'+crypto.randomUUID();
        const old={id_kind:'string',doc:{_id:oldId,identifier:'public-'+oldId,type:'sgv',sgv:139,date:now-4*86400000,dateString:new Date(now-4*86400000).toISOString()}};
        const meal={id_kind:'string',doc:{_id:foodId,identifier:'public-'+foodId,name:'synthetic raw food',carbs:12}};
        const expect=async(event,row,domain,groups=clients)=>{
          const wanted=oracle.single(event,row,domain);
          await wait(()=>groups.every(client=>client.events.some(item=>require('node:util').isDeepStrictEqual(item,wanted))),'STORAGE_RAW_'+domain.toUpperCase()+'_'+event.toUpperCase()+'_MISSING');
          for(const client of foreign)assert.deepEqual(client.events,[],'STORAGE_RAW_FOREIGN_WIRE_UNCHANGED');
          return wanted;
        };
        await mutate(false,stamp=>{old.doc.srvModified=stamp;return admin.query('INSERT INTO '+entries+'(tenant_id,id_kind,doc) VALUES($1,\'string\',$2::jsonb)',[config.tenant,JSON.stringify(old.doc)]);});
        const oldWire=await expect('create',old,'entries');
        await mutate(false,stamp=>{meal.doc.srvModified=stamp;return admin.query('INSERT INTO '+food+'(tenant_id,id_kind,doc) VALUES($1,\'string\',$2::jsonb)',[config.tenant,JSON.stringify(meal.doc)]);});
        await expect('create',meal,'food');
        await mutate(false,stamp=>{meal.doc={...meal.doc,carbs:23,srvModified:stamp};return admin.query('UPDATE '+food+' SET doc=$3::jsonb WHERE tenant_id=$1 AND doc->>\'_id\'=$2',[config.tenant,foodId,JSON.stringify(meal.doc)]);});
        await expect('update',meal,'food');
        await mutate(true,()=>admin.query('DELETE FROM '+food+' WHERE tenant_id=$1 AND doc->>\'_id\'=$2',[config.tenant,foodId]));
        await expect('delete',meal,'food');
        const rawStamp=String((await floor())[0].last_stamp);
        const bounded=await projection(row=>BigInt(row?.checkpoint||0)>=BigInt(rawStamp));
        assert(!bounded.projection[0].output.frame.sgvs.some(row=>row._id===oldId),'OLD_RAW_ENTRY_MUST_NOT_ENTER_CLINICAL_FRAME');
        const input=(await admin.query('SELECT projection->0 AS clinical FROM '+checkpoint+' WHERE tenant_id=$1 AND consumer=$2',[config.tenant,realtimeConfig.completedOutput.consumer])).rows[0].clinical;
        assert(!input.rows.some(row=>row.domain==='entries'&&row.doc._id===oldId),'OLD_RAW_ENTRY_MUST_NOT_ENTER_CLINICAL_WINDOW');
        record({rawOutsideClinical:{oldWire,completedCheckpoint:bounded.checkpoint,publicFoodIdentifier:meal.doc.identifier}});
        // A newly subscribed stock client starts at current high water. It
        // receives neither historical population nor events from its offline gap.
        const fresh=[];
        for(const transport of ['polling','websocket'])await socket(transport,config.host,config.credentialEnv,fresh);
        await pause(config.observationMs);
        for(const client of fresh)assert.deepEqual(client.events,[],'STORAGE_RECONNECT_MUST_NOT_REPLAY_OLD_TAIL');
        const follow={id_kind:'string',doc:{_id:'synthetic-follow-'+crypto.randomUUID(),name:'synthetic after reconnect',carbs:4}};
        await mutate(false,stamp=>{follow.doc.srvModified=stamp;return admin.query('INSERT INTO '+food+'(tenant_id,id_kind,doc) VALUES($1,\'string\',$2::jsonb)',[config.tenant,JSON.stringify(follow.doc)]);});
        await expect('create',follow,'food',[...clients,...fresh]);
        await mutate(true,()=>admin.query('DELETE FROM '+food+' WHERE tenant_id=$1 AND doc->>\'_id\'=$2',[config.tenant,follow.doc._id]));
        await expect('delete',follow,'food',[...clients,...fresh]);
        for(const client of fresh){assert.equal(client.events.length,2,'STORAGE_RECONNECT_EXACT_LIVE_CRUD');client.socket.close();}
        record({reconnectHighWater:{clients:events(fresh),noOfflineReplay:true}});
        // Exercise an actual membership edge without deleting source storage.
        // The common due scheduler must perform time-only clinical completion;
        // its independent raw tail must emit no fabricated storage deletion.
        const expiryId='synthetic-expiry-'+crypto.randomUUID(),edge=Date.now()+5000;
        const expires={_id:expiryId,type:'sgv',sgv:138,date:edge-2*86400000,dateString:new Date(edge-2*86400000).toISOString()};
        await mutate(false,stamp=>{expires.srvModified=stamp;return admin.query('INSERT INTO '+entries+'(tenant_id,id_kind,doc) VALUES($1,\'string\',$2::jsonb)',[config.tenant,JSON.stringify(expires)]);});
        await expect('create',{id_kind:'string',doc:expires},'entries');
        const expiryStamp=String((await floor())[0].last_stamp);
        const entering=await projection(row=>String(row?.checkpoint)===expiryStamp);
        const beforeProgress=entering.projection[0].output.result.progress;
        const expired=await projection(row=>String(row?.checkpoint)===expiryStamp&&row.projection[0].output.frame.lastUpdated>edge&&row.projection[0].output.result.progress!==beforeProgress);
        assert.equal(expired.projection[0].output.trigger,'time-only','STORAGE_EXPIRY_ACTUAL_TIME_COMPLETION');
        assert.equal(String((await floor())[0].last_stamp),expiryStamp,'STORAGE_EXPIRY_MUST_NOT_WRITE_SOURCE_CLOCK');
        assert((await rows(config.tenant)).some(row=>row.doc._id===expiryId),'STORAGE_EXPIRY_MUST_KEEP_SOURCE_ROW');
        for(const client of clients)assert(!client.events.some(row=>row.event==='delete'&&row.value.identifier===expiryId),'STORAGE_EXPIRY_MUST_NOT_EMIT_DELETE');
        record({clinicalExpiry:{sourceId:expiryId,inputCheckpoint:expiryStamp,beforeProgress,afterProgress:expired.projection[0].output.result.progress,trigger:expired.projection[0].output.trigger,sourcePreserved:true}});


      },
      async afterRevocation(){
        assert(exercised,'storage exercise must precede existing parent quiet removal and grant tightening');
        // Parent deletes all A entries after exercise. Storage states were
        // subscribed before main clients: wait for their quiet-delete receipt
        // before opening the revocation observation window, not an old wire tail.
        await wait(()=>clients.every(client=>client.events.filter(row=>row.event==='delete'&&row.value.identifier===identifier).length>=2),'STORAGE_PARENT_QUIET_REMOVAL_NOT_OBSERVED');
        const empty=await rows(config.tenant);if(empty.length)throw new Error('STORAGE_PARENT_QUIET_EMPTY_REQUIRED');
        const current=await require('../../../lib/server/internal-api/clients').socketAuthority(realtimeConfig.api).authorizeSocket({host:config.host+':'+roles.ingress.port,tenant:config.tenant,namespace:'/storage',credential:{accessToken:token}});
        const storedGrants=(await admin.query('SELECT role_name FROM '+grants+' WHERE tenant_id=$1 AND subject_id=$2',[config.tenant,config.subjectId])).rows;
        record({revocationCurrent:current,revocationGrants:storedGrants});
        if(current.denied||current.permissions?.read!==false||!Array.isArray(current.collections)||current.collections.length||storedGrants.length)throw new Error('STORAGE_VALID_REVOKED_COLLECTIONS_REQUIRED');
        const starts=clients.map(client=>client.events.length),foreignStarts=foreign.map(client=>client.events.length),before=await floor();
        const doc={_id:marker,type:'sgv',sgv:444,date:Date.now(),device:'synthetic-revoked-storage'};doc.dateString=new Date(doc.date).toISOString();
        await mutate(false,stamp=>{doc.srvModified=stamp;return admin.query('INSERT INTO '+entries+' (tenant_id,id_kind,doc) VALUES($1,\'string\',$2::jsonb)',[config.tenant,JSON.stringify(doc)]);});
        const after=await floor();
        const barrier=await projection(row=>String(row?.checkpoint)===String(after[0].last_stamp)&&row?.projection?.[0]?.kind==='evaluator-work-v2'&&row.projection[0].output?.frame?.sgvs?.some(item=>item._id===marker&&item.mgdl===444));
        const rawTail=(await admin.query('SELECT projection->1 AS storage FROM '+checkpoint+' WHERE tenant_id=$1 AND consumer=$2',[config.tenant,realtimeConfig.completedOutput.consumer])).rows[0].storage;
        record({revocationPipelineBarrier:barrier,revocationRawTail:rawTail});await pause(config.observationMs);
        const physical={marker,grants:storedGrants,current,checkpoint:barrier,rawTail,floor:after[0].last_stamp,clockBefore:before,clockAfter:await floor(),rows:await rows(config.tenant),
          foreignBefore:beforeForeign,foreignAfter:await rows(config.foreignTenant),clients:clients.map((client,i)=>({transport:client.transport,events:client.events.slice(starts[i])})),
          foreignClients:foreign.map((client,i)=>({transport:client.transport,events:client.events.slice(foreignStarts[i])}))};
        oracle.revoked(physical,record);
      },close
    });
  }catch(error){await close();throw error;}
};
