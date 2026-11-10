'use strict';

// Post-deletion key retention (release decision "tenant-deletion-key-retention"):
// executing a deletion keeps the tenant's provider keys for a fixed 30-day window
// and records that window in the lifecycle ledger; an operator destroys the keys
// only after the window ends; restore of a deleted tenant is refused once the
// window has ended or destruction has started. Time is always the caller's
// injected clock. No key material, plaintext or ciphertext is returned or logged.

const scope = require('../storage/tenant-scope');
const artifacts = require('./artifact');
const { validateCatalogue } = require('../migrations/catalogue');
const candidate = require('./postgres-candidate.json');
const { assertRelationInventory } = require('../storage/postgres-relation-inventory');

const { refuse } = artifacts;
const TABLE = 'tenant_lifecycle_key_retention';
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 30 * DAY_MS;
const SEGMENT = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTOR = /^[A-Za-z0-9_-]{1,128}$/;
const qualified = (namespace, table) => '"' + namespace + '"."' + table + '"';

// Every table the reviewed lifecycle candidate creates in its own namespace.
const LEDGER_TABLES = Object.freeze(validateCatalogue(candidate).flatMap(migration => migration.up
  .map(sql => /^\s*CREATE TABLE ([a-z][a-z0-9_]+) \(/.exec(sql)).filter(Boolean).map(match => match[1])));

// Key names are trusted provisioning references ({ mount, name }), never key
// material. Canonical order makes the artifact and the inventory comparable.
function keyNames (value, code = 'LIFECYCLE_KEY_NAMES_INVALID') {
  if (!Array.isArray(value) || !value.length) throw refuse(code);
  const seen = new Set();
  const names = value.map(entry => {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'mount,name' ||
        !SEGMENT.test(entry.mount) || !SEGMENT.test(entry.name)) throw refuse(code);
    const key = entry.mount + '/' + entry.name;
    if (seen.has(key)) throw refuse(code);
    seen.add(key);
    return Object.freeze({ mount: entry.mount, name: entry.name });
  });
  return Object.freeze(names.sort((a, b) => (a.mount + '/' + a.name).localeCompare(b.mount + '/' + b.name)));
}

function retentionDeadline (retainedAt) {
  if (!Number.isSafeInteger(retainedAt) || retainedAt < 0 || !Number.isSafeInteger(retainedAt + RETENTION_MS)) throw refuse('LIFECYCLE_CLOCK_INVALID');
  return retainedAt + RETENTION_MS;
}

const destroyIntent = (tenant, requestId) => 'destroy-retained-keys:' + tenant + ':' + requestId;

