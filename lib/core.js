
var es = require('event-stream')
var EventEmitter = require('events').EventEmitter;
  ;

function sniff (data) {
  var type = 'sgv';
  if (data.type) {
    type = data.type;
  } else {
    type = 'unknown';
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
    /*
    TODO: enforce hash/sig somewhere, but not here, rather delegate to
    any known models, then do last resort.
    var sig = hash(data);
    if (!data.sig) {
      data.sig = sig;
    }
    */
    var ev = hook(data, this);
    this.push(ev);
  }
  function ender ( ) {
    console.log('ending');
  }
  var stream = es.through(writer, ender);

  function emitter ( ) { }

  function start (ev, next) {
    // TODO: inspect known models/register, bless with mixins?
  }

  function finish (ev, next) {
    // TODO: execute hook's own stream, using one writable to process
    // single data entry
    // es.pipeline(es.readArray([hook.value]), hook, es.writeArray(done));
    /*
    function done (err, results) {
      // next(err, results);
      // stream.emit('finished', results, ...);
      // next(err);
    }
    */
  }
  function iter (ev, next) {
    // TODO:
    // hook.inject(stream);
    stream.emit(ev.name, ev);
    next(null, ev);
  }

  es.pipeline(stream, es.map(iter));
  return stream;
}


module.exports = dispatcher;


