'use strict';

const fail = code => Object.assign(new Error('Access signing provider refused'), { code });
const segment = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

// Separate from the existing Transit HMAC API. This capability has one bound
// Ed25519 sign endpoint and cannot read/export keys or select a request key URL.
// Provisioning must create a non-exportable Ed25519 key and scope its token to
// sign only. Public keys are separately provisioned to serving verification.
function createVaultAccessSigner ({ address, mount, signingKey, signingVersion, getToken,
  timeoutMs = 5000, allowInsecureLoopback = false, fetch: transport = globalThis.fetch }) {
  const url = new URL(address);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      url.protocol !== 'https:' && !(allowInsecureLoopback && loopback && url.protocol === 'http:') ||
      !segment(mount) || !segment(signingKey) || !Number.isSafeInteger(signingVersion) || signingVersion < 1 ||
      typeof getToken !== 'function' || typeof transport !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new TypeError('Explicit bounded private Ed25519 Transit signing capability required');
  }
  return Object.freeze({
    async sign (input) {
      if (!Buffer.isBuffer(input) || input.length < 1 || input.length > 8192) throw new TypeError('Bounded access signing input required');
      const controller = new AbortController();
      let timer, response;
      try {
        return await Promise.race([
          (async () => {
            const token = await getToken({ signal: controller.signal });
            if (controller.signal.aborted || typeof token !== 'string' || !token || token.length > 8192) throw fail('HUMAN_SESSION_UNAVAILABLE');
            response = await transport(url.origin + '/v1/' + mount + '/sign/' + signingKey, {
              method: 'POST', redirect: 'manual', signal: controller.signal,
              headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
              body: JSON.stringify({ input: input.toString('base64'), key_version: signingVersion, prehashed: false })
            });
            if (!response.ok || !response.body) throw fail('HUMAN_SESSION_UNAVAILABLE');
            const reader = response.body.getReader(), chunks = []; let length = 0;
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                length += value.length;
                if (length > 4096) throw fail('HUMAN_SESSION_UNAVAILABLE');
                chunks.push(Buffer.from(value));
              }
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const prefix = 'vault:v' + signingVersion + ':';
            const value = result?.data?.signature;
            if (typeof value !== 'string' || !value.startsWith(prefix)) throw fail('HUMAN_SESSION_UNAVAILABLE');
            const encoded = value.slice(prefix.length), signature = Buffer.from(encoded, 'base64');
            if (signature.length !== 64 || signature.toString('base64') !== encoded || controller.signal.aborted) throw fail('HUMAN_SESSION_UNAVAILABLE');
            return signature;
          })(),
          new Promise((resolve, reject) => { timer = setTimeout(() => {
            controller.abort(); reject(fail('HUMAN_SESSION_UNAVAILABLE'));
          }, timeoutMs); })
        ]);
      } catch { throw fail('HUMAN_SESSION_UNAVAILABLE'); }
      finally { clearTimeout(timer); controller.abort(); await response?.body?.cancel().catch(() => {}); }
    }
  });
}

module.exports = { createVaultAccessSigner };
