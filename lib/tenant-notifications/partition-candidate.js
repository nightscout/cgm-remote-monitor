'use strict';
// Explicit opt-in notification fence. Static bindings come from the selected
// deployment/evaluator document; user ACK reads the ledger, not live workers.
const {checksum,validateCatalogue}=require('../migrations/catalogue');
const base=require('./postgres-candidate.json');
const c=require('./contract');
const OWNER_DOMAIN='nightscout:pgstream-notification-owner:v1:';
const TABLES=Object.freeze(['tenant_notification_heads','tenant_notification_requests','tenant_notification_state']);
function quote(name){if(typeof name!=='string'||name!==name.trim()||!/^[a-z][a-z0-9_]{0,62}$/.test(name)||name.startsWith('pg_')||['public','information_schema'].includes(name))throw new TypeError('NOTIFICATION_PARTITION_NAMESPACE');return '"'+name+'"';}
function bindings(value){
 if(!value||Object.keys(value).sort().join(',')!=='checkpointNamespace,consumer,evaluatorConsumer,lifecycleNamespace,membershipNamespace'||typeof value.consumer!=='string'||value.consumer!==value.consumer.trim()||!c.NAME.test(value.consumer)||typeof value.evaluatorConsumer!=='string'||value.evaluatorConsumer!==value.evaluatorConsumer.trim()||!/^evaluator-[A-Za-z0-9_-]{1,100}-completed$/.test(value.evaluatorConsumer))throw new TypeError('NOTIFICATION_PARTITION_BINDING');
 for(const key of ['checkpointNamespace','membershipNamespace','lifecycleNamespace'])quote(value[key]);
 if(new Set([value.checkpointNamespace,value.membershipNamespace,value.lifecycleNamespace]).size!==3)throw new TypeError('NOTIFICATION_PARTITION_BINDING');
 return Object.freeze({...value});
}
function build(value){
 const selected=bindings(value),checkpoint=quote(selected.checkpointNamespace),membership=quote(selected.membershipNamespace),lifecycle=quote(selected.lifecycleNamespace);
 const key=expression=>`bytes:=sha256(convert_to(${expression},'UTF8'));
  high_key:=((get_byte(bytes,0)::bigint<<24)+(get_byte(bytes,1)::bigint<<16)+(get_byte(bytes,2)::bigint<<8)+get_byte(bytes,3))::oid;
  low_key:=((get_byte(bytes,4)::bigint<<24)+(get_byte(bytes,5)::bigint<<16)+(get_byte(bytes,6)::bigint<<8)+get_byte(bytes,7))::oid;`;
 const held=(mode,subid)=>`EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid=pg_backend_pid() AND classid=high_key AND objid=low_key AND objsubid=${subid} AND mode='${mode}' AND granted)`;
 const body=`
DECLARE subject uuid; route text; context jsonb; assignment record; desired record; roster record; lifetime record; bytes bytea; high_key oid; low_key oid;
BEGIN
  IF TG_OP='DELETE' THEN subject:=OLD.tenant_id; route:=OLD.consumer; ELSE subject:=NEW.tenant_id; route:=NEW.consumer; END IF;
  IF TG_OP='UPDATE' AND (OLD.consumer='${selected.consumer}' OR NEW.consumer='${selected.consumer}') AND (NEW.consumer IS DISTINCT FROM OLD.consumer OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id) THEN RAISE EXCEPTION 'NOTIFICATION_PARTITION_KEY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF route<>'${selected.consumer}' THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
  SELECT work_owner_ordinal AS ordinal,work_assignment_revision::text AS revision INTO assignment FROM ${checkpoint}.tenant_consumer_checkpoint WHERE tenant_id=subject AND consumer='${selected.evaluatorConsumer}';
  IF NOT FOUND OR assignment.ordinal IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
  context:=NULLIF(current_setting('app.pgstream_notification_effect',true),'')::jsonb;
  IF context IS NULL OR context->>'tenant' IS DISTINCT FROM subject::text OR context->>'consumer' IS DISTINCT FROM route OR context->>'ordinal' IS DISTINCT FROM assignment.ordinal::text OR context->>'revision' IS DISTINCT FROM assignment.revision OR context->>'backendPid' IS DISTINCT FROM pg_backend_pid()::text OR context->>'transactionId' IS DISTINCT FROM pg_current_xact_id()::text OR context->>'restoreGeneration' IS NULL OR context->>'restoreGeneration' !~ '^[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'NOTIFICATION_ASSIGNED_CONTEXT_REQUIRED' USING ERRCODE='55000'; END IF;
  ${key("'nightscout:pool-membership:xact:v1:"+selected.membershipNamespace+":evaluator'")}
  IF NOT ${held('ShareLock',2)} THEN RAISE EXCEPTION 'NOTIFICATION_ASSIGNED_SHARED_REQUIRED' USING ERRCODE='55000'; END IF;
  ${key("'"+OWNER_DOMAIN+"'||TG_TABLE_SCHEMA||':'||route||':'||assignment.ordinal::text")}
  IF NOT ${held('ExclusiveLock',1)} THEN RAISE EXCEPTION 'NOTIFICATION_ASSIGNED_OWNER_RESOURCE' USING ERRCODE='55000'; END IF;
  SELECT members,revision::text AS revision,slice_rule INTO desired FROM ${membership}.pool_desired WHERE pool_kind='evaluator';
  IF NOT FOUND OR desired.members NOT IN (1,2) OR desired.revision IS DISTINCT FROM assignment.revision OR desired.slice_rule<>'sha256-modulo-v1' THEN RAISE EXCEPTION 'NOTIFICATION_ASSIGNED_REVISION' USING ERRCODE='55000'; END IF;
  SELECT count(*) AS live_count,count(DISTINCT ordinal) AS ordinals,bool_and(coalesce(ordinal>=0 AND ordinal<desired.members AND applied_members=desired.members AND slice_rule=desired.slice_rule,false)) AS valid,
    count(*) FILTER (WHERE ordinal=assignment.ordinal AND member_id::text=context->>'memberId') AS selves
    INTO roster FROM ${membership}.pool_membership WHERE pool_kind='evaluator' AND lease_expires_at>clock_timestamp();
  IF roster.live_count<>desired.members OR roster.ordinals<>desired.members OR NOT coalesce(roster.valid,false) OR roster.selves<>1 THEN RAISE EXCEPTION 'NOTIFICATION_ASSIGNED_LEASE' USING ERRCODE='55000'; END IF;
  SELECT phase,generation::text AS generation INTO lifetime FROM ${lifecycle}.tenant_lifecycle_windows WHERE tenant_id=subject;
  IF NOT FOUND OR lifetime.phase<>'active' OR lifetime.generation IS DISTINCT FROM context->>'restoreGeneration' THEN RAISE EXCEPTION 'NOTIFICATION_ASSIGNED_RESTORE' USING ERRCODE='55000'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
`;
 const up=['CREATE FUNCTION pgstream_notification_partition() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $notification_partition$'+body+'$notification_partition$'];
 for(const table of TABLES)up.push('CREATE TRIGGER notification_partition_effect BEFORE INSERT OR UPDATE OR DELETE ON '+table+' FOR EACH ROW EXECUTE FUNCTION pgstream_notification_partition()',
  'CREATE CONSTRAINT TRIGGER notification_partition_commit AFTER INSERT OR UPDATE OR DELETE ON '+table+' DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pgstream_notification_partition()',
  'ALTER TABLE '+table+' ENABLE ALWAYS TRIGGER notification_partition_effect','ALTER TABLE '+table+' ENABLE ALWAYS TRIGGER notification_partition_commit');
 const execution=['REVOKE EXECUTE ON FUNCTION pgstream_notification_partition() FROM PUBLIC'];
 return {bindings:selected,body,catalogue:{version:1,migrations:[...base.migrations,{name:'0003_pgstream_notification_partition',up,checksum:checksum(up)},{name:'0004_notification_partition_function_execution',up:execution,checksum:checksum(execution)}]}};
}
function expectedMigrations(catalogue){
 if(catalogue===undefined)return base.migrations;
 const migrations=validateCatalogue(catalogue);
 const execution=['REVOKE EXECUTE ON FUNCTION pgstream_notification_partition() FROM PUBLIC'];
 if(migrations.length!==base.migrations.length+2||migrations.at(-2).name!=='0003_pgstream_notification_partition'||migrations.at(-1).name!=='0004_notification_partition_function_execution'||JSON.stringify(migrations.at(-1).up)!==JSON.stringify(execution)||migrations.at(-1).checksum!==checksum(execution)||base.migrations.some((migration,index)=>JSON.stringify(migration.up)!==JSON.stringify(migrations[index].up)||migration.name!==migrations[index].name||migration.checksum!==migrations[index].checksum))throw new Error('NOTIFICATION_PARTITION_CATALOGUE');
 return migrations;
}
module.exports={build,bindings,expectedMigrations,quote,OWNER_DOMAIN,TABLES};
