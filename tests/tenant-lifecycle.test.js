'use strict';
// covers: lib/tenant-lifecycle/index.js, lib/tenant-lifecycle/artifact.js, lib/tenant-lifecycle/ceremony.js, lib/tenant-lifecycle/filesystem-artifact.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ObjectId } = require('mongodb');
const tenantScope = require('../lib/storage/tenant-scope');
const codec = require('../lib/storage/postgres-identity');
const lifecycleModule = require('../lib/tenant-lifecycle');
const trustedCapabilities = {
  authorize: async ({ tenant }) => ({ tenant, allowed: true, current: true, plane: 'operator', principal: 'synthetic_operator', consumer: 'synthetic_control' }),
  verifyDurableArtifact: async ({ tenant, artifact }) => ({ tenant, verified: true, digest: artifact.digest }),
  executionWindow: async ({ tenant }) => ({ tenant, current: true, quiesced: true })
};
const selectedCatalogues = [...lifecycleModule.admittedCatalogue(),
  { kind: 'alarm_suppression', candidate: require('../migrations/candidates/postgres-alarm-suppression-v1.json'), tables: ['tenant_alarm_suppression'], secrets: [] },
  { kind: 'notification_outbox', candidate: require('../lib/tenant-notifications/postgres-candidate.json'), tables: ['tenant_notification_heads', 'tenant_notification_requests'], secrets: [] }];
function currentAdmission ({ catalogues, namespaces }) {
  const ops = require('../lib/tenant-operations');
  const { alarmInputs } = require('./fixtures/tenant-deployment-alarm');
  const { notificationInputs } = require('./fixtures/tenant-deployment-notifications');
  const inputs = { tenants: [A, B], now: 1700000000000 };
  const full = ops.deploymentAdmission({ namespaces: { ...namespaces, lifecycle: ledgerNamespace }, extensions: [
    alarmInputs({ ...inputs, writerRole: 'alarm_writer', readerRole: 'alarm_reader' }).extension,
    notificationInputs({ ...inputs, outboxRole: 'outbox_writer', checkpointWriterRole: 'checkpoint_writer' }).extension
  ] });
  assert.deepEqual(catalogues.map(entry => [entry.kind, entry.tables]), full.lifecycle.CATALOGUE.map(entry => [entry.kind, entry.tables]));
}
trustedCapabilities.catalogues = selectedCatalogues;
trustedCapabilities.admissionCheck = currentAdmission;
const lifecycle = lifecycleModule.createLifecycle(trustedCapabilities);
const artifacts = require('../lib/tenant-lifecycle/artifact');
const ledgerCandidate = require('../lib/tenant-lifecycle/postgres-candidate.json');
const { validateCatalogue } = require('../lib/migrations/catalogue');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const HEX = '0123456789abcdef01234567';
const COMMIT = '83582e876dd193f4448f44c28e379fb5464a26c7';
const CIPHER = 'vault:v1:c3ludGhldGljLWNpcGhlcnRleHQ=';

// Column specs mirror the reviewed candidates' non-generated columns for the
// tables this test populates; unpopulated tables keep only their binding.
const COLUMNS = {
  entries: 'tenant_id uuid, doc jsonb, id_kind text',
  treatments: 'tenant_id uuid, doc jsonb, id_kind text',
  devicestatus: 'tenant_id uuid, doc jsonb, id_kind text',
  profile: 'tenant_id uuid, id_kind text, doc jsonb',
  food: 'tenant_id uuid, id_kind text, doc jsonb, insertion_ordinal bigint identity',
  activity: 'tenant_id uuid, doc jsonb, id_kind text',
  settings: 'tenant_id uuid, doc jsonb, id_kind text',
  tenant_write_clock: 'tenant_id uuid, last_stamp bigint',
  tenant_consumer_checkpoint: 'tenant_id uuid, consumer text, contract_digest text, checkpoint bigint, projection jsonb',
  tenant_authorization_config: 'tenant_id uuid, anonymous_roles text[], owner_fence boolean',
  tenant_authorization_roles: 'tenant_id uuid, name text, permissions text[], owner_fence boolean',
  tenant_authorization_subjects: 'tenant_id uuid, subject_id text, display_name text, notes text, created_at text',
  tenant_authorization_subject_roles: 'tenant_id uuid, subject_id text, role_name text',
  tenant_settings: 'tenant_id uuid, version integer, values jsonb',
  secret_records: 'tenant_id uuid, id text, format integer, ciphertext text',
  secret_audit: 'event_id uuid, tenant_id uuid, principal text, consumer text, operation text, secret_id text, phase text, event_time bigint, target_version bigint',
  tenant_lifecycle_requests: 'request_id uuid, tenant_id uuid, artifact_digest text, phase text, requested_at bigint, executed_at bigint',
  tenant_alarm_suppression: 'tenant_id uuid, alarm_group text, alarm_level integer, acked_at bigint, expires_at bigint',
  tenant_notification_heads: 'tenant_id uuid, consumer text, dedup_key text, request_id uuid, blocked_until bigint',
  tenant_notification_requests: 'tenant_id uuid, request_id uuid, consumer text, dedup_key text, origin text, config_identity text, payload jsonb, state text, created_at bigint, next_at bigint, attempt integer, attempt_token uuid, attempt_until bigint, accepted_at bigint, receipt jsonb, cleared_at bigint',
  tenant_lifecycle_ceremony: 'request_id uuid, tenant_id uuid, phase text, requested_by text, requested_consumer text, confirmed_by text, confirmed_consumer text, confirmed_at bigint, cancelled_by text, cancelled_consumer text, cancelled_at bigint, claim_id uuid, started_by text, started_consumer text, started_at bigint, executed_by text, executed_consumer text, executed_at bigint'
};
const namespaces = Object.fromEntries(lifecycle.CATALOGUE.map(entry => [entry.kind, 'ns_' + entry.kind]));
const ledgerNamespace = 'ns_lifecycle';

