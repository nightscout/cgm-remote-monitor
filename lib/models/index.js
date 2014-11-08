
var es = require('event-stream');
var lo = require('lodash');
var qs = require('querystring');
// var unique = require('unique-stream');

function tailed (opts) {
  var max = opts.max || 100;
  function writer (data) {
    console.log('add to list', tr.list.length);
    tr.list.push(data);
    while (tr.list.length > max) {
      console.log('deleting from list');
      tr.list.shift( );
    }
    this.push(data);
  }
  var tr = es.through(writer);
  tr.list = [ ];
  tr.slice = tr.list.slice.bind(tr.list);
  return tr;
}

function uniq (stream) {
  function writer (data) {
    console.log('deduping', stream.list.length, data.sig, data);
    if (data.sig) {
      var dupes = lo.find(stream.list, { "sig": data.sig });
      console.log("FOUND DUPES", !!dupes);
      if (!dupes) {
        console.log("NEW DATA!!!!");
        this.push(data);
      }
    }
  }
  var tr = es.through(writer);
  return tr;
  // return unique('sig');
  return stream.pipe(tr);
}

function signature (opts) {
  function default_sig (d) {
    var fields = opts.indexedFields || [ 'timestamp', 'type', 'date', 'now' ];
    fields.sort( );
    var o = lo.pick(d, fields);
    return qs.encode(o);
    
    
  }
  var sig = opts.sig || default_sig;
  function iter (item, next) {
    if (!item.sig) {
      item.sig  = sig(item);
    }
    next(null, item);
  }
  return es.map(iter);

}

function normalize (opts) {
  var tail = tailed(opts);
  var pipe = es.pipeline(signature(opts), uniq(tail), tail);
  return pipe;
}

function done (keep, origin, fn) {
  var ender = es.writeArray(fn);
  var alive = es.through(function write (data) {
    this.emit('data', data);
  }, function end ( ) {
    ender.emit('end');
    return false;
  });
  return es.pipeline(keep, alive, origin, ender);
}

function create (core) {
  var types = { };

  function tailor (opts) {
    function writer (data) {
      console.log('tailor', data);
      var self = this;
      if (data.name) {
        if (data.name.split('://')[0] == 'internal') {
          console.log('skipping');
          return;
        }
        if (!types[data.name]) {
          console.log('creating new type stream', data.name);
          var tail = normalize({ });
          switch (data.name) {
            case 'sgv':
            case '/downloads/protobuf':
            case '/entries/sgv':
            case 'mbg':
            case '/uploader':
              console.log('INVOKE SPECIAL', data.name, data.value.sig || data.name);
              break;
            default:
              break;
          }
          types[data.name] = tail;
          // By adding stages here, we can do a kind of
          // * ingest | validate | uniq | store
          // or even a
          // * request | lookup | result kind of model.
          tail.pipe(es.map(finish));
        }
        console.log('piping to', types[data.name]);
        // es.readArray([data.value])
        types[data.name].write(data.value);
        function finish (value, next) {
          console.log('iter FINISH');
          self.push(data.value);
          next(null, value);
        }
        /*
        done(es.readArray([data.value]), types[data.name], (function (err, results) {
          console.log("FINISH MODEL", data, arguments, results);
          // self.push(results);
        })).on('error', function (e) { console.error(e); });
        // types.write(data.value);
        */
      }
    }
    var stream = es.through(writer);
    return stream;

  }
  var master = tailor({ });
  core.inputs.pipe(master);
  // master.pipe(core.inputs);
  return master;

}
module.exports = create;


