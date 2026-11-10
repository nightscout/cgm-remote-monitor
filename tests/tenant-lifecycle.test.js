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
const { legacyInsertionEntry } = require('./fixtures/legacy-insertion-catalogue');
const trustedCapabilities = {
  authorize: async ({ tenant }) => ({ tenant, allowed: true, current: true, plane: 'operator', principal: 'synthetic_operator', consumer: 'synthetic_control' }),
  verifyDurableArtifact: async ({ tenant, artifact }) => ({ tenant, verified: true, digest: artifact.digest }),
  executionWindow: async ({ tenant }) => ({ tenant, current: true, quiesced: true }),
  // Trusted provisioning's per-tenant key names (synthetic; no key material).
  keyInventory: async ({ tenant }) => [{ mount: 'transit', name: 'tenant-' + tenant.slice(0, 8) + '-data' }, { mount: 'transit', name: 'tenant-' + tenant.slice(0, 8) + '-signing' }]
};
const selectedCatalogues = [...lifecycleModule.admittedCatalogue().map(legacyInsertionEntry),
  { kind: 'alarm_suppression', candidate: require('../migrations/candidates/postgres-alarm-suppression-v1.json'), tables: ['tenant_alarm_suppression'], secrets: [] },
  { kind: 'notification_outbox', candidate: require('../lib/tenant-notifications/postgres-candidate.json'), tables: ['tenant_notification_heads', 'tenant_notification_requests', 'tenant_notification_state'], secrets: [] }];
function currentAdmission ({ catalogues, namespaces }) {
  // This recording double intentionally models the immutable legacy schema.
  // The current deployment census and native counter/maintenance oracle are
  // independently exercised; old identity-refusal vectors remain meaningful.
  assert.deepEqual(catalogues.map(entry => [entry.kind, entry.tables, entry.candidate]), selectedCatalogues.map(entry => [entry.kind, entry.tables, entry.candidate]));
  assert.ok(catalogues.every(entry => typeof namespaces[entry.kind] === 'string'));
}
trustedCapabilities.catalogues = selectedCatalogues;
trustedCapabilities.admissionCheck = currentAdmission;
const lifecycle = lifecycleModule.createLifecycle(trustedCapabilities);
const artifacts = require('../lib/tenant-lifecycle/artifact');
const ledgerCandidate = require('../lib/tenant-lifecycle/postgres-candidate.json');
const { validateCatalogue } = require('../lib/migrations/catalogue');
const { LEDGER_TABLES } = require('../lib/tenant-lifecycle/key-retention');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const HEX = '0123456789abcdef01234567';
const COMMIT = '83582e876dd193f4448f44c28e379fb5464a26c7';
const CIPHER = 'vault:v1:c3ludGhldGljLWNpcGhlcnRleHQ=';

