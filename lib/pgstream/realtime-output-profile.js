'use strict';
// Selected completed-output reader admission. It grants no receipt, completion,
// ownership or migration capability. Catalogue reads occur at boot/recovery.
const profiles=require('./intake-profile'),domain=require('../tenant-lifecycle/generation-domain'),windows=require('../tenant-lifecycle/operation-window');
const states=new WeakMap(),rosters=new WeakMap(),q=name=>'"'+name+'"';
const fail=()=>new Error('REALTIME_INTAKE_PROFILE_REFUSED');
function binding(config,window){
 if(config.intakeProfile===undefined)return undefined;
 const p=domain.recognize(config.intakeProfile),b=p.binding;
 provenance(config,p);
 if(!windows.isWindow(window)||window.namespace!==b.lifecycleNamespace||window.intakeProfileDigest!==p.digest||config.completedOutput?.namespace!==b.namespace||config.completedOutput?.consumer!==b.consumer)throw fail();
 return p;
}
function provenance(config,p){
 if(config.predecessorProfile===undefined)return undefined;
 if(!domain.isPool(p))throw fail();const old=profiles.validate(config.predecessorProfile);
 if(['namespace','membershipNamespace','lifecycleNamespace','consumer'].some(key=>old.binding[key]!==p.binding[key]))throw fail();return old.digest;
}
function grants({profile,role}){
 const p=domain.recognize(profile);if(!profiles.name(role)||role===p.binding.role||role===p.binding.operatorRole)throw fail();
 return Object.freeze(['GRANT USAGE ON SCHEMA '+q(p.binding.namespace)+' TO '+q(role),
  'GRANT SELECT(name,checksum) ON '+q(p.binding.namespace)+'.schema_migrations TO '+q(role),
  'GRANT SELECT(consumer,profile,digest,contract_digest) ON '+q(p.binding.namespace)+'.pgstream_intake_profile TO '+q(role),...(domain.isPool(p)?[
  'GRANT USAGE ON SCHEMA '+q(p.binding.membershipNamespace)+' TO '+q(role),
  'GRANT SELECT(name,checksum) ON '+q(p.binding.membershipNamespace)+'.schema_migrations TO '+q(role),
  'GRANT SELECT(pool_kind,members,previous_members,slice_rule,revision,partitioned,previous_partitioned) ON '+q(p.binding.membershipNamespace)+'.pool_desired TO '+q(role)]:[])]);
}
async function installed(connection,p,predecessorProfile){
 const query=connection.readOnly.bind(connection),b=p.binding;
 const rows=(await query('SELECT /* realtime-installed-intake-profile */ consumer,profile,digest,contract_digest FROM '+q(b.namespace)+'.pgstream_intake_profile')).rows;
 if(rows.length!==1||rows[0].consumer!==b.consumer+'-completed'||rows[0].digest!==p.digest||rows[0].contract_digest!==p.contractDigest||domain.recognize({...p,binding:rows[0].profile}).digest!==p.digest)throw fail();
 const catalogue=domain.isPool(p)?require('./pool-catalogue').build(p,{predecessorProfile}).catalogue:require('./assignment-candidate').build({membershipNamespace:b.membershipNamespace,lifecycleNamespace:b.lifecycleNamespace,intakeProfile:p}).catalogue;
 const ledger=await require('../migrations/postgres-check').inspect(query,{table:q(b.namespace)+'.schema_migrations',files:require('../migrations/catalogue').validateCatalogue(catalogue)});
 if(!ledger.current)throw fail();
 await require('./assignment-protocol').assertInstalled(query,{namespace:b.namespace,membershipNamespace:b.membershipNamespace,lifecycleNamespace:b.lifecycleNamespace,...(domain.isPool(p)?{poolProfile:p,poolIntake:true,predecessorProfile}:{intakeProfile:p})});
 if(domain.isPool(p))await require('../pool-membership/pool-candidate').assertInstalled(query,b.membershipNamespace);
 const tables=[b.namespace+'.schema_migrations',b.namespace+'.pgstream_intake_profile',b.namespace+'.tenant_consumer_checkpoint',...(domain.isPool(p)?[b.membershipNamespace+'.schema_migrations',b.membershipNamespace+'.pool_desired']:[])];
 const rights=(await query(`SELECT /* realtime-intake-source-readonly */ n.nspname||'.'||c.relname AS relation,c.relkind AS kind,c.relpersistence AS persistence,
 pg_has_role(current_user,c.relowner,'MEMBER') AS owns,has_schema_privilege(n.oid,'CREATE') AS creates,
 has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES') AS writes,
 has_table_privilege(c.oid,'SELECT') OR has_any_column_privilege(c.oid,'SELECT') AS reads,
 EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname||'.'||c.relname=ANY($1::text[])`,[tables])).rows;
 if(rights.length!==tables.length||new Set(rights.map(row=>row.relation)).size!==tables.length||rights.some(row=>!tables.includes(row.relation)||row.kind!=='r'||row.persistence!=='p'||row.owns!==false||row.creates!==false||row.writes!==false||row.reads!==true||row.inherited!==false))throw fail();
}
async function open({config,connection,operationWindow}){
 const p=binding(config,operationWindow);if(!p)return undefined;
 if(typeof connection?.readOnly!=='function')throw fail();
 const state={profile:p,predecessor:provenance(config,p),connection,window:operationWindow,verified:false,closed:false};
 const token=Object.freeze({async verify(){state.verified=false;if(state.closed||state.predecessor!==provenance(config,p))throw fail();binding(config,operationWindow);if(domain.isPool(p))await installed(connection,p,config.predecessorProfile);else await installed(connection,p);binding(config,operationWindow);state.verified=true;},close(){state.verified=false;state.closed=true;}});
 states.set(token,state);await token.verify();return token;
}
function admitted({config,connection,operationWindow,admission}){
 const p=binding(config,operationWindow);if(!p)return undefined;
 const state=states.get(admission);
 if(!state||!state.verified||state.closed||state.connection!==connection||state.window!==operationWindow||state.profile.digest!==p.digest||state.predecessor!==provenance(config,p))throw fail();
 return state.profile;
}
function roster(profile,tenants,config){
 if(!profile)return;
 profile=domain.recognize(profile);
 if(domain.isPool(profile)){if(!config||!(config.tenants instanceof Map)||!Number.isSafeInteger(config.maxTenants)||config.maxTenants<1||config.maxTenants>10000||!Array.isArray(tenants)||tenants.length>config.maxTenants||new Set(tenants).size!==tenants.length||tenants.some(tenant=>typeof tenant!=='string'||!UUID.test(tenant)||!config.tenants.has(tenant)))throw fail();return profile;}
 let known=rosters.get(profile);if(!known){known=new Set(profile.binding.tenants);rosters.set(profile,known);}
 if(!Array.isArray(tenants)||new Set(tenants).size!==tenants.length||tenants.some(tenant=>!known.has(tenant)))throw fail();return profile;
}
function rows(profile,tenants,values,config){
 if(!profile)return;profile=roster(profile,tenants,config);
 if(domain.isPool(profile)){poolRows(profile,tenants,values);return;}
 if(values.length!==tenants.length||new Set(values.map(row=>row.tenant)).size!==tenants.length||values.some(row=>!tenants.includes(row.tenant)||row.contract_digest!==profile.contractDigest||row.work_version!==2||row.work_owner_ordinal!==profile.assignment.owner(row.tenant)||row.work_assignment_revision!==profile.binding.revision))throw fail();
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function poolRows(profile,tenants,values){
 if(!Array.isArray(values)||values.length!==tenants.length||new Set(values.map(row=>row.tenant)).size!==tenants.length)throw fail();
 for(const row of values){
  let desired;try{desired=require('../pool-membership/pool-candidate').placement({members:row.members,previousMembers:row.previous_members,revision:row.assignment_revision,rule:row.slice_rule,partitioned:row.partitioned,previousPartitioned:row.previous_partitioned});}catch{throw fail();}
  if(row.pool_kind!=='evaluator'||!tenants.includes(row.tenant)||row.contract_digest!==profile.contractDigest||row.work_version!==2||row.work_assignment_revision!==desired.revision||row.work_owner_ordinal!==require('../pool-membership/slice').bucket(row.tenant,desired.members))throw fail();
 }
}
async function scan(profile,tenants,connection,config){
 roster(profile,tenants,config);const b=profile.binding;
 const values=(await connection.readOnly('SELECT /* realtime-pool-current-output */ c.tenant_id::text AS tenant,c.output_revision::text AS revision,c.work_enabled,c.contract_digest,c.work_version,c.work_owner_ordinal,c.work_assignment_revision::text AS work_assignment_revision,d.pool_kind,d.members,d.previous_members,d.slice_rule,d.revision::text AS assignment_revision,d.partitioned,d.previous_partitioned FROM '+q(b.namespace)+'.tenant_consumer_checkpoint c CROSS JOIN '+q(b.membershipNamespace)+'.pool_desired d WHERE d.pool_kind=$1 AND c.consumer=$2 AND c.tenant_id=ANY($3::uuid[])',['evaluator',b.consumer+'-completed',tenants])).rows;
 poolRows(profile,tenants,values);return values;
}
module.exports={binding,grants,open,admitted,roster,rows,scan};
