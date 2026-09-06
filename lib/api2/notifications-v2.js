'use strict';

var consts = require('../constants');

var errorMessage = require('./loop-notification-errors');

function configure (app, ctx) {
  var express = require('express')
    , api = express.Router( )
    ;

  api.use(ctx.wares.compression());
  api.use(ctx.wares.rawParser);
  api.use(ctx.wares.bodyParser.json({
      limit: '50Mb'
  }));
  api.use(ctx.wares.urlencodedParser);
  
  api.post('/loop', ctx.authorization.isPermitted('notifications:loop:push'), function (req, res) {
    function fail (error) {
      console.log("error sending notification to Loop: ", error);
      res.status(consts.HTTP_INTERNAL_ERROR).send(errorMessage(error));
    }

    function complete (error) {
      if (error) {
        fail(error);
      } else {
        res.sendStatus(consts.HTTP_OK);
      }
    }

    try {
      ctx.loop.sendNotification(req.body, req.connection.remoteAddress, complete);
    } catch (error) {
      fail(error);
    }
  });

  return api;
}
module.exports = configure;
