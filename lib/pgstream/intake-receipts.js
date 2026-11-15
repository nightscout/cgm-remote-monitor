'use strict';
const profiles=require('./intake-profile'),work=require('./work-state');
const transactionLock=require('../pool-membership/transaction-lock');
async function admit(query,profile){
 const p=profiles.validate(profile),b=p.binding;
 await require('./intake-grants').assertReady(query,p);
 await require('../pool-membership/fixed-protocol').assertInstalled(query,b.membershipNamespace);
 const catalogue=require('./assignment-candidate').build({membershipNamespace:b.membershipNamespace,lifecycleNamespace:b.lifecycleNamespace,intakeProfile:p}).catalogue;
 const installedCatalogue=await require('../migrations/postgres-check').inspect(query,{table:'"'+b.namespace+'".schema_migrations',files:require('../migrations/catalogue').validateCatalogue(catalogue)});
 if(!installedCatalogue.current)throw new Error('PGSTREAM_INTAKE_CATALOGUE_PENDING');
 await require('./assignment-protocol').assertInstalled(query,{namespace:b.namespace,membershipNamespace:b.membershipNamespace,lifecycleNamespace:b.lifecycleNamespace,intakeProfile:p,requireIntakeExecute:true});
 const installed=(await query('SELECT /* intake-installed-profile */ consumer,profile,digest,contract_digest FROM "'+b.namespace+'".pgstream_intake_profile')).rows;
 if(installed.length!==1||installed[0].consumer!==b.consumer+'-completed'||profiles.validate({...p,binding:installed[0].profile}).digest!==p.digest||installed[0].digest!==p.digest||installed[0].contract_digest!==p.contractDigest)throw new Error('PGSTREAM_INTAKE_INSTALLED_PROFILE');
 const seen=new Set();
 for(let start=0;start<b.tenants.length;start+=64){const page=b.tenants.slice(start,start+64),rows=(await query('SELECT /* intake-admission */ tenant_id::text AS tenant,contract_digest,work_version,work_owner_ordinal,work_assignment_revision::text AS work_assignment_revision FROM "'+b.namespace+'".tenant_consumer_checkpoint WHERE consumer=$1 AND tenant_id=ANY($2::uuid[])',[b.consumer+'-completed',page])).rows;
 if(rows.length!==page.length)throw new Error('PGSTREAM_INTAKE_NOT_PROVISIONED');
 for(const row of rows){if(!page.includes(row.tenant)||seen.has(row.tenant)||row.contract_digest!==p.contractDigest||row.work_version!==2||row.work_owner_ordinal!==p.assignment.owner(row.tenant)||row.work_assignment_revision!==b.revision)throw new Error('PGSTREAM_INTAKE_ADMISSION_REFUSED');seen.add(row.tenant);}}
 return p;
}
function capture(profile,observations){
 const p=profiles.validate(profile),b=p.binding;
 work.validateReceipts({table:b.namespace+'.tenant_consumer_checkpoint',consumer:b.consumer+'-completed',observations});
 if(observations.some(o=>!b.tenants.includes(o.tenant)))throw new Error('PGSTREAM_INTAKE_ROSTER_REFUSED');
 return JSON.parse(JSON.stringify(observations));
}
async function observe(query,profile,backendPid,observations){
 const p=profiles.validate(profile),b=p.binding;
 if(!Array.isArray(observations)||!observations.length||observations.length>64||observations.some(o=>!b.tenants.includes(o?.tenant)))throw new Error('PGSTREAM_INTAKE_ROSTER_REFUSED');
 const identity=await transactionLock.lock(query,b.membershipNamespace,'evaluator',true);
 if(identity.backend_pid!==backendPid)throw new Error('PGSTREAM_INTAKE_BACKEND_REFUSED');
 const at=Date.now();work.instant(at);
 const context=Object.freeze({protocol:profiles.PROTOCOL,profile:p.digest,consumer:b.consumer+'-completed',revision:b.revision,backendPid:String(backendPid),transactionId:identity.transaction_id,operation:'observe',observedAt:String(at),tenants:observations.map(o=>o.tenant)});
 await query("SELECT set_config('app.current_tenant_id','',true)");
 await query("SELECT set_config('app.pgstream_intake',$1,true)",[JSON.stringify(context)]);
 const verify=()=>query('SELECT "'+b.namespace+'".pgstream_intake_assert()');
 await verify();
 const result=await work.observeInTransaction({client:{query},table:b.namespace+'.tenant_consumer_checkpoint',consumer:b.consumer+'-completed',contractDigest:p.contractDigest,observations,at});
 // Also required for equal-version/no-op batches, which fire no row trigger.
 await verify();return result;
}
module.exports={admit,observe,capture};
