'use strict';

// vcpool (MT-CONNECTOR-REVERSE): configuration, one connector frame against
// loopback stand-ins for the source site, the tenant API and an egress proxy,
// and the cycle's slice/activity gating. Synthetic data only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const config = require('../lib/tenant-connector/config');
const frame = require('../lib/tenant-connector/frame');
const runtime = require('../lib/tenant-connector/runtime');
const contracts = require('../lib/server/internal-api/contracts');
const { validate } = require('../lib/server/internal-api/schema');

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const env = { VC_SECRETS_PG: 'postgres://vc:synthetic@127.0.0.1:5432/preview', VC_ACTIVITY_PG: 'postgres://vca:synthetic@127.0.0.1:5432/preview',
  VC_VAULT_A: 'synthetic-a', VC_VAULT_B: 'synthetic-b' };
const tenant = (id, i) => ({ id, host: 'ns-' + i + '.localhost',
  vault: { encryptionKey: 't' + i + '-data', signingKey: 't' + i + '-sign', signingVersion: 1, tokenEnv: 'VC_VAULT_' + i.toUpperCase() },
  connector: { collections: ['entries', 'treatments'], sourceEndpoint: 'src-endpoint', sourceCredential: 'src-credential',
    sourceCredentialKind: 'token', writeCredential: 'write-credential' } });
const document = () => ({ version: 1, api: { url: 'http://127.0.0.1:1337/' },
  postgres: { connectionEnv: 'VC_SECRETS_PG', namespaces: { secrets: 'preview_secrets' } },
  vault: { address: 'http://127.0.0.1:8200/', mount: 'transit', allowInsecureLoopback: true },
  activity: { connectionEnv: 'VC_ACTIVITY_PG', namespace: 'preview_lifecycle' },
  sources: { allowHosts: ['127.0.0.1'], allowInsecureHttp: true }, cycleMs: 1000, pollIntervalMs: 1000,
  tenants: [tenant(A, 'a'), tenant(B, 'b')] });
const sha1 = value => crypto.createHash('sha1').update(value).digest('hex');

