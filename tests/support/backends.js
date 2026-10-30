'use strict';

// Which storage backend the tests run against.
//
//   NS_TEST_BACKEND unset or empty   mongodb, exactly the runs there were before
//   NS_TEST_BACKEND=mongodb          the same
//   NS_TEST_BACKEND=postgres         known, not built until ST-PG: every test that
//                                    reaches storage is reported pending, with
//                                    the reason in its title
//   anything else                    throws when this module loads, so the run
//                                    stops before any test (a typo must never
//                                    shrink the suite)
//
// One backend per run; a CI matrix runs each as its own job.
//
// Which test files reach storage is recorded in ./backend-census.json, in two
// classes:
//   - "interface": the behaviour is the storage interface's, so the file runs
//     against any backend that is built, and is pending on one that is not;
//   - "mongodb": MongoDB's own, by nature (the driver, its pool, retry, URI
//     grammar, wire version) or by mechanism (the proof counts MongoDB wire
//     commands), with the reason for each file. Pending on any other backend.
// A new test file can instead say it in the file, with describeForEachBackend
// or describeMongoOnly below.
//
// The visibility contract: a backend that cannot run produces pending tests,
// never absent ones. Pending suites use describe.skip, which still evaluates
// the suite body, so every test inside is registered and reported. Under a
// selection without mongodb, a test file that reaches MongoDB but is not in
// the census is refused the connection, and the run fails at the end naming
// the file (tests/hooks.js), even if the file's own tests passed without it:
// a run under another backend's name never quietly passes against MongoDB.

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_BACKEND = 'mongodb';
const MARK = 'NS_TEST_BACKEND=';

function unbuilt (backend, method) {
  return function () {
    throw new Error('Backend "' + backend + '" has no ' + method + '(): it is not built yet.');
  };
}

const REGISTRY = Object.freeze({
  mongodb: Object.freeze({
    name: 'mongodb'
    , available: true
    , unavailableReason: null
    // The handle fixtures insert into and delete from, past the interface.
    , collection (ctx, name) { return ctx.store.collection(name); }
    // A stored document exactly as the backend holds it, for byte comparisons.
    , async storedDocument (ctx, name, query) {
      return ctx.store.collection(name).findOne(query, { raw: true });
    }
  })
  , postgres: Object.freeze({
    name: 'postgres'
    , available: false
    , unavailableReason: 'no PostgreSQL storage backend is built until ST-PG '
      + '(lib/server/storage-backends.js has mongodb only)'
    , collection: unbuilt('postgres', 'collection')
    , storedDocument: unbuilt('postgres', 'storedDocument')
  })
});

function knownNames () {
  return Object.keys(REGISTRY);
}

/**
 * The backend this run selects. Throws on anything but one known name.
 * @param {Object} [env] process.env by default
 */
function selectedName (env) {
  const raw = (env || process.env).NS_TEST_BACKEND;
  const value = raw === undefined || raw === null ? '' : String(raw).trim();
  if (value === '') return DEFAULT_BACKEND;
  if (!Object.prototype.hasOwnProperty.call(REGISTRY, value)) {
    throw new Error('Unknown NS_TEST_BACKEND "' + value + '". Known backends: '
      + knownNames().join(', ') + ' (one per run). Refusing to run: an unrecognised '
      + 'backend must stop the run, not skip the storage tests.');
  }
  return value;
}

function selected (env) {
  return REGISTRY[selectedName(env)];
}

function pendingTitle (title, reason) {
  return title + ' [pending on ' + MARK + selectedName() + ': ' + reason + ']';
}

/**
 * A suite about the storage interface: runs against the selected backend when
 * it is built, and is pending with the backend's reason when it is not. The
 * body gets the backend, with this bound to the mocha suite.
 */
function describeForEachBackend (title, body) {
  const backend = selected();
  if (backend.available) {
    return describe(title + ' [backend: ' + backend.name + ']', function () { body.call(this, backend); });
  }
  return describe.skip(pendingTitle(title, backend.unavailableReason), function () { body.call(this, backend); });
}

/**
 * A suite that is MongoDB's own. Plain describe, title untouched, when mongodb
 * is selected; pending with the reason otherwise.
 * @param {string} title
 * @param {string} reason why this is MongoDB's own
 * @param {Function} body
 */
