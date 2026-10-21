'use strict';

const apn = require('@parse/node-apn');

/**
 * Sends a glucose alarm to the AAPS iOS follower clients as an APNs background push.
 *
 * The push carries no alarm text and no glucose value. It holds only `content-available: 1`
 * and a `pushId`. The app wakes, reads Nightscout over its own authenticated connection,
 * decides locally, and raises its own local notification. Nothing the app shows a user ever
 * comes out of the payload, so a forged push cannot state a glucose value.
 *
 * Credentials come from the environment. Per-device registration (token, bundle id,
 * environment) comes from the `settings` collection, written by each client.
 */
function init (env, ctx) {

  function apnspush () {
    return apnspush;
  }

  // Read straight from process.env, NOT from env.extendedSettings.
  //
  // findExtendedSettings() in lib/server/env.js only exposes a variable when its prefix
  // matches an entry in env.settings.enable, the enabled-plugin list. lib/server/loop.js can
  // use env.extendedSettings.loop.* because `loop` is a real plugin in lib/plugins. This
  // transport is deliberately NOT a plugin - it is a transport under pushnotify, like Pushover
  // and Maker - so `aaps` is never in that list and the variables would silently read as
  // undefined. That failure would look exactly like a missing key.
  //
  // It also sidesteps a second trap: findExtendedSettings coerces any value that passes
  // !isNaN() to a Number, which would mangle an all-digit team id or key id.
  const config = {
    key: process.env.AAPS_APNS_KEY            // path to the .p8, or its contents
    , keyId: process.env.AAPS_APNS_KEY_ID
    , teamId: process.env.AAPS_DEVELOPER_TEAM_ID
  };

  /**
   * Smallest gap between two background pushes to one device, for one alarm group and level.
   *
   * Apple: "don't try to send more than two or three per hour" for background notifications.
   * Nightscout's own dispatcher cannot honour that. lib/notifications.js emitNotification
   * re-emits an unacked alarm on every data-load cycle - it gates only on
   * lastUpdated > lastAckTime + silenceTime and never reads alarm.lastEmitTime - and the only
   * brake underneath it is recentlySent.set(key, notify, 30) in pushnotify.js. Measured on
   * 2026-10-08 that is about 111 sends an hour, roughly 40x over Apple's figure.
   *
   * So this transport keeps its own ledger and ignores the dispatcher's spacing entirely.
   */
  const MIN_PUSH_INTERVAL_MS = 20 * 60 * 1000;

  /** Guards against an unbounded ledger on a long-running server. */
  const LEDGER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

  const providers = {};     // "teamId|keyId|production" -> apn.Provider
  const lastPushAt = {};    // "deviceToken|group|level"  -> epoch ms
  let suppressed = 0;

  function configured () {
    return Boolean(config.key && config.keyId && config.teamId);
  }

  /**
   * One long-lived provider per (team, key, environment).
   *
   * node-apn takes a boolean `production`, not a host - see lib/server/loop.js. Creating a
   * provider per send would open a new HTTP/2 connection each time.
   */
  function providerFor (production) {
    const cacheKey = config.teamId + '|' + config.keyId + '|' + String(production);
    if (!providers[cacheKey]) {
      providers[cacheKey] = new apn.Provider({
        token: { key: config.key, keyId: config.keyId, teamId: config.teamId }
        , production: production
      });
    }
    return providers[cacheKey];
  }

  /**
   * Live registrations, read straight from Mongo and read-only.
   *
   * Read-only because a direct write here would bypass srvModified/modifiedBy, the
   * immutable-field validation, autoPrune, the storage-socket-update broadcast and
   * getLastModified. The ack path goes through api3 for exactly those reasons.
   *
   * markAsDeleted only sets isValid: false, so soft-deleted documents must be filtered here;
   * normalizeDoc is called only from the api3 find path, so _id is still present.
   */
  function registrations (completion) {
    const name = env.settings_collection || 'settings';
    let col;
    try {
      col = ctx.store.collection(name);
    } catch (err) {
      console.error('apnspush: cannot open the ' + name + ' collection', err);
      return completion([]);
    }
    // The pinned mongodb driver is ^5.9.2, which REMOVED callback support - find().toArray(cb)
    // returns a promise and never invokes cb, so a callback style here hangs silently and the
    // alarm is simply never sent. Promises only.
    col.find({ type: 'aapsPushRegistration', isValid: { $ne: false } }).toArray()
      .then(function found (docs) {
        completion((docs || []).filter(usable));
      })
      .catch(function failed (err) {
        console.error('apnspush: failed to read registrations', err);
        completion([]);
      });
  }

  function usable (doc) {
    if (!doc || !doc.deviceToken || !doc.bundleIdentifier) {
      // A half-written document is a client bug, not a transport error. Say which one.
      console.warn('apnspush: skipping registration without a token or bundle id, identifier='
        + (doc && doc.identifier));
      return false;
    }
    return true;
  }

  /** Apple's own wording: "Always use priority 5. Using priority 10 is an error." */
  function stage1Notification (doc, pushId) {
    const n = new apn.Notification();
    // Both of these MUST be set explicitly. Notification.prototype.headers() in
    // @parse/node-apn 5.2.3 emits apns-priority only when priority !== 10, and the constructor
    // default IS 10 - so leaving it alone sends no priority header at all and APNs treats the
    // push as priority 10, which is wrong for a background push. apns-push-type has no default
    // and is omitted entirely unless pushType is set.
    n.pushType = 'background';
    n.priority = 5;
    n.topic = doc.bundleIdentifier;
    n.contentAvailable = 1;
    // Correlation only. The app must never render anything from this payload.
    n.payload = { pushId: pushId };
    // Apple holds only the newest background notification per app, so an old one is useless.
    n.expiry = Math.floor(Date.now() / 1000) + 300;
    return n;
  }

  function budgetKey (doc, notify) {
    return doc.deviceToken + '|' + (notify.group || 'default') + '|' + String(notify.level);
  }

  function withinBudget (key, now) {
    const previous = lastPushAt[key];
    return !previous || (now - previous) >= MIN_PUSH_INTERVAL_MS;
  }

  function pruneLedger (now) {
    Object.keys(lastPushAt).forEach(function eachKey (key) {
      if (now - lastPushAt[key] > LEDGER_MAX_AGE_MS) { delete lastPushAt[key]; }
    });
  }

  /**
   * Explains the three APNs reasons that look alike and are otherwise misdiagnosed.
   */
  function hintFor (reason) {
    switch (reason) {
      case 'TopicDisallowed':
        return 'the key may not push to that topic at all - most likely Push Notifications is not enabled on that App ID';
      case 'BadDeviceToken':
        return 'the token does not match the environment - a sandbox token sent to production, or the reverse';
      case 'DeviceTokenNotForTopic':
        return 'the token belongs to a different app than the bundle id being pushed';
      case 'Unregistered':
        return 'the app was removed from that device; the registration should be dropped';
      case 'InvalidProviderToken':
        return 'the signing key is wrong - check that AAPS_APNS_KEY is the APNs key and not the App Store Connect API key';
      default:
        return null;
    }
  }

  /** These never succeed on retry, so retrying only burns the device's budget. */
  const FINAL_REASONS = [
    'BadDeviceToken', 'DeviceTokenNotForTopic', 'TopicDisallowed', 'Forbidden'
    , 'ExpiredToken', 'Unregistered', 'PayloadTooLarge'
  ];

  function reportFailure (doc, failure) {
    // Check `error` BEFORE `status`. node-apn resolves { device, error } with no status on a
    // transport failure, and assigns the string sentinels '(timeout)', '(aborted)' and
    // '(error)' to the same place a numeric HTTP/2 :status would go.
    if (failure.error) {
      console.error('apnspush: transport failure for ' + doc.identifier + ': ' + failure.error);
      return;
    }
    const reason = failure.response && failure.response.reason;
    const hint = hintFor(reason);
    console.error('apnspush: APNs rejected ' + doc.identifier + ' status=' + failure.status
      + ' reason=' + reason + (hint ? ' (' + hint + ')' : ''));

    if (reason === 'Unregistered' || FINAL_REASONS.indexOf(reason) > -1) {
      // adminnotifies dedupes by message and keeps a count. It is a no-op unless
      // ctx.settings.adminNotifiesEnabled, which is the operator's choice.
      if (ctx.adminnotifies) {
        ctx.adminnotifies.addNotify({
          title: 'iOS push failed'
          , message: 'A registered iOS client could not be reached (' + reason + '). '
            + 'Alarms are not being delivered to it.'
          , persistent: false
        });
      }
    }
  }

  /**
   * Sends one alarm to every registered client that is inside its budget.
   *
   * Called from pushnotify.emitNotification. ctx.notifications and api3 are both constructed
   * later than this module, so nothing from either may be captured at construction time.
   */
  apnspush.sendAlarm = function sendAlarm (notify, completion) {
    const done = completion || function noop () {};

    if (!configured()) {
      // Deliberately not silent, and deliberately not fatal: the module still exists so it can
      // report its own misconfiguration rather than vanishing the way a plugin would.
      console.error('apnspush: not configured - set AAPS_APNS_KEY, AAPS_APNS_KEY_ID and '
        + 'AAPS_DEVELOPER_TEAM_ID. No iOS alarm was sent.');
      return done(0);
    }

    registrations(function withRegistrations (docs) {
      if (!docs.length) {
        // Not silent on purpose. A feature that is present but quietly dead is the failure
        // mode this whole design is meant to avoid: the user believes alarms are armed.
        console.info('apnspush: no iOS client is registered, so no alarm was pushed');
        return done(0);
      }

      const now = Date.now();
      pruneLedger(now);

      let sent = 0;
      let outstanding = docs.length;
      function oneDone () {
        outstanding -= 1;
        if (outstanding === 0) { done(sent); }
      }

      docs.forEach(function eachDoc (doc) {
        const key = budgetKey(doc, notify);
        if (!withinBudget(key, now)) {
          suppressed += 1;
          console.info('apnspush: suppressed by budget for ' + doc.identifier
            + ' (level=' + notify.level + ', group=' + (notify.group || 'default')
            + '), total suppressed=' + suppressed);
          return oneDone();
        }

        const production = doc.apnsEnvironment === 'production';
        const pushId = doc.identifier + '-' + now;
        const note = stage1Notification(doc, pushId);

        console.info('apnspush: offering pushId=' + pushId + ' to ' + doc.identifier
          + ' topic=' + doc.bundleIdentifier
          + ' host=' + (production ? 'api.push.apple.com' : 'api.sandbox.push.apple.com')
          + ' (from apnsEnvironment=' + doc.apnsEnvironment + ')');

        providerFor(production).send(note, [doc.deviceToken]).then(function responded (response) {
          if (response.sent && response.sent.length) {
            // ACCEPTED, not delivered. Measured 2026-10-08: APNs returned 200 for a push that
            // the phone never received, because the device's background budget was spent. The
            // only evidence of real delivery is the client's ack. Never report this as an
            // alarm the user got.
            lastPushAt[key] = now;
            sent += 1;
          }
          (response.failed || []).forEach(function eachFailure (failure) {
            reportFailure(doc, failure);
          });
          oneDone();
        }, function rejected (err) {
          console.error('apnspush: send threw for ' + doc.identifier, err);
          oneDone();
        });
      });
    });
  };

  /** Test and diagnostic surface. */
  apnspush.isConfigured = configured;
  apnspush.suppressedCount = function suppressedCount () { return suppressed; };

  // Subscribed here rather than in bootevent setupListeners: per-module subscription is the
  // dominant pattern (alarmSocket, storageSocket and adminnotifies all do their own).
  // `teardown` is a real event, emitted by stream.teardown().
  ctx.bus.on('teardown', function shutdown () {
    Object.keys(providers).forEach(function eachProvider (cacheKey) {
      providers[cacheKey].shutdown();
      delete providers[cacheKey];
    });
  });

  return apnspush;
}

module.exports = init;
