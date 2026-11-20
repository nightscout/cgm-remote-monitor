'use strict';

// Request protocol accounting only. Physical backend/COMMIT coverage remains in
// rest-entries-{read-transaction,joined-authority}.test.js; no native/load run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const createAccess = require('../lib/server/tenant-app/data-access');
const authentication = require('../lib/api3/tenant-authentication');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function implementation (mutate) {
  if (!mutate) return createAccess;
  const file = require.resolve('../lib/server/tenant-app/data-access'), out = { exports: {} };
  const source = fs.readFileSync(file, 'utf8'), changed = mutate(source);
  assert.notEqual(changed, source, 'CONTROL_MUTATION_LANDED');
  vm.runInThisContext('(function(require,module,exports){' + changed + '\n})', { filename: file })(createRequire(file), out, out.exports);
  return out.exports;
}
function rawFixture (mutate) {
  const events = [], state = { allowed: true, commit: true };
  let active;
  const connection = {
    async withTenant (tenant, operation) {
      if (active) { assert.equal(active, tenant, 'NO_FOREIGN_NESTED_TENANT'); return operation(); }
      events.push('acquire', 'BEGIN'); active = tenant;
      try {
        const result = await operation();
        if (!state.commit) throw Error('synthetic COMMIT refused');
        events.push('COMMIT'); return result;
      } catch (error) { events.push('ROLLBACK'); throw error; }
      finally { active = undefined; events.push('release'); }
    },
    async query (name) { assert(active, 'SQL_MUST_BE_TENANT_BOUND'); events.push(name); return { rows: [] }; }
  };
  const authority = {
    usesConnection: candidate => candidate === connection,
    authorize: async () => { throw Error('permission snapshot expected'); },
    subjectAuthorizationSnapshot: async () => null,
    permissionSnapshot: async ({ tenant }) => connection.withTenant(tenant, async () => {
      await connection.query('authority'); return { allows: () => state.allowed };
    })
  };
  const factory = implementation(mutate);
  const access = factory({ authority, readConnection: connection,
    verifierContext: async tenant => ({ tenant, consumer: 'api' }),
    secrets: { verifyLegacyCredential: async () => { events.push('verify'); return { kind: 'root' }; } },
    legacyCollections: ['entries', 'treatments', 'devicestatus'] });
  function request (logical, tenant = A, registration = {}) {
    const req = { method: 'GET', path: '/' + logical, query: {}, rawHeaders: ['api-secret', 'synthetic'] };
    factory.registerRawRead(req, { logical, tenant, connection,
      load: async () => { await connection.query('clinical'); return { logical, tenant }; },
      publish: frame => { events.push('publish'); req.frame = frame; }, ...registration });
    return req;
  }
  async function serve (req, tenant = A) {
    const actor = await access({ tenant, request: req, version: 1 });
    if (actor && !req.frame) await connection.withTenant(tenant, () => connection.query('clinical'));
    return actor;
  }
  return { access, request, serve, state, events, connection };
}
function oneRead (events) {
  assert.equal(events.filter(x => x === 'acquire').length, 1, 'ONE_AUTHORITY_AND_RAW_ACQUISITION');
  assert.equal(events.filter(x => x === 'authority').length, 1, 'FRESH_CURRENT_AUTHORITY');
  assert.equal(events.filter(x => x === 'clinical').length, 1, 'ONE_CLINICAL_ACQUISITION');
  assert(events.indexOf('authority') < events.indexOf('clinical'));
  assert(events.indexOf('COMMIT') < events.indexOf('publish'));
}

