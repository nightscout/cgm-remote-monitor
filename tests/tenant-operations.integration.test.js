'use strict';
// covers: lib/tenant-operations/backup.js, lib/tenant-operations/restore.js, lib/tenant-operations/upgrade.js, lib/tenant-operations/common.js

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { run } = require('../lib/migrations/postgres');
const operations = require('../lib/tenant-operations');
const common = require('../lib/tenant-operations/common');
const { optInSuite } = require('./support/opt-in');
const { upgradePlan, catalogues, seedEntries, applicationAcl, observe: observeState, older } = require('./fixtures/tenant-operations-current');
const clock = require('../migrations/candidates/postgres-write-clock-v1.json');
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
  const capture = ns => operations.backup(client, { catalogues: catalogues(ns), sourceCommit: COMMIT });
  const observe = (ns, old = false) => observeState(client, ns, old);
  const recording = () => {
    const statements = [];
    return { statements, query: async (text, values) => { statements.push(text); return client.query(text, values); } };
  };

  before(async function () {
    const password = crypto.randomBytes(24).toString('hex');
    execFileSync('docker', ['run', '--pull', 'never', '--rm', '--name', name, '-d', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_USER=operator', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=operations_test', 'postgres:16'],
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

  it('refuses damaged files and invalid ACL before statements; bound identity before table reads', async function () {
    const ns = await source();
    const artifact = await capture(ns);
    const fresh = namespaces();
    await prepare(fresh);
    const wire = recording();
    const damaged = { ...artifact, tables: { ...artifact.tables, 'entries.entries': artifact.tables['entries.entries'].replace('"sgv":100', '"sgv":999') } };
    await assert.rejects(operations.restore(wire, damaged, { catalogues: catalogues(fresh) }), { code: 'RESTORE_DIGEST_MISMATCH' });
    const invalidAcl = applicationAcl(role); invalidAcl.grants[0].role = 'bad-role';
    await assert.rejects(operations.restore(wire, artifact, { catalogues: catalogues(fresh), acl: invalidAcl }), { code: 'RESTORE_ACL_ROLE_INVALID' });
    assert.equal(wire.statements.length, 0);
    await client.query('SET ROLE "' + role + '"');
    try {
      await assert.rejects(operations.backup(wire, { catalogues: catalogues(ns), sourceCommit: COMMIT }), { code: 'BACKUP_IDENTITY_BOUND' });
      assert.equal(wire.statements.some(sql => /FROM "ops_/.test(sql)), false);
    } finally { await client.query('RESET ROLE'); }
  });

  it('restores typed rows, clock and tenant-local ordinals with explicit RLS application grants', async function () {
    const ns = await source();
    const artifact = await capture(ns);
    const expected = await observe(ns);
    assert.deepEqual(expected.counters, [{ tenant_id: A, last_ordinal: '2' }, { tenant_id: B, last_ordinal: '1' }]);
    assert.deepEqual(expected.ordinals.map(row => [row.tenant_id, row.insertion_ordinal]), [[A, '1'], [A, '2'], [B, '1']]);
    const fresh = namespaces();
    await prepare(fresh);
    await operations.restore(client, artifact, { catalogues: catalogues(fresh), acl: applicationAcl(role) });
    assert.deepEqual(await observe(fresh), expected);
    await client.query('SET ROLE "' + role + '"');
    try {
      await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [B]);
      const visible = await client.query('SELECT tenant_id FROM "' + fresh.entries + '".entries');
      assert.deepEqual(visible.rows, [{ tenant_id: B }]);
      const next = await client.query('INSERT INTO "' + fresh.entries + '".entries (tenant_id,id_kind,doc) VALUES ($1,$2,$3::jsonb) RETURNING insertion_ordinal', [B, 'string', JSON.stringify({ _id: 'after-restore' })]);
      assert.equal(next.rows[0].insertion_ordinal, '2', 'B advances its own restored floor, independent of A');
      await assert.rejects(client.query('INSERT INTO "' + fresh.entries + '".entries (tenant_id,id_kind,doc) VALUES ($1,$2,$3::jsonb)', [A, 'string', JSON.stringify({ _id: 'foreign' })]), { code: '42501' });
      await assert.rejects(client.query('INSERT INTO "' + fresh.entries + '".entries (tenant_id,id_kind,doc,insertion_ordinal) VALUES ($1,$2,$3::jsonb,99)', [B, 'string', JSON.stringify({ _id: 'explicit-ordinal-refused' })]), { code: '42501' });
    } finally { await client.query('RESET ROLE'); await client.query("RESET app.current_tenant_id"); }
  });

  it('distinguishes self-consistent row loss from digest damage using independent source readback', async function () {
    const ns = await source();
    const artifact = await capture(ns);
    // A self-consistent backup losing B in entries must escape internal checks;
    // the external source comparison must still catch the missing tenant/table.
    const forged = JSON.parse(JSON.stringify(artifact));
    const encoded = common.encodeTable(common.decodeTable(forged.tables['entries.entries']).filter(row => row.tenant_id !== B));
    forged.tables['entries.entries'] = encoded.text;
    Object.assign(forged.manifest.catalogues.find(c => c.kind === 'entries').tables.find(t => t.table === 'entries'), { count: encoded.count, digest: encoded.digest });
    delete forged.manifest.tenants.find(t => t.tenant_id === B).rows['entries.entries'];
    forged.digest = common.manifestDigest(forged.manifest);
    const fresh = namespaces();
    await prepare(fresh);
    await operations.restore(client, forged, { catalogues: catalogues(fresh) });
    assert.notDeepEqual(await observe(fresh), await observe(ns));
    const differences = operations.compareSummaries(await operations.summarize(client, catalogues(ns)), await operations.summarize(client, catalogues(fresh)));
    assert.ok(differences.some(d => d.key === 'entries.entries' && d.tenant === B && d.actual === 0));
  });

  it('rolls back lying successful inserts and interruptions; rerun restores the same target', async function () {
    const ns = await source();
    const artifact = await capture(ns);
    const fresh = namespaces();
    await prepare(fresh);
    await assert.rejects(operations.restore(client, artifact, { catalogues: catalogues(fresh), onRow: ({ key, written }) => { if (key === 'entries.entries' && written === 1) throw new Error('synthetic interruption'); } }), /synthetic interruption/);
    assert.deepEqual(await observe(fresh), { rows: [], stamps: [], counters: [], ordinals: [] });
    const liar = { query: (text, values) => /^INSERT INTO .*tenant_write_clock/.test(text) ? Promise.resolve({ rowCount: 1, rows: [] }) : client.query(text, values) };
    await assert.rejects(operations.restore(liar, artifact, { catalogues: catalogues(fresh) }), { code: 'RESTORE_ORACLE_MISMATCH' });
    assert.deepEqual(await observe(fresh), { rows: [], stamps: [], counters: [], ordinals: [] });
    await operations.restore(client, artifact, { catalogues: catalogues(fresh) });
    assert.deepEqual(await observe(fresh), await observe(ns));
  });

  it('upgrades then refuses old catalogue; rollback preflights every target and restores pre-upgrade rows', async function () {
    const ns = await source(true);
    const expected = await observe(ns, true);
    const { artifact } = await operations.upgrade(client, { migrate, ...upgradePlan(ns), sourceCommit: COMMIT });
    await assert.rejects(migrate('check', { namespace: ns.entries, catalogue: older }), { code: 'MIG_UNKNOWN' });
    const fresh = namespaces();
    await migrate('up', { namespace: fresh.clock, catalogue: clock });
    await assert.rejects(operations.rollback(client, { migrate, artifact, catalogues: catalogues(fresh, true), upgraded: ns }), { code: 'ROLLBACK_TARGET_NOT_FRESH' });
    assert.equal((await client.query('SELECT to_regnamespace($1) AS schema', [fresh.entries])).rows[0].schema, null);
    const target = namespaces();
    await seedEntries(client, ns.entries, [{ tenant: A, kind: 'string', doc: { _id: 'after-upgrade' } }]);
    const upgraded = await observe(ns);
    const record = await operations.rollback(client, { migrate, artifact, catalogues: catalogues(target, true), upgraded: ns, acl: applicationAcl(role, true) });
    assert.equal(record.refusal.entries, 'MIG_UNKNOWN');
    assert.deepEqual(await observe(target, true), expected);
    assert.deepEqual(await observe(ns), upgraded);
    assert.match(record.lost, /writes committed after takenAt/);
  });
});
