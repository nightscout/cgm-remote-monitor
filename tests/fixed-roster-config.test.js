'use strict';

// covers: lib/server/internal-api/listener-config.js, lib/server/serve/operation-cohort-config.js, lib/server/serve/operation-cohort-manifest.js
// Fixed-roster api replicas: a participant row may carry its own instance
// address, separate from the service address its role is called on.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const config = require('../lib/server/serve/operation-cohort-config');
const listenerConfig = require('../lib/server/internal-api/listener-config');
const manifest = require('../lib/server/serve/operation-cohort-manifest');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const PG = 'postgresql://synthetic:synthetic@127.0.0.1/disposable_test';

function roster (selfId) {
  const row = (id, roles, address) => ({ id, roles, namespaces: ['clinical_' + id.replace(/-/g, '_')], maxMessageBytes: 100000, timeoutMs: 1000, ...(address ? { address } : {}) });
  return { version: 2, namespace: 'synthetic_window', connectionEnv: 'SYNTHETIC_PG', locks: [{ tenant: A, key: '17' }, { tenant: B, key: '19' }], participantId: selfId,
    participants: [row('api-1', ['api'], { url: 'http://api-1:7001' }), row('api-2', ['api'], { url: 'http://api-2:7001' }),
      row('evaluator', ['evaluator']), row('realtime', ['realtime']), row('tenant-admin', ['tenant-admin'])] };
}
// Every process sees the same peer list: api by its service name.
const peers = { NS_API_INTERNAL_URL: 'http://api-internal:7001', NS_EVALUATOR_INTERNAL_URL: 'http://evaluator:7001',
  NS_REALTIME_INTERNAL_URL: 'http://realtime:7001', NS_TENANT_ADMIN_INTERNAL_URL: 'http://tenant-admin:7001' };

describe('Fixed-roster api replicas: instance addresses beside the service address', function () {
  let dir, file;
  beforeEach(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-roster-')); file = path.join(dir, 'operation.json'); });
  afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  const load = (value, extra = {}) => {
    fs.writeFileSync(file, JSON.stringify(value));
    return config.load({ MULTITENANT_OPERATION_CONFIG: file, SYNTHETIC_PG: PG, NS_SERVE_INTERNAL_HOST: '0.0.0.0', NS_SERVE_INTERNAL_PORT: '7001', ...peers, ...extra });
  };

  it('loads two api participants on their own addresses while the api service address stays the routing destination', function () {
    for (const self of ['api-1', 'api-2']) {
      const parsed = load(roster(self));
      assert.equal(parsed.participantId, self);
      assert.deepEqual(parsed.participants.map(row => row.id), ['api-1', 'api-2', 'evaluator', 'realtime', 'tenant-admin']);
      assert.equal(parsed.participants[0].endpoint.url, 'http://api-1:7001/');
      assert.equal(parsed.participants[1].endpoint.url, 'http://api-2:7001/');
      assert.equal(parsed.participants[2].endpoint.url, 'http://evaluator:7001/', 'a role with one participant keeps its role address');
      assert.ok(parsed.participants.every(manifest.isParticipant));
    }
    // The application route is untouched: realtime calls api on the service.
    const realtime = listenerConfig.resolve(['realtime'], { NS_SERVE_INTERNAL_HOST: '0.0.0.0', NS_SERVE_INTERNAL_PORT: '7001', ...peers });
    assert.equal(realtime.peer('api', { maxBytes: 1, timeoutMs: 1 }).url, 'http://api-internal:7001/');
  });

  it('refuses a replicated role row without its own address', function () {
    const value = roster('api-1'); delete value.participants[1].address;
    assert.throws(() => load(value), /invalid explicit/);
  });

  it('refuses a participant addressed by a service destination (service-aliased participant)', function () {
    const value = roster('api-1'); value.participants[1].address = { url: 'http://api-internal:7001' };
    assert.throws(() => load(value), /invalid explicit/);
    const own = roster('api-1'); own.participants[0].address = { url: 'http://api-internal:7001' };
    assert.throws(() => load(own), /invalid explicit/, 'nor this process by the service name');
  });

  it('refuses two participants on one address, and a self address that cannot be this listener', function () {
    const twin = roster('api-1'); twin.participants[1].address = { url: 'http://api-1:7001' };
    assert.throws(() => load(twin), /invalid explicit/);
    const port = roster('api-1'); port.participants[0].address = { url: 'http://api-1:7002' };
    assert.throws(() => load(port), /invalid explicit/);
    const socket = roster('api-1'); socket.participants[0].address = { socket: '/synthetic/api-1.sock' };
    assert.throws(() => load(socket), /invalid explicit/, 'a network listener cannot be named by a socket');
    for (const bad of [{ url: 'http://api-1:7001', socket: '/x.sock' }, { url: 'http://u:p@api-1:7001' }, { endpoint: 'api-1' }, 'http://api-1:7001']) {
      const value = roster('api-2'); value.participants[0].address = bad;
      assert.throws(() => load(value), /invalid explicit/, JSON.stringify(bad));
    }
  });

  it('accepts a self row on its own address at the role start check, and refuses another port', function () {
    const internal = listenerConfig.resolve(['api'], { NS_SERVE_INTERNAL_HOST: '0.0.0.0', NS_SERVE_INTERNAL_PORT: '7001', ...peers });
    assert.equal(listenerConfig.canName({ url: 'http://api-1:7001/' }, internal.listen), true);
    assert.equal(listenerConfig.canName({ url: 'http://api-1:7002/' }, internal.listen), false);
    assert.equal(listenerConfig.canName({ socketPath: '/run/ns-ipc/api.sock' }, internal.listen), false);
  });
});
