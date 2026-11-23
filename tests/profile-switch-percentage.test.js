'use strict';

// BF-123: an AndroidAPS 3.x Profile Switch carries `percentage` and `timeshift` (milliseconds)
// next to a profileJson that AAPS serialises unscaled. Nightscout must read the schedule the way
// AAPS does: basal x pct/100, ISF and carb ratio x 100/pct, targets unscaled, and every schedule
// read at (time - timeshift) with the timeshift truncated to whole hours
// (AndroidAPS core/objects ProfileSealed.kt, extensions/BlockExtension.kt getShiftedTimeSecs).

const fs = require('fs');
const should = require('should');
const moment = require('moment-timezone');
const createProfile = require('../lib/profilefunctions');

const H = 3600e3;
const M = 60e3;
const DAY = '2026-09-24';
const at = (hhmm) => Date.parse(DAY + 'T' + hhmm + ':00Z');

function sched (pairs) {
  return pairs.map(([time, value]) => ({ time, value }));
}

// Stepped schedules so a timeshift is visible: steps at 00:00, 10:00 and 12:00 (UTC)
function stepped () {
  return {
    units: 'mg/dl', timezone: 'UTC', dia: 5, carbs_hr: 30,
    basal: sched([['00:00', 1.0], ['10:00', 2.0], ['12:00', 3.0]]),
    sens: sched([['00:00', 50], ['10:00', 40], ['12:00', 30]]),
    carbratio: sched([['00:00', 10], ['10:00', 8], ['12:00', 6]]),
    target_low: sched([['00:00', 90], ['10:00', 100], ['12:00', 110]]),
    target_high: sched([['00:00', 110], ['10:00', 120], ['12:00', 130]])
  };
}

function customizedName (pct, tsMs) {
  if (pct === 100 && !tsMs) return 'Default';
  return 'Default (' + pct + '%' + (tsMs ? ',' + Math.trunc(tsMs / H) + 'h' : '') + ')';
}

// The shape AAPS uploads (nsclientV3/extensions/ProfileSwitchExtension.kt toNSProfileSwitch)
function aapsSwitch (pct, tsMs, extra) {
  const mills = at('00:30');
  const doc = {
    eventType: 'Profile Switch', mills, created_at: new Date(mills).toISOString(),
    profile: customizedName(pct, tsMs), originalProfileName: 'Default',
    duration: 24 * 60, durationInMilliseconds: 24 * 60 * M, originalDuration: 24 * 60 * M,
    profileJson: JSON.stringify(stepped()), enteredBy: 'AndroidAPS', isValid: true
  };
  if (pct !== undefined) doc.percentage = pct;
  if (tsMs !== undefined) doc.timeshift = tsMs;
  return Object.assign(doc, extra || {});
}

function load (treatments) {
  const profile = createProfile([{ defaultProfile: 'Default', startDate: '2026-01-01T00:00:00Z', store: { Default: stepped() } }], { moment });
  profile.updateTreatments(treatments, [], []);
  return profile;
}

function read (profile, hhmm, spec) {
  const t = at(hhmm);
  const r2 = (v) => Math.round(Number(v) * 100) / 100;
  return {
    basal: r2(profile.getBasal(t, spec)),
    tempbasal: r2(profile.getTempBasal(t, spec).totalbasal),
    sens: r2(profile.getSensitivity(t, spec)),
    carbratio: r2(profile.getCarbRatio(t, spec)),
    target_low: r2(profile.getLowBGTarget(t, spec)),
    target_high: r2(profile.getHighBGTarget(t, spec)),
    dia: r2(profile.getDIA(t, spec))
  };
}

// Literal expectations. Unshifted stepped schedule by window:
//   A (00:00-10:00): basal 1, ISF 50, IC 10, target 90-110
//   B (10:00-12:00): basal 2, ISF 40, IC 8,  target 100-120
//   C (12:00-24:00): basal 3, ISF 30, IC 6,  target 110-130
const WINDOW = {
  A: { 100: [1, 50, 10], 150: [1.5, 33.33, 6.67], 50: [0.5, 100, 20] },
  B: { 100: [2, 40, 8], 150: [3, 26.67, 5.33], 50: [1, 80, 16] },
  C: { 100: [3, 30, 6], 150: [4.5, 20, 4], 50: [1.5, 60, 12] }
};
const TARGET = { A: [90, 110], B: [100, 120], C: [110, 130] };

