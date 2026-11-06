'use strict';

// BF-128: /pebble returns the delta (bgdelta) in the same units as the reading (sgv),
// for every combination of the site's display units and the ?units the client asks for.
// No database: each request gets a fresh ctx built the way bootevent builds the parts
// /pebble uses (language, levels, the server plugin registry, ddata).

var request = require('supertest');
var should = require('should');
var fs = require('fs');
var moment = require('moment-timezone');

var pebble = require('../lib/server/pebble');

function makeEnv (siteUnits, enable) {
  var settings = require('../lib/settings')();
  settings.units = siteUnits;
  settings.enable = enable || [];
  return { settings: settings, extendedSettings: {} };
}

function makeApp (env, prev, cur, profile, extraTreatments) {
  var now = Date.now();
  var language = require('../lib/language')(fs);
  var levels = require('../lib/levels');
  levels.translate = language.translate;
  var ctx = { language: language, levels: levels, moment: moment, settings: env.settings };
  ctx.plugins = require('../lib/plugins')({
    settings: env.settings, language: language, levels: levels, moment: moment
  }).registerServerDefaults();
  ctx.authorization = { isPermitted: function () { return function (req, res, next) { next(); }; } };
  ctx.ddata = require('../lib/data/ddata')();
  ctx.ddata.sgvs = [{ device: 'test', mgdl: cur, direction: 'Flat', type: 'sgv', mills: now }];
  if (prev !== null) {
    ctx.ddata.sgvs.unshift({ device: 'test', mgdl: prev, direction: 'Flat', type: 'sgv', mills: now - 5 * 60 * 1000 });
  }
  ctx.ddata.profiles = [profile || { dia: 4, sens: 70, carbratio: 15, carbs_hr: 30 }];
  ctx.ddata.devicestatus = [];
  ctx.ddata.treatments = [
    { eventType: 'Correction Bolus', insulin: 1, mills: now - 30 * 60 * 1000 }
  ].concat(extraTreatments || []);
  var app = require('express')();
  app.use('/pebble', pebble(env, ctx));
  return app;
}

function getFirst (app, query) {
  return request(app).get('/pebble' + query).expect(200).then(function (res) {
    res.body.bgs.length.should.equal(1);
    return res.body.bgs[0];
  });
}

var trends = [
  { name: 'rising', prev: 88, cur: 90, mgdl: 2, mmol: '0.1' }
  , { name: 'falling', prev: 92, cur: 90, mgdl: -2, mmol: '-0.1' }
  , { name: 'flat', prev: 90, cur: 90, mgdl: 0, mmol: '0.0' }
];

// site display units (as lib/server/env.js normalises them) x the ?units query
var combos = [
  { site: 'mg/dl', query: '', want: 'mgdl' }
  , { site: 'mg/dl', query: '?units=mgdl', want: 'mgdl' }
  , { site: 'mg/dl', query: '?units=mmol', want: 'mmol' }
  , { site: 'mmol', query: '', want: 'mmol' }
  , { site: 'mmol', query: '?units=mmol', want: 'mmol' }
  , { site: 'mmol', query: '?units=mgdl', want: 'mgdl' }
];

describe('Pebble units (BF-128): the delta follows the reading\'s units', function () {

  combos.forEach(function (combo) {
    trends.forEach(function (trend) {
      it(combo.site + ' site, /pebble' + (combo.query || ' (no units)') + ', ' + trend.name
        + ': sgv and bgdelta both in ' + combo.want, function () {
        var app = makeApp(makeEnv(combo.site), trend.prev, trend.cur);
        return getFirst(app, combo.query).then(function (bg) {
          if (combo.want === 'mgdl') {
            bg.sgv.should.equal('90');
            bg.bgdelta.should.equal(trend.mgdl);
          } else {
            bg.sgv.should.equal('5.0');
            bg.bgdelta.should.equal(trend.mmol);
          }
        });
      });
    });
  });

  it('mmol site, /pebble?units=mgdl, a 2 mg/dL fall is not reported as a 0.1 fall', function () {
    var app = makeApp(makeEnv('mmol'), 92, 90);
    return getFirst(app, '?units=mgdl').then(function (bg) {
      bg.sgv.should.equal('90');
      bg.bgdelta.should.not.equal(-0.1);
      bg.bgdelta.should.equal(-2);
    });
  });

  it('with only one reading (no delta) the legacy 0 is kept, in the requested units', function () {
    return Promise.all([
      getFirst(makeApp(makeEnv('mmol'), null, 90), '?units=mgdl')
      , getFirst(makeApp(makeEnv('mmol'), null, 90), '')
      , getFirst(makeApp(makeEnv('mg/dl'), null, 90), '?units=mmol')
      , getFirst(makeApp(makeEnv('mg/dl'), null, 90), '')
    ]).then(function (bgs) {
      bgs[0].bgdelta.should.equal(0);
      bgs[1].bgdelta.should.equal('0.0');
      bgs[2].bgdelta.should.equal('0.0');
      bgs[3].bgdelta.should.equal(0);
    });
  });

  // The bolus wizard preview (bwp/bwpo) compares the reading with the profile's
  // sensitivity and targets, which are in the profile's units. The delta fix must not
  // move the sandbox those are computed in: on an mmol site asking for mg/dL, bwp, iob
  // and cob stay what the site computes for itself, and bwpo (a glucose value) is the
  // site's outcome expressed in the requested units (BF-138).
  it('mmol site with iob enabled: ?units=mgdl leaves bwp, iob and cob as the site computes them', function () {
    var profile = { units: 'mmol', dia: 4, sens: 3.9, carbratio: 15, carbs_hr: 30, target_low: 5, target_high: 7, basal: 1 };
    var enable = ['iob', 'cob'];
    return Promise.all([
      getFirst(makeApp(makeEnv('mmol', enable), 92, 90, profile), '')
      , getFirst(makeApp(makeEnv('mmol', enable), 92, 90, profile), '?units=mgdl')
      , getFirst(makeApp(makeEnv('mmol', enable), 92, 90, profile), '?units=mmol')
    ]).then(function (bgs) {
      var site = bgs[0], mgdl = bgs[1], mmol = bgs[2];
      should.exist(site.bwp);
      should.exist(site.iob);
      mgdl.bgdelta.should.equal(-2);
      site.bgdelta.should.equal('-0.1');
      ['iob', 'bwp', 'cob'].forEach(function (field) {
        should.deepEqual(mgdl[field], site[field], field + ' changed with ?units=mgdl');
        should.deepEqual(mmol[field], site[field], field + ' changed with ?units=mmol');
      });
      should.deepEqual(mmol.bwpo, site.bwpo, 'bwpo changed with ?units=mmol');
    });
  });
});