describe('REST request work budget', function () {
  it('joins registered cache-eligible entries, treatments and devicestatus authority/acquisition without extra transaction work', async function () {
    for (const logical of ['entries', 'treatments', 'devicestatus']) {
      const f = rawFixture(), req = f.request(logical);
      assert(await f.serve(req)); oneRead(f.events); assert.equal(req.frame.logical, logical);
    }
  });
  it('keeps current revocation, COMMIT failure and cross-domain registrations fail closed', async function () {
    const f = rawFixture(); assert(await f.serve(f.request('treatments')));
    f.events.length = 0; f.state.allowed = false; const denied = f.request('treatments');
    await assert.rejects(f.serve(denied), { code: 'TENANT_LEGACY_FORBIDDEN' });
    assert(!f.events.includes('clinical')); assert.equal(authentication.get(denied), undefined);
    f.state.allowed = true; f.state.commit = false; f.events.length = 0; const failed = f.request('devicestatus');
    await assert.rejects(f.serve(failed), /COMMIT refused/);
    assert(!f.events.includes('publish')); assert.equal(authentication.get(failed), undefined);
    f.state.commit = true; f.events.length = 0; const foreign = f.request('treatments', A, { logical: 'entries' });
    assert(await f.serve(foreign)); assert.equal(foreign.frame, undefined);
    assert.equal(f.events.filter(x => x === 'acquire').length, 2);
    f.events.length = 0; assert(await f.serve(f.request('devicestatus', B), B)); oneRead(f.events);
    assert.throws(() => f.request('food'), /raw read registration/);
  });
  it('control: retaining entries-only joining restores a second T/D acquisition and fails the work budget', async function () {
    const f = rawFixture(source => source.replace('selected.logical === registered.logical &&', "selected.logical === 'entries' &&"));
    assert(await f.serve(f.request('treatments')));
    assert.equal(f.events.filter(x => x === 'acquire').length, 2, 'BROKEN_JOIN_WAS_EXERCISED');
    assert.throws(() => oneRead(f.events), /ONE_AUTHORITY_AND_RAW_ACQUISITION/);
  });

  function mixedFixture ({ root = false, tokenKnown = true, tokenCurrent = true, apiNamed = true, allowed = true } = {}) {
    const calls = [];
    const access = createAccess({ legacyCollections: ['entries'], verifierContext: async tenant => ({ tenant, consumer: 'api' }),
      secrets: {
        async verifyLegacyCredential (context, input, acceptToken) {
          calls.push('verify');
          const token = { kind: 'subject', subjectId: 'token-subject' };
          if (!tokenKnown || !await acceptToken(token)) return null;
          return root ? { kind: 'root' } : token;
        },
        exchangeLegacyCredential: async () => { calls.push('EXCHANGE_FORBIDDEN'); throw Error('DATA must not issue JWTs'); }
      }, authority: {
        authorize: async () => { throw Error('snapshot expected'); },
        subjectAuthorizationSnapshot: async ({ principal }) => {
          calls.push('subject:' + principal.subjectId);
          if (principal.subjectId === 'token-subject' && !tokenCurrent) return null;
          if (principal.subjectId === 'api-subject' && !apiNamed) return null;
          return { subject: { sub: principal.subjectId }, allows: () => allowed };
        },
        permissionSnapshot: async ({ principal }) => { calls.push('permission:' + principal.kind); return { allows: () => allowed }; },
        subjectSnapshot: async () => null
      } });
    const request = (method = 'GET') => ({ method, path: '/entries', query: { token: 'legacy-token' }, rawHeaders: ['api-secret', 'api-secret-subject'] });
    return { access, calls, request };
  }
  it('authenticates mixed DATA credentials once, without signing/exchanging, and reuses only current operation authority', async function () {
    for (const method of ['GET', 'POST']) {
      const f = mixedFixture(), req = f.request(method);
      const result = await f.access({ tenant: A, request: req, version: 1 });
      assert.equal(result.principal, 'token-subject');
      assert.deepEqual(f.calls, ['verify', 'subject:token-subject']);
      if (method === 'POST') assert.equal(authentication.get(req).subject.name, 'token-subject');
    }
    const root = mixedFixture({ root: true });
    assert.equal((await root.access({ tenant: A, request: root.request(), version: 1 })).principal, 'root');
    assert.deepEqual(root.calls, ['verify', 'subject:token-subject', 'permission:root']);
  });
  it('retains actual mixed-token refusal when the token subject is absent and never reuses prior authority', async function () {
    const f = mixedFixture({ tokenCurrent: false, apiNamed: false });
    for (let i = 0; i < 2; i++) {
      assert.equal(await f.access({ tenant: A, request: f.request(), version: 1 }), null);
    }
    assert.deepEqual(f.calls, ['verify', 'subject:token-subject', 'verify', 'subject:token-subject']);
    const denied = mixedFixture({ allowed: false }), req = denied.request();
    await assert.rejects(denied.access({ tenant: A, request: req, version: 1 }), { code: 'TENANT_LEGACY_FORBIDDEN' });
    assert.equal(authentication.get(req), undefined);
  });
});

