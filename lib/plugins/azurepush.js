'use strict';

var azure = require('azure-sb');
var crypto = require('crypto');
var levels = require('../levels');
var ObjectID = require('mongodb').ObjectID;

function init (env, ctx) {
  var azurepush = { };

  var notificationHubService = setupAzurePush(env);

  azurepush.send = function send(notify, callback) {
    //Set app specific sound for alerts, otherwise use generic notification sound (nothing in the sound attribute)
    var sound = '';
    if (notify.level == levels.URGENT)
    {
      sound = 'alarm2.mp3';
    }
    else if (notify.level == levels.WARN)
    {
      sound = 'alarm.mp3';
    }

    // TODO: We should generalize this across push platforms, pushover does the same thing
    // TODO: Send a more meaningful category
    var payload = {
      eventName: notify.eventName
      , group: notify.group
      , key: notify.key
      , level: notify.level
      , message: notify.message
      , sound: sound
      , title: notify.title 
      , category: "event"
    }

    // Set tag based on level of the notification
    var tag, tagType = '-';
    if (notify.isAnnouncement) {
      tagType = tagType + 'announcement';
    } else if (levels.isAlarm(notify.level)) {
      tagType = tagType + 'alert';
    } else {
      tagType = tagType + 'info';
    }

    tag = env.settings.azureTag + tagType;

    // Send template notification, registration maps to platform specific notification
    // http://azure.github.io/azure-sdk-for-node/azure-sb/latest/NotificationHubService.html#send
    // send(tags, payload, [optionsopt], callback)
    notificationHubService.send(tag, payload, callback);
  };

  azurepush.unregister = function unregister(request, callback) {
    if (request && request.installationId) {
      ctx.store.collection(env.azurepush_collection).find({_id: request.installationId}).toArray(function findAzurepush(err, docs) {
        if (docs.length > 0) {
          ctx.store.collection(env.azurepush_collection).remove({_id: request.installationId}, function removeAzurepush(err, doc) {
            // TODO: Handle error
            console.log(err, doc);
          });
        }
      });
      notificationHubService.deleteInstallation(request.installationId, function (error, response) {
        callback(error);
      });
    }
    else {
      //No installationId, required parameter
      return callback({message: 'InstallationId required'});
    }
  };

  azurepush.register = function register(request, callback) {
    if (request && request.platform) {
      if (!request.installationId) {
        // New registration, use deviceToken
        request.installationId = request.deviceToken;
      }

      var tags = [];
      for (var key in request.settings) {
        if (request.settings[key]) {
          tags.push(env.settings.azureTag + '-' + key);
        }
      }

      // Store notification registration information to state
      // We'll use this when sending notifications to only send tags we need to send.
      // At least one device must be registered to a notification type to send to Azure, all others will be skipped
      var entry = {
        _id: request.installationId
        , settings: request.settings
      }

      ctx.store.collection(env.azurepush_collection).find({_id: entry._id}).toArray(function findAzurepush(err, docs) {
        // _id is unique, only ever one
        if (docs.length > 0) {
          ctx.store.collection(env.azurepush_collection).update({_id: entry._id}, {$set: {settings: entry.settings}}, function updateAzurepush(err, doc) {
            // TODO: Handle error
            console.log(err, doc);
          });
        } else {
          ctx.store.collection(env.azurepush_collection).insert(entry, function storeAzurepush(err, doc) {
            // TODO: Handle error
            console.log(err, doc);
          });
        }
      });
      
      // More info on request body: https://msdn.microsoft.com/en-us/library/mt621153.aspx
      var installation = {
        installationId: request.installationId
        , pushChannel: request.deviceToken
        , templates: {
          nightscout: {
            tags: tags
          }
        }
      };

      // 'platform': https://developer.xamarin.com/guides/xamarin-forms/platform-features/device/#Device.OS
      switch (request.platform) {
        case 'iOS':
          installation.platform = 'apns';
          installation.templates.nightscout.body = "{\"aps\":{\"alert\":\"$(message)\",\"sound\":\"$(sound)\",\"category\":\"$(category)\"},\"eventName\":\"$(eventName)\",\"group\":\"$(group)\",\"key\":\"$(key)\",\"level\":\"$(level)\",\"title\":\"$(title)\"}";
          break;
        case 'Android':
          installation.platform = 'gcm';
          installation.templates.nightscout.body = "{\"data\":{\"message\":\"$(message)\",\"eventName\":\"$(eventName)\",\"group\":\"$(group)\",\"key\":\"$(key)\",\"level\":\"$(level)\",\"sound\":\"$(sound)\",\"title\":\"$(title)\"}}";
          break;
        case 'WinPhone': //Not yet supported
        case 'Windows': //Not yet supported
        default: //No platform specified, or invalid platform
          return callback({message: 'Platform not supported'});
      }

      notificationHubService.createOrUpdateInstallation(installation, function (error, response) {
        callback(error, {installationId: installation.installationId});
      });
    }
    else {
      // No platform, required parameter
      return callback({message: 'Platform required'});
    }
  };

  if (notificationHubService) {
    return azurepush;
  }
  else {
    return null;
  }
}

function setupAzurePush (env) {
  if (env.settings.isEnabled('azurepush')) {
    //TODO: Allow override
    //env.extendedSettings.azurepush.hubName, env.extendedSettings.azurepush.connectionString
    var notificationHubService = azure.createNotificationHubService('Push-Notification-Hub','Endpoint=sb://nspush.servicebus.windows.net/;SharedAccessKeyName=DefaultFullSharedAccessSignature;SharedAccessKey=VdtFDvldTypVUgroq6JtrbI162upFh7MeWcpSdJu3yE=');
    
    //Hash the baseURL for the tag
    var tag = env.settings.baseURL;
    var shasum = crypto.createHash('sha1');
    shasum.update(tag);
    env.settings.azureTag = shasum.digest('hex');
    
    return notificationHubService;
  }
  else {
    return null;
  }
}

module.exports = init;