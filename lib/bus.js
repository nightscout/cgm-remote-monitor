var Stream = require('stream');

function init (env) {
  var beats = 0;
  var started = new Date( );
  var id;
  var interval = env.HEARTBEAT || 20000;

  var stream = new Stream;

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

  stream.readable = true;
  stream.uptime = repeat;
  id = setInterval(repeat, interval);
  return stream;
}
module.exports = init;

