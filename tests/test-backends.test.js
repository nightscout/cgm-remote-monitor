'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const backends = require('./support/backends');

const ROOT = path.resolve(__dirname, '..');

// Runs `fn` with NS_TEST_BACKEND set to `value` (undefined unsets it), then
// restores it: the selector reads the environment on every call.
function withSelection (value, fn) {
  const saved = process.env.NS_TEST_BACKEND;
  if (value === undefined) delete process.env.NS_TEST_BACKEND; else process.env.NS_TEST_BACKEND = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.NS_TEST_BACKEND; else process.env.NS_TEST_BACKEND = saved;
  }
}

describe('NS_TEST_BACKEND, the test storage backend selection', function () {

  describe('the selector', function () {

    it('selects mongodb when unset or empty', function () {
      assert.equal(backends.selectedName({}), 'mongodb');
      assert.equal(backends.selectedName({ NS_TEST_BACKEND: '' }), 'mongodb');
      assert.equal(backends.selectedName({ NS_TEST_BACKEND: '  ' }), 'mongodb');
    });

    it('selects the backend NS_TEST_BACKEND names', function () {
      assert.equal(backends.selectedName({ NS_TEST_BACKEND: 'mongodb' }), 'mongodb');
      assert.equal(backends.selectedName({ NS_TEST_BACKEND: 'postgres' }), 'postgres');
      assert.equal(withSelection('postgres', () => backends.selected().name), 'postgres');
      assert.equal(withSelection(undefined, () => backends.selected().name), 'mongodb');
    });

    it('knows postgres and says why it cannot run yet', function () {
      const postgres = backends.selected({ NS_TEST_BACKEND: 'postgres' });
      assert.equal(postgres.available, false);
      assert.match(postgres.unavailableReason, /ST-PG/);
      assert.throws(() => postgres.collection({}, 'entries'), /not built/);
      assert.equal(backends.selected({}).available, true);
    });

    it('throws on an unknown name, a misspelling or a list, naming the known ones', function () {
      for (const value of ['postgre', 'Mongodb', 'mongo', 'mongodb,postgres', 'sqlite']) {
        assert.throws(() => backends.selectedName({ NS_TEST_BACKEND: value }), function (err) {
          assert.match(err.message, /Unknown NS_TEST_BACKEND/);
          assert.ok(err.message.includes(JSON.stringify(value)), err.message);
          assert.match(err.message, /mongodb, postgres/);
          return true;
        });
      }
    });
  });

  describe('the census of test files that reach storage', function () {

    const census = backends.census();

    it('names files that exist, once each, in order', function () {
      const all = census.interface.concat(Object.keys(census.mongodb));
      assert.deepEqual(all.filter(file => !fs.existsSync(path.join(ROOT, file))), []);
      assert.deepEqual(all.filter((file, i) => all.indexOf(file) !== i), []);
      assert.deepEqual(census.interface, census.interface.slice().sort());
      assert.deepEqual(Object.keys(census.mongodb), Object.keys(census.mongodb).sort());
    });

    it('gives every MongoDB-only file its reason', function () {
      for (const [file, reason] of Object.entries(census.mongodb)) {
        assert.match(reason, /^(by nature|by mechanism): \S/, file);
      }
    });

    // The run itself catches a file that reaches MongoDB from the test process
    // (tests/hooks.js). A child process is out of its sight, so a file that
    // hands a database setting to a child must be in the census, or listed
    // here with the reason its child reaches no database.
    it('includes every file that hands a database setting to a child process', function () {
      const noDatabase = {
        'tests/mongo-aws-compat.test.js': 'driver authentication against a stubbed connection'
        , 'tests/nightscout-cli.test.js': 'a planted URI on an .invalid host, to check redaction'
        , 'tests/read-contract.test.js': 'collection-name settings only; the child connects to nothing'
        , 'tests/write-intent.d-event.test.js': 'its only child is git grep over lib/; the database is used in-process'
      };
      const listed = new Set(census.interface.concat(Object.keys(census.mongodb), Object.keys(noDatabase)));
      const missing = fs.readdirSync(path.join(ROOT, 'tests')).filter(name => name.endsWith('.test.js'))
        .map(name => 'tests/' + name)
        .filter(file => file !== 'tests/' + path.basename(__filename))
        .filter(function (file) {
          const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
          return /\b(spawn|spawnSync|fork|execFile|execFileSync)\(/.test(source)
            && /storageURI|CUSTOMCONNSTR_mongo|MONGO_CONNECTION|MONGODB_URI/.test(source);
        })
        .filter(file => !listed.has(file));
      assert.deepEqual(missing, []);
    });

    it('decides per file and backend whether it runs', function () {
      const mongoOnly = Object.keys(census.mongodb)[0];
      const shared = census.interface[0];
      withSelection('mongodb', function () {
        assert.equal(backends.pendingReason(mongoOnly), null);
        assert.equal(backends.pendingReason(shared), null);
      });
      withSelection('postgres', function () {
        assert.match(backends.pendingReason(path.join(ROOT, mongoOnly)), /^MongoDB's own: by/);
        assert.match(backends.pendingReason(shared), /ST-PG/);
        assert.equal(backends.pendingReason('tests/not-in-the-census.test.js'), null);
      });
    });
  });

  // End to end, in a child mocha with the suite's own hooks and reporter, on a
  // fixture that declares its suites with describeForEachBackend and
  // describeMongoOnly.
  describe('a run', function () {
    this.timeout(20000);

    function run (value, fixture) {
      const env = Object.assign({}, process.env);
      if (value === undefined) delete env.NS_TEST_BACKEND; else env.NS_TEST_BACKEND = value;
      return spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'mocha', 'bin', 'mocha.js')
        , '--require', './tests/hooks.js', '--reporter', './scripts/execution-reporter.js'
        , '--fail-zero', '--exit', './tests/fixtures/' + (fixture || 'backend-selection') + '.fixture.js']
      , { cwd: ROOT, env, encoding: 'utf8', timeout: 20000 });
    }

    it('runs both suites under mongodb', function () {
      const result = run('mongodb');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /2 passing/);
      assert.doesNotMatch(result.stdout, /pending/);
    });

    it('reports both pending under postgres, each with its reason, and passes', function () {
      const result = run('postgres');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /0 passing/);
      assert.match(result.stdout, /2 pending/);
      assert.match(result.stdout, /\[pending on NS_TEST_BACKEND=postgres: no PostgreSQL storage backend/);
      assert.match(result.stdout, /\[pending on NS_TEST_BACKEND=postgres: MongoDB's own: by nature: fixture/);
    });

    it('fails under postgres when a file outside the census reaches MongoDB, though its tests pass', function () {
      const result = run('postgres', 'backend-unclassified');
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /1 passing/);
      assert.match(result.stdout + result.stderr,
        /reached MongoDB under NS_TEST_BACKEND=postgres but are not in tests\/support\/backend-census\.json: tests\/fixtures\/backend-unclassified\.fixture\.js/);
    });

    it('stops before any test on an unknown name', function () {
      const result = run('postgre');
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /Unknown NS_TEST_BACKEND "postgre"/);
      assert.doesNotMatch(result.stdout, /passing|pending/);
    });
  });
});
