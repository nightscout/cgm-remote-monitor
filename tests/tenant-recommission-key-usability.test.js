'use strict';
// Actual local challenge cryptography; native provider reachability is separate.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const usability = require('../lib/tenant-lifecycle/recommission-key-usability');
const A = '11111111-1111-4111-8111-111111111111';
function fixture () {
  const hmacKey = crypto.randomBytes(32), tracked = [];
  const provider = { signingVersion: 1, sign: async input => { tracked.push(input); const bytes = crypto.createHmac('sha256', hmacKey).update(input).digest(); tracked.push(bytes); return bytes; },
    verify: async (version, input, signature) => version === 1 && crypto.timingSafeEqual(signature, crypto.createHmac('sha256', hmacKey).update(input).digest()) };
  const keys = [], signers = {};
  for (const purpose of ['access', 'management', 'human-data', 'human-management']) {
    const pair = crypto.generateKeyPairSync('ed25519');
    keys.push({ purpose, kid: purpose, publicKey: Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64') });
    signers[purpose] = { sign: async input => { const bytes = crypto.sign(null, input, pair.privateKey); tracked.push(bytes); return bytes; } };
  }
  return { provider, keys, signers, tracked };
}
describe('current retained provider key usability', function () {
  it('verifies actual HMAC and all current Ed25519 keys, returns no material and clears challenge/signature buffers', async function () {
    const f = fixture(); assert.deepEqual(await usability.verify({ tenant: A, ...f }), { verified: true });
    assert(f.tracked.length > 4); assert(f.tracked.every(bytes => bytes.every(value => value === 0)));
  });
  it('refuses missing/mismatched provider keys and sanitizes private provider errors', async function () {
    for (const change of [f => { f.provider.verify = async () => false; }, f => { delete f.signers.management; },
      f => { f.signers.access = fixture().signers.access; }, f => { f.keys[0].publicKey = Buffer.alloc(32).toString('base64'); },
      f => { f.signers.access.sign = async () => { throw Object.assign(new Error('private-provider-body'), { detail: 'private-ciphertext' }); }; }]) {
      const f = fixture(); change(f);
      await assert.rejects(usability.verify({ tenant: A, ...f }), error => error.code === 'LIFECYCLE_RECOMMISSION_PROVIDER_KEYS_REFUSED' && error.message === error.code && !error.cause && !error.detail);
      assert(f.tracked.every(bytes => bytes.every(value => value === 0)));
    }
  });
  it('makes the wrong-signing-key refusal red when signature verification is omitted and restores it', async function () {
    const fs = require('node:fs'), Module = require('node:module'), path = require('node:path');
    const filename = require.resolve('../lib/tenant-lifecycle/recommission-key-usability'), source = fs.readFileSync(filename, 'utf8');
    const guard = '!crypto.verify(null, challenge, publicKey, signature)'; assert.equal(source.split(guard).length, 2);
    const altered = new Module(filename, module); altered.filename = filename; altered.paths = Module._nodeModulePaths(path.dirname(filename)); altered._compile(source.replace(guard, 'false'), filename);
    const f = fixture(); f.signers.access = fixture().signers.access; let red = false;
    try { await assert.rejects(altered.exports.verify({ tenant: A, ...f })); } catch (error) { assert.equal(error.code, 'ERR_ASSERTION'); assert.match(error.message, /Missing expected rejection/); red = true; }
    assert(red); await assert.rejects(usability.verify({ tenant: A, ...fixture(), signers: f.signers }), { code: 'LIFECYCLE_RECOMMISSION_PROVIDER_KEYS_REFUSED' });
  });
});
