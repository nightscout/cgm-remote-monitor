'use strict';

var cache = { };

var factories = {
  days: function days(value) {
    return {
      hours: value * 24 ,mins: value * 24 * 60, secs: value * 24 * 60 * 60, msecs: value * 24 * 60 * 60 * 1000
    };
  }
  , hours: function hours(value) {
    return {
      days: value / 24 ,mins: value * 60, secs: value * 60 * 60, msecs: value * 60 * 60 * 1000
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

function getOrCreate (types) {
  return function withValue (value) {
    var key = types + value;
    var obj = cache[key];
    if (!obj) {
      obj = factories[types](value);
      cache[key] = obj;
    }
    return obj;
  };
}

var times = {
  days: function (value) { return getOrCreate('days')(value); }
  , hour: function ( ) { return getOrCreate('hours')(1); }
  , hours: function (value) { return getOrCreate('hours')(value); }
  , min: function ( ) { return getOrCreate('mins')(1); }
  , mins: function (value) { return getOrCreate('mins')(value); }
  , sec: function ( ) { return getOrCreate('secs')(1); }
  , secs: function (value) { return getOrCreate('secs')(value); }
  , msec: function ( ) { return getOrCreate('msecs')(1); }
  , msecs: function (value) { return getOrCreate('msecs')(value); }
};

module.exports = times;