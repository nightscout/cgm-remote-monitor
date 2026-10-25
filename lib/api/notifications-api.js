'use strict';

var consts = require('../constants');
var bodyParser = require('body-parser');

function configure (app, wares, ctx) {
  var express = require('express')
    , api = express.Router( )
    ;

  app.use(bodyParser.urlencoded({extended : true}));
  app.use(bodyParser.json());

  api.post('/notifications/pushovercallback', function (req, res) {
    if (ctx.pushnotify.pushoverAck(req.body)) {
      res.sendStatus(consts.HTTP_OK);
    } else {
      res.sendStatus(consts.HTTP_INTERNAL_ERROR);
    }
  });

  if (app.enabled('api')) {
    // Create and store new sgv entries
    api.get('/notifications/ack', ctx.authorization.isPermitted('notifications:*:ack'), function (req, res) {
      var level = Number(req.query.level);
      var group = req.query.group || 'default';
      var time = req.query.time && Number(req.query.time);
      console.info('got api ack, level: ', level, ', time: ', time, ', query: ', req.query);
      ctx.notifications.ack(level, group, time, true);
      res.sendStatus(consts.HTTP_OK);
    });
  }

  return api;
}
module.exports = configure;
