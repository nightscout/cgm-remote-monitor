'use strict';
const fs=require('node:fs');
const http=require('node:http');
const {createHash}=require('node:crypto');
const checkpoint=require('./checkpoint');
const supervisor=require('./supervisor');
const receiver=require('./receiver');
const endpoint=require('../server/serve/evaluator-consumer-config').endpoint;
const BINARY_SHA256='f9da5d0c299139db5236b63bdbd5cc20f6e1267db989c51d6444f429150c158b';
function routes(config){const ns=config.namespaces,w=config.trustedWorker;return [
 {schema:ns.clock,table:'tenant_write_clock',kind:'clock'},
 {schema:w.settings,table:'tenant_settings',kind:'settings'},
 {schema:w.operatorPolicy,table:'tenant_operator_policy',kind:'policy'},
 {schema:w.activity,table:'tenant_activity',kind:'activity'},
 {schema:w.activity,table:'tenant_lifecycle_windows',kind:'lifecycle'},
 {schema:ns.checkpoint,table:'tenant_consumer_checkpoint',kind:'output'},
 {schema:ns.clock,table:'nightscout_heartbeat',kind:'heartbeat'}];}
async function open({config,connection,onInput,onOutput,onSchema,onUnavailable,onRecovered,onTerminal}){
 const settings=config.pgstream,selected=routes(config);
 if(createHash('sha256').update(fs.readFileSync(settings.binary)).digest('hex')!==BINARY_SHA256)throw new Error('PGSTREAM_BINARY_PIN_REFUSED');
 // The binding writes bounded JSON, which is also valid pgstream YAML.
 const wire=JSON.parse(fs.readFileSync(settings.configFile,'utf8'));
 const metadataURL=new URL(wire?.target?.webhooks?.subscriptions?.store?.url);
 if(metadataURL.searchParams.get('pool_max_conns')!=='2')throw new Error('PGSTREAM_METADATA_POOL_BOUND');
 metadataURL.searchParams.delete('pool_max_conns');
 const source=wire?.source?.postgres,target=wire?.target?.webhooks;
 if(!source||source.mode!=='replication'||endpoint(source.url)!==endpoint(config.connectionString)||new URL(source.url).username!==settings.streamRole||source.replication?.replication_slot!==settings.slot||
   metadataURL.href!==new URL(source.url).href||target.subscriptions.store.cache?.enabled===true||target?.notifier?.strict_mode!==true||
   !/^127\.0\.0\.1:[0-9]+$/.test(target?.subscriptions?.server?.address||'')||
   source.replication.plugin?.add_tables?.split(',').sort().join(',')!==selected.map(row=>row.schema+'.'+row.table).sort().join(','))throw new Error('PGSTREAM_CONFIG_PIN_REFUSED');
 const store=checkpoint.create({connection,namespace:config.namespaces.checkpoint,consumer:config.consumer,maxBytes:config.maxBytes*2,timeIntervalMs:config.timeIntervalMs});
 let feed,server,closed=false,available=true,schemaBlocked=false;
 async function withdraw(code,signal,details){available=false;await onUnavailable(code,details);}
 const receive=receiver.create({routes:selected,relevantSchemas:[...Object.values(config.namespaces),...(config.registry?[config.registry.namespace]:[])],store,onInput,onOutput,
   onSchema:async schemas=>{schemaBlocked=true;await onSchema(schemas);schemaBlocked=false;},
   onHeartbeat:async revision=>{feed?.receipt(revision);}});
 try{
   await store.own(async()=>{try{await withdraw('EVALUATOR_OWNER_UNAVAILABLE');}finally{onTerminal?.('EVALUATOR_OWNER_UNAVAILABLE');}});
   server=http.createServer(async(req,res)=>{
     try{
       if(closed||req.method!=='POST'||req.url!=='/pgstream'){res.writeHead(404).end();return;}
       let bytes=0,body='';for await(const part of req){bytes+=part.length;if(bytes>config.maxBytes*2)throw new Error('PGSTREAM_WEBHOOK_BYTE_BOUND');body+=part;}
       await receive(JSON.parse(body));res.writeHead(204).end();
     }catch{res.writeHead(503).end();}
   });
   server.requestTimeout=settings.bounds.stepMs;server.headersTimeout=settings.bounds.stepMs;
   await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(settings.receiverPort,'127.0.0.1',resolve);});
   const initial=(await connection.readOnly('SELECT revision::text FROM '+config.namespaces.clock+'.nightscout_heartbeat WHERE id=1')).rows;
   if(initial.length!==1||!Number.isSafeInteger(Number(initial[0].revision)))throw new Error('PGSTREAM_HEARTBEAT_NOT_PROVISIONED');
   feed=await supervisor.start({binary:settings.binary,configFile:settings.configFile,bounds:settings.bounds,initialSequence:Number(initial[0].revision),
     pulse:revision=>connection.pulsePgstream(config.namespaces.clock,revision),pending:store.health,onUnavailable:withdraw,onTerminal,onRecovered:async()=>{await onRecovered(store);available=true;},
     inspect:async()=>{
       const row=(await connection.readOnly(`SELECT r.rolsuper,r.rolreplication,r.rolbypassrls,
         NOT pg_has_role(r.oid,d.datdba,'MEMBER') AND NOT pg_has_role(r.oid,n.nspowner,'MEMBER') AS nonowner,
         has_schema_privilege(r.oid,n.oid,'USAGE') AND has_schema_privilege(r.oid,n.oid,'CREATE') AND has_table_privilege(r.oid,'pgstream.webhook_subscriptions','SELECT') AND NOT has_table_privilege(r.oid,'pgstream.webhook_subscriptions','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS grants,
         s.database=current_database() AS same_database,s.plugin,s.wal_status,s.restart_lsn
         FROM pg_roles r CROSS JOIN pg_database d CROSS JOIN pg_namespace n LEFT JOIN pg_replication_slots s ON s.slot_name=$2
         WHERE r.rolname=$1 AND d.datname=current_database() AND n.nspname='pgstream'`,[settings.streamRole,settings.slot])).rows[0];
       const subscriptions=(await connection.readOnly('SELECT url,schema_name,table_name,event_types FROM pgstream.webhook_subscriptions')).rows;
       const expected=selected.map(route=>({url:'http://127.0.0.1:'+settings.receiverPort+'/pgstream',schema_name:route.schema,table_name:route.table,event_types:['D','I','U']}));
       expected.push({url:'http://127.0.0.1:'+settings.receiverPort+'/pgstream',schema_name:'',table_name:'',event_types:['M']});
       const normalize=rows=>rows.map(value=>JSON.stringify([value.url,value.schema_name,value.table_name,[...(value.event_types||[])].sort()])).sort().join('\n');
       return {identity:!!row&&!row.rolsuper&&!row.rolbypassrls&&row.rolreplication&&row.nonowner&&row.same_database===true&&row.plugin==='wal2json',grants:row?.grants===true&&normalize(subscriptions)===normalize(expected),
         slot:!row?.restart_lsn||row.wal_status==='lost'?'lost':'valid'};
     }});
   return Object.freeze({store,
     async ready(){const end=Date.now()+settings.bounds.recoveryMs;while(!feed.health().healthy){if(feed.health().terminal||Date.now()>=end)throw new Error(feed.health().code||'PGSTREAM_NOT_READY');await new Promise(r=>setTimeout(r,10));}available=true;},
     assertAvailable(){if(closed||schemaBlocked||!available||!store.available||!feed.health().healthy)throw new Error('EVALUATOR_FEED_UNAVAILABLE');},
     health:()=>({...feed.health(),owner:store.available}),
     async close(){if(closed)return;closed=true;await feed.close();if(server)await new Promise(r=>server.close(r));await store.close();}
   });
 }catch(error){closed=true;await feed?.close();if(server)await new Promise(r=>server.close(r));await store.close();throw error;}
}
module.exports={open,routes,BINARY_SHA256};
