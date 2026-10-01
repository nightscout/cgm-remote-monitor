'use strict';

/*
 * tests/client-core/careportal-resolve-event-name.test.js
 *
 * Track 2 / Phase 5a — Node-only tests for the pure
 * resolveEventName helper.
 */

require('should');
var resolveEventName = require('../../lib/client-core/careportal/resolve-event-name');

describe('client-core/careportal/resolve-event-name', function () {

  var events = [
    { val: 'Snack Bolus', name: 'Snack Bolus' }
    , { val: 'Meal Bolus', name: 'Meal' }
    , { val: 'Temporary Target', name: 'Temporary Target' }
  ];

  it('returns the matching event name for a known val', function () {
    resolveEventName('Meal Bolus', events).should.equal('Meal');
  });

  it('returns the input value when no match is found', function () {
    resolveEventName('Unknown', events).should.equal('Unknown');
  });

  it('returns the input value when events is undefined', function () {
    resolveEventName('Snack Bolus').should.equal('Snack Bolus');
  });

  it('returns the input value when events is empty', function () {
    resolveEventName('Snack Bolus', []).should.equal('Snack Bolus');
  });

  it('returns the input value when events contains a falsy entry', function () {
    resolveEventName('Snack Bolus', [null, { val: 'Snack Bolus', name: 'Snack' }]).should.equal('Snack');
  });
});
