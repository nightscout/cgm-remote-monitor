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

function implementation (mutate = s => s, constructed = []) {
  const file = require.resolve('../lib/server/serve/preview-domains');
  const original = fs.readFileSync(file, 'utf8'), source = mutate(original), output = { exports: {} };
  const local = createRequire(file);
  const imports = name => name === '../tenant-app/legacy-domains' ? options => {
    constructed.push(options.domains); return local(name)(options);
  } : local(name);
  vm.runInThisContext('(function(require,module,exports){' + source + '\n})', { filename: file })(imports, output, output.exports);
  return output.exports;
}
async function fixture (mutate) {
  const sql = [], graphs = [];
  let denied = false, badStorage = false, authentications = 0;
  const connection = {
    withTenant: (tenant, fn) => scope.withTenant(tenant, fn), transaction: fn => fn(), withSavepoint: fn => fn(),
    async query (text) {
      if (text.includes("current_setting('server_version')")) return { rows: [{ version: 'recording-SQL' }] };
      sql.push({ tenant: scope.currentTenant(), text });
      if (badStorage) throw new Error('synthetic storage unavailable');
      return { rows: text.includes('pg_column_size') ? [{ bytes: 0 }] : [] };
    }
  };
  const graph = await implementation(mutate, graphs)({ config: { domains, legacyEnabled: true, contextEnabled: true,
    bindings: new Map([[A, {}], [B, {}]]), environments: new Map([A, B].map(t => [t, environment()])),
    namespaces: Object.fromEntries(domains.map(d => [d, 'source_' + d])) }, connection, exchange: async () => null });
  sql.length = 0; graphs.length = 0;
  const app = express();
  app.use((req, res, next) => scope.withTenant(req.header('x-test-tenant') || A, () => {
    req.tenantAuthenticate = async () => {
      authentications++;
      if (denied) throw Object.assign(new Error('synthetic current authority refused'), { code: 'TEST_AUTH_REFUSED' });
      const permissions = shiro.new();
      if (!denied) permissions.add('api:*:read');
      permissions.add('api:entries:create');
      authentication.bind(req, { shiros: [permissions] });
    }; next();
  }));
  for (const v of [1, 2]) app.use('/api/v' + v, graph.legacyRouter);
  app.use((error, req, res, next) => { void next; res.status(error.code === 'TEST_AUTH_REFUSED' ? 401 : 503).json({ error: error.code || 'TEST_STORAGE_REFUSED' }); });
  return { app, sql, graphs, denied: v => { denied = v; }, badStorage: v => { badStorage = v; },
    authentications: () => authentications };
}
function reads (rows) { return rows.filter(r => /source_/.test(r.text)); }
function rawCriterion (f) {
  assert(reads(f.sql).every(r => /source_entries/.test(r.text) && !/pg_column_size/.test(r.text)), 'RAW_ENTRIES_NO_UNRELATED_ACQUISITION');
  assert.deepEqual(f.graphs, [['entries']], 'RAW_ENTRIES_ONLY_GRAPH');
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
  it('control: restoring old full acquisition and graphs violates the raw route criteria', async function () {
    await quiet(async () => {
      let applied = false;
      const f = await fixture(s => {
        const changed = s.replace('const rawEntries = /^\\/entries(?:\\/[^/]+)?$/.test(entriesPath);', 'const rawEntries = false;');
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
        const changed = s.replace('if (!metadata && (!rawEntries || entriesFrame))', 'if (!metadata && rawEntries && entriesFrame)');
        assert.notEqual(changed, s, 'derived-frame bypass mutation landed'); return changed;
      });
      await request(broken.app).get('/api/v2/properties').expect(200);
      assert.throws(() => derivedCriterion(broken), /DERIVED_REQUIRES_FULL_FRAME/);
      f.badStorage(true);
      await request(f.app).get('/api/v2/properties').expect(503);
    });
  });
});
