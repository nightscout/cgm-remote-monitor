'use strict';

// Real pg.Pool and PostgreSQL transaction code over a recording synthetic driver.
// No listener, native database, timer benchmark or external credential is used.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const pg = require('pg');
const scope = require('../lib/storage/tenant-scope');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
function load (file, replacements, mutate = value => value) {
  const loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const original = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(replacements, name) ? replacements[name] : original(name);
  loaded._compile(mutate(fs.readFileSync(file, 'utf8')), file);
  return loaded.exports;
}
async function fixture (mutate) {
  const calls = [], durable = [], clients = [], records = new Map([
    [A, { tenant: A, id: 'root', format: 1, ciphertext: 'synthetic-A' }],
    [B, { tenant: B, id: 'root', format: 1, ciphertext: 'synthetic-B' }]
  ]);
  let action = async () => {};
  class Client extends EventEmitter {
    constructor () { super(); this.processID = 100 + clients.length; this._queryable = true; this._ending = false; this.receipts = []; clients.push(this); }
    connect (done) { queueMicrotask(() => done(null)); }
    query (input, values, done) {
      if (typeof values === 'function') { done = values; values = undefined; }
      const text = typeof input === 'string' ? input : input.text;
      values = typeof input === 'object' ? input.values : values;
      const execute = async () => {
        calls.push({ text, values, pid: this.processID });
        await action(this, text, values);
        if (text.includes('FROM pg_roles')) return { rows: [{ rolsuper: false, rolbypassrls: false }] };
        if (text.includes('FROM pg_class')) return { rows: [
          { secured: true, owns: false, inserts: true, reads: true, column_reads: true, is_records: true, mutates: false, update_columns: [] },
          { secured: true, owns: false, inserts: true, reads: false, column_reads: false, is_records: false, mutates: false, update_columns: [] }
        ] };
        if (text === 'BEGIN') this.receipts = [];
        if (text.includes('INSERT INTO "synthetic_secrets".secret_audit')) {
          assert(!text.includes('RETURNING'), 'audit read must not require SELECT on receipts');
          for (let offset = 0; offset < values.length; offset += 9) this.receipts.push(values.slice(offset, offset + 9));
        }
        if (text === 'COMMIT') { durable.push(...this.receipts); this.receipts = []; }
        if (text === 'ROLLBACK') this.receipts = [];
        if (text.includes('SELECT tenant_id AS tenant, id, format, ciphertext')) {
          const row = records.get(text.startsWith('WITH receipt') ? values[1] : values[0]);
          const id = text.startsWith('WITH receipt') ? values[5] : values[1];
          return { rows: row && row.id === id ? [row] : [] };
        }
        return { rows: [], command: text.split(' ')[0], rowCount: 1 };
      };
      if (done) { execute().then(value => done(null, value), done); return; }
      return execute();
    }
    end (done) { this._ending = true; this.emit('end'); if (done) queueMicrotask(done); }
  }
  class Pool extends pg.Pool { constructor (options) { super({ ...options, Client, idleTimeoutMillis: 0 }); } }
  const connection = load(require.resolve('../lib/storage/postgres-connection'), { pg: { ...pg, Pool, Client } });
  const create = load(require.resolve('../lib/secrets/postgres'), { '../storage/postgres-connection': connection }, mutate).createPostgresSecrets;
  const persistence = await create({ connectionString: 'postgres://synthetic:synthetic@127.0.0.1/synthetic_test', namespace: 'synthetic_secrets' });
  calls.length = 0;
  return { persistence, calls, durable, records, clients, action: value => { action = value; }, close: () => persistence.close() };
}
function event (tenant = A) { return { tenant, principal: 'api', consumer: 'data', operation: 'decrypt', id: 'root', phase: 'authorized', time: 1000 }; }
function budget (f) {
  return { begins: f.calls.filter(call => call.text === 'BEGIN').length,
    commits: f.calls.filter(call => call.text === 'COMMIT').length,
    durableSettings: f.calls.filter(call => call.text === "SET LOCAL synchronous_commit = 'on'").length };
}
function component (f) {
  const secret = 'synthetic-root-secret';
  const calls = { authority: 0, authorize: 0, provider: 0, decrypt: 0 };
  let current = { reference: { tenant: A, id: 'root' }, subjects: [] };
  const secrets = require('../lib/secrets/component').createSecrets({
    ...f.persistence,
    store: { ...f.persistence.store, get () { throw new Error('Separate secret checkout must not run'); } },
    audit () { throw new Error('Separate receipt checkout must not run'); },
    maxTokenLifetimeSeconds: 28800, now: () => 1000,
    legacyAuthorityFor: async () => { calls.authority++; return current; },
    authorize: async (identity, action, authority) => {
      calls.authorize++;
      return authority === current && identity.tenant === current.reference.tenant && action.id === current.reference.id;
    },
    providerFor: async () => {
      calls.provider++;
      return { decrypt: async () => {
        calls.decrypt++;
        assert(f.durable.length > 0, 'CRYPTO_REQUIRES_DURABLE_RECEIPT');
        return Buffer.from(JSON.stringify({ tenant: A, id: 'root', data: Buffer.from(secret).toString('base64') }));
      } };
    }
  });
  return { secrets, calls, context: { tenant: A, principal: 'api', consumer: 'data' },
    credential: { apiSecret: require('node:crypto').createHash('sha1').update(secret).digest('hex') },
    authority: value => { current = value; } };
}
describe('durable secret audit and record read', function () {
  let previous;
  beforeEach(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(previous));
  it('uses one physical transaction and does not expose the selected record before receipt COMMIT', async function () {
    const f = await fixture(); let entered, release;
    const committing = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    try {
      f.action(async (client, text) => { if (text === 'COMMIT') { entered(); await blocked; } });
      let published = false;
      const pending = f.persistence.auditRead(event()).then(record => { published = true; return record; });
      await committing;
      assert.equal(published, false); assert.equal(f.durable.length, 0);
      release(); assert.deepEqual(await pending, f.records.get(A));
      assert.equal(f.durable.length, 1); assert.deepEqual(budget(f), { begins: 1, commits: 1, durableSettings: 1 });
      assert.equal(new Set(f.calls.map(call => call.pid)).size, 1);
      const statement = f.calls.find(call => call.text.startsWith('WITH receipt'));
      assert.equal(statement.values[1], A); assert.equal(statement.values[5], 'root');
      assert(!statement.values.includes('synthetic-A'), 'receipt payload must not contain ciphertext');
    } finally { release(); await f.close(); }
  });
  it('retains a durable receipt even when the selected record does not exist', async function () {
    const f = await fixture();
    try { f.records.delete(A); assert.equal(await f.persistence.auditRead(event()), undefined); assert.equal(f.durable.length, 1); }
    finally { await f.close(); }
  });
  it('reads fresh selected tenant records without reusing another tenant or stale ciphertext', async function () {
    const f = await fixture();
    try {
      const results = await Promise.all([A, B].map(tenant => f.persistence.auditRead(event(tenant))));
      assert.deepEqual(results.map(row => row.tenant), [A, B]);
      f.records.set(A, { ...f.records.get(A), ciphertext: 'synthetic-A-rotated' });
      assert.equal((await f.persistence.auditRead(event())).ciphertext, 'synthetic-A-rotated');
      assert.equal(f.durable.length, 3);
    } finally { await f.close(); }
  });
  it('refuses invalid fields and non-read operations before opening a transaction', async function () {
    const f = await fixture();
    try {
      for (const bad of [{ ...event(), plaintext: 'forbidden' }, { ...event(), phase: 'released' },
        { ...event(), time: -1 }, { ...event(), operation: 'encrypt' }, { ...event(), operation: 'sign', id: undefined }]) {
        await assert.rejects(f.persistence.auditRead(bad), TypeError);
      }
      assert.equal(f.calls.length, 0); assert.equal(f.durable.length, 0);
    } finally { await f.close(); }
  });
  it('withholds records and redacts driver detail when INSERT or COMMIT fails', async function () {
    for (const stage of ['WITH receipt', 'COMMIT']) {
      const f = await fixture();
      try {
        f.action(async (client, text) => { if (text.startsWith(stage)) throw new Error('sensitive synthetic driver detail'); });
        await assert.rejects(f.persistence.auditRead(event()), error => error.code === 'SECRETS_STORE_UNAVAILABLE' && !error.message.includes('sensitive'));
        assert.equal(f.durable.length, 0); assert(f.calls.some(call => call.text === 'ROLLBACK'));
      } finally { await f.close(); }
    }
  });
  // Root custody reads (admin-tools token listing) compose the fused receipt; the
  // Vault-backed DATA verifier that also used it is retired (deployment-signing-secret).
  it('composes root custody with the fused receipt and decrypts only after physical COMMIT', async function () {
    const f = await fixture(), c = component(f); let entered, release;
    const committing = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    try {
      f.action(async (client, text) => { if (text === 'COMMIT') { entered(); await blocked; } });
      const pending = c.secrets.rootLegacyTokens(c.context, c.credential);
      await committing;
      assert.deepEqual(c.calls, { authority: 1, authorize: 1, provider: 0, decrypt: 0 });
      release(); assert.ok(await pending instanceof Map, 'the root secret was verified after the decrypt');
      assert.deepEqual(c.calls, { authority: 1, authorize: 1, provider: 1, decrypt: 1 });
      assert.deepEqual(budget(f), { begins: 1, commits: 1, durableSettings: 1 });
      assert.equal(f.durable.length, 1);
      assert.equal(f.calls.filter(call => call.text.startsWith('SELECT tenant_id AS tenant')).length, 0, 'NO_SEPARATE_RECORD_CHECKOUT');
    } finally { release(); await f.close(); }
  });
  it('never starts a provider effect when the composed audit COMMIT fails', async function () {
    const f = await fixture(), c = component(f);
    try {
      f.action(async (client, text) => { if (text === 'COMMIT') throw new Error('synthetic commit failure'); });
      await assert.rejects(c.secrets.rootLegacyTokens(c.context, c.credential), { code: 'SECRETS_STORE_UNAVAILABLE' });
      assert.equal(c.calls.provider, 0); assert.equal(c.calls.decrypt, 0); assert.equal(f.durable.length, 0);
    } finally { await f.close(); }
  });
  it('re-reads current legacy references and refuses reference or stored-record identity mismatches', async function () {
    const f = await fixture(), c = component(f);
    try {
      c.authority({ reference: { tenant: B, id: 'root' }, subjects: [] });
      await assert.rejects(c.secrets.rootLegacyTokens(c.context, c.credential), { code: 'SECRETS_REFERENCE_MISMATCH' });
      assert.equal(f.calls.length, 0); assert.equal(c.calls.decrypt, 0);
      c.authority({ reference: { tenant: A, id: 'root' }, subjects: [] });
      f.records.set(A, { ...f.records.get(A), tenant: B });
      await assert.rejects(c.secrets.rootLegacyTokens(c.context, c.credential), { code: 'SECRETS_RECORD_INVALID' });
      assert.equal(c.calls.authority, 2); assert.equal(c.calls.decrypt, 0); assert.equal(f.durable.length, 1);
      c.authority({ reference: { tenant: A, id: 'replacement' }, subjects: [] });
      await assert.rejects(c.secrets.rootLegacyTokens(c.context, c.credential), { code: 'SECRETS_NOT_FOUND' });
      assert.equal(c.calls.authority, 3); assert.equal(c.calls.decrypt, 0); assert.equal(f.durable.length, 2);
    } finally { await f.close(); }
  });
  it('control: separate durable audit then get violates the single-transaction cost budget', async function () {
    const f = await fixture();
    try {
      await f.persistence.audit(event()); await f.persistence.store.get(A, 'root');
      assert.deepEqual(budget(f), { begins: 2, commits: 2, durableSettings: 2 }, 'CONTROL_WAS_EXERCISED');
      assert.throws(() => assert.deepEqual(budget(f), { begins: 1, commits: 1, durableSettings: 1 }, 'AUDIT_READ_ONE_TRANSACTION'));
      assert.equal(f.durable.length, 1);
    } finally { await f.close(); }
  });
  it('control: removing the receipt INSERT is detected by the durable-effect oracle', async function () {
    const f = await fixture(source => {
      const original = "'WITH receipt AS (' + insert.text +";
      assert(source.includes(original));
      return source.replace(original, "'WITH receipt AS (SELECT $1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::text,$7::text,$8::bigint,$9::bigint' +");
    });
    try {
      assert.equal((await f.persistence.auditRead(event())).tenant, A);
      assert.equal(f.durable.length, 0, 'CONTROL_WAS_EXERCISED');
      assert.throws(() => assert.equal(f.durable.length, 1, 'DURABLE_RECEIPT_REQUIRED'));
    } finally { await f.close(); }
  });
});
