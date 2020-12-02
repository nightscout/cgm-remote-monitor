'use strict';

function init () {

  const ipDelayList = {};

  const DELAY_ON_FAIL = 5000;
  const FAIL_AGE = 60000;

  const sleep = require('util').promisify(setTimeout);

  ipDelayList.addFailedRequest = function addFailedRequest (ip) {
    let entry = ipDelayList[ip];
    const now = Date.now();
    if (!entry) {
      ipDelayList[ip] = now + DELAY_ON_FAIL;
      return;
    }
    if (now >= entry) { entry = now; }
    ipDelayList[ip] = entry + DELAY_ON_FAIL;
  }

  ipDelayList.shouldDelayRequest = function shouldDelayRequest (ip) {
    let entry = ipDelayList[ip];
    let now = Date.now();
    if (entry) {
      if (now < entry) {
        return entry - now;
      }
    }
    return false;
  }

  ipDelayList.requestSucceeded = function requestSucceeded (ip) {
    if (ipDelayList[ip]) {
      delete ipDelayList[ip];
    }
  }

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
