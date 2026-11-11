'use strict';

// Pool membership primitive: slice function, configuration and the agreement
// rule, without a database. Synthetic tenant ids only.
// covers: lib/pool-membership/slice.js, lib/pool-membership/config.js, lib/pool-membership/assess.js, lib/pool-membership/index.js, lib/server/serve/evaluator-config.js
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const membership = require('../lib/pool-membership');
const { RULE, bucket, predicate } = membership.slice;
const { fromEnvironment } = membership.config;

const tenants = Array.from({ length: 2000 }, () => randomUUID());
const row = (ordinal, memberId, extra = {}) => ({ ordinal, memberId, expectedMembers: 3, rule: RULE, live: true, ...extra });

describe('pool membership primitive', function () {
  describe('slice function', function () {
    it('is a stable partition: every tenant is selected by exactly one member for N=1..5', function () {
      for (let members = 1; members <= 5; members++) {
        const slices = Array.from({ length: members }, (_, ordinal) => predicate(members, ordinal));
        const sizes = new Array(members).fill(0);
        for (const tenant of tenants) {
          const owners = slices.map((includes, ordinal) => includes(tenant) ? ordinal : -1).filter(ordinal => ordinal >= 0);
          assert.equal(owners.length, 1, 'N=' + members + ' tenant ' + tenant + ' owners ' + JSON.stringify(owners));
          sizes[owners[0]]++;
          // Stable: a second evaluation, and a fresh predicate, agree.
          assert.equal(predicate(members, owners[0])(tenant), true);
          assert.equal(bucket(tenant, members), owners[0]);
        }
        // Not a vacuous partition: with 2000 tenants every member gets some.
        assert.ok(sizes.every(size => size > 0), 'N=' + members + ' sizes ' + sizes);
      }
    });
    it('pins the rule to sha256-modulo-v1 on a known synthetic id', function () {
      const id = '11111111-1111-4111-8111-111111111111';
      // sha256 prefix of the id as an unsigned 64-bit integer, independently computed.
      const prefix = require('node:crypto').createHash('sha256').update(id).digest('hex').slice(0, 16);
      for (let members = 1; members <= 5; members++) assert.equal(bucket(id, members), Number(BigInt('0x' + prefix) % BigInt(members)));
    });
    it('refuses non-canonical ids and impossible shapes', function () {
      assert.throws(() => bucket('11111111-1111-4111-8111-11111111111A', 2), /Canonical tenant/);
      assert.throws(() => bucket('not-a-tenant', 2), /Canonical tenant/);
      for (const [members, ordinal] of [[0, 0], [2, 2], [2, -1], [1.5, 0], [1025, 0]]) assert.throws(() => predicate(members, ordinal), /Pool slice/);
    });
  });

  describe('configuration', function () {
    const on = (extra = {}) => ({ MULTITENANT_POOL_VCPOOL_PARTITION: 'on', MULTITENANT_POOL_VCPOOL_MEMBERS: '3',
      MULTITENANT_POOL_VCPOOL_ORDINAL: '2', MULTITENANT_POOL_VCPOOL_DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1/disposable_test',
      MULTITENANT_POOL_VCPOOL_NAMESPACE: 'pool_ops', ...extra });
    it('flag off (unset or off) is one owner of every tenant', function () {
      assert.deepEqual(fromEnvironment('evaluator', {}), { kind: 'evaluator', partitioned: false });
      assert.deepEqual(fromEnvironment('evaluator', { MULTITENANT_POOL_EVALUATOR_PARTITION: 'off' }), { kind: 'evaluator', partitioned: false });
    });
    it('reads count, ordinal, lease and identity per kind; another kind\'s variables are not read', function () {
      const selected = fromEnvironment('vcpool', on());
      assert.deepEqual({ ...selected, connectionString: undefined }, { kind: 'vcpool', partitioned: true, members: 3, ordinal: 2,
        leaseMs: 30000, connectionString: undefined, namespace: 'pool_ops' });
      assert.deepEqual(fromEnvironment('evaluator', on()), { kind: 'evaluator', partitioned: false });
    });
    it('refuses malformed or stray values rather than ignoring them', function () {
      for (const env of [on({ MULTITENANT_POOL_VCPOOL_PARTITION: 'yes' }), on({ MULTITENANT_POOL_VCPOOL_ORDINAL: '3' }),
        on({ MULTITENANT_POOL_VCPOOL_MEMBERS: '0' }), on({ MULTITENANT_POOL_VCPOOL_MEMBERS: '02' }), on({ MULTITENANT_POOL_VCPOOL_ORDINAL: '-1' }),
        on({ MULTITENANT_POOL_VCPOOL_LEASE_MS: '50' }), on({ MULTITENANT_POOL_VCPOOL_NAMESPACE: 'public' }),
        on({ MULTITENANT_POOL_VCPOOL_DATABASE_URL: undefined }),
        { MULTITENANT_POOL_VCPOOL_MEMBERS: '2' }, { MULTITENANT_POOL_VCPOOL_PARTITION: 'off', MULTITENANT_POOL_VCPOOL_ORDINAL: '0' }]) {
        assert.throws(() => fromEnvironment('vcpool', env), { code: 'POOL_CONFIG_INVALID' }, JSON.stringify(Object.keys(env)));
      }
      assert.throws(() => fromEnvironment('VCPOOL', {}), TypeError);
      assert.throws(() => fromEnvironment('vc_pool', {}), TypeError);
    });
  });

  describe('agreement rule', function () {
    const self = { memberId: 'm1', ordinal: 1, members: 3, rule: RULE };
    it('admits a member whose row is live when every live row agrees and ordinals are distinct', function () {
      const verdict = membership.assess(self, [row(0, 'm0'), row(1, 'm1'), row(2, 'm2')]);
      assert.equal(verdict.eligible, true);
      assert.deepEqual(verdict.missingOrdinals, []);
    });
    it('a count disagreement stops the member', function () {
      const verdict = membership.assess(self, [row(0, 'm0', { expectedMembers: 2 }), row(1, 'm1')]);
      assert.equal(verdict.eligible, false);
      assert.equal(verdict.reason, 'POOL_COUNT_DISAGREEMENT');
      assert.deepEqual(verdict.conflicts[0].counts, [2, 3]);
    });
    it('a duplicate ordinal stops every member of the kind, including members of other ordinals', function () {
      const rows = [row(0, 'm0'), row(1, 'm1'), row(2, 'm2'), row(2, 'm2b')];
      for (const member of [self, { ...self, memberId: 'm0', ordinal: 0 }, { ...self, memberId: 'm2', ordinal: 2 }]) {
        const verdict = membership.assess(member, rows);
        assert.equal(verdict.eligible, false);
        assert.equal(verdict.reason, 'POOL_DUPLICATE_ORDINAL');
        assert.deepEqual(verdict.conflicts[0].ordinals, [2]);
      }
    });
    it('an expired row drops out: it neither conflicts nor counts as membership', function () {
      const verdict = membership.assess(self, [row(1, 'm1'), row(1, 'old', { live: false, expectedMembers: 9 })]);
      assert.equal(verdict.eligible, true);
      assert.deepEqual(verdict.liveOrdinals, [1]);
      assert.deepEqual(verdict.missingOrdinals, [0, 2]);
      const expiredSelf = membership.assess(self, [row(1, 'm1', { live: false })]);
      assert.equal(expiredSelf.reason, 'POOL_SELF_NOT_LIVE');
    });
    it('a slice rule disagreement stops the member', function () {
      assert.equal(membership.assess(self, [row(1, 'm1'), row(0, 'm0', { rule: 'other-rule' })]).reason, 'POOL_RULE_DISAGREEMENT');
    });
  });

  describe('standalone (flag off)', function () {
    it('selects every tenant and inspects without a lease', async function () {
      const member = await membership.member(fromEnvironment('evaluator', {}));
      await member.register();
      assert.deepEqual(await member.heartbeat(), { renewed: true });
      const slice = await member.slice();
      assert.equal(slice.eligible, true);
      assert.deepEqual(tenants.filter(slice.includes), tenants);
      assert.deepEqual(await member.inspect(), { kind: 'evaluator', configured: { mode: 'standalone', members: 1, ordinal: 0, rule: null }, observed: null });
      await member.close();
      assert.equal((await member.slice()).eligible, false);
    });
    it('the evaluator config loads flag off and refuses the partitioned mode in this build', function () {
      const evaluatorConfig = require('../lib/server/serve/evaluator-config');
      assert.deepEqual(evaluatorConfig.partitionFor({}), { kind: 'evaluator', partitioned: false });
      assert.throws(() => evaluatorConfig.partitionFor({ MULTITENANT_POOL_EVALUATOR_PARTITION: 'on', MULTITENANT_POOL_EVALUATOR_MEMBERS: '2',
        MULTITENANT_POOL_EVALUATOR_ORDINAL: '0', MULTITENANT_POOL_EVALUATOR_DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1/disposable_test',
        MULTITENANT_POOL_EVALUATOR_NAMESPACE: 'pool_ops' }), /not enabled in this build/);
      assert.throws(() => evaluatorConfig.partitionFor({ MULTITENANT_POOL_EVALUATOR_MEMBERS: '2' }), /partition is off/);
    });
  });
});
