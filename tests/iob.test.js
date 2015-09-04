'use strict';

require('should');

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


});