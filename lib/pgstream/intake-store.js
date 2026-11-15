'use strict';
// Default off; no boot constructor selects this receipt-only capability.
const profiles=require('./intake-profile'),work=require('./work-state');
function create({connection,profile,onCommit}){
 const p=profiles.validate(profile);
 if(!connection||typeof connection.holdAdvisoryLock!=='function'||onCommit!==undefined&&typeof onCommit!=='function')throw new TypeError('PGSTREAM_INTAKE_STORE');
 let owner,port,admitted=false,closed=false,unavailable=false,started=false;
 const refuse=()=>{throw new Error('PGSTREAM_INTAKE_UNAVAILABLE');};
 const notify=tenant=>{try{Promise.resolve(onCommit?.({tenant,kind:'observe'})).catch(()=>{});}catch{ /* Durable pending truth recovers a lost hint. */ }};
 return Object.freeze({consumer:p.binding.consumer+'-completed',digest:p.contractDigest,profile:p.digest,
  async own(onLoss){
   if(started||closed||unavailable||typeof onLoss!=='function')throw new Error('PGSTREAM_INTAKE_OWNER_STATE');
   started=true;
   const lost=()=>{unavailable=true;admitted=false;return onLoss();};
   try{owner=await connection.holdAdvisoryLock(p.ownerKey,lost);if(closed||unavailable)throw new Error('PGSTREAM_INTAKE_OWNER_STATE');port=await owner.openIntakeReceipts(p);if(closed||unavailable)throw new Error('PGSTREAM_INTAKE_OWNER_STATE');}catch(error){unavailable=true;await owner?.close();throw error;}
  },
  async admit(tenants){
   if(!owner?.available||!port?.available||closed||unavailable)refuse();
   const roster=[...tenants].sort();if(JSON.stringify(roster)!==JSON.stringify(p.binding.tenants))throw new Error('PGSTREAM_INTAKE_FIXED_ROSTER');admitted=true;
  },
  async observeMany(observations){
   if(!admitted||!owner?.available||!port?.available||closed||unavailable)refuse();
   const batch=require('./intake-receipts').capture(p,observations);
   const result=await port.observeMany(batch);result.forEach((receipt,i)=>{if(receipt.deliveryPending)notify(batch[i].tenant);});return result;
  },
  async observe(tenant,source,version,enabled){return (await this.observeMany([{tenant,observed:{[source]:work.version(version)},...(enabled===undefined?{}:{eligibility:{[source]:enabled}})}]))[0];},
  get available(){return admitted&&!closed&&!unavailable&&owner?.available===true&&port?.available===true;},
  async close(){closed=true;admitted=false;await owner?.close();}
 });
}
module.exports={create};
