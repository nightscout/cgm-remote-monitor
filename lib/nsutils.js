'use strict';

function init() {

  function nsutils() {
    return nsutils;
  }

  nsutils.toFixed = function toFixed(value) {
    if (value === 0) {
      return '0';
    } else {
      var fixed = value.toFixed(2);
      return fixed == '-0.00' ? '0.00' : fixed;
    }
  };

  return nsutils();
}

module.exports = init;