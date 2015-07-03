'use strict';

function configure (app, wares, ctx) {
  var express = require('express')
    , notifications = express.Router( )
    ;

  notifications.post('/notifications/pushovercallback', function (req, res) {
    console.info('GOT Pushover callback', req.body);
    if (ctx.pushnotify.pushoverAck(req.body)) {
      res.sendStatus(200);
    } else {
      res.sendStatus(500);
    }
  });

  return notifications;
}
module.exports = configure;
