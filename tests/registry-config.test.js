'use strict';

// Registry-mode role configuration (decision tenant-registry): a configuration
// that selects the registry refuses any tenant list; the operation window
// derives lock keys by the tenant-id rule. No database; synthetic only.
// covers: lib/server/serve/preview-config.js, lib/server/serve/registry-config.js, lib/server/serve/operation-cohort-config.js, lib/tenant-lifecycle/operation-window.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const previewConfig = require('../lib/server/serve/preview-config');
const operationConfig = require('../lib/server/serve/operation-cohort-config');
const operationWindow = require('../lib/tenant-lifecycle/operation-window');
const rules = require('../lib/tenant-registry/rules');

const SOURCE = { APP_PG: 'postgres://app:synthetic@db.example.test/ns', CHECK_PG: 'postgres://check:synthetic@db.example.test/ns',
  SETTINGS_PG: 'postgres://settings:synthetic@db.example.test/ns', VAULT_TOKEN: 'synthetic-token', LIFE_PG: 'postgres://life:synthetic@db.example.test/ns' };
function apiConfig (extra = {}) {
  return { version: 1, postgres: { connectionEnv: 'APP_PG', readinessConnectionEnv: 'CHECK_PG',
    namespaces: { entries: 'ns_entries', authorization: 'ns_auth', secrets: 'ns_secrets', legacy: 'ns_legacy' } },
  vault: { address: 'https://vault.example.test/', mount: 'transit', tokenEnv: 'VAULT_TOKEN' }, resolution: { mode: 'direct-alias' },
  registry: { namespace: 'ns_registry', refreshMs: 1000 },
  tenantSettings: { connectionEnv: 'SETTINGS_PG', namespaces: { settings: 'ns_tsettings', operatorPolicy: 'ns_tpolicy' } }, ...extra };
}

describe('registry-mode role configuration', function () {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-registry-config-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const load = (config, loader = previewConfig.load, name = 'MULTITENANT_PREVIEW_CONFIG') => {
    const file = path.join(dir, randomUUID() + '.json');
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    return loader({ ...SOURCE, [name]: file });
  };

  it('RC_REGISTRY: the api loads with a registry and no tenant list', function () {
    const config = load(apiConfig());
    assert.deepEqual({ ...config.registry }, { namespace: 'ns_registry', maxTenants: 10000, refreshMs: 1000 });
    assert.equal(config.bindings, null);
    assert.deepEqual(config.tenantIds, ['registry:ns_registry']);
    assert.equal(config.registryVault.mount, 'transit');
  });

  it('RC_TENANTS_REFUSED: a registry configuration that still carries a tenants list is refused', function () {
    const tenants = [{ id: randomUUID(), aliases: ['one.example.test'], vault: { tokenEnv: 'VAULT_TOKEN', encryptionKey: 'a', signingKey: 'b', signingVersion: 1 } }];
    assert.throws(() => load(apiConfig({ tenants })), /registry configuration refuses a tenants list/);
    const withAccess = apiConfig({ accessTokens: { issuer: 'i', audience: 'a', keys: [] } });
    withAccess.postgres.namespaces.access = 'ns_access';
    assert.throws(() => load(withAccess), /registry configuration refuses a tenants list/, 'per-tenant access-token keys are a tenant list too');
    delete withAccess.accessTokens.keys;
    assert.deepEqual(Object.keys(load(withAccess).accessTokens).sort(), ['audience', 'issuer', 'maxLifetimeSeconds', 'purpose']);
  });

  it('RC_BOUNDS: refuses a registry without tenant settings, a per-tenant Vault reference or unbounded refresh', function () {
    const { tenantSettings, ...noSettings } = apiConfig();
    assert.ok(tenantSettings);
    assert.throws(() => load(noSettings), /tenant settings reader/);
    assert.throws(() => load(apiConfig({ vault: { address: 'https://vault.example.test/', mount: 'transit' } })), /role-level Vault credential/);
    assert.throws(() => load(apiConfig({ registry: { namespace: 'ns_registry', refreshMs: 10 } })), /registry bounds/);
    assert.throws(() => load(apiConfig({ socketForwarding: {} })), /socket forwarding/);
  });

  it('RC_LOCK_RULE: the operation configuration names the registry instead of a lock list; the window derives keys by the tenant-id rule', function () {
    const parsed = load({ version: 1, namespace: 'ns_control', connectionEnv: 'LIFE_PG', registry: { namespace: 'ns_registry' } }, operationConfig.load, 'MULTITENANT_OPERATION_CONFIG');
    assert.equal(parsed.locks, null); assert.equal(parsed.lockRule, 'tenant-id-sha256-v1');
    assert.deepEqual([...parsed.tenantIds], ['registry:ns_registry']);
    assert.equal(load({ version: 1, namespace: 'ns_control', connectionEnv: 'LIFE_PG', registry: { namespace: 'ns_registry' }, locks: [] },
      config => { try { return operationConfig.load(config); } catch { return 'refused'; } }, 'MULTITENANT_OPERATION_CONFIG'), 'refused');
    const window = operationWindow.create({ namespace: 'ns_control', lockRule: parsed.lockRule, pool: { connect () { throw new Error('unused'); } } });
    assert.ok(window);
    assert.throws(() => operationWindow.create({ namespace: 'ns_control', lockRule: 'other', pool: { connect () {} } }));
    assert.throws(() => operationWindow.create({ namespace: 'ns_control', lockRule: parsed.lockRule, locks: [{ tenant: randomUUID(), key: '1' }], pool: { connect () {} } }));
    const tenant = randomUUID();
    assert.equal(rules.lockKey(tenant), rules.lockKey(tenant));
  });
});
