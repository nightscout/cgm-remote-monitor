'use strict';
// Proposed selected-worker SQL plan. Runtime checks authority; it never grants it.
const {INPUT_COLUMNS}=require('./assignment-candidate');
const UPDATES=Object.freeze(['checkpoint','projection','contract_digest','work_completed','work_pending_at','work_due_at','work_completed_at','delivery_revision','delivery_ack_revision','output_identity','output_digest','output_revision','output_restore_generation']);
const MEMBERS=Object.freeze(['pool_kind','ordinal','member_id','slice_rule','applied_members','lease_expires_at']);
const DESIRED=Object.freeze(['pool_kind','members','previous_members','slice_rule','revision']);
const quote=name=>{if(typeof name!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(name)||name.startsWith('pg_')||['public','information_schema'].includes(name))throw new TypeError('EVALUATOR_WORKER_GRANTS_BINDING');return '"'+name+'"';};
function binding({namespace,consumer,assignment,ordinal,membershipNamespace}){
 quote(namespace);quote(membershipNamespace);
 if(!/^evaluator-[A-Za-z0-9_-]{1,100}$/.test(consumer)||!Array.isArray(assignment?.tenants)||typeof assignment.owner!=='function'||!Number.isInteger(ordinal)||ordinal<0||ordinal>=assignment.members)throw new TypeError('EVALUATOR_WORKER_GRANTS_BINDING');
 const tenants=assignment.tenants.filter(tenant=>assignment.owner(tenant)===ordinal);
 if(tenants.some(tenant=>!/^[0-9a-f-]{36}$/.test(tenant)))throw new TypeError('EVALUATOR_WORKER_GRANTS_BINDING');
 const expression="tenant_id = ANY ('{"+tenants.join(',')+"}'::uuid[]) AND consumer = ANY ('{"+consumer+','+consumer+"-completed}'::text[])";
 return {namespace,consumer,ordinal,membershipNamespace,expression};
}
function build({role,...options}){
 const selected=binding(options),principal=quote(role),table=quote(selected.namespace)+'.tenant_consumer_checkpoint';
 return Object.freeze([
  'GRANT USAGE ON SCHEMA '+quote(selected.namespace)+' TO '+principal,
  'GRANT SELECT ON '+table+' TO '+principal,
  'GRANT UPDATE('+UPDATES.join(',')+') ON '+table+' TO '+principal,
  ...['restrict','allow'].map(kind=>'CREATE POLICY pgstream_worker_'+kind+'_'+selected.ordinal+' ON '+table+' AS '+(kind==='restrict'?'RESTRICTIVE':'PERMISSIVE')+' FOR ALL TO '+principal+' USING ('+selected.expression+') WITH CHECK ('+selected.expression+')'),
  'GRANT USAGE ON SCHEMA '+quote(selected.membershipNamespace)+' TO '+principal,
  ...[['pool_membership',MEMBERS],['pool_desired',DESIRED]].map(([table,columns])=>'GRANT SELECT('+columns.join(',')+') ON '+quote(selected.membershipNamespace)+'.'+table+' TO '+principal)
 ]);
}
const normalize=value=>typeof value==='string'?value.replace(/[\s()]/g,''):null;
async function assertReady(query,options){
 const selected=binding(options);
 const rows=(await query(`SELECT /* evaluator-worker-grants */ current_user AS principal,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication,
  EXISTS(SELECT 1 FROM pg_roles other WHERE other.oid<>r.oid AND pg_has_role(r.oid,other.oid,'MEMBER')) AS memberships,
  has_schema_privilege(n.oid,'USAGE') AS uses_schema,has_schema_privilege(n.oid,'CREATE') AS creates,
  pg_has_role(current_user,c.relowner,'MEMBER') AS owns,c.relrowsecurity AND c.relforcerowsecurity AS secured,
  has_table_privilege(c.oid,'SELECT') AS reads,
  has_table_privilege(c.oid,'INSERT,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(c.oid,'INSERT,REFERENCES') AS forbidden,
  ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(c.oid,a.attname,'UPDATE') ORDER BY a.attname) AS updates
  FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE r.rolname=current_user AND n.nspname=$1 AND c.relname='tenant_consumer_checkpoint'`,[selected.namespace])).rows;
 const row=rows[0];
 if(rows.length!==1||!row.principal||row.uses_schema!==true||row.secured!==true||row.reads!==true||['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication','memberships','creates','owns','forbidden'].some(key=>row[key]!==false)||JSON.stringify(row.updates)!==JSON.stringify([...UPDATES].sort()))throw new Error('EVALUATOR_WORKER_GRANTS_REFUSED');
 const policies=(await query(`SELECT /* evaluator-worker-policies */ p.polname AS name,p.polcmd AS command,p.polpermissive AS permissive,
  pg_get_expr(p.polqual,p.polrelid) AS "using",pg_get_expr(p.polwithcheck,p.polrelid) AS "check"
  FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname=$1 AND c.relname='tenant_consumer_checkpoint' AND (SELECT oid FROM pg_roles WHERE rolname=current_user)=ANY(p.polroles)`,[selected.namespace])).rows;
 if(policies.length!==2||policies.some(p=>!['pgstream_worker_allow_'+selected.ordinal,'pgstream_worker_restrict_'+selected.ordinal].includes(p.name)||p.command!=='*'||p.permissive!==(p.name==='pgstream_worker_allow_'+selected.ordinal)||normalize(p.using)!==normalize(selected.expression)||normalize(p.check)!==normalize(selected.expression))||new Set(policies.map(p=>p.name)).size!==2)throw new Error('EVALUATOR_WORKER_POLICY_REFUSED');
 return Object.freeze({principal:row.principal,ordinal:selected.ordinal});
}
module.exports={build,assertReady,UPDATES,INPUT_COLUMNS};
