'use strict';
// Appended opt-in catalogue only. No vectors, assignments or legacy row digests
// are converted here: operator cutover and runtime activation remain refused.
const {checksum}=require('../migrations/catalogue');
const profiles=require('./intake-profile');
const q=name=>'"'+name+'"';
const literal=value=>"'"+String(value).replace(/'/g,"''")+"'";
function extend(base,{intakeProfile}){
 const p=profiles.validate(intakeProfile),b=p.binding,m=q(b.membershipNamespace),l=q(b.lifecycleNamespace),n=q(b.namespace);
 const bits=BigInt.asUintN(64,BigInt(p.ownerKey)),high=(bits>>32n).toString(),low=(bits&4294967295n).toString();
 const roster='ARRAY['+b.tenants.map(literal).join(',')+']::uuid[]';
 const assertBody=`
DECLARE context jsonb; installed record; bytes bytea; high_key oid; low_key oid; desired record; prior_tenant text; subject text; lifetime_phase text;
BEGIN
 prior_tenant:=current_setting('app.current_tenant_id',true);
 IF prior_tenant IS NULL THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_UNINITIALIZED_TENANT_SETTING' USING ERRCODE='55000'; END IF;
 context:=NULLIF(current_setting('app.pgstream_intake',true),'')::jsonb;
 SELECT consumer,profile,digest,contract_digest INTO installed FROM ${n}.pgstream_intake_profile WHERE consumer=${literal(b.consumer+'-completed')};
 IF NOT FOUND OR installed.profile IS DISTINCT FROM ${literal(JSON.stringify(b))}::jsonb OR installed.digest IS DISTINCT FROM ${literal(p.digest)} OR installed.contract_digest IS DISTINCT FROM ${literal(p.contractDigest)} OR current_user<>${literal(b.role)} THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_PROFILE_REFUSED' USING ERRCODE='55000'; END IF;
 IF context IS NULL OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(context) k) IS DISTINCT FROM ARRAY['backendPid','consumer','observedAt','operation','profile','protocol','revision','tenants','transactionId']::text[] OR context->>'protocol' IS DISTINCT FROM ${literal(profiles.PROTOCOL)} OR context->>'profile' IS DISTINCT FROM installed.digest OR context->>'consumer' IS DISTINCT FROM installed.consumer OR context->>'revision' IS DISTINCT FROM ${literal(b.revision)} OR context->>'operation' IS DISTINCT FROM 'observe' OR context->>'observedAt' IS NULL OR context->>'observedAt' !~ '^(0|[1-9][0-9]{0,15})$' OR (context->>'observedAt')::numeric>=8640000000000000 OR context->>'backendPid' IS DISTINCT FROM pg_backend_pid()::text OR context->>'transactionId' IS DISTINCT FROM pg_current_xact_id()::text OR jsonb_typeof(context->'tenants') IS DISTINCT FROM 'array' OR jsonb_array_length(context->'tenants') NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_CONTEXT_REQUIRED' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(context->'tenants') t WHERE NOT t::uuid=ANY(${roster})) OR (SELECT count(*) FROM jsonb_array_elements_text(context->'tenants'))<>(SELECT count(DISTINCT t) FROM jsonb_array_elements_text(context->'tenants') t) THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_ROSTER_REFUSED' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid=pg_backend_pid() AND classid=${high}::oid AND objid=${low}::oid AND objsubid=1 AND mode='ExclusiveLock' AND granted) THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_OWNER_REQUIRED' USING ERRCODE='55000'; END IF;
 bytes:=sha256(convert_to('nightscout:pool-membership:xact:v1:${b.membershipNamespace}:evaluator','UTF8'));
 high_key:=((get_byte(bytes,0)::bigint<<24)+(get_byte(bytes,1)::bigint<<16)+(get_byte(bytes,2)::bigint<<8)+get_byte(bytes,3))::oid;
 low_key:=((get_byte(bytes,4)::bigint<<24)+(get_byte(bytes,5)::bigint<<16)+(get_byte(bytes,6)::bigint<<8)+get_byte(bytes,7))::oid;
 IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid=pg_backend_pid() AND classid=high_key AND objid=low_key AND objsubid=2 AND mode='ShareLock' AND granted) THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_SHARED_REQUIRED' USING ERRCODE='55000'; END IF;
 SELECT members,previous_members,revision,slice_rule INTO desired FROM ${m}.pool_desired WHERE pool_kind='evaluator';
 IF NOT FOUND OR desired.previous_members IS NOT NULL OR desired.members<>${b.members} OR desired.revision<>${b.revision}::bigint OR desired.slice_rule<>'sha256-modulo-v1' THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_CONFIGURATION_CHANGED' USING ERRCODE='55000'; END IF;
 -- Metadata existence/enum validation only. Canonical RLS/policy inventory is
 -- unchanged; each read names its REAL configured tenant, never a dummy lease.
 BEGIN
  FOR subject IN SELECT jsonb_array_elements_text(context->'tenants') ORDER BY 1 LOOP
   PERFORM set_config('app.current_tenant_id',subject,true);
   SELECT phase INTO lifetime_phase FROM ${l}.tenant_lifecycle_windows WHERE tenant_id=subject::uuid;
   IF NOT FOUND OR lifetime_phase NOT IN ('active','suspended') THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_LIFECYCLE_REFUSED' USING ERRCODE='55000'; END IF;
  END LOOP;
  PERFORM set_config('app.current_tenant_id',prior_tenant,true);
 EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.current_tenant_id',prior_tenant,true);
  RAISE;
 END;
END;
`;
 const preserved=['tenant_id','consumer','work_owner_ordinal','work_assignment_revision','checkpoint','contract_digest','projection','work_version','work_completed','work_due_at','work_completed_at','output_identity','output_digest','output_revision','output_restore_generation','delivery_ack_revision'];
 const row=(alias,columns)=>'ROW('+columns.map(c=>alias+'.'+c).join(',')+')';
 const branch=`
  IF NEW.consumer=${literal(b.consumer+'-completed')} AND (NEW.contract_digest IS DISTINCT FROM ${literal(p.contractDigest)} OR NEW.work_version<>2 OR NEW.work_owner_ordinal IS NULL OR NEW.work_assignment_revision IS DISTINCT FROM ${b.revision}::bigint OR NOT NEW.tenant_id=ANY(${roster})) THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_ROW_PROFILE' USING ERRCODE='55000'; END IF;
  IF NULLIF(current_setting('app.pgstream_intake',true),'') IS NOT NULL THEN
    PERFORM ${n}.pgstream_intake_assert();
    IF NOT NEW.tenant_id::text IN (SELECT jsonb_array_elements_text(current_setting('app.pgstream_intake')::jsonb->'tenants')) OR NEW.consumer<>${literal(b.consumer+'-completed')} OR NEW.work_version<>2 OR NEW.work_assignment_revision<>${b.revision}::bigint OR NEW.work_owner_ordinal IS NULL OR ${row('NEW',preserved)} IS DISTINCT FROM ${row('OLD',preserved)} THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_IMMUTABLE' USING ERRCODE='55000'; END IF;
    IF cardinality(NEW.work_observed)<>6 OR cardinality(NEW.work_observed_at)<>6 OR EXISTS(SELECT 1 FROM generate_series(1,6) i WHERE
      (OLD.work_observed[i] IS NOT NULL AND (NEW.work_observed[i] IS NULL OR NEW.work_observed[i]<OLD.work_observed[i])) OR
      (NEW.work_observed[i] IS NOT DISTINCT FROM OLD.work_observed[i] AND NEW.work_observed_at[i] IS DISTINCT FROM OLD.work_observed_at[i]) OR
      (NEW.work_observed[i] IS DISTINCT FROM OLD.work_observed[i] AND (NEW.work_observed_at[i] IS DISTINCT FROM (current_setting('app.pgstream_intake')::jsonb->>'observedAt')::bigint))) THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_VECTOR_TRANSITION' USING ERRCODE='55000'; END IF;
    IF (NEW.work_activity_enabled IS DISTINCT FROM OLD.work_activity_enabled AND NEW.work_observed[4] IS NOT DISTINCT FROM OLD.work_observed[4]) OR (NEW.work_lifecycle_enabled IS DISTINCT FROM OLD.work_lifecycle_enabled AND NEW.work_observed[5] IS NOT DISTINCT FROM OLD.work_observed[5]) OR NEW.work_enabled IS DISTINCT FROM (NEW.work_activity_enabled AND NEW.work_lifecycle_enabled) OR (OLD.work_pending_at IS NOT NULL AND NEW.work_pending_at IS DISTINCT FROM OLD.work_pending_at) OR (OLD.work_pending_at IS NULL AND NEW.work_pending_at IS DISTINCT FROM (CASE WHEN NEW.work_observed IS DISTINCT FROM OLD.work_observed THEN (current_setting('app.pgstream_intake')::jsonb->>'observedAt')::bigint ELSE NULL END)) OR NEW.delivery_revision IS DISTINCT FROM OLD.delivery_revision+(CASE WHEN NEW.work_observed[3] IS DISTINCT FROM OLD.work_observed[3] OR NEW.work_observed[4] IS DISTINCT FROM OLD.work_observed[4] OR NEW.work_observed[5] IS DISTINCT FROM OLD.work_observed[5] THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'PGSTREAM_INTAKE_DERIVED_TRANSITION' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
`;
 // Preserve worker complete/TIME/ACK body byte-for-byte beneath the intake
 // dispatch, including membership, owner, active-generation and deferred fences.
 const effectBody=base.effectBody.replace('BEGIN\n','BEGIN\n'+branch);
 if(effectBody===base.effectBody)throw new Error('PGSTREAM_INTAKE_COMPOSITION_BOUNDARY');
 const up=[
  'CREATE TABLE pgstream_intake_profile (consumer text PRIMARY KEY,profile jsonb NOT NULL,digest text NOT NULL,contract_digest text NOT NULL,CHECK (consumer='+literal(b.consumer+'-completed')+' AND profile='+literal(JSON.stringify(b))+'::jsonb AND digest='+literal(p.digest)+' AND contract_digest='+literal(p.contractDigest)+'))',
  'INSERT INTO pgstream_intake_profile VALUES ('+[b.consumer+'-completed',JSON.stringify(b),p.digest,p.contractDigest].map(literal).join(',')+')',
  'REVOKE ALL ON pgstream_intake_profile FROM PUBLIC',
  `CREATE FUNCTION pgstream_intake_assert() RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $intake$${assertBody}$intake$`,
  'REVOKE ALL ON FUNCTION pgstream_intake_assert() FROM PUBLIC',
  'GRANT EXECUTE ON FUNCTION pgstream_intake_assert() TO '+q(b.role),
  `CREATE OR REPLACE FUNCTION pgstream_assigned_effect_required() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $intake$${effectBody}$intake$`
 ];
 return {...base,effectBody,intakeAssertBody:assertBody,intakeProfile:p,catalogue:{version:1,migrations:[...base.catalogue.migrations,{name:'0004_evaluator_sole_intake',up,checksum:checksum(up)}]}};
}
module.exports={extend};
