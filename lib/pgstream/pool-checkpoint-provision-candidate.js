'use strict';
// A fresh typed checkpoint is written only inside the existing suspended
// maintenance claim. The DATA commit must advance its audit to restored.
const { checksum, validateCatalogue } = require('../migrations/catalogue');
const profiles = require('./pool-intake-profile');
const pool = require('./pool-assignment-candidate');
const { RULE, MAX_MEMBERS } = require('../pool-membership/slice');
const CONTEXT_FIELDS = Object.freeze(['artifactDigest', 'backendPid', 'birth', 'claimId', 'consumer', 'generation', 'members', 'observedAt', 'ordinal', 'profile', 'revision', 'roleOID', 'tenant', 'transactionId']);
const INSERTS = Object.freeze(['tenant_id', 'consumer', 'contract_digest', 'checkpoint', 'projection', ...require('./work-state').COLUMNS, 'work_owner_ordinal', 'work_assignment_revision']);
const AUTHORITY_READS = Object.freeze({
  tenant_lifecycle_windows: Object.freeze(['tenant_id', 'lock_key', 'phase', 'generation', 'claim_id', 'artifact_digest']),
  tenant_lifecycle_restore_authority: Object.freeze(['tenant_id', 'role_oid', 'active']),
  tenant_lifecycle_restore_audit: Object.freeze(['tenant_id', 'claim_id', 'generation', 'artifact_digest', 'role_oid', 'owner_pid', 'owner_birth', 'state', 'restored_at', 'activated_at'])
});
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
function expected (profile) {
  const b = profile.binding, legacy = require('./assignment-candidate').build(b);
  const assignment = pool.build({ base: legacy, membershipNamespace: b.membershipNamespace, lifecycleNamespace: b.lifecycleNamespace, operatorRole: b.operatorRole });
  return require('./pool-intake-candidate').build({ base: assignment, intakeProfile: profile });
}
function build ({ base, intakeProfile }) {
  const p = profiles.validate(intakeProfile), b = p.binding, prefix = pool.unsignedPrefix();
  const original = expected(p);
  if (!base || JSON.stringify(base.catalogue) !== JSON.stringify(original.catalogue) || base.effectBody !== original.effectBody || base.assignmentBody !== original.assignmentBody || base.intakeAssertBody !== original.intakeAssertBody) throw new TypeError('PGSTREAM_POOL_PROVISION_BASE');
  const m = '"' + b.membershipNamespace + '"', l = '"' + b.lifecycleNamespace + '"', n = '"' + b.namespace + '"';
  const provisionBody = `
DECLARE context jsonb; installed record; desired record; roster record; lifetime record; bytes bytea; high_key oid; low_key oid; prior_tenant text; found_window boolean; actual_birth text; actual_role text; stamp bigint;
BEGIN
 IF NEW.consumer<>${literal(b.consumer + '-completed')} OR NEW.work_owner_ordinal IS NULL THEN RETURN NEW; END IF;
 context:=NULLIF(current_setting('app.pgstream_checkpoint_provision',true),'')::jsonb;
 IF context IS NULL OR jsonb_typeof(context) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(context) k) IS DISTINCT FROM ARRAY[${CONTEXT_FIELDS.map(literal).join(',')}]::text[] OR context->>'profile' IS DISTINCT FROM ${literal(p.digest)} OR context->>'tenant' IS DISTINCT FROM NEW.tenant_id::text OR context->>'consumer' IS DISTINCT FROM NEW.consumer OR context->>'backendPid' IS DISTINCT FROM pg_backend_pid()::text OR context->>'transactionId' IS DISTINCT FROM pg_current_xact_id()::text OR context->>'generation' IS NULL OR context->>'generation' !~ '^[1-9][0-9]{0,18}$' OR (context->>'generation')::numeric>${literal(profiles.DOMAIN.completeMaximum)}::numeric OR context->>'observedAt' IS NULL OR context->>'observedAt' !~ '^(0|[1-9][0-9]{0,15})$' OR (context->>'observedAt')::numeric>=8640000000000000 THEN RAISE EXCEPTION 'PGSTREAM_POOL_PROVISION_CONTEXT' USING ERRCODE='55000'; END IF;
 SELECT consumer,profile,digest,contract_digest INTO installed FROM ${n}.pgstream_intake_profile WHERE consumer=${literal(b.consumer + '-completed')};
 IF NOT FOUND OR installed.profile IS DISTINCT FROM ${literal(JSON.stringify(b))}::jsonb OR installed.digest IS DISTINCT FROM ${literal(p.digest)} OR installed.contract_digest IS DISTINCT FROM ${literal(p.contractDigest)} THEN RAISE EXCEPTION 'PGSTREAM_POOL_PROVISION_PROFILE' USING ERRCODE='55000'; END IF;
 prior_tenant:=current_setting('app.current_tenant_id',true);
 IF prior_tenant IS NULL THEN RAISE EXCEPTION 'PGSTREAM_POOL_PROVISION_TENANT' USING ERRCODE='55000'; END IF;
 actual_birth:=${l}.tenant_lifecycle_backend_birth()::text; actual_role:=CURRENT_USER::regrole::oid::text;
 BEGIN
  PERFORM set_config('app.current_tenant_id',NEW.tenant_id::text,true);
  SELECT w.lock_key,w.phase,w.generation::text AS generation,w.claim_id::text AS claim_id,w.artifact_digest,a.role_oid::text AS role_oid,a.owner_pid,a.owner_birth::text AS owner_birth,a.state,a.restored_at,a.activated_at,
   EXISTS(SELECT 1 FROM ${l}.tenant_lifecycle_restore_authority r WHERE r.tenant_id=w.tenant_id AND r.role_oid=CURRENT_USER::regrole::oid AND r.active) AS authorized
   INTO lifetime FROM ${l}.tenant_lifecycle_windows w JOIN ${l}.tenant_lifecycle_restore_audit a ON a.tenant_id=w.tenant_id AND a.claim_id=w.claim_id AND a.generation=w.generation AND a.artifact_digest=w.artifact_digest WHERE w.tenant_id=NEW.tenant_id;
  found_window:=FOUND;
  PERFORM set_config('app.current_tenant_id',prior_tenant,true);
 EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.current_tenant_id',prior_tenant,true);
  RAISE;
 END;
 IF NOT found_window OR lifetime.phase<>'suspended' OR lifetime.claim_id IS NULL OR lifetime.artifact_digest IS NULL OR lifetime.authorized IS DISTINCT FROM true OR lifetime.generation IS DISTINCT FROM context->>'generation' OR lifetime.claim_id IS DISTINCT FROM context->>'claimId' OR lifetime.artifact_digest IS DISTINCT FROM context->>'artifactDigest' OR lifetime.role_oid IS DISTINCT FROM actual_role OR lifetime.role_oid IS DISTINCT FROM context->>'roleOID' OR lifetime.owner_pid IS DISTINCT FROM pg_backend_pid() OR lifetime.owner_birth IS DISTINCT FROM actual_birth OR lifetime.owner_birth IS DISTINCT FROM context->>'birth' OR lifetime.activated_at IS NOT NULL THEN RAISE EXCEPTION 'PGSTREAM_POOL_PROVISION_AUTHORITY' USING ERRCODE='55000'; END IF;
 IF (TG_WHEN='BEFORE' AND (lifetime.state<>'suspended' OR lifetime.restored_at IS NOT NULL)) OR (TG_WHEN='AFTER' AND (lifetime.state<>'restored' OR lifetime.restored_at IS NULL)) THEN RAISE EXCEPTION 'PGSTREAM_POOL_PROVISION_AUDIT_STAGE' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid=pg_backend_pid() AND classid=((lifetime.lock_key>>32)&4294967295)::oid AND objid=(lifetime.lock_key&4294967295)::oid AND objsubid=1 AND mode='ExclusiveLock' AND granted) THEN RAISE EXCEPTION 'PGSTREAM_POOL_PROVISION_LIFETIME' USING ERRCODE='55000'; END IF;
 bytes:=sha256(convert_to('nightscout:pool-membership:xact:v1:${b.membershipNamespace}:evaluator','UTF8'));
 high_key:=((get_byte(bytes,0)::bigint<<24)+(get_byte(bytes,1)::bigint<<16)+(get_byte(bytes,2)::bigint<<8)+get_byte(bytes,3))::oid;
 low_key:=((get_byte(bytes,4)::bigint<<24)+(get_byte(bytes,5)::bigint<<16)+(get_byte(bytes,6)::bigint<<8)+get_byte(bytes,7))::oid;
 IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid=pg_backend_pid() AND classid=high_key AND objid=low_key AND objsubid=2 AND mode='ExclusiveLock' AND granted) THEN RAISE EXCEPTION 'PGSTREAM_POOL_PROVISION_COHORT_LOCK' USING ERRCODE='55000'; END IF;
 SELECT members,revision,slice_rule INTO desired FROM ${m}.pool_desired WHERE pool_kind='evaluator';
 IF NOT FOUND OR desired.members NOT BETWEEN 1 AND ${MAX_MEMBERS} OR desired.slice_rule<>'${RULE}' OR desired.revision::text IS DISTINCT FROM context->>'revision' OR desired.members::text IS DISTINCT FROM context->>'members' OR NEW.work_assignment_revision IS DISTINCT FROM desired.revision OR NEW.work_owner_ordinal::text IS DISTINCT FROM context->>'ordinal' THEN RAISE EXCEPTION 'PGSTREAM_POOL_PROVISION_ASSIGNMENT' USING ERRCODE='55000'; END IF;
 bytes:=sha256(convert_to(NEW.tenant_id::text,'UTF8'));
 IF NEW.work_owner_ordinal IS DISTINCT FROM mod((${prefix}),desired.members)::integer THEN RAISE EXCEPTION 'PGSTREAM_POOL_PROVISION_BUCKET' USING ERRCODE='55000'; END IF;
 SELECT count(*) AS live_count,count(DISTINCT ordinal) AS ordinals,bool_and(coalesce(ordinal>=0 AND ordinal<desired.members AND slice_rule=desired.slice_rule AND applied_members=desired.members,false)) AS valid INTO roster FROM ${m}.pool_membership WHERE pool_kind='evaluator' AND lease_expires_at>clock_timestamp();
 IF roster.live_count<>desired.members OR roster.ordinals<>desired.members OR NOT coalesce(roster.valid,false) THEN RAISE EXCEPTION 'PGSTREAM_POOL_PROVISION_COHORT' USING ERRCODE='55000'; END IF;
 stamp:=2*(context->>'generation')::bigint+1;
 IF to_jsonb(NEW) IS DISTINCT FROM jsonb_build_object('tenant_id',NEW.tenant_id,'consumer',${literal(b.consumer + '-completed')},'contract_digest',${literal(p.contractDigest)},'checkpoint',0,'projection',jsonb_build_array(jsonb_build_object('kind','evaluator-work-v2','output',NULL)),'work_version',2,'work_observed',ARRAY[NULL,NULL,NULL,NULL,stamp,1]::bigint[],'work_completed',ARRAY[NULL,NULL,NULL,NULL,NULL,NULL]::bigint[],'work_observed_at',ARRAY[NULL,NULL,NULL,NULL,(context->>'observedAt')::bigint,(context->>'observedAt')::bigint]::bigint[],'work_pending_at',(context->>'observedAt')::bigint,'work_due_at',NULL,'work_completed_at',NULL,'work_enabled',false,'work_activity_enabled',false,'work_lifecycle_enabled',false,'delivery_revision',0,'delivery_ack_revision',0,'output_identity',NULL,'output_digest',NULL,'output_revision',0,'output_restore_generation',NULL,'work_owner_ordinal',NEW.work_owner_ordinal,'work_assignment_revision',desired.revision) THEN RAISE EXCEPTION 'PGSTREAM_POOL_PROVISION_CLEAN_ROW' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END;
`;
  const up = [
    `CREATE FUNCTION pgstream_checkpoint_provision_required() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $pool_provision$${provisionBody}$pool_provision$`,
    'REVOKE ALL ON FUNCTION pgstream_checkpoint_provision_required() FROM PUBLIC',
    'CREATE TRIGGER pgstream_checkpoint_provision BEFORE INSERT ON tenant_consumer_checkpoint FOR EACH ROW EXECUTE FUNCTION pgstream_checkpoint_provision_required()',
    'CREATE CONSTRAINT TRIGGER pgstream_checkpoint_provision_commit AFTER INSERT ON tenant_consumer_checkpoint DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pgstream_checkpoint_provision_required()',
    'ALTER TABLE tenant_consumer_checkpoint ENABLE ALWAYS TRIGGER pgstream_checkpoint_provision',
    'ALTER TABLE tenant_consumer_checkpoint ENABLE ALWAYS TRIGGER pgstream_checkpoint_provision_commit'
  ];
  const migration = { name: '0009_evaluator_pool_checkpoint_provision', up, checksum: checksum(up) };
  const catalogue = { version: 1, migrations: [...base.catalogue.migrations, migration] };
  validateCatalogue(catalogue);
  return { ...base, catalogue, provisionBody, provisionMigration: migration,
    provisionProtocol: Object.freeze({ version: 1, functionName: 'pgstream_checkpoint_provision_required', before: 'pgstream_checkpoint_provision', deferred: 'pgstream_checkpoint_provision_commit' }) };
}
async function assertInstalled (query, intakeProfile, {predecessorProfile} = {}) {
  if (typeof query !== 'function') throw new TypeError('PGSTREAM_POOL_PROVISION_QUERY');
  const profile = profiles.validate(intakeProfile), b = profile.binding;
  const selected = require('./pool-catalogue').build(profile,{predecessorProfile});
  const rows = (await query(`SELECT /* pool-checkpoint-provision-protocol */ t.tgname AS name,t.tgtype AS type,t.tgenabled AS enabled,t.tgdeferrable AS deferrable,t.tginitdeferred AS deferred,t.tgnargs AS arguments,t.tgqual IS NULL AS unconditional,t.tgattr::text AS columns,p.prosrc AS source,p.proname AS function_name,p.prosecdef AS definer,p.proconfig AS config,p.pronargs AS function_arguments,p.prorettype='pg_catalog.trigger'::regtype AS trigger_result,l.lanname AS language
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname=$1 AND f.nspname=$1 AND c.relname='tenant_consumer_checkpoint' AND t.tgname=ANY($2::text[]) AND NOT t.tgisinternal`, [b.namespace, ['pgstream_checkpoint_provision', 'pgstream_checkpoint_provision_commit']])).rows;
  const names = new Set();
  if (rows.length !== 2 || rows.some(row => {
    const deferred = row.name === 'pgstream_checkpoint_provision_commit';
    if (!['pgstream_checkpoint_provision', 'pgstream_checkpoint_provision_commit'].includes(row.name) || names.has(row.name)) return true;
    names.add(row.name);
    return row.type !== (deferred ? 5 : 7) || row.enabled !== 'A' || row.deferrable !== deferred || row.deferred !== deferred || row.arguments !== 0 || row.unconditional !== true || row.columns !== '' || row.source !== selected.provisionBody || row.function_name !== 'pgstream_checkpoint_provision_required' || row.definer !== false || JSON.stringify(row.config) !== JSON.stringify(['search_path=pg_catalog']) || row.function_arguments !== 0 || row.trigger_result !== true || row.language !== 'plpgsql';
  })) throw new Error('PGSTREAM_POOL_PROVISION_PROTOCOL');
  const ledger = (await query('SELECT /* pool-checkpoint-provision-ledger */ name,checksum FROM "' + b.namespace + '".schema_migrations ORDER BY name')).rows;
  if (JSON.stringify(ledger) !== JSON.stringify(selected.catalogue.migrations.map(m => ({ name: m.name, checksum: m.checksum })))) throw new Error('PGSTREAM_POOL_PROVISION_LEDGER');
  const installed = (await query('SELECT /* pool-checkpoint-provision-profile */ consumer,profile,digest,contract_digest FROM "' + b.namespace + '".pgstream_intake_profile WHERE consumer=$1', [b.consumer + '-completed'])).rows;
  if (installed.length !== 1 || installed[0].consumer !== b.consumer + '-completed' || require('../server/serve/evaluator-runtime').canonical(installed[0].profile) !== require('../server/serve/evaluator-runtime').canonical(b) || installed[0].digest !== profile.digest || installed[0].contract_digest !== profile.contractDigest) throw new Error('PGSTREAM_POOL_PROVISION_PROFILE');
  return Object.freeze({ profile: profile.digest });
}
module.exports = { build, assertInstalled, CONTEXT_FIELDS, INSERTS, AUTHORITY_READS };
