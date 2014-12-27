'use strict';

var es = require('event-stream');
var Long = require('long');
var decoders = require('sgvdata/lib/protobuf');
var direction = require('sgvdata/lib/utils').direction;
var mqtt = require('mqtt');
var moment = require('moment');

function process (client) {
  var stream = es.through(
    function _write (data) {
      this.push(data);
    }
  );
  return stream;
}

function every (storage) {
  function iter (item, next) {
    storage.create(item, next);
  }
  return es.map(iter);
}
function downloader ( ) {
  var opts = {
    model: decoders.models.CookieMonsterG4Download
  , json: function (o) { return o; }
  , payload: function (o) { return o; }
  };
  return decoders(opts);
}

function ReceiverTime (ts) {
  var base = Date.parse('2009-01-01T00:00:00-0800');
  return new Date(base + (ts * 1000));
}

function toSGV (proto) {
  var ts = moment(proto.download_timestamp);
  console.log("errr", proto, "TIMESTAMP", ReceiverTime(proto.timestamp_sec));
  var obj = {
    device: 'dexcom'
  , date: ts.unix() * 1000
  , dateString: ts.format()
  , sgv: proto.sgv_mgdl
  , direction: direction(proto.trend)
  , noise: proto.noise
  , type: 'sgv'
  };
  return obj;
}

function createProtoStream (packet) {
  var stream = es.readArray(packet.sgv);
  function map (item, next) {
    var r = toSGV(item);
    console.log("ITEM", item, "TO SGV", r);
    next(null, r);
  }
  return stream.pipe(es.map(map));
}
function long_time (p) {
  var ts = parseInt(new Long(p.low, p.high, p.unsigned).toString( ));
  return new Date(ts);
}

function configure (env, core) {
  var uri = env['MQTT_MONITOR'];
  var opts = {
    encoding: 'binary',
    clean: false,
    clientId: 'master'
  };
  var client = mqtt.connect(uri, opts);
  var downloads = downloader( );
  client.subscribe('sgvs');
  client.subscribe('published');
  client.subscribe('/downloads/protobuf',{qos: 2}, granted);
  client.subscribe('/uploader', granted);
  client.subscribe('/entries/sgv', granted);
  function granted ( ) {
    console.log('granted', arguments);
  }


  client.on('message', function (topic, msg) { console.log('topic', topic);
    console.log(topic, 'on message', 'msg', msg.length);
    switch (topic) {
      case '/uploader':
        console.log({type: topic, msg: msg.toString( )});
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
          console.log('download_timestamp', packet.download_timestamp, Date.parse(packet.download_timestamp));
          console.log("WRITE TO MONGO");
          createProtoStream(packet).pipe(core.persist(function empty(err, result) {
            console.log("DONE WRITING TO MONGO", err);
          }));

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
