'use strict';

// Exact deletion reconstruction inside the real controller's DATA transaction.
// The retained artifact owns erased clinical/order/credential state. Current
// maintenance authority, configuration and registry own admission/capabilities.
const scope = require('../storage/tenant-scope');
const maintenance = require('./maintenance-window');
const artifacts = require('./artifact');
const planner = require('./recommission-plan');
const control = require('./recommission-control');
const { HISTORY } = require('./clinical-catalogue');
const { refuse } = artifacts;
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const q = (namespace, table) => '"' + namespace + '"."' + table + '"';
function namespaceOf (value) {
  if (typeof value !== 'string' || !NAME.test(value) || value === 'public' || value.startsWith('pg_') || value === 'information_schema') throw refuse('LIFECYCLE_RECOMMISSION_NAMESPACE_INVALID');
  return value;
}
function freeze (value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function floorOf (rows, field) {
  let floor = 0;
  for (const row of rows || []) {
    const value = row[field];
    if (!Number.isInteger(value) || value < 1 || value >= 2147483647) throw refuse('LIFECYCLE_RECOMMISSION_POLICY_EPOCH_INVALID');
    floor = Math.max(floor, value);
  }
  return floor;
}
function create ({ intakeProfile, predecessorProfile, registryNamespace, currentConfiguration, providerFor, signersFor,
  authorize, verifyDurableArtifact, admissionCheck, catalogues, verifyTarget, insertStatement, insertValues, retention, timestamp }) {
  const profile = require('../pgstream/pool-intake-profile').validate(intakeProfile);
  const registry = require('../tenant-registry/recommission').create({ namespace: namespaceOf(registryNamespace), controlNamespace: profile.binding.lifecycleNamespace });
  return async function recommission (connection, input, options = {}) {
    artifacts.validateArtifact(input);
    // Own the exact input before any awaited authority/provider call. A caller
    // cannot alter a later insert after the retained digest was admitted.
    const artifact = freeze(JSON.parse(JSON.stringify(input)));
    artifacts.validateArtifact(artifact);
    const { tenant, namespaces, requestId, ledgerNamespace, maintenanceClaim, onRow, onCommitted, now } = options;
    if (artifact.manifest.tenant !== tenant) throw refuse('LIFECYCLE_TENANT_MISMATCH');
    if (ledgerNamespace !== profile.binding.lifecycleNamespace || typeof currentConfiguration !== 'function' || typeof providerFor !== 'function' ||
        typeof signersFor !== 'function' || typeof authorize !== 'function' || typeof verifyDurableArtifact !== 'function' || typeof admissionCheck !== 'function') throw refuse('LIFECYCLE_RECOMMISSION_CAPABILITIES_REQUIRED');
    if (onRow !== undefined && typeof onRow !== 'function' || onCommitted !== undefined && typeof onCommitted !== 'function') throw refuse('LIFECYCLE_RECOMMISSION_CALLBACK_INVALID');
    const claim = { connection, tenant, artifactDigest: artifact.digest };
    return scope.withTenant(tenant, () => connection.transaction(async () => {
      await maintenance.assertHeld(maintenanceClaim, claim);
      if (typeof connection.afterCommit !== 'function') throw refuse('LIFECYCLE_RECOMMISSION_COMMIT_HOOK_REQUIRED');
      const actor = await authorize({ connection, tenant, requestId, action: 'recommission' });
      if (!actor || actor.allowed !== true || actor.current !== true || actor.tenant !== tenant || actor.plane !== 'operator') throw refuse('LIFECYCLE_RECOMMISSION_AUTHORITY_REFUSED');
      // Actual tenant lifetime exclusion already held, then cohort, then rows.
      await require('../pool-membership/transaction-lock').lock(connection.query.bind(connection), profile.binding.membershipNamespace, 'evaluator', false);
      await admissionCheck({ catalogues, namespaces });
      const target = await verifyTarget(connection, artifact, namespaces);
      const admission = await retention.admitRecommission(connection, { tenant, requestId, artifact, ledgerNamespace, now });
      const proof = await verifyDurableArtifact({ connection, tenant, requestId, artifact, action: 'recommission' });
      if (!proof || proof.verified !== true || proof.tenant !== tenant || proof.digest !== artifact.digest) throw refuse('LIFECYCLE_DURABLE_ARTIFACT_REFUSED');
      // Compute fresh credential epochs/key exactly once for this transaction.
      const planned = planner.plan(artifact, { tenant, artifactDigest: admission.artifactDigest });
      const current = new Set(planned.current);
      for (const step of target) {
        const rows = (await connection.query('SELECT count(*)::int AS n FROM ' + q(step.namespace, step.table) + ' WHERE tenant_id=$1', [tenant])).rows;
        if (rows.length !== 1 || !Number.isSafeInteger(rows[0].n) || rows[0].n < 0 || (!current.has(step.key) && rows[0].n !== 0)) throw refuse('LIFECYCLE_RECOMMISSION_TARGET_NOT_EMPTY', step.key);
      }
      const provider = await providerFor({ tenant, connection });
      await require('./recommission-secrets').verify({ artifact, tenant, provider });
      const configuration = await currentConfiguration({ tenant, connection });
      const checkpoints = require('./recommission-checkpoints').describe({ intakeProfile: profile, predecessorProfile,
        replays: configuration?.replays, namespaces, catalogues });
      const registered = await registry.register(connection, { tenant, maintenanceClaim, artifactDigest: artifact.digest, configuration });
      const storedKeys = (await connection.query('SELECT kid,purpose,active FROM ' + q(namespaces.access, 'access_keys') + ' WHERE tenant_id=$1', [tenant])).rows;
      const map = { access: 'data', management: 'management', 'human-data': 'data', 'human-management': 'management' };
      const keys = storedKeys.length ? storedKeys.filter(key => key.active).map(key => {
        const matches = registered.keys.filter(row => row.kid === key.kid && map[row.purpose] === key.purpose);
        if (matches.length !== 1) throw refuse('LIFECYCLE_RECOMMISSION_CURRENT_KEYS_INVALID');
        return { purpose: matches[0].purpose, kid: key.kid, publicKey: matches[0].public_key };
      }) : configuration?.access?.keys;
      await require('./recommission-key-usability').verify({ tenant, provider, keys, signers: await signersFor({ tenant, connection, keys }) });
      const written = {}; let total = 0;
      const insert = async (step, rows) => {
        written[step.key] = 0;
        for (const row of rows) {
          const result = await connection.query(insertStatement(step.namespace, step.table, step.columns), insertValues(step.columns, row));
          if (result.rowCount !== 1) throw refuse('LIFECYCLE_RECOMMISSION_WRITE_CHANGED', step.key);
          written[step.key]++; total++;
          if (onRow) await onRow({ key: step.key, written: written[step.key], total });
        }
      };
      // Current owner policy's FK needs this admitted parent before commission;
      // no archived row is used to authorize this transaction.
      const parent = target.find(step => step.key === 'authorization.tenant_authorization_config');
      if (!parent) throw refuse('LIFECYCLE_RECOMMISSION_AUTHORIZATION_REQUIRED');
      await insert(parent, planned.tables[parent.key]);
      const commissioning = await require('./recommission-commissioning').commission({ connection, maintenanceClaim, tenant, artifactDigest: artifact.digest,
        namespaces: { ...namespaces, control: ledgerNamespace, registry: registryNamespace }, configuration,
        versionFloors: { subjectPolicy: Math.max(floorOf(artifact.tables['subject_policy.subject_policy'], 'version'), floorOf(artifact.tables['subject_policy.subject_policy_audit'], 'version')),
          operatorPolicy: floorOf(artifact.tables['operator_policy.tenant_operator_policy'], 'generation') } });
      let floor = Math.max(Number(planned.floors.clock.last_stamp), timestamp(now));
      const tables = JSON.parse(JSON.stringify(planned.tables));
      for (const kind of HISTORY) for (const row of tables[kind + '.' + kind] || []) {
        if (!Number.isSafeInteger(++floor) || floor >= 8640000000000000) throw refuse('LIFECYCLE_RECOMMISSION_CLOCK_EXHAUSTED');
        row.doc.srvModified = floor;
        if (!Number.isSafeInteger(row.doc.srvCreated) || row.doc.srvCreated < 0) row.doc.srvCreated = floor;
      }
      if (!Number.isSafeInteger(++floor) || floor >= 8640000000000000) throw refuse('LIFECYCLE_RECOMMISSION_CLOCK_EXHAUSTED');
      tables['clock.tenant_write_clock'] = [{ tenant_id: tenant, last_stamp: String(floor), last_delete_stamp: String(floor) }];
      for (const step of target) if (step !== parent && !current.has(step.key) && !planned.reset.includes(step.key)) await insert(step, tables[step.key]);
      // Independent in-transaction row oracle for every reconstructed table.
      for (const step of target) if (Object.hasOwn(written, step.key)) {
        const rows = (await connection.query('SELECT ' + step.columns.map(column => '"' + column.name + '"').join(',') + ' FROM ' + q(step.namespace, step.table) + ' WHERE tenant_id=$1', [tenant])).rows;
        if (artifacts.digestRows(rows) !== artifacts.digestRows(tables[step.key])) throw refuse('LIFECYCLE_RECOMMISSION_ORACLE_MISMATCH', step.key);
      }
      const lifetime = (await connection.query('SELECT /* recommission-current-generation */ generation::text AS generation,claim_id FROM ' + q(ledgerNamespace, 'tenant_lifecycle_windows') + ' WHERE tenant_id=$1 AND phase=\'suspended\' AND artifact_digest=$2', [tenant, artifact.digest])).rows;
      if (lifetime.length !== 1) throw refuse('LIFECYCLE_RECOMMISSION_WINDOW_CHANGED');
      await require('./recommission-checkpoints').provision(connection.query.bind(connection), checkpoints, { tenant, generation: lifetime[0].generation });
      const linked = await connection.query('INSERT INTO ' + q(ledgerNamespace, 'tenant_lifecycle_recommission') +
        ' (tenant_id,request_id,claim_id,generation,artifact_digest) VALUES ($1,$2,$3,$4::bigint,$5)', [tenant, requestId, lifetime[0].claim_id, lifetime[0].generation, artifact.digest]);
      if (linked.rowCount !== 1) throw refuse('LIFECYCLE_RECOMMISSION_LINK_CHANGED');
      await retention.markRestored(connection, admission);
      await maintenance.assertHeld(maintenanceClaim, claim);
      if (onCommitted) connection.afterCommit(() => onCommitted({ tenant, artifactDigest: artifact.digest, mode: control.MODE }));
      return { tenant, mode: control.MODE, written, total, commissioning, oracle: { differences: 0 }, clock: String(floor) };
    }));
  };
}
module.exports = { create };
