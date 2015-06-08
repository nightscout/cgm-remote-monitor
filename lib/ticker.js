
var es = require('event-stream');
var Stream = require('stream');

function heartbeat (env, ctx) {
  var beats = 0;
  var started = new Date( );
  var id;
  var interval = env.HEARTBEAT || 20000;
  function ictus ( ) {
    var tick = {
      now: new Date( )
    , type: 'heartbeat'
    , sig: 'internal://' + ['heartbeat', beats ].join('/')
    , beat: beats++
    , interval: interval
    , started: started
    };
    return tick;
  }
  function repeat ( ) {
    stream.emit('tick', ictus( ));
  }
  function ender ( ) {
    if (id) cancelInterval(id);
    stream.emit('end');
  }
  var stream = new Stream;
  stream.readable = true;
  stream.uptime = repeat;
  id = setInterval(repeat, interval);
  return stream;
}
module.exports = heartbeat;

