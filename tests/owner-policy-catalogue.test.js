'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const shiro = require('shiro-trie');
const { createOwnerPolicy, catalogueDigest, TERMINAL_OPERATIONS } = require('../lib/subject-admin/owner-policy');

describe('owner policy reviewed operation catalogue', function () {
  const namespace = 'owner_catalogue_test';

  it('preserves regular root, subject and default grants while writer policy still fences proposals', async function () {
    const result = await require('../scripts/probe-tenant-authorization-compatibility').run({ quiet: true });
    assert.deepEqual(result.after, { legacy: true, legacySnapshot: true, local: true });
    assert.deepEqual(result.removed, { legacy: false, legacySnapshot: false, local: false });
    assert.equal(result.proposedGrantRefused, true);
  });

  for (const permission of [
    'api:entries:read', 'api:treatments:create', 'api:profile:update',
    'api:devicestatus:delete', 'api:settings:admin', 'api:status:read',
    'admin:api:permissions:read'
  ]) {
    it('accepts the explicitly bounded terminal shape ' + permission, function () {
      const policy = createOwnerPolicy({ namespace, catalogue: [permission] });
      assert.equal(typeof policy.authorizeUpdate, 'function');
      assert.equal(catalogueDigest([permission]),
        createHash('sha256').update(JSON.stringify([permission])).digest('hex'));
    });
  }

  for (const permission of [
    'api', 'api:entries', 'api:entries:read:descendant', 'api:future_resource-2:read',
    'api:entries:invented', 'api:entries:READ', 'api:entries:read,delete',
    'api:*:read', 'api:entries:*', 'api:entries:read:*',
    'api::read', 'api:entries.subresource:read', 'api:entries:child:read',
    'admin:api', 'admin:api:permissions', 'admin:api:permissions:create',
    'admin:api:permissions:read:descendant', 'other:entries:read'
  ]) {
    it('rejects a prefix, wildcard, descendant, or unselected namespace ' + permission, function () {
      assert.throws(() => createOwnerPolicy({ namespace, catalogue: [permission] }), TypeError);
      assert.throws(() => catalogueDigest([permission]), TypeError);
    });
  }

  it('rejects empty, duplicate, and non-string catalogues', function () {
    for (const catalogue of [[], ['api:entries:read', 'api:entries:read'], [null], 'api:entries:read']) {
      assert.throws(() => createOwnerPolicy({ namespace, catalogue }), TypeError);
    }
  });

  it('digests an independent sorted copy and leaves the caller catalogue unchanged', function () {
    const catalogue = ['api:treatments:delete', 'api:entries:read', 'admin:api:permissions:read'];
    const original = catalogue.slice();
    const expected = createHash('sha256').update(JSON.stringify([
      'admin:api:permissions:read', 'api:entries:read', 'api:treatments:delete'
    ])).digest('hex');
    assert.equal(catalogueDigest(catalogue), expected);
    assert.deepEqual(catalogue, original);
    assert.doesNotThrow(() => createOwnerPolicy({ namespace, catalogue }));
  });

  it('reproduces Shiro parent implication including a terminal-looking parent of a future operation', function () {
    const broad = shiro.new();
    broad.add(['api:entries']);
    for (const operation of ['read', 'create', 'update', 'delete', 'admin']) {
      assert.equal(broad.check('api:entries:' + operation), true);
    }
    const terminal = shiro.new();
    terminal.add(['api:entries:read']);
    assert.equal(terminal.check('api:entries:read:descendant'), true);
  });

  it('bounds each accepted literal to itself within the independently reviewed REST operation universe', function () {
    const universe = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'settings']
      .flatMap(collection => ['read', 'create', 'update', 'delete', 'admin']
        .map(operation => 'api:' + collection + ':' + operation));
    universe.push('api:status:read', 'admin:api:permissions:read');
    assert.equal(Object.isFrozen(TERMINAL_OPERATIONS), true);
    assert.deepEqual(TERMINAL_OPERATIONS.slice().sort(), universe.slice().sort());
    assert.doesNotThrow(() => createOwnerPolicy({ namespace, catalogue: universe }));
    for (const granted of universe) {
      const permissions = shiro.new();
      permissions.add([granted]);
      for (const demanded of universe) {
        assert.equal(permissions.check(demanded), demanded === granted, granted + ' => ' + demanded);
        if (demanded !== granted) assert.equal(demanded.startsWith(granted + ':'), false);
      }
    }
  });

});
