'use strict';

// Native owner transport instrument. Import/admit acquire nothing. Only the
// lead-admitted shared driver supplies HTTPS, native stores and browser custody.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const PREFIX = '/api/v2/oidc';
const COOKIE = '__Host-ns-human-management';
const DATA_COOKIE = '__Host-ns-human-data';
const SUBJECTS = '/api/v2/authorization/subjects';
const SETTINGS = '/api/v1/tenant/settings';
const HTTP_FLAGS = Object.freeze(['ownerCookieMutations', 'ownerBearerParity', 'ownerCsrfOrigin',
  'ownerSensitiveFreshness', 'ownerCurrentAuthority', 'ownerSessionLogout']);
const BROWSER_FLAGS = Object.freeze(['ownerBrowserMutations', 'ownerBrowserTabsBackReload',
  'ownerBrowserBearerParity', 'ownerBrowserLogout']);
const COMPATIBILITY_FLAGS = Object.freeze(['defaultOffMulti', 'legacyApiSecret',
  'legacySubject', 'legacyEightHourExchange', 'anonymousReadClamp', 'planeSeparation']);
const CLASSIFICATIONS = Object.freeze({ http: 'native-PG-Transit-owner-cookie-bearer-https',
  browser: 'native-PG-Transit-owner-browser', compatibility: 'native-PG-legacy-compatibility' });
const fail = code => { throw new Error(code); };
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const ns = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(value) &&
  !['public', 'information_schema'].includes(value) && !value.startsWith('pg_');

function admit (plan) {
  if (plan?.env?.HUMAN_SESSION_NATIVE_RESERVED !== '1' ||
      plan.env.HUMAN_HTTPS_RESERVED !== '1' || plan.binding?.persistence !== 'postgres' ||
      plan.binding?.signing !== 'configured-transit' || !Array.isArray(plan.config?.tenants) ||
      plan.config.tenants.length !== 2 || new Set(plan.config.tenants).size !== 2 ||
      plan.config.tenants.some(value => typeof value !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))) {
    fail('OWNER_BROWSER_EXPLICIT_NATIVE_PLAN_REQUIRED');
  }
  return true;
}

function admitContext (context) {
  admit(context);
  if (context.nativeStore?.kind !== 'postgres' || !context.config.tenants.includes(context.tenant) ||
      !ns(context.nativeStore.resources?.human) || !ns(context.parsed?.namespaces?.authorization) ||
      typeof context.admin?.query !== 'function' || typeof context.snapshot !== 'function') {
    fail('OWNER_BROWSER_NATIVE_CONTEXT_REQUIRED');
  }
  if (!['subjects', 'settings', 'settingsReader'].every(key => context.services?.[key]) ||
      typeof context.nativeStore.inspect !== 'function') fail('OWNER_BROWSER_ACTUAL_SERVICES_REQUIRED');
  const origin = new URL(context.origin);
  if (origin.protocol !== 'https:' || origin.origin !== context.origin) fail('OWNER_BROWSER_HTTPS_ORIGIN_REQUIRED');
  return true;
}

function assertCompleted (kind, result) {
  const keys = { http: HTTP_FLAGS, browser: BROWSER_FLAGS, compatibility: COMPATIBILITY_FLAGS }[kind];
  if (!keys || !result || result.classification !== CLASSIFICATIONS[kind] ||
      keys.some(key => result[key] !== true)) fail('OWNER_BROWSER_FAMILY_INCOMPLETE');
  return true;
}

async function response (reply) {
  if (!reply || !Number.isInteger(reply.status)) fail('OWNER_BROWSER_RESPONSE_SHAPE');
  const body = typeof reply.json === 'function' ? await reply.json() : reply.body;
  if (!body || typeof body !== 'object') fail('OWNER_BROWSER_RESPONSE_SHAPE');
  return { status: reply.status, body, headers: reply.headers };
}

