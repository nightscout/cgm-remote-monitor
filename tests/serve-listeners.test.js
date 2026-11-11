'use strict';

// covers: lib/server/serve/listeners.js, lib/server/serve/roles.js, lib/server/serve/index.js, lib/cli/commands/multitenant.js, lib/cli/commands/healthcheck.js

// PLAT-SERVE (D21): the role list `nightscout multitenant` takes, and the listener
// rules. Nothing here boots a server or needs a database. The plane rule is
// exercised through a stub internal-plane role and on the real `admin` role
// definition; admin's operator runtime is tests/admin-role.test.js.

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const serve = require('../lib/server/serve');
const listeners = require('../lib/server/serve/listeners');
const { ROLES } = require('../lib/server/serve/roles');
const healthcheck = require('../lib/cli/commands/healthcheck');

const root = path.resolve(__dirname, '..');
const BIN = path.join(root, 'bin/nightscout.js');

function cleanEnv (extra) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'SystemRoot', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return Object.assign(env, extra);
}

function cli (args, env) {
  return spawnSync(process.execPath, [BIN].concat(args), { cwd: root, encoding: 'utf8', timeout: 15000, env: env || cleanEnv() });
}

// A consumer role like api, and an internal-plane role like admin.
const STUB_ROLES = {
  front: { plane: 'consumer', prefix: 'FRONT', consumerDefault: true, start: () => null }
  , side: { plane: 'consumer', prefix: 'SIDE', start: () => null }
  , backstage: { plane: 'internal', prefix: 'BACKSTAGE', defaultHost: '127.0.0.1', defaultPort: 2338, start: () => null }
};
const FALLBACK = { host: null, port: 1337 };

function refused (fn, pattern) {
  assert.throws(fn, err => err instanceof listeners.ListenerError && pattern.test(err.message));
}

describe('nightscout multitenant: roles (PLAT-SERVE)', function () {

  it('accepts the implemented explicitly configured preview roles', function () {
    assert.deepEqual(serve.parseRoles(['api']), ['api']);
    for (const [name, role] of Object.entries(ROLES)) assert.equal(role.multitenant === true, ['api', 'evaluator', 'realtime', 'vcpool', 'tenant-admin', 'admin'].includes(name), name);
  });

  it('refuses an unknown role, an empty one, a repeated one, and a missing list', function () {
    const roles = { api: Object.assign({}, ROLES.api, { multitenant: true }) };
    for (const args of [['bogus'], ['api,bogus'], ['api,'], ['api,api'], [], ['api', 'extra']]) {
      assert.throws(() => serve.parseRoles(args, roles), serve.RoleError, JSON.stringify(args));
    }
  });

  it('names every role that cannot be served yet', function () {
    // Every role in the table has a preview runtime; a role without one is refused by name.
    assert.deepEqual(Object.keys(ROLES).filter(name => !(ROLES[name].start && ROLES[name].multitenant)), []);
    const roles = { ...ROLES, pending: { listener: false, storage: 'none', feed: false, egress: false } };
    assert.throws(() => serve.parseRoles(['pending'], roles), /not yet available: pending\./);
    assert.throws(() => serve.parseRoles(['api,pending,realtime'], roles), /not yet available: pending/);
    assert.deepEqual(serve.parseRoles(['admin']), ['admin']);
    assert.deepEqual(serve.parseRoles(['vcpool']), ['vcpool']);
  });

  it('exits 64 for an unknown role and 78 for a role without its configuration', function () {
    const unknown = cli(['multitenant', 'bogus']);
    assert.equal(unknown.status, 64);
    assert.match(unknown.stderr, /unknown role: bogus/);
    for (const name of ['vcpool', 'api,vcpool']) {
      const result = cli(['multitenant', name]);
      assert.equal(result.status, 78, name);
      assert.match(result.stderr, /requires MULTITENANT_/, name);
    }
    assert.equal(cli(['multitenant']).status, 64);
  });

  it('refuses realtime without explicit preview configuration before any socket or storage boot', function () {
    const result = cli(['multitenant', 'realtime']);
    assert.equal(result.status, 78);
    assert.match(result.stderr, /REALTIME_CONFIG_REFUSED/);
  });

  it('refuses evaluator without explicit preview configuration before any storage boot', function () {
    const result = cli(['multitenant', 'evaluator']);
    assert.equal(result.status, 78);
    assert.match(result.stderr, /explicit evaluator preview configuration/);
  });

  it('refuses headless tenant-admin without explicit preview configuration before any storage boot', function () {
    const result = cli(['multitenant', 'tenant-admin']);
    assert.equal(result.status, 78);
    assert.match(result.stderr, /MULTITENANT_OWNER_PREVIEW_CONFIG/);
    assert.doesNotMatch(result.stdout + result.stderr, /Listening|postgres:|API_SECRET|Mongo/);
  });

  it('refuses api without explicit preview configuration before single-tenant bootstrap', function () {
    const result = cli(['multitenant', 'api']);
    assert.equal(result.status, 78);
    assert.match(result.stderr, /MULTITENANT_PREVIEW_CONFIG/);
    assert.doesNotMatch(result.stdout + result.stderr, /API_SECRET|Mongo|Listening/);
  });

});

