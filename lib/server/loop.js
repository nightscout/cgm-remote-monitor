//'use strict';

const apn = require('apn');

function init (env, ctx) {

  function loop () {
    return loop;
  }

  loop.sendNotification = function sendNotification (data, remoteAddress, completion) {

    // console.info("JAP");
    // console.info(data);

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

    var options = {
      token: {
        key: env.extendedSettings.loop.apnsKey
        , keyId: env.extendedSettings.loop.apnsKeyId
        , teamId: env.extendedSettings.loop.developerTeamId
      },
      production: env.extendedSettings.loop.pushServerEnvironment === "production"
    };

    var provider = new apn.Provider(options);

    var payload = {
      'remote-address': remoteAddress,
      'notes': data.notes,
      'entered-by': data.enteredBy
    };
    var alert;
    if (data.eventType === 'Temporary Override Cancel') {
      payload["cancel-temporary-override"] = "true";
      alert = "Cancel Temporary Override";
    } else if (data.eventType === 'Temporary Override') {
      payload["override-name"] = data.reason;
      if (data.duration !== undefined && parseInt(data.duration) > 0) {
        payload["override-duration-minutes"] = parseInt(data.duration);
      }
      alert = data.reasonDisplay + " Temporary Override";
    } else if (data.eventType === 'Remote Carbs Entry') { 
      payload["carbs-entry"] = parseFloat(data.remoteCarbs);
      if(payload["carbs-entry"] > 0.0 ) { 
         payload["absorption-time"] = 3.0;
         if (data.remoteAbsorption !== undefined && parseFloat(data.remoteAbsorption) > 0.0) {
           payload["absorption-time"] = parseFloat(data.remoteAbsorption);
         }
         if (data.otp !== undefined && data.otp.length > 0) {
            payload["otp"] = ""+data.otp
         }
         alert  = "Remote Carbs Entry: "+payload["carbs-entry"]+" grams\n";
         alert += "Absorption Time: "+payload["absorption-time"]+" hours";
      } else { 
         completion("Loop remote carbs failed. Incorrect carbs entry: ", data.remoteCarbs);
         return;
      }
   
   } else if (data.eventType === 'Remote Bolus Entry') { 
      payload["bolus-entry"] = parseFloat(data.remoteBolus);
      if(payload["bolus-entry"] > 0.0 ) { 
         alert  = "Remote Bolus Entry: "+payload["bolus-entry"]+" U\n";
         if (data.otp !== undefined && data.otp.length > 0) {
            payload["otp"] = ""+data.otp
         }
      } else { 
         completion("Loop remote bolus failed. Incorrect bolus entry: ", data.remoteBolus);
         return;
      }
    } else {
      completion("Loop notification failed: Unhandled event type:", data.eventType);
      return;
    }

    if (data.notes !== undefined && data.notes.length > 0) {
      alert += " - " + data.notes
    }

    if (data.enteredBy !== undefined && data.enteredBy.length > 0) {
      alert += " - " + data.enteredBy
    }

    let notification = new apn.Notification();
    notification.alert = alert;
    notification.topic = loopSettings.bundleIdentifier;
    notification.contentAvailable = 1;
    notification.expiry =  Math.round((Date.now() / 1000)) + 60 * 5; // Allow this to enact within 5 minutes.
    notification.payload = payload;

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
