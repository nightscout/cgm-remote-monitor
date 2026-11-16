'use strict';
const http=require('node:http');
const checkpoint=require('./checkpoint');
const deliveryHealth=require('./delivery-health');
const receiver=require('./receiver');
const BINARY_SHA256='f9da5d0c299139db5236b63bdbd5cc20f6e1267db989c51d6444f429150c158b';
function routes(config){const ns=config.namespaces,w=config.trustedWorker;return [
 {schema:ns.clock,table:'tenant_write_clock',kind:'clock'},
 {schema:w.settings,table:'tenant_settings',kind:'settings'},
 {schema:w.operatorPolicy,table:'tenant_operator_policy',kind:'policy'},
 {schema:w.activity,table:'tenant_activity',kind:'activity'},
 {schema:w.activity,table:'tenant_lifecycle_windows',kind:'lifecycle'},
 {schema:ns.clock,table:'nightscout_heartbeat',kind:'heartbeat'}];}
function relevantSchemas(config,intakeProfile){
 const selected=config.consumers?.realtime;
 return [...new Set([...(intakeProfile===undefined?[]:[require('./intake-profile').validate(intakeProfile).binding.membershipNamespace]),...Object.values(config.namespaces),...(config.registry?[config.registry.namespace]:[]),
   ...(selected?[selected.outbox.namespace,selected.suppression.namespace]:[])])];
}
async function open({config,connection,onInput,onCommit,onSchema,onUnavailable,onRecovered,onTerminal,intakeBinding,intakeProfile,controlConnection}){
 const settings=config.pgstream,selected=routes(config);
 if(controlConnection!==undefined&&intakeProfile===undefined||intakeProfile!==undefined&&(!controlConnection||controlConnection===connection))throw new TypeError('PGSTREAM_SELECTED_CONTROL_CONNECTION_REQUIRED');
 const control=controlConnection||connection;
 if(intakeProfile!==undefined){intakeProfile=require('./intake-profile').validate(intakeProfile);if(intakeProfile.binding.namespace!==config.namespaces.checkpoint||intakeProfile.binding.consumer!==config.consumer||intakeProfile.binding.lifecycleNamespace!==config.trustedWorker.activity)throw new TypeError('PGSTREAM_EVALUATOR_INTAKE_PROFILE_BINDING');}
 const deliveryURL=new URL('pgstream',settings.receiver.url).href;
 if(intakeProfile!==undefined)await require('./feed-control').assertReady(control,{profile:intakeProfile,clockNamespace:config.namespaces.clock,role:decodeURIComponent(new URL(config.selectedIntake.controlConnectionString).username)});
 const store=intakeProfile===undefined?checkpoint.create({connection,namespace:config.namespaces.checkpoint,consumer:config.consumer,maxBytes:config.maxBytes*2,timeIntervalMs:config.timeIntervalMs,typed:true,onCommit}):require('./intake-store').create({connection,profile:intakeProfile,onCommit});
 // Fixed numeric stages only: never retain request bodies, schema/tenant names
 // or arbitrary callback errors. Accepted receipts remain the delivery monitor's count.
 const stages=Object.fromEntries(deliveryHealth.RECEIVER_COUNTERS.map(key=>[key,0]));
 const increment=key=>{stages[key]=Math.min(Number.MAX_SAFE_INTEGER,stages[key]+1);};
 let feed,server,closed=false,available=true,schemaBlocked=false,schemaEpoch,recoveryTicket;
 const publication=config.intakeStateSync === undefined ? null : require('./intake-state').publisher({
   getBinding:intakeBinding,...(intakeProfile===undefined?{}:{intakeProfileDigest:store.profile}),stallMs:settings.bounds.stallMs,assignmentRevision:require('./intake-state').selection(config.intakeStateSync).assignmentRevision,
   health:()=>{const h=feed?.health();return h ? {...h,healthy:h.healthy&&!schemaBlocked&&available,heartbeatAgeMs:h.monotonicHeartbeatAgeMs} : null;}});
 async function withdraw(code,signal,details){let publicationError;try{publication?.blocked(code);}catch(error){publicationError=error;}available=false;await onUnavailable(code,details);if(publicationError)throw publicationError;}
 const receive=receiver.create({routes:selected,relevantSchemas:relevantSchemas(config,intakeProfile),store,onInput,...(intakeProfile===undefined?{}:{intakeProfile}),
   onSchema:async schemas=>{increment('schemaStarted');increment('schemaInFlight');const epoch=schemaEpoch=Symbol('schema');
     try{let publicationError;try{publication?.blocked('INTAKE_SCHEMA_CHANGED');}catch(error){publicationError=error;}schemaBlocked=true;
       if(publicationError){await onSchema(schemas);throw publicationError;}
       const revalidate=()=>onSchema(schemas);
       const ticket=publication ? await publication.prepareRecovery(revalidate) : await revalidate();
       // Only the latest completed validation can release the local schema fence.
       // The publication ticket separately fences cohort/authority changes.
       if(schemaEpoch!==epoch)throw Object.assign(new Error('PGSTREAM_SCHEMA_SUPERSEDED'),{code:'PGSTREAM_SCHEMA_SUPERSEDED'});
       schemaBlocked=false;
       // Strict delivery must ACK validated startup DDL before it can deliver
       // the first heartbeat. Transport recovery owns durable reconciliation
       // and ready publication; a schema ACK alone grants neither.
       if(publication&&available&&feed?.health().healthy)publication.ready(ticket);
       increment('schemaCompleted');
     }catch(error){if(schemaEpoch===epoch)schemaBlocked=true;increment('schemaRefusals');throw error;}finally{stages.schemaInFlight--;}
   },
   onHeartbeat:async revision=>{increment('heartbeatCallbacks');try{feed?.receipt(revision);increment('heartbeatCompleted');}catch(error){increment('heartbeatRefusals');throw error;}}});
 try{
   await store.own(async()=>{try{await withdraw('EVALUATOR_OWNER_UNAVAILABLE');}finally{onTerminal?.('EVALUATOR_OWNER_UNAVAILABLE');}});
   await store.admit(config.tenants.keys());
   server=http.createServer(async(req,res)=>{
     increment('httpArrivals');let stage='body';
     try{
       if(req.method==='GET'&&req.url==='/pgstream/ready'){res.writeHead(!closed&&store.available?204:503).end();return;}
       if(closed||req.method!=='POST'||req.url!=='/pgstream'){increment('routeRefusals');res.writeHead(404).end();return;}
       let bytes=0,body='';for await(const part of req){bytes+=part.length;if(bytes>Math.min(config.maxBytes*2,settings.receiver.maxBytes))throw new Error('PGSTREAM_WEBHOOK_BYTE_BOUND');body+=part;}
       stage='parse';const event=receiver.parse(body);increment('parsed');stage='receive';increment('receiverInFlight');
       try{await receive(event);increment('receiverCompleted');}catch(error){increment('receiverRefusals');throw error;}finally{stages.receiverInFlight--;}
       res.writeHead(204).end();
     }catch{if(stage==='body')increment('bodyRefusals');else if(stage==='parse')increment('parseRefusals');res.writeHead(503).end();}
   });
   server.requestTimeout=settings.receiver.timeoutMs;server.headersTimeout=settings.receiver.timeoutMs;
   await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(new URL(settings.receiver.url).port),settings.receiver.bindHost,resolve);});
   const initial=(await control.readOnly('SELECT revision::text FROM '+config.namespaces.clock+'.nightscout_heartbeat WHERE id=1')).rows;
   if(initial.length!==1||!Number.isSafeInteger(Number(initial[0].revision)))throw new Error('PGSTREAM_HEARTBEAT_NOT_PROVISIONED');
   feed=await deliveryHealth.start({bounds:settings.bounds,initialSequence:Number(initial[0].revision),
     receiverDiagnostics:()=>({...stages}),
     pulse:revision=>control.pulsePgstream(config.namespaces.clock,revision),pending:store.health,onUnavailable:withdraw,
     ...(publication ? {monotonicNow:()=>performance.now(),onHealthy:()=>{publication.ready(recoveryTicket);recoveryTicket=undefined;}} : {}),
     onTerminal:publication ? (code,details)=>{try{publication.terminal(code);}finally{onTerminal?.(code,details);}} : onTerminal,
     onRecovered:async()=>{const recover=async()=>{await onRecovered(store);available=true;};if(publication)recoveryTicket=await publication.prepareRecovery(recover);else await recover();},
     inspect:async()=>{
       const row=(await control.readOnly(`SELECT r.rolsuper,r.rolreplication,r.rolbypassrls,
         NOT pg_has_role(r.oid,d.datdba,'MEMBER') AND NOT pg_has_role(r.oid,n.nspowner,'MEMBER') AS nonowner,
         has_schema_privilege(r.oid,n.oid,'USAGE') AND has_schema_privilege(r.oid,n.oid,'CREATE') AND has_table_privilege(r.oid,'pgstream.webhook_subscriptions','SELECT') AND NOT has_table_privilege(r.oid,'pgstream.webhook_subscriptions','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS grants,
         s.database=current_database() AS same_database,s.plugin,s.wal_status,s.restart_lsn
         FROM pg_roles r CROSS JOIN pg_database d CROSS JOIN pg_namespace n LEFT JOIN pg_replication_slots s ON s.slot_name=$2
         WHERE r.rolname=$1 AND d.datname=current_database() AND n.nspname='pgstream'`,[settings.streamRole,settings.slot])).rows[0];
       const subscriptions=(await control.readOnly('SELECT url,schema_name,table_name,event_types FROM pgstream.webhook_subscriptions')).rows;
       const expected=selected.map(route=>({url:deliveryURL,schema_name:route.schema,table_name:route.table,event_types:['D','I','U']}));
       expected.push({url:deliveryURL,schema_name:'',table_name:'',event_types:['M']});
       const normalize=rows=>rows.map(value=>JSON.stringify([value.url,value.schema_name,value.table_name,[...(value.event_types||[])].sort()])).sort().join('\n');
       return {identity:!!row&&!row.rolsuper&&!row.rolbypassrls&&row.rolreplication&&row.nonowner&&row.same_database===true&&row.plugin==='wal2json',grants:row?.grants===true&&normalize(subscriptions)===normalize(expected),
         slot:!row?.restart_lsn||row.wal_status==='lost'?'lost':'valid'};
     }});
   return Object.freeze({store, ...(publication ? {inspectIntake:publication.inspectIntake} : {}),
     async ready(){const end=Date.now()+settings.bounds.recoveryMs;while(!feed.health().healthy){if(feed.health().terminal||Date.now()>=end)throw new Error(feed.health().code||'PGSTREAM_NOT_READY');await new Promise(r=>setTimeout(r,10));}available=true;},
     assertAvailable(){if(closed||schemaBlocked||!available||!store.available||!feed.health().healthy)throw new Error('EVALUATOR_FEED_UNAVAILABLE');},
     health:()=>{const health=feed.health();return {...health,healthy:health.healthy&&!schemaBlocked&&available&&store.available,owner:store.available};},
     async close(){if(closed)return;let publicationError;try{publication?.close();}catch(error){publicationError=error;}closed=true;await feed.close();if(server)await new Promise(r=>server.close(r));await store.close();if(publicationError)throw publicationError;}
   });
 }catch(error){try{publication?.terminal('INTAKE_OPEN_FAILED');}catch{ /* Preserve the original failure and still drain owned resources. */ }closed=true;await feed?.close();if(server)await new Promise(r=>server.close(r));await store.close();throw error;}
}
module.exports={open,routes,relevantSchemas,BINARY_SHA256};
