'use strict';

const assert = require('assert');
const http = require('http');
const {once} = require('events');
const {createRequire} = require('module');
const zlib = require('zlib');
const rootAxios = require('axios');
const legacyRequire = createRequire(require.resolve('minimed-connect-to-nightscout/package.json'));
const connectRequire = createRequire(require.resolve('nightscout-connect/package.json'));
const modernAxios = connectRequire('axios');

// Capture the real boot stage without starting storage, timers or remote bridges.
function importSettings(env, ctx) {
  const boot = require('../lib/server/bootevent');
  const id = require.resolve('bootevent');
  require(id);
  const original = require.cache[id].exports;
  const stages = [];
  const chain = {acquire(stage) { stages.push(stage); return chain; }};
  try {
    require.cache[id].exports = () => chain;
    boot(env, {});
  } finally {
    require.cache[id].exports = original;
  }
  const stage = stages.find(fn => fn.name === 'augmentSettings');
  assert.ok(stage);
  return new Promise(resolve => stage(ctx, resolve));
}

describe('Axios consumer compatibility', function () {
  this.timeout(5000);
  let server, baseURL, requests;
  beforeEach(async function () {
    requests = [];
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', data => chunks.push(data));
      req.on('end', () => {
        const target = new URL(req.url, 'http://localhost');
        const body = Buffer.concat(chunks).toString();
        requests.push({target, body, headers: req.headers});
        res.setHeader('Content-Type', 'application/json');
        if (target.pathname === '/redirect' || target.pathname === '/login') {
          res.writeHead(302, {Location: '/echo', 'Set-Cookie': 'session=fixture; Path=/; HttpOnly'});
          return res.end('{}');
        }
        if (target.pathname === '/error') { res.statusCode = 401; return res.end('{"error":"denied"}'); }
        if (target.pathname === '/slow') return;
        if (target.pathname === '/config') return res.end(JSON.stringify({settings: {units: 'mmol', nested: {added: true}}, extendedSettings: {custom: {enabled: true}}}));
        if (target.pathname === '/flat-config') return res.end('{"units":"mg/dl"}');
        if (target.pathname.startsWith('/api/v2/authorization/request/')) return res.end('{"token":"fixture-bearer","iat":100,"exp":200}');
        if (target.pathname === '/api/v1/entries.json') return res.end('[{"sgv":123,"date":1700000000000}]');
        const reply = JSON.stringify({body, headers: req.headers, query: Object.fromEntries(target.searchParams)});
        if (target.pathname === '/gzip') { res.setHeader('Content-Encoding', 'gzip'); return res.end(zlib.gzipSync(reply)); }
        res.end(reply);
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseURL = 'http://127.0.0.1:' + server.address().port;
  });
  afterEach(async function () {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  [['legacy', rootAxios], ['connect', modernAxios]].forEach(([label, axios]) => {
    it(label + ' preserves instance headers, nested queries and Unicode JSON', async function () {
      const client = axios.create({baseURL, proxy: false, headers: {Accept: 'application/json'}});
      client.interceptors.request.use(config => { config.headers['X-Fixture'] = 'interceptor'; return config; });
      const payload = {notes: 'Café 💉', sgv: 123};
      const response = await client.post('/echo', payload, {headers: {'API-SECRET': 'fixture-hash'}, params: {find: {date: {$gt: '2026-01-01'}}, count: 2}});
      assert.deepStrictEqual(JSON.parse(response.data.body), payload);
      assert.strictEqual(response.data.headers['api-secret'], 'fixture-hash');
      assert.strictEqual(response.data.headers['x-fixture'], 'interceptor');
      assert.strictEqual(response.data.headers.accept, 'application/json');
      ['common', 'get', 'post'].forEach(key => assert.strictEqual(response.data.headers[key], undefined));
      assert.strictEqual(response.data.query['find[date][$gt]'], '2026-01-01');
      assert.strictEqual(response.data.query.count, '2');
    });
    it(label + ' uploads multipart fields and a Unicode file with a valid boundary', async function () {
      const FormData = require('form-data');
      const form = new FormData();
      form.append('note', 'fixture-note');
      form.append('file', Buffer.from('Café 💉'), {filename: 'fixture.txt', contentType: 'text/plain'});
      const response = await axios.post(baseURL + '/echo', form, {proxy: false, headers: form.getHeaders()});
      const contentType = response.data.headers['content-type'];
      const boundary = contentType.split('boundary=')[1];
      assert.ok(boundary);
      assert.ok(response.data.body.includes('name="note"'));
      assert.ok(response.data.body.includes('fixture-note'));
      assert.ok(response.data.body.includes('filename="fixture.txt"'));
      assert.ok(response.data.body.includes('Café 💉'));
      assert.ok(response.data.body.endsWith('--' + boundary + '--\r\n'));
    });
    it(label + ' honors explicit HTTP proxy routing and proxy authentication', async function () {
      const response = await axios.get('http://upstream.invalid/echo', {
        proxy: {protocol: 'http:', host: '127.0.0.1', port: server.address().port,
          auth: {username: 'fixture-proxy', password: 'fixture-password'}}
      });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(requests[0].target.host, 'upstream.invalid');
      assert.strictEqual(requests[0].headers['proxy-authorization'], 'Basic ' + Buffer.from('fixture-proxy:fixture-password').toString('base64'));
    });
    it(label + ' follows redirects and decompresses JSON responses', async function () {
      const response = await axios.get(baseURL + '/redirect', {proxy: false});
      assert.strictEqual(response.status, 200);
      assert.strictEqual(requests[1].target.pathname, '/echo');
      const compressed = await axios.get(baseURL + '/gzip', {proxy: false, params: {note: 'Café 💉'}});
      assert.strictEqual(compressed.data.query.note, 'Café 💉');
    });
    it(label + ' preserves structured HTTP failures and custom status acceptance', async function () {
      await assert.rejects(axios.get(baseURL + '/error', {proxy: false}), error => {
        assert.ok(axios.isAxiosError(error));
        assert.strictEqual(error.response.status, 401);
        assert.deepStrictEqual(error.response.data, {error: 'denied'});
        return true;
      });
      const accepted = await axios.get(baseURL + '/error', {proxy: false, validateStatus: status => status === 401});
      assert.strictEqual(accepted.status, 401);
    });
    it(label + ' times out without blocking a later request', async function () {
      await assert.rejects(axios.get(baseURL + '/slow', {proxy: false, timeout: 30}), error => error.code === 'ECONNABORTED');
      assert.strictEqual((await axios.get(baseURL + '/echo', {proxy: false})).status, 200);
    });
    it(label + ' redacts errors with its supported redaction policy', async function () {
      await assert.rejects(axios.get(baseURL + '/error', {proxy: false, ...(label === 'connect' ? {redact: ['password', 'authorization']} : {}), auth: {username: 'fixture-user', password: 'fixture-password'}, headers: {Authorization: 'Bearer fixture-token'}}), error => {
        const serialized = JSON.stringify(error.toJSON());
        assert.ok(!serialized.includes('fixture-password'));
        assert.ok(!serialized.includes('fixture-token'));
        assert.strictEqual(error.response.status, 401);
        return true;
      });
    });
    it(label + ' ignores inherited basic-auth credentials but accepts own credentials', async function () {
      const inherited = Object.assign(Object.create({auth: {username: 'inherited-user', password: 'inherited-password'}}), {proxy: false});
      const ignored = await axios.get(baseURL + '/echo', inherited);
      assert.strictEqual(ignored.data.headers.authorization, undefined);
      const own = await axios.get(baseURL + '/echo', {proxy: false, auth: {username: 'fixture', password: 'secret'}});
      assert.strictEqual(own.data.headers.authorization, 'Basic ' + Buffer.from('fixture:secret').toString('base64'));
    });
  });

  it('legacy ignores inherited fields inside Basic auth', async function () {
    const auth = Object.create({username: 'inherited-user', password: 'inherited-password'});
    const response = await rootAxios.get(baseURL + '/echo', {proxy: false, auth});
    assert.strictEqual(response.data.headers.authorization, 'Basic ' + Buffer.from(':').toString('base64'));
  });

  it('connect removes ejected interceptors without dropping active or newly registered handlers', async function () {
    const client = modernAxios.create({baseURL, proxy: false});
    const calls = [];
    const active = client.interceptors.request.use(config => { calls.push('active'); return config; });
    for (let cycle = 0; cycle < 2; cycle++) {
      const removed = client.interceptors.request.use(config => { calls.push('removed'); return config; });
      client.interceptors.request.eject(removed);
      assert.strictEqual(client.interceptors.request.handlers.length, 1);
      await client.get('/echo');
    }
    client.interceptors.request.eject(active);
    assert.strictEqual(client.interceptors.request.handlers.length, 0);
    client.interceptors.request.use(config => { calls.push('new'); return config; });
    await client.get('/echo');
    assert.deepStrictEqual(calls, ['active', 'active', 'new']);
  });

  it('keeps null-prototype legacy headers compatible with request interceptors', async function () {
    const client = rootAxios.create({proxy: false});
    client.interceptors.request.use(config => {
      assert.strictEqual(Object.getPrototypeOf(config.headers), null);
      config.headers['X-Fixture'] = 'safe';
      return config;
    });
    assert.strictEqual((await client.get(baseURL + '/echo')).data.headers['x-fixture'], 'safe');
  });

  [['MiniMed legacy', legacyRequire], ['nightscout-connect', connectRequire]].forEach(([label, consumerRequire]) => {
    it(label + ' preserves its actual cookie wrapper across login and repeated reads', async function () {
      const axios = consumerRequire('axios');
      const support = consumerRequire('axios-cookiejar-support');
      const {CookieJar} = consumerRequire('tough-cookie');
      const jar = new CookieJar();
      const client = axios.create({baseURL, proxy: false, jar, withCredentials: true});
      if (support.wrapper) support.wrapper(client); else support.default(client);
      const login = await client.get('/login');
      assert.strictEqual(login.data.headers.cookie, 'session=fixture');
      for (let cycle = 0; cycle < 2; cycle++) {
        assert.strictEqual((await client.get('/echo')).data.headers.cookie, 'session=fixture');
      }
      assert.strictEqual(jar.getCookieStringSync(baseURL), 'session=fixture');
    });
  });

  it('preserves MiniMed manual redirects, form posts and response interceptors', async function () {
    const axios = legacyRequire('axios');
    const client = axios.create({baseURL, proxy: false, maxRedirects: 0, withCredentials: true});
    legacyRequire('axios-cookiejar-support').default(client);
    client.defaults.jar = new (legacyRequire('tough-cookie').CookieJar)();
    client.interceptors.response.use(response => response, error => {
      if (error.response && error.response.status >= 200 && error.response.status < 400) return error.response;
      return Promise.reject(error);
    });
    const login = await client.post('/login', 'username=fixture&password=fixture', {headers: {'Content-Type': 'application/x-www-form-urlencoded'}});
    assert.strictEqual(login.status, 302);
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].body, 'username=fixture&password=fixture');
    const response = await client.get(login.headers.location);
    assert.strictEqual(response.data.headers.cookie, 'session=fixture');
    await assert.rejects(client.get('/error'), error => error.response.status === 401);
  });

  it('imports wrapped settings through the actual boot stage and preserves existing nested settings', async function () {
    const env = {IMPORT_CONFIG: baseURL + '/config', settings: {nested: {retained: true}}, extendedSettings: {}};
    const ctx = {bootErrors: []};
    await importSettings(env, ctx);
    assert.deepStrictEqual(env.settings, {units: 'mmol', nested: {retained: true, added: true}});
    assert.deepStrictEqual(env.extendedSettings, {custom: {enabled: true}});
    assert.strictEqual(requests[0].headers.accept, 'application/json');
    assert.deepStrictEqual(ctx.bootErrors, []);
  });
  it('imports flat settings through the actual boot stage', async function () {
    const env = {IMPORT_CONFIG: baseURL + '/flat-config', settings: {theme: 'colors'}, extendedSettings: {}};
    await importSettings(env, {bootErrors: []});
    assert.deepStrictEqual(env.settings, {theme: 'colors', units: 'mg/dl'});
  });
  it('records a failed settings import and continues without overwriting settings', async function () {
    const env = {IMPORT_CONFIG: baseURL + '/error', settings: {units: 'mmol'}, extendedSettings: {}};
    const ctx = {bootErrors: []};
    await importSettings(env, ctx);
    assert.deepStrictEqual(env.settings, {units: 'mmol'});
    assert.strictEqual(ctx.bootErrors.length, 1);
    assert.strictEqual(ctx.bootErrors[0].err.response.status, 401);
  });
  it('runs the real nightscout-connect token exchange and repeated glucose reads', async function () {
    const source = connectRequire('./lib/sources/nightscout')({url: baseURL + '?token=fixture-access', apiSecret: 'fixture-secret', sourceCollections: ['entries'], sourceMaxCount: 2}, modernAxios);
    const token = await source.authFromCredentials();
    const session = await source.sessionFromAuth(token);
    assert.strictEqual(session.bearer, 'fixture-bearer');
    for (let cycle = 0; cycle < 2; cycle++) {
      const data = await source.dataFromSesssion(session, {entries: new Date('2026-01-01')});
      assert.deepStrictEqual(data.entries, [{sgv: 123, date: 1700000000000}]);
      const request = requests[requests.length - 1];
      assert.strictEqual(request.headers.authorization, 'Bearer fixture-bearer');
      assert.strictEqual(request.target.searchParams.get('find[dateString][$gt]'), '2026-01-01T00:00:00.000Z');
      assert.strictEqual(request.target.searchParams.get('count'), '2');
    }
  });
});
