'use strict';
// covers: lib/tenant-operations/backup.js, lib/tenant-operations/restore.js, lib/tenant-operations/upgrade.js, lib/tenant-operations/common.js

const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const codec = require('../lib/storage/postgres-identity');
const { validateCatalogue, checksum } = require('../lib/migrations/catalogue');
const common = require('../lib/tenant-operations/common');
const operations = require('../lib/tenant-operations');
const { legacyInsertionCatalogue } = require('./fixtures/legacy-insertion-catalogue');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const HEX = '0123456789abcdef01234567';
const COMMIT = '83582e876dd193f4448f44c28e379fb5464a26c7';
const NOW = () => 1700000000000;

const CANDIDATES = {
  entries: legacyInsertionCatalogue(require('../migrations/candidates/postgres-entries-v1.json')),
  clock: require('../migrations/candidates/postgres-write-clock-v1.json'),
  access: require('../lib/tenant-authorization/access-candidate.json'),
  secrets: require('../lib/secrets/postgres-candidate.json')
};
const OLD_ENTRIES = { version: 1, migrations: [CANDIDATES.entries.migrations[0]] };
const TABLES = {
  entries: ['entries'],
  clock: ['tenant_write_clock'],
  access: ['access_tenants', 'access_credentials', 'access_sessions', 'access_keys'],
  secrets: ['secret_records', 'secret_audit']
};
const NS = { entries: 'ns_entries', clock: 'ns_clock', access: 'ns_access', secrets: 'ns_secrets' };
const FRESH = { entries: 'fresh_entries', clock: 'fresh_clock', access: 'fresh_access', secrets: 'fresh_secrets' };
const REGISTRY = { kind: 'access', table: 'access_tenants' };

function catalogues (namespaces = NS, overrides = {}) {
  return Object.keys(TABLES).map(kind => ({
    kind, namespace: namespaces[kind], catalogue: overrides[kind] || CANDIDATES[kind], tables: TABLES[kind], secrets: kind === 'secrets' ? ['secret_records'] : []
  }));
}

// What each reviewed migration does to the fake's schema, so the fake runner
// can provision namespaces the same way for a source, a restore target and a
// rollback target. Column specs mirror the candidates' non-generated columns.
function column (spec) {
  const words = spec.trim().split(/\s+/);
  return { name: words[0], type: words[1], identity: words[2] === 'identity' };
}
const create = (schema, table, specs) => schema.tables.set(table, { columns: specs.split(',').map(column), rows: [], next: 1 });
const EFFECTS = {
  '0001_synthetic_state': schema => create(schema, 'synthetic_state', 'tenant_id uuid, value text'),
  '0001_tenant_notification_outbox': schema => {
    create(schema, 'tenant_notification_heads', 'tenant_id uuid, consumer text, dedup_key text, request_id uuid, blocked_until bigint');
    create(schema, 'tenant_notification_requests', 'tenant_id uuid, request_id uuid, consumer text, dedup_key text, origin text, config_identity text, payload jsonb, state text, created_at bigint, next_at bigint, attempt integer, attempt_token uuid, attempt_until bigint, accepted_at bigint, receipt jsonb, cleared_at bigint');
  },
  '0002_tenant_notification_producer_state': schema => create(schema, 'tenant_notification_state', 'tenant_id uuid, consumer text, revision bigint, config_identity text, producer jsonb'),
  '0001_consumer_checkpoint_projection': schema => create(schema, 'tenant_consumer_checkpoint', 'tenant_id uuid, consumer text, contract_digest text, checkpoint bigint, projection jsonb'),
  '0001_profile': schema => create(schema, 'profile', 'tenant_id uuid, doc jsonb, id_kind text'),
  '0002_profile_socket_order': schema => {
    const table = schema.tables.get('profile');
    if (table.rows.length) throw common.refuse('PROFILE_ORDER_REQUIRES_EMPTY');
    table.columns.push(column('insertion_ordinal bigint identity'));
  },
  '0001_entries': schema => create(schema, 'entries', 'tenant_id uuid, doc jsonb, id_kind text'),
  '0002_entries_insertion_order': schema => {
    const table = schema.tables.get('entries');
    table.columns.push(column('insertion_ordinal bigint identity'));
    for (const row of table.rows) row.insertion_ordinal = String(table.next++);
  },
  '0001_tenant_write_clock': schema => create(schema, 'tenant_write_clock', 'tenant_id uuid, last_stamp bigint'),
  '0001_access_state': schema => {
    create(schema, 'access_tenants', 'tenant_id uuid, active boolean');
    create(schema, 'access_credentials', 'tenant_id uuid, credential_id text, subject_id text, generation integer, enabled boolean');
    create(schema, 'access_sessions', 'tenant_id uuid, session_id text, subject_id text, credential_id text, generation integer, expires_at bigint, active boolean, purpose text');
    create(schema, 'access_keys', 'tenant_id uuid, kid text, purpose text, active boolean');
  },
  '0001_secrets': schema => {
    create(schema, 'secret_records', 'tenant_id uuid, id text, format integer, ciphertext text');
    create(schema, 'secret_audit', 'event_id uuid, tenant_id uuid, principal text, consumer text, operation text, secret_id text, phase text, event_time bigint');
  },
  '0002_secrets_rewrap': schema => {
    const table = schema.tables.get('secret_audit');
    table.columns.push(column('target_version bigint'));
    for (const row of table.rows) row.target_version = null;
  }
};

