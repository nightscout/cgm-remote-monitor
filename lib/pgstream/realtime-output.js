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
// The level read (decision D23): one batched control read and one batched
// primary-key read of the completed-output revision, for the watched tenants
// this process was asked about. It reads no settings and no frame, and it
// writes nothing. `eligible:false` is a completed read that refuses the tenant.
function revisions({config,connection,trusted,owner}){
 const counters={polls:0,failures:0};
 const table='"'+config.completedOutput.namespace+'".tenant_consumer_checkpoint',consumer=config.completedOutput.consumer+'-completed';
 const policy=require('../tenant-activity/policy');
 const read=async tenants=>{
   counters.polls++;
   try{
     if(!Array.isArray(tenants)||new Set(tenants).size!==tenants.length)throw new TypeError('Distinct addressed realtime tenants required');
     if(!tenants.length)return new Map();for(const tenant of tenants)owner(tenant);
     const metadata=await trusted.scan(tenants);
     const rows=(await connection.readOnly('SELECT tenant_id::text AS tenant,output_revision::text AS revision,work_enabled FROM '+table+' WHERE consumer=$1 AND tenant_id=ANY($2::uuid[])',[consumer,tenants])).rows;
     const found=new Map(rows.map(row=>[row.tenant,row]));
     return new Map(tenants.map(tenant=>{
       const row=found.get(tenant),control=metadata.get(tenant);
       const eligible=!!control&&row?.work_enabled===true&&policy.eligible('read',control.activity.state);
       return [tenant,eligible?{eligible,revision:row.revision}:{eligible}];
     }));
   }catch(error){counters.failures++;throw error;}
 };
 read.stats=()=>Object.freeze({...counters});
 return read;
}
module.exports={projection,revisions};
