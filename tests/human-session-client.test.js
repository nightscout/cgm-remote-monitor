'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createSecureDOM } = require('./fixtures/secure-jsdom');
const createHuman = require('../lib/client/human-session');
const csrf = 's'.repeat(43);
const next = () => new Promise(resolve => setImmediate(resolve));
const valid = () => ({ status: 200, body: { enabled: true, credentialPresent: true, csrf,
  session: { id: 'synthetic-session', subject: 'local-reader', purpose: 'data' }, permissionGroups: [['api:entries:read']] } });

function headersFor (client) {
  // Compile the actual small header-selection consumer, without starting the
  // chart/socket application or replacing it with a test copy of that policy.
  const source = fs.readFileSync(path.join(__dirname, '../lib/client/index.js'), 'utf8');
  const start = source.indexOf('client.headers = function headers () {');
  const end = source.indexOf('\n};', start) + 3;
  vm.runInNewContext(source.slice(start, end), { client });
  return client.headers();
}

function authentication (client, window, stored) {
  const module = { exports: {} };
  const $ = require('jquery')(window);
  $.ajax = () => { throw new Error('Unexpected legacy authentication AJAX'); };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/client/hashauth.js'), 'utf8'), {
    module, window, document: window.document, TextEncoder, Uint8Array, URL, console,
    require (name) {
      if (name === './storage') return { localStorage: {
        get: key => stored[key] || null, remove: key => { delete stored[key]; }, set: (key, value) => { stored[key] = value; }
      } };
      if (name === '../utils/html') return require('../lib/utils/html');
      throw new Error('Unexpected hashauth dependency');
    }
  }, { filename: 'hashauth.js' });
  const auth = module.exports.init(client, $);
  client.hashauth = auth;
  return { auth, $ };
}

