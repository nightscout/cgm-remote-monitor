'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const { execFileSync } = require('node:child_process');
const { run } = require('../lib/migrations/postgres');
const catalogue = require('../lib/tenant-authorization/postgres-candidate.json');
const createTenantAuthorization = require('../lib/tenant-authorization/postgres');
const scope = require('../lib/storage/tenant-scope');
const { optInSuite } = require('./support/opt-in');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const SUBJECT = 'same-subject';
const NAMESPACE = 'authority_test';
const CONFIG = '"' + NAMESPACE + '".tenant_authorization_config';
const ROLES = '"' + NAMESPACE + '".tenant_authorization_roles';
const SUBJECTS = '"' + NAMESPACE + '".tenant_authorization_subjects';
const LINKS = '"' + NAMESPACE + '".tenant_authorization_subject_roles';
const docker = args => execFileSync('docker', args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
}).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

optInSuite(process.env.NS_TENANT_AUTHORITY_POSTGRES_DOCKER_TEST === '1',
  'NS_TENANT_AUTHORITY_POSTGRES_DOCKER_TEST=1')('tenant authorization current state (disposable PostgreSQL)', function () {
  this.timeout(30000);
  const container = 'ns-tenant-authority-pg-' + crypto.randomBytes(8).toString('hex');
  const appRole = 'tenant_authority_app';
  let owned = false, previousMode, admin, adminURI, appURI, first, second;

  before(async function () {
    previousMode = scope.getTenancyMode();
    scope.setTenancyMode('multi');
    const password = crypto.randomBytes(24).toString('hex');
    execFileSync('docker', ['run', '--name', container, '-d', '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_USER=operator', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=tenant_authority',
      'postgres:16', '-c', 'shared_preload_libraries=pg_stat_statements', '-c', 'pg_stat_statements.track=all'], {
      env: { ...process.env, POSTGRES_PASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    owned = true;
    const port = docker(['port', container, '5432/tcp']).split(':').pop();
    adminURI = 'postgres://operator:' + password + '@127.0.0.1:' + port + '/tenant_authority';
    const deadline = Date.now() + 15000;
    let ready = false;
    do {
      try {
        docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'operator', '-d', 'tenant_authority']);
        ready = true;
      } catch (error) {
        if (error.status !== 1 && error.status !== 2) throw error;
        await sleep(100);
      }
    } while (!ready && Date.now() < deadline);
    assert.ok(ready, 'owned PostgreSQL must become responsive');
    assert.equal(docker(['inspect', '--format', '{{.State.Running}}', container]), 'true');

    await run('up', { direct: true, connectionString: adminURI, namespace: NAMESPACE, catalogue });
    await run('check', { direct: true, connectionString: adminURI, namespace: NAMESPACE, catalogue });
    admin = new Client({ connectionString: adminURI });
    await admin.connect();
    const appPassword = crypto.randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE ${appRole} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${appPassword}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${NAMESPACE}" TO ${appRole}`);
    await admin.query(`GRANT SELECT ON ${CONFIG}, ${ROLES}, ${SUBJECTS}, ${LINKS} TO ${appRole}`);
    const url = new URL(adminURI);
    url.username = appRole;
    url.password = appPassword;
    appURI = url.toString();

    await admin.query(`INSERT INTO ${CONFIG} (tenant_id, anonymous_roles) VALUES
      ($1, ARRAY['readable']), ($2, ARRAY['status-only']), ($3, ARRAY['denied'])`, [A, B, C]);
    await admin.query(`INSERT INTO ${ROLES} (tenant_id, name, permissions) VALUES
      ($1, 'uploader', ARRAY['api:entries:create']),
      ($1, 'readable', ARRAY['*']),
      ($2, 'uploader', ARRAY['api:treatments:create']),
      ($3, 'uploader', ARRAY['api:entries:create'])`, [A, B, C]);
    await admin.query(`INSERT INTO ${SUBJECTS} (tenant_id, subject_id) VALUES
      ($1, $2), ($3, $2), ($4, $2)`, [A, SUBJECT, B, C]);
    await admin.query(`INSERT INTO ${LINKS} (tenant_id, subject_id, role_name) VALUES
      ($1, $2, 'uploader'), ($3, $2, 'uploader'), ($4, $2, 'uploader')`, [A, SUBJECT, B, C]);

    first = await createTenantAuthorization({ connectionString: appURI, namespace: NAMESPACE });
    second = await createTenantAuthorization({ connectionString: appURI, namespace: NAMESPACE });
  });

  after(async function () {
    try {
      if (first) await first.close();
      if (second) await second.close();
      if (admin) await admin.end();
    } finally {
      scope.setTenancyMode(previousMode);
      if (owned) docker(['rm', '-f', '-v', container]);
    }
  });

  it('appends current display metadata without rewriting the applied candidate or inventing imported names', async function () {
    const namespace = NAMESPACE + '_names_upgrade';
    const options = { direct: true, connectionString: adminURI, namespace };
    const original = { version: 1, migrations: catalogue.migrations.slice(0, 1) };
    await run('up', { ...options, catalogue: original });
    await admin.query(`INSERT INTO "${namespace}".tenant_authorization_subjects VALUES ($1, $2)`, [A, SUBJECT]);
    const pending = await run('status', { ...options, catalogue });
    // Every candidate migration after the one applied is pending; read the
    // list from the catalogue so a new migration does not stale this test.
    assert.deepEqual(pending.pending, catalogue.migrations.slice(1).map(migration => migration.name));
    assert.ok(pending.pending.includes('0002_subject_display_name'));
    await assert.rejects(run('check', { ...options, catalogue }), { code: 'MIG_STALE' });
    await run('up', { ...options, catalogue });
    assert.equal((await run('check', { ...options, catalogue })).current, true);
    const row = (await admin.query(`SELECT subject_id, display_name
      FROM "${namespace}".tenant_authorization_subjects WHERE tenant_id = $1`, [A])).rows[0];
    assert.deepEqual(row, { subject_id: SUBJECT, display_name: null });
    const ledger = (await admin.query(`SELECT checksum FROM "${namespace}".schema_migrations
      WHERE name = '0001_tenant_authorization'`)).rows[0];
    assert.equal(ledger.checksum, original.migrations[0].checksum);
  });

  it('uses tenant anonymous defaults and enforces the no-anonymous-write floor', async function () {
    const anonymous = kind => Object.freeze({ kind });
    assert.equal(await first.authorize({ tenant: A, principal: anonymous('anonymous'), permission: 'api:entries:read' }), true);
    assert.equal(await first.authorize({ tenant: B, principal: anonymous('anonymous'), permission: 'api:status:read' }), true);
    assert.equal(await first.authorize({ tenant: B, principal: anonymous('anonymous'), permission: 'api:entries:read' }), false);
    assert.equal(await first.authorize({ tenant: C, principal: anonymous('anonymous'), permission: 'api:status:read' }), false);
    assert.equal(await first.authorize({ tenant: A, principal: anonymous('anonymous'), permission: 'api:entries:create' }), false);
    assert.equal(await first.authorize({ tenant: A, principal: anonymous('anonymous'), permission: 'api:entries:delete' }), false);
  });

  it('unions the tenant subject roles with configured defaults and isolates overlapping subject IDs', async function () {
    const subject = Object.freeze({ kind: 'subject', subjectId: SUBJECT });
    assert.equal(await first.authorize({ tenant: A, principal: subject, permission: 'api:entries:create' }), true);
    assert.equal(await first.authorize({ tenant: A, principal: subject, permission: 'api:treatments:create' }), false);
    assert.equal(await first.authorize({ tenant: A, principal: subject, permission: 'api:profile:read' }), true);
    assert.equal(await second.authorize({ tenant: B, principal: subject, permission: 'api:treatments:create' }), true);
    assert.equal(await second.authorize({ tenant: B, principal: subject, permission: 'api:entries:create' }), false);
    assert.equal(await first.authorize({ tenant: B, principal: subject, permission: 'api:entries:create' }), false);
    assert.equal(await first.authorize({ tenant: A, principal: Object.freeze({ kind: 'subject', subjectId: 'missing' }),
      permission: 'api:entries:create' }), false);
  });

  it('keeps trusted root distinct from uploader subjects and requires tenant configuration first', async function () {
    const root = Object.freeze({ kind: 'root' });
    const subject = Object.freeze({ kind: 'subject', subjectId: SUBJECT });
    assert.equal(await first.authorize({ tenant: A, principal: root, permission: 'api:treatments:delete' }), true);
    assert.equal(await first.authorize({ tenant: A, principal: subject, permission: 'api:treatments:delete' }), false);
    await assert.rejects(first.authorize({ tenant: '44444444-4444-4444-8444-444444444444',
      principal: root, permission: 'api:entries:read' }), { code: 'TENANT_AUTHORITY_UNKNOWN' });
    await assert.rejects(first.authorize({ tenant: A, principal: Object.freeze({ kind: 'root', subjectId: 'caller' }),
      permission: 'api:entries:read' }), { code: 'TENANT_AUTHORITY_PRINCIPAL_INVALID' });
  });

  it('observes committed role revocation and grant changes from an independent worker', async function () {
    const subject = Object.freeze({ kind: 'subject', subjectId: SUBJECT });
    const request = { tenant: C, principal: subject, permission: 'api:entries:create' };
    assert.equal(await first.authorize(request), true);
    assert.equal(await second.authorize(request), true);
    await admin.query(`DELETE FROM ${LINKS} WHERE tenant_id = $1 AND subject_id = $2`, [C, SUBJECT]);
    assert.equal(await second.authorize(request), false);
    await admin.query(`INSERT INTO ${LINKS} (tenant_id, subject_id, role_name) VALUES ($1, $2, 'uploader')`, [C, SUBJECT]);
    assert.equal(await first.authorize(request), true);
    await admin.query(`UPDATE ${ROLES} SET permissions = ARRAY['api:treatments:create']
      WHERE tenant_id = $1 AND name = 'uploader'`, [C]);
    assert.equal(await second.authorize(request), false);
  });

  it('refuses missing authority, invalid records, and cross-tenant role links', async function () {
    await assert.rejects(first.authorize({ tenant: '44444444-4444-4444-8444-444444444444',
      principal: Object.freeze({ kind: 'anonymous' }), permission: 'api:entries:read' }),
    { code: 'TENANT_AUTHORITY_UNKNOWN' });
    await assert.rejects(admin.query(`INSERT INTO ${LINKS} (tenant_id, subject_id, role_name) VALUES ($1, $2, 'uploader')`,
      [A, 'not-present']), /foreign key/i);

    await admin.query(`UPDATE ${ROLES} SET permissions = ARRAY['']
      WHERE tenant_id = $1 AND name = 'uploader'`, [C]);
    await assert.rejects(first.authorize({ tenant: C, principal: Object.freeze({ kind: 'subject', subjectId: SUBJECT }),
      permission: 'api:entries:create' }), { code: 'TENANT_AUTHORITY_INVALID' });
  });

  it('proves forced RLS hides foreign rows and disabling it exposes the negative-control row', async function () {
    const client = new Client({ connectionString: appURI });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [A]);
      const isolated = await client.query(`SELECT tenant_id::text FROM ${SUBJECTS}`);
      await client.query('COMMIT');
      assert.deepEqual(isolated.rows.map(row => row.tenant_id), [A]);

      await admin.query(`ALTER TABLE ${SUBJECTS} NO FORCE ROW LEVEL SECURITY`);
      await admin.query(`ALTER TABLE ${SUBJECTS} DISABLE ROW LEVEL SECURITY`);
      try {
        await assert.rejects(createTenantAuthorization({ connectionString: appURI, namespace: NAMESPACE }),
          { code: 'TENANT_AUTHORITY_UNSAFE' });
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [A]);
        const ablated = await client.query(`SELECT tenant_id::text FROM ${SUBJECTS} ORDER BY tenant_id`);
        await client.query('COMMIT');
        assert.deepEqual(ablated.rows.map(row => row.tenant_id), [A, B, C]);
      } finally {
        await admin.query(`ALTER TABLE ${SUBJECTS} ENABLE ROW LEVEL SECURITY`);
        await admin.query(`ALTER TABLE ${SUBJECTS} FORCE ROW LEVEL SECURITY`);
      }
    } finally {
      if (client) {
        try { await client.query('ROLLBACK'); } catch { /* The transaction may already have rolled back. */ }
        await client.end();
      }
    }
  });

  it('survives idle-connection termination and rejects the next authority query', async function () {
    await first.close();
    await second.close();
    await admin.end();
    first = null;
    second = null;
    admin = null;

    const childSource = `
      const scope = require('./lib/storage/tenant-scope');
      scope.setTenancyMode('multi');
      const create = require('./lib/tenant-authorization/postgres');
      (async () => {
        const authority = await create({ connectionString: process.env.AUTHORITY_DATABASE_URL,
          namespace: process.env.AUTHORITY_NAMESPACE });
        process.stdout.write('READY\\n');
        process.stdin.once('data', async () => {
          let exitCode = 0;
          try {
            const allowed = await authority.authorize({ tenant: process.env.AUTHORITY_TENANT,
              principal: { kind: 'anonymous' }, permission: 'api:entries:read' });
            process.stdout.write('UNEXPECTED_RESULT ' + allowed + '\\n');
            exitCode = 2;
          } catch (error) {
            if (error.code === 'TENANT_AUTHORITY_UNAVAILABLE') {
              process.stdout.write('REJECT ' + error.code + '\\n');
            } else {
              process.stdout.write('UNEXPECTED_REJECTION ' + error.code + '\\n');
              exitCode = 3;
            }
          } finally {
            try {
              await authority.close();
              process.stdout.write('POOL_CLOSED\\n');
            } catch (error) {
              process.stdout.write('POOL_CLOSE_FAILED ' + error.code + '\\n');
              exitCode = 4;
            }
            process.stdout.write('COMPLETE\\n', () => { process.exitCode = exitCode; });
          }
        });
      })().catch(error => {
        process.stderr.write('STARTUP_FAILURE ' + (error.code || error.name) + '\\n');
        process.exitCode = 2;
      });
    `;
    const child = spawn(process.execPath, ['-e', childSource], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUTHORITY_DATABASE_URL: appURI,
        AUTHORITY_NAMESPACE: NAMESPACE,
        AUTHORITY_TENANT: A
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '', exited = false, exitCode, exitSignal;
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
    });
    const waitFor = async (predicate, label, timeout = 10000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (predicate()) return;
        if (exited) throw new Error('child exited before ' + label + ': ' + stdout + stderr);
        await sleep(20);
      }
      throw new Error('timed out waiting for ' + label + ': ' + stdout + stderr);
    };
    try {
      await waitFor(() => stdout.includes('READY\n'), 'idle pool readiness');
      docker(['kill', container]);
      await waitFor(() => stderr.includes('PostgreSQL idle connection error:'),
        'repository pool idle-error handler');
      assert.match(stderr, /PostgreSQL idle connection error: Error/);
      assert.equal(exited, false, 'idle pool error must not crash the child process');
      child.stdin.end('GO\n');
      await waitFor(() => stdout.includes('REJECT TENANT_AUTHORITY_UNAVAILABLE'),
        'sanitized current-authority rejection');
      await waitFor(() => stdout.includes('POOL_CLOSED\n'), 'pool cleanup');
      await waitFor(() => stdout.includes('COMPLETE\n'), 'pool cleanup completion');
      await waitFor(() => exited, 'subprocess exit');
      assert.equal(exitCode, 0, 'child must exit cleanly: ' + stdout + stderr);
      assert.equal(exitSignal, null);
      assert.equal(stdout.includes('UNEXPECTED_RESULT'), false);
      assert.equal(stdout.includes('UNEXPECTED_REJECTION'), false);
      assert.equal(stdout.includes('POOL_CLOSE_FAILED'), false);
      assert.equal(stderr.includes('uncaughtException'), false);
      assert.equal(stderr.includes('Unhandled'), false);
    } finally {
      if (!exited) child.kill('SIGKILL');
    }
  });
});
