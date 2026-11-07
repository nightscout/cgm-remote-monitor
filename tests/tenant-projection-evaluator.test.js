'use strict';

// Source/interface checks. Real SQL and clinical recovery are opt-in separately.
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const scope = require('../lib/storage/tenant-scope');
const readProjection = require('../lib/storage/postgres-projection-read');
const evaluator = require('../lib/data/tenant-projection-evaluator');
const { fromMongo } = require('../lib/storage/filter');
const { encodeDocument } = require('../lib/storage/postgres-identity');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const id = '0123456789abcdef01234567';

describe('dormant tenant projection evaluator source contract', function () {
  let previous;
  beforeEach(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(previous));
  function source (extra = {}) {
    const calls = [];
    const documents = [{ _id: new ObjectId(id), type: 'sgv', date: 1000, sgv: 111 },
      { _id: id, type: 'sgv', date: 2000, sgv: 222 }];
    const connection = { async query (text, values) { calls.push({ text, values }); return { rows: documents.map(encodeDocument) }; } };
    return { calls, documents, reader: readProjection({ tenant: A, connection, logical: 'entries', documents,
      maxRows: 10, maxBytes: 10000, ...extra }) };
  }
  it('uses current filter/sort SQL and typed codec over an immutable read-only JSON source', async function () {
    const s = source();
    s.documents[0].sgv = -1;
    const rows = await scope.withTenant(A, () => s.reader.findFiltered(fromMongo({ type: 'sgv' }),
      { v1: true, sort: { date: -1, _id: -1 }, limit: 2, options: { normalize: false } }));
    assert.equal(typeof rows[0]._id.toHexString, 'function');
    assert.equal(typeof rows[1]._id, 'string');
    const call = s.calls[0];
    assert.match(call.text, /^SELECT id_kind, doc/);
    assert.match(call.text, /jsonb_to_recordset\(\$\d+::jsonb\)/);
    assert.match(call.text, /ORDER BY/);
    assert.match(call.text, /CASE id_kind/);
    assert.match(call.text, / LIMIT \$\d+/);
    assert.equal(JSON.parse(call.values.at(-1))[0].doc.sgv, 111);
    assert.equal(new Set(JSON.parse(call.values.at(-1)).map(row => row.id_kind)).size, 2);
    assert.deepEqual(Object.keys(s.reader).sort(), ['count', 'findFiltered', 'findOne', 'findOneFilter']);
  });
  it('refuses foreign and unbound calls before submitting SQL', async function () {
    const s = source();
    await assert.rejects(scope.withTenant(B, () => s.reader.findFiltered(null, { sort: { date: -1 } })), /tenant mismatch/);
    await assert.rejects(s.reader.findFiltered(null, { sort: { date: -1 } }), /tenant/i);
    assert.equal(s.calls.length, 0);
  });
  it('requires explicit count/byte bounds and preserves typed duplicate distinction', function () {
    assert.throws(() => source({ maxRows: undefined }), /bound/);
    assert.throws(() => source({ maxRows: 1 }), /bound/);
    assert.throws(() => source({ maxBytes: 1 }), /byte bound/);
    assert.throws(() => source({ documents: [{ _id: 'a' }, { _id: 'a' }] }), /duplicate typed/);
    assert.throws(() => source({ logical: 'unknown' }), /clinical domain/);
  });
  it('keeps existing unsupported read options and natural ordering refused', async function () {
    const s = source();
    await assert.rejects(scope.withTenant(A, () => s.reader.findFiltered(fromMongo({}), { v1: true, limit: 1 })), /without a sort/);
    await assert.rejects(scope.withTenant(A, () => s.reader.findFiltered(fromMongo({}), { v1: true, sort: { date: -1 }, madeUp: true })), /find option/);
    assert.equal(s.calls.length, 0);
  });
  function component (replay, suppliedConnection, suppliedStats) {
    const env = require('../lib/server/tenant-app/environment')({ settings: { enable: ['bgnow'] } });
    const connection = suppliedConnection || { async query () { throw new Error('No SQL allowed in this contract case'); } };
    const language = require('../lib/language')();
    return evaluator({ tenant: A, replay, connection, env, language, dbstats: suppliedStats || (async () => ({ dataSize: 0, indexSize: 0 })),
      maxRows: 10, maxBytes: 10000 });
  }
  it('does not retain or publish when replay commit refuses', async function () {
    const v = component({ async reconcile () { throw new Error('COMMIT refused'); } });
    await assert.rejects(v.evaluate(), /COMMIT refused/);
    assert.equal(v.last(), null);
  });
  it('retries clinical computation after a downstream failure despite unchanged snapshot progress', async function () {
    let acquisitions = 0, fail = false;
    const v = component({ async reconcile (bounds) {
      assert.deepEqual(bounds, { maxRows: 10, maxBytes: 10000 });
      acquisitions++;
      return { checkpoint: 1, progress: 'current-snapshot', rows: [] };
    } }, { async query () {
      if (fail) throw new Error('Synthetic downstream clinical read failure');
      return { rows: [] };
    } });
    const instant = Date.UTC(2026, 10, 6, 12);
    const first = await v.evaluate({ at: instant });
    fail = true;
    await assert.rejects(v.evaluate({ at: instant }), /downstream clinical read failure/);
    assert.equal(v.last(), first);
    fail = false;
    const retry = await v.evaluate({ at: instant });
    assert.equal(acquisitions, 3, 'unchanged input checkpoint never suppresses a clinical retry');
    assert.equal(retry.checkpoint, first.checkpoint);
    assert.deepEqual(retry.properties, first.properties);
  });
  it('evaluates time-only from successful retained input without acquisition or statistics reload', async function () {
    let acquisitions = 0, statistics = 0;
    const v = component({ async reconcile () { acquisitions++; return { checkpoint: 7, rows: [] }; } },
      { async query () { return { rows: [] }; } }, async () => { statistics++; return { dataSize: 0, indexSize: 0 }; });
    await assert.rejects(v.evaluateTime(), /no successful retained input/, 'M5_EVAL_TIME_COMPONENT time-only cannot bootstrap acquisition');
    const first = await v.evaluate({ at: 1000 });
    const time = await v.evaluateTime({ at: 2000 });
    assert.equal(acquisitions, 1, 'M5_EVAL_TIME_COMPONENT no acquisition from time tick');
    assert.equal(statistics, 1, 'M5_EVAL_TIME_COMPONENT retains acquisition statistics');
    assert.equal(time.checkpoint, first.checkpoint);
    assert.equal(time.trigger, 'time-only');
    assert.equal(time.evaluationRevision, first.evaluationRevision + 1);
    assert.equal(time.now, 2000);
  });
  it('enforces tenant scope before replay and retained-state access', async function () {
    let reads = 0;
    const v = component({ async reconcile () { reads++; } });
    await assert.rejects(scope.withTenant(B, () => v.evaluate()), /tenant scope/);
    assert.throws(() => scope.withTenant(B, () => v.last()), /tenant scope/);
    assert.equal(reads, 0);
  });
  it('refuses concurrent evaluation and late publication after close', async function () {
    let release;
    const v = component({ reconcile: () => new Promise(resolve => { release = resolve; }) });
    const first = v.evaluate();
    await assert.rejects(v.evaluate(), /already running/);
    v.close();
    release({ checkpoint: 1, rows: [] });
    await assert.rejects(first, /closed/);
    assert.throws(() => v.last(), /closed/);
  });
  it('refuses incomplete, unsupported and over-bound recovered output before SQL', async function () {
    for (const output of [undefined, { checkpoint: -1, rows: [] },
      { checkpoint: 1, rows: [{ domain: 'other', document: { _id: 'one' } }] },
      { checkpoint: 1, rows: Array.from({ length: 11 }, (_, i) => ({ domain: 'entries', document: { _id: String(i) } })) },
      { checkpoint: 1, rows: [{ domain: 'entries', document: { _id: 'large', text: 'x'.repeat(10001) } }] }]) {
      const v = component({ async reconcile () { return output; } });
      await assert.rejects(v.evaluate(), /invalid|bound|unsupported/);
      assert.equal(v.last(), null);
    }
  });
});
