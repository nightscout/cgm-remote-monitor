const fs = require('fs');
const moment = require('moment-timezone');
const language = require('../lib/language')(fs);
const settings = require('../lib/settings')();
const levels = require('../lib/levels');

function helper() {

    if (process.env['DISPLAY_UNITS'] && process.env['DISPLAY_UNITS'].toLowerCase().includes('mmol')) {
      settings.units = 'mmol';
    }

    helper.ctx = {
        language: language
        , settings: settings
        , levels: levels
        , moment: moment
      };

    helper.getctx = function getctx () {
        return helper.ctx;
    }

    return helper;
}

module.exports = helper;
