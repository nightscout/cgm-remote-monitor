'use strict';

// Node-only replacement for the skipped, bundle-driven tests/profileeditor.test.js.
// The original assertions counted DOM <option> elements in #pe_databaserecords
// and #pe_profiles after clicking add/remove/clone buttons, then poked the I:C
// and target-bg range arrays via add/delete-row icons. All of those operations
// are now backed by pure modules in lib/client-core/profile-editor/, so we can
// assert the same shape changes on the underlying data without booting a
// jsdom + jQuery + Flot bundle.
//
// When the Phase 5b adapter refactor is fully wired, the bundle-driven test
// becomes redundant — this file is what proves the behavior is preserved.

require('should');
var buildDefaultProfile = require('../lib/client-core/profile-editor/default-profile');
var records = require('../lib/client-core/profile-editor/records');
var profilesMod = require('../lib/client-core/profile-editor/profiles');
var ranges = require('../lib/client-core/profile-editor/ranges');

describe('Profile editor (records / profiles / ranges via core)', function () {

  it('mirrors the legacy DOM test: record add/remove/clone changes mongorecords length', function () {
    var arr = [records.newEmptyRecord(buildDefaultProfile())];

    // Initial state: #pe_databaserecords option length === 1
    arr.length.should.equal(1);

    // $('#pe_records_add').click() → length 2
    var afterAdd = records.addRecord(arr, buildDefaultProfile());
    arr.length.should.equal(2);
    afterAdd.currentIndex.should.equal(1);

    // $('#pe_records_remove').click() (with confirm=true) → length 1
    var afterRemove = records.removeRecord(arr, afterAdd.currentIndex);
    arr.length.should.equal(1);
    afterRemove.removed.should.be.true();

    // $('#pe_records_clone').click() → length 2
    var afterClone = records.cloneRecord(arr, 0);
    arr.length.should.equal(2);
    afterClone.currentIndex.should.equal(1);
  });

  it('mirrors the legacy DOM test: profile add/remove/clone changes store size', function () {
    var record = records.newEmptyRecord(buildDefaultProfile());

    // Initial: #pe_profiles option length === 1
    Object.keys(record.store).length.should.equal(1);

    // $('#pe_profile_add').click() → length 2
    profilesMod.addProfile(record, buildDefaultProfile());
    Object.keys(record.store).length.should.equal(2);

    // Original then renamed via #pe_profile_name to "Test", switched away,
    // and clicked $('#pe_profile_remove').click() (with confirm=true) → length 1.
    // We model the rename + remove directly.
    profilesMod.renameProfile(record, 'New profile', 'Test');
    var rmRes = profilesMod.removeProfile(record, 'Test');
    rmRes.removed.should.be.true();
    Object.keys(record.store).length.should.equal(1);

    // $('#pe_profile_clone').click() → length 2
    profilesMod.cloneProfile(record, record.defaultProfile);
    Object.keys(record.store).length.should.equal(2);
  });

  it('mirrors the legacy DOM test: I:C range add then delete restores values', function () {
    // Seeded carbratio matches the buildDefaultProfile (single 30 g/U at 00:00).
    var profile = buildDefaultProfile();
    profile.carbratio[0].value.should.equal(30); // pe_ic_val_0 === '30'

    // $('#pe_ic_placeholder').find('img.addsingle').click() at pos 0 →
    // a new {time:'00:00', value:0} is inserted at index 0 so:
    //   pe_ic_val_0 === '0', pe_ic_val_1 === '30'
    ranges.addRangeStop(profile.carbratio, 0);
    profile.carbratio[0].value.should.equal(0);
    profile.carbratio[1].value.should.equal(30);

    // $('#pe_ic_placeholder').find('img.delsingle').click() removes the new row;
    // arr[0].time invariant kept at '00:00'; pe_ic_val_0 === '30' again.
    ranges.removeRangeStop(profile.carbratio, 0);
    profile.carbratio[0].value.should.equal(30);
    profile.carbratio[0].time.should.equal('00:00');
  });

  it('mirrors the legacy DOM test: target BG range add+delete keeps low/high in lockstep', function () {
    var profile = buildDefaultProfile();
    // The legacy test seeded target_low to 100; we use the buildDefaultProfile
    // value (0) for the assertion shape. The behavior we care about is that
    // the per-row value is preserved across add/delete and indices line up.
    var initialLow = profile.target_low[0].value;
    var initialHigh = profile.target_high[0].value;

    ranges.addTargetStop(profile.target_low, profile.target_high, 0);
    profile.target_low.length.should.equal(2);
    profile.target_high.length.should.equal(2);
    profile.target_low[0].value.should.equal(0);
    profile.target_low[1].value.should.equal(initialLow);
    profile.target_high[1].value.should.equal(initialHigh);

    ranges.removeTargetStop(profile.target_low, profile.target_high, 0);
    profile.target_low.length.should.equal(1);
    profile.target_high.length.should.equal(1);
    profile.target_low[0].value.should.equal(initialLow);
    profile.target_high[0].value.should.equal(initialHigh);
  });
});