// An in-memory operator client: `query(text, values)` only, transactions as
// statements, a snapshot taken at BEGIN and put back on ROLLBACK, READ ONLY
// enforced, identity configurable, every statement recorded. Not a SQL engine.
function fakeConnection ({ identity = { rolsuper: false, rolbypassrls: true }, lossy = null } = {}) {
  const schemas = new Map();
  const log = [];
  let transaction = null;
  const clone = value => JSON.parse(JSON.stringify(value));
  const schemaOf = qualified => {
    const match = /^"([a-z0-9_]+)"\."([a-z0-9_]+)"$/.exec(qualified);
    const schema = schemas.get(match[1]);
    return { schema, table: schema && schema.tables.get(match[2]), namespace: match[1], name: match[2] };
  };
  function snapshot () {
    return new Map([...schemas].map(([namespace, schema]) => [namespace, { ledger: clone(schema.ledger),
      tables: new Map([...schema.tables].map(([name, table]) => [name, { columns: clone(table.columns), rows: clone(table.rows), next: table.next }])) }]));
  }
  function write () {
    if (transaction && transaction.readOnly) { const error = new Error('cannot execute in a read-only transaction'); error.code = '25006'; throw error; }
  }
  async function query (text, values = []) {
    const compact = text.replace(/\s+/g, ' ').trim();
    log.push({ text: compact, values: clone(values) });
    let match;
    if (/^BEGIN/.test(compact)) {
      if (transaction) throw new Error('nested transaction');
      transaction = { readOnly: /READ ONLY/.test(compact), snapshot: snapshot() };
      return { rows: [], rowCount: null };
    }
    if (compact === 'COMMIT') { if (!transaction) throw new Error('no transaction'); transaction = null; return { rows: [], rowCount: null, command: 'COMMIT' }; }
    if (compact === 'ROLLBACK') {
      if (!transaction) throw new Error('no transaction');
      schemas.clear();
      for (const [namespace, schema] of transaction.snapshot) schemas.set(namespace, schema);
      transaction = null;
      return { rows: [], rowCount: null };
    }
    if (compact === 'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user') return { rows: [{ ...identity }] };
    if (compact === 'SELECT to_regnamespace($1) IS NOT NULL AS present') return { rows: [{ present: schemas.has(values[0]) }] };
    if (compact === 'SELECT to_regclass($1) IS NOT NULL AS present') {
      const found = schemaOf(values[0]);
      return { rows: [{ present: Boolean(found.schema && (found.name === 'schema_migrations' ? found.schema.ledger : found.table)) }] };
    }
    if (/^SELECT n.nspname AS namespace, c.relname AS name FROM pg_class/.test(compact)) {
      const found = schemaOf(values[0]);
      return { rows: [{ namespace: found.namespace, name: found.name + '_' + values[1] + '_seq' }] };
    }
    if (compact.includes('reviewed-relation-inventory')) {
      const schema = schemas.get(values[0]);
      return { rows: schema ? [{ name: 'schema_migrations', kind: 'r', partition: false, inherited: false }, ...[...schema.tables].map(([name, table]) => ({ name, kind: table.kind || 'r', partition: table.partition || false, inherited: table.inherited || false }))] : [] };
    }
    if (/FROM pg_attribute/.test(compact)) {
      const found = schemaOf(values[0]);
      return { rows: found.table ? clone(found.table.columns) : [] };
    }
    if ((match = /^SELECT name, checksum FROM "([a-z0-9_]+)"\."schema_migrations" ORDER BY name COLLATE "C"$/.exec(compact))) {
      return { rows: clone(schemas.get(match[1]).ledger) };
    }
    if ((match = /^SELECT count\(\*\)::int AS n FROM ("[a-z0-9_]+"\."[a-z0-9_]+")$/.exec(compact))) {
      return { rows: [{ n: schemaOf(match[1]).table.rows.length }] };
    }
    if ((match = /^SELECT (.+) FROM ("[a-z0-9_]+"\."[a-z0-9_]+")$/.exec(compact))) {
      const names = match[1].split(',').map(part => part.trim().replace(/"/g, ''));
      return { rows: schemaOf(match[2]).table.rows.map(row => clone(Object.fromEntries(names.map(name => [name, row[name] === undefined ? null : row[name]])))) };
    }
    if ((match = /^INSERT INTO ("[a-z0-9_]+"\."[a-z0-9_]+") \((.+?)\)( OVERRIDING SYSTEM VALUE)? VALUES \((.+)\)$/.exec(compact))) {
      write();
      const { table } = schemaOf(match[1]);
      const names = match[2].split(',').map(part => part.trim().replace(/"/g, ''));
      const casts = match[4].split(',').map(part => part.trim().split('::')[1]);
      const row = Object.fromEntries(table.columns.map(c => [c.name, null]));
      names.forEach((name, index) => {
        const value = values[index];
        row[name] = (casts[index] === 'jsonb' || casts[index] === 'json') && typeof value === 'string' ? JSON.parse(value) : clone(value);
      });
      for (const c of table.columns.filter(c => c.identity)) {
        if (row[c.name] === null) row[c.name] = String(table.next++);
        else if (!match[3]) throw new Error('identity column requires OVERRIDING SYSTEM VALUE');
      }
      if (lossy !== match[1]) table.rows.push(row);
      return { rowCount: 1, rows: [] };
    }
    if ((match = /^SELECT setval\(pg_get_serial_sequence\(\$1, \$2\), \(SELECT max\("([a-z_]+)"\) FROM ("[a-z0-9_]+"\."[a-z0-9_]+")\), true\)$/.exec(compact))) {
      write();
      const { table } = schemaOf(match[2]);
      const max = table.rows.reduce((m, row) => Math.max(m, Number(row[match[1]]) || 0), 0);
      table.next = max + 1;
      return { rows: [{ setval: max || null }] };
    }
    if (/^GRANT /.test(compact)) { write(); return { rows: [] }; }
    throw new Error('fake connection cannot interpret: ' + compact);
  }
  return {
    log,
    query,
    schemas,
    rows: (namespace, table) => clone(schemas.get(namespace).tables.get(table).rows),
    ledger: namespace => (schemas.has(namespace) ? clone(schemas.get(namespace).ledger) : []),
    async seed (namespace, table, rows) {
      const target = schemas.get(namespace).tables.get(table);
      for (const row of rows) {
        const stored = { ...Object.fromEntries(target.columns.map(c => [c.name, null])), ...row };
        for (const c of target.columns.filter(c => c.identity)) if (stored[c.name] === null) stored[c.name] = String(target.next++);
        target.rows.push(stored);
      }
    },
    statements: pattern => log.filter(entry => pattern.test(entry.text))
  };
}

// The migration runner's observable contract over the fake: status, check and
// up with the prefix rule and codes of lib/migrations/postgres.js inspect.
function fakeMigrate (connection, calls = []) {
  const fail = (code, message) => { const error = new Error(message || code); error.code = code; return error; };
  return async function migrate (action, { namespace, catalogue }) {
    calls.push({ action, namespace });
    const files = validateCatalogue(catalogue);
    const schema = connection.schemas.get(namespace) || { ledger: [], tables: new Map() };
    for (const [index, row] of schema.ledger.entries()) {
      const file = files.find(m => m.name === row.name);
      if (!file) throw fail('MIG_UNKNOWN');
      if (file.checksum !== row.checksum) throw fail('MIG_DRIFT', row.name);
      if (files[index].name !== row.name) throw fail('MIG_HISTORY');
    }
    const applied = schema.ledger.map(row => row.name);
    const pending = files.slice(schema.ledger.length).map(m => m.name);
    if (action === 'status') return { current: !pending.length, applied, pending };
    if (action === 'check') { if (pending.length) throw fail('MIG_STALE'); return { current: true, applied, pending }; }
    if (action !== 'up') throw fail('MIG_UNSUPPORTED');
    connection.schemas.set(namespace, schema);
    for (const name of pending) {
      EFFECTS[name](schema);
      schema.ledger.push({ name, checksum: files.find(m => m.name === name).checksum });
    }
    return { current: true, applied: applied.concat(pending), pending: [], done: pending };
  };
}

const typed = (tenant, kind, doc) => {
  const encoded = codec.encodeDocument(kind === 'objectid' ? { ...doc, _id: new ObjectId(doc._id) } : doc);
  return { tenant_id: tenant, id_kind: encoded.id_kind, doc: encoded.doc };
};

async function seed (connection, namespaces = NS) {
  await connection.seed(namespaces.entries, 'entries', [
    typed(A, 'objectid', { _id: HEX, date: 1000, sgv: 100, extension: { nullable: null, ordered: [3, 1, 2] } }),
    typed(A, 'string', { _id: HEX, date: 1000, sgv: 101 }),
    typed(A, 'string', { _id: 'synthetic-a-2', date: 2000, sgv: 102, isValid: false }),
    typed(B, 'string', { _id: HEX, date: 1000, sgv: 200 })
  ]);
  await connection.seed(namespaces.clock, 'tenant_write_clock', [{ tenant_id: A, last_stamp: '2000' }, { tenant_id: B, last_stamp: '1000' }]);
  await connection.seed(namespaces.access, 'access_tenants', [{ tenant_id: A, active: true }, { tenant_id: B, active: true }]);
  await connection.seed(namespaces.access, 'access_credentials', [{ tenant_id: A, credential_id: 'cred-a', subject_id: 'subject-a', generation: 1, enabled: true }]);
  await connection.seed(namespaces.access, 'access_keys', [{ tenant_id: A, kid: 'key-1', purpose: 'data', active: true }, { tenant_id: B, kid: 'key-2', purpose: 'management', active: true }]);
  await connection.seed(namespaces.secrets, 'secret_records', [
    { tenant_id: A, id: 'vendor-a', format: 1, ciphertext: 'vault:v1:c3ludGhldGljLWNpcGhlcnRleHQ=' },
    { tenant_id: B, id: 'vendor-b', format: 1, ciphertext: 'vault:v2:Zm9yZWlnbg==' }
  ]);
  await connection.seed(namespaces.secrets, 'secret_audit', [{ event_id: '33333333-3333-4333-8333-333333333333', tenant_id: A, principal: 'issuer',
    consumer: 'runtime', operation: 'encrypt', secret_id: 'vendor-a', phase: 'authorized', event_time: '5' }]);
}

// A provisioned tree: every catalogue applied through the fake runner into its
// namespace, then populated. `overrides` pins a catalogue to an older version.
async function scenario ({ namespaces = NS, overrides = {}, populate = true, connection = fakeConnection() } = {}) {
  const calls = [];
  const migrate = fakeMigrate(connection, calls);
  for (const entry of catalogues(namespaces, overrides)) await migrate('up', { namespace: entry.namespace, catalogue: entry.catalogue });
  if (populate) await seed(connection, namespaces);
  connection.log.length = 0;
  calls.length = 0;
  return { connection, migrate, calls };
}

const options = extra => ({ catalogues: catalogues(), sourceCommit: COMMIT, registry: REGISTRY, now: NOW, ...extra });

// Rebuilds an artifact after editing its rows so that every count, digest and
// the tenants section agree with the edited files: the model of a backup step
// that silently lost rows, as opposed to a file damaged after the fact.
function forge (artifact, edit) {
  const manifest = JSON.parse(JSON.stringify(artifact.manifest));
  const tables = {};
  const tenants = {};
  for (const catalogue of manifest.catalogues) {
    for (const table of catalogue.tables) {
      const key = common.tableKey(catalogue.kind, table.table);
      const rows = edit(key, common.decodeTable(artifact.tables[key]));
      const encoded = common.encodeTable(rows);
      Object.assign(table, { count: encoded.count, digest: encoded.digest });
      if (table.keyReferences) table.keyReferences = common.keyReferences(rows, key);
      tables[key] = encoded.text;
      for (const [tenant, n] of Object.entries(common.tenantCounts(rows))) {
        tenants[tenant] = tenants[tenant] || { tenant_id: tenant, registered: true, rows: {} };
        tenants[tenant].rows[key] = n;
      }
    }
  }
  manifest.tenants = Object.values(tenants).sort((a, b) => a.tenant_id.localeCompare(b.tenant_id, 'en'));
  return { ...artifact, manifest, tables, digest: common.manifestDigest(manifest) };
}

async function refused (promise, code) {
  let caught;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught, 'expected refusal ' + code);
  assert.equal(caught.code, code, 'expected ' + code + ', got ' + caught.code + ': ' + caught.message);
  return caught;
}

describe('tenant operations: deployment backup, restore, upgrade and rollback', function () {
  describe('plan', function () {
    it('validates the injected catalogue list and refuses a shared namespace', function () {
      const steps = operations.plan(catalogues());
      assert.deepEqual(steps.map(s => s.kind), ['entries', 'clock', 'access', 'secrets']);
      assert.match(steps[0].catalogueChecksum, /^[a-f0-9]{64}$/);
      assert.throws(() => operations.plan(catalogues({ ...NS, clock: NS.entries })), { code: 'OPERATIONS_NAMESPACE_SHARED' });
      assert.throws(() => operations.plan(catalogues({ ...NS, clock: 'public' })), { code: 'OPERATIONS_NAMESPACE_INVALID' });
      assert.throws(() => operations.plan([]), { code: 'OPERATIONS_CATALOGUES_REQUIRED' });
      assert.throws(() => operations.plan(catalogues(NS, { entries: { version: 1, migrations: [] } })), { code: 'MIG_CATALOGUE' });
    });
  });

  describe('backup', function () {
    it('refuses hidden physical relations with a known ledger in deployment backup and restore', async function () {
      const state = await scenario();
      await operations.backup(state.connection, options());
      create(state.connection.schemas.get(NS.entries), 'unreviewed_state', 'tenant_id uuid, value text');
      await state.connection.seed(NS.entries, 'unreviewed_state', [{ tenant_id: A, value: 'synthetic' }]);
      await assert.rejects(operations.backup(state.connection, options()), { code: 'OPERATIONS_RELATION_UNADMITTED', detail: 'entries.unreviewed_state' });
    });

    it('refuses hidden target physical relations before any deployment restore effect', async function () {
      const state = await scenario(); const artifact = await operations.backup(state.connection, options());
      const target = await scenario({ namespaces: FRESH, populate: false });
      create(target.connection.schemas.get(FRESH.entries), 'unreviewed_state', 'tenant_id uuid, value text');
      await assert.rejects(operations.restore(target.connection, artifact, { catalogues: catalogues(FRESH) }), { code: 'OPERATIONS_RELATION_UNADMITTED', detail: 'entries.unreviewed_state' });
      assert.equal(target.connection.statements(/^(INSERT|GRANT|SELECT setval)/).length, 0);
    });

    it('captures every catalogued table for every tenant in one read-only snapshot, with ledgers, checksums and key references', async function () {
      const { connection } = await scenario();
      const artifact = await operations.backup(connection, options());
      const begins = connection.statements(/^BEGIN/);
      assert.equal(begins.length, 1);
      assert.equal(begins[0].text, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      assert.equal(connection.statements(/^(INSERT|UPDATE|DELETE|GRANT|CREATE)/).length, 0);
      assert.equal(connection.log[connection.log.length - 1].text, 'COMMIT');
      const manifest = artifact.manifest;
      assert.equal(manifest.sourceCommit, COMMIT);
      assert.equal(manifest.takenAt, NOW());
      assert.deepEqual(manifest.identity, { superuser: false, bypassrls: true });
      assert.deepEqual(manifest.catalogues.map(c => c.kind), ['entries', 'clock', 'access', 'secrets']);
      const entries = manifest.catalogues[0];
      assert.deepEqual(entries.ledger, connection.ledger(NS.entries));
      assert.equal(entries.catalogueChecksum, operations.plan(catalogues())[0].catalogueChecksum);
      assert.equal(entries.tables[0].count, 4);
      assert.equal(entries.tables[0].file, 'tables/entries.entries.ndjson');
      assert.equal(common.sha256(artifact.tables['entries.entries']), entries.tables[0].digest);
      assert.equal(artifact.tables['entries.entries'].split('\n').filter(Boolean).length, 4);
      assert.deepEqual(manifest.tenants.map(t => t.tenant_id), [A, B]);
      assert.deepEqual(manifest.tenants[0].rows, { 'entries.entries': 3, 'clock.tenant_write_clock': 1, 'access.access_tenants': 1,
        'access.access_credentials': 1, 'access.access_keys': 1, 'secrets.secret_records': 1, 'secrets.secret_audit': 1 });
      assert.deepEqual(manifest.tenants[1].rows, { 'entries.entries': 1, 'clock.tenant_write_clock': 1, 'access.access_tenants': 1,
        'access.access_keys': 1, 'secrets.secret_records': 1 });
      assert.equal(manifest.tenants.every(t => t.registered === true), true);
      const secrets = manifest.catalogues[3].tables[0];
      assert.deepEqual(secrets.keyReferences, [
        { tenant_id: A, id: 'vendor-a', scheme: 'vault-transit', keyVersion: 1 },
        { tenant_id: B, id: 'vendor-b', scheme: 'vault-transit', keyVersion: 2 }
      ]);
      assert.equal(manifest.catalogues[3].tables[1].keyReferences, undefined);
      assert.equal(artifact.digest, common.manifestDigest(manifest));
      // Typed twins stay distinct and the write clock travels.
      const rows = common.decodeTable(artifact.tables['entries.entries']);
      assert.equal(rows.filter(r => r.doc._id === HEX && r.tenant_id === A).length, 2);
      assert.deepEqual(new Set(rows.filter(r => r.doc._id === HEX && r.tenant_id === A).map(r => r.id_kind)), new Set(['objectid', 'string']));
      assert.deepEqual(common.decodeTable(artifact.tables['clock.tenant_write_clock']).map(r => r.last_stamp).sort(), ['1000', '2000']);
      // Serialization round-trips byte-for-byte and keeps the digest.
      const files = operations.serialize(artifact);
      assert.deepEqual(Object.keys(files).sort(), ['manifest.json', ...manifest.catalogues.flatMap(c => c.tables.map(t => t.file))].sort());
      const back = operations.deserialize(files);
      assert.equal(back.digest, artifact.digest);
      assert.deepEqual(back.tables, artifact.tables);
      assert.equal(operations.verifyArtifact(back) !== null, true);
      assert.match(operations.artifactName(artifact), /^deployment-backup-2023-11-14T22-13-20-000Z-[a-f0-9]{12}$/);
    });

    it('refuses a bound identity before reading any table: a bound role would produce an empty, consistent artifact', async function () {
      const { connection } = await scenario({ connection: fakeConnection({ identity: { rolsuper: false, rolbypassrls: false } }) });
      await refused(operations.backup(connection, options()), 'BACKUP_IDENTITY_BOUND');
      assert.equal(connection.statements(/FROM "ns_/).length, 0);
      assert.equal(connection.log[connection.log.length - 1].text, 'ROLLBACK');
    });

    it('refuses a ledger the catalogue does not know, checksum drift, an empty ledger and an unregistered tenant', async function () {
      const unknown = await scenario();
      unknown.connection.schemas.get(NS.clock).ledger.push({ name: '0002_future', checksum: 'f'.repeat(64) });
      const refusal = await refused(operations.backup(unknown.connection, options()), 'BACKUP_LEDGER_UNKNOWN');
      assert.equal(refusal.detail, 'clock unknown 0002_future');
      const drift = await scenario();
      drift.connection.schemas.get(NS.entries).ledger[1].checksum = 'e'.repeat(64);
      assert.equal((await refused(operations.backup(drift.connection, options()), 'BACKUP_LEDGER_UNKNOWN')).detail, 'entries drift 0002_entries_insertion_order');
      const empty = await scenario();
      empty.connection.schemas.get(NS.secrets).ledger.length = 0;
      await refused(operations.backup(empty.connection, options()), 'BACKUP_LEDGER_EMPTY');
      const unregistered = await scenario();
      unregistered.connection.schemas.get(NS.access).tables.get('access_tenants').rows.pop();
      assert.equal((await refused(operations.backup(unregistered.connection, options()), 'BACKUP_TENANT_UNREGISTERED')).detail, B);
      // Without a registry the tenants section is still complete, just unattested.
      const artifact = await operations.backup(unregistered.connection, options({ registry: null }));
      assert.deepEqual(artifact.manifest.tenants.map(t => [t.tenant_id, t.registered]), [[A, null], [B, null]]);
      assert.equal(artifact.manifest.registry, null);
    });

    it('refuses a secret record whose stored value is not a key-referenced ciphertext, so plaintext never travels', async function () {
      const { connection } = await scenario();
      await connection.seed(NS.secrets, 'secret_records', [{ tenant_id: A, id: 'leak', format: 1, ciphertext: 'synthetic-plaintext' }]);
      const refusal = await refused(operations.backup(connection, options()), 'BACKUP_SECRET_FORMAT');
      assert.equal(refusal.detail, 'secrets.secret_records.leak');
    });
  });

  describe('restore', function () {
    it('restores into prepared fresh namespaces in one transaction, recreates the ACL, advances identity sequences and the independent oracle matches the source', async function () {
      const source = await scenario();
      const artifact = await operations.backup(source.connection, options());
      const target = await scenario({ namespaces: FRESH, populate: false });
      const report = await operations.restore(target.connection, artifact, { catalogues: catalogues(FRESH), acl: { role: 'ns_app' } });
      assert.equal(target.connection.statements(/^BEGIN/).length, 1);
      assert.equal(target.connection.log[target.connection.log.length - 1].text, 'COMMIT');
      assert.equal(report.total, 14); // 4 entries + 2 clocks + 2 tenants + 1 credential + 2 keys + 2 secrets + 1 audit
      assert.deepEqual(report.written, { 'entries.entries': 4, 'clock.tenant_write_clock': 2, 'access.access_tenants': 2, 'access.access_credentials': 1,
        'access.access_sessions': 0, 'access.access_keys': 2, 'secrets.secret_records': 2, 'secrets.secret_audit': 1 });
      assert.equal(report.acl, 'ns_app');
      assert.deepEqual(report.namespaces, FRESH);
      assert.deepEqual(report.oracle, { tables: 8, tenants: 2, differences: 0 });
      // Every refusal check precedes the first write.
      const firstInsert = target.connection.log.findIndex(e => /^INSERT/.test(e.text));
      const lastCount = target.connection.log.map(e => /^SELECT count/.test(e.text)).lastIndexOf(true);
      assert.ok(lastCount < firstInsert, 'emptiness checks run before any insert');
      assert.ok(target.connection.statements(/OVERRIDING SYSTEM VALUE/).length === 4, 'identity rows use OVERRIDING SYSTEM VALUE');
      assert.equal(target.connection.statements(/^SELECT setval/).length, 1);
      assert.equal(target.connection.schemas.get(FRESH.entries).tables.get('entries').next, 5);
      const grants = target.connection.statements(/^GRANT/).map(e => e.text);
      assert.ok(grants.includes('GRANT USAGE ON SCHEMA "fresh_entries" TO "ns_app"'));
      assert.ok(grants.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON "fresh_secrets"."secret_records" TO "ns_app"'));
      assert.ok(grants.includes('GRANT SELECT ON "fresh_clock"."schema_migrations" TO "ns_app"'));
      assert.equal(grants.length, 4 * 3 + 8);
      // The independent oracle: both trees read back through the same lens.
      const expected = await operations.summarize(source.connection, catalogues());
      const actual = await operations.summarize(target.connection, catalogues(FRESH));
      assert.deepEqual(operations.compareSummaries(expected, actual), []);
      assert.deepEqual(target.connection.rows(FRESH.entries, 'entries').map(r => r.insertion_ordinal).sort(), ['1', '2', '3', '4']);
      assert.deepEqual(target.connection.rows(FRESH.secrets, 'secret_records').map(r => r.ciphertext).sort(), ['vault:v1:c3ludGhldGljLWNpcGhlcnRleHQ=', 'vault:v2:Zm9yZWlnbg==']);
    });

    it('preserves profile successor ordinal gaps across restore and grants only exact writer sequence USAGE', async function () {
      const candidate = legacyInsertionCatalogue(require('../migrations/candidates/postgres-profile-socket-order-v1.json'));
      const selected = namespace => [{ kind: 'profile', namespace, catalogue: candidate, tables: ['profile'] }];
      const source = fakeConnection(), target = fakeConnection();
      await fakeMigrate(source, [])('up', { namespace: 'source_profile', catalogue: candidate });
      await fakeMigrate(target, [])('up', { namespace: 'fresh_profile', catalogue: candidate });
      const rows = [
        { ...typed(A, 'string', { _id: 'b', NSCLIENT_ID: 'same', flag: false }), insertion_ordinal: '11' },
        { ...typed(A, 'string', { _id: 'a', NSCLIENT_ID: 'same', nullable: null }), insertion_ordinal: '3' },
        { ...typed(B, 'string', { _id: 'foreign', NSCLIENT_ID: 'same', value: 0 }), insertion_ordinal: '29' }
      ];
      await source.seed('source_profile', 'profile', rows);
      const artifact = await operations.backup(source, { catalogues: selected('source_profile'), sourceCommit: COMMIT, now: NOW });
      const inputs = require('./fixtures/tenant-deployment-profile').profileInputs({ writerRole: 'profile_writer', readerRole: 'profile_reader', realtimeRole: 'realtime', legacy: true });
      await operations.restore(target, artifact, { catalogues: selected('fresh_profile'), acl: inputs.acl });
      assert.deepEqual(target.rows('fresh_profile', 'profile').sort((a, b) => Number(a.insertion_ordinal) - Number(b.insertion_ordinal)), rows.slice().sort((a, b) => Number(a.insertion_ordinal) - Number(b.insertion_ordinal)));
      assert.equal(target.schemas.get('fresh_profile').tables.get('profile').next, 30);
      assert.deepEqual(target.statements(/^GRANT .* ON SEQUENCE/).map(entry => entry.text), ['GRANT USAGE ON SEQUENCE "fresh_profile"."profile_insertion_ordinal_seq" TO "profile_writer"']);
      const restored = await operations.summarize(target, selected('fresh_profile'));
      assert.deepEqual(operations.compareSummaries(await operations.summarize(source, selected('source_profile')), restored), []);
    });

    it('restores exact outbox private clear/ACK/revision state and keeps ACK principal SELECT-only', async function () {
      const candidate = require('../lib/tenant-notifications/postgres-candidate.json');
      const inputs = require('./fixtures/tenant-deployment-notifications').notificationInputs({ tenants: [A, B], now: NOW(), outboxRole: 'outbox_writer', checkpointWriterRole: 'checkpoint_writer', ackReaderRole: 'ack_reader' });
      const selected = namespace => [{ kind: 'notification_outbox', namespace, catalogue: candidate, tables: inputs.extension.tables }];
      const source = fakeConnection(), target = fakeConnection();
      await fakeMigrate(source, [])('up', { namespace: 'source_outbox', catalogue: candidate });
      await fakeMigrate(target, [])('up', { namespace: 'fresh_outbox', catalogue: candidate });
      for (const [table, rows] of Object.entries(inputs.rows)) await source.seed('source_outbox', table, rows);
      const artifact = await operations.backup(source, { catalogues: selected('source_outbox'), sourceCommit: COMMIT, now: NOW });
      await operations.restore(target, artifact, { catalogues: selected('fresh_outbox'), acl: inputs.acl });
      for (const table of inputs.extension.tables) {
        const rows = target.rows('fresh_outbox', table);
        assert.deepEqual(rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), source.rows('source_outbox', table).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
      }
      const grants = target.statements(/^GRANT/).map(entry => entry.text);
      assert.deepEqual(grants.filter(sql => sql.endsWith('TO "ack_reader"')), [
        'GRANT USAGE ON SCHEMA "fresh_outbox" TO "ack_reader"',
        'GRANT SELECT ON "fresh_outbox"."schema_migrations" TO "ack_reader"',
        'GRANT SELECT ON "fresh_outbox"."tenant_notification_state" TO "ack_reader"'
      ]);
      assert.ok(grants.includes('GRANT SELECT, INSERT, UPDATE ("revision", "config_identity", "producer") ON "fresh_outbox"."tenant_notification_state" TO "outbox_writer"'));
      assert.deepEqual(operations.compareSummaries(await operations.summarize(source, selected('source_outbox')), await operations.summarize(target, selected('fresh_outbox'))), []);
    });

    it('restores both physical checkpoint instances without mixing their consumers, tenant rows or grants', async function () {
      const candidate = require('../migrations/candidates/postgres-consumer-checkpoint-v1.json');
      const selected = prefix => ['checkpoint', 'evaluator_checkpoint'].map(kind => ({ kind, namespace: prefix + '_' + kind, catalogue: candidate, tables: ['tenant_consumer_checkpoint'] }));
      const inputs = require('./fixtures/tenant-deployment-checkpoints').checkpointInputs({ namespaces: { checkpoint: 'source_checkpoint', evaluator_checkpoint: 'source_evaluator_checkpoint' }, tenants: [A, B],
        realtime: { namespace: 'source_checkpoint', consumer: 'realtime-joined-fixture', contractDigest: 'a'.repeat(64) },
        evaluator: { namespace: 'source_evaluator_checkpoint', consumer: 'evaluator-joined-fixture', contractDigest: 'b'.repeat(64) }, realtimeRole: 'realtime_reader', evaluatorRole: 'evaluator_reader' });
      const source = fakeConnection(), target = fakeConnection();
      for (const entry of selected('source')) {
        await fakeMigrate(source, [])('up', { namespace: entry.namespace, catalogue: candidate });
        await source.seed(entry.namespace, 'tenant_consumer_checkpoint', inputs.rows[entry.kind + '.tenant_consumer_checkpoint']);
      }
      for (const entry of selected('fresh')) await fakeMigrate(target, [])('up', { namespace: entry.namespace, catalogue: candidate });
      const artifact = await operations.backup(source, { catalogues: selected('source'), sourceCommit: COMMIT, now: NOW });
      assert.deepEqual(Object.keys(artifact.tables).sort(), ['checkpoint.tenant_consumer_checkpoint', 'evaluator_checkpoint.tenant_consumer_checkpoint']);
      await operations.restore(target, artifact, { catalogues: selected('fresh'), acl: inputs.acl });
      assert.deepEqual(operations.compareSummaries(await operations.summarize(source, selected('source')), await operations.summarize(target, selected('fresh'))), []);
      assert.ok(target.rows('fresh_checkpoint', 'tenant_consumer_checkpoint').every(row => row.consumer === 'realtime-joined-fixture'));
      assert.ok(target.rows('fresh_evaluator_checkpoint', 'tenant_consumer_checkpoint').every(row => row.consumer === 'evaluator-joined-fixture'));
      const grants = target.statements(/^GRANT/).map(entry => entry.text);
      assert.ok(grants.filter(sql => sql.includes('fresh_evaluator_checkpoint')).every(sql => sql.endsWith('TO "evaluator_reader"')));
      assert.ok(grants.filter(sql => sql.includes('"fresh_checkpoint"')).every(sql => sql.endsWith('TO "realtime_reader"')));
      target.schemas.get('fresh_evaluator_checkpoint').tables.get('tenant_consumer_checkpoint').rows.pop();
      const differences = operations.compareSummaries(await operations.summarize(source, selected('source')), await operations.summarize(target, selected('fresh')));
      assert.ok(differences.some(row => row.key === 'evaluator_checkpoint.tenant_consumer_checkpoint'), 'independent summary must expose a lost second-instance tenant');
    });

    it('control: a backup that lost one tenant from one table restores cleanly, and the independent oracle names the tenant and table', async function () {
      const source = await scenario();
      const artifact = forge(await operations.backup(source.connection, options()), (key, rows) =>
        (key === 'entries.entries' ? rows.filter(row => row.tenant_id !== B) : rows));
      assert.equal(operations.verifyArtifact(artifact) !== null, true, 'the forgery is self-consistent');
      const target = await scenario({ namespaces: FRESH, populate: false });
      const report = await operations.restore(target.connection, artifact, { catalogues: catalogues(FRESH) });
      assert.equal(report.written['entries.entries'], 3);
      const expected = await operations.summarize(source.connection, catalogues());
      const actual = await operations.summarize(target.connection, catalogues(FRESH));
      const differences = operations.compareSummaries(expected, actual);
      assert.deepEqual(differences, [
        { key: 'entries.entries', what: 'count', expected: 4, actual: 3 },
        { key: 'entries.entries', what: 'digest' },
        { key: 'entries.entries', what: 'tenant rows', tenant: B, expected: 1, actual: 0 }
      ]);
      const refusal = await refused(Promise.resolve().then(() => operations.assertSameSummary(expected, actual)), 'ORACLE_MISMATCH');
      assert.equal(refusal.differences.length, 3);
    });

    it('control: one tampered row is refused by the file digest before any transaction or write', async function () {
      const source = await scenario();
      const artifact = await operations.backup(source.connection, options());
      const text = artifact.tables['entries.entries'];
      assert.ok(text.includes('"sgv":100'));
      const tampered = { ...artifact, tables: { ...artifact.tables, 'entries.entries': text.replace('"sgv":100', '"sgv":999') } };
      const target = await scenario({ namespaces: FRESH, populate: false });
      const refusal = await refused(operations.restore(target.connection, tampered, { catalogues: catalogues(FRESH) }), 'RESTORE_DIGEST_MISMATCH');
      assert.equal(refusal.detail, 'entries.entries');
      assert.equal(target.connection.log.length, 0, 'no statement issued');
      assert.equal(target.connection.statements(/^INSERT/).length, 0);
      assert.equal(target.connection.rows(FRESH.entries, 'entries').length, 0);
      // A manifest edited to match the tampered file changes the artifact digest instead.
      const forged = JSON.parse(JSON.stringify(tampered));
      forged.manifest.catalogues[0].tables[0].digest = common.sha256(forged.tables['entries.entries']);
      assert.equal((await refused(operations.restore(target.connection, forged, { catalogues: catalogues(FRESH) }), 'RESTORE_ARTIFACT_INVALID')).detail, 'digest');
    });

    it('control: a non-empty target namespace is refused inside the transaction with no write issued and nothing changed', async function () {
      const source = await scenario();
      const artifact = await operations.backup(source.connection, options());
      const target = await scenario({ namespaces: FRESH, populate: false });
      await target.connection.seed(FRESH.clock, 'tenant_write_clock', [{ tenant_id: A, last_stamp: '7' }]);
      target.connection.log.length = 0;
      const refusal = await refused(operations.restore(target.connection, artifact, { catalogues: catalogues(FRESH) }), 'RESTORE_TARGET_NOT_EMPTY');
      assert.equal(refusal.detail, 'clock.tenant_write_clock');
      assert.equal(target.connection.statements(/^(INSERT|GRANT|SELECT setval)/).length, 0);
      assert.equal(target.connection.log[target.connection.log.length - 1].text, 'ROLLBACK');
      assert.deepEqual(target.connection.rows(FRESH.clock, 'tenant_write_clock'), [{ tenant_id: A, last_stamp: '7' }]);
      assert.equal(target.connection.rows(FRESH.entries, 'entries').length, 0);
    });

    it('control: a target ledger that is not exactly the artifact ledger is refused: unprepared, longer, or drifted', async function () {
      const source = await scenario();
      const artifact = await operations.backup(source.connection, options());
      const unprepared = await scenario({ namespaces: FRESH, populate: false });
      unprepared.connection.schemas.get(FRESH.secrets).ledger.length = 0;
      assert.equal((await refused(operations.restore(unprepared.connection, artifact, { catalogues: catalogues(FRESH) }), 'RESTORE_TARGET_UNPREPARED')).detail, 'secrets');
      assert.equal(unprepared.connection.statements(/^INSERT/).length, 0);
      const longer = await scenario({ namespaces: FRESH, populate: false });
      longer.connection.schemas.get(FRESH.clock).ledger.push({ name: '0002_future', checksum: 'f'.repeat(64) });
      assert.equal((await refused(operations.restore(longer.connection, artifact, { catalogues: catalogues(FRESH) }), 'RESTORE_LEDGER_MISMATCH')).detail, 'clock');
      assert.equal(longer.connection.statements(/^INSERT/).length, 0);
      // A target prepared with the older entries catalogue (one migration) is shorter than the artifact's ledger.
      const shorter = await scenario({ namespaces: FRESH, populate: false, overrides: { entries: OLD_ENTRIES } });
      assert.equal((await refused(operations.restore(shorter.connection, artifact, { catalogues: catalogues(FRESH) }), 'RESTORE_LEDGER_MISMATCH')).detail, 'entries');
      // The artifact itself must be a prefix of the catalogue the restore is given.
      assert.equal((await refused(operations.restore(shorter.connection, artifact, { catalogues: catalogues(FRESH, { entries: OLD_ENTRIES }) }), 'RESTORE_CATALOGUE_MISMATCH')).detail, 'entries');
      assert.equal(shorter.connection.statements(/^INSERT/).length, 0);
    });

    it('control: a column difference, a bound identity and a bad ACL role are refused before any write', async function () {
      const source = await scenario();
      const artifact = await operations.backup(source.connection, options());
      const columns = await scenario({ namespaces: FRESH, populate: false });
      columns.connection.schemas.get(FRESH.clock).tables.get('tenant_write_clock').columns.push(column('extra text'));
      assert.equal((await refused(operations.restore(columns.connection, artifact, { catalogues: catalogues(FRESH) }), 'RESTORE_COLUMNS_MISMATCH')).detail, 'clock.tenant_write_clock');
      assert.equal(columns.connection.statements(/^INSERT/).length, 0);
      const bound = await scenario({ namespaces: FRESH, populate: false, connection: fakeConnection({ identity: { rolsuper: false, rolbypassrls: false } }) });
      await refused(operations.restore(bound.connection, artifact, { catalogues: catalogues(FRESH) }), 'RESTORE_IDENTITY_BOUND');
      assert.equal(bound.connection.statements(/^INSERT/).length, 0);
      const acl = await scenario({ namespaces: FRESH, populate: false });
      await refused(operations.restore(acl.connection, artifact, { catalogues: catalogues(FRESH), acl: { role: 'ns-app; DROP' } }), 'RESTORE_ACL_ROLE_INVALID');
      assert.equal(acl.connection.statements(/^(INSERT|GRANT|SELECT setval)/).length, 0, 'invalid ACL must refuse before writes');
      assert.equal(acl.connection.log.length, 0, 'ACL syntax is checked before BEGIN');
      assert.equal(acl.connection.rows(FRESH.entries, 'entries').length, 0);
    });

    it('control: the in-transaction oracle does not trust row counts; a write that reports success without storing rolls everything back', async function () {
      const source = await scenario();
      const artifact = await operations.backup(source.connection, options());
      const lossy = await scenario({ namespaces: FRESH, populate: false, connection: fakeConnection({ lossy: '"fresh_access"."access_keys"' }) });
      const refusal = await refused(operations.restore(lossy.connection, artifact, { catalogues: catalogues(FRESH) }), 'RESTORE_ORACLE_MISMATCH');
      assert.ok(refusal.differences.some(d => d.key === 'access.access_keys' && d.what === 'count' && d.expected === 2 && d.actual === 0));
      assert.ok(refusal.differences.some(d => d.key === 'access.access_keys' && d.what === 'tenant rows' && d.tenant === A));
      assert.equal(lossy.connection.log[lossy.connection.log.length - 1].text, 'ROLLBACK');
      assert.equal(lossy.connection.rows(FRESH.entries, 'entries').length, 0, 'the rows that were stored are rolled back too');
    });

    it('an interrupted restore leaves nothing behind and a rerun completes', async function () {
      const source = await scenario();
      const artifact = await operations.backup(source.connection, options());
      const target = await scenario({ namespaces: FRESH, populate: false });
      let seen = 0;
      await assert.rejects(operations.restore(target.connection, artifact, { catalogues: catalogues(FRESH), onRow: async () => { if (++seen === 3) throw new Error('synthetic interruption'); } }),
        /synthetic interruption/);
      assert.equal(target.connection.rows(FRESH.entries, 'entries').length, 0, 'interruption must not retain inserted rows');
      assert.equal(target.connection.log[target.connection.log.length - 1].text, 'ROLLBACK');
      const report = await operations.restore(target.connection, artifact, { catalogues: catalogues(FRESH) });
      assert.equal(report.total, 14); // 4 entries + 2 clocks + 2 tenants + 1 credential + 2 keys + 2 secrets + 1 audit
      assert.deepEqual(operations.compareSummaries(await operations.summarize(source.connection, catalogues()), await operations.summarize(target.connection, catalogues(FRESH))), []);
    });
  });

  describe('explicit old/new inventory and table-scoped privileges', function () {
    const up = ['CREATE TABLE synthetic_state (tenant_id uuid NOT NULL, value text)'];
    const extension = { kind: 'synthetic', namespace: 'ns_synthetic', tables: ['synthetic_state'],
      catalogue: { version: 1, migrations: [{ name: '0001_synthetic_state', up, checksum: checksum(up) }] } };

    it('backs up only old populated inventory, upgrades a new namespace, refuses older readiness and restores old inventory', async function () {
      const state = await scenario();
      const before = await operations.summarize(state.connection, catalogues());
      const result = await operations.upgrade(state.connection, { migrate: state.migrate, catalogues: [...catalogues(), extension],
        sourceCatalogues: catalogues(), sourceCommit: COMMIT, backupSourceCommit: COMMIT, now: NOW });
      assert.equal(result.artifact.manifest.catalogues.length, 4);
      assert.equal(result.record.targetCatalogues.length, 5);
      assert.deepEqual(result.record.sourceCatalogues.map(item => item.kind), Object.keys(TABLES));
      assert.throws(() => operations.assertUpgradeCompatible(result.record, catalogues()), { code: 'OPERATIONS_BINARY_CATALOGUE_UNKNOWN' });
      await state.connection.seed(extension.namespace, 'synthetic_state', [{ tenant_id: B, value: 'after-upgrade' }]);
      const record = await operations.rollback(state.connection, { migrate: state.migrate, artifact: result.artifact,
        catalogues: catalogues(FRESH), upgraded: { ...NS, synthetic: extension.namespace }, upgradeRecord: result.record });
      assert.equal(record.refusal.catalogue, 'OPERATIONS_BINARY_CATALOGUE_UNKNOWN');
      assert.deepEqual(operations.compareSummaries(before, await operations.summarize(state.connection, catalogues(FRESH))), []);
      assert.deepEqual(state.connection.rows(extension.namespace, 'synthetic_state'), [{ tenant_id: B, value: 'after-upgrade' }]);
      assert.equal(state.connection.rows(FRESH.entries, 'entries').length, 4);
    });

    it('refuses occupied new namespaces before backup and detects row loss during an otherwise successful migration', async function () {
      const occupied = await scenario();
      occupied.connection.schemas.set(extension.namespace, { ledger: [], tables: new Map() });
      await refused(operations.upgrade(occupied.connection, { migrate: occupied.migrate, catalogues: [...catalogues(), extension], sourceCatalogues: catalogues(), sourceCommit: COMMIT }), 'UPGRADE_NEW_NAMESPACE_NOT_FRESH');
      assert.equal(occupied.connection.statements(/^BEGIN/).length, 0);
      assert.equal(occupied.calls.filter(call => call.action === 'up').length, 0);
      const lossy = await scenario();
      const migrate = async (action, input) => {
        const result = await lossy.migrate(action, input);
        if (action === 'up') {
          const table = lossy.connection.schemas.get(NS.entries).tables.get('entries');
          table.rows = table.rows.filter(row => row.tenant_id !== B);
        }
        return result;
      };
      const error = await refused(operations.upgrade(lossy.connection, { migrate, catalogues: [...catalogues(), extension], sourceCatalogues: catalogues(), sourceCommit: COMMIT }), 'UPGRADE_TARGET_VALIDATION_FAILED');
      assert.equal(error.cause.code, 'UPGRADE_PRESERVATION_MISMATCH');
      assert.ok(error.cause.differences.some(item => item.key === 'entries.entries' && item.tenant === B));
      assert.equal(error.artifact.manifest.catalogues[0].tables[0].count, 4, 'retained backup still has the lost row');
    });

    it('emits only caller-supplied table grants; invalid wildcard/escalation plans refuse before statements', async function () {
      const source = await scenario();
      const artifact = await operations.backup(source.connection, options());
      const target = await scenario({ namespaces: FRESH, populate: false });
      const acl = { grants: [
        { role: 'data_reader', kind: 'entries', table: 'entries', privileges: ['SELECT'] },
        { role: 'evaluator_reader', kind: 'clock', table: 'tenant_write_clock', privileges: ['SELECT'] },
        { role: 'session_writer', kind: 'access', table: 'access_sessions', privileges: ['SELECT'], columnPrivileges: { UPDATE: ['expires_at'] } }
      ] };
      const result = await operations.restore(target.connection, artifact, { catalogues: catalogues(FRESH), acl });
      assert.deepEqual(result.acl.roles, ['data_reader', 'evaluator_reader', 'session_writer']);
      const grants = target.connection.statements(/^GRANT/).map(entry => entry.text);
      assert.equal(grants.length, 6);
      assert.ok(grants.includes('GRANT SELECT ON "fresh_entries"."entries" TO "data_reader"'));
      assert.ok(!grants.some(sql => /ALL|secret|schema_migrations/.test(sql)));
      assert.ok(grants.includes('GRANT SELECT, UPDATE ("expires_at") ON "fresh_access"."access_sessions" TO "session_writer"'));
      assert.ok(!grants.some(sql => /UPDATE ON/.test(sql)));
      for (const grant of [
        { role: 'reader', kind: 'entries', table: '*', privileges: ['SELECT'] },
        { role: 'reader', kind: 'entries', table: 'entries', privileges: ['ALL'] },
        { role: 'reader', kind: 'entries', table: 'schema_migrations', privileges: ['UPDATE'] },
        { role: 'reader', kind: 'entries', table: 'entries', privileges: [], columnPrivileges: { DELETE: ['doc'] } }
      ]) {
        const invalid = await scenario({ namespaces: FRESH, populate: false });
        await refused(operations.restore(invalid.connection, artifact, { catalogues: catalogues(FRESH), acl: { grants: [grant] } }), 'RESTORE_ACL_PLAN_INVALID');
        assert.equal(invalid.connection.log.length, 0);
      }
    });
  });

  describe('upgrade and rollback over a two-catalogue sequence', function () {
    // Older binary: entries at 0001 only. Newer binary: 0001 + 0002 (adds the identity column).
    const older = catalogues(NS, { entries: OLD_ENTRIES });
    const newer = catalogues(NS);

    it('upgrade is status, backup, up, check; the record names the backup; no up is issued before the backup commits', async function () {
      const { connection, migrate, calls } = await scenario({ overrides: { entries: OLD_ENTRIES } });
      const before = await operations.summarize(connection, older);
      const guardedMigrate = async (action, input) => {
        if (action === 'up') assert.equal(connection.log.at(-1).text, 'COMMIT', 'backup must commit before migration');
        return migrate(action, input);
      };
      const { record, artifact } = await operations.upgrade(connection, { migrate: guardedMigrate, catalogues: newer, sourceCommit: COMMIT, registry: REGISTRY, now: NOW });
      assert.deepEqual(calls.map(c => c.action), ['status', 'status', 'status', 'status', 'up', 'check', 'check', 'check', 'check']);
      assert.deepEqual(calls.filter(c => c.action === 'up').map(c => c.namespace), [NS.entries]);
      assert.equal(record.format, 'nightscout-upgrade-record');
      assert.equal(record.backup.digest, artifact.digest);
      assert.equal(record.backup.name, operations.artifactName(artifact));
      const entries = record.catalogues.find(c => c.kind === 'entries');
      assert.deepEqual(entries.before, ['0001_entries']);
      assert.deepEqual(entries.applied, ['0002_entries_insertion_order']);
      assert.deepEqual(entries.after, ['0001_entries', '0002_entries_insertion_order']);
      assert.deepEqual(record.catalogues.find(c => c.kind === 'clock').applied, []);
      assert.deepEqual(artifact.manifest.catalogues[0].ledger.map(e => e.name), ['0001_entries']);
      assert.equal(artifact.manifest.catalogues[0].catalogueChecksum, operations.plan(newer)[0].catalogueChecksum, 'the artifact records the catalogue the upgrading binary knows');
      const commitIndex = connection.log.findIndex(e => e.text === 'COMMIT');
      assert.ok(commitIndex > 0, 'the backup committed');
      assert.deepEqual(connection.ledger(NS.entries).map(e => e.name), ['0001_entries', '0002_entries_insertion_order']);
      assert.ok(connection.rows(NS.entries, 'entries').every(r => typeof r.insertion_ordinal === 'string'));
      // After the upgrade the tree is a different shape; the pre-upgrade summary no longer matches it.
      assert.notDeepEqual(operations.compareSummaries(before, await operations.summarize(connection, newer)), []);
    });

    it('control: a failing precheck issues neither a backup nor an up; nothing pending issues no backup', async function () {
      const drifted = await scenario({ overrides: { entries: OLD_ENTRIES } });
      drifted.connection.schemas.get(NS.secrets).ledger[0].checksum = 'd'.repeat(64);
      const refusal = await refused(operations.upgrade(drifted.connection, { migrate: drifted.migrate, catalogues: newer, sourceCommit: COMMIT, now: NOW }), 'UPGRADE_PRECHECK_FAILED');
      assert.equal(refusal.kind, 'secrets');
      assert.equal(refusal.cause.code, 'MIG_DRIFT');
      assert.equal(drifted.connection.statements(/^BEGIN/).length, 0, 'no backup transaction');
      assert.equal(drifted.calls.filter(c => c.action === 'up').length, 0);
      const current = await scenario();
      await refused(operations.upgrade(current.connection, { migrate: current.migrate, catalogues: newer, sourceCommit: COMMIT, now: NOW }), 'UPGRADE_NOTHING_PENDING');
      assert.equal(current.connection.statements(/^BEGIN/).length, 0);
      assert.deepEqual(current.calls.map(c => c.action), ['status', 'status', 'status', 'status']);
    });

    it('control: a ledger that moved between precheck and backup, and an up that fails, keep the artifact and issue no further up', async function () {
      const moved = await scenario({ overrides: { entries: OLD_ENTRIES } });
      const racing = async (action, input) => {
        const result = await moved.migrate(action, input);
        if (action === 'status' && input.namespace === NS.entries) await moved.migrate('up', { namespace: NS.entries, catalogue: CANDIDATES.entries });
        return result;
      };
      await refused(operations.upgrade(moved.connection, { migrate: racing, catalogues: newer, sourceCommit: COMMIT, now: NOW }), 'UPGRADE_LEDGER_MOVED');
      assert.equal(moved.calls.filter(c => c.action === 'up').length, 1, 'only the racing up, none from the upgrade');
      const failing = await scenario({ overrides: { entries: OLD_ENTRIES } });
      const broken = async (action, input) => {
        if (action === 'up') { const error = new Error('synthetic'); error.code = 'MIG_LOCK_TIMEOUT'; throw error; }
        return failing.migrate(action, input);
      };
      const refusal = await refused(operations.upgrade(failing.connection, { migrate: broken, catalogues: newer, sourceCommit: COMMIT, now: NOW }), 'UPGRADE_FAILED');
      assert.equal(refusal.cause.code, 'MIG_LOCK_TIMEOUT');
      assert.equal(refusal.artifact.manifest.catalogues[0].ledger.length, 1, 'the pre-upgrade backup is attached');
      assert.equal(failing.calls.filter(c => c.action === 'check').length, 0, 'no postcheck after a failed up');
    });

    it('rollback: the older check refuses the upgraded namespace with MIG_UNKNOWN, the backup restores into fresh namespaces, the older check is current there, and writes after the backup are lost', async function () {
      const { connection, migrate, calls } = await scenario({ overrides: { entries: OLD_ENTRIES } });
      const before = await operations.summarize(connection, older);
      const { artifact } = await operations.upgrade(connection, { migrate, catalogues: newer, sourceCommit: COMMIT, registry: REGISTRY, now: NOW });
      await connection.seed(NS.entries, 'entries', [typed(A, 'string', { _id: 'after-backup', date: 3000, sgv: 103 })]);
      calls.length = 0;
      const record = await operations.rollback(connection, { migrate, artifact, catalogues: catalogues(FRESH, { entries: OLD_ENTRIES }), upgraded: NS, acl: { role: 'ns_app' } });
      assert.deepEqual(record.refusal, { entries: 'MIG_UNKNOWN', clock: 'current', access: 'current', secrets: 'current' });
      assert.deepEqual(calls.map(c => c.action), ['check', 'check', 'check', 'check', 'up', 'up', 'up', 'up', 'check', 'check', 'check', 'check']);
      assert.deepEqual(calls.slice(4, 8).map(c => c.namespace), Object.values(FRESH));
      assert.equal(record.restored.total, 14);
      assert.equal(record.restored.acl, 'ns_app');
      assert.deepEqual(record.after.entries, ['0001_entries']);
      assert.equal(record.backup.digest, artifact.digest);
      assert.match(record.lost, /after takenAt 1700000000000/);
      // The upgraded namespaces are untouched: the newer ledger and the post-backup row are still there.
      assert.deepEqual(connection.ledger(NS.entries).map(e => e.name), ['0001_entries', '0002_entries_insertion_order']);
      assert.equal(connection.rows(NS.entries, 'entries').length, 5);
      // The fresh namespaces reproduce the pre-upgrade tree exactly, minus the write after the backup.
      assert.deepEqual(operations.compareSummaries(before, await operations.summarize(connection, catalogues(FRESH, { entries: OLD_ENTRIES }))), []);
      assert.equal(connection.rows(FRESH.entries, 'entries').length, 4);
      assert.equal(connection.rows(FRESH.entries, 'entries').some(r => r.doc._id === 'after-backup'), false, 'the write after the backup is lost, as documented');
    });

    it('rollback validates ACL, cross-kind source aliases and empty existing schemas before preparation', async function () {
      const state = await scenario({ overrides: { entries: OLD_ENTRIES } });
      const { artifact } = await operations.upgrade(state.connection, { migrate: state.migrate, catalogues: newer, sourceCommit: COMMIT, now: NOW });
      state.calls.length = 0;
      const args = { migrate: state.migrate, artifact, catalogues: catalogues(FRESH, { entries: OLD_ENTRIES }), upgraded: NS };
      await refused(operations.rollback(state.connection, { ...args, acl: { role: 'bad-role' } }), 'RESTORE_ACL_ROLE_INVALID');
      assert.equal(state.calls.length, 0);
      await refused(operations.rollback(state.connection, { ...args, catalogues: catalogues({ ...FRESH, entries: NS.clock }, { entries: OLD_ENTRIES }) }), 'ROLLBACK_TARGET_NOT_FRESH');
      assert.equal(state.calls.length, 0);
      state.connection.schemas.set(FRESH.clock, { ledger: [], tables: new Map() });
      await refused(operations.rollback(state.connection, args), 'ROLLBACK_TARGET_NOT_FRESH');
      assert.equal(state.calls.filter(c => c.action === 'up').length, 0);
      assert.equal(state.connection.schemas.has(FRESH.entries), false);
    });

    it('control: rollback refuses when the older check finds every namespace current, when a target is not fresh, and when the artifact is not the older catalogue', async function () {
      const current = await scenario({ overrides: { entries: OLD_ENTRIES } });
      const artifact = await operations.backup(current.connection, options({ catalogues: older }));
      await refused(operations.rollback(current.connection, { migrate: current.migrate, artifact, catalogues: catalogues(FRESH, { entries: OLD_ENTRIES }), upgraded: NS }), 'ROLLBACK_NOT_NEEDED');
      assert.equal(current.calls.filter(c => c.action === 'up').length, 0);
      assert.equal(current.connection.statements(/^INSERT/).length, 0);
      const same = await scenario({ overrides: { entries: OLD_ENTRIES } });
      await operations.upgrade(same.connection, { migrate: same.migrate, catalogues: newer, sourceCommit: COMMIT, now: NOW });
      assert.equal((await refused(operations.rollback(same.connection, { migrate: same.migrate, artifact, catalogues: older, upgraded: NS }), 'ROLLBACK_TARGET_NOT_FRESH')).detail, 'entries');
      const newerArtifact = await operations.backup(same.connection, options({ catalogues: newer }));
      assert.equal((await refused(operations.rollback(same.connection, { migrate: same.migrate, artifact: newerArtifact, catalogues: catalogues(FRESH, { entries: OLD_ENTRIES }), upgraded: NS }), 'ROLLBACK_CATALOGUE_MISMATCH')).detail, 'entries');
      const occupied = await scenario({ overrides: { entries: OLD_ENTRIES } });
      await operations.upgrade(occupied.connection, { migrate: occupied.migrate, catalogues: newer, sourceCommit: COMMIT, now: NOW });
      await occupied.migrate('up', { namespace: FRESH.clock, catalogue: CANDIDATES.clock });
      occupied.calls.length = 0;
      assert.equal((await refused(operations.rollback(occupied.connection, { migrate: occupied.migrate, artifact, catalogues: catalogues(FRESH, { entries: OLD_ENTRIES }), upgraded: NS }), 'ROLLBACK_TARGET_NOT_FRESH')).detail, 'clock');
      assert.equal(occupied.connection.statements(/^INSERT/).length, 0);
      assert.equal(occupied.calls.filter(c => c.action === 'up').length, 0, 'all freshness checks must precede preparation');
      assert.equal(occupied.connection.schemas.has(FRESH.entries), false, 'earlier target must remain absent');
    });
  });
});
