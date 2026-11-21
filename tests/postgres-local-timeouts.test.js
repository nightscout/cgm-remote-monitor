'use strict';
// Actual pinned pg option parsing over a recording Pool; no native resources.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const ConnectionParameters = require('pg/lib/connection-parameters');
const parse = require('pg-connection-string').parse;
const URL = 'postgres://synthetic:synthetic@127.0.0.1/synthetic_test';
function fixture () {
  const pools = [];
  class Pool {
    constructor (options) { pools.push(options); }
    on () {}
    async query () { return { rows: [{ rolsuper: false, rolbypassrls: false }] }; }
    async end () {}
  }
  const filename = path.resolve(__dirname, '../lib/storage/postgres-connection.js'), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  loaded.require = name => name === 'pg' ? { Pool, Client: require('pg').Client } : original(name);
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  return { connect: loaded.exports, pools };
}
const registryOptions = connectionString => ({ connectionString, max: 2, connectionTimeoutMillis: 1000,
  query_timeout: 1000, statement_timeout: 5000, application_name: 'synthetic-registry' });
describe('explicit local PostgreSQL timeout precedence', function () {
  it('refuses ordinary URL timer overrides before constructing the registry-shaped pool', async function () {
    const good = new ConnectionParameters(registryOptions(URL));
    assert.equal(good.query_timeout, 1000); assert.equal(good.connect_timeout, 1);
    const malicious = URL + '?query_timeout=6000&connectionTimeoutMillis=6000';
    const bad = new ConnectionParameters(registryOptions(malicious));
    assert.equal(bad.query_timeout, '6000'); assert.equal(bad.connect_timeout, 6);
    assert.throws(() => assert.equal(bad.query_timeout, 1000), { code: 'ERR_ASSERTION' });
    const f = fixture(); let unexpected;
    try { await assert.rejects(async () => { unexpected = await f.connect(registryOptions(malicious)); }, { code: 'POSTGRES_LOCAL_TIMEOUT_OVERRIDE' }); }
    finally { if (unexpected) await unexpected.end(); }
    assert.equal(f.pools.length, 0);
  });
  it('rejects aliases, duplicate and encoded timer names with either explicit local timer', async function () {
    const queryStrings = ['query_timeout=6000', 'connectionTimeoutMillis=6000', 'connect_timeout=6000',
      '%71uery_timeout=6000', '%63onnectionTimeoutMillis=6000', 'connect%5ftimeout=6000',
      'query_timeout=1000&%71uery_timeout=6000', 'connectionTimeoutMillis=6000&connectionTimeoutMillis=1000'];
    for (const query of queryStrings) {
      const connectionString = URL + '?' + query;
      assert(Object.keys(parse(connectionString)).some(key => ['query_timeout', 'connectionTimeoutMillis', 'connect_timeout'].includes(key)));
      for (const timers of [{ query_timeout: 1000 }, { connectionTimeoutMillis: 1000 }]) {
        const f = fixture(); await assert.rejects(f.connect({ connectionString, ...timers }), { code: 'POSTGRES_LOCAL_TIMEOUT_OVERRIDE' });
        assert.equal(f.pools.length, 0);
      }
    }
  });
  it('preserves non-direct URL options, explicit SSL and hidden property descriptors', async function () {
    const f = fixture(), ssl = { rejectUnauthorized: true }, connectionString = URL + '?application_name=url-registry&statement_timeout=9000&options=-c%20search_path%3Dpg_catalog';
    const input = { ...registryOptions(connectionString), ssl };
    Object.defineProperty(input, 'password', { value: 'synthetic-hidden', enumerable: false, configurable: true });
    const password = Object.getOwnPropertyDescriptor(input, 'password');
    const store = await f.connect(input);
    try {
      const options = f.pools[0], actual = new ConnectionParameters(options), baseline = new ConnectionParameters(input);
      assert.equal(options.direct, undefined); assert.equal(options.connectionString, connectionString);
      assert.equal(options.ssl, ssl); assert.equal(options.application_name, 'synthetic-registry');
      assert.deepEqual(Object.getOwnPropertyDescriptor(options, 'password'), password);
      assert.deepEqual(Object.getOwnPropertyDescriptor(input, 'password'), password);
      assert.equal(actual.query_timeout, 1000); assert.equal(actual.connect_timeout, 1);
      assert.equal(actual.application_name, baseline.application_name); assert.equal(actual.application_name, 'url-registry');
      assert.equal(actual.statement_timeout, '9000'); assert.equal(actual.options, '-c search_path=pg_catalog'); assert.equal(actual.ssl, ssl);
    } finally { await store.end(); }
    const tls = await f.connect(registryOptions(URL + '?sslmode=verify-full'));
    try { assert.deepEqual(new ConnectionParameters(f.pools[1]).ssl, {}); } finally { await tls.end(); }
  });
  it('preserves URL timer behavior without explicit local timers and the driver socket form', async function () {
    const f = fixture(), connectionString = URL + '?query_timeout=6000&connectionTimeoutMillis=6000';
    const legacy = await f.connect({ connectionString });
    try {
      const actual = new ConnectionParameters(f.pools[0]); assert.equal(actual.query_timeout, '6000'); assert.equal(actual.connect_timeout, 6);
    } finally { await legacy.end(); }
    const socket = await f.connect({ connectionString: '/tmp/synthetic_socket query_timeout=6000', query_timeout: 1000 });
    try { assert.equal(new ConnectionParameters(f.pools[1]).query_timeout, 1000); } finally { await socket.end(); }
  });
});
