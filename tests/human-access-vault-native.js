'use strict';

// Finite opt-in Vault service acceptance. No process, listener or service is
// created. URLs/tokens must name the explicitly reserved owned loopback Vault.
// Required environment: HUMAN_SESSION_NATIVE_RESERVED=1, HUMAN_VAULT_RESERVED=1,
// HUMAN_VAULT_URL (explicit HTTP/HTTPS loopback origin), HUMAN_VAULT_ADMIN_TOKEN,
// HUMAN_VAULT_TENANT (exact private 'single' or canonical multitenant UUID).
// Each invocation creates a new mount/profile for exactly that one binding;
// separate sequential single/multitenant runs never reuse cross-scope configs.
// HTTP stays an owned lab-only option; HTTPS uses normal trust, never bypassed.
// Administrative calls are capped at 3 seconds and 64 KiB per response; serving
// issuance uses the production signer's separate 5-second bound. Fixed loops,
// a 10-minute operation budget and the caller's whole-composite deadline keep
// this finite. Scoped tokens have a nonrenewable 15-minute maximum. There is no
// production service-login/lease-renewal, HTTPS-deployment or real-data claim.
// The optional consume callback must await its bounded child/owned cleanup;
// dedicated signer success alone is not HTTP/browser/native-store acceptance.
// Protocol basis: https://developer.hashicorp.com/vault/api-docs/secret/transit
// and https://developer.hashicorp.com/vault/api-docs/auth/token . The existing
// owner-authority lab reads versioned Ed25519 public_key as raw base64(32 bytes).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { loadHumanAccess } = require('../lib/human-session/access-config');
const { createVaultTransit } = require('../lib/secrets/vault-transit');

function configuration (source) {
  if (source.HUMAN_SESSION_NATIVE_RESERVED !== '1' || source.HUMAN_VAULT_RESERVED !== '1') {
    throw new Error('Both HUMAN_SESSION_NATIVE_RESERVED=1 and HUMAN_VAULT_RESERVED=1 required before Vault transport');
  }
  if (typeof source.HUMAN_VAULT_URL !== 'string' || !source.HUMAN_VAULT_URL ||
      typeof source.HUMAN_VAULT_ADMIN_TOKEN !== 'string' || !source.HUMAN_VAULT_ADMIN_TOKEN || source.HUMAN_VAULT_ADMIN_TOKEN.length > 8192) {
    throw new Error('Explicit HUMAN_VAULT_URL and HUMAN_VAULT_ADMIN_TOKEN required; no default Vault');
  }
  let url;
  try { url = new URL(source.HUMAN_VAULT_URL); } catch { throw new Error('Explicit loopback Vault origin required'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('Reserved Vault must be a literal loopback origin without credentials, path or selectors');
  }
  const tenant = source.HUMAN_VAULT_TENANT;
  if (tenant !== 'single' && (typeof tenant !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant))) {
    throw new Error('Explicit HUMAN_VAULT_TENANT must be exact single or a canonical UUID; no implicit authentication scope');
  }
  return { address: url.origin, adminToken: source.HUMAN_VAULT_ADMIN_TOKEN, tenant,
    mode: tenant === 'single' ? 'single' : 'multi', allowInsecureLoopback: url.protocol === 'http:' };
}

