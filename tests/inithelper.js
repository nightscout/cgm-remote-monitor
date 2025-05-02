
const fs = require('fs');
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const relativeTime = require("dayjs/plugin/relativeTime");
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(relativeTime);
const language = require('../lib/language')(fs);
const settings = require('../lib/settings')();
const levels = require('../lib/levels');

function helper() {

    helper.ctx = {
        language: language
        , settings: settings
        , levels: levels
        /** deprecated */
        , moment: dayjs
        , dayjs: dayjs
      };

    helper.getctx = function getctx () {
        return helper.ctx;
    }

    return helper;
}

module.exports = helper;