function server (handler) {
  return new Promise(resolve => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const close = s => new Promise(resolve => s.close(resolve));

describe('vcpool tenant-side connector', function () {
  describe('configuration', function () {
    it('parses tenants, secret references, the allow-list and timing', function () {
      const parsed = config.parse(document(), env);
      assert.deepEqual([...parsed.tenants.keys()], [A, B]);
      assert.equal(parsed.api, 'http://127.0.0.1:1337/');
      assert.deepEqual(parsed.tenants.get(A).binding, { tenant: A, principal: 'vcpool', consumer: 'tenant-connector' });
      assert.deepEqual(parsed.tenants.get(A).connector.collections, ['entries', 'treatments']);
      assert.deepEqual(parsed.egress, { proxy: null });
      assert.equal(parsed.retryMs, config.DEFAULTS.retryMs);
    });
    it('refuses a document without activity, allow-list, distinct references or a known collection', function () {
      const cases = [
        doc => { delete doc.activity; },
        doc => { doc.sources.allowHosts = []; },
        doc => { doc.sources.allowHosts = ['Upper.Example']; },
        doc => { doc.tenants[0].connector.writeCredential = 'src-credential'; },
        doc => { doc.tenants[0].connector.collections = ['food']; },
        doc => { doc.tenants[0].connector.sourceCredentialKind = 'password'; },
        doc => { doc.tenants[1].vault.encryptionKey = 'ta-data'; },
        doc => { doc.api.url = 'http://user:pw@127.0.0.1:1337/'; },
        doc => { doc.activity.connectionEnv = 'VC_SECRETS_PG'; },
        doc => { doc.tenants[0].secret = 'inline'; }
      ];
      for (const change of cases) {
        const doc = document(); change(doc);
        assert.throws(() => config.parse(doc, env), { code: 'CONNECTOR_CONFIG_INVALID' }, change.toString());
      }
    });
    it('reads the member egress proxy from its own environment only', function () {
      assert.deepEqual(config.egress({ MULTITENANT_VCPOOL_EGRESS_PROXY: 'http://proxy.internal:3128' }),
        { proxy: { protocol: 'http', host: 'proxy.internal', port: 3128 } });
      assert.deepEqual(config.egress({ HTTP_PROXY: 'http://other:1' }), { proxy: null });
      for (const bad of ['proxy:3128', 'http://u:p@proxy:3128', 'http://proxy:3128/path', 'socks5://proxy:1080']) {
        assert.throws(() => config.egress({ MULTITENANT_VCPOOL_EGRESS_PROXY: bad }), { code: 'CONNECTOR_CONFIG_INVALID' }, bad);
      }
    });
    it('checks a decrypted source endpoint against the operator allow-list', function () {
      const sources = { allowHosts: ['ns.example.org'], allowInsecureHttp: false };
      assert.equal(config.sourceEndpoint('https://ns.example.org/', sources).hostname, 'ns.example.org');
      for (const bad of ['http://ns.example.org/', 'https://other.example.org/', 'https://u:p@ns.example.org/', 'ftp://ns.example.org/', 'not a url']) {
        assert.throws(() => config.sourceEndpoint(bad, sources), { code: 'CONNECTOR_SOURCE_REFUSED' }, bad);
      }
    });
    it('loads the file, and refuses partition values while the vcpool flag is off', function () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcpool-config-'));
      try {
        const file = path.join(dir, 'vcpool.json');
        fs.writeFileSync(file, JSON.stringify(document()));
        const loaded = config.load({ ...env, MULTITENANT_VCPOOL_CONFIG: file });
        assert.deepEqual(loaded.partition, { kind: 'vcpool', partitioned: false });
        assert.throws(() => config.load({ ...env, MULTITENANT_VCPOOL_CONFIG: file, MULTITENANT_POOL_VCPOOL_ORDINAL: '1' }),
          error => error.code === 'CONNECTOR_CONFIG_INVALID' && /MULTITENANT_POOL_VCPOOL_ORDINAL/.test(error.message));
        // Another kind's variables are not this kind's.
        assert.deepEqual(config.load({ ...env, MULTITENANT_VCPOOL_CONFIG: file, MULTITENANT_POOL_EVALUATOR_ORDINAL: '1' }).partition,
          { kind: 'vcpool', partitioned: false });
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  });

  describe('one frame', function () {
    let source, api, proxy, seen;
    const SOURCE_TOKEN = 'connectsrc-0123456789abcdef', WRITE_TOKEN = 'vcpool-fedcba9876543210';
    beforeEach(async function () {
      seen = { source: [], api: [], proxy: [], refuse: 0 };
      source = await server((req, res) => {
        seen.source.push({ url: req.url, auth: req.headers.authorization || null });
        if (seen.refuse) { seen.refuse -= 1; return json(res, 429, { status: 429 }); }
        if (req.url.startsWith('/api/v2/authorization/request/' + SOURCE_TOKEN)) return json(res, 200, { token: 'synthetic.jwt', iat: 1, exp: 3601 });
        if (req.headers.authorization !== 'Bearer synthetic.jwt') return json(res, 401, { status: 401 });
        if (req.url.startsWith('/api/v1/entries.json')) return json(res, 200, [{ type: 'sgv', sgv: 101, date: 1700000000000, dateString: '2023-11-14T22:13:20.000Z' }]);
        if (req.url.startsWith('/api/v1/treatments.json')) return json(res, 200, [{ eventType: 'Note', notes: 'synthetic', created_at: '2023-11-14T22:13:20.000Z' }]);
        return json(res, 404, {});
      });
      api = await server((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          seen.api.push({ method: req.method, url: req.url, host: req.headers.host, secret: req.headers['api-secret'] || null, body: body ? JSON.parse(body) : null });
          json(res, 200, req.method === 'POST' ? JSON.parse(body) : []);
        });
      });
      proxy = await server((req, res) => {
        // A forward proxy: the request line carries the absolute source URL.
        seen.proxy.push(req.url);
        const target = new URL(req.url);
        const upstream = http.request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search,
          method: req.method, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
        req.pipe(upstream);
      });
    });
    afterEach(async function () { await Promise.all([source, api, proxy].map(close)); });

    function connector (options = {}) {
      const refusals = [];
      const c = frame.create({ tenant: A, api: 'http://127.0.0.1:' + api.address().port + '/', host: 'ns-a.localhost',
        endpoint: new URL('http://127.0.0.1:' + source.address().port + '/'), credential: SOURCE_TOKEN, credentialKind: 'token',
        writeCredential: WRITE_TOKEN, collections: ['entries', 'treatments'], onRefusal: event => refusals.push(event), ...options });
      return { c, refusals };
    }

    it('reads the source with its token and writes through the tenant API as the connector subject', async function () {
      const { c, refusals } = connector();
      const result = await c.run();
      assert.deepEqual(result.counts, { entries: 1, treatments: 1, devicestatus: 0, profiles: 0 });
      assert.deepEqual(refusals, []);
      assert.ok(seen.source.some(row => row.url === '/api/v2/authorization/request/' + SOURCE_TOKEN));
      assert.ok(seen.source.filter(row => row.url.startsWith('/api/v1/')).every(row => row.auth === 'Bearer synthetic.jwt'));
      const posts = seen.api.filter(row => row.method === 'POST');
      assert.deepEqual(posts.map(row => row.url).sort(), ['/api/v1/entries.json', '/api/v1/treatments.json']);
      assert.ok(seen.api.every(row => row.host === 'ns-a.localhost' && row.secret === sha1(WRITE_TOKEN)),
        'every tenant API call names the tenant host and the subject credential hash, never another value');
      assert.equal(posts.find(row => row.url === '/api/v1/entries.json').body[0].sgv, 101);
      assert.deepEqual(seen.proxy, [], 'no proxy configured, no proxied request');
    });
    it('sends every source request, and no tenant API request, through the member egress proxy', async function () {
      const { c } = connector({ proxy: { protocol: 'http', host: '127.0.0.1', port: proxy.address().port } });
      await c.run();
      const port = source.address().port;
      assert.ok(seen.proxy.length >= 3 && seen.proxy.every(url => url.startsWith('http://127.0.0.1:' + port + '/')), JSON.stringify(seen.proxy));
      assert.equal(seen.proxy.length, seen.source.length);
      assert.ok(seen.api.length > 0 && seen.proxy.every(url => !url.includes(':' + api.address().port + '/')));
    });
    it('reports an upstream refusal with its phase and status, and writes nothing', async function () {
      seen.refuse = 10;
      const { c, refusals } = connector();
      await assert.rejects(c.run(), error => error.code === 'CONNECTOR_SOURCE_AUTH_FAILED' && error.status === 429);
      assert.deepEqual(refusals[0], { phase: 'source', status: 429, code: 'ERR_BAD_REQUEST' });
      assert.equal(seen.api.filter(row => row.method === 'POST').length, 0);
    });
  });

  describe('cycle', function () {
    function fixture ({ slice = { eligible: true, includes: () => true }, states = {} } = {}) {
      const parsed = config.parse(document(), env);
      const runs = [], built = [];
      const fake = {
        create: options => {
          built.push(options.tenant);
          return { tenant: options.tenant, run: async () => { runs.push(options.tenant); return { counts: { entries: 2, treatments: 1, devicestatus: 0, profiles: 0 }, alignTo: null }; } };
        }
      };
      const member = { configured: { mode: 'standalone', members: 1, ordinal: 0, rule: null },
        slice: async () => slice, heartbeat: async () => ({ renewed: true }),
        inspect: async () => ({ kind: 'vcpool', configured: { mode: 'standalone', members: 1, ordinal: 0, rule: null }, observed: null }) };
      const policy = require('../lib/tenant-activity/policy');
      const activity = require('../lib/tenant-activity/eligibility').create({ read: async id => states[id] ? { state: states[id] } : null });
      const decrypted = [];
      const decrypt = async (selected, id) => { decrypted.push(selected.id + ':' + id); return Buffer.from(id === 'src-endpoint' ? 'http://127.0.0.1:9/' : 'synthetic-' + id); };
      const r = runtime.create({ config: parsed, member, activity, decrypt, frame: fake, log: () => {} });
      return { r, runs, built, decrypted, policy };
    }
    it('polls an active and a paused tenant and never a suspended one', async function () {
      const { r, runs } = fixture({ states: { [A]: 'paused', [B]: 'suspended' } });
      await r.cycle();
      assert.deepEqual(runs, [A]);
      const view = await r.inspect();
      validate(contracts.connectorInspection.operations.inspectConnectors.response, view);
      assert.deepEqual(view.tenants.map(row => [row.status, row.code]), [['polling', null], ['skipped', 'TENANT_SUSPENDED']]);
      assert.deepEqual(view.tenants[0].pulled, { entries: 2, treatments: 1, devicestatus: 0, profiles: 0 });
    });
    it('works only this member slice and nothing while membership refuses', async function () {
      const sliced = fixture({ slice: { eligible: true, includes: id => id === B }, states: { [A]: 'active', [B]: 'active' } });
      await sliced.r.cycle();
      assert.deepEqual(sliced.runs, [B]);
      assert.equal((await sliced.r.inspect()).tenants[0].status, 'not-in-slice');
      const refused = fixture({ slice: { eligible: false, reason: 'POOL_DUPLICATE_ORDINAL', conflicts: [] }, states: { [A]: 'active', [B]: 'active' } });
      await refused.r.cycle();
      assert.deepEqual(refused.runs, []);
      assert.deepEqual(refused.decrypted, [], 'a refused member decrypts nothing');
      const view = await refused.r.inspect();
      assert.equal(view.member.eligible, false);
      assert.equal(view.member.reason, 'POOL_DUPLICATE_ORDINAL');
    });
    it('refuses an unprovisioned or unreadable activity state as not eligible', async function () {
      const { r, runs } = fixture({ states: { [A]: 'active' } });
      await r.cycle();
      assert.deepEqual(runs, [A]);
      assert.equal((await r.inspect()).tenants[1].code, 'ACTIVITY_NOT_PROVISIONED');
    });
  });
});
