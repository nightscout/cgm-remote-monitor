'use strict';

var _ = require('lodash');

var head = '<!DOCTYPE html><html><head><title>Nightscout - Boot Error</title></head><body><h1>Nightscout - Boot Error</h1><dl>';
var tail = '</dl></body></html>';

function bootError(ctx) {

  return function pageHandler (req, res) {
    var errors = _.map(ctx.bootErrors, function (obj) {

      let message;

      if (typeof obj.err === 'string' || obj.err instanceof String) {
        console.log('Its a string');
        message = obj.err;
      } else {
        message = JSON.stringify(_.pick(obj.err, Object.getOwnPropertyNames(obj.err)));
      }
      return '<dt>' + obj.desc + '</dt><dd>' + message.replace(/\\n/g, '<br/>') + '</dd>';
    }).join(' ');

    res.set('Content-Type', 'text/html');
    res.send(head + errors + tail);

  }
}

module.exports = bootError;