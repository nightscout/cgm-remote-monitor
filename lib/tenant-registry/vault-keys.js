'use strict';

// Provisioning's Vault Transit key step: create a tenant key if it is absent,
// adopt it if it exists with the expected type, and read Ed25519 public keys.
// Never exports, rotates or deletes a key. Key names come from rules.vaultKey.
// Provider bodies and errors are redacted (they may carry credentials).
const fail = code => Object.assign(new Error(code), { code });
const MAX_KEY_METADATA_BYTES = 65536;
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
  // One deadline spans the complete key operation, including credentials,
  // provider cleanup and GET->POST->GET. A late provider promise cannot resume
  // an undispatched request. An already dispatched POST remains uncertain.
  async function bounded (check, work) {
    const controller = new AbortController(), deadline = performance.now() + timeoutMs;
    let expired = false, timer;
    const guard = () => {
      check();
      if (expired || performance.now() >= deadline) throw fail('TENANT_PROVISION_VAULT_UNAVAILABLE');
    };
    const timeout = new Promise((_resolve,reject) => {
      timer = setTimeout(() => { expired = true; controller.abort(); reject(fail('TENANT_PROVISION_VAULT_UNAVAILABLE')); },timeoutMs);
    });
    try { guard(); return await Promise.race([work({check:guard,signal:controller.signal}),timeout]); }
    finally { clearTimeout(timer); }
  }
  async function request (path, body, context) {
    const {check,signal} = context;
    let response, value;
    try {
      check(); const token = await getToken(); check();
      if (typeof token !== 'string' || !token) throw fail('TENANT_PROVISION_VAULT_UNAVAILABLE');
      check(); response = await fetchImpl(url.origin + '/v1/' + mount + '/' + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
        headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal });
      check();
      if (response.status === 404) { await response.body?.cancel(); check(); return null; }
      if (!response.ok) { await response.body?.cancel(); check(); throw fail('TENANT_PROVISION_VAULT_REFUSED'); }
      if (response.status === 204) value = {};
      else {
        // A key can accumulate many versions. Bound bytes BEFORE decoding or
        // JSON allocation; an oversized/unconfirmed body is never absence.
        if (!response.body || !response.body[Symbol.asyncIterator]) throw fail('TENANT_PROVISION_VAULT_UNAVAILABLE');
        let bytes = 0; const chunks = [];
        for await (const chunk of response.body) {
          check(); if (!(chunk instanceof Uint8Array)) throw fail('TENANT_PROVISION_VAULT_UNAVAILABLE');
          bytes += chunk.byteLength;
          if (bytes > MAX_KEY_METADATA_BYTES) throw fail('TENANT_PROVISION_VAULT_UNAVAILABLE');
          chunks.push(Buffer.from(chunk)); check();
        }
        check(); value = JSON.parse(Buffer.concat(chunks).toString('utf8')); check();
      }
    } catch (error) {
      if (error?.code === 'TENANT_PROVISION_VAULT_REFUSED') throw error;
      throw fail('TENANT_PROVISION_VAULT_UNAVAILABLE');
    }
    return value;
  }
  async function read (name, context) {
    const value = await request('keys/' + name,undefined,context);
    if (value === null) return null;
    if (!value || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) throw fail('TENANT_PROVISION_VAULT_UNAVAILABLE');
    return value.data;
  }
  const shaped = (key, type) => !!key && key.type === type && key.exportable !== true &&
    (type !== 'ed25519' || (typeof key.keys?.['1']?.public_key === 'string' && Buffer.from(key.keys['1'].public_key, 'base64').length === 32));
  return Object.freeze({
    // Read only: 'absent', 'present' (the type and shape `ensure` adopts) or 'mismatch'.
    async status (name, type) {
      if (!SEGMENT.test(name) || !['aes256-gcm96', 'ed25519'].includes(type)) throw new TypeError('Invalid Vault key request');
      return bounded(() => {},async context => {
        const key = await read(name,context); context.check();
        return key === null ? 'absent' : shaped(key, type) ? 'present' : 'mismatch';
      });
    },
    // Read-only evidence for ensure. Only version 1 is registered by the
    // current provisioning grammar; never return provider bodies or key material.
    async observe (name, type, check = () => {}) {
      if (!SEGMENT.test(name) || !['aes256-gcm96', 'ed25519'].includes(type)) throw new TypeError('Invalid Vault key request');
      return bounded(check,async context => {
      const key = await read(name,context); context.check();
      if (!key) return null;
      if (!shaped(key, type)) throw fail('TENANT_PROVISION_VAULT_KEY_MISMATCH');
      return Object.freeze({ type, version: 1, ...(type === 'ed25519' ? { publicKey: key.keys['1'].public_key } : {}) });
      });
    },
    // -> { created, publicKey? } ; publicKey is version 1's for an Ed25519 key.
    async ensure (name, type, check = () => {}) {
      if (!SEGMENT.test(name) || !['aes256-gcm96', 'ed25519'].includes(type)) throw new TypeError('Invalid Vault key request');
      return bounded(check,async context => {
      let key = await read(name,context), created = false; context.check();
      if (!key) {
        await request('keys/' + name, { type, exportable: false },context);
        created = true;
        key = await read(name,context); context.check();
      }
      if (!key || key.type !== type || key.exportable === true) throw fail('TENANT_PROVISION_VAULT_KEY_MISMATCH');
      if (type !== 'ed25519') return Object.freeze({ created });
      const publicKey = key.keys?.['1']?.public_key;
      if (typeof publicKey !== 'string' || Buffer.from(publicKey, 'base64').length !== 32) throw fail('TENANT_PROVISION_VAULT_KEY_MISMATCH');
      return Object.freeze({ created, publicKey });
      });
    }
  });
}

module.exports = { createVaultKeys, MAX_KEY_METADATA_BYTES };