function cookieFrom (reply, name = COOKIE) {
  const raw = reply.headers?.get('set-cookie');
  if (typeof raw !== 'string') fail('OWNER_BROWSER_DEFAULT_COOKIE_MISSING');
  const part = raw.split(/,(?=\s*__Host-)/).find(value => value.trim().startsWith(name + '='));
  if (!part || !/;\s*HttpOnly(?:;|$)/i.test(part) || !/;\s*Secure(?:;|$)/i.test(part) ||
      !/;\s*SameSite=Strict(?:;|$)/i.test(part)) fail('OWNER_BROWSER_DEFAULT_COOKIE_FLAGS');
  return part.trim().split(';')[0];
}

function assertPopulated (value) {
  const populated = Array.isArray(value) ? value.some(row => row && typeof row === 'object' &&
    (Object.hasOwn(row, 'rows') ? Array.isArray(row.rows) && row.rows.length > 0 : true)) : value && typeof value === 'object' &&
    Object.values(value).some(rows => Array.isArray(rows) && rows.length > 0);
  assert.equal(populated, true, 'independent native oracle must contain populated tenant rows');
}

async function withRestoration (action, restore) {
  let value, primary;
  try { value = await action(); } catch (error) { primary = error; }
  try { await restore(); } catch (error) {
    if (primary) throw new globalThis.AggregateError([primary, error], 'OWNER_BROWSER_OPERATION_AND_RESTORE_FAILED');
    throw error;
  }
  if (primary) throw primary;
  return value;
}

