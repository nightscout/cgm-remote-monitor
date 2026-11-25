'use strict';
// Current signing keys before recommission commits (decision
// deployment-signing-secret): each stored public key must be this deployment's
// derivation. No Vault, no HMAC probe; synthetic secret only.
const assert = require('node:assert/strict');
const usability = require('../lib/tenant-lifecycle/recommission-key-usability');
const derived = require('../lib/secrets/derived-signing');
const fixtureSigning = require('./fixtures/signing-secret').signing;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const stored = (tenant = A, signing = fixtureSigning, version = 1) => ['management', 'human-data', 'human-management'].map(purpose => {
  const key = signing.key(tenant, purpose, version); return { purpose, kid: key.kid, publicKey: key.raw };
});
describe('current retained provider key usability', function () {
  it('verifies every current derived key and returns no material', async function () {
    assert.deepEqual(await usability.verify({ tenant: A, keys: stored(), signing: fixtureSigning }), { verified: true });
    assert.deepEqual(await usability.verify({ tenant: A, keys: stored(A, fixtureSigning, 3), signing: fixtureSigning }), { verified: true });
  });
  it('refuses another deployment\'s, another tenant\'s, a retired-purpose or a malformed key, sanitized', async function () {
    const foreign = derived.fromSecret(Buffer.alloc(32, 3));
    for (const keys of [stored(A, foreign), stored(B), [{ purpose: 'access', kid: 'key1', publicKey: stored()[0].publicKey }],
      [{ ...stored()[0], kid: 'management1' }], [stored()[0], stored()[0]], [{ ...stored()[1], purpose: 'management' }]]) {
      await assert.rejects(usability.verify({ tenant: A, keys, signing: fixtureSigning }),
        error => error.code === 'LIFECYCLE_RECOMMISSION_PROVIDER_KEYS_REFUSED' && error.message === error.code && !error.cause, JSON.stringify(keys));
    }
    await assert.rejects(usability.verify({ tenant: A, keys: stored() }), { code: 'LIFECYCLE_RECOMMISSION_PROVIDER_KEYS_REFUSED' });
  });
  it('makes the foreign-secret refusal red when the derivation match is omitted and restores it', async function () {
    const fs = require('node:fs'), Module = require('node:module'), path = require('node:path');
    const filename = require.resolve('../lib/tenant-lifecycle/recommission-key-usability'), source = fs.readFileSync(filename, 'utf8');
    const guard = "signing.matching(tenant, key.purpose, { kid: key.kid, publicKey: key.publicKey });"; assert.equal(source.split(guard).length, 2);
    const altered = new Module(filename, module); altered.filename = filename; altered.paths = Module._nodeModulePaths(path.dirname(filename)); altered._compile(source.replace(guard, ''), filename);
    const keys = stored(A, derived.fromSecret(Buffer.alloc(32, 4))); let red = false;
    try { await assert.rejects(altered.exports.verify({ tenant: A, keys, signing: fixtureSigning })); } catch (error) { assert.equal(error.code, 'ERR_ASSERTION'); assert.match(error.message, /Missing expected rejection/); red = true; }
    assert(red); await assert.rejects(usability.verify({ tenant: A, keys, signing: fixtureSigning }), { code: 'LIFECYCLE_RECOMMISSION_PROVIDER_KEYS_REFUSED' });
  });
});
