'use strict';

// Source protocol only; fake connection is not PostgreSQL/RLS acceptance.
const assert = require('node:assert/strict');
const replay = require('../lib/storage/postgres-durable-replay');
const scope = require('../lib/storage/tenant-scope');
const { validateCatalogue } = require('../lib/migrations/catalogue');
const A = '11111111-1111-4111-8111-111111111111';

describe('dormant durable replay source protocol', function () {
  let previous;
  beforeEach(function () { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(function () { scope.setTenancyMode(previous); });

  it('compares recovered documents with stored typed metadata and rejects flattened or swapped kinds', function () {
    const { ObjectId } = require('mongodb');
    const { assertDocuments } = require('./fixtures/tenant-durable-replay');
    const id = '0123456789abcdef01234567';
    const stored = [
      { id_kind: 'objectid', doc: { _id: id, sgv: 111, nested: { value: null } } },
      { id_kind: 'string', doc: { _id: id, sgv: 112, nested: { value: false } } }
    ];
    const actual = [{ ...stored[0].doc, _id: new ObjectId(id) }, { ...stored[1].doc }];
    assertDocuments(actual, stored);
    assert.throws(() => assertDocuments(stored.map(row => ({ ...row.doc })), stored), assert.AssertionError);
    const swapped = stored.map(row => ({ ...row, id_kind: row.id_kind === 'string' ? 'objectid' : 'string' }));
    assert.throws(() => assertDocuments(actual, swapped), assert.AssertionError);
    assert.throws(() => assertDocuments([{ ...actual[0], nested: { value: false } }, actual[1]], stored), assert.AssertionError);
  });

  function fixture (overrides = {}) {
    const calls = [];
    let saved, floor = 0, source = [], failUpdate = false, failCommit = false;
    const compare = (a, b) => a.stamp - b.stamp || a.domain.localeCompare(b.domain) ||
      a.id_kind.localeCompare(b.id_kind) || a.doc._id.localeCompare(b.doc._id);
    const connection = {
      async snapshotTransaction (fn) {
        calls.push('SNAPSHOT');
        const before = structuredClone(saved);
        try {
          const value = await fn();
          if (failCommit) throw new Error('synthetic commit failure');
          calls.push('COMMIT');
          return value;
        } catch (error) { saved = before; calls.push('ROLLBACK'); throw error; }
      },
      async query (sql, values) {
        calls.push({ sql, values });
        if (sql.startsWith('SELECT checkpoint')) return { rows: saved ? [structuredClone(saved)] : [] };
        if (sql.startsWith('SELECT last_stamp')) return { rows: [{ last_stamp: String(floor) }] };
        if (sql.startsWith('SELECT 1')) return { rows: [] };
        if (sql.startsWith('SELECT count(*)')) return { rows: [{ row_count: String(source.length),
          document_bytes: String(source.reduce((n, row) => n + Buffer.byteLength(JSON.stringify(row.doc)), 0)) }] };
        if (sql.startsWith('SELECT domain') && sql.includes('snapshot_source')) {
          const compareIdentity = (a, b) => a.domain.localeCompare(b.domain) || a.id_kind.localeCompare(b.id_kind) || a.doc._id.localeCompare(b.doc._id);
          const after = values.length === 4 ? { domain: values[0], id_kind: values[1], doc: { _id: values[2] } } : null;
          return { rows: source.filter(row => !after || compareIdentity(row, after) > 0).sort(compareIdentity)
            .slice(0, values.at(-1)).map(row => structuredClone(row)) };
        }
        if (sql.startsWith('SELECT domain')) {
          const after = values.length === 7 ? { stamp: values[2], domain: values[3], id_kind: values[4], doc: { _id: values[5] } } : null;
          return { rows: source.filter(row => row.stamp > values[0] && row.stamp <= values[1] &&
            (!after || compare(row, after) > 0)).sort(compare).slice(0, values.at(-1)).map(row => structuredClone(row)) };
        }
        assert.equal(sql.startsWith('UPDATE'), true);
        assert.equal(values[0], A);
        if (failUpdate) throw new Error('synthetic checkpoint failure');
        saved = { checkpoint: values[2], projection: JSON.parse(values[3]), contract_digest: values[4] };
        return { rowCount: 1 };
      }
    };
    const options = { connection, checkpointTable: 'replay_test.tenant_consumer_checkpoint',
      clockTable: 'clock_test.tenant_write_clock', domains: { entries: 'entries_test.entries' },
      consumer: 'evaluator', projectionVersion: 'v1', pageSize: 1, maxRows: 10, ...overrides };
    const consumer = replay(options);
    const row = (id, kind, modified, value, valid = true) => ({ domain: 'entries', id_kind: kind, stamp: modified,
      doc: { _id: id, srvModified: modified, sgv: value, isValid: valid } });
    return { consumer, connection, options, calls, row,
      provision (projection = null, checkpoint = 0, digest = consumer.digest) {
        saved = { checkpoint, contract_digest: digest, projection };
      },
      setSource (rows, high) { source = rows; floor = high; },
      saved: () => structuredClone(saved),
      reorderSaved () {
        const reorder = value => Array.isArray(value) ? value.map(reorder)
          : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, reorder(value[key])])) : value;
        saved = reorder(saved);
      },
      failUpdate () { failUpdate = true; }, failCommit () { failCommit = true; },
      reconcile: (bounds = { maxRows: 10, maxBytes: 10000 }) => scope.withTenant(A, () => consumer.reconcile(bounds)),
      run: () => scope.withTenant(A, () => consumer.catchUp()) };
  }

  it('requires declared snapshot capability and explicit caller-selected bounds', function () {
    assert.throws(() => replay({ connection: { query () {}, transaction () {} } }), /snapshotTransaction/);
    assert.throws(() => fixture({ maxRows: undefined }), /pageSize and maxRows/);
    assert.throws(() => fixture({ checkpointTable: 'public.checkpoints' }), /non-system/);
  });

  it('refuses unbound and missing operator provisioning before replay', async function () {
    const f = fixture();
    await assert.rejects(f.consumer.catchUp(), /no tenant bound/);
    await assert.rejects(f.run(), /REPLAY_NOT_PROVISIONED/);
    assert.equal(f.calls.some(call => call.sql && call.sql.startsWith('UPDATE')), false);
  });

  it('bootstraps at an advanced checkpoint and preserves a typed tied cohort split across pages', async function () {
    const f = fixture();
    f.provision(null, 4);
    f.setSource([f.row('0123456789abcdef01234567', 'objectid', 2, 101),
      f.row('0123456789abcdef01234567', 'string', 2, 102)], 4);
    const result = await f.run();
    assert.equal(result.bootstrapped, true);
    assert.equal(result.rows.length, 2, 'bootstrap must not resume advanced cursor into empty projection');
    assert.equal(typeof result.rows[0].document._id.toHexString, 'function');
    assert.equal(typeof result.rows[1].document._id, 'string');
    assert.equal(result.checkpoint, 4);
    assert.equal(f.calls.at(-1), 'COMMIT');
  });

  it('restarts from durable projection, avoids duplicate application, and applies soft deletes', async function () {
    const f = fixture(); f.provision();
    f.setSource([f.row('id', 'string', 1, 101)], 1);
    await f.run();
    const saved = f.saved();
    const duplicate = await f.run();
    assert.equal(duplicate.changed, false);
    assert.deepEqual(f.saved(), saved);
    assert.equal(duplicate.rows[0].document.sgv, 101);
    f.setSource([f.row('id', 'string', 2, 101, false)], 2);
    const deleted = await f.run();
    assert.deepEqual(deleted.rows, []);
    assert.equal(deleted.checkpoint, 2);
  });

  it('rebuilds incompatible projections from all visible rows rather than keeping a stale cache', async function () {
    const f = fixture(); f.provision([{ broken: true }], 5, '0'.repeat(64));
    f.setSource([f.row('id', 'string', 2, 111)], 5);
    const result = await f.run();
    assert.equal(result.bootstrapped, true);
    assert.equal(result.rows[0].document.sgv, 111);
    assert.equal(f.saved().contract_digest, f.consumer.digest);
  });

  it('rolls back projection/checkpoint on failure and returns no uncommitted result', async function () {
    for (const method of ['failUpdate', 'failCommit']) {
      const f = fixture(); f.provision(); f.setSource([f.row('id', 'string', 1, 110)], 1);
      const before = f.saved(); f[method]();
      await assert.rejects(f.run(), /synthetic/);
      assert.deepEqual(f.saved(), before);
      assert.equal(f.calls.at(-1), 'ROLLBACK');
    }
  });

  it('refuses incomplete over-bound replay without advancing its checkpoint', async function () {
    const f = fixture({ maxRows: 1 }); f.provision();
    f.setSource([f.row('a', 'string', 1, 110), f.row('b', 'string', 1, 111)], 1);
    const before = f.saved();
    await assert.rejects(f.run(), /REPLAY_ROW_BOUND/);
    assert.deepEqual(f.saved(), before);
  });

  it('bounds scanned soft-deleted rows even when the retained projection would be empty', async function () {
    const f = fixture({ maxRows: 1 }); f.provision();
    f.setSource([f.row('a', 'string', 1, 110, false), f.row('b', 'string', 1, 111, false)], 1);
    const before = f.saved();
    await assert.rejects(f.run(), /REPLAY_ROW_BOUND/);
    assert.deepEqual(f.saved(), before);
  });

  it('replaces full current identities without floor movement and includes unstamped typed current state', async function () {
    const f = fixture(); f.provision();
    const id = '0123456789abcdef01234567';
    const activity = { domain: 'entries', id_kind: 'objectid', stamp: null, doc: { _id: id, sgv: 222 } };
    f.setSource([f.row(id, 'string', 1, 111), activity], 1);
    const first = await f.reconcile();
    assert.equal(first.rows.length, 2);
    assert.equal(first.progress, 'current-snapshot');
    assert.equal(f.saved().contract_digest, f.consumer.snapshotDigest);
    activity.doc.sgv = 333;
    assert.equal((await f.reconcile()).rows.find(row => typeof row.document._id !== 'string').document.sgv, 333, 'M5_SNAPSHOT_UNSTAMPED_UPDATE unchanged floor must refresh current values');
    f.setSource([activity], 1);
    const afterDelete = await f.reconcile();
    assert.equal(afterDelete.checkpoint, first.checkpoint);
    assert.equal(afterDelete.rows.length, 1, 'M5_SNAPSHOT_ABSENCE_TYPED_CURRENT physical source absence replaces saved key');
    assert.equal(typeof afterDelete.rows[0].document._id.toHexString, 'function');
    activity.doc.sgv = 333;
    assert.equal((await f.reconcile()).rows[0].document.sgv, 333);
    f.setSource([], 1);
    assert.deepEqual((await f.reconcile()).rows, []);
  });

  it('does not UPDATE semantically unchanged JSONB-reordered projection but preserves array order', async function () {
    const f = fixture(); f.provision();
    const row = f.row('one', 'string', 1, 111);
    row.doc.extension = { z: [1, 2, { z: true, a: 'typed' }], a: null };
    f.setSource([row], 1); await f.reconcile();
    f.reorderSaved();
    const before = f.saved(), updates = () => f.calls.filter(call => call.sql && call.sql.startsWith('UPDATE')).length;
    const count = updates(), scans = f.calls.filter(call => call.sql && call.sql.startsWith('SELECT count(*)')).length;
    const unchanged = await f.reconcile();
    assert.equal(unchanged.changed, false, 'M5_JSONB_SEMANTIC_EQUAL unchanged object keys must not trigger replacement');
    assert.equal(updates(), count, 'M5_JSONB_SEMANTIC_EQUAL unchanged floor/state issues no UPDATE');
    assert.equal(f.calls.filter(call => call.sql && call.sql.startsWith('SELECT count(*)')).length, scans + 1,
      'unchanged floor still performs full current-state acquisition');
    assert.deepEqual(f.saved(), before);
    row.doc.extension.z.reverse();
    const changed = await f.reconcile();
    assert.equal(changed.changed, true, 'JSON arrays retain order semantics');
    assert.equal(updates(), count + 1);
    row.doc.extension.z[0].z = 'true';
    assert.equal((await f.reconcile()).changed, true, 'scalar types retain their semantics');
    assert.equal(updates(), count + 2);
  });

  it('requires explicit snapshot bounds and rolls back row, byte, update and commit refusals', async function () {
    const f = fixture(); f.provision(); f.setSource([f.row('a', 'string', 1, 111)], 1);
    await f.reconcile(); const before = f.saved();
    await assert.rejects(f.reconcile({ maxRows: 1 }), /row\/byte bounds/);
    f.setSource([f.row('a', 'string', 1, 111), f.row('b', 'string', 1, 222)], 1);
    await assert.rejects(f.reconcile({ maxRows: 1, maxBytes: 10000 }), /SNAPSHOT_ROW_BOUND/, 'M5_SNAPSHOT_BOUND_REFUSAL row refusal before persistence');
    await assert.rejects(f.reconcile({ maxRows: 10, maxBytes: 1 }), /SNAPSHOT_BYTE_BOUND/);
    const docs = f.row('x', 'string', 1, 111);
    f.setSource([docs], 1);
    await assert.rejects(f.reconcile({ maxRows: 10, maxBytes: Buffer.byteLength(JSON.stringify(docs.doc)) + 1 }), /SNAPSHOT_BYTE_BOUND/);
    assert.deepEqual(f.saved(), before);
    for (const fail of ['failUpdate', 'failCommit']) {
      const g = fixture(); g.provision(); g.setSource([g.row('one', 'string', 1, 111)], 1);
      await g.reconcile(); const saved = g.saved();
      g.setSource([g.row('two', 'string', 2, 222)], 2); g[fail]();
      await assert.rejects(g.reconcile(), /synthetic/);
      assert.deepEqual(g.saved(), saved);
      assert.equal(g.calls.at(-1), 'ROLLBACK');
    }
  });

  it('keeps snapshot stamp fences and the strict replay API separate', async function () {
    const f = fixture(); f.provision();
    f.setSource([f.row('future', 'string', 2, 111)], 1);
    await assert.rejects(f.reconcile(), /UNSTAMPED_OR_UNFENCED/);
    const g = fixture(); g.provision(); g.setSource([g.row('one', 'string', 1, 111)], 1);
    await g.reconcile(); assert.notEqual(g.consumer.digest, g.consumer.snapshotDigest);
    await g.run(); assert.equal(g.saved().contract_digest, g.consumer.digest);
  });

  it('validates the append-only forced-RLS candidate and never grants clinical writes', function () {
    const catalogue = require('../migrations/candidates/postgres-consumer-checkpoint-v1.json');
    assert.equal(validateCatalogue(catalogue).length, 1);
    const sql = catalogue.migrations[0].up.join('\n');
    assert.match(sql, /FORCE ROW LEVEL SECURITY/);
    assert.match(sql, /WITH CHECK/);
    assert.match(sql, /REVOKE ALL/);
    assert.doesNotMatch(sql, /GRANT/);
  });
});
