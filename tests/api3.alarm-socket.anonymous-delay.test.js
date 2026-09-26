/* eslint require-atomic-updates: 0 */
'use strict';

require('should');

/*
 * BF-80: the failed-login delay must not hold back alarms from a viewer that
 * presents no credential.
 *
 * `authorization.resolve` waits out the failed-authentication delay for the
 * caller's address BEFORE it looks at the credential, so a guesser learns
 * nothing from a fast answer. /alarm delivery (BF-75) admits a socket to the
 * delivery room only once that resolution has returned, so after a few
 * failed logins from an address -- a misconfigured uploader behind the same
 * home router is enough -- a web page opening there joined the room late,
 * missed the first emission of an alarm, and heard it only at the next
 * re-emission.
 *
 * A subscriber with no credential has nothing to guess with: whatever the
 * delay protects, it gets the deployment's anonymous default permissions and
 * nothing else, the same answer it gets from an address that never failed.
 * So it is answered at once. The same holds for the connect-time admission,
 * which never carries a credential: on a readable site every socket, signed
 * in or not, is in the delivery room as soon as it connects, whatever the
 * delay state of its address, as on 15.0.8 and on an address that never
 * failed. Everything that presents a credential, valid or not, still waits
 * exactly as before before the credential is checked, and can only add to
 * what the admission gave; the rows below that assert the delay is still
 * there are as much the point of this file as the ones that assert it is
 * gone.
 *
 * CHANGED marks the expectations the wider admission changed by design: on a
 * readable site a viewer whose credentialed subscribe is still held already
 * receives the alarm through the admission.
 *
 * Addresses are chosen per case through X-Forwarded-For, which this fixture
 * resolves the client address from (TRUST_PROXY unset), so each case starts
 * from its own delay state.
 */
