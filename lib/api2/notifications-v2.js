'use strict';

var consts = require('../constants');

var errorMessage = require('./loop-notification-errors');
var { clientIPFor } = require('../server/client-ip');

function configure (app, ctx, env) {
  var express = require('express')
    , api = express.Router( )
    , getRemoteIP = clientIPFor(env)
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
      // The sender's address as TRUST_PROXY resolves it, like every other
      // client address; Loop records it on remote overrides.
      ctx.loop.sendNotification(req.body, getRemoteIP(req), complete);
    } catch (error) {
      fail(error);
    }
  });

  return api;
}
module.exports = configure;
