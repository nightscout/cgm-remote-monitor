'use strict';

const crypto = require('node:crypto');
const { compileTrust } = require('../server/client-ip');

// How long an expired entry is kept before the sweep drops it.
const FAIL_AGE = 60000;
const SWEEP_INTERVAL = 30000;

// The list is in memory and is fed by unauthenticated callers, so each
// namespace is bounded. The namespaces are bounded separately on purpose:
// credential keys are the ones an attacker can mint at will, and evicting them
// must never be able to push an address key -- the entry that is actually
// throttling that attacker -- out of the list.
const MAX_ADDRESS_ENTRIES = 10000;
const MAX_CREDENTIAL_ENTRIES = 10000;

// Entries are keyed by a digest under a per-process salt. The list outlives any
// single request, and a map whose keys are the secrets people just tried is not
// something this process should be holding.
const KEY_SALT = crypto.randomBytes(32);

function derive (namespace, value) {
  const digest = crypto.createHash('sha256')
    .update(KEY_SALT)
    .update(String(value))
    .digest('hex');
  return namespace + ':' + digest.slice(0, 32);
}

function makeBucket (limit) {
  const entries = new Map();

  return {
    get: function get (key) {
      return entries.get(key);
    }
    , set: function set (key, expiry) {
      entries.set(key, expiry);
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done) { break; }
        entries.delete(oldest.value);
      }
    }
    , remove: function remove (key) {
      entries.delete(key);
    }
    , sweep: function sweep (now) {
      for (const [key, expiry] of entries) {
        if (now > expiry + FAIL_AGE) {
          entries.delete(key);
        }
      }
    }
    , size: function size () {
      return entries.size;
    }
  };
}

function trustsForwardedHeaders (env) {
  return Boolean(compileTrust(env && env.trustProxy).legacyForwardedHeaders);
}

// The warning logged when the throttle can be walked past by a caller, or null
// when a trust boundary is configured.
function bootMessage (env) {
  if (!trustsForwardedHeaders(env)) { return null; }
  return 'SECURITY: failed-authentication throttling is keyed on the client address, '
    + 'and TRUST_PROXY is not set, so that address is read from request headers '
    + '(X-Forwarded-For and similar) that any caller can set. A caller who changes '
    + 'them, and the password or token tried, on every attempt is never delayed, so '
    + 'while TRUST_PROXY is unset this delay does NOT protect against guessing '
    + 'passwords or tokens. To key it on the real client address, set TRUST_PROXY '
    + 'to the IP address(es) or CIDR range(s) of the proxy in front of Nightscout, '
    + 'or to false if clients connect directly. Until then, restrict access at your '
    + 'proxy or hosting provider.';
}

function configuredMessage (env) {
  return 'Failed-authentication throttling is keyed on the client address as '
    + 'resolved through TRUST_PROXY=' + String(env.trustProxy).trim() + '.';
}

function init (env) {

  const delayList = {};

  const DELAY_ON_FAIL = env?.settings?.authFailDelay ?? 5000;

  // SAY SO AT BOOT. The throttle below is only as good as the address it is
  // keyed on. With TRUST_PROXY unset -- the default, and the behaviour of every
  // release before this one -- that address is read from request headers with
  // no proxy trust boundary, so a caller who varies the header is never
  // throttled for guessing different credentials. That is not something an
  // operator can be expected to infer from a changelog, so it is logged. The
  // message must never claim protection the default does not give, and must
  // name only settings this code reads (tests/authdelay.test.js checks both).
  if (bootMessage(env)) { console.warn(bootMessage(env)); }
  else { console.info(configuredMessage(env)); }

  const buckets = {
    addr: makeBucket(MAX_ADDRESS_ENTRIES)
    , cred: makeBucket(MAX_CREDENTIAL_ENTRIES)
  };

  function bucketFor (key) {
    return buckets[String(key).split(':')[0]];
  }

  function keyList (keys) {
    if (!keys) { return []; }
    return (Array.isArray(keys) ? keys : [keys]).filter(key => bucketFor(key));
  }

  /**
   * The keys a failed authentication is counted under.
   *
   * `addr` is the client address as this deployment resolves it -- the same
   * value the rest of the request path reports. HOW MUCH IT IS WORTH DEPENDS ON
   * CONFIGURATION, and on a default deployment it is worth very little: the
   * address is read out of `X-Forwarded-For` and friends with no proxy trust
   * boundary, so a caller that varies the header gets a fresh counter on every
   * attempt and is never throttled. That is the behaviour on the shipping
   * release and, with TRUST_PROXY unset, this change does not alter it -- see
   * the note `init` logs at boot. Set TRUST_PROXY (lib/server/client-ip.js) and
   * the same key becomes the address the trusted proxy saw, at which point the
   * throttle does what it was always meant to do.
   *
   * The credential is keyed as well, so that guessing at one secret from many
   * addresses is slowed too, and so that a misconfigured uploader is throttled
   * for its own bad credential wherever it connects from. It cannot replace the
   * address key: a brute force varies the credential by definition, so a counter
   * keyed only on the credential is fresh on every guess.
   *
   * @param {*} data resolve() data: `ip`, and `api_secret` or `token`
   * @returns {Array<string>} keys, possibly empty
   */
  delayList.keysFor = function keysFor (data) {
    const keys = [];
    if (!data) { return keys; }

    if (data.ip) { keys.push(derive('addr', data.ip)); }

    const credential = data.api_secret || data.token;
    if (credential) { keys.push(derive('cred', credential)); }

    return keys;
  };

  delayList.addFailedRequest = function addFailedRequest (keys) {
    const now = Date.now();
    keyList(keys).forEach(function each (key) {
      const bucket = bucketFor(key);
      const entry = bucket.get(key);
      const from = (entry && entry > now) ? entry : now;
      bucket.set(key, from + DELAY_ON_FAIL);
    });
  };

  delayList.shouldDelayRequest = function shouldDelayRequest (keys) {
    const now = Date.now();
    let delay = 0;

    keyList(keys).forEach(function each (key) {
      const entry = bucketFor(key).get(key);
      if (entry && entry - now > delay) {
        delay = entry - now;
      }
    });

    return delay > 0 ? delay : false;
  };

  delayList.requestSucceeded = function requestSucceeded (keys) {
    keyList(keys).forEach(function each (key) {
      bucketFor(key).remove(key);
    });
  };

  // Clear items older than a minute. This was a setTimeout, so it ran once and
  // then never again; the bounds above are what keeps the list finite, but a
  // sweep that only happens once leaves stale entries for the life of the
  // process, so it is an interval now. Unreferenced, so it cannot hold the
  // process open on shutdown or at the end of a test run.

  const sweep = setInterval(function clearList () {
    const now = Date.now();
    buckets.addr.sweep(now);
    buckets.cred.sweep(now);
  }, SWEEP_INTERVAL);

  if (sweep.unref) { sweep.unref(); }

  return delayList;
}

module.exports = init;
// Exposed for tests/authdelay.test.js, which checks what the message claims.
module.exports.bootMessage = bootMessage;
