'use strict';

var consts = require('./constants');

function mgdlToMMOL(mgdl) {
  return (Math.round((mgdl / consts.MMOL_TO_MGDL) * 10) / 10).toFixed(1);
}

function mmolToMgdl(mgdl) {
  return Math.round(mgdl * consts.MMOL_TO_MGDL);
}

function configure() {
  return {
    mgdlToMMOL: mgdlToMMOL
    , mmolToMgdl: mmolToMgdl
  };
}

module.exports = configure;