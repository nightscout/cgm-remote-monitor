'use strict';

require('should');

const helper = require('./inithelper')();

describe('utils', function ( ) {

  const ctx = helper.getctx();
  
  ctx.settings = {
    alarmTimeagoUrgentMins: 30
    , alarmTimeagoWarnMins: 15
  };

  var utils = require('../lib/utils')(ctx);

  it('format numbers', function () {
    utils.toFixed(5.499999999).should.equal('5.50');
  });

  it('format numbers short', function () {
    var undef;
    utils.toRoundedStr(3.345, 2).should.equal('3.35');
    utils.toRoundedStr(5.499999999, 0).should.equal('5');
    utils.toRoundedStr(5.499999999, 1).should.equal('5.5');
    utils.toRoundedStr(5.499999999, 3).should.equal('5.5');
    utils.toRoundedStr(123.45, -2).should.equal('100');
    utils.toRoundedStr(-0.001, 2).should.equal('0');
    utils.toRoundedStr(-2.47, 1).should.equal('-2.5');
    utils.toRoundedStr(-2.44, 1).should.equal('-2.4');

    utils.toRoundedStr(undef, 2).should.equal('0');
    utils.toRoundedStr(null, 2).should.equal('0');
    utils.toRoundedStr('text', 2).should.equal('0');
  });

  it('merge date and time', function () {
    var result = utils.mergeInputTime('22:35', '2015-07-14');
    result.hours().should.equal(22);
    result.minutes().should.equal(35);
    result.year().should.equal(2015);
    result.format('MMM').should.equal('Jul');
    result.date().should.equal(14);
  });

});
