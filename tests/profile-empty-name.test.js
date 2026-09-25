'use strict';
const assert = require('assert');
const moment = require('moment-timezone');
const create = require('../lib/profilefunctions');
const fixture = require('./fixtures/unnamed-profile.json');
const clone = value => JSON.parse(JSON.stringify(value));

describe('Unnamed profile stores', function () {
  it('preserves the empty selection, all settings, and metadata', function () {
    const input = clone(fixture);
    const p = create([input], { moment });
    assert.strictEqual(p.data[0].defaultProfile, '');
    assert.deepStrictEqual(Object.keys(p.data[0].store), ['', 'Named']);
    assert.strictEqual(p.data[0].convertedOnTheFly, undefined);
    assert.strictEqual(p.data[0].created_at, fixture.created_at);
    assert.strictEqual(p.activeProfileToTime(), '');
    assert.strictEqual(p.getDIA(), 6);
    assert.strictEqual(p.getBasal(), 0.5);
    assert.strictEqual(p.getSensitivity(), 2.5);
    assert.strictEqual(p.getCarbRatio(), 10);
    assert.strictEqual(p.getLowBGTarget(), 5);
    assert.strictEqual(p.getHighBGTarget(), 6);
    assert.strictEqual(p.getTimezone(), 'UTC');
    assert.strictEqual(p.getUnits(), 'mmol');
  });
  [undefined, null, 'Missing', 'toString'].forEach(function (name) {
    it('does not wrap or select a fallback for invalid pointer ' + name, function () {
      const record = clone(fixture);
      record.defaultProfile = name;
      record.store.null = clone(record.store.Named);
      const p = create([record], { moment });
      assert.strictEqual(p.data[0].convertedOnTheFly, undefined);
      assert.strictEqual(p.data[0].defaultProfile, name);
      assert.strictEqual(p.activeProfileToTime(), null);
      assert.deepStrictEqual(p.getCurrentProfile(), {});
      assert.strictEqual(p.getBasal(), undefined);
    });
  });
  it('retains named and legacy compatibility', function () {
    const named = clone(fixture);
    named.defaultProfile = 'Named';
    assert.strictEqual(create([named], { moment }).getDIA(), 5);
    const legacy = create([clone(fixture.store[''])], { moment });
    assert.strictEqual(legacy.activeProfileToTime(), 'Default');
    assert.strictEqual(legacy.getDIA(), 6);
  });
  it('can remove a named profile and select its unnamed sibling', function () {
    const record = clone(fixture);
    const result = require('../lib/client-core/profile-editor/profiles').removeProfile(record, 'Named');
    assert.strictEqual(result.removed, true);
    assert.strictEqual(result.currentProfile, '');
    assert.deepStrictEqual(Object.keys(record.store), ['']);
  });
  it('continues basal rendering for an unnamed active profile', function () {
    const p = create([clone(fixture)], { moment });
    const reachedSampling = new Error('reached basal sampling');
    p.getBasalRenderTimes = () => { throw reachedSampling; };
    const client = {
      settings: { isEnabled: () => true, extendedSettings: { basal: { render: 'default' } } },
      sbx: { data: { profile: p } },
      chart: { createAdjustedRange: () => [new Date(), new Date()] }
    };
    assert.throws(() => require('../lib/client/renderer')(client, {}).addBasals(client),
      error => error === reachedSampling);
  });
});
