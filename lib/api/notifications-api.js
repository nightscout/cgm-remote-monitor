'use strict';

function configure (app, wares, ctx) {
  var express = require('express')
    , api = express.Router( )
    ;

  api.post('/notifications/pushovercallback', function (req, res) {
    console.info('GOT Pushover callback', req.body);
    if (ctx.pushnotify.pushoverAck(req.body)) {
      res.sendStatus(200);
    } else {
      res.sendStatus(500);
    }
  });

  if (app.enabled('api')) {
    // Create and store new sgv entries
    api.get('/notifications/ack', wares.verifyAuthorization, function (req, res, next) {
      var level = req.query.level;
      var time = req.query.time;
      console.info('got api ack, level: ', level, ', time: ', time);
      ctx.notifications.ack(level, time, true);
      next( );
    });
  }

  return api;
}
module.exports = configure;
