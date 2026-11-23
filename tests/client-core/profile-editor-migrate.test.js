'use strict';
require('should');

var migrate = require('../../lib/client-core/profile-editor/migrate');
var buildDefaultProfile = require('../../lib/client-core/profile-editor/default-profile');

describe('client-core: profile-editor / migrate', function () {

  describe('alignProfileWithDefaults', function () {
    it('adds missing keys from defaults', function () {
      var defaults = buildDefaultProfile();
      var p = { dia: 5 };
      migrate.alignProfileWithDefaults(p, defaults);
      p.should.have.property('carbratio');
      p.should.have.property('sens');
      p.dia.should.equal(5); // existing keys preserved
    });

    it('drops keys not present in defaults', function () {
      var defaults = buildDefaultProfile();
      var p = Object.assign(buildDefaultProfile(), { rogue: 'remove-me' });
      migrate.alignProfileWithDefaults(p, defaults);
      p.should.not.have.property('rogue');
    });

    it('is a no-op for null inputs', function () {
      (migrate.alignProfileWithDefaults(null, buildDefaultProfile()) === null).should.be.true();
    });
  });

  describe('convertToRanges', function () {
    it('coerces scalar carbratio/sens/target/basal into [{time,value}]', function () {
      var p = {
        carbratio: 12,
        sens: 50,
        target_low: 80,
        target_high: 140,
        basal: 0.5
      };
      var res = migrate.convertToRanges(p, buildDefaultProfile());
      p.carbratio.should.eql([{ time: '00:00', value: 12 }]);
      p.sens.should.eql([{ time: '00:00', value: 50 }]);
      p.basal.should.eql([{ time: '00:00', value: 0.5 }]);
      res.rangesMismatch.should.be.false();
    });

    it('leaves array-form fields untouched', function () {
      var ranges = [{ time: '00:00', value: 10 }, { time: '06:00', value: 20 }];
      var p = {
        carbratio: ranges,
        sens: [{ time: '00:00', value: 100 }],
        target_low: [{ time: '00:00', value: 80 }],
        target_high: [{ time: '00:00', value: 140 }],
        basal: [{ time: '00:00', value: 0.5 }]
      };
      migrate.convertToRanges(p, buildDefaultProfile());
      p.carbratio.should.equal(ranges); // same reference
    });

    it('flags mismatch when target_low/target_high lengths differ and resets to defaults', function () {
      var defaults = buildDefaultProfile();
      var p = {
        carbratio: 12, sens: 50, basal: 0.5,
        target_low: [{ time: '00:00', value: 80 }, { time: '06:00', value: 90 }],
        target_high: [{ time: '00:00', value: 140 }]
      };
      var res = migrate.convertToRanges(p, defaults);
      res.rangesMismatch.should.be.true();
      p.target_low.should.eql(defaults.target_low);
      p.target_high.should.eql(defaults.target_high);
    });
  });

  describe('migrateRecordStore', function () {
    it('applies align+convert to every named profile and returns mismatch list', function () {
      var defaults = buildDefaultProfile();
      var record = {
        store: {
          'A': { dia: 4, carbratio: 10, sens: 50, target_low: 80, target_high: 140, basal: 0.4 },
          'B': {
            dia: 3,
            carbratio: 15,
            sens: 60,
            target_low: [{ time: '00:00', value: 80 }, { time: '06:00', value: 90 }],
            target_high: [{ time: '00:00', value: 140 }],
            basal: 0.5
          }
        }
      };
      var res = migrate.migrateRecordStore(record, defaults);
      res.mismatchedProfiles.should.eql(['B']);
      record.store.A.carbratio.should.eql([{ time: '00:00', value: 10 }]);
      // missing keys filled
      record.store.A.should.have.property('timezone');
    });

    it('handles records with no store gracefully', function () {
      migrate.migrateRecordStore({}, buildDefaultProfile()).mismatchedProfiles.should.eql([]);
      migrate.migrateRecordStore(null, buildDefaultProfile()).mismatchedProfiles.should.eql([]);
    });
  });
});
