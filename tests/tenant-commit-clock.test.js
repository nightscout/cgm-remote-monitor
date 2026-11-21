'use strict';

// Source-only protocol tests. The recording connection is not PostgreSQL;
// real lock/commit visibility and RLS acceptance require the integration lane.
const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const dates = require('../lib/server/srv-dates');
const decorate = require('../lib/storage/postgres-write-clock');
const intent = require('../lib/storage/write-intent');
const { withCommitEvents } = require('../lib/storage/postgres-intent-common');
const { EventEmitter } = require('node:events');
const TENANT = '11111111-1111-4111-8111-111111111111';

describe('tenant commit clock source protocol', function () {
  let previous;
  beforeEach(function () { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(function () { scope.setTenancyMode(previous); });

  function fixture (initial = Date.now() + 100000) {
    let floor = initial;
    const calls = [];
    const raw = {
      async transaction (fn) {
        calls.push('BEGIN');
        const before = floor;
        try { const result = await fn(); calls.push('COMMIT'); return result; }
        catch (error) { floor = before; calls.push('ROLLBACK'); throw error; }
      },
      async query (sql, values) {
        calls.push({ sql, values });
        if (sql.startsWith('SELECT')) return { rows: [{ last_stamp: String(floor) }] };
        assert.equal(values[1], TENANT);
        assert.equal(values[2], floor);
        floor = values[0];
        return { rowCount: 1 };
      }
    };
    return { connection: decorate(raw, 'clock_test'), calls, floor: () => floor, initial };
  }

  it('uses the locked floor, joins nested writes, and publishes only after outer COMMIT', async function () {
    const f = fixture();
    const bus = new EventEmitter();
    const observed = [];
    bus.on(intent.INTENT_EVENT, () => observed.push(f.calls.at(-1)));
    const port = withCommitEvents({ write: async () => {
      return { items: [], stamp: dates.next() };
    } }, { connection: f.connection, bus, logical: 'entries', source: 'v3' });
    await scope.withTenant(TENANT, () => f.connection.transaction(async () => {
      const first = dates.next();
      const nested = await port.write({ op: 'create' });
      assert.equal(nested.stamp, first + 1);
      assert.deepEqual(observed, []);
    }));
    assert.equal(f.floor(), f.initial + 2);
    assert.deepEqual(observed, ['COMMIT']);
    assert.equal(f.calls.filter(call => call.sql && call.sql.includes('FOR UPDATE')).length, 1);
    assert.equal(f.calls.filter(call => call === 'BEGIN').length, 1);
  });

  it('rolls back its high-water and suppresses queued events when the outer write fails', async function () {
    const f = fixture();
    let events = 0;
    await scope.withTenant(TENANT, () => assert.rejects(f.connection.transaction(async () => {
      dates.next();
      f.connection.afterCommit(() => { events++; });
      throw new Error('synthetic write refusal');
    }), /synthetic write refusal/));
    assert.equal(f.floor(), f.initial);
    assert.equal(events, 0);
    assert.equal(f.calls.at(-1), 'ROLLBACK');
  });

  it('refuses overflow and retains the durable floor on a no-stamp operation', async function () {
    const f = fixture(8639999999999999);
    await scope.withTenant(TENANT, async () => {
      await f.connection.transaction(async () => {});
      assert.equal(f.calls.some(call => call.sql && call.sql.startsWith('UPDATE')), false);
      await assert.rejects(f.connection.transaction(async () => dates.next()), /Invalid tenant write clock floor/);
    });
    assert.equal(f.floor(), f.initial);
  });

  it('does not fall back to the process clock in a retained closed async context', async function () {
    const f = fixture();
    let resume, continuation;
    await scope.withTenant(TENANT, () => f.connection.transaction(async () => {
      continuation = new Promise(resolve => { resume = resolve; }).then(() => {
        assert.throws(() => dates.next(), /closed/);
        assert.throws(() => f.connection.afterCommit(() => {}), /closed/);
      });
    }));
    resume();
    await continuation;
  });

  it('finalizes genuine preplanned entries without changing filters, identifiers or domain dates', async function () {
    const f = fixture();
    const batches = [];
    const storage = { findFiltered: async () => [],
      bulkUpsert: async ops => { batches.push(ops); return {}; } };
    const step = intent.forCollection(storage, 'entries', 'v1/internal', { env: {} });
    await scope.withTenant(TENANT, async () => {
      const docs = [0, 1].map(i => ({ identifier: 'synthetic-clock-' + i, type: 'sgv', sgv: 100 + i,
        dateString: '2026-11-06T01:00:00+01:00', extra: { srvModified: 7 } }));
      const planned = step.plan({ op: 'create', docs });
      assert.equal(f.calls.length, 0, 'PLANNING_MUST_NOT_QUERY_CLOCK');
      assert(docs.every(doc => !Object.hasOwn(doc, 'srvModified')), 'PLANNING_MUST_NOT_ISSUE_CURSOR');
      const originals = docs.map(doc => ({ ...doc }));
      const filters = planned.ops.map(op => structuredClone(op.updateOne.filter));
      await f.connection.transaction(() => step.write(planned));
      assert.equal(batches.length, 1);
      docs.forEach((doc, i) => {
        assert.equal(doc.srvModified, f.initial + i + 1);
        assert.equal(batches[0][i].doc.srvModified, doc.srvModified);
        assert.equal(batches[0][i].setOnInsert.srvCreated, doc.srvModified);
        const { srvModified, ...withoutServerDate } = doc;
        assert(Number.isSafeInteger(srvModified));
        assert.deepEqual(withoutServerDate, originals[i]);
        assert.deepEqual(planned.ops[i].updateOne.filter, filters[i]);
        assert.equal(doc.extra.srvModified, 7);
      });
    });
  });

  function implementation (mutate) {
    const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
    const file = require.resolve('../lib/storage/write-intent'), result = { exports: {} };
    vm.runInThisContext('(function(require,module,exports){' + mutate(fs.readFileSync(file, 'utf8')) + '\n})', { filename: file })(createRequire(file), result, result.exports);
    return result.exports;
  }

  async function finalizationCriterion (library = intent) {
    const f = fixture(), batches = [];
    const storage = { findFiltered: async () => [], bulkUpsert: async ops => { batches.push(ops); return {}; } };
    const step = library.forCollection(storage, 'entries', 'v1/internal', { env: {} });
    await scope.withTenant(TENANT, async () => {
      const doc = { identifier: 'synthetic-finalization', type: 'sgv', sgv: 111, date: 1793664000000, srvModified: 1234, srvCreated: 1234 };
      const planned = step.plan({ op: 'create', docs: [doc] });
      assert.equal(f.calls.length, 0, 'PLANNING_MUST_NOT_QUERY_CLOCK');
      assert.equal(Object.hasOwn(doc, 'srvModified'), false, 'PLANNING_MUST_NOT_ISSUE_CURSOR');
      assert.equal(Object.hasOwn(doc, 'srvCreated'), false, 'PLANNING_MUST_NOT_KEEP_CLIENT_CLOCK');
      await f.connection.transaction(() => step.write(planned));
      assert.equal(doc.srvModified, f.initial + 1, 'COMMITTED_REPLY_MUST_USE_DURABLE_CURSOR');
      assert.equal(batches[0][0].doc.srvModified, doc.srvModified, 'REPLY_AND_STORED_CURSOR_MUST_AGREE');
      assert.equal(f.floor(), doc.srvModified);
    });
  }

  async function acknowledgeCriterion (library = intent) {
    for (const datesPresent of [true, false]) {
      const stored = { _id: 'synthetic-stored', identifier: 'synthetic-ack', ...(datesPresent ? { srvModified: 200, srvCreated: 100 } : {}) };
      const storage = { findFiltered: async () => [{ ...stored }] };
      const step = library.forCollection(storage, 'entries', 'v1/internal', { env: { write: { resend: 'acknowledge' } } });
      await scope.withTenant(TENANT, async () => {
        const doc = { identifier: stored.identifier, type: 'sgv', sgv: 123, date: 1793664000000 };
        const planned = step.plan({ op: 'create', docs: [doc] });
        const probe = library.entryResendProbe(storage, planned);
        assert.equal((await probe()).items[0].outcome, 'unchanged');
        for (const field of ['srvModified', 'srvCreated']) {
          assert.equal(doc[field], stored[field], 'ACK_REPLY_MUST_USE_STORED_HISTORY_METADATA');
          assert.equal(Object.hasOwn(doc, field), Object.hasOwn(stored, field), 'ACK_REPLY_MUST_PRESERVE_MISSING_METADATA');
        }
      });
    }
  }

  it('planning issues no cursor; actual write and reply use the durable allocation', () => finalizationCriterion());
  it('a read-only acknowledge returns stored history dates or their absence', () => acknowledgeCriterion());
  it('red/restored: skipping finalization exposes a cursor that was never committed', async function () {
    const broken = implementation(source => {
      const needle = '  finalizeEntryServerDates(plan);';
      assert(source.includes(needle), 'FINALIZATION_CONTROL_MUST_CHANGE_ACTUAL_WRITE');
      return source.replace(needle, '  // finalization removed by semantic control');
    });
    await assert.rejects(finalizationCriterion(broken), /COMMITTED_REPLY_MUST_USE_DURABLE_CURSOR/);
    await finalizationCriterion();
  });
  it('red/restored: skipping stored-date binding makes an acknowledge invent or omit its cursor', async function () {
    const broken = implementation(source => {
      const needle = '      entryReplyDates(plan.docs[i], row);';
      assert(source.includes(needle), 'ACK_CONTROL_MUST_CHANGE_ACTUAL_PROBE');
      return source.replace(needle, '      // stored-date binding removed by semantic control');
    });
    await assert.rejects(acknowledgeCriterion(broken), /ACK_REPLY_MUST_USE_STORED_HISTORY_METADATA/);
    await acknowledgeCriterion();
  });

  for (const [mode, outcome] of [['acknowledge', 'unchanged'], ['refuse', 'refused']]) {
    it('uses stored ' + mode + ' reply dates and does not advance the durable floor', async function () {
      const f = fixture();
      const { ObjectId } = require('mongodb');
      const stored = { _id: new ObjectId('111111111111111111111111'), identifier: 'synthetic-repeat',
        sysTime: '2026-11-06T00:00:00.000Z', type: 'sgv', srvCreated: 100, srvModified: 200 };
      const storage = { findFiltered: async () => [{ ...stored }],
        bulkUpsert: async () => { assert.fail('No operation may reach the writer'); } };
      const step = intent.forCollection(storage, 'entries', 'v1/internal', { env: { write: { resend: mode } } });
      await scope.withTenant(TENANT, async () => {
        const doc = { identifier: stored.identifier, type: 'sgv', sgv: 123,
          dateString: '2026-11-06T01:00:00+01:00' };
        const planned = step.plan({ op: 'create', docs: [doc] });
        assert.equal(Object.hasOwn(doc, 'srvModified'), false, 'PLANNING_MUST_NOT_ISSUE_CURSOR');
        const result = await f.connection.transaction(() => step.write(planned));
        assert.equal(result.items[0].outcome, outcome);
        assert.equal(doc.srvModified, stored.srvModified);
        assert.equal(doc.srvCreated, stored.srvCreated);
        assert.equal(String(doc._id), String(stored._id));
        assert.equal(f.floor(), f.initial);
        assert.equal(f.calls.some(call => call.sql && call.sql.startsWith('UPDATE')), false);
      });
    });
  }
});

describe('admin tenant commit clock floor source contract', function () {
  const domains = require('../lib/server/serve/postgres-domains');
  const names = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'settings'];
  const B = '22222222-2222-4222-8222-222222222222';
  let previous, savedInsertion;
  const insertion = require('../lib/storage/postgres-insertion-readiness');
  // This recorder characterizes clock queries only. Actual insertion metadata
  // has separate protocol/native admission tests; do not fake its SQL rows here.
  beforeEach(function () { previous = scope.getTenancyMode(); scope.setTenancyMode('multi');
    savedInsertion = { metadata: insertion.metadata, floor: insertion.floor };
    insertion.metadata = async () => {}; insertion.floor = async () => {};
  });
  afterEach(function () { Object.assign(insertion, savedInsertion); scope.setTenancyMode(previous); });

  function fixture () {
    const calls = [];
    const config = { writeClock: true, domains: names,
      namespaces: Object.fromEntries([...names, 'clock'].map(name => [name, 'test_' + name])),
      bindings: new Map([[TENANT, {}], [B, {}]]) };
    const rows = new Map([[TENANT, [{ last_stamp: '101', stored_max: '101' }]],
      [B, [{ last_stamp: '0', stored_max: null }]]]);
    const connection = {
      withTenant: (tenant, fn) => scope.withTenant(tenant, fn),
      async query (sql, values) {
        calls.push({ sql, values, tenant: scope.currentTenant() });
        if (sql.includes('FROM pg_roles')) return { rows: [{ rolcreaterole: false, rolcreatedb: false, rolreplication: false }] };
        if (sql.includes('AS creates')) return { rows: [{ creates: false }] };
        if (sql.includes('FROM pg_class')) return { rows: [{ secured: true, owns: false, serves: true, extra: false }] };
        assert.ok(sql.startsWith('SELECT last_stamp,'), 'Readiness may only read the configured floor and maxima');
        assert.equal(values[0], scope.currentTenant());
        return { rows: rows.get(values[0]) };
      }
    };
    return { config, connection, calls, rows };
  }

  it('admits valid floors with every actual catalogue using one guarded JSONB maximum statement per tenant', async function () {
    const f = fixture();
    for (const name of names) {
      const ddl = domains.get(name).catalogue.migrations.flatMap(m => m.up).find(sql => sql.startsWith('CREATE TABLE ' + name + ' '));
      assert.ok(ddl && /doc jsonb NOT NULL/.test(ddl), name + ' must provide the portable source field');
    }
    for (const tenant of f.config.bindings.keys()) await domains.checkTenantFloors(f.config, f.connection, tenant);
    const reads = f.calls.filter(call => call.sql.startsWith('SELECT last_stamp,'));
    assert.equal(reads.length, 2);
    for (const { sql } of reads) {
      assert.equal((sql.match(/UNION ALL/g) || []).length, names.length - 1);
      assert.equal((sql.match(/CASE WHEN jsonb_typeof\(doc -> 'srvModified'\) = 'number' THEN \(doc ->> 'srvModified'\)::numeric END/g) || []).length, names.length);
      assert.equal((sql.match(/value >= 0 AND value < 8640000000000000/g) || []).length, names.length);
      assert.match(sql, /CEIL\(MAX\(value\)\)/);
      assert.doesNotMatch(sql, /"srvModified"|FOR UPDATE|\b(?:INSERT|UPDATE|DELETE)\b/);
      names.forEach(name => assert.ok(sql.includes('FROM "test_' + name + '"."' + name + '"')));
    }
  });

  for (const [label, rows] of [['missing', []], ['stale', [{ last_stamp: '100', stored_max: '101' }]],
    ['overflow', [{ last_stamp: '8640000000000000', stored_max: null }]]]) {
    it('refuses a ' + label + ' floor after the all-domain positive setup', async function () {
      const f = fixture();
      for (const tenant of f.config.bindings.keys()) await domains.checkTenantFloors(f.config, f.connection, tenant);
      f.rows.set(TENANT, rows);
      await assert.rejects(domains.checkTenantFloors(f.config, f.connection, TENANT), /missing or stale/);
    });
  }

  // The privilege screen is the admin pre-start step's (screenServing); a
  // serving API checks only the issued platform proof.
  it('refuses unsafe clock privileges after the same all-domain setup succeeds', async function () {
    const f = fixture();
    await domains.screenServing(f.config, f.connection);
    const original = f.connection.query;
    f.connection.query = async (sql, values) => {
      if (sql.includes('FROM pg_class') && values[0] === 'test_clock.tenant_write_clock') {
        return { rows: [{ secured: true, owns: false, serves: true, extra: true }] };
      }
      return original(sql, values);
    };
    await assert.rejects(domains.screenServing(f.config, f.connection), /unsafe write clock privileges/);
  });
});
