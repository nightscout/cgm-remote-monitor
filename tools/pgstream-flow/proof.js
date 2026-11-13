'use strict';
// Small synthetic local capability proof. Requires its own disposable database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const {spawn} = require('node:child_process');
const lab = require('../../tests/fixtures/tenant-projection-evaluator')();
const scope = require('../../lib/storage/tenant-scope');
const environment = require('../../lib/server/tenant-app/environment');
const {createHash} = require('node:crypto');
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const evidence = process.env.PGSTREAM_FLOW_EVIDENCE;
fs.mkdirSync(evidence,{recursive:true});
const events=[]; const log = x => {events.push(x);fs.appendFileSync(evidence+'/events.jsonl',JSON.stringify(x)+'\n');};
let child,server,sockets,client,protocol;
const current=new Map(),identities=new Map(),components=new Map(),published=new Map(),timers=new Map(),queues=new Map();
let closing=false,eventsSeen=0,evaluations=0,outputs=0,mode='normal', beforePublish=null,crashBeforeAck=false,crashed=false;
let failedInputLsn=null;
let sqlQueries=0;const pgQuery=require('pg').Client.prototype.query;require('pg').Client.prototype.query=function(...args){sqlQueries++;return pgQuery.apply(this,args);};
const ablation=process.env.PGSTREAM_FLOW_ABLATE;
const identity='a'.repeat(64), outputConsumer='pgstream-evaluated-output';
const cfg = tenant=>({tenant,identity:identities.get(tenant)||identity,env:current.get(tenant)||lab.env});
async function waitFor(fn,label,ms=10000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(20);}throw Error('TIMEOUT '+label);}
async function ensureConfig(tenant){if(current.has(tenant))return;const setting=(await scope.withTenant(tenant,()=>lab.reader.query(`SELECT doc FROM "${lab.namespaces.settings}".settings WHERE tenant_id=$1`,[tenant]))).rows[0]?.doc;
  current.set(tenant,setting?environment({settings:setting.settings,extendedSettings:setting.extendedSettings}):lab.env);if(setting)identities.set(tenant,digest(setting));}
