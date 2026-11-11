'use strict';

// Pool membership on actual PostgreSQL: two pool kinds (evaluator, vcpool) in
// one table, least-privilege member, inspector and operator identities, the
// operator-set member count, the agreement rule, lease expiry and alerts.
// Synthetic tenants and roles only.
// covers: lib/pool-membership/postgres.js, lib/pool-membership/index.js, lib/pool-membership/operator.js, lib/pool-membership/postgres-candidate.json
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { run } = require('../lib/migrations/postgres');
const membership = require('../lib/pool-membership');
const { optInSuite } = require('./support/opt-in');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

optInSuite(!!process.env.NS_TEST_POSTGRES_ADMIN_URI, 'disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'pool membership: shared primitive on actual PostgreSQL', function () {
    this.timeout(30000);
    const namespace = 'pool_' + randomUUID().replace(/-/g, '').slice(0, 12);
    const roles = { owner: namespace + '_schema_owner', evaluator: namespace + '_evaluator', vcpool: namespace + '_vcpool',
      inspector: namespace + '_inspector', operator: namespace + '_operator', broad: namespace + '_broad' };
    const urls = {};
    const open = [];
    let admin, operator;
    const alerts = [];
    const sink = label => event => alerts.push({ label, ...event });
    // The member count is the operator's: set it, then start a member.
    async function member (kind, members, ordinal, { leaseMs = 5000, role = kind, capability, label } = {}) {
      if (members !== null) await operator.setMembers(kind, members);
      const created = await membership.member({ kind, partitioned: true, ordinal, leaseMs, connectionString: urls[role], namespace },
        { onAlert: sink(label || kind + ordinal), ...(capability ? { capability } : {}) });
      open.push(created);
      return created;
    }
    async function closeAll () {
      while (open.length) await open.pop().close().catch(() => {});
    }

    before(async function () {
      admin = new Client({ connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI });
      await admin.connect();
      const base = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI);
      for (const [key, role] of Object.entries(roles)) {
        const password = randomBytes(24).toString('hex');
        await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
        const url = new URL(base); url.username = role; url.password = password; urls[key] = url.toString();
      }
      await admin.query(`CREATE SCHEMA "${namespace}" AUTHORIZATION "${roles.owner}"`);
      // The runner issues CREATE SCHEMA IF NOT EXISTS; held only while migrating.
      const database = (await admin.query('SELECT current_database() AS name')).rows[0].name;
      await admin.query(`GRANT CREATE ON DATABASE "${database}" TO "${roles.owner}"`);
      await run('up', { direct: true, connectionString: urls.owner, namespace, catalogue: membership.catalogue });
      await admin.query(`REVOKE CREATE ON DATABASE "${database}" FROM "${roles.owner}"`);
      // One identity per member kind, one read-only inspector: the repository's grant plan.
      for (const statement of membership.grants({ namespace, member: roles.evaluator, inspector: roles.inspector })) await admin.query(statement);
      for (const statement of membership.grants({ namespace, member: roles.vcpool })) await admin.query(statement);
      for (const statement of membership.grants({ namespace, operator: roles.operator })) await admin.query(statement);
      operator = await membership.operator({ connectionString: urls.operator, namespace, kinds: ['evaluator', 'vcpool'] });
      // A deliberately over-privileged identity for the refusal control.
      for (const statement of membership.grants({ namespace, member: roles.broad })) await admin.query(statement);
      await admin.query(`GRANT UPDATE (ordinal) ON "${namespace}".pool_membership TO "${roles.broad}"`);
    });
    afterEach(async function () {
      await closeAll(); alerts.length = 0;
      await admin.query(`DELETE FROM "${namespace}".pool_membership`); await admin.query(`DELETE FROM "${namespace}".pool_desired`);
    });
    after(async function () {
      await closeAll();
      if (operator) await operator.close();
      if (!admin) return;
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      for (const role of Object.values(roles)) {
        await admin.query(`DROP OWNED BY "${role}"`).catch(() => {});
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      }
      await admin.end();
    });

    it('two kinds with overlapping ordinals stay independent', async function () {
      const evaluators = [await member('evaluator', 2, 0), await member('evaluator', 2, 1)];
      const connectors = [await member('vcpool', 3, 0), await member('vcpool', 3, 1), await member('vcpool', 3, 2)];
      for (const m of [...evaluators, ...connectors]) await m.register();
      for (const m of [...evaluators, ...connectors]) {
        const slice = await m.slice();
        assert.equal(slice.eligible, true, m.kind + ' ' + m.configured.ordinal + ' ' + slice.reason);
      }
      const seen = await evaluators[0].inspect();
      assert.deepEqual(seen.observed.rows.map(row => row.ordinal), [0, 1], 'evaluator sees only evaluator rows');
      assert.deepEqual((await connectors[0].inspect()).observed.rows.map(row => row.ordinal), [0, 1, 2]);
      // A conflict in one kind stops that kind only.
      const duplicate = await member('vcpool', 3, 0, { label: 'vcpool0-duplicate' });
      await duplicate.register();
      for (const m of [...connectors, duplicate]) assert.equal((await m.slice()).reason, 'POOL_DUPLICATE_ORDINAL');
      for (const m of evaluators) assert.equal((await m.slice()).eligible, true);
      assert.ok(alerts.length >= 4 && alerts.every(alert => alert.kind === 'vcpool' && alert.state === 'refused' && alert.reason === 'POOL_DUPLICATE_ORDINAL'),
        JSON.stringify(alerts));
    });

    it('an unset count stops the kind and raises the alert; setting it recovers, signalled once', async function () {
      const a = await member('evaluator', null, 0), other = await member('vcpool', 1, 0);
      for (const m of [a, other]) await m.register();
      const refused = await a.slice();
      assert.equal(refused.eligible, false); assert.equal(refused.reason, 'POOL_COUNT_UNSET');
      assert.equal(refused.includes, undefined, 'a refusal carries no predicate');
      assert.equal((await other.slice()).eligible, true, 'another kind is unaffected');
      await a.slice();
      assert.deepEqual(alerts.map(alert => [alert.label, alert.state, alert.reason]), [['evaluator0', 'refused', 'POOL_COUNT_UNSET']], 'one alert per change of reason');
      await operator.setMembers('evaluator', 1);
      assert.equal((await a.slice()).eligible, true);
      assert.deepEqual(alerts.at(-1), { label: 'evaluator0', kind: 'evaluator', ordinal: 0, state: 'recovered', previous: 'POOL_COUNT_UNSET' });
    });

    it('scaling 2 -> 3: members keep their slices until ordinal 2 is live, then all switch; nobody restarts', async function () {
      const a = await member('evaluator', 2, 0), b = await member('evaluator', null, 1);
      for (const m of [a, b]) await m.register();
      const tenants = Array.from({ length: 300 }, () => randomUUID());
      const owned = async list => (await Promise.all(list.map(m => m.slice()))).map(slice => slice.eligible ? tenants.filter(slice.includes) : null);
      const before = await owned([a, b]);
      assert.equal(before[0].length + before[1].length, 300);
      const set = await operator.setMembers('evaluator', 3);
      assert.deepEqual([set.outcome, set.desired.members, set.desired.previousMembers, set.effectiveMembers, set.switching], ['applied', 3, 2, 2, true]);
      assert.deepEqual(await owned([a, b]), before, 'the previous slices hold while ordinal 2 is missing');
      const c = await member('evaluator', null, 2); await c.register();
      const after = await owned([a, b, c]);
      assert.equal(after.flat().length, 300); assert.equal(new Set(after.flat()).size, 300);
      assert.ok(after.every(list => list.length > 0));
      assert.deepEqual((await operator.setMembers('evaluator', 3)).outcome, 'unchanged');
      // After the switch a lost member does not revert the others to 2: its slice is unworked.
      await c.close();
      const lost = await owned([a, b]);
      assert.deepEqual(lost, after.slice(0, 2), 'members 0 and 1 keep their 3-member slices; ordinal 2\'s tenants are unworked');
      assert.deepEqual((await a.slice()).missingOrdinals, [2]);
      const c2 = await member('evaluator', null, 2); await c2.register(); await c2.slice();
      // Scaling down: the count takes effect at once; the member beyond it idles.
      await operator.setMembers('evaluator', 2);
      const down = await owned([a, b, c2]);
      assert.deepEqual(down[2], [], 'ordinal 2 is outside the count: empty slice');
      assert.equal(down[0].length + down[1].length, 300);
      assert.equal(alerts.length, 0, 'no refusal during a scale change');
    });

    it('the operator refuses an unknown kind and an impossible count, and cannot write membership rows', async function () {
      await assert.rejects(operator.setMembers('other', 2), { code: 'POOL_KIND_UNKNOWN' });
      await assert.rejects(operator.setMembers('evaluator', 0), { code: 'POOL_MEMBERS_INVALID' });
      await assert.rejects(operator.setMembers('evaluator', 1025), { code: 'POOL_MEMBERS_INVALID' });
      const client = new Client({ connectionString: urls.operator });
      await client.connect();
      try {
        await assert.rejects(client.query(`DELETE FROM "${namespace}".pool_membership`), { code: '42501' });
        await assert.rejects(client.query(`DELETE FROM "${namespace}".pool_desired`), { code: '42501' });
      } finally { await client.end(); }
    });

    it('a duplicate ordinal within one kind stops that kind\'s members and raises the alert', async function () {
      const a = await member('evaluator', 2, 0), b = await member('evaluator', 2, 1), c = await member('evaluator', 2, 1, { label: 'evaluator1-duplicate' });
      for (const m of [a, b, c]) await m.register();
      for (const m of [a, b, c]) {
        const slice = await m.slice();
        assert.equal(slice.reason, 'POOL_DUPLICATE_ORDINAL');
        assert.deepEqual(slice.conflicts.find(conflict => conflict.reason === 'POOL_DUPLICATE_ORDINAL').ordinals, [1]);
      }
      assert.deepEqual(alerts.map(alert => alert.reason), ['POOL_DUPLICATE_ORDINAL', 'POOL_DUPLICATE_ORDINAL', 'POOL_DUPLICATE_ORDINAL']);
    });

    it('an expired lease drops out; the stale member itself refuses', async function () {
      const a = await member('evaluator', 2, 0), b = await member('evaluator', 2, 1);
      const stale = await member('evaluator', 2, 1, { leaseMs: 300, label: 'stale' });
      for (const m of [a, b, stale]) await m.register();
      assert.equal((await a.slice()).reason, 'POOL_DUPLICATE_ORDINAL');
      await delay(700);
      await a.heartbeat(); await b.heartbeat();
      assert.equal((await a.slice()).eligible, true, 'the expired duplicate no longer conflicts');
      assert.equal((await b.slice()).eligible, true);
      assert.equal((await stale.slice()).reason, 'POOL_SELF_NOT_LIVE');
      const inspected = await a.inspect();
      assert.deepEqual(inspected.observed.rows.map(row => [row.ordinal, row.live]).sort((x, y) => x[0] - y[0] || Number(y[1]) - Number(x[1])),
        [[0, true], [1, true], [1, false]], 'the expired row stays visible to inspection');
      // A heartbeat renews the stale member, which is a duplicate again.
      await stale.heartbeat();
      assert.equal((await a.slice()).reason, 'POOL_DUPLICATE_ORDINAL');
    });

    it('a successor of an ordinal removes only its expired predecessor', async function () {
      const old = await member('vcpool', 2, 0, { leaseMs: 200 });
      await old.register();
      await delay(400);
      const successor = await member('vcpool', 2, 0);
      await successor.register();
      const rows = (await successor.inspect()).observed.rows;
      assert.deepEqual(rows.map(row => [row.ordinal, row.self, row.live]), [[0, true, true]]);
    });

    it('slices partition a synthetic tenant set exactly across live members', async function () {
      const members = [0, 1, 2].map(ordinal => member('vcpool', 3, ordinal));
      const all = await Promise.all(members);
      for (const m of all) await m.register();
      const tenants = Array.from({ length: 300 }, () => randomUUID());
      const slices = await Promise.all(all.map(m => m.slice()));
      const owned = slices.map(slice => tenants.filter(slice.includes));
      assert.equal(owned.reduce((n, list) => n + list.length, 0), tenants.length);
      assert.equal(new Set(owned.flat()).size, tenants.length);
    });

    it('inspection is read-only and keeps configured values separate from observed membership', async function () {
      const a = await member('evaluator', 2, 0);
      const inspector = await member('evaluator', 2, 0, { role: 'inspector', capability: 'inspector' });
      const before = (await inspector.inspect()).observed;
      assert.deepEqual(before.rows, []);
      assert.equal(before.eligible, false);
      await a.register();
      const seen = await inspector.inspect();
      assert.deepEqual(seen.configured, { mode: 'partitioned', ordinal: 0, rule: 'sha256-modulo-v1', leaseMs: 5000, memberId: inspector.configured.memberId });
      assert.equal(seen.observed.desired.members, 2, 'the count is observed from the table, not configured');
      assert.deepEqual(seen.observed.liveOrdinals, [0]);
      assert.deepEqual(seen.observed.missingOrdinals, [1]);
      assert.equal(seen.observed.reason, 'POOL_INSPECTOR');
      await assert.rejects(inspector.register(), { code: 'POOL_FORBIDDEN' });
      await assert.rejects(inspector.slice(), { code: 'POOL_FORBIDDEN' });
      assert.equal(alerts.length, 0, 'inspection never alerts');
    });

    it('least privilege: the database refuses inspector writes and boot refuses an over-privileged member', async function () {
      const client = new Client({ connectionString: urls.inspector });
      await client.connect();
      try {
        await assert.rejects(client.query(`INSERT INTO "${namespace}".pool_membership (pool_kind, ordinal, member_id, slice_rule, registered_at, heartbeat_at, lease_expires_at)
          VALUES ('evaluator', 0, $1, 'sha256-modulo-v1', now(), now(), now() + interval '1 minute')`, [randomUUID()]), { code: '42501' });
        await assert.rejects(client.query(`UPDATE "${namespace}".pool_desired SET members = 5`), { code: '42501' });
      } finally { await client.end(); }
      const writer = new Client({ connectionString: urls.evaluator });
      await writer.connect();
      try {
        await assert.rejects(writer.query(`UPDATE "${namespace}".pool_membership SET ordinal = 1`), { code: '42501' });
        await assert.rejects(writer.query(`TRUNCATE "${namespace}".pool_membership`), { code: '42501' });
        await assert.rejects(writer.query(`UPDATE "${namespace}".pool_desired SET members = 5`), { code: '42501' }, 'a member cannot set the count');
      } finally { await writer.end(); }
      await assert.rejects(member('evaluator', 1, 0, { role: 'broad' }), { code: 'POOL_STORE_UNSAFE' });
      await assert.rejects(member('evaluator', 1, 0, { role: 'inspector' }), { code: 'POOL_STORE_UNSAFE' }, 'a read-only identity is not a member');
      await assert.rejects(member('evaluator', 1, 0, { role: 'operator' }), { code: 'POOL_STORE_UNSAFE' }, 'the operator identity is not a member');
      await assert.rejects(membership.operator({ connectionString: urls.evaluator, namespace, kinds: ['evaluator'] }), { code: 'POOL_STORE_UNSAFE' }, 'a member identity is not the operator');
    });
  });
