'use strict';

// covers: lib/storage/postgres-connection.js

// Census C-06: the per-process connection plan (connection-admission) and its
// cold-start queue are retired. A role's configured pool size is what bounds
// the PostgreSQL connections that pool opens. This control saturates one
// serving connection on real PostgreSQL (PLATFORM_TEST_PG or
// NS_TEST_POSTGRES_ADMIN_URI) and counts its backends. Removing the pool size
// from the constructed pool lets the backends exceed it (red).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');

describe('retired connection admission (census C-06)', function () {
  it('leaves no admission module or wrapper in the serving source', function () {
    const root = path.resolve(__dirname, '../lib');
    for (const file of ['storage/connection-admission.js', 'server/serve/cold-start-admission.js']) assert.equal(fs.existsSync(path.join(root, file)), false, file);
    const offenders = [];
    (function walk (dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (file.endsWith('.js') && /connection-admission|cold-start-admission/.test(fs.readFileSync(file, 'utf8'))) offenders.push(path.relative(root, file));
      }
    })(root);
    assert.deepEqual(offenders, []);
  });
});

const database = process.env.PLATFORM_TEST_PG || process.env.NS_TEST_POSTGRES_ADMIN_URI;
(database ? describe : describe.skip)('Native PostgreSQL: a serving pool never exceeds its configured size', function () {
  this.timeout(30000);
  const { Client } = require('pg');
  const scope = require('../lib/storage/tenant-scope');
  const id = crypto.randomBytes(5).toString('hex'), role = 'cpb_' + id, password = crypto.randomBytes(24).toString('hex');
  const application = 'nightscout-pool-bound-' + id, LIMIT = 3, CALLERS = 12;
  const TENANT = '11111111-1111-4111-8111-111111111111';
  let admin, previous;
  const address = () => { const url = new URL(database); url.username = role; url.password = password; return url.toString(); };
  function connection (mutate = source => source) {
    const filename = require.resolve('../lib/storage/postgres-connection'), loaded = new Module(filename, module);
    loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(mutate(fs.readFileSync(filename, 'utf8')), filename);
    return loaded.exports;
  }
  // Without the configured size the pool falls back to a larger one.
  const ignoreSize = source => {
    const needle = 'const pool = new Pool(poolOptions);';
    assert.equal(source.split(needle).length, 2, 'POOL_SIZE_CONTROL_SEAM_REQUIRED');
    return source.replace(needle, 'const pool = new Pool(poolOptions); pool.options.max = 64;');
  };
  before(async function () {
    previous = scope.getTenancyMode(); scope.setTenancyMode('multi');
    admin = new Client({ connectionString: database }); await admin.connect();
    await admin.query('CREATE ROLE ' + role + " LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '" + password + "'");
  });
  after(async function () {
    scope.setTenancyMode(previous);
    if (!admin) return;
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1', [role]);
    await admin.query('DROP ROLE IF EXISTS ' + role); await admin.end();
  });
  async function peak (mutate) {
    const store = await connection(mutate)({ connectionString: address(), max: LIMIT, connectionTimeoutMillis: 10000, application_name: application });
    let highest = 0, sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const count = Number((await admin.query('SELECT count(*) AS n FROM pg_stat_activity WHERE usename=$1 AND application_name=$2', [role, application])).rows[0].n);
        highest = Math.max(highest, count);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    })();
    try {
      const results = await Promise.all(Array.from({ length: CALLERS }, () => store.withTenant(TENANT, () => store.query('SELECT pg_sleep(0.15) AS slept'))));
      assert.equal(results.length, CALLERS, 'EVERY_CALLER_IS_SERVED');
    } finally { sampling = false; await sampler; await store.end(); }
    return highest;
  }
  it('serves every caller within the configured size; ignoring the size exceeds it (red)', async function () {
    const bounded = await peak();
    assert(bounded >= 1 && bounded <= LIMIT, 'POOL_BACKENDS_WITHIN_CONFIGURED_SIZE ' + bounded);
    const unbounded = await peak(ignoreSize);
    assert(unbounded > LIMIT, 'IGNORED_SIZE_MUST_EXCEED_LIMIT ' + unbounded);
    console.log('    CONTROL RED: pool size ignored, peak backends ' + unbounded + ' > ' + LIMIT);
    const restored = await peak();
    assert(restored <= LIMIT);
    console.log('    CONTROL RESTORED: peak backends ' + restored + ' <= ' + LIMIT + ' with ' + CALLERS + ' concurrent callers');
  });
});
