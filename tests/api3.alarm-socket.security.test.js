/* eslint require-atomic-updates: 0 */
'use strict';

require('should');

/*
 * The /alarm namespace is the only path by which Nightscout pushes alarms,
 * announcements and treatment notifications to clients. `emitNotification`
 * used to broadcast to the whole namespace, so delivery was conditional on
 * neither having subscribed nor being allowed to read: on an instance with
 * AUTH_DEFAULT_ROLES=denied, where every REST read answers 401, an anonymous
 * socket received everything. (GHSA-8849-qjp5-vrrj / BF-75.)
 *
 * Delivery is now scoped to the 'AlarmReceivers' room, and membership is
 * decided by one thing only: whether this socket's resolved authorization
 * includes `api:*:read` — the same permission the REST surface checks and the
 * same one the main namespace's 'DataReceivers' room is gated on.
 *
 *   ---------------------------------------------------------------------
 *   FIX SHAPE B. Decided 2026-09-21 by Ben West; recorded in
 *   docs/60-research/remedial/ghsa-8849-alarm-socket-2026-09-21.md §12 of
 *   the alignment repository.
 *
 *   Shape B admits the socket to the delivery room at CONNECTION time when
 *   the deployment's anonymous default role already permits reading, and
 *   re-evaluates on `subscribe`.
 *
 *   The rejected alternative, shape A, additionally required a successful
 *   `subscribe`. Measured consequence of A: on the shipped
 *   AUTH_DEFAULT_ROLES=readable default, a client that connects and never
 *   subscribes stops receiving alarms. That is a behaviour change on the
 *   majority configuration, and in this namespace a behaviour change means
 *   somebody's hypo alarm does not arrive. The /alarm protocol is in no
 *   swagger file and nothing under docs/, so its third-party consumers
 *   cannot be enumerated and that risk cannot be measured away.
 *
 *   FIVE CASES IN THIS FILE CHANGED THEIR EXPECTATION WHEN B WAS CHOSEN
 *   over A — the `readable` / never-subscribed row, one per event class.
 *   Under shape A they asserted non-delivery. They now assert DELIVERY and
 *   are tagged [SHAPE B] individually. They are the cases that go red if the
 *   room is ever scoped back to subscribers only.
 *   ---------------------------------------------------------------------
 *
 * The delivery rows carry most of the value in this file. A suite that only
 * asserted non-delivery sails straight through a room scoped too tightly,
 * which is exactly the failure the shape decision was taken to avoid, so
 * every positive cell is asserted for every event class independently.
 *
 * The `denied` arm also pins the two ways a room-scoped fix can still be too
 * loose. It can gate on the wrong setting — AUTH_DEFAULT_ROLES is what turns
 * anonymous reads off, and it is the only thing this room may follow. And it
 * can gate on "a credential resolved" rather than on the read permission: a
 * token that authenticates perfectly well but holds no read entitlement —
 * write-only, and no-permissions-at-all — must be refused alarms, and the
 * REST control in the same run shows that same token being refused the same
 * data over HTTP.
 */
