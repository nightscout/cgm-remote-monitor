'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { format } = require('node:util');
const StorageSocket = require('../lib/api3/storageSocket');
const apiConst = require('../lib/api3/const');

describe('API3 storage subscription logging', function () {
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

  function fixture (error) {
    const ctx = {
      authorization: {
        resolveAccessToken: (token, callback) => callback(error, error ? undefined : { shiros: [] }),
        checkMultiple: () => true
      }
    };
    const app = { get: name => name === 'enabledCollections' ? ['entries', 'treatments'] : undefined };
    const socket = new EventEmitter();
    socket.join = () => {};
    return { socket, storage: new StorageSocket(app, {}, ctx) };
  }

  for (const mode of ['accessToken', 'missingCredentials']) {
    for (const withCallback of [true, false]) {
      it(`keeps ${mode} rejection private ${withCallback ? 'with' : 'without'} a callback`, function () {
        const sentinel = 'storage-test-private-credential';
        const error = new Error(sentinel);
        const { socket, storage } = fixture(error);
        const message = mode === 'missingCredentials'
          ? { collections: ['entries'], extra: sentinel }
          : { accessToken: sentinel, secret: sentinel, extra: sentinel };
        const responses = [];
        for (let cycle = 0; cycle < 2; cycle++) {
          const result = storage.subscribe(socket, message, withCallback ? response => responses.push(response) : undefined);
          assert.equal(result, mode === 'missingCredentials' ? undefined : error);
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

  it('keeps accessToken credentials out of logs on a successful subscribe', function () {
    const { socket, storage } = fixture(null);
    const responses = [];
    const result = storage.subscribe(socket, { accessToken: 'storage-test-private-credential' }, response => responses.push(response));
    assert.deepEqual(result, { success: true, collections: ['entries', 'treatments'] });
    assert.deepEqual(responses, [result]);
    assert.equal(logs.some(line => line.includes('storage-test-private-credential')), false);
  });
});
