'use strict';

var es = require('event-stream');
var Long = require('long');
var decoders = require('sgvdata/lib/protobuf');
var direction = require('sgvdata/lib/utils').direction;
var moment = require('moment');
var url = require('url');

function init (env, ctx) {

  function mqtt ( ) {
    return mqtt;
  }
  var info = url.parse(env.MQTT_MONITOR);
  var username = info.auth.split(':').slice(0, -1).join('');
  var shared_topic = '/downloads/' + username + '/#';
  var alias_topic = '/downloads/' + username + '/protobuf';
  var notification_topic = '/notifications/' + username + '/json';
  env.mqtt_shared_topic = shared_topic;

  mqtt.client = connect(env);
  var downloads = mqtt.downloads = downloader();

  if (mqtt.client) {
    listenForMessages(ctx);
  }

  mqtt.every = every;
  mqtt.entries = process();

  //expose for tests that don't need to connect
  mqtt.sgvSensorMerge = sgvSensorMerge;

  function listenForMessages ( ) {
    mqtt.client.on('message', function (topic, msg) {
      console.log('topic', topic);
      // XXX: ugly hack
      if (topic === alias_topic) {
        topic = '/downloads/protobuf';
      }

      console.log(topic, 'on message', 'msg', msg.length);
      switch (topic) {
        case '/uploader':
          console.log({type: topic, msg: msg.toString()});
          break;
        case '/downloads/protobuf':
          downloadProtobuf(msg, topic, downloads, ctx);
          break;

        default:
          console.log(topic, 'on message', 'msg', msg);
          // ctx.entries.write(msg);
          break;
      }
    });
  }

  mqtt.emitNotification = function emitNotification(notify) {
    console.info('Publishing notification to mqtt: ', notify);
    [notification_topic, '/notifications/json'].forEach(function iter_notify (topic) {
      mqtt.client.publish(topic, JSON.stringify(notify), function mqttCallback (err) {
        if (err) {
          console.error('Unable to publish notification to MQTT', err);
        }
      });
    });
  };

  return mqtt();
}

function connect (env) {
  var uri = env.MQTT_MONITOR;
  var shared_topic = env.mqtt_shared_topic;
  if (!uri) {
    return null;
  }

  var opts = {
    encoding: 'binary',
    clean: false,
    clientId: env.mqtt_client_id
  };
  var client = require('mqtt').connect(uri, opts);

  function granted () { console.log('granted', arguments); }

  client.subscribe('sgvs');
  client.subscribe('published');
  client.subscribe('/downloads/protobuf', {qos: 2}, granted);
  client.subscribe(shared_topic, {qos: 2}, granted);
  client.subscribe('/uploader', granted);
  client.subscribe('/entries/sgv', granted);

  return client;
}

function process ( ) {
  var stream = es.through(
    function _write(data) {
      this.push(data);
    }
  );
  return stream;
}

function every (storage) {
  function iter(item, next) {
    storage.create(item, next);
  }

  return es.map(iter);
}

function downloader ( ) {
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

function downloadProtobuf (msg, topic, downloads, ctx) {
  var b = new Buffer(msg, 'binary');
  console.log('BINARY', b.length, b.toString('hex'));
  var packet;
  try {
    packet = downloads.parse(b);
    if (!packet.type) {
      packet.type = topic;

    }
    console.log('DOWNLOAD msg', msg.length, packet);
    console.log('download SGV', packet.sgv[0]);
    console.log('download_timestamp', packet.download_timestamp, new Date(Date.parse(packet.download_timestamp)));
    console.log('WRITE TO MONGO');
    var download_timestamp = moment(packet.download_timestamp);
    if (packet.download_status === 0) {
      es.readArray(sgvSensorMerge(packet)).pipe(ctx.entries.persist(function empty(err, result) {
        console.log('DONE WRITING MERGED SGV TO MONGO', err, result);
      }));

      iter_mqtt_record_stream(packet, 'cal', toCal)
        .pipe(ctx.entries.persist(function empty(err, result) {
          console.log('DONE WRITING Cal TO MONGO', err, result.length);
        }));
      iter_mqtt_record_stream(packet, 'meter', toMeter)
        .pipe(ctx.entries.persist(function empty(err, result) {
          console.log('DONE WRITING Meter TO MONGO', err, result.length);
        }));
    }
    packet.type = 'download';
    ctx.devicestatus.create({
      uploaderBattery: packet.uploader_battery,
      created_at: download_timestamp.toISOString()
    }, function empty(err, result) {
      console.log('DONE WRITING TO MONGO devicestatus ', result, err);
    });

    ctx.entries.create([ packet ], function empty(err) {
      if (err) {
        console.log('Error writting to mongo: ', err);
      } else {
        console.log('Download written to mongo: ', packet);
      }
    });
  } catch (e) {
    console.log('DID NOT PARSE', e);
  }
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

function timestampFactory (packet) {
  var receiver_time = packet.receiver_system_time_sec;
  var download_time = moment(packet.download_timestamp);
  function timestamp (item) {
    return toTimestamp(item, receiver_time, download_time.clone( ));
  }
  return timestamp;
}

function timeSort (a, b) {
  return a.date - b.date;
}

function sgvSensorMerge (packet) {
  var timestamp = timestampFactory(packet);
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

  if (sgvsLength >= 0 && sensorsLength === 0) {
    merged = sgvs;
  } else {
    var smallerLength = Math.min(sgvsLength, sensorsLength);
    for (var i = 1; i <= smallerLength; i++) {
      var sgv = sgvs[sgvsLength - i];
      var sensor = sensors[sensorsLength - i];
      if (sgv && sensor && Math.abs(sgv.date - sensor.date) < 10000) {
        //timestamps are close so merge
        sgv.filtered = sensor.filtered;
        sgv.unfiltered = sensor.unfiltered;
        sgv.rssi = sensor.rssi;
        merged.push(sgv);
      } else {
        console.info('mismatch or missing, sgv: ', sgv, ' sensor: ', sensor);
        //timestamps aren't close enough so add both
        if (sgv) { merged.push(sgv); }
        //but the sensor will become and sgv now
        if (sensor) {
          sensor.type = 'sgv';
          merged.push(sensor);
        }
      }
    }

    //any extra sgvs?
    if (sgvsLength > smallerLength) {
      for (var j = 0; j < sgvsLength - smallerLength; j++) {
        var extraSGV = sgvs[j];
        merged.push(extraSGV);
      }
    }

    //any extra sensors?
    if (sensorsLength > smallerLength) {
      for (var k = 0; k < sensorsLength - smallerLength; k++) {
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
    console.log('ITEM', item, 'TO', prop, r);
    next(null, r);
  }
  return stream.pipe(es.map(map));
}

init.downloadProtobuf = downloadProtobuf;
module.exports = init;
