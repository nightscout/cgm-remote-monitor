'use strict';

// covers: bin/nightscout.js, lib/cli/index.js, lib/cli/commands/version.js, lib/cli/commands/env.js, lib/cli/commands/healthcheck.js, lib/cli/commands/serve.js, lib/cli/commands/diagnose.js, package.json

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const BIN = path.join(root, 'bin/nightscout.js');

// Environment for a child that starts from nothing Nightscout-specific, so a
// developer's my.test.env cannot change what is being asserted.
function cleanEnv (extra) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'SystemRoot', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return Object.assign(env, extra);
}

function cli (args, env, opts) {
  return spawnSync(process.execPath, [BIN].concat(args),
    Object.assign({ cwd: root, encoding: 'utf8', timeout: 15000, env: env || cleanEnv() }, opts));
}

// Async form, for a child that must reach a server in this process.
function cliAsync (args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN].concat(args), { cwd: root, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

describe('nightscout executable (D21)', function () {
  this.timeout(30000);

  it('is the package bin', function () {
    assert.deepEqual(require('../package.json').bin, { nightscout: 'bin/nightscout.js' });
  });

  it('prints usage and exits 0 with no arguments, help, or --help', function () {
    for (const args of [[], ['help'], ['--help']]) {
      const result = cli(args);
      assert.equal(result.status, 0, args.join(' ') + ': ' + result.stderr);
      assert.match(result.stdout, /^Usage: nightscout <command>/);
      for (const name of ['single', 'serve', 'diagnose', 'healthcheck', 'version', 'env', 'help']) {
        assert.match(result.stdout, new RegExp('nightscout ' + name + '\\b'), name + ' is listed');
      }
    }
  });

  it('exits 64 with usage on stderr for an unknown subcommand', function () {
    const result = cli(['no-such-subcommand-' + process.pid]);
    assert.equal(result.status, 64);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /unknown command: no-such-subcommand-/);
    assert.match(result.stderr, /Usage: nightscout <command>/);
  });

  it('exits 64 for `serve` of a role that is not available yet', function () {
    const result = cli(['serve', 'admin']);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /not yet available: admin/);
  });

  it('exits 64 for `single` with arguments and `diagnose` without a target', function () {
    assert.equal(cli(['single', 'extra']).status, 64);
    assert.equal(cli(['diagnose']).status, 64);
    assert.equal(cli(['diagnose', 'everything']).status, 64);
    assert.equal(cli(['healthcheck', '--bogus']).status, 64);
  });

  it('prints the package version without loading the server', function () {
    const trap = `
      const Module = require('module');
      const original = Module._load;
      Module._load = function (name) {
        if (/server\\/(env|server|bootevent|app)$|^\\.\\/(env|bootevent|app)$|mongodb/.test(name)) {
          throw new Error('version loaded ' + name);
        }
        return original.apply(this, arguments);
      };
      process.argv = [process.argv[0], ${JSON.stringify(BIN)}, 'version'];
      require(${JSON.stringify(BIN)});
    `;
    const result = spawnSync(process.execPath, ['-e', trap], { cwd: root, encoding: 'utf8', env: cleanEnv() });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, require('../package.json').version + '\n');
  });

  it('runs a first argument that names a program, as the old image CMD override does', function () {
    const result = cli(['node', '-e', 'process.stdout.write(process.argv.slice(1).join(" ")); process.exit(7)', 'a', 'b']);
    assert.equal(result.status, 7, result.stderr);
    assert.equal(result.stdout, 'a b');
  });

  it('runs an option or a non-executable script with node, as the node image entrypoint did', function () {
    const option = cli(['-e', 'process.stdout.write("option"); process.exit(5)']);
    assert.equal(option.status, 5, option.stderr);
    assert.equal(option.stdout, 'option');
    const script = cli(['tests/fixtures/cli-echo-args.js', 'x', 'y']);
    assert.equal(script.status, 0, script.stderr);
    assert.equal(script.stdout, 'x y');
  });

  it('treats a missing path as an unknown subcommand', function () {
    assert.equal(cli(['./no-such-dir/no-such-script.js']).status, 64);
  });

  it('passes SIGTERM on to a program it runs', function (done) {
    const child = spawn(process.execPath, [BIN, 'node', '-e',
      'process.on("SIGTERM", () => { process.stdout.write("got SIGTERM"); process.exit(3); }); console.log("ready"); setInterval(() => {}, 1000)'],
    { cwd: root, env: cleanEnv() });
    let out = '';
    child.stdout.on('data', d => {
      out += d;
      if (out.includes('ready') && !child.signalled) { child.signalled = true; child.kill('SIGTERM'); }
    });
    child.on('close', status => {
      try {
        assert.equal(status, 3);
        assert.match(out, /got SIGTERM/);
        done();
      } catch (err) { done(err); }
    });
  });

  describe('env', function () {
    const planted = {
      API_SECRET: 'planted-api-secret-' + process.pid + '-Zq9'
      , PUSHOVER_API_TOKEN: 'planted-pushover-token-' + process.pid
      , CONNECT_SHARE_ACCOUNT_PASSWORD: 'planted-share-password-' + process.pid
      , SOME_PLUGIN_KEY: 'planted-plugin-key-' + process.pid
      , MONGO_CONNECTION: 'mongodb://planteduser:planted-mongo-pw-' + process.pid + '@db.example.invalid:27017/ns?authSource=admin'
    };
    let result, out;

    before(function () {
      result = cli(['env'], cleanEnv(Object.assign({
        ENABLE: 'careportal pushover connect'
        , AUTH_DEFAULT_ROLES: 'denied'
        , PORT: '4242'
        , CONNECT_SOURCE: 'dexcomshare'
      }, planted)));
      out = result.stdout;
    });

    it('prints the parsed configuration as JSON', function () {
      assert.equal(result.status, 0, result.stderr);
      const config = JSON.parse(out);
      assert.equal(config.PORT, '4242');
      assert.equal(config.version, require('../package.json').version);
      assert.equal(config.apiSecretSet, true);
      assert.equal(config.settings.authDefaultRoles, 'denied');
    });

    it('redacts every planted secret, from stdout and stderr', function () {
      for (const [name, value] of Object.entries(planted)) {
        assert.ok(!out.includes(value), name + ' value leaked to stdout');
        assert.ok(!result.stderr.includes(value), name + ' value leaked to stderr');
      }
      assert.ok(!out.includes('planteduser'), 'MongoDB user leaked');
      assert.ok(!out.includes('planted-mongo-pw'), 'MongoDB password leaked');
      assert.match(out, /\[redacted\]/);
    });

    it('redacts by key, URL credentials and value', function () {
      const { redact, secretValues } = require('../lib/cli/commands/env');
      const secrets = secretValues({ WEIRD_SECRET: 'zz-value-zz' });
      assert.deepEqual(redact({
        apiToken: 'x', nested: { userKey: 'y', authDefaultRoles: 'readable' }
        , other: 'mongodb+srv://u:p@h.example.invalid/db?tls=true'
        , copied: 'prefix zz-value-zz suffix'
        , contact: 'someone@example.invalid'
      }, secrets), {
        apiToken: '[redacted]', nested: { authDefaultRoles: 'readable', userKey: '[redacted]' }
        , contact: '[redacted]'
        , copied: 'prefix [redacted] suffix'
        , other: 'mongodb+srv://[redacted]@h.example.invalid/db?[redacted]'
      });
    });
  });

  describe('healthcheck', function () {
    let server;
    let answer;

    before(function (done) {
      server = http.createServer((req, res) => answer(req, res));
      server.listen(0, '127.0.0.1', done);
    });
    after(function (done) { server.close(done); });

    function env (port, extra) {
      return cleanEnv(Object.assign({ PORT: String(port), NIGHTSCOUT_HOSTNAME: '127.0.0.1', INSECURE_USE_HTTP: 'true' }, extra));
    }

    it('is green when /api/versions answers with the version list', async function () {
      let seen;
      answer = (req, res) => { seen = req.url; res.setHeader('content-type', 'application/json'); res.end('[{"version":"1"}]'); };
      const result = await cliAsync(['healthcheck'], env(server.address().port));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(seen, '/api/versions');
      assert.match(result.stdout, /^healthy: http:\/\/127\.0\.0\.1:\d+\/api\/versions 200/);
    });

    it('is red for a boot-error page (500)', async function () {
      answer = (req, res) => { res.statusCode = 500; res.end('<html>boot error</html>'); };
      const result = await cliAsync(['healthcheck'], env(server.address().port));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /^unhealthy: .* 500 \(the server is up and showing its boot-error page/);
    });

    it('asks as https when INSECURE_USE_HTTP is off, and accepts the redirect only to https', async function () {
      let proto;
      answer = (req, res) => {
        proto = req.headers['x-forwarded-proto'];
        res.statusCode = 307; res.setHeader('location', 'https://example.invalid/api/versions'); res.end();
      };
      const on = await cliAsync(['healthcheck'], env(server.address().port, { INSECURE_USE_HTTP: 'false' }));
      assert.equal(proto, 'https');
      assert.equal(on.status, 0, on.stderr);
      answer = (req, res) => { res.statusCode = 307; res.setHeader('location', 'http://elsewhere.invalid/'); res.end(); };
      assert.equal((await cliAsync(['healthcheck'], env(server.address().port))).status, 1);
    });

    it('is red within the timeout when nothing answers', async function () {
      answer = () => { /* never answer */ };
      const started = Date.now();
      const result = await cliAsync(['healthcheck', '--timeout', '300'], env(server.address().port));
      assert.equal(result.status, 1);
      assert.ok(Date.now() - started < 5000, 'took ' + (Date.now() - started) + ' ms');
    });

    describe('over https', function () {
      // localhost.crt names localhost and is what SSL_CERT points at;
      // healthcheck-other.crt (CN other.invalid) plays a different server on
      // the same port. Both are self-signed test fixtures.
      const fixture = name => path.join(root, 'tests/fixtures', name);
      const versions = (req, res) => { res.setHeader('content-type', 'application/json'); res.end('[{"version":"1"}]'); };
      let tlsServer;

      function listen (certName, keyName) {
        tlsServer = https.createServer({ cert: fs.readFileSync(fixture(certName)), key: fs.readFileSync(fixture(keyName)) }, versions);
        return new Promise(resolve => tlsServer.listen(0, '127.0.0.1', resolve));
      }
      afterEach(function (done) { tlsServer.closeAllConnections(); tlsServer.close(done); });

      function tlsEnv (extra) {
        return cleanEnv(Object.assign({
          PORT: String(tlsServer.address().port), NIGHTSCOUT_HOSTNAME: '127.0.0.1'
          , SSL_KEY: fixture('localhost.key'), SSL_CERT: fixture('localhost.crt')
        }, extra));
      }

      it('is green for the certificate SSL_CERT names, reached on loopback', async function () {
        await listen('localhost.crt', 'localhost.key');
          const result = await cliAsync(['healthcheck'], tlsEnv());
          assert.equal(result.status, 0, result.stderr);
          assert.match(result.stdout, /^healthy: https:\/\/127\.0\.0\.1:\d+\/api\/versions 200/);
      });

      it('is red when the server presents a different certificate', async function () {
        await listen('healthcheck-other.crt', 'healthcheck-other.key');
          const result = await cliAsync(['healthcheck'], tlsEnv());
          assert.equal(result.status, 1, result.stdout);
          assert.match(result.stderr, /^unhealthy: https:/);
      });

      it('is red when SSL_CERT cannot be read', async function () {
        await listen('localhost.crt', 'localhost.key');
          const result = await cliAsync(['healthcheck'], tlsEnv({ SSL_CERT: fixture('no-such.crt') }));
          assert.equal(result.status, 1, result.stdout);
          assert.match(result.stderr, /cannot read SSL_CERT or SSL_CA \(ENOENT\)/);
      });

      it('checks a --url as any client would: a self-signed certificate is red', async function () {
        await listen('localhost.crt', 'localhost.key');
          const url = 'https://127.0.0.1:' + tlsServer.address().port + '/api/versions';
          const result = await cliAsync(['healthcheck', '--url', url], tlsEnv());
          assert.equal(result.status, 1, result.stdout);
          assert.match(result.stderr, /SELF_SIGNED|self-signed|self signed/i);
      });
    });

    it('reads the address the server listens on', function () {
      const { target } = require('../lib/cli/commands/healthcheck');
      assert.equal(target({}).url, 'http://127.0.0.1:1337/api/versions');
      assert.equal(target({ PORT: ' 8080 ', NIGHTSCOUT_HOSTNAME: '0.0.0.0' }).url, 'http://127.0.0.1:8080/api/versions');
      assert.equal(target({ CUSTOMCONNSTR_PORT: '9', NIGHTSCOUT_HOSTNAME: '::' }).url, 'http://[::1]:9/api/versions');
      assert.equal(target({ NIGHTSCOUT_HOSTNAME: '', HOSTNAME: 'ignored.example' }).url, 'http://127.0.0.1:1337/api/versions');
      assert.equal(target({ HOSTNAME: 'ns.example' }).url, 'http://ns.example:1337/api/versions');
      assert.equal(target({ SSL_KEY: 'k.pem', SSL_CERT: 'c.pem' }).url, 'https://127.0.0.1:1337/api/versions');
    });
  });
});
