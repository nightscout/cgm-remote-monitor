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

    if (data.eventType != 'Temporary Override') {
      completion("Loop notification failed: Unhandled event type:", data.eventType);
      return;
    }

    // {"aps":{"timestamp": "2019-09-17T22:55:50Z", "alert":"🏃Recess Override Enacted","content-available": 1,"override-name":"Recess", "override-duration-minutes": 120.0}}


    let notification = new apn.Notification();
    notification.alert = data.reasonDisplay + " Temporary Override";
    notification.topic = loopSettings.bundleIdentifier;
    notification.contentAvailable = 1;
    notification.expiry =  Math.round((Date.now() + 60 * 5) / 1000); // Allow this to enact within 5 minutes.
    notification.payload = {
      "override-name": data.reason,
    };

    if (data.duration && parseInt(data.duration) > 0) {
      notification.payload["override-duration-minutes"] = parseInt(data.duration);
    }

    provider.send(notification, [loopSettings.deviceToken]).then( (response) => {
      if (response.sent && response.sent.length > 0) {
        completionHandler();
      } else {
        console.log("APNs delivery failed:", response.failed)
        completionHandler("APNs delivery failed:" + response.failed);
      }
    });
  };

  return loop();
}

module.exports = init;
