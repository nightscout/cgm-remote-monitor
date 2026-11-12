'use strict';

// Registry OIDC uses alias origins and dynamic, separately scoped signing keys.
// Actual crypto/token and HTTP boundaries, synthetic registry/provider/store.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, generateKeyPairSync, sign } = require('node:crypto');
const express = require('express');
const request = require('supertest');
const { createRegistryHumanAccess } = require('../lib/human-session/registry-access');
const { createOriginRuntimes } = require('../lib/human-session/registry-runtime');
const rules = require('../lib/tenant-registry/rules');
const { HUMAN_KIDS } = require('../lib/tenant-registry/provision');
const { PREFIX } = require('../lib/human-session/http');
const A = randomUUID(), B = randomUUID(), C = randomUUID();
const config = { issuer: 'https://idp.example.test', clientId: 'synthetic', clientSecret: 'synthetic', signingAlgorithm: 'RS256', cookieKey: randomBytes(32) };
function trust () {
  return { OIDC_ACCESS_CONFIG: JSON.stringify({ version: 1, registry: true, issuer: 'https://human.example.test',
    audiences: { data: 'human-data', management: 'human-management' },
    vault: { addressEnv: 'HUMAN_VAULT_ADDR', mount: 'transit', tokenEnv: 'HUMAN_VAULT_TOKEN' } }),
  HUMAN_VAULT_ADDR: 'https://vault.example.test/', HUMAN_VAULT_TOKEN: 'synthetic' };
}
function keys (tenant, privateKeys) {
  return Object.freeze({ tenant, state: 'active', signingVersion: 1, keys: ['access', 'management', 'human-data', 'human-management'].map(purpose => {
    const pair = generateKeyPairSync('ed25519'); privateKeys.set(rules.vaultKey(tenant, purpose), pair.privateKey);
    return { purpose, kid: HUMAN_KIDS[purpose.slice(6)] || purpose + '-1', publicKey: Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64') };
  }) });
}
describe('registry-backed human access and origin clients', function () {
  it('RH_KEYS: each tenant/purpose uses its separate registry key; wrong tenant and headless key substitution refuse', async function () {
    const privateKeys = new Map(), entries = new Map([[A, keys(A, privateKeys)], [B, keys(B, privateKeys)]]), selectedKeys = [];
    const registry = { maxTenants: 2, entry: async tenant => entries.get(tenant) };
    const access = createRegistryHumanAccess({ source: trust(), registry, createSigner: options => {
      selectedKeys.push(options.signingKey); return { sign: async bytes => sign(null, bytes, privateKeys.get(options.signingKey)) };
    } });
    const at = Math.floor(Date.now() / 1000);
    const issue = (tenant, purpose) => access.issue({ tenant, purpose, subject: 'synthetic', session: 'synthetic-session', credentialVersion: 1, issuedAt: at, expiresAt: at + 600 });
    const token = await issue(A, 'data'), management = await issue(A, 'management');
    assert.equal((await access.verify({ tenant: A, token })).kid, HUMAN_KIDS.data);
    assert.equal((await access.verify({ tenant: A, token: management })).kid, HUMAN_KIDS.management);
    await assert.rejects(access.verify({ tenant: B, token }), { code: 'HUMAN_SESSION_REFUSED' });
    assert.ok(selectedKeys.every(name => name.includes('tenant-human-')), 'only human key purposes are used for signing');
    const bad = { ...entries.get(A), keys: entries.get(A).keys.map(key => key.purpose === 'human-data' ? { ...key, publicKey: entries.get(A).keys[0].publicKey } : key) };
    entries.set(A, bad);
    await assert.rejects(issue(A, 'data'), /registry-backed human access/);
  });
  it('RH_REFRESH: a new registry entry invalidates cached public keys; key cache remains bounded and removed tenants refuse', async function () {
    const privateKeys = new Map(), entries = new Map([A, B, C].map(tenant => [tenant, keys(tenant, privateKeys)]));
    const registry = { maxTenants: 2, entry: async tenant => entries.get(tenant) };
    const access = createRegistryHumanAccess({ source: trust(), registry,
      createSigner: options => ({ sign: async bytes => sign(null, bytes, privateKeys.get(options.signingKey)) }) });
    const at = Math.floor(Date.now() / 1000), input = { tenant: A, purpose: 'data', subject: 'synthetic', session: 'synthetic-session', credentialVersion: 1, issuedAt: at, expiresAt: at + 600 };
    const old = await access.issue(input);
    entries.set(A, keys(A, privateKeys));
    await assert.rejects(access.verify({ tenant: A, token: old }), { code: 'HUMAN_SESSION_REFUSED' });
    const fresh = await access.issue(input); assert.equal((await access.verify({ tenant: A, token: fresh })).tid, A);
    await access.keyId({ tenant: B, purpose: 'data' }); await access.keyId({ tenant: C, purpose: 'data' });
    assert.equal(access.stats().tenants, 2);
    entries.set(A, { ...entries.get(A), state: 'removed' });
    await assert.rejects(access.verify({ tenant: A, token: fresh }), { code: 'HUMAN_SESSION_REFUSED' });
  });
  it('RH_NAMESPACE: ambiguous human/headless verification and local multitenant signing refuse', function () {
    const source = trust(), registry = { maxTenants: 1, entry: async () => null };
    assert.throws(() => createRegistryHumanAccess({ source, registry,
      legacyProfiles: [{ issuer: 'https://human.example.test', audience: 'human-data' }] }), /disjoint/);
    assert.throws(() => createRegistryHumanAccess({ source: { ...source, OIDC_ACCESS_SIGNING_KEY: 'synthetic' }, registry }), /not both/);
    const value = JSON.parse(source.OIDC_ACCESS_CONFIG); value.keys = [];
    assert.throws(() => createRegistryHumanAccess({ source: { ...source, OIDC_ACCESS_CONFIG: JSON.stringify(value) }, registry }), /configuration/);
  });
  function originLab ({ max = 2, create } = {}) {
    const aliases = new Map([['one.example.test', A], ['alias.example.test', A], ['two.example.test', B]]);
    const resolve = async req => { const id = aliases.get(req.headers.host); if (!id) throw new Error('unknown alias'); return id; };
    const registry = { resolveOrigin: async req => ({ tenant: await resolve(req), origin: 'https://' + req.headers.host }) };
    const selected = [];
    const runtime = createOriginRuntimes({ registry, resolver: { resolve }, config, max,
      store: { transaction: async () => { throw new Error('no session mutation during login start'); } },
      access: { keyId () {}, issue () {}, verify () {}, accepts: () => false },
      create: create || (async options => { selected.push(options.redirectUri); return { begin: async () => options.redirectUri }; }) });
    const app = express(); app.use(PREFIX, runtime.router);
    return { aliases, runtime, app, selected };
  }
  it('RH_ORIGINS: callbacks and CSRF follow each resolved alias; provider cache is bounded, and removals cannot use a cached provider', async function () {
    const f = originLab();
    const login = (host, origin = 'https://' + host) => request(f.app).post(PREFIX + '/login').set('Host', host).set('Origin', origin).send({});
    try {
      for (const host of ['one.example.test', 'alias.example.test', 'two.example.test']) {
        const reply = await login(host); assert.equal(reply.status, 200); assert.equal(reply.body.location, 'https://' + host + PREFIX + '/callback');
      }
      assert.equal(f.runtime.stats().origins, 2);
      assert.equal((await login('two.example.test', 'https://one.example.test')).status, 403);
      f.aliases.delete('two.example.test'); assert.equal((await login('two.example.test')).status, 503);
    } finally { f.runtime.close(); }
  });
  it('RH_PENDING: concurrent requests share discovery; pending discovery and failed clients stay bounded', async function () {
    let release, count = 0;
    const waiting = new Promise(resolve => { release = resolve; });
    const f = originLab({ max: 1, create: async options => { count++; await waiting; return { begin: async () => options.redirectUri }; } });
    const login = host => request(f.app).post(PREFIX + '/login').set('Host', host).set('Origin', 'https://' + host).send({});
    try {
      const one = login('one.example.test').then(reply => reply);
      const two = login('one.example.test').then(reply => reply);
      while (!f.runtime.stats().pending) await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal((await login('alias.example.test')).status, 503, 'no second pending discovery beyond the cache bound');
      release(); assert.equal((await one).status, 200); assert.equal((await two).status, 200); assert.equal(count, 1);
    } finally { release(); f.runtime.close(); }
    const broken = originLab({ create: async () => { throw new Error('synthetic provider outage'); } });
    try { assert.equal((await request(broken.app).post(PREFIX + '/login').set('Host', 'one.example.test').send({})).status, 503); assert.equal(broken.runtime.stats().origins, 0); }
    finally { broken.runtime.close(); }
  });
  it('RH_SETTINGS: registry boot needs no global or per-tenant origin list; single-site still requires its explicit origin', function () {
    const source = { OIDC_ISSUER: config.issuer, OIDC_CLIENT_ID: 'synthetic', OIDC_CLIENT_SECRET: 'synthetic', OIDC_COOKIE_KEY: randomBytes(32).toString('base64') };
    assert.equal(require('../lib/human-session/runtime').settings(source, { registry: true }).origin, undefined);
    assert.throws(() => require('../lib/human-session/runtime').settings(source), /requires explicit/);
  });
});
