'use strict';

const assert = require('node:assert/strict');
const { createOwnershipOperations, plan, checkAuthority } = require('../lib/tenant-ownership/component');
const service = require('../lib/tenant-ownership/service');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const OPERATOR = { principal: 'synthetic_operator', consumer: 'operator_plane' };
const ref = principal => ({ principal, consumer: 'tenant-admin' });

function recordingStore () {
  const calls = [];
  return { calls, async list (actor, authorize) { calls.push(['list', actor]); await authorize(null); return { owners: [] }; },
    async change (actor, operation, proposal, authorize) { calls.push([operation, actor, proposal]); await authorize(null); return { outcome: 'applied', code: null, event: null, owners: [] }; } };
}

function state (owners, extra = []) {
  const actors = owners.map(principal => ({ ...ref(principal), active: true, can_update: true, delegable: ['api:*:read'] }))
    .concat(extra.map(principal => ({ ...ref(principal), active: false, can_update: true, delegable: [] })));
  return { owners: owners.map(ref), actors, subjects: new Set(['a', 'b', 'c', 'd']), contained: permissions => !permissions.includes('*') };
}

describe('tenant ownership operations (source)', function () {
  it('accepts only identifiers and permission strings; credential-bearing or extra fields refuse before any store call', async function () {
    const store = recordingStore();
    const ops = createOwnershipOperations({ store, authorizeOperator: async request => ({ allowed: true, current: true, plane: 'operator', ...request, connection: undefined, operation: undefined }) });
    const bad = [
      { tenant: A, owner: ref('a'), delegable: [], expectedOwners: [], credential: 'x' },
      { tenant: A, owner: { ...ref('a'), token: 'x' }, delegable: [], expectedOwners: [] },
      { tenant: 'not-a-tenant', owner: ref('a'), delegable: [], expectedOwners: [] },
      { tenant: A, owner: ref('a'), delegable: [], expectedOwners: [ref('b'), ref('b')] },
      { tenant: A, owner: ref('a'), delegable: 'api:*:read', expectedOwners: [] }
    ];
    for (const input of bad) await assert.rejects(ops.add(OPERATOR, input), { code: 'OWNERSHIP_INVALID' });
    await assert.rejects(ops.transfer(OPERATOR, { tenant: A, from: ref('a'), to: ref('a'), expectedOwners: [ref('a')] }), { code: 'OWNERSHIP_INVALID' });
    await assert.rejects(ops.add({ ...OPERATOR, tenant: A }, bad[0]), TypeError);
    assert.deepEqual(store.calls, []);
  });

  it('requires current operator authority naming exactly the requested tenant, plane and actor', function () {
    const actor = { tenant: A, ...OPERATOR };
    const good = { allowed: true, current: true, tenant: A, plane: 'operator', ...OPERATOR };
    checkAuthority(good, actor);
    for (const patch of [{ allowed: false }, { current: false }, { tenant: B }, { plane: 'owner' }, { principal: 'other' }, { consumer: 'other' }, { extra: true }]) {
      assert.throws(() => checkAuthority({ ...good, ...patch }, actor), { code: 'OWNERSHIP_FORBIDDEN' });
    }
    assert.throws(() => checkAuthority(true, actor), { code: 'OWNERSHIP_FORBIDDEN' });
  });

  it('every applied plan leaves at least one owner and changes only what the operator named', function () {
    const universe = ['a', 'b', 'c', 'd'];
    for (const current of [['a'], ['a', 'b'], []]) {
      const s = state(current, ['d']);
      for (const target of universe) {
        for (const [operation, proposal] of [
          ['add', { owner: ref(target), delegable: [], expectedOwners: current.map(ref) }],
          ['recover', { owner: ref(target), delegable: [], expectedOwners: current.map(ref) }],
          ...current.map(from => ['transfer', { from: ref(from), to: ref(target), expectedOwners: current.map(ref) }])
        ]) {
          const decision = plan(operation, proposal, s);
          if (decision.code) continue;
          const active = new Set(current);
          decision.deactivate.forEach(row => active.delete(row.principal));
          if (decision.activate) active.add(decision.activate.principal);
          assert(active.size >= 1, operation + ' orphaned ' + JSON.stringify(current));
          assert(active.has(target), operation + ' must leave its named target an owner');
        }
      }
    }
    assert.equal(plan('add', { owner: ref('c'), delegable: [], expectedOwners: [ref('b')] }, state(['a'])).code, 'OWNERSHIP_CONFLICT');
    assert.equal(plan('add', { owner: ref('c'), delegable: ['*'], expectedOwners: [ref('a')] }, state(['a'])).code, 'OWNERSHIP_DELEGATION_EXCEEDS_CEILING');
    assert.equal(plan('transfer', { from: ref('b'), to: ref('c'), expectedOwners: [ref('a')] }, state(['a'])).code, 'OWNERSHIP_NOT_OWNER');
    assert.equal(plan('recover', { owner: ref('a'), delegable: [], expectedOwners: [ref('a')] }, state(['a'])).code, 'OWNERSHIP_UNCHANGED');
  });

  it('service handlers require the owned transport token, map denials without owners and use the fixed operator identity', async function () {
    const token = Symbol('owned');
    const seen = [];
    const ownership = { async add (context) { seen.push(context); throw Object.assign(new Error('OWNERSHIP_FORBIDDEN'), { code: 'OWNERSHIP_FORBIDDEN' }); },
      async list () { return { owners: [ref('a')] }; }, async transfer () { throw new Error('unexpected'); }, async recover () { return {}; } };
    const handlers = service.operations({ token, ownership, operator: OPERATOR });
    assert.deepEqual(Object.keys(handlers), ['listOwners', 'addOwner', 'transferOwner', 'recoverOwner']);
    await assert.rejects(handlers.addOwner({ transport: Symbol('other') }, {}), { code: 'OWNERSHIP_PRIVATE_REQUEST_REFUSED' });
    assert.deepEqual(await handlers.addOwner({ transport: token }, { tenant: A }), { outcome: 'denied', code: 'OWNERSHIP_FORBIDDEN', event: null });
    assert.deepEqual(seen, [OPERATOR]);
    assert.deepEqual(await handlers.listOwners({ transport: token }, { tenant: A }), { outcome: 'listed', owners: [ref('a')] });
    await assert.rejects(handlers.transferOwner({ transport: token }, {}), /unexpected/);
  });

  it('tenant-set authority allows only its listed tenants and its own operator identity', async function () {
    const authority = service.tenantSetAuthority({ ...OPERATOR, tenants: [B] });
    assert.equal((await authority({ tenant: B, ...OPERATOR })).allowed, true);
    assert.equal((await authority({ tenant: A, ...OPERATOR })).allowed, false);
    assert.equal((await authority({ tenant: B, principal: 'other', consumer: OPERATOR.consumer })).allowed, false);
    assert.throws(() => service.tenantSetAuthority({ ...OPERATOR, tenants: [] }), TypeError);
    assert.throws(() => service.tenantSetAuthority({ ...OPERATOR, tenants: [B, B] }), TypeError);
  });
});
