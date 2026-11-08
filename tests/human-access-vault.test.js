'use strict';
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomBytes, sign, verify } = require('node:crypto');
const { createVaultAccessSigner } = require('../lib/secrets/vault-access-signing');

describe('private bound Ed25519 Transit access signing (synthetic HTTP transport)', function () {
  function setup (overrides = {}) {
    const key = generateKeyPairSync('ed25519'), credential = randomBytes(24).toString('base64url'), calls = [];
    const config = { address: 'https://vault.synthetic.invalid', mount: 'transit', signingKey: 'human-data', signingVersion: 2,
      getToken: async () => credential,
      fetch: async (url, request) => {
        calls.push(url); assert.equal(url, 'https://vault.synthetic.invalid/v1/transit/sign/human-data');
        assert.equal(request.redirect, 'manual'); assert.equal(request.headers['X-Vault-Token'], credential);
        const body = JSON.parse(request.body); assert.equal(body.key_version, 2); assert.equal(body.prehashed, false);
        const signature = sign(null, Buffer.from(body.input, 'base64'), key.privateKey);
        return new Response(JSON.stringify({ data: { signature: 'vault:v2:' + signature.toString('base64') } }));
      }, ...overrides };
    return { signer: createVaultAccessSigner(config), key, calls };
  }

  it('uses only the configured sign endpoint and returns an independently verified 64-byte Ed25519 signature', async function () {
    const source = setup(), input = Buffer.from('synthetic signing input');
    const signature = await source.signer.sign(input);
    assert.equal(signature.length, 64); assert.equal(verify(null, input, source.key.publicKey, signature), true);
    assert.equal(source.calls.length, 1);
  });

  it('refuses HMAC/foreign-version/malformed/oversized responses and server redirects', async function () {
    for (const fetch of [
      async () => new Response(JSON.stringify({ data: { hmac: 'vault:v2:' + randomBytes(32).toString('base64') } })),
      async () => new Response(JSON.stringify({ data: { signature: 'vault:v1:' + randomBytes(64).toString('base64') } })),
      async () => new Response('{'), async () => new Response('x'.repeat(4097)),
      async () => new Response('', { status: 307 }), async () => new Response('', { status: 503 })
    ]) await assert.rejects(setup({ fetch }).signer.sign(Buffer.from('payload')), { code: 'HUMAN_SESSION_UNAVAILABLE' });
  });

  it('bounds a stalled service login and never sends a late credential after its deadline', async function () {
    let sent = 0;
    const source = setup({ timeoutMs: 10, getToken: () => new Promise(resolve => setTimeout(() => resolve(randomBytes(24).toString('hex')), 30)),
      fetch: async () => { sent++; throw new Error('must not reach provider'); } });
    await assert.rejects(source.signer.sign(Buffer.from('payload')), { code: 'HUMAN_SESSION_UNAVAILABLE' });
    await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(sent, 0);
  });

  it('requires explicit TLS/private path configuration and a bounded input', async function () {
    assert.throws(() => setup({ address: 'http://vault.synthetic.invalid' }), TypeError);
    assert.throws(() => setup({ signingKey: '../foreign' }), TypeError);
    await assert.rejects(setup().signer.sign(Buffer.alloc(8193)), TypeError);
    await assert.rejects(setup().signer.sign('payload'), TypeError);
  });
});
