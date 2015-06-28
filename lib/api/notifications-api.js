'use strict';

function configure (app, wares, ctx) {
  var express = require('express'),
    notifications = express.Router( )
    ;

  notifications.get('/notifications/snooze', function (req, res) {
    console.info('GOT web notification snooze', req.query);
    var result = ctx.notifications.secureAck(
      req.query.level
      , req.query.lengthMills
      , req.query.t
      , req.query.sig
    );
    res.redirect(302, '/result/?ok=' + result);
  });

  notifications.post('/notifications/pushovercallback', function (req, res) {
    console.info('GOT Pushover callback', req.body);
    var result = ctx.pushnotify.pushoverAck(req.body);
    res.redirect(302, '/result/?ok=' + result);
  });

  return notifications;
}
module.exports = configure;
