'use strict';

// Provisioning's Vault Transit key step: create a tenant key if it is absent,
// adopt it if it exists with the expected type, and read Ed25519 public keys.
// Never exports, rotates or deletes a key. Key names come from rules.vaultKey.
// Provider bodies and errors are redacted (they may carry credentials).
const fail = code => Object.assign(new Error(code), { code });
const SEGMENT = /^[a-zA-Z0-9_-]{1,128}$/;

function createVaultKeys ({ address, mount, getToken, timeoutMs = 5000, allowInsecureLoopback = false, fetchImpl = fetch } = {}) {
  const url = new URL(address);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(allowInsecureLoopback && loopback && url.protocol === 'http:'))) {
    throw new TypeError('Vault requires an HTTPS origin (explicit loopback HTTP is test-only)');
  }
  if (!SEGMENT.test(mount || '') || typeof getToken !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new TypeError('Vault key provisioning requires a mount, a credential callback and a bounded timeout');
  }
  async function request (path, body) {
    let response, value;
    try {
      const token = await getToken();
      if (typeof token !== 'string' || !token) throw fail('TENANT_PROVISION_VAULT_UNAVAILABLE');
      response = await fetchImpl(url.origin + '/v1/' + mount + '/' + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
        headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) { await response.body?.cancel(); throw fail('TENANT_PROVISION_VAULT_REFUSED'); }
      value = response.status === 204 ? {} : await response.json();
    } catch (error) {
      if (error?.code === 'TENANT_PROVISION_VAULT_REFUSED') throw error;
      throw fail('TENANT_PROVISION_VAULT_UNAVAILABLE');
    }
    return value;
  }
  async function read (name) {
    const value = await request('keys/' + name);
    return value === null ? null : value.data || null;
  }
  return Object.freeze({
    // -> { created, publicKey? } ; publicKey is version 1's for an Ed25519 key.
    async ensure (name, type) {
      if (!SEGMENT.test(name) || !['aes256-gcm96', 'ed25519'].includes(type)) throw new TypeError('Invalid Vault key request');
      let key = await read(name), created = false;
      if (!key) {
        await request('keys/' + name, { type, exportable: false });
        created = true;
        key = await read(name);
      }
      if (!key || key.type !== type || key.exportable === true) throw fail('TENANT_PROVISION_VAULT_KEY_MISMATCH');
      if (type !== 'ed25519') return Object.freeze({ created });
      const publicKey = key.keys?.['1']?.public_key;
      if (typeof publicKey !== 'string' || Buffer.from(publicKey, 'base64').length !== 32) throw fail('TENANT_PROVISION_VAULT_KEY_MISMATCH');
      return Object.freeze({ created, publicKey });
    }
  });
}

module.exports = { createVaultKeys };
