'use strict';
// Metadata protocol controls; actual SQL/roles/restore are the native fit gate.
// covers: lib/pgstream/heartbeat-inventory.js, lib/storage/postgres-relation-inventory.js
const assert = require('node:assert/strict');
const contract = require('../lib/pgstream/heartbeat-inventory');
const { assertRelationInventory } = require('../lib/storage/postgres-relation-inventory');
const fail = (reason, name) => Object.assign(new Error(reason), { code: reason, detail: name });
const table = name => ({ name, kind: 'r', partition: false, inherited: false });
const namespace = 'owned_clock', tables = ['tenant_write_clock'];
const metadata = () => ({ global: true, bootstrap_owned: true, augmented: false,
  columns: ['id', 'revision'].map((name, i) => ({ name, type: i ? 'bigint' : 'integer', required: true, identity: '', generated: '', default: false })),
  constraints: ['CHECK ((id = 1))', 'CHECK ((revision >= 0))', 'PRIMARY KEY (id)'].map((definition, i) => ({ definition, validated: true, deferred: false, noinherit: i === 2 })) });
function fixture () {
  const value = { rows: ['schema_migrations', ...tables, contract.TABLE].map(table), metadata: metadata(), reads: [] };
  value.connection = { query: async (text, parameters) => { value.reads.push({ text, parameters }); return { rows: text.includes('reviewed-relation-inventory') ? value.rows : [value.metadata] }; } };
  value.check = (infrastructure = contract.forCatalogue('clock', namespace, tables)) => assertRelationInventory(value.connection, { namespace, tables, infrastructure, fail });
  return value;
}
describe('optional reviewed pgstream shared heartbeat inventory', function () {
  it('validates a clock-only declaration without adding any tenant table or row read', async function () {
    const f = fixture(); await f.check(); assert.deepEqual(tables, ['tenant_write_clock']); assert.equal(f.reads.length, 2);
    assert.equal(contract.forCatalogue('entries', namespace, tables), null); assert.equal(contract.forCatalogue('clock', namespace, ['other']), null);
    assert(!f.reads.some(row => /SELECT .*revision.* FROM "owned_clock"/.test(row.text)));
  });
  it('keeps absence optional for deployments without pgstream', async function () {
    const f = fixture(); f.rows.pop(); await f.check(); assert.equal(f.reads.length, 1);
  });
  it('refuses the same name without explicit clock infrastructure selection', async function () {
    await assert.rejects(fixture().check(null), { code: 'UNADMITTED', detail: contract.TABLE });
  });
  it('refuses namespace substitution and unknown sibling tables', async function () {
    const f = fixture(); await assert.rejects(f.check({ ...contract.forCatalogue('clock', namespace, tables), namespace: 'different' }), { code: 'INVALID' });
    const other = fixture(); other.rows.push(table('unexpected_tenant_rows')); await assert.rejects(other.check(), { code: 'UNADMITTED', detail: 'unexpected_tenant_rows' });
  });
  for (const [name, mutate] of [
    ['runtime ownership', m => { m.bootstrap_owned = false; }],
    ['tenant binding or extra column', m => { m.columns.push({ name: 'tenant_id', type: 'uuid' }); }],
    ['row security or persistence drift', m => { m.global = false; }],
    ['trigger or rewrite augmentation', m => { m.augmented = true; }],
    ['default value', m => { m.columns[1].default = true; }],
    ['missing or changed check', m => { m.constraints[0].definition = 'CHECK ((id > 0))'; }],
    ['unvalidated constraint', m => { m.constraints[0].validated = false; }],
    ['deferrable primary key', m => { m.constraints[2].deferred = true; }]
  ]) it('refuses ' + name, async function () { const f = fixture(); mutate(f.metadata); await assert.rejects(f.check(), { code: 'INFRASTRUCTURE_UNSUPPORTED' }); });
  it('retains unsupported relation-shape refusal', async function () {
    const f = fixture(); f.rows[2].kind = 'v'; await assert.rejects(f.check(), { code: 'UNSUPPORTED' });
  });
});
