'use strict';
const scope=require('../storage/tenant-scope');
const {decodeDocument}=require('../storage/postgres-identity');
const checkpoints=require('./checkpoint');
function source(config,connection){return checkpoints.create({connection,namespace:config.completedOutput.namespace,consumer:config.completedOutput.consumer,maxBytes:config.maxBytes*2,timeIntervalMs:config.recoveryIntervalMs});}
function projection({config,connection,current,operationWindow}){
 const store=source(config,connection);
 return Object.freeze({async acquire(){return scope.withTenant(current.tenant,async()=>{
   const output=await store.output(current.tenant,current.identity);
   if(!operationWindow||output.restoreGeneration!==operationWindow.currentGeneration(current.tenant))throw new Error('REALTIME_COMPLETED_OUTPUT_RESTORE_GENERATION');
   if(!Array.isArray(output.rows)||!output.frame||Buffer.byteLength(JSON.stringify(output))>config.maxBytes*2)throw new Error('REALTIME_COMPLETED_OUTPUT_BOUND');
   const rows=output.rows.map(row=>({domain:row.domain,document:decodeDocument(row)}));
   // This is a consumed output revision, not another raw clinical projection.
   return {tenant:current.tenant,checkpoint:output.outputRevision,inputCheckpoint:output.inputCheckpoint,frame:output.frame,rows,read:'completed-output'};
 });}});
}
function detector({config,connection,trusted,readAll,owner,prime,onIneligible}){
 const table='"'+config.completedOutput.namespace+'".tenant_consumer_checkpoint',consumer=config.completedOutput.consumer+'-completed';
 return async tenants=>{
   if(!tenants.length)return new Map();for(const tenant of tenants)owner(tenant);
   const metadata=await trusted.scan(tenants);prime?.(metadata);const identities=await readAll(tenants);
   const rows=(await connection.readOnly('SELECT tenant_id::text AS tenant,projection->0->\'output\'->>\'outputRevision\' AS revision FROM '+table+' WHERE consumer=$1 AND tenant_id=ANY($2::uuid[])',[consumer,tenants])).rows;
   const revisions=new Map(rows.map(row=>[row.tenant,row.revision]));
   return new Map(tenants.map(tenant=>{const row=metadata.get(tenant),current=identities.get(tenant);
     if(!current||!row||!require('../tenant-activity/policy').eligible('read',row.activity.state)){onIneligible(tenant);return [tenant,{identity:null,stamp:null}];}
     return [tenant,{identity:current.identity,stamp:revisions.get(tenant)??null}];
   }));
 };
}
module.exports={projection,detector};
