'use strict';
// Connected actual /storage proof inside the existing owned recovery cohort.
// Admin writes deliberately bypass hints/clock; this is not client-write parity.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const oracle=require('./storage-oracle');
module.exports=async function start({input,roles,admin,connect,realtimeConfig}){
  const config=roles.config,clients=[],foreign=[],ownedSockets=[],subscriptions=[],observations={classification:'actual connected storage; inherited typed-ID delete-wire ambiguity; no universal client-cache or native binary claim'};
  const limits={maxRows:realtimeConfig.maxRows,maxBytes:realtimeConfig.maxBytes};
  const identifier=crypto.randomBytes(12).toString('hex'),marker='synthetic-revoked-'+crypto.randomUUID();let exercised=false,closed=false;
  const q=name=>{assert.match(name,/^[a-z][a-z0-9_]{0,62}$/);return '"'+name+'"';};
  const entries=q(config.entriesNamespace)+'.entries',clock=q(config.clockNamespace)+'.tenant_write_clock',checkpoint=q(realtimeConfig.namespaces.checkpoint)+'.tenant_consumer_checkpoint';
  const grants=q(config.authorizationNamespace)+'.tenant_authorization_subject_roles';
  function record(extra={}){Object.assign(observations,extra);fs.writeFileSync(path.join(input.captureDir,'actual-storage-proof.json'),JSON.stringify(observations,null,2)+'\n');}
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function wait(check,label){const deadline=Date.now()+config.timeoutMs;while(Date.now()<deadline){const value=await check();if(value)return value;await pause(10);}throw new Error(label);}
  const rows=async tenant=>oracle.bounded((await admin.query('SELECT id_kind,doc FROM '+entries+' WHERE tenant_id=$1 ORDER BY id_kind,doc->>\'_id\' LIMIT $2',[tenant,limits.maxRows+1])).rows,limits);
  const floor=async()=> (await admin.query('SELECT last_stamp FROM '+clock+' WHERE tenant_id=$1',[config.tenant])).rows;
  const events=group=>oracle.eventSnapshots(group,limits);
  async function projection(check){return wait(async()=>{
    const row=(await admin.query('SELECT checkpoint,projection FROM '+checkpoint+' WHERE tenant_id=$1 AND consumer=$2',[config.tenant,realtimeConfig.consumer])).rows[0];
    record({lastCheckpoint:row});return check(row)?row:null;
  },'STORAGE_ACTUAL_PROJECTION_BOUNDARY_NOT_OBSERVED');}
  async function socket(transport,host,credentialEnv,target){
    const credential=JSON.parse(input.env[credentialEnv]);assert.equal(typeof credential.token,'string','actual signed main token required');
    const client=await connect({transport,host,namespace:'/storage'});ownedSockets.push(client);const item={socket:client,transport,events:[]};target.push(item);
    for(const event of ['create','update','delete'])client.on(event,value=>{item.events.push({event,value});oracle.bounded(item.events,limits);record({clients:events(clients),foreignClients:events(foreign)});});
    const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('STORAGE_SUBSCRIBE_NOACK')),config.timeoutMs);
      client.emit('subscribe',{accessToken:credential.token,collections:['entries']},value=>{clearTimeout(timer);resolve(value);});});
    subscriptions.push({tenant:target===clients?'A':'B',transport,host,result});record({subscriptions});assert.deepEqual(result,{success:true,collections:['entries']});return credential.token;
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
    record({baseline:{clock:beforeClock,foreignRows:beforeForeign,rows:beforeA,consumer:realtimeConfig.consumer,checkpointNamespace:realtimeConfig.namespaces.checkpoint}});
    const now=Date.now(),base={_id:identifier,type:'sgv',date:now,dateString:new Date(now).toISOString(),device:'synthetic-storage-proof'};
    const object={id_kind:'objectid',doc:{...base,sgv:111}},string={id_kind:'string',doc:{...base,sgv:222}},updated={id_kind:'string',doc:{...base,sgv:333}};
    const expected=[oracle.single('create',object),oracle.single('create',string)];
    const stage=async(name,twins)=>{
      const physical={stage:name,id:identifier,twins:(await rows(config.tenant)).filter(row=>row.doc._id===identifier),
        clockBefore:beforeClock,clockAfter:await floor(),foreignBefore:beforeForeign,foreignAfter:await rows(config.foreignTenant),clients:events(clients),foreignClients:events(foreign)};
      oracle.typed(physical,{twins,events:expected},record);
    };
    return Object.freeze({
      async exercise(){
        assert(!exercised);exercised=true;
        await admin.query('INSERT INTO '+entries+' (tenant_id,id_kind,doc) VALUES($1,$2,$3::jsonb),($1,$4,$5::jsonb)',[config.tenant,'objectid',JSON.stringify(object.doc),'string',JSON.stringify(string.doc)]);
        await wait(()=>clients.every(client=>client.events.filter(row=>row.event==='create'&&row.value.doc?.identifier===identifier).length>=2),'STORAGE_TYPED_CREATES_NOT_OBSERVED');
        await stage('create',[object,string]);
        await admin.query('UPDATE '+entries+' SET doc=$3::jsonb WHERE tenant_id=$1 AND id_kind=\'string\' AND doc->>\'_id\'=$2',[config.tenant,identifier,JSON.stringify(updated.doc)]);
        expected.push(oracle.single('update',updated));
        await wait(()=>clients.every(client=>client.events.some(row=>row.event==='update'&&row.value.doc?.identifier===identifier&&row.value.doc.sgv===333)),'STORAGE_TYPED_UPDATE_NOT_OBSERVED');
        await stage('update',[object,updated]);
        await admin.query('DELETE FROM '+entries+' WHERE tenant_id=$1 AND id_kind=\'objectid\' AND doc->>\'_id\'=$2',[config.tenant,identifier]);expected.push(oracle.single('delete',object));
        await wait(()=>clients.every(client=>client.events.some(row=>row.event==='delete'&&row.value.identifier===identifier)),'STORAGE_TYPED_DELETE_NOT_OBSERVED');
        await stage('delete',[updated]);record({typedWireAmbiguity:{identifier,physicalKinds:['objectid','string'],normalizedIdentifierShared:true,deleteDoesNotIdentifyKind:true}});
      },
      async afterRevocation(){
        assert(exercised,'storage exercise must precede existing parent quiet removal and grant tightening');
        // Parent deletes all A entries after exercise. Storage states were
        // subscribed before main clients: wait for their quiet-delete receipt
        // before opening the revocation observation window, not an old wire tail.
        await wait(()=>clients.every(client=>client.events.filter(row=>row.event==='delete'&&row.value.identifier===identifier).length>=2),'STORAGE_PARENT_QUIET_REMOVAL_NOT_OBSERVED');
        const empty=await rows(config.tenant);if(empty.length)throw new Error('STORAGE_PARENT_QUIET_EMPTY_REQUIRED');
        const current=await require('../../../lib/server/realtime/ipc').client(realtimeConfig.api)('/authorize',{host:config.host+':'+roles.ingress.port,tenant:config.tenant,namespace:'/storage',credential:{accessToken:token}});
        const storedGrants=(await admin.query('SELECT role_name FROM '+grants+' WHERE tenant_id=$1 AND subject_id=$2',[config.tenant,config.subjectId])).rows;
        record({revocationCurrent:current,revocationGrants:storedGrants});
        if(current.denied||current.permissions?.read!==false||!Array.isArray(current.collections)||current.collections.length||storedGrants.length)throw new Error('STORAGE_VALID_REVOKED_COLLECTIONS_REQUIRED');
        const starts=clients.map(client=>client.events.length),foreignStarts=foreign.map(client=>client.events.length),before=await floor();
        const doc={_id:marker,type:'sgv',sgv:444,date:Date.now(),device:'synthetic-revoked-storage'};doc.dateString=new Date(doc.date).toISOString();
        await admin.query('INSERT INTO '+entries+' (tenant_id,id_kind,doc) VALUES($1,\'string\',$2::jsonb)',[config.tenant,JSON.stringify(doc)]);
        const barrier=await projection(row=>String(row?.checkpoint)===String(before[0].last_stamp)&&row?.projection?.some(item=>item.domain==='entries'&&item.id_kind==='string'&&item.doc._id===marker));
        record({revocationPipelineBarrier:barrier});await pause(config.observationMs);
        const physical={marker,grants:storedGrants,current,checkpoint:barrier,floor:before[0].last_stamp,clockBefore:before,clockAfter:await floor(),rows:await rows(config.tenant),
          foreignBefore:beforeForeign,foreignAfter:await rows(config.foreignTenant),clients:clients.map((client,i)=>({transport:client.transport,events:client.events.slice(starts[i])})),
          foreignClients:foreign.map((client,i)=>({transport:client.transport,events:client.events.slice(foreignStarts[i])}))};
        oracle.revoked(physical,record);
      },close
    });
  }catch(error){await close();throw error;}
};
