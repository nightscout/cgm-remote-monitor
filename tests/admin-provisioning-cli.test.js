'use strict';

// `nightscout admin provision` argument and seed parsing, and the admin
// configuration's provisioning section, without a database. Synthetic only.
// covers: lib/cli/commands/admin.js, lib/server/serve/admin-config.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const admin = require('../lib/cli/commands/admin');
const adminConfig = require('../lib/server/serve/admin-config');

describe('admin provisioning client and configuration', function () {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-admin-cli-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, text) => { const file = path.join(dir, name); fs.writeFileSync(file, text); return file; };

  it('reads one schema from JSON and CSV seeds', function () {
    const id = randomUUID();
    const json = admin.seedRows(write('a.json', JSON.stringify({ version: 1, tenants: [{ id, hosts: ['a.example.test', 'b.example.test'], ref: 'lab-1' }] })));
    const csv = admin.seedRows(write('a.csv', 'id,hosts,ref\n' + id + ',a.example.test;b.example.test,lab-1\n'));
    assert.deepEqual(csv, json);
    assert.deepEqual(admin.seedRows(write('b.csv', 'ref,internal_host,id\nlab-2,b.internal.test,' + id + '\n')), [{ id, internalHost: 'b.internal.test', ref: 'lab-2' }]);
  });

  it('refuses seeds outside the schema', function () {
    for (const [name, text] of [['x.csv', 'id,hosts,password\n1,2,3\n'], ['q.csv', 'id,hosts\n"a",b\n'], ['n.csv', 'id,hosts\na\n'],
      ['v.json', JSON.stringify({ version: 2, tenants: [] })], ['f.json', JSON.stringify({ version: 1, tenants: [{ id: 'x', secret: 'y' }] })], ['e.json', '{'], ['t.txt', 'id']]) {
      assert.throws(() => admin.seedRows(write(name, text)), error => error.usage === true, name);
    }
  });

  it('parses flags and refuses mixed or unbounded options', function () {
    const id = randomUUID();
    assert.deepEqual(admin.parseArgs(['--id', id, '--host', 'a.example.test', '--host', 'b.example.test', '--url', 'http://127.0.0.1:1']),
      { hosts: ['a.example.test', 'b.example.test'], id, url: 'http://127.0.0.1:1' });
    for (const args of [[], ['--id', id, '--seed', 'x.json'], ['--seed', 'x.json', '--host', 'a'], ['--seed', 'x.json', '--batch', '101'],
      ['--id', id, '--secrets-out', 'relative.jsonl'], ['--id', id, '--url', 'http://x:1', '--socket', '/tmp/s'], ['--id'], ['--nope']]) {
      assert.throws(() => admin.parseArgs(args), error => error.usage === true, JSON.stringify(args));
    }
  });

  it('admits a provisioning-only admin configuration and refuses a partial one', function () {
    const namespaces = Object.fromEntries(['registry', 'legacy', 'secrets', 'authorization', 'access', 'clock', 'control', 'settings', 'operatorPolicy'].map(kind => [kind, 'nsadm_' + kind.toLowerCase()]));
    const pendingConsumer = { namespace: 'nsadm_eval_checkpoint', consumer: 'evaluator-lab-completed' };
    const provisioning = { connectionEnv: 'NS_PROVISIONER_PG', namespaces, pendingConsumer,
      checkpoints: [{ namespace: 'nsadm_checkpoint', consumer: 'realtime-lab', digest: 'a'.repeat(64) }, { ...pendingConsumer, digest: 'b'.repeat(64) }],
      vault: { address: 'https://vault.example.test/', mount: 'transit', tokenFile: '/run/vault/token' }, accessTokens: { issuer: 'synthetic-data', audience: 'synthetic-api' },
      operator: { principal: 'operator', consumer: 'admin' } };
    const source = { NS_PROVISIONER_PG: 'postgres://prov:synthetic@db.example.test/ns', ...require('./fixtures/signing-secret').env() };
    const parsed = adminConfig.parse({ version: 1, maxBytes: 65536, timeoutMs: 10000, provisioning }, source);
    assert.equal(parsed.provisioning.namespaces.registry, 'nsadm_registry');
    assert.deepEqual(parsed.provisioning.ownerCatalogue, ['*']);
    assert.equal(parsed.provisioning.pendingConsumer.consumer, 'evaluator-lab-completed');
    assert.equal(typeof parsed.provisioning.signing.key, 'function');
    // The provisioning role issues data JWTs: it does not start without the signing secret.
    assert.throws(() => adminConfig.parse({ version: 1, maxBytes: 65536, timeoutMs: 10000, provisioning }, { NS_PROVISIONER_PG: source.NS_PROVISIONER_PG }), /NS_SIGNING_SECRET_FILE/);
    const noRealm = { ...provisioning }; delete noRealm.accessTokens;
    for (const bad of [noRealm, { ...provisioning, vault: { ...provisioning.vault, tokenEnv: 'X' } }, { ...provisioning, namespaces: { ...namespaces, control: 'nsadm_registry' } },
      { ...provisioning, checkpoints: [{ namespace: 'nsadm_checkpoint', consumer: 'r', digest: 'short' }] }, { ...provisioning, tenants: [] }]) {
      assert.throws(() => adminConfig.parse({ version: 1, maxBytes: 65536, timeoutMs: 10000, provisioning: bad }, source));
    }
  });
  it('ADMIN_PROVISIONING_PENDING_CONSUMER_REQUIRED: provisioning without its evaluator pending row refuses at start', function () {
    // Writer-driven is the only input transport: a tenant provisioned without the typed
    // pending row would refuse every write (EVALUATOR_PENDING_MARK_NOT_PROVISIONED).
    const namespaces = Object.fromEntries(['registry', 'legacy', 'secrets', 'authorization', 'access', 'clock', 'control', 'settings', 'operatorPolicy'].map(kind => [kind, 'nsadm_' + kind.toLowerCase()]));
    const pendingConsumer = { namespace: 'nsadm_eval_checkpoint', consumer: 'evaluator-lab-completed' };
    const provisioning = { connectionEnv: 'NS_PROVISIONER_PG', namespaces, pendingConsumer,
      checkpoints: [{ namespace: 'nsadm_checkpoint', consumer: 'realtime-lab', digest: 'a'.repeat(64) }, { ...pendingConsumer, digest: 'b'.repeat(64) }],
      vault: { address: 'https://vault.example.test/', mount: 'transit', tokenFile: '/run/vault/token' }, accessTokens: { issuer: 'synthetic-data', audience: 'synthetic-api' },
      operator: { principal: 'operator', consumer: 'admin' } };
    const source = { NS_PROVISIONER_PG: 'postgres://prov:synthetic@db.example.test/ns', ...require('./fixtures/signing-secret').env() };
    const parse = value => adminConfig.parse({ version: 1, maxBytes: 65536, timeoutMs: 10000, provisioning: value }, source);
    assert.equal(parse(provisioning).provisioning.pendingConsumer.namespace, 'nsadm_eval_checkpoint');
    const missing = { ...provisioning }; delete missing.pendingConsumer;
    for (const bad of [missing, { ...provisioning, checkpoints: [provisioning.checkpoints[0]] },
      { ...provisioning, pendingConsumer: { namespace: 'nsadm_eval_checkpoint', consumer: 'evaluator-lab' } }]) {
      assert.throws(() => parse(bad), error => error.code === 'ADMIN_PROVISIONING_PENDING_CONSUMER_REQUIRED');
    }
    // The library refuses the same omission, so no caller provisions a tenant without the row.
    assert.throws(() => require('../lib/tenant-registry/provision').createProvisioning({ namespaces: {}, checkpoints: [], actor: { principal: 'operator', consumer: 'test' } }),
      error => error.code === 'TENANT_PROVISION_PENDING_CONSUMER_REQUIRED');
  });
});
