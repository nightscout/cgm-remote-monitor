'use strict';

var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();

//Mocked ctx
var ctx = {};
// var env = {}; Unused variable
var now = Date.now();

function updateMills (entries) {
  //last is now, assume 5m between points
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[entries.length - i - 1];
    entry.mills = now - (i * 5 * 60 * 1000);
  }
  return entries;
}

ctx.ddata = require('../lib/data/ddata')();
ctx.ddata.sgvs = updateMills([
  { device: 'dexcom',
    mgdl: 91,
    direction: 'Flat',
    type: 'sgv',
    filtered: 124048,
    unfiltered: 118880,
    rssi: 174,
    noise: 1
  }
  , { device: 'dexcom',
    mgdl: 88,
    direction: 'Flat',
    type: 'sgv',
    filtered: 120464,
    unfiltered: 116608,
    rssi: 175,
    noise: 1
  }
  , { device: 'dexcom',
    mgdl: 86,
    direction: 'Flat',
    type: 'sgv',
    filtered: 117808,
    unfiltered: 114640,
    rssi: 169,
    noise: 1
  }
  , { device: 'dexcom',
    mgdl: 92,
    direction: 'Flat',
    type: 'sgv',
    filtered: 115680,
    unfiltered: 113552,
    rssi: 179,
    noise: 1
  }
  , { device: 'dexcom',
    mgdl: 90,
    direction: 'Flat',
    type: 'sgv',
    filtered: 113984,
    unfiltered: 111920,
    rssi: 179,
    noise: 1
  }
]);

ctx.ddata.cals = updateMills([
  { device: 'dexcom',
    slope: 895.8571693029189,
    intercept: 34281.06876195567,
    scale: 1,
    type: 'cal'
  }
]);

ctx.ddata.profiles = [{dia: 4, sens: 70, carbratio: 15, carbs_hr: 30}];

ctx.ddata.treatments = updateMills([
  { eventType: 'Snack Bolus', insulin: '1.50', carbs: '22' }
]);

ctx.ddata.devicestatus = [{uploader: {battery: 100}}];

var bootevent = require('../lib/server/bootevent');
describe('Pebble Endpoint', function ( ) {

  this.timeout(10000);

  var pebble = require('../lib/server/pebble');
  before(function (done) {
    var env = require('../env')( );
    env.settings.authDefaultRoles = 'readable';
    this.app = require('express')( );
    this.app.enable('api');
    var self = this;
    bootevent(env, language).boot(function booted (context) {
      context.ddata = ctx.ddata.clone( );
      self.app.use('/pebble', pebble(env, context));
      done();
    });
  });

  it('/pebble default(1) count', function (done) {
    request(this.app)
      .get('/pebble')
      .expect(200)
      .end(function (err, res)  {
        var bgs = res.body.bgs;
        bgs.length.should.equal(1);
        var bg = bgs[0];
        bg.sgv.should.equal('90');
        bg.bgdelta.should.equal(-2);
        bg.trend.should.equal(4);
        bg.direction.should.equal('Flat');
        bg.datetime.should.equal(now);
        should.not.exist(bg.filtered);
        should.not.exist(bg.unfiltered);
        should.not.exist(bg.noise);
        should.not.exist(bg.rssi);
        should.not.exist(bg.iob);
        should.not.exist(bg.cob);
        bg.battery.should.equal('100');

        res.body.cals.length.should.equal(0);
        done( );
      });
  });

  it('/pebble with mmol param', function (done) {
    request(this.app)
      .get('/pebble?units=mmol')
      .expect(200)
      .end(function (err, res)  {
        var bgs = res.body.bgs;
        bgs.length.should.equal(1);
        var bg = bgs[0];
        bg.sgv.should.equal('5.0');
        bg.bgdelta.should.equal('-0.1');
        bg.trend.should.equal(4);
        bg.direction.should.equal('Flat');
        bg.datetime.should.equal(now);
        should.not.exist(bg.filtered);
        should.not.exist(bg.unfiltered);
        should.not.exist(bg.noise);
        should.not.exist(bg.rssi);
        bg.battery.should.equal('100');

        res.body.cals.length.should.equal(0);
        done( );
      });
  });

  it('/pebble?count=2', function (done) {
    request(this.app)
      .get('/pebble?count=2')
      .expect(200)
      .end(function (err, res)  {
        var bgs = res.body.bgs;
        bgs.length.should.equal(2);
        var bg = bgs[0];
        bg.sgv.should.equal('90');
        bg.bgdelta.should.equal(-2);
        bg.trend.should.equal(4);
        bg.direction.should.equal('Flat');
        bg.datetime.should.equal(now);
        should.not.exist(bg.filtered);
        should.not.exist(bg.unfiltered);
        should.not.exist(bg.noise);
        should.not.exist(bg.rssi);
        bg.battery.should.equal('100');

        res.body.cals.length.should.equal(0);
        done( );
      });
  });

  it('/pebble without battery', function (done) {
    ctx.ddata.devicestatus = [];
    request(this.app)
      .get('/pebble')
      .expect(200)
      .end(function (err, res)  {
        var bgs = res.body.bgs;
        bgs.length.should.equal(1);
        should.not.exist(bgs[0].battery);

        res.body.cals.length.should.equal(0);
        done( );
      });
  });

  it('/pebble with a negative battery', function (done) {
    ctx.ddata.devicestatus = [{uploader: {battery: -1}}];
    request(this.app)
      .get('/pebble')
      .expect(200)
      .end(function (err, res)  {
        var bgs = res.body.bgs;
        bgs.length.should.equal(1);
        should.not.exist(bgs[0].battery);

        res.body.cals.length.should.equal(0);
        done( );
      });
  });

  it('/pebble with a false battery', function (done) {
    ctx.ddata.devicestatus = [{uploader: {battery: false}}];
    request(this.app)
      .get('/pebble')
      .expect(200)
      .end(function (err, res)  {
        var bgs = res.body.bgs;
        bgs.length.should.equal(1);
        should.not.exist(bgs[0].battery);

        res.body.cals.length.should.equal(0);
        done( );
      });
  });
});

