'use strict';

function configure () {
  var self = {}

  
  /**
   * Check the string for strictly valid number (no other characters present)
   * @param {any} str
   */
  self.isNumberInString = function isNumberInString (str) {
    return !isNaN(parseFloat(str)) && isFinite(str);
  }


  /**
   * Check the string for non-whitespace characters presence
   * @param {any} input
   */
  self.isNullOrWhitespace = function isNullOrWhitespace (input) {

    if (typeof input === 'undefined' || input == null) return true;

    return input.replace(/\s/g, '').length < 1;
  }


  return self;
}
module.exports = configure();
