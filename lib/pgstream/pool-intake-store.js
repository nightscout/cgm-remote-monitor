'use strict';
const profiles=require('./pool-intake-profile'),work=require('./work-state'),receipts=require('./pool-intake-receipts');
function create({connection,profile,predecessorProfile,onCommit}){
 const p=profiles.validate(profile);
 if(!connection||typeof connection.holdAdvisoryLock!=='function'||onCommit!==undefined&&typeof onCommit!=='function')throw new TypeError('PGSTREAM_INTAKE_STORE');
 let owner,port,admitted=false,closed=false,unavailable=false,started=false;
 const refuse=commitOutcome=>{throw Object.assign(new Error('PGSTREAM_INTAKE_UNAVAILABLE'),commitOutcome?{commitOutcome}:{});};
 const available=()=>admitted&&!closed&&!unavailable&&owner?.available===true&&port?.available===true;
 const notify=tenant=>{try{Promise.resolve(onCommit?.({tenant,kind:'observe'})).catch(()=>{});}catch{ /* Committed pending truth recovers lost hints. */ }};
 return Object.freeze({consumer:p.binding.consumer+'-completed',digest:p.contractDigest,profile:p.digest,
  async own(onLoss){
   if(started||closed||unavailable||typeof onLoss!=='function')throw new Error('PGSTREAM_INTAKE_OWNER_STATE');
   started=true;
   const lost=()=>{unavailable=true;admitted=false;return onLoss();};
   try{owner=await connection.holdAdvisoryLock(p.ownerKey,lost);if(closed||unavailable)throw new Error('PGSTREAM_INTAKE_OWNER_STATE');port=await owner.openIntakeReceipts(p,{predecessorProfile});if(closed||unavailable||typeof port?.admit!=='function')throw new Error('PGSTREAM_INTAKE_OWNER_STATE');}catch(error){unavailable=true;await owner?.close();throw error;}
  },
  async admit(tenants){
   if(!owner?.available||!port?.available||closed||unavailable)refuse();
   await port.admit(receipts.captureTenants(tenants));
   if(!owner?.available||!port?.available||closed||unavailable)refuse();admitted=true;
  },
  async observeMany(observations){
   if(!available())refuse();const batch=receipts.capture(p,observations),result=await port.observeMany(batch);
   if(!available())refuse('committed');if(!Array.isArray(result)||result.length!==batch.length)throw new Error('PGSTREAM_INTAKE_RECEIPT_RESULT');
   result.forEach((receipt,i)=>{if(receipt.discarded!==true&&receipt.deliveryPending)notify(batch[i].tenant);});return result;
  },
  async observe(tenant,source,version,enabled){return (await this.observeMany([{tenant,observed:{[source]:work.version(version)},...(enabled===undefined?{}:{eligibility:{[source]:enabled}})}]))[0];},
  async health(){if(!available())refuse();const result=await port.health();if(!available())refuse();return result;},
  get available(){return available();},
  async close(){closed=true;admitted=false;await owner?.close();}
 });
}
module.exports={create};
