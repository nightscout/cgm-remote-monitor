'use strict';

// Match complete, known messages emitted by lib/server/loop.js. Public messages
// are fixed text: never echo arbitrary diagnostics, error objects or input values.
var messages = new Map([
  ['Loop notification failed: LOOP_APNS_KEY not set.',
    'Loop notification failed: LOOP_APNS_KEY is not configured. Ask the Nightscout administrator to configure the APNs signing key.'],
  ['Loop notification failed: LOOP_APNS_KEY_ID not set.',
    'Loop notification failed: LOOP_APNS_KEY_ID is not configured. Ask the Nightscout administrator to set the key ID for the APNs signing key.'],
  ['Loop notification failed: LOOP_DEVELOPER_TEAM_ID not set.',
    'Loop notification failed: LOOP_DEVELOPER_TEAM_ID is missing or invalid. Ask the Nightscout administrator to set the 10-character Apple developer team ID.'],
  ['Loop notification failed: Could not find loopSettings in profile.',
    'Loop notification failed: the uploaded profile has no Loop settings. Check that Loop is uploading its profile to Nightscout.'],
  ['Loop notification failed: Could not find deviceToken in loopSettings.',
    'Loop notification failed: the uploaded Loop profile is missing its device token. Check the Nightscout connection and profile upload in Loop.'],
  ['Loop notification failed: Could not find bundleIdentifier in loopSettings.',
    'Loop notification failed: the uploaded Loop profile is missing its app identifier (bundleIdentifier). Check the Nightscout connection and profile upload in Loop.'],
  ['Loop remote carbs failed. Incorrect carbs entry: ',
    'Loop remote carbs failed: invalid carbs entry. The carbohydrate amount must be a number greater than zero.'],
  ['Loop remote bolus failed. Incorrect bolus entry: ',
    'Loop remote bolus failed: invalid bolus entry. The bolus amount must be a number greater than zero.'],
  ['Loop notification failed: Unhandled event type:',
    'Loop notification failed: unsupported command. Check that the client is sending a supported Loop remote command.'],
  ['APNs delivery failed: Unknown reason',
    'Failed to send notification: APNs did not provide a failure reason. Ask the Nightscout administrator to check the server logs for details.'],
  ['APNs delivery failed: No failure details available.',
    'Failed to send notification: APNs did not provide failure details. Ask the Nightscout administrator to check the server logs for details.']
]);

var checkRequest = ' Ask the Nightscout administrator to check the notification request in the server logs.';
var checkCredentials = ' Ask the Nightscout administrator to check the APNs signing key, key ID, and developer team ID.';
var checkEnvironment = ' Ask the Nightscout administrator to check that the APNs environment matches the Loop app build.';
var checkProfile = ' Check the Nightscout connection and profile upload in Loop.';
var checkService = ' Ask the Nightscout administrator to check APNs service status and the server logs.';

// https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns
// Include BadProviderToken as a compatibility label alongside InvalidProviderToken.
var apnsReasons = [
  ['BadCollapseId', 'The notification collapse identifier is too long.' + checkRequest],
  ['BadDeviceToken', 'The device token is invalid or does not match the APNs environment.' + checkEnvironment],
  ['BadExpirationDate', 'The notification expiry time is invalid.' + checkRequest],
  ['BadMessageId', 'The notification identifier is invalid.' + checkRequest],
  ['BadPriority', 'The notification priority is invalid.' + checkRequest],
  ['BadTopic', 'The app identifier in the notification is invalid.' + checkProfile],
  ['DeviceTokenNotForTopic', 'The device token does not match the Loop app identifier.' + checkProfile],
  ['DuplicateHeaders', 'The notification request contains duplicate headers.' + checkRequest],
  ['IdleTimeout', 'The APNs connection timed out.' + checkService],
  ['InvalidPushType', 'The notification push type is invalid.' + checkRequest],
  ['MissingDeviceToken', 'The notification request has no device token.' + checkProfile],
  ['MissingTopic', 'The notification request has no app identifier.' + checkProfile],
  ['PayloadEmpty', 'The notification payload is empty.' + checkRequest],
  ['TopicDisallowed', 'The APNs credentials do not allow notifications for this app identifier.' + checkCredentials],
  ['BadCertificate', 'The APNs certificate is invalid. Ask the Nightscout administrator to check the APNs certificate.'],
  ['BadCertificateEnvironment', 'The APNs certificate does not match the environment.' + checkEnvironment],
  ['BadProviderToken', 'APNs rejected the provider authentication token.' + checkCredentials],
  ['ExpiredProviderToken', 'The APNs provider authentication token has expired. Ask the Nightscout administrator to check the server clock and APNs authentication.'],
  ['Forbidden', 'APNs refused this notification request.' + checkCredentials],
  ['InvalidProviderToken', 'APNs rejected the provider authentication token.' + checkCredentials],
  ['MissingProviderToken', 'The notification request has no provider authentication token.' + checkCredentials],
  ['UnrelatedKeyIdInToken', 'The APNs connection is using an unrelated signing key ID.' + checkCredentials],
  ['BadEnvironmentKeyIdInToken', 'The APNs signing key ID does not match the environment.' + checkEnvironment],
  ['BadPath', 'The notification request path is invalid.' + checkRequest],
  ['MethodNotAllowed', 'The notification request uses an unsupported HTTP method.' + checkRequest],
  ['ExpiredToken', 'The Loop device token has expired.' + checkProfile],
  ['Unregistered', 'The Loop device token is no longer registered for this app.' + checkProfile],
  ['PayloadTooLarge', 'The notification is too large. Shorten the notes or override name.'],
  ['TooManyProviderTokenUpdates', 'The server is updating its APNs authentication token too often. Ask the Nightscout administrator to check APNs authentication.'],
  ['TooManyRequests', 'APNs is limiting notifications to this device because too many requests were sent. Wait for the rate limit to clear.'],
  ['InternalServerError', 'APNs encountered an internal error.' + checkService],
  ['ServiceUnavailable', 'APNs is temporarily unavailable.' + checkService],
  ['Shutdown', 'The APNs server is shutting down.' + checkService]
];

apnsReasons.forEach(function (entry) {
  messages.set('APNs delivery failed: ' + entry[0],
    'Failed to send notification (APNs: ' + entry[0] + '). ' + entry[1]);
});

module.exports = function loopNotificationErrorMessage (error) {
  return messages.get(error) ||
    'Loop notification failed unexpectedly. Ask the Nightscout administrator to check the server logs for details.';
};
