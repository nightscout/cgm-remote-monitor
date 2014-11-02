'use strict';

var es = require('event-stream');
var Long = require('long');
var decoders = require('sgvdata/lib/protobuf');
var mqtt = require('mqtt');

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

function configure (env) {
  var uri = env['MQTT_MONITOR'];
  var opts = {encoding: 'binary'};
  var client = mqtt.connect(uri, opts);
  var downloads = downloader( );
  client.subscribe('sgvs');
  client.subscribe('published');
  client.subscribe('/downloads/protobuf', granted);
  client.subscribe('downloads/protobuf', granted);
  client.subscribe('/entries/sgv', granted);
  client.subscribe('entries/sgv', granted);
  function granted ( ) {
    console.log('granted', arguments);
  }

  function long_time (p) {
    var ts = parseInt(new Long(p.low, p.high, p.unsigned).toString( ));
    return new Date(ts);
  }

  client.on('/downloads/protobuf', function (topic, msg) {
    console.log('topic got protobuf!', topic);
    console.log('DOWNLOAD msg', msg.length, downloads.parse(msg));
  });

  client.on('message', function (topic, msg) { console.log('topic', topic);
    console.log(topic, 'on message', 'msg', msg.length);
    switch (topic) {
      case '/downloads/protobuf':
        var b = new Buffer(msg, 'binary');
        console.log("BINARY", b.length, b.toString('hex'));
        try {
          var packet = downloads.parse(b);
          console.log('DOWNLOAD msg', msg.length, packet);
          console.log('download SGV', packet.sgv[0]);
          console.log('download_timestamp', packet.download_timestamp, long_time(packet.download_timestamp));
        } catch (e) {
          console.log("DID NOT PARSE", e);
        }
        break;
      default:
        console.log(topic, 'on message', 'msg', msg);
        break;
    }
  });
  client.entries = process(client);
  client.every = every;
  return client;
}
module.exports = configure;
