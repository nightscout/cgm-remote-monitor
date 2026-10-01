'use strict';

/*
 * tests/client-core/profile-editor-migrate.captured.test.js
 *
 * Golden-shape tests that feed real-world Loop-managed profile
 * records (sanitized, see tests/fixtures/captured/README.md)
 * through the pure profile-editor migration logic and assert that:
 *
 *   1. Every profile in every record migrates without throwing.
 *   2. After migration, every store profile has the canonical
 *      key set defined by buildDefaultProfile().
 *   3. All time-series fields (sens, target_low, target_high,
 *      basal, carbratio) are coerced to range arrays.
 *   4. Migration is idempotent: running it twice produces the
 *      same result as running it once.
 *
 * If a future change breaks these guarantees against real Loop
 * payloads (which is what the bundle actually sees in production),
 * this suite will catch it before the bundle does.
 */

require('should');
var fs = require('fs');
var path = require('path');

var migrate = require('../../lib/client-core/profile-editor/migrate');
var buildDefaultProfile = require('../../lib/client-core/profile-editor/default-profile');

var CAPTURED = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'captured', 'loop', 'profile.json'), 'utf8'));

var RANGE_FIELDS = ['sens', 'target_low', 'target_high', 'basal', 'carbratio'];

function freshDefaults () {
  // buildDefaultProfile() takes no arguments.
  return buildDefaultProfile();
}

describe('client-core: profile-editor / migrate (captured Loop fixtures)', function () {

  it('captured fixture set is non-empty', function () {
    CAPTURED.length.should.be.greaterThan(0);
  });

  CAPTURED.forEach(function (record, recordIdx) {
    describe('record[' + recordIdx + '] (' + Object.keys(record.store || {}).join(',') + ')', function () {

      var migrated;
      var result;

      before(function () {
        // Deep clone so we never mutate the shared fixture in memory.
        var clone = JSON.parse(JSON.stringify(record));
        result = migrate.migrateRecordStore(clone, freshDefaults());
        migrated = clone;
      });

      it('returns a mismatchedProfiles array (possibly empty)', function () {
        result.should.have.property('mismatchedProfiles').which.is.an.Array();
      });

      it('every store profile has the canonical default key set', function () {
        var defaultKeys = Object.keys(freshDefaults()).sort();
        Object.keys(migrated.store).forEach(function (name) {
          /* eslint-disable-next-line security/detect-object-injection */
          var profileKeys = Object.keys(migrated.store[name]).sort();
          profileKeys.should.eql(defaultKeys, 'profile "' + name + '"');
        });
      });

      it('every range field is an array of {time,value} entries', function () {
        Object.keys(migrated.store).forEach(function (name) {
          /* eslint-disable-next-line security/detect-object-injection */
          var profile = migrated.store[name];
          RANGE_FIELDS.forEach(function (f) {
            /* eslint-disable-next-line security/detect-object-injection */
            var v = profile[f];
            v.should.be.an.Array();
            v.length.should.be.greaterThan(0);
            v.forEach(function (entry) {
              entry.should.have.property('time').which.is.a.String();
              entry.should.have.property('value');
            });
          });
        });
      });

      it('migration is idempotent', function () {
        var twice = JSON.parse(JSON.stringify(migrated));
        migrate.migrateRecordStore(twice, freshDefaults());
        twice.should.eql(migrated);
      });
    });
  });
});
