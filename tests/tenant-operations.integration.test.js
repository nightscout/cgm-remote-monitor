'use strict';
// covers: lib/tenant-operations/upgrade.js, lib/tenant-lifecycle/copy-table.js, lib/tenant-operations/common.js

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { run } = require('../lib/migrations/postgres');
const operations = require('../lib/tenant-operations');
const path = require('node:path');
const os = require('node:os');
const lifecycle = require('../lib/tenant-lifecycle');
const scope = require('../lib/storage/tenant-scope');
const { optInSuite } = require('./support/opt-in');
const { upgradePlan, catalogues, seedEntries, observe: observeState, older } = require('./fixtures/tenant-operations-current');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const COMMIT = '83582e876dd193f4448f44c28e379fb5464a26c7';

// Requires a focused runtime grant; this suite alone is not Batch C acceptance.
// This flag creates precisely one disposable local PostgreSQL container. No
// application database URL or existing service is accepted by this suite.
optInSuite(process.env.NS_TENANT_OPERATIONS_PG_TEST === '1', 'NS_TENANT_OPERATIONS_PG_TEST=1')('tenant operations PostgreSQL (owned disposable Docker)', function () {
  this.timeout(60000);
  const name = 'ns-tenant-operations-' + crypto.randomBytes(8).toString('hex');
  const role = 'ops_app_' + crypto.randomBytes(8).toString('hex');
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
  let connectionString;
  let client;
  let owned = false;
  let serial = 0;
  let mounts = [];
  const audit = event => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Explicit local evidence destination.
    if (process.env.NS_TENANT_OPERATIONS_AUDIT) fs.appendFileSync(process.env.NS_TENANT_OPERATIONS_AUDIT, JSON.stringify({ ...event, name, at: new Date().toISOString() }) + '\n');
  };
  const namespaces = () => ({ entries: 'ops_entries_' + (++serial), clock: 'ops_clock_' + serial });
  const migrate = (action, input) => run(action, { ...input, connectionString, direct: true });
  async function prepare (ns, old = false) {
    for (const entry of catalogues(ns, old)) await migrate('up', entry);
  }
  async function source (old = false) {
    const ns = namespaces();
    await prepare(ns, old);
    await seedEntries(client, ns.entries, [[A, 'objectid', '0123456789abcdef01234567', 100], [A, 'string', '0123456789abcdef01234567', 101], [B, 'string', 'synthetic-b', 200]]
      .map(([tenant, kind, id, value]) => ({ tenant, kind, doc: { _id: id, date: 1000, sgv: value } })));
    await client.query('INSERT INTO "' + ns.clock + '".tenant_write_clock (tenant_id,last_stamp) VALUES ($1,1000),($2,2000)', [A, B]);
    return ns;
  }
  before(async function () {
    const password = crypto.randomBytes(24).toString('hex');
    execFileSync('docker', ['run', '--pull', 'never', '--rm', '--name', name, '--label', 'org.nightscout.test.owner=' + name, '-d', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_USER=operator', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=operations_test', 'postgres:16'],
      { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    owned = true;
    const metadata = JSON.parse(docker(['inspect', '--format', '{{json .}}', name]));
    mounts = metadata.Mounts.filter(mount => mount.Type === 'volume').map(mount => mount.Name);
    audit({ phase: 'created', container: metadata.Id, image: metadata.Image, mounts });
    const port = docker(['port', name, '5432/tcp']).split(':').pop();
    connectionString = 'postgres://operator:' + password + '@127.0.0.1:' + port + '/operations_test';
    const deadline = Date.now() + 15000;
    let ready = false;
    while (!ready) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'operator', '-d', 'operations_test']); ready = true; } catch (error) {
        if (![1, 2].includes(error.status) || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    client = new Client({ connectionString });
    await client.connect();
    audit({ phase: 'server', version: (await client.query('SHOW server_version')).rows[0].server_version });
    await client.query('CREATE ROLE "' + role + '" NOSUPERUSER NOBYPASSRLS');
  });
  beforeEach(async function () {
    assert.equal((await client.query('SELECT 1 AS alive')).rows[0].alive, 1);
    audit({ phase: 'test-start', title: this.currentTest.title });
  });
  afterEach(async function () {
    assert.equal((await client.query('SELECT 1 AS alive')).rows[0].alive, 1);
    audit({ phase: 'test-end', title: this.currentTest.title });
  });
  after(async function () {
    try { if (client) await client.end(); } finally {
      if (owned) {
        docker(['rm', '-f', '-v', name]);
        audit({ phase: 'removed', mounts });
      }
    }
  });

  it('migrates an older ledger and preserves the previously written documents', async function () {
    const ns = await source(true);
    const before = await observeState(client, ns, true);
    const { record } = await operations.upgrade(client, { migrate, ...upgradePlan(ns), sourceCommit: COMMIT });
    assert.equal(operations.assertUpgradeCompatible(record, catalogues(ns)), true);
    assert.throws(() => operations.assertUpgradeCompatible(record, catalogues(ns, true)), { code: 'OPERATIONS_BINARY_CATALOGUE_NEWER' });
    const after = await observeState(client, ns);
    assert.deepEqual(after.rows, before.rows);
    await assert.rejects(migrate('check', { namespace: ns.entries, catalogue: older }), { code: 'MIG_UNKNOWN' });
  });

  it('exports the bound tenant using COPY, reloads the files and restores the original ciphertext and IDs', async function () {
    const namespaces = { secrets: 'copy_secrets' };
    const ledgerNamespace = 'copy_lifecycle';
    const entries = lifecycle.admittedCatalogue().filter(entry => entry.kind === 'secrets');
    const life = lifecycle.createLifecycle({ catalogues: entries });
    await migrate('up', { namespace: namespaces.secrets, catalogue: entries[0].candidate });
    await migrate('up', { namespace: ledgerNamespace, catalogue: require('../lib/tenant-lifecycle/postgres-candidate.json') });
    const pass = crypto.randomBytes(24).toString('hex');
    await client.query('ALTER ROLE "' + role + '" LOGIN PASSWORD \'' + pass + '\'');
    await client.query('GRANT USAGE ON SCHEMA copy_secrets,copy_lifecycle TO "' + role + '"');
    await client.query('GRANT SELECT,INSERT,DELETE ON ALL TABLES IN SCHEMA copy_secrets TO "' + role + '"');
    await client.query('GRANT SELECT, UPDATE ON copy_lifecycle.tenant_lifecycle_key_retention TO "' + role + '"');
    const cipher = 'vault:v2:c3ludGhldGlj';
    await client.query("INSERT INTO copy_secrets.secret_records VALUES ($1,'integration_key',1,$3),($2,'neighbour_key',1,$3)", [A, B, cipher]);
    const before = (await client.query('SELECT * FROM copy_secrets.secret_records ORDER BY tenant_id')).rows;
    const url = new URL(connectionString);
    url.username = role;
    url.password = pass;
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tenant-copy-roundtrip-'));
    const previous = scope.getTenancyMode();
    scope.setTenancyMode('multi');
    const port = await require('../lib/storage/postgres-connection')({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 3000 });
    try {
      const artifact = await life.exportTenant(port, { tenant: A, namespaces, sourceCommit: COMMIT });
      await lifecycle.saveTenantArtifact(artifact, { directory });
      const location = path.join(directory, 'tenant-artifact-' + artifact.digest);
      const data = await fs.promises.readFile(path.join(location, 'secrets.secret_records.csv'), 'utf8');
      const table = artifact.manifest.catalogues[0].tables.find(table => table.table === 'secret_records');
      assert.equal(crypto.createHash('sha256').update(data).digest('hex'), table.sha256);
      assert(data.includes(cipher));
      assert(!data.includes(B));
      const retained = await lifecycle.loadTenantArtifact({ directory, digest: artifact.digest });
      await client.query('DELETE FROM copy_secrets.secret_records WHERE tenant_id=$1', [A]);
      await life.importArtifact(port, retained, { tenant: A, namespaces, ledgerNamespace });
      const after = (await client.query('SELECT * FROM copy_secrets.secret_records ORDER BY tenant_id')).rows;
      assert.deepEqual(after, before);
    } finally {
      await port.end();
      scope.setTenancyMode(previous);
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });
});
