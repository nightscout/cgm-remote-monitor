'use strict';
const assert = require('node:assert/strict');
const parse = require('../lib/server/serve/owner-credential-config');
const A = '11111111-1111-4111-8111-111111111111';
const existing = { tenants: [A], consumer: 'owner', legacyConnectionString: 'postgres://reader:synthetic@localhost/test',
  legacyNamespace: 'legacy', existingConnections: ['postgres://writer:synthetic@localhost/test', 'postgres://reader:synthetic@localhost/test'], existingNamespaces: ['auth','legacy','access'] };
const make = () => ({ connectionEnv: 'NS_OWNER_SECRETS', namespace: 'secrets', vault: { address: 'https://vault.example.test', mount: 'transit', allowInsecureLoopback: false },
  tenants: [{ id: A, tokenEnv: 'NS_OWNER_VAULT_TOKEN', encryptionKey: 'tenant-a-data', signingKey: 'tenant-a-sign', signingVersion: 1 }] });
const env = { NS_OWNER_SECRETS: 'postgres://issuer:synthetic@localhost/test', NS_OWNER_VAULT_TOKEN: 'synthetic-token' };
describe('operator-only owner credential configuration source', function () {
  it('keeps absent capability disabled and builds only explicit tenant providers from environment references', function () {
    assert.equal(parse(undefined, env, existing), undefined);
    const selected = parse(make(), env, existing);
    assert.equal(selected.consumer, 'owner'); assert.equal(selected.namespace, 'secrets');
    assert.equal(selected.providers.size, 1); assert.equal(typeof selected.providers.get(A).decrypt, 'function');
    assert.equal(selected.legacyConnectionString, existing.legacyConnectionString);
  });
  it('refuses missing references, same writer identity, wrong database, namespace overlap and foreign/duplicate tenants', function () {
    for (const mutate of [v => { v.namespace = 'auth'; }, v => { v.tenants[0].id = 'foreign'; },
      v => { v.tenants.push(v.tenants[0]); }, v => { v.tenants[0].tokenEnv = 'UNDEFINED'; },
      v => { v.vault.address = 'http://vault.example.test'; }, v => { v.tenants[0].signingKey = v.tenants[0].encryptionKey; }]) {
      const value = make(); mutate(value); assert.throws(() => parse(value, env, existing), TypeError);
    }
    for (const address of ['postgres://writer:synthetic@localhost/test', 'postgres://issuer:synthetic@localhost/other']) {
      assert.throws(() => parse(make(), { ...env, NS_OWNER_SECRETS: address }, existing), TypeError);
    }
    assert.throws(() => parse(make(), {}, existing), TypeError);
  });
});