async function loadOutput(tenant){const row=await lab.checkpoint(outputConsumer,tenant);return row?.projection?.[0]||null;}
async function evaluate(tenant,timeOnly=false){
  if(![lab.A,lab.B].includes(tenant))throw Error('FOREIGN_TENANT');
  let component=components.get(tenant);
  await ensureConfig(tenant);
  if(!component){component=lab.evaluator(tenant,{env:cfg(tenant).env,includeFrame:true});components.set(tenant,component);timeOnly=false;}
  const result=await (timeOnly?component.evaluateTime({at:Date.now()}):component.evaluate({at:Date.now()}));evaluations++;
  if(beforePublish){const hook=beforePublish;beforePublish=null;await hook(result);}
  const old=await loadOutput(tenant);
  const content=digest({properties:result.properties,emitted:result.emitted,requested:result.requested,frame:{...result.frame,lastUpdated:0}});
  const revision=old?.content===content?old.revision:(old?.revision||0)+1;
  const nextDueAt=Math.min(result.due?.dueAt??Infinity,result.due?.slow?.length?Date.now()+60000:Infinity);
  const value={tenant,identity:cfg(tenant).identity,nextDueAt:Number.isFinite(nextDueAt)?nextDueAt:null,checkpoint:result.checkpoint,signature:result.signature,revision,content,result,frame:result.frame,rows:(await lab.checkpoint('clinical-view',tenant)).projection.map(row=>({domain:row.domain,document:require('../../lib/storage/postgres-identity').decodeDocument(row)}))};
  // A distinct existing checkpoint consumer stores the completed output, never the acquired-only row.
  await scope.withTenant(tenant,()=>lab.reader.transaction(async()=>{
    await lab.reader.query(`UPDATE "${lab.replayNamespace}".tenant_consumer_checkpoint SET checkpoint=$3,projection=$4::jsonb WHERE tenant_id=$1 AND consumer=$2`,[tenant,outputConsumer,result.checkpoint,JSON.stringify([value])]);
  }));outputs++;log({kind:'durable-output',tenant,revision,checkpoint:result.checkpoint,mean:result.properties.bgnow?.mean,trigger:result.trigger});
  armDue(tenant,value);
  return value;
}
function armDue(tenant,value){clearTimeout(timers.get(tenant));if(Number.isFinite(value.nextDueAt)&&!closing)timers.set(tenant,setTimeout(()=>enqueue(tenant,true).catch(e=>log({error:e.message})),Math.max(1,value.nextDueAt-Date.now())));}
async function loseCachesAndRecoverDue(){for(const c of components.values())c.close();components.clear();current.clear();identities.clear();for(const timer of timers.values())clearTimeout(timer);timers.clear();for(const tenant of [lab.A,lab.B]){const value=await loadOutput(tenant);if(value)armDue(tenant,value);}}
function enqueue(tenant,timeOnly=false){const previous=queues.get(tenant)||Promise.resolve();const next=previous.catch(()=>{}).then(()=>scope.withTenant(tenant,()=>evaluate(tenant,timeOnly)));queues.set(tenant,next);return next;}
async function deliver(tenant){const next=await loadOutput(tenant);if(!next)return;const previous=published.get(tenant);published.set(tenant,next);await protocol.fanout({tenant,previous,next});}
async function body(req){let data='';for await(const b of req){data+=b;if(data.length>1048576)throw Error('BODY_BOUND');}return JSON.parse(data);}
function startFeed(){const out=fs.openSync(evidence+'/pgstream.log','a');child=spawn(process.env.PGSTREAM_BINARY,['run','-c',evidence+'/config.yaml','--init','--log-level','info'],{stdio:['ignore',out,out]});return child;}
async function stopFeed(){if(!child||child.exitCode!==null||child.signalCode!==null)return;const c=child;c.kill('SIGTERM');await Promise.race([new Promise(r=>c.once('exit',r)),sleep(5000)]);if(c.exitCode===null){c.kill('SIGKILL');await new Promise(r=>c.once('exit',r));}}
(async()=>{
  await lab.open(); await lab.provisionView(lab.A);await lab.provisionView(lab.B);
  await lab.admin.query(`GRANT USAGE ON SCHEMA "${lab.namespaces.settings}" TO "${lab.readerRole}"`);
  await lab.admin.query(`GRANT SELECT ON "${lab.namespaces.settings}".settings TO "${lab.readerRole}"`);
  lab.env=environment({settings:{enable:['bgnow','simplealarms','timeago'],alarmTimeagoWarn:true,alarmTimeagoWarnMins:1,thresholds:{bgHigh:200,bgTargetTop:180,bgTargetBottom:80,bgLow:55}},extendedSettings:{timeago:{enableAlerts:true}}});
  for(const tenant of [lab.A,lab.B])await lab.admin.query(`INSERT INTO "${lab.replayNamespace}".tenant_consumer_checkpoint(tenant_id,consumer,contract_digest,checkpoint,projection)VALUES($1,$2,$3,0,NULL)`,[tenant,outputConsumer,identity]);
  protocol=require('../../lib/server/realtime/protocol').create({admission:{resolve:async req=>req.headers.host.startsWith('b.')?lab.B:lab.A},
    api:{authorizeSocket:async ({tenant})=>({tenant,principal:{kind:'anonymous'},permissions:{read:true,write:false,write_treatment:false,ack:false},collections:['entries']}),executeSocketMutation:async()=>{throw Error('READ_ONLY');}},
    readCurrent:async tenant=>{await ensureConfig(tenant);return cfg(tenant);},runtime:()=>({refresh:async tenant=>loadOutput(tenant),last:tenant=>published.get(tenant)}),domains:['entries']});
  server=http.createServer(async(req,res)=>{try{
    if(req.method!=='POST'){res.writeHead(404).end();return;}
    const event=await body(req);eventsSeen++;fs.appendFileSync(evidence+'/payloads.jsonl',JSON.stringify({path:req.url,event})+'\n');
    if(mode==='permanent'){failedInputLsn=(event.Data||event.data).lsn;log({kind:'forced-http-failure',status:422,path:req.url,eventLsn:failedInputLsn,slot:(await lab.admin.query('SELECT confirmed_flush_lsn::text,restart_lsn::text FROM pg_replication_slots WHERE slot_name=$1',[lab.name+'_slot'])).rows});res.writeHead(422).end();return;}
    if(mode==='transient'){res.writeHead(503).end();return;}
    const data=event.Data||event.data||event;
    const cols=data.columns||[];const keys=data.identity||[];
    const tenant=[...cols,...keys].find(x=>x.name==='tenant_id')?.value;
    if(!tenant){throw Error('NO_TENANT '+JSON.stringify(event));}
    if(req.url==='/input'){
      if(crashBeforeAck){failedInputLsn=data.lsn;log({kind:'before-input-durability',inputLsn:data.lsn,headers:req.headers,slot:(await lab.admin.query('SELECT confirmed_flush_lsn::text,restart_lsn::text,confirmed_flush_lsn >= $2::pg_lsn AS confirmed_past_input FROM pg_replication_slots WHERE slot_name=$1',[lab.name+'_slot',data.lsn])).rows});
        if(process.env.PGSTREAM_FLOW_CRASH==='before-durable'){crashBeforeAck=false;crashed=true;child.kill('SIGKILL');res.destroy();log({kind:'crash-before-durable-before-ack',tenant});return;}
      }
      if(ablation==='early-ack'){res.writeHead(204).end();return;}
      if(data.table==='settings'){
        const row=(await scope.withTenant(tenant,()=>lab.reader.query(`SELECT doc FROM "${lab.namespaces.settings}".settings WHERE tenant_id=$1`,[tenant]))).rows[0];
        if(!row)throw Error('SETTINGS_MISSING');
        current.set(tenant,environment({settings:row.doc.settings,extendedSettings:row.doc.extendedSettings}));
        identities.set(tenant,digest(row.doc));
        components.get(tenant)?.close();components.delete(tenant);
      }
      await enqueue(tenant);
      if(crashBeforeAck){crashBeforeAck=false;crashed=true;log({kind:'after-output-before-ack',inputLsn:data.lsn,slot:(await lab.admin.query('SELECT confirmed_flush_lsn::text,restart_lsn::text,confirmed_flush_lsn >= $2::pg_lsn AS confirmed_past_input FROM pg_replication_slots WHERE slot_name=$1',[lab.name+'_slot',data.lsn])).rows});child.kill('SIGKILL');res.destroy();log({kind:'crash-after-durable-before-ack',tenant});return;}
    }
    else if(req.url==='/output'){
      const consumer=cols.find(x=>x.name==='consumer')?.value;
      if(consumer===outputConsumer&&!(ablation==='drop-output'&&outputs>2))await deliver(tenant);
    }
    else throw Error('ROUTE');
    res.writeHead(204).end();log({kind:'ack',path:req.url,tenant});
  }catch(e){log({kind:'webhook-error',error:e.message});res.writeHead(503).end();}});
  sockets=require('../../lib/server/realtime/socket-server').attach(server,{protocol,admission:{resolve:async()=>lab.A},maxMessageBytes:1048576});
  await new Promise(r=>server.listen(19913,'127.0.0.1',r));
  const url=process.env.NS_TEST_POSTGRES_ADMIN_URI;
  fs.writeFileSync(evidence+'/config.yaml',`source:\n  postgres:\n    url: "${url}"\n    mode: replication\n    replication:\n      replication_slot: ${lab.name}_slot\n      plugin:\n        add_tables: "${lab.namespaces.entries}.entries,${lab.namespaces.settings}.settings,${lab.replayNamespace}.tenant_consumer_checkpoint"\ntarget:\n  webhooks:\n    subscriptions:\n      store:\n        url: "${url}"\n        cache:\n          enabled: false\n      server:\n        address: "127.0.0.1:19914"\n    notifier:\n      worker_count: 1\n      strict_mode: true\n      client_timeout: 5000\n      constant:\n        max_retries: 1\n        interval: 50\n`);
  startFeed();await waitFor(async()=>{try{return (await fetch('http://127.0.0.1:19914/webhooks/subscribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'http://127.0.0.1:19913/input',event_types:['I','U','D'],schema:lab.namespaces.entries,table:'entries'})})).ok;}catch{return false;}},'subscription');
  for(const [schema,table,path]of [[lab.namespaces.settings,'settings','input'],[lab.replayNamespace,'tenant_consumer_checkpoint','output']]){
    const response=await fetch('http://127.0.0.1:19914/webhooks/subscribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'http://127.0.0.1:19913/'+path,event_types:['I','U','D'],schema,table})});assert(response.ok);
  }
  const at=Date.now();await lab.persistDomains({entries:[{_id:'a',type:'sgv',sgv:123,date:at-58000,dateString:new Date(at-58000).toISOString(),direction:'Flat'}]});
  await waitFor(async()=> (await loadOutput(lab.A))?.result.properties.bgnow?.mean===123,'durable clinical');
  const io=require('socket.io-client');const received=[];client=io('http://127.0.0.1:19913',{transports:['websocket'],extraHeaders:{Host:'a.local'},reconnection:false});client.on('dataUpdate',frame=>{received.push(frame);log({kind:'client-frame',sgvs:frame.sgvs});});
  await waitFor(()=>received.length,'actual client frame');
  await waitFor(async()=> (await loadOutput(lab.A))?.result.trigger==='time-only','due without write',6000);
  log({kind:'PASS',capability:'input-durable-clinical-output-client-and-due'});
  const framesBefore=received.length;
  await lab.persistDomains({entries:[{_id:'a',type:'sgv',sgv:130,date:Date.now(),dateString:new Date().toISOString(),direction:'Flat'}]});
  await waitFor(()=>received.slice(framesBefore).some(f=>f.sgvs?.some(r=>r.mgdl===130)),'connected client output CDC update');
  log({kind:'PASS',capability:'connected-client-output-cdc'});
  const settings={enable:['bgnow','simplealarms'],thresholds:{bgHigh:120,bgTargetTop:110,bgTargetBottom:80,bgLow:55}};
  await scope.withTenant(lab.A,()=>lab.clocks[0].transaction(()=>lab.raw[0].query(`INSERT INTO "${lab.namespaces.settings}".settings(tenant_id,id_kind,doc)VALUES($1,'string',$2::jsonb)`,[lab.A,JSON.stringify({_id:'pgstream-settings',settings})])));
  await waitFor(async()=> (await loadOutput(lab.A))?.result.requested?.some(r=>r.kind==='notify'&&r.eventName==='high'&&r.debug?.thresholds?.bgHigh===120), 'settings clinical outcome');
  log({kind:'PASS',capability:'settings-change-clinical'});
  // An in-flight older clinical result must not acknowledge a newer committed version.
  let release,started;const blocked=new Promise(r=>release=r),seen=new Promise(r=>started=r);
  beforePublish=async result=>{log({kind:'older-generation-held',checkpoint:result.checkpoint});started();await blocked;};
  await lab.persistDomains({entries:[{_id:'a',type:'sgv',sgv:140,date:Date.now(),dateString:new Date().toISOString()}]});
  await Promise.race([seen,sleep(10000).then(()=>{throw Error('TIMEOUT older generation hook');})]);
  await lab.persistDomains({entries:[{_id:'a',type:'sgv',sgv:150,date:Date.now(),dateString:new Date().toISOString()}]});
  const newer=await lab.clock();release();
  await waitFor(async()=>{const row=await loadOutput(lab.A);return row?.result.properties.bgnow?.mean===150&&row.signature.stamp===newer.stamp;},'concurrent newer generation');
  log({kind:'PASS',capability:'concurrent-newer-generation'});
  // Stop before durable completion on a permanent HTTP failure; strict mode must retain retryable WAL.
  mode='permanent';const seenBefore=eventsSeen;
  await lab.persistDomains({entries:[{_id:'b',type:'sgv',sgv:234,date:Date.now(),dateString:new Date().toISOString()}]},lab.B);
  await waitFor(()=>eventsSeen>seenBefore,'permanent delivery');await waitFor(()=>fs.readFileSync(evidence+'/pgstream.log','utf8').includes('stopping webhook notifier...'),'strict notifier stop');
  log({kind:'strict-notifier-stopped',processExited:child.exitCode!==null});
  await stopFeed();
  assert.equal(await loadOutput(lab.B),null,'failed delivery never committed clinical output');
  for(const component of components.values())component.close();components.clear();
  for(const timer of timers.values())clearTimeout(timer);timers.clear();
  mode='normal';startFeed();
  await sleep(150);log({kind:'after-manual-restart',failedEventLsn:failedInputLsn,slot:(await lab.admin.query('SELECT confirmed_flush_lsn::text,restart_lsn::text FROM pg_replication_slots WHERE slot_name=$1',[lab.name+'_slot'])).rows});
  await waitFor(async()=> (await loadOutput(lab.B))?.result.properties.bgnow?.mean===234,'redelivery after restart');
  log({kind:'PASS',capability:'strict-permanent-failure-manual-restart-redelivery'});
  log({kind:'retention',rows:(await lab.admin.query("SELECT slot_name,plugin,confirmed_flush_lsn::text,restart_lsn::text,wal_status,safe_wal_size,current_setting('max_slot_wal_keep_size') AS wal_bound FROM pg_replication_slots WHERE slot_name=$1",[lab.name+'_slot'])).rows});
  // With no due work in the short interval, CDC output delivery must not trigger raw-input evaluation.
  await sleep(150);const quiet={evaluations,eventsSeen,outputs,sqlQueries};await sleep(300);
  assert.equal(evaluations,quiet.evaluations);assert.equal(outputs,quiet.outputs);assert.equal(sqlQueries,quiet.sqlQueries);
  log({kind:'PASS',capability:'quiet-adapter-no-evaluation-or-sql',milliseconds:300,...quiet});
  // Explicit cache-loss simulation: recover persisted due state with no input write.
  await lab.persistDomains({entries:[{_id:'b',type:'sgv',sgv:111,date:Date.now()-58000,dateString:new Date(Date.now()-58000).toISOString()}]},lab.B);
  await waitFor(async()=> (await loadOutput(lab.B))?.result.properties.bgnow?.mean===111,'future due output');
  const future=await loadOutput(lab.B);assert(future.nextDueAt>Date.now(),'future due persisted');
  await loseCachesAndRecoverDue();
  await waitFor(async()=> (await loadOutput(lab.B))?.result.requested?.some(r=>r.eventName==='timeago'),'cache-loss recovered due without write',6000);
  log({kind:'PASS',capability:'cache-loss-recovered-due-no-write'});
  if(process.env.PGSTREAM_FLOW_STOP_AFTER_DUE==='1')return;
  // Persist a new output, lose the HTTP acknowledgement, then replay the same input.
  crashBeforeAck=true;
  await lab.persistDomains({entries:[{_id:'a',type:'sgv',sgv:160,date:Date.now(),dateString:new Date().toISOString()}]});
  await waitFor(()=>crashed,'crash before ack');await waitFor(()=>child.exitCode!==null||child.signalCode!==null,'killed feed');
  const beforeReplay=await loadOutput(lab.A),evaluationBeforeReplay=evaluations;
  await loseCachesAndRecoverDue();startFeed();
  await sleep(150);
  log({kind:'after-restart-checkpoint',inputLsn:failedInputLsn,slot:(await lab.admin.query('SELECT confirmed_flush_lsn::text,restart_lsn::text,confirmed_flush_lsn >= $2::pg_lsn AS confirmed_past_input FROM pg_replication_slots WHERE slot_name=$1',[lab.name+'_slot',failedInputLsn])).rows});
  await waitFor(()=>evaluations>evaluationBeforeReplay,'same input replay');
  const afterReplay=await loadOutput(lab.A);if(process.env.PGSTREAM_FLOW_CRASH==='before-durable'){assert.equal(afterReplay.result.properties.bgnow.mean,160);}else{assert.equal(afterReplay.revision,beforeReplay.revision,'retry keeps content revision');assert.equal(afterReplay.checkpoint,beforeReplay.checkpoint);}
  log({kind:'PASS',capability:'durable-before-ack-redelivery-stable-revision',revision:afterReplay.revision});
  log({kind:'PASS',capability:'thin-flow',eventsSeen,evaluations,outputs});
})().catch(e=>{log({kind:'FAIL',error:e.stack});process.exitCode=1;}).finally(async()=>{closing=true;for(const t of timers.values())clearTimeout(t);await stopFeed();client?.close();protocol?.close();sockets?.close();server?.close();for(const c of components.values())c.close();await Promise.allSettled([...queues.values()]);await lab.admin?.query('SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name=$1',[lab.name+'_slot']);await lab.close();});