// BF-138: the bolus estimate (bwp, in insulin units) is computed in the site's units,
// against the profile, whatever ?units asks for; bwpo, the expected outcome (a glucose
// value), is that result in the requested units. Nothing else moves.
describe('Pebble units (BF-138): bwp is the site\'s own, bwpo follows the reading\'s units', function () {

  var profiles = {
    'mg/dl': { dia: 4, sens: 70, carbratio: 15, carbs_hr: 30, target_low: 90, target_high: 126, basal: 1 }
    , mmol: { units: 'mmol', dia: 4, sens: 3.9, carbratio: 15, carbs_hr: 30, target_low: 5, target_high: 7, basal: 1 }
  };
  // 90 mg/dL (5.0 mmol/L), 1 U 30 min ago: 0.95 U on board, outcome 23 mg/dL (1.3 mmol/L)
  // below the low target, so the estimate is -0.96 U on both sites
  var outcome = { mgdl: 23, mmol: 1.3 };

  function app (site, trend) {
    return makeApp(makeEnv(site, ['iob', 'cob']), trend.prev, trend.cur, profiles[site]);
  }

  combos.forEach(function (combo) {
    trends.forEach(function (trend) {
      it(combo.site + ' site, /pebble' + (combo.query || ' (no units)') + ', ' + trend.name
        + ': bwp, iob, cob as the site computes them, bwpo in ' + combo.want, function () {
        return Promise.all([
          getFirst(app(combo.site, trend), '')
          , getFirst(app(combo.site, trend), combo.query)
        ]).then(function (bgs) {
          var site = bgs[0], bg = bgs[1];
          site.bwp.should.equal('-0.96');
          site.iob.should.equal('0.95');
          bg.bwp.should.equal('-0.96');
          bg.bwpo.should.equal(outcome[combo.want]);
          // and the reading and delta still follow the requested units (BF-128)
          if (combo.want === 'mgdl') {
            bg.sgv.should.equal('90');
            bg.bgdelta.should.equal(trend.mgdl);
          } else {
            bg.sgv.should.equal('5.0');
            bg.bgdelta.should.equal(trend.mmol);
          }
          // only sgv, bgdelta and bwpo may differ from the site's own answer
          ['trend', 'direction', 'iob', 'bwp', 'cob'].forEach(function (field) {
            should.deepEqual(bg[field], site[field], field + ' changed with ' + combo.query);
          });
          Object.keys(bg).sort().should.eql(Object.keys(site).sort());
        });
      });
    });
  });

  it('mg/dL site, /pebble?units=mmol: the estimate is not -2.17 U with an outcome of -61.8', function () {
    return getFirst(app('mg/dl', trends[2]), '?units=mmol').then(function (bg) {
      bg.sgv.should.equal('5.0');
      bg.bwp.should.not.equal('-2.17');
      bg.bwpo.should.not.equal(-61.8);
    });
  });

  it('when the profile lacks the targets the estimate keeps its "0" placeholders in any units', function () {
    var noTargets = { dia: 4, sens: 70, carbratio: 15, carbs_hr: 30 };
    return Promise.all(['', '?units=mmol'].map(function (query) {
      return getFirst(makeApp(makeEnv('mg/dl', ['iob']), 90, 90, noTargets), query);
    })).then(function (bgs) {
      bgs[0].bwp.should.equal('0');
      bgs[0].bwpo.should.equal('0');
      bgs[1].bwp.should.equal('0');
      bgs[1].bwpo.should.equal('0');
    });
  });

  it('carbs on board are the same whatever ?units asks for', function () {
    function withCarbs (site) {
      var carbs = { eventType: 'Carb Correction', carbs: 20, mills: Date.now() - 20 * 60 * 1000 };
      return makeApp(makeEnv(site, ['iob', 'cob']), 90, 90, profiles[site], [carbs]);
    }
    return Promise.all(['', '?units=mmol', '?units=mgdl'].map(function (query) {
      return getFirst(withCarbs('mg/dl'), query);
    })).then(function (bgs) {
      bgs[0].cob.should.be.above(0);
      bgs[1].cob.should.eql(bgs[0].cob);
      bgs[2].cob.should.eql(bgs[0].cob);
    });
  });
});
