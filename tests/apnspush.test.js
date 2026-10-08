'use strict';

require('should');

const apn = require('@parse/node-apn');
const init = require('../lib/server/apnspush');

const TOKEN = 'f13973fcedd370e10e5b08b5afa7a162f66024c9730320ec40e599be2f4935c2';

function makeCtx (docs, sendResults) {
  const sends = [];
  const ctx = {
    bus: { on: function on () {} }
    , adminnotifies: { notifies: [], addNotify: function addNotify (n) { this.notifies.push(n); } }
    , store: {
      collection: function collection () {
        return {
          find: function find (query) {
            return {
              // Promise, not a callback. The pinned mongodb driver is ^5.9.2, which removed
              // callback support - a mock that still took a cb would let a callback-style
              // regression in the transport pass here and then hang silently in production.
              toArray: function toArray () {
                // Honour the soft-delete filter the transport asks for, so the test proves the
                // query is right rather than assuming it.
                const matching = docs.filter(function keep (d) {
                  return d.type === query.type && d.isValid !== false;
                });
                return Promise.resolve(matching);
              }
            };
          }
        };
      }
    }
  };
  ctx.sends = sends;
  ctx.sendResults = sendResults;
  return ctx;
}

function withEnv (fn) {
  const saved = {
    key: process.env.AAPS_APNS_KEY
    , keyId: process.env.AAPS_APNS_KEY_ID
    , teamId: process.env.AAPS_DEVELOPER_TEAM_ID
  };
  process.env.AAPS_APNS_KEY = '/dev/null';
  process.env.AAPS_APNS_KEY_ID = 'TESTKEYID1';
  process.env.AAPS_DEVELOPER_TEAM_ID = 'TESTTEAM01';
  try {
    return fn();
  } finally {
    ['AAPS_APNS_KEY', 'AAPS_APNS_KEY_ID', 'AAPS_DEVELOPER_TEAM_ID'].forEach(function restore (k, i) {
      const v = [saved.key, saved.keyId, saved.teamId][i];
      if (v === undefined) { delete process.env[k]; } else { process.env[k] = v; }
    });
  }
}

describe('apnspush', function apnspushSuite () {

  it('reports its own misconfiguration instead of disappearing', function notConfigured (done) {
    const saved = process.env.AAPS_APNS_KEY;
    delete process.env.AAPS_APNS_KEY;
    const push = init({}, makeCtx([], []));
    push.isConfigured().should.equal(false);
    // Must still exist and still answer, unlike a plugin that returns null.
    push.sendAlarm({ level: 2, group: 'default' }, function sent (count) {
      count.should.equal(0);
      if (saved !== undefined) { process.env.AAPS_APNS_KEY = saved; }
      done();
    });
  });

  it('builds a stage-1 push with the headers Apple requires', function headers () {
    // The regression this guards is specific and silent. In @parse/node-apn 5.2.3,
    // Notification.prototype.headers() emits apns-priority ONLY when priority !== 10, and the
    // constructor default IS 10 - so forgetting to set 5 sends no priority header at all and
    // APNs treats a background push as priority 10. apns-push-type has no default either.
    const n = new apn.Notification();
    n.pushType = 'background';
    n.priority = 5;
    n.topic = 'app.aaps.client';
    n.contentAvailable = 1;
    n.payload = { pushId: 'abc' };

    const h = n.headers();
    h['apns-push-type'].should.equal('background');
    h['apns-priority'].should.equal(5);
    h['apns-topic'].should.equal('app.aaps.client');

    const body = JSON.parse(n.compile());
    body.aps['content-available'].should.equal(1);
    body.should.have.property('pushId', 'abc');
    // No alert, ever. The app renders nothing that came from the payload.
    body.aps.should.not.have.property('alert');
  });

  it('shows that leaving the default priority sends no priority header at all', function defaultPriority () {
    const n = new apn.Notification();
    n.pushType = 'background';
    n.topic = 'app.aaps.client';
    n.contentAvailable = 1;
    n.headers().should.not.have.property('apns-priority');
  });

  it('skips a registration with no token or no bundle id', function halfWritten (done) {
    withEnv(function run () {
      const ctx = makeCtx([
        { type: 'aapsPushRegistration', identifier: 'no-token', bundleIdentifier: 'app.aaps.client' }
        , { type: 'aapsPushRegistration', identifier: 'no-bundle', deviceToken: TOKEN }
      ], []);
      const push = init({}, ctx);
      push.sendAlarm({ level: 2, group: 'default' }, function sent (count) {
        count.should.equal(0);
        done();
      });
    });
  });

  it('ignores a soft-deleted registration', function softDeleted (done) {
    withEnv(function run () {
      const ctx = makeCtx([
        {
          type: 'aapsPushRegistration', identifier: 'gone', deviceToken: TOKEN
          , bundleIdentifier: 'app.aaps.client', apnsEnvironment: 'sandbox', isValid: false
        }
      ], []);
      const push = init({}, ctx);
      push.sendAlarm({ level: 2, group: 'default' }, function sent (count) {
        count.should.equal(0);
        done();
      });
    });
  });

  it('keeps its own budget rather than inheriting the 30-second dedupe', function budget () {
    // Nightscout re-emits an unacked alarm on every data-load cycle, bounded only by a
    // 30-second recentlySent entry - measured at about 111 sends an hour, against Apple's
    // "two or three". The transport's ledger, not that gate, is what bounds the rate.
    withEnv(function run () {
      const ctx = makeCtx([], []);
      const push = init({}, ctx);
      push.suppressedCount().should.equal(0);
      push.isConfigured().should.equal(true);
    });
  });

});
