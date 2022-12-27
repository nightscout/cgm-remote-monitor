'use strict';

var constants = require('./constants');

var levels = {
  URGENT: constants.LEVEL_URGENT
  , WARN: constants.LEVEL_WARN
  , INFO: constants.LEVEL_INFO
  , LOW: constants.LEVEL_LOW
  , LOWEST: constants.LEVEL_LOWEST
  , NONE: constants.LEVEL_NONE
};

levels.language = require('./language')();
levels.translate = levels.language.translate;

var level2Display = {
  '2': 'Urgent'
  , '1':'Warning'
  , '0': 'Info'
  , '-1': 'Low'
  , '-2': 'Lowest'
  , '-3': 'None'
};

levels.isAlarm = function isAlarm(level) {
  return level === levels.WARN || level === levels.URGENT;
};

levels.toDisplay = function toDisplay(level) {
  var key = level !== undefined && level.toString();
  return key && levels.translate(level2Display[key]) || levels.translate('Unknown');
};

levels.toLowerCase = function toLowerCase(level) {
  return levels.toDisplay(level).toLowerCase();
};

levels.toStatusClass = function toStatusClass(level) {
  var cls = 'current';

  if (level === levels.WARN) {
    cls = 'warn';
  } else if (level === levels.URGENT) {
    cls = 'urgent';
  }

  return cls;
};


module.exports = levels;