'use strict';
const {checksum}=require('../migrations/catalogue');
const profiles=require('./pool-intake-profile'),pool=require('./pool-assignment-candidate');
const {RULE,MAX_MEMBERS}=require('../pool-membership/slice');
const q=value=>'"'+value+'"',literal=value=>"'"+String(value).replace(/'/g,"''")+"'";
const CONTEXT_FIELDS=Object.freeze(['backendPid','consumer','generations','observedAt','operation','profile','protocol','revision','tenants','transactionId']);
function build({base,intakeProfile}){
 const p=profiles.validate(intakeProfile),b=p.binding,m=q(b.membershipNamespace),l=q(b.lifecycleNamespace),n=q(b.namespace);
 const expected=pool.build({base:require('./assignment-candidate').build(b),membershipNamespace:b.membershipNamespace,lifecycleNamespace:b.lifecycleNamespace,operatorRole:b.operatorRole});
 if(!base||base.assignmentBody!==expected.assignmentBody||base.effectBody!==expected.effectBody||JSON.stringify(base.catalogue)!==JSON.stringify(expected.catalogue))throw new TypeError('PGSTREAM_POOL_INTAKE_BASE');
 const deletion=require('../tenant-lifecycle/pool-authority').deletionSQL(b.lifecycleNamespace),prefix=pool.unsignedPrefix();
 const bits=BigInt.asUintN(64,BigInt(p.ownerKey)),high=(bits>>32n).toString(),low=(bits&4294967295n).toString();
 const assertBody=`
DECLARE context jsonb; installed record; bytes bytea; high_key oid; low_key oid; desired record; prior_tenant text; subject text; lifetime record; saved_checkpoint record;
BEGIN
 prior_tenant:=current_setting('app.current_tenant_id',true);
 IF prior_tenant IS NULL THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_UNINITIALIZED_TENANT_SETTING' USING ERRCODE='55000'; END IF;
 context:=NULLIF(current_setting('app.pgstream_intake',true),'')::jsonb;
 SELECT consumer,profile,digest,contract_digest INTO installed FROM ${n}.pgstream_intake_profile WHERE consumer=${literal(b.consumer+'-completed')};
 IF NOT FOUND OR installed.profile IS DISTINCT FROM ${literal(JSON.stringify(b))}::jsonb OR installed.digest IS DISTINCT FROM ${literal(p.digest)} OR installed.contract_digest IS DISTINCT FROM ${literal(p.contractDigest)} OR current_user<>${literal(b.role)} THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_PROFILE_REFUSED' USING ERRCODE='55000'; END IF;
 IF context IS NULL OR jsonb_typeof(context) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(context) k) IS DISTINCT FROM ARRAY[${CONTEXT_FIELDS.map(literal).join(',')}]::text[] OR context->>'protocol' IS DISTINCT FROM ${literal(profiles.PROTOCOL)} OR context->>'profile' IS DISTINCT FROM installed.digest OR context->>'consumer' IS DISTINCT FROM installed.consumer OR context->>'operation' IS DISTINCT FROM 'observe' OR context->>'observedAt' IS NULL OR context->>'observedAt' !~ '^(0|[1-9][0-9]{0,15})$' OR (context->>'observedAt')::numeric>=8640000000000000 OR context->>'backendPid' IS DISTINCT FROM pg_backend_pid()::text OR context->>'transactionId' IS DISTINCT FROM pg_current_xact_id()::text OR jsonb_typeof(context->'tenants') IS DISTINCT FROM 'array' OR jsonb_array_length(context->'tenants') NOT BETWEEN 1 AND 64 OR jsonb_typeof(context->'generations') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_CONTEXT_REQUIRED' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(context->'tenants') t WHERE t !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') OR (SELECT count(*) FROM jsonb_array_elements_text(context->'tenants'))<>(SELECT count(DISTINCT t) FROM jsonb_array_elements_text(context->'tenants') t) OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(context->'generations') k) IS DISTINCT FROM (SELECT array_agg(t ORDER BY t) FROM jsonb_array_elements_text(context->'tenants') t) THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_TENANTS_REFUSED' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid=pg_backend_pid() AND classid=${high}::oid AND objid=${low}::oid AND objsubid=1 AND mode='ExclusiveLock' AND granted) THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_OWNER_REQUIRED' USING ERRCODE='55000'; END IF;
 bytes:=sha256(convert_to('nightscout:pool-membership:xact:v1:${b.membershipNamespace}:evaluator','UTF8'));
 high_key:=((get_byte(bytes,0)::bigint<<24)+(get_byte(bytes,1)::bigint<<16)+(get_byte(bytes,2)::bigint<<8)+get_byte(bytes,3))::oid;
 low_key:=((get_byte(bytes,4)::bigint<<24)+(get_byte(bytes,5)::bigint<<16)+(get_byte(bytes,6)::bigint<<8)+get_byte(bytes,7))::oid;
 IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid=pg_backend_pid() AND classid=high_key AND objid=low_key AND objsubid=2 AND mode='ShareLock' AND granted) THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_SHARED_REQUIRED' USING ERRCODE='55000'; END IF;
 SELECT members,revision,slice_rule INTO desired FROM ${m}.pool_desired WHERE pool_kind='evaluator';
 IF NOT FOUND OR desired.members NOT BETWEEN 1 AND ${MAX_MEMBERS} OR desired.revision<=0 OR desired.revision::text IS DISTINCT FROM context->>'revision' OR desired.slice_rule<>'${RULE}' THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_CONFIGURATION_CHANGED' USING ERRCODE='55000'; END IF;
 BEGIN
  FOR subject IN SELECT jsonb_array_elements_text(context->'tenants') ORDER BY 1 LOOP
   PERFORM set_config('app.current_tenant_id',subject,true);
   SELECT w.phase,w.generation::text AS generation,${deletion} AS deletion INTO lifetime FROM ${l}.tenant_lifecycle_windows w WHERE w.tenant_id=subject::uuid;
   IF NOT FOUND OR lifetime.phase NOT IN ('active','suspended') OR lifetime.generation !~ '^[1-9][0-9]{0,18}$' OR lifetime.generation::numeric>${profiles.DOMAIN.completeMaximum}::numeric OR jsonb_typeof(context->'generations'->subject) IS DISTINCT FROM 'string' OR lifetime.generation IS DISTINCT FROM context->'generations'->>subject THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_LIFECYCLE_REFUSED' USING ERRCODE='55000'; END IF;
   IF NOT lifetime.deletion THEN
    SELECT contract_digest,work_version,work_owner_ordinal,work_assignment_revision INTO saved_checkpoint FROM ${n}.tenant_consumer_checkpoint WHERE tenant_id=subject::uuid AND consumer=installed.consumer;
    IF NOT FOUND OR saved_checkpoint.contract_digest IS DISTINCT FROM installed.contract_digest OR saved_checkpoint.work_version<>2 OR saved_checkpoint.work_assignment_revision IS DISTINCT FROM desired.revision THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_NOT_PROVISIONED' USING ERRCODE='55000'; END IF;
    bytes:=sha256(convert_to(subject,'UTF8'));
    IF saved_checkpoint.work_owner_ordinal IS DISTINCT FROM mod((${prefix}),desired.members)::integer THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_ASSIGNMENT_REFUSED' USING ERRCODE='55000'; END IF;
   END IF;
  END LOOP;
  PERFORM set_config('app.current_tenant_id',prior_tenant,true);
 EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.current_tenant_id',prior_tenant,true);
  RAISE;
 END;
END;
`;
 const preserved=['tenant_id','consumer','work_owner_ordinal','work_assignment_revision','checkpoint','contract_digest','projection','work_version','work_completed','work_due_at','work_completed_at','output_identity','output_digest','output_revision','output_restore_generation','delivery_ack_revision'];
 const row=(alias,columns)=>'ROW('+columns.map(column=>alias+'.'+column).join(',')+')';
 const branch=`
  IF NEW.consumer=${literal(b.consumer+'-completed')} AND (NEW.contract_digest IS DISTINCT FROM ${literal(p.contractDigest)} OR NEW.work_version<>2 OR NEW.work_owner_ordinal IS NULL) THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_ROW_PROFILE' USING ERRCODE='55000'; END IF;
  intake_context:=NULLIF(current_setting('app.pgstream_intake',true),'')::jsonb;
  IF intake_context IS NOT NULL THEN
    PERFORM ${n}.pgstream_intake_assert();
    IF NOT NEW.tenant_id::text IN (SELECT jsonb_array_elements_text(intake_context->'tenants')) OR NEW.consumer<>${literal(b.consumer+'-completed')} OR NEW.work_version<>2 OR NEW.work_assignment_revision::text IS DISTINCT FROM intake_context->>'revision' OR NEW.work_owner_ordinal IS NULL OR ${row('NEW',preserved)} IS DISTINCT FROM ${row('OLD',preserved)} THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_IMMUTABLE' USING ERRCODE='55000'; END IF;
    intake_prior:=current_setting('app.current_tenant_id',true);
    IF intake_prior IS NULL THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_UNINITIALIZED_TENANT_SETTING' USING ERRCODE='55000'; END IF;
    BEGIN
      PERFORM set_config('app.current_tenant_id',NEW.tenant_id::text,true);
      SELECT w.generation::text AS generation,w.phase,${deletion} AS deletion INTO intake_lifetime FROM ${l}.tenant_lifecycle_windows w WHERE w.tenant_id=NEW.tenant_id;
      intake_found:=FOUND;
      PERFORM set_config('app.current_tenant_id',intake_prior,true);
    EXCEPTION WHEN OTHERS THEN
      PERFORM set_config('app.current_tenant_id',intake_prior,true);
      RAISE;
    END;
    IF NOT intake_found OR intake_lifetime.deletion OR intake_lifetime.phase NOT IN ('active','suspended') OR intake_lifetime.generation IS DISTINCT FROM intake_context->'generations'->>(NEW.tenant_id::text) THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_LIFECYCLE_REFUSED' USING ERRCODE='55000'; END IF;
    IF cardinality(NEW.work_observed)<>6 OR cardinality(NEW.work_observed_at)<>6 OR EXISTS(SELECT 1 FROM generate_series(1,6) i WHERE
      (OLD.work_observed[i] IS NOT NULL AND (NEW.work_observed[i] IS NULL OR NEW.work_observed[i]<OLD.work_observed[i])) OR
      (NEW.work_observed[i] IS NOT DISTINCT FROM OLD.work_observed[i] AND NEW.work_observed_at[i] IS DISTINCT FROM OLD.work_observed_at[i]) OR
      (NEW.work_observed[i] IS DISTINCT FROM OLD.work_observed[i] AND NEW.work_observed_at[i] IS DISTINCT FROM (intake_context->>'observedAt')::bigint)) THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_VECTOR_TRANSITION' USING ERRCODE='55000'; END IF;
    IF (NEW.work_activity_enabled IS DISTINCT FROM OLD.work_activity_enabled AND NEW.work_observed[4] IS NOT DISTINCT FROM OLD.work_observed[4]) OR (NEW.work_lifecycle_enabled IS DISTINCT FROM OLD.work_lifecycle_enabled AND NEW.work_observed[5] IS NOT DISTINCT FROM OLD.work_observed[5]) OR NEW.work_enabled IS DISTINCT FROM (NEW.work_activity_enabled AND NEW.work_lifecycle_enabled) OR (OLD.work_pending_at IS NOT NULL AND NEW.work_pending_at IS DISTINCT FROM OLD.work_pending_at) OR (OLD.work_pending_at IS NULL AND NEW.work_pending_at IS DISTINCT FROM (CASE WHEN NEW.work_observed IS DISTINCT FROM OLD.work_observed THEN (intake_context->>'observedAt')::bigint ELSE NULL END)) OR NEW.delivery_revision IS DISTINCT FROM OLD.delivery_revision+(CASE WHEN NEW.work_observed[3] IS DISTINCT FROM OLD.work_observed[3] OR NEW.work_observed[4] IS DISTINCT FROM OLD.work_observed[4] OR NEW.work_observed[5] IS DISTINCT FROM OLD.work_observed[5] THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_DERIVED_TRANSITION' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
`;
 const effectBody=base.effectBody.replace('DECLARE ','DECLARE intake_context jsonb; intake_prior text; intake_lifetime record; intake_found boolean; ').replace('BEGIN\n','BEGIN\n'+branch);
 if(effectBody===base.effectBody)throw new Error('PGSTREAM_POOL_INTAKE_COMPOSITION');
 const up=[
  'CREATE TABLE pgstream_intake_profile (consumer text PRIMARY KEY,profile jsonb NOT NULL,digest text NOT NULL,contract_digest text NOT NULL,CHECK (consumer='+literal(b.consumer+'-completed')+' AND profile='+literal(JSON.stringify(b))+'::jsonb AND digest='+literal(p.digest)+' AND contract_digest='+literal(p.contractDigest)+'))',
  'INSERT INTO pgstream_intake_profile VALUES ('+[b.consumer+'-completed',JSON.stringify(b),p.digest,p.contractDigest].map(literal).join(',')+')',
  'REVOKE ALL ON pgstream_intake_profile FROM PUBLIC',
  `CREATE FUNCTION pgstream_intake_assert() RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $pool_intake$${assertBody}$pool_intake$`,
  'REVOKE ALL ON FUNCTION pgstream_intake_assert() FROM PUBLIC',
  'GRANT EXECUTE ON FUNCTION pgstream_intake_assert() TO '+q(b.role),
  `CREATE OR REPLACE FUNCTION pgstream_assigned_effect_required() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $pool_intake$${effectBody}$pool_intake$`
 ];
 return {...base,effectBody,intakeAssertBody:assertBody,intakeProfile:p,catalogue:{version:1,migrations:[...base.catalogue.migrations,{name:'0008_evaluator_pool_intake',up,checksum:checksum(up)}]}};
}
module.exports={build,CONTEXT_FIELDS};
