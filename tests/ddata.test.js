
'use strict';

var should = require('should');


describe('ddata', function ( ) {
  // var sandbox = require('../lib/sandbox')();
  // var env = require('../lib/server/env')();
  var ctx = {};
  ctx.ddata = require('../lib/data/ddata')();

  it('should be a module', function (done) {
    var libddata = require('../lib/data/ddata');
    var ddata = libddata( );
    should.exist(ddata);
    should.exist(libddata);
    should.exist(libddata.call);
    ddata = ctx.ddata.clone( );
    should.exist(ddata);
    done( );
  });

  it('has #clone( )', function (done) {
    should.exist(ctx.ddata.treatments);
    should.exist(ctx.ddata.sgvs);
    should.exist(ctx.ddata.mbgs);
    should.exist(ctx.ddata.cals);
    should.exist(ctx.ddata.profiles);
    should.exist(ctx.ddata.devicestatus);
    should.exist(ctx.ddata.lastUpdated);
    var ddata = ctx.ddata.clone( );
    should.exist(ddata);
    should.exist(ddata.treatments);
    should.exist(ddata.sgvs);
    should.exist(ddata.mbgs);
    should.exist(ddata.cals);
    should.exist(ddata.profiles);
    should.exist(ddata.devicestatus);
    should.exist(ddata.lastUpdated);
    done( );
  });

  it('processRawDataForRuntime derives duration and endmills from durationInMilliseconds', function () {
    var ddata = require('../lib/data/ddata')();
    var createdAt = '2026-03-06T10:00:00.000Z';
    var result = ddata.processRawDataForRuntime([{
      _id: '507f1f77bcf86cd799439011',
      created_at: createdAt,
      durationInMilliseconds: 26584
    }])[0];

    result.mills.should.equal(new Date(createdAt).getTime());
    result.duration.should.equal(0);
    result.endmills.should.equal(result.mills + 26584);
  });

  it('idMergePreferNew matches records by identifier when _id is missing', function () {
    var ddata = require('../lib/data/ddata')();
    var merged = ddata.idMergePreferNew(
      [{ _id: 'mongo-id', identifier: 'loop-id', carbs: 15 }],
      [{ identifier: 'loop-id', carbs: 0 }]
    );

    merged.length.should.equal(1);
    merged[0].carbs.should.equal(0);
    merged[0].identifier.should.equal('loop-id');
  });

  describe('normalizeAapsRunningModes', function () {
    var infiniteDuration = 2147483647;
    var infiniteDurationInMilliseconds = infiniteDuration * 60000;

    function disabledAt(mills) {
      return {
        eventType: 'OpenAPS Offline',
        mode: 'DISABLED_LOOP',
        mills: mills,
        duration: infiniteDuration,
        durationInMilliseconds: infiniteDurationInMilliseconds,
        originalDuration: infiniteDurationInMilliseconds,
        endmills: mills + infiniteDurationInMilliseconds
      };
    }

    ['CLOSED_LOOP', 'OPEN_LOOP', 'CLOSED_LOOP_LGS'].forEach(function (mode) {
      it('ends an infinite DISABLED_LOOP when followed by ' + mode, function () {
        var ddata = require('../lib/data/ddata')();
        var disabled = disabledAt(1000);
        var treatments = [
          disabled,
          { eventType: 'OpenAPS Offline', mode: mode, mills: 1801000, duration: 0 }
        ];

        var normalized = ddata.normalizeAapsRunningModes(treatments);

        normalized[0].duration.should.equal(30);
        normalized[0].durationInMilliseconds.should.equal(1800000);
        normalized[0].endmills.should.equal(1801000);
        disabled.duration.should.equal(infiniteDuration);
        disabled.endmills.should.equal(1000 + infiniteDurationInMilliseconds);
      });
    });

    it('does not change legacy OpenAPS Offline treatments without a mode', function () {
      var ddata = require('../lib/data/ddata')();
      var treatments = [
        { eventType: 'OpenAPS Offline', mills: 1000, duration: infiniteDuration },
        { eventType: 'OpenAPS Offline', mode: 'CLOSED_LOOP', mills: 1801000, duration: 0 }
      ];

      var normalized = ddata.normalizeAapsRunningModes(treatments);

      normalized[0].duration.should.equal(infiniteDuration);
      should.not.exist(normalized[0].durationInMilliseconds);
      should.not.exist(normalized[0].endmills);
    });

    it('does not change finite DISABLED_LOOP treatments', function () {
      var ddata = require('../lib/data/ddata')();
      var treatments = [
        { eventType: 'OpenAPS Offline', mode: 'DISABLED_LOOP', mills: 1000, duration: 60 },
        { eventType: 'OpenAPS Offline', mode: 'OPEN_LOOP', mills: 1801000, duration: 0 }
      ];

      var normalized = ddata.normalizeAapsRunningModes(treatments);

      normalized[0].duration.should.equal(60);
      should.not.exist(normalized[0].durationInMilliseconds);
      should.not.exist(normalized[0].endmills);
    });

    it('tracks pending DISABLED_LOOP treatments by source', function () {
      var ddata = require('../lib/data/ddata')();
      var first = Object.assign(disabledAt(1000), { pumpType: 'AAPS', pumpSerial: 'first' });
      var second = Object.assign(disabledAt(2000), { pumpType: 'AAPS', pumpSerial: 'second' });
      var treatments = [
        first,
        second,
        {
          eventType: 'OpenAPS Offline',
          mode: 'CLOSED_LOOP',
          mills: 1801000,
          duration: 0,
          pumpType: 'AAPS',
          pumpSerial: 'first'
        }
      ];

      var normalized = ddata.normalizeAapsRunningModes(treatments);

      normalized[0].duration.should.equal(30);
      normalized[1].should.equal(second);
      normalized[1].duration.should.equal(infiniteDuration);
    });

    it('ignores invalid RunningMode treatments', function () {
      var ddata = require('../lib/data/ddata')();
      var disabled = disabledAt(1000);
      var treatments = [
        disabled,
        {
          eventType: 'OpenAPS Offline',
          mode: 'CLOSED_LOOP',
          mills: 1801000,
          duration: 0,
          isValid: false
        }
      ];

      var normalized = ddata.normalizeAapsRunningModes(treatments);

      normalized[0].should.equal(disabled);
      normalized[0].duration.should.equal(infiniteDuration);
    });

    it('only clones treatments that are modified', function () {
      var ddata = require('../lib/data/ddata')();
      var disabled = disabledAt(1000);
      var running = { eventType: 'OpenAPS Offline', mode: 'OPEN_LOOP', mills: 1801000, duration: 0 };
      var unrelated = { eventType: 'Note', mills: 2000000, notes: 'unchanged' };
      var treatments = [disabled, running, unrelated];

      var normalized = ddata.normalizeAapsRunningModes(treatments);

      normalized[0].should.not.equal(disabled);
      normalized[1].should.equal(running);
      normalized[2].should.equal(unrelated);
      disabled.duration.should.equal(infiniteDuration);
    });

    it('does not create a zero-length Offline period', function () {
      var ddata = require('../lib/data/ddata')();
      var disabled = disabledAt(1000);
      var treatments = [
        disabled,
        { eventType: 'OpenAPS Offline', mode: 'CLOSED_LOOP', mills: 1000, duration: 0 }
      ];

      var normalized = ddata.normalizeAapsRunningModes(treatments);

      normalized[0].should.equal(disabled);
      normalized[0].duration.should.equal(infiniteDuration);
    });

    it('ends duplicate infinite DISABLED_LOOP treatments at the same enabled mode', function () {
      var ddata = require('../lib/data/ddata')();
      var first = disabledAt(1000);
      var second = disabledAt(2000);
      var treatments = [
        first,
        second,
        { eventType: 'OpenAPS Offline', mode: 'CLOSED_LOOP', mills: 61000, duration: 0 }
      ];

      var normalized = ddata.normalizeAapsRunningModes(treatments);

      normalized[0].durationInMilliseconds.should.equal(60000);
      normalized[0].endmills.should.equal(61000);
      normalized[1].durationInMilliseconds.should.equal(59000);
      normalized[1].endmills.should.equal(61000);
      first.duration.should.equal(infiniteDuration);
      second.duration.should.equal(infiniteDuration);
    });

    it('normalizes out-of-order treatments while preserving their order', function () {
      var ddata = require('../lib/data/ddata')();
      var running = { eventType: 'OpenAPS Offline', mode: 'OPEN_LOOP', mills: 61000, duration: 0 };
      var disabled = disabledAt(1000);
      var treatments = [running, disabled];

      var normalized = ddata.normalizeAapsRunningModes(treatments);

      normalized[0].should.equal(running);
      normalized[1].durationInMilliseconds.should.equal(60000);
      normalized[1].endmills.should.equal(61000);
      disabled.duration.should.equal(infiniteDuration);
    });

    [
      { name: 'null', mills: null },
      { name: 'missing' },
      { name: 'nonnumeric', mills: 'not-a-time' },
      { name: 'NaN', mills: NaN },
      { name: 'infinite', mills: Infinity }
    ].forEach(function (invalidTime) {
      it('ignores a DISABLED_LOOP treatment with a ' + invalidTime.name + ' timestamp', function () {
        var ddata = require('../lib/data/ddata')();
        var disabled = disabledAt(invalidTime.mills);
        if (!Object.prototype.hasOwnProperty.call(invalidTime, 'mills')) {
          delete disabled.mills;
        }
        var treatments = [
          disabled,
          { eventType: 'OpenAPS Offline', mode: 'CLOSED_LOOP', mills: 61000, duration: 0 }
        ];

        var normalized = ddata.normalizeAapsRunningModes(treatments);

        normalized[0].should.equal(disabled);
        normalized[0].duration.should.equal(infiniteDuration);
      });
    });

    it('preserves millisecond precision for a transition shorter than one minute', function () {
      var ddata = require('../lib/data/ddata')();
      var treatments = [
        disabledAt(1000),
        { eventType: 'OpenAPS Offline', mode: 'CLOSED_LOOP', mills: 27584, duration: 0 }
      ];

      var normalized = ddata.normalizeAapsRunningModes(treatments);

      normalized[0].durationInMilliseconds.should.equal(26584);
      normalized[0].duration.should.equal(26584 / 60000);
      normalized[0].endmills.should.equal(27584);
    });

    it('normalizes multiple enable and disable cycles for the same source', function () {
      var ddata = require('../lib/data/ddata')();
      var firstDisabled = Object.assign(disabledAt(1000), { pumpSerial: 'same' });
      var secondDisabled = Object.assign(disabledAt(121000), { pumpSerial: 'same' });
      var treatments = [
        secondDisabled,
        {
          eventType: 'OpenAPS Offline',
          mode: 'OPEN_LOOP',
          mills: 181000,
          duration: 0,
          pumpSerial: 'same'
        },
        firstDisabled,
        {
          eventType: 'OpenAPS Offline',
          mode: 'CLOSED_LOOP',
          mills: 61000,
          duration: 0,
          pumpSerial: 'same'
        }
      ];

      var normalized = ddata.normalizeAapsRunningModes(treatments);

      normalized[0].durationInMilliseconds.should.equal(60000);
      normalized[0].endmills.should.equal(181000);
      normalized[1].should.equal(treatments[1]);
      normalized[2].durationInMilliseconds.should.equal(60000);
      normalized[2].endmills.should.equal(61000);
      normalized[3].should.equal(treatments[3]);
    });

    it('is idempotent', function () {
      var ddata = require('../lib/data/ddata')();
      var treatments = [
        disabledAt(1000),
        { eventType: 'OpenAPS Offline', mode: 'CLOSED_LOOP', mills: 1801000, duration: 0 }
      ];

      var once = ddata.normalizeAapsRunningModes(treatments);
      var twice = ddata.normalizeAapsRunningModes(once);

      twice.should.deepEqual(once);
    });

    it('is applied by processTreatments', function () {
      var ddata = require('../lib/data/ddata')();
      ddata.treatments = [
        disabledAt(1000),
        { eventType: 'OpenAPS Offline', mode: 'CLOSED_LOOP', mills: 1801000, duration: 0 }
      ];

      ddata.processTreatments(false);

      ddata.treatments[0].duration.should.equal(30);
      ddata.treatments[0].durationInMilliseconds.should.equal(1800000);
      ddata.treatments[0].endmills.should.equal(1801000);
    });
  });

  // TODO: ensure partition function gets called via:
  // Properties
  // * ddata.devicestatus
  // * ddata.mbgs
  // * ddata.sgvs
  // * ddata.treatments
  // * ddata.profiles
  // * ddata.lastUpdated
  // Methods
  // * ddata.processTreatments
  // * ddata.processDurations
  // * ddata.clone
  // * ddata.split
 

});