async function run ({ source = process.env, fetch: transport = globalThis.fetch, consume, nativeStage } = {}) {
  // Admission/configuration precede scratch writes and every network operation.
  const config = configuration(source);
  if (typeof transport !== 'function') throw new TypeError('Bounded Vault transport required');
  if (consume !== undefined && typeof consume !== 'function') throw new TypeError('Explicit bounded native consumer callback required');
  const budget = require('./fixtures/human-native-budget')({ stage: nativeStage, id: 'vault-' + config.mode, persistence: 'vault' });
  let cleaning = false;
  const suffix = randomBytes(8).toString('hex'), mount = 'human-native-' + suffix;
  const policies = [], tokens = [], checks = [], cleanup = [];
  const signPolicy = 'human-sign-' + suffix, legacyPolicy = 'human-hmac-' + suffix;
  let mountAttempted = false, tokenCreationUnknown = false, scratch, primary;
  const started = Date.now();
  async function api (endpoint, { method = 'GET', body, token = config.adminToken } = {}) {
    if (cleaning) budget.cleanup(); else budget.active();
    if (typeof endpoint !== 'string' || !/^[A-Za-z0-9_/-]+$/.test(endpoint) || endpoint.includes('..')) {
      throw new Error('Native Vault endpoint must be statically bound to owned resources');
    }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 3000);
    let response;
    try {
      response = await transport(config.address + '/v1/' + endpoint, { method, redirect: 'manual', signal: controller.signal,
        headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const chunks = []; let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const result = await reader.read(); if (result.done) break;
            size += result.value.length;
            if (size > 65536) throw new Error('Native Vault response exceeded bound');
            chunks.push(Buffer.from(result.value));
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
      const bytes = Buffer.concat(chunks);
      return { status: response.status, data: bytes.length ? JSON.parse(bytes.toString('utf8')) : null };
    } catch (cause) {
      // Do not render transport exceptions/bodies containing private tokens.
      // Preserve the original in memory; the CLI below never serializes cause.
      throw new Error('Native Vault request unavailable or malformed', { cause });
    } finally { clearTimeout(timer); controller.abort(); await response?.body?.cancel().catch(() => {}); }
  }
  async function expect (endpoint, options, status) {
    const result = await api(endpoint, options);
    assert.equal(result.status, status, 'unexpected status for owned Vault operation ' + endpoint);
    return result.data;
  }
  async function check (name, work) {
    assert(Date.now() - started < 600000, 'finite native Vault operation budget exceeded');
    budget.active(); await work(); budget.active(); checks.push({ name, pass: true });
  }
  async function policy (name, text) {
    await expect('sys/policies/acl/' + name, {}, 404);
    // Track the unique owned name before a request whose reply can be lost.
    policies.push(name);
    await expect('sys/policies/acl/' + name, { method: 'PUT', body: { policy: text } }, 204);
    await expect('sys/policies/acl/' + name, {}, 200);
  }
  async function issueToken (name) {
    tokenCreationUnknown = true;
    const result = await expect('auth/token/create', { method: 'POST', body: { policies: [name], no_default_policy: true,
      ttl: '15m', explicit_max_ttl: '15m', renewable: false, type: 'service', display_name: 'synthetic-human-native' } }, 200);
    const auth = result?.auth;
    assert(auth && typeof auth.client_token === 'string' && auth.client_token && typeof auth.accessor === 'string' && auth.accessor,
      'actual scoped token and revocation accessor required');
    const record = { token: auth.client_token, accessor: auth.accessor, revoked: false };
    // Track before validating policy metadata so a failed assertion still revokes.
    tokens.push(record);
    tokenCreationUnknown = false;
    assert(Array.isArray(auth.policies) && auth.policies.every(value => typeof value === 'string'), 'scoped token policy metadata required');
    assert.deepEqual(auth.policies.slice().sort(), [name]);
    assert.equal(auth.renewable, false);
    assert(auth.lease_duration >= 840 && auth.lease_duration <= 900,
      'Vault must admit the reviewed 15-minute scoped token lifetime with headroom for the finite composite');
    await expect('auth/token/lookup-accessor', { method: 'POST', body: { accessor: record.accessor } }, 200);
    return record;
  }
  async function revoke (record) {
    if (!record.revoked) {
      await expect('auth/token/revoke-accessor', { method: 'POST', body: { accessor: record.accessor } }, 204);
      record.revoked = true;
    }
    const result = await api('auth/token/lookup-accessor', { method: 'POST', body: { accessor: record.accessor } });
    assert([400, 404].includes(result.status) && Array.isArray(result.data?.errors) &&
      result.data.errors.some(error => typeof error === 'string' && /invalid accessor/i.test(error)), 'revoked owned token accessor must be absent');
  }
  try {
    const preflight = (await expect('sys/mounts', {}, 200)).data;
    assert(preflight && typeof preflight === 'object', 'actual mount catalogue required before creating owned fixture');
    assert(!Object.hasOwn(preflight, mount + '/'), 'unique native Transit mount unexpectedly exists; refuse without claiming ownership');
    mountAttempted = true;
    await expect('sys/mounts/' + mount, { method: 'POST', body: { type: 'transit', description: 'Owned synthetic human-access native proof' } }, 204);
    const publicProfiles = [];
    await check('administrator creates distinct nonexportable Ed25519 keys and provisions exact raw public bytes', async () => {
      for (const purpose of ['data', 'management', 'foreign']) {
        await expect(mount + '/keys/' + purpose, { method: 'POST', body: { type: 'ed25519', derived: false, exportable: false, allow_plaintext_backup: false } }, 204);
        const info = (await expect(mount + '/keys/' + purpose, {}, 200)).data;
        assert.equal(info.type, 'ed25519'); assert.equal(info.exportable, false); assert.equal(info.allow_plaintext_backup, false);
        assert.equal(info.latest_version, 1);
        const encoded = info.keys?.['1']?.public_key;
        assert.equal(typeof encoded, 'string');
        const bytes = Buffer.from(encoded, 'base64');
        assert.equal(bytes.length, 32); assert.equal(bytes.toString('base64'), encoded);
        if (purpose !== 'foreign') publicProfiles.push({ tenant: config.tenant, purpose, kid: 'vault-human-' + purpose,
          publicKey: encoded, current: true, signingKey: purpose, signingVersion: 1 });
      }
      assert.notEqual(publicProfiles[0].publicKey, publicProfiles[1].publicKey);
    });
    await policy(signPolicy, ['data', 'management'].map(key => 'path "' + mount + '/sign/' + key + '" { capabilities = ["update"] }').join('\n'));
    const signing = await issueToken(signPolicy);
    let access, issued, accessConfigPath, accessSource;
    await check('production config and bound Vault signer issue locally verified asymmetric access for both purposes', async () => {
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'human-access-vault-native-'));
      const filename = path.join(scratch, 'public-access.json');
      const publicConfig = { version: 1, issuer: 'synthetic-vault-human-access',
        audiences: { data: 'synthetic-vault-data', management: 'synthetic-vault-management' },
        vault: { addressEnv: 'HUMAN_VAULT_URL', tokenEnv: 'HUMAN_VAULT_SIGN_TOKEN', mount,
          ...(config.allowInsecureLoopback ? { allowInsecureLoopback: true } : {}) }, keys: publicProfiles };
      // Owned random scratch contains public configuration and env names only.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.writeFileSync(filename, JSON.stringify(publicConfig), { mode: 0o600 });
      accessConfigPath = filename;
      accessSource = Object.freeze({ OIDC_ACCESS_CONFIG: filename, HUMAN_VAULT_URL: config.address,
        HUMAN_VAULT_SIGN_TOKEN: signing.token });
      access = loadHumanAccess({ source: accessSource, mode: config.mode, tenants: [config.tenant] });
      const at = Math.floor(Date.now() / 1000);
      for (const purpose of ['data', 'management']) {
        const token = await access.issue({ tenant: config.tenant, subject: 'synthetic_human', session: 'synthetic_session_' + purpose,
          purpose, credentialVersion: 1, issuedAt: at, expiresAt: at + (purpose === 'management' ? 600 : 28800) });
        const claims = access.verify({ tenant: config.tenant, token });
        assert.equal(claims.purpose, purpose); assert.equal(claims.kid, 'vault-human-' + purpose);
        assert.equal(JSON.parse(Buffer.from(token.split('.')[0], 'base64url')).alg, 'EdDSA');
        if (purpose === 'management') issued = token;
      }
    });
    if (consume) await check('explicit bounded consumer callback completed before owned Vault teardown', async () => {
      // SOURCE ATTRIBUTION: a dedicated Vault run is not HTTP/browser/store
      // acceptance. The caller may claim that boundary only from an actual
      // callback child run using this exact config and captured source head.
      // The callback must await child exit and close its own listeners before
      // returning. The external runtime plan bounds the whole composite. This
      // private source map contains ONLY sign-only capability/env references,
      // never the parent admin token. Build child environment explicitly; do
      // not spread the parent's HUMAN_VAULT_ADMIN_TOKEN into the child. Never
      // log this map or include it in the public result.
      try { await consume(Object.freeze({ accessConfigPath, accessSource, tenant: config.tenant, mode: config.mode })); }
      catch (cause) { throw new Error('Bounded native consumer callback failed; inspect its separately retained result', { cause }); }
    });
    await check('sign-only token refuses key reads, exports, writes, deletion, listing and every other selected endpoint', async () => {
      const denied = [
        [mount + '/keys/data', 'GET'], [mount + '/export/signing-key/data', 'GET'],
        [mount + '/export/public-key/data', 'GET'], [mount + '/keys/data', 'POST', { type: 'ed25519' }],
        [mount + '/keys/data/config', 'POST', { deletion_allowed: true }], [mount + '/keys/data', 'DELETE'],
        [mount + '/keys', 'LIST'], [mount + '/sign/foreign', 'POST', { input: 'c3ludGhldGlj', key_version: 1, prehashed: false }],
        [mount + '/sign/data/sha2-256', 'POST', { input: 'c3ludGhldGlj', key_version: 1, prehashed: false }],
        [mount + '/hmac/legacy-sign', 'POST', { input: 'c3ludGhldGlj', algorithm: 'sha2-256', key_version: 1 }]
      ];
      for (const [endpoint, method, body] of denied) await expect(endpoint, { method, body, token: signing.token }, 403);
      // Prove denied mutations did not change the owned signing key's state.
      const info = (await expect(mount + '/keys/data', {}, 200)).data;
      assert.equal(info.exportable, false); assert.equal(info.deletion_allowed, false); assert.equal(info.latest_version, 1);
    });
    await check('existing legacy Transit HMAC API remains separate and verifies with its own scoped token', async () => {
      for (const name of ['legacy-data', 'legacy-sign']) await expect(mount + '/keys/' + name,
        { method: 'POST', body: { type: 'aes256-gcm96', exportable: false } }, 204);
      await policy(legacyPolicy, ['hmac', 'verify'].map(operation => 'path "' + mount + '/' + operation + '/legacy-sign" { capabilities = ["update"] }').join('\n'));
      const legacyToken = await issueToken(legacyPolicy);
      const legacy = createVaultTransit({ address: config.address, mount, encryptionKey: 'legacy-data', signingKey: 'legacy-sign',
        signingVersion: 1, getToken: () => legacyToken.token, allowInsecureLoopback: config.allowInsecureLoopback, timeoutMs: 3000 });
      const input = Buffer.from('synthetic-legacy-hmac-proof'), signature = await legacy.sign(input);
      assert.equal(signature.length, 32); assert.equal(await legacy.verify(1, input, signature), true);
      const wrong = Buffer.from(signature); wrong[0] ^= 1;
      assert.equal(await legacy.verify(1, input, wrong), false);
    });
    await check('revoked signing token refuses new issuance while existing trusted-public-key verification continues', async () => {
      const live = await expect('auth/token/lookup-accessor', { method: 'POST', body: { accessor: signing.accessor } }, 200);
      assert(live.data?.ttl >= 60, 'scoped signing token must still have at least 60 seconds before intentional revocation');
      const liveAt = Date.now(), before = Math.floor(Date.now() / 1000);
      // Prove actual signing still succeeds immediately before the deliberate
      // revoke, and refresh the bounded verification specimen after callback
      // time. Earlier token expiry must not masquerade as revocation evidence.
      issued = await access.issue({ tenant: config.tenant, subject: 'synthetic_human', session: 'synthetic_session_pre_revoke',
        purpose: 'management', credentialVersion: 1, issuedAt: before, expiresAt: before + 600 });
      assert.equal(access.verify({ tenant: config.tenant, token: issued }).sub, 'synthetic_human');
      await revoke(signing);
      const at = Math.floor(Date.now() / 1000);
      await assert.rejects(access.issue({ tenant: config.tenant, subject: 'synthetic_human', session: 'synthetic_session_after_revoke',
        purpose: 'management', credentialVersion: 1, issuedAt: at, expiresAt: at + 600 }), { code: 'HUMAN_SESSION_UNAVAILABLE' });
      assert(Date.now() - liveAt < 30000, 'intentional revocation observation exceeded token-validity discriminator window');
      assert.equal(access.verify({ tenant: config.tenant, token: issued }).sub, 'synthetic_human');
    });
  } catch (error) { primary = error; }
  finally {
    cleaning = true;
    // Cleanup has its own finite request bounds and touches only named resources
    // created above. No success record is emitted before this completes.
    for (const record of tokens.slice().reverse()) {
      try { await revoke(record); cleanup.push('owned token revoked and accessor absent'); } catch (error) { cleanup.push(error); }
    }
    if (tokenCreationUnknown) cleanup.push(new Error('Scoped token creation outcome unknown; token revocation cannot be confirmed'));
    for (const name of policies.slice().reverse()) {
      try {
        const existing = await api('sys/policies/acl/' + name);
        assert([200, 404].includes(existing.status), 'owned policy lookup must be known before cleanup');
        if (existing.status === 200) await expect('sys/policies/acl/' + name, { method: 'DELETE' }, 204);
        await expect('sys/policies/acl/' + name, {}, 404);
        cleanup.push('owned policy deleted and absent');
      } catch (error) { cleanup.push(error); }
    }
    if (mountAttempted) {
      try {
        const existing = (await expect('sys/mounts', {}, 200)).data;
        assert(existing && typeof existing === 'object', 'actual mount catalogue required for owned cleanup');
        if (Object.hasOwn(existing, mount + '/')) await expect('sys/mounts/' + mount, { method: 'DELETE' }, 204);
        const mounts = (await expect('sys/mounts', {}, 200)).data;
        assert(mounts && !Object.hasOwn(mounts, mount + '/'), 'owned Transit mount must be absent');
        cleanup.push('owned mount disabled and absent');
      } catch (error) { cleanup.push(error); }
    }
    if (scratch) {
      try {
        fs.rmSync(scratch, { recursive: true, force: false });
        // Owned mkdtemp path, never supplied by a request or environment.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        assert.equal(fs.existsSync(scratch), false, 'owned public configuration scratch must be absent after cleanup');
        cleanup.push('owned public configuration removed and absent');
      } catch (error) { cleanup.push(error); }
    }
  }
  try { budget.cleanup(); } catch (error) { cleanup.push(error); }
  const errors = cleanup.filter(item => item instanceof Error);
  if (primary && errors.length) throw new globalThis.AggregateError([primary, ...errors], 'Native Vault proof and owned cleanup failed');
  if (primary) throw primary;
  if (errors.length) throw new globalThis.AggregateError(errors, 'Native Vault owned cleanup failed');
  return { instrument: 'human-access-vault-native', service: 'explicit-owned-loopback-vault', tenant: config.tenant, mode: config.mode,
    resources: { mount, policies: policies.slice() }, checks, cleanup, verdict: 'pass' };
}

if (require.main === module) run().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
  // Error messages are generated locally; response bodies and tokens are omitted.
  process.stderr.write(JSON.stringify({ instrument: 'human-access-vault-native', error: error.name, message: error.message,
    failures: error.errors?.map(item => ({ name: item.name, message: item.message })) }) + '\n');
  process.exitCode = 1;
});

module.exports = { run };
