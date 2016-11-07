'use strict';

var azure = require('azure-sb');

function init (env) {
  var azurepush = { };

  var notificationHubService = setupAzurePush(env);

  azurepush.send = function send(notify, callback) {
    // http://azure.github.io/azure-sdk-for-node/azure-sb/latest/NotificationHubService.html#send
    // send(tags, payload, optionsopt, callback)
    // current payload example: {"aps":{"alert":"Node.js test notification"}}

    //TODO: if (env.settings && env.settings.baseURL) <-- Use BASE_URL as tag
    //TODO: move to cross-platform
    notificationHubService.apns.send('evaroo.azurewebsites.net', {"aps":{"alert":notify.message}}, callback);
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
    return notificationHubService;
  }
  else {
    return null;
  }
}

module.exports = init;