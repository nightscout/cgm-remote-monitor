'use strict';

const _ = require('lodash');

function init (env) {

  const ipDelayList = {};

  const DELAY_ON_FAIL = _.get(env, 'settings.authFailDelay') || 5000;
  const FAIL_AGE = 60000;

  ipDelayList.addFailedRequest = function addFailedRequest (ip) {
    const ipString = String(ip);
    let entry = ipDelayList[ipString];
    const now = Date.now();
    if (!entry) {
      ipDelayList[ipString] = now + DELAY_ON_FAIL;
      return;
    }
    if (now >= entry) { entry = now; }
    ipDelayList[ipString] = entry + DELAY_ON_FAIL;
  };

  ipDelayList.shouldDelayRequest = function shouldDelayRequest (ip) {
    const ipString = String(ip);
    const entry = ipDelayList[ipString];
    let now = Date.now();
    if (entry) {
      if (now < entry) {
        return entry - now;
      }
    }
    return false;
  };

  ipDelayList.requestSucceeded = function requestSucceeded (ip) {
    const ipString = String(ip);
    if (ipDelayList[ipString]) {
      delete ipDelayList[ipString];
    }
  };

  // Clear items older than a minute

  setTimeout(function clearList () {
    for (var key in ipDelayList) {
      if (ipDelayList.hasOwnProperty(key)) {
        if (Date.now() > ipDelayList[key] + FAIL_AGE) {
          delete ipDelayList[key];
        }
      }
    }
  }, 30000);

  return ipDelayList;
}

module.exports = init;
