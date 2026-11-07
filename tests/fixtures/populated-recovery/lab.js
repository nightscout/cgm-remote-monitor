'use strict';

// Disposable reference experiment, not an operator backup/restore interface.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { Client } = require('pg');
const connection = require('../../../lib/storage/postgres-connection');
const scope = require('../../../lib/storage/tenant-scope');
const codec = require('../../../lib/storage/postgres-identity');
const { createPostgresTarget, importEntries } = require('../../../lib/import/entries');
const { run } = require('../../../lib/migrations/postgres');
const candidate = require('../../../migrations/candidates/postgres-entries-v1.json');
const fixture = require('./fixture');
const SCHEMA = 'test_populated_' + crypto.randomBytes(8).toString('hex');
const ROLE = 'test_recovery_application';
const DB = 'populated_recovery_test';
const USER = 'proof_operator';
const sortRows = rows => rows.slice().sort((a, b) =>
  JSON.stringify([a.tenant_id, a.id_kind, a.doc._id]).localeCompare(JSON.stringify([b.tenant_id, b.id_kind, b.doc._id]), 'en'));
const oracle = (actual, expected) => assert.deepEqual(sortRows(actual), sortRows(expected));
function docker (args, options = {}) {
  try { return execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], ...options }); } catch (error) {
    const detail = String(error.stderr || '');
    const code = args.includes('pg_restore') && /input file is too short|does not appear to be a valid archive|could not read from input file/.test(detail)
      ? 'RECOVERY_ARCHIVE_INVALID'
      : args.includes('pg_dump') && /no matching schemas were found/.test(detail)
        ? 'RECOVERY_DUMP_SCHEMA_MISSING' : 'RECOVERY_DOCKER_COMMAND_FAILED';
    const failure = new Error(code);
    failure.code = code;
    failure.status = error.status;
    throw failure; // driver/container details may include credentials or data
  }
}
const absent = (type, id) => {
  const result = spawnSync('docker', [type, 'inspect', id], { encoding: 'utf8', timeout: 10000 });
  return result.status !== 0 && /no such (object|container|volume)/i.test(result.stderr || '');
};
async function eventually (fn) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('RECOVERY_POSTGRES_NOT_READY');
}
function install (describe, it, before, beforeEach, after) {
  describe('populated PostgreSQL recovery reference (owned Docker; stopped writes)', function () {
    this.timeout(120000);
    const owner = crypto.randomUUID();
    const services = [];
    const clients = [];
    let scratch, source, target, previousMode;
    const migration = service => ({ direct: true, connectionString: service.url, namespace: SCHEMA, catalogue: candidate });
    async function provision (suffix) {
      const name = 'ns-populated-test-' + owner.slice(0, 8) + '-' + suffix;
      const password = crypto.randomBytes(24).toString('hex');
      // Save intended identity before spawning so a timeout can still be audited.
      const service = { name, owner, password, started: false, mounts: [] };
      services.push(service);
      docker(['run', '-d', '--name', name, '--label', 'nightscout.recovery-owner=' + owner,
        '--tmpfs', '/var/lib/postgresql/data', '-p', '127.0.0.1::5432',
        '-e', 'POSTGRES_USER=' + USER, '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=' + DB, 'postgres:16'],
      { env: { ...process.env, POSTGRES_PASSWORD: password } });
      service.started = true;
      const info = JSON.parse(docker(['inspect', name]))[0];
      assert.equal(info.Config.Labels['nightscout.recovery-owner'], owner);
      service.id = info.Id;
      service.mounts = info.Mounts.filter(m => m.Type === 'volume').map(m => m.Name);
      const port = docker(['port', name, '5432/tcp']).trim().split(':').pop();
      service.url = 'postgres://' + USER + ':' + password + '@127.0.0.1:' + port + '/' + DB;
      await eventually(async () => {
        try { docker(['exec', service.id, 'pg_isready', '-h', '127.0.0.1', '-U', USER, '-d', DB]); return true; } catch (error) {
          if (error.status === 1 || error.status === 2) return false;
          throw error;
        }
      });
      service.admin = new Client({ connectionString: service.url });
      await service.admin.connect();
      clients.push(service.admin);
      assert.equal((await service.admin.query('SELECT current_database() AS db')).rows[0].db, DB);
      // Password is locally generated hex, never caller SQL or a printed argument.
      assert.match(password, /^[a-f0-9]{48}$/);
      await service.admin.query('CREATE ROLE ' + ROLE + " LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '" + password + "'");
      return service;
    }
    async function grants (service) {
      await service.admin.query('GRANT USAGE ON SCHEMA ' + SCHEMA + ' TO ' + ROLE);
      await service.admin.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ' + SCHEMA + '.entries TO ' + ROLE);
      await service.admin.query('GRANT SELECT ON ' + SCHEMA + '.schema_migrations TO ' + ROLE);
      await service.admin.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ' + SCHEMA + ' TO ' + ROLE);
    }
    async function application (service, fn) {
      const url = new URL(service.url);
      url.username = ROLE;
      const app = await connection({ connectionString: url.toString(), max: 2 });
      try { return await fn(app, url.toString()); } finally { await app.end(); }
    }
    async function rows (service) {
      return (await service.admin.query('SELECT tenant_id::text, id_kind, doc FROM ' + SCHEMA + '.entries')).rows;
    }
    async function ledger (service) {
      return (await service.admin.query('SELECT name, checksum FROM ' + SCHEMA + '.schema_migrations ORDER BY name')).rows;
    }
    async function resetTarget () { await target.admin.query('DROP SCHEMA IF EXISTS ' + SCHEMA + ' CASCADE'); }
    function snapshot (schema = SCHEMA, extra = []) {
      // An exit failure never yields an accepted file, including partial stdout.
      const data = docker(['exec', source.id, 'pg_dump', '-U', USER, '-d', DB,
        '--format=custom', '--no-owner', '--no-privileges', '--strict-names', '--schema=' + schema, ...extra],
      { encoding: null, maxBuffer: 32 * 1024 * 1024 });
      const file = path.join(scratch, crypto.randomUUID() + '.dump');
      fs.writeFileSync(file, data, { mode: 0o600, flag: 'wx' });
      return file;
    }
    function restore (file) {
      docker(['exec', '-i', target.id, 'pg_restore', '-U', USER, '-d', DB,
        '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges'],
      { input: fs.readFileSync(file), stdio: ['pipe', 'pipe', 'pipe'], encoding: null, maxBuffer: 1024 * 1024 });
    }
    before(async function () {
      previousMode = scope.getTenancyMode();
      scope.setTenancyMode('multi');
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-populated-recovery-test-'));
      fs.chmodSync(scratch, 0o700);
      source = await provision('source');
      target = await provision('target');
    });
    beforeEach(async function () {
      await resetTarget();
      await source.admin.query('DROP SCHEMA IF EXISTS ' + SCHEMA + ' CASCADE');
      await run('up', migration(source));
      await grants(source);
      await application(source, async app => {
        for (const row of fixture.documents()) {
          const encoded = codec.encodeDocument(row.doc);
          await app.withTenant(row.tenant, () => app.query('INSERT INTO ' + SCHEMA + '.entries (tenant_id, id_kind, doc) VALUES ($1,$2,$3::jsonb)',
            [row.tenant, encoded.id_kind, JSON.stringify(encoded.doc)]));
        }
        const docs = fixture.apiRows();
        const imported = await importEntries({ tenant: fixture.A, pageSize: 1,
          source: { key: 'https://synthetic-source.invalid', async baseline ({ skip, limit }) { return docs.slice(skip, skip + limit); },
            async history ({ cursor }) { return { docs: [], cursor }; } },
          target: createPostgresTarget({ connection: app, tenant: fixture.A, table: SCHEMA + '.entries' }) });
        assert.equal(imported.baselineCount, docs.length);
      });
    });
    after(async function () {
      const failures = [];
      const audit = [];
      for (const client of clients.reverse()) {
        try { await client.end(); } catch { failures.push('client-close'); }
      }
      for (const service of services.reverse()) {
        try {
          if (absent('container', service.id || service.name)) continue;
          const info = JSON.parse(docker(['inspect', service.id || service.name]))[0];
          assert.equal(info.Config.Labels['nightscout.recovery-owner'], owner);
          const volumes = info.Mounts.filter(m => m.Type === 'volume').map(m => m.Name);
          assert.deepEqual(volumes, service.mounts);
          docker(['rm', '-f', '-v', info.Id]);
          assert.ok(absent('container', info.Id), 'owned container not absent');
          for (const volume of volumes) assert.ok(absent('volume', volume), 'owned volume not absent');
          audit.push({ container: info.Id, volumes, absent: true });
        } catch { failures.push('owned-resource-cleanup'); }
      }
      if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
      if (previousMode) scope.setTenancyMode(previousMode);
      process.stdout.write('populated-recovery-cleanup ' + JSON.stringify({ owner, resources: audit, failures }) + '\n');
      assert.deepEqual(failures, [], 'recovery fixture cleanup failed');
    });
    it('restores populated typed rows and actual migration ledger, with read-only restricted compatibility check', async function () {
      const expected = await rows(source);
      const expectedLedger = await ledger(source);
      const file = snapshot(); // No writers remain active: stopped-write reference only.
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      restore(file);
      oracle(await rows(target), expected);
      oracle(await rows(source), expected);
      assert.deepEqual(await ledger(target), expectedLedger);
      await grants(target);
      await application(target, async (app, url) => {
        assert.equal((await run('check', { ...migration(target), connectionString: url })).current, true);
        const security = await app.withTenant(fixture.A, () => app.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'));
        assert.deepEqual(security.rows, [{ rolsuper: false, rolbypassrls: false }]);
        const a = await app.withTenant(fixture.A, () => app.query('SELECT tenant_id::text, id_kind, doc FROM ' + SCHEMA + '.entries'));
        oracle(a.rows, expected.filter(row => row.tenant_id === fixture.A));
        const decoded = a.rows.filter(row => row.doc._id === fixture.HEX).map(row => codec.decodeDocument(row));
        assert.equal(decoded.filter(doc => typeof doc._id === 'string').length, 1);
        assert.equal(decoded.filter(doc => doc._id._bsontype === 'ObjectId').length, 1);
        await assert.rejects(app.withTenant(fixture.A, () => app.query('DELETE FROM ' + SCHEMA + '.schema_migrations')), { code: '42501' });
      });
    });
    it('rejects a truncated snapshot without leaving a partial schema transaction', async function () {
      const file = snapshot();
      fs.writeFileSync(file, fs.readFileSync(file).subarray(0, 32), { mode: 0o600 });
      assert.throws(() => restore(file), { code: 'RECOVERY_ARCHIVE_INVALID', status: 1 });
      assert.equal((await target.admin.query('SELECT to_regnamespace($1) AS ns', [SCHEMA])).rows[0].ns, null);
    });
    it('detects a schema-only partial snapshot as stale and missing populated values', async function () {
      const expected = await rows(source);
      restore(snapshot(SCHEMA, ['--section=pre-data']));
      await assert.rejects(run('check', migration(target)), { code: 'MIG_STALE' });
      const incomplete = await rows(target);
      assert.deepEqual(incomplete, []);
      assert.throws(() => oracle(incomplete, expected), assert.AssertionError);
    });
    it('detects altered typed identity independently of textual identity, then restores the original dump', async function () {
      const expected = await rows(source);
      const file = snapshot();
      restore(file);
      await target.admin.query('DELETE FROM ' + SCHEMA + '.entries WHERE tenant_id=$1 AND id_kind=$2 AND "_id"=$3', [fixture.A, 'string', fixture.HEX]);
      await target.admin.query('UPDATE ' + SCHEMA + '.entries SET id_kind=$1 WHERE tenant_id=$2 AND id_kind=$3', ['string', fixture.A, 'objectid']);
      const changed = await rows(target);
      assert.throws(() => oracle(changed, expected), assert.AssertionError);
      await resetTarget();
      restore(file);
      oracle(await rows(target), expected);
    });
    it('refuses wrong-tenant writes and exposes the paired RLS break before restoring isolation', async function () {
      restore(snapshot());
      await grants(target);
      const expected = await rows(target);
      await application(target, async app => {
        const foreign = async () => (await app.withTenant(fixture.A, () => app.query('SELECT tenant_id FROM ' + SCHEMA + '.entries WHERE tenant_id=$1', [fixture.B]))).rows;
        assert.deepEqual(await foreign(), []);
        await assert.rejects(app.withTenant(fixture.A, () => app.query('INSERT INTO ' + SCHEMA + '.entries (tenant_id,id_kind,doc) VALUES ($1,$2,$3::jsonb)',
          [fixture.B, 'string', JSON.stringify({ _id: 'synthetic-forbidden' })])), { code: '42501' });
        await target.admin.query('ALTER TABLE ' + SCHEMA + '.entries DISABLE ROW LEVEL SECURITY');
        try {
          const exposed = await foreign();
          assert.ok(exposed.length > 0, 'RLS break must expose the seeded foreign row');
          assert.throws(() => assert.deepEqual(exposed, []), assert.AssertionError);
        } finally { await target.admin.query('ALTER TABLE ' + SCHEMA + '.entries ENABLE ROW LEVEL SECURITY'); }
        assert.deepEqual(await foreign(), []);
      });
      oracle(await rows(target), expected);
    });
    it('refuses failed dump selection without creating an accepted dump artifact', function () {
      const beforeFiles = fs.readdirSync(scratch);
      assert.throws(() => snapshot('test_missing_schema'), { code: 'RECOVERY_DUMP_SCHEMA_MISSING', status: 1 });
      assert.deepEqual(fs.readdirSync(scratch), beforeFiles);
    });
    it('reruns the actual API importer after a later page failure, retaining only committed page data', async function () {
      const docs = [{ _id: 'synthetic-rerun-first', date: 3000 }, { _id: 'synthetic-rerun-second', date: 4000 }];
      await application(source, async app => {
        const targetPort = createPostgresTarget({ connection: app, tenant: fixture.A, table: SCHEMA + '.entries' });
        const src = { key: 'https://synthetic-source.invalid', async baseline ({ skip, limit }) { return docs.slice(skip, skip + limit); },
          async history ({ cursor }) { return { docs: [], cursor }; } };
        let failing = true;
        const port = { async writePage (page) {
          if (failing && page[0]._id === docs[1]._id) { failing = false; throw new Error('synthetic-later-page-failure'); }
          await targetPort.writePage(page);
        } };
        await assert.rejects(importEntries({ source: src, target: port, tenant: fixture.A, pageSize: 1 }), /synthetic-later-page-failure/);
        const stored = (await rows(source)).filter(row => row.doc._id.startsWith('synthetic-rerun-'));
        assert.deepEqual(stored.map(row => row.doc._id), [docs[0]._id]);
        assert.equal((await importEntries({ source: src, target: port, tenant: fixture.A, pageSize: 1 })).phase, 'done');
        oracle((await rows(source)).filter(row => row.doc._id.startsWith('synthetic-rerun-')),
          docs.map(doc => ({ tenant_id: fixture.A, id_kind: 'string', doc })));
      });
    });
  });
}
module.exports = { install, oracle };
