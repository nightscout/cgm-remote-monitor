'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { format } = require('node:util');
const AlarmSocket = require('../lib/api3/alarmSocket');
const apiConst = require('../lib/api3/const');

describe('API3 alarm subscription logging', function () {
  let logs;
  let originalLog;
  let originalInfo;
  beforeEach(function () {
    logs = [];
    originalLog = console.log;
    originalInfo = console.info;
    console.log = console.info = (...args) => logs.push(format(...args));
  });
  afterEach(function () {
    console.log = originalLog;
    console.info = originalInfo;
  });

  function fixture (error, canAck = true) {
    const calls = [];
    const ctx = {
      levels: {},
      authorization: {
        resolveAccessToken: (token, callback) => callback(error),
        resolve: (credentials, callback) => callback(error, { shiros: [] }),
        checkMultiple: permission => permission === 'api:*:read' || canAck
      },
      notifications: { ack: (...args) => calls.push(args) }
    };
    const socket = new EventEmitter();
    socket.request = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
    return { socket, calls, alarm: new AlarmSocket(null, {
      settings: { authenticationPromptOnLoad: true }
    }, ctx) };
  }

  for (const mode of ['accessToken', 'jwtToken', 'missingCredentials']) {
    for (const withCallback of [true, false]) {
      it(`keeps ${mode} rejection private ${withCallback ? 'with' : 'without'} a callback`, function () {
        const sentinel = 'alarm-test-private-credential';
        const error = new Error(sentinel);
        const { socket, alarm } = fixture(error);
        const message = mode === 'missingCredentials'
          ? { extra: sentinel }
          : { [mode]: sentinel, secret: sentinel, extra: sentinel };
        const responses = [];
        for (let cycle = 0; cycle < 2; cycle++) {
          const result = alarm.subscribe(socket, message, withCallback ? response => responses.push(response) : undefined);
          assert.equal(result, mode === 'missingCredentials' ? undefined : error);
          assert.equal(socket.listenerCount('ack'), 0);
        }
        assert.equal(responses.length, withCallback ? 2 : 0);
        for (const response of responses) assert.deepEqual(response, {
          success: false, message: apiConst.MSG.SOCKET_MISSING_OR_BAD_ACCESS_TOKEN
        });
        assert.equal(logs.length, 2);
        assert.ok(logs.every(line => line.includes('Authorization failed')));
        assert.equal(logs.some(line => line.includes(sentinel)), false, 'credentials must stay out of logs');
      });
    }
  }

  for (const mode of ['accessToken', 'jwtToken']) {
    for (const canAck of [true, false]) {
      it(`preserves ${mode} success and acknowledgement permissions (${canAck})`, function () {
        for (let cycle = 0; cycle < 2; cycle++) {
          const { socket, calls, alarm } = fixture(null, canAck);
          const responses = [];
          const result = alarm.subscribe(socket, { [mode]: 'alarm-test-private-credential' }, response => responses.push(response));
          assert.equal(result.success, true);
          assert.deepEqual(responses, [result]);
          assert.equal(socket.listenerCount('ack'), 1);
          socket.emit('ack', 1, 'test-group', 300);
          assert.deepEqual(calls, mode === 'accessToken' || canAck ? [[1, 'test-group', 300, true]] : []);
        }
        assert.equal(logs.some(line => line.includes('alarm-test-private-credential')), false);
      });
    }
  }
});
