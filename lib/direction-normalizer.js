'use strict';

var directionAliases = {
  none: 'NONE'
  , tripleup: 'TripleUp'
  , doubleup: 'DoubleUp'
  , singleup: 'SingleUp'
  , fortyfiveup: 'FortyFiveUp'
  , flat: 'Flat'
  , fortyfivedown: 'FortyFiveDown'
  , singledown: 'SingleDown'
  , doubledown: 'DoubleDown'
  , tripledown: 'TripleDown'
  , notcomputable: 'NOT COMPUTABLE'
  , rateoutofrange: 'RATE OUT OF RANGE'

  , up: 'SingleUp'
  , down: 'SingleDown'
  , slideup: 'FortyFiveUp'
  , slidedown: 'FortyFiveDown'
  , slightup: 'FortyFiveUp'
  , slightdown: 'FortyFiveDown'
};

function normalizeDirection(direction) {
  if (!direction) {
    return direction;
  }

  var key = String(direction).trim().replace(/[\s_-]+/g, '').toLowerCase();
  return directionAliases[key] || direction;
}

module.exports = {
  normalizeDirection: normalizeDirection
};