// Compose the api's DATA verifier (one-way verifiers, lib/secrets/legacy-verifiers.js)
// and DATA entry point. Verifier-store reads and authority reads are counted as
// actually invoked. The Vault-backed verifier and its decrypt-per-request cost
// are retired (decision deployment-signing-secret): no secrets operation runs.
function credentialFixture ({ root = false, tokenCurrent = true, tokenNamed = true,
  apiNamed = true, tokenKnown = true, allowed = true } = {}) {
  const crypto = require('node:crypto');
  const verifiers = require('../lib/secrets/legacy-verifiers');
  const hash = value => crypto.createHash('sha1').update(value).digest('hex');
  const rootSecret = 'synthetic-root-secret', rootHash = hash(rootSecret);
  const derived = id => (id === 'token-subject' ? 'token' : 'api') + '-' + hash(rootHash + id).slice(0, 16);
  const counts = { secrets: 0, metadata: 0, authority: 0 };
  const prepared = verifiers.prepare(Buffer.from(rootSecret), ['token-subject', 'api-subject'].map(subjectId =>
    ({ subjectId, tokenPrefix: subjectId === 'token-subject' ? 'token' : 'api' })));
  const verifier = verifiers.create({ verifyToken: () => { counts.secrets++; throw new Error('no JWT presented'); },
    read: async () => {
      counts.metadata++;
      return { rootVerifiers: prepared.rootVerifiers, rootVersion: 1, keys: [],
        subjects: prepared.subjects.map(subject => ({ ...subject, credentialVersion: 1 })) };
    } });
  const context = { tenant: A, principal: 'api', consumer: 'api' };
  const name = id => id === 'token-subject' ? (tokenCurrent && tokenNamed ? 'token-current-name' : null)
    : apiNamed ? 'api-current-name' : null;
  const authority = {
    authorize: async () => { throw Error('snapshot expected'); },
    async subjectSnapshot ({ principal }) { counts.authority++; const sub = name(principal.subjectId); return sub ? { sub } : null; },
    async permissionSnapshot () { counts.authority++; return { allows: () => allowed }; },
    async subjectAuthorizationSnapshot ({ principal }) {
      counts.authority++; const sub = name(principal.subjectId);
      return sub ? { subject: { sub }, allows: () => allowed } : null;
    }
  };
  const access = implementation()({ secrets: verifier, authority, verifierContext: async () => context, legacyCollections: ['entries'] });
  return {
    counts,
    async run () {
      const request = { method: 'GET', path: '/entries', query: { token: tokenKnown ? derived('token-subject') : 'unknown-legacy-token' },
        rawHeaders: ['api-secret', root ? rootHash : hash(derived('api-subject'))] };
      try { const result = await access({ tenant: A, request, version: 1 }); return result ? result.principal : null; }
      catch (error) { return error.code || error.message; }
    }
  };
}
describe('local verifier mixed-credential cost', function () {
  it('authenticates DATA with one verifier read and no secrets operation for root, token, missing/unnamed refusal and revocation outcomes', async function () {
    const cases = [
      [{ root: true }, 'root', 2], [{}, 'token-subject', 1],
      [{ root: true, tokenCurrent: false }, null, 1], [{ root: true, tokenKnown: false }, null, 0],
      [{ tokenCurrent: false }, null, 1], [{ tokenNamed: false, apiNamed: false }, null, 1],
      [{ tokenKnown: false }, null, 0], [{ allowed: false }, 'TENANT_LEGACY_FORBIDDEN', 1]
    ];
    for (const [options, outcome, authority] of cases) {
      const candidate = credentialFixture(options);
      assert.equal(await candidate.run(), outcome, 'CURRENT_DATA_CREDENTIAL_OUTCOME');
      assert.deepEqual(candidate.counts, { secrets: 0, metadata: 1, authority }, 'DATA_AUTHENTICATES_WITHOUT_SECRETS');
    }
  });
});

