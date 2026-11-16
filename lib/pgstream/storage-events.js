'use strict';
const scope=require('../storage/tenant-scope');
const journal=require('../storage/storage-event-journal');
// The existing completed checkpoint/delivery revision owns retry. This reader
// neither mutates source data nor creates another retry loop or projection.
function create({config,connection,operationWindow,workerState,assertOwner=()=>{}}){
 const fences=new WeakMap();
 const table='"'+config.completedOutput.namespace+'".tenant_consumer_checkpoint',consumer=config.completedOutput.consumer;
 const read=tenant=>scope.withTenant(tenant,async()=>{
  const worker=workerState?.(),restore=operationWindow?.currentGeneration(tenant);
  const check=()=>{assertOwner(tenant);if(operationWindow&&String(restore)!==String(operationWindow.currentGeneration(tenant)))throw new Error('STORAGE_EVENT_RESTORE_CHANGED');if(workerState&&(!worker?.available||!workerState().available||worker.generation!==workerState().generation))throw new Error('TRUSTED_WORKER_UNAVAILABLE');};
  check();
  const row=(await connection.query("SELECT input.projection->1 AS storage,output.work_enabled FROM "+table+' input JOIN '+table+" output ON output.tenant_id=input.tenant_id AND output.consumer=input.consumer||'-completed' WHERE input.tenant_id=$1 AND input.consumer=$2",[tenant,consumer])).rows[0];
  if(!row)throw new Error('STORAGE_EVENT_NOT_PROVISIONED');
  if(!row.work_enabled)throw new Error('STORAGE_EVENT_CONTROL_PENDING');
  const tail=journal.validate(row.storage);
  if(tail.events.length>config.maxRows||Buffer.byteLength(JSON.stringify(tail))>config.maxBytes)throw new Error('STORAGE_EVENT_READ_BOUND');
  check();fences.set(tail,check);return tail;
 });
 const readCurrent=tenant=>operationWindow?operationWindow.run(tenant,()=>read(tenant)):read(tenant);
 return Object.freeze({
 async check(tenants,{runtime,protocol,concurrency}){
  const outcomes=await runtime.check(tenants);
  const raw=await require('../server/serve/tenant-startup').settleLimited(tenants,concurrency,async tenant=>{
   if(!protocol.storageWatched(tenant))return;
   await protocol.storage({tenant,tail:await readCurrent(tenant)});
  });
  for(let i=0;i<tenants.length;i++)if(raw[i].status==='rejected')outcomes.set(tenants[i],false);
  return outcomes;
 },
 assert:tail=>{const check=fences.get(tail);if(!check)throw new Error('STORAGE_EVENT_UNFENCED');check();},read:readCurrent});
}
module.exports={create};
