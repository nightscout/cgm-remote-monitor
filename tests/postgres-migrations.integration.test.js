'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { run } = require('../lib/migrations/postgres');
const { checksum } = require('../lib/migrations/catalogue');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const catalogue = (...steps) => ({
  version: 1,
  migrations: steps.map((up, i) => ({ name: String(i + 1).padStart(4, '0') + '_test', up, checksum: checksum(up) }))
});

// Opt-in: these tests own a disposable container, loopback-only random port,
// random credentials, no persistent volume, and remove precisely that resource.
(process.env.NS_MIGRATION_DOCKER_TEST === '1' ? describe : describe.skip)('operator PostgreSQL migrations (disposable Docker)', function () {
  this.timeout(30000);
  const name = 'ns-migration-test-' + crypto.randomBytes(8).toString('hex');
  let observer;
  let connectionString;
  let owned = false;
  let sequence = 0;
  const opts = cat => ({ direct: true, connectionString, namespace: 'test_' + (++sequence), catalogue: cat });

  async function eventually (fn, timeout = 10000) {
    const deadline = Date.now() + timeout;
    do {
      if (await fn()) return;
      await sleep(25);
    } while (Date.now() < deadline);
    throw new Error('test condition did not become true before deadline');
  }

  async function sleepingMigration () {
    const state = await observer.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'nightscout-operator-migrations' AND wait_event = 'PgSleep'");
    return state.rows[0].n > 0;
  }

  before(async function () {
    const password = crypto.randomBytes(24).toString('hex');
    execFileSync('docker', ['run', '--rm', '--name', name, '-d', '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_USER=operator', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=migrations', 'postgres:16'],
    { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
    owned = true;
    const port = docker(['port', name, '5432/tcp']).split(':').pop();
    connectionString = 'postgres://operator:' + password + '@127.0.0.1:' + port + '/migrations';
    await eventually(async () => {
      const status = docker(['inspect', '--format', '{{.State.Running}}', name]);
      assert.equal(status, 'true');
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'operator', '-d', 'migrations']); return true; } catch (error) {
        if (error.status !== 1 && error.status !== 2) throw error;
        return false;
      }
    });
    observer = new Client({ connectionString });
    await observer.connect();
    assert.equal((await observer.query('SELECT current_database() AS db')).rows[0].db, 'migrations');
  });

  after(async function () {
    try { if (observer) await observer.end(); } finally {
      if (owned) docker(['rm', '-f', name]);
    }
  });

  it('status/check are read-only even before the namespace and ledger exist', async function () {
    const o = opts(catalogue(['CREATE TABLE sample (id integer)']));
    const status = await run('status', o);
    assert.deepEqual(status, { current: false, applied: [], pending: ['0001_test'] });
    await assert.rejects(run('check', o), /schema is stale/);
    const result = await observer.query('SELECT to_regnamespace($1) AS schema', [o.namespace]);
    assert.equal(result.rows[0].schema, null);
  });

  it('runs the actual operator CLI with only an explicitly injected test catalogue', function () {
    const namespace = 'test_' + (++sequence);
    const flags = ['--backend', 'postgres', '--namespace', namespace,
      '--catalogue', 'tests/fixtures/migrations/operator-test.json', '--connection-env', 'NS_OPERATOR_TEST_URL', '--direct'];
    const cli = action => spawnSync(process.execPath, ['bin/nightscout.js', 'migrate', action, ...flags], {
      cwd: require('node:path').resolve(__dirname, '..'),
      env: { ...process.env, NS_OPERATOR_TEST_URL: connectionString },
      encoding: 'utf8',
      timeout: 15000
    });
    const stale = cli('status');
    assert.equal(stale.status, 1, stale.stderr);
    assert.deepEqual(JSON.parse(stale.stdout).pending, ['0001_cli_fixture']);
    const applied = cli('up');
    assert.equal(applied.status, 0, applied.stderr);
    assert.deepEqual(JSON.parse(applied.stdout).done, ['0001_cli_fixture']);
    const check = cli('check');
    assert.equal(check.status, 0, check.stderr);
    assert.equal(JSON.parse(check.stdout).current, true);
    assert.doesNotMatch(stale.stdout + stale.stderr + applied.stdout + applied.stderr + check.stdout + check.stderr,
      /postgres:\/\/|password|127\.0\.0\.1/);
  });

  it('does not silently inherit ambient application or PG connection configuration', async function () {
    const variables = {
      DATABASE_URL: 'postgres://wrong:wrong@127.0.0.1:1/wrong',
      PGHOST: 'wrong.invalid', PGPORT: '1', PGUSER: 'wrong', PGPASSWORD: 'wrong', PGDATABASE: 'wrong',
      PGSSLMODE: 'require', PGSSLNEGOTIATION: 'direct', PGCLIENTENCODING: 'LATIN1',
      PGOPTIONS: '-c default_transaction_read_only=on'
    };
    const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
    try {
      Object.assign(process.env, variables);
      assert.equal((await run('up', opts(catalogue(['CREATE TABLE explicit (id integer)'])))).current, true);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('serializes overlapping runners, commits exactly once and accepts current schema', async function () {
    const o = opts(catalogue(['CREATE TABLE events (id integer)'], ['INSERT INTO events SELECT 1 FROM pg_sleep(0.5)']));
    const first = run('up', o);
    await eventually(sleepingMigration);
    const states = await Promise.all([first, run('up', o), run('up', o), run('up', o)]);
    assert.deepEqual(states.map(s => s.done.length).sort(), [0, 0, 0, 2]);
    assert.equal((await observer.query('SELECT count(*)::int AS n FROM "' + o.namespace + '".events')).rows[0].n, 1);
    assert.equal((await observer.query('SELECT count(*)::int AS n FROM "' + o.namespace + '".schema_migrations')).rows[0].n, 2);
    assert.equal((await run('check', o)).current, true);
  });

  it('has a bounded lock wait and leaves the lock holder unaffected', async function () {
    const o = opts(catalogue(['CREATE TABLE events AS SELECT 1 AS id FROM pg_sleep(0.5)']));
    const first = run('up', o);
    await eventually(sleepingMigration);
    await assert.rejects(run('up', { ...o, waitMs: 40 }), /lock deadline/);
    assert.equal((await first).current, true);
    assert.deepEqual((await run('up', o)).done, []);
  });

  it('rolls failed DDL and ledger back together and resumes without rewriting prior history', async function () {
    const o = opts(catalogue(['CREATE TABLE good (id integer)'],
      ['CREATE TABLE rolled_back (id integer)', 'INSERT INTO absent VALUES (1)']));
    await assert.rejects(run('up', o), /Migration .* failed/);
    assert.equal((await observer.query('SELECT to_regclass($1) AS t', [o.namespace + '.rolled_back'])).rows[0].t, null);
    assert.deepEqual((await run('status', o)).applied, ['0001_test']);
    const repaired = { ...o, catalogue: catalogue(['CREATE TABLE good (id integer)'], ['CREATE TABLE rolled_back (id integer)']) };
    assert.deepEqual((await run('up', repaired)).done, ['0002_test']);
  });

  it('refuses multi-statement transaction escape and rolls back its first statement', async function () {
    const o = opts(catalogue(['CREATE TABLE escaped (id integer); COMMIT']));
    await assert.rejects(run('up', o), /Migration .* failed/);
    assert.equal((await observer.query('SELECT to_regclass($1) AS t', [o.namespace + '.escaped'])).rows[0].t, null);
    assert.deepEqual((await run('status', o)).applied, []);
  });

  it('refuses applied checksum drift and unknown history on both inspection and mutation', async function () {
    const o = opts(catalogue(['CREATE TABLE sample (id integer)']));
    await run('up', o);
    const drift = { ...o, catalogue: catalogue(['CREATE TABLE sample (id bigint)']) };
    for (const action of ['status', 'check', 'up']) await assert.rejects(run(action, drift), /checksum drift/);
    await observer.query('INSERT INTO "' + o.namespace + '".schema_migrations (name, checksum) VALUES ($1, $2)', ['9999_unknown', '0'.repeat(64)]);
    for (const action of ['status', 'check', 'up']) await assert.rejects(run(action, o), /unknown/);
  });

  it('refuses non-prefix ledger history instead of applying migrations out of order', async function () {
    const o = opts(catalogue(['CREATE TABLE first (id integer)'], ['CREATE TABLE second (id integer)']));
    await run('up', o);
    await observer.query('DELETE FROM "' + o.namespace + '".schema_migrations WHERE name = $1', ['0001_test']);
    await assert.rejects(run('check', o), /catalogue prefix/);
    await assert.rejects(run('up', o), /catalogue prefix/);
  });

  it('survives SIGKILL mid-migration without committed DDL or ledger, then restarts', async function () {
    const o = opts(catalogue(['CREATE TABLE killed (id integer)', 'INSERT INTO killed SELECT 1 FROM pg_sleep(1)']));
    const script = "require('./lib/migrations/postgres').run('up', JSON.parse(process.env.NS_TEST_MIGRATION_OPTIONS)).then(() => process.exit(0), () => process.exit(1))";
    const child = spawn(process.execPath, ['-e', script], {
      cwd: require('node:path').resolve(__dirname, '..'),
      env: { ...process.env, NS_TEST_MIGRATION_OPTIONS: JSON.stringify(o) },
      stdio: 'ignore'
    });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    try {
      await eventually(sleepingMigration);
      child.kill('SIGKILL');
      assert.equal((await exited).signal, 'SIGKILL');
      await eventually(async () => !(await sleepingMigration()));
      const state = await run('status', o);
      assert.deepEqual(state.applied, []);
      assert.equal((await observer.query('SELECT to_regclass($1) AS t', [o.namespace + '.killed'])).rows[0].t, null);
      assert.equal((await run('up', o)).current, true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  });

  it('control: a split schema/ledger commit really can leave committed unrecorded DDL', async function () {
    const o = opts(catalogue(['CREATE TABLE orphan (id integer)']));
    // Initialize only the ledger using a deliberately failed test migration.
    const failure = { ...o, catalogue: catalogue(['INSERT INTO absent VALUES (1)']) };
    await assert.rejects(run('up', failure));
    await observer.query('CREATE TABLE "' + o.namespace + '".orphan (id integer)');
    assert.notEqual((await observer.query('SELECT to_regclass($1) AS t', [o.namespace + '.orphan'])).rows[0].t, null);
    assert.deepEqual((await run('status', o)).applied, []);
    // This is the unsafe split that the runner's shared transaction prevents.
    await assert.rejects(run('up', o), /Migration .* failed/);
  });

  it('allows a SELECT-only compatibility identity, and rejects its mutation attempt', async function () {
    const o = opts(catalogue(['CREATE TABLE sample (id integer)']));
    await run('up', o);
    const password = crypto.randomBytes(24).toString('hex');
    const role = 'reader_' + crypto.randomBytes(8).toString('hex');
    await observer.query('CREATE ROLE "' + role + '" LOGIN PASSWORD \'' + password + '\'');
    await observer.query('GRANT USAGE ON SCHEMA "' + o.namespace + '" TO "' + role + '"');
    await observer.query('GRANT SELECT ON "' + o.namespace + '".schema_migrations TO "' + role + '"');
    const url = new URL(connectionString);
    url.username = role;
    url.password = password;
    const reader = { ...o, connectionString: url.toString() };
    assert.equal((await run('check', reader)).current, true);
    await assert.rejects(run('up', reader), /permission denied/);
    assert.equal((await run('check', reader)).current, true);
  });
});
