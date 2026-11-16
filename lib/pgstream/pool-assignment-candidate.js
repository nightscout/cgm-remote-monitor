'use strict';

// Additive successor of the fixed one/two-worker SQL. Existing migration bodies
// remain untouched. Runtime selection and transition orchestration are separate.
const { checksum, validateCatalogue } = require('../migrations/catalogue');
const { MAX_MEMBERS, RULE } = require('../pool-membership/slice');
const legacy = require('./assignment-candidate');

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const TRANSITION_SETTING = 'app.pgstream_assignment_transition';
const TRANSITION_FIELDS = Object.freeze(['backendPid', 'consumer', 'generations', 'members', 'newRevision', 'oldMembers', 'oldRevision', 'operation', 'transactionId']);
function name (value) {
  if (typeof value !== 'string' || !NAME.test(value) || value.startsWith('pg_') || ['public', 'information_schema'].includes(value)) throw new TypeError('EVALUATOR_POOL_ASSIGNMENT_BINDING');
  return value;
}
function unsignedPrefix (bytes = 'bytes') {
  if (bytes !== 'bytes') throw new TypeError('EVALUATOR_POOL_ASSIGNMENT_BYTES');
  return Array.from({ length: 8 }, (_, i) => 'get_byte(bytes,' + i + ')::numeric*' + (256n ** BigInt(7 - i))).join('+');
}
function build ({ base, membershipNamespace, lifecycleNamespace, operatorRole }) {
  name(membershipNamespace); name(lifecycleNamespace); name(operatorRole);
  if (membershipNamespace === lifecycleNamespace) throw new TypeError('EVALUATOR_POOL_ASSIGNMENT_BINDING');
  const original = legacy.build({ membershipNamespace, lifecycleNamespace });
  // A selected-v1 body embeds its old roster/revision. It is not a dynamic v2
  // admission body. Compose v2 intake separately after this unselected prefix.
  if (!base || base.intakeProfile !== undefined || base.assignmentBody !== original.assignmentBody || base.effectBody !== original.effectBody || JSON.stringify(base.catalogue) !== JSON.stringify(original.catalogue)) throw new TypeError('EVALUATOR_POOL_ASSIGNMENT_BASE');
  validateCatalogue(base.catalogue);
  const membership = '"' + membershipNamespace + '"', lifecycle = '"' + lifecycleNamespace + '"';
  const prefix = unsignedPrefix();
  const key = `bytes:=sha256(convert_to('nightscout:pool-membership:xact:v1:${membershipNamespace}:evaluator','UTF8'));
    high_key:=((get_byte(bytes,0)::bigint<<24)+(get_byte(bytes,1)::bigint<<16)+(get_byte(bytes,2)::bigint<<8)+get_byte(bytes,3))::oid;
    low_key:=((get_byte(bytes,4)::bigint<<24)+(get_byte(bytes,5)::bigint<<16)+(get_byte(bytes,6)::bigint<<8)+get_byte(bytes,7))::oid;`;
  const transition = `
  transition:=NULLIF(current_setting('${TRANSITION_SETTING}',true),'')::jsonb;
  IF transition IS NOT NULL THEN
    IF TG_OP<>'UPDATE' OR current_user<>'${operatorRole}' THEN RAISE EXCEPTION 'EVALUATOR_POOL_TRANSITION_OPERATOR' USING ERRCODE='55000'; END IF;
    IF jsonb_typeof(transition)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(transition) k) IS DISTINCT FROM ARRAY[${TRANSITION_FIELDS.map(v => "'" + v + "'").join(',')}]::text[] OR transition->>'operation' IS DISTINCT FROM 'reassign' OR transition->>'consumer' IS DISTINCT FROM NEW.consumer OR transition->>'backendPid' IS DISTINCT FROM pg_backend_pid()::text OR transition->>'transactionId' IS DISTINCT FROM pg_current_xact_id()::text OR transition->>'oldRevision' IS DISTINCT FROM OLD.work_assignment_revision::text OR transition->>'newRevision' IS DISTINCT FROM NEW.work_assignment_revision::text OR OLD.work_owner_ordinal IS NULL OR NEW.work_owner_ordinal IS NULL OR NEW.work_assignment_revision IS NULL OR OLD.work_assignment_revision IS NULL OR NEW.work_assignment_revision<=OLD.work_assignment_revision OR jsonb_typeof(transition->'generations') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(transition->'generations')) NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'EVALUATOR_POOL_TRANSITION_CONTEXT' USING ERRCODE='55000'; END IF;
    IF (to_jsonb(NEW)-ARRAY['work_owner_ordinal','work_assignment_revision']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['work_owner_ordinal','work_assignment_revision']) THEN RAISE EXCEPTION 'EVALUATOR_POOL_TRANSITION_PRESERVATION' USING ERRCODE='55000'; END IF;
    ${key}
    IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid=pg_backend_pid() AND classid=high_key AND objid=low_key AND objsubid=2 AND mode='ExclusiveLock' AND granted) THEN RAISE EXCEPTION 'EVALUATOR_POOL_TRANSITION_EXCLUSIVE' USING ERRCODE='55000'; END IF;
    SELECT members,previous_members,revision,slice_rule INTO desired FROM ${membership}.pool_desired WHERE pool_kind='evaluator';
    IF NOT FOUND OR desired.members NOT BETWEEN 1 AND ${MAX_MEMBERS} OR desired.previous_members NOT BETWEEN 1 AND ${MAX_MEMBERS} OR desired.previous_members IS NULL OR desired.slice_rule<>'${RULE}' OR transition->>'members' IS DISTINCT FROM desired.members::text OR transition->>'oldMembers' IS DISTINCT FROM desired.previous_members::text OR NEW.work_assignment_revision IS DISTINCT FROM desired.revision THEN RAISE EXCEPTION 'EVALUATOR_POOL_TRANSITION_REVISION' USING ERRCODE='55000'; END IF;
    bytes:=sha256(convert_to(NEW.tenant_id::text,'UTF8'));
    IF NEW.work_owner_ordinal IS DISTINCT FROM mod((${prefix}),desired.members)::integer OR OLD.work_owner_ordinal IS DISTINCT FROM mod((${prefix}),desired.previous_members)::integer THEN RAISE EXCEPTION 'EVALUATOR_POOL_TRANSITION_BUCKET' USING ERRCODE='55000'; END IF;
    SELECT count(*) AS live_count,count(DISTINCT ordinal) AS ordinals,bool_and(coalesce(ordinal>=0 AND ordinal<desired.members AND slice_rule=desired.slice_rule AND applied_members IN (desired.previous_members,desired.members),false)) AS valid INTO roster FROM ${membership}.pool_membership WHERE pool_kind='evaluator' AND lease_expires_at>clock_timestamp();
    IF roster.live_count<>desired.members OR roster.ordinals<>desired.members OR NOT coalesce(roster.valid,false) THEN RAISE EXCEPTION 'EVALUATOR_POOL_TRANSITION_COHORT' USING ERRCODE='55000'; END IF;
    SELECT phase,generation::text AS generation,lock_key INTO lifetime FROM ${lifecycle}.tenant_lifecycle_windows WHERE tenant_id=NEW.tenant_id;
    IF NOT FOUND OR lifetime.phase<>'active' OR jsonb_typeof(transition->'generations'->(NEW.tenant_id::text)) IS DISTINCT FROM 'string' OR lifetime.generation IS DISTINCT FROM transition->'generations'->>(NEW.tenant_id::text) OR (NEW.output_revision>0 AND NEW.output_restore_generation::text IS DISTINCT FROM lifetime.generation) THEN RAISE EXCEPTION 'EVALUATOR_POOL_TRANSITION_GENERATION' USING ERRCODE='55000'; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid=pg_backend_pid() AND classid=((lifetime.lock_key>>32)&4294967295)::oid AND objid=(lifetime.lock_key&4294967295)::oid AND objsubid=1 AND mode='ShareLock' AND granted) THEN RAISE EXCEPTION 'EVALUATOR_POOL_TRANSITION_LIFETIME' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
`;
  const bound = source => source.replaceAll('desired.members NOT IN (1,2)', 'desired.members NOT BETWEEN 1 AND ' + MAX_MEMBERS);
  const declaration = body => body.replace('DECLARE ', 'DECLARE transition jsonb; roster record; lifetime record; ');
  let assignmentBody = bound(base.assignmentBody);
  const oldBucket = '(get_byte(sha256(convert_to(NEW.tenant_id::text,\'UTF8\')),7)%desired.members)';
  if (!assignmentBody.includes(oldBucket)) throw new Error('EVALUATOR_POOL_ASSIGNMENT_SOURCE_BOUNDARY');
  assignmentBody = assignmentBody.replace("  IF NOT FOUND OR desired.members", "  bytes:=sha256(convert_to(NEW.tenant_id::text,'UTF8'));\n  IF NOT FOUND OR desired.members").replace(oldBucket, 'mod((' + prefix + '),desired.members)::integer');
  assignmentBody = declaration(assignmentBody).replace('BEGIN\n', 'BEGIN\n' + transition);
  const effectBody = bound(base.effectBody).replace('DECLARE ', 'DECLARE transition jsonb; ').replace('BEGIN\n', 'BEGIN\n' + transition);
  const functionSQL = (fn, body) => `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $pool_assignment$${body}$pool_assignment$`;
  const up = [
    'ALTER TABLE tenant_consumer_checkpoint DROP CONSTRAINT evaluator_fixed_assignment_pair',
    'ALTER TABLE tenant_consumer_checkpoint ADD CONSTRAINT evaluator_fixed_assignment_pair CHECK ((work_owner_ordinal IS NULL AND work_assignment_revision IS NULL) OR (work_owner_ordinal IS NOT NULL AND work_assignment_revision IS NOT NULL AND work_version=2 AND work_owner_ordinal BETWEEN 0 AND ' + (MAX_MEMBERS - 1) + ' AND work_assignment_revision>0))',
    functionSQL('pgstream_assignment_required', assignmentBody),
    functionSQL('pgstream_assigned_effect_required', effectBody),
    'REVOKE EXECUTE ON FUNCTION pgstream_assignment_required() FROM PUBLIC',
    'REVOKE EXECUTE ON FUNCTION pgstream_assigned_effect_required() FROM PUBLIC'
  ];
  const migration = { name: '0006_evaluator_pool_assignment_v2', up, checksum: checksum(up) };
  const catalogue = { version: 1, migrations: [...base.catalogue.migrations, migration] };
  validateCatalogue(catalogue);
  return { ...base, catalogue, assignmentBody, effectBody, transitionBody: transition,
    poolAssignment: Object.freeze({ version: 2, membershipNamespace, lifecycleNamespace, operatorRole, rule: RULE, maximumMembers: MAX_MEMBERS }) };
}
module.exports = { build, unsignedPrefix, TRANSITION_SETTING, TRANSITION_FIELDS };
