'use strict';
// Recording-protocol checks; physical PostgreSQL admission has its native suite.
// covers: lib/storage/postgres-insertion-readiness.js
const assert = require('node:assert/strict');
const admission = require('../lib/storage/postgres-insertion-readiness');
const proposal = require('../lib/tenant-lifecycle/tenant-insertion-sql');
const A = '11111111-1111-4111-8111-111111111111';
const namespace = 'insertion_admission', domain = 'entries';
function fixture () {
  const policy = [{ command: '*', permissive: true, roles: ['0'],
    using: "(tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)",
    check: "(tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)" }];
  const structure = { clinical_secured: true, counter_secured: true, independent: true, same_owner: true,
    owns: false, plain_ordinal: true, counter_columns: [{ name: 'tenant_id', type: 'uuid', required: true, identity: '', generated: '' },
      { name: 'last_ordinal', type: 'bigint', required: true, identity: '', generated: '' }],
    body: proposal.effectiveFunctionBody({ namespace, domain }),
    definer: false, volatility: 'v', config: ['search_path=pg_catalog'], language: 'plpgsql', trigger_function: true,
    triggers: [{ name: 'tenant_insertion_allocate', enabled: 'O', type: 23, internal: false, function: true, args: 0, conditional: false }],
    counter_policies: policy, clinical_policies: structuredClone(policy), unique_order: true, counter_primary: true, no_sequence: true,
    counter_checks: [{ expression: '(last_ordinal >= 0)', validated: true }],
    ordinal_checks: [{ expression: '(insertion_ordinal > 0)', validated: true }] };
  const acl = { owns: false, elevated: false, creates: false, clinical_reads: true, clinical_writes: true, clinical_inputs: true,
    explicit_ordinal: false, clinical_extra: false, clinical_mutates: true, counter_reads: true, counter_writes: true,
    counter_extra: false, counter_deletes: false, counter_mutates: true, executes: true };
  const state = { binding: A, last_ordinal: '9007199254740993', maximum: '9007199254740992' };
  const calls = [];
  return { structure, acl, state, calls, connection: { async query (text, values) {
    calls.push({ text, values });
    return { rows: text.includes('tenant-insertion-structure') ? [structure] : text.includes('tenant-insertion-effective-acl') ? [acl] : [state] };
  } } };
}
const options = { namespace, domain };
describe('tenant insertion read-only physical admission protocol', function () {
  it('selects only a reviewed counter-bearing catalogue and validates identifiers', async function () {
    assert.equal(admission.isOrderedCatalogue(require('../migrations/candidates/postgres-activity-v1.json')), false);
    assert.equal(admission.isOrderedCatalogue(require('../migrations/candidates/postgres-entries-v1.json')), true);
    assert.throws(() => admission.isOrderedCatalogue({ migrations: [{ up: proposal.build(options).up }] }), /catalogue|migration/i);
    for (const name of ['public', 'information_schema', 'pg_catalog', 'x.y', 'bad"']) {
      await assert.rejects(admission.metadata(fixture().connection, { namespace: name, domain }), /Explicit reviewed/);
    }
    await assert.rejects(admission.metadata(fixture().connection, { ...options, mode: 'operator-name' }), /role mode/);
  });
  it('admits ordinary and exact-ordinal restore privilege boundaries without writing', async function () {
    const f = fixture(); await admission.metadata(f.connection, options); await admission.floor(f.connection, { ...options, tenant: A });
    f.acl.explicit_ordinal = true; f.acl.counter_deletes = true;
    await admission.metadata(f.connection, { ...options, mode: 'restore' });
    await assert.rejects(admission.metadata(f.connection, options), /privileges/);
    assert(f.calls.every(call => call.text.startsWith('SELECT ')));
    assert(f.calls.some(call => call.text.includes('has_column_privilege(r.oid,$1,\'insertion_ordinal\',\'INSERT\')')));
  });
  it('checks a named target role without changing the operator role or weakening actual-caller checks', async function () {
    const f = fixture(); f.structure.owns = true;
    await admission.roleMetadata(f.connection, { ...options, role: 'synthetic_app' });
    assert.equal(f.calls.at(-1).values[4], 'synthetic_app');
    await admission.metadata(f.connection, options);
    assert.equal(f.calls.at(-1).values[4], null);
    assert(f.calls.every(call => call.text.startsWith('SELECT ')));
    await assert.rejects(admission.roleMetadata(f.connection, { ...options, role: 'bad;role' }), /target role/);
  });
  it('requires read-only consumers to see floors but have no mutation or allocation authority', async function () {
    const f = fixture();
    Object.assign(f.acl, { clinical_mutates: false, counter_mutates: false, executes: false });
    await admission.metadata(f.connection, { ...options, mode: 'reader' });
    for (const key of ['clinical_mutates', 'counter_mutates', 'executes']) {
      f.acl[key] = true;
      await assert.rejects(admission.metadata(f.connection, { ...options, mode: 'reader' }), /privileges/);
      f.acl[key] = false;
    }
    await admission.metadata(f.connection, { ...options, mode: 'reader' });
  });
  it('refuses missing/disabled/rebound triggers and altered function bodies, restoring pristine each time', async function () {
    for (const mutate of [s => { s.triggers = null; }, s => { s.triggers[0].enabled = 'D'; },
      s => { s.triggers[0].function = false; }, s => { s.body = s.body.replace('counter.last_ordinal+1', 'counter.last_ordinal'); },
      s => { s.body = proposal.build({ namespace, domain }).up.find(statement => statement.startsWith('CREATE FUNCTION ')).split('$tenant_insertion$')[1]; },
      s => { s.definer = true; }, s => { s.config = ['search_path=public']; }, s => { s.no_sequence = false; },
      s => { s.same_owner = false; }, s => { s.counter_policies[0].roles = ['1']; }, s => { s.counter_policies[0].roles = [0]; },
      s => { s.counter_policies[0].using = 'true'; }, s => { s.counter_policies.push(s.counter_policies[0]); },
      s => { s.unique_order = false; }, s => { s.counter_primary = false; },
      s => { s.counter_checks = null; }, s => { s.ordinal_checks[0].validated = false; }]) {
      const f = fixture(); await admission.metadata(f.connection, options);
      const saved = structuredClone(f.structure); mutate(f.structure);
      await assert.rejects(admission.metadata(f.connection, options), /schema/);
      Object.assign(f.structure, saved); await admission.metadata(f.connection, options);
    }
  });
  it('refuses unsafe effective privilege classes and a current-user owner', async function () {
    for (const key of ['explicit_ordinal', 'elevated', 'creates', 'clinical_extra', 'counter_extra', 'counter_deletes']) {
      const f = fixture(); f.acl[key] = true;
      await assert.rejects(admission.metadata(f.connection, options), /privileges/);
    }
    const f = fixture(); f.structure.owns = true; f.acl.owns = true;
    await assert.rejects(admission.metadata(f.connection, options), /privileges/);
    await admission.schemaMetadata(f.connection, options); // explicit operator structural inspection
  });
  it('uses exact bigint comparisons, rejects stale/missing/foreign floors, and accepts empty initialization', async function () {
    const f = fixture(); const opts = { ...options, tenant: A };
    await admission.floor(f.connection, opts);
    for (const change of [{ last_ordinal: '9007199254740991' }, { last_ordinal: null },
      { binding: '22222222-2222-4222-8222-222222222222' }, { last_ordinal: '-1' }, { maximum: '9223372036854775808' }]) {
      const saved = { ...f.state }; Object.assign(f.state, change);
      await assert.rejects(admission.floor(f.connection, opts), /floor/);
      Object.assign(f.state, saved); await admission.floor(f.connection, opts);
    }
    Object.assign(f.state, { last_ordinal: null, maximum: null }); await admission.floor(f.connection, opts);
  });
});