describe('Alarm socket and the failed-login delay (BF-80)', function () {
  const self = this
    , crypto = require('crypto')
    , request = require('supertest')
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , io = require('socket.io-client')
    ;

  const API_SECRET = 'this is my long pass phrase'
    , API_SECRET_HASH = crypto.createHash('sha1').update(API_SECRET).digest('hex')
    // A different wrong secret per use: a failed credential is keyed as well
    // as the address, and a shared one would couple the scenarios.
    , wrongHash = tag => crypto.createHash('sha1').update('not the secret ' + tag).digest('hex')
    // The per-failure penalty. Long enough that "held" and "not held" cannot
    // be confused with scheduling noise, short enough to keep the file quick.
    , DELAY = 1500
    , FAILURES = 3
    // When the alarm is emitted, measured from sending `subscribe`: the alarm
    // that is already sounding when the page opens.
    , EMIT_AFTER = 250
    // How long after that emission a viewer that is not held must have it.
    , PROMPT = 1000
    , ALARM = { level: 2, title: 'Urgent LOW', group: 'default'
      , plugin: { name: 'simplealarms', label: 'Simple Alarms', pluginType: 'notification' } }
    ;

  this.timeout(60000);

  let addressSeq = 0;
  function freshAddress () {
    addressSeq += 1;
    return `203.0.113.${addressSeq}`;
  }

  function connect (inst, address) {
    return new Promise(function (resolve, reject) {
      const socket = io(`${inst.baseUrl}/alarm`, {
        transports: ['websocket']
        , forceNew: true
        , reconnection: false
        , extraHeaders: { 'X-Forwarded-For': address }
      });
      socket.received = [];
      socket.on('urgent_alarm', function onAlarm (notify) {
        socket.received.push({ at: Date.now(), message: notify && notify.message });
      });
      socket.on('connect', function onConnect () { resolve(socket); });
      socket.on('connect_error', reject);
      self.open.push(socket);
    });
  }

  // X: the uploader with the wrong credential, from `address`. The failed
  // credential is keyed too, so each X has its own, or the scenarios below
  // would throttle one another through it.
  async function fail (inst, address, n) {
    for (let i = 0; i < n; i++) {
      const res = await request(inst.baseUrl).get('/api/v3/entries?limit=1')
        .set('Authorization', 'Bearer not-a-valid-jwt-' + address)
        .set('X-Forwarded-For', address);
      res.status.should.equal(401);
    }
  }

  /*
   * Y without a subscribe: connect, emit one alarm EMIT_AFTER ms later, and
   * report when (if at all) it arrived.
   */
  async function silentViewer (inst, address) {
    const socket = await connect(inst, address);
    await new Promise(r => setTimeout(r, EMIT_AFTER));
    const tag = 'bf80-silent-' + address + '-' + Date.now();
    const emittedAt = Date.now();
    inst.ctx.bus.emit('notification', Object.assign({}, ALARM, { message: tag }));
    await new Promise(r => setTimeout(r, PROMPT));
    const first = socket.received.find(r => r.message === tag);
    return { alarmAfterEmitMs: first ? first.at - emittedAt : null };
  }

  // Emit a second alarm on `socket` after its subscribe has resolved: the
  // positive control for a viewer that missed the first one.
  async function emitAgain (inst, socket) {
    const tag = 'bf80-again-' + Date.now() + '-' + Math.random();
    const emittedAt = Date.now();
    inst.ctx.bus.emit('notification', Object.assign({}, ALARM, { message: tag }));
    await new Promise(r => setTimeout(r, PROMPT));
    const first = socket.received.find(r => r.message === tag);
    return first ? first.at - emittedAt : null;
  }

  /*
   * Y: connect, subscribe with `message`, and while the acknowledgement is
   * outstanding emit one alarm EMIT_AFTER ms in. Reports when the ack came,
   * what it said, and when (if at all) the alarm arrived.
   */
  async function viewer (inst, address, message) {
    const socket = await connect(inst, address);
    const sent = Date.now();
    let emittedAt = null;

    // Each viewer's alarm is its own, so viewers running side by side cannot
    // be credited with one another's deliveries.
    const tag = 'bf80-canary-' + address + '-' + sent;
    const emitted = new Promise(function (resolve) {
      setTimeout(function emitOnce () {
        emittedAt = Date.now();
        inst.ctx.bus.emit('notification', Object.assign({}, ALARM, { message: tag }));
        resolve();
      }, EMIT_AFTER);
    });

    const ack = await new Promise(function (resolve) {
      socket.emit('subscribe', message, function onAck (data) {
        resolve({ at: Date.now(), data });
      });
    });

    await emitted;
    // Give a prompt delivery the whole window to land.
    const settle = emittedAt + PROMPT - Date.now();
    if (settle > 0) { await new Promise(r => setTimeout(r, settle)); }

    const first = socket.received.find(r => r.message === tag);
    return {
      socket
      , ackMs: ack.at - sent
      , ack: ack.data
      , alarmAfterEmitMs: first ? first.at - emittedAt : null
    };
  }

  // Send an ack for a group of our own from `socket` and report whether it
  // reached the notifications layer.
  async function tryAck (inst, socket) {
    const group = 'bf80-ack-' + Date.now() + '-' + Math.random();
    socket.emit('ack', 2, group, 1000);
    await new Promise(r => setTimeout(r, 300));
    return inst.acks.some(a => a.group === group);
  }

  /*
   * Every scenario runs side by side, each on its own address, so the file
   * costs one scenario's time rather than the sum; the cases below only read
   * the results. X is the failing uploader, Y the viewer.
   */
  const scenarios = {
    // What the web page sends when nobody has signed in: hashauth.hash() is
    // null and client.authorized is unset (lib/client/index.js subscribeForAlarms).
    anonymous: async () => {
      const address = freshAddress();
      await fail(self.readable, address, FAILURES);
      return viewer(self.readable, address, { secret: null, jwtToken: undefined });
    }
    , emptyStrings: async () => {
      const address = freshAddress();
      await fail(self.readable, address, FAILURES);
      return viewer(self.readable, address, { secret: '', jwtToken: '', token: '', accessToken: '' });
    }
    , deniedAnonymous: async () => {
      const address = freshAddress();
      await fail(self.denied, address, FAILURES);
      return viewer(self.denied, address, { secret: null });
    }
    , wrongSecret: async () => {
      const address = freshAddress();
      await fail(self.readable, address, FAILURES);
      const y = await viewer(self.readable, address, { secret: wrongHash(address) });
      y.ackReached = await tryAck(self.readable, y.socket);
      return y;
    }
    // Positive control for the ack check above: the right secret, no failures.
    , rightSecret: async () => {
      const y = await viewer(self.readable, freshAddress(), { secret: API_SECRET_HASH });
      y.ackReached = await tryAck(self.readable, y.socket);
      return y;
    }
    , deniedWrongSecret: async () => {
      const address = freshAddress();
      await fail(self.denied, address, FAILURES);
      return viewer(self.denied, address, { secret: wrongHash(address) });
    }
    , deniedValidToken: async () => {
      const address = freshAddress();
      await fail(self.denied, address, FAILURES);
      const y = await viewer(self.denied, address, { jwtToken: self.deniedJwt });
      y.againAfterEmitMs = await emitAgain(self.denied, y.socket);
      return y;
    }
    , readableSilent: async () => {
      const address = freshAddress();
      await fail(self.readable, address, FAILURES);
      return silentViewer(self.readable, address);
    }
    , deniedSilent: async () => {
      const address = freshAddress();
      await fail(self.denied, address, FAILURES);
      return silentViewer(self.denied, address);
    }
    , ignoredField: async () => {
      const address = freshAddress();
      await fail(self.readable, address, FAILURES);
      return viewer(self.readable, address, { secret: null, token: 'not-read-here' });
    }
    , validToken: async () => {
      const address = freshAddress();
      await fail(self.readable, address, FAILURES);
      return viewer(self.readable, address, { jwtToken: self.jwt });
    }
    , otherAddress: async () => {
      await fail(self.readable, freshAddress(), FAILURES);
      return viewer(self.readable, freshAddress(), { jwtToken: self.jwt });
    }
    , noFailures: async () => viewer(self.readable, freshAddress(), { jwtToken: self.jwt })
    , afterAnonymous: async () => {
      const address = freshAddress();
      await fail(self.readable, address, FAILURES);
      // Five sockets connect and never subscribe (five admissions), and five
      // anonymous viewers subscribe, while the address is held.
      await Promise.all([0, 1, 2, 3, 4].map(() => connect(self.readable, address)));
      const reads = await Promise.all([0, 1, 2, 3, 4].map(async function anonymous () {
        const socket = await connect(self.readable, address);
        const data = await new Promise(r => socket.emit('subscribe', { secret: null }, r));
        return data.read;
      }));
      const y = await viewer(self.readable, address, { secret: wrongHash(address) });
      y.anonymousReads = reads;
      return y;
    }
  };

  before(async () => {
    self.open = [];
    self.readable = await instance.create({ useHttps: false, apiSecret: API_SECRET
      , authDefaultRoles: 'readable', authFailDelay: DELAY });
    self.denied = await instance.create({ useHttps: false, apiSecret: API_SECRET
      , authDefaultRoles: 'denied', authFailDelay: DELAY });

    const auth = await authSubject(self.readable.ctx.authorization.storage, ['read'], self.readable.app);
    self.jwt = auth.jwt.read;
    const deniedAuth = await authSubject(self.denied.ctx.authorization.storage, ['read'], self.denied.app);
    self.deniedJwt = deniedAuth.jwt.read;

    // Record acks that reach the notifications layer instead of acting on
    // them; each ack carries a group of its own.
    self.readable.acks = [];
    self.readable.ctx.notifications.ack = function recordAck (level, group) {
      self.readable.acks.push({ level, group });
    };

    self.notified = [];
    self.readable.ctx.bus.on('admin-notify', function onNotify (n) { self.notified.push(n); });

    const names = Object.keys(scenarios);
    const results = await Promise.all(names.map(name => scenarios[name]()));
    self.y = {};
    names.forEach((name, i) => { self.y[name] = results[i]; });
  });

  after(async () => {
    self.open.forEach(s => { if (s.connected) { s.disconnect(); } });
    self.readable.ctx.bus.teardown();
    self.denied.ctx.bus.teardown();
  });


  // ------------------------------------------------------------ the fix

  it('delivers the alarm at once to an anonymous viewer on a throttled address', () => {
    const y = self.y.anonymous;
    // The symptom first: the alarm that was sounding as the page opened.
    (y.alarmAfterEmitMs === null).should.equal(false, 'alarm not delivered within ' + PROMPT + ' ms of emission');
    y.alarmAfterEmitMs.should.be.below(PROMPT);
    y.ack.success.should.equal(true);
    y.ack.read.should.equal(true);
    y.ackMs.should.be.below(EMIT_AFTER);
  });

  it('treats empty-string credentials as no credential', () => {
    const y = self.y.emptyStrings;
    (y.alarmAfterEmitMs === null).should.equal(false, 'alarm not delivered within ' + PROMPT + ' ms of emission');
    y.ack.read.should.equal(true);
    y.ackMs.should.be.below(EMIT_AFTER);
  });

  // BF-75 must still hold: answered at once, but with what anonymous gets
  // on this deployment, which is nothing.
  it('answers an anonymous viewer on a denied instance at once, with no read and no alarm', () => {
    const y = self.y.deniedAnonymous;
    y.ack.success.should.equal(true);
    y.ack.read.should.equal(false);
    y.ackMs.should.be.below(EMIT_AFTER);
    (y.alarmAfterEmitMs === null).should.equal(true, 'alarm delivered to an unentitled socket');
  });


  // ------------------------------------------------ the connect-time admission

  // A socket that never subscribes is admitted with the anonymous default,
  // and on a readable site that is read, whatever the delay state.
  it('delivers the alarm at once to a readable-site socket that never subscribes, on a throttled address', () => {
    const y = self.y.readableSilent;
    (y.alarmAfterEmitMs === null).should.equal(false, 'alarm not delivered within ' + PROMPT + ' ms of emission');
    y.alarmAfterEmitMs.should.be.below(PROMPT);
  });

  // BF-75: on a denied site the admission grants nothing, so a socket that
  // never subscribes receives nothing -- no return to the 15.0.8 broadcast.
  it('delivers nothing to a denied-site socket that never subscribes, on a throttled address', () => {
    const y = self.y.deniedSilent;
    (y.alarmAfterEmitMs === null).should.equal(true, 'alarm delivered to an unentitled socket');
  });


  // ------------------------------------------------ the credential check still waits

  // Every guess carries a credential, and every credential still waits before
  // it is checked.
  it('still holds the credential check of a wrong secret for the full delay', () => {
    const y = self.y.wrongSecret;
    y.ack.success.should.equal(false);
    y.ackMs.should.be.aboveOrEqual(DELAY * 0.8);
  });

  // CHANGED (wider admission, 2026-09-26): this viewer used to miss the first
  // emission; it is now in the room through the admission, with the anonymous
  // default, while its subscribe is held.
  it('delivers the alarm at once to a readable-site viewer whose wrong-secret subscribe is held', () => {
    const y = self.y.wrongSecret;
    (y.alarmAfterEmitMs === null).should.equal(false, 'alarm not delivered within ' + PROMPT + ' ms of emission');
    y.alarmAfterEmitMs.should.be.below(PROMPT);
  });

  // The admission gave read and nothing else; the failed subscribe adds
  // nothing, so an ack from this socket goes nowhere.
  it('gives a wrong secret no permission beyond the anonymous default', () => {
    self.y.wrongSecret.ackReached.should.equal(false, 'ack from a wrong-secret socket reached notifications');
    // The control: the same ack from a socket with the right secret arrives.
    self.y.rightSecret.ack.ack.should.equal(true);
    self.y.rightSecret.ackReached.should.equal(true, 'ack from an admin socket did not arrive');
  });

  it('still holds the credential check of a wrong secret on a denied site, and delivers nothing', () => {
    const y = self.y.deniedWrongSecret;
    y.ack.success.should.equal(false);
    y.ackMs.should.be.aboveOrEqual(DELAY * 0.8);
    (y.alarmAfterEmitMs === null).should.equal(true, 'alarm delivered to an unentitled socket');
  });

  // A field this path does not read still counts as presenting something, so
  // a message is never answered as anonymous because it put its credential in
  // an unexpected place.
  it('still holds the subscribe of a viewer whose only credential is in a field this path ignores', () => {
    const y = self.y.ignoredField;
    y.ackMs.should.be.aboveOrEqual(DELAY * 0.8);
  });

  // CHANGED (wider admission): see the wrong-secret case above.
  it('delivers the alarm at once to a readable-site viewer whose ignored-field subscribe is held', () => {
    const y = self.y.ignoredField;
    (y.alarmAfterEmitMs === null).should.equal(false, 'alarm not delivered within ' + PROMPT + ' ms of emission');
  });

  // A valid credential is only known to be valid once it has been checked, and
  // it is checked after the wait.
  it('still holds the credential check of a valid web token for the full delay', () => {
    const y = self.y.validToken;
    y.ack.success.should.equal(true);
    y.ack.read.should.equal(true);
    y.ackMs.should.be.aboveOrEqual(DELAY * 0.8);
  });

  // CHANGED (wider admission): a signed-in viewer on a readable site used to
  // miss the first emission; it now has it through the admission.
  it('delivers the alarm at once to a readable-site viewer whose valid-token subscribe is held', () => {
    const y = self.y.validToken;
    (y.alarmAfterEmitMs === null).should.equal(false, 'alarm not delivered within ' + PROMPT + ' ms of emission');
    y.alarmAfterEmitMs.should.be.below(PROMPT);
  });

  // Unchanged on a denied site: the admission grants nothing, so a signed-in
  // viewer receives nothing until its held subscribe resolves, and then does.
  it('holds a valid web token on a denied site: no alarm until its subscribe resolves', () => {
    const y = self.y.deniedValidToken;
    y.ack.success.should.equal(true);
    y.ack.read.should.equal(true);
    y.ackMs.should.be.aboveOrEqual(DELAY * 0.8);
    (y.alarmAfterEmitMs === null).should.equal(true, 'held viewer received the first emission');
    (y.againAfterEmitMs === null).should.equal(false, 'resolved viewer did not receive the next emission');
  });

  it('does not hold a signed-in viewer on a different address', () => {
    const y = self.y.otherAddress;
    y.ackMs.should.be.below(EMIT_AFTER);
    y.alarmAfterEmitMs.should.be.below(PROMPT);
  });

  it('does not hold a signed-in viewer when nothing has failed', () => {
    const y = self.y.noFailures;
    y.ackMs.should.be.below(EMIT_AFTER);
    y.alarmAfterEmitMs.should.be.below(PROMPT);
  });

  // The next guess from the address is still held -- anonymous admissions and
  // subscribes did not clear the delay -- and for no longer than the penalty
  // the failures left, so they did not add to it either.
  it('does not let anonymous admissions or subscribes wear the delay down or add to it', () => {
    const y = self.y.afterAnonymous;
    y.anonymousReads.should.eql([true, true, true, true, true]);
    y.ack.success.should.equal(false);
    y.ackMs.should.be.aboveOrEqual(DELAY * 0.8);
    y.ackMs.should.be.below(DELAY * 1.5);
  });

  it('still raises the Failed authentication notice for every failure', () => {
    const failed = self.notified.filter(n => n && n.title === 'Failed authentication');
    // FAILURES for each of the eight throttling scenarios on this instance,
    // plus the two wrong-secret subscribes.
    failed.length.should.equal(FAILURES * 8 + 2);
  });

});
