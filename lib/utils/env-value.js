'use strict';

// Match Nightscout's environment precedence, including Azure connection
// settings and lowercase aliases. Callers decide how defaults are applied.
module.exports = function envValue(source, name) {
  return source['CUSTOMCONNSTR_' + name] || source['CUSTOMCONNSTR_' + name.toLowerCase()]
    || source[name] || source[name.toLowerCase()];
};
