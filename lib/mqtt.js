'use strict';

var es = require('event-stream');
var Long = require('long');
var decoders = require('sgvdata/lib/protobuf');
var direction = require('sgvdata/lib/utils').direction;
var mqtt = require('mqtt');
var moment = require('moment');

function process(client) {
    var stream = es.through(
        function _write(data) {
            this.push(data);
        }
    );
    return stream;
}

function every(storage) {
    function iter(item, next) {
        storage.create(item, next);
    }

    return es.map(iter);
}

function downloader() {
    var opts = {
        model: decoders.models.G4Download
        , json: function (o) {
            return o;
        }
        , payload: function (o) {
            return o;
        }
    };
    return decoders(opts);
}

function toSGV (proto, vars) {
  vars.sgv = proto.sgv_mgdl;
  vars.direction = direction(proto.trend);
  vars.noise = proto.noise;
  vars.type = 'sgv';
  return vars;
}

function toCal (proto, vars) {
  vars.slope = proto.slope;
  vars.intercept = proto.intercept;
  vars.scale = proto.scale;
  vars.type = 'cal';
  return vars;
}

function toSensor (proto, vars) {
  vars.filtered = new Long(proto.filtered).toInt();
  vars.unfiltered = new Long(proto.unfiltered).toInt();
  vars.rssi = proto.rssi;
  vars.type = 'sensor';
  return vars;
}

function toMeter (proto, result) {
  result.type = 'mbg';
  result.mbg = proto.mbg || proto.meter_bg_mgdl;
  return result;
}

function toTimestamp (proto, receiver_time, download_time) {
  var record_offset = receiver_time - proto.sys_timestamp_sec;
  var record_time = download_time.clone( ).subtract(record_offset, 'second');
  var obj = {
      device: 'dexcom'
      , date: record_time.unix() * 1000
      , dateString: record_time.format( )
  };
  return obj;
}

function sgvSensorMerge(packet) {
  var receiver_time = packet.receiver_system_time_sec;
  var download_time = moment(packet.download_timestamp);

  function timestamp(item) {
    return toTimestamp(item, receiver_time, download_time.clone( ));
  }

  function timeSort(a, b) {
    return a.date - b.date;
  }

  var sgvs = (packet['sgv'] || []).map(function(sgv) {
    var timestamped = timestamp(sgv);
    return toSGV(sgv, timestamped);
  }).sort(timeSort);

  var sensors = (packet['sensor'] || []).map(function(sensor) {
    var timestamped = timestamp(sensor);
    return toSensor(sensor, timestamped);
  }).sort(timeSort);

  //based on com.nightscout.core.dexcom.Utils#mergeGlucoseDataRecords
  var merged = []
    , sgvsLength = sgvs.length
    , sensorsLength = sensors.length;

  if (sgvsLength >= 0 && sensorsLength == 0) {
    merged.concat(sgvs);
  } else {
    var smallerLength = sgvsLength < sensorsLength ? sgvsLength : sensorsLength;
    for (var i = 1; i <= smallerLength; i++) {
      var sgv = sgvs[sgvsLength - i];
      var sensor = sensors[sensorsLength - i];
      if (Math.abs(sgv.date - sensor.date) < 10000) {
        //timestamps are close so merge
        sgv.filtered = sensor.filtered;
        sgv.unfiltered = sensor.unfiltered;
        sgv.rssi = sensor.rssi;
        merged.push(sgv);
      } else {
        //timestamps aren't close enough so add both
        merged.push(sgv);
        //but the sensor will become and sgv now
        sensor.type = 'sgv';
        merged.push(sensor);
      }
    }

    //any extra sgvs?
    if (sgvsLength > smallerLength) {
      for (var j = sgvsLength - smallerLength; j < sgvsLength; j++) {
        var extraSGV = sgvs[j];
        merged.push(extraSGV);
      }
    }

    //any extra sensors?
    if (sensorsLength > smallerLength) {
      for (var k = sensorsLength - smallerLength; k < sensorsLength; k++) {
        var extraSensor = sensors[k];
        //from now on we consider it a sgv
        extraSensor.type = 'sgv';
        merged.push(extraSensor);
      }
    }

  }

  return merged;
}

function iter_mqtt_record_stream (packet, prop, sync) {
  var list = packet[prop];
  console.log('incoming', prop, (list || [ ]).length);
  var stream = es.readArray(list || [ ]);
  var receiver_time = packet.receiver_system_time_sec;
  var download_time = moment(packet.download_timestamp);
    function map(item, next) {
        var timestamped = toTimestamp(item, receiver_time, download_time.clone( ));
        var r = sync(item, timestamped);
        if (!('type' in r)) {
          r.type = prop;
        }
        console.log("ITEM", item, "TO", prop, r);
        next(null, r);
    }
    return stream.pipe(es.map(map));
}

function configure(env, core, devicestatus) {
    var uri = env['MQTT_MONITOR'];
    var opts = {
        encoding: 'binary',
        clean: false,
        clientId: env.mqtt_client_id
    };
    var client = mqtt.connect(uri, opts);
    var downloads = downloader();
    client.subscribe('sgvs');
    client.subscribe('published');
    client.subscribe('/downloads/protobuf', {qos: 2}, granted);
    client.subscribe('/uploader', granted);
    client.subscribe('/entries/sgv', granted);
    function granted() {
        console.log('granted', arguments);
    }


    client.on('message', function (topic, msg) {
        console.log('topic', topic);
        console.log(topic, 'on message', 'msg', msg.length);
        switch (topic) {
            case '/uploader':
                console.log({type: topic, msg: msg.toString()});
                break;
            case '/downloads/protobuf':
                var b = new Buffer(msg, 'binary');
                console.log("BINARY", b.length, b.toString('hex'));
                try {
                    var packet = downloads.parse(b);
                    if (!packet.type) {
                        packet.type = topic;
                    }
                } catch (e) {
                    console.log("DID NOT PARSE", e);
                    break;
                }
                console.log('DOWNLOAD msg', msg.length, packet);
                console.log('download SGV', packet.sgv[0]);
                console.log('download_timestamp', packet.download_timestamp, new Date(Date.parse(packet.download_timestamp)));
                console.log("WRITE TO MONGO");
                var download_timestamp = moment(packet.download_timestamp);
                if (packet.download_status === 0) {
                    es.readArray(sgvSensorMerge(packet)).pipe(core.persist(function empty(err, result) {
                        console.log("DONE WRITING MERGED SGV TO MONGO", err, result);
                    }));

                    iter_mqtt_record_stream(packet, 'cal', toCal)
                      .pipe(core.persist(function empty(err, result) {
                          console.log("DONE WRITING Cal TO MONGO", err, result.length);
                      }));
                    iter_mqtt_record_stream(packet, 'meter', toMeter)
                      .pipe(core.persist(function empty(err, result) {
                          console.log("DONE WRITING Meter TO MONGO", err, result.length);
                      }));
                }
                packet.type = "download";
                devicestatus.create({
                    uploaderBattery: packet.uploader_battery,
                    created_at: download_timestamp.toISOString()
                }, function empty(err, result) {
                    console.log("DONE WRITING TO MONGO devicestatus ", result, err);
                });

                core.create([ packet ], function empty(err, res) {
                    console.log("Download written to mongo: ", packet)
                });


                // core.write(packet);
                break;
            default:
                console.log(topic, 'on message', 'msg', msg);
                // core.write(msg);
                break;
        }
    });
    client.entries = process(client);
    client.every = every;
    return client;
}
module.exports = configure;
