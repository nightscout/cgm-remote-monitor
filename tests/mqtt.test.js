'use strict';

var should = require('should');

var FIVE_MINS = 5 * 60 * 1000;

describe('mqtt', function ( ) {

  var self = this;

  before(function () {
    process.env.MQTT_MONITOR = 'mqtt://user:password@localhost:12345';
    process.env.MONGO='mongodb://localhost/test_db';
    process.env.MONGO_COLLECTION='test_sgvs';
    self.env = require('../env')();
    self.es = require('event-stream');
    self.results = self.es.through(function (ch) { this.push(ch); });
    function outputs (fn) {
      return self.es.writeArray(function (err, results) {
        fn(err, results);
        self.results.write(err || results);
      });
    }
    function written (data, fn) {
      self.results.write(data);
      setTimeout(fn, 5);
    }
    self.mqtt = require('../lib/mqtt')(self.env, {entries: { persist: outputs, create: written }, devicestatus: { create: written } });
  });

  after(function () {
    delete process.env.MQTT_MONITOR;
  });

  var now = Date.now()
    , prev1 = now - FIVE_MINS
    , prev2 = prev1 - FIVE_MINS
    ;

  it('setup env correctly', function (done) {
    self.env.mqtt_client_id.should.equal('fSjoHx8buyCtAc474tg8Dt3');
    done();
  });

  it('handle a download with only sgvs', function (done) {
    var packet = {
      sgv: [
        {sgv_mgdl: 110, trend: 4, date: prev2}
        , {sgv_mgdl: 105, trend: 4, date: prev1}
        , {sgv_mgdl: 100, trend: 4, date: now}
      ]
    };

    var merged = self.mqtt.sgvSensorMerge(packet);

    merged.length.should.equal(packet.sgv.length);

    done();

  });

  it('merge sgvs and sensor records that match up', function (done) {
    var packet = {
      sgv: [
        {sgv_mgdl: 110, trend: 4, date: prev2}
        , {sgv_mgdl: 105, trend: 4, date: prev1}
        , {sgv_mgdl: 100, trend: 4, date: now}
      ]
      , sensor: [
        {filtered: 99999, unfiltered: 99999, rssi: 200, date: prev2}
        , {filtered: 99999, unfiltered: 99999, rssi: 200, date: prev1}
        , {filtered: 99999, unfiltered: 99999, rssi: 200, date: now}
      ]
    };

    var merged = self.mqtt.sgvSensorMerge(packet);

    merged.length.should.equal(packet.sgv.length);

    merged.filter(function (sgv) {
      return sgv.filtered && sgv.unfiltered && sgv.rssi;
    }).length.should.equal(packet.sgv.length);

    done();

  });

  it('downloadProtobuf should dispatch', function (done) {

    var payload = new Buffer('0a1108b70110d6d1fa6318f08df963200428011a1d323031352d30382d32335432323a35333a35352e3634392d30373a303020d7d1fa6328004a1508e0920b10c0850b18b20120d5d1fa6328ef8df963620a534d34313837393135306a053638393250', 'hex');

    // var payload = self.mqtt.downloads.format(packet);
    console.log('yaploda', '/downloads/protobuf', payload);
    var l = [ ];
    self.results.on('data', function (chunk) {
      l.push(chunk);
      console.log('test data', l.length, chunk.length, chunk);
      switch (l.length) {
        case 0: // devicestatus
          break;
        case 2: // sgv
          break;
        case 3: // sgv
          chunk.length.should.equal(1);
          var first = chunk[0];
          should.exist(first.sgv);
          should.exist(first.noise);
          should.exist(first.date);
          should.exist(first.dateString);
          first.type.should.equal('sgv');
          break;
        case 4: // cal
          break;
        case 1: // meter
          break;
        default:
          break;
      }
      if (l.length >= 5) {
        self.results.end( );
      }
    });
    self.results.on('end', function ( ) {
        done( );
    });
    self.mqtt.client.emit('message', '/downloads/protobuf', payload);
  });

  it('merge sgvs and sensor records that match up, and get the sgvs that don\'t match', function (done) {
    var packet = {
      sgv: [
        {sgv_mgdl: 110, trend: 4, date: prev2}
        , {sgv_mgdl: 105, trend: 4, date: prev1}
        , {sgv_mgdl: 100, trend: 4, date: now}
      ]
      , sensor: [
        {filtered: 99999, unfiltered: 99999, rssi: 200, date: now}
      ]
    };

    var merged = self.mqtt.sgvSensorMerge(packet);

    merged.length.should.equal(packet.sgv.length);

    var withBoth = merged.filter(function (sgv) {
      return sgv.sgv && sgv.filtered && sgv.unfiltered && sgv.rssi;
    });

    withBoth.length.should.equal(1);

    done();

  });

  it('merge sgvs and sensor records that match up, and get the sensors that don\'t match', function (done) {
    var packet = {
      sgv: [
        {sgv_mgdl: 100, trend: 4, date: now}
      ]
      , sensor: [
        {filtered: 99999, unfiltered: 99999, rssi: 200, date: prev2}
        , {filtered: 99999, unfiltered: 99999, rssi: 200, date: prev1}
        , {filtered: 99999, unfiltered: 99999, rssi: 200, date: now}
      ]
    };

    var merged = self.mqtt.sgvSensorMerge(packet);

    merged.length.should.equal(packet.sensor.length);

    var withBoth = merged.filter(function (sgv) {
      return sgv.sgv && sgv.filtered && sgv.unfiltered && sgv.rssi;
    });

    withBoth.length.should.equal(1);

    done();

  });


});
