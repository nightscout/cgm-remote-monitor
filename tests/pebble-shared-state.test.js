'use strict';

// BF-139: /pebble works on its own copies of the readings. Its sandbox can be in
// mmol/L on an mg/dL site (?units=mmol), and sandbox.scaleEntry stores the scaled
// reading on the entry, so scaling the server's shared ctx.ddata.sgvs objects would
// change what the server's own evaluation (bootevent's data-loaded listener: a
// sandbox in the site's units, setProperties, checkNotifications) and
// /api/v2/properties see, and /pebble would reuse whatever another sandbox stored.
// No database: the ctx is built the way bootevent builds the parts involved.

var request = require('supertest');
var should = require('should');
var fs = require('fs');
var moment = require('moment-timezone');

var pebble = require('../lib/server/pebble');

var now = Date.now();

function freshSgvs () {
  // what lib/data/dataloader.js builds on each load: new objects, no scaled value
  return [
    { _id: 'e1', device: 'test', mgdl: 90, direction: 'Flat', type: 'sgv', mills: now - 5 * 60 * 1000 }
    , { _id: 'e2', device: 'test', mgdl: 90, direction: 'Flat', type: 'sgv', mills: now }
  ];
}

function makeSite (siteUnits) {
  var settings = require('../lib/settings')();
  settings.units = siteUnits;
  settings.enable = ['bgnow', 'delta', 'direction', 'ar2', 'iob', 'cob', 'bwp', 'simplealarms'];
  var env = { settings: settings, extendedSettings: {} };
  var language = require('../lib/language')(fs);
  var levels = require('../lib/levels');
  levels.translate = language.translate;
  var notifies = [];
  var ctx = { language: language, levels: levels, moment: moment, settings: settings };
  ctx.notifications = {
    requestNotify: function (notify) { notifies.push(notify); }
    , requestSnooze: function () {}
    , requestClear: function () {}
  };
  ctx.plugins = require('../lib/plugins')({
    settings: settings, language: language, levels: levels, moment: moment
  }).registerServerDefaults();
  ctx.authorization = { isPermitted: function () { return function (req, res, next) { next(); }; } };
  ctx.ddata = require('../lib/data/ddata')();
  ctx.ddata.sgvs = freshSgvs();
  ctx.ddata.profiles = [{ dia: 4, sens: 70, carbratio: 15, carbs_hr: 30, target_low: 90, target_high: 126, basal: 1 }];
  ctx.ddata.devicestatus = [];
  ctx.ddata.treatments = [{ _id: 't1', eventType: 'Correction Bolus', insulin: 1, mills: now - 30 * 60 * 1000 }];
  var app = require('express')();
  app.use('/pebble', pebble(env, ctx));

  return {
    ctx: ctx
    , reload: function () { ctx.ddata.sgvs = freshSgvs(); }
    , get: function (query) {
      return request(app).get('/pebble' + query).expect(200).then(function (res) {
        return res.body.bgs[0];
      });
    }
    // the body of bootevent's data-loaded listener, with the notifications recorded
    , serverEvaluation: function () {
      notifies.length = 0;
      var sbx = require('../lib/sandbox')().serverInit(env, ctx);
      ctx.plugins.setProperties(sbx);
      ctx.plugins.checkNotifications(sbx);
      return { lastScaledSGV: sbx.lastScaledSGV(), notifies: notifies.slice(), sbx: sbx };
    }
  };
}

describe('Pebble shared state (BF-139): /pebble does not scale the server\'s readings', function () {

  it('mg/dL site: /pebble?units=mmol leaves no scaled value on the shared readings', function () {
    var site = makeSite('mg/dl');
    return site.get('?units=mmol').then(function (bg) {
      bg.sgv.should.equal('5.0');
      site.ctx.ddata.sgvs.forEach(function (sgv) {
        should.not.exist(sgv.scaled);
      });
    });
  });

  it('mg/dL site: after /pebble?units=mmol the server evaluation still reads 90 mg/dL and raises no alarm', function () {
    var site = makeSite('mg/dl');
    var control = site.serverEvaluation();
    control.lastScaledSGV.should.equal(90);
    control.notifies.length.should.equal(0);

    site.reload();
    return site.get('?units=mmol').then(function () {
      var after = site.serverEvaluation();
      after.lastScaledSGV.should.equal(90);
      after.notifies.map(function (n) { return n.title; }).should.eql([]);
      should.not.exist(after.sbx.properties.bgnow.sgvs.find(function (sgv) { return sgv.scaled !== 90; }));
      after.sbx.properties.bwp.scaledSGV.should.equal(90);
    });
  });

  it('mg/dL site: /pebble?units=mmol gives the same answer whether or not the server evaluation scaled the readings first', function () {
    var site = makeSite('mg/dl');
    return site.get('?units=mmol').then(function (fresh) {
      site.reload();
      site.serverEvaluation();
      return site.get('?units=mmol').then(function (afterEvaluation) {
        afterEvaluation.should.eql(fresh);
      });
    });
  });

  it('mg/dL site: /pebble after a /pebble?units=mmol answers as it does on freshly loaded readings', function () {
    var site = makeSite('mg/dl');
    return site.get('').then(function (fresh) {
      site.reload();
      return site.get('?units=mmol').then(function () {
        return site.get('').then(function (again) {
          again.should.eql(fresh);
        });
      });
    });
  });
});
