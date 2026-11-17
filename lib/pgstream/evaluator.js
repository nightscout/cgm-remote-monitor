'use strict';
const http=require('node:http');
const checkpoint=require('./checkpoint');
const receiver=require('./receiver');
const BINARY_SHA256='eac69908e214dd42c19a96761ee0fabcadc1b5c7e89c747614df59b458d82a14';
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
async function open({config,connection,onInput,onCommit,onSchema,onUnavailable,onRecovered,onTerminal,assignment,schemaStartup=require('./schema-startup').create(),clinical}){
 const settings=config.pgstream,selected=routes(config);
 const deliveryURL=new URL('pgstream',settings.receiver.url).href;
 const store=checkpoint.create({connection,namespace:config.namespaces.checkpoint,consumer:config.consumer,maxBytes:config.maxBytes*2,timeIntervalMs:config.timeIntervalMs,typed:true,onCommit,assignment});
 // Numeric receiver stages describe actual deliveries, never synthetic work.
 const stages=Object.fromEntries(['httpArrivals','routeRefusals','bodyRefusals','parseRefusals','parsed','receiverInFlight','receiverCompleted','receiverRefusals','schemaStarted','schemaInFlight','schemaCompleted','schemaRefusals'].map(key=>[key,0]));
 const increment=key=>{stages[key]=Math.min(Number.MAX_SAFE_INTEGER,stages[key]+1);};
 let server,closed=false,available=false,schemaBlocked=false,schemaEpoch;
 async function withdraw(code){available=false;await onUnavailable(code);}
 async function inspectSource(){
       const row=(await connection.readOnly(`SELECT r.rolsuper,r.rolreplication,r.rolbypassrls,
         NOT pg_has_role(r.oid,d.datdba,'MEMBER') AND NOT pg_has_role(r.oid,n.nspowner,'MEMBER') AS nonowner,
         has_schema_privilege(r.oid,n.oid,'USAGE') AND has_schema_privilege(r.oid,n.oid,'CREATE') AND has_table_privilege(r.oid,'pgstream.webhook_subscriptions','SELECT') AND NOT has_table_privilege(r.oid,'pgstream.webhook_subscriptions','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS grants,
         s.database=current_database() AS same_database,s.plugin,s.wal_status,s.restart_lsn
         FROM pg_roles r CROSS JOIN pg_database d CROSS JOIN pg_namespace n LEFT JOIN pg_replication_slots s ON s.slot_name=$2
         WHERE r.rolname=$1 AND d.datname=current_database() AND n.nspname='pgstream'`,[settings.streamRole,settings.slot])).rows[0];
       const subscriptions=(await connection.readOnly('SELECT url,schema_name,table_name,event_types FROM pgstream.webhook_subscriptions')).rows;
       const expected=selected.map(route=>({url:deliveryURL,schema_name:route.schema,table_name:route.table,event_types:['D','I','U']}));
       expected.push({url:deliveryURL,schema_name:'',table_name:'',event_types:['B','C','M']});
       const normalize=rows=>rows.map(value=>JSON.stringify([value.url,value.schema_name,value.table_name,[...(value.event_types||[])].sort()])).sort().join('\n');
       return {identity:!!row&&!row.rolsuper&&!row.rolbypassrls&&row.rolreplication&&row.nonowner&&row.same_database===true&&row.plugin==='wal2json',grants:row?.grants===true&&normalize(subscriptions)===normalize(expected),
         slot:!row?.restart_lsn||row.wal_status==='lost'?'lost':'valid'};
 }
 async function admitSource(){
   const source=await inspectSource();
   if(!source.identity||!source.grants||source.slot!=='valid')throw Object.assign(new Error(source.slot==='lost'?'PGSTREAM_REBOOTSTRAP_REQUIRED':'PGSTREAM_SOURCE_REFUSED'),{code:source.slot==='lost'?'PGSTREAM_REBOOTSTRAP_REQUIRED':'PGSTREAM_SOURCE_REFUSED'});
 }
 const receive=receiver.create({routes:selected,relevantSchemas:relevantSchemas(config),store,onInput,clinical,
   onSchema:schemas=>schemaStartup.schema(async()=>{increment('schemaStarted');increment('schemaInFlight');const epoch=schemaEpoch=Symbol('schema');
     schemaBlocked=true;
     try{await admitSource();await onSchema(schemas);
       if(schemaEpoch!==epoch)throw Object.assign(new Error('PGSTREAM_SCHEMA_SUPERSEDED'),{code:'PGSTREAM_SCHEMA_SUPERSEDED'});
       schemaBlocked=false;increment('schemaCompleted');
     }catch(error){if(schemaEpoch===epoch)schemaBlocked=true;increment('schemaRefusals');throw error;}finally{stages.schemaInFlight--;}
   })});

 try{
   await store.own(async()=>{try{await withdraw('EVALUATOR_OWNER_UNAVAILABLE');}finally{onTerminal?.('EVALUATOR_OWNER_UNAVAILABLE');}});
   await store.admit(config.tenants.keys());
   server=http.createServer(async(req,res)=>{
     increment('httpArrivals');let stage='body';
     try{
       if(req.method==='GET'&&req.url==='/pgstream/ready'){res.writeHead(!closed&&store.available?204:503).end();return;}
       if(closed||req.method!=='POST'||req.url!=='/pgstream'){increment('routeRefusals');res.writeHead(404).end();return;}
       let bytes=0,body='';for await(const part of req){bytes+=part.length;if(bytes>settings.receiver.maxBytes)throw new Error('PGSTREAM_WEBHOOK_BYTE_BOUND');body+=part;}
       stage='parse';const event=receiver.parse(body);increment('parsed');stage='receive';increment('receiverInFlight');
       try{await receive(event);increment('receiverCompleted');}catch(error){increment('receiverRefusals');throw error;}finally{stages.receiverInFlight--;}
       res.writeHead(204).end();
     }catch{if(stage==='body')increment('bodyRefusals');else if(stage==='parse')increment('parseRefusals');res.writeHead(503).end();}
   });
   server.requestTimeout=settings.receiver.timeoutMs;server.headersTimeout=settings.receiver.timeoutMs;
   await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(new URL(settings.receiver.url).port),settings.receiver.bindHost,resolve);});
   await admitSource();
   await onRecovered(store);
   available=true;
   return Object.freeze({store,
     async ready(){if(closed||schemaBlocked||!available||!store.available)throw new Error('PGSTREAM_NOT_READY');},
     assertAvailable(){if(closed||schemaBlocked||!available||!store.available)throw new Error('EVALUATOR_FEED_UNAVAILABLE');},
     health:()=>({healthy:!closed&&!schemaBlocked&&available&&store.available,closed,schemaBlocked,owner:store.available,receiver:{...stages}}),
     async close(){if(closed)return;closed=true;available=false;if(server)await new Promise(r=>server.close(r));await store.close();}
   });
 }catch(error){closed=true;available=false;if(server)await new Promise(r=>server.close(r));await store.close();throw error;}
}
module.exports={open,routes,relevantSchemas,BINARY_SHA256};
