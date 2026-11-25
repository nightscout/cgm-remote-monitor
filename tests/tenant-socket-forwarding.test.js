'use strict';

// Source/injected transport tests only: no Socket.IO listener, database,
// current production write handler or Android application is executed here.
const assert = require('node:assert/strict');
const { createForwarder, createApiReceiver, EVENTS } = require('../lib/server/tenant-socket-forwarding');
const patterns = require('./fixtures/socket-forwarding/patterns');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function fixture () {
  const credential = patterns.authorization();
  const roleCredential = { secret: 'synthetic-role-credential' };
  const state = { tenant: A, credential, requestTenant: A, revoked: false, admitted: true };
  const calls = [], acks = [];
  const receiver = createApiReceiver({
    async authenticateTransport () { return state.admitted; },
    async resolveTenant () { return state.requestTenant; },
    async authorizeSocket (operation) {
      calls.push(['authorize', operation]);
      return !state.revoked && operation.credential === credential && operation.tenant === A
        ? { tenant: A, principal: 'synthetic-subject' } : null;
    },
    async executeWrite (operation) {
      calls.push(['write', operation]);
      return operation.event === 'dbAdd' ? [[{ _id: 'synthetic-server-id' }]] : [{ result: 'success' }];
    },
    async persistAlarmAck (operation) { acks.push(operation); return []; }
  });
  const forwarder = createForwarder({
    contextForSocket: async () => ({ tenant: state.tenant, credential: state.credential }),
    transport: envelope => receiver({}, envelope)
  });
  return { receiver, forwarder, state, credential, roleCredential, calls, acks };
}

