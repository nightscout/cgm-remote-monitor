
var es = require('event-stream')
var EventEmitter = require('events').EventEmitter;
  ;

function sniff (data) {
  var type = 'sgv';
  if (data.type) {
    type = data.type;
  } else {
    if ('sgv' in data) {
      type = 'mbg';
    }
    if ('mbg' in data) {
      type = 'mbg';
    }
  }
  return type;
}

function hash (data) {
  var type = data.type;
  var list = [ ];
  var prefix = (type || 'datum') + '://';
  var key = prefix + list.join('/');
  return key;
}

function hook (data, stream) {
  var ev = es.through(function (item) {
    this.push(item);
  });
  ev.name = data.type;
  ev.value = data;
  return ev;
}

function dispatcher (opts, fn) {
  function default_cb (h, next) { next(null, h); }
  var cb = (fn && fn.call) ? fn : (opts && opts.call ? opts : default_cb);
  function writer (data) {
    var type = sniff(data);
    if (!data.type) {
      data.type = type;
    }
    this.emit('data', hook(data, stream));
  }
  function ender ( ) {
  }
  var stream = es.pipeline(es.through(writer, ender), es.map(iter));

  function emitter ( ) {
  }

  function start (ev, next) {
  }

  function finish (ev, next) {

  }
  function iter (ev, next) {
    stream.emit(ev.name, ev, next);
    // ev.emit('start');
    // ev.on('finish', next);
  }

  return stream;
}


module.exports = dispatcher;



