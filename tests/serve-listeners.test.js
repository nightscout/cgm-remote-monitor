'use strict';

// covers: lib/server/serve/listeners.js, lib/server/serve/roles.js, lib/server/serve/index.js, lib/cli/commands/serve.js, lib/cli/commands/healthcheck.js

// PLAT-SERVE (D21): the role list `nightscout serve` takes, and the listener
// rules. Nothing here boots a server or needs a database. The plane rule is
// exercised through a stub internal-plane role, because `admin`, the one
// real internal-plane role, cannot be served yet.

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

describe('nightscout serve: roles (PLAT-SERVE)', function () {

  it('accepts a multitenant role, and no role is multitenant yet', function () {
    const roles = { api: Object.assign({}, ROLES.api, { multitenant: true }) };
    assert.deepEqual(serve.parseRoles(['api'], roles), ['api']);
    for (const [name, role] of Object.entries(ROLES)) assert.notEqual(role.multitenant, true, name);
  });

  it('refuses an unknown role, an empty one, a repeated one, and a missing list', function () {
    const roles = { api: Object.assign({}, ROLES.api, { multitenant: true }) };
    for (const args of [['bogus'], ['api,bogus'], ['api,'], ['api,api'], [], ['api', 'extra']]) {
      assert.throws(() => serve.parseRoles(args, roles), serve.RoleError, JSON.stringify(args));
    }
  });

  it('names every role that cannot be served yet', function () {
    for (const name of ['api', 'evaluator', 'realtime', 'vcpool', 'tenant-admin', 'admin']) {
      assert.ok(ROLES[name], name);
      assert.throws(() => serve.parseRoles([name]), new RegExp('not yet available: ' + name + '\\.'));
    }
    assert.throws(() => serve.parseRoles(['api,admin,realtime']), /not yet available: api, admin, realtime/);
  });

  it('exits 64 for an unknown role and for each role not yet available', function () {
    const unknown = cli(['serve', 'bogus']);
    assert.equal(unknown.status, 64);
    assert.match(unknown.stderr, /unknown role: bogus/);
    for (const name of ['api', 'evaluator', 'realtime', 'vcpool', 'tenant-admin', 'admin', 'api,admin']) {
      const result = cli(['serve', name]);
      assert.equal(result.status, 64, name);
      assert.match(result.stderr, /not yet available: .*multitenant Nightscout, which is not built yet/, name);
    }
    assert.equal(cli(['serve']).status, 64);
  });

});

describe('nightscout serve: listeners (PLAT-SERVE)', function () {

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

    it('refuses the consumer listener\'s address, on any port, even when not serving the consumer role', function () {
      for (const source of [
        { FRONT_HOSTNAME: '10.0.0.5', BACKSTAGE_HOSTNAME: '10.0.0.5', BACKSTAGE_INSECURE_BIND_ACKNOWLEDGED: 'true' }
        , { FRONT_HOSTNAME: '127.0.0.1', BACKSTAGE_HOSTNAME: '127.0.0.1' }
        , { FRONT_HOSTNAME: 'localhost', BACKSTAGE_HOSTNAME: '127.0.0.1' }
        , { FRONT_HOSTNAME: '[::1]', BACKSTAGE_HOSTNAME: '::1' }
      ]) {
        refused(() => listeners.resolve(['front', 'backstage'], source, FALLBACK, STUB_ROLES), /on the consumer listener's address/);
        refused(() => listeners.resolve(['backstage'], source, FALLBACK, STUB_ROLES), /on the consumer listener's address/);
      }
      // The consumer address can come from the fallback (HOSTNAME) too.
      refused(() => listeners.resolve(['backstage'], {}, { host: '127.0.0.1', port: 1337 }, STUB_ROLES), /consumer listener's address/);
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
      refused(() => listeners.resolve(['admin'], { API_HOSTNAME: '127.0.0.1' }, FALLBACK), /consumer listener's address/);
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
