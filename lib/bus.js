'use strict';

var Stream = require('stream');

function init (env) {
  var beats = 0;
  var started = new Date( );
  var interval = env.settings.heartbeat * 1000;

  var stream = new Stream;

  function ictus ( ) {
    return {
      now: new Date( )
    , type: 'heartbeat'
    , sig: 'internal://' + ['heartbeat', beats ].join('/')
    , beat: beats++
    , interval: interval
    , started: started
    };
  }

  function repeat ( ) {
    stream.emit('tick', ictus( ));
  }

  stream.readable = true;
  stream.uptime = repeat;
  setInterval(repeat, interval);
  return stream;
}
module.exports = init;

