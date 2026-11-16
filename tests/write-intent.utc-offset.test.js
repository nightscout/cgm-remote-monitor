'use strict';
const assert = require('node:assert/strict');
const intent = require('../lib/storage/write-intent');
const writer = require('../lib/storage/postgres-entries-write');
function plan (logical, doc) {
  return intent.forCollection({}, logical, 'v1/internal', { env: {} })
    .plan({ op: 'create', form: 'batch', docs: [doc] }).docs[0];
}
describe('derived UTC offsets remain representable without weakening document validation', function () {
  let old;
  before(() => { old = process.env.TZ; process.env.TZ = 'UTC'; });
  after(() => { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; });
  it('normalizes a date-only entry offset to positive zero', function () {
    const entry = plan('entries', { type: 'sgv', sgv: 123, date: 1700000000000 });
    assert.equal(Object.is(entry.utcOffset, -0), false, 'ENTRY_DERIVED_OFFSET_REPRESENTABLE');
    assert.equal(entry.utcOffset, 0);
    assert.equal(entry.date, 1700000000000); assert.equal(entry.sgv, 123);
    assert.equal(entry.sysTime, '2023-11-14T22:13:20.000Z');
  });
  it('normalizes the treatment fallback offset to positive zero', function () {
    const treatment = plan('treatments', { eventType: 'Note' });
    assert.equal(Object.is(treatment.utcOffset, -0), false, 'TREATMENT_DERIVED_OFFSET_REPRESENTABLE');
    assert.equal(treatment.utcOffset, 0);
    assert.equal(treatment.eventType, 'Note');
    assert(Number.isFinite(Date.parse(treatment.created_at)));
  });
  it('preserves explicit nonzero offsets and their exact instants', function () {
    for (const [suffix, offset] of [['+02:00', 120], ['-05:00', -300]]) {
      const time = '2023-11-14T22:13:20.000' + suffix;
      const entry = plan('entries', { type: 'sgv', sgv: 123, date: Date.parse(time), dateString: time });
      const treatment = plan('treatments', { eventType: 'Note', created_at: time });
      assert.equal(entry.utcOffset, offset); assert.equal(treatment.utcOffset, offset);
      assert.equal(entry.sysTime, new Date(time).toISOString());
      assert.equal(treatment.created_at, new Date(time).toISOString());
    }
  });
  it('still refuses caller-supplied negative zero and non-finite numbers in storage documents', function () {
    const storage = writer({ connection: { query () {}, transaction () {} }, table: 'test_entries.entries' });
    for (const value of [-0, NaN, Infinity, -Infinity]) {
      assert.throws(() => storage.validateDocument({ type: 'sgv', date: 1700000000000, utcOffset: value }), /unsupported document value for utcOffset/);
      assert.throws(() => storage.validateDocument({ type: 'sgv', date: 1700000000000, sgv: value }), /unsupported document value for sgv/);
    }
  });
});
