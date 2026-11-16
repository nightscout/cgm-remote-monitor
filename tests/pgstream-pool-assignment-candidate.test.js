'use strict';
// Generated SQL and independent expression/contract controls only. These checks
// do not establish PostgreSQL trigger/lock/deferred-COMMIT runtime semantics.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const legacy = require('../lib/pgstream/assignment-candidate');
const successor = require('../lib/pgstream/pool-assignment-candidate');
const { bucket, MAX_MEMBERS } = require('../lib/pool-membership/slice');
const { checksum, validateCatalogue } = require('../lib/migrations/catalogue');
const binding = { membershipNamespace: 'test_pool', lifecycleNamespace: 'test_lifetime', operatorRole: 'test_operator' };
const base = () => legacy.build(binding);
const build = (module = successor) => module.build({ ...binding, base: base() });
const ids = Array.from({ length: 128 }, (_, i) => '00000000-0000-4000-8000-' + (i + 1).toString(16).padStart(12, '0'));
function mutant (from, to) {
  const file = require.resolve('../lib/pgstream/pool-assignment-candidate');
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.split(from).length, 2, 'one exact authored mutation anchor');
  const result = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + text.replace(from, to) + '\n})', { filename: file })(createRequire(file), result, result.exports);
  return result.exports;
}
function evaluatePrefix (expression, bytes) {
  // Evaluate only the actual generated restricted numeric sum. No general SQL
  // evaluator or duplicate bucket implementation is substituted for the source.
  return expression.split('+').reduce((sum, term) => {
    const match = /^get_byte\(bytes,([0-7])\)::numeric\*([0-9]+)$/.exec(term);
    assert(match, 'unsigned byte/weight expression required');
    return sum + BigInt(bytes[Number(match[1])]) * BigInt(match[2]);
  }, 0n);
}
function parity (module) {
  const actual = build(module), expression = /mod\(\((get_byte\(bytes,0\)::numeric\*[^\n]+?)\),desired.members\)::integer/.exec(actual.assignmentBody)?.[1];
  assert(expression, 'actual generated provisioning expression');
  let high = 0, clear = 0;
  for (const id of ids) {
    const bytes = crypto.createHash('sha256').update(id).digest();
    if (bytes[0] >= 128) high++; else clear++;
    const prefix = evaluatePrefix(expression, bytes);
    for (const members of [1, 2, 3, 5, 257, MAX_MEMBERS]) assert.equal(Number(prefix % BigInt(members)), bucket(id, members));
  }
  assert(high > 0 && clear > 0);
}
describe('additive shared-pool assignment SQL v2 (source/expression proof)', () => {
  it('appends one validated migration, preserving the full v1 catalogue, functions, checksums and trigger definitions', () => {
    const old = base(), captured = structuredClone(old), next = build();
    assert.deepEqual(old, captured);
    assert.deepEqual(next.catalogue.migrations.slice(0, -1), old.catalogue.migrations);
    const m = next.catalogue.migrations.at(-1);
    assert.equal(m.name, '0006_evaluator_pool_assignment_v2');
    assert.equal(m.checksum, checksum(m.up));
    assert.equal(validateCatalogue(next.catalogue).length, old.catalogue.migrations.length + 1);
    assert(m.up.some(sql => sql.includes('work_owner_ordinal BETWEEN 0 AND ' + (MAX_MEMBERS - 1))));
    assert(m.up.filter(sql => sql.startsWith('CREATE OR REPLACE FUNCTION')).length === 2);
    assert(!m.up.some(sql => /DISABLE|DROP TRIGGER|DROP FUNCTION/.test(sql)));
    assert(m.up.includes('REVOKE EXECUTE ON FUNCTION pgstream_assignment_required() FROM PUBLIC'));
  });
  it('uses the exact shared unsigned prefix at N3/N5 and signed-boundary fixtures; byte-weight mutation is red, restoration green', () => {
    parity(successor);
    const broken = mutant('256n ** BigInt(7 - i)', '256n ** BigInt(6 - Math.min(i, 6))');
    assert.throws(() => parity(broken), { code: 'ERR_ASSERTION' });
    parity(successor);
  });
  it('retains the entire ordinary worker body except the explicit count bound, beneath the transition branch', () => {
    const old = base(), next = build();
    const restoredWorker = next.effectBody.replace(next.transitionBody, '').replace('DECLARE transition jsonb; ', 'DECLARE ').replaceAll('desired.members NOT BETWEEN 1 AND ' + MAX_MEMBERS, 'desired.members NOT IN (1,2)');
    assert.equal(restoredWorker, old.effectBody);
    assert(next.effectBody.includes("context->>'operation'='ack'"));
    assert(next.effectBody.includes('roster.selves<>1'));
    assert(next.effectBody.includes('applied_members=desired.members'));
    assert(next.effectBody.includes('NEW.output_restore_generation::text IS DISTINCT FROM lifetime.generation'));
    assert(next.effectBody.includes("context->>'transactionId' IS DISTINCT FROM pg_current_xact_id()::text"));
  });
  it('binds the same transition body before assignment and worker branches and keeps deferred transitions distinct from ordinary effects', () => {
    const next = build();
    for (const body of [next.assignmentBody, next.effectBody]) {
      assert(body.indexOf(next.transitionBody) < body.indexOf('IF OLD.work_owner_ordinal IS NULL'));
      assert(body.includes('NEW.work_assignment_revision<=OLD.work_assignment_revision'));
      assert(body.includes("transition->>'oldRevision' IS DISTINCT FROM OLD.work_assignment_revision::text"));
      assert(body.includes("transition->>'newRevision' IS DISTINCT FROM NEW.work_assignment_revision::text"));
      assert(body.includes("jsonb_typeof(transition->'generations'->(NEW.tenant_id::text)) IS DISTINCT FROM 'string'"));
    }
  });
  it('preserves every row field except assignment by JSON row subtraction; omission-control is red and restoration green', () => {
    const criterion = module => {
      const text = build(module).transitionBody;
      const lists = [...text.matchAll(/to_jsonb\((NEW|OLD)\)-ARRAY\[([^\]]+)\]/g)];
      assert.equal(lists.length, 2);
      for (const [, , fields] of lists) assert.deepEqual(fields.split(',').map(s => s.replaceAll("'", '')), ['work_owner_ordinal', 'work_assignment_revision']);
      const original = { work_owner_ordinal: 0, work_assignment_revision: '7', work_observed: ['9'], work_completed: ['8'], work_due_at: '33', output_digest: 'synthetic', delivery_ack_revision: '4', unknown_future_column: 'protected' };
      const fields = lists[0][2].split(',').map(s => s.replaceAll("'", ''));
      const projection = value => Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
      assert.deepEqual(projection({ ...original, work_owner_ordinal: 2, work_assignment_revision: '8' }), projection(original));
      for (const key of ['work_observed', 'work_completed', 'work_due_at', 'output_digest', 'delivery_ack_revision', 'unknown_future_column']) assert.notDeepEqual(projection({ ...original, [key]: null }), projection(original));
    };
    criterion(successor);
    const broken = mutant("['work_owner_ordinal','work_assignment_revision']) IS DISTINCT", "['work_owner_ordinal','work_assignment_revision','work_observed']) IS DISTINCT");
    assert.throws(() => criterion(broken), { code: 'ERR_ASSERTION' }); criterion(successor);
  });
  it('requires exact operator, backend/transaction, previous/new count, complete new cohort and held lifecycle generation in both trigger paths', () => {
    const text = build().transitionBody;
    for (const required of ["current_user<>'test_operator'", "transition->>'backendPid' IS DISTINCT FROM pg_backend_pid()::text", "transition->>'transactionId' IS DISTINCT FROM pg_current_xact_id()::text", "transition->>'oldMembers' IS DISTINCT FROM desired.previous_members::text", "transition->>'members' IS DISTINCT FROM desired.members::text", "mode='ExclusiveLock'", 'applied_members IN (desired.previous_members,desired.members)', 'roster.live_count<>desired.members', 'roster.ordinals<>desired.members', "lifetime.phase<>'active'", "lifetime.generation IS DISTINCT FROM transition->'generations'->>(NEW.tenant_id::text)", "mode='ShareLock'", 'lifetime.lock_key', 'NEW.output_restore_generation::text IS DISTINCT FROM lifetime.generation']) assert(text.includes(required), required);
    assert(text.includes('FROM "test_pool".pool_desired')); assert(text.includes('FROM "test_lifetime".tenant_lifecycle_windows'));
    assert(text.includes('OLD.work_owner_ordinal IS DISTINCT FROM mod('));
  });
  it('refuses malformed source bindings, forged base and selected-v1 bodies rather than silently dropping their roster contract', () => {
    for (const patch of [{ operatorRole: 'postgres;unsafe' }, { lifecycleNamespace: 'public' }, { membershipNamespace: 'test_lifetime' }, { base: { ...base(), effectBody: base().effectBody + ' ' } }, { base: { ...base(), intakeProfile: {} } }]) assert.throws(() => successor.build({ ...binding, base: base(), ...patch }), /EVALUATOR_POOL_ASSIGNMENT_/);
  });
});
