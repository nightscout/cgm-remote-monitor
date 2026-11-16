'use strict';
const profiles=require('./pool-intake-profile'),work=require('./work-state');
const transactionLock=require('../pool-membership/transaction-lock'),slice=require('../pool-membership/slice');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const healthBindings=new WeakMap(),q=value=>'"'+value+'"';
function captureTenants(tenants){
 if(!Array.isArray(tenants)||!Number.isSafeInteger(tenants.length)||tenants.length>10000)throw new TypeError('PGSTREAM_INTAKE_TENANTS');
 const owned=new Array(tenants.length);for(let i=0;i<owned.length;i++){const id=tenants[i];if(typeof id!=='string'||!UUID.test(id))throw new TypeError('PGSTREAM_INTAKE_TENANTS');owned[i]=id;}
 if(new Set(owned).size!==owned.length)throw new TypeError('PGSTREAM_INTAKE_TENANTS');return Object.freeze(owned);
}
function capture(profile,observations){
 const p=profiles.validate(profile),b=p.binding;
 if(!Array.isArray(observations)||!Number.isSafeInteger(observations.length)||observations.length<1||observations.length>64)throw new TypeError('EVALUATOR_RECEIPT_BATCH_BOUND');
 const batch=new Array(observations.length);
 for(let i=0;i<batch.length;i++){
  const source=observations[i];if(!source||typeof source!=='object'||Object.keys(source).some(key=>!['tenant','observed','eligibility'].includes(key)))throw new TypeError('EVALUATOR_RECEIPT_SHAPE');
  const tenant=source.tenant,raw=source.observed,eligibility=source.eligibility;
  if(typeof tenant!=='string'||!UUID.test(tenant)||!raw||typeof raw!=='object'||Array.isArray(raw))throw new TypeError('EVALUATOR_RECEIPT_SHAPE');
  const observed=Object.create(null),keys=Object.keys(raw);if(keys.length<1||keys.some(key=>!work.SOURCES.includes(key)))throw new TypeError('EVALUATOR_RECEIPT_SHAPE');
  for(const key of keys){const value=raw[key];if(typeof value!=='string'&&typeof value!=='number')throw new TypeError('EVALUATOR_RECEIPT_SHAPE');observed[key]=work.version(value);}
  const row={tenant,observed:Object.freeze(observed)};
  if(eligibility!==undefined){if(!eligibility||typeof eligibility!=='object'||Array.isArray(eligibility))throw new TypeError('EVALUATOR_RECEIPT_ELIGIBILITY');const own=Object.create(null);for(const key of Object.keys(eligibility)){const value=eligibility[key];if(!['activity','lifecycle'].includes(key)||typeof value!=='boolean')throw new TypeError('EVALUATOR_RECEIPT_ELIGIBILITY');own[key]=value;}row.eligibility=Object.freeze(own);}
  batch[i]=Object.freeze(row);
 }
 work.validateReceipts({table:b.namespace+'.tenant_consumer_checkpoint',consumer:b.consumer+'-completed',observations:batch});return Object.freeze(batch);
}
async function installed(query,p,marker){
 const b=p.binding,rows=(await query('SELECT /* '+marker+' */ consumer,profile,digest,contract_digest FROM '+q(b.namespace)+'.pgstream_intake_profile')).rows;
 if(rows.length!==1||rows[0].consumer!==b.consumer+'-completed'||rows[0].digest!==p.digest||rows[0].contract_digest!==p.contractDigest||profiles.validate({...p,binding:rows[0].profile}).digest!==p.digest)throw new Error('PGSTREAM_INTAKE_INSTALLED_PROFILE');
}
async function desired(query,p,backendPid){
 const identity=await transactionLock.lock(query,p.binding.membershipNamespace,'evaluator',true);
 if(backendPid!==undefined&&identity.backend_pid!==backendPid)throw new Error('PGSTREAM_INTAKE_BACKEND_REFUSED');
 const rows=(await query('SELECT /* pool-intake-desired */ members,revision::text AS revision,slice_rule AS rule,pg_backend_pid() AS backend_pid,pg_current_xact_id()::text AS transaction_id FROM '+q(p.binding.membershipNamespace)+'.pool_desired WHERE pool_kind=$1',['evaluator'])).rows;
 const row=rows[0];if(rows.length!==1||row.backend_pid!==identity.backend_pid||row.transaction_id!==identity.transaction_id||!Number.isSafeInteger(row.members)||row.members<1||row.members>slice.MAX_MEMBERS||row.rule!==slice.RULE||typeof row.revision!=='string'||work.version(row.revision)==='0')throw new Error('PGSTREAM_INTAKE_CONFIGURATION_CHANGED');return Object.freeze({...row});
}
async function authority(query,p,tenant){
 await query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);return require('../tenant-lifecycle/pool-authority').create({namespace:p.binding.lifecycleNamespace}).read(query,tenant);
}
async function checkpoint(query,p,tenant,selection){
 const b=p.binding,rows=(await query('SELECT /* pool-intake-admission */ tenant_id::text AS tenant,contract_digest,work_version,work_owner_ordinal,work_assignment_revision::text AS work_assignment_revision FROM '+q(b.namespace)+'.tenant_consumer_checkpoint WHERE consumer=$1 AND tenant_id=$2',[b.consumer+'-completed',tenant])).rows;
 const row=rows[0];if(rows.length!==1)throw new Error('PGSTREAM_INTAKE_NOT_PROVISIONED');
 if(row.tenant!==tenant||row.contract_digest!==p.contractDigest||row.work_version!==2||row.work_owner_ordinal!==slice.bucket(tenant,selection.members)||row.work_assignment_revision!==selection.revision)throw new Error('PGSTREAM_INTAKE_ADMISSION_REFUSED');
}
async function admit(query,profile,{predecessorProfile}={}){
 const p=profiles.validate(profile),b=p.binding;await require('./pool-intake-grants').assertReady(query,p);
 await require('../pool-membership/pool-candidate').assertInstalled(query,b.membershipNamespace);
 const catalogue=require('./pool-catalogue').build(p,{predecessorProfile}).catalogue;
 const inspected=await require('../migrations/postgres-check').inspect(query,{table:q(b.namespace)+'.schema_migrations',files:require('../migrations/catalogue').validateCatalogue(catalogue)});if(!inspected.current)throw new Error('PGSTREAM_INTAKE_CATALOGUE_PENDING');
 await require('./assignment-protocol').assertInstalled(query,{namespace:b.namespace,membershipNamespace:b.membershipNamespace,lifecycleNamespace:b.lifecycleNamespace,poolProfile:p,poolIntake:true,predecessorProfile,requireIntakeExecute:true});
 await installed(query,p,'pool-intake-installed-profile');return p;
}
async function admitTenants(query,profile,tenants){
 const p=profiles.validate(profile),owned=captureTenants(tenants),selection=await desired(query,p),seen=new Map();
 await installed(query,p,'pool-intake-installed-profile');
 for(const tenant of owned){const value=await authority(query,p,tenant);seen.set(tenant,value);if(value.eligibility!=='deleted')await checkpoint(query,p,tenant,selection);}
 for(const tenant of owned){const value=await authority(query,p,tenant),old=seen.get(tenant);if(value.identity!==old.identity||value.generation!==old.generation||value.eligibility!==old.eligibility)throw new Error('PGSTREAM_INTAKE_LIFECYCLE_CHANGED');}
 await installed(query,p,'pool-intake-installed-profile');return Object.freeze({tenants:owned.length,revision:selection.revision});
}
async function observe(query,profile,backendPid,observations){
 const p=profiles.validate(profile),b=p.binding,batch=capture(p,observations),selection=await desired(query,p,backendPid),seen=new Map(),generations=Object.create(null);
 for(const input of batch){const value=await authority(query,p,input.tenant);seen.set(input.tenant,value);generations[input.tenant]=value.generation;}
 const at=Date.now();work.instant(at);
 const context=Object.freeze({protocol:profiles.PROTOCOL,profile:p.digest,consumer:b.consumer+'-completed',revision:selection.revision,backendPid:String(backendPid),transactionId:selection.transaction_id,operation:'observe',observedAt:String(at),tenants:batch.map(input=>input.tenant),generations});
 await query("SELECT set_config('app.pgstream_intake',$1,true)",[JSON.stringify(context)]);
 const verify=()=>query('SELECT '+q(b.namespace)+'.pgstream_intake_assert()');await verify();
 const result=[];
 for(const input of batch){
  const current=seen.get(input.tenant);
  if(current.eligibility==='deleted'){result.push(Object.freeze({discarded:true,observed:input.observed,completed:input.observed,pendingAt:null,deliveryPending:false}));continue;}
  await query("SELECT set_config('app.current_tenant_id',$1,true)",[input.tenant]);
  result.push((await work.observeInTransaction({client:{query},table:b.namespace+'.tenant_consumer_checkpoint',consumer:b.consumer+'-completed',contractDigest:p.contractDigest,observations:[input],at}))[0]);
 }
 // Final current-authority and SQL assertion apply even to equal-version or
 // terminal-only batches, which do not fire checkpoint row triggers.
 for(const input of batch){const value=await authority(query,p,input.tenant),old=seen.get(input.tenant);if(value.identity!==old.identity||value.generation!==old.generation||value.eligibility!==old.eligibility)throw new Error('PGSTREAM_INTAKE_LIFECYCLE_CHANGED');}
 await verify();return result;
}
async function health(query,profile){
 const p=profiles.validate(profile),b=p.binding;if(!healthBindings.has(p))healthBindings.set(p,JSON.stringify(b));
 const installedRows=(await query('SELECT /* pool-intake-health-profile */ consumer,digest,contract_digest,profile=$1::jsonb AS profile_matches FROM '+q(b.namespace)+'.pgstream_intake_profile',[healthBindings.get(p)])).rows;
 if(installedRows.length!==1||installedRows[0].consumer!==b.consumer+'-completed'||installedRows[0].profile_matches!==true||installedRows[0].digest!==p.digest||installedRows[0].contract_digest!==p.contractDigest)throw new Error('PGSTREAM_INTAKE_INSTALLED_PROFILE');
 const rows=(await query('SELECT /* pool-intake-pending-health */ min(work_pending_at)::text AS oldest FROM '+q(b.namespace)+'.tenant_consumer_checkpoint WHERE consumer=$1 AND contract_digest=$2 AND work_version=2 AND work_enabled AND work_pending_at IS NOT NULL',[b.consumer+'-completed',p.contractDigest])).rows;
 if(rows.length!==1||!Object.hasOwn(rows[0],'oldest'))throw new Error('PGSTREAM_INTAKE_PENDING_HEALTH_INVALID');const oldest=rows[0].oldest===null?null:Number(rows[0].oldest);if(oldest!==null&&(!Number.isSafeInteger(oldest)||oldest<0||oldest>=8640000000000000))throw new Error('PGSTREAM_INTAKE_PENDING_HEALTH_INVALID');return {pending:oldest!==null,oldestPendingAt:oldest};
}
module.exports={admit,admitTenants,capture,captureTenants,observe,health};
