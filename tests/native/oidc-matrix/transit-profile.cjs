'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const fail = () => { throw new Error('MATRIX_NATIVE_TRANSIT_PROFILE_REQUIRED'); };
function admit ({ req, file, env, mode, tenant }) {
  if (!file || !req || !env) fail();
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const access = req('./lib/human-session/access-config').loadHumanAccess({ mode, tenants: [tenant],
    source: { ...env, OIDC_ACCESS_CONFIG: file } });
  const address = new URL(env[config.vault.addressEnv]);
  if (!['http:', 'https:'].includes(address.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) ||
      !address.port || address.origin !== env.HUMAN_VAULT_URL || !env.HUMAN_VAULT_ADMIN_TOKEN ||
      address.username || address.password || address.pathname !== '/' || address.search || address.hash) fail();
  const current = config.keys.filter(key => key.current);
  if (current.length !== 2 || current.some(key => key.tenant !== tenant)) fail();
  return { config, access, address: address.origin, current };
}
async function prove (input) {
  const profile = admit(input);
  for (const key of profile.current) {
    const response = await fetch(profile.address + '/v1/' + profile.config.vault.mount + '/keys/' + key.signingKey,
      { headers: { 'x-vault-token': input.env.HUMAN_VAULT_ADMIN_TOKEN }, signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200, 'native signer key metadata available');
    // Bound response before JSON; do not emit private provider content.
    const reader = response.body.getReader(); let text = '', size = 0;
    for (;;) { const value = await reader.read(); if (value.done) break; size += value.value.length;
      if (size > 65536) { await reader.cancel(); fail(); } text += Buffer.from(value.value).toString('utf8'); }
    const data = JSON.parse(text).data;
    assert.equal(data.type, 'ed25519'); assert.equal(data.exportable, false);
    assert.equal(data.allow_plaintext_backup, false);
    assert.equal(data.keys[String(key.signingVersion)].public_key, key.publicKey,
      'configured accepted public key is the actual native nonexportable signer version');
  }
  return { signing: 'configured-transit', keys: profile.current.length, nonexportable: true };
}
module.exports = { admit, prove };
