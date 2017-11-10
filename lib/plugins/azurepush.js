'use strict';

var azure = require('azure-sb');
var crypto = require('crypto');
var levels = require('../levels');
var trello = require('node-trello');
var trelloService = new trello('daaebf0eb5b5e19d9c84398d332c6b7f', 'e976d63638f2ecd2edec6f8fb56a46cb5cf2100b11101f4edf189376892a6415');

function init (env, ctx) {
  var azurepush = { };
  var isConfigured = false;
  azurepush.notificationHubService = null;

  isConfigured = setupAzurePush(env);

  azurepush.send = function send(notify, callback) {
    // Set tag and query based on level of the notification
    var tag, tagType = '-';
    var query;
    if (notify.isAnnouncement) {
      tagType = tagType + 'announcement';
      query = {'settings.announcement': true};
    } else if (levels.isAlarm(notify.level)) {
      tagType = tagType + 'alert';
      query = {'settings.alert': true};
    } else {
      tagType = tagType + 'info';
      query = {'settings.info': true};
    }

    tag = env.settings.azureTag + tagType;

    // See if anyone is actually registered
    ctx.store.collection(env.pushclients_collection).find(query).toArray(function findAnnouncement(err, docs) {
      if (docs.length > 0) {
        // At least one device has registered for this type of notification, actually send
        // Azure handles only sending to the scpeific devices, we just need to send the level-specific notification

        // Set app specific sound for alerts, otherwise use generic notification sound (default in the sound attribute)
        var sound = 'default';
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
          , category: 'event'
        }

        azurepush.notificationHubService.send(tag, payload, function (error, response) {
          // *****REMOVE*****: Beta logging
          if (error) {
            logTrelloIssue(env, '0x01-Failed to deliver notification to Azure');
          }
          // END: *****REMOVE*****

          callback(error, response);
        });
      }
    });
  };

  azurepush.unregister = function unregister(request, callback) {
    if (request && request.installationId) {
      // Remove registration from mongodb, this will ensure we don't call up to Azure if there are no devices registered
      ctx.store.collection(env.pushclients_collection).remove({_id: request.installationId}, function removeAzurepush(err, doc) {
        // *****REMOVE*****: Beta logging
        if (err) {
          logTrelloIssue(env, '0x02-Failed to remove registration from mongodb');
        }
        // END: *****REMOVE*****

        // TODO: Handle error
        console.log(err, doc);
      });

      // Remove installation from Azure, make sure that if we do call up to Azure, this device won't get a notification
      azurepush.notificationHubService.deleteInstallation(request.installationId, function (error, response) {
        // *****REMOVE*****: Beta logging
        if (error) {
          logTrelloIssue(env, '0x03-Failed to delete installation from Azure');
        }
        // END: *****REMOVE*****
        
        callback(error);
      });
    }
    else {
      // *****REMOVE*****: Beta logging
      logTrelloIssue(env, '0x04-Unregister received without installationId');
      // END: *****REMOVE*****

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

      ctx.store.collection(env.pushclients_collection).find({_id: entry._id}).toArray(function findAzurepush(err, docs) {
        // _id is unique, only ever one
        if (docs.length > 0) {
          ctx.store.collection(env.pushclients_collection).update({_id: entry._id}, {$set: {settings: entry.settings}}, function updateAzurepush(err, doc) {
            // *****REMOVE*****: Beta logging
            if (err) {
              logTrelloIssue(env, '0x05-Failed to update existing registration in mongodb');
            }
            // END: *****REMOVE*****

            // TODO: Handle error
            console.log(err, doc);
          });
        } else {
          ctx.store.collection(env.pushclients_collection).insert(entry, function storeAzurepush(err, doc) {
            // *****REMOVE*****: Beta logging
            if (err) {
              logTrelloIssue(env, '0x06-Failed to add new registration in mongodb');
            }
            // END: *****REMOVE*****
            
            // TODO: Handle error
            console.log(err, doc);
          });
        }
      });

      // Verify/create index
      ctx.store.collection(env.pushclients_collection).ensureIndex('settings.announcement', function indexAnnouncement(err, doc) {
        // *****REMOVE*****: Beta logging
        if (err) {
          logTrelloIssue(env, '0x07-Failed to verify index on anncouncement in mongodb');
        }
        // END: *****REMOVE*****
        
        // TODO: Handle error
        console.log(err, doc);
      });
      ctx.store.collection(env.pushclients_collection).ensureIndex('settings.alert', function indexAnnouncement(err, doc) {
        // *****REMOVE*****: Beta logging
        if (err) {
          logTrelloIssue(env, '0x08-Failed to verify index on alert in mongodb');
        }
        // END: *****REMOVE*****
        
        // TODO: Handle error
        console.log(err, doc);
      });
      ctx.store.collection(env.pushclients_collection).ensureIndex('settings.info', function indexAnnouncement(err, doc) {
        // *****REMOVE*****: Beta logging
        if (err) {
          logTrelloIssue(env, '0x09-Failed to verify index on info in mongodb');
        }
        // END: *****REMOVE*****
        
        // TODO: Handle error
        console.log(err, doc);
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
          installation.templates.nightscout.body = '{\"aps\":{\"alert\":{\"body\":\"$(message)\",\"title\":\"$(title)\"},\"sound\":\"$(sound)\",\"category\":\"$(category)\"},\"eventName\":\"$(eventName)\",\"group\":\"$(group)\",\"key\":\"$(key)\",\"level\":\"$(level)\"}';
          break;
        case 'Android':
          installation.platform = 'gcm';
          installation.templates.nightscout.body = '{\"data\":{\"message\":\"$(message)\",\"eventName\":\"$(eventName)\",\"group\":\"$(group)\",\"key\":\"$(key)\",\"level\":\"$(level)\",\"sound\":\"$(sound)\",\"title\":\"$(title)\"}}';
          break;
        case 'WinPhone': //Not yet supported
        case 'Windows': //Not yet supported
        default: //No platform specified, or invalid platform
          // *****REMOVE*****: Beta logging
          logTrelloIssue(env, '0x10-Register received without supported platform');
          // END: *****REMOVE*****

          return callback({message: 'Platform not supported'});
      }

      azurepush.notificationHubService.createOrUpdateInstallation(installation, function (error, response) {
        // *****REMOVE*****: Beta logging
        if (error) {
          logTrelloIssue(env, '0x11-Failed to create or update installation');
        }
        // END: *****REMOVE*****

        callback(error, {installationId: installation.installationId});
      });
    }
    else {
      // *****REMOVE*****: Beta logging
      logTrelloIssue(env, '0x12-Register received without platform');
      // END: *****REMOVE*****

      // No platform, required parameter
      return callback({message: 'Platform required'});
    }
  };

  azurepush.ack = function ack(request, callback) {
    if (request && request.level) {
      var response = {};
      response.level = Number(request.level);
      response.group = request.group || 'default';
      response.time = request.time && Number(request.time);

      //Convert minutes to milliseconds
      if (response.time) {
        response.time = response.time * 60 * 1000;
      }

      ctx.notifications.ack(response.level, response.group, response.time, true);

      callback(null, response);
    }
    else {
      // *****REMOVE*****: Beta logging
      logTrelloIssue(env, '0x13-Ack received without level');
      // END: *****REMOVE*****

      //No level, required parameter
      callback({message: 'Level required'});
    }
  };

  azurepush.createService = function createService(sak) {
    if (!azurepush.notificationHubService) {
      // If the access key is being provided, go ahead and create the service and store it
      if (sak) {
        azurepush.notificationHubService = azure.createNotificationHubService('Push-Notification-Hub', sak);
        ctx.store.collection(env.pushclients_collection).insert({_id: '-1', sak: sak}, function updateSak(err, doc) {
            // *****REMOVE*****: Beta logging
            if (err) {
              logTrelloIssue(env, '0x05-Failed to update shared access key in mongodb');
            }
            // END: *****REMOVE*****

            // TODO: Handle error
            console.log(err, doc);
          });
        return true;
      }
      // Otherwise, check mongo
      else {
        ctx.store.collection(env.pushclients_collection).find({_id: '-1'}).toArray(function findSak(err, docs) {
          // _id is unique, only ever one
          if (docs.length > 0) {
            if (docs[0].sak) {
              azurepush.notificationHubService = azure.createNotificationHubService('Push-Notification-Hub', docs[0].sak);
            }
          }
          else {
            return false;
          }
        });
      }
    }
  }

  if (isConfigured) {
    azurepush.createService(null);
    return azurepush;
  }
  else {
    return null;
  }
}

function setupAzurePush (env) {
  if (env.settings.isEnabled('azurepush')) {
    if (env.settings.baseURL) {      
      //Hash the baseURL for the tag
      var tag = env.settings.baseURL;
      var shasum = crypto.createHash('sha1');
      shasum.update(tag);
      env.settings.azureTag = shasum.digest('hex');
      
      return true;
    } else {
      // No baseURL, cannot create azureTag
      // *****REMOVE*****: Beta logging
      logTrelloIssue(env, '0x14-Azure enabled but no BASE_URL');
      // END: *****REMOVE*****

      console.error('Azure push notifications enabled but no BASE_URL set, notifications will not be sent');
      return null;
    }
  } else {
    return null;
  }
}

function logTrelloIssue (env, message) {
  var trace = {};
  Error.captureStackTrace(trace);
  
  var card = {
    name: env.settings.baseURL + ': ' + message
    , desc: trace.stack
    , idList: '58539ab3416027457b1238c0'
  };
  
  trelloService.post('/1/cards', card, function trelloCallback(err, data) {
    if (err) {
      console.error('Trello card creation failed: ', err);
    }
    else {
      console.info('Logged Trello issue: ', data);
    }
  });
}

module.exports = init;