describe('Alarm socket delivery scope', function () {
  const self = this
    , crypto = require('crypto')
    , request = require('supertest')
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , io = require('socket.io-client')
    ;

  const API_SECRET = 'this is my long pass phrase'
    , SECRET_HASH = crypto.createHash('sha1').update(API_SECRET).digest('hex')
    , EVENTS = ['notification', 'announcement', 'alarm', 'urgent_alarm', 'clear_alarm']
    ;

  // One notification per branch of emitNotification, so a test that only ever
  // exercised the INFO branch cannot pass for the other four.
  const TREATMENTNOTIFY = { name: 'treatmentnotify', label: 'Treatment Notifications', pluginType: 'notification' }
    , SIMPLEALARMS = { name: 'simplealarms', label: 'Simple Alarms', pluginType: 'notification' }
    ;

  const NOTIFIES = {
    notification: { level: 0, title: 'Bolus', message: 'canary-notification', group: 'default', plugin: TREATMENTNOTIFY }
    , announcement: { level: 0, isAnnouncement: true, title: 'Announcement', message: 'canary-announcement', group: 'Announcement', plugin: TREATMENTNOTIFY }
    , alarm: { level: 1, title: 'Warning LOW', message: 'canary-alarm', group: 'default', plugin: SIMPLEALARMS }
    , urgent_alarm: { level: 2, title: 'Urgent LOW', message: 'canary-urgent', group: 'default', plugin: SIMPLEALARMS }
    , clear_alarm: { clear: true, title: 'All Clear', message: 'canary-clear', group: 'default' }
  };

  this.timeout(60000);

  function connect (inst) {
    return new Promise(function (resolve, reject) {
      const socket = io(`${inst.baseUrl}/alarm`, {
        transports: ['websocket']
        , forceNew: true
        , reconnection: false
        , rejectUnauthorized: false
      });
      const received = [];
      EVENTS.forEach(function eachEvent (ev) {
        socket.on(ev, function onEvent (notify) {
          received.push({ event: ev, message: notify && notify.message });
        });
      });
      socket.received = received;
      socket.on('connect', function onConnect () { resolve(socket); });
      socket.on('connect_error', reject);
    });
  }

  function subscribe (socket, message) {
    return new Promise(function (resolve) {
      socket.emit('subscribe', message, resolve);
    });
  }

  // Emit every notification class on the server bus, which is exactly where
  // emitNotification is registered, then let the sockets drain.
  function emitAll (inst) {
    EVENTS.forEach(function eachEvent (ev) {
      inst.ctx.bus.emit('notification', NOTIFIES[ev]);
    });
    return new Promise(function (resolve) { setTimeout(resolve, 700); });
  }

  // The REST control, taken in the same run against the same instance: what
  // does this credential get over HTTP at the moment it is being offered to
  // the socket? A refusal on the socket means something only if the same
  // subject is being refused the same data through the front door.
  //
  // This control is only meaningful for the TOKEN rows. API v3 demands a
  // bearer token unconditionally (lib/api3/security.js `authenticate`), so an
  // anonymous v3 request is 401 on every value of AUTH_DEFAULT_ROLES and says
  // nothing about it. The anonymous control is therefore the v1 surface,
  // which this fixture does not mount; it is measured on the live lab and in
  // docs/60-research/remedial/ghsa-8849-alarm-socket-2026-09-21.md §3. What
  // stands in for it here is the server's own decision for the same caller at
  // the same moment: the `read` boolean in the subscribe acknowledgement.
  function restProbe (inst, jwt) {
    return request(inst.baseUrl).get('/api/v3/entries?limit=1')
      .set('Authorization', `Bearer ${jwt}`)
      .then(res => ({ status: res.status, message: res.body && res.body.message })
        , err => ({ status: (err.response && err.response.status) || -1, message: String(err) }));
  }

  before(async () => {
    self.denied = await instance.create({ useHttps: false, apiSecret: API_SECRET, authDefaultRoles: 'denied' });
    self.readable = await instance.create({ useHttps: false, apiSecret: API_SECRET, authDefaultRoles: 'readable' });

    // apiRead grants `api:*:read`; apiCreate grants only `api:*:create`;
    // noneRole resolves to a real subject holding no permission at all.
    const authResult = await authSubject(self.denied.ctx.authorization.storage
      , ['read', 'create', 'noneRole'], self.denied.app);
    self.accessToken = authResult.accessToken;
    self.jwt = authResult.jwt;

    self.rest = {
      deniedReadToken: await restProbe(self.denied, self.jwt.read)
      , deniedCreateToken: await restProbe(self.denied, self.jwt.create)
      , deniedNoneToken: await restProbe(self.denied, self.jwt.noneRole)
    };

    self.sockets = {
      // ---- AUTH_DEFAULT_ROLES=denied : anonymous reads are off ----
      deniedSilent: await connect(self.denied)        // connects, never sends subscribe
      , deniedAnon: await connect(self.denied)        // subscribes with no credential
      , deniedSecret: await connect(self.denied)      // subscribes with the API secret
      , deniedReadToken: await connect(self.denied)   // token granting api:*:read
      , deniedCreateToken: await connect(self.denied) // token granting only api:*:create
      , deniedNoneToken: await connect(self.denied)   // token granting nothing at all
      // ---- AUTH_DEFAULT_ROLES=readable : the shipped default ----
      , readableSilent: await connect(self.readable)  // connects, never sends subscribe
      , readableAnon: await connect(self.readable)
      , readableSecret: await connect(self.readable)
    };

    self.acks = {
      deniedAnon: await subscribe(self.sockets.deniedAnon, {})
      , deniedSecret: await subscribe(self.sockets.deniedSecret, { secret: SECRET_HASH })
      , deniedReadToken: await subscribe(self.sockets.deniedReadToken, { accessToken: self.accessToken.read })
      , deniedCreateToken: await subscribe(self.sockets.deniedCreateToken, { accessToken: self.accessToken.create })
      , deniedNoneToken: await subscribe(self.sockets.deniedNoneToken, { accessToken: self.accessToken.noneRole })
      , readableAnon: await subscribe(self.sockets.readableAnon, {})
      , readableSecret: await subscribe(self.sockets.readableSecret, { secret: SECRET_HASH })
    };

    await emitAll(self.denied);
    await emitAll(self.readable);
  });

  after(async () => {
    Object.keys(self.sockets).forEach(function eachSocket (name) {
      if (self.sockets[name].connected) { self.sockets[name].disconnect(); }
    });
    self.denied.ctx.bus.teardown();
    self.readable.ctx.bus.teardown();
  });


  // ---------------------------------------------------------------- controls

  it('should serve REST reads to a token holding api:*:read', () => {
    self.rest.deniedReadToken.status.should.equal(200);
  });

  it('should refuse REST reads to a token holding only api:*:create', () => {
    self.rest.deniedCreateToken.status.should.equal(403);
    self.rest.deniedCreateToken.message.should.match(/api:entries:read/);
  });

  it('should refuse REST reads to a token holding no permission', () => {
    self.rest.deniedNoneToken.status.should.equal(403);
    self.rest.deniedNoneToken.message.should.match(/api:entries:read/);
  });

  // The server's own authorization decision for each subscriber, computed
  // from AUTH_DEFAULT_ROLES and reported to the client. Before the fix this
  // was the whole defect in one line: `read:false` was transmitted and then
  // every event was delivered anyway.
  it('should tell a subscriber whether it may read', () => {
    self.acks.deniedAnon.read.should.equal(false);
    self.acks.deniedSecret.read.should.equal(true);
    self.acks.readableAnon.read.should.equal(true);
    self.acks.readableSecret.read.should.equal(true);
  });


  // ---------------------------------------------------------------- delivery

  EVENTS.forEach(function eachEvent (ev) {

    // --- AUTH_DEFAULT_ROLES=denied : nothing anonymous, nothing unentitled ---

    it(`should not deliver ${ev} to a never-subscribed socket when reads are denied`, () => {
      self.sockets.deniedSilent.received
        .filter(r => r.event === ev).should.be.empty();
    });

    it(`should not deliver ${ev} to an unauthorized subscriber when reads are denied`, () => {
      self.sockets.deniedAnon.received
        .filter(r => r.event === ev).should.be.empty();
    });

    // A credential that resolves is not a credential that may read. "Did a
    // credential resolve" would admit this token; `api:*:read` is the
    // question, and by it this token is refused here exactly as REST refuses
    // it the same data in this same run (rest.deniedCreateToken, 403).
    it(`should not deliver ${ev} to a subscriber whose token may write but not read`, () => {
      self.sockets.deniedCreateToken.received
        .filter(r => r.event === ev).should.be.empty();
    });

    it(`should not deliver ${ev} to a subscriber whose token holds no permission`, () => {
      self.sockets.deniedNoneToken.received
        .filter(r => r.event === ev).should.be.empty();
    });

    it(`should deliver ${ev} to a subscriber holding the API secret`, () => {
      self.sockets.deniedSecret.received
        .filter(r => r.event === ev).should.have.length(1);
    });

    it(`should deliver ${ev} to a subscriber whose token grants api:*:read`, () => {
      self.sockets.deniedReadToken.received
        .filter(r => r.event === ev).should.have.length(1);
    });

    // --- AUTH_DEFAULT_ROLES=readable : the shipped default, unchanged ---

    // [SHAPE B] This case asserted the OPPOSITE under shape A, which required
    // a successful subscribe on every configuration. Shape B admits at connect
    // time when the anonymous default already permits reading, so a client
    // that connects and never subscribes receives exactly what it has
    // received since 15.0.0. This is the assertion that fails if anyone
    // re-tightens the room to subscribers only — which is what the decision
    // of 2026-09-21 rejected, on the grounds that the /alarm protocol is
    // undocumented and its third-party consumers cannot be enumerated.
    it(`should deliver ${ev} to a never-subscribed socket on a readable instance [SHAPE B]`, () => {
      self.sockets.readableSilent.received
        .filter(r => r.event === ev).should.have.length(1);
    });

    it(`should deliver ${ev} to an anonymous subscriber on a readable instance`, () => {
      self.sockets.readableAnon.received
        .filter(r => r.event === ev).should.have.length(1);
    });

    it(`should deliver ${ev} to a secret-holding subscriber on a readable instance`, () => {
      self.sockets.readableSecret.received
        .filter(r => r.event === ev).should.have.length(1);
    });

  });

});
