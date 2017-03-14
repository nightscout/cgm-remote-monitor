'use strict';

function configure (app, wares, ctx) {
  var express = require('express')
    , api = express.Router( );

  api.post('/notifications/pushovercallback', function (req, res) {
    if (ctx.pushnotify.pushoverAck(req.body)) {
      res.sendStatus(200);
    } else {
      res.sendStatus(500);
    }
  });

  if (app.enabled('api')) {
    //Acknowledge notifications
    api.get('/notifications/ack', ctx.authorization.isPermitted('notifications:*:ack'), function (req, res) {
      var level = Number(req.query.level);
      var group = req.query.group || 'default';
      var time = req.query.time && Number(req.query.time);
      console.info('got api ack, level: ', level, ', time: ', time, ', query: ', req.query);
      ctx.notifications.ack(level, group, time, true);
      res.sendStatus(200);
    });
  }

  if(app.enabled('azurepush') && ctx.azurepush) {
    // Register device with Azure Notification Hub
    api.post('/notifications/azure/register', function (req, res) {
      if (!ctx.azurepush.notificationHubService){
        if(!ctx.azurepush.createService(req.body.sharedAccessKey)) {
          console.error('Unable to register for Azure push notifications');
          res.sendStatus(500);
        }
      }
      ctx.azurepush.register(req.body, function registerCallback(error, response) {
        if (error) {
          console.error('Unable to register for Azure push notifications', error);
          res.sendStatus(500);
        } else {
          console.info('Registered for Azure push notifications');
          res.json(response);
        }
      });
    });

    // Unregister device with Azure Notification Hub
    api.post('/notifications/azure/unregister', function (req, res) {
      ctx.azurepush.unregister(req.body, function unregisterCallback(error) {
        if (error) {
          console.error('Unable to unregister for Azure push notifications', error);
          res.sendStatus(500);
        } else {
          console.info('Unregistered for Azure push notifications');
          res.sendStatus(200);
        }
      });
    });

    // Acknowledge notifications
    api.post('/notifications/azure/ack', function (req, res) {
      ctx.azurepush.ack(req.body, function ackCallback(error, response) {
        if (error) {
          console.error('Unable to Ack Azure push notification', error);
          res.sendStatus(500);
        } else {
          console.info('Ack Azure push notification, level: ', response.level, ', group: ', response.group, ', time: ', response.time);
          res.sendStatus(200);
        }
      });
    });
  }

  return api;
}
module.exports = configure;
