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
const row = (ordinal, memberId, extra = {}) => ({ ordinal, memberId, rule: RULE, live: true, ...extra });

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
    const on = (extra = {}) => ({ MULTITENANT_POOL_VCPOOL_PARTITION: 'on',
      MULTITENANT_POOL_VCPOOL_ORDINAL: '2', MULTITENANT_POOL_VCPOOL_DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1/disposable_test',
      MULTITENANT_POOL_VCPOOL_NAMESPACE: 'pool_ops', ...extra });
    it('flag off (unset or off) is one owner of every tenant', function () {
      assert.deepEqual(fromEnvironment('evaluator', {}), { kind: 'evaluator', partitioned: false });
      assert.deepEqual(fromEnvironment('evaluator', { MULTITENANT_POOL_EVALUATOR_PARTITION: 'off' }), { kind: 'evaluator', partitioned: false });
    });
    it('reads the ordinal, lease and identity per kind; another kind\'s variables are not read', function () {
      const selected = fromEnvironment('vcpool', on());
      assert.deepEqual({ ...selected, connectionString: undefined }, { kind: 'vcpool', partitioned: true, ordinal: 2,
        leaseMs: 30000, connectionString: undefined, namespace: 'pool_ops' });
      assert.deepEqual(fromEnvironment('evaluator', on()), { kind: 'evaluator', partitioned: false });
    });
    it('refuses a member count in the environment and names the operator command', function () {
      for (const env of [on({ MULTITENANT_POOL_VCPOOL_MEMBERS: '3' }), { MULTITENANT_POOL_VCPOOL_MEMBERS: '2' }]) {
        assert.throws(() => fromEnvironment('vcpool', env), error => error.code === 'POOL_CONFIG_INVALID' &&
          /MULTITENANT_POOL_VCPOOL_MEMBERS is not read/.test(error.message) && /setPoolMembers \(POST \/pool\/members\)/.test(error.message));
      }
    });
    it('refuses malformed or stray values rather than ignoring them', function () {
      for (const env of [on({ MULTITENANT_POOL_VCPOOL_PARTITION: 'yes' }), on({ MULTITENANT_POOL_VCPOOL_ORDINAL: '1024' }),
        on({ MULTITENANT_POOL_VCPOOL_ORDINAL: '02' }), on({ MULTITENANT_POOL_VCPOOL_ORDINAL: '-1' }), on({ MULTITENANT_POOL_VCPOOL_ORDINAL: undefined }),
        on({ MULTITENANT_POOL_VCPOOL_LEASE_MS: '50' }), on({ MULTITENANT_POOL_VCPOOL_NAMESPACE: 'public' }),
        on({ MULTITENANT_POOL_VCPOOL_DATABASE_URL: undefined }),
        { MULTITENANT_POOL_VCPOOL_PARTITION: 'off', MULTITENANT_POOL_VCPOOL_ORDINAL: '0' }]) {
        assert.throws(() => fromEnvironment('vcpool', env), { code: 'POOL_CONFIG_INVALID' }, JSON.stringify(env));
      }
      assert.throws(() => fromEnvironment('VCPOOL', {}), TypeError);
      assert.throws(() => fromEnvironment('vc_pool', {}), TypeError);
    });
  });

  describe('agreement rule (count from the desired row)', function () {
    const self = { memberId: 'm1', ordinal: 1, rule: RULE };
    const desired = (members, previousMembers = null) => ({ members, previousMembers, rule: RULE, revision: 1 });
    it('admits a member whose row is live when every ordinal of the count is live and distinct', function () {
      const verdict = membership.assess(self, [row(0, 'm0'), row(1, 'm1'), row(2, 'm2')], desired(3));
      assert.equal(verdict.eligible, true);
      assert.equal(verdict.members, 3);
      assert.deepEqual(verdict.missingOrdinals, []);
    });
    it('an unset count stops the member', function () {
      assert.equal(membership.assess(self, [row(1, 'm1')], null).reason, 'POOL_COUNT_UNSET');
    });
    it('a raised count keeps the previous count until every new ordinal is live, then switches', function () {
      const two = [row(0, 'm0'), row(1, 'm1')];
      const waiting = membership.assess(self, two, desired(3, 2));
      assert.deepEqual([waiting.eligible, waiting.members, waiting.switching, waiting.missingOrdinals], [true, 2, true, []]);
      const complete = membership.assess(self, [...two, row(2, 'm2')], desired(3, 2));
      assert.deepEqual([complete.eligible, complete.members, complete.switching], [true, 3, false]);
      const newcomer = membership.assess({ ...self, memberId: 'm2', ordinal: 2 }, [...two, row(2, 'm2')], desired(3, 2));
      assert.equal(newcomer.members, 3);
      const early = membership.assess({ ...self, memberId: 'm2', ordinal: 2 }, [row(0, 'm0'), row(2, 'm2')], desired(3, 2));
      assert.deepEqual([early.eligible, early.members, early.outside, early.missingOrdinals], [true, 3, false, [1]],
        'neither count complete: the desired count, with the missing ordinal reported (its tenants unworked)');
    });
    it('a completed switch never falls back: a member lost after it leaves its tenants unworked (takeover undecided)', function () {
      const after = [row(0, 'm0', { appliedMembers: 3 }), row(1, 'm1', { appliedMembers: 3 })];
      const verdict = membership.assess(self, after, desired(3, 2));
      assert.deepEqual([verdict.eligible, verdict.members, verdict.switching, verdict.missingOrdinals], [true, 3, false, [2]]);
      const before = membership.assess(self, [row(0, 'm0', { appliedMembers: 2 }), row(1, 'm1', { appliedMembers: 2 })], desired(3, 2));
      assert.deepEqual([before.members, before.switching], [2, true], 'nobody has switched yet: the previous count holds');
    });
    it('a lowered count switches at once; a member beyond it is eligible with an empty slice', function () {
      const three = [row(0, 'm0'), row(1, 'm1'), row(2, 'm2')];
      const beyond = membership.assess({ ...self, memberId: 'm2', ordinal: 2 }, three, desired(2, 3));
      assert.deepEqual([beyond.eligible, beyond.members, beyond.outside], [true, 2, true]);
    });
    it('a duplicate ordinal stops every member of the kind, including members of other ordinals', function () {
      const rows = [row(0, 'm0'), row(1, 'm1'), row(2, 'm2'), row(2, 'm2b')];
      for (const member of [self, { ...self, memberId: 'm0', ordinal: 0 }, { ...self, memberId: 'm2', ordinal: 2 }]) {
        const verdict = membership.assess(member, rows, desired(3));
        assert.equal(verdict.eligible, false);
        assert.equal(verdict.reason, 'POOL_DUPLICATE_ORDINAL');
        assert.deepEqual(verdict.conflicts[0].ordinals, [2]);
      }
    });
    it('an expired row drops out: it neither conflicts nor counts as membership', function () {
      const verdict = membership.assess(self, [row(1, 'm1'), row(1, 'old', { live: false })], desired(3));
      assert.equal(verdict.eligible, true);
      assert.deepEqual(verdict.liveOrdinals, [1]);
      assert.deepEqual(verdict.missingOrdinals, [0, 2]);
      const expiredSelf = membership.assess(self, [row(1, 'm1', { live: false })], desired(3));
      assert.equal(expiredSelf.reason, 'POOL_SELF_NOT_LIVE');
    });
    it('a slice rule disagreement (a row or the desired row) stops the member', function () {
      assert.equal(membership.assess(self, [row(1, 'm1'), row(0, 'm0', { rule: 'other-rule' })], desired(2)).reason, 'POOL_RULE_DISAGREEMENT');
      assert.equal(membership.assess(self, [row(1, 'm1'), row(0, 'm0')], { ...desired(2), rule: 'other-rule' }).reason, 'POOL_RULE_DISAGREEMENT');
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
      assert.deepEqual(await member.inspect(), { kind: 'evaluator', configured: { mode: 'standalone', ordinal: 0, rule: null }, observed: null });
      await member.close();
      assert.equal((await member.slice()).eligible, false);
    });
    it('the evaluator config admits the partitioned mode and refuses a member count in the environment', function () {
      const evaluatorConfig = require('../lib/server/serve/evaluator-config');
      assert.deepEqual(evaluatorConfig.partitionFor({}), { kind: 'evaluator', partitioned: false });
      const env = { MULTITENANT_POOL_EVALUATOR_PARTITION: 'on', MULTITENANT_POOL_EVALUATOR_ORDINAL: '0',
        MULTITENANT_POOL_EVALUATOR_DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1/disposable_test', MULTITENANT_POOL_EVALUATOR_NAMESPACE: 'pool_ops' };
      assert.equal(evaluatorConfig.partitionFor(env).partitioned, true);
      assert.throws(() => evaluatorConfig.partitionFor({ ...env, MULTITENANT_POOL_EVALUATOR_MEMBERS: '2' }), /setPoolMembers/);
      assert.throws(() => evaluatorConfig.partitionFor({ MULTITENANT_POOL_EVALUATOR_ORDINAL: '0' }), /partition is off/);
    });
    it('serves the inspection read when partitioned, and standalone only with serve.internal configured explicitly', function () {
      const { inspectionFor } = require('../lib/server/serve/evaluator-config');
      assert.equal(inspectionFor({ partitioned: true }, {}), true);
      assert.equal(inspectionFor({ partitioned: false }, {}), false);
      assert.equal(inspectionFor({ partitioned: false }, { XDG_RUNTIME_DIR: '/run/user/1000' }), false);
      assert.equal(inspectionFor({ partitioned: false }, { NS_SERVE_INTERNAL_SOCKET: '/run/ns-ipc/evaluator.sock' }), true);
      assert.equal(inspectionFor({ partitioned: false }, { NS_SERVE_INTERNAL_HOST: '127.0.0.1', NS_SERVE_INTERNAL_PORT: '7001' }), true);
    });
  });
});
