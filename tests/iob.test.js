'use strict';

var should = require('should');

var sandbox = require('../lib/sandbox')();

describe('IOB', function ( ) {
  var iob = require('../lib/plugins/iob')();


  it('should calculate IOB', function() {

    var time = Date.now()
      , treatments = [ {
          mills: time - 1,
          insulin: '1.00'
        }
      ];
    
    
  var profileData = {
    dia: 3,
    sens: 0};

   var profile = require('../lib/profilefunctions')([profileData]);

    var rightAfterBolus = iob.calcTotal(treatments, profile, time);

    rightAfterBolus.display.should.equal('1.00');

    var afterSomeTime = iob.calcTotal(treatments, profile, time + (60 * 60 * 1000));

    afterSomeTime.iob.should.be.lessThan(1);
    afterSomeTime.iob.should.be.greaterThan(0);

    var afterDIA = iob.calcTotal(treatments, profile, time + (3 * 60 * 60 * 1000));

    afterDIA.iob.should.equal(0);

  });

  it('should calculate IOB using defaults', function() {

    var treatments = [{
      mills: Date.now() - 1,
      insulin: '1.00'
    }];

    var rightAfterBolus = iob.calcTotal(treatments);

    rightAfterBolus.display.should.equal('1.00');

  });

  it('should not show a negative IOB when approaching 0', function() {

    var time = Date.now() - 1;

    var treatments = [{
      mills: time,
      insulin: '5.00'
    }];

    var whenApproaching0 = iob.calcTotal(treatments, undefined, time + (3 * 60 * 60 * 1000) - (90 * 1000));

    //before fix we got this: AssertionError: expected '-0.00' to be '0.00'
    whenApproaching0.display.should.equal('0.00');

  });

  it('should calculate IOB using a 4 hour duration', function() {

    var time = Date.now()
      , treatments = [ {
        mills: time - 1,
        insulin: '1.00'
      } ];
       
  var profileData = {
    dia: 4,
    sens: 0};

   var profile = require('../lib/profilefunctions')([profileData]);

    
    var rightAfterBolus = iob.calcTotal(treatments, profile, time);

    rightAfterBolus.display.should.equal('1.00');

    var afterSomeTime = iob.calcTotal(treatments, profile, time + (60 * 60 * 1000));

    afterSomeTime.iob.should.be.lessThan(1);
    afterSomeTime.iob.should.be.greaterThan(0);

    var after3hDIA = iob.calcTotal(treatments, profile, time + (3 * 60 * 60 * 1000));

    after3hDIA.iob.should.greaterThan(0);

    var after4hDIA = iob.calcTotal(treatments, profile, time + (4 * 60 * 60 * 1000));

    after4hDIA.iob.should.equal(0);

  });

  describe('bolus IOB and pump IOB modes', function () {
    var time = Date.now()
      , treatments = [{mills: time - 1, insulin: '1.00'}]
      , profileData = [{dia: 4, sens: 0}]
      , profile = require('../lib/profilefunctions')([profileData])
      , pumpStatuses = [{mills: time - 1, type: 'pump_status', activeInsulin: 4.2}]
      , data = {treatments: treatments, profile: profile, pumpStatuses: pumpStatuses};

    it('should calculate bolus IOB based on treatments by default', function(done) {

      var clientSettings = {iob: {}};
      var sbx = sandbox.clientInit(clientSettings, Date.now(), {}, data);
      sbx.offerProperty = function mockedOfferProperty (name, setter) {
        name.should.equal('iob');
        var result = setter();
        result.display.should.equal(iob.calcTotal(treatments, profile, time).display);
        done();
      };
      iob.setProperties(sbx.withExtendedSettings(iob));

    });

    it('should report pump IOB when source is "pump"', function(done) {

      var clientSettings = {extendedSettings: {iob: {source: 'pump'}}};
      var sbx = sandbox.clientInit(clientSettings, Date.now(), {}, data);
      sbx.offerProperty = function mockedOfferProperty (name, setter) {
        name.should.equal('iob');
        var result = setter();
        result.display.should.equal(iob.getPumpIOB(pumpStatuses, clientSettings.extendedSettings.iob, time).display);
        done();
      };
      iob.setProperties(sbx.withExtendedSettings(iob));

    });

  });

  describe('pump IOB', function () {
    var time, data;

    beforeEach(function () {
      time = Date.now();
      data = {
        pumpStatuses: [
          {mills: time - 5 * 60 * 1000, type: 'pump_status', activeInsulin: 1.2}
        ]
      };
    });

    it('should show the IOB from the most recent pump_status entry', function (done) {
      data.pumpStatuses.push(
        {mills: time - 1, type: 'pump_status', activeInsulin: 3.4}
      );
      var clientSettings = {extendedSettings: {iob: {source: 'pump'}}};
      var sbx = sandbox.clientInit(clientSettings, time, {}, data);
      sbx.offerProperty = function mockedOfferProperty (name, setter) {
        var result = setter();
        result.iob.should.equal(3.4);
        done();
      };
      iob.setProperties(sbx.withExtendedSettings(iob));
    });

    it('should not show stale data', function (done) {
      data.pumpStatuses[0].mills = time - 7 * 60 * 1000 - 1;
      var clientSettings = {extendedSettings: {iob: {source: 'pump', pumpRecency: 7}}};
      var sbx = sandbox.clientInit(clientSettings, time, {}, data);
      sbx.offerProperty = function mockedOfferProperty (name, setter) {
        var result = setter();
        should.not.exist(result);
        done();
      };
      iob.setProperties(sbx.withExtendedSettings(iob));
    });
  });
});
