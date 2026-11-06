'use strict';

// covers: lib/server/serve/roles.js, lib/server/serve/index.js

// D23 entry condition 4 (PLAT-SERVE): the role table states each role's inputs
// and outputs as typed fields, so a composed process can be checked against
// them, and realtime declares no write authority. Nothing here boots a server
// or needs a database. parseRoles is asserted unchanged with the error texts
// lib/server/serve/index.js carries.

const assert = require('node:assert/strict');

const serve = require('../lib/server/serve');
const { ROLES, FIELDS, STORAGE, describeComposition, RoleTableError } = require('../lib/server/serve/roles');

const NAMES = ['api', 'evaluator', 'realtime', 'vcpool', 'tenant-admin', 'admin'];
const TYPED = ['listener', 'storage', 'feed', 'egress'];

// A copy whose entries can be edited without touching the table.
function copyRoles () {
  const copy = {};
  for (const [name, role] of Object.entries(ROLES)) copy[name] = Object.assign({}, role);
  return copy;
}

// `expected` is the exact message, or a pattern for it.
function refused (fn, expected) {
  const matches = message => (typeof expected === 'string' ? message === expected : expected.test(message));
  assert.throws(fn, err => err instanceof RoleTableError && matches(err.message), String(expected));
}

describe('multitenant role table fields (D23 entry condition 4)', function () {

  it('lists the six roles in the order the command lists them', function () {
    assert.deepEqual(Object.keys(ROLES), NAMES);
    assert.deepEqual(Object.keys(FIELDS), TYPED);
    assert.deepEqual(STORAGE, ['write', 'read', 'none']);
  });

  it('gives every role every typed field with an allowed value', function () {
    for (const [name, role] of Object.entries(ROLES)) {
      for (const field of TYPED) assert.ok(Object.prototype.hasOwnProperty.call(role, field), name + ' lacks ' + field);
      for (const field of ['listener', 'feed', 'egress']) assert.equal(typeof role[field], 'boolean', name + '.' + field);
      assert.ok(STORAGE.includes(role.storage), name + '.storage is ' + JSON.stringify(role.storage));
      // The listener flag agrees with the plane and prefix a listener is bound by.
      assert.equal(role.listener, typeof role.plane === 'string' && typeof role.prefix === 'string', name + '.listener');
    }
  });

  it('realtime is a reader that consumes the feed and forwards socket writes to api', function () {
    assert.equal(ROLES.realtime.storage, 'read');
    assert.equal(ROLES.realtime.forwardsWritesTo, 'api');
    assert.equal(ROLES.realtime.feed, true);
    assert.equal(ROLES.realtime.listener, true);
    assert.equal(ROLES.realtime.egress, false);
    for (const name of NAMES.filter(n => n !== 'realtime')) {
      assert.equal(Object.prototype.hasOwnProperty.call(ROLES[name], 'forwardsWritesTo'), false, name + ' forwards nothing');
    }
  });

  it('api is the writer with the consumer-default listener, and nothing else is consumer-default', function () {
    assert.equal(ROLES.api.storage, 'write');
    assert.equal(ROLES.api.listener, true);
    assert.equal(ROLES.api.feed, false);
    assert.equal(ROLES.api.egress, false);
    assert.deepEqual(NAMES.filter(name => ROLES[name].consumerDefault), ['api']);
  });

  it('evaluator and vcpool have no listener; evaluator consumes the feed; both are egress', function () {
    assert.equal(ROLES.evaluator.listener, false);
    assert.equal(ROLES.evaluator.feed, true);
    assert.equal(ROLES.evaluator.egress, true);
    assert.equal(ROLES.evaluator.storage, 'read');
    assert.equal(ROLES.vcpool.listener, false);
    assert.equal(ROLES.vcpool.feed, false);
    assert.equal(ROLES.vcpool.egress, true);
    assert.equal(ROLES.vcpool.storage, 'write');
  });

  it('admin is on the internal plane and tenant-admin on the consumer plane, both writers', function () {
    assert.equal(ROLES.admin.plane, 'internal');
    assert.equal(ROLES.admin.listener, true);
    assert.equal(ROLES.admin.storage, 'write');
    assert.equal(ROLES['tenant-admin'].plane, 'consumer');
    assert.equal(ROLES['tenant-admin'].listener, true);
    assert.equal(ROLES['tenant-admin'].storage, 'write');
  });
});

