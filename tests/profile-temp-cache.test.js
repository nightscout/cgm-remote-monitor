'use strict';

// BF-94: tempBasalTreatment() remembers the last temp basal it found, and returns it while
// the time asked for falls inside it. That memory must not outlive the treatment list it
// came from, and must not be shared between profile instances.
//
// The browser keeps one profile instance and calls updateTreatments() on every data update.
// When a client edits a temp (AndroidAPS PATCHes the shortened duration; Trio re-uploads the
// finalized one), the update replaces the treatment object, so the remembered object keeps
// its original end time.

require('should');
const helper = require('./inithelper')();

const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-02T12:00:00.000Z');

const profileData = {
  timezone: 'UTC'
  , startDate: '2026-01-01'
  , basal: [{ time: '00:00', value: 1.0 }]
};

function temp (startsMinutesAgo, absolute, duration) {
  // a fresh object, as the browser's data update delivers one
  return { eventType: 'Temp Basal', mills: NOW - startsMinutesAgo * MIN, absolute: absolute, duration: duration };
}

function newProfile () {
  return require('../lib/profilefunctions')([profileData], helper.ctx);
}

describe('profile temp basal lookup after the treatments change (BF-94)', function () {

  it('finds the new temp after a temp is shortened and a new one starts', function () {
    const profile = newProfile();
    profile.updateTreatments([], [temp(10, 2.0, 30)], []);
    profile.getTempBasal(NOW).totalbasal.should.equal(2.0);

    // A shortened to 9 minutes (a new object), B starts one minute ago
    profile.updateTreatments([], [temp(10, 2.0, 9), temp(1, 0, 30)], []);
    const now = profile.getTempBasal(NOW + 1);
    now.totalbasal.should.equal(0);
    now.treatment.mills.should.equal(NOW - 1 * MIN);
  });

  it('returns the scheduled basal after a temp is cancelled', function () {
    const profile = newProfile();
    profile.updateTreatments([], [temp(10, 2.0, 30)], []);
    profile.getTempBasal(NOW).totalbasal.should.equal(2.0);

    profile.updateTreatments([], [temp(10, 2.0, 9)], []);
    const now = profile.getTempBasal(NOW + 1);
    (now.treatment === undefined || now.treatment === null).should.be.true();
    now.totalbasal.should.equal(1.0);
  });

  it('does not answer one instance from another instance\'s treatments', function () {
    const first = newProfile();
    first.updateTreatments([], [temp(10, 2.0, 30)], []);
    first.getTempBasal(NOW).totalbasal.should.equal(2.0);

    const second = newProfile();
    second.updateTreatments([], [temp(5, 1.5, 30)], []);
    second.getTempBasal(NOW).totalbasal.should.equal(1.5);

    first.getTempBasal(NOW + 1).totalbasal.should.equal(2.0);
  });

  it('still answers repeated lookups within one list', function () {
    const profile = newProfile();
    profile.updateTreatments([], [temp(60, 0.5, 30), temp(30, 1.5, 30)], []);
    for (let m = 59; m > 30; m -= 1) {
      profile.getTempBasal(NOW - m * MIN).totalbasal.should.equal(0.5);
    }
    for (let m = 29; m > 0; m -= 1) {
      profile.getTempBasal(NOW - m * MIN).totalbasal.should.equal(1.5);
    }
  });
});
