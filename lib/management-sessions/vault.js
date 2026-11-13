'use strict';

const { createPublicKey, verify } = require('node:crypto');
const { createVaultAccessSigner } = require('../secrets/vault-access-signing');
const rules = require('../tenant-registry/rules');
const fail = code => Object.assign(new Error(code), { code });
const publicKey = raw => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw, 'base64')]), format: 'der', type: 'spki' });
function createVaultKeySource ({ address, mount, getToken, timeoutMs = 5000, allowInsecureLoopback = false, fetch: transport = globalThis.fetch }) {
  const url = new URL(address), segment = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (!segment(mount) || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      url.protocol !== 'https:' && !(allowInsecureLoopback && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.protocol === 'http:') ||
      typeof getToken !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('Explicit bounded management Vault capability required');
  return Object.freeze({
    async select ({ tenant, keys, expected }) {
      const keyName = rules.vaultKey(tenant, 'management'), controller = new AbortController();
      let timer, response;
      const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(fail('MANAGEMENT_SESSION_UNAVAILABLE')); }, timeoutMs); });
      try {
        return await Promise.race([(async () => {
        const token = await getToken({ signal: controller.signal });
        if (controller.signal.aborted || typeof token !== 'string' || !token || token.length > 8192) throw fail('MANAGEMENT_SESSION_UNAVAILABLE');
        response = await transport(url.origin + '/v1/' + mount + '/keys/' + keyName, {
          redirect: 'manual', signal: controller.signal, headers: { 'X-Vault-Token': token } });
        if (!response.ok || !response.body) throw fail('MANAGEMENT_SESSION_UNAVAILABLE');
        const chunks = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > 262144) throw fail('MANAGEMENT_SESSION_KEY_REFUSED'); chunks.push(Buffer.from(chunk)); }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8')).data;
        if (!data || data.type !== 'ed25519' || data.exportable !== false || !data.keys ||
            !Number.isSafeInteger(data.latest_version) || !Number.isSafeInteger(data.min_encryption_version) ||
            data.min_encryption_version < 0 || !Array.isArray(keys)) throw fail('MANAGEMENT_SESSION_KEY_REFUSED');
        const candidates = [];
        for (const [version, value] of Object.entries(data.keys)) {
          if (!/^[1-9][0-9]{0,8}$/.test(version) || Number(version) > data.latest_version || Number(version) < Math.max(1, data.min_encryption_version)) continue;
          for (const key of keys) if (key.public_key === value.public_key && (!expected || expected.kid === key.kid && expected.key_version === Number(version))) {
            candidates.push({ kid: key.kid, keyVersion: Number(version), public: key.public_key });
          }
        }
        candidates.sort((a, b) => b.keyVersion - a.keyVersion);
        if (!candidates.length || candidates.length > 1 && candidates[0].keyVersion === candidates[1].keyVersion) throw fail('MANAGEMENT_SESSION_KEY_REFUSED');
        const chosen = candidates[0], verificationKey = publicKey(chosen.public);
        const signer = createVaultAccessSigner({ address, mount, signingKey: keyName, signingVersion: chosen.keyVersion, getToken, timeoutMs, allowInsecureLoopback, fetch: transport });
        return Object.freeze({ kid: chosen.kid, keyVersion: chosen.keyVersion,
          async sign (input) {
            const signature = await signer.sign(input);
            if (!verify(null, input, verificationKey, signature)) throw fail('MANAGEMENT_SESSION_KEY_REFUSED');
            return signature;
          } });
        })(), deadline]);
      } catch (error) { throw fail(error.code === 'MANAGEMENT_SESSION_KEY_REFUSED' ? error.code : 'MANAGEMENT_SESSION_UNAVAILABLE'); }
      finally { clearTimeout(timer); controller.abort(); await response?.body?.cancel().catch(() => {}); }
    }
  });
}
module.exports = { createVaultKeySource };
