'use strict';
// covers: tests/fixtures/legacy-rest-time.js, tests/fixtures/client-replay-patterns.js
const assert = require('node:assert/strict');
const { capture, DAY } = require('./fixtures/legacy-rest-time');
const patterns = require('./fixtures/client-replay-patterns');

describe('legacy REST temporal fixtures', function () {
  for (const [now, expected] of [
    ['2026-11-06T23:59:59.999Z', '2026-11-05T00:00:00.123Z'],
    ['2026-11-07T00:00:00.000Z', '2026-11-06T00:00:00.123Z'],
    ['2027-01-01T00:00:00.000Z', '2026-12-31T00:00:00.123Z'],
    ['2028-03-01T12:00:00.000Z', '2028-02-29T00:00:00.123Z']
  ]) it('captures the previous UTC day across ' + now, function () {
    const time = capture(Date.parse(now));
    assert.equal(time.iso(), expected);
    assert.equal(Date.parse(now) - time.base < 2 * DAY, true);
    assert.equal(time.iso(-DAY), new Date(time.base - DAY).toISOString());
  });

  it('keeps pattern payloads and follower windows on the same explicit anchor', function () {
    const base = capture(Date.parse('2028-03-01T12:00:00Z')).base - 123;
    const bound = patterns.at(base), docs = bound.documents();
    assert.deepEqual(docs.entries.map(doc => doc.date), [base, base + 300000]);
    assert.equal(docs.devicestatus[0].created_at, bound.iso(0));
    assert.equal(docs.treatments[0].timestamp, bound.iso(0));
    assert.equal(docs.profile[0].mills, String(base));
    const entry = new URL(bound.followerPath('entries', 'synthetic'), 'http://synthetic.invalid');
    assert.equal(entry.searchParams.get('find[date][$gte]'), String(base));
    const treatment = new URL(bound.followerPath('treatments', 'synthetic'), 'http://synthetic.invalid');
    assert.equal(treatment.searchParams.get('find[created_at][$lte]'), bound.iso(60000));
    assert.equal(bound.iso(-60000), new Date(base - 60000).toISOString());
  });

  it('retains opaque measurements, schedules and identity while rebinding only known timestamp fields', function () {
    const first = patterns.at(1793664000000).documents(1);
    const shifted = patterns.at(2100000000000).documents(1);
    assert.deepEqual(shifted.devicestatus[0].loop.predicted.values, first.devicestatus[0].loop.predicted.values);
    assert.equal(shifted.devicestatus[0].identifier, first.devicestatus[0].identifier);
    assert.equal(shifted.treatments[0].syncIdentifier, first.treatments[0].syncIdentifier);
    assert.deepEqual(shifted.profile[0].store, first.profile[0].store);
    assert.deepEqual(shifted.entries.map(doc => doc.sgv), first.entries.map(doc => doc.sgv));
  });
});
