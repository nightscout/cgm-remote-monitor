'use strict';

function configure () {
  var self = {}

  
  /**
    * Floor date to whole seconds (cut off milliseconds)
    * @param {Date} date
    */
  self.floorSeconds = function floorSeconds (date) {
    var ms = date.getTime();
    ms -= ms % 1000;
    return new Date(ms);
  }


  return self;
}
module.exports = configure;
