'use strict';
// Reviewed SQL plan only. Runtime never grants itself authority. ACK and
// suppression identities receive none of these extra metadata capabilities.
const {quote,bindings}=require('./partition-candidate');
const MEMBERS=Object.freeze(['pool_kind','ordinal','member_id','slice_rule','applied_members','lease_expires_at']);
const DESIRED=Object.freeze(['pool_kind','members','previous_members','slice_rule','revision']);
const ASSIGNMENT=Object.freeze(['tenant_id','consumer','work_owner_ordinal','work_assignment_revision']);
function build({outboxRole,suppressionRole,ackRole,...binding}){
 const selected=bindings(binding),role=quote(outboxRole);
 if([suppressionRole,ackRole].some(value=>value!==undefined&&(quote(value),value===outboxRole)))throw new TypeError('NOTIFICATION_PARTITION_DISTINCT_ROLES');
 const reads=[[selected.membershipNamespace,'pool_membership',MEMBERS],[selected.membershipNamespace,'pool_desired',DESIRED],[selected.checkpointNamespace,'tenant_consumer_checkpoint',ASSIGNMENT]];
 return Object.freeze([...new Set(reads.map(([namespace])=>'GRANT USAGE ON SCHEMA '+quote(namespace)+' TO '+role)),...reads.map(([namespace,table,columns])=>'GRANT SELECT('+columns.join(',')+') ON '+quote(namespace)+'.'+table+' TO '+role)]);
}
async function assertReady(query,binding){
 const selected=bindings(binding);
 for(const [namespace,table,columns] of [[selected.membershipNamespace,'pool_membership',MEMBERS],[selected.membershipNamespace,'pool_desired',DESIRED],[selected.checkpointNamespace,'tenant_consumer_checkpoint',ASSIGNMENT]]){
  const rows=(await query(`SELECT /* notification-partition-grants */ has_schema_privilege(n.oid,'USAGE') AS uses_schema,
   has_schema_privilege(n.oid,'CREATE') AS creates,pg_has_role(current_user,c.relowner,'MEMBER') AS owns,
   has_table_privilege(c.oid,'SELECT') AS broad_reads,
   has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES') AS writes,
   ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(c.oid,a.attname,'SELECT') ORDER BY a.attname) AS reads
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`,[namespace,table])).rows;
  const row=rows[0];
  if(rows.length!==1||row.uses_schema!==true||row.creates!==false||row.owns!==false||row.broad_reads!==false||row.writes!==false||JSON.stringify(row.reads)!==JSON.stringify([...columns].sort()))throw new Error('NOTIFICATION_PARTITION_GRANTS_REFUSED');
 }
}
module.exports={build,assertReady,MEMBERS,DESIRED,ASSIGNMENT};