// Local verifier store and current authority on the request connection: one
// tenant transaction, current reads only, and the prior per-reader error codes.
function fusedFixture (mutate) {
  const events = [], state = { allowed: true, commit: true, refuse: false, known: true };
  let active;
  const connection = {
    async withTenant (tenant, operation) {
      if (active) { assert.equal(active, tenant, 'NO_FOREIGN_NESTED_TENANT'); return operation(); }
      events.push('acquire');
      if (state.refuse) throw Object.assign(Error('LIFECYCLE_WINDOW_SUSPENDED'), { code: 'LIFECYCLE_WINDOW_SUSPENDED' });
      events.push('BEGIN'); active = tenant;
      try {
        const result = await operation();
        if (!state.commit) throw Error('synthetic COMMIT refused');
        events.push('COMMIT'); return result;
      } catch (error) { events.push('ROLLBACK'); throw error; }
      finally { active = undefined; events.push('release'); }
    },
    async query (name) { assert(active, 'SQL_MUST_BE_TENANT_BOUND'); events.push(name); return { rows: [] }; }
  };
  const snapshot = () => ({ subject: { sub: 'current-name' }, allows: () => state.allowed });
  const authority = {
    usesConnection: candidate => candidate === connection,
    authorize: async () => { throw Error('snapshot expected'); },
    subjectSnapshot: async () => { throw Error('snapshot expected'); },
    subjectAuthorizationSnapshot: async ({ tenant }) => connection.withTenant(tenant, async () => { await connection.query('authority'); return snapshot(); }),
    permissionSnapshot: async ({ tenant }) => connection.withTenant(tenant, async () => { await connection.query('authority'); return snapshot(); })
  };
  const secrets = {
    usesConnection: candidate => candidate === connection,
    async verifyLegacyCredential (context, input) {
      await connection.withTenant(context.tenant, () => connection.query('verifier'));
      if (!state.known) throw Object.assign(Error('SECRETS_LEGACY_AUTHORITY_UNKNOWN'), { code: 'SECRETS_LEGACY_AUTHORITY_UNKNOWN' });
      return input.apiSecret === 'synthetic-root' ? { kind: 'root' } : { kind: 'subject', subjectId: 'subject' };
    }
  };
  const factory = implementation(mutate);
  const access = factory({ authority, readConnection: connection, secrets, verifierContext: async tenant => ({ tenant, consumer: 'api' }),
    legacyCollections: ['entries'] });
  function request (method = 'GET', carrier = 'token') {
    const req = { method, path: '/entries', query: carrier === 'token' ? { token: 'subject-0123456789abcdef' } : {},
      rawHeaders: carrier === 'token' ? [] : ['api-secret', 'synthetic-root'] };
    if (method === 'GET') factory.registerRawRead(req, { logical: 'entries', tenant: A, connection,
      load: async () => { await connection.query('clinical'); return { logical: 'entries' }; },
      publish: frame => { events.push('publish'); req.frame = frame; } });
    return req;
  }
  return { access: req => access({ tenant: A, request: req, version: 1 }), request, state, events };
}
describe('fused verifier and authority transaction', function () {
  it('reads verifier, current authority and the joined clinical read in one transaction, publishing after COMMIT', async function () {
    for (const carrier of ['token', 'secret']) {
      const f = fusedFixture(), get = f.request('GET', carrier);
      assert(await f.access(get));
      assert.deepEqual(f.events, ['acquire', 'BEGIN', 'verifier', 'authority', 'clinical', 'COMMIT', 'release', 'publish']);
      f.events.length = 0; const write = f.request('POST', carrier);
      assert(await f.access(write)); assert(authentication.get(write));
      assert.deepEqual(f.events, ['acquire', 'BEGIN', 'verifier', 'authority', 'COMMIT', 'release']);
    }
  });
  it('honours a revocation on the next request and keeps every refusal code', async function () {
    const f = fusedFixture(); assert(await f.access(f.request('POST')));
    f.state.allowed = false; f.events.length = 0; const denied = f.request('POST');
    await assert.rejects(f.access(denied), { code: 'TENANT_LEGACY_FORBIDDEN' });
    assert.equal(authentication.get(denied), undefined); assert.deepEqual(f.events.filter(x => x === 'authority'), ['authority']);
    f.state.allowed = true; f.state.refuse = true; f.events.length = 0;
    await assert.rejects(f.access(f.request('GET')), { code: 'SECRETS_LEGACY_AUTHORITY_UNAVAILABLE' });
    assert.deepEqual(f.events, ['acquire'], 'REFUSED_BEFORE_ANY_READ');
    f.state.refuse = false; f.state.commit = false;
    await assert.rejects(f.access(f.request('POST')), { code: 'TENANT_AUTHORITY_UNAVAILABLE' });
    const joined = f.request('GET');
    await assert.rejects(f.access(joined), /COMMIT refused/);
    assert.equal(joined.frame, undefined); assert.equal(authentication.get(joined), undefined);
    f.state.commit = true; f.state.known = false;
    await assert.rejects(f.access(f.request('GET')), { code: 'SECRETS_LEGACY_AUTHORITY_UNKNOWN' });
  });
  it('control: surfacing the raw window refusal changes the prior verifier code and fails the code control', async function () {
    const f = fusedFixture(source => source.replace("const reported = failure(entered ? reader : 'SECRETS_LEGACY_AUTHORITY_UNAVAILABLE');", 'const reported = error;'));
    f.state.refuse = true;
    await assert.rejects(f.access(f.request('GET')), { code: 'LIFECYCLE_WINDOW_SUSPENDED' });
  });
});
