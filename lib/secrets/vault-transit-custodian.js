'use strict';

// Operator-plane Transit key custodian for post-deletion key destruction. It is
// a separate credential from the serving adapter (vault-transit.js): the serving
// token has no key-management capability. Required operator policy, per key:
//   path "<mount>/keys/<key>/config" { capabilities = ["update"] }
//   path "<mount>/keys/<key>"        { capabilities = ["read", "delete"] }
// Destroying a Transit key is irreversible: every ciphertext under it, in the
// database and in any export artifact, can no longer be decrypted. Responses
// and provider errors are never surfaced; only fixed codes leave this module.

function failure (code) {
  const error = new Error('Secrets provider key destruction failed');
  error.code = code;
  return error;
}

function segment (value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new TypeError('Invalid Transit mount or key name');
  return value;
}

function createVaultTransitCustodian ({ address, getToken, timeoutMs = 5000, allowInsecureLoopback = false, keyAllowed }) {
  const url = new URL(address);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(allowInsecureLoopback && loopback && url.protocol === 'http:'))) {
    throw new TypeError('Vault requires an HTTPS origin (explicit loopback HTTP is test-only)');
  }
  // Trusted provisioning decides which keys belong to which tenant; a ledger
  // record alone never selects an arbitrary Vault path for deletion.
  if (typeof getToken !== 'function' || typeof keyAllowed !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new TypeError('Vault credential callback, key admission and bounded timeout are required');
  }

  async function call (method, path, body) {
    let response;
    try {
      const token = await getToken();
      if (typeof token !== 'string' || !token) throw failure('SECRETS_PROVIDER_UNAVAILABLE');
      response = await fetch(url.origin + '/v1/' + path, {
        method, redirect: 'manual',
        headers: { 'X-Vault-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (response.body) await response.body.cancel();
    } catch {
      throw failure('SECRETS_PROVIDER_UNAVAILABLE');
    }
    return response.status;
  }

  async function present (mount, name) {
    const status = await call('GET', mount + '/keys/' + name);
    if (status === 200) return true;
    if (status === 404) return false;
    throw failure('SECRETS_PROVIDER_REFUSED');
  }

  return Object.freeze({
    // Idempotent: an already absent key counts as destroyed after a lookup
    // that distinguishes absence (404) from denial (403).
    async destroy ({ tenant, keys } = {}) {
      if (!Array.isArray(keys) || !keys.length) throw new TypeError('Keys to destroy are required');
      for (const key of keys) {
        segment(key.mount); segment(key.name);
        if (await keyAllowed({ tenant, mount: key.mount, name: key.name }) !== true) throw failure('SECRETS_KEY_NOT_ADMITTED');
      }
      let absent = 0;
      for (const { mount, name } of keys) {
        if (await present(mount, name)) {
          const configured = await call('POST', mount + '/keys/' + name + '/config', { deletion_allowed: true });
          if (configured !== 200 && configured !== 204) throw failure('SECRETS_PROVIDER_REFUSED');
          const deleted = await call('DELETE', mount + '/keys/' + name);
          if (deleted !== 200 && deleted !== 204) throw failure('SECRETS_PROVIDER_REFUSED');
          if (await present(mount, name)) throw failure('SECRETS_PROVIDER_RESPONSE');
        }
        absent++;
      }
      return Object.freeze({ destroyed: true, absent });
    }
  });
}

module.exports = { createVaultTransitCustodian };
