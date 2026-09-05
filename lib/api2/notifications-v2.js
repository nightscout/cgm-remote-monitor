'use strict';

var consts = require('../constants');

// https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns
// Include BadProviderToken as a compatibility label alongside InvalidProviderToken.
// Match the entire message emitted by lib/server/loop.js and return fixed text;
// never reflect arbitrary error messages or serialize error objects to clients.
var apnsErrorMessages = new Map([
  'BadCollapseId',
  'BadDeviceToken',
  'BadExpirationDate',
  'BadMessageId',
  'BadPriority',
  'BadTopic',
  'DeviceTokenNotForTopic',
  'DuplicateHeaders',
  'IdleTimeout',
  'InvalidPushType',
  'MissingDeviceToken',
  'MissingTopic',
  'PayloadEmpty',
  'TopicDisallowed',
  'BadCertificate',
  'BadCertificateEnvironment',
  'BadProviderToken',
  'ExpiredProviderToken',
  'Forbidden',
  'InvalidProviderToken',
  'MissingProviderToken',
  'UnrelatedKeyIdInToken',
  'BadEnvironmentKeyIdInToken',
  'BadPath',
  'MethodNotAllowed',
  'ExpiredToken',
  'Unregistered',
  'PayloadTooLarge',
  'TooManyProviderTokenUpdates',
  'TooManyRequests',
  'InternalServerError',
  'ServiceUnavailable',
  'Shutdown'
].map(function (reason) {
  return ['APNs delivery failed: ' + reason, 'Failed to send notification (APNs: ' + reason + ')'];
}));

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
    ctx.loop.sendNotification(req.body, req.connection.remoteAddress, function (error) {
      if (error) {
        console.log("error sending notification to Loop: ", error);
        res.status(consts.HTTP_INTERNAL_ERROR).send(apnsErrorMessages.get(error) || 'Failed to send notification');
      } else {
        res.sendStatus(consts.HTTP_OK);
      }
    });
  });

  return api;
}
module.exports = configure;