function expected (win, pct) {
  const [basal, sens, carbratio] = WINDOW[win][pct];
  return { basal, tempbasal: basal, sens, carbratio, target_low: TARGET[win][0], target_high: TARGET[win][1], dia: 5 };
}

describe('BF-123 AndroidAPS Profile Switch percentage and timeshift', function () {

  // [percentage, timeshift ms, { read time: window AAPS reads }]
  // AAPS reads (time - timeshift): +2 h reads two hours earlier in the schedule, -2 h two hours later.
  const cases = [
    [150, 0, { '09:00': 'A', '11:00': 'B', '13:00': 'C' }],
    [50, 0, { '09:00': 'A', '11:00': 'B', '13:00': 'C' }],
    [100, 0, { '09:00': 'A', '11:00': 'B', '13:00': 'C' }],
    [150, 2 * H, { '09:00': 'A', '11:00': 'A', '13:00': 'B', '14:30': 'C' }],
    [150, -2 * H, { '07:00': 'A', '09:00': 'B', '11:00': 'C', '13:00': 'C' }],
    [100, 2 * H, { '11:00': 'A', '13:00': 'B' }],
    [50, -2 * H, { '09:00': 'B', '11:00': 'C' }],
    // wrap around midnight: 01:00 - 2 h = 23:00 (C); 23:00 + 2 h = 01:00 (A)
    [150, 2 * H, { '01:00': 'C' }],
    [150, -2 * H, { '23:00': 'A' }],
    // AAPS truncates the timeshift to whole hours: 90 minutes acts as 1 hour
    [100, 90 * M, { '11:00': 'B', '10:30': 'A' }],
  ];

  cases.forEach(function ([pct, ts, reads]) {
    Object.keys(reads).forEach(function (hhmm) {
      it(pct + '% timeshift ' + (ts / H) + ' h at ' + hhmm + ' reads window ' + reads[hhmm], function () {
        const profile = load([aapsSwitch(pct, ts)]);
        read(profile, hhmm).should.eql(expected(reads[hhmm], pct));
      });
    });
  });

  it('keeps the AAPS customised name as the active profile', function () {
    let profile = load([aapsSwitch(150, 0)]);
    profile.profileSwitchName(profile.activeProfileToTime(at('11:00'))).should.equal('Default (150%)');
    profile = load([aapsSwitch(150, 2 * H)]);
    profile.profileSwitchName(profile.activeProfileToTime(at('11:00'))).should.equal('Default (150%,2h)');
  });

  it('reads the stored profile once the switch has ended', function () {
    const profile = load([aapsSwitch(150, 2 * H, { duration: 60, durationInMilliseconds: 60 * M, originalDuration: 60 * M })]);
    profile.activeProfileToTime(at('11:00')).should.equal('Default');
    read(profile, '11:00').should.eql(expected('B', 100));
  });

  it('does not scale a Profile Switch without percentage or timeshift', function () {
    const profile = load([aapsSwitch(undefined, undefined, { profile: 'Other' })]);
    read(profile, '11:00').should.eql(expected('B', 100));
  });

  it('does not scale when percentage is not a number', function () {
    const profile = load([aapsSwitch(150, 0, { percentage: '150' })]);
    read(profile, '11:00').should.eql(expected('B', 100));
  });

  it('does not scale a named switch that embeds no profileJson', function () {
    const sw = aapsSwitch(150, 2 * H, { profile: 'Default' });
    delete sw.profileJson;
    const profile = load([sw]);
    profile.activeProfileToTime(at('11:00')).should.equal('Default');
    read(profile, '11:00').should.eql(expected('B', 100));
  });

  it('does not scale when a specific profile is requested', function () {
    const profile = load([aapsSwitch(150, 2 * H)]);
    read(profile, '11:00', 'Default').should.eql(expected('B', 100));
  });

  it('applies an absolute temp basal as is during a percentage switch', function () {
    const profile = createProfile([{ defaultProfile: 'Default', startDate: '2026-01-01T00:00:00Z', store: { Default: stepped() } }], { moment });
    profile.updateTreatments([aapsSwitch(150, 0)], [{ eventType: 'Temp Basal', mills: at('10:50'), duration: 30, absolute: 0.4 }], []);
    const tb = profile.getTempBasal(at('11:00'));
    tb.basal.should.equal(3);
    tb.totalbasal.should.equal(0.4);
  });

  // CircadianPercentageProfile (AAPS 2.x, timeshift in hours) keeps its existing behaviour:
  // percentage applied, and its timeshift does not move the schedule lookup.
  it('CircadianPercentageProfile control: percentage applied, lookup unshifted (unchanged)', function () {
    [0, 2, -2].forEach(function (tsHours) {
      const profile = load([aapsSwitch(150, tsHours, { CircadianPercentageProfile: true })]);
      read(profile, '11:00').should.eql(expected('B', 150));
    });
  });
});

