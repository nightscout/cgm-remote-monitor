'use strict';
// Singleton keeps the same SQL owner, transaction and lifecycle fences. Only
// its nonexistent membership lease is replaced by an explicit applied mode.
const { checksum, validateCatalogue } = require('../migrations/catalogue');
const profiles = require('./pool-intake-profile');
const pool = require('./pool-assignment-candidate');
function baseFor (profile) {
  const b = profile.binding;
  const assignment = pool.build({ base: require('./assignment-candidate').build(b), membershipNamespace: b.membershipNamespace, lifecycleNamespace: b.lifecycleNamespace, operatorRole: b.operatorRole });
  const intake = require('./pool-intake-candidate').build({ base: assignment, intakeProfile: profile });
  return require('./pool-checkpoint-provision-candidate').build({ base: intake, intakeProfile: profile });
}
function once (source, needle, replacement) {
  if (source.split(needle).length !== 2) throw new Error('POOL_PLACEMENT_SOURCE_BOUNDARY');
  return source.replace(needle, replacement);
}
function block (source, start, end) {
  const at = source.indexOf(start), until = source.indexOf(end, at);
  if (at < 0 || until < at) throw new Error('POOL_PLACEMENT_SOURCE_BOUNDARY');
  return source.slice(at, until);
}
function build ({ base, intakeProfile }) {
  const p = profiles.validate(intakeProfile), b = p.binding, expected = baseFor(p);
  if (!base || JSON.stringify(base.catalogue) !== JSON.stringify(expected.catalogue) || base.assignmentBody !== expected.assignmentBody || base.effectBody !== expected.effectBody || base.intakeAssertBody !== expected.intakeAssertBody || base.provisionBody !== expected.provisionBody) throw new TypeError('POOL_PLACEMENT_BASE');
  const members = '"' + b.membershipNamespace + '".pool_membership';
  const fields = [...pool.TRANSITION_FIELDS, 'oldPartitioned', 'partitioned'].sort();
  const oldFields = 'ARRAY[' + pool.TRANSITION_FIELDS.map(value => "'" + value + "'").join(',') + ']::text[]';
  const newFields = 'ARRAY[' + fields.map(value => "'" + value + "'").join(',') + ']::text[]';
  const transitionRoster = block(base.transitionBody, '    SELECT count(*) AS live_count', '    prior_tenant:=');
  const transitionMode = `    IF jsonb_typeof(transition->'partitioned') IS DISTINCT FROM 'boolean' OR jsonb_typeof(transition->'oldPartitioned') IS DISTINCT FROM 'boolean' OR transition->>'partitioned' IS DISTINCT FROM desired.partitioned::text OR transition->>'oldPartitioned' IS DISTINCT FROM desired.previous_partitioned::text OR (NOT desired.partitioned AND desired.members<>1) OR (NOT desired.previous_partitioned AND desired.previous_members<>1) THEN RAISE EXCEPTION 'EVALUATOR_POOL_TRANSITION_PLACEMENT' USING ERRCODE='55000'; END IF;
    IF desired.partitioned THEN
${transitionRoster}    ELSE
      IF EXISTS(SELECT 1 FROM ${members} WHERE pool_kind='evaluator' AND lease_expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'EVALUATOR_POOL_TRANSITION_LIVE_MEMBERS' USING ERRCODE='55000'; END IF;
    END IF;
`;
  const desiredColumns = source => source.replaceAll('SELECT members,previous_members,revision,slice_rule INTO desired', 'SELECT members,previous_members,revision,slice_rule,partitioned,previous_partitioned INTO desired').replaceAll('SELECT members,revision,slice_rule INTO desired', 'SELECT members,revision,slice_rule,partitioned,previous_partitioned INTO desired');
  let transitionBody = once(base.transitionBody, oldFields, newFields);
  transitionBody = once(transitionBody, transitionRoster, transitionMode);
  transitionBody = desiredColumns(transitionBody);
  let assignmentBody = once(base.assignmentBody, base.transitionBody, transitionBody);
  let effectBody = once(base.effectBody, base.transitionBody, transitionBody);
  assignmentBody = desiredColumns(assignmentBody); effectBody = desiredColumns(effectBody);
  const ordinary = require('./assignment-candidate').build(b).effectBody;
  const workerRoster = block(ordinary, '  SELECT count(*) AS live_count', '  SELECT phase,generation');
  const workerMode = `  IF context->>'partitioned' IS DISTINCT FROM desired.partitioned::text THEN RAISE EXCEPTION 'EVALUATOR_ASSIGNED_EFFECT_PLACEMENT' USING ERRCODE='55000'; END IF;
  IF desired.partitioned THEN
${workerRoster}  ELSE
    IF desired.members<>1 OR OLD.work_owner_ordinal<>0 OR NOT (context ? 'memberId') OR jsonb_typeof(context->'memberId') IS DISTINCT FROM 'null' THEN RAISE EXCEPTION 'EVALUATOR_SINGLETON_CONTEXT' USING ERRCODE='55000'; END IF;
    IF EXISTS(SELECT 1 FROM ${members} WHERE pool_kind='evaluator' AND lease_expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'EVALUATOR_SINGLETON_LIVE_MEMBERS' USING ERRCODE='55000'; END IF;
  END IF;
`;
  effectBody = once(effectBody, workerRoster, workerMode);
  let provisionBody = desiredColumns(base.provisionBody);
  const provisionRoster = block(provisionBody, ' SELECT count(*) AS live_count', ' stamp:=');
  const provisionMode = ` IF desired.partitioned THEN
${provisionRoster} ELSE
  IF desired.members<>1 OR NEW.work_owner_ordinal<>0 THEN RAISE EXCEPTION 'PGSTREAM_SINGLETON_PROVISION_ASSIGNMENT' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM ${members} WHERE pool_kind='evaluator' AND lease_expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'PGSTREAM_SINGLETON_PROVISION_LIVE_MEMBERS' USING ERRCODE='55000'; END IF;
 END IF;
`;
  provisionBody = once(provisionBody, provisionRoster, provisionMode);
  const intakeAssertBody = desiredColumns(base.intakeAssertBody);
  const functionSQL = (name, body, result = 'trigger') => `CREATE OR REPLACE FUNCTION ${name}() RETURNS ${result} LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $pool_placement$${body}$pool_placement$`;
  const up = [functionSQL('pgstream_assignment_required', assignmentBody), functionSQL('pgstream_assigned_effect_required', effectBody), functionSQL('pgstream_intake_assert', intakeAssertBody, 'void'), functionSQL('pgstream_checkpoint_provision_required', provisionBody)];
  const migration = { name: '0010_pool_singleton_effects', up, checksum: checksum(up) };
  const catalogue = { version: 1, migrations: [...base.catalogue.migrations, migration] };
  validateCatalogue(catalogue);
  return { ...base, catalogue, assignmentBody, effectBody, transitionBody, intakeAssertBody, provisionBody,
    poolPlacement: Object.freeze({ version: 1, transitionFields: Object.freeze(fields), workerContextMode: 'partitioned', singletonMemberId: null }) };
}
module.exports = { build };
