'use strict';

const _ = require('lodash');
const apn = require('apn');

function init (env, ctx) {

  function loop () {
    return loop;
  }

  loop.sendNotification = function sendNotification (data, completionHandler) {
    console.info('loop notify: ', data);
    console.info('data.eventType: ', data.eventType);
    console.info('ctx.ddata.profiles: ', ctx.ddata.profiles);

    var options = {
      token: {
        key: env.extendedSettings.loop.apnsKey
        , keyId: env.extendedSettings.loop.apnsKeyId
        , teamId: env.extendedSettings.loop.developerTeamId
      },
      production: false
    };

    var provider = new apn.Provider(options);

    if (ctx.ddata.profiles === undefined || ctx.ddata.profiles.length < 1 || ctx.ddata.profiles[0].loopSettings === undefined) {
      completion("Loop notification failed: Could not find loopSettings in profile.");
      return;
    }
    
    let loopSettings = ctx.ddata.profiles[0].loopSettings;

    if (loopSettings.deviceToken === undefined) {
      completion("Loop notification failed: Could not find deviceToken in loopSettings.");
      return;
    }

    if (loopSettings.bundleIdentifier === undefined) {
      completion("Loop notification failed: Could not find bundleIdentifier in loopSettings.");
      return;
    }
    //var data = sbx.data;


    let notification = new apn.Notification();
    notification.alert = "Remote Override Test";
    notification.badge = 1;
    notification.topic = loopSettings.bundleIdentifier;

    provider.send(notification, [loopSettings.deviceToken]).then( (response) => {
      if (response.sent && response.sent.length > 0) {
        completionHandler();
      } else {
        completionHandler("APNs delivery failed.");
      }
    });
  };

  return loop();
}

module.exports = init;
