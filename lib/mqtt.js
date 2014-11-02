'use strict';

var es = require('event-stream');
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
  var client = mqtt.connect(uri);
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
          console.log('DOWNLOAD msg', msg.length, downloads.parse(b));
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
