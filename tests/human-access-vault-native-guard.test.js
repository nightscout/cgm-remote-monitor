'use strict';

// Inert admission checks only. This file never runs the native Vault proof.
const assert = require('node:assert/strict');
const { run } = require('./human-access-vault-native');
const synthetic = { HUMAN_SESSION_NATIVE_RESERVED: '1', HUMAN_VAULT_RESERVED: '1',
  HUMAN_VAULT_URL: 'http://127.0.0.1:18200', HUMAN_VAULT_ADMIN_TOKEN: 'synthetic-inert-placeholder', HUMAN_VAULT_TENANT: 'single' };

async function refusesWithoutTransport (source, pattern) {
  let calls = 0, consumers = 0;
  await assert.rejects(run({ source, fetch: async () => { calls++; throw new Error('Transport forbidden in inert guard checks'); },
    consume: async () => { consumers++; throw new Error('Consumer forbidden before admission'); } }), pattern);
  assert.equal(calls, 0);
  assert.equal(consumers, 0);
}

describe('native Vault human access admission (inert)', function () {
  it('requires the general native reservation before any transport', async function () {
    await refusesWithoutTransport({ ...synthetic, HUMAN_SESSION_NATIVE_RESERVED: undefined }, /Both HUMAN_SESSION_NATIVE_RESERVED/);
  });
  it('requires the separate Vault reservation before any transport', async function () {
    await refusesWithoutTransport({ ...synthetic, HUMAN_VAULT_RESERVED: undefined }, /HUMAN_VAULT_RESERVED=1 required/);
  });
  it('has no default Vault URL', async function () {
    await refusesWithoutTransport({ ...synthetic, HUMAN_VAULT_URL: undefined }, /Explicit HUMAN_VAULT_URL/);
  });
  it('has no default administrative credential', async function () {
    await refusesWithoutTransport({ ...synthetic, HUMAN_VAULT_ADMIN_TOKEN: undefined }, /HUMAN_VAULT_ADMIN_TOKEN required/);
  });
  it('refuses remote service URLs before transport', async function () {
    await refusesWithoutTransport({ ...synthetic, HUMAN_VAULT_URL: 'https://vault.synthetic.invalid' }, /literal loopback origin/);
  });
  it('refuses credentials and selectors embedded in a URL', async function () {
    for (const value of ['http://synthetic@127.0.0.1:18200', 'http://127.0.0.1:18200/path', 'http://127.0.0.1:18200?selector=synthetic', 'http://127.0.0.1:18200#synthetic']) {
      await refusesWithoutTransport({ ...synthetic, HUMAN_VAULT_URL: value }, /without credentials, path or selectors/);
    }
  });
  it('refuses malformed URL configuration before transport', async function () {
    await refusesWithoutTransport({ ...synthetic, HUMAN_VAULT_URL: 'synthetic-non-url' }, /Explicit loopback Vault origin required/);
  });
  it('does not create a default or implicit consumer callback', async function () {
    let calls = 0;
    await assert.rejects(run({ source: synthetic, consume: 'implicit-child', fetch: async () => { calls++; } }), /Explicit bounded native consumer/);
    assert.equal(calls, 0);
  });
  it('requires an explicit authentication binding before any transport', async function () {
    await refusesWithoutTransport({ ...synthetic, HUMAN_VAULT_TENANT: undefined }, /Explicit HUMAN_VAULT_TENANT/);
  });
  it('admits no arbitrary authentication binding spelling', async function () {
    await refusesWithoutTransport({ ...synthetic, HUMAN_VAULT_TENANT: 'single-alias' }, /no implicit authentication scope/);
  });
});