function createKeyRetention ({ authorize, keyInventory, keyCustodian, namespaceOf, timestamp, catalogue, countRows } = {}) {
  // The completeness check: the artifact names every provisioned key of the
  // tenant and holds every live ciphertext with its key reference. It runs in
  // the destructive transaction before any secret or audit row is removed.
  async function assertKeyCompleteness ({ tenant, artifact, plan, liveRows }) {
    if (typeof keyInventory !== 'function') throw refuse('LIFECYCLE_KEY_INVENTORY_REQUIRED');
    const provisioned = keyNames(await keyInventory({ tenant }), 'LIFECYCLE_KEY_INVENTORY_INVALID');
    if (artifact.manifest.keyNames === null || artifact.manifest.keyNames === undefined) throw refuse('LIFECYCLE_KEY_NAMES_MISSING');
    const declared = keyNames(artifact.manifest.keyNames);
    const id = entry => entry.mount + '/' + entry.name;
    const named = new Set(declared.map(id));
    for (const entry of provisioned) if (!named.has(id(entry))) throw refuse('LIFECYCLE_KEY_REFERENCE_MISSING', id(entry));
    const known = new Set(provisioned.map(id));
    for (const entry of declared) if (!known.has(id(entry))) throw refuse('LIFECYCLE_KEY_REFERENCE_UNKNOWN', id(entry));
    let references = 0;
    for (const step of plan) {
      const entry = catalogue.find(item => item.kind === step.kind);
      if (!entry || !entry.secrets.includes(step.table)) continue;
      const described = step.described.tables.find(table => table.table === step.table);
      const byId = new Map((described.keyReferences || []).map(reference => [reference.id, reference]));
      const stored = new Map(artifact.tables[step.key].map(row => [row.id, row]));
      const rows = liveRows.get(step.key) || [];
      if (byId.size !== rows.length || stored.size !== rows.length) throw refuse('LIFECYCLE_KEY_MATERIAL_UNVERIFIED', step.key);
      for (const row of rows) {
        const reference = byId.get(row.id), copy = stored.get(row.id);
        if (!reference || !copy || copy.ciphertext !== row.ciphertext ||
            artifacts.keyReference(row.ciphertext).keyVersion !== reference.keyReference.keyVersion) {
          throw refuse('LIFECYCLE_KEY_MATERIAL_UNVERIFIED', step.key + '.' + row.id);
        }
        references++;
      }
    }
    return { keyNames: declared, keyReferences: references };
  }

  async function recordRetention (connection, { ledgerNamespace, tenant, requestId, artifactDigest, completeness, executedAt }) {
    const ledger = namespaceOf({ ledger: ledgerNamespace }, 'ledger');
    const inserted = await connection.query('INSERT INTO ' + qualified(ledger, TABLE) +
      ' (request_id, tenant_id, artifact_digest, key_names, key_references, phase, retained_at, retain_until) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)',
    [requestId, tenant, artifactDigest, JSON.stringify(completeness.keyNames), completeness.keyReferences, 'retained', executedAt, retentionDeadline(executedAt)]);
    if (inserted.rowCount !== 1) throw refuse('LIFECYCLE_RETENTION_NOT_RECORDED');
    return { retainedAt: executedAt, retainUntil: retentionDeadline(executedAt) };
  }

  async function tenantRecords (connection, ledger, tenant) {
    const result = await connection.query('SELECT request_id, phase, retained_at, retain_until FROM ' + qualified(ledger, TABLE) +
      ' WHERE tenant_id = $1 FOR UPDATE', [tenant]);
    return result.rows.map(row => {
      if (!['retained', 'restored', 'destroying', 'destroyed'].includes(row.phase)) throw refuse('LIFECYCLE_RETENTION_INVALID');
      return { requestId: row.request_id, phase: row.phase, retainedAt: Number(row.retained_at), retainUntil: Number(row.retain_until) };
    });
  }

  // Inside the restore's own transaction, before any write: a tenant whose
  // keys are destroyed or past their window is not restored. A tenant that was
  // never deleted has no retention record and is unaffected.
  async function admitRestore (connection, { tenant, ledgerNamespace, now }) {
    if (ledgerNamespace === undefined) throw refuse('LIFECYCLE_RETENTION_LEDGER_REQUIRED');
    const ledger = namespaceOf({ ledger: ledgerNamespace }, 'ledger');
    const at = timestamp(now);
    const records = await tenantRecords(connection, ledger, tenant);
    if (records.some(record => record.phase === 'destroying' || record.phase === 'destroyed')) throw refuse('LIFECYCLE_KEYS_DESTROYED');
    const open = records.filter(record => record.phase === 'retained');
    if (open.some(record => at >= record.retainUntil)) throw refuse('LIFECYCLE_RETENTION_EXPIRED');
    if (open.some(record => at < record.retainedAt)) throw refuse('LIFECYCLE_CLOCK_REWOUND');
    return { ledger, at, requestIds: open.map(record => record.requestId) };
  }

  async function markRestored (connection, admission) {
    for (const requestId of admission.requestIds) {
      const updated = await connection.query('UPDATE ' + qualified(admission.ledger, TABLE) +
        ' SET phase = $3, restored_at = $4 WHERE request_id = $1 AND tenant_id = $2 AND phase = $5',
      [requestId, scope.requireTenant('lifecycle restore retention'), 'restored', admission.at, 'retained']);
      if (updated.rowCount !== 1) throw refuse('LIFECYCLE_RETENTION_CONFLICT');
    }
  }

  async function ready (connection, ledger) {
    const rows = await connection.query('SELECT name, checksum FROM ' + qualified(ledger, 'schema_migrations') + ' ORDER BY name COLLATE "C"');
    if (!artifacts.ledgerEqual(rows.rows, validateCatalogue(candidate))) throw refuse('LIFECYCLE_RETENTION_SCHEMA_REQUIRED');
    await assertRelationInventory(connection, { namespace: ledger, tables: LEDGER_TABLES.slice(),
      fail: (reason, name) => refuse('LIFECYCLE_RELATION_' + reason, 'lifecycle.' + name) });
  }

  async function operator (connection, options) {
    if (typeof authorize !== 'function') throw refuse('LIFECYCLE_AUTHORITY_REQUIRED');
    const actor = await authorize({ connection, tenant: options.tenant, requestId: options.requestId, action: 'destroy-keys' });
    if (!actor || actor.allowed !== true || actor.current !== true || actor.tenant !== options.tenant ||
        typeof actor.principal !== 'string' || typeof actor.consumer !== 'string' || !ACTOR.test(actor.principal) || !ACTOR.test(actor.consumer)) throw refuse('LIFECYCLE_AUTHORITY_REFUSED');
    if (actor.plane !== 'operator') throw refuse('LIFECYCLE_OPERATOR_REQUIRED');
    return actor;
  }

  function destroyOptions (options) {
    if (!options || typeof options.tenant !== 'string' || !UUID.test(options.tenant)) throw refuse('LIFECYCLE_TENANT_INVALID');
    if (typeof options.requestId !== 'string' || !UUID.test(options.requestId)) throw refuse('LIFECYCLE_REQUEST_INVALID');
    namespaceOf({ ledger: options.ledgerNamespace }, 'ledger');
    // Irreversible: the operator restates the exact tenant and request.
    if (options.intent !== destroyIntent(options.tenant, options.requestId)) throw refuse('LIFECYCLE_DESTROY_INTENT_REQUIRED');
  }

  const transaction = (conn, options, fn) => {
    if (!conn || typeof conn.transaction !== 'function' || typeof conn.query !== 'function') throw refuse('LIFECYCLE_TRANSACTION_REQUIRED');
    return scope.withTenant(options.tenant, () => conn.transaction(async () => {
      await ready(conn, options.ledgerNamespace);
      return fn();
    }));
  };

  async function lockedRecord (conn, options) {
    const result = await conn.query('SELECT request_id, artifact_digest, key_names, phase, retained_at, retain_until, destroy_started_at FROM ' +
      qualified(options.ledgerNamespace, TABLE) + ' WHERE request_id = $1 AND tenant_id = $2 FOR UPDATE', [options.requestId, options.tenant]);
    if (result.rows.length !== 1) throw refuse('LIFECYCLE_RETENTION_MISSING');
    const row = result.rows[0];
    return { ...row, keyNames: keyNames(row.key_names, 'LIFECYCLE_RETENTION_INVALID'), retainUntil: Number(row.retain_until) };
  }

  // Two committed steps around the provider call. The first commit moves the
  // record to `destroying` (restore refuses from then on); the provider then
  // deletes and confirms absence of every key; the second commit records
  // `destroyed`. A provider failure leaves `destroying` for an explicit retry.
  async function destroyRetainedKeys (conn, options = {}) {
    destroyOptions(options);
    if (!keyCustodian || typeof keyCustodian.destroy !== 'function') throw refuse('LIFECYCLE_KEY_CUSTODIAN_REQUIRED');
    const started = await transaction(conn, options, async () => {
      await operator(conn, options);
      const record = await lockedRecord(conn, options);
      if (record.phase === 'restored') throw refuse('LIFECYCLE_RETENTION_RESTORED');
      if (record.phase === 'destroyed') return { record, already: true };
      const at = timestamp(options.now);
      if (record.phase === 'retained' && at < record.retainUntil) throw refuse('LIFECYCLE_RETENTION_WINDOW_OPEN');
      // A same-ID tenant that is live again must never lose its keys here.
      for (const entry of catalogue) {
        const namespace = namespaceOf(options.namespaces, entry.kind);
        for (const table of entry.tables) {
          if (await countRows(conn, options.tenant, namespace, table) !== 0) throw refuse('LIFECYCLE_TENANT_NOT_DELETED', entry.kind + '.' + table);
        }
      }
      const actor = await operator(conn, options);
      if (record.phase === 'retained') {
        const updated = await conn.query('UPDATE ' + qualified(options.ledgerNamespace, TABLE) +
          ' SET phase = $3, destroy_started_by = $4, destroy_started_consumer = $5, destroy_started_at = $6 WHERE request_id = $1 AND tenant_id = $2 AND phase = $7',
        [options.requestId, options.tenant, 'destroying', actor.principal, actor.consumer, at, 'retained']);
        if (updated.rowCount !== 1) throw refuse('LIFECYCLE_RETENTION_CONFLICT');
      }
      return { record, already: false };
    });
    if (started.already) return { requestId: options.requestId, tenant: options.tenant, phase: 'destroyed', keys: started.record.keyNames.length, resumed: true };
    const proof = await keyCustodian.destroy({ tenant: options.tenant, keys: started.record.keyNames });
    if (!proof || proof.destroyed !== true || proof.absent !== started.record.keyNames.length) throw refuse('LIFECYCLE_KEY_DESTRUCTION_UNVERIFIED');
    return transaction(conn, options, async () => {
      const record = await lockedRecord(conn, options);
      if (record.phase !== 'destroying') throw refuse('LIFECYCLE_RETENTION_CONFLICT');
      const actor = await operator(conn, options);
      const at = Math.max(timestamp(options.now), Number(record.destroy_started_at));
      const updated = await conn.query('UPDATE ' + qualified(options.ledgerNamespace, TABLE) +
        ' SET phase = $3, destroyed_by = $4, destroyed_consumer = $5, destroyed_at = $6 WHERE request_id = $1 AND tenant_id = $2 AND phase = $7',
      [options.requestId, options.tenant, 'destroyed', actor.principal, actor.consumer, at, 'destroying']);
      if (updated.rowCount !== 1) throw refuse('LIFECYCLE_RETENTION_CONFLICT');
      return { requestId: options.requestId, tenant: options.tenant, phase: 'destroyed', keys: record.keyNames.length, destroyedAt: at, resumed: false };
    });
  }

  // Operator view: phase and deadlines only; never key material.
  async function retentionStatus (conn, options = {}) {
    if (!options || typeof options.tenant !== 'string' || !UUID.test(options.tenant)) throw refuse('LIFECYCLE_TENANT_INVALID');
    namespaceOf({ ledger: options.ledgerNamespace }, 'ledger');
    return transaction(conn, options, () => tenantRecords(conn, options.ledgerNamespace, options.tenant));
  }

  return { assertKeyCompleteness, recordRetention, admitRestore, markRestored, destroyRetainedKeys, retentionStatus };
}

module.exports = { createKeyRetention, keyNames, retentionDeadline, destroyIntent, RETENTION_MS, TABLE, LEDGER_TABLES };