describe('Pebble Endpoint with Raw and IOB and COB', function ( ) {
  var pebbleRaw = require('../lib/server/pebble');
  before(function (done) {
    var env = require('../env')( );
    env.settings.enable = ['rawbg', 'iob', 'cob'];
    env.settings.authDefaultRoles = 'readable';
    this.appRaw = require('express')( );
    this.appRaw.enable('api');
    var self = this;
    bootevent(env, language).boot(function booted (context) {
      context.ddata = ctx.ddata.clone( );
      self.appRaw.use('/pebble', pebbleRaw(env, context));
      done();
    });
  });

  it('/pebble', function (done) {
    ctx.ddata.devicestatus = [{uploader: {battery: 100}}];
    request(this.appRaw)
      .get('/pebble?count=2')
      .expect(200)
      .end(function (err, res)  {
        var bgs = res.body.bgs;
        bgs.length.should.equal(2);
        var bg = bgs[0];
        bg.sgv.should.equal('90');
        bg.bgdelta.should.equal(-2);
        bg.trend.should.equal(4);
        bg.direction.should.equal('Flat');
        bg.datetime.should.equal(now);
        bg.filtered.should.equal(113984);
        bg.unfiltered.should.equal(111920);
        bg.noise.should.equal(1);
        bg.battery.should.equal('100');
        bg.iob.should.equal('1.50');
        bg.cob.should.equal(22);

        res.body.cals.length.should.equal(1);
        var cal = res.body.cals[0];
        cal.slope.toFixed(3).should.equal('895.857');
        cal.intercept.toFixed(3).should.equal('34281.069');
        cal.scale.should.equal(1);
        done( );
      });
  });

  it('/pebble with no treatments', function (done) {
    ctx.ddata.treatments = [];
    request(this.appRaw)
      .get('/pebble')
      .expect(200)
      .end(function (err, res)  {
        var bgs = res.body.bgs;
        bgs.length.should.equal(1);
        var bg = bgs[0];
        bg.iob.should.equal(0);
        bg.cob.should.equal(0);
        done();
      });
  });

  it('/pebble with IOB from devicestatus', function (done) {
    ctx.ddata.treatments = [];
    ctx.ddata.devicestatus = updateMills([{pump: {iob: {bolusiob: 2.3}}}]);
    request(this.appRaw)
      .get('/pebble')
      .expect(200)
      .end(function (err, res)  {
        var bgs = res.body.bgs;
        bgs.length.should.equal(1);
        var bg = bgs[0];
        bg.iob.should.equal('2.30');
        bg.cob.should.equal(0);
        done();
      });
  });

});
