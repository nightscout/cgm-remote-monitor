'use strict';
// The existing maintenance DATA wrapper owns the private JS claim and closure.
// This adapter certifies its actual database claim; it never starts or commits it.
const {match}=require('./pool-partition-candidate');
const lock=require('../pool-membership/transaction-lock');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTEXT_FIELDS=Object.freeze(['artifactDigest','backendPid','bindings','birth','claimId','generation','profile','roleOID','tenant','transactionId']);
const READS=require('../pgstream/pool-checkpoint-provision-candidate').AUTHORITY_READS;
function authoritySQL(profile){
 const l='"'+profile.binding.lifecycleNamespace+'"';
 return `SELECT /* pool-notification-maintenance-authority */ pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid,current_setting('app.current_tenant_id',true) AS tenant,CURRENT_USER::regrole::oid::text AS role_oid,${l}.tenant_lifecycle_backend_birth()::text AS birth,
  w.generation::text AS generation,w.claim_id::text AS claim_id,w.artifact_digest,w.phase,a.role_oid::text AS audit_role,a.owner_pid,a.owner_birth::text AS owner_birth,a.state,a.restored_at IS NULL AS unrestored,a.activated_at IS NULL AS unactivated,
  EXISTS(SELECT 1 FROM ${l}.tenant_lifecycle_restore_authority r WHERE r.tenant_id=w.tenant_id AND r.role_oid=CURRENT_USER::regrole::oid AND r.active) AS authorized,
  EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid=pg_backend_pid() AND classid=((w.lock_key>>32)&4294967295)::oid AND objid=(w.lock_key&4294967295)::oid AND objsubid=1 AND mode='ExclusiveLock' AND granted) AS lifetime_held,
  r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication,
  pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid=to_regclass('${l}.tenant_lifecycle_windows')),'MEMBER') AS owns_lifecycle
  FROM ${l}.tenant_lifecycle_windows w JOIN ${l}.tenant_lifecycle_restore_audit a ON a.tenant_id=w.tenant_id AND a.claim_id=w.claim_id AND a.generation=w.generation AND a.artifact_digest=w.artifact_digest JOIN pg_roles r ON r.oid=CURRENT_USER::regrole WHERE w.tenant_id=$1`;
}
const BINDING_FIELDS=Object.freeze(['checkpointNamespace','consumer','evaluatorConsumer','lifecycleNamespace','membershipNamespace','namespace']);
function normalizeBindings(profile,bindings){
 profile=require('../pgstream/pool-intake-profile').validate(profile);
 if(!Array.isArray(bindings)||bindings.length<1||bindings.length>32)throw new TypeError('NOTIFICATION_MAINTENANCE_BINDINGS');
 const selected=[];
 for(let i=0;i<bindings.length;i++){
  const value=bindings[i];
  if(!value||Object.keys(value).sort().join(',')!==BINDING_FIELDS.join(','))throw new TypeError('NOTIFICATION_MAINTENANCE_BINDINGS');
  const copy=Object.fromEntries(BINDING_FIELDS.map(key=>[key,value[key]])),namespace=copy.namespace;
  require('./partition-candidate').quote(namespace);
  if([profile.binding.namespace,profile.binding.membershipNamespace,profile.binding.lifecycleNamespace].includes(namespace))throw new TypeError('NOTIFICATION_MAINTENANCE_BINDINGS');
  delete copy.namespace;const binding=match(copy,profile).selected;
  selected.push(Object.freeze({...binding,namespace}));
 }
 if(new Set(selected.map(scope=>scope.namespace)).size!==selected.length)throw new TypeError('NOTIFICATION_MAINTENANCE_BINDINGS');
 return Object.freeze(selected.sort((a,b)=>a.namespace<b.namespace?-1:a.namespace>b.namespace?1:0));
}
async function prepareDelete(query,options){
 if(!options||Object.keys(options).sort().join(',')!=='bindings,generation,profile,tenant')throw new TypeError('NOTIFICATION_MAINTENANCE_INPUT');
 let {profile,generation}=options;const {tenant}=options;
 profile=require('../pgstream/pool-intake-profile').validate(profile);
 const bindings=normalizeBindings(profile,options.bindings);
 if(typeof query!=='function'||typeof tenant!=='string'||!UUID.test(tenant)||tenant==='00000000-0000-0000-0000-000000000000')throw new TypeError('NOTIFICATION_MAINTENANCE_INPUT');
 generation=require('../tenant-lifecycle/generation-domain').assertGeneration(generation);
 let original;
 async function authority(){
  const rows=(await query(authoritySQL(profile),[tenant])).rows,row=rows[0];
  if(rows.length!==1||!row||!Number.isSafeInteger(row.pid)||row.pid<1||typeof row.xid!=='string'||!/^[1-9][0-9]*$/.test(row.xid)||row.tenant!==tenant||row.generation!==generation||row.phase!=='suspended'||typeof row.claim_id!=='string'||!UUID.test(row.claim_id)||typeof row.artifact_digest!=='string'||!/^[a-f0-9]{64}$/.test(row.artifact_digest)||typeof row.role_oid!=='string'||!/^[1-9][0-9]*$/.test(row.role_oid)||typeof row.birth!=='string'||!row.birth||row.audit_role!==row.role_oid||row.owner_pid!==row.pid||row.owner_birth!==row.birth||row.state!=='suspended'||row.unrestored!==true||row.unactivated!==true||row.authorized!==true||row.lifetime_held!==true||['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication','owns_lifecycle'].some(key=>row[key]!==false))throw new Error('NOTIFICATION_MAINTENANCE_AUTHORITY');
  const identity={artifactDigest:row.artifact_digest,backendPid:row.pid,birth:row.birth,claimId:row.claim_id,bindings,generation,profile:profile.digest,roleOID:row.role_oid,tenant,transactionId:row.xid};
  if(original&&JSON.stringify(identity)!==JSON.stringify(original))throw new Error('NOTIFICATION_MAINTENANCE_IDENTITY_CHANGED');
  original=Object.freeze(identity);return original;
 }
 // Lifetime exclusion is observed before cohort acquisition. Routed/autocommit
 // queries fail the subsequent exact transaction comparison.
 await authority();
 const held=await lock.lock(query,profile.binding.membershipNamespace,'evaluator');
 if(held.backend_pid!==original.backendPid||held.transaction_id!==original.transactionId)throw new Error('NOTIFICATION_MAINTENANCE_TRANSACTION');
 await authority();
 const keys=lock.key(profile.binding.membershipNamespace,'evaluator');
 const rows=(await query(`SELECT /* pool-notification-maintenance-cohort */ EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid=pg_backend_pid() AND classid=$1::oid AND objid=$2::oid AND objsubid=2 AND mode='ExclusiveLock' AND granted) AS held,pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid`,keys.map(key=>String(key>>>0)))).rows;
 if(rows.length!==1||rows[0].held!==true||rows[0].pid!==original.backendPid||rows[0].xid!==original.transactionId)throw new Error('NOTIFICATION_MAINTENANCE_COHORT');
 await query("SELECT set_config('app.pgstream_notification_maintenance',$1,true)",[JSON.stringify(original)]);
 return Object.freeze({tenant,generation,claimId:original.claimId,staged:true,bindings});
}
function deleteBody(profile,binding){
 const matched=match(binding,profile);profile=matched.profile;binding=matched.selected;
 const expected=JSON.stringify(binding).replaceAll("'","''");
 const l='"'+profile.binding.lifecycleNamespace+'"',m=profile.binding.membershipNamespace;
 return `
  IF TG_OP='DELETE' AND NULLIF(current_setting('app.pgstream_notification_maintenance',true),'') IS NOT NULL THEN
    maintenance:=current_setting('app.pgstream_notification_maintenance',true)::jsonb;
    IF maintenance IS NULL OR jsonb_typeof(maintenance) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(maintenance) k) IS DISTINCT FROM ARRAY[${CONTEXT_FIELDS.map(key=>"'"+key+"'").join(',')}]::text[] OR maintenance->>'profile' IS DISTINCT FROM '${profile.digest}' OR maintenance->>'tenant' IS DISTINCT FROM subject::text OR current_setting('app.current_tenant_id',true) IS DISTINCT FROM subject::text OR maintenance->>'backendPid' IS DISTINCT FROM pg_backend_pid()::text OR maintenance->>'transactionId' IS DISTINCT FROM pg_current_xact_id()::text OR maintenance->>'generation' IS NULL OR maintenance->>'generation' !~ '^[1-9][0-9]{0,18}$' OR (maintenance->>'generation')::numeric>${require('../pgstream/pool-intake-profile').DOMAIN.completeMaximum}::numeric THEN RAISE EXCEPTION 'NOTIFICATION_MAINTENANCE_CONTEXT' USING ERRCODE='55000'; END IF;
    IF jsonb_typeof(maintenance->'bindings') IS DISTINCT FROM 'array' OR jsonb_array_length(maintenance->'bindings') NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION 'NOTIFICATION_MAINTENANCE_BINDINGS' USING ERRCODE='55000'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(maintenance->'bindings') entry WHERE jsonb_typeof(entry) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(entry) k) IS DISTINCT FROM ARRAY[${BINDING_FIELDS.map(key=>"'"+key+"'").join(',')}]::text[] OR entry->>'checkpointNamespace' IS DISTINCT FROM '${binding.checkpointNamespace}' OR entry->>'membershipNamespace' IS DISTINCT FROM '${binding.membershipNamespace}' OR entry->>'lifecycleNamespace' IS DISTINCT FROM '${binding.lifecycleNamespace}' OR entry->>'evaluatorConsumer' IS DISTINCT FROM '${binding.evaluatorConsumer}' OR jsonb_typeof(entry->'namespace') IS DISTINCT FROM 'string' OR entry->>'namespace' !~ '^[a-z][a-z0-9_]{0,62}$' OR left(entry->>'namespace',3)='pg_' OR entry->>'namespace' IN ('public','information_schema','${binding.checkpointNamespace}','${binding.membershipNamespace}','${binding.lifecycleNamespace}') OR jsonb_typeof(entry->'consumer') IS DISTINCT FROM 'string' OR entry->>'consumer' !~ '^[A-Za-z0-9_-]{1,128}$') OR (SELECT count(DISTINCT entry->>'namespace') FROM jsonb_array_elements(maintenance->'bindings') entry)<>jsonb_array_length(maintenance->'bindings') OR (SELECT array_agg(entry->>'namespace' ORDER BY position) FROM jsonb_array_elements(maintenance->'bindings') WITH ORDINALITY e(entry,position)) IS DISTINCT FROM (SELECT array_agg(entry->>'namespace' ORDER BY (entry->>'namespace') COLLATE "C") FROM jsonb_array_elements(maintenance->'bindings') entry) THEN RAISE EXCEPTION 'NOTIFICATION_MAINTENANCE_BINDINGS' USING ERRCODE='55000'; END IF;
    SELECT entry INTO maintenance_scope FROM jsonb_array_elements(maintenance->'bindings') entry WHERE entry->>'namespace'=TG_TABLE_SCHEMA AND entry->>'consumer'=route;
    IF NOT FOUND OR maintenance_scope IS DISTINCT FROM ('${expected}'::jsonb||jsonb_build_object('namespace',TG_TABLE_SCHEMA)) THEN RAISE EXCEPTION 'NOTIFICATION_MAINTENANCE_SCOPE' USING ERRCODE='55000'; END IF;
    maintenance_birth:=${l}.tenant_lifecycle_backend_birth()::text; maintenance_role:=CURRENT_USER::regrole::oid::text;
    SELECT w.lock_key,w.phase,w.generation::text AS generation,w.claim_id::text AS claim_id,w.artifact_digest,a.role_oid::text AS role_oid,a.owner_pid,a.owner_birth::text AS owner_birth,a.state,a.restored_at,a.activated_at,
      EXISTS(SELECT 1 FROM ${l}.tenant_lifecycle_restore_authority r WHERE r.tenant_id=w.tenant_id AND r.role_oid=CURRENT_USER::regrole::oid AND r.active) AS authorized
      INTO lifetime FROM ${l}.tenant_lifecycle_windows w JOIN ${l}.tenant_lifecycle_restore_audit a ON a.tenant_id=w.tenant_id AND a.claim_id=w.claim_id AND a.generation=w.generation AND a.artifact_digest=w.artifact_digest WHERE w.tenant_id=subject;
    IF NOT FOUND OR lifetime.phase<>'suspended' OR lifetime.claim_id IS NULL OR lifetime.artifact_digest IS NULL OR lifetime.authorized IS DISTINCT FROM true OR lifetime.generation IS DISTINCT FROM maintenance->>'generation' OR lifetime.claim_id IS DISTINCT FROM maintenance->>'claimId' OR lifetime.artifact_digest IS DISTINCT FROM maintenance->>'artifactDigest' OR lifetime.role_oid IS DISTINCT FROM maintenance_role OR lifetime.role_oid IS DISTINCT FROM maintenance->>'roleOID' OR lifetime.owner_pid IS DISTINCT FROM pg_backend_pid() OR lifetime.owner_birth IS DISTINCT FROM maintenance_birth OR lifetime.owner_birth IS DISTINCT FROM maintenance->>'birth' OR lifetime.activated_at IS NOT NULL THEN RAISE EXCEPTION 'NOTIFICATION_MAINTENANCE_AUTHORITY' USING ERRCODE='55000'; END IF;
    IF (TG_WHEN='BEFORE' AND (lifetime.state<>'suspended' OR lifetime.restored_at IS NOT NULL)) OR (TG_WHEN='AFTER' AND (lifetime.state<>'restored' OR lifetime.restored_at IS NULL)) THEN RAISE EXCEPTION 'NOTIFICATION_MAINTENANCE_AUDIT_STAGE' USING ERRCODE='55000'; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid=pg_backend_pid() AND classid=((lifetime.lock_key>>32)&4294967295)::oid AND objid=(lifetime.lock_key&4294967295)::oid AND objsubid=1 AND mode='ExclusiveLock' AND granted) THEN RAISE EXCEPTION 'NOTIFICATION_MAINTENANCE_LIFETIME' USING ERRCODE='55000'; END IF;
    bytes:=sha256(convert_to('nightscout:pool-membership:xact:v1:${m}:evaluator','UTF8'));
    high_key:=((get_byte(bytes,0)::bigint<<24)+(get_byte(bytes,1)::bigint<<16)+(get_byte(bytes,2)::bigint<<8)+get_byte(bytes,3))::oid;
    low_key:=((get_byte(bytes,4)::bigint<<24)+(get_byte(bytes,5)::bigint<<16)+(get_byte(bytes,6)::bigint<<8)+get_byte(bytes,7))::oid;
    IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid=pg_backend_pid() AND classid=high_key AND objid=low_key AND objsubid=2 AND mode='ExclusiveLock' AND granted) THEN RAISE EXCEPTION 'NOTIFICATION_MAINTENANCE_COHORT' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
`;
}
module.exports={prepareDelete,authoritySQL,deleteBody,READS,CONTEXT_FIELDS,BINDING_FIELDS,normalizeBindings};
