'use strict';
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const carelink = require('nightscout-connect/lib/sources/minimedcarelink');
const fromConnect = createRequire(require.resolve('nightscout-connect'));
const fixtures = require('./fixtures/minimed-cutover.json');
const selectPump = require('../lib/client-core/devicestatus/pump');

function source() {return carelink({carelinkRegion: 'eu'}, fromConnect('axios'));}
function readings(batch) {return batch.entries.map(({type, sgv, date, dateString, trend, direction}) => ({type, sgv, date, dateString, trend, direction}));}
function statuses(batch) {
  return batch.devicestatus.map(status => ({created_at: status.created_at, uploader: status.uploader,
    ...(status.pump ? {pump: {battery: status.pump.battery, reservoir: status.pump.reservoir, iob: status.pump.iob, clock: status.pump.clock}} : {})}));
}

describe('MiniMed cutover from legacy output', function () {
  for (const fixture of fixtures.cases) {
    it('preserves ' + fixture.family + ' glucose and status fields captured from legacy 1.5.8', function () {
      const data = structuredClone(fixture.input);
      for (let cycle = 0; cycle < 2; cycle++) {
        const batch = source().transformPayload(data, {});
        assert.deepEqual(readings(batch), fixture.entries);
        assert.deepEqual(statuses(batch), fixture.devicestatus);
        assert.deepEqual(data, fixture.input);
        assert.equal(batch.entries[0].device, 'nightscout-connect://minimedcarelink/' + fixture.family);
        assert.ok(batch.entries.every(entry => entry.type === 'sgv'));
      }
    });
  }
  it('preserves stored trends and emits no duplicate status over repeated cutover batches', function () {
    const data = structuredClone(fixtures.cases[0].input);
    const previous = structuredClone(fixtures.cases[0].entries);
    const initial = data.lastMedicalDeviceDataUpdateServerTime;
    const next = initial + 300000;
    data.sgs.push({kind: 'SG', sg: 130, datetime: new Date(next).toISOString()});
    data.lastSG = {sg: 130}; data.lastSGTrend = 'DOWN';
    data.lastMedicalDeviceDataUpdateServerTime = next;
    const batch = source().transformPayload(data, {entries: new Date(initial), devicestatus: new Date(initial)});
    assert.equal(batch.entries.length, 1);
    assert.equal(batch.entries[0].date, next);
    assert.equal(batch.entries[0].direction, 'SingleDown');
    assert.equal(batch.devicestatus.length, 1);
    // Applying an upsert by timestamp cannot overwrite the existing trend:
    // the replacement batch contains only the new timestamp.
    const stored = new Map(previous.map(entry => [entry.date, entry]));
    for (const entry of batch.entries) stored.set(entry.date, entry);
    assert.equal(stored.get(initial).direction, 'SingleUp');
    assert.equal(stored.size, 2);
    for (let repeat = 0; repeat < 2; repeat++) {
      const duplicate = source().transformPayload(data, {entries: new Date(next), devicestatus: new Date(next)});
      assert.deepEqual(duplicate.entries, []);
      assert.deepEqual(duplicate.devicestatus, []);
    }
  });
  it('preserves the values consumed by Nightscout pump selection', function () {
    const fixture = fixtures.cases[0];
    const migrated = source().transformPayload(structuredClone(fixture.input), {}).devicestatus;
    const before = selectPump(structuredClone(fixture.devicestatus));
    const after = selectPump(migrated);
    assert.equal(after.clockMills, before.clockMills);
    assert.equal(after.pump.reservoir, before.pump.reservoir);
    assert.deepEqual(after.pump.battery, before.pump.battery);
    assert.deepEqual(after.pump.iob, before.pump.iob);
  });
  it('preserves measurement age when Connect backfills data older than the legacy cutoff', function () {
    const data = structuredClone(fixtures.cases[0].input);
    data.currentServerTime += 21 * 60 * 1000;
    const batch = source().transformPayload(data, {});
    assert.equal(batch.entries[0].date, data.lastMedicalDeviceDataUpdateServerTime);
    assert.equal(Date.parse(batch.devicestatus[0].created_at), data.lastMedicalDeviceDataUpdateServerTime);
    assert.notEqual(Date.parse(batch.devicestatus[0].created_at), data.currentServerTime);
  });
  it('keeps a valid newest reading when trend metadata does not describe it', function () {
    const data = structuredClone(fixtures.cases[0].input);
    data.lastSG = {sg: 999};
    const batch = source().transformPayload(data, {});
    assert.equal(batch.entries.length, 1);
    assert.equal(batch.entries[0].sgv, 123);
    assert.equal(batch.entries[0].direction, undefined);
  });
});
