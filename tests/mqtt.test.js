'use strict';

require('should');

var FIVE_MINS = 5 * 60 * 1000;

describe('mqtt', function ( ) {

  var mqtt = require('../lib/mqtt');

  var now = Date.now()
    , prev1 = now - FIVE_MINS
    , prev2 = prev1 - FIVE_MINS
    ;

  it('setup env correctly', function (done) {
    process.env.MONGO='mongodb://localhost/test_db';
    process.env.MONGO_COLLECTION='test_sgvs';
    process.env.MQTT_MONITOR = 'mqtt://user:password@m10.cloudmqtt.com:12345';
    var env = require('../env')();
    env.mqtt_client_id.should.equal('fSjoHx8buyCtAc474tg8Dt3');
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

    var merged = mqtt.sgvSensorMerge(packet);

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

    var merged = mqtt.sgvSensorMerge(packet);

    merged.length.should.equal(packet.sgv.length);

    merged.filter(function (sgv) {
      return sgv.filtered && sgv.unfiltered && sgv.rssi;
    }).length.should.equal(packet.sgv.length);

    done();

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

    var merged = mqtt.sgvSensorMerge(packet);

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

    var merged = mqtt.sgvSensorMerge(packet);

    merged.length.should.equal(packet.sensor.length);

    var withBoth = merged.filter(function (sgv) {
      return sgv.sgv && sgv.filtered && sgv.unfiltered && sgv.rssi;
    });

    withBoth.length.should.equal(1);

    done();

  });


});
