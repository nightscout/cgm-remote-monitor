'use strict';

// covers: lib/server/tenant-app/data-access.js
const assert = require('node:assert/strict');
const shiro = require('shiro-trie');
const { discovery } = require('../lib/server/tenant-app/data-access').internals;

describe('discovery permissions decided on demand', function () {
  const names = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'settings'];
  const { discoverable, discovered } = discovery([...names, 'entries']);
  // Grants a tenant role can hold, and the anonymous default lists.
  const grants = ['*', '*:*:read', '*:*:write', '*:*:admin', 'api:*:read', 'api:*', 'api:entries:read', 'api:entries:create,update',
    'api:treatments:*', 'api:status:read', 'admin:api:permissions:read', 'admin:*', 'api:*:create,update,delete', 'notifications:*:ack',
    'api:devicestatus:read', '*:entries:read', 'careportal:*:*'];
  const asked = [...discoverable, 'api:*:read', 'api:*:create,update,delete', 'api:treatments:create,update,delete', 'notifications:*:ack',
    'admin:api:subjects:read', 'api:unknown:read', '*', 'api', 'api:entries', 'api:entries:read,create', '*:*:read,write', 'careportal:x:y'];

  // The trie the request was bound to before: every allowed discoverable permission.
  function eager (allows) {
    const trie = shiro.new();
    for (const permission of discoverable) if (allows(permission) === true) trie.add(permission);
    return trie;
  }

  it('lists five actions per distinct collection and the five route permissions', function () {
    assert.equal(discoverable.length, names.length * 5 + 5);
    assert.equal(new Set(discoverable).size, discoverable.length);
  });

  it('answers every check as the eagerly built trie does, for subject, anonymous and root snapshots', function () {
    let seed = 20261124;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    let compared = 0;
    for (let round = 0; round < 400; round++) {
      const tries = Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
        const trie = shiro.new();
        trie.add(grants.filter(() => random() < 0.2));
        return trie;
      });
      const kind = round % 3;
      const allows = kind === 0 ? permission => tries.some(trie => trie.check(permission))
        : kind === 1 ? permission => permission.endsWith(':read') && tries.some(trie => trie.check(permission))
        : () => true;
      const expected = eager(allows);
      // Fresh objects in both orders: a route permission first, and an outside permission first.
      for (const order of [asked, asked.slice().reverse()]) {
        const lazy = discovered(allows);
        for (const permission of order) {
          assert.equal(lazy.check(permission), expected.check(permission), JSON.stringify({ round, kind, permission }));
          compared++;
        }
      }
    }
    assert.ok(compared > 30000);
  });

  it('asks the snapshot only about the permission a route checks', function () {
    const calls = [];
    const lazy = discovered(permission => { calls.push(permission); return permission === 'api:status:read'; });
    assert.equal(lazy.check('api:status:read'), true);
    assert.equal(lazy.check('api:status:read'), true);
    assert.deepEqual(calls, ['api:status:read']);
    assert.equal(lazy.check('api:*:read'), false);
    assert.equal(calls.length, discoverable.length, 'a permission outside the list decides the others once');
    assert.equal(lazy.check('notifications:*:ack'), false);
    assert.equal(calls.length, discoverable.length);
  });
});
