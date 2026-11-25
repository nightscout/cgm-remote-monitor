'use strict';

// serve.internal configuration (decision internal-listener-ory-pattern):
// host/port or socket, each overridable from NS_SERVE_INTERNAL_*, a unix-socket
// default under the runtime directory, and peer addresses by role.
const assert = require('node:assert/strict');
const config = require('../lib/server/internal-api/listener-config');
const LIMITS = { maxBytes: 1000, timeoutMs: 500 };

describe('serve.internal listener configuration', function () {
  it('defaults to a unix socket under the runtime directory, never a network bind', function () {
    const plain = config.resolve(['api'], {});
    assert.deepEqual(plain.listen, { socketPath: '/run/nightscout/api.sock' });
    assert.equal(plain.defaultSocket, true);
    assert.equal(Object.hasOwn(plain.listen, 'url'), false, 'INTERNAL_DEFAULT_IS_NOT_NETWORK');
    assert.equal(plain.shutdownTimeoutMs, config.DEFAULT_SHUTDOWN_TIMEOUT_MS);
    const xdg = config.resolve(['realtime', 'api'], { XDG_RUNTIME_DIR: '/run/user/1000' });
    assert.deepEqual(xdg.listen, { socketPath: '/run/user/1000/nightscout/api+realtime.sock' }, 'roles sorted into the default name');
    assert.deepEqual(config.resolve(['api'], { XDG_RUNTIME_DIR: 'relative' }).listen, { socketPath: '/run/nightscout/api.sock' });
  });
  it('takes host/port or socket from config, each key overridden from the environment', function () {
    assert.deepEqual(config.resolve(['api'], {}, { socket: '/srv/ipc/api.sock' }).listen, { socketPath: '/srv/ipc/api.sock' });
    assert.deepEqual(config.resolve(['api'], { NS_SERVE_INTERNAL_SOCKET: '/srv/env/api.sock' }, { socket: '/srv/ipc/api.sock' }).listen, { socketPath: '/srv/env/api.sock' });
    const network = config.resolve(['api'], { NS_SERVE_INTERNAL_PORT: '7001' }, { host: '10.0.0.5', port: 6001 });
    assert.deepEqual(network.listen, { url: 'http://10.0.0.5:7001/', trust: 'network', bindHost: '10.0.0.5' });
    assert.equal(network.defaultSocket, false);
    const wildcard = config.resolve(['api'], { NS_SERVE_INTERNAL_HOST: '0.0.0.0', NS_SERVE_INTERNAL_PORT: '7001' });
    assert.deepEqual(wildcard.listen, { url: 'http://0.0.0.0:7001/', trust: 'network', bindHost: '0.0.0.0' });
    assert.deepEqual(wildcard.peer('api', LIMITS), { url: 'http://127.0.0.1:7001/', trust: 'network', ...LIMITS }, 'co-resident caller dials loopback');
    const v6 = config.resolve(['api'], { NS_SERVE_INTERNAL_HOST: '::', NS_SERVE_INTERNAL_PORT: '7001' });
    assert.equal(v6.peer('api', LIMITS).url, 'http://[::1]:7001/');
    assert.equal(config.resolve(['api'], { NS_SERVE_INTERNAL_SHUTDOWN_TIMEOUT_MS: '2500' }).shutdownTimeoutMs, 2500);
    assert.equal(config.resolve(['api'], {}, { shutdownTimeoutMs: 0 }).shutdownTimeoutMs, 0);
  });
  it('refuses partial or mixed listener settings and unknown keys', function () {
    for (const [source, value] of [
      [{ NS_SERVE_INTERNAL_HOST: '127.0.0.1' }, {}],
      [{ NS_SERVE_INTERNAL_PORT: '7001' }, {}],
      [{ NS_SERVE_INTERNAL_SOCKET: '/srv/a.sock', NS_SERVE_INTERNAL_PORT: '7001', NS_SERVE_INTERNAL_HOST: '127.0.0.1' }, {}],
      [{ NS_SERVE_INTERNAL_SOCKET: '/srv/a.sock' }, { host: '127.0.0.1', port: 7001 }],
      [{ NS_SERVE_INTERNAL_HOST: '127.0.0.1', NS_SERVE_INTERNAL_PORT: '0' }, {}],
      [{ NS_SERVE_INTERNAL_HOST: '127.0.0.1', NS_SERVE_INTERNAL_PORT: '70000' }, {}],
      [{ NS_SERVE_INTERNAL_HOST: 'a/b', NS_SERVE_INTERNAL_PORT: '7001' }, {}],
      [{ NS_SERVE_INTERNAL_SOCKET: 'relative.sock' }, {}],
      [{ NS_SERVE_INTERNAL_SOCKET: '/srv/../a.sock' }, {}],
      [{ NS_SERVE_INTERNAL_SOCKET: '/' + 'x'.repeat(120) + '.sock' }, {}],
      [{ NS_SERVE_INTERNAL_SHUTDOWN_TIMEOUT_MS: '-1' }, {}],
      [{ NS_SERVE_INTERNAL_SHUTDOWN_TIMEOUT_MS: '60001' }, {}],
      [{}, { contracts: ['alarm-delivery'] }],
      [{}, { endpoint: { urlEnv: 'X', trust: 'network' } }]
    ]) assert.throws(() => config.resolve(['api'], source, value), { code: 'INTERNAL_LISTENER_CONFIG_REFUSED' }, JSON.stringify([source, value]));
    for (const names of [[], ['api', 'api'], ['admin'], 'api']) assert.throws(() => config.resolve(names, {}), { code: 'INTERNAL_LISTENER_CONFIG_REFUSED' });
  });
  it('gives callers peer addresses: explicit URL or socket, else the peer default socket', function () {
    const internal = config.resolve(['evaluator'], { NS_API_INTERNAL_URL: 'http://api-internal.nightscout.svc.cluster.local:1401',
      NS_REALTIME_INTERNAL_SOCKET: '/srv/ipc/realtime.sock', XDG_RUNTIME_DIR: '/run/user/1000' });
    assert.deepEqual(internal.peer('api', LIMITS), { url: 'http://api-internal.nightscout.svc.cluster.local:1401/', trust: 'network', ...LIMITS });
    assert.deepEqual(internal.peer('realtime', LIMITS), { socketPath: '/srv/ipc/realtime.sock', ...LIMITS });
    assert.deepEqual(internal.peer('tenant-admin', LIMITS), { socketPath: '/run/user/1000/nightscout/tenant-admin.sock', ...LIMITS });
    assert.deepEqual(internal.peer('evaluator', LIMITS), { socketPath: '/run/user/1000/nightscout/evaluator.sock', ...LIMITS }, 'own role dials own listener');
    for (const source of [{ NS_API_INTERNAL_URL: 'http://a:1', NS_API_INTERNAL_SOCKET: '/srv/a.sock' }, { NS_API_INTERNAL_URL: 'https://a:1401' },
      { NS_API_INTERNAL_URL: 'http://a' }, { NS_API_INTERNAL_URL: 'http://a:1401/path' }, { NS_API_INTERNAL_URL: 'http://u:p@a:1401' },
      { NS_TENANT_ADMIN_INTERNAL_SOCKET: 'relative' }]) {
      assert.throws(() => config.resolve(['evaluator'], source), { code: 'INTERNAL_LISTENER_CONFIG_REFUSED' }, JSON.stringify(source));
    }
    assert.throws(() => internal.peer('admin', LIMITS), { code: 'INTERNAL_LISTENER_CONFIG_REFUSED' });
    assert.throws(() => internal.peer('api'), { code: 'INTERNAL_LISTENER_CONFIG_REFUSED' });
  });
  it('serves co-resident roles on the own listener; a peer address cannot move them', function () {
    const source = { NS_SERVE_INTERNAL_SOCKET: '/srv/ipc/api+realtime.sock' };
    const internal = config.resolve(['api', 'realtime'], source);
    assert.deepEqual(internal.peer('api', LIMITS), { socketPath: '/srv/ipc/api+realtime.sock', ...LIMITS });
    assert.deepEqual(internal.participant(['api', 'realtime'], LIMITS), { socketPath: '/srv/ipc/api+realtime.sock', ...LIMITS });
    assert.doesNotThrow(() => config.resolve(['api', 'realtime'], { ...source, NS_API_INTERNAL_SOCKET: source.NS_SERVE_INTERNAL_SOCKET }), 'naming the same address is allowed');
    for (const moved of [{ NS_API_INTERNAL_SOCKET: '/srv/ipc/api.sock' }, { NS_REALTIME_INTERNAL_URL: 'http://realtime-internal:1402' }]) {
      assert.throws(() => config.resolve(['api', 'realtime'], { ...source, ...moved }), /serves on its own serve\.internal/, 'INTERNAL_CONTRACT_NOT_MOVED_BY_CONFIG');
    }
    const network = { NS_SERVE_INTERNAL_HOST: '0.0.0.0', NS_SERVE_INTERNAL_PORT: '7001' };
    assert.equal(config.resolve(['api'], { ...network, NS_API_INTERNAL_URL: 'http://api:7001' }).peer('api', LIMITS).url, 'http://127.0.0.1:7001/',
      'a shared peer list may name this process by service name; co-resident calls still use the own listener');
    for (const moved of [{ NS_API_INTERNAL_URL: 'http://api:7002' }, { NS_API_INTERNAL_SOCKET: '/srv/ipc/api.sock' }]) {
      assert.throws(() => config.resolve(['api'], { ...network, ...moved }), /serves on its own serve\.internal/);
    }
    const separate = config.resolve(['evaluator'], { NS_API_INTERNAL_SOCKET: '/srv/ipc/api.sock', NS_REALTIME_INTERNAL_SOCKET: '/srv/ipc/realtime.sock' });
    assert.throws(() => separate.participant(['api', 'realtime'], LIMITS), /different addresses/, 'one participant has one address');
    assert.equal(config.key({ url: 'http://api-internal:80/' }), config.key({ url: 'http://api-internal/' }));
  });
});