describe('dormant D23 socket forwarding source contract', function () {
  it('requires every trusted dependency without selecting a transport or storage provider', function () {
    assert.throws(() => createForwarder(), TypeError);
    assert.throws(() => createApiReceiver(), TypeError);
    assert.throws(() => createApiReceiver({ authenticateTransport () {}, resolveTenant () {},
      authorizeSocket () {}, executeWrite () {}, persistAlarmAck: true }), TypeError);
  });

  it('preserves every data event, argument and socket credential while selecting socket attribution', async function () {
    const f = fixture();
    for (const event of EVENTS['/'].filter(name => name !== 'ack')) {
      const message = { collection: 'treatments', _id: 'synthetic-id', data: { nested: [false, null, 0] }, source: 'untrusted-value' };
      const args = [message], replies = [];
      const result = await f.forwarder.forward({ socket: {}, namespace: '/', event, args,
        acknowledge: (...received) => replies.push(received) });
      assert.equal(result.delivered, true);
      assert.equal(replies.length, 1);
      const operation = f.calls.filter(call => call[0] === 'write').at(-1)[1];
      assert.equal(operation.event, event);
      assert.equal(operation.args, args);
      assert.equal(f.calls.filter(call => call[0] === 'authorize').at(-1)[1].credential, f.credential);
      assert.equal(operation.source, 'socket');
      assert.equal(operation.tenant, A);
      assert.deepEqual(message.data, { nested: [false, null, 0] });
      assert.deepEqual(replies[0], event === 'dbAdd' ? [[{ _id: 'synthetic-server-id' }]] : [{ result: 'success' }]);
    }
  });

  it('does not acknowledge before the injected API operation resolves, including an ambiguous failure', async function () {
    let resolve, reject, replies = 0;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const forwarder = createForwarder({ contextForSocket: () => ({ tenant: A, credential: {} }), transport: () => pending });
    const running = forwarder.forward({ namespace: '/', event: 'dbAdd', args: [patterns.addTreatment()],
      acknowledge: () => { replies++; } });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(replies, 0, 'no acknowledgement may precede API confirmation');
    reject(new Error('synthetic commit acknowledgement unavailable'));
    assert.equal((await running).delivered, false);
    assert.equal(replies, 0, 'failed forward must not synthesize success');
    resolve({ replyArgs: [] });
  });

  it('relays the exact acknowledgement argument vector after confirmation', async function () {
    let confirm;
    const original = [[{ _id: 'synthetic-id', nested: { value: null } }], false, 0];
    const pending = new Promise(resolve => { confirm = resolve; });
    const forwarder = createForwarder({ contextForSocket: () => ({ tenant: A, credential: {} }), transport: () => pending });
    let reply;
    const running = forwarder.forward({ namespace: '/', event: 'dbAdd', args: [patterns.addTreatment()],
      acknowledge: (...args) => { reply = args; } });
    assert.equal(reply, undefined);
    confirm({ replyArgs: original });
    assert.equal((await running).delivered, true);
    assert.deepEqual(reply, original);
  });

  it('reads current socket credentials and API authority on every operation', async function () {
    const f = fixture(); let replies = 0;
    const input = { namespace: '/', event: 'dbAdd', args: [patterns.addTreatment()], acknowledge: () => { replies++; } };
    assert.equal((await f.forwarder.forward(input)).delivered, true);
    f.state.revoked = true;
    assert.equal((await f.forwarder.forward(input)).delivered, false);
    f.state.revoked = false; f.state.credential = f.roleCredential;
    assert.equal((await f.forwarder.forward(input)).delivered, false);
    assert.equal(replies, 1);
    assert.equal(f.calls.filter(call => call[0] === 'write').length, 1);
  });

  it('never promotes transport role admission into client or cross-tenant write authority', async function () {
    const f = fixture();
    f.state.credential = f.roleCredential;
    const result = await f.forwarder.forward({ namespace: '/', event: 'dbAdd', args: [patterns.addTreatment()],
      acknowledge: () => assert.fail('role admission must not acknowledge a client write') });
    assert.equal(result.delivered, false);
    assert.equal(f.calls.some(call => call[0] === 'write'), false);
    f.state.credential = f.credential; f.state.tenant = B; f.state.requestTenant = B;
    assert.equal((await f.forwarder.forward({ namespace: '/', event: 'dbAdd', args: [patterns.addTreatment()] })).delivered, false);
    assert.equal(f.calls.some(call => call[0] === 'write'), false);
  });

  it('requires independent tenant resolution and transport admission before client authority', async function () {
    const f = fixture();
    const envelope = { tenant: A, credential: f.credential, namespace: '/', event: 'dbRemove', args: [{}] };
    f.state.requestTenant = B;
    await assert.rejects(f.receiver({}, envelope), { code: 'SOCKET_FORWARD_TENANT_REFUSED' });
    f.state.admitted = false;
    await assert.rejects(f.receiver({}, envelope), { code: 'SOCKET_FORWARD_TRANSPORT_REFUSED' });
    assert.deepEqual(f.calls, []);
  });

  it('preserves ack arguments and passes the verified tenant to a separately composed persistence callback', async function () {
    const f = fixture();
    const args = patterns.alarmAck();
    for (const namespace of ['/', '/alarm']) {
      assert.equal((await f.forwarder.forward({ namespace, event: 'ack', args })).delivered, true);
      assert.equal(f.acks.at(-1).tenant, A, 'ack bookkeeping must retain the verified tenant');
      assert.equal(f.acks.at(-1).args, args);
      assert.equal(f.acks.at(-1).source, 'socket');
    }
    assert.equal(f.calls.some(call => call[0] === 'write'), false);
  });

  it('refuses ack until its persistence dependency is explicitly composed', async function () {
    const receiver = createApiReceiver({ authenticateTransport: () => true, resolveTenant: () => A,
      authorizeSocket: () => ({ tenant: A }), executeWrite: () => assert.fail('ack cannot use clinical writer') });
    await assert.rejects(receiver({}, { tenant: A, credential: {}, namespace: '/alarm', event: 'ack', args: [2, 'group', 1] }),
      { code: 'SOCKET_FORWARD_ACK_NOT_COMPOSED' });
  });

  it('does not retry or deduplicate locally when a client repeats dbAdd', async function () {
    const f = fixture(); const args = [patterns.addTreatment()]; const replies = [];
    for (let i = 0; i < 2; i++) {
      await f.forwarder.forward({ namespace: '/', event: 'dbAdd', args, acknowledge: (...reply) => replies.push(reply) });
    }
    assert.equal(f.calls.filter(call => call[0] === 'write').length, 2);
    assert.deepEqual(replies[0], replies[1]);
    assert.equal(patterns.addedId(replies[0]), 'synthetic-server-id');
    assert.equal(patterns.updated([{ result: 'success' }]), true);
    assert.equal(patterns.updated([{ result: 'Missing _id' }]), true);
    assert.equal(patterns.updated([{ result: 'Not permitted' }]), false);
    // Real write-step dedupe and stored cardinality remain runtime acceptance.
  });

  it('rejects unknown operations and malformed transport responses without an acknowledgement', async function () {
    const f = fixture();
    await assert.rejects(f.receiver({}, { tenant: A, credential: {}, namespace: '/storage', event: 'dbAdd', args: [] }),
      { code: 'SOCKET_FORWARD_MESSAGE_REFUSED' });
    const bad = createForwarder({ contextForSocket: () => ({ tenant: A, credential: {} }), transport: () => ({ result: 'success' }) });
    assert.equal((await bad.forward({ namespace: '/', event: 'dbAdd', args: [],
      acknowledge: () => assert.fail('malformed transport response must not acknowledge') })).delivered, false);
  });

  it('sanitizes provider/executor failures without logging or returning credentials', async function () {
    const receiver = createApiReceiver({ authenticateTransport: () => true, resolveTenant: () => A,
      authorizeSocket: () => { throw new Error('synthetic-private-credential'); }, executeWrite () {} });
    await assert.rejects(receiver({}, { tenant: A, credential: {}, namespace: '/', event: 'dbAdd', args: [] }), error =>
      error.code === 'SOCKET_FORWARD_UNAVAILABLE' && error.message === 'SOCKET_FORWARD_UNAVAILABLE' && error.cause === undefined);
  });

  it('binds only explicit namespace events and separates a callback from unchanged message arguments', async function () {
    const listeners = new Map(); const socket = { on: (name, fn) => listeners.set(name, fn) };
    const f = fixture(); f.forwarder.bind(socket, '/');
    assert.deepEqual([...listeners.keys()], EVENTS['/']);
    const message = patterns.addDeviceStatus(); let received;
    await listeners.get('dbAdd')(message, (...args) => { received = args; });
    assert.equal(patterns.addedId(received), 'synthetic-server-id');
    assert.equal(f.calls.filter(call => call[0] === 'write')[0][1].args[0], message);
    assert.throws(() => f.forwarder.bind(socket, '/unknown'), TypeError);
  });

  it('pins the source pattern and keeps authorization outside the write adapter', function () {
    assert.equal(patterns.provenance.commit, '05a3433598ac49a3ecafcbd218fc5c1fc39c8719');
    const message = patterns.authorization();
    assert.equal(message.client, 'Android_synthetic');
    assert.equal(message.status, true);
    assert.ok(message.secret);
    assert.throws(() => patterns.addedId([{ result: 'Not permitted' }]), /ADD_ACK_INVALID/);
    assert.equal(EVENTS['/'].includes('authorize'), false);
  });

  it('carries the pinned envelope sequence and withheld-ack retry without rewriting client arguments', async function () {
    const steps = patterns.sequence('synthetic-server-id');
    assert.equal(steps[0].event, 'authorize');
    assert.equal(steps[1].withholdAcknowledgement, true);
    assert.equal(steps[2].retry, true);
    assert.equal(steps[1].args[0], steps[2].args[0]);
    const f = fixture(), replies = [];
    for (const step of steps.slice(1)) {
      const acknowledge = step.withholdAcknowledgement || step.event === 'ack' ? undefined
        : (...args) => { replies.push({ event: step.event, args }); };
      assert.equal((await f.forwarder.forward({ ...step, acknowledge })).delivered, true);
    }
    assert.equal(patterns.addedId(replies[0].args), 'synthetic-server-id');
    assert.equal(patterns.updated(replies[1].args), true);
    assert.equal(f.calls.filter(call => call[0] === 'write').length, 4);
    assert.equal(f.acks.length, 1);
    // These are injected callback observations, not stored cardinality or
    // confirmation that the baseline handles the main-namespace alarm event.
  });
});