function columnsFor (table) {
  const spec = COLUMNS[table] || 'tenant_id uuid';
  return spec.split(',').map(part => {
    const words = part.trim().split(/\s+/);
    return { name: words[0], type: words[1], identity: words[2] === 'identity' };
  });
}

function seedRows () {
  const typed = (tenant, kind, doc) => {
    const encoded = codec.encodeDocument(kind === 'objectid' ? { ...doc, _id: new ObjectId(doc._id) } : doc);
    return { tenant_id: tenant, id_kind: encoded.id_kind, doc: encoded.doc };
  };
  return {
    entries: [
      typed(A, 'objectid', { _id: HEX, date: 1000, sgv: 100, extension: { nullable: null, ordered: [3, 1, 2] } }),
      typed(A, 'string', { _id: HEX, date: 1000, sgv: 101 }),
      typed(A, 'string', { _id: 'synthetic-a-2', date: 2000, sgv: 102, isValid: false }),
      typed(B, 'string', { _id: HEX, date: 1000, sgv: 200 })
    ],
    food: [
      { ...typed(A, 'string', { _id: 'food-a', name: 'synthetic' }), insertion_ordinal: '7' },
      { ...typed(B, 'string', { _id: 'food-b', name: 'synthetic' }), insertion_ordinal: '8' }
    ],
    tenant_write_clock: [{ tenant_id: A, last_stamp: '2000' }, { tenant_id: B, last_stamp: '1000' }],
    tenant_authorization_config: [{ tenant_id: A, anonymous_roles: ['denied'], owner_fence: false }, { tenant_id: B, anonymous_roles: ['readable'], owner_fence: false }],
    tenant_authorization_roles: [{ tenant_id: A, name: 'viewer', permissions: ['api:entries:read'], owner_fence: false }],
    tenant_authorization_subjects: [{ tenant_id: A, subject_id: 'subject-a', display_name: 'Synthetic A', notes: null, created_at: null }],
    tenant_authorization_subject_roles: [{ tenant_id: A, subject_id: 'subject-a', role_name: 'viewer' }],
    tenant_settings: [{ tenant_id: A, version: 1, values: { DISPLAY_UNITS: 'mmol' } }],
    secret_records: [
      { tenant_id: A, id: 'vendor-a', format: 1, ciphertext: CIPHER },
      { tenant_id: B, id: 'vendor-b', format: 1, ciphertext: 'vault:v1:Zm9yZWlnbg==' }
    ],
    secret_audit: [{ event_id: '33333333-3333-4333-8333-333333333333', tenant_id: A, principal: 'issuer', consumer: 'runtime',
      operation: 'encrypt', secret_id: 'vendor-a', phase: 'authorized', event_time: '5', target_version: null }]
  };
}

