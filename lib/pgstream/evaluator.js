'use strict';
const http=require('node:http');
const checkpoint=require('./checkpoint');
const receiver=require('./receiver');
// Decision stable-evaluator-runtime: one typed terminal code for relevant DDL
// after the startup-verified position. The operator restarts after the migration.
const SCHEMA_TERMINAL='EVALUATOR_SCHEMA_CHANGED_AFTER_STARTUP';
const BINARY_SHA256='cc47552319c1a2ec9c85d7286e366496a5149c9e355a2a891f578333634e5465';
function routes(config){const ns=config.namespaces,w=config.trustedWorker;return [
 {schema:w.settings,table:'tenant_settings',kind:'settings'},
 {schema:w.operatorPolicy,table:'tenant_operator_policy',kind:'policy'},
 {schema:w.activity,table:'tenant_activity',kind:'activity'},
 {schema:w.activity,table:'tenant_lifecycle_windows',kind:'lifecycle'},
 ...require('../storage/clinical-stream-state').DOMAINS.map(domain=>({schema:ns[domain],table:domain,kind:'clinical',domain}))];}
function relevantSchemas(config){
 const selected=config.consumers?.realtime;
 return [...new Set([...Object.values(config.namespaces),...(config.registry?[config.registry.namespace]:[]),
   ...(selected?[selected.outbox.namespace,selected.suppression.namespace]:[])])];
}
async function open({config,connection,onInput,onCommit,onUnavailable,onRecovered,onTerminal,onSourceReady,assignment,clinical,schemaBaseline,notificationRecovery}){
 if(onSourceReady!==undefined&&typeof onSourceReady!=='function')throw new TypeError('Optional source-ready callback must be a function');
 const settings=config.pgstream,selected=routes(config);
 const receiverURLs=config.processAssignment?.receivers||[settings.receiver.url];
 const expected=receiverURLs.flatMap(url=>{const deliveryURL=new URL('pgstream',url).href;return [...selected.map(route=>({url:deliveryURL,schema_name:route.schema,table_name:route.table,event_types:['D','I','U']})),{url:deliveryURL,schema_name:'',table_name:'',event_types:['B','C','M']}];});
 const store=checkpoint.create({connection,namespace:config.namespaces.checkpoint,consumer:config.consumer,maxBytes:config.maxBytes*2,timeIntervalMs:config.timeIntervalMs,typed:true,onCommit,assignment,notificationRecovery});
 // Numeric receiver stages describe actual deliveries, never synthetic work.
 const stages=Object.fromEntries(['httpArrivals','routeRefusals','bodyRefusals','parseRefusals','parsed','receiverInFlight','receiverCompleted','receiverRefusals','schemaStarted','schemaInFlight','schemaCompleted','schemaRefusals','schemaAcknowledged','schemaRepeated'].map(key=>[key,0]));
 const baseline=schemaBaseline||require('./schema-baseline').create({read:(text,values)=>connection.readOnly(text,values),timeoutMs:settings.bounds.recoveryMs});
 const increment=key=>{stages[key]=Math.min(Number.MAX_SAFE_INTEGER,stages[key]+1);};
 const diagnostics=process.env.NS_PGSTREAM_RECEIVER_TRACE==='1'
   ? require('../diagnostics/pgstream-receiver').create() : undefined;
 let server,closed=false,available=false,schemaBlocked=false,sourceReadyNotified=false;
 let readyNotificationQueued=false;
 // With a stable schema there is one source cut: the startup-verified one.
 // A later relevant DDL blocks the source permanently for this process.
 function canResumeVerification(){
   return !closed&&available&&store.available===true&&!schemaBlocked;
 }
 function notifySourceReady(){
   if(!onSourceReady||readyNotificationQueued||!canResumeVerification()||sourceReadyNotified)return;
   readyNotificationQueued=true;
   queueMicrotask(()=>{
     readyNotificationQueued=false;
     if(!canResumeVerification()||sourceReadyNotified)return;
     sourceReadyNotified=true;
     // This disposable wake never joins a clinical cycle or delays its ACK.
     // Lost wakes leave the owner's existing recovery and clinical bounds intact.
     try{Promise.resolve(onSourceReady()).catch(()=>{});}catch{ /* A wake cannot change accepted input. */ }
   });
 }
 async function withdraw(code){available=false;await onUnavailable(code);}
 async function inspectSource(){
       const row=(await connection.readOnly(`SELECT r.rolsuper,r.rolreplication,r.rolbypassrls,
         NOT pg_has_role(r.oid,d.datdba,'MEMBER') AND NOT pg_has_role(r.oid,n.nspowner,'MEMBER') AS nonowner,
         has_schema_privilege(r.oid,n.oid,'USAGE') AND has_schema_privilege(r.oid,n.oid,'CREATE') AND has_table_privilege(r.oid,'pgstream.webhook_subscriptions','SELECT') AND NOT has_table_privilege(r.oid,'pgstream.webhook_subscriptions','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS grants,
         s.database=current_database() AS same_database,s.plugin,s.wal_status,s.restart_lsn
         FROM pg_roles r CROSS JOIN pg_database d CROSS JOIN pg_namespace n LEFT JOIN pg_replication_slots s ON s.slot_name=$2
         WHERE r.rolname=$1 AND d.datname=current_database() AND n.nspname='pgstream'`,[settings.streamRole,settings.slot])).rows[0];
       const subscriptions=(await connection.readOnly('SELECT url,schema_name,table_name,event_types FROM pgstream.webhook_subscriptions')).rows;
       const normalize=rows=>rows.map(value=>JSON.stringify([value.url,value.schema_name,value.table_name,[...(value.event_types||[])].sort()])).sort().join('\n');
       return {identity:!!row&&!row.rolsuper&&!row.rolbypassrls&&row.rolreplication&&row.nonowner&&row.same_database===true&&row.plugin==='wal2json',grants:row?.grants===true&&normalize(subscriptions)===normalize(expected),
         slot:!row?.restart_lsn||row.wal_status==='lost'?'lost':'valid'};
 }
 async function admitSource(){
   const source=await inspectSource();
   if(!source.identity||!source.grants||source.slot!=='valid')throw Object.assign(new Error(source.slot==='lost'?'PGSTREAM_REBOOTSTRAP_REQUIRED':'PGSTREAM_SOURCE_REFUSED'),{code:source.slot==='lost'?'PGSTREAM_REBOOTSTRAP_REQUIRED':'PGSTREAM_SOURCE_REFUSED'});
 }
 // No in-place schema transition: DDL at or before the startup baseline is
 // acknowledged with no invalidation; later relevant DDL refuses its ACK, blocks
 // the feed and stops the role through the existing terminal path.
 const receive=receiver.create({routes:selected,relevantSchemas:relevantSchemas(config),store,onInput,clinical,
   onSchema:async(_schemas,trace,position)=>{
     increment('schemaStarted');
     const disposition=await baseline.observe(position);
     if(disposition!=='after'){increment('schemaAcknowledged');if(disposition==='repeated')increment('schemaRepeated');trace?.mark('schema-baseline-'+disposition);return undefined;}
     schemaBlocked=true;available=false;increment('schemaRefusals');trace?.mark('schema-after-baseline');
     try{onTerminal?.(SCHEMA_TERMINAL);}catch{ /* The refused ACK still holds the event in the slot. */ }
     throw Object.assign(new Error(SCHEMA_TERMINAL),{code:SCHEMA_TERMINAL});
   }});

 try{
   await store.own(async()=>{try{await withdraw('EVALUATOR_OWNER_UNAVAILABLE');}finally{onTerminal?.('EVALUATOR_OWNER_UNAVAILABLE');}});
   await store.admit(config.tenants.keys());
   server=http.createServer(async(req,res)=>{
     increment('httpArrivals');let stage='body',trace;
     try{
       if(req.method==='GET'&&req.url==='/pgstream/ready'){res.writeHead(!closed&&store.available?204:503).end();return;}
       if(closed||req.method!=='POST'||req.url!=='/pgstream'){increment('routeRefusals');res.writeHead(404).end();return;}
       trace=diagnostics?.start(res);
       let bytes=0,body='';for await(const part of req){bytes+=part.length;if(bytes>settings.receiver.maxBytes)throw new Error('PGSTREAM_WEBHOOK_BYTE_BOUND');body+=part;}
       stage='parse';trace?.mark('parse');const event=receiver.parse(body);increment('parsed');trace?.parsed(event,bytes);stage='receive';increment('receiverInFlight');
       try{await receive(event,trace);
         increment('receiverCompleted');trace?.mark('receive-completed');
       }catch(error){increment('receiverRefusals');throw error;}finally{stages.receiverInFlight--;}
       res.writeHead(204).end();
     }catch{trace?.refused();if(stage==='body')increment('bodyRefusals');else if(stage==='parse')increment('parseRefusals');res.writeHead(503).end();}
     finally{notifySourceReady();}
   });
   server.requestTimeout=settings.receiver.timeoutMs;server.headersTimeout=settings.receiver.timeoutMs;
   await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(new URL(settings.receiver.url).port),settings.receiver.bindHost,resolve);});
   diagnostics?.listening();
   await admitSource();
   // Startup verification in onRecovered covers every DDL at or before this position.
   await baseline.capture();
   await onRecovered(store);
   available=true;
   notifySourceReady();
   return Object.freeze({store,canResumeVerification,
     async ready(){if(closed||schemaBlocked||!available||!store.available)throw new Error('PGSTREAM_NOT_READY');},
     assertAvailable(){if(closed||schemaBlocked||!available||!store.available)throw new Error('EVALUATOR_FEED_UNAVAILABLE');},
     health:()=>({healthy:!closed&&!schemaBlocked&&available&&store.available,closed,schemaBlocked,owner:store.available,receiver:{...stages},schema:baseline.stats()}),
     async close(){if(closed)return;closed=true;available=false;if(server)await new Promise(r=>server.close(r));await store.close();}
   });
 }catch(error){closed=true;available=false;if(server)await new Promise(r=>server.close(r));await store.close();throw error;}
}
module.exports={open,routes,relevantSchemas,BINARY_SHA256,SCHEMA_TERMINAL};