describe('existing browser consumes optional human sessions (hermetic DOM/source)', function () {
  let dom, window, client, requests, navigated, reply, reloads, stored;
  beforeEach(function () {
    dom = createSecureDOM('<!doctype html><div id="authentication_placeholder"></div><div class="needsadminaccess"></div>',
      { url: 'https://nightscout.synthetic.invalid/?token=synthetic-link&secret=synthetic-legacy&units=mgdl' });
    window = dom.window; requests = []; navigated = []; reloads = 0;
    stored = { apisecrethash: 'synthetic-stored-device-hash' };
    reply = async () => valid();
    client = { translate: text => text, browserUtils: { reload () { reloads++; } },
      settings: { theme: 'modern' } };
    client.humanSession = createHuman({ client,
      request: async options => { requests.push(options); return reply(options); }, navigate: value => navigated.push(value) });
  });
  afterEach(function () { dom.cleanup(); });

  it('probes without legacy credentials and preserves default-off legacy selection', async function () {
    const legacy = { token: 'synthetic-device-token' };
    client.authorized = legacy;
    reply = async () => ({ status: 404 });
    await client.humanSession.prepare();
    assert.equal(client.humanSession.state.enabled, false);
    assert.equal(client.humanSession.suppressesLegacy(), false);
    assert.equal(client.authorized, legacy);
    assert.deepEqual(requests, [{ method: 'GET', url: '/api/v2/oidc/session', headers: {} }]);
    assert.equal(headersFor(client).Authorization, 'Bearer synthetic-device-token');
    assert.equal(stored.apisecrethash, 'synthetic-stored-device-hash');
  });

  it('does not infer a human session from enabled/absent or a legacy server 401', async function () {
    reply = async () => ({ status: 401, body: { enabled: true, credentialPresent: false, error: 'HUMAN_SESSION_ABSENT' } });
    await client.humanSession.probe();
    assert.equal(client.humanSession.state.enabled, true);
    assert.equal(client.humanSession.suppressesLegacy(), false);
    reply = async () => ({ status: 401, body: { status: 401, message: 'Unauthorized' } });
    await client.humanSession.probe();
    assert.equal(client.humanSession.state.enabled, false);
    assert.equal(client.humanSession.suppressesLegacy(), false);
  });

  it('consumes only current local grants and keeps existing legacy credentials dormant in headers and sockets', async function () {
    const { auth } = authentication(client, window, stored);
    auth.apisecrethash = stored.apisecrethash;
    await client.humanSession.probe();
    await new Promise(resolve => auth.verifyAuthentication(resolve));
    assert.equal(client.authorized.check('api:entries:read'), true);
    assert.equal(client.authorized.check('*'), false);
    assert.equal(client.authorized.check('admin:api:subjects:read'), false);
    assert.equal(client.authorized.token, undefined);
    assert.equal(auth.isAdmin, false);
    assert.equal(auth.hash(), null);
    assert.deepEqual(Object.keys(headersFor(client)), ['x-ns-csrf']);
    assert.equal(headersFor(client)['x-ns-csrf'], csrf);
    assert.equal(stored.apisecrethash, 'synthetic-stored-device-hash');
    assert.match(auth.inlineCode(), /Signed in with identity provider/);
    assert.match(auth.inlineCode(), /Renew sign-in/);
    assert.match(auth.inlineCode(), /Sign out/);
    assert.equal(window.document.querySelector('.needsadminaccess').style.display, 'none');
  });

  it('keeps expired/revoked cookie dormant instead of falling back to stored root and can request provider-backed renewal', async function () {
    const { auth } = authentication(client, window, stored);
    auth.apisecrethash = stored.apisecrethash;
    reply = async options => options.method === 'GET' ? { status: 401, body: {
      enabled: true, credentialPresent: true, error: 'HUMAN_SESSION_REFUSED', csrf
    } } : { status: 200, body: { location: 'https://identity.synthetic.invalid/authorize?prompt=none' } };
    await client.humanSession.probe();
    assert.equal(client.humanSession.suppressesLegacy(), true);
    assert.equal(client.authorized, undefined);
    assert.equal(auth.hash(), null);
    assert.deepEqual(Object.keys(headersFor(client)), ['x-ns-csrf']);
    await client.humanSession.renew();
    assert.deepEqual(requests[1], { method: 'POST', url: '/api/v2/oidc/renew', headers: { 'x-ns-csrf': csrf }, body: { purpose: 'data', transport: 'cookie' } });
    assert.equal(new URL(navigated[0]).hostname, 'identity.synthetic.invalid');
  });

  it('uses a same-origin JSON start then navigates to the external provider and refuses a script location', async function () {
    reply = async options => options.method === 'GET' ? { status: 401, body: { enabled: true, credentialPresent: false } }
      : { status: 200, body: { location: 'https://identity.synthetic.invalid/authorize' } };
    await client.humanSession.prepare(); await client.humanSession.login();
    assert.deepEqual(requests[1].body, { purpose: 'data', transport: 'cookie' });
    assert.deepEqual(requests[1].headers, {});
    assert.equal(navigated.length, 1);
    reply = async () => ({ status: 200, body: { location: 'javascript:alert(1)' } });
    await assert.rejects(client.humanSession.login(), { code: 'HUMAN_PROVIDER_LOCATION_REFUSED' });
    assert.equal(navigated.length, 1);
  });

  it('forgets this browser legacy material before logout completes, commits local-first and reloads a clean URL only on confirmation', async function () {
    const { auth } = authentication(client, window, stored);
    auth.apisecrethash = stored.apisecrethash;
    await client.humanSession.probe();
    let finish;
    reply = async () => new Promise(resolve => { finish = resolve; });
    auth.removeAuthentication();
    assert.equal(requests.filter(value => value.url === '/api/v2/oidc/logout').length, 1,
      'existing human SignOut must consume durable server logout rather than browser-only forgetting');
    assert.equal(stored.apisecrethash, undefined);
    assert.equal(new URL(window.location.href).searchParams.has('token'), false);
    assert.equal(new URL(window.location.href).searchParams.has('secret'), false);
    assert.equal(new URL(window.location.href).searchParams.get('units'), 'mgdl');
    assert.equal(reloads, 0);
    assert.deepEqual(requests.at(-1), { method: 'POST', url: '/api/v2/oidc/logout', headers: { 'x-ns-csrf': csrf }, body: { purpose: 'data' } });
    finish({ status: 200, body: { local: 'revoked' } }); await next();
    assert.equal(reloads, 1);
    assert.equal(client.authorized, null);
    assert.equal(requests.every(value => ['/api/v2/oidc/session', '/api/v2/oidc/logout'].includes(value.url)), true);
  });

  it('surfaces revocation-unconfirmed without success reload or root fallback during a store outage', async function () {
    const { auth } = authentication(client, window, stored);
    auth.apisecrethash = stored.apisecrethash;
    reply = async options => options.method === 'GET'
      ? { status: 503, body: { enabled: true, credentialPresent: true, csrf, error: 'HUMAN_SESSION_UNAVAILABLE' } }
      : { status: 503, body: { error: 'LOCAL_REVOCATION_UNCONFIRMED' } };
    await client.humanSession.probe();
    auth.removeAuthentication(); await next();
    assert.equal(reloads, 0);
    assert.equal(stored.apisecrethash, undefined);
    assert.equal(client.humanSession.state.uncertain, true);
    assert.equal(client.humanSession.suppressesLegacy(), true);
    assert.equal(headersFor(client).Authorization, undefined);
    assert.equal(headersFor(client)['api-secret'], undefined);
    assert.match(window.document.querySelector('[role=alert]').textContent, /could not confirm session revocation/);
    assert.equal(requests.every(value => ['/api/v2/oidc/session', '/api/v2/oidc/logout'].includes(value.url)), true);
  });

  it('preserves existing browser-only legacy forgetting when no human server session exists', function () {
    const { auth } = authentication(client, window, stored);
    auth.apisecrethash = stored.apisecrethash; auth.authenticated = true;
    auth.removeAuthentication();
    assert.equal(stored.apisecrethash, undefined);
    assert.equal(reloads, 1);
    assert.equal(requests.length, 0);
    assert.equal(new URL(window.location.href).searchParams.get('token'), 'synthetic-link');
  });

  it('does not dispatch a legacy secret login while the browser has an active human credential', async function () {
    const { auth } = authentication(client, window, stored);
    await client.humanSession.probe();
    const notices = [];
    window.alert = text => notices.push(text);
    let outcome;
    await auth.processSecret('synthetic-long-legacy-secret', true, value => { outcome = value; });
    assert.equal(outcome, false);
    assert.match(notices[0], /Sign out of the human session/);
    assert.equal(requests.length, 1);
  });

  it('refuses malformed permission responses without local authority or silent legacy fallback', async function () {
    reply = async () => ({ ...valid(), body: { ...valid().body, permissionGroups: ['*'] } });
    await client.humanSession.probe();
    assert.equal(client.humanSession.state.active, false);
    assert.equal(client.humanSession.state.unavailable, true);
    assert.equal(client.humanSession.suppressesLegacy(), true);
    assert.equal(client.authorized, undefined);
  });

  it('retries a transient discovery failure and clears its warning when default-off legacy service recovers', async function () {
    const { auth } = authentication(client, window, stored);
    reply = async () => ({ status: 503 });
    await client.humanSession.probe();
    assert.equal(client.humanSession.state.unavailable, true);
    assert.match(auth.inlineCode(), /Retry sign-in check/);
    reply = async () => ({ status: 404 });
    auth.retryHumanSession(); await next();
    assert.equal(reloads, 1);
    assert.equal(client.humanSession.state.error, null);
    assert.equal(client.humanSession.message(), '');
    assert.equal(client.humanSession.suppressesLegacy(), false);
    assert.equal(stored.apisecrethash, 'synthetic-stored-device-hash');
    assert.equal(requests.every(value => value.method === 'GET' && value.url === '/api/v2/oidc/session'), true);
  });

  it('never turns a retry after revocation-unconfirmed into a successful sign-out reload', async function () {
    const { auth } = authentication(client, window, stored);
    await client.humanSession.probe();
    reply = async () => ({ status: 503, body: { error: 'LOCAL_REVOCATION_UNCONFIRMED' } });
    auth.removeAuthentication(); await next();
    assert.equal(client.humanSession.state.uncertain, true);
    reply = async () => ({ status: 404 });
    auth.retryHumanSession(); await next();
    assert.equal(reloads, 0);
    assert.equal(client.humanSession.state.error, 'LOCAL_REVOCATION_UNCONFIRMED');
    assert.equal(client.humanSession.suppressesLegacy(), true);
    assert.match(window.document.querySelector('[role=alert]').textContent, /could not confirm session revocation/);
    assert.equal(stored.apisecrethash, undefined);
  });

  it('keeps an expired/refused human credential visible after retry without reloading into legacy authority', async function () {
    const { auth } = authentication(client, window, stored);
    reply = async () => ({ status: 401, body: { enabled: true, credentialPresent: true, csrf, error: 'HUMAN_SESSION_REFUSED' } });
    await client.humanSession.probe();
    auth.retryHumanSession(); await next();
    assert.equal(reloads, 0);
    assert.equal(client.humanSession.suppressesLegacy(), true);
    assert.match(window.document.querySelector('#authorizationstatus').textContent, /Human sign-in requires attention/);
  });

  it('fits the additional human provider/error content while retaining default-off legacy dialog height', async function () {
    const { auth, $ } = authentication(client, window, stored);
    client.settings.theme = 'default';
    let dialog;
    $.fn.dialog = function (options) { dialog = options; return this; };
    auth.requestAuthentication();
    assert.equal(dialog.height, 270);
    await client.humanSession.probe();
    auth.requestAuthentication();
    assert.equal(dialog.height, 'auto');
  });

  it('keeps current-authority refusal distinct from an outage and suppresses legacy credentials without grants', async function () {
    reply = async () => ({ status: 403, body: { enabled: true, credentialPresent: true, csrf, error: 'HUMAN_AUTHORITY_REFUSED' } });
    await client.humanSession.probe();
    assert.equal(client.humanSession.state.active, false);
    assert.equal(client.humanSession.state.unavailable, false);
    assert.equal(client.humanSession.state.credentialPresent, true);
    assert.equal(client.humanSession.state.csrf, csrf);
    assert.equal(client.humanSession.suppressesLegacy(), true);
    assert.equal(client.authorized, undefined);
    assert.equal(client.humanSession.state.error, 'HUMAN_SESSION_REFUSED');
    assert.doesNotMatch(client.humanSession.message(), /service is available/);
  });

  it('calls the configured provider logout only after confirmed local revocation and browser forgetting', async function () {
    const { auth } = authentication(client, window, stored);
    await client.humanSession.probe();
    let finish;
    reply = async () => new Promise(resolve => { finish = resolve; });
    auth.removeAuthentication();
    assert.equal(stored.apisecrethash, undefined);
    assert.equal(navigated.length, 0);
    finish({ status: 200, body: { local: 'revoked', providerLogout: 'https://identity.synthetic.invalid/logout?client_id=nightscout' } });
    await next();
    assert.deepEqual(navigated, ['https://identity.synthetic.invalid/logout?client_id=nightscout']);
    assert.equal(reloads, 0);
    assert.equal(client.humanSession.state.active, false);
    assert.equal(client.humanSession.state.credentialPresent, false);
    assert.equal(client.authorized, null);
  });

  it('never calls provider logout on local-revocation-unconfirmed, even if a failure response carries a URL', async function () {
    const { auth } = authentication(client, window, stored);
    await client.humanSession.probe();
    reply = async () => ({ status: 503, body: { error: 'LOCAL_REVOCATION_UNCONFIRMED', providerLogout: 'https://identity.synthetic.invalid/logout' } });
    auth.removeAuthentication(); await next();
    assert.equal(navigated.length, 0);
    assert.equal(reloads, 0);
    assert.equal(client.humanSession.state.uncertain, true);
  });

  it('keeps local revocation committed when provider navigation fails and surfaces that precise result', async function () {
    const { auth } = authentication(client, window, stored);
    client.humanSession = createHuman({ client,
      request: async options => { requests.push(options); return reply(options); },
      navigate () { throw new Error('Synthetic provider navigation failed'); } });
    await client.humanSession.probe();
    reply = async () => ({ status: 200, body: { local: 'revoked', providerLogout: 'https://identity.synthetic.invalid/logout' } });
    auth.removeAuthentication(); await next();
    assert.equal(client.humanSession.state.active, false);
    assert.equal(client.humanSession.state.credentialPresent, false);
    assert.equal(client.humanSession.state.uncertain, false);
    assert.equal(client.humanSession.state.error, 'HUMAN_PROVIDER_LOGOUT_FAILED');
    assert.equal(reloads, 0);
    assert.equal(client.authorized, null);
    assert.match(window.document.querySelector('[role=alert]').textContent, /session was revoked, but provider sign-out/);
  });

  it('refuses unsafe provider logout URLs and keeps no-server-session sign-out browser-only', async function () {
    const { auth } = authentication(client, window, stored);
    await client.humanSession.probe();
    reply = async () => ({ status: 200, body: { local: 'revoked', providerLogout: 'javascript:alert(1)' } });
    auth.removeAuthentication(); await next();
    assert.equal(navigated.length, 0);
    assert.equal(client.humanSession.state.error, 'HUMAN_PROVIDER_LOGOUT_FAILED');
    assert.equal(client.humanSession.finishLogout({ local: 'absent', providerLogout: 'https://identity.synthetic.invalid/logout' }), false);
    assert.equal(navigated.length, 0);
  });

  it('probes at startup only on a page that advertises OIDC; other pages start unchanged', async function () {
    const source = fs.readFileSync(path.join(__dirname, '../lib/client/index.js'), 'utf8');
    const tree = require('acorn').parse(source, { ecmaVersion: 'latest' });
    const node = tree.body.find(item => item.type === 'ExpressionStatement' && item.expression.type === 'AssignmentExpression' &&
      item.expression.left.object?.name === 'client' && item.expression.left.property?.name === 'init').expression.right;
    function start (advertised) {
      const status = [];
      const page = { headers: () => ({}), hashauth: {}, loadLanguage () {} };
      page.humanSession = createHuman({ client: page, advertised,
        request: async options => { requests.push(options); return { status: 404 }; }, navigate () {} });
      const $ = () => ({ html () {}, show () {} });
      $.ajax = options => { status.push(options.url.split('?')[0]); return { done () { return this; }, fail () { return this; } }; };
      const init = vm.runInNewContext('(' + source.slice(node.start, node.end) + ')', { $, client: page,
        require: () => () => ({ queryParms: () => ({}) }), Storages: { localStorage: { get: () => null } },
        window: { setTimeout () {} }, console: { log () {} } });
      page.init = init; init(() => {});
      return status;
    }
    assert.deepEqual(start(false), ['/api/v1/status.json'], 'unadvertised page requests status synchronously');
    assert.deepEqual(requests, []);
    const advertised = start(true);
    assert.deepEqual(advertised, [], 'advertised page discovers the session first');
    await next();
    assert.deepEqual(requests.map(request => request.url), ['/api/v2/oidc/session']);
    assert.deepEqual(advertised, ['/api/v1/status.json']);
  });

  it('renders the OIDC page hint only for a server that mounted human sessions', function () {
    const file = path.join(__dirname, '../views/partials/page-scripts.ejs');
    const render = locals => require('ejs').render(fs.readFileSync(file, 'utf8'), { locals, pageEntry: 'app', startupScripts: [] }, { filename: file });
    assert.match(render({ bundle: '/bundle', humanSessions: true }), /<meta name="nightscout-human-sessions" content="enabled">/);
    assert.doesNotMatch(render({ bundle: '/bundle', humanSessions: false }), /nightscout-human-sessions/);
    assert.doesNotMatch(render({ bundle: '/bundle' }), /nightscout-human-sessions/);
  });
});