function cookieOptions ({ cookie, csrf, origin }, method, body, overrides = {}) {
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  return { method, headers: { cookie, ...(unsafe ? { origin, 'x-ns-csrf': csrf } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...overrides },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

// Sent directly into the real browser realm. No closure values or instrumentation
// globals are needed; in particular DELETE requires CSRF even without a body.
async function browserRequest (input) {
  const headers = {};
  if (input.token) headers.authorization = 'Bearer ' + input.token;
  if (input.body !== undefined) headers['content-type'] = 'application/json';
  if (!input.token && !['GET', 'HEAD', 'OPTIONS'].includes(input.method)) {
    const state = await (await fetch(input.prefix + '/session?purpose=management', { cache: 'no-store' })).json();
    headers['x-ns-csrf'] = input.badCsrf ? 'invalid' : state.csrf;
  }
  const reply = await fetch(input.path, { method: input.method, cache: 'no-store', headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }) });
  return { status: reply.status, body: await reply.json() };
}

function create (context) {
  admitContext(context);
  const { admin, config, parsed, nativeStore, tenant, origin, snapshot } = context;
  const sessions = quote(nativeStore.resources.human) + '.human_sessions';
  const actors = quote(parsed.namespaces.authorization) + '.tenant_owner_actors';
  const checkStatus = (actual, expected) => assert.equal(actual, expected, 'owner transport status oracle');
  const flatten = value => Object.values(value).flat();
  const foreign = config.tenants.find(value => value !== tenant);
  const states = { http: null, browser: null, compatibility: null };
  const tabs = new Set();

  async function verifyEffects (id, present) {
    const rows = flatten(await snapshot(tenant));
    assert.equal(rows.some(row => row.subject_id === id && Object.hasOwn(row, 'display_name')), present,
      'independent native subject persistence oracle');
    if (present) assert.equal(rows.some(row => row.subject_id === id && row.operation === 'issue'), true,
      'independent native issuance audit oracle');
  }

  async function exerciseMutations (request, label) {
    const name = 'owner_' + label + '_' + randomBytes(5).toString('hex');
    checkStatus((await request('POST', '/api/v2/authorization/roles', { name, permissions: ['api:entries:read'] })).status, 200);
    const created = await request('POST', SUBJECTS, { name: 'Synthetic transport subject', roles: [name] });
    checkStatus(created.status, 200);
    const id = created.body.subjectId;
    assert.equal(typeof id === 'string' && /^[a-f0-9]{32}$/.test(id), true, 'created native subject identity');
    checkStatus((await request('POST', SUBJECTS + '/' + id + '/credential', {})).status, 200);
    await verifyEffects(id, true);
    const current = await request('GET', SETTINGS); checkStatus(current.status, 200);
    const changed = await request('PUT', SETTINGS, { expectedVersion: current.body.version,
      values: { ...current.body.values, SHOW_SECONDS: !current.body.effective.SHOW_SECONDS.value } });
    checkStatus(changed.status, 200);
    assert.equal(changed.body.version, current.body.version + 1, 'native settings version advances once');
    const rolled = await request('POST', SETTINGS + '/rollback', {
      expectedVersion: changed.body.version, restoredFrom: current.body.version });
    checkStatus(rolled.status, 200);
    assert.equal(rolled.body.version, changed.body.version + 1, 'native rollback version advances once');
    assert.deepEqual(rolled.body.values, current.body.values, 'rollback restores exact committed owner values');
    checkStatus((await request('DELETE', SUBJECTS + '/' + id)).status, 200);
    await verifyEffects(id, false);
    checkStatus((await request('POST', SUBJECTS + '/' + id + '/credential', {})).status, 404);
    return id;
  }

  async function assertFreshness (request, session) {
    const made = await request('POST', SUBJECTS, { name: 'Synthetic freshness subject', roles: [] });
    checkStatus(made.status, 200);
    const id = made.body.subjectId;
    // Age only this owned durable session. The real engine must reject the
    // sensitive action while ordinary management/revocation remains available.
    const changed = (await admin.query('UPDATE ' + sessions + ' SET authenticated_at=$3 WHERE tenant_id=$1 AND session_id=$2 RETURNING authenticated_at',
      [tenant, session.id, Math.floor(Date.now() / 1000) - 301])).rows;
    assert.equal(changed.length, 1, 'owned native management session must actually age');
    assert.equal(Number(changed[0].authenticated_at) + 300 <= Math.floor(Date.now() / 1000), true);
    await withRestoration(async () => {
      const before = await snapshot(tenant);
      checkStatus((await request('POST', '/api/v2/authorization/roles', {
        name: 'stale_' + randomBytes(5).toString('hex'), permissions: ['api:entries:read'] })).status, 403);
      checkStatus((await request('POST', SUBJECTS + '/' + id + '/credential', {})).status, 403);
      assert.deepEqual(await snapshot(tenant), before, 'stale privileged grant/issuance must have no effect');
      checkStatus((await request('GET', SETTINGS)).status, 200);
      checkStatus((await request('DELETE', SUBJECTS + '/' + id)).status, 200);
      await verifyEffects(id, false);
    }, () => admin.query('UPDATE ' + sessions + ' SET authenticated_at=$3 WHERE tenant_id=$1 AND session_id=$2',
      [tenant, session.id, session.authenticatedAt]));
  }

  async function exerciseHttp ({ transport, site, login }) {
    admitContext(context);
    if (site !== origin || typeof transport !== 'function' || typeof login !== 'function') fail('OWNER_BROWSER_HTTP_BINDING_REQUIRED');
    const beforeB = await snapshot(foreign);
    assertPopulated(beforeB);
    // Omitted transport selects the real HTTP layer's adopted cookie default.
    const cookieReply = await login(undefined, 'management');
    checkStatus(cookieReply.status, 303);
    const cookie = cookieFrom(cookieReply);
    let csrf;
    const cookieRequest = async (method, path, body, overrides = {}) => response(await transport(site + path,
      cookieOptions({ cookie, csrf, origin: site }, method, body, overrides)));
    const probe = await cookieRequest('GET', PREFIX + '/session?purpose=management'); checkStatus(probe.status, 200);
    csrf = probe.body.csrf;
    assert.equal(typeof csrf === 'string' && /^[A-Za-z0-9_-]{43}$/.test(csrf), true, 'actual server CSRF issued');
    const claims = await context.access.verify({ tenant, token: cookie.slice(COOKIE.length + 1) });
    assert.equal(claims.exp - claims.iat <= 600, true, 'management access retains its maximum lifetime');
    const dataReply = await login(undefined, 'data'); checkStatus(dataReply.status, 303);
    const dataCookie = cookieFrom(dataReply, DATA_COOKIE);
    const dataProbe = async () => response(await transport(site + PREFIX + '/session', { headers: { cookie: dataCookie } }));
    const data = await dataProbe();
    checkStatus(data.status, 200);
    assert.equal(data.body.session.idleExpiresAt, null, 'always-on data has no management idle');
    assert.equal(data.body.session.absoluteExpiresAt, null, 'always-on data has no management absolute deadline');
    checkStatus((await response(await transport(site + SETTINGS, { headers: { cookie: dataCookie } }))).status, 401);
    const prior = await snapshot(tenant);
    const denied = { expectedVersion: (await cookieRequest('GET', SETTINGS)).body.version, values: {} };
    checkStatus((await cookieRequest('PUT', SETTINGS, denied, { 'x-ns-csrf': 'invalid' })).status, 403);
    checkStatus((await cookieRequest('PUT', SETTINGS, denied, { origin: 'https://foreign.synthetic.invalid' })).status, 403);
    checkStatus((await cookieRequest('PUT', SETTINGS, denied, { authorization: 'Bearer ambiguous' })).status, 401);
    assert.deepEqual(await snapshot(tenant), prior, 'CSRF/origin/ambiguity refusal has no native mutation');
    await exerciseMutations(cookieRequest, 'cookie');

    const session = probe.body.session;
    await assertFreshness(cookieRequest, session);

    const assertAuthority = async request => {
      const changed = (await admin.query('UPDATE ' + actors + ' SET active=false WHERE tenant_id=$1 AND principal=$2 AND consumer=$3 AND active RETURNING principal',
        [tenant, nativeStore.subject, parsed.consumer])).rows;
      assert.equal(changed.length, 1, 'native current management actor must actually deactivate');
      await withRestoration(async () => {
        const before = await snapshot(tenant);
        checkStatus((await request('GET', SETTINGS)).status, 403);
        assert.deepEqual(await snapshot(tenant), before, 'revoked native actor cannot operate');
      }, () => admin.query('UPDATE ' + actors + ' SET active=true WHERE tenant_id=$1 AND principal=$2 AND consumer=$3',
        [tenant, nativeStore.subject, parsed.consumer]));
    };
    await assertAuthority(cookieRequest);

    checkStatus((await cookieRequest('POST', PREFIX + '/logout', { purpose: 'management' })).status, 200);
    checkStatus((await cookieRequest('GET', SETTINGS)).status, 401);
    const durable = (await nativeStore.inspect()).sessions.find(value => value.id === session.id);
    assert.equal(durable?.active, false, 'local logout must persist before copied-cookie replay');
    const retainedData = await dataProbe(); checkStatus(retainedData.status, 200);
    assert.equal(retainedData.body.session.id, data.body.session.id, 'management logout does not replace/revoke the data session');
    const bearerReply = await response(await login('bearer', 'management')); checkStatus(bearerReply.status, 200);
    const token = bearerReply.body.token;
    const bearerRequest = async (method, path, body) => response(await transport(site + path, { method,
      headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    await assertFreshness(bearerRequest, bearerReply.body.session);
    await assertAuthority(bearerRequest);
    await exerciseMutations(bearerRequest, 'bearer');
    checkStatus((await bearerRequest('POST', PREFIX + '/logout', { purpose: 'management' })).status, 200);
    checkStatus((await bearerRequest('GET', SETTINGS)).status, 401);
    assert.deepEqual(await snapshot(foreign), beforeB, 'transport journeys leave B unchanged');
    states.http = { classification: CLASSIFICATIONS.http, ...Object.fromEntries(HTTP_FLAGS.map(key => [key, true])) };
    assertCompleted('http', states.http); return states.http;
  }

  async function exerciseBrowser ({ browserContext, page, site }) {
    admitContext(context);
    if (context.env.HUMAN_BROWSER_RESERVED !== '1' || site !== origin || !browserContext ||
        typeof browserContext.newPage !== 'function' || typeof browserContext.cookies !== 'function' ||
        typeof browserContext.request?.get !== 'function' ||
        typeof page?.evaluate !== 'function' || typeof page.goto !== 'function') fail('OWNER_BROWSER_OWNED_BROWSER_REQUIRED');
    const beforeB = await snapshot(foreign);
    assertPopulated(beforeB);
    const fetchOn = (selected, method, path, body, token, badCsrf = false) => selected.evaluate(browserRequest,
      { prefix: PREFIX, method, path, body, token, badCsrf });
    await page.goto(site);
    const location = await page.evaluate(async prefix => (await (await fetch(prefix + '/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'management' })
    })).json()).location, PREFIX);
    await page.goto(location); await page.waitForURL(site + '/');
    assert.equal(await page.evaluate(name => document.cookie.includes(name), COOKIE), false, 'management cookie remains HttpOnly');
    const selected = (await browserContext.cookies(site)).filter(value => value.name === COOKIE);
    assert.equal(selected.length, 1, 'default browser management cookie must exist');
    assert.deepEqual(selected.map(({ httpOnly, secure, sameSite }) => ({ httpOnly, secure, sameSite })),
      [{ httpOnly: true, secure: true, sameSite: 'Strict' }]);
    const tab = await browserContext.newPage(); tabs.add(tab);
    try {
      await tab.goto(site);
      const cookieRequest = (method, path, body) => fetchOn(page, method, path, body);
      const current = await cookieRequest('GET', SETTINGS); checkStatus(current.status, 200);
      const prior = await snapshot(tenant);
      checkStatus((await fetchOn(page, 'PUT', SETTINGS, { expectedVersion: current.body.version, values: {} }, undefined, true)).status, 403);
      assert.deepEqual(await snapshot(tenant), prior, 'browser CSRF refusal has no persisted effect');
      await exerciseMutations(cookieRequest, 'browser');
      checkStatus((await fetchOn(tab, 'GET', SETTINGS)).status, 200);
      await page.goto(site + SETTINGS); await page.goBack(); await page.reload();
      checkStatus((await fetchOn(page, 'GET', SETTINGS)).status, 200);
      checkStatus((await fetchOn(tab, 'POST', PREFIX + '/logout', { purpose: 'management' })).status, 200);
      assert.equal((await browserContext.cookies(site)).some(value => value.name === COOKIE), false, 'local logout clears the browser selector');
      const copied = await browserContext.request.get(site + SETTINGS, {
        headers: { cookie: COOKIE + '=' + selected[0].value }, timeout: 5000
      }).catch(() => fail('OWNER_BROWSER_COPIED_SELECTOR_REQUEST_FAILED'));
      checkStatus(copied.status(), 401);
      checkStatus((await fetchOn(page, 'GET', SETTINGS)).status, 401);
      await page.goto(site + SETTINGS); await page.goBack(); await page.reload();
      checkStatus((await fetchOn(page, 'GET', SETTINGS)).status, 401);
      checkStatus((await fetchOn(tab, 'GET', SETTINGS)).status, 401);
      const bearerLocation = await page.evaluate(async prefix => (await (await fetch(prefix + '/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: 'management', transport: 'bearer' })
      })).json()).location, PREFIX);
      const bearerResponse = await page.goto(bearerLocation);
      const token = (await bearerResponse.json()).token;
      assert.equal(new URL(page.url()).searchParams.has('token'), false, 'bearer never enters URL');
      assert.equal((await browserContext.cookies(site)).some(value => value.name === COOKIE), false, 'direct bearer does not create management cookie');
      const bearerRequest = (method, path, body) => fetchOn(page, method, path, body, token);
      await exerciseMutations(bearerRequest, 'browser_bearer');
      checkStatus((await fetchOn(tab, 'GET', SETTINGS, undefined, token)).status, 200);
      checkStatus((await fetchOn(tab, 'POST', PREFIX + '/logout', { purpose: 'management' }, token)).status, 200);
      await page.goBack(); await page.reload();
      checkStatus((await fetchOn(page, 'GET', SETTINGS, undefined, token)).status, 401);
      checkStatus((await fetchOn(tab, 'GET', SETTINGS, undefined, token)).status, 401);
      assert.deepEqual(await snapshot(foreign), beforeB, 'browser owner journeys leave B unchanged');
    } finally { tabs.delete(tab); await tab.close(); }
    states.browser = { classification: CLASSIFICATIONS.browser, ...Object.fromEntries(BROWSER_FLAGS.map(key => [key, true])) };
    assertCompleted('browser', states.browser); return states.browser;
  }

  async function exerciseCompatibility ({ managementToken }) {
    admitContext(context);
    const compatibility = context.compatibility;
    if (!compatibility || compatibility.nativePersistence !== 'postgres' || compatibility.oidcOff !== true ||
        typeof compatibility.request !== 'function' || typeof compatibility.credentials !== 'function' ||
        typeof compatibility.exchangePath !== 'function' || typeof compatibility.setAnonymous !== 'function' ||
        !Array.isArray(compatibility.defaultOffModes) || !compatibility.defaultOffModes.includes('multi') ||
        typeof compatibility.snapshotData !== 'function' ||
        typeof compatibility.dataPath !== 'string' || typeof compatibility.operatorPath !== 'string' ||
        typeof managementToken !== 'string') fail('OWNER_BROWSER_COMPATIBILITY_BINDING_REQUIRED');
    const request = async input => response(await compatibility.request(input));
    const beforeA = await snapshot(tenant), beforeB = await snapshot(foreign);
    const clinicalA = await compatibility.snapshotData(tenant), clinicalB = await compatibility.snapshotData(foreign);
    assertPopulated(clinicalA); assertPopulated(clinicalB);
    const root = await compatibility.credentials({ tenant, kind: 'apiSecret' });
    const subject = await compatibility.credentials({ tenant, kind: 'subject' });
    assert.equal(typeof root === 'string' && root.length > 0 && typeof subject === 'string' && subject.length > 0, true,
      'explicit protected native legacy credential closure');
    checkStatus((await request({ plane: 'data', tenant, mode: 'multi',
      oidcEnabled: false, method: 'GET', path: compatibility.dataPath, headers: { 'api-secret': root } })).status, 200);
    for (const credential of [root, subject]) {
      checkStatus((await request({ plane: 'data', tenant, method: 'GET', path: compatibility.dataPath,
        headers: { 'api-secret': credential } })).status, 200);
      const refused = await request({ plane: 'data', tenant: foreign, method: 'GET', path: compatibility.dataPath,
        headers: { 'api-secret': credential } });
      assert.equal([401, 403].includes(refused.status), true, 'foreign native credential must refuse');
      const owner = await request({ plane: 'owner', tenant, method: 'GET', path: SETTINGS, headers: { 'api-secret': credential } });
      assert.equal([401, 403].includes(owner.status), true, 'DATA/root cannot become management authority');
      const rawBearer = await request({ plane: 'owner', tenant, method: 'GET', path: SETTINGS,
        headers: { authorization: 'Bearer ' + credential } });
      assert.equal([401, 403].includes(rawBearer.status), true, 'legacy DATA bearer cannot acquire management authority');
    }
    const exchange = await request({ plane: 'data', tenant, method: 'GET', path: compatibility.exchangePath(subject) });
    checkStatus(exchange.status, 200);
    assert.equal(exchange.body.exp - exchange.body.iat, 28800, 'legacy device exchange remains eight hours');
    const jwt = exchange.body.token;
    assert.equal(typeof jwt === 'string' && jwt.length > 0, true, 'actual legacy exchange returns a credential');
    checkStatus((await request({ plane: 'data', tenant, method: 'GET', path: compatibility.dataPath,
      headers: { authorization: 'Bearer ' + jwt } })).status, 200);
    for (const plane of ['data', 'operator']) {
      const reply = await request({ plane, tenant, method: 'GET',
        path: plane === 'data' ? compatibility.dataPath : compatibility.operatorPath,
        headers: { authorization: 'Bearer ' + managementToken } });
      assert.equal([401, 403].includes(reply.status), true, 'management credential cannot cross its plane');
    }
    if (typeof compatibility.anonymousAllows !== 'function') fail('OWNER_BROWSER_NATIVE_ANONYMOUS_AUTHORITY_REQUIRED');
    const restore = await compatibility.setAnonymous(tenant, ['readable'], { widenReadable: true });
    if (typeof restore !== 'function') fail('OWNER_BROWSER_ANONYMOUS_RESTORE_REQUIRED');
    await withRestoration(async () => {
      const clinical = await compatibility.snapshotData(tenant);
      assert.equal(await compatibility.anonymousAllows(tenant, 'api:entries:read'), true, 'actual anonymous authority retains reads');
      assert.equal(await compatibility.anonymousAllows(tenant, 'api:entries:create'), false, 'actual anonymous authority floor refuses writes');
      checkStatus((await request({ plane: 'data', tenant, method: 'GET', path: compatibility.dataPath })).status, 200);
      checkStatus((await request({ plane: 'data', tenant, method: 'POST', path: compatibility.dataPath,
        body: { type: 'sgv', sgv: 123, date: 1794000000000 } })).status, 403);
      assert.deepEqual(await compatibility.snapshotData(tenant), clinical, 'anonymous forbidden write has no native clinical effect');
    }, restore);
    assert.deepEqual(await snapshot(tenant), beforeA, 'compatibility proof has no owner-state side effect');
    assert.deepEqual(await snapshot(foreign), beforeB, 'compatibility proof leaves B unchanged');
    assert.deepEqual(await compatibility.snapshotData(tenant), clinicalA, 'compatibility proof preserves native A clinical rows/counters');
    assert.deepEqual(await compatibility.snapshotData(foreign), clinicalB, 'compatibility proof preserves native B clinical rows/counters');
    states.compatibility = { classification: CLASSIFICATIONS.compatibility,
      ...Object.fromEntries(COMPATIBILITY_FLAGS.map(key => [key, true])) };
    assertCompleted('compatibility', states.compatibility); return states.compatibility;
  }

  return { exerciseHttp, exerciseBrowser, exerciseCompatibility,
    async close () { for (const tab of tabs) { tabs.delete(tab); await tab.close(); } },
    manifest: { acquisition: 'borrowed native PG/Transit/HTTPS and parent-owned browser context',
      poolCount: 0, browserProcesses: 0, borrowedContexts: 1, peakPages: 2,
      dependencies: ['lib/human-session/http.js', 'lib/human-session/engine.js', 'lib/human-session/management.js',
        'lib/server/subject-management-app.js', 'lib/server/tenant-app/owner-settings.js'],
      purePlan: { env: ['HUMAN_SESSION_NATIVE_RESERVED=1', 'HUMAN_HTTPS_RESERVED=1'],
        binding: { persistence: 'postgres', signing: 'configured-transit' }, config: 'two distinct canonical UUID tenants' },
      nativeContext: ['nativeStore.kind/resources.human/subject/inspect', 'parsed.namespaces.authorization/consumer',
        'tenant/origin', 'admin.query', 'snapshot', 'services.subjects/settings/settingsReader', 'access.verify'],
      browserContext: ['HUMAN_BROWSER_RESERVED=1', 'parent browserContext.newPage/cookies/request.get', 'parent page.evaluate/goto'],
      compatibility: ['request', 'credentials', 'dataPath', 'exchangePath', 'operatorPath', 'setAnonymous',
        'snapshotData', 'anonymousAllows', 'defaultOffModes includes multi; single is separate global stage'],
      nativeExecution: 'NOTEXECUTED' } };
}

module.exports = { admit, admitContext, create, assertCompleted, cookieFrom, assertPopulated, withRestoration, cookieOptions, browserRequest,
  HTTP_FLAGS, BROWSER_FLAGS, COMPATIBILITY_FLAGS, CLASSIFICATIONS };
