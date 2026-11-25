'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { createSecrets } = require('../lib/secrets/component');
const { createSubjectPolicy } = require('../lib/subject-policy/component');
const { validateCatalogue } = require('../lib/migrations/catalogue');
const catalogue = require('../lib/secrets/postgres-candidate.json');
const tenant = '11111111-1111-4111-8111-111111111111';
const actor = { tenant, principal: 'owner', consumer: 'issuer' };

// Actual adapter code, synthetic transaction connection. The SQL and serialized
// rows are inspected independently; native PostgreSQL acceptance is separate.
function adapter (connection) {
  const filename = require.resolve('../lib/secrets/postgres');
  const originalRequire = createRequire(filename);
  const module = { exports: {} };
  const injected = name => name === '../storage/postgres-connection' ? async () => connection
    : name === '../storage/tenant-scope' ? { getTenancyMode: () => 'multi' } : originalRequire(name);
  new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8'))(injected, module, module.exports);
  return module.exports.createPostgresSecrets({ namespace: 'synthetic_secrets', connectionString: 'synthetic-source-double' });
}

function persistenceConnection () {
  let currentTenant, fail = false;
  const rows = [], committed = [];
  return {
    rows, committed,
    fail () { fail = true; },
    async withTenant (selected, operation) {
      assert.equal(currentTenant, undefined, 'private tenant transaction');
      currentTenant = selected;
      const count = rows.length;
      try { const result = await operation(); committed.push(...rows.slice(count)); return result; }
      catch (error) { rows.splice(count); throw error; }
      finally { currentTenant = undefined; }
    },
    async query (sql, values) {
      if (sql === "SET LOCAL synchronous_commit = 'on'") return { rows: [] };
      if (sql.includes('FROM pg_class')) return { rows: [true, false].map(is_records => ({
        secured: true, owns: false, inserts: true, mutates: false,
        reads: is_records, column_reads: is_records, update_columns: [], is_records
      })) };
      if (sql.startsWith('SELECT tenant_id AS tenant')) return { rows: [{ tenant: currentTenant,
        id: values[1], format: 1, ciphertext: 'synthetic-envelope' }] };
      if (sql.startsWith('INSERT INTO "synthetic_secrets".secret_audit')) {
        assert.equal(currentTenant, values[1]);
        if (fail) throw new Error('synthetic insert refusal');
        const [, tenant, principal, consumer, operation, secret_id, phase, event_time, target_version] = values;
        rows.push({ tenant, principal, consumer, operation, secret_id, phase, event_time, target_version });
        return { rows: [], rowCount: 1 };
      }
      throw new Error('Unexpected synthetic SQL');
    },
    async end () {}
  };
}

function issuance (persistence, beforeDecrypt) {
  return createSecrets({
    store: persistence.store, audit: persistence.audit,
    authorize: async (identity, action) => action.operation === 'issue-legacy',
    maxTokenLifetimeSeconds: 28800,
    legacyAuthorityFor: async selected => ({ reference: { tenant: selected, id: 'legacy-root' },
      subjects: [{ subjectId: 'subject', tokenPrefix: 'synthetic' }] }),
    providerFor: async selected => ({ async decrypt () {
      beforeDecrypt();
      return Buffer.from(JSON.stringify({ tenant: selected, id: 'legacy-root', data: Buffer.alloc(32, 17).toString('base64') }));
    } })
  });
}

describe('legacy issuance source persistence integration', function () {
  it('writes the bounded issue attempt through the actual adapter before crypto', async function () {
    const connection = persistenceConnection(), persistence = await adapter(connection);
    const component = issuance(persistence, () => {
      assert.equal(connection.committed.length, 1, 'audit transaction resolved before crypto');
      assert.deepEqual(connection.committed[0], { tenant, principal: 'owner', consumer: 'issuer',
        operation: 'issue-legacy', secret_id: 'legacy-root', phase: 'authorized',
        event_time: connection.committed[0].event_time, target_version: null });
    });
    const result = await component.issueLegacyCredential(actor, 'subject', async (target, issue) => issue());
    assert.equal(typeof result.token, 'string');
    assert.equal(JSON.stringify(connection.rows).includes(result.token), false);
    await persistence.close();
  });

  it('refuses missing reference, extra secret payload and audit failure before crypto', async function () {
    const connection = persistenceConnection(), persistence = await adapter(connection);
    const event = { ...actor, operation: 'issue-legacy', phase: 'authorized', time: 1 };
    await assert.rejects(persistence.audit(event), /Invalid secrets audit event/);
    await assert.rejects(persistence.audit({ ...event, id: 'legacy-root', token: 'unaccepted' }), /fields/);
    connection.fail();
    let decrypts = 0;
    const component = issuance(persistence, () => { decrypts++; });
    await assert.rejects(component.issueLegacyCredential(actor, 'subject', async (target, issue) => issue()),
      { code: 'SECRETS_STORE_UNAVAILABLE' });
    assert.equal(decrypts, 0);
    assert.deepEqual(connection.rows, []);
    await persistence.close();
  });

  it('admits a separate exact-reference issuance grant while decrypt stays unauthorized', async function () {
    const grant = { principal: actor.principal, consumer: actor.consumer, operation: 'issue-legacy', id: 'legacy-root' };
    const policy = createSubjectPolicy({
      store: { read: async () => ({ version: 1, grants: [grant] }), write: async () => {} },
      limitsFor: async () => ({ generation: 1, code: [grant], operator: [grant] }),
      authorizeManagement: async () => true
    });
    assert.equal(await policy.authorize(actor, { operation: 'issue-legacy', id: 'legacy-root' }), true);
    assert.equal(await policy.authorize(actor, { operation: 'decrypt', id: 'legacy-root' }), false);
    await assert.rejects(policy.authorize(actor, { operation: 'issue-legacy' }), /exact secrets grant/);
    assert.equal(await policy.authorize(actor, { operation: 'issue-legacy', id: 'other-root' }), false);
  });

  it('appends checksummed audit constraints without altering earlier migrations', function () {
    const checked = validateCatalogue(catalogue);
    assert.deepEqual(checked.slice(0, 2).map(item => item.checksum), [
      'fabba64185a4b931667047d794ae2557862f9bad521135197c9a5c4ebd20f99a',
      '2fac5b180d049094e4d06b242f5e5d7c067eaa1e841ce6ebe97e39b4c41b77a6'
    ]);
    const migration = checked.at(-1);
    assert.equal(migration.name, '0003_secrets_legacy_issuance');
    const operation = migration.up.find(sql => sql.includes('ADD CONSTRAINT secret_audit_operation_check'));
    const reference = migration.up.find(sql => sql.includes('ADD CONSTRAINT secret_audit_check'));
    assert.ok(operation.includes("'issue-legacy'"));
    assert.ok(reference.includes("'issue-legacy'"));
    assert.ok(reference.endsWith('= (secret_id IS NOT NULL))'));
    assert.equal(migration.up.some(sql => /target_version|ROW LEVEL|GRANT|REVOKE/.test(sql)), false);
  });
});
