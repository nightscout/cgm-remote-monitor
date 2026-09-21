'use strict';

const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const compiled = require('./browser/compiled-worker');

describe('Page HMR compilation notification correlation', function () {
  let worker;
  beforeEach(function () {worker = new EventEmitter();});
  afterEach(function () {
    assert.equal(worker.listenerCount('message'), 0);
    assert.equal(worker.listenerCount('exit'), 0);
  });

  it('does not let a stale successful build satisfy an expected compile error', async function () {
    const failed = assert.rejects(compiled(worker, 2), /ownedBrokenFixture/);
    worker.emit('message', {requestId: 1, hash: 'previous-success'});
    worker.emit('message', {requestId: 2, error: 'ownedBrokenFixture Unexpected token'});
    await failed;
  });

  it('ignores stale errors and duplicate successes while waiting for recovery', async function () {
    const recovered = compiled(worker, 3);
    worker.emit('message', {requestId: 2, error: 'previous-failure'});
    worker.emit('message', {requestId: 1, hash: 'previous-success'});
    worker.emit('message', {requestId: 1, hash: 'previous-success'});
    worker.emit('message', {requestId: 3, hash: 'recovery'});
    assert.equal((await recovered).hash, 'recovery');
  });

  it('does not treat an uncorrelated message as completion', async function () {
    const ready = compiled(worker, 0);
    worker.emit('message', {hash: 'no-request-id'});
    worker.emit('message', {requestId: 0, origin: 'http://127.0.0.1:1234'});
    assert.equal((await ready).requestId, 0);
  });

  it('rejects and removes listeners if the worker exits', async function () {
    const failed = assert.rejects(compiled(worker, 1), /compiler exited: 1/);
    worker.emit('exit', 1);
    await failed;
  });

  it('keeps its deadline when unrelated builds arrive', async function () {
    const failed = assert.rejects(compiled(worker, 2, 10), /compiler timed out/);
    worker.emit('message', {requestId: 1, hash: 'unrelated'});
    await failed;
  });
});
