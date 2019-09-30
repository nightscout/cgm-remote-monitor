'use strict';

function configure (app, ctx) {
  var express = require('express')
    , api = express.Router( )
    ;

  api.post('/loop', ctx.authorization.isPermitted('notifications:loop:push'), function (req, res) {
    console.log("req = ", req);
    console.log("req.connection.remoteAddress = ", req.connection.remoteAddress);
    console.log("req.body = ", req.body);
    ctx.loop.sendNotification(req.body, req.connection.remoteAddress, function (error) {
      if (error) {
        res.sendStatus(500);
        console.log("error sending notification to Loop: ", error);
      } else {
        res.sendStatus(200);
      }
    });
  });

  return api;
}
module.exports = configure;
