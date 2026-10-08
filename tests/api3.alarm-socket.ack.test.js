/* eslint require-atomic-updates: 0 */
'use strict';

require('should');

/*
 * Acking an alarm silences it for every viewer of the instance, for a duration
 * the caller chooses. The web-client branch of `subscribe` checks
 * notifications:*:ack before wiring the handler up; the access-token branch
 * used not to, so any token that resolved to a known subject could silence
 * everyone's alarms whatever its role said.
 */
describe('Alarm socket ack authorization', function () {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , io = require('socket.io-client')
    ;

  this.timeout(30000);

  function connect (inst) {
    return new Promise(function (resolve, reject) {
      const socket = io(`${inst.baseUrl}/alarm`, {
        transports: ['websocket']
        , forceNew: true
        , reconnection: false
        , rejectUnauthorized: false
      });
      socket.on('connect', function onConnect () { resolve(socket); });
      socket.on('connect_error', reject);
    });
  }

  function subscribe (socket, message) {
    return new Promise(function (resolve) {
      socket.emit('subscribe', message, resolve);
    });
  }

  function ackAndSettle (socket) {
    socket.emit('ack', 2, 'default', 60000);
    return new Promise(function (resolve) { setTimeout(resolve, 300); });
  }

  before(async () => {
    self.instance = await instance.create({ useHttps: false, authDefaultRoles: 'denied' });

    const authResult = await authSubject(self.instance.ctx.authorization.storage, [], self.instance.app);
    self.accessToken = authResult.accessToken;

    // Record what reaches the global ack, rather than inspecting alarm state,
    // so the assertion is about authorization and not about snooze arithmetic.
    self.acked = [];
    self.instance.ctx.notifications.ack = function recordAck (level, group, silenceTime) {
      self.acked.push({ level, group, silenceTime });
    };

    self.readOnly = await connect(self.instance);
    self.admin = await connect(self.instance);

    await subscribe(self.readOnly, { accessToken: self.accessToken.read });
    await ackAndSettle(self.readOnly);
    self.afterReadOnly = self.acked.length;

    await subscribe(self.admin, { accessToken: self.accessToken.adminAll });
    await ackAndSettle(self.admin);
    self.afterAdmin = self.acked.length;
  });

  after(async () => {
    [self.readOnly, self.admin].forEach(function eachSocket (socket) {
      if (socket && socket.connected) { socket.disconnect(); }
    });
    self.instance.ctx.bus.teardown();
  });


  it('should ignore ack from a token that may read but may not ack', () => {
    self.afterReadOnly.should.equal(0);
  });


  it('should honour ack from a token that may ack', () => {
    self.afterAdmin.should.equal(1);
    self.acked[0].level.should.equal(2);
    self.acked[0].group.should.equal('default');
  });

});