describe('describeComposition', function () {

  it('lists one writer and one reader for api,realtime', function () {
    assert.deepEqual(describeComposition(['api', 'realtime']), {
      writers: ['api']
      , readers: ['realtime']
      , listeners: ['api', 'realtime']
      , feedConsumers: ['realtime']
      , egress: []
    });
  });

  it('reads the whole table from the fields', function () {
    assert.deepEqual(describeComposition(NAMES), {
      writers: ['api', 'vcpool', 'tenant-admin', 'admin']
      , readers: ['evaluator', 'realtime']
      , listeners: ['api', 'realtime', 'tenant-admin', 'admin']
      , feedConsumers: ['evaluator', 'realtime']
      , egress: ['evaluator', 'vcpool']
    });
    assert.deepEqual(describeComposition([]), { writers: [], readers: [], listeners: [], feedConsumers: [], egress: [] });
  });

  it('names the role that lacks a typed field', function () {
    for (const field of TYPED) {
      const roles = copyRoles();
      delete roles.evaluator[field];
      refused(() => describeComposition(['api', 'evaluator'], roles), 'role evaluator lacks the ' + field + ' field');
      // The roles before it are not what fails.
      assert.deepEqual(describeComposition(['api'], roles).writers, ['api']);
    }
  });

  it('names the role whose value is outside the allowed set', function () {
    const roles = copyRoles();
    roles.realtime.storage = 'maybe';
    refused(() => describeComposition(['realtime'], roles), /^role realtime has storage "maybe", not one of write, read, none$/);
    roles.realtime.storage = 'read';
    roles.realtime.feed = 'yes';
    refused(() => describeComposition(['realtime'], roles), /^role realtime has feed "yes", not a boolean$/);
  });

  it('refuses an unknown role, a listener flag that disagrees with plane and prefix, and a forward to a non-writer', function () {
    refused(() => describeComposition(['bogus']), /^unknown role: bogus$/);
    const roles = copyRoles();
    roles.evaluator.listener = true;
    refused(() => describeComposition(['evaluator'], roles), /^role evaluator declares a listener without a plane and prefix$/);
    roles.evaluator.listener = false;
    roles.realtime.listener = false;
    refused(() => describeComposition(['realtime'], roles), /^role realtime names a plane or prefix without a listener$/);
    roles.realtime.listener = true;
    roles.api.storage = 'read';
    refused(() => describeComposition(['api', 'realtime'], roles), /^role realtime forwards writes to api, which is not a writer$/);
  });
});

describe('parseRoles is unchanged by the typed fields', function () {

  it('accepts api and only api', function () {
    assert.deepEqual(serve.parseRoles(['api']), ['api']);
    assert.deepEqual(NAMES.filter(name => ROLES[name].multitenant === true), ['api']);
  });

  it('still says realtime is not yet available, with the text index.js carries', function () {
    assert.throws(() => serve.parseRoles(['realtime']), err => err instanceof serve.RoleError
      && err.message === 'not yet available: realtime. `nightscout multitenant` is for a multitenant role that is not implemented. Only api has an explicit preview runtime.');
  });

  it('still refuses an unknown role, listing the roles', function () {
    assert.throws(() => serve.parseRoles(['bogus']), err => err instanceof serve.RoleError
      && err.message === 'unknown role: bogus; the roles are api, evaluator, realtime, vcpool, tenant-admin, admin');
  });
});
