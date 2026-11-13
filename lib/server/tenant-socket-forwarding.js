'use strict';

// Dormant D23 request-handling core. No listener, transport authenticator,
// credential store, storage handle or socket write implementation is selected.
const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENTS = Object.freeze({
  '/': Object.freeze(['dbAdd', 'dbUpdate', 'dbUpdateUnset', 'dbRemove', 'ack']),
  '/alarm': Object.freeze(['ack'])
});

class SocketForwardError extends Error {
  constructor (code) { super(code); this.code = code; }
}
const fail = code => { throw new SocketForwardError(code); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function supported (namespace, event, args) {
  if (!Object.hasOwn(EVENTS, namespace) || !EVENTS[namespace].includes(event) || !Array.isArray(args)) {
    fail('SOCKET_FORWARD_MESSAGE_REFUSED');
  }
}
function contextFor (context) {
  if (!record(context) || typeof context.tenant !== 'string' || !TENANT.test(context.tenant) || !record(context.credential)) {
    fail('SOCKET_FORWARD_CONTEXT_REFUSED');
  }
  return context;
}

function createForwarder ({ contextForSocket, transport, withOperation } = {}) {
  if (typeof contextForSocket !== 'function' || typeof transport !== 'function') {
    throw new TypeError('Socket forwarder requires trusted current socket context and transport');
  }
  if (withOperation !== undefined && typeof withOperation !== 'function') throw new TypeError('Socket operation lifetime must be a function');
  async function forward ({ socket, namespace, event, args, acknowledge } = {}) {
    try {
      supported(namespace, event, args);
      // Read for every operation: reauthorization must not leave an old
      // credential captured by a long-lived connection handler.
      const context = contextFor(await contextForSocket(socket, namespace));
      const execute = async () => {
      const envelope = Object.freeze({ tenant: context.tenant, credential: context.credential,
        namespace, event, args });
      const response = await transport(envelope);
      if (!record(response) || !Array.isArray(response.replyArgs)) fail('SOCKET_FORWARD_RESPONSE_INVALID');
      if (typeof acknowledge === 'function') acknowledge(...response.replyArgs);
      return Object.freeze({ delivered: true });
      };
      return withOperation ? await withOperation(context.tenant, execute) : await execute();
    } catch {
      // A failed/ambiguous forward is no acknowledgement. No automatic retry,
      // synthetic success, payload logging or provider exception disclosure.
      return Object.freeze({ delivered: false });
    }
  }
  function bind (socket, namespace) {
    if (!socket || typeof socket.on !== 'function' || !Object.hasOwn(EVENTS, namespace)) {
      throw new TypeError('Socket forwarding requires an explicit supported namespace');
    }
    for (const event of EVENTS[namespace]) {
      socket.on(event, (...received) => {
        const args = received.slice();
        const acknowledge = typeof args.at(-1) === 'function' ? args.pop() : undefined;
        return forward({ socket, namespace, event, args, acknowledge });
      });
    }
  }
  return Object.freeze({ forward, bind });
}

function createApiReceiver ({ authenticateTransport, resolveTenant, authorizeSocket, executeWrite, persistAlarmAck } = {}) {
  if ([authenticateTransport, resolveTenant, authorizeSocket, executeWrite].some(fn => typeof fn !== 'function') ||
      (persistAlarmAck !== undefined && typeof persistAlarmAck !== 'function')) {
    throw new TypeError('Socket receiver requires explicit transport/tenant/current-credential authority and existing write executor');
  }
  return async function receive (request, envelope) {
    try {
      if (await authenticateTransport(request) !== true) fail('SOCKET_FORWARD_TRANSPORT_REFUSED');
      if (!record(envelope)) fail('SOCKET_FORWARD_MESSAGE_REFUSED');
      const { namespace, event, args } = envelope;
      supported(namespace, event, args);
      const tenant = await resolveTenant(request);
      if (typeof tenant !== 'string' || !TENANT.test(tenant) || tenant !== envelope.tenant || !record(envelope.credential)) {
        fail('SOCKET_FORWARD_TENANT_REFUSED');
      }
      // Transport admission is not client authority. The socket credential is
      // checked again for this exact operation; no role credential substitution.
      const actor = await authorizeSocket({ tenant, credential: envelope.credential, namespace, event, args });
      if (!record(actor) || actor.tenant !== tenant) fail('SOCKET_FORWARD_AUTHORITY_REFUSED');
      const execute = event === 'ack' ? persistAlarmAck : executeWrite;
      if (!execute) fail('SOCKET_FORWARD_ACK_NOT_COMPOSED');
      // This callback must wrap the existing socket write step and resolve only
      // after its commit/result. It is intentionally not implemented twice here.
      const replyArgs = await execute({ tenant, actor, namespace, event, args, source: 'socket' });
      if (!Array.isArray(replyArgs)) fail('SOCKET_FORWARD_RESPONSE_INVALID');
      return Object.freeze({ replyArgs });
    } catch (error) {
      if (error instanceof SocketForwardError) throw error;
      throw new SocketForwardError('SOCKET_FORWARD_UNAVAILABLE');
    }
  };
}

module.exports = { createForwarder, createApiReceiver, SocketForwardError, EVENTS };
