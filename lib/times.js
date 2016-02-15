'use strict';

var factories = {
  weeks: function weeks(value) {
    return {
      mins: value * 7 * 24 * 60, secs: value * 7 * 24 * 60 * 60, msecs: value * 7 * 24 * 60 * 60 * 1000
    };
  }
  , days: function days(value) {
    return {
      mins: value * 24 * 60, secs: value * 24 * 60 * 60, msecs: value * 24 * 60 * 60 * 1000
    };
  }
  , hours: function hours(value) {
    return {
      mins: value * 60, secs: value * 60 * 60, msecs: value * 60 * 60 * 1000
    };
  }
  , mins: function mins(value) {
    return {
      secs: value * 60, msecs: value * 60 * 1000
    };
  }
  , secs: function secs(value) {
    return {
      msecs: value * 1000
    };
  }
  , msecs: function msecs(value) {
    return {
      mins: value / 1000 / 60, secs: value / 1000, msecs: value
    };
  }
};

function create (types) {
  return function withValue (value) {
    return factories[types](value);
  }
}

var times = {
  week: function ( ) { return create('weeks')(1); }
  , weeks: function (value) { return create('weeks')(value); }
  , day: function ( ) { return create('days')(1); }
  , days: function (value) { return create('days')(value); }
  , hour: function ( ) { return create('hours')(1); }
  , hours: function (value) { return create('hours')(value); }
  , min: function ( ) { return create('mins')(1); }
  , mins: function (value) { return create('mins')(value); }
  , sec: function ( ) { return create('secs')(1); }
  , secs: function (value) { return create('secs')(value); }
  , msec: function ( ) { return create('msecs')(1); }
  , msecs: function (value) { return create('msecs')(value); }
};

module.exports = times;