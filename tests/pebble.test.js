
var request = require('supertest');
var should = require('should');

//Mock entries
var entries = {
  list: function(opts, callback) {
    var sgvs = [
      { device: 'dexcom',
        date: 1422727301000,
        dateString: 'Sat Jan 31 10:01:41 PST 2015',
        sgv: 82,
        direction: 'Flat',
        type: 'sgv',
        filtered: 113984,
        unfiltered: 111920,
        rssi: 179,
        noise: 1
      },
      { device: 'dexcom',
        date: 1422727001000,
        dateString: 'Sat Jan 31 09:56:41 PST 2015',
        sgv: 84,
        direction: 'Flat',
        type: 'sgv',
        filtered: 115680,
        unfiltered: 113552,
        rssi: 179,
        noise: 1
      },
      { device: 'dexcom',
        date: 1422726701000,
        dateString: 'Sat Jan 31 09:51:41 PST 2015',
        sgv: 86,
        direction: 'Flat',
        type: 'sgv',
        filtered: 117808,
        unfiltered: 114640,
        rssi: 169,
        noise: 1
      },
      { device: 'dexcom',
        date: 1422726401000,
        dateString: 'Sat Jan 31 09:46:41 PST 2015',
        sgv: 88,
        direction: 'Flat',
        type: 'sgv',
        filtered: 120464,
        unfiltered: 116608,
        rssi: 175,
        noise: 1
      },
      { device: 'dexcom',
        date: 1422726101000,
        dateString: 'Sat Jan 31 09:41:41 PST 2015',
        sgv: 91,
        direction: 'Flat',
        type: 'sgv',
        filtered: 124048,
        unfiltered: 118880,
        rssi: 174,
        noise: 1
      }
    ];

    var cals = [
      { device: 'dexcom',
        date: 1422647711000,
        dateString: 'Fri Jan 30 11:55:11 PST 2015',
        slope: 895.8571693029189,
        intercept: 34281.06876195567,
        scale: 1,
        type: 'cal'
      }
    ];

    var count = (opts && opts.count) || 1;

    if (opts && opts.find && opts.find.sgv) {
      callback(null, sgvs.slice(0, count));
    } else if (opts && opts.find && opts.find.type == 'cal') {
      callback(null, cals.slice(0, count));
    }
  }
};

//Mock devicestatus
var treatments = {
  list: function(callback) {
    callback(null, []);
  }
};

var profile = {
  list: function(callback) {
    callback(null, []);
  }
};

var devicestatus = {
  last: function(callback) {
    callback(null, {uploaderBattery: 100});
  }
};

describe('Pebble Endpoint without Raw', function ( ) {
  var pebble = require('../lib/pebble');
  before(function (done) {
    var env = require('../env')( );
    this.app = require('express')( );
    this.app.enable('api');
    this.app.use('/pebble', pebble(entries, treatments, profile, devicestatus, env));
    done();
  });

  it('should be a module', function ( ) {
    pebble.should.be.ok;
  });

  it('/pebble default(1) count', function (done) {
    request(this.app)
      .get('/pebble')
      .expect(200)
      .end(function (err, res)  {
        var bgs = res.body.bgs;
        bgs.length.should.equal(1);
        var bg = bgs[0];
        bg.sgv.should.equal('82');
        bg.bgdelta.should.equal(-2);
        bg.trend.should.equal(4);
        bg.direction.should.equal('Flat');
        bg.datetime.should.equal(1422727301000);
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
        bg.sgv.should.equal('82');
        bg.bgdelta.should.equal(-2);
        bg.trend.should.equal(4);
        bg.direction.should.equal('Flat');
        bg.datetime.should.equal(1422727301000);
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


describe('Pebble Endpoint with Raw', function ( ) {
  var pebbleRaw = require('../lib/pebble');
  before(function (done) {
    var envRaw = require('../env')( );
    envRaw.enable = "rawbg";
    this.appRaw = require('express')( );
    this.appRaw.enable('api');
    this.appRaw.use('/pebble', pebbleRaw(entries, treatments, profile, devicestatus, envRaw));
    done();
  });

  it('should be a module', function ( ) {
    pebbleRaw.should.be.ok;
  });

  it('/pebble', function (done) {
    request(this.appRaw)
      .get('/pebble?count=2')
      .expect(200)
      .end(function (err, res)  {
        var bgs = res.body.bgs;
        bgs.length.should.equal(2);
        var bg = bgs[0];
        bg.sgv.should.equal('82');
        bg.bgdelta.should.equal(-2);
        bg.trend.should.equal(4);
        bg.direction.should.equal('Flat');
        bg.datetime.should.equal(1422727301000);
        bg.filtered.should.equal(113984);
        bg.unfiltered.should.equal(111920);
        bg.noise.should.equal(1);
        bg.battery.should.equal('100');

        res.body.cals.length.should.equal(1);
        var cal = res.body.cals[0];
        cal.slope.should.equal(896);
        cal.intercept.should.equal(34281);
        cal.scale.should.equal(1);
        done( );
      });
  });

});