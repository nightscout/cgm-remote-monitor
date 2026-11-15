'use strict';
// Proposed opt-in fixed-roster candidate. Namespace bindings are compiled from
// the existing deployment layout; no runtime setting can redirect its reads.
const {checksum}=require('../migrations/catalogue');
const {OWNER_DOMAIN}=require('./partition-work');
const base=require('../../migrations/candidates/postgres-evaluator-work-v2.json');
const EFFECT_COLUMNS=Object.freeze(['checkpoint','contract_digest','projection','work_version','work_completed','work_due_at','work_completed_at','output_identity','output_digest','output_revision','output_restore_generation','delivery_ack_revision']);
const ASSIGNMENT_COLUMNS=Object.freeze(['tenant_id','consumer','work_owner_ordinal','work_assignment_revision']);
const INDEXES=Object.freeze([
 {name:'pgstream_partition_pending',columns:['consumer','work_owner_ordinal','work_assignment_revision','tenant_id'],predicate:'work_version=2 AND work_enabled AND work_pending_at IS NOT NULL'},
 {name:'pgstream_partition_due',columns:['consumer','work_owner_ordinal','work_assignment_revision','work_due_at','tenant_id'],predicate:'work_version=2 AND work_enabled AND work_due_at IS NOT NULL'},
 {name:'pgstream_partition_delivery',columns:['consumer','work_owner_ordinal','work_assignment_revision','tenant_id'],predicate:'work_version=2 AND delivery_revision>delivery_ack_revision'}
]);
function quote(name){if(typeof name!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(name)||name.startsWith('pg_')||['public','information_schema'].includes(name))throw new TypeError('EVALUATOR_ASSIGNMENT_NAMESPACE');return '"'+name+'"';}
function build({membershipNamespace,lifecycleNamespace}){
 const membership=quote(membershipNamespace),lifecycle=quote(lifecycleNamespace);
 const key=`bytes:=sha256(convert_to('nightscout:pool-membership:xact:v1:${membershipNamespace}:evaluator','UTF8'));
  high_key:=((get_byte(bytes,0)::bigint<<24)+(get_byte(bytes,1)::bigint<<16)+(get_byte(bytes,2)::bigint<<8)+get_byte(bytes,3))::oid;
  low_key:=((get_byte(bytes,4)::bigint<<24)+(get_byte(bytes,5)::bigint<<16)+(get_byte(bytes,6)::bigint<<8)+get_byte(bytes,7))::oid;`;
 const held=mode=>`EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid=pg_backend_pid() AND classid=high_key AND objid=low_key AND objsubid=2 AND mode='${mode}' AND granted)`;
 const assignmentBody=`
DECLARE bytes bytea; high_key oid; low_key oid; desired record;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.work_owner_ordinal IS NULL THEN RETURN OLD; END IF;
  ELSIF NEW.work_owner_ordinal IS NULL THEN
    IF TG_OP='UPDATE' AND OLD.work_owner_ordinal IS NOT NULL THEN RAISE EXCEPTION 'EVALUATOR_ASSIGNMENT_CANNOT_CLEAR' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  ${key}
  IF NOT ${held('ExclusiveLock')} THEN RAISE EXCEPTION 'EVALUATOR_ASSIGNMENT_EXCLUSIVE_REQUIRED' USING ERRCODE='55000'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.consumer !~ '^evaluator-[A-Za-z0-9_-]{1,100}-completed$' THEN RAISE EXCEPTION 'EVALUATOR_ASSIGNMENT_CONSUMER' USING ERRCODE='55000'; END IF;
  SELECT members,revision,slice_rule INTO desired FROM ${membership}.pool_desired WHERE pool_kind='evaluator';
  IF NOT FOUND OR desired.members NOT IN (1,2) OR desired.slice_rule<>'sha256-modulo-v1' OR NEW.work_assignment_revision IS DISTINCT FROM desired.revision OR NEW.work_owner_ordinal IS DISTINCT FROM (get_byte(sha256(convert_to(NEW.tenant_id::text,'UTF8')),7)%desired.members) THEN
    RAISE EXCEPTION 'EVALUATOR_ASSIGNMENT_PROVISION_REFUSED' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
`;
 const row=alias=>'ROW('+EFFECT_COLUMNS.map(column=>alias+'.'+column).join(',')+')';
 const effectBody=`
DECLARE context jsonb; bytes bytea; high_key oid; low_key oid; desired record; roster record; lifetime record;
BEGIN
  IF OLD.work_owner_ordinal IS NULL THEN RETURN NEW; END IF;
  IF TG_WHEN='AFTER' AND ${row('NEW')} IS NOT DISTINCT FROM ${row('OLD')} THEN RETURN NEW; END IF;
  context:=NULLIF(current_setting('app.pgstream_partition_effect',true),'')::jsonb;
  IF context IS NULL OR context->>'tenant' IS DISTINCT FROM NEW.tenant_id::text OR context->>'consumer' IS DISTINCT FROM NEW.consumer OR context->>'ordinal' IS DISTINCT FROM OLD.work_owner_ordinal::text OR context->>'revision' IS DISTINCT FROM OLD.work_assignment_revision::text OR context->>'backendPid' IS DISTINCT FROM pg_backend_pid()::text OR context->>'transactionId' IS DISTINCT FROM pg_current_xact_id()::text OR context->>'restoreGeneration' IS NULL OR context->>'restoreGeneration' !~ '^[1-9][0-9]{0,18}$' OR NEW.work_owner_ordinal IS DISTINCT FROM OLD.work_owner_ordinal OR NEW.work_assignment_revision IS DISTINCT FROM OLD.work_assignment_revision THEN
    RAISE EXCEPTION 'EVALUATOR_ASSIGNED_EFFECT_CONTEXT_REQUIRED' USING ERRCODE='55000';
  END IF;
  ${key}
  IF NOT ${held('ShareLock')} THEN RAISE EXCEPTION 'EVALUATOR_ASSIGNED_EFFECT_SHARED_REQUIRED' USING ERRCODE='55000'; END IF;
  bytes:=sha256(convert_to('${OWNER_DOMAIN}'||TG_TABLE_SCHEMA||':'||left(NEW.consumer,length(NEW.consumer)-10)||':'||OLD.work_owner_ordinal::text,'UTF8'));
  high_key:=((get_byte(bytes,0)::bigint<<24)+(get_byte(bytes,1)::bigint<<16)+(get_byte(bytes,2)::bigint<<8)+get_byte(bytes,3))::oid;
  low_key:=((get_byte(bytes,4)::bigint<<24)+(get_byte(bytes,5)::bigint<<16)+(get_byte(bytes,6)::bigint<<8)+get_byte(bytes,7))::oid;
  IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid=pg_backend_pid() AND classid=high_key AND objid=low_key AND objsubid=1 AND mode='ExclusiveLock' AND granted) THEN RAISE EXCEPTION 'EVALUATOR_ASSIGNED_OWNER_RESOURCE' USING ERRCODE='55000'; END IF;
  SELECT members,revision,slice_rule INTO desired FROM ${membership}.pool_desired WHERE pool_kind='evaluator';
  IF NOT FOUND OR desired.members NOT IN (1,2) OR desired.slice_rule<>'sha256-modulo-v1' OR desired.revision IS DISTINCT FROM OLD.work_assignment_revision THEN RAISE EXCEPTION 'EVALUATOR_ASSIGNED_EFFECT_REVISION' USING ERRCODE='55000'; END IF;
  SELECT count(*) AS live_count,count(DISTINCT ordinal) AS ordinals,
    bool_and(ordinal>=0 AND ordinal<desired.members AND applied_members=desired.members AND slice_rule=desired.slice_rule) AS valid,
    count(*) FILTER (WHERE ordinal=OLD.work_owner_ordinal AND member_id::text=context->>'memberId') AS selves
    INTO roster FROM ${membership}.pool_membership WHERE pool_kind='evaluator' AND lease_expires_at>clock_timestamp();
  IF roster.live_count<>desired.members OR roster.ordinals<>desired.members OR NOT coalesce(roster.valid,false) OR roster.selves<>1 THEN RAISE EXCEPTION 'EVALUATOR_ASSIGNED_EFFECT_LEASE' USING ERRCODE='55000'; END IF;
  SELECT phase,generation::text AS generation INTO lifetime FROM ${lifecycle}.tenant_lifecycle_windows WHERE tenant_id=NEW.tenant_id;
  IF NOT FOUND OR lifetime.phase<>'active' OR lifetime.generation IS DISTINCT FROM context->>'restoreGeneration' OR (NEW.output_revision>0 AND NEW.output_restore_generation::text IS DISTINCT FROM lifetime.generation) THEN RAISE EXCEPTION 'EVALUATOR_ASSIGNED_EFFECT_RESTORE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
`;
 const functionSQL=(name,body)=>`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $assignment$${body}$assignment$`;
 const up=[
  'ALTER TABLE tenant_consumer_checkpoint ADD COLUMN work_owner_ordinal smallint',
  'ALTER TABLE tenant_consumer_checkpoint ADD COLUMN work_assignment_revision bigint',
  'ALTER TABLE tenant_consumer_checkpoint ADD CONSTRAINT evaluator_fixed_assignment_pair CHECK ((work_owner_ordinal IS NULL AND work_assignment_revision IS NULL) OR (work_owner_ordinal IS NOT NULL AND work_assignment_revision IS NOT NULL AND work_version=2 AND work_owner_ordinal BETWEEN 0 AND 1 AND work_assignment_revision>0))',
  ...INDEXES.map(index=>'CREATE INDEX '+index.name+' ON tenant_consumer_checkpoint ('+index.columns.join(',')+') WHERE '+index.predicate),
  functionSQL('pgstream_assignment_required',assignmentBody),functionSQL('pgstream_assigned_effect_required',effectBody),
  'CREATE TRIGGER pgstream_assignment_protocol BEFORE INSERT OR DELETE OR UPDATE OF '+ASSIGNMENT_COLUMNS.join(',')+' ON tenant_consumer_checkpoint FOR EACH ROW EXECUTE FUNCTION pgstream_assignment_required()',
  'CREATE TRIGGER pgstream_effect_protocol BEFORE UPDATE OF '+EFFECT_COLUMNS.join(',')+' ON tenant_consumer_checkpoint FOR EACH ROW EXECUTE FUNCTION pgstream_assigned_effect_required()',
  'CREATE CONSTRAINT TRIGGER pgstream_effect_commit AFTER UPDATE ON tenant_consumer_checkpoint DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pgstream_assigned_effect_required()',
  ...['pgstream_assignment_protocol','pgstream_effect_protocol','pgstream_effect_commit'].map(name=>'ALTER TABLE tenant_consumer_checkpoint ENABLE ALWAYS TRIGGER '+name)
 ];
 const migration={name:'0003_evaluator_fixed_assignment',up,checksum:checksum(up)};
 return {catalogue:{version:1,migrations:[...base.migrations,migration]},assignmentBody,effectBody};
}
module.exports={build,EFFECT_COLUMNS,ASSIGNMENT_COLUMNS,INDEXES};