describe('BF-123 plugins during an AndroidAPS percentage switch', function () {
  const env = require('../lib/server/env')();
  env.testMode = true;
  const ctx = { language: require('../lib/language')(fs), settings: env.settings, levels: require('../lib/levels'), moment };
  ctx.ddata = require('../lib/data/ddata')();
  ctx.notifications = require('../lib/notifications')(env, ctx);
  const plugins = {
    bgnow: require('../lib/plugins/bgnow')(ctx), ar2: require('../lib/plugins/ar2')(ctx),
    iob: require('../lib/plugins/iob')(ctx), cob: require('../lib/plugins/cob')(ctx),
    basal: require('../lib/plugins/basalprofile')(ctx), bwp: require('../lib/plugins/boluswizardpreview')(ctx)
  };
  const flat = (v) => [{ time: '00:00', value: v }];
  const store = () => ({ units: 'mg/dl', timezone: 'UTC', dia: 5, carbs_hr: 30, basal: flat(1.0), sens: flat(50), carbratio: flat(10), target_low: flat(100), target_high: flat(120) });

  function run (pct) {
    const now = Math.floor(Date.now() / M) * M;
    ctx.ddata.sgvs = [{ mills: now - 5 * M, mgdl: 200 }, { mills: now, mgdl: 200 }];
    ctx.ddata.treatments = [{ mills: now - 30 * M, insulin: 1.0 }];
    ctx.ddata.profiles = [{ defaultProfile: 'Default', startDate: '2026-01-01T00:00:00Z', store: { Default: store() } }];
    ctx.ddata.profileTreatments = pct === null ? [] : [{
      eventType: 'Profile Switch', mills: now - 60 * M, profile: 'Default (' + pct + '%)', originalProfileName: 'Default',
      percentage: pct, timeshift: 0, duration: 180, profileJson: JSON.stringify(store()), enteredBy: 'AndroidAPS'
    }];
    ctx.ddata.tempbasalTreatments = [];
    ctx.ddata.combobolusTreatments = [];
    const sbx = require('../lib/sandbox')().serverInit(env, ctx);
    sbx.time = now;
    sbx.offerProperty('direction', () => ({ value: 'Flat', label: '→', entity: '' }));
    ['bgnow', 'ar2', 'iob', 'cob', 'basal', 'bwp'].forEach((k) => plugins[k].setProperties(sbx));
    return sbx.properties;
  }

  it('basal pill, IOB activity and Bolus Wizard Preview use the scaled values at 150%', function () {
    const p = run(150);
    p.basal.display.should.equal('1.500U');
    p.iob.iob.should.be.approximately(0.969, 0.001);
    p.iob.activity.should.be.approximately(0.05333, 0.0001);
    p.bwp.effect.should.be.approximately(32.3, 0.05);
    p.bwp.bolusEstimateDisplay.should.equal('1.43');
  });

  it('basal pill and Bolus Wizard Preview match the stored profile without a switch', function () {
    const p = run(null);
    p.basal.display.should.equal('1.000U');
    p.iob.activity.should.be.approximately(0.08, 0.0001);
    p.bwp.effect.should.be.approximately(48.45, 0.05);
    p.bwp.bolusEstimateDisplay.should.equal('0.63');
  });
});
