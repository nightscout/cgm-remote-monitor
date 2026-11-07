'use strict';
/* eslint-disable security/detect-non-literal-fs-filename -- All filesystem paths are owned private temporary fixtures. */
// covers: lib/tenant-operations/catalogues.js, lib/tenant-operations/filesystem.js, lib/tenant-operations/deployment.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const common = require('../lib/tenant-operations/common');
const operations = require('../lib/tenant-operations');
const { checksum } = require('../lib/migrations/catalogue');
const { createdTables } = require('../lib/tenant-operations/catalogues');
const A = '11111111-1111-4111-8111-111111111111';
const COMMIT = '74d7b3fc25c7e3c496c438847c95e89ec7fe6061';
const KINDS = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'settings', 'clock', 'checkpoint',
  'authorization', 'access', 'subject_policy', 'operator_policy', 'tenant_settings', 'owner_configuration', 'legacy', 'secrets', 'lifecycle'];
const namespaces = () => Object.fromEntries(KINDS.map(kind => [kind, 'deploy_' + kind]));
const ROOT = path.resolve(__dirname, '..');
const candidate = () => {
  const up = ['CREATE TABLE synthetic_state (tenant_id uuid NOT NULL, value jsonb NOT NULL)'];
  return { version: 1, migrations: [{ name: '0001_synthetic_state', up, checksum: checksum(up) }] };
};
function artifact () {
  const encoded = common.encodeTable([{ tenant_id: A, doc: { _id: 'synthetic', nullable: null, flag: false } }]);
  const manifest = { format: common.FORMAT, version: common.VERSION, takenAt: 1700000000000, sourceCommit: COMMIT,
    catalogues: [{ kind: 'entries', namespace: 'source_entries', ledger: [{ name: '0001_entries', checksum: 'a'.repeat(64) }],
      tables: [{ table: 'entries', file: 'tables/entries.entries.ndjson', columns: [{ name: 'tenant_id', type: 'uuid' }, { name: 'doc', type: 'jsonb' }], count: encoded.count, digest: encoded.digest }] }],
    tenants: [{ tenant_id: A, registered: null, rows: { 'entries.entries': 1 } }] };
  return { format: common.FORMAT, version: common.VERSION, manifest, tables: { 'entries.entries': encoded.text }, digest: common.manifestDigest(manifest) };
}

