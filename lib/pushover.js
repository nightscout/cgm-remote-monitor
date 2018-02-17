'use strict';

var Pushover = require('pushover-notifications');

function init(env) {
    if (env.pushover_api_token && env.pushover_user_key) {
        return new Pushover({
            token: env.pushover_api_token,
            user: env.pushover_user_key,
            onerror: function (err) {
                console.log(err);
            }
        });
    } else {
        return null;
    }
}

module.exports = init;