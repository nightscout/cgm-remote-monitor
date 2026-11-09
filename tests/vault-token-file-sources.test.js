'use strict';

// covers: lib/secrets/vault-token-source.js, lib/human-session/access-config.js, lib/server/serve/owner-credential-config.js, lib/secrets/vault-access-signing.js, lib/secrets/vault-transit.js
// The two other Vault credential loaders carry the shape tests/preview-vault-token-file.test.js
// records for preview tenants: exactly one of tokenEnv (fixed at bootstrap) or tokenFile (a
// Vault Agent sink re-read on every provider call); an unreadable or empty sink fails that
// operation closed and never falls back to an environment token.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const fixture = require('./fixtures/human-access-issuer');
const { loadHumanAccess } = require('../lib/human-session/access-config');
const ownerCredentials = require('../lib/server/serve/owner-credential-config');

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const BAD_PATHS = ['run/ns-vault/token', '', ' ', '/run/ns-vault/', '/run/ns-vault/../token', 42];

describe('Vault credential source for human access signing and owner credential issuance: tokenEnv or tokenFile', function () {
  let dir, server, origin, requests, local;
  // A loopback stand-in for Transit: it records the credential header of every request,
  // answers encrypt with a fixed ciphertext and sign with the fixture's actual Ed25519 key so
  // the issued access token verifies against the provisioned public key.
  before(function (done) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-token-sources-'));
    requests = [];
    local = fixture({ tenant: 'single' });
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => {
        requests.push({ path: req.url, token: req.headers['x-vault-token'] });
        res.setHeader('Content-Type', 'application/json');
        const sign = /^\/v1\/transit\/sign\/synthetic-(data|management)$/.exec(req.url);
        if (sign) {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const key = local.keys.find(candidate => candidate.purpose === sign[1]);
          const signature = await key.sign(Buffer.from(body.input, 'base64'));
          res.end(JSON.stringify({ data: { signature: 'vault:v1:' + signature.toString('base64') } }));
        } else {
          res.end(JSON.stringify({ data: { ciphertext: 'vault:v1:c3ludGhldGlj' } }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => { origin = 'http://127.0.0.1:' + server.address().port; done(); });
  });
  after(function (done) {
    fs.rmSync(dir, { recursive: true, force: true });
    server.close(done);
  });
  beforeEach(function () { requests.length = 0; });

  describe('human access signing (OIDC_ACCESS_CONFIG vault block)', function () {
    const claims = () => ({ tenant: 'single', subject: 'reader', session: 'session', purpose: 'data',
      credentialVersion: 1, issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 600 });
    function write (vault) {
      const file = path.join(dir, 'human-access.json');
      fs.writeFileSync(file, JSON.stringify({ version: 1, issuer: local.issuer, audiences: local.audiences,
        vault: { addressEnv: 'TS_HUMAN_VAULT_ADDRESS', mount: 'transit', allowInsecureLoopback: true, ...vault },
        keys: local.keys.map(key => ({ tenant: key.tenant, purpose: key.purpose, kid: key.kid, current: key.current,
          publicKey: Buffer.from(key.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'),
          signingKey: 'synthetic-' + key.purpose, signingVersion: 1 })) }));
      return file;
    }
    const environment = (file, extra = {}) => ({ ENABLE: 'oidc', OIDC_ACCESS_CONFIG: file, TS_HUMAN_VAULT_ADDRESS: origin, ...extra });
    const load = (file, extra) => loadHumanAccess({ source: environment(file, extra), mode: 'single', tenants: ['single'] });

    it('refuses a vault block that names both tokenEnv and tokenFile, and one that names neither', function () {
      for (const vault of [{ tokenEnv: 'TS_HUMAN_VAULT_TOKEN', tokenFile: path.join(dir, 'token') }, {}]) {
        assert.throws(() => load(write(vault), { TS_HUMAN_VAULT_TOKEN: 'synthetic-env' }), TypeError, JSON.stringify(vault));
      }
    });

    it('refuses a relative, empty, trailing-slash or unnormalized tokenFile path', function () {
      for (const tokenFile of BAD_PATHS) assert.throws(() => load(write({ tokenFile })), TypeError, 'tokenFile ' + JSON.stringify(tokenFile));
    });

    it('still accepts tokenEnv alone exactly as before', async function () {
      const token = randomBytes(24).toString('base64url');
      const loaded = load(write({ tokenEnv: 'TS_HUMAN_VAULT_TOKEN' }), { TS_HUMAN_VAULT_TOKEN: token });
      assert.equal(loaded.verify({ tenant: 'single', token: await loaded.issue(claims()) }).sub, 'reader');
      assert.deepEqual(requests, [{ path: '/v1/transit/sign/synthetic-data', token }]);
    });

    it('reads the sink at every signing call so a rewritten token is used by the next issuance without a restart', async function () {
      const sink = path.join(dir, 'human-token');
      fs.writeFileSync(sink, 'synthetic-first\n');
      const loaded = load(write({ tokenFile: sink }));
      assert.equal(loaded.verify({ tenant: 'single', token: await loaded.issue(claims()) }).sub, 'reader');
      fs.writeFileSync(sink, '  synthetic-renewed  \n');
      assert.equal(loaded.verify({ tenant: 'single', token: await loaded.issue(claims()) }).sub, 'reader');
      assert.deepEqual(requests.map(r => r.token), ['synthetic-first', 'synthetic-renewed']);
    });

    it('fails issuance closed when the sink is missing or empty and never falls back to an environment token', async function () {
      const sink = path.join(dir, 'absent-human-token');
      // Control: the environment carries a usable token under the name the tokenEnv shape would use.
      const loaded = load(write({ tokenFile: sink }), { TS_HUMAN_VAULT_TOKEN: 'synthetic-env-must-not-be-used' });
      await assert.rejects(loaded.issue(claims()), { code: 'HUMAN_SESSION_UNAVAILABLE' });
      fs.writeFileSync(sink, '\n   \n');
      await assert.rejects(loaded.issue(claims()), { code: 'HUMAN_SESSION_UNAVAILABLE' });
      assert.equal(requests.length, 0, 'no signing request leaves without a sink token');
      fs.writeFileSync(sink, 'synthetic-recovered');
      assert.equal(loaded.verify({ tenant: 'single', token: await loaded.issue(claims()) }).sub, 'reader');
      assert.deepEqual(requests.map(r => r.token), ['synthetic-recovered']);
    });
  });

  describe('owner credential issuance (ownerCredentials.tenants[].vault)', function () {
    const existing = { tenants: [A, B], consumer: 'owner', legacyConnectionString: 'postgres://reader:synthetic@localhost/test',
      legacyNamespace: 'legacy', existingConnections: ['postgres://writer:synthetic@localhost/test', 'postgres://reader:synthetic@localhost/test'],
      existingNamespaces: ['auth', 'legacy', 'access'] };
    const make = sources => ({ connectionEnv: 'TS_OWNER_SECRETS', namespace: 'secrets', vault: { address: origin, mount: 'transit', allowInsecureLoopback: true },
      tenants: [A, B].map((id, i) => ({ id, encryptionKey: 'tenant-' + i + '-data', signingKey: 'tenant-' + i + '-sign', signingVersion: 1, ...sources[i] })) });
    const env = extra => ({ TS_OWNER_SECRETS: 'postgres://issuer:synthetic@localhost/test', ...extra });

    it('refuses a tenant that names both tokenEnv and tokenFile, and one that names neither', function () {
      for (const source of [{ tokenEnv: 'TS_OWNER_VAULT_0', tokenFile: path.join(dir, 'token') }, {}]) {
        assert.throws(() => ownerCredentials(make([source, { tokenEnv: 'TS_OWNER_VAULT_1' }]),
          env({ TS_OWNER_VAULT_0: 'synthetic-a', TS_OWNER_VAULT_1: 'synthetic-b' }), existing), TypeError, JSON.stringify(source));
      }
    });

    it('refuses a relative, empty, trailing-slash or unnormalized tokenFile path', function () {
      for (const tokenFile of BAD_PATHS) {
        assert.throws(() => ownerCredentials(make([{ tokenFile }, { tokenEnv: 'TS_OWNER_VAULT_1' }]), env({ TS_OWNER_VAULT_1: 'synthetic-b' }), existing),
          TypeError, 'tokenFile ' + JSON.stringify(tokenFile));
      }
    });

    it('still accepts tokenEnv alone exactly as before, including the duplicate-reference refusal', async function () {
      const selected = ownerCredentials(make([{ tokenEnv: 'TS_OWNER_VAULT_0' }, { tokenEnv: 'TS_OWNER_VAULT_1' }]),
        env({ TS_OWNER_VAULT_0: 'synthetic-a', TS_OWNER_VAULT_1: 'synthetic-b' }), existing);
      await selected.providers.get(B).encrypt(Buffer.from('x'));
      assert.deepEqual(requests, [{ path: '/v1/transit/encrypt/tenant-1-data', token: 'synthetic-b' }]);
      assert.throws(() => ownerCredentials(make([{ tokenEnv: 'TS_OWNER_VAULT_0' }, { tokenEnv: 'TS_OWNER_VAULT_0' }]), env({ TS_OWNER_VAULT_0: 'synthetic-a' }), existing), TypeError);
    });

    it('reads the sink at every call so a rewritten token is used by the next operation without a restart', async function () {
      const sink = path.join(dir, 'owner-shared-token');
      fs.writeFileSync(sink, 'synthetic-first\n');
      // Two tenants may share one sink: one Agent, one login.
      const selected = ownerCredentials(make([{ tokenFile: sink }, { tokenFile: sink }]), env(), existing);
      await selected.providers.get(A).encrypt(Buffer.from('x'));
      fs.writeFileSync(sink, '  synthetic-renewed  \n');
      await selected.providers.get(A).encrypt(Buffer.from('x'));
      await selected.providers.get(B).encrypt(Buffer.from('x'));
      assert.deepEqual(requests.map(r => r.token), ['synthetic-first', 'synthetic-renewed', 'synthetic-renewed']);
      assert.deepEqual(requests.map(r => r.path), ['/v1/transit/encrypt/tenant-0-data', '/v1/transit/encrypt/tenant-0-data', '/v1/transit/encrypt/tenant-1-data']);
    });

    it('fails the operation closed when the sink is missing or empty and never falls back to an environment token', async function () {
      const sink = path.join(dir, 'absent-owner-token');
      // Control: the environment carries a usable token under the name the tokenEnv shape would use.
      const selected = ownerCredentials(make([{ tokenFile: sink }, { tokenEnv: 'TS_OWNER_VAULT_1' }]),
        env({ TS_OWNER_VAULT_0: 'synthetic-env-must-not-be-used', TS_OWNER_VAULT_1: 'synthetic-b' }), existing);
      await assert.rejects(selected.providers.get(A).encrypt(Buffer.from('x')), { code: 'SECRETS_PROVIDER_UNAVAILABLE' });
      fs.writeFileSync(sink, '\n   \n');
      await assert.rejects(selected.providers.get(A).encrypt(Buffer.from('x')), { code: 'SECRETS_PROVIDER_UNAVAILABLE' });
      assert.equal(requests.length, 0, 'no Transit request leaves without a sink token');
      // The sibling tokenEnv tenant is unaffected and the env token the file tenant must not use is not sent.
      await selected.providers.get(B).encrypt(Buffer.from('x'));
      assert.deepEqual(requests.map(r => r.token), ['synthetic-b']);
      fs.writeFileSync(sink, 'synthetic-recovered');
      await selected.providers.get(A).encrypt(Buffer.from('x'));
      assert.deepEqual(requests.map(r => r.token), ['synthetic-b', 'synthetic-recovered']);
    });
  });
});