describe('whole deployment source admission and filesystem durability', function () {
  let scratch;
  beforeEach(async function () { scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tenant-deployment-unit-')); });
  afterEach(async function () { await fs.promises.rm(scratch, { recursive: true, force: true }); });

  it('censuses all selected A74/R69 kinds, owner configuration and the independent lifecycle ledger', function () {
    const admission = operations.deploymentAdmission({ namespaces: namespaces() });
    assert.deepEqual(admission.census.selected.map(entry => entry.kind), KINDS);
    assert.equal(admission.census.tables, 31);
    assert.equal(admission.census.candidates.length, 20);
    assert.equal(admission.census.candidates.filter(entry => entry.disposition === 'reviewed alternative').length, 2);
    assert.ok(admission.lifecycle.CATALOGUE.some(entry => entry.tables.includes('tenant_owner_configuration_authority')));
    assert.ok(!admission.lifecycle.CATALOGUE.some(entry => entry.tables.includes('tenant_lifecycle_requests')));
    assert.deepEqual(admission.catalogues.find(entry => entry.kind === 'lifecycle').tables, ['tenant_lifecycle_requests']);
  });

  it('has an explicit two-tenant populated seed for every selected table; no empty-domain acceptance', function () {
    const { A, B, populatedRows } = require('./fixtures/tenant-deployment-data');
    const rows = populatedRows();
    const tables = operations.deploymentAdmission({ namespaces: namespaces() }).catalogues.flatMap(entry => entry.tables);
    assert.deepEqual(Object.keys(rows).sort(), tables.slice().sort());
    for (const table of tables) {
      assert.ok(rows[table].some(row => row.tenant_id === A), table + ' missing A');
      assert.ok(rows[table].some(row => row.tenant_id === B), table + ' missing B');
    }
  });

  it('control: adding a candidate refuses until its exact extension, namespace and table list are admitted', async function () {
    for (const entry of operations.discoverCatalogues()) {
      await fs.promises.mkdir(path.dirname(path.join(scratch, entry.file)), { recursive: true });
      await fs.promises.copyFile(path.join(ROOT, entry.file), path.join(scratch, entry.file));
    }
    const oldEntryFile = 'migrations/candidates/postgres-entries-v1.json';
    const older = JSON.parse(await fs.promises.readFile(path.join(scratch, oldEntryFile), 'utf8'));
    older.migrations = older.migrations.slice(0, 1);
    await fs.promises.writeFile(path.join(scratch, oldEntryFile), JSON.stringify(older));
    const oldAdmission = operations.deploymentAdmission({ root: scratch, namespaces: namespaces() });
    assert.equal(oldAdmission.catalogues.find(entry => entry.kind === 'entries').catalogue.migrations.length, 1, 'old archive retains actual old SQL');
    const file = 'lib/synthetic-extension/postgres-candidate.json';
    await fs.promises.mkdir(path.dirname(path.join(scratch, file)));
    await fs.promises.writeFile(path.join(scratch, file), JSON.stringify(candidate()));
    const options = { root: scratch, namespaces: namespaces() };
    assert.throws(() => operations.deploymentAdmission(options), { code: 'OPERATIONS_CATALOGUE_UNADMITTED', detail: file });
    const extension = { kind: 'synthetic', candidatePath: file, tables: ['synthetic_state'] };
    assert.throws(() => operations.deploymentAdmission({ ...options, extensions: [extension] }), { code: 'OPERATIONS_NAMESPACE_INVALID' });
    const admitted = { ...options, namespaces: { ...namespaces(), synthetic: 'deploy_synthetic' }, extensions: [extension] };
    assert.throws(() => operations.deploymentAdmission({ ...admitted, extensions: [{ ...extension, tables: [] }] }), { code: 'OPERATIONS_CENSUS_TABLES_MISMATCH' });
    const plan = operations.deploymentAdmission(admitted);
    assert.equal(plan.census.tables, 32);
    assert.ok(plan.lifecycle.CATALOGUE.some(entry => entry.kind === 'synthetic'));
  });

  it('requires an explicit reviewed selection and refuses omitted namespace mappings', function () {
    const ns = namespaces(); delete ns.owner_configuration;
    assert.throws(() => operations.deploymentAdmission({ namespaces: ns }), { code: 'OPERATIONS_NAMESPACE_INVALID' });
    assert.throws(() => operations.deploymentAdmission({ namespaces: namespaces(), selection: { unknown: 'ignored' } }), { code: 'OPERATIONS_CENSUS_SELECTION_INVALID' });
    const plan = operations.deploymentAdmission({ namespaces: namespaces(), selection: { treatments: 'migrations/candidates/postgres-treatments-socket-order-v1.json' } });
    assert.match(plan.census.selected.find(entry => entry.kind === 'treatments').candidatePath, /socket-order/);
    assert.equal(plan.census.tables, 31);
    assert.throws(() => createdTables({ version: 1, migrations: [{ name: '0001_bad', up: ['CREATE TABLE unbound (value text)'], checksum: checksum(['CREATE TABLE unbound (value text)']) }] }), { code: 'OPERATIONS_CENSUS_DDL_UNSUPPORTED' });
  });

  it('saves, fsyncs, atomically publishes and independently reloads the exact original-tenant artifact', async function () {
    const events = [];
    const io = { ...fs.promises,
      open: async (...args) => {
        const handle = await fs.promises.open(...args);
        return { writeFile: (...values) => handle.writeFile(...values), readFile: (...values) => handle.readFile(...values), stat: () => handle.stat(),
          sync: async () => { events.push(['sync', args[0]]); await handle.sync(); }, close: () => handle.close() };
      },
      rename: async (...args) => { events.push(['rename']); await fs.promises.rename(...args); }
    };
    const original = artifact();
    const saved = await operations.saveArtifact(original, { directory: scratch, io });
    assert.deepEqual(saved, original);
    const rename = events.findIndex(event => event[0] === 'rename');
    assert.ok(events.slice(0, rename).some(event => /manifest.json$/.test(event[1])));
    assert.ok(events.slice(0, rename).some(event => /\.ndjson$/.test(event[1])));
    assert.ok(events.slice(rename + 1).some(event => event[0] === 'sync' && event[1] === scratch));
    const name = operations.artifactName(original);
    const loaded = await operations.loadArtifact({ directory: scratch, name });
    assert.deepEqual(loaded, original);
    assert.equal(loaded.manifest.tenants[0].tenant_id, A);
    assert.deepEqual(await fs.promises.readdir(scratch), [name]);
    await assert.rejects(operations.saveArtifact(original, { directory: scratch }), { code: 'BACKUP_DESTINATION_EXISTS' });
  });

  it('control: a lying filesystem write or corrupt published row cannot pass readback validation', async function () {
    const io = { ...fs.promises, open: async (...args) => {
      const handle = await fs.promises.open(...args);
      if (!args[0].endsWith('.ndjson')) return handle;
      return { writeFile: async () => {}, readFile: (...values) => handle.readFile(...values), stat: () => handle.stat(), sync: () => handle.sync(), close: () => handle.close() };
    } };
    await assert.rejects(operations.saveArtifact(artifact(), { directory: scratch, io }), error => error.code === 'BACKUP_DURABILITY_FAILED' && error.cause.code === 'RESTORE_COUNT_MISMATCH');
    assert.deepEqual(await fs.promises.readdir(scratch), []);
    await operations.saveArtifact(artifact(), { directory: scratch });
    const name = operations.artifactName(artifact());
    const file = path.join(scratch, name, 'tables/entries.entries.ndjson');
    const original = await fs.promises.readFile(file, 'utf8');
    await fs.promises.writeFile(file, original.replace('"flag":false', '"flag":true'));
    await assert.rejects(operations.loadArtifact({ directory: scratch, name }), { code: 'RESTORE_DIGEST_MISMATCH' });
  });

  it('control: interrupted write/sync/rename refuses and never publishes a partial artifact', async function () {
    for (const stage of ['write', 'sync', 'rename']) {
      const io = { ...fs.promises,
        open: async (...args) => {
          const handle = await fs.promises.open(...args);
          return { writeFile: async (...values) => { if (stage === 'write') throw new Error('synthetic interrupted write'); return handle.writeFile(...values); },
            readFile: (...values) => handle.readFile(...values), stat: () => handle.stat(),
            sync: async () => { if (stage === 'sync') throw new Error('synthetic interrupted sync'); return handle.sync(); }, close: () => handle.close() };
        }, rename: async (...args) => { if (stage === 'rename') throw new Error('synthetic interrupted rename'); return fs.promises.rename(...args); }
      };
      await assert.rejects(operations.saveArtifact(artifact(), { directory: scratch, io }), { code: 'BACKUP_DURABILITY_FAILED' });
      assert.deepEqual(await fs.promises.readdir(scratch), []);
    }
    await operations.saveArtifact(artifact(), { directory: scratch }); // rerun completes
  });

  it('refuses after a failed publication-directory sync and retains the published artifact for recovery', async function () {
    const io = { ...fs.promises, open: async (...args) => {
      const handle = await fs.promises.open(...args);
      if (args[0] !== scratch) return handle;
      return { sync: async () => { throw new Error('synthetic root sync failure'); }, close: () => handle.close() };
    } };
    await assert.rejects(operations.saveArtifact(artifact(), { directory: scratch, io }), { code: 'BACKUP_DURABILITY_FAILED' });
    assert.deepEqual(await fs.promises.readdir(scratch), [operations.artifactName(artifact())]);
    assert.deepEqual(await operations.loadArtifact({ directory: scratch, name: operations.artifactName(artifact()) }), artifact());
  });

  it('durability refusal prevents any migration up; a restored filesystem callback completes before up', async function () {
    const old = artifact();
    const up = ['CREATE TABLE entries (tenant_id uuid)'];
    const first = { name: '0001_entries', up, checksum: checksum(up) };
    old.manifest.catalogues[0].ledger[0].checksum = first.checksum;
    old.digest = common.manifestDigest(old.manifest);
    const second = { name: '0002_extension', up: ['ALTER TABLE entries ADD COLUMN flag boolean'], checksum: checksum(['ALTER TABLE entries ADD COLUMN flag boolean']) };
    const catalogues = [{ kind: 'entries', namespace: 'upgrade_entries', tables: ['entries'], catalogue: { version: 1, migrations: [first, second] } }];
    const connection = { query: async text => {
      if (/FROM pg_attribute/.test(text)) return { rows: old.manifest.catalogues[0].tables[0].columns };
      if (/to_regclass/.test(text)) return { rows: [{ present: true }] };
      if (/SELECT name, checksum/.test(text)) return { rows: [first, second].map(({ name, checksum }) => ({ name, checksum })) };
      return { rows: common.decodeTable(old.tables['entries.entries']) };
    } };
    const calls = [];
    const migrate = async action => {
      calls.push(action);
      if (action === 'status') return { applied: ['0001_entries'], pending: ['0002_extension'] };
      if (action === 'up') {
        const saved = await operations.loadArtifact({ directory: scratch, name: operations.artifactName(old) });
        assert.equal(saved.digest, old.digest, 'durable readback before first up');
        return { done: ['0002_extension'] };
      }
      return { applied: ['0001_entries', '0002_extension'] };
    };
    const bad = operations.createFilesystemBackup({ directory: scratch, io: { ...fs.promises, rename: async () => { throw new Error('synthetic refusal'); } }, backup: async () => old });
    await assert.rejects(operations.upgrade(connection, { migrate, catalogues, sourceCommit: COMMIT, backup: bad }), { code: 'BACKUP_DURABILITY_FAILED' });
    assert.deepEqual(calls, ['status']);
    calls.length = 0;
    await operations.upgrade(connection, { migrate, catalogues, sourceCommit: COMMIT, backup: operations.createFilesystemBackup({ directory: scratch, backup: async () => old }) });
    assert.deepEqual(calls, ['status', 'up', 'check']);
  });

  it('refuses cloning and incomplete whole-deployment admission before any database or filesystem write', async function () {
    const deploy = operations.createDeploymentOperations({ directory: scratch, namespaces: namespaces() });
    const connection = { query: async () => { assert.fail('must refuse before database'); } };
    await assert.rejects(deploy.restore(connection, artifact(), { targetTenant: A }), { code: 'OPERATIONS_REHOME_UNSUPPORTED' });
    const broken = operations.createDeploymentOperations({ directory: scratch, namespaces: {} });
    await assert.rejects(broken.backup(connection, { sourceCommit: COMMIT }), { code: 'OPERATIONS_NAMESPACE_INVALID' });
    await assert.rejects(deploy.restore(connection, artifact(), { acl: { role: 'blanket_writer' } }), { code: 'OPERATIONS_DEPLOYMENT_ACL_REQUIRED' });
    await assert.rejects(deploy.upgrade(connection, {}), { code: 'UPGRADE_SOURCE_ADMISSION_REQUIRED' });
    await assert.rejects(deploy.rollback(connection, artifact()), { code: 'ROLLBACK_UPGRADE_RECORD_REQUIRED' });
    assert.deepEqual(await fs.promises.readdir(scratch), []);
  });
});
