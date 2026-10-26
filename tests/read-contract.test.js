'use strict';

const assert = require('node:assert/strict');
const contract = require('../lib/storage/read-contract');
const {ObjectId} = require('mongodb');
const {spawnSync} = require('node:child_process');
const {report} = require('../scripts/diagnose-data');

describe('Stored-data read contract', function () {
  it('reports malformed shapes without mutating or leaking their contents', function () {
    const doc = {_id: {toString: 'broken'}, identifier: [], srvModified: [1],
      created_at: {valueOf: 'broken', toString: 'broken'}, notes: 'sensitive', duration: {toString: 'broken'}};
    const before = JSON.stringify(doc);
    const summary = contract.summarize([doc]);
    assert.equal(summary.flagged, 1);
    assert(summary.rules['identity-shape']);
    assert(summary.rules['server-time-shape']);
    assert(summary.rules['date-shape']);
    assert(summary.rules['number-shape']);
    assert(!JSON.stringify(summary).includes('sensitive'));
    assert.equal(JSON.stringify(doc), before);
  });

  it('does not flag missing fields in a projected treatment or mutate API data', function () {
    const doc = {eventType: 'Temporary Target', notes: 'legacy'};
    const headers = {};
    contract.setHeader({setHeader: (key, value) => { headers[key] = value; }}, [doc]);
    assert.deepEqual(headers, {});
    assert.equal(doc.notes, 'legacy');
    assert(contract.inspect(doc).length);
  });

  it('flags a future clock without clamping a previously issued cursor', function () {
    const doc = {srvModified: Date.UTC(2100, 0, 1)};
    const value = doc.srvModified;
    assert.equal(contract.inspect(doc, {now: 1})[0].rule, 'server-time-future');
    assert.equal(doc.srvModified, value);
    const script = `
      const assert = require('node:assert/strict');
      const clock = require('./lib/server/srv-dates');
      clock.restore({collection: () => ({findOne: async () => ({srvModified: ${value}})})}, {})
        .then(() => { assert(clock.next() > ${value}); });`;
    const run = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', timeout: 5000});
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /HISTORY_CLOCK future srvModified/);
    assert(!run.stderr.includes(String(value)));
  });

  it('normalizes valid identities and retains an unaddressable stored id visibly', function () {
    const normalize = require('../lib/api3/storage/mongoCollection/utils').normalizeDoc;
    const oid = new ObjectId(), doc = {_id: oid};
    normalize(doc);
    assert.equal(doc.identifier, oid.toHexString());
    const malformed = {_id: {toString: 'broken'}};
    normalize(malformed);
    assert.deepEqual(malformed, {_id: {toString: 'broken'}});
  });

  it('does not let object-valued stored dates and durations throw during cache conversion', function () {
    const ddata = require('../lib/data/ddata')();
    const broken = {toString: 'broken', valueOf: 'broken'};
    const docs = [{_id: broken, created_at: broken, duration: broken, durationInMilliseconds: broken}];
    const before = JSON.stringify(docs);
    const converted = ddata.processRawDataForRuntime(docs);
    assert.equal(converted.length, 1);
    assert.deepEqual(converted[0].created_at, broken);
    assert.equal(JSON.stringify(docs), before);
  });

  it('keeps diagnostic scans bounded, closes cursors and never writes', async function () {
    let closed = 0;
    const docs = [{srvModified: []}, {notes: 'private'}, {}];
    const db = {collection: () => ({find: () => ({
      limit(n) { assert.equal(n, 3); return this; },
      batchSize(n) { assert.equal(n, 500); return this; },
      async *[Symbol.asyncIterator]() { yield* docs; },
      async close() { closed++; }
    })})};
    const result = await report(db, {entries: 'custom_entries'}, 2);
    assert.equal(result.entries.scanned, 2);
    assert.equal(result.entries.flagged, 1);
    assert.equal(result.entries.truncated, true);
    assert.equal(closed, 1);
    assert(!JSON.stringify(result).includes('private'));
  });
  it('never advances a history cursor from a malformed stored time', function () {
    const docs = [{srvModified: [999999]}, {srvModified: '999999'}, {srvModified: NaN},
      {srvModified: {valueOf: 'broken'}}, {srvModified: 100}, {srvModified: 200}];
    assert.equal(contract.historyWatermark(docs), 200);
    assert.equal(contract.historyWatermark(docs.slice(0, 4)), undefined);
  });

});
