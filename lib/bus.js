'use strict';
var EventEmitter = require('events');

function init (settings) {
  var beats = 0;
  var started = new Date( );
  var interval = settings.heartbeat * 1000;
  let busInterval;

  var bus = new EventEmitter;

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
    bus.emit('tick', ictus( ));
  }

  bus.teardown = function ( ) {
    console.log('Initiating server teardown');
    clearInterval(busInterval);
    bus.emit('teardown');
  };

  bus.uptime = repeat;
  busInterval = setInterval(repeat, interval);
  return bus;
}
module.exports = init;

