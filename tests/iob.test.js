var should = require('should');

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

    rightAfterBolus.display.should.equal(1);

    var afterSomeTime = iob.calcTotal(treatments, profile, new Date(time.getTime() + (60 * 60 * 1000)));

    afterSomeTime.display.should.be.lessThan(1);
    afterSomeTime.display.should.be.greaterThan(0);

    var afterDIA = iob.calcTotal(treatments, profile, new Date(time.getTime() + (3 * 60 * 60 * 1000)));

    afterDIA.display.should.equal(0);

  });
});