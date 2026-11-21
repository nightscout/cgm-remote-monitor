'use strict';
// covers: lib/tenant-authorization/signature-proof.js, lib/tenant-authorization/access-token.js
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const proof = require('../lib/tenant-authorization/signature-proof');
const tokens = require('../lib/tenant-authorization/access-token');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
function fixture () {
  const pair = crypto.generateKeyPairSync('ed25519');
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'ns-access+jwt', kid: 'synthetic' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: 'synthetic', aud: 'synthetic', tid: A, purpose: 'data', sub: 'subject', sid: 'session', cv: 1, iat: 100, nbf: 100, exp: 700 })).toString('base64url');
  const input = header + '.' + payload;
  return { ...pair, input: Buffer.from(input), token: input + '.' + crypto.sign(null, Buffer.from(input), pair.privateKey).toString('base64url'),
    options: { issuer: 'synthetic', audience: 'synthetic', purpose: 'data', maxLifetimeSeconds: 600, now: () => 100,
      resolveKey: (tenant, kid) => ({ tenant, kid, issuer: 'synthetic', purpose: 'data', publicKey: pair.publicKey }) } };
}
function instrument () {
  const original = crypto.verify; let calls = 0;
  crypto.verify = (...args) => { calls++; return original(...args); };
  return { get calls () { return calls; }, restore: () => { crypto.verify = original; } };
}
describe('pure local Ed25519 signature proof reuse', function () {
  it('reduces only repeated crypto work while resolving current keys and checking current authority every time', async () => {
    const f = fixture(), counter = instrument(); let resolutions = 0, snapshots = 0;
    let state = { active: true, sessionActive: true, keyActive: true, credentialVersion: 1, sessionExpiresAt: 700 };
    const verify = tokens.createVerifier({ ...f.options, resolveKey: (...args) => { resolutions++; return f.options.resolveKey(...args); } });
    const authenticate = tokens.createAuthentication({ verifyToken: verify, snapshot: async () => { snapshots++; return state; }, now: () => 100 });
    try {
      await authenticate({ token: f.token, tenant: A }); await authenticate({ token: f.token, tenant: A });
      assert.equal(counter.calls, 1); assert.equal(resolutions, 2); assert.equal(snapshots, 2);
      for (const mutation of [{ active: false }, { sessionActive: false }, { keyActive: false }, { credentialVersion: 2 }, { sessionExpiresAt: 100 }]) {
        const original = state; state = { ...state, ...mutation };
        await assert.rejects(authenticate({ token: f.token, tenant: A }), { code: 'AUTHORITY_FORBIDDEN' }); state = original;
      }
      assert.equal(counter.calls, 1); assert.equal(resolutions, 7); assert.equal(snapshots, 7);
      await Promise.all(Array.from({ length: 16 }, () => authenticate({ token: f.token, tenant: A })));
      assert.equal(counter.calls, 1); assert.equal(resolutions, 23); assert.equal(snapshots, 23);
    } finally { counter.restore(); }
  });
  it('refuses changed signed bytes or signatures after a valid proof primes the cache; never caches a negative', function () {
    const f = fixture(), verify = tokens.createVerifier(f.options), counter = instrument();
    try {
      verify(f.token, A); const [header, payload, encoded] = f.token.split('.');
      const signature = Buffer.from(encoded, 'base64url'); signature[0] ^= 1;
      const broken = header + '.' + payload + '.' + signature.toString('base64url');
      assert.throws(() => verify(broken, A), { code: 'TOKEN_SIGNATURE' }); assert.throws(() => verify(broken, A), { code: 'TOKEN_SIGNATURE' });
      const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), sid: 'different' })).toString('base64url');
      assert.throws(() => verify(header + '.' + changed + '.' + encoded, A), { code: 'TOKEN_SIGNATURE' });
      assert.equal(counter.calls, 4);
    } finally { counter.restore(); }
  });
  it('freshly checks key removal, key metadata, key rotation under the same kid, tenant and expiry', function () {
    const f = fixture(); let current = f.publicKey, removed = false, purpose = 'data', now = 100;
    const verify = tokens.createVerifier({ ...f.options, now: () => now,
      resolveKey: (tenant, kid) => removed ? undefined : { tenant, kid, issuer: 'synthetic', purpose, publicKey: current } });
    verify(f.token, A);
    removed = true; assert.throws(() => verify(f.token, A), { code: 'TOKEN_KEY' }); removed = false;
    purpose = 'management'; assert.throws(() => verify(f.token, A), { code: 'TOKEN_KEY' }); purpose = 'data';
    current = crypto.generateKeyPairSync('ed25519').publicKey; assert.throws(() => verify(f.token, A), { code: 'TOKEN_SIGNATURE' }); current = f.publicKey;
    assert.throws(() => verify(f.token, B), { code: 'TOKEN_CLAIMS' });
    now = 700; assert.throws(() => verify(f.token, A), { code: 'TOKEN_CLAIMS' });
  });
  it('requires exact public DER for a different immutable key object even under the same kid', function () {
    const f = fixture(), counter = instrument(); let current = f.publicKey;
    const verify = tokens.createVerifier({ ...f.options, resolveKey: (tenant, kid) => ({ tenant, kid, issuer: 'synthetic', purpose: 'data', publicKey: current }) });
    try {
      verify(f.token, A); assert.equal(counter.calls, 1);
      current = crypto.createPublicKey({ key: f.publicKey.export({ format: 'der', type: 'spki' }), format: 'der', type: 'spki' });
      verify(f.token, A); verify(f.token, A); assert.equal(counter.calls, 1);
      current = crypto.generateKeyPairSync('ed25519').publicKey;
      assert.throws(() => verify(f.token, A), { code: 'TOKEN_SIGNATURE' }); assert.equal(counter.calls, 2);
    } finally { counter.restore(); }
  });
  it('does not carry permissive lookup expiry semantics into ordinary verification', function () {
    const f = fixture(), options = { ...f.options, now: () => 700 };
    assert.equal(tokens.createHumanLookupVerifier(options)(f.token, A).lookupOnly, true);
    assert.throws(() => tokens.createVerifier(options)(f.token, A), { code: 'TOKEN_CLAIMS' });
  });
  it('keeps one process bound and evicts cold proofs instead of growing with tenants', function () {
    const f = fixture(), counter = instrument(), samples = [];
    try {
      for (let i = 0; i < 257; i++) {
        const bytes = Buffer.from('synthetic-proof-' + i), signature = crypto.sign(null, bytes, f.privateKey); samples.push({ bytes, signature });
        assert(proof(bytes, f.publicKey, signature));
      }
      assert.equal(counter.calls, 257);
      assert(proof(samples[256].bytes, f.publicKey, samples[256].signature)); assert.equal(counter.calls, 257);
      assert(proof(samples[0].bytes, f.publicKey, samples[0].signature)); assert.equal(counter.calls, 258);
    } finally { counter.restore(); }
  });
  it('enforces the encoded proof byte budget before the entry budget and leaves oversized proofs uncached', function () {
    const f = fixture(), counter = instrument(), samples = [];
    try {
      for (let i = 0; i < 140; i++) {
        const bytes = Buffer.alloc(6000, i), signature = crypto.sign(null, bytes, f.privateKey); samples.push({ bytes, signature });
        assert(proof(bytes, f.publicKey, signature));
      }
      assert.equal(counter.calls, 140);
      assert(proof(samples[0].bytes, f.publicKey, samples[0].signature)); assert.equal(counter.calls, 141);
      const oversized = Buffer.alloc(13000), signature = crypto.sign(null, oversized, f.privateKey);
      assert(proof(oversized, f.publicKey, signature)); assert(proof(oversized, f.publicKey, signature)); assert.equal(counter.calls, 143);
    } finally { counter.restore(); }
  });
  it('discriminates a changed current FIPS policy before reusing any proof', function () {
    const f = fixture(), counter = instrument(), getFips = crypto.getFips; let mode = 0;
    crypto.getFips = () => mode;
    try {
      const signature = crypto.sign(null, f.input, f.privateKey);
      assert(proof(f.input, f.publicKey, signature)); assert.equal(counter.calls, 1);
      mode = 1; assert(proof(f.input, f.publicKey, signature)); assert.equal(counter.calls, 2);
    } finally { crypto.getFips = getFips; counter.restore(); }
  });
});
