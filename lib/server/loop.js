'use strict';

const apn = require('apn');

function init (env, ctx) {

  function loop () {
    return loop;
  }

  loop.sendNotification = function sendNotification (data, remoteAddress, completion) {
    if (env.extendedSettings.loop.apnsKey === undefined || env.extendedSettings.loop.apnsKey.length == 0) {
      completion("Loop notification failed: LOOP_APNS_KEY not set.");
      return;
    }

    if (env.extendedSettings.loop.apnsKeyId === undefined || env.extendedSettings.loop.apnsKeyId.length == 0) {
      completion("Loop notification failed: LOOP_APNS_KEY_ID not set.");
      return;
    }

    if (env.extendedSettings.loop.developerTeamId === undefined || env.extendedSettings.loop.developerTeamId.length != 10) {
      completion("Loop notification failed: LOOP_DEVELOPER_TEAM_ID not set.");
      return;
    }

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

    var payload = {'remote-address': remoteAddress};
    var alert;
    if (data.eventType === 'Temporary Override Cancel') {
      payload["cancel-temporary-override"] = "true";
      alert = "Cancel Temporary Override";
    } else if (data.eventType === 'Temporary Override') {
      payload["override-name"] = data.reason;
      alert = data.reasonDisplay + " Temporary Override";
    } else {
      completion("Loop notification failed: Unhandled event type:", data.eventType);
      return;
    }

    let notification = new apn.Notification();
    notification.alert = alert;
    notification.topic = loopSettings.bundleIdentifier;
    notification.contentAvailable = 1;
    notification.expiry =  Math.round((Date.now() + 60 * 5) / 1000); // Allow this to enact within 5 minutes.
    notification.payload = payload;

    if (data.duration && parseInt(data.duration) > 0) {
      notification.payload["override-duration-minutes"] = parseInt(data.duration);
    }

    provider.send(notification, [loopSettings.deviceToken]).then( (response) => {
      if (response.sent && response.sent.length > 0) {
        completion();
      } else {
        console.log("APNs delivery failed:", response.failed)
        completion("APNs delivery failed: " + response.failed[0].response.reason);
      }
    });
  };

  return loop();
}

module.exports = init;
