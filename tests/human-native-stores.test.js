'use strict';

// No-runtime guard checks compile the real fixture with driver constructors
// that fail immediately. No DNS, listener, database or provider is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, 'fixtures/human-native-stores.js'), 'utf8');

function guardedFixture (env) {
  const attempted = [];
  class ForbiddenDriver {
    constructor () { attempted.push('driver constructor'); throw new Error('Native driver constructor forbidden during guard check'); }
  }
  const module = { exports: {} };
  const dependencies = {
    'node:crypto': require('node:crypto'),
    mongodb: { MongoClient: ForbiddenDriver },
    pg: { Pool: ForbiddenDriver },
    '../../lib/storage/tenant-scope': { getTenancyMode () { attempted.push('tenancy mode'); throw new Error('No mode change before guard'); } },
    '../../lib/migrations/catalogue': { validateCatalogue () { attempted.push('migration'); throw new Error('No migration before guard'); } },
    '../../lib/human-session/mongo': { createMongoStore () { attempted.push('mongo adapter'); throw new Error('No adapter before guard'); } },
    '../../lib/human-session/postgres': { createPostgresStore () { attempted.push('postgres adapter'); throw new Error('No adapter before guard'); } }
  };
  vm.runInNewContext(source, { module, process: { env }, require: name => {
    if (!Object.hasOwn(dependencies, name)) throw new Error('Unexpected fixture import');
    return dependencies[name];
  } }, { filename: 'human-native-stores.js' });
  assert.deepEqual(attempted, [], 'import itself must not construct drivers or touch a datastore');
  return { createNativeStore: module.exports.createNativeStore, attempted };
}

const identity = { issuer: 'https://provider.synthetic.invalid', providerSubject: 'synthetic-subject', providerSession: 'synthetic-session', acceptedKeys: [{ kid: 'synthetic-data', purpose: 'data', active: true }] };

describe('native human store fixture admission (no runtime)', function () {
  it('requires an explicit reservation before any Mongo driver construction', async function () {
    const f = guardedFixture({ HUMAN_SESSION_MONGO_URL: 'mongodb://synthetic.invalid/synthetic' });
    await assert.rejects(f.createNativeStore({ kind: 'mongo', ...identity }), /HUMAN_SESSION_NATIVE_RESERVED=1 required/);
    assert.deepEqual(f.attempted, []);
  });

  it('requires an explicit reservation before any PostgreSQL driver construction', async function () {
    const f = guardedFixture({ HUMAN_SESSION_PG_ADMIN_URL: 'postgresql://synthetic.invalid/synthetic', HUMAN_SESSION_PG_APP_URL: 'postgresql://synthetic.invalid/synthetic' });
    await assert.rejects(f.createNativeStore({ kind: 'postgres', ...identity }), /HUMAN_SESSION_NATIVE_RESERVED=1 required/);
    assert.deepEqual(f.attempted, []);
  });

  it('has no implicit Mongo datastore even with a reservation', async function () {
    const f = guardedFixture({ HUMAN_SESSION_NATIVE_RESERVED: '1' });
    await assert.rejects(f.createNativeStore({ kind: 'mongo', ...identity }), /HUMAN_SESSION_MONGO_URL/);
    assert.deepEqual(f.attempted, []);
  });

  it('requires both distinct PostgreSQL connection inputs before any connection', async function () {
    const f = guardedFixture({ HUMAN_SESSION_NATIVE_RESERVED: '1', HUMAN_SESSION_PG_ADMIN_URL: 'postgresql://synthetic.invalid/synthetic' });
    await assert.rejects(f.createNativeStore({ kind: 'postgres', ...identity }), /HUMAN_SESSION_PG_APP_URL/);
    assert.deepEqual(f.attempted, []);
  });

  it('refuses unsupported kind or malformed tenant without consulting runtime', async function () {
    const f = guardedFixture({ HUMAN_SESSION_NATIVE_RESERVED: '1' });
    await assert.rejects(f.createNativeStore({ kind: 'memory', ...identity }), /Explicit native fixture kind/);
    await assert.rejects(f.createNativeStore({ kind: 'postgres', tenant: 'not-a-uuid', ...identity }), /canonical UUID tenant/);
    assert.deepEqual(f.attempted, []);
  });
});
