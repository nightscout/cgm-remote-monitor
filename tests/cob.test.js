'use strict';

const deepMerge = require('../lib/utils/deepMerge');
const helper = require('./inithelper')();

require('should');

describe('COB', function ( ) {
  var ctx = helper.ctx;

  var cob = require('../lib/plugins/cob')(ctx);

  var profileData = {
    startDate: '2015-06-21'
    , sens: 95
    , carbratio: 18
    , carbs_hr: 30
  };

  var profile = require('../lib/profilefunctions')([profileData], ctx);

  it('should calculate IOB, multiple treatments', function() {

    var treatments = [
      {
        'carbs': '100',
        'mills': new Date('2015-05-29T02:03:48.827Z').getTime()
      },
      {
        'carbs': '10',
        'mills': new Date('2015-05-29T03:45:10.670Z').getTime()
      }
    ];

    var devicestatus = [];

    var after100 = cob.cobTotal(treatments, devicestatus, profile, new Date('2015-05-29T02:03:49.827Z').getTime());
    var before10 = cob.cobTotal(treatments, devicestatus, profile, new Date('2015-05-29T03:45:10.670Z').getTime());
    var after10 = cob.cobTotal(treatments, devicestatus, profile, new Date('2015-05-29T03:45:11.670Z').getTime());

    after100.cob.should.equal(100);
    Math.round(before10.cob).should.equal(59);
    Math.round(after10.cob).should.equal(69); //WTF == 128
  });

  it('should calculate IOB, single treatment', function() {

    var treatments = [
      {
        'carbs': '8',
        'mills': new Date('2015-05-29T04:40:40.174Z').getTime()
      }
    ];

    var devicestatus = [];

    var rightAfterCorrection = new Date('2015-05-29T04:41:40.174Z').getTime();
    var later1 = new Date('2015-05-29T05:04:40.174Z').getTime();
    var later2 = new Date('2015-05-29T05:20:00.174Z').getTime();
    var later3 = new Date('2015-05-29T05:50:00.174Z').getTime();
    var later4 = new Date('2015-05-29T06:50:00.174Z').getTime();

    var result1 = cob.cobTotal(treatments, devicestatus, profile, rightAfterCorrection);
    var result2 = cob.cobTotal(treatments, devicestatus, profile, later1);
    var result3 = cob.cobTotal(treatments, devicestatus, profile, later2);
    var result4 = cob.cobTotal(treatments, devicestatus, profile, later3);
    var result5 = cob.cobTotal(treatments, devicestatus, profile, later4);

    result1.cob.should.equal(8);
    result2.cob.should.equal(6);
    result3.cob.should.equal(0);
    result4.cob.should.equal(0);
    result5.cob.should.equal(0);
  });

  it('set a pill to the current COB', function (done) {
    var data = {
      treatments: [{
        carbs: '8'
        , 'mills': Date.now() - 60000 //1m ago
      }]
      , profile: profile
    };

    ctx.pluginBase = {
        updatePillText: function mockedUpdatePillText (plugin, options) {
          plugin.name.should.equal('cob');
          plugin.pluginType.should.equal('pill-minor');
          options.value.should.equal('8g');
          done();
        }
    };

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, Date.now(), data);
    cob.setProperties(sbx);
    cob.updateVisualisation(sbx);

  });

  it('shows the source, device and Nightscout comparison on the pill', function (done) {
    var now = Date.now();
    var data = {
      treatments: [{
        carbs: '8'
        , 'mills': now - 60000 //1m ago
      }]
      , devicestatus: [{
        device: 'Trio'
        , mills: now - 60000
        , openaps: { suggested: { COB: 61, timestamp: now - 60000 } }
      }]
      , profile: profile
    };

    ctx.pluginBase = {
        updatePillText: function mockedUpdatePillText (plugin, options) {
          options.value.should.equal('61g');
          options.info[0].should.eql({ label: 'Source', value: 'OpenAPS' });
          options.info[1].should.eql({ label: 'Device', value: 'Trio' });
          options.info[2].should.eql({ label: '------------', value: '' });
          options.info[3].label.should.equal('Careportal COB');
          options.info[3].value.should.equal(8);
          done();
        }
    };

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, now, data);
    cob.setProperties(sbx);
    cob.updateVisualisation(sbx);

  });

  it('should handle virtAsst requests', function (done) {
    var data = {
      treatments: [{
        carbs: '8'
        , 'mills': Date.now() - 60000 //1m ago
      }]
      , profile: profile
    };

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, Date.now(), data);
    cob.setProperties(sbx);

    cob.virtAsst.intentHandlers.length.should.equal(1);

    cob.virtAsst.intentHandlers[0].intentHandler(function next(title, response) {
      title.should.equal('Current COB');
      response.should.equal('You have 8 carbohydrates on board');
      done();
    }, [], sbx);

  });

  describe('from devicestatus', function () {
    var time = Date.now();
    var treatments = [{
      mills: time - 1,
      carbs: '20'
    }];

    var OPENAPS_DEVICESTATUS = {
      device: 'openaps://pi1',
      openaps: {
        enacted: {
          COB: 30
        }
      }
    };

    var treatmentCOB = cob.fromTreatments(treatments, OPENAPS_DEVICESTATUS, profile, time).cob;

    it('should fall back to treatment data if no devicestatus data', function() {
      cob.cobTotal(treatments, [], profile, time).should.containEql({
        source: 'Care Portal',
        cob: treatmentCOB
      });
    });

    it('should fall back to treatments if openaps devicestatus is present but empty', function() {
      var devicestatus = [{
        device: 'openaps://pi1',
        mills: time - 1,
        openaps: {}
      }];
      cob.cobTotal(treatments, devicestatus, profile, time).cob.should.equal(treatmentCOB);
    });

    it('should fall back to treatments if openaps devicestatus is present but too stale', function() {
      var devicestatus = [deepMerge(OPENAPS_DEVICESTATUS, { mills: time - cob.RECENCY_THRESHOLD - 1, openaps: {enacted: {COB: 5, timestamp: time - cob.RECENCY_THRESHOLD - 1} } })];
      cob.cobTotal(treatments, devicestatus, profile, time).should.containEql({
        source: 'Care Portal',
        cob: treatmentCOB
      });
    });

    it('should return COB data from OpenAPS', function () {
      var devicestatus = [deepMerge(OPENAPS_DEVICESTATUS, { mills: time - 1, openaps: {enacted: {COB: 5, timestamp: time - 1} } })];
      cob.cobTotal(treatments, devicestatus, profile, time).should.containEql({
        cob: 5,
        source: 'OpenAPS',
        device: 'openaps://pi1'
      });
    });

    it('should return historical OpenAPS COB data when viewing retro time', function () {
      var viewTime = time - (60 * 60 * 1000);
      var cobTime = viewTime - 1;
      var devicestatus = [{
        device: 'openaps://pi1',
        mills: cobTime,
        openaps: {
          enacted: {
            COB: 6,
            timestamp: cobTime
          }
        }
      }];

      cob.cobTotal([], devicestatus, profile, viewTime).should.containEql({
        cob: 6,
        source: 'OpenAPS',
        device: 'openaps://pi1'
      });
    });

    it('should fall back to treatments when historical OpenAPS COB is stale for retro time', function() {
      var viewTime = time - (60 * 60 * 1000);
      var staleCobTime = viewTime - (11 * 60 * 1000);
      var retroTreatments = [{
        mills: viewTime - 1,
        carbs: '20'
      }];
      var retroTreatmentCOB = cob.fromTreatments(retroTreatments, [], profile, viewTime).cob;
      var devicestatus = [{
        device: 'openaps://pi1',
        mills: staleCobTime,
        openaps: {
          enacted: {
            COB: 6,
            timestamp: staleCobTime
          }
        }
      }];

      cob.cobTotal(retroTreatments, devicestatus, profile, viewTime).should.containEql({
        source: 'Care Portal',
        cob: retroTreatmentCOB
      });
    });

    it('should return COB data from Loop', function () {

      var LOOP_DEVICESTATUS = {
        device: 'loop://iPhone',
        loop: {
          cob: {
            cob: 5
          }
        }
      };

      var devicestatus = [deepMerge(LOOP_DEVICESTATUS, { mills: time - 1, loop: {cob: {timestamp: time - 1} } })];
      cob.cobTotal(treatments, devicestatus, profile, time).should.containEql({
        cob: 5,
        source: 'Loop',
        device: 'loop://iPhone'
      });
    });

    it('should use uploader COB when there is no treatment profile', function () {
      var devicestatus = [deepMerge(OPENAPS_DEVICESTATUS, { mills: time - 1, openaps: {enacted: {COB: 5, timestamp: time - 1} } })];
      cob.cobTotal(treatments, devicestatus, undefined, time).should.containEql({
        cob: 5,
        source: 'OpenAPS',
        device: 'openaps://pi1'
      });
    });

    it('should use uploader COB when the profile has no sens or carbratio', function () {
      var bareProfile = require('../lib/profilefunctions')([{ startDate: '2015-06-21', carbs_hr: 30 }], ctx);
      var devicestatus = [deepMerge(OPENAPS_DEVICESTATUS, { mills: time - 1, openaps: {enacted: {COB: 5, timestamp: time - 1} } })];
      cob.cobTotal(treatments, devicestatus, bareProfile, time).should.containEql({
        cob: 5,
        source: 'OpenAPS'
      });
    });

    it('should have no COB without a profile once uploader COB goes stale', function () {
      var staleMills = time - (11 * 60 * 1000);
      var devicestatus = [deepMerge(OPENAPS_DEVICESTATUS, { mills: staleMills, openaps: {enacted: {COB: 5, timestamp: staleMills} } })];
      cob.cobTotal(treatments, devicestatus, undefined, time).should.eql({});
    });

    it('should have no COB without a profile and without uploader COB', function () {
      cob.cobTotal(treatments, [], undefined, time).should.eql({});
    });

    it('should carry the treatment-derived COB alongside the uploader value', function () {
      var devicestatus = [deepMerge(OPENAPS_DEVICESTATUS, { mills: time - 1, openaps: {enacted: {COB: 5, timestamp: time - 1} } })];
      cob.cobTotal(treatments, devicestatus, profile, time).treatmentCOB.should.equal(treatmentCOB);
    });

    it('should not carry a treatment-derived COB when it is the displayed value', function () {
      (cob.cobTotal(treatments, [], profile, time).treatmentCOB === undefined).should.equal(true);
    });

    it('should return historical Loop COB data when viewing retro time', function () {
      var viewTime = time - (60 * 60 * 1000);
      var cobTime = viewTime - 1;
      var devicestatus = [{
        device: 'loop://iPhone',
        mills: cobTime,
        loop: {
          cob: {
            cob: 7,
            timestamp: cobTime
          }
        }
      }];

      cob.cobTotal([], devicestatus, profile, viewTime).should.containEql({
        cob: 7,
        source: 'Loop',
        device: 'loop://iPhone'
      });
    });

  });


});