// An in-memory lower-port double: it honours the real tenant scope as the RLS
// binding, records every statement, and discards writes when a transaction
// throws, so rollback is observable. It is not a SQL engine.
function recordingConnection (seed = seedRows()) {
  const tables = new Map();
  const ledgers = new Map();
  const log = [];
  for (const entry of lifecycle.admittedCatalogue()) {
    ledgers.set(namespaces[entry.kind], validateCatalogue(entry.candidate).map(m => ({ name: m.name, checksum: m.checksum })));
    for (const table of entry.tables) {
      tables.set('"' + namespaces[entry.kind] + '"."' + table + '"', { columns: columnsFor(table), rows: (seed[table] || []).map(row => ({ ...row })) });
    }
  }
  ledgers.set(ledgerNamespace, ledgerCandidate.migrations.map(m => ({ name: m.name, checksum: m.checksum })));
  tables.set('"' + ledgerNamespace + '"."tenant_lifecycle_requests"', { columns: columnsFor('tenant_lifecycle_requests'), rows: [] });
  tables.set('"' + ledgerNamespace + '"."tenant_lifecycle_ceremony"', { columns: columnsFor('tenant_lifecycle_ceremony'), rows: [] });
  let active = false;
  let pending = Promise.resolve();
  const bound = () => {
    const tenant = tenantScope.requireTenant('recording query');
    if (typeof tenant !== 'string') throw new Error('unbound');
    return tenant;
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  async function query (text, values = []) {
    if (!active) throw new Error('recording connection used outside a transaction');
    const tenant = bound();
    log.push({ text: text.replace(/\s+/g, ' ').trim(), values: clone(values), tenant });
    let match;
    if (/FROM pg_attribute/.test(text)) {
      const table = tables.get(values[0]);
      return { rows: table ? table.columns.map(c => ({ ...c })) : [] };
    }
    if ((match = /FROM "([a-z0-9_]+)"\."schema_migrations"/.exec(text))) return { rows: clone(ledgers.get(match[1]) || []) };
    if ((match = /^SELECT count\(\*\)::int AS n FROM ("[a-z0-9_]+"\."[a-z0-9_]+") WHERE tenant_id = \$1$/.exec(text))) {
      return { rows: [{ n: tables.get(match[1]).rows.filter(row => row.tenant_id === tenant && row.tenant_id === values[0]).length }] };
    }
    if ((match = /^SELECT (.+) FROM ("[a-z0-9_]+"\."tenant_lifecycle_(?:requests|ceremony)") WHERE request_id = \$1 AND tenant_id = \$2 FOR UPDATE$/.exec(text))) {
      return { rows: clone(tables.get(match[2]).rows.filter(row => row.tenant_id === tenant && row.request_id === values[0] && row.tenant_id === values[1])) };
    }
    if ((match = /^SELECT (.+) FROM ("[a-z0-9_]+"\."[a-z0-9_]+") WHERE tenant_id = \$1$/.exec(text))) {
      const names = match[1].split(',').map(part => part.trim().replace(/"/g, ''));
      return { rows: tables.get(match[2]).rows.filter(row => row.tenant_id === tenant && row.tenant_id === values[0])
        .map(row => clone(Object.fromEntries(names.map(name => [name, row[name] === undefined ? null : row[name]])))) };
    }
    if ((match = /^INSERT INTO ("[a-z0-9_]+"\."[a-z0-9_]+") \((.+?)\)( OVERRIDING SYSTEM VALUE)? VALUES \((.+)\)$/.exec(text))) {
      const table = tables.get(match[1]);
      const names = match[2].split(',').map(part => part.trim().replace(/"/g, ''));
      const casts = match[4].split(',').map(part => part.trim().split('::')[1]);
      const row = Object.fromEntries(table.columns.map(c => [c.name, null]));
      names.forEach((name, index) => {
        const value = values[index];
        row[name] = (casts[index] === 'jsonb' || casts[index] === 'json') && typeof value === 'string' ? JSON.parse(value) : clone(value);
      });
      if (row.tenant_id !== tenant) { const error = new Error('new row violates row-level security policy'); error.code = '42501'; throw error; }
      if (table.columns.some(c => c.identity) && !match[3]) throw new Error('identity column requires OVERRIDING SYSTEM VALUE');
      table.rows.push(row);
      return { rowCount: 1, rows: [] };
    }
    if ((match = /^DELETE FROM ("[a-z0-9_]+"\."[a-z0-9_]+") WHERE tenant_id = \$1$/.exec(text))) {
      const table = tables.get(match[1]);
      const before = table.rows.length;
      table.rows = table.rows.filter(row => !(row.tenant_id === tenant && row.tenant_id === values[0]));
      return { rowCount: before - table.rows.length, rows: [] };
    }
    if ((match = /^UPDATE ("[a-z0-9_]+"\."tenant_lifecycle_ceremony") SET (.+) WHERE request_id = \$1 AND tenant_id = \$2 AND phase = ANY\(\$3::text\[\]\)$/.exec(text))) {
      const assignments = match[2].split(',').map(item => { const parts = /([a-z_]+) = \$(\d+)/.exec(item.trim()); return { name: parts[1], index: Number(parts[2]) - 1 }; });
      let count = 0;
      for (const row of tables.get(match[1]).rows) {
        if (row.tenant_id === tenant && row.request_id === values[0] && row.tenant_id === values[1] && values[2].includes(row.phase)) {
          for (const part of assignments) row[part.name] = clone(values[part.index]);
          count++;
        }
      }
      return { rowCount: count, rows: [] };
    }
    if ((match = /^UPDATE ("[a-z0-9_]+"\."tenant_lifecycle_requests") SET phase = \$3, executed_at = \$4 WHERE request_id = \$1 AND tenant_id = \$2$/.exec(text))) {
      let count = 0;
      for (const row of tables.get(match[1]).rows) {
        if (row.tenant_id === tenant && row.request_id === values[0] && row.tenant_id === values[1]) { row.phase = values[2]; row.executed_at = values[3]; count += 1; }
      }
      return { rowCount: count, rows: [] };
    }
    throw new Error('recording connection cannot interpret: ' + text);
  }
  async function transaction (fn, begin) {
    bound();
    const previous = pending;
    let release;
    pending = new Promise(resolve => { release = resolve; });
    await previous;
    if (active) throw new Error('nested transaction');
    const snapshot = new Map([...tables].map(([key, table]) => [key, clone(table.rows)]));
    active = true;
    log.push({ text: begin });
    try {
      const result = await fn();
      log.push({ text: 'COMMIT' });
      return result;
    } catch (error) {
      for (const [key, rows] of snapshot) tables.get(key).rows = rows;
      log.push({ text: 'ROLLBACK' });
      throw error;
    } finally { active = false; release(); }
  }
  return {
    log,
    rows: (ns, table, tenant) => clone(tables.get('"' + ns + '"."' + table + '"').rows.filter(row => tenant === undefined || row.tenant_id === tenant)),
    ledgers,
    query,
    transaction: fn => transaction(fn, 'BEGIN'),
    snapshotTransaction: fn => transaction(fn, 'BEGIN ISOLATION LEVEL REPEATABLE READ'),
    withTenant: (tenant, fn) => tenantScope.withTenant(tenant, () => transaction(fn, 'BEGIN'))
  };
}

const sorted = rows => rows.map(artifacts.canonical).sort();
const totalRows = (connection, tenant) => lifecycle.CATALOGUE.reduce((sum, entry) =>
  sum + entry.tables.reduce((inner, table) => inner + connection.rows(namespaces[entry.kind], table, tenant).length, 0), 0);
const options = extra => ({ tenant: A, namespaces, sourceCommit: COMMIT, now: () => 1700000000000, ...extra });

describe('tenant lifecycle: typed export, import and two-phase deletion', function () {
  let previousMode;
  before(function () { previousMode = tenantScope.getTenancyMode(); tenantScope.setTenancyMode('multi'); });
  after(function () { tenantScope.setTenancyMode(previousMode); });

  it('includes the accepted owner configuration authority in tenant lifecycle operations', function () {
    const expected = require('../lib/tenant-settings/owner-authority-candidate.json');
    const entry = lifecycle.admittedCatalogue().find(item => item.kind === 'owner_configuration');
    assert.ok(entry, 'accepted owner authority must not be omitted');
    assert.deepEqual(entry.candidate, expected);
    assert.deepEqual(entry.tables, ['tenant_owner_configuration_authority']);
  });

  it('admits every tenant-bound table the reviewed candidates create, parents before children', function () {
    const created = new Set();
    for (const entry of lifecycle.admittedCatalogue()) {
      validateCatalogue(entry.candidate);
      for (const migration of entry.candidate.migrations) {
        for (const sql of migration.up) {
          const match = /^\s*CREATE TABLE ([a-z_]+)\s*\(/i.exec(sql);
          if (match) created.add(match[1]);
        }
      }
      const listed = new Set(entry.tables);
      for (const table of entry.tables) assert.ok(created.has(table), entry.kind + ' lists a table its candidate does not create: ' + table);
      for (const migration of entry.candidate.migrations) {
        for (const sql of migration.up) {
          const match = /^\s*CREATE TABLE ([a-z_]+)\s*\(([\s\S]*)\)\s*$/i.exec(sql);
          if (!match) continue;
          assert.ok(listed.has(match[1]), entry.kind + ' omits a tenant-bound table: ' + match[1]);
          const references = [...match[2].matchAll(/REFERENCES ([a-z_]+)/g)].map(m => m[1]);
          for (const parent of references) {
            assert.ok(entry.tables.indexOf(parent) < entry.tables.indexOf(match[1]), match[1] + ' must follow its parent ' + parent);
          }
        }
      }
    }
    assert.equal(created.size, lifecycle.CATALOGUE.reduce((n, entry) => n + entry.tables.length, 0));
    validateCatalogue(ledgerCandidate);
    assert.equal(ledgerCandidate.migrations[0].name, '0001_tenant_lifecycle_requests');
  });

  it('exports every admitted table under the tenant binding in one snapshot, with typed kinds and key references', async function () {
    const source = recordingConnection();
    const artifact = await lifecycle.exportTenant(source, options());
    assert.equal(source.log.filter(e => e.text.startsWith('BEGIN')).length, 1);
    assert.equal(source.log[0].text, 'BEGIN ISOLATION LEVEL REPEATABLE READ');
    assert.ok(source.log.every(e => e.tenant === undefined || e.tenant === A));
    assert.equal(artifact.manifest.tenant, A);
    assert.equal(artifact.manifest.sourceCommit, COMMIT);
    assert.equal(artifact.manifest.catalogues.length, lifecycle.CATALOGUE.length);
    const entries = artifact.tables['entries.entries'];
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.filter(row => row.doc._id === HEX).map(row => row.id_kind).sort(), ['objectid', 'string']);
    const decoded = entries.filter(row => row.doc._id === HEX).map(codec.decodeDocument);
    assert.equal(decoded.filter(doc => doc._id instanceof ObjectId).length, 1);
    assert.equal(decoded.filter(doc => typeof doc._id === 'string').length, 1);
    assert.ok(entries.every(row => row.tenant_id === A));
    const secrets = artifact.manifest.catalogues.find(c => c.kind === 'secrets').tables.find(t => t.table === 'secret_records');
    assert.deepEqual(secrets.keyReferences, [{ id: 'vendor-a', keyReference: { scheme: 'vault-transit', keyVersion: 1 } }]);
    assert.deepEqual(artifact.tables['secrets.secret_records'], [{ tenant_id: A, id: 'vendor-a', format: 1, ciphertext: CIPHER }]);
    assert.equal(JSON.stringify(artifact).includes('"plaintext"'), false);
    assert.equal(artifact.digest.length, 64);
    const permuted = JSON.parse(JSON.stringify(artifact));
    permuted.manifest = Object.fromEntries(Object.entries(permuted.manifest).reverse());
    assert.equal(artifacts.manifestDigest(permuted.manifest), artifact.digest);
    assert.ok(artifacts.validateArtifact(artifact));
  });

  it('imports into an empty target in one transaction and the rows read back identical', async function () {
    const source = recordingConnection();
    const artifact = await lifecycle.exportTenant(source, options());
    const target = recordingConnection({});
    const seen = [];
    const result = await lifecycle.importArtifact(target, artifact, { tenant: A, namespaces, onRow: event => { seen.push(event.total); } });
    assert.equal(result.total, totalRows(source, A));
    assert.deepEqual(seen, seen.map((_, i) => i + 1));
    assert.equal(target.log.filter(e => e.text.startsWith('BEGIN')).length, 1);
    assert.equal(target.log.at(-1).text, 'COMMIT');
    for (const entry of lifecycle.CATALOGUE) {
      for (const table of entry.tables) {
        assert.deepEqual(sorted(target.rows(namespaces[entry.kind], table, A)), sorted(source.rows(namespaces[entry.kind], table, A)), entry.kind + '.' + table);
      }
    }
    const food = target.log.find(e => e.text.startsWith('INSERT INTO "ns_food"."food"'));
    assert.match(food.text, / OVERRIDING SYSTEM VALUE VALUES \(\$1::uuid, \$2::text, \$3::jsonb, \$4::bigint\)$/);
    assert.equal(typeof food.values[2], 'string');
    assert.equal(target.rows(namespaces.food, 'food', A)[0].insertion_ordinal, '7');
    assert.equal(totalRows(target, B), 0);
  });

  it('refuses before any write: tenant, row tenant, ledger, columns, key reference, non-empty target, missing catalogue', async function () {
    const source = recordingConnection();
    const artifact = await lifecycle.exportTenant(source, options());
    const writes = connection => connection.log.filter(e => /^(INSERT|DELETE|UPDATE)/.test(e.text)).length;
    let target = recordingConnection({});
    await assert.rejects(lifecycle.importArtifact(target, artifact, { tenant: B, namespaces }), { code: 'LIFECYCLE_TENANT_MISMATCH' });
    assert.equal(writes(target), 0);

    const rebuilt = mutate => {
      const copy = JSON.parse(JSON.stringify(artifact));
      const catalogues = copy.manifest.catalogues.map(c => ({ ...c, tables: c.tables.map(t => ({ ...t, rows: copy.tables[c.kind + '.' + t.table], secrets: t.keyReferences !== undefined, keyReferences: t.keyReferences })) }));
      mutate(catalogues);
      return artifacts.buildArtifact({ tenant: A, sourceCommit: COMMIT, exportedAt: 1, catalogues });
    };
    assert.throws(() => rebuilt(c => { c.find(x => x.kind === 'entries').tables[0].rows[0].tenant_id = B; }), { code: 'LIFECYCLE_ROW_TENANT_MISMATCH' });
    assert.throws(() => rebuilt(c => {
      const t = c.find(x => x.kind === 'secrets').tables.find(x => x.table === 'secret_records');
      t.rows = [];
    }), { code: 'LIFECYCLE_KEY_REFERENCE_WITHOUT_CIPHERTEXT' });
    assert.throws(() => rebuilt(c => {
      const t = c.find(x => x.kind === 'secrets').tables.find(x => x.table === 'secret_records');
      t.rows[0].ciphertext = 'plain-text-not-allowed';
      t.keyReferences = undefined;
    }), { code: 'LIFECYCLE_CIPHERTEXT_FORMAT' });

    const tampered = JSON.parse(JSON.stringify(artifact));
    tampered.tables['entries.entries'].pop();
    await assert.rejects(lifecycle.importArtifact(recordingConnection({}), tampered, { tenant: A, namespaces }), { code: 'LIFECYCLE_ARTIFACT_COUNT' });
    tampered.manifest.exportedAt += 1;
    await assert.rejects(lifecycle.importArtifact(recordingConnection({}), tampered, { tenant: A, namespaces }), { code: 'LIFECYCLE_ARTIFACT_DIGEST' });

    const stale = rebuilt(c => { c.find(x => x.kind === 'entries').ledger[0].checksum = 'f'.repeat(64); });
    target = recordingConnection({});
    await assert.rejects(lifecycle.importArtifact(target, stale, { tenant: A, namespaces }), { code: 'LIFECYCLE_LEDGER_MISMATCH', detail: 'entries' });
    assert.equal(writes(target), 0);

    assert.throws(() => rebuilt(c => { delete c.find(x => x.kind === 'entries').tables[0].rows[0].id_kind; }), { code: 'LIFECYCLE_ARTIFACT_COLUMN', detail: 'entries.entries.id_kind' });
    const narrowed = rebuilt(c => { c.find(x => x.kind === 'entries').tables[0].columns.pop(); });
    await assert.rejects(lifecycle.importArtifact(recordingConnection({}), narrowed, { tenant: A, namespaces }), { code: 'LIFECYCLE_COLUMNS_MISMATCH', detail: 'entries.entries' });
    const retyped = rebuilt(c => { c.find(x => x.kind === 'entries').tables[0].columns[1].type = 'text'; });
    await assert.rejects(lifecycle.importArtifact(recordingConnection({}), retyped, { tenant: A, namespaces }), { code: 'LIFECYCLE_COLUMNS_MISMATCH', detail: 'entries.entries' });

    const missing = rebuilt(c => { c.splice(c.findIndex(x => x.kind === 'food'), 1); });
    target = recordingConnection({});
    await assert.rejects(lifecycle.importArtifact(target, missing, { tenant: A, namespaces }), { code: 'LIFECYCLE_CATALOGUE_INCOMPLETE', detail: 'food' });
    assert.equal(writes(target), 0);

    await assert.rejects(lifecycle.importArtifact(source, artifact, { tenant: A, namespaces }), { code: 'LIFECYCLE_TARGET_NOT_EMPTY', detail: 'entries.entries' });
    await assert.rejects(lifecycle.importArtifact(recordingConnection({}), artifact, { tenant: A, namespaces: { ...namespaces, food: undefined } }), { code: 'LIFECYCLE_CATALOGUE_UNMAPPED', detail: 'food' });
  });

  it('rolls back an interrupted import completely and a rerun completes', async function () {
    const source = recordingConnection();
    const artifact = await lifecycle.exportTenant(source, options());
    const target = recordingConnection({});
    let partial;
    await assert.rejects(lifecycle.importArtifact(target, artifact, { tenant: A, namespaces, onRow: event => {
      if (event.total === 3) { partial = totalRows(target, A); throw new Error('synthetic-interruption'); }
    } }), /synthetic-interruption/);
    assert.equal(partial, 3, 'three rows were visible inside the transaction before the throw');
    assert.equal(target.log.at(-1).text, 'ROLLBACK');
    assert.equal(totalRows(target, A), 0);
    const rerun = await lifecycle.importArtifact(target, artifact, { tenant: A, namespaces });
    assert.equal(rerun.total, totalRows(source, A));
    assert.equal(totalRows(target, A), rerun.total);
  });

  it('deletes in two phases: request, verified execute, foreign tenant untouched, re-import restores byte-for-byte', async function () {
    const connection = recordingConnection();
    const artifact = await lifecycle.exportTenant(connection, options());
    const before = { a: totalRows(connection, A), b: totalRows(connection, B) };
    const foreign = lifecycle.CATALOGUE.map(entry => entry.tables.map(table => sorted(connection.rows(namespaces[entry.kind], table, B))));
    assert.ok(before.a > 0 && before.b > 0);

    const request = await lifecycle.requestDeletion(connection, { tenant: A, ledgerNamespace, artifact, now: () => 5 });
    assert.deepEqual(connection.rows(ledgerNamespace, 'tenant_lifecycle_requests'), [{ request_id: request.requestId, tenant_id: A, artifact_digest: artifact.digest, phase: 'requested', requested_at: 5, executed_at: null }]);
    assert.equal(totalRows(connection, A), before.a, 'the request phase deletes nothing');

    await assert.rejects(lifecycle.executeDeletion(connection, { tenant: A, namespaces, ledgerNamespace, artifact, requestId: '99999999-9999-4999-8999-999999999999' }), { code: 'LIFECYCLE_REQUEST_MISSING' });
    const other = await lifecycle.exportTenant(connection, options({ now: () => 1700000000001 }));
    await assert.rejects(lifecycle.executeDeletion(connection, { tenant: A, namespaces, ledgerNamespace, artifact: other, requestId: request.requestId }), { code: 'LIFECYCLE_REQUEST_DIGEST_MISMATCH' });
    assert.equal(totalRows(connection, A), before.a);

    await lifecycle.confirmDeletion(connection, { tenant: A, ledgerNamespace, artifact, requestId: request.requestId, now: () => 6 });
    const order = [];
    await assert.rejects(lifecycle.executeDeletion(connection, { tenant: A, namespaces, ledgerNamespace, artifact, requestId: request.requestId, now: () => 7, onRow: event => {
      order.push(event.key);
      if (event.total >= 2) throw new Error('synthetic-delete-interruption');
    } }), /synthetic-delete-interruption/);
    assert.equal(connection.log.at(-1).text, 'ROLLBACK');
    assert.equal(totalRows(connection, A), before.a, 'interrupted deletion removed nothing durable');
    const started = connection.rows(ledgerNamespace, 'tenant_lifecycle_ceremony')[0];
    assert.equal(started.phase, 'executing', 'destructive rollback cannot reopen cancellation');
    assert.equal(started.started_at, 7);
    await assert.rejects(lifecycle.cancelDeletion(connection, { tenant: A, ledgerNamespace, requestId: request.requestId }), { code: 'LIFECYCLE_EXECUTION_STARTED' });
    assert.equal(order[0], 'notification_outbox.tenant_notification_requests', 'deletion walks the catalogue in reverse');

    const executed = await lifecycle.executeDeletion(connection, { tenant: A, namespaces, ledgerNamespace, artifact, requestId: request.requestId, now: () => 9 });
    assert.equal(executed.total, before.a);
    assert.equal(totalRows(connection, A), 0);
    assert.equal(totalRows(connection, B), before.b);
    assert.deepEqual(lifecycle.CATALOGUE.map(entry => entry.tables.map(table => sorted(connection.rows(namespaces[entry.kind], table, B)))), foreign);
    assert.equal(connection.rows(ledgerNamespace, 'tenant_lifecycle_requests')[0].phase, 'executed');
    assert.equal(connection.log.filter(e => e.text === 'BEGIN').at(-1) !== undefined, true);
    await assert.rejects(lifecycle.executeDeletion(connection, { tenant: A, namespaces, ledgerNamespace, artifact, requestId: request.requestId }), { code: 'LIFECYCLE_REQUEST_ALREADY_EXECUTED' });

    const restored = await lifecycle.importArtifact(connection, artifact, { tenant: A, namespaces });
    assert.equal(restored.total, before.a);
    const again = await lifecycle.exportTenant(connection, options());
    assert.deepEqual(again.tables, artifact.tables);
    assert.equal(again.tables['secrets.secret_records'][0].ciphertext, CIPHER);
    assert.equal(again.digest, artifact.digest);
  });

  it('requires operator confirmation, current authority and durable/quiescent capabilities before deletion', async function () {
    const connection = recordingConnection();
    const artifact = await lifecycle.exportTenant(connection, options());
    const args = { tenant: A, namespaces, ledgerNamespace, artifact };
    const request = await lifecycle.requestDeletion(connection, { ...args, now: () => 1 });
    const input = { ...args, requestId: request.requestId, now: () => 2 };
    const before = totalRows(connection, A);
    await assert.rejects(lifecycle.executeDeletion(connection, input), { code: 'LIFECYCLE_CONFIRMATION_REQUIRED' });
    const owner = lifecycleModule.createLifecycle({ ...trustedCapabilities,
      authorize: async ({ tenant }) => ({ tenant, allowed: true, current: true, plane: 'owner', principal: 'synthetic_owner', consumer: 'owner_client' }) });
    await assert.rejects(owner.confirmDeletion(connection, input), { code: 'LIFECYCLE_OPERATOR_REQUIRED' });
    await lifecycle.confirmDeletion(connection, input);
    await assert.rejects(owner.executeDeletion(connection, input), { code: 'LIFECYCLE_OPERATOR_REQUIRED' });
    const revoked = lifecycleModule.createLifecycle({ ...trustedCapabilities,
      authorize: async ({ tenant }) => ({ tenant, allowed: true, current: false, plane: 'operator', principal: 'revoked_operator', consumer: 'control' }) });
    await assert.rejects(revoked.executeDeletion(connection, input), { code: 'LIFECYCLE_AUTHORITY_REFUSED' });
    const memoryOnly = lifecycleModule.createLifecycle({ ...trustedCapabilities, verifyDurableArtifact: null });
    await assert.rejects(memoryOnly.executeDeletion(connection, input), { code: 'LIFECYCLE_DURABLE_ARTIFACT_REQUIRED' });
    const noWindow = lifecycleModule.createLifecycle({ ...trustedCapabilities, executionWindow: null });
    await assert.rejects(noWindow.executeDeletion(connection, input), { code: 'LIFECYCLE_EXECUTION_WINDOW_REQUIRED' });
    const incomplete = lifecycleModule.createLifecycle({ ...trustedCapabilities, admissionCheck: null });
    await assert.rejects(incomplete.executeDeletion(connection, input), { code: 'LIFECYCLE_FULL_ADMISSION_REQUIRED' });
    assert.equal(totalRows(connection, A), before);
    assert.equal(connection.log.filter(entry => /^DELETE/.test(entry.text)).length, 0);
  });

  it('cancellation is final and cancel-versus-start has exactly one winner in either ordering', async function () {
    for (const cancelFirst of [true, false]) {
      const connection = recordingConnection();
      const artifact = await lifecycle.exportTenant(connection, options());
      const request = await lifecycle.requestDeletion(connection, { tenant: A, ledgerNamespace, artifact, now: () => 1 });
      const args = { tenant: A, namespaces, ledgerNamespace, artifact, requestId: request.requestId, now: () => 3 };
      await lifecycle.confirmDeletion(connection, { ...args, now: () => 2 });
      const before = totalRows(connection, A);
      const first = cancelFirst ? lifecycle.cancelDeletion(connection, args) : lifecycle.claimDeletion(connection, args);
      const second = cancelFirst ? lifecycle.claimDeletion(connection, args) : lifecycle.cancelDeletion(connection, args);
      const results = await Promise.allSettled([first, second]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, 'cancel and execution claim cannot both win');
      assert.equal(results.filter(result => result.status === 'rejected').length, 1);
      const state = connection.rows(ledgerNamespace, 'tenant_lifecycle_ceremony')[0];
      assert.equal(state.phase, cancelFirst ? 'cancelled' : 'executing');
      assert.equal(totalRows(connection, A), before, 'claim and cancellation never delete rows');
      if (cancelFirst) await assert.rejects(lifecycle.executeDeletion(connection, args), { code: 'LIFECYCLE_REQUEST_CANCELLED' });
      else await assert.rejects(lifecycle.cancelDeletion(connection, args), { code: 'LIFECYCLE_EXECUTION_STARTED' });
    }
  });

  it('rechecks execution authority after a durable start and keeps the same claim on denied retry', async function () {
    const connection = recordingConnection();
    const artifact = await lifecycle.exportTenant(connection, options());
    const request = await lifecycle.requestDeletion(connection, { tenant: A, ledgerNamespace, artifact, now: () => 1 });
    const args = { tenant: A, namespaces, ledgerNamespace, artifact, requestId: request.requestId, now: () => 3 };
    await lifecycle.confirmDeletion(connection, { ...args, now: () => 2 });
    const claim = await lifecycle.claimDeletion(connection, args);
    const before = totalRows(connection, A);
    const changed = lifecycleModule.createLifecycle({ ...trustedCapabilities, authorize: async ({ tenant, action }) => ({
      tenant, allowed: action !== 'execute', current: true, plane: 'operator', principal: 'operator', consumer: 'control'
    }) });
    await assert.rejects(changed.executeDeletion(connection, { ...args, claimId: claim.claimId }), { code: 'LIFECYCLE_AUTHORITY_REFUSED' });
    assert.equal(totalRows(connection, A), before);
    const state = connection.rows(ledgerNamespace, 'tenant_lifecycle_ceremony')[0];
    assert.equal(state.phase, 'executing'); assert.equal(state.claim_id, claim.claimId);
    const result = await lifecycle.executeDeletion(connection, { ...args, claimId: claim.claimId, now: () => 4 });
    assert.equal(result.claimId, claim.claimId); assert.equal(totalRows(connection, A), 0);
  });

  it('old pending requests require explicit confirmation and old ledgers refuse before ceremony writes', async function () {
    const connection = recordingConnection();
    const artifact = await lifecycle.exportTenant(connection, options());
    const requestId = '99999999-9999-4999-8999-999999999999';
    await connection.withTenant(A, () => connection.query('INSERT INTO "ns_lifecycle"."tenant_lifecycle_requests" (request_id, tenant_id, artifact_digest, phase, requested_at) VALUES ($1, $2, $3, $4, $5)', [requestId, A, artifact.digest, 'requested', 1]));
    const args = { tenant: A, namespaces, ledgerNamespace, artifact, requestId, now: () => 2 };
    await assert.rejects(lifecycle.executeDeletion(connection, args), { code: 'LIFECYCLE_CONFIRMATION_REQUIRED' });
    assert.equal(connection.rows(ledgerNamespace, 'tenant_lifecycle_ceremony').length, 0, 'failed legacy claim rolls back lazy initialization');
    await lifecycle.confirmDeletion(connection, args);
    assert.equal(connection.rows(ledgerNamespace, 'tenant_lifecycle_ceremony')[0].phase, 'confirmed');
    const old = recordingConnection(); old.ledgers.set(ledgerNamespace, ledgerCandidate.migrations.slice(0, 1));
    await assert.rejects(lifecycle.requestDeletion(old, { tenant: A, ledgerNamespace, artifact }), { code: 'LIFECYCLE_CEREMONY_SCHEMA_REQUIRED' });
    assert.equal(old.rows(ledgerNamespace, 'tenant_lifecycle_requests').length, 0);
  });

  it('refuses late source changes after the durable claim without reopening cancellation', async function () {
    const connection = recordingConnection();
    const artifact = await lifecycle.exportTenant(connection, options());
    const request = await lifecycle.requestDeletion(connection, { tenant: A, ledgerNamespace, artifact, now: () => 1 });
    const args = { tenant: A, namespaces, ledgerNamespace, artifact, requestId: request.requestId, now: () => 3 };
    await lifecycle.confirmDeletion(connection, { ...args, now: () => 2 });
    const claim = await lifecycle.claimDeletion(connection, args);
    await connection.withTenant(A, () => connection.query('INSERT INTO "ns_entries"."entries" ("tenant_id", "doc", "id_kind") VALUES ($1::uuid, $2::jsonb, $3::text)',
      [A, JSON.stringify({ _id: 'after-claim', date: 3000 }), 'string']));
    const before = totalRows(connection, A);
    await assert.rejects(lifecycle.executeDeletion(connection, { ...args, claimId: claim.claimId, now: () => 4 }), { code: 'LIFECYCLE_ARTIFACT_STALE', detail: 'entries.entries' });
    assert.equal(totalRows(connection, A), before);
    assert.equal(connection.rows(ledgerNamespace, 'tenant_lifecycle_ceremony')[0].phase, 'executing');
    await assert.rejects(lifecycle.cancelDeletion(connection, args), { code: 'LIFECYCLE_EXECUTION_STARTED' });
    assert.equal(connection.log.filter(entry => /^DELETE/.test(entry.text)).length, 0);
  });

  it('permits confirmation and execution at the request instant with no mandatory waiting timer', async function () {
    const connection = recordingConnection();
    const artifact = await lifecycle.exportTenant(connection, options({ now: () => 1000 }));
    const request = await lifecycle.requestDeletion(connection, { tenant: A, ledgerNamespace, artifact, now: () => 1000 });
    const args = { tenant: A, namespaces, ledgerNamespace, artifact, requestId: request.requestId, now: () => 1000 };
    await lifecycle.confirmDeletion(connection, args);
    await lifecycle.executeDeletion(connection, args);
    const state = connection.rows(ledgerNamespace, 'tenant_lifecycle_ceremony')[0];
    assert.equal(state.confirmed_at, 1000); assert.equal(state.started_at, 1000); assert.equal(state.executed_at, 1000);
  });

  it('tenant artifact persistence refuses missing file fsync and restores verified publication', async function () {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tenant-artifact-sync-'));
    try {
      const artifact = await lifecycle.exportTenant(recordingConnection(), options());
      const events = [];
      const io = fail => ({ ...fs.promises,
        open: async (...args) => {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- Owned private artifact instrumentation.
          const handle = await fs.promises.open(...args);
          return { writeFile: (...values) => handle.writeFile(...values), readFile: (...values) => handle.readFile(...values), stat: () => handle.stat(),
            sync: async () => { events.push(['sync', args[0]]); if (fail && args[0].endsWith('artifact.json')) throw new Error('synthetic tenant artifact fsync failure'); await handle.sync(); }, close: () => handle.close() };
        },
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Exact owned staging/publication paths.
        rename: async (...args) => { events.push(['rename']); return fs.promises.rename(...args); }
      });
      await assert.rejects(lifecycleModule.saveTenantArtifact(artifact, { directory, io: io(true) }), { code: 'LIFECYCLE_ARTIFACT_DURABILITY_FAILED' });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Owned temporary directory only.
      assert.deepEqual(await fs.promises.readdir(directory), []);
      events.length = 0;
      assert.deepEqual(await lifecycleModule.saveTenantArtifact(artifact, { directory, io: io(false) }), artifact);
      const renamed = events.findIndex(event => event[0] === 'rename');
      assert.ok(events.slice(0, renamed).some(event => event[0] === 'sync' && event[1].endsWith('artifact.json')));
      assert.ok(events.slice(renamed + 1).some(event => event[0] === 'sync' && event[1] === directory));
    } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
  });

  it('filesystem evidence is reloaded before confirmation and a corrupt retained artifact blocks destructive admission', async function () {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tenant-ceremony-artifact-'));
    try {
      const connection = recordingConnection();
      const artifact = await lifecycle.exportTenant(connection, options());
      await lifecycleModule.saveTenantArtifact(artifact, { directory });
      const durable = lifecycleModule.createLifecycle({ ...trustedCapabilities, verifyDurableArtifact: lifecycleModule.createFilesystemArtifactVerifier({ directory }) });
      const request = await durable.requestDeletion(connection, { tenant: A, ledgerNamespace, artifact, now: () => 1 });
      const args = { tenant: A, namespaces, ledgerNamespace, artifact, requestId: request.requestId, now: () => 2 };
      await durable.confirmDeletion(connection, args);
      const file = path.join(directory, 'tenant-artifact-' + artifact.digest, 'artifact.json');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Owned temporary recovery artifact.
      const text = await fs.promises.readFile(file, 'utf8');
      assert.ok(text.includes('"sgv":100'));
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Corrupt only the owned temporary artifact control.
      await fs.promises.writeFile(file, text.replace('"sgv":100', '"sgv":999'));
      const before = totalRows(connection, A);
      await assert.rejects(durable.executeDeletion(connection, { ...args, now: () => 3 }), { code: 'LIFECYCLE_ARTIFACT_TABLE_DIGEST' });
      assert.equal(totalRows(connection, A), before);
      assert.equal(connection.rows(ledgerNamespace, 'tenant_lifecycle_ceremony')[0].phase, 'confirmed');
      assert.equal(connection.log.filter(entry => /^DELETE/.test(entry.text)).length, 0);
    } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
  });

  it('refuses to execute against rows that changed after the export, and unverified key material', async function () {
    const connection = recordingConnection();
    const artifact = await lifecycle.exportTenant(connection, options());
    const request = await lifecycle.requestDeletion(connection, { tenant: A, ledgerNamespace, artifact });
    await lifecycle.confirmDeletion(connection, { tenant: A, ledgerNamespace, artifact, requestId: request.requestId });
    const count = totalRows(connection, A);
    await connection.withTenant(A, () => connection.query('INSERT INTO "ns_entries"."entries" ("tenant_id", "doc", "id_kind") VALUES ($1::uuid, $2::jsonb, $3::text)',
      [A, JSON.stringify({ _id: 'late-row', date: 3000 }), 'string']));
    await assert.rejects(lifecycle.executeDeletion(connection, { tenant: A, namespaces, ledgerNamespace, artifact, requestId: request.requestId }), { code: 'LIFECYCLE_ARTIFACT_STALE', detail: 'entries.entries' });
    assert.equal(totalRows(connection, A), count + 1);

    const secretsOnly = recordingConnection();
    const exported = await lifecycle.exportTenant(secretsOnly, options());
    const dropped = JSON.parse(JSON.stringify(exported));
    const secrets = dropped.manifest.catalogues.find(c => c.kind === 'secrets').tables.find(t => t.table === 'secret_records');
    secrets.keyReferences = [];
    assert.throws(() => artifacts.validateArtifact(dropped), { code: 'LIFECYCLE_ARTIFACT_DIGEST' });
    dropped.digest = artifacts.manifestDigest(dropped.manifest);
    assert.throws(() => artifacts.validateArtifact(dropped), { code: 'LIFECYCLE_CIPHERTEXT_WITHOUT_KEY_REFERENCE' });
  });
});
