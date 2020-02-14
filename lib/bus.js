'use strict';
var Stream = require('stream');

function init (settings) {
  var beats = 0;
  var started = new Date( );
  var interval = settings.heartbeat * 1000;
  let busInterval;

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

  stream.teardown = function ( ) {
    console.log('Initiating server teardown');
    clearInterval(busInterval);
    stream.emit('teardown');
  };

  stream.readable = true;
  stream.uptime = repeat;
  busInterval = setInterval(repeat, interval);
  return stream;
}
module.exports = init;

