'use strict';

/*
 * tests/client-core/careportal-event-types.test.js
 *
 * Track 2 / Phase 5a — Node-only tests for the event-types
 * shape transforms.
 */

require('should');
var et = require('../../lib/client-core/careportal/event-types');

describe('client-core/careportal/event-types', function () {

  var sample = [
    {
      val: 'Snack Bolus', name: 'Snack Bolus'
      , bg: true, carbs: true, insulin: true, prebolus: true
      , reasons: [], submitHook: function noopHook() {}
    }
    , {
      val: 'Temporary Target', name: 'Temporary Target'
      , duration: true, targets: true, profile: false
      , reasons: [{ name: 'Eating Soon' }]
    }
    , {
      val: 'Profile Switch', name: 'Profile Switch'
      , profile: true, duration: true
    }
  ];

  it('buildEvents returns only val + name', function () {
    var events = et.buildEvents(sample);
    events.should.have.length(3);
    events[0].should.eql({ val: 'Snack Bolus', name: 'Snack Bolus' });
    Object.keys(events[0]).should.eql(['val', 'name']);
  });

  it('buildEvents handles non-array input', function () {
    et.buildEvents().should.eql([]);
    et.buildEvents(null).should.eql([]);
  });

  it('buildInputMatrix keys by val and picks INPUT_KEYS only', function () {
    var matrix = et.buildInputMatrix(sample);
    matrix.should.have.keys('Snack Bolus', 'Temporary Target', 'Profile Switch');
    matrix['Snack Bolus'].carbs.should.equal(true);
    matrix['Snack Bolus'].should.not.have.property('submitHook');
    matrix['Snack Bolus'].should.not.have.property('val');
  });

  it('buildInputMatrix preserves explicit profile=false (used by gather to drop profile)', function () {
    var matrix = et.buildInputMatrix(sample);
    matrix['Temporary Target'].profile.should.equal(false);
    matrix['Profile Switch'].profile.should.equal(true);
  });

  it('buildInputMatrix omits entries with no val', function () {
    var matrix = et.buildInputMatrix([{ name: 'Bad' }, { val: 'Good', carbs: true }]);
    matrix.should.have.keys('Good');
    matrix.should.not.have.property(undefined);
  });

  it('buildSubmitHooks maps val → submitHook (or undefined)', function () {
    var hooks = et.buildSubmitHooks(sample);
    hooks['Snack Bolus'].should.be.a.Function();
    (hooks['Temporary Target'] === undefined).should.be.true();
  });
});
