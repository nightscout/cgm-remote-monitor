'use strict';

// Same-ID clinical reconciliation, not raw backup import. Current authority,
// credentials, secrets, checkpoints and the live clock remain authoritative.
// Coverage is the union of currently retained and captured identities. Historical
// purges absent from both sources retain the existing history-retention limit.
// Activity has no v3 history protocol: replace its v1 snapshot and rely on the
// maintenance controller's actual cohort invalidation after the data commit.
const { isDeepStrictEqual } = require('node:util');
const scope = require('../storage/tenant-scope');
const clock = require('../storage/postgres-write-clock');
const dates = require('../server/srv-dates');
const codec = require('../storage/postgres-identity');
const normalize = require('../api3/storage/mongoCollection/utils').normalizeDoc;
const { validateCatalogue } = require('../migrations/catalogue');
const { assertRelationInventory } = require('../storage/postgres-relation-inventory');
const artifacts = require('./artifact');
const insertion = require('./insertion-inventory');
const maintenance = require('./maintenance-window');
const readiness = require('../storage/postgres-insertion-readiness');
const catalogue = require('./clinical-catalogue');
const HISTORY = new Set(catalogue.HISTORY);
const CLINICAL = new Set(catalogue.CLINICAL);
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const LIMIT = 8640000000000000;
const expression = value => typeof value === 'string' ? value.replace(/::text|\s|[()]/g, '') : '';
const BINDING = expression("tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid");
const { refuse } = artifacts;
const qualified = (namespace, table) => '"' + namespace + '"."' + table + '"';
function namespaceOf (namespaces, kind) {
  const value = namespaces?.[kind];
  if (!NAME.test(value || '') || value === 'public' || value.startsWith('pg_') || value === 'information_schema') throw refuse('LIFECYCLE_LOGICAL_NAMESPACE_INVALID', kind);
  return value;
}
function stamp (value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= LIMIT) throw refuse('LIFECYCLE_LOGICAL_HISTORY_INVALID');
  return value;
}
function identity (row) {
  const doc = codec.decodeDocument(row), shown = { ...doc }; normalize(shown);
  if (typeof shown.identifier !== 'string' || !shown.identifier.length) throw refuse('LIFECYCLE_LOGICAL_IDENTITY_INVALID');
  return { key: row.id_kind + ':' + row.doc._id, publicId: shown.identifier };
}
function indexed (rows) {
  const typed = new Map(), publicIds = new Map();
  for (const row of rows) {
    const id = identity(row);
    if (typed.has(id.key) || publicIds.has(id.publicId)) throw refuse('LIFECYCLE_LOGICAL_IDENTITY_AMBIGUOUS');
    typed.set(id.key, row); publicIds.set(id.publicId, id.key);
  }
  return { typed, publicIds };
}
function clinical (doc) {
  const copy = { ...doc };
  for (const field of ['_id', 'identifier', 'srvModified', 'srvCreated', 'modifiedBy']) delete copy[field];
  return copy;
}
function clone (value) { return JSON.parse(JSON.stringify(value)); }

function assertCapturedFloor (artifact, clockFiles, liveFloor) {
  const described = artifact.manifest.catalogues.find(entry => entry.kind === 'clock');
  const rows = artifact.tables[artifacts.tableKey('clock', 'tenant_write_clock')];
  if (!described || !described.ledger.length || described.ledger.some((m, i) => clockFiles[i]?.name !== m.name || clockFiles[i]?.checksum !== m.checksum) ||
      !Array.isArray(rows) || rows.length !== 1 || typeof rows[0].last_stamp !== 'string' || !/^(0|[1-9][0-9]*)$/.test(rows[0].last_stamp)) throw refuse('LIFECYCLE_LOGICAL_ARTIFACT_FLOOR_INVALID');
  const floor = stamp(Number(rows[0].last_stamp));
  if (floor > liveFloor) throw refuse('LIFECYCLE_LOGICAL_ARTIFACT_FLOOR_AHEAD');
}

function assertCapturedMetadata (rows, liveFloor) {
  for (const row of rows) if (row.doc.srvModified !== undefined && stamp(row.doc.srvModified) > liveFloor) throw refuse('LIFECYCLE_LOGICAL_ARTIFACT_METADATA_AHEAD');
}

