'use strict';

// covers: lib/server/serve/preview-config.js, lib/secrets/vault-transit.js
// The Vault credential for a preview tenant comes from exactly one source: an
// environment reference fixed at bootstrap (tokenEnv) or a Vault Agent sink file
// re-read on every provider call (tokenFile). The sink path never falls back to
// the environment, and an unreadable or empty sink fails the operation closed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { load, PreviewConfigError } = require('../lib/server/serve/preview-config');

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';

describe('preview Vault credential source: tokenEnv or tokenFile', function () {
  let dir, server, origin, requests;
  const url = name => 'postgres://synthetic-' + name + ':synthetic@127.0.0.1:15432/token_file_test';
  function write (config) {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify(config));
    return file;
  }
  function config (vaults) {
    return { version: 1,
      postgres: { connectionEnv: 'TF_API_PG', readinessConnectionEnv: 'TF_READINESS_PG',
        namespaces: { entries: 'tf_entries', authorization: 'tf_authorization', secrets: 'tf_secrets', legacy: 'tf_legacy' } },
      vault: { address: origin, mount: 'tf_transit', allowInsecureLoopback: true },
      resolution: { mode: 'direct-alias' },
      tenants: [A, B].map((id, i) => ({ id, aliases: [(i ? 'two' : 'one') + '.example.test'],
        vault: { encryptionKey: 'tenant-' + i + '-data', signingKey: 'tenant-' + i + '-signing', signingVersion: 1, ...vaults[i] } })) };
  }
  function environment (file, extra = {}) {
    return { MULTITENANT_PREVIEW_CONFIG: file, TF_API_PG: url('api'), TF_READINESS_PG: url('readiness'), ...extra };
  }
  before(function (done) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-token-file-'));
    requests = [];
    // A loopback stand-in for Transit that records only the credential header it was sent.
    server = http.createServer((req, res) => {
      requests.push({ path: req.url, token: req.headers['x-vault-token'] });
      req.resume();
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { ciphertext: 'vault:v1:c3ludGhldGlj' } }));
      });
    });
    server.listen(0, '127.0.0.1', () => { origin = 'http://127.0.0.1:' + server.address().port; done(); });
  });
  after(function (done) {
    fs.rmSync(dir, { recursive: true, force: true });
    server.close(done);
  });
  beforeEach(function () { requests.length = 0; });

  it('refuses a tenant that names both tokenEnv and tokenFile, and one that names neither', function () {
    const sink = path.join(dir, 'token');
    for (const vault of [{ tokenEnv: 'TF_VAULT_0', tokenFile: sink }, {}]) {
      const file = write(config([vault, { tokenEnv: 'TF_VAULT_1' }]));
      assert.throws(() => load(environment(file, { TF_VAULT_0: 'synthetic-a', TF_VAULT_1: 'synthetic-b' })),
        error => error instanceof PreviewConfigError && /exactly one of tokenEnv or tokenFile/.test(error.message));
    }
  });

  it('refuses a relative, empty, trailing-slash or unnormalized tokenFile path', function () {
    for (const tokenFile of ['run/ns-vault/token', '', ' ', '/run/ns-vault/', '/run/ns-vault/../token', 42]) {
      const file = write(config([{ tokenFile }, { tokenEnv: 'TF_VAULT_1' }]));
      assert.throws(() => load(environment(file, { TF_VAULT_1: 'synthetic-b' })),
        error => error instanceof PreviewConfigError && /tokenFile must be a normalized absolute file path/.test(error.message),
        'tokenFile ' + JSON.stringify(tokenFile));
    }
  });

  it('still accepts tokenEnv alone exactly as before', async function () {
    const file = write(config([{ tokenEnv: 'TF_VAULT_0' }, { tokenEnv: 'TF_VAULT_1' }]));
    const loaded = load(environment(file, { TF_VAULT_0: 'synthetic-a', TF_VAULT_1: 'synthetic-b' }));
    await loaded.providers.get(B).encrypt(Buffer.from('x'));
    assert.deepEqual(requests.map(r => r.token), ['synthetic-b']);
  });

  it('reads the sink at every call so a rewritten token is used by the next operation without a restart', async function () {
    const sink = path.join(dir, 'shared-token');
    fs.writeFileSync(sink, 'synthetic-first\n');
    // Two tenants may share one sink: one Agent, one login.
    const file = write(config([{ tokenFile: sink }, { tokenFile: sink }]));
    const loaded = load(environment(file));
    await loaded.providers.get(A).encrypt(Buffer.from('x'));
    fs.writeFileSync(sink, '  synthetic-renewed  \n');
    await loaded.providers.get(A).encrypt(Buffer.from('x'));
    await loaded.providers.get(B).encrypt(Buffer.from('x'));
    assert.deepEqual(requests.map(r => r.token), ['synthetic-first', 'synthetic-renewed', 'synthetic-renewed']);
    assert.deepEqual(requests.map(r => r.path), ['/v1/tf_transit/encrypt/tenant-0-data', '/v1/tf_transit/encrypt/tenant-0-data', '/v1/tf_transit/encrypt/tenant-1-data']);
  });

  it('fails the operation closed when the sink is missing or empty and never falls back to an environment token', async function () {
    const sink = path.join(dir, 'absent-token');
    const file = write(config([{ tokenFile: sink }, { tokenEnv: 'TF_VAULT_1' }]));
    // Control: the environment carries a usable token under the name the tokenEnv shape would use.
    const loaded = load(environment(file, { TF_VAULT_0: 'synthetic-env-must-not-be-used', TF_VAULT_1: 'synthetic-b' }));
    await assert.rejects(loaded.providers.get(A).encrypt(Buffer.from('x')), { code: 'SECRETS_PROVIDER_UNAVAILABLE' });
    fs.writeFileSync(sink, '\n   \n');
    await assert.rejects(loaded.providers.get(A).encrypt(Buffer.from('x')), { code: 'SECRETS_PROVIDER_UNAVAILABLE' });
    assert.equal(requests.length, 0, 'no Transit request leaves without a sink token');
    // The sibling tokenEnv tenant is unaffected and the env token the file tenant must not use is not sent.
    await loaded.providers.get(B).encrypt(Buffer.from('x'));
    assert.deepEqual(requests.map(r => r.token), ['synthetic-b']);
    fs.writeFileSync(sink, 'synthetic-recovered');
    await loaded.providers.get(A).encrypt(Buffer.from('x'));
    assert.deepEqual(requests.map(r => r.token), ['synthetic-b', 'synthetic-recovered']);
  });
});