describe('multitenant role listeners (PLAT-SERVE)', function () {

  it('reads <PREFIX>_HOSTNAME and <PREFIX>_PORT, and api falls back to HOSTNAME and PORT', function () {
    assert.deepEqual(listeners.resolve(['api'], {}, { host: 'example.test', port: 1337 })
      .map(s => [s.role, s.host, s.port]), [['api', 'example.test', 1337]]);
    assert.deepEqual(listeners.resolve(['api'], { API_HOSTNAME: '127.0.0.1', API_PORT: '8080' }, { host: null, port: 1337 })
      .map(s => [s.role, s.host, s.port]), [['api', '127.0.0.1', 8080]]);
    // Present but empty: every interface, as NIGHTSCOUT_HOSTNAME= means for single.
    assert.equal(listeners.resolve(['api'], { API_HOSTNAME: '' }, { host: 'x.test', port: 1 })[0].host, null);
    // Azure's connection-string prefix and lowercase names, as lib/server/env.js reads them.
    assert.equal(listeners.resolve(['api'], { api_port: '81' }, FALLBACK)[0].port, 81);
  });

  it('gives admin 127.0.0.1:1338 by default, which the plane rule accepts', function () {
    const [spec] = listeners.resolve(['admin'], {}, FALLBACK);
    assert.deepEqual([spec.host, spec.port, spec.plane, spec.acknowledgeName],
      ['127.0.0.1', 1338, 'internal', 'ADMIN_INSECURE_BIND_ACKNOWLEDGED']);
  });

  it('refuses two roles on one listener, and accepts them on two', function () {
    refused(() => listeners.resolve(['front', 'side'], { SIDE_PORT: '1337' }, FALLBACK, STUB_ROLES), /would share a listener/);
    refused(() => listeners.resolve(['front', 'side'], { FRONT_HOSTNAME: '10.0.0.5', SIDE_HOSTNAME: '0.0.0.0', SIDE_PORT: '1337' }, FALLBACK, STUB_ROLES), /would share a listener/);
    assert.equal(listeners.resolve(['front', 'side'], { SIDE_PORT: '1339' }, FALLBACK, STUB_ROLES).length, 2);
    assert.equal(listeners.resolve(['front', 'side'], { FRONT_HOSTNAME: '10.0.0.5', SIDE_HOSTNAME: '10.0.0.6', SIDE_PORT: '1337' }, FALLBACK, STUB_ROLES).length, 2);
  });

  describe('plane rule, through a stub internal-plane role', function () {

    it('accepts the internal role on its own loopback address', function () {
      const specs = listeners.resolve(['front', 'backstage'], { FRONT_HOSTNAME: '10.0.0.5' }, FALLBACK, STUB_ROLES);
      assert.deepEqual(specs.map(s => [s.role, s.host, s.port]), [['front', '10.0.0.5', 1337], ['backstage', '127.0.0.1', 2338]]);
      // Alone, with the consumer listener on every interface (HOSTNAME unset).
      assert.equal(listeners.resolve(['backstage'], {}, FALLBACK, STUB_ROLES).length, 1);
      assert.equal(listeners.resolve(['backstage'], { BACKSTAGE_HOSTNAME: '::1' }, FALLBACK, STUB_ROLES).length, 1);
    });

    it('accepts the consumer listener\'s address on another port, loopback or acknowledged non-loopback', function () {
      for (const source of [
        { FRONT_HOSTNAME: '10.0.0.5', BACKSTAGE_HOSTNAME: '10.0.0.5', BACKSTAGE_INSECURE_BIND_ACKNOWLEDGED: 'true' }
        , { FRONT_HOSTNAME: '127.0.0.1', BACKSTAGE_HOSTNAME: '127.0.0.1' }
        , { FRONT_HOSTNAME: 'localhost', BACKSTAGE_HOSTNAME: '127.0.0.1' }
        , { FRONT_HOSTNAME: '[::1]', BACKSTAGE_HOSTNAME: '::1' }
      ]) {
        assert.deepEqual(listeners.resolve(['front', 'backstage'], source, FALLBACK, STUB_ROLES).map(s => s.port), [1337, 2338]);
        assert.equal(listeners.resolve(['backstage'], source, FALLBACK, STUB_ROLES).length, 1);
      }
      // The consumer address can come from the fallback (HOSTNAME) too.
      assert.equal(listeners.resolve(['backstage'], {}, { host: '127.0.0.1', port: 1337 }, STUB_ROLES)[0].host, '127.0.0.1');
    });

    it('refuses the consumer listener\'s port on its address, even when not serving the consumer role', function () {
      for (const source of [
        { FRONT_HOSTNAME: '10.0.0.5', BACKSTAGE_HOSTNAME: '10.0.0.5', BACKSTAGE_PORT: '1337', BACKSTAGE_INSECURE_BIND_ACKNOWLEDGED: 'true' }
        , { FRONT_HOSTNAME: '127.0.0.1', BACKSTAGE_HOSTNAME: '127.0.0.1', BACKSTAGE_PORT: '1337' }
        , { FRONT_HOSTNAME: 'localhost', BACKSTAGE_HOSTNAME: '127.0.0.1', BACKSTAGE_PORT: '1337' }
        , { FRONT_HOSTNAME: '[::1]', BACKSTAGE_HOSTNAME: '::1', BACKSTAGE_PORT: '1337' }
        // The consumer on every interface takes its port on every address.
        , { BACKSTAGE_PORT: '1337' }
      ]) {
        refused(() => listeners.resolve(['backstage'], source, FALLBACK, STUB_ROLES), /would share the consumer listener/);
        assert.throws(() => listeners.resolve(['front', 'backstage'], source, FALLBACK, STUB_ROLES), listeners.ListenerError);
      }
      refused(() => listeners.resolve(['backstage'], { BACKSTAGE_PORT: '1337' }, { host: '127.0.0.1', port: 1337 }, STUB_ROLES), /would share the consumer listener/);
      // Another address on the consumer's port is a listener of its own.
      assert.equal(listeners.resolve(['backstage'], { FRONT_HOSTNAME: '127.0.0.1', BACKSTAGE_HOSTNAME: '127.0.0.2', BACKSTAGE_PORT: '1337' }, FALLBACK, STUB_ROLES).length, 1);
    });

    it('opens both listeners on one address with different ports', async function () {
      const port = await new Promise(resolve => { const probe = require('net').createServer().listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); }); });
      const specs = listeners.resolve(['api', 'admin'], { API_HOSTNAME: '127.0.0.1', API_PORT: String(port), ADMIN_HOSTNAME: '127.0.0.1', ADMIN_PORT: '0' }, FALLBACK);
      const servers = [];
      try {
        for (const spec of specs) servers.push(await listeners.open(spec, (req, res) => res.end(spec.role)));
        assert.deepEqual(servers.map(server => server.address().address), ['127.0.0.1', '127.0.0.1']);
        assert.notEqual(servers[0].address().port, servers[1].address().port);
      } finally { for (const server of servers) await listeners.close(server); }
    });

    it('refuses every interface, acknowledged or not', function () {
      for (const host of ['', '0.0.0.0', '::', '[::]']) {
        refused(() => listeners.resolve(['backstage'], { BACKSTAGE_HOSTNAME: host, BACKSTAGE_INSECURE_BIND_ACKNOWLEDGED: 'true' }, FALLBACK, STUB_ROLES), /every interface/);
      }
    });

    it('refuses a non-loopback address unless <PREFIX>_INSECURE_BIND_ACKNOWLEDGED=true', function () {
      for (const ack of [undefined, '', 'false', '1', 'yes']) {
        const source = { BACKSTAGE_HOSTNAME: '10.0.0.9' };
        if (ack !== undefined) source.BACKSTAGE_INSECURE_BIND_ACKNOWLEDGED = ack;
        refused(() => listeners.resolve(['backstage'], source, FALLBACK, STUB_ROLES), /not a loopback address.*BACKSTAGE_INSECURE_BIND_ACKNOWLEDGED=true/);
      }
      for (const ack of ['true', 'TRUE']) {
        assert.equal(listeners.resolve(['backstage'], { BACKSTAGE_HOSTNAME: '10.0.0.9', BACKSTAGE_INSECURE_BIND_ACKNOWLEDGED: ack }, FALLBACK, STUB_ROLES)[0].host, '10.0.0.9');
      }
    });

    it('applies to the real admin role definition with ADMIN_ names', function () {
      refused(() => listeners.resolve(['admin'], { ADMIN_HOSTNAME: '192.0.2.10' }, FALLBACK), /ADMIN_INSECURE_BIND_ACKNOWLEDGED=true/);
      // HOSTNAME=127.0.0.1 with admin at its default 127.0.0.1:1338: the same
      // address on another port resolves (it refused before this decision).
      assert.deepEqual(listeners.resolve(['admin'], {}, { host: '127.0.0.1', port: 1337 }).map(s => [s.host, s.port]), [['127.0.0.1', 1338]]);
      assert.equal(listeners.resolve(['admin'], { API_HOSTNAME: '127.0.0.1' }, FALLBACK).length, 1);
      refused(() => listeners.resolve(['admin'], { API_HOSTNAME: '127.0.0.1', ADMIN_PORT: '1337' }, FALLBACK), /would share the consumer listener/);
      refused(() => listeners.resolve(['admin'], { ADMIN_HOSTNAME: '0.0.0.0', ADMIN_INSECURE_BIND_ACKNOWLEDGED: 'true' }, FALLBACK), /every interface/);
      // A shared non-loopback address still needs the acknowledgement.
      refused(() => listeners.resolve(['api', 'admin'], { API_HOSTNAME: '192.0.2.10', ADMIN_HOSTNAME: '192.0.2.10' }, FALLBACK), /ADMIN_INSECURE_BIND_ACKNOWLEDGED=true/);
      assert.equal(listeners.resolve(['api', 'admin'], { API_HOSTNAME: '192.0.2.10', ADMIN_HOSTNAME: '192.0.2.10', ADMIN_INSECURE_BIND_ACKNOWLEDGED: 'true' }, FALLBACK).length, 2);
    });

    it('leaves a consumer role alone on a non-loopback or wildcard address', function () {
      assert.equal(listeners.resolve(['front'], { FRONT_HOSTNAME: '0.0.0.0' }, FALLBACK, STUB_ROLES).length, 1);
      assert.equal(listeners.resolve(['front'], { FRONT_HOSTNAME: '192.0.2.1' }, FALLBACK, STUB_ROLES).length, 1);
    });
  });

  it('knows loopback and wildcard addresses', function () {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1']) assert.ok(listeners.isLoopback(host), host);
    for (const host of ['10.0.0.1', '0.0.0.0', '::', '', null, 'example.test', '128.0.0.1']) assert.ok(!listeners.isLoopback(host), String(host));
    for (const host of ['', null, undefined, '0.0.0.0', '::', '[::]']) assert.ok(listeners.isWildcard(host), String(host));
  });
});