// Pure planning preserves public identities and known relative insertion order.
function planRows ({ kind, current, desired, ordered = false }) {
  if (!CLINICAL.has(kind)) throw refuse('LIFECYCLE_LOGICAL_DOMAIN_UNSUPPORTED', kind);
  const live = indexed(current), old = indexed(desired);
  for (const [publicId, key] of old.publicIds) {
    if (live.publicIds.has(publicId) && live.publicIds.get(publicId) !== key) throw refuse('LIFECYCLE_LOGICAL_IDENTITY_REASSIGNED', kind);
  }
  const sorted = desired.slice();
  if (ordered) {
    const seen = new Set();
    for (const row of sorted) {
      if (typeof row.insertion_ordinal !== 'string' || !/^[1-9][0-9]*$/.test(row.insertion_ordinal) || seen.has(row.insertion_ordinal)) throw refuse('LIFECYCLE_LOGICAL_ORDER_UNAVAILABLE', kind);
      seen.add(row.insertion_ordinal);
    }
    sorted.sort((a, b) => BigInt(a.insertion_ordinal) < BigInt(b.insertion_ordinal) ? -1 : 1);
  }
  const rows = sorted.map(row => {
    const id = identity(row), previous = live.typed.get(id.key);
    if (previous && identity(previous).publicId !== id.publicId) throw refuse('LIFECYCLE_LOGICAL_IDENTITY_REASSIGNED', kind);
    const unchanged = previous && (kind === 'activity' ? isDeepStrictEqual(previous.doc, row.doc) : isDeepStrictEqual(clinical(previous.doc), clinical(row.doc)));
    const doc = clone(unchanged ? previous.doc : row.doc);
    if (previous?.doc.identifier) doc.identifier = previous.doc.identifier;
    return { id_kind: row.id_kind, doc, action: unchanged ? 'unchanged' : previous ? 'replaced' : 'created', previous: previous?.doc || null };
  });
  if (HISTORY.has(kind)) for (const [key, previous] of live.typed) {
    if (!old.typed.has(key)) rows.push({ id_kind: previous.id_kind, doc: { ...clone(previous.doc), isValid: false }, action: 'deleted', previous: previous.doc });
  }
  return { kind, rows, removed: kind === 'activity' ? current.filter(row => !old.typed.has(identity(row).key)).length : 0 };
}

