'use strict';

function failure (code) {
  const error = new Error('Secrets provider request failed');
  error.code = code;
  return error;
}

function segment (value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError('Invalid Transit mount or key name');
  }
  return value;
}

function version (value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid key version');
  return value;
}

function decode (value) {
  if (typeof value !== 'string') throw failure('SECRETS_PROVIDER_RESPONSE');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw failure('SECRETS_PROVIDER_RESPONSE');
  return bytes;
}

// Each instance is bound by trusted provisioning, never by request-supplied key paths.
function createVaultTransit ({ address, mount, encryptionKey, signingKey, signingVersion, getToken,
  timeoutMs = 5000, allowInsecureLoopback = false }) {
  const url = new URL(address);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(allowInsecureLoopback && loopback && url.protocol === 'http:'))) {
    throw new TypeError('Vault requires an HTTPS origin (explicit loopback HTTP is test-only)');
  }
  segment(mount);
  segment(encryptionKey);
  segment(signingKey);
  if (encryptionKey === signingKey) throw new TypeError('Data and signing keys must be distinct');
  version(signingVersion);
  if (typeof getToken !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new TypeError('Vault credential callback and bounded timeout are required');
  }

  async function request (operation, key, body) {
    let response, result;
    try {
      const token = await getToken();
      if (typeof token !== 'string' || !token) throw failure('SECRETS_PROVIDER_UNAVAILABLE');
      response = await fetch(url.origin + '/v1/' + mount + '/' + operation + '/' + key, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (response.ok) result = await response.json();
      else if (response.body) await response.body.cancel();
    } catch {
      // Provider exceptions and bodies may contain credentials or plaintext.
      throw failure('SECRETS_PROVIDER_UNAVAILABLE');
    }
    if (!response.ok) throw failure('SECRETS_PROVIDER_REFUSED');
    if (!result || !result.data) throw failure('SECRETS_PROVIDER_RESPONSE');
    return result.data;
  }

  return Object.freeze({
    signingVersion,
    async encrypt (plaintext) {
      if (!Buffer.isBuffer(plaintext)) throw new TypeError('Plaintext must be a Buffer');
      const data = await request('encrypt', encryptionKey, { plaintext: plaintext.toString('base64') });
      if (typeof data.ciphertext !== 'string' || !/^vault:v[1-9][0-9]*:/.test(data.ciphertext)) {
        throw failure('SECRETS_PROVIDER_RESPONSE');
      }
      return data.ciphertext;
    },
    async decrypt (ciphertext) {
      if (typeof ciphertext !== 'string' || !/^vault:v[1-9][0-9]*:/.test(ciphertext)) {
        throw new TypeError('Invalid ciphertext');
      }
      return decode((await request('decrypt', encryptionKey, { ciphertext })).plaintext);
    },
    async rewrap (ciphertext, targetVersion) {
      version(targetVersion);
      const match = typeof ciphertext === 'string' && /^vault:v([1-9][0-9]*):/.exec(ciphertext);
      if (!match || !Number.isSafeInteger(Number(match[1]))) throw new TypeError('Invalid ciphertext');
      const currentVersion = Number(match[1]);
      if (targetVersion < currentVersion) throw new TypeError('Ciphertext key downgrade is forbidden');
      const data = await request('rewrap', encryptionKey, { ciphertext, key_version: targetVersion });
      if (typeof data.ciphertext !== 'string' || !data.ciphertext.startsWith('vault:v' + targetVersion + ':')) {
        throw failure('SECRETS_PROVIDER_RESPONSE');
      }
      // Validate with the provider even on retry, but keep the stored bytes stable.
      return targetVersion === currentVersion ? ciphertext : data.ciphertext;
    },
    async sign (input) {
      if (!Buffer.isBuffer(input)) throw new TypeError('Signing input must be a Buffer');
      const data = await request('hmac', signingKey, {
        input: input.toString('base64'), algorithm: 'sha2-256', key_version: signingVersion
      });
      const prefix = 'vault:v' + signingVersion + ':';
      if (typeof data.hmac !== 'string' || !data.hmac.startsWith(prefix)) throw failure('SECRETS_PROVIDER_RESPONSE');
      const signature = decode(data.hmac.slice(prefix.length));
      if (signature.length !== 32) throw failure('SECRETS_PROVIDER_RESPONSE');
      return signature;
    },
    async verify (keyVersion, input, signature) {
      version(keyVersion);
      if (!Buffer.isBuffer(input) || !Buffer.isBuffer(signature) || signature.length !== 32) {
        throw new TypeError('Invalid HMAC input');
      }
      const data = await request('verify', signingKey, {
        input: input.toString('base64'),
        hmac: 'vault:v' + keyVersion + ':' + signature.toString('base64'),
        hash_algorithm: 'sha2-256'
      });
      if (typeof data.valid !== 'boolean') throw failure('SECRETS_PROVIDER_RESPONSE');
      return data.valid;
    }
  });
}

module.exports = { createVaultTransit };
