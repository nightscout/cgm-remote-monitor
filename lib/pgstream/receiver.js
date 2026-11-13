'use strict';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bad=code=>Object.assign(new Error(code),{code});
const version=value=>{const text=String(value);if(!/^(0|[1-9][0-9]{0,18})$/.test(text)||BigInt(text)>9223372036854775807n)throw bad('PGSTREAM_EVENT_VERSION');return text;};
function create({routes,store,onInput,onOutput,onHeartbeat,onSchema}){
 if(!Array.isArray(routes)||routes.some(row=>!row.schema||!row.table)||[onInput,onOutput,onHeartbeat,onSchema].some(fn=>typeof fn!=='function'))throw new TypeError('Explicit pgstream routes and role callbacks required');
 const routeMap=new Map(routes.map(row=>[row.schema+'.'+row.table,row]));
 if(routeMap.size!==routes.length)throw new TypeError('Duplicate pgstream route');
 const schemas=new Set(routes.map(row=>row.schema));
 return async function receive(event){
   const data=event?.Data;if(!data||typeof data!=='object')throw bad('PGSTREAM_EVENT_SHAPE');
   if(data.action==='M'){
     if(data.prefix!=='pgstream.ddl'||typeof data.content!=='string')throw bad('PGSTREAM_CONTROL_UNKNOWN');
     let ddl;try{ddl=JSON.parse(data.content);}catch{throw bad('PGSTREAM_DDL_SHAPE');}
     if(!ddl||!Array.isArray(ddl.objects)||typeof ddl.schema_name!=='string'||ddl.objects.some(object=>typeof object.schema!=='string'))throw bad('PGSTREAM_DDL_SHAPE');
     const affected=new Set([ddl.schema_name,...ddl.objects.map(object=>object.schema)].filter(schema=>schemas.has(schema)));
     if(affected.size)await onSchema([...affected]);
     return {kind:affected.size?'schema':'irrelevant-schema'};
   }
   if(!['I','U','D'].includes(data.action)||typeof data.schema!=='string'||typeof data.table!=='string')throw bad('PGSTREAM_EVENT_ACTION');
   const route=routeMap.get(data.schema+'.'+data.table);if(!route)throw bad('PGSTREAM_EVENT_UNROUTED');
   if(!Array.isArray(data.columns)||data.columns.some(column=>typeof column?.name!=='string')||data.identity!==null && data.identity!==undefined && !Array.isArray(data.identity))throw bad('PGSTREAM_EVENT_COLUMNS');
   const row=Object.fromEntries([...(data.identity||[]),...data.columns].map(column=>[column.name,column.value]));
   if(route.kind==='heartbeat'){
     if(data.action==='D'||String(row.id)!=='1')throw bad('PGSTREAM_HEARTBEAT_SHAPE');
     await onHeartbeat(Number(version(row.revision)));return {kind:'heartbeat'};
   }
   if(typeof row.tenant_id!=='string'||!UUID.test(row.tenant_id))throw bad('PGSTREAM_EVENT_TENANT');
   if(route.kind==='output'){
     if(row.consumer!==store.consumer)return {kind:'other-checkpoint'};
     // Output and receiver writes only wake output consumers. No raw-input loop.
     await onOutput(row.tenant_id);return {kind:'output'};
   }
   if(data.action==='D')throw bad('PGSTREAM_INPUT_TOMBSTONE_RECONCILE_REQUIRED');
   let stamp,enabled;
   if(route.kind==='clock')stamp=version(row.last_stamp);
   else if(route.kind==='settings')stamp=version(row.version);
   else if(route.kind==='policy')stamp=version(row.generation);
   else if(route.kind==='activity'){
     if(typeof row.paused!=='boolean'||typeof row.suspended!=='boolean')throw bad('PGSTREAM_ACTIVITY_SHAPE');
     stamp=version(row.version);enabled=!row.paused&&!row.suspended;
   }else if(route.kind==='lifecycle'){
     if(!['active','suspended'].includes(row.phase))throw bad('PGSTREAM_LIFECYCLE_SHAPE');
     stamp=version(BigInt(version(row.generation))*2n+(row.phase==='suspended'?1n:0n));enabled=row.phase==='active';
   }else throw bad('PGSTREAM_EVENT_UNROUTED');
   // HTTP success is permitted only after this transaction's COMMIT.
   await store.observe(row.tenant_id,route.kind,stamp,enabled);
   // A hint does not hold up serial WAL delivery or certify clinical completion.
   try{Promise.resolve(onInput(row.tenant_id,route.kind)).catch(()=>{});}catch{ /* Durable pending work recovers a missed hint. */ }
   return {kind:'observed',tenant:row.tenant_id};
 };
}
module.exports={create,version};
