'use strict';
const assert = require('node:assert/strict');
const shiro = require('shiro-trie');
const { permissionsValid, permissionsContained, createOwnerPolicy, catalogueDigest } = require('../lib/subject-admin/owner-policy');

describe('owner Shiro implication', function () {
  const cases = [
    [['*'], ['*'], true],
    [['*:*:read'], ['*'], true],
    [['api:treatments:*'], ['api:treatments'], true],
    [['api:treatments'], ['api:treatments:*'], true],
    [['api:treatments:*'], ['api:treatments:read'], false],
    [['api:future_resource:read'], ['api:*:read'], true],
    [['api:future_resource:read:extension'], ['api:future_resource:read'], true],
    [['api:future_resource:read'], ['api:future_resource:read:extension'], false],
    [['api:entries:read,delete'], ['api:entries:read', 'api:entries:delete'], true],
    [['api:entries:read,delete'], ['api:entries:read'], false],
    [['api:entries,treatments:read'], ['api:entries:read', 'api:treatments:read'], true],
    [['api:*:read'], ['api:entries:read', 'api:treatments:read'], false],
    [['api:entries:read'], ['api:entries:create', 'api:entries:read'], true],
    [['api:entries:read'], [], false],
    [[], [], true],
    [['unselected.extension::READ'], ['*'], true]
  ];
  for (const [proposed, ceiling, expected] of cases) {
    it(JSON.stringify(proposed) + ' within ' + JSON.stringify(ceiling) + ' = ' + expected, function () {
      assert.equal(permissionsContained(proposed, ceiling), expected);
    });
  }

  it('matches installed checker across an independently enumerated concrete request corpus', function () {
    const grants = [[], ['*'], ['a'], ['a:b'], ['*:b'], ['a:*:c'], ['a,b:c'], ['a:b,c'], ['a:b', '*:c']];
    const requests = [];
    const alphabet = ['a', 'b', 'c', 'unknown', '*', ''];
    function extend (parts, depth) {
      if (parts.length) requests.push(parts.join(':'));
      if (!depth) return;
      for (const part of alphabet) extend([...parts, part], depth - 1);
    }
    extend([], 5);
    for (const left of grants) for (const right of grants) {
      const a = shiro.new().add(left), b = shiro.new().add(right);
      const witness = requests.find(request => a.check(request) && !b.check(request));
      assert.equal(permissionsContained(left, right), witness === undefined,
        JSON.stringify({ left, right, witness }));
    }
  });

  it('validates shipped extension, prefix, comma and wildcard strings without a terminal catalogue', function () {
    for (const value of ['api', 'api:entries', 'api::read', '*', '*:*:read', 'api:entries:read,delete', 'future:extension']) {
      assert.equal(permissionsValid([value]), true, value);
      assert.doesNotThrow(() => catalogueDigest([value]));
    }
    for (const values of [null, [''], [null], ['api\nread'], ['api', 'api']]) assert.equal(permissionsValid(values), false);
  });

  it('reads current locked ceiling and actor independently for every proposal', async function () {
    const state = { ceiling: ['*'], delegable: ['*'], active: true, roles: ['*:*:read'] };
    const seen = [];
    const digest = catalogueDigest(['*']);
    const connection = { async query (sql) {
      seen.push(sql);
      assert.match(sql, /FOR SHARE/);
      if (sql.includes('SELECT anonymous_roles')) return { rows: [{ anonymous_roles: ['readable'] }] };
      if (sql.includes('SELECT catalogue_digest')) return { rows: [{ catalogue_digest: digest, ceiling: state.ceiling }] };
      if (sql.includes('SELECT active,can_update,delegable')) return { rows: [{ active: state.active, can_update: true, delegable: state.delegable }] };
      if (sql.includes('SELECT name,permissions')) return { rows: [{ name: 'reader', permissions: state.roles }] };
      throw new Error('unexpected query');
    } };
    const policy = createOwnerPolicy({ namespace: 'owner_implication', catalogue: ['*'] });
    const actor = { tenant: '11111111-1111-4111-8111-111111111111', principal: 'owner', consumer: 'management' };
    const run = () => policy.authorizeUpdate(connection, actor, 'subject', { roles: ['reader'] });
    await run();
    state.ceiling = ['api:entries:read'];
    await assert.rejects(run(), { code: 'SUBJECT_ADMIN_FORBIDDEN' });
    state.ceiling = ['*']; state.delegable = [];
    await assert.rejects(run(), { code: 'SUBJECT_ADMIN_FORBIDDEN' });
    state.delegable = ['*']; state.active = false;
    await assert.rejects(run(), { code: 'SUBJECT_ADMIN_FORBIDDEN' });
    state.active = true; await run();
    await policy.authorizePermissions(connection, actor, ['api:future:read,delete']);
    assert.match(seen[0], /SELECT anonymous_roles/);
    assert.match(seen[1], /SELECT catalogue_digest/);
    assert.match(seen[2], /SELECT active,can_update,delegable/);
  });
});
