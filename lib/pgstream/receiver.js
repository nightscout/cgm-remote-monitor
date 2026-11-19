'use strict';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A schema cut is accepted only with the original successful receive result.
// Keep its private token out of the receiver's existing enumerable contract.
const acceptedSchemas=new WeakMap();
function acceptedSchemaToken(result){return acceptedSchemas.get(result)??null;}
function accepted(result,token){if(typeof token!=='undefined')acceptedSchemas.set(result,token);return result;}
const bad=code=>Object.assign(new Error(code),{code});
const version=value=>{if(typeof value==='number'&&!Number.isSafeInteger(value))throw bad('PGSTREAM_EVENT_VERSION');const text=String(value);if(!/^(0|[1-9][0-9]{0,18})$/.test(text)||BigInt(text)>9223372036854775807n)throw bad('PGSTREAM_EVENT_VERSION');return text;};
// Restore exact integer lexemes only for operational bigint columns. Clinical
// JSON and already-decoded unsafe JavaScript numbers keep their existing rules.
const EXACT_COLUMNS=new Set(['last_stamp','last_delete_stamp','version','generation','revision']);
function parse(text){
 const exact=new WeakMap();
 const event=JSON.parse(text,function(key,value,context){if(key==='value'&&typeof value==='number'&&!Number.isSafeInteger(value)&&/^-?[0-9]+$/.test(context?.source||''))exact.set(this,context.source);return value;});
 for(const columns of [event?.Data,...(event?.Transaction||[])].flatMap(data=>[data?.columns,data?.identity]))if(Array.isArray(columns))for(const column of columns)if(column&&EXACT_COLUMNS.has(column.name)&&['bigint','int8','pg_catalog.int8'].includes(column.type)&&exact.has(column))column.value=exact.get(column);
 return event;
}
function create({routes,relevantSchemas=[],store,onInput,onSchema,clinical}){
 if(!Array.isArray(routes)||routes.some(row=>!row.schema||!row.table)||!Array.isArray(relevantSchemas)||relevantSchemas.some(schema=>typeof schema!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(schema))||[onInput,onSchema].some(fn=>typeof fn!=='function'))throw new TypeError('Explicit pgstream routes and role callbacks required');
 const native=store?.nativeLifecycle && require('../tenant-lifecycle/native-selection').validate(store.nativeLifecycle);
 if(native&&(store.digest!==native.contractDigest||store.consumer!==native.binding.consumer+'-completed'||routes.filter(r=>r.kind==='lifecycle').length!==1||!routes.some(r=>r.kind==='lifecycle'&&r.schema===native.binding.lifecycleNamespace&&r.table==='tenant_lifecycle_windows')))throw new Error('PGSTREAM_NATIVE_RECEIPT_BINDING');
 const routeMap=new Map(routes.map(row=>[row.schema+'.'+row.table,row]));
 if(routeMap.size!==routes.length)throw new TypeError('Duplicate pgstream route');
 // DML routes stay narrow; DDL can invalidate clinical admission even when
 // rows in that schema are acquired through the existing projection.
 const schemas=new Set([...routes.map(row=>row.schema),...relevantSchemas]);
 return async function receive(event,trace){
   if(clinical?.slice&&!event?.Transaction)throw bad('CLINICAL_STREAM_SLICE_REQUIRED');
   if(event?.Transaction){
     if(!clinical?.acceptTransaction)throw bad('PGSTREAM_TRANSACTION_MATERIALIZER_REQUIRED');
     const transaction=require('../storage/clinical-stream-state').validateTransaction(event,{maxRows:clinical.maxTransactionRows,maxBytes:clinical.maxTransactionBytes,slice:clinical.slice});
     const observations=new Map(),invalidateTenants=[],affected=new Set(),addressed=new Set();
     for(const data of transaction.changes){
       if(data.action==='M'){
         if(data.prefix!=='pgstream.ddl'||typeof data.content!=='string')throw bad('PGSTREAM_CONTROL_UNKNOWN');
         let ddl;try{ddl=JSON.parse(data.content);}catch{throw bad('PGSTREAM_DDL_SHAPE');}
         if(!ddl||!Array.isArray(ddl.objects)||typeof ddl.schema_name!=='string'||ddl.objects.some(object=>typeof object.schema!=='string'))throw bad('PGSTREAM_DDL_SHAPE');
         for(const schema of [ddl.schema_name,...ddl.objects.map(object=>object.schema)])if(schemas.has(schema))affected.add(schema);
         continue;
       }
       const route=routeMap.get(data.schema+'.'+data.table);if(!route)throw bad('PGSTREAM_EVENT_UNROUTED');
       const row=Object.fromEntries([...(data.identity||[]),...(data.columns||[])].map(column=>[column.name,column.value]));
       if(typeof row.tenant_id!=='string'||!UUID.test(row.tenant_id))throw bad('PGSTREAM_EVENT_TENANT');
       addressed.add(row.tenant_id);
       if(route.kind==='clinical')continue;
       if(data.action==='D')throw bad('PGSTREAM_INPUT_TOMBSTONE_RECONCILE_REQUIRED');
       let stamp,enabled;
       if(route.kind==='settings')stamp=version(row.version);
       else if(route.kind==='policy')stamp=version(row.generation);
       else if(route.kind==='activity'){
         if(typeof row.paused!=='boolean'||typeof row.suspended!=='boolean')throw bad('PGSTREAM_ACTIVITY_SHAPE');
         stamp=version(row.version);enabled=!row.paused&&!row.suspended;
       }else if(route.kind==='lifecycle'){
         if(!['active','suspended'].includes(row.phase))throw bad('PGSTREAM_LIFECYCLE_SHAPE');
         const generation=version(row.generation);
         stamp=native?require('./intake-profile').lifecycleStamp(generation,row.phase):version(BigInt(generation)*2n+(row.phase==='suspended'?1n:0n));enabled=row.phase==='active';
         invalidateTenants.push(row.tenant_id);
       }else throw bad('PGSTREAM_EVENT_UNROUTED');
       const observation=observations.get(row.tenant_id)||{tenant:row.tenant_id,observed:{}};
       if(observation.observed[route.kind]===undefined||BigInt(stamp)>BigInt(observation.observed[route.kind])){
         observation.observed[route.kind]=stamp;
         if(enabled!==undefined)observation.eligibility={...observation.eligibility,[route.kind]:enabled};
       }
       observations.set(row.tenant_id,observation);
     }
     // The validated commit position identifies this DDL against the startup baseline.
     const schemaToken=affected.size?await onSchema([...affected],trace,transaction.position):undefined;
     trace?.mark('clinical-accept');
     if (addressed.size && clinical.prepare) {
       if (addressed.size > 64) throw bad('CLINICAL_STREAM_TRANSACTION_TENANT_BOUND');
       await clinical.prepare(addressed, transaction.source_identity);
     }
     let receipts;
     try{receipts=await clinical.acceptTransaction(event,{routes:routes.filter(route=>route.kind==='clinical'),observations:[...observations.values()],invalidateTenants:[...new Set(invalidateTenants)],store});}
     catch(error){
       // An older retained cohort can precede the lifecycle event that would
       // otherwise wake recovery. Refuse ACK, but address the same scheduler
       // immediately so exact recovery can unblock that cohort after restore.
       if(['CLINICAL_STREAM_SOURCE_FENCE','CLINICAL_STREAM_BOOTSTRAP_REQUIRED'].includes(error.message))
         for(const tenant of addressed)try{Promise.resolve(onInput(tenant,'recovery')).catch(()=>{});}catch{ /* Replay retries the recovery hint. */ }
       throw error;
     }
     for(const receipt of receipts){
       // Every pending duplicate also hints: its prior COMMIT reply or wake may
       // have been lost. Raw delivery is independent from clinical readiness.
       if(Object.entries(receipt.observed||{}).some(([key,value])=>receipt.completed?.[key]===undefined||BigInt(value)>BigInt(receipt.completed[key])))
         try{Promise.resolve(onInput(receipt.tenant,'bootstrap',receipt.pendingAt)).catch(()=>{});}catch{ /* Durable pending work recovers a missed hint. */ }
     }
     return accepted({kind:'transaction',tenants:receipts.map(receipt=>receipt.tenant)},schemaToken);
   }
   const data=event?.Data;if(!data||typeof data!=='object')throw bad('PGSTREAM_EVENT_SHAPE');
   if(data.action==='M'){
     if(data.prefix!=='pgstream.ddl'||typeof data.content!=='string')throw bad('PGSTREAM_CONTROL_UNKNOWN');
     let ddl;try{ddl=JSON.parse(data.content);}catch{throw bad('PGSTREAM_DDL_SHAPE');}
     if(!ddl||!Array.isArray(ddl.objects)||typeof ddl.schema_name!=='string'||ddl.objects.some(object=>typeof object.schema!=='string'))throw bad('PGSTREAM_DDL_SHAPE');
     const affected=new Set([ddl.schema_name,...ddl.objects.map(object=>object.schema)].filter(schema=>schemas.has(schema)));
     const schemaToken=affected.size?await onSchema([...affected],trace):undefined;
     return accepted({kind:affected.size?'schema':'irrelevant-schema'},schemaToken);
   }
   throw bad('PGSTREAM_COMPLETE_TRANSACTION_REQUIRED');
 };
}
module.exports={create,version,parse,acceptedSchemaToken};
