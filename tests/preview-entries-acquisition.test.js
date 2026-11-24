'use strict';

// Actual preview composition + shipping HTTP handlers over recording SQL.
// Native storage/restore coverage is separate; these assertions count acquisition.
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const express = require('express'), request = require('supertest'), shiro = require('shiro-trie');
const scope = require('../lib/storage/tenant-scope');
const authentication = require('../lib/api3/tenant-authentication');
const environment = require('../lib/server/tenant-app/environment');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const domains = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'];

function implementation (mutate = s => s, constructed = [], contexts = [], completed = []) {
  const file = require.resolve('../lib/server/serve/preview-domains');
  const original = fs.readFileSync(file, 'utf8'), source = mutate(original), output = { exports: {} };
  const local = createRequire(file);
  const imports = name => {
    if (name === '../tenant-app/legacy-domains') return options => {
      constructed.push(options.domains);
      const graph = local(name)(options); contexts.push(graph.context);
      return graph;
    };
    if (name === '../tenant-app/shared-legacy-routes') return options => {
      const routes = local(name)(options);
      return { ...routes, dispatch (operation, req, res, next) {
        // Capture the actual request context at the shared HTTP composition
        // boundary. Warm storage wrappers no longer dispatch HTTP routes.
        res.once('finish', () => completed.push({ tag: req.header('x-control-case'), context: operation.ctx,
          ddata: operation.ctx.ddata, cache: operation.ctx.cache, bus: operation.ctx.bus }));
        return routes.dispatch(operation, req, res, next);
      } };
    };
    return local(name);
  };
  vm.runInThisContext('(function(require,module,exports){' + source + '\n})', { filename: file })(imports, output, output.exports);
  return output.exports;
}
async function fixture (mutate, populated = false, interleaved = false) {
  const sql = [], graphs = [], contexts = [], completed = [];
  const instant = Math.floor(Date.now() / 1000) * 1000 - 1000;
  let sequence = 0, entered; const firstEntered = new Promise(resolve => { entered = resolve; });
  const waiting = [];
  let capturing = false;
  let denied = false, badStorage = false, authentications = 0;
  const connection = {
    withTenant: (tenant, fn) => scope.withTenant(tenant, fn), transaction: fn => fn(), withSavepoint: fn => fn(),
    async query (text) {
      if (text.includes("current_setting('server_version')")) return { rows: [{ version: 'recording-SQL' }] };
      sql.push({ tenant: scope.currentTenant(), text });
      if (badStorage) throw new Error('synthetic storage unavailable');
      if (populated && capturing && /SELECT id_kind, doc/.test(text) && text.includes('source_entries')) {
        const tenant = scope.currentTenant(), index = sequence++;
        if (interleaved) await new Promise(resolve => {
          waiting.push(resolve); entered();
          if (waiting.length === 2) { waiting[1](); setImmediate(waiting[0]); }
        });
        else await new Promise(resolve => setImmediate(resolve));
        return { rows: Array.from({ length: interleaved ? index + 1 : 1 }, (_, j) => ({ id_kind: 'string', doc: {
          _id: 'reading-' + index + '-' + j, type: 'sgv',
          sgv: interleaved ? 100 + index * 10 + j : tenant === A ? 123 : 234,
          date: instant - index * 1000 - j * 1000, device: tenant
        } })) };
      }
      // The maintained statistics port returns one aggregate per configured
      // source in a single statement, rather than one statement per source.
      if (text.includes('pg_column_size')) return { rows: [...text.matchAll(/FROM "([a-z_]+)"\."([a-z_]+)"/g)].map(() => ({ bytes: 0 })) };
      return { rows: /SELECT count/.test(text) ? [{ n: '0' }] : [] };
    }
  };
  const graph = await implementation(mutate, graphs, contexts, completed)({ config: { domains, legacyEnabled: true, contextEnabled: true,
    bindings: new Map([[A, {}], [B, {}]]), environments: new Map([A, B].map(t => [t, environment()])),
    namespaces: Object.fromEntries(domains.map(d => [d, 'source_' + d])) }, connection, exchange: async () => null });
  // Measure hot requests after explicitly constructing the two selected wrappers.
  // Cold service construction is measured by the LRU suite.
  for (const tenant of [A, B]) (await graph.prepareTenant(tenant)).legacy();
  sql.length = 0; graphs.length = 0; capturing = true;
  const app = express();
  app.use((req, res, next) => scope.withTenant(req.header('x-test-tenant') || A, () => {
    req.tenantAuthenticate = async () => {
      authentications++;
      req.tenantContext = { tenant: scope.currentTenant() };
      if (denied) throw Object.assign(new Error('synthetic current authority refused'), { code: 'TEST_AUTH_REFUSED' });
      const permissions = shiro.new();
      if (!denied) permissions.add('api:*:read');
      permissions.add('api:entries:create');
      authentication.bind(req, { shiros: [permissions] });
    }; next();
  }));
  for (const v of [1, 2]) app.use('/api/v' + v, graph.legacyRouter);
  app.use((error, req, res, next) => { void next; if (res.headersSent) return; res.status(error.code === 'TEST_AUTH_REFUSED' ? 401 : 503).json({ error: error.code || 'TEST_STORAGE_REFUSED' }); });
  return { app, sql, graphs, contexts, completed, instant, firstEntered, denied: v => { denied = v; }, badStorage: v => { badStorage = v; },
    authentications: () => authentications };
}
function reads (rows) { return rows.filter(r => /source_/.test(r.text)); }
function rawCriterion (f) {
  assert(reads(f.sql).every(r => /source_entries/.test(r.text) && !/pg_column_size/.test(r.text)), 'RAW_ENTRIES_NO_UNRELATED_ACQUISITION');
  assert.deepEqual(f.graphs, [], 'RAW_REUSES_IMMUTABLE_GRAPH');
}
function derivedCriterion (f) {
  assert(reads(f.sql).some(r => /source_treatments/.test(r.text)), 'DERIVED_REQUIRES_FULL_FRAME');
  assert(reads(f.sql).some(r => /pg_column_size/.test(r.text)), 'DERIVED_REQUIRES_STATS');
}
const quiet = async fn => {
  const log = console.log, info = console.info; console.log = console.info = () => {};
  try { return await fn(); } finally { console.log = log; console.info = info; }
};
describe('ordinary entries acquire only the state their shipping handler consumes', function () {
  let old;
  before(() => { old = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  after(() => scope.setTenancyMode(old));
  it('uses one entries window for v1/v2 model and list reads, with no unrelated clinical/statistics SQL or wrappers', async function () {
    await quiet(async () => {
      const f = await fixture();
      for (const v of [1, 2]) for (const path of ['/entries/sgv.json?count=1', '/entries.json']) {
        f.sql.length = 0; f.graphs.length = 0;
        await request(f.app).get('/api/v' + v + path).set('Accept', 'application/json').expect(200, []);
        assert(reads(f.sql).length > 0, 'actual storage read observed');
        assert(reads(f.sql).every(r => r.tenant === A && /source_entries/.test(r.text) && !/pg_column_size/.test(r.text)), 'RAW_ENTRIES_NO_UNRELATED_ACQUISITION');
        rawCriterion(f);
      }
      assert.equal(f.authentications(), 4, 'fresh authentication on every request');
    });
  });
  it('current and addressed reads skip pre-acquisition; preview write never queries storage', async function () {
    await quiet(async () => {
      const f = await fixture();
      for (const path of ['/entries/current', '/entries/000000000000000000000101']) {
        f.sql.length = 0;
        await request(f.app).get('/api/v1' + path).set('Accept', 'application/json').expect(200, []);
        assert.equal(reads(f.sql).length, 1, 'RAW_ENTRIES_SINGLE_DIRECT_READ');
      }
      f.sql.length = 0;
      await request(f.app).post('/api/v1/entries/preview').send([{ type: 'sgv', sgv: 123, date: Date.now() }]).expect(200);
      assert.equal(f.sql.length, 0, 'RAW_ENTRIES_PREVIEW_NO_ACQUISITION');
    });
  });
  it('refuses revoked reads before storage and preserves tenant scope and storage refusal', async function () {
    await quiet(async () => {
      const f = await fixture();
      f.denied(true);
      await request(f.app).get('/api/v1/entries/sgv').expect(401);
      assert.equal(f.sql.length, 0, 'denied authority reaches no storage');
      f.denied(false);
      await request(f.app).get('/api/v1/entries/sgv').set('x-test-tenant', B).expect(200);
      assert(reads(f.sql).every(r => r.tenant === B));
      f.badStorage(true);
      await request(f.app).get('/api/v1/entries/sgv').expect(503);
    });
  });
  it('applies the same removal to other raw domains, aliases and metadata', async function () {
    await quiet(async () => {
      const f = await fixture();
      for (const domain of ['treatments', 'devicestatus', 'profile', 'food', 'activity']) {
        f.sql.length = 0; f.graphs.length = 0;
        await request(f.app).get('/api/v2/' + domain + '.json').set('Accept', 'application/json').expect(200);
        assert(reads(f.sql).every(r => r.text.includes('source_' + domain) && !/pg_column_size/.test(r.text)), 'RAW_ONLY_SELECTED_DOMAIN ' + domain);
        assert.deepEqual(f.graphs, [], 'reuse immutable raw graph ' + domain);
      }
      const old = await fixture(s => s.replace('const rawDomains = logical && legacyNames.includes(logical) ? [logical]', 'const rawDomains = false ? [logical]').replace(": alias ? [...new Set(['entries', ...(legacyNames.includes(alias[2]) ? [alias[2]] : [])])] : null;", ': null;'));
      for (const path of ['/echo/entries/sgv?find[date][$gte]=1700000000000', '/count/entries/where', '/slice/entries/dateString/sgv/2026', '/times/2026']) {
        f.sql.length = 0;
        const reply = await request(f.app).get('/api/v1' + path).set('Accept', 'application/json');
        const expected = await request(old.app).get('/api/v1' + path).set('Accept', 'application/json');
        assert.equal(reply.status, expected.status, path);
        assert.deepEqual(reply.body, expected.body, path);
        if (reply.status !== 200) console.error('REST_INHERITED_ALIAS_REFUSAL ' + path + ' ' + reply.status);
        assert(reads(f.sql).every(r => /source_entries/.test(r.text) && !/pg_column_size/.test(r.text)), 'RAW_ALIAS_NO_UNRELATED_READ');
      }
      f.sql.length = 0;
      await request(f.app).get('/api/v1/status.json').set('Accept', 'application/json').expect(200);
      assert.equal(f.sql.length, 0, 'metadata performs no clinical read');
      assert.deepEqual(f.graphs, [], 'metadata constructs no clinical graph');
    });
  });
  it('serves filtered treatment/device reads without prefetch or a mutable empty cache', async function () {
    await quiet(async () => {
      const f = await fixture();
      for (const domain of ['treatments', 'devicestatus']) {
        f.sql.length = 0;
        await request(f.app).get('/api/v1/' + domain + '?token=synthetic&find[created_at][$gte]=2020-01-01T00:00:00Z')
          .set('Accept', 'application/json').expect(200);
        assert.equal(reads(f.sql).length, 1, 'RAW_FILTERED_ONE_STORAGE_READ ' + domain);
        assert(reads(f.sql).every(r => r.text.includes('source_' + domain) && !/pg_column_size/.test(r.text)));
      }
    });
  });
  it('keeps the untyped filtered entries header without building an unused response cache', async function () {
    const f = await fixture(undefined, true);
    const modified = new Date(f.instant).toUTCString();
    const response = await request(f.app).get('/api/v1/entries?find[device]=synthetic')
      .set('If-Modified-Since', modified).expect(304);
    assert.equal(response.headers['last-modified'], modified);
    assert.equal(reads(f.sql).length, 1, 'conditional response stops before the filtered list');
    assert.deepEqual(f.completed[0].cache.entries, []);
  });
  it('keeps mutable frame/cache state private while reusing routes across concurrent tenant requests', async function () {
    await quiet(async () => {
      const f = await fixture(undefined, true);
      const tenants = [A, B, B, A];
      const responses = await Promise.all(tenants.map(t => request(f.app).get('/api/v1/entries/sgv.json?count=1').set('x-test-tenant', t).set('Accept', 'application/json').expect(200)));
      assert.deepEqual(responses.map(r => r.body[0].sgv), [123, 234, 234, 123]);
      const privateCriterion = target => {
        assert(target.contexts.every(c => c.cache.entries.length === 0), 'RAW_REQUEST_FRAME_MUST_NOT_ESCAPE');
        for (let i = 0; i < target.completed.length; i++) for (let j = 0; j < i; j++) {
          for (const field of ['ddata', 'cache', 'bus']) assert.notEqual(
            target.completed[i].context[field], target.completed[j].context[field], 'RAW_REQUEST_FRAME_MUST_NOT_ESCAPE ' + field);
        }
      };
      assert.equal(f.completed.length, tenants.length, 'all shared dispatch completions observed');
      privateCriterion(f);
      const broken = await fixture(s => {
        const original = 'const ctx = { storagePorts: service.storagePorts, purifier: purifier({}, {}) };';
        const changed = s.replace(original,
          'const ctx = service.presentationState.rawRequestContext || (service.presentationState.rawRequestContext = { storagePorts: service.storagePorts, purifier: purifier({}, {}) });');
        assert.notEqual(changed, s, 'request-state isolation mutation landed'); return changed;
      }, true);
      for (let i = 0; i < 2; i++) await request(broken.app).get('/api/v1/entries/sgv.json?count=1').set('Accept', 'application/json').expect(200);
      assert.equal(broken.completed.length, 2, 'broken requests exercised shared dispatch');
      assert.equal(broken.completed[0].context.cache, broken.completed[1].context.cache, 'SHARED_REQUEST_CACHE_FAULT_EXERCISED');
      assert.throws(() => privateCriterion(broken), /RAW_REQUEST_FRAME_MUST_NOT_ESCAPE/);
    });
  });
  it('separates simultaneous same-tenant count/format requests when frame reads complete in reverse order', async function () {
    await quiet(async () => {
      const f = await fixture(undefined, true, true);
      const first = request(f.app).get('/api/v1/entries/sgv.json?count=1').set('x-control-case', 'json-one').then(r => r);
      await f.firstEntered;
      const second = request(f.app).get('/api/v1/entries/sgv.csv?count=2').set('x-control-case', 'csv-two').then(r => r);
      const [json, csv] = await Promise.all([first, second]);
      assert.equal(json.status, 200); assert.equal(csv.status, 200);
      assert.deepEqual(json.body.map(r => r.sgv), [100]);
      assert.match(csv.text, /\b110\b/); assert.match(csv.text, /\b111\b/); assert.doesNotMatch(csv.text, /\b100\b/);
      assert.equal(json.headers['last-modified'], new Date(f.instant).toUTCString());
      assert.equal(csv.headers['last-modified'], new Date(f.instant - 1000).toUTCString());
      assert.match(json.headers['content-type'], /json/); assert.match(csv.headers['content-type'], /csv/);
      assert.equal(f.completed[0].tag, 'csv-two', 'read completion was deliberately reversed');
      const byTag = Object.fromEntries(f.completed.map(row => [row.tag, row]));
      for (const field of ['ddata', 'cache', 'bus']) assert.notEqual(byTag['json-one'][field], byTag['csv-two'][field], 'private request ' + field);
      assert.deepEqual(byTag['json-one'].ddata.sgvs.map(r => r.mgdl), [100]);
      assert.deepEqual(byTag['csv-two'].cache.entries.map(r => r.sgv), [110, 111]);
      assert(f.contexts.every(c => c.cache.entries.length === 0), 'neither request frame reaches warm graph');
    });
  });
  it('control: restoring old full acquisition and graphs violates the raw route criteria', async function () {
    await quiet(async () => {
      let applied = false;
      const f = await fixture(s => {
        const changed = s.replace('const rawDomains = logical && legacyNames.includes(logical) ? [logical]', 'const rawDomains = false ? [logical]').replace(": alias ? [...new Set(['entries', ...(legacyNames.includes(alias[2]) ? [alias[2]] : [])])] : null;", ': null;');
        applied = changed !== s; return changed;
      });
      assert(applied, 'old acquisition mutation landed');
      await request(f.app).get('/api/v1/entries/sgv?count=1').expect(200);
      assert(reads(f.sql).some(r => /source_treatments|pg_column_size/.test(r.text)), 'old full acquisition is actually observed');
      assert.throws(() => rawCriterion(f), /RAW_ENTRIES_NO_UNRELATED_ACQUISITION/);
      console.error('REST_ACQUISITION_CONTROL ' + JSON.stringify({ oldSqlStatements: reads(f.sql).length, oldGraphDomains: f.graphs[0] }));
    });
  });
  it('control: derived reads still acquire unrelated domains and fail if those reads fail', async function () {
    await quiet(async () => {
      const f = await fixture();
      await request(f.app).get('/api/v2/properties').expect(200);
      derivedCriterion(f);
      const broken = await fixture(s => {
        const changed = s.replace('if (!metadata && (!rawDomains || rawCache))', 'if (!metadata && rawDomains && rawCache)');
        assert.notEqual(changed, s, 'derived-frame bypass mutation landed'); return changed;
      });
      await request(broken.app).get('/api/v2/properties').expect(200);
      assert.throws(() => derivedCriterion(broken), /DERIVED_REQUIRES_FULL_FRAME/);
      f.badStorage(true);
      await request(f.app).get('/api/v2/properties').expect(503);
    });
  });
});
