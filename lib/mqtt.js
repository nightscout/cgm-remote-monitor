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
  client.subscribe('/downloads/protobuf');
  client.subscribe('entries/sgv', function ( ) {
    console.log('granted', arguments);
  });

  client.on('/downloads/protobuf', function (topic, msg) { console.log('topic', topic);

    console.log('DOWNLOAD msg', msg, downloads.parse(msg));
  });

  client.on('message', function (topic, msg) { console.log('topic', topic);
    console.log('msg', msg);
  });
  client.entries = process(client);
  client.every = every;
  return client;
}
module.exports = configure;
