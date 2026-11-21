'use strict';

// Source-only characterization using real policy/readers and synthetic SQL
// responses. No connection, schema, credential, or runtime default is changed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createOwnerPolicy, catalogueDigest } = require('../lib/subject-admin/owner-policy');

const tenant = '11111111-1111-4111-8111-111111111111';
const permission = 'api:entries:read';
const actor = { tenant, principal: 'synthetic_owner', consumer: 'management' };
const state = { ceiling: [permission], permissions: [permission], unavailable: false,
  anonymous: ['denied'] };
const queries = [];

function reader (filename) {
  const file = path.join(__dirname, '../lib/tenant-authorization', filename);
  const actualRequire = createRequire(file);
  const connection = {
    withTenant: async (bound, callback) => {
      assert.ok(bound === tenant || bound === '00000000-0000-0000-0000-000000000000');
      return callback();
    },
    async query (sql, params) {
      if (sql.includes('FROM pg_class')) {
        const count = filename === 'access-postgres.js' ? params[0].length : params.length;
        return { rows: Array.from({ length: count }, () => ({
          secured: true, owns: false, reads: true, writes: false, column_reads: true
        })) };
      }
      const readsPolicy = sql.includes('tenant_owner_policy');
      queries.push({ reader: filename, readsPolicy });
      assert.equal(readsPolicy, false, 'data-reader SQL must not depend on writer policy');
      if (state.unavailable) throw new Error('synthetic unavailable');
      // The stored assignment and role stay unchanged as the separate policy
      // record tightens. These are independently mutable records in the DDL.
      return { rows: [{ anonymous_roles: state.anonymous.slice(), subject_id: 'synthetic_subject',
        found_subject: 'synthetic_subject', display_name: 'Synthetic Subject',
        role_name: 'synthetic_reader', found_role: 'synthetic_reader', permissions: state.permissions.slice(),
        active: true, credential_enabled: true, generation: 1, session_active: true,
        session_generation: 1, expires_at: 2000000000, key_active: true }] };
    },
    async end () {}
  };
  const fakeRequire = spec => spec === '../storage/postgres-connection'
    ? async () => connection
    : spec === '../storage/tenant-scope' ? { getTenancyMode: () => 'multi' } : actualRequire(spec);
  const module = { exports: {} };
  // filename is one of the two fixed calls below, never a command-line value.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const compiled = vm.runInThisContext('(function(require,module,exports){\n' + fs.readFileSync(file, 'utf8') + '\n})',
    { filename: file });
  compiled(fakeRequire, module, module.exports);
  return module.exports;
}

async function run ({ quiet = false } = {}) {
  Object.assign(state, { ceiling: [permission], permissions: [permission], unavailable: false,
    anonymous: ['denied'] });
  queries.length = 0;
  const policy = createOwnerPolicy({ namespace: 'synthetic_authority', catalogue: [permission] });
  const writerConnection = { async query (sql) {
    if (sql.includes('SELECT anonymous_roles')) return { rows: [{ anonymous_roles: ['denied'] }] };
    if (sql.includes('SELECT catalogue_digest')) return { rows: [{ catalogue_digest: catalogueDigest([permission]), ceiling: state.ceiling.slice() }] };
    if (sql.includes('SELECT active,can_update,delegable')) return { rows: [{ active: true, can_update: true, delegable: [permission] }] };
    if (sql.includes('SELECT name,permissions')) return { rows: [{ name: 'synthetic_reader', permissions: state.permissions.slice() }] };
    throw new Error('unexpected policy query');
  } };
  const legacy = await reader('postgres.js')({ namespace: 'synthetic_authority' });
  const local = await reader('access-postgres.js')({ namespace: 'synthetic_access', authorityNamespace: 'synthetic_authority' });
  const principal = { kind: 'subject', subjectId: 'synthetic_subject' };
  const claims = { tid: tenant, sub: principal.subjectId, sid: 'synthetic_session', kid: 'synthetic_key', purpose: 'data' };
  async function snapshot () {
    const start = queries.length;
    const result = {
      legacy: await legacy.authorize({ tenant, principal, permission }),
      legacySnapshot: (await legacy.subjectSnapshot({ tenant, principal })).permissionGroups.flat().includes(permission),
      local: (await local.snapshot(claims)).allows(permission)
    };
    assert.equal(queries.length - start, 3, 'each of three protected operations uses one authority statement');
    return result;
  }
  await policy.authorizeUpdate(writerConnection, actor, principal.subjectId, { roles: ['synthetic_reader'] });
  const before = await snapshot();
  assert.deepEqual(before, { legacy: true, legacySnapshot: true, local: true });
  const inFlight = await local.snapshot(claims);
  state.ceiling = [];
  await assert.rejects(policy.authorizeUpdate(writerConnection, actor, principal.subjectId, { roles: ['synthetic_reader'] }),
    { code: 'SUBJECT_ADMIN_FORBIDDEN' });
  const after = await snapshot();
  assert.equal(inFlight.allows(permission), true, 'an already-authorized operation retains its own snapshot');
  assert.deepEqual(after, before, 'writer ceiling changes do not rewrite data-reader grants');
  // Control: removing the actual stored role permission must change all readers.
  state.permissions = [];
  const removed = await snapshot();
  assert.deepEqual(removed, { legacy: false, legacySnapshot: false, local: false });
  state.permissions = [permission];
  const restored = await snapshot();
  assert.deepEqual(restored, after);
  assert.equal(await legacy.authorize({ tenant, principal: { kind: 'root' }, permission }), true);
  state.anonymous = ['readable'];
  assert.equal(await legacy.authorize({ tenant, principal: { kind: 'anonymous' }, permission }), true);
  state.anonymous = ['denied'];
  assert.ok(queries.every(query => !query.readsPolicy), 'reader SQL must not depend on owner policy');
  state.unavailable = true;
  await assert.rejects(legacy.authorize({ tenant, principal, permission }), { code: 'TENANT_AUTHORITY_UNAVAILABLE' });
  await assert.rejects(local.snapshot(claims), { code: 'ACCESS_AUTHORITY_UNAVAILABLE' });
  await legacy.close();
  await local.close();
  const observation = { grade: 'reproduced source-only; SQL responses synthetic',
    before, tightenedCeiling: [], proposedGrantRefused: true, after, removed, restored,
    protectedOutageRefused: true, queries };
  if (!quiet) console.log(JSON.stringify(observation, null, 2));
  return observation;
}

if (require.main === module) {
  run()
    .catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { run };