async function restore (connection, artifact, { tenant, namespaces, maintenanceClaim, catalogues, onRow, onCommitted, retention } = {}) {
  artifacts.validateArtifact(artifact);
  if (artifact.manifest.tenant !== tenant) throw refuse('LIFECYCLE_TENANT_MISMATCH');
  if (!maintenanceClaim) throw refuse('LIFECYCLE_MAINTENANCE_REQUIRED');
  if (!Array.isArray(catalogues) || !catalogues.some(entry => entry.kind === 'clock') || !catalogues.some(entry => CLINICAL.has(entry.kind))) throw refuse('LIFECYCLE_LOGICAL_CATALOGUE_REQUIRED');
  if (onCommitted !== undefined && typeof onCommitted !== 'function') throw refuse('LIFECYCLE_LOGICAL_CALLBACK_INVALID');
  // Post-deletion key retention gate (key-retention.js); never optional.
  if (!retention || typeof retention.admit !== 'function' || typeof retention.mark !== 'function') throw refuse('LIFECYCLE_RETENTION_REQUIRED');
  const claim = { connection, tenant, artifactDigest: artifact.digest };
  return scope.withTenant(tenant, () => connection.transaction(async () => {
    await maintenance.assertHeld(maintenanceClaim, claim);
    if (typeof connection.afterCommit !== 'function') throw refuse('LIFECYCLE_LOGICAL_COMMIT_HOOK_REQUIRED');
    const clockNamespace = namespaceOf(namespaces, 'clock');
    const clockEntry = catalogues.find(entry => entry.kind === 'clock');
    if (clockEntry.tables.join(',') !== 'tenant_write_clock') throw refuse('LIFECYCLE_LOGICAL_CLOCK_SCHEMA_UNSUPPORTED');
    const clockFiles = validateCatalogue(clockEntry.candidate);
    const clockLedger = (await connection.query('SELECT name,checksum FROM ' + qualified(clockNamespace, 'schema_migrations') + ' ORDER BY name COLLATE "C"')).rows;
    if (!artifacts.ledgerEqual(clockLedger, clockFiles)) throw refuse('LIFECYCLE_LOGICAL_SCHEMA_NOT_CURRENT', 'clock');
    await assertRelationInventory(connection, { namespace: clockNamespace, tables: clockEntry.tables,
      fail: (reason, name) => refuse('LIFECYCLE_LOGICAL_RELATION_' + reason, name) });
    const clockColumns = (await connection.query('SELECT /* logical-restore-clock-shape */ a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required,a.attidentity,a.attgenerated FROM pg_attribute a WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum', [qualified(clockNamespace, 'tenant_write_clock')])).rows;
    if (!isDeepStrictEqual(clockColumns, [
      { name: 'tenant_id', type: 'uuid', required: true, attidentity: '', attgenerated: '' },
      { name: 'last_stamp', type: 'bigint', required: true, attidentity: '', attgenerated: '' }
    ])) throw refuse('LIFECYCLE_LOGICAL_CLOCK_SCHEMA_UNSUPPORTED');
    const clockSecurity = (await connection.query(`SELECT /* logical-restore-clock-security */
      c.relkind='r' AND NOT c.relispartition AND c.relrowsecurity AND c.relforcerowsecurity AS secured,
      pg_has_role(current_user,c.relowner,'MEMBER') AS owns,
      (SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication FROM pg_roles WHERE rolname=current_user) OR has_schema_privilege(c.relnamespace,'CREATE') AS elevated,
      (SELECT jsonb_agg(jsonb_build_object('command',polcmd,'permissive',polpermissive,'roles',polroles::text[],
        'using',pg_get_expr(polqual,polrelid),'check',pg_get_expr(polwithcheck,polrelid))) FROM pg_policy WHERE polrelid=c.oid) AS policies,
      has_table_privilege(c.oid,'SELECT') AND has_column_privilege(c.oid,'last_stamp','UPDATE') AS serves,
      has_table_privilege(c.oid,'INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(c.oid,'INSERT,REFERENCES') OR has_column_privilege(c.oid,'tenant_id','UPDATE') AS extra,
      EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid) OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal) AS augmented
      FROM pg_class c WHERE c.oid=to_regclass($1)`, [qualified(clockNamespace, 'tenant_write_clock')])).rows[0];
    const policies = clockSecurity?.policies;
    if (!clockSecurity?.secured || clockSecurity.owns || clockSecurity.elevated || !clockSecurity.serves || clockSecurity.extra || clockSecurity.augmented ||
        !Array.isArray(policies) || policies.length !== 1 || policies[0].command !== '*' || policies[0].permissive !== true ||
        !isDeepStrictEqual(policies[0].roles, ['0']) || expression(policies[0].using) !== BINDING || expression(policies[0].check) !== BINDING) throw refuse('LIFECYCLE_LOGICAL_CLOCK_SCHEMA_UNSUPPORTED');
    const locked = await connection.query('SELECT /* logical-restore-live-clock */ last_stamp FROM ' + qualified(clockNamespace, 'tenant_write_clock') + ' WHERE tenant_id=$1 FOR UPDATE', [tenant]);
    if (locked.rows.length !== 1 || typeof locked.rows[0].last_stamp !== 'string' || !/^(0|[1-9][0-9]*)$/.test(locked.rows[0].last_stamp)) throw refuse('LIFECYCLE_LOGICAL_LIVE_FLOOR_REQUIRED');
    const liveFloor = stamp(Number(locked.rows[0].last_stamp));
    assertCapturedFloor(artifact, clockFiles, liveFloor);
    const work = [], described = new Map(artifact.manifest.catalogues.map(entry => [entry.kind, entry]));
    for (const entry of catalogues.filter(item => CLINICAL.has(item.kind))) {
      const namespace = namespaceOf(namespaces, entry.kind), old = described.get(entry.kind);
      const files = validateCatalogue(entry.candidate);
      if (!old || !old.ledger.length || old.ledger.some((m, i) => files[i]?.name !== m.name || files[i]?.checksum !== m.checksum)) throw refuse('LIFECYCLE_LOGICAL_ARTIFACT_SCHEMA_UNSUPPORTED', entry.kind);
      const ledger = (await connection.query('SELECT name,checksum FROM ' + qualified(namespace, 'schema_migrations') + ' ORDER BY name COLLATE "C"')).rows;
      if (!artifacts.ledgerEqual(ledger, files)) throw refuse('LIFECYCLE_LOGICAL_SCHEMA_NOT_CURRENT', entry.kind);
      await assertRelationInventory(connection, { namespace, tables: entry.tables, fail: (reason, name) => refuse('LIFECYCLE_LOGICAL_RELATION_' + reason, name) });
      const ordered = insertion.hasCounter(entry.candidate, entry.kind);
      if (ordered) { await readiness.metadata(connection, { namespace, domain: entry.kind, mode: 'restore' }); await readiness.floor(connection, { namespace, domain: entry.kind, tenant }); }
      const current = (await connection.query('SELECT /* logical-restore-current */ tenant_id,id_kind,doc' + (ordered ? ',insertion_ordinal::text AS insertion_ordinal' : '') + ' FROM ' + qualified(namespace, entry.kind) + ' WHERE tenant_id=$1', [tenant])).rows;
      for (const row of current) {
        if (row.tenant_id !== tenant) throw refuse('LIFECYCLE_LOGICAL_ROW_TENANT_MISMATCH');
        if (HISTORY.has(entry.kind) && row.doc.srvModified !== undefined && stamp(row.doc.srvModified) > liveFloor) throw refuse('LIFECYCLE_LOGICAL_LIVE_FLOOR_BEHIND');
      }
      const desired = artifact.tables[artifacts.tableKey(entry.kind, entry.kind)];
      if (!Array.isArray(desired)) throw refuse('LIFECYCLE_LOGICAL_ARTIFACT_INCOMPLETE', entry.kind);
      if (HISTORY.has(entry.kind)) assertCapturedMetadata(desired, liveFloor);
      work.push({ ...planRows({ kind: entry.kind, current, desired, ordered }), namespace, ordered });
    }
    const summary = { tenant, mode: 'logical-history-reconciliation', liveFloorBefore: liveFloor, liveFloorAfter: liveFloor,
      created: 0, replaced: 0, deleted: 0, unchanged: 0, legacyActivityRemoved: 0, tables: work.length,
      preservedKinds: catalogues.filter(entry => !CLINICAL.has(entry.kind)).map(entry => entry.kind),
      historyScope: 'current-live-and-artifact-identities', historicalPurgesAbsentFromBoth: 'outside-retained-history-scope' };
    const restorable = await retention.admit(connection);
    const stamped = clock(connection, clockNamespace);
    await stamped.transaction(async () => {
      // Plan all public changes before removing any current clinical row.
      for (const table of work) for (const row of table.rows) {
        summary[row.action]++;
        if (HISTORY.has(table.kind) && row.action !== 'unchanged') {
          const next = dates.next(); row.doc.srvModified = next;
          if (row.action === 'created') row.doc.srvCreated = next;
          else if (row.action === 'replaced') row.doc.srvCreated = row.previous.srvCreated || next;
          summary.liveFloorAfter = next;
        }
      }
      let written = 0;
      for (const table of work) {
        summary.legacyActivityRemoved += table.removed;
        await connection.query('DELETE /* logical-restore-rebuild */ FROM ' + qualified(table.namespace, table.kind) + ' WHERE tenant_id=$1', [tenant]);
        for (const row of table.rows) {
          const result = await connection.query('INSERT /* logical-restore-row */ INTO ' + qualified(table.namespace, table.kind) + ' (tenant_id,id_kind,doc) VALUES($1,$2,$3::jsonb)', [tenant, row.id_kind, JSON.stringify(row.doc)]);
          if (result.rowCount !== 1) throw refuse('LIFECYCLE_LOGICAL_WRITE_COUNT');
          if (onRow) await onRow({ kind: table.kind, written: ++written, action: row.action });
        }
        const actual = (await connection.query('SELECT /* logical-restore-oracle */ tenant_id,id_kind,doc' + (table.ordered ? ',restored.insertion_ordinal::text AS insertion_ordinal' : '') + ' FROM ' + qualified(table.namespace, table.kind) + ' AS restored WHERE tenant_id=$1' + (table.ordered ? ' ORDER BY restored.insertion_ordinal' : ''), [tenant])).rows;
        const view = rows => rows.map(row => ({ id_kind: row.id_kind, doc: row.doc }));
        if (table.ordered ? !isDeepStrictEqual(view(actual), view(table.rows)) : artifacts.digestRows(view(actual)) !== artifacts.digestRows(view(table.rows))) throw refuse('LIFECYCLE_LOGICAL_ORACLE_MISMATCH', table.kind);
        if (table.ordered) await readiness.floor(connection, { namespace: table.namespace, domain: table.kind, tenant });
      }
    });
    await retention.mark(connection, restorable);
    await maintenance.assertHeld(maintenanceClaim, claim);
    const frozen = Object.freeze({ ...summary, preservedKinds: Object.freeze(summary.preservedKinds) });
    if (onCommitted) connection.afterCommit(() => onCommitted(frozen));
    return frozen;
  }));
}

module.exports = { restore, planRows };