function describeMongoOnly (title, reason, body) {
  if (typeof reason !== 'string' || !reason) throw new TypeError('describeMongoOnly needs the reason the suite is MongoDB\'s own');
  if (selectedName() === 'mongodb') return describe(title, body);
  return describe.skip(pendingTitle(title, 'MongoDB\'s own: ' + reason), body);
}

function census () {
  return require('./backend-census.json');
}

function relative (file) {
  return path.relative(ROOT, path.resolve(file)).split(path.sep).join('/');
}

/**
 * Why a test file is pending under this run's backend, or null if it runs.
 * @param {string} file
 */
function pendingReason (file) {
  const backend = selected();
  const name = relative(file);
  const entries = census();
  if (Object.prototype.hasOwnProperty.call(entries.mongodb, name)) {
    return backend.name === 'mongodb' ? null : 'MongoDB\'s own: ' + entries.mongodb[name];
  }
  if (entries.interface.includes(name)) return backend.available ? null : backend.unavailableReason;
  return null;
}

/** Whether a reported test is pending because of the backend selection. */
function isBackendPending (test) {
  return typeof test.fullTitle === 'function' && test.fullTitle().includes('[pending on ' + MARK);
}

// The top-level suites of a census file become pending suites carrying the
// reason. Nested suites are left to inherit it, so the reason appears once.
function wrapSuites (context, file) {
  const reason = pendingReason(file);
  if (reason === null) return;
  let depth = 0;
  const original = context.describe;
  function pending (title, fn) {
    if (depth > 0) return original(title, fn);
    depth++;
    try {
      return original.skip(pendingTitle(title, reason), fn);
    } finally {
      depth--;
    }
  }
  pending.skip = pending;
  pending.only = pending;
  context.describe = context.context = pending;
  const it = context.it;
  // A test outside any suite is pending too.
  function pendingTest (title) {
    return depth > 0 ? it.apply(this, arguments) : it.skip(pendingTitle(title, reason));
  }
  pendingTest.skip = it.skip;
  pendingTest.only = pendingTest;
  context.it = context.specify = pendingTest;
}

let installed = false;
// Under a selection without mongodb: the test file running now, and the files
// outside the census that tried to reach MongoDB.
let running = null;
const reachedMongo = new Set();

/** Test files outside the census that reached MongoDB in this run. */
function unclassifiedReached () {
  return Array.from(reachedMongo).sort();
}

/**
 * Called once from tests/hooks.js. Validates NS_TEST_BACKEND (throwing on an
 * unknown name before any test file loads); under mongodb it does nothing
 * else, so the default run is unchanged. Under any other backend it applies
 * the census to each test file as mocha loads it, and makes a connection to
 * MongoDB from a file outside the census fail.
 */
function install () {
  const backend = selected();
  if (installed || backend.name === 'mongodb') return backend;
  installed = true;

  const Mocha = require('mocha');
  const bdd = Mocha.interfaces.bdd;
  Mocha.interfaces.bdd = function censusBdd (suite) {
    bdd(suite);
    suite.on('pre-require', function (context, file) { wrapSuites(context, file); });
    // Each top-level suite says which file is running, so a refused connection
    // can be charged to it.
    suite.on('post-require', function (context, file) {
      for (const child of suite.suites) {
        if (child.file !== file || child.nsBackendTracked) continue;
        child.nsBackendTracked = true;
        child.beforeAll(function () { running = relative(file); });
        child.afterAll(function () { running = null; });
      }
    });
  };

  const { MongoClient } = require('mongodb');
  MongoClient.prototype.connect = function refused () {
    reachedMongo.add(running || '(outside any suite)');
    return Promise.reject(new Error('A test reached MongoDB under ' + MARK + backend.name
      + ' from a file that is not in tests/support/backend-census.json. Add it as '
      + '"interface" or, with the reason, as "mongodb".'));
  };
  return backend;
}

module.exports = {
  DEFAULT_BACKEND
  , REGISTRY
  , knownNames
  , selectedName
  , selected
  , describeForEachBackend
  , describeMongoOnly
  , pendingReason
  , isBackendPending
  , census
  , install
  , unclassifiedReached
};
