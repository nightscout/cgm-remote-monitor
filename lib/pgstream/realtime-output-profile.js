'use strict';
// Selected completed-output reader admission. It grants no receipt, completion,
// ownership or migration capability. Catalogue reads occur at boot/recovery.
const profiles=require('./intake-profile'),windows=require('../tenant-lifecycle/operation-window');
const states=new WeakMap(),rosters=new WeakMap(),q=name=>'"'+name+'"';
const fail=()=>new Error('REALTIME_INTAKE_PROFILE_REFUSED');
function binding(config,window){
 if(config.intakeProfile===undefined)return undefined;
 const p=profiles.validate(config.intakeProfile),b=p.binding;
 if(!windows.isWindow(window)||window.namespace!==b.lifecycleNamespace||window.intakeProfileDigest!==p.digest||config.completedOutput?.namespace!==b.namespace||config.completedOutput?.consumer!==b.consumer)throw fail();
 return p;
}
function grants({profile,role}){
 const p=profiles.validate(profile);if(!profiles.name(role)||role===p.binding.role)throw fail();
 return Object.freeze(['GRANT USAGE ON SCHEMA '+q(p.binding.namespace)+' TO '+q(role),
  'GRANT SELECT(name,checksum) ON '+q(p.binding.namespace)+'.schema_migrations TO '+q(role),
  'GRANT SELECT(consumer,profile,digest,contract_digest) ON '+q(p.binding.namespace)+'.pgstream_intake_profile TO '+q(role)]);
}
async function installed(connection,p){
 const query=connection.readOnly.bind(connection),b=p.binding;
 const rows=(await query('SELECT /* realtime-installed-intake-profile */ consumer,profile,digest,contract_digest FROM '+q(b.namespace)+'.pgstream_intake_profile')).rows;
 if(rows.length!==1||rows[0].consumer!==b.consumer+'-completed'||rows[0].digest!==p.digest||rows[0].contract_digest!==p.contractDigest||profiles.validate({...p,binding:rows[0].profile}).digest!==p.digest)throw fail();
 const catalogue=require('./assignment-candidate').build({membershipNamespace:b.membershipNamespace,lifecycleNamespace:b.lifecycleNamespace,intakeProfile:p}).catalogue;
 const ledger=await require('../migrations/postgres-check').inspect(query,{table:q(b.namespace)+'.schema_migrations',files:require('../migrations/catalogue').validateCatalogue(catalogue)});
 if(!ledger.current)throw fail();
 await require('./assignment-protocol').assertInstalled(query,{namespace:b.namespace,membershipNamespace:b.membershipNamespace,lifecycleNamespace:b.lifecycleNamespace,intakeProfile:p});
 const tables=[b.namespace+'.schema_migrations',b.namespace+'.pgstream_intake_profile',b.namespace+'.tenant_consumer_checkpoint'];
 const rights=(await query(`SELECT /* realtime-intake-source-readonly */ n.nspname||'.'||c.relname AS relation,c.relkind AS kind,c.relpersistence AS persistence,
 pg_has_role(current_user,c.relowner,'MEMBER') AS owns,has_schema_privilege(n.oid,'CREATE') AS creates,
 has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES') AS writes,
 has_table_privilege(c.oid,'SELECT') OR has_any_column_privilege(c.oid,'SELECT') AS reads,
 EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname||'.'||c.relname=ANY($1::text[])`,[tables])).rows;
 if(rights.length!==3||new Set(rights.map(row=>row.relation)).size!==3||rights.some(row=>!tables.includes(row.relation)||row.kind!=='r'||row.persistence!=='p'||row.owns!==false||row.creates!==false||row.writes!==false||row.reads!==true||row.inherited!==false))throw fail();
}
async function open({config,connection,operationWindow}){
 const p=binding(config,operationWindow);if(!p)return undefined;
 if(typeof connection?.readOnly!=='function')throw fail();
 const state={profile:p,connection,window:operationWindow,verified:false,closed:false};
 const token=Object.freeze({async verify(){state.verified=false;if(state.closed)throw fail();binding(config,operationWindow);await installed(connection,p);binding(config,operationWindow);state.verified=true;},close(){state.verified=false;state.closed=true;}});
 states.set(token,state);await token.verify();return token;
}
function admitted({config,connection,operationWindow,admission}){
 const p=binding(config,operationWindow);if(!p)return undefined;
 const state=states.get(admission);
 if(!state||!state.verified||state.closed||state.connection!==connection||state.window!==operationWindow||state.profile.digest!==p.digest)throw fail();
 return state.profile;
}
function roster(profile,tenants){
 if(!profile)return;
 profile=profiles.validate(profile);let known=rosters.get(profile);if(!known){known=new Set(profile.binding.tenants);rosters.set(profile,known);}
 if(!Array.isArray(tenants)||new Set(tenants).size!==tenants.length||tenants.some(tenant=>!known.has(tenant)))throw fail();return profile;
}
function rows(profile,tenants,values){
 if(!profile)return;profile=roster(profile,tenants);
 if(values.length!==tenants.length||new Set(values.map(row=>row.tenant)).size!==tenants.length||values.some(row=>!tenants.includes(row.tenant)||row.contract_digest!==profile.contractDigest||row.work_version!==2||row.work_owner_ordinal!==profile.assignment.owner(row.tenant)||row.work_assignment_revision!==profile.binding.revision))throw fail();
}
module.exports={binding,grants,open,admitted,roster,rows};
