'use strict';

var azure = require('azure-sb');
var notificationHubService = azure.createNotificationHubService('Push-Notification-Hub','Endpoint=sb://nspush.servicebus.windows.net/;SharedAccessKeyName=DefaultFullSharedAccessSignature;SharedAccessKey=VdtFDvldTypVUgroq6JtrbI162upFh7MeWcpSdJu3yE=');

function init (env) {
    var azurepush = { };

    //TODO: Initialize, check environment variables

    azurepush.send = function send(notify, callback) {
        // http://azure.github.io/azure-sdk-for-node/azure-sb/latest/NotificationHubService.html#send
        // send(tags, payload, optionsopt, callback)
        // payload example: {"aps":{"alert":"Node.js test notification"}}
        notificationHubService.apns.send('evaroo.azurewebsites.net', {"aps":{"alert":notify.message}}, callback);
    };

    //TODO: Handle when it's not setup
    return azurepush;
}

module.exports = init;