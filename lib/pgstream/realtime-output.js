'use strict';
const scope=require('../storage/tenant-scope');
const checkpoints=require('./checkpoint');
function projection({config,connection,current,operationWindow}){
 const store=checkpoints.create({connection,namespace:config.completedOutput.namespace,consumer:config.completedOutput.consumer,maxBytes:config.maxBytes*2,typed:true});
 let retained, result;
 return Object.freeze({async acquire(){return scope.withTenant(current.tenant,async()=>{
   const output=await store.output(current.tenant,current.identity,{retained,delivery:true});
   if(!operationWindow||String(output.restoreGeneration)!==String(operationWindow.currentGeneration(current.tenant)))throw new Error('REALTIME_COMPLETED_OUTPUT_RESTORE_GENERATION');
   if(output!==retained){
     if(!output.frame||Buffer.byteLength(JSON.stringify(output))>config.maxBytes*2)throw new Error('REALTIME_COMPLETED_OUTPUT_BOUND');
     // This is a consumed output revision, not another raw clinical projection.
     result={tenant:current.tenant,checkpoint:output.outputRevision,inputCheckpoint:output.inputCheckpoint,frame:output.frame,read:'completed-output'};
     retained=output;
   }
   return result;
 });}});
}
function detector({config,connection,trusted,readAll,owner,prime,onIneligible}){
 const counters={polls:0,failures:0};
 const table='"'+config.completedOutput.namespace+'".tenant_consumer_checkpoint',consumer=config.completedOutput.consumer+'-completed';
 const poll=async (tenants,{interested=tenants}={})=>{
   counters.polls++;
   try{
   const addressed=new Set(tenants);
   if(!Array.isArray(interested)||new Set(interested).size!==interested.length||interested.some(tenant=>!addressed.has(tenant)))throw new TypeError('Bounded addressed realtime interest required');
   if(!tenants.length)return new Map();for(const tenant of tenants)owner(tenant);
   const metadata=await trusted.scan(tenants);prime?.(metadata);
   const rows=(await connection.readOnly('SELECT tenant_id::text AS tenant,output_revision::text AS revision,work_enabled FROM '+table+' WHERE consumer=$1 AND tenant_id=ANY($2::uuid[])',[consumer,tenants])).rows;
   const revisions=new Map(rows.map(row=>[row.tenant,row]));
   const eligible=tenant=>{const row=metadata.get(tenant);return !!row&&revisions.get(tenant)?.work_enabled===true&&require('../tenant-activity/policy').eligible('read',row.activity.state);};
   // Control checks apply to every addressed tenant. Settings/config identities
   // are needed only for a viewer, cold retry or explicit demand. A later
   // viewer performs a fresh addressed check; deferred work never warms a cell.
   const selected=interested.filter(eligible),interest=new Set(selected);
   // Any completed revision is publishable. Inputs observed after it are
   // covered by the next revision; only a tenant with no completed output
   // (revision 0) has nothing to send.
   const pending=new Set(selected.filter(tenant=>revisions.get(tenant).revision==='0'));
   const ready=selected.filter(tenant=>!pending.has(tenant));
   const identities=ready.length?await readAll(ready):new Map();
   return new Map(tenants.map(tenant=>{
     if(!eligible(tenant)){onIneligible(tenant);return [tenant,{identity:null,stamp:null}];}
     if(!interest.has(tenant))return [tenant,{deferred:true}];
     if(pending.has(tenant))return [tenant,{pending:true}];
     const current=identities.get(tenant);
     if(!current){onIneligible(tenant);return [tenant,{identity:null,stamp:null}];}
     return [tenant,{identity:current.identity,stamp:revisions.get(tenant)?.revision??null}];
   }));
   }catch(error){counters.failures++;throw error;}
 };
 poll.stats=()=>Object.freeze({...counters});
 return poll;
}
module.exports={projection,detector};
