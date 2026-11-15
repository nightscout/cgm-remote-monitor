'use strict';
const {validate,CONTROL_READS,WORK_CATALOGUE_READ}=require('./intake-profile');
const UPDATES=Object.freeze(['work_observed','work_observed_at','work_enabled','work_activity_enabled','work_lifecycle_enabled','work_pending_at','delivery_revision']);
const READS=Object.freeze(['tenant_id','consumer','contract_digest',...require('./work-state').COLUMNS,'work_owner_ordinal','work_assignment_revision']);
const PROFILE=Object.freeze(['consumer','profile','digest','contract_digest']);
const DESIRED=Object.freeze(['pool_kind','members','previous_members','slice_rule','revision']);
const LIFE=Object.freeze(['tenant_id','phase']);
const q=n=>'"'+n+'"';
function expression(profile){const b=validate(profile).binding;return "tenant_id = ANY ('{"+b.tenants.join(',')+"}'::uuid[]) AND consumer = ANY ('{"+b.consumer+"-completed}'::text[])";}
function build(profile){const p=validate(profile),b=p.binding,role=q(b.role),table=q(b.namespace)+'.tenant_consumer_checkpoint',policy=expression(p);return Object.freeze([
 ...[b.namespace,b.membershipNamespace,b.lifecycleNamespace].map(n=>'GRANT USAGE ON SCHEMA '+q(n)+' TO '+role),
 'GRANT SELECT('+[...new Set(READS)].join(',')+'), UPDATE('+UPDATES.join(',')+') ON '+table+' TO '+role,
 ...['restrict','allow'].map(kind=>'CREATE POLICY pgstream_intake_'+kind+' ON '+table+' AS '+(kind==='restrict'?'RESTRICTIVE':'PERMISSIVE')+' FOR ALL TO '+role+' USING ('+policy+') WITH CHECK ('+policy+')'),
 'GRANT SELECT('+WORK_CATALOGUE_READ.join(',')+') ON '+q(b.namespace)+'.schema_migrations TO '+role,
 'GRANT SELECT('+PROFILE.join(',')+') ON '+q(b.namespace)+'.pgstream_intake_profile TO '+role,
 'GRANT SELECT('+DESIRED.join(',')+') ON '+q(b.membershipNamespace)+'.pool_desired TO '+role,
 ...Object.keys(CONTROL_READS).map(table=>'GRANT SELECT ON '+q(b.lifecycleNamespace)+'.'+table+' TO '+role)
]);}
const sorted=xs=>JSON.stringify([...new Set(xs)].sort());
async function assertReady(query,profile){const p=validate(profile),b=p.binding;
 const role=(await query(`SELECT /* intake-role */ current_user AS principal,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolinherit,
 EXISTS(SELECT 1 FROM pg_roles other WHERE other.oid<>r.oid AND pg_has_role(r.oid,other.oid,'MEMBER')) AS memberships FROM pg_roles r WHERE rolname=current_user`)).rows;
 if(role.length!==1||role[0].principal!==b.role||['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication','rolinherit','memberships'].some(k=>role[0][k]!==false))throw new Error('PGSTREAM_INTAKE_ROLE_REFUSED');
 const wanted=new Map([[b.namespace+'.tenant_consumer_checkpoint',{reads:READS,updates:UPDATES,secured:true}],[b.namespace+'.schema_migrations',{reads:WORK_CATALOGUE_READ,updates:[],secured:false}],[b.namespace+'.pgstream_intake_profile',{reads:PROFILE,updates:[],secured:false}],[b.membershipNamespace+'.pool_desired',{reads:DESIRED,updates:[],secured:false}],...Object.entries(CONTROL_READS).map(([table,reads])=>[b.lifecycleNamespace+'.'+table,{reads,updates:[],secured:table!=='schema_migrations'}])]);
 const rows=(await query(`SELECT /* intake-effective-grants */ n.nspname||'.'||c.relname AS relation,c.relkind AS kind,c.relpersistence AS persistence,c.relrowsecurity AS rls,c.relforcerowsecurity AS forced,EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited,pg_has_role(current_user,c.relowner,'MEMBER') AS owns,
 has_schema_privilege(n.oid,'USAGE') AS uses_schema,has_schema_privilege(n.oid,'CREATE') AS creates,c.relrowsecurity AND c.relforcerowsecurity AS secured,
 has_table_privilege(c.oid,'INSERT,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(c.oid,'INSERT,REFERENCES') AS forbidden,
 ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(c.oid,a.attname,'SELECT') ORDER BY a.attname) AS reads,
 ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(c.oid,a.attname,'UPDATE') ORDER BY a.attname) AS updates
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname||'.'||c.relname=ANY($1::text[])`,[[...wanted.keys()]])).rows;
 if(rows.length!==wanted.size||new Set(rows.map(r=>r.relation)).size!==wanted.size||rows.some(r=>{const w=wanted.get(r.relation);return !w||r.kind!=='r'||r.persistence!=='p'||r.inherited!==false||r.rls!==w.secured||r.forced!==w.secured||r.owns!==false||r.uses_schema!==true||r.creates!==false||r.forbidden!==false||w.secured&&r.secured!==true||sorted(r.reads)!==sorted(w.reads)||sorted(r.updates)!==sorted(w.updates);}))throw new Error('PGSTREAM_INTAKE_GRANTS_REFUSED');
 // No undeclared relation authority anywhere, including a privilege
 // inherited through PUBLIC or another namespace. Only the explicit seven
 // checkpoint input/derived columns are writable.
 const extra=(await query(`SELECT /* intake-other-rights */ n.nspname||'.'||c.relname AS relation FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND (has_table_privilege(c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(c.oid,'SELECT,UPDATE,INSERT,REFERENCES')) AND NOT n.nspname||'.'||c.relname=ANY($1::text[])`,[[...wanted.keys()]])).rows;
 if(extra.length)throw new Error('PGSTREAM_INTAKE_EXTRA_AUTHORITY');
 const policies=(await query(`SELECT /* intake-policies */ polname AS name,polcmd AS command,polpermissive AS permissive,pg_get_expr(polqual,polrelid) AS "using",pg_get_expr(polwithcheck,polrelid) AS "check" FROM pg_policy WHERE polrelid=($1::regclass) AND (polroles=ARRAY[0::oid] OR (SELECT oid FROM pg_roles WHERE rolname=current_user)=ANY(polroles))`,[q(b.namespace)+'.tenant_consumer_checkpoint'])).rows;
 const original=policies.filter(r=>r.name==='tenant_consumer_checkpoint_isolation');
 const canonical=require('../tenant-lifecycle/catalogue-structure'),tenant="tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid";
 if(original.length!==1||original[0].command!=='*'||original[0].permissive!==true||canonical(original[0].using,b.namespace)!==canonical(tenant,b.namespace)||canonical(original[0].check,b.namespace)!==canonical(tenant,b.namespace))throw new Error('PGSTREAM_INTAKE_PUBLIC_POLICY_REFUSED');
 const selected=policies.filter(r=>r.name!=='tenant_consumer_checkpoint_isolation');
 const normalize=v=>typeof v==='string'?v.replace(/[\s()]/g,''):null;
 if(selected.length!==2||new Set(selected.map(p=>p.name)).size!==2||selected.some(r=>!['pgstream_intake_restrict','pgstream_intake_allow'].includes(r.name)||r.command!=='*'||r.permissive!==(r.name==='pgstream_intake_allow')||normalize(r.using)!==normalize(expression(p))||normalize(r.check)!==normalize(expression(p))))throw new Error('PGSTREAM_INTAKE_POLICY_REFUSED');
 return Object.freeze({principal:b.role,profile:p.digest});
}
module.exports={build,assertReady,UPDATES,READS,PROFILE,DESIRED,LIFE,CONTROL_READS,WORK_CATALOGUE_READ,expression};
