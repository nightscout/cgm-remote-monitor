'use strict';

// covers: lib/server/serve/deployment-settings.js
// Old layout versus new (decision config-few-dozen-env): the configuration each
// role builds from its environment equals the document the deployment wrote for
// the same prefix (tests/fixtures/deployment-documents-8d4475e.json), except for
// the differences named here. Namespace names and bookkeeping identities are
// byte-identical, so an existing database keeps its schemas and checkpoint rows.
// Synthetic values only.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const settings = require('../lib/server/serve/deployment-settings');
const golden = require('./fixtures/deployment-documents-8d4475e.json');

const url = name => 'postgres://nsdemo_' + name + ':synthetic@postgres:5432/nightscout';
const env = { NS_VAULT_ADDR: 'https://vault.example.test:8200', NS_EVALUATOR_PG: url('evaluator'), NS_ALARM_PG: url('alarm'), NS_LIFETIME_PG: url('lifetime_api'),
  NS_PROVISIONER_PG: url('provisioner'), NS_OWNERSHIP_PG: url('ownership_operator'), NS_CONNECTOR_SOURCES_PG: url('connector_writer'), NS_MANAGEMENT_SESSIONS_PG: url('management_issuer') };

describe('deployment settings: the environment builds the deployment\'s documents', function () {
  it('DS_LAYOUT: every role configuration equals the deployment document for the default prefix', function () {
    const expected = structuredClone(golden.configs);
    // Writer-driven input is the only transport (lib/writer-driven): the evaluator
    // keeps only its clinical bounds, and the api marks the evaluator work row.
    const ns = settings.layout(env).namespaces;
    expected.evaluator.pgstream = { bounds: expected.evaluator.pgstream.bounds };
    expected.evaluator.writerDriven = { sweepMs: 5000, lifecycleNamespace: ns.control };
    expected.api.writerDriven = { pending: { namespace: ns.eval_checkpoint, consumer: settings.IDENTITY.evaluatorConsumer + '-completed' } };
    // The api reads the evaluator's notification metadata from its own environment.
    expected.api.socketForwarding.consumerState = {};
    // The api has no `access` namespace (deployment-signing-secret, amendment 4).
    delete expected.api.postgres.namespaces.access;
    for (const role of ['api', 'realtime', 'evaluator', 'tenant-admin']) {
      assert.deepStrictEqual(settings.configuration(role, env), expected[role], role);
    }
  });

  it('DS_ADMIN: the admin configuration equals the deployment document; the completed checkpoint carries the native contract digest', function () {
    const expected = structuredClone(golden.admin), built = settings.configuration('admin', env);
    expected.ownership.configurationNamespace = settings.layout(env).namespaces.owner_configuration;
    const completed = expected.provisioning.checkpoints.find(row => row.consumer.endsWith('-completed'));
    // The deployment replaced this digest with the native selection's when it
    // attached the selection at bootstrap; the role now computes it itself.
    completed.digest = settings.nativeSelection(settings.layout(env)).contractDigest;
    // Bootstrap writes the owner's configure authority (one-call-usable-provisioning).
    expected.provisioning.namespaces.ownerConfiguration = settings.layout(env).namespaces.owner_configuration;
    // Signing is in process (deployment-signing-secret): management sessions hold no
    // Vault credential, and provisioning issues data JWTs in the api's realm.
    delete expected.managementSessions.vault;
    expected.provisioning.accessTokens = { ...golden.configs.api.accessTokens };
    // Provisioning creates this row typed and pending (lib/writer-driven).
    expected.provisioning.pendingConsumer = { namespace: completed.namespace, consumer: completed.consumer };
    assert.deepStrictEqual(built, expected);
    // Each admin service is composed when the process has its connection secret.
    assert.deepStrictEqual(Object.keys(settings.configuration('admin', { NS_OWNERSHIP_PG: env.NS_OWNERSHIP_PG })), ['version', 'maxBytes', 'timeoutMs', 'ownership']);
  });

  it('DS_OPERATION: the operation lease names the same control namespace, registry and identity, and no database identity', function () {
    // leaseSessions was validated but read by nothing (lib), so it is not a setting.
    const built = settings.operation(env), { version, leaseSessions, ...expected } = golden.operation; // eslint-disable-line no-unused-vars
    assert.deepStrictEqual({ namespace: built.namespace, connectionEnv: built.connectionEnv, registry: built.registry }, expected);
    assert.deepStrictEqual(Object.keys(built.nativeSelection.binding).sort(), ['consumer', 'lifecycleNamespace', 'namespace']);
    assert.strictEqual(settings.operation({ ...env, NS_LIFETIME_PG: undefined }), null);
  });

  it('DS_PREFIX: another prefix renames every namespace and nothing else', function () {
    const other = settings.configuration('evaluator', { ...env, NS_PG_PREFIX: 'site2' }), base = settings.configuration('evaluator', env);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(other).replaceAll('site2_', 'nsdemo_')), base);
    assert.throws(() => settings.layout({ NS_PG_PREFIX: 'Pg-bad' }), /NS_PG_PREFIX/);
  });

  it('loads mounted database settings and reads a rotated Vault Agent token on the next call', async function () {
    const plan = require('./fixtures/multitenant-plan');
    const layout = plan.layout('nstest');
    const { api } = plan.documents({ layout, urls: plan.syntheticUrls(layout) }).environments;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-vault-agent-'));
    const sink = path.join(dir, 'token');
    try {
      fs.writeFileSync(sink, 'first', { mode: 0o600 });
      fs.writeFileSync(path.join(dir, 'api-pg'), api.NS_API_PG, { mode: 0o600 });
      const source = { ...api, NS_API_PG_FILE: path.join(dir, 'api-pg'), NS_VAULT_TOKEN_FILE: sink };
      delete source.NS_API_PG;
      const loaded = require('../lib/server/serve/preview-config').load(source);
      assert.strictEqual(await loaded.registryVault.getToken(), 'first');
      fs.writeFileSync(sink + '.new', 'replacement', { mode: 0o600 });
      fs.renameSync(sink + '.new', sink);
      assert.strictEqual(await loaded.registryVault.getToken(), 'replacement');
      fs.unlinkSync(sink);
      await assert.rejects(loaded.registryVault.getToken(), { code: 'SECRETS_PROVIDER_UNAVAILABLE' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('DS_EVALUATOR_SLICE: the hostname ordinal and NS_EVALUATOR_SLICES give the evaluator its slice', function () {
    const os = require('node:os'), hostname = os.hostname;
    const plan = require('./fixtures/multitenant-plan');
    const layout = plan.layout('nstest');
    const base = { ...plan.documents({ layout, urls: plan.syntheticUrls(layout) }).environments.evaluator };
    const config = require('../lib/server/serve/evaluator-config');
    try {
      os.hostname = () => 'evaluator-1';
      const sliced = config.load({ ...base, NS_EVALUATOR_SLICES: '2' });
      assert.deepStrictEqual({ ...sliced.processAssignment }, { count: 2, ordinal: 1 });
      const single = config.load(base);
      assert.strictEqual(single.processAssignment, undefined);
      os.hostname = () => 'evaluator-4';
      assert.strictEqual(config.load({ ...base, NS_EVALUATOR_SLICES: '2' }).processAssignment.ordinal, 4, 'an ordinal >= K starts and owns nothing');
    } finally { os.hostname = hostname; }
  });

  it('DS_SECRET_FILE: a secret is read from NAME, NAME_FILE or the secrets directory, in that order', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-secrets-'));
    try {
      fs.writeFileSync(path.join(dir, 'ns_api_pg'), url('api') + '\n', { mode: 0o600 });
      fs.writeFileSync(path.join(dir, 'other'), url('other'), { mode: 0o600 });
      assert.strictEqual(settings.withSecrets({ NS_SECRETS_DIR: dir }).NS_API_PG, url('api'));
      assert.strictEqual(settings.withSecrets({ NS_SECRETS_DIR: dir, NS_API_PG_FILE: path.join(dir, 'other') }).NS_API_PG, url('other'));
      assert.strictEqual(settings.withSecrets({ NS_SECRETS_DIR: dir, NS_API_PG: url('inline') }).NS_API_PG, url('inline'));
      assert.strictEqual(settings.withSecrets({ NS_SECRETS_DIR: dir }).NS_REALTIME_PG, undefined);
      assert.strictEqual(settings.configuration('api', { ...env, NS_SECRETS_DIR: dir }).vault.tokenFile, path.join(dir, 'vault-token'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