describe('nightscout healthcheck --role (PLAT-SERVE)', function () {

  it('asks the api role\'s listener on /api/v3/version', function () {
    assert.equal(healthcheck.target({ PORT: '1337' }, 'api').url, 'http://127.0.0.1:1337/api/v3/version');
    assert.equal(healthcheck.target({ PORT: '1337', API_PORT: '8080', API_HOSTNAME: '::' }, 'api').url, 'http://[::1]:8080/api/v3/version');
    assert.equal(healthcheck.target({ PORT: '1337', API_PORT: '8080' }).url, 'http://127.0.0.1:1337/api/versions');
  });

  it('is green only for API v3\'s version record', function () {
    const body = JSON.stringify({ status: 200, result: { version: '16.0.0', apiVersion: '3.0.5' } });
    assert.equal(healthcheck.verdict({ status: 200, body }, 'api').healthy, true);
    assert.equal(healthcheck.verdict({ status: 200, body: '[]' }, 'api').healthy, false);
    assert.equal(healthcheck.verdict({ status: 200, body }).healthy, false);
    assert.equal(healthcheck.verdict({ status: 500, body: '{}' }, 'api').healthy, false);
  });

  it('exits 64 for a role it cannot probe, or --role with --url', function () {
    assert.equal(cli(['healthcheck', '--role', 'admin']).status, 64);
    assert.equal(cli(['healthcheck', '--role']).status, 64);
    assert.equal(cli(['healthcheck', '--role', 'api', '--url', 'http://127.0.0.1:1/']).status, 64);
  });
});
