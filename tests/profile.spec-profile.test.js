'use strict';

/*
 * A profile named by the caller (spec_profile) is the one whose values are
 * returned. The bolus calculator's profile picker passes the chosen name;
 * from 14.0.0 (#5729) the name was ignored and the active profile was used.
 * A name that is not in the store, or a value that is not a name, still
 * gives the active profile.
 */

require('should');
const helper = require('./inithelper')();

describe('Profile spec_profile', function ( ) {

  function schedule (value) {
    return [{ time: '00:00', timeAsSeconds: 0, value: value }];
  }

  var profile = require('../lib/profilefunctions')([{
    defaultProfile: 'Default'
    , startDate: '2015-06-21T00:00:00.000Z'
    , mills: 1434844800000
    , store: {
      Default: {
        dia: 3, units: 'mg/dl', timezone: 'UTC'
        , sens: schedule(54), carbratio: schedule(10), basal: schedule(1)
        , target_low: schedule(90), target_high: schedule(126)
      }
      , Other: {
        dia: 4, units: 'mmol', timezone: 'UTC'
        , sens: schedule(1.5), carbratio: schedule(8), basal: schedule(0.8)
        , target_low: schedule(5), target_high: schedule(7)
      }
    }
  }], helper.ctx);

  var noon = new Date('2015-06-22T12:00:00Z').getTime();

  it('gives the active profile when no profile is named', function () {
    profile.getSensitivity(noon).should.equal(54);
    profile.getUnits().should.equal('mg/dl');
  });

  it('gives the named profile', function () {
    profile.getSensitivity(noon, 'Other').should.equal(1.5);
    profile.getCarbRatio(noon, 'Other').should.equal(8);
    profile.getLowBGTarget(noon, 'Other').should.equal(5);
    profile.getHighBGTarget(noon, 'Other').should.equal(7);
    profile.getDIA(noon, 'Other').should.equal(4);
    profile.getUnits('Other').should.equal('mmol');
  });

  it('gives the named active profile as before', function () {
    profile.getSensitivity(noon, 'Default').should.equal(54);
  });

  it('gives the active profile for a name not in the store', function () {
    profile.getSensitivity(noon, 'Missing').should.equal(54);
  });

  it('gives the active profile for a value that is not a name', function () {
    profile.getUnits(noon).should.equal('mg/dl');
  });
});
