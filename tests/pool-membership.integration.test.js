'use strict';

// Pool membership on actual PostgreSQL: two pool kinds (evaluator, vcpool) in
// one table, least-privilege member and inspector identities, the agreement
// rule, lease expiry and alerts. Synthetic tenants and roles only.
// covers: lib/pool-membership/postgres.js, lib/pool-membership/index.js, lib/pool-membership/postgres-candidate.json
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
      inspector: namespace + '_inspector', broad: namespace + '_broad' };
    const urls = {};
    const open = [];
    let admin;
    const alerts = [];
    const sink = label => event => alerts.push({ label, ...event });
    async function member (kind, members, ordinal, { leaseMs = 5000, role = kind, capability, label } = {}) {
      const created = await membership.member({ kind, partitioned: true, members, ordinal, leaseMs, connectionString: urls[role], namespace },
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
      // A deliberately over-privileged identity for the refusal control.
      for (const statement of membership.grants({ namespace, member: roles.broad })) await admin.query(statement);
      await admin.query(`GRANT UPDATE (ordinal) ON "${namespace}".pool_membership TO "${roles.broad}"`);
    });
    afterEach(async function () { await closeAll(); alerts.length = 0; await admin.query(`DELETE FROM "${namespace}".pool_membership`); });
    after(async function () {
      await closeAll();
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

    it('a member count disagreement within one kind stops every member of that kind and raises the alert', async function () {
      const a = await member('evaluator', 2, 0), b = await member('evaluator', 3, 1), other = await member('vcpool', 3, 1);
      for (const m of [a, b, other]) await m.register();
      for (const m of [a, b]) {
        const slice = await m.slice();
        assert.equal(slice.eligible, false);
        assert.equal(slice.reason, 'POOL_COUNT_DISAGREEMENT');
        assert.equal(slice.includes, undefined, 'a refusal carries no predicate');
      }
      assert.equal((await other.slice()).eligible, true, 'another kind is unaffected');
      assert.deepEqual(alerts.map(alert => [alert.label, alert.state, alert.reason]),
        [['evaluator0', 'refused', 'POOL_COUNT_DISAGREEMENT'], ['evaluator1', 'refused', 'POOL_COUNT_DISAGREEMENT']]);
      // The alert is raised on a change of reason, not on every cycle.
      await a.slice();
      assert.equal(alerts.length, 2);
      // Removing the disagreeing member recovers the rest of the kind, signalled once.
      await b.close();
      assert.equal((await a.slice()).eligible, true);
      assert.deepEqual(alerts.at(-1), { label: 'evaluator0', kind: 'evaluator', ordinal: 0, members: 2, state: 'recovered', previous: 'POOL_COUNT_DISAGREEMENT' });
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
      assert.deepEqual(seen.configured, { mode: 'partitioned', members: 2, ordinal: 0, rule: 'sha256-modulo-v1', leaseMs: 5000, memberId: inspector.configured.memberId });
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
        await assert.rejects(client.query(`INSERT INTO "${namespace}".pool_membership (pool_kind, ordinal, member_id, expected_members, slice_rule, registered_at, heartbeat_at, lease_expires_at)
          VALUES ('evaluator', 0, $1, 1, 'sha256-modulo-v1', now(), now(), now() + interval '1 minute')`, [randomUUID()]), { code: '42501' });
      } finally { await client.end(); }
      const writer = new Client({ connectionString: urls.evaluator });
      await writer.connect();
      try {
        await assert.rejects(writer.query(`UPDATE "${namespace}".pool_membership SET ordinal = 1`), { code: '42501' });
        await assert.rejects(writer.query(`TRUNCATE "${namespace}".pool_membership`), { code: '42501' });
      } finally { await writer.end(); }
      await assert.rejects(member('evaluator', 1, 0, { role: 'broad' }), { code: 'POOL_STORE_UNSAFE' });
      await assert.rejects(member('evaluator', 1, 0, { role: 'inspector' }), { code: 'POOL_STORE_UNSAFE' }, 'a read-only identity is not a member');
    });
  });
