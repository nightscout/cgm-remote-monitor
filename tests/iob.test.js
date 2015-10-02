var should = require('should');

var FIVE_MINS = 10 * 60 * 1000;

describe('IOB', function ( ) {
  var iob = require('../lib/iob')();

  it('should calculate IOB', function() {

    var time = new Date()
      , treatments = [ {
          created_at: time - 1,
          insulin: "1.00"
        }
      ]
      , profile = {
        dia: 3,
        sens: 0
      };

    var rightAfterBolus = iob.calcTotal(treatments, profile, time);

    rightAfterBolus.display.should.equal('1.00');

    var afterSomeTime = iob.calcTotal(treatments, profile, new Date(time.getTime() + (60 * 60 * 1000)));

    afterSomeTime.iob.should.be.lessThan(1);
    afterSomeTime.iob.should.be.greaterThan(0);

    var afterDIA = iob.calcTotal(treatments, profile, new Date(time.getTime() + (3 * 60 * 60 * 1000)));

    afterDIA.iob.should.equal(0);

  });

  it('should calculate IOB using defaults', function() {

    var treatments = [{
      created_at: (new Date()) - 1,
      insulin: "1.00"
    }];

    var rightAfterBolus = iob.calcTotal(treatments);

    rightAfterBolus.display.should.equal('1.00');

  });

  it('should not show a negative IOB when approaching 0', function() {

    var time = new Date() - 1;

    var treatments = [{
      created_at: time,
      insulin: "5.00"
    }];

    var whenApproaching0 = iob.calcTotal(treatments, undefined, new Date(time + (3 * 60 * 60 * 1000) - (90 * 1000)));

    //before fix we got this: AssertionError: expected '-0.00' to be '0.00'
    whenApproaching0.display.should.equal('0.00');

  });

  it('should calculate IOB using a 4 hour duration', function() {

    var time = new Date()
      , treatments = [ {
        created_at: time - 1,
        insulin: "1.00"
      }
      ]
      , profile = {
        dia: 4,
        sens: 0
      };

    var rightAfterBolus = iob.calcTotal(treatments, profile, time);

    rightAfterBolus.display.should.equal('1.00');

    var afterSomeTime = iob.calcTotal(treatments, profile, new Date(time.getTime() + (60 * 60 * 1000)));

    afterSomeTime.iob.should.be.lessThan(1);
    afterSomeTime.iob.should.be.greaterThan(0);

    var after3hDIA = iob.calcTotal(treatments, profile, new Date(time.getTime() + (3 * 60 * 60 * 1000)));

    after3hDIA.iob.should.greaterThan(0);

    var after4hDIA = iob.calcTotal(treatments, profile, new Date(time.getTime() + (3 * 60 * 60 * 1000)));

    after4hDIA.iob.should.greaterThan(0);

  });


});