// Column specs mirror the reviewed candidates' non-generated columns for the
// tables this test populates; unpopulated tables keep only their binding.
const COLUMNS = {
  entries: 'tenant_id uuid, doc jsonb, id_kind text, insertion_ordinal bigint identity',
  treatments: 'tenant_id uuid, doc jsonb, id_kind text',
  devicestatus: 'tenant_id uuid, doc jsonb, id_kind text',
  profile: 'tenant_id uuid, id_kind text, doc jsonb',
  food: 'tenant_id uuid, id_kind text, doc jsonb',
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
  tenant_notification_state: 'tenant_id uuid, consumer text, revision bigint, config_identity text, producer jsonb',
  tenant_notification_heads: 'tenant_id uuid, consumer text, dedup_key text, request_id uuid, blocked_until bigint',
  tenant_notification_requests: 'tenant_id uuid, request_id uuid, consumer text, dedup_key text, origin text, config_identity text, payload jsonb, state text, created_at bigint, next_at bigint, attempt integer, attempt_token uuid, attempt_until bigint, accepted_at bigint, receipt jsonb, cleared_at bigint',
  tenant_lifecycle_key_retention: 'request_id uuid, tenant_id uuid, artifact_digest text, key_names jsonb, key_references integer, phase text, retained_at bigint, retain_until bigint, restored_at bigint, destroy_started_by text, destroy_started_consumer text, destroy_started_at bigint, destroyed_by text, destroyed_consumer text, destroyed_at bigint',
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
  const seeded = {
    entries: [
      typed(A, 'objectid', { _id: HEX, date: 1000, sgv: 100, extension: { nullable: null, ordered: [3, 1, 2] } }),
      typed(A, 'string', { _id: HEX, date: 1000, sgv: 101 }),
      typed(A, 'string', { _id: 'synthetic-a-2', date: 2000, sgv: 102, isValid: false }),
      typed(B, 'string', { _id: HEX, date: 1000, sgv: 200 })
    ],
    food: [
      typed(A, 'string', { _id: 'food-a', name: 'synthetic' }),
      typed(B, 'string', { _id: 'food-b', name: 'synthetic' })
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
  seeded.entries.forEach((row, index) => { row.insertion_ordinal = ['7', '11', '17', '900'][index]; });
  return seeded;
}

// An in-memory lower-port double: it honours the real tenant scope as the RLS
// binding, records every statement, and discards writes when a transaction
// throws, so rollback is observable. It is not a SQL engine.
function recordingConnection (seed = seedRows(), legacy = false) {
  const tables = new Map();
  const ledgers = new Map();
  const log = [];
  for (const entry of lifecycle.admittedCatalogue()) {
    ledgers.set(namespaces[entry.kind], validateCatalogue(legacy && entry.kind === 'entries' ? { ...entry.candidate, migrations: entry.candidate.migrations.slice(0, 1) } : entry.candidate).map(m => ({ name: m.name, checksum: m.checksum })));
    for (const table of entry.tables) {
      tables.set('"' + namespaces[entry.kind] + '"."' + table + '"', { columns: columnsFor(table).filter(c => !(legacy && c.identity)), rows: (seed[table] || []).map(row => { const copy = { ...row }; if (legacy) delete copy.insertion_ordinal; return copy; }) });
    }
  }
  ledgers.set(ledgerNamespace, ledgerCandidate.migrations.map(m => ({ name: m.name, checksum: m.checksum })));
  tables.set('"' + ledgerNamespace + '"."tenant_lifecycle_requests"', { columns: columnsFor('tenant_lifecycle_requests'), rows: [] });
  for (const table of LEDGER_TABLES) tables.set('"' + ledgerNamespace + '"."' + table + '"', { columns: columnsFor(table), rows: [] });
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
    if (text.includes('reviewed-relation-inventory')) return { rows: [
      ...(ledgers.has(values[0]) ? [{ name: 'schema_migrations', kind: 'r', partition: false, inherited: false }] : []),
      ...[...tables].filter(([name]) => name.startsWith('"' + values[0] + '".')).map(([name, table]) => ({ name: name.split('"')[3], kind: table.kind || 'r', partition: table.partition || false, inherited: table.inherited || false }))
    ] };
    if (/FROM pg_attribute/.test(text)) {
      const table = tables.get(values[0]);
      return { rows: table ? table.columns.map(c => ({ ...c })) : [] };
    }
    if ((match = /FROM "([a-z0-9_]+)"\."schema_migrations"/.exec(text))) return { rows: clone(ledgers.get(match[1]) || []) };
    if ((match = /^SELECT count\(\*\)::int AS n FROM ("[a-z0-9_]+"\."[a-z0-9_]+") WHERE tenant_id = \$1$/.exec(text))) {
      return { rows: [{ n: tables.get(match[1]).rows.filter(row => row.tenant_id === tenant && row.tenant_id === values[0]).length }] };
    }
    if ((match = /^SELECT (.+) FROM ("[a-z0-9_]+"\."tenant_lifecycle_key_retention") WHERE tenant_id = \$1 FOR UPDATE$/.exec(text))) {
      return { rows: clone(tables.get(match[2]).rows.filter(row => row.tenant_id === tenant && row.tenant_id === values[0])) };
    }
    if ((match = /^UPDATE ("[a-z0-9_]+"\."tenant_lifecycle_key_retention") SET (.+) WHERE request_id = \$1 AND tenant_id = \$2 AND phase = \$(\d+)$/.exec(text))) {
      const assignments = match[2].split(',').map(item => { const parts = /([a-z_]+) = \$(\d+)/.exec(item.trim()); return { name: parts[1], index: Number(parts[2]) - 1 }; });
      let count = 0;
      for (const row of tables.get(match[1]).rows) {
        if (row.tenant_id === tenant && row.request_id === values[0] && row.tenant_id === values[1] && row.phase === values[Number(match[3]) - 1]) {
          for (const part of assignments) row[part.name] = clone(values[part.index]);
          count++;
        }
      }
      return { rowCount: count, rows: [] };
    }
    if ((match = /^SELECT (.+) FROM ("[a-z0-9_]+"\."tenant_lifecycle_(?:requests|ceremony|key_retention)") WHERE request_id = \$1 AND tenant_id = \$2 FOR UPDATE$/.exec(text))) {
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
    addInheritance: (ns, name) => {
      const table = tables.get('"' + ns + '"."' + name + '"'); table.inherited = true;
      table.rows.push({ tenant_id: A, id_kind: 'string', doc: { _id: 'inherited-a', date: 1000 }, insertion_ordinal: '991', descendant_only: 'synthetic child extra' });
    },
    addRelation: (ns, name, kind = 'r', partition = false) => tables.set('"' + ns + '"."' + name + '"', { kind, partition, columns: [{ name: 'tenant_id', type: 'uuid' }], rows: [{ tenant_id: A }, { tenant_id: B }] }),
    query,
    transaction: fn => transaction(fn, 'BEGIN'),
    snapshotTransaction: fn => transaction(fn, 'BEGIN ISOLATION LEVEL REPEATABLE READ'),
    withTenant: (tenant, fn) => tenantScope.withTenant(tenant, () => transaction(fn, 'BEGIN'))
  };
}


// Explicit older, non-identity protocol cohort. Current entries0002 is covered
// separately and refuses tenant import; these successes do not claim otherwise.
const nonIdentityLifecycle = lifecycleModule.createLifecycle({ ...trustedCapabilities,
  catalogues: selectedCatalogues.map(entry => entry.kind === 'entries' ? { ...entry, candidate: { ...entry.candidate, migrations: entry.candidate.migrations.slice(0, 1) } } : entry) });
const recordingLegacyConnection = seed => recordingConnection(seed, true);

const sorted = rows => rows.map(artifacts.canonical).sort();
const totalRows = (connection, tenant) => lifecycle.CATALOGUE.reduce((sum, entry) =>
  sum + entry.tables.reduce((inner, table) => inner + connection.rows(namespaces[entry.kind], table, tenant).length, 0), 0);
const options = extra => ({ tenant: A, namespaces, sourceCommit: COMMIT, now: () => 1700000000000, ...extra });

describe('tenant lifecycle: typed export, import and two-phase deletion', function () {
  let previousMode;
  before(function () { previousMode = tenantScope.getTenancyMode(); tenantScope.setTenancyMode('multi'); });
  after(function () { tenantScope.setTenancyMode(previousMode); });

  function unknownArtifact (artifact) {
    const catalogues = artifact.manifest.catalogues.map(entry => ({ ...entry,
      ledger: entry.kind === 'entries' ? [...entry.ledger, { name: '0999_unknown', checksum: 'a'.repeat(64) }] : entry.ledger,
      tables: entry.tables.map(table => ({ ...table, rows: artifact.tables[entry.kind + '.' + table.table], secrets: table.keyReferences !== undefined, keyReferences: table.keyReferences })) }));
    return artifacts.buildArtifact({ tenant: A, sourceCommit: COMMIT, exportedAt: 1, catalogues });
  }

  it('serializes execute versus cancel with the actual SQL authority fence before request locks', async function () {
    const createCeremony = require('../lib/tenant-lifecycle/ceremony');
    const { currentAuthority } = require('../tools/lab/tenant-whole-c/authority');
    const artifact = await lifecycle.exportTenant(recordingConnection(), options());
    const requestId = '10000000-0000-4000-8000-000000000001', claimId = '10000000-0000-4000-8000-000000000002';
    const trace = [], owners = new Map(), waits = new Map(), queue = new Map();
    let releaseFirst, firstAcquired, cancelWaiting;
    const first = new Promise(resolve => { firstAcquired = resolve; });
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const waiting = new Promise(resolve => { cancelWaiting = resolve; });
    let firstKey;
    async function acquire (id, key) {
      if (owners.get(key) === id) return;
      if (!owners.has(key)) {
        owners.set(key, id); trace.push({ id, event: 'acquired', key });
        if (id === 'execute' && firstKey === undefined) { firstKey = key; firstAcquired(); await firstGate; }
        return;
      }
      const owner = owners.get(key); trace.push({ id, event: 'waiting', key, owner }); waits.set(id, owner);
      if (id === 'cancel') cancelWaiting();
      if (waits.get(owner) === id) { trace.push({ event: 'cycle', id, owner }); throw Object.assign(new Error('controlled lock graph cycle'), { code: 'SOURCE_MODEL_DEADLOCK' }); }
      await new Promise(resolve => { const entries = queue.get(key) || []; entries.push({ id, resolve }); queue.set(key, entries); });
      waits.delete(id);
    }
    function release (id) {
      waits.delete(id);
      for (const [key, owner] of owners) if (owner === id) {
        const next = (queue.get(key) || []).shift();
        if (next) { owners.set(key, next.id); next.resolve(); } else owners.delete(key);
      }
    }
    const principal = { principal: 'model_operator', consumer: 'model_core', plane: 'operator' };
    const authorize = currentAuthority({ namespace: 'model_policy', ...principal });
    const ceremony = createCeremony({ authorize, namespaceOf: mapping => mapping.ledger, timestamp: () => 2,
      verifyDurableArtifact: async () => ({ tenant: A, verified: true, digest: artifact.digest }), executionWindow: async () => ({ tenant: A, current: true, quiesced: true }),
      verifyRows: async () => [], eraseRows: async () => { throw Object.assign(new Error('controlled destructive rollback'), { code: 'SOURCE_EXEC_INTERRUPT' }); } });
    const connection = id => ({
      transaction: async fn => { try { return await fn(); } finally { release(id); } },
      query: async text => {
        assert.equal(tenantScope.requireTenant('controlled ceremony query'), A);
        if (text.includes('reviewed-relation-inventory')) return { rows: ['schema_migrations', ...LEDGER_TABLES].map(name => ({ name, kind: 'r', partition: false, inherited: false })) };
        if (text.includes('SELECT name, checksum')) return { rows: validateCatalogue(ledgerCandidate).map(({ name, checksum }) => ({ name, checksum })) };
        if (text.includes('pg_advisory_xact_lock')) { await acquire(id, 'policy'); return { rows: [] }; }
        if (text.includes('SELECT generation, policy')) return { rows: [{ generation: 1, policy: { wholeCFixtureActors: [{ ...principal, active: true, actions: ['execute','cancel'] }] } }] };
        if (text.includes('tenant_lifecycle_requests')) { await acquire(id, 'request'); return { rows: [{ request_id: requestId, tenant_id: A, phase: 'requested', artifact_digest: artifact.digest }] }; }
        if (text.includes('tenant_lifecycle_ceremony')) { await acquire(id, 'ceremony'); return { rows: [{ phase: 'executing', claim_id: claimId, started_at: '1', confirmed_at: '1' }] }; }
        throw new Error('unexpected controlled query');
      }
    });
    const args = { tenant: A, ledgerNamespace: 'model_lifecycle', artifact, requestId, claimId };
    const execute = ceremony.executeDeletion(connection('execute'), args).then(() => 'unexpected-success', error => error.code);
    await first;
    const cancel = ceremony.cancelDeletion(connection('cancel'), args).then(() => 'unexpected-success', error => error.code);
    await waiting; releaseFirst();
    const outcomes = await Promise.all([execute, cancel]);
    console.log('CEREMONY_LOCK_ORDER_SOURCE', JSON.stringify({ scope: 'actual component/SQL adapter with controlled lock model, not PostgreSQL', trace, outcomes }));
    assert.equal(trace.some(event => event.event === 'cycle'), false, 'execute and cancel must not create policy/request inversion');
    assert.equal(firstKey, 'policy');
    assert.deepEqual(outcomes, ['SOURCE_EXEC_INTERRUPT', 'LIFECYCLE_EXECUTION_STARTED']);
  });

  it('refuses ordinary inheritance participation even when descendant is outside selected namespaces', async function () {
    const source = recordingConnection(); source.addInheritance(namespaces.entries, 'entries');
    let artifact, exportFailure, eraseFailure;
    try { artifact = await lifecycle.exportTenant(source, options()); } catch (error) { exportFailure = error; }
    // Old source accepts parent projection and omits the descendant-only column.
    if (artifact) {
      const request = await lifecycle.requestDeletion(source, { tenant: A, ledgerNamespace, artifact });
      await lifecycle.confirmDeletion(source, { tenant: A, ledgerNamespace, artifact, requestId: request.requestId });
      try { await lifecycle.executeDeletion(source, { tenant: A, namespaces, ledgerNamespace, artifact, requestId: request.requestId }); } catch (error) { eraseFailure = error; }
    }
    console.log('LIFECYCLE_INHERITANCE_SOURCE', JSON.stringify({ scope: 'actual-component recording model, not PostgreSQL', accepted: Boolean(artifact), omittedExtra: artifact ? artifact.tables['entries.entries'].every(row => !Object.hasOwn(row, 'descendant_only')) : null, deletes: source.log.filter(entry => /^DELETE/.test(entry.text)).length, remainingParentA: source.rows(namespaces.entries, 'entries', A).length }));
    assert.equal(exportFailure?.code, 'LIFECYCLE_RELATION_UNSUPPORTED');
    assert.equal(eraseFailure, undefined);
    assert.equal(source.log.filter(entry => /^DELETE/.test(entry.text)).length, 0);
  });

  it('refuses unadmitted physical relations with an unchanged known ledger before export or erase', async function () {
    const source = recordingConnection(); const artifact = await lifecycle.exportTenant(source, options());
    source.addRelation(namespaces.entries, 'unreviewed_state');
    const request = await lifecycle.requestDeletion(source, { tenant: A, ledgerNamespace, artifact });
    await lifecycle.confirmDeletion(source, { tenant: A, ledgerNamespace, artifact, requestId: request.requestId });
    let exportFailure, eraseFailure;
    try { await lifecycle.exportTenant(source, options()); } catch (error) { exportFailure = error; }
    try { await lifecycle.executeDeletion(source, { tenant: A, namespaces, ledgerNamespace, artifact, requestId: request.requestId }); } catch (error) { eraseFailure = error; }
    console.log('LIFECYCLE_PHYSICAL_INVENTORY_SOURCE', JSON.stringify({ scope: 'recording-client protocol, not PostgreSQL', deletes: source.log.filter(entry => /^DELETE/.test(entry.text)).length, knownA: totalRows(source, A), hiddenA: source.rows(namespaces.entries, 'unreviewed_state', A).length }));
    assert.equal(exportFailure?.code, 'LIFECYCLE_RELATION_UNADMITTED');
    assert.equal(eraseFailure?.code, 'LIFECYCLE_RELATION_UNADMITTED');
    assert.equal(source.log.filter(entry => /^DELETE/.test(entry.text)).length, 0);
    const target = recordingConnection({}); target.addRelation(namespaces.entries, 'unreviewed_state');
    await assert.rejects(lifecycle.importArtifact(target, artifact, { tenant: A, ledgerNamespace, namespaces }), { code: 'LIFECYCLE_RELATION_UNADMITTED', detail: 'entries.unreviewed_state' });
    assert.equal(target.log.some(entry => /^INSERT/.test(entry.text)), false);
  });

  it('requires full current reviewed ledger for export, including unknown, stale and drifted clinical ledgers', async function () {
    for (const [mutation, code] of [
      [rows => rows.push({ name: '0999_unknown', checksum: 'a'.repeat(64) }), 'LIFECYCLE_SCHEMA_UNKNOWN'],
      [rows => rows.pop(), 'LIFECYCLE_SCHEMA_STALE'],
      [rows => { rows[0].checksum = 'f'.repeat(64); }, 'LIFECYCLE_SCHEMA_DRIFT'],
      [rows => rows.reverse(), 'LIFECYCLE_SCHEMA_HISTORY']
    ]) {
      const connection = recordingConnection(); mutation(connection.ledgers.get(namespaces.entries));
      await assert.rejects(lifecycle.exportTenant(connection, options()), { code, detail: 'entries' });
    }
  });

  it('refuses matching unknown artifact and live ledgers before import or deletion effects', async function () {
    const source = recordingConnection();
    const knownArtifact = await lifecycle.exportTenant(source, options());
    const artifact = unknownArtifact(knownArtifact);
    const target = recordingConnection({});
    const unknown = { name: '0999_unknown', checksum: 'a'.repeat(64) };
    target.ledgers.get(namespaces.entries).push(unknown);
    await assert.rejects(lifecycle.importArtifact(target, artifact, { tenant: A, ledgerNamespace, namespaces }), { code: 'LIFECYCLE_SCHEMA_UNKNOWN', detail: 'entries' });
    await assert.rejects(lifecycle.importArtifact(target, knownArtifact, { tenant: A, ledgerNamespace, namespaces }), { code: 'LIFECYCLE_SCHEMA_UNKNOWN', detail: 'entries' });
    assert.equal(target.log.filter(entry => /^INSERT|^DELETE/.test(entry.text)).length, 0);
  });

  it('refuses matching unknown clinical ledger before destructive execution', async function () {
    const source = recordingConnection();
    const artifact = unknownArtifact(await lifecycle.exportTenant(source, options()));
    const unknown = { name: '0999_unknown', checksum: 'a'.repeat(64) };
    source.ledgers.get(namespaces.entries).push(unknown);
    const request = await lifecycle.requestDeletion(source, { tenant: A, ledgerNamespace, artifact });
    await lifecycle.confirmDeletion(source, { tenant: A, ledgerNamespace, artifact, requestId: request.requestId });
    let failure;
    try { await lifecycle.executeDeletion(source, { tenant: A, namespaces, ledgerNamespace, artifact, requestId: request.requestId }); } catch (error) { failure = error; }
    const observed = { scope: 'actual-component recording-client protocol, not PostgreSQL', deleteStatements: source.log.filter(entry => /^DELETE/.test(entry.text)).length, remainingTenantRows: totalRows(source, A) };
    console.log('LIFECYCLE_UNKNOWN_LEDGER_SOURCE_OBSERVATION', JSON.stringify(observed));
    assert.equal(failure?.code, 'LIFECYCLE_SCHEMA_UNKNOWN');
    assert.equal(observed.deleteStatements, 0);
  });

  it('refuses current identity-bearing tenant import before inserts or any shared sequence maintenance', async function () {
    const source = recordingConnection();
    const artifact = await lifecycle.exportTenant(source, options());
    const foreign = seedRows(); for (const rows of Object.values(foreign)) for (let i = rows.length - 1; i >= 0; i--) if (rows[i].tenant_id === A) rows.splice(i, 1);
    const target = recordingConnection(foreign);
    const before = target.rows(namespaces.entries, 'entries', B);
    await assert.rejects(lifecycle.importArtifact(target, artifact, { tenant: A, ledgerNamespace, namespaces }), { code: 'LIFECYCLE_IDENTITY_IMPORT_UNSUPPORTED', detail: 'entries.entries' });
    assert.equal(target.log.some(entry => /^(INSERT|UPDATE|DELETE|ALTER)|setval|nextval/.test(entry.text)), false);
    assert.deepEqual(target.rows(namespaces.entries, 'entries', B), before);
  });

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
    const source = recordingLegacyConnection();
    const artifact = await nonIdentityLifecycle.exportTenant(source, options());
    const target = recordingLegacyConnection({});
    const seen = [];
    const result = await nonIdentityLifecycle.importArtifact(target, artifact, { tenant: A, ledgerNamespace, namespaces, onRow: event => { seen.push(event.total); } });
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
    assert.ok(!food.text.includes('OVERRIDING SYSTEM VALUE'));
    assert.equal(typeof food.values[2], 'string');
    assert.equal(target.log.some(entry => /setval|nextval|ALTER SEQUENCE/.test(entry.text)), false);
    assert.equal(totalRows(target, B), 0);
  });

  it('refuses before any write: tenant, row tenant, ledger, columns, key reference, non-empty target, missing catalogue', async function () {
    const source = recordingLegacyConnection();
    const artifact = await nonIdentityLifecycle.exportTenant(source, options());
    const writes = connection => connection.log.filter(e => /^(INSERT|DELETE|UPDATE)/.test(e.text)).length;
    let target = recordingLegacyConnection({});
    await assert.rejects(nonIdentityLifecycle.importArtifact(target, artifact, { tenant: B, ledgerNamespace, namespaces }), { code: 'LIFECYCLE_TENANT_MISMATCH' });
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
    await assert.rejects(nonIdentityLifecycle.importArtifact(recordingLegacyConnection({}), tampered, { tenant: A, ledgerNamespace, namespaces }), { code: 'LIFECYCLE_ARTIFACT_COUNT' });
    tampered.manifest.exportedAt += 1;
    await assert.rejects(nonIdentityLifecycle.importArtifact(recordingLegacyConnection({}), tampered, { tenant: A, ledgerNamespace, namespaces }), { code: 'LIFECYCLE_ARTIFACT_DIGEST' });

    const stale = rebuilt(c => { c.find(x => x.kind === 'entries').ledger[0].checksum = 'f'.repeat(64); });
    target = recordingLegacyConnection({});
    await assert.rejects(nonIdentityLifecycle.importArtifact(target, stale, { tenant: A, ledgerNamespace, namespaces }), { code: 'LIFECYCLE_SCHEMA_DRIFT', detail: 'entries' });
    assert.equal(writes(target), 0);

    assert.throws(() => rebuilt(c => { delete c.find(x => x.kind === 'entries').tables[0].rows[0].id_kind; }), { code: 'LIFECYCLE_ARTIFACT_COLUMN', detail: 'entries.entries.id_kind' });
    const narrowed = rebuilt(c => { c.find(x => x.kind === 'entries').tables[0].columns.pop(); });
    await assert.rejects(nonIdentityLifecycle.importArtifact(recordingLegacyConnection({}), narrowed, { tenant: A, ledgerNamespace, namespaces }), { code: 'LIFECYCLE_COLUMNS_MISMATCH', detail: 'entries.entries' });
    const retyped = rebuilt(c => { c.find(x => x.kind === 'entries').tables[0].columns[1].type = 'text'; });
    await assert.rejects(nonIdentityLifecycle.importArtifact(recordingLegacyConnection({}), retyped, { tenant: A, ledgerNamespace, namespaces }), { code: 'LIFECYCLE_COLUMNS_MISMATCH', detail: 'entries.entries' });

    const missing = rebuilt(c => { c.splice(c.findIndex(x => x.kind === 'food'), 1); });
    target = recordingLegacyConnection({});
    await assert.rejects(nonIdentityLifecycle.importArtifact(target, missing, { tenant: A, ledgerNamespace, namespaces }), { code: 'LIFECYCLE_CATALOGUE_INCOMPLETE', detail: 'food' });
    assert.equal(writes(target), 0);

    await assert.rejects(nonIdentityLifecycle.importArtifact(source, artifact, { tenant: A, ledgerNamespace, namespaces }), { code: 'LIFECYCLE_TARGET_NOT_EMPTY', detail: 'entries.entries' });
    await assert.rejects(nonIdentityLifecycle.importArtifact(recordingLegacyConnection({}), artifact, { tenant: A, ledgerNamespace, namespaces: { ...namespaces, food: undefined } }), { code: 'LIFECYCLE_CATALOGUE_UNMAPPED', detail: 'food' });
  });

  it('rolls back an interrupted import completely and a rerun completes', async function () {
    const source = recordingLegacyConnection();
    const artifact = await nonIdentityLifecycle.exportTenant(source, options());
    const target = recordingLegacyConnection({});
    let partial;
    await assert.rejects(nonIdentityLifecycle.importArtifact(target, artifact, { tenant: A, ledgerNamespace, namespaces, onRow: event => {
      if (event.total === 3) { partial = totalRows(target, A); throw new Error('synthetic-interruption'); }
    } }), /synthetic-interruption/);
    assert.equal(partial, 3, 'three rows were visible inside the transaction before the throw');
    assert.equal(target.log.at(-1).text, 'ROLLBACK');
    assert.equal(totalRows(target, A), 0);
    const rerun = await nonIdentityLifecycle.importArtifact(target, artifact, { tenant: A, ledgerNamespace, namespaces });
    assert.equal(rerun.total, totalRows(source, A));
    assert.equal(totalRows(target, A), rerun.total);
  });

  it('deletes with verified ceremony, preserves foreign tenant and refuses identity-bearing tenant re-import', async function () {
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
    assert.equal(order[0], 'notification_outbox.tenant_notification_state', 'deletion walks the catalogue in reverse');

    const executed = await lifecycle.executeDeletion(connection, { tenant: A, namespaces, ledgerNamespace, artifact, requestId: request.requestId, now: () => 9 });
    assert.equal(executed.total, before.a);
    assert.equal(totalRows(connection, A), 0);
    assert.equal(totalRows(connection, B), before.b);
    assert.deepEqual(lifecycle.CATALOGUE.map(entry => entry.tables.map(table => sorted(connection.rows(namespaces[entry.kind], table, B)))), foreign);
    assert.equal(connection.rows(ledgerNamespace, 'tenant_lifecycle_requests')[0].phase, 'executed');
    assert.equal(connection.log.filter(e => e.text === 'BEGIN').at(-1) !== undefined, true);
    await assert.rejects(lifecycle.executeDeletion(connection, { tenant: A, namespaces, ledgerNamespace, artifact, requestId: request.requestId }), { code: 'LIFECYCLE_REQUEST_ALREADY_EXECUTED' });

    await assert.rejects(lifecycle.importArtifact(connection, artifact, { tenant: A, ledgerNamespace, namespaces }), { code: 'LIFECYCLE_IDENTITY_IMPORT_UNSUPPORTED', detail: 'entries.entries' });
    assert.equal(totalRows(connection, A), 0);
    assert.equal(artifact.tables['secrets.secret_records'][0].ciphertext, CIPHER);
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
    await connection.withTenant(A, () => connection.query('INSERT INTO "ns_entries"."entries" ("tenant_id", "doc", "id_kind", "insertion_ordinal") OVERRIDING SYSTEM VALUE VALUES ($1::uuid, $2::jsonb, $3::text, $4::bigint)',
      [A, JSON.stringify({ _id: 'after-claim', date: 3000 }), 'string', '999']));
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
    await connection.withTenant(A, () => connection.query('INSERT INTO "ns_entries"."entries" ("tenant_id", "doc", "id_kind", "insertion_ordinal") OVERRIDING SYSTEM VALUE VALUES ($1::uuid, $2::jsonb, $3::text, $4::bigint)',
      [A, JSON.stringify({ _id: 'late-row', date: 3000 }), 'string', '999']));
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

// Post-deletion key retention (release decision tenant-deletion-key-retention).
// Same recording double: it is not PostgreSQL; the native suite is
// tests/tenant-key-retention.integration.test.js (PostgreSQL + Vault).
describe('tenant lifecycle: 30-day key retention, operator destroy and restore window', function () {
  const retention = require('../lib/tenant-lifecycle/key-retention');
  const DAY = 24 * 60 * 60 * 1000;
  const T0 = 1700000000000;
  let previousMode;
  before(function () { previousMode = tenantScope.getTenancyMode(); tenantScope.setTenancyMode('multi'); });
  after(function () { tenantScope.setTenancyMode(previousMode); });

  function custodian () {
    const calls = [];
    return { calls, fail: false, async destroy ({ tenant, keys }) {
      calls.push({ tenant, keys: keys.map(key => key.mount + '/' + key.name) });
      if (this.fail) throw Object.assign(new Error('Secrets provider key destruction failed'), { code: 'SECRETS_PROVIDER_UNAVAILABLE' });
      return { destroyed: true, absent: keys.length };
    } };
  }
  // The older non-identity entries cohort (as nonIdentityLifecycle) so a
  // same-ID import can run on this double; admission checks the selected kinds.
  const legacyAdmission = ({ catalogues }) => assert.deepEqual(catalogues.map(entry => entry.kind), selectedCatalogues.map(entry => entry.kind));
  const subject = (keyCustodian, extra = {}) => lifecycleModule.createLifecycle({ ...trustedCapabilities, admissionCheck: legacyAdmission, keyCustodian, ...extra,
    catalogues: selectedCatalogues.map(entry => entry.kind === 'entries' ? { ...entry, candidate: { ...entry.candidate, migrations: entry.candidate.migrations.slice(0, 1) } } : entry) });

  async function deleted (life, connection, at = T0) {
    const artifact = await life.exportTenant(connection, options({ now: () => at - 10 }));
    const request = await life.requestDeletion(connection, { tenant: A, ledgerNamespace, artifact, now: () => at - 3 });
    await life.confirmDeletion(connection, { tenant: A, ledgerNamespace, artifact, requestId: request.requestId, now: () => at - 2 });
    const result = await life.executeDeletion(connection, { tenant: A, namespaces, ledgerNamespace, artifact, requestId: request.requestId, now: () => at });
    return { artifact, requestId: request.requestId, result };
  }
  const destroyArgs = (requestId, now, extra = {}) => ({ tenant: A, namespaces, ledgerNamespace, requestId, now: () => now,
    intent: retention.destroyIntent(A, requestId), ...extra });

  it('records a 30-day retention window with every key name at execution, in the destructive transaction', async function () {
    const connection = recordingLegacyConnection();
    const { artifact, requestId, result } = await deleted(subject(custodian()), connection);
    assert.deepEqual(result.retention, { retainedAt: T0, retainUntil: T0 + 30 * DAY, keys: 2 });
    const [row] = connection.rows(ledgerNamespace, 'tenant_lifecycle_key_retention');
    assert.equal(row.request_id, requestId); assert.equal(row.artifact_digest, artifact.digest);
    assert.equal(row.phase, 'retained'); assert.equal(row.retain_until, T0 + 30 * DAY); assert.equal(row.key_references, 1);
    assert.deepEqual(row.key_names, [{ mount: 'transit', name: 'tenant-11111111-data' }, { mount: 'transit', name: 'tenant-11111111-signing' }]);
    assert.ok(!JSON.stringify(row).includes(CIPHER), 'the retention record holds names and counts, never ciphertext');
    assert.equal(connection.rows(namespaces.secrets, 'secret_records', A).length, 0);
    assert.equal(connection.rows(namespaces.secrets, 'secret_records', B).length, 1);
  });

  it('gate: an artifact missing one key reference refuses deletion before any secret or audit row is removed', async function () {
    const life = subject(custodian());
    for (const [keyNames, code] of [
      [[{ mount: 'transit', name: 'tenant-11111111-data' }], 'LIFECYCLE_KEY_REFERENCE_MISSING'],
      [null, 'LIFECYCLE_KEY_NAMES_MISSING'],
      [[{ mount: 'transit', name: 'tenant-11111111-data' }, { mount: 'transit', name: 'tenant-11111111-signing' }, { mount: 'transit', name: 'tenant-22222222-data' }], 'LIFECYCLE_KEY_REFERENCE_UNKNOWN']
    ]) {
      const connection = recordingLegacyConnection();
      const before = totalRows(connection, A);
      const exported = await lifecycleModule.createLifecycle({ ...trustedCapabilities, keyInventory: null, catalogues: life.admittedCatalogue() })
        .exportTenant(connection, options({ keyNames, now: () => T0 - 10 }));
      const request = await life.requestDeletion(connection, { tenant: A, ledgerNamespace, artifact: exported, now: () => T0 - 3 });
      await life.confirmDeletion(connection, { tenant: A, ledgerNamespace, artifact: exported, requestId: request.requestId, now: () => T0 - 2 });
      await assert.rejects(life.executeDeletion(connection, { tenant: A, namespaces, ledgerNamespace, artifact: exported, requestId: request.requestId, now: () => T0 }), error => {
        assert.equal(error.code, code); return true;
      });
      assert.equal(totalRows(connection, A), before, code + ': nothing deleted');
      assert.equal(connection.rows(namespaces.secrets, 'secret_audit', A).length, 1, code + ': audit rows kept');
      assert.equal(connection.rows(ledgerNamespace, 'tenant_lifecycle_key_retention').length, 0);
    }
    // A missing per-ciphertext reference is refused at artifact validation.
    const connection = recordingLegacyConnection();
    const artifact = await life.exportTenant(connection, options({ now: () => T0 - 10 }));
    const catalogues = artifact.manifest.catalogues.map(entry => ({ ...entry, tables: entry.tables.map(table => ({ ...table,
      rows: artifact.tables[entry.kind + '.' + table.table], secrets: table.keyReferences !== undefined,
      keyReferences: table.keyReferences && table.keyReferences.slice(1) })) }));
    assert.throws(() => artifacts.buildArtifact({ tenant: A, sourceCommit: COMMIT, exportedAt: 1, keyNames: artifact.manifest.keyNames, catalogues }),
      { code: 'LIFECYCLE_CIPHERTEXT_WITHOUT_KEY_REFERENCE' });
  });

  it('gate: restore inside the window succeeds, credentials return and the record becomes restored', async function () {
    const connection = recordingLegacyConnection();
    const life = subject(custodian());
    const { artifact, requestId } = await deleted(life, connection);
    const result = await life.importArtifact(connection, artifact, { tenant: A, namespaces, ledgerNamespace, now: () => T0 + 30 * DAY - 1 });
    assert.ok(result.total > 0);
    assert.deepEqual(connection.rows(namespaces.secrets, 'secret_records', A).map(row => row.ciphertext), [CIPHER]);
    const [row] = connection.rows(ledgerNamespace, 'tenant_lifecycle_key_retention');
    assert.equal(row.phase, 'restored'); assert.equal(row.restored_at, T0 + 30 * DAY - 1);
    await assert.rejects(life.destroyRetainedKeys(connection, destroyArgs(requestId, T0 + 31 * DAY)), { code: 'LIFECYCLE_RETENTION_RESTORED' });
  });

  it('gate: restore after the window refuses with nothing written, even before any destroy', async function () {
    const connection = recordingLegacyConnection();
    const life = subject(custodian());
    const { artifact } = await deleted(life, connection);
    await assert.rejects(life.importArtifact(connection, artifact, { tenant: A, namespaces, ledgerNamespace, now: () => T0 + 30 * DAY }), { code: 'LIFECYCLE_RETENTION_EXPIRED' });
    assert.equal(totalRows(connection, A), 0);
    assert.equal(connection.rows(ledgerNamespace, 'tenant_lifecycle_key_retention')[0].phase, 'retained');
    await assert.rejects(life.importArtifact(connection, artifact, { tenant: A, namespaces, now: () => T0 + 1 }), { code: 'LIFECYCLE_RETENTION_LEDGER_REQUIRED' });
  });

  it('destroy requires explicit intent, the operator plane and an ended window, and audits both steps', async function () {
    const connection = recordingLegacyConnection();
    const keys = custodian();
    const life = subject(keys);
    const { requestId } = await deleted(life, connection);
    await assert.rejects(life.destroyRetainedKeys(connection, destroyArgs(requestId, T0 + 31 * DAY, { intent: undefined })), { code: 'LIFECYCLE_DESTROY_INTENT_REQUIRED' });
    await assert.rejects(life.destroyRetainedKeys(connection, destroyArgs(requestId, T0 + 31 * DAY, { intent: retention.destroyIntent(B, requestId) })), { code: 'LIFECYCLE_DESTROY_INTENT_REQUIRED' });
    const owner = subject(keys, { authorize: async ({ tenant }) => ({ tenant, allowed: true, current: true, plane: 'owner', principal: 'synthetic_owner', consumer: 'synthetic_owner_ui' }) });
    await assert.rejects(owner.destroyRetainedKeys(connection, destroyArgs(requestId, T0 + 31 * DAY)), { code: 'LIFECYCLE_OPERATOR_REQUIRED' });
    await assert.rejects(life.destroyRetainedKeys(connection, destroyArgs(requestId, T0 + 30 * DAY - 1)), { code: 'LIFECYCLE_RETENTION_WINDOW_OPEN' });
    await assert.rejects(subject(null).destroyRetainedKeys(connection, destroyArgs(requestId, T0 + 31 * DAY)), { code: 'LIFECYCLE_KEY_CUSTODIAN_REQUIRED' });
    assert.equal(keys.calls.length, 0, 'no provider call before every precondition holds');
    const done = await life.destroyRetainedKeys(connection, destroyArgs(requestId, T0 + 30 * DAY));
    assert.deepEqual(done, { requestId, tenant: A, phase: 'destroyed', keys: 2, destroyedAt: T0 + 30 * DAY, resumed: false });
    assert.deepEqual(keys.calls, [{ tenant: A, keys: ['transit/tenant-11111111-data', 'transit/tenant-11111111-signing'] }]);
    const [row] = connection.rows(ledgerNamespace, 'tenant_lifecycle_key_retention');
    assert.equal(row.phase, 'destroyed');
    assert.deepEqual([row.destroy_started_by, row.destroy_started_consumer, row.destroy_started_at, row.destroyed_by, row.destroyed_at],
      ['synthetic_operator', 'synthetic_control', T0 + 30 * DAY, 'synthetic_operator', T0 + 30 * DAY]);
    assert.ok(!JSON.stringify(done).includes('vault:'), 'the result reveals no ciphertext');
    const again = await life.destroyRetainedKeys(connection, destroyArgs(requestId, T0 + 32 * DAY));
    assert.equal(again.resumed, true); assert.equal(keys.calls.length, 1, 'a repeat destroy makes no provider call');
  });

  it('gate: destroy then restore refuses, including inside a clock that is later rewound', async function () {
    const connection = recordingLegacyConnection();
    const life = subject(custodian());
    const { artifact, requestId } = await deleted(life, connection);
    await life.destroyRetainedKeys(connection, destroyArgs(requestId, T0 + 30 * DAY));
    for (const at of [T0 + 31 * DAY, T0 + 1]) {
      await assert.rejects(life.importArtifact(connection, artifact, { tenant: A, namespaces, ledgerNamespace, now: () => at }), { code: 'LIFECYCLE_KEYS_DESTROYED' });
    }
    assert.equal(totalRows(connection, A), 0);
  });

  it('a provider failure leaves the record destroying: restore refuses and an explicit retry completes', async function () {
    const connection = recordingLegacyConnection();
    const keys = custodian(); keys.fail = true;
    const life = subject(keys);
    const { artifact, requestId } = await deleted(life, connection);
    await assert.rejects(life.destroyRetainedKeys(connection, destroyArgs(requestId, T0 + 30 * DAY)), error => {
      assert.equal(error.code, 'SECRETS_PROVIDER_UNAVAILABLE'); assert.ok(!/vault:|token/i.test(error.message)); return true;
    });
    assert.equal(connection.rows(ledgerNamespace, 'tenant_lifecycle_key_retention')[0].phase, 'destroying');
    await assert.rejects(life.importArtifact(connection, artifact, { tenant: A, namespaces, ledgerNamespace, now: () => T0 + 1 }), { code: 'LIFECYCLE_KEYS_DESTROYED' });
    keys.fail = false;
    const done = await life.destroyRetainedKeys(connection, destroyArgs(requestId, T0 + 30 * DAY + 5));
    assert.equal(done.phase, 'destroyed'); assert.equal(keys.calls.length, 2);
    assert.equal(connection.rows(ledgerNamespace, 'tenant_lifecycle_key_retention')[0].destroy_started_at, T0 + 30 * DAY);
  });

  it('refuses to destroy keys of a same-ID tenant that holds rows again', async function () {
    const connection = recordingLegacyConnection();
    const keys = custodian();
    const life = subject(keys);
    const { requestId } = await deleted(life, connection);
    await tenantScope.withTenant(A, () => connection.transaction(() => connection.query('INSERT INTO "' + namespaces.food + '"."food" ("tenant_id", "id_kind", "doc") VALUES ($1::uuid, $2::text, $3::jsonb)',
      [A, 'string', JSON.stringify({ _id: 'reprovisioned', name: 'synthetic' })])));
    await assert.rejects(life.destroyRetainedKeys(connection, destroyArgs(requestId, T0 + 31 * DAY)), { code: 'LIFECYCLE_TENANT_NOT_DELETED', detail: 'food.food' });
    assert.equal(keys.calls.length, 0);
  });
});
