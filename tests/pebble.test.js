'use strict';

var request = require('supertest');
var should = require('should');

//Mocked ctx
var ctx = {};
var env = {};
var now = Date.now();

function updateMills (entries) {
  //last is now, assume 5m between points
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[entries.length - i - 1];
    entry.mills = now - (i * 5 * 60 * 1000);
  }
  return entries;
}

ctx.data = require('../lib/data')(env, ctx);
ctx.data.sgvs = updateMills([
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

ctx.data.cals = updateMills([
  { device: 'dexcom',
    slope: 895.8571693029189,
    intercept: 34281.06876195567,
    scale: 1,
    type: 'cal'
  }
]);

ctx.data.profiles = [{dia: 4 }];

ctx.data.treatments = updateMills([
  { eventType: 'Snack Bolus', insulin: '1.50', carbs: '22' }
]);

ctx.data.devicestatus.uploaderBattery = 100;

describe('Pebble Endpoint', function ( ) {
  var pebble = require('../lib/pebble');
  before(function (done) {
    var env = require('../env')( );
    this.app = require('express')( );
    this.app.enable('api');
    this.app.use('/pebble', pebble(env, ctx));
    done();
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
});

describe('Pebble Endpoint with Raw and IOB', function ( ) {
  var pebbleRaw = require('../lib/pebble');
  before(function (done) {
    var envRaw = require('../env')( );
    envRaw.settings.enable = 'rawbg iob';
    this.appRaw = require('express')( );
    this.appRaw.enable('api');
    this.appRaw.use('/pebble', pebbleRaw(envRaw, ctx));
    done();
  });

  it('/pebble', function (done) {
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

        res.body.cals.length.should.equal(1);
        var cal = res.body.cals[0];
        cal.slope.toFixed(3).should.equal('895.857');
        cal.intercept.toFixed(3).should.equal('34281.069');
        cal.scale.should.equal(1);
        done( );
      });
  });

});