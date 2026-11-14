'use strict';

// Small native PostgreSQL + actual preview/API path. The operation-window
// adapter below is a refusal protocol, not native platform fencing evidence.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const express = require('express'), request = require('supertest');
const scope = require('../lib/storage/tenant-scope');
const connect = require('../lib/storage/postgres-connection');
const preview = require('../lib/server/serve/preview-domains');
const environment = require('../lib/server/tenant-app/environment');
const { run } = require('../lib/migrations/postgres');
const dataAccess = require('../lib/server/tenant-app/data-access');
const { createTenantApp } = require('../lib/server/tenant-app');
const { optInSuite } = require('./support/opt-in');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const domains = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'];
const GRANTS = domains.flatMap(d => ['read', 'create', 'update', 'delete'].map(a => 'api:' + d + ':' + a));
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
optInSuite(process.env.NS_REST_ACQUISITION_NATIVE === '1', 'NS_REST_ACQUISITION_NATIVE=1')('entries acquisition native preview path', function () {
  this.timeout(60000);
  const name = 'ns-rest-read-transaction-native-' + randomBytes(5).toString('hex');
  const ns = 'acquisition';
  const role = 'acquisition_api';
  const auth = 'acquisition_authority';
  const password = randomBytes(24).toString('hex');
  const credentials = new Map([['synthetic-a', A], ['synthetic-b', B]]);
  let owned = false, containerId, pinnedImage, admin, connection, authority, app, oldApp, previous, closed = false;
  let suspended = false, checks = 0, queries = [], witnessing = false, witnesses = [];
  const at = Date.now() - 1000;
  const unavailable = async () => { throw new Error('owner service outside fixture'); };
  const http = (method, path, tenant = A, token = tenant === A ? 'synthetic-a' : 'synthetic-b') =>
    request(app)[method](path + (path.includes('?') ? '&' : '?') + 'token=' + token)
      .set('Host', tenant === A ? 'a.example.test' : 'b.example.test').set('Accept', 'application/json');
  before(async () => {
    previous = scope.getTenancyMode(); scope.setTenancyMode('multi');
    const imageReference=process.env.NS_MULTITENANT_POSTGRES_IMAGE || 'postgres:16';
    pinnedImage = docker(['image', 'inspect', imageReference, '--format', '{{.Id}}']);
    const id = execFileSync('docker', ['run', '--rm', '-d', '--name', name,
      '--label', 'com.docker.compose.project=ns-rest-read-transaction-native-20261113', '--label', 'ns.rest.owner=rest-read-transaction-batch-20261113',
      '--cpus=1', '--memory=512m', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD', pinnedImage],
    { env: { ...process.env, POSTGRES_PASSWORD: password }, encoding: 'utf8', timeout: 30000 }).trim();
    owned = true; containerId = id;
    const port = docker(['port', name, '5432/tcp']).split(':').pop();
    console.log('REST_NATIVE_OWNED ' + JSON.stringify({ id, name, port, imageReference, pinnedImage, owner: 'rest-read-transaction-batch-20261113' }));
    const uri = new URL('postgres://postgres@127.0.0.1:' + port + '/postgres'); uri.password = password;
    for (let i = 0; ; i++) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); break; }
      catch (e) { if (i >= 100) throw e; await delay(100); }
    }
    admin = new Client({ connectionString: uri.toString() }); await admin.connect();
    for (const d of domains) await run('up', { direct: true, connectionString: uri.toString(), namespace: ns + '_' + d,
      catalogue: require('../lib/server/serve/postgres-domains').get(d).catalogue });
    await run('up', { direct: true, connectionString: uri.toString(), namespace: auth,
      catalogue: require('../lib/tenant-authorization/postgres-candidate.json') });
    const secret = randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${secret}'`);
    for (const d of domains) {
      await admin.query(`GRANT USAGE ON SCHEMA ${ns}_${d} TO ${role}`);
      await require('./fixtures/tenant-insertion-grants').grant(admin, { namespace: ns + '_' + d, role,
        domain: d, catalogue: require('../lib/server/serve/postgres-domains').get(d).catalogue });
    }
    await admin.query(`GRANT USAGE ON SCHEMA ${auth} TO ${role}`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${auth} TO ${role}`);
    for (const tenant of [A, B]) {
      await admin.query(`INSERT INTO ${auth}.tenant_authorization_config VALUES ($1, ARRAY['denied'])`, [tenant]);
      await admin.query(`INSERT INTO ${auth}.tenant_authorization_subjects (tenant_id,subject_id,display_name) VALUES ($1,'subject','synthetic')`, [tenant]);
      await admin.query(`INSERT INTO ${auth}.tenant_authorization_roles VALUES ($1,'writer',$2)`, [tenant, GRANTS]);
      await admin.query(`INSERT INTO ${auth}.tenant_authorization_subject_roles VALUES ($1,'subject','writer')`, [tenant]);
    }
    uri.username = role; uri.password = secret;
    connection = await connect({ connectionString: uri.toString(), max: 1 });
    const query = connection.query.bind(connection);
    connection.query = async (...args) => {
      const input = args[0], text = typeof input === 'string' ? input : input.text;
      queries.push(text);
      const phase = text.includes('s.subject_id, s.display_name') ? 'authority'
        : text.startsWith('SELECT id_kind, doc') ? 'entries' : null;
      if (witnessing && phase) {
        // Native-only diagnostic fields identify the actual two SELECTs. The
        // production adapters ignore these extra columns; no extra TX/query.
        const tagged = text.replace(/SELECT /, "SELECT pg_backend_pid() AS witness_pid,txid_current()::text AS witness_txid,");
        args[0] = typeof input === 'string' ? tagged : { ...input, text: tagged };
      }
      const result = await query(...args);
      if (witnessing && phase) witnesses.push({ phase, pid: result.rows[0]?.witness_pid, txid: result.rows[0]?.witness_txid });
      return result;
    };
    authority = await require('../lib/tenant-authorization/postgres')({ connectionString: uri.toString(), namespace: auth, connection });
    const previewOptions = { config: { domains, legacyEnabled: true, contextEnabled: true, bindings: new Map([[A, {}], [B, {}]]),
      environments: new Map([A, B].map(t => [t, environment()])), namespaces: Object.fromEntries(domains.map(d => [d, ns + '_' + d])) },
    connection, exchange: async () => null };
    const graph = await preview(previewOptions);
    const file = require.resolve('../lib/server/serve/preview-domains');
    const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
    const source = fs.readFileSync(file, 'utf8');
    const restored = source.replace("const rawDomains = logical && legacyNames.includes(logical) ? [logical]", "const rawDomains = false ? [logical]").replace(": alias ? [...new Set(['entries', ...(legacyNames.includes(alias[2]) ? [alias[2]] : [])])] : null;", ": null;");
    assert.notEqual(restored, source, 'full acquisition control mutation landed');
    const output = { exports: {} };
    vm.runInThisContext('(function(require,module,exports){' + restored + '\n})', { filename: file })(createRequire(file), output, output.exports);
    const oldGraph = await output.exports(previewOptions);
    const access = dataAccess({ authority, entriesReadConnection: connection, secrets: { verifyLegacyCredential: async ({ tenant }, { token }) =>
      credentials.get(token) === tenant ? { kind: 'subject', subjectId: 'subject' } : null },
    verifierContext: async tenant => ({ tenant, consumer: 'api' }), collections: domains, legacyCollections: domains });
    const options = { resolver: { resolve: async req => req.hostname === 'a.example.test' ? A : B },
      verifyCredential: unavailable, authorizeRequest: unavailable, tenantSettings: { read: unavailable, replace: unavailable, rollback: unavailable },
      subjectPolicy: { read: unavailable, replace: unavailable }, dataRouter: express.Router(), legacyRouter: graph.legacyRouter, dataAccess: access,
      operationWindow: { run: async (tenant, fn) => {
        checks++; if (suspended) throw Object.assign(new Error('restore in progress'), { code: 'TENANT_MAINTENANCE', status: 503 });
        return scope.withTenant(tenant, fn);
      } } };
    app = createTenantApp(options);
    oldApp = createTenantApp({ ...options, legacyRouter: oldGraph.legacyRouter });
  });
  after(async () => {
    try { if (connection && !closed) await connection.end(); }
    finally { try { if (authority) await authority.close(); }
      finally { try { if (admin) await admin.end(); }
      finally { try { if (owned) {
        const metadata = JSON.parse(docker(['inspect', containerId]))[0];
        assert.equal(metadata.Config.Labels['ns.rest.owner'], 'rest-read-transaction-batch-20261113');
        assert.equal(metadata.Image, pinnedImage);
        assert.equal(metadata.Name,'/'+name);
        const volumes=metadata.Mounts.filter(row=>row.Type==='volume').map(row=>row.Name);
        docker(['rm', '-f', '-v', containerId]);
        assert.equal(docker(['ps','-a','--no-trunc','--filter','id='+containerId,'--format','{{.ID}}']),'');
        const remaining=new Set(docker(['volume','ls','--format','{{.Name}}']).split('\n'));
        assert(volumes.every(volume=>!remaining.has(volume)),'REST_NATIVE_OWNED_VOLUMES_REMOVED');
        console.log('REST_NATIVE_REMOVED '+JSON.stringify({id:containerId,pinnedImage,containerAbsent:true,volumesAbsent:true,volumeCount:volumes.length}));
      } } finally { scope.setTenancyMode(previous); } } } }
  });
  it('persists each tenant through actual POST then reads matching content with no unrelated SQL', async () => {
    for (const [tenant, sgv] of [[A, 123], [B, 234]]) {
      queries = [];
      await http('post', '/api/v1/entries', tenant).send([{ type: 'sgv', sgv, date: at, dateString: new Date(at).toISOString(), device: 'synthetic' }]).expect(200);
      assert(!queries.some(s => /pg_column_size|acquisition_(treatments|profile|food|activity|devicestatus)/.test(s)), 'NATIVE_WRITE_NO_UNRELATED_READ');
      for (const version of [1, 2]) {
        queries = [];
        const response = await http('get', '/api/v' + version + '/entries/sgv.json?count=1', tenant).expect(200);
        assert.equal(response.body[0].sgv, sgv);
        assert.equal(response.headers['last-modified'], new Date(at).toUTCString());
        assert(!queries.some(s => /pg_column_size|acquisition_(treatments|profile|food|activity|devicestatus)/.test(s)), 'NATIVE_READ_NO_UNRELATED_READ');
        console.log('REST_NATIVE_READ ' + JSON.stringify({ version, tenant, sqlStatements: queries.length }));
      }
    }
    const stored = (await admin.query(`SELECT tenant_id,doc FROM ${ns}_entries.entries ORDER BY tenant_id`)).rows;
    assert.deepEqual(stored.map(r => [r.tenant_id, r.doc.sgv]), [[A, 123], [B, 234]]);
    await http('post', '/api/v1/entries').send([
      { type: 'sgv', sgv: 111, date: at - 5 * 86400000, dateString: new Date(at - 5 * 86400000).toISOString(), device: 'stale' },
      { type: 'sgv', sgv: 144, date: at + 86400000, dateString: new Date(at + 86400000).toISOString(), device: 'future' },
      { type: 'mbg', mbg: 122, date: at - 1000, dateString: new Date(at - 1000).toISOString(), device: 'mbg' },
      { type: 'cal', scale: 1, slope: 2, intercept: 3, date: at - 2000, dateString: new Date(at - 2000).toISOString(), device: 'cal' }
    ]).expect(200);
    for (const version of [1, 2]) for (const path of ['/entries.json', '/entries/sgv.json?count=1', '/entries/sgv.json?count=50', '/entries/mbg.json?count=1', '/entries/cal.json?count=1', '/entries?find[date][$gte]=' + (at - 6 * 86400000), '/entries/current.json', '/entries.csv', '/entries?count=0']) {
      const actual = await http('get', '/api/v' + version + path).expect(200);
      queries = [];
      const expected = await request(oldApp).get('/api/v' + version + path + (path.includes('?') ? '&' : '?') + 'token=synthetic-a')
        .set('Host', 'a.example.test').set('Accept', 'application/json').expect(200);
      assert.deepEqual(actual.body, expected.body, 'same payload ' + path);
      assert.equal(actual.text, expected.text, 'same representation ' + path);
      assert.equal(actual.headers['last-modified'], expected.headers['last-modified'], 'same header ' + path);
      assert.equal(actual.headers['content-type'], expected.headers['content-type']);
      if (path.includes('/entries/sgv')) console.log('REST_NATIVE_OLD_READ ' + JSON.stringify({ version, sqlStatements: queries.length }));
    }
    const first = await http('get', '/api/v1/entries').expect(200);
    await http('get', '/api/v1/entries').set('If-Modified-Since', first.headers['last-modified']).expect(304);
  });
  it('preserves other raw domain reads/writes and header-credential cache behavior against full acquisition', async () => {
    const createdAt = new Date(at).toISOString();
    const payloads = {
      treatments: { created_at: createdAt, eventType: 'Note', notes: 'synthetic' },
      devicestatus: { created_at: createdAt, device: 'synthetic', uploaderBattery: 80 },
      activity: { created_at: createdAt, steps: 1, notes: 'synthetic' },
      food: { name: 'synthetic', carbs: 10, portion: 1, unit: 'g', type: 'food' },
      profile: { startDate: createdAt, defaultProfile: 'Default', units: 'mg/dl', store: { Default: {
        dia: 3, timezone: 'UTC', units: 'mg/dl', basal: [{ time: '00:00', value: 1 }],
        carbratio: [{ time: '00:00', value: 10 }], sens: [{ time: '00:00', value: 40 }],
        target_low: [{ time: '00:00', value: 90 }], target_high: [{ time: '00:00', value: 110 }]
      } } }
    };
    for (const [domain, doc] of Object.entries(payloads)) {
      for (const tenant of [A, B]) {
        queries = [];
        await http('post', '/api/v1/' + domain, tenant).send(doc).expect(200);
        assert(!queries.some(s => /pg_column_size/.test(s) || domains.filter(d => d !== domain).some(d => s.includes('acquisition_' + d))), 'RAW_WRITE_ONLY_SELECTED_DOMAIN ' + domain);
      }
      const stored = (await admin.query(`SELECT tenant_id,doc FROM ${ns}_${domain}.${domain} ORDER BY tenant_id`)).rows;
      assert.deepEqual(stored.map(r => r.tenant_id), [A, B], 'independent tenant storage ' + domain);
      for (const version of [1, 2]) for (const carrier of ['query', 'header']) {
        const path = '/api/v' + version + '/' + domain + '?count=1';
        const get = target => {
          const call = request(target).get(path + (carrier === 'query' ? '&token=synthetic-a' : ''))
            .set('Host', 'a.example.test').set('Accept', 'application/json');
          return carrier === 'header' ? call.set('Authorization', 'Bearer synthetic-a') : call;
        };
        queries = [];
        const actual = await get(app).expect(200);
        assert(!queries.some(s => /pg_column_size/.test(s) || domains.filter(d => d !== domain).some(d => s.includes('acquisition_' + d))), 'RAW_READ_ONLY_SELECTED_DOMAIN ' + domain);
        const expected = await get(oldApp).expect(200);
        assert.deepEqual(actual.body, expected.body, domain + ' ' + carrier);
        assert.equal(actual.headers['last-modified'], expected.headers['last-modified']);
        assert.equal(actual.headers['content-type'], expected.headers['content-type']);
      }
    }
    const responses = await Promise.all([A, B, A, B].map(t => http('get', '/api/v1/entries/sgv?count=1', t).expect(200)));
    assert.deepEqual(responses.map(r => r.body[0].sgv), [123, 234, 123, 234], 'concurrent tenant frame isolation');
  });
  it('keeps native rollback savepoints bounded and removes WindowAgg only for complete entry reads', async () => {
    await scope.withTenant(A, () => connection.transaction(async () => {
      for (let i = 0; i < 5; i++) {
        await assert.rejects(connection.withSavepoint(async () => {
          await connection.query("SELECT set_config('ns.rest_savepoint_probe','changed',true)");
          throw Error('rollback probe');
        }), /rollback probe/);
        const result = await connection.query("SELECT current_setting('ns.rest_savepoint_probe',true) AS value");
        assert.notEqual(result.rows[0].value, 'changed');
      }
    }));
    const read = require('../lib/storage/postgres-entries-read')({ connection, table: ns + '_entries.entries' });
    const fromMongo = require('../lib/storage/filter').fromMongo;
    const filter = fromMongo({ device: 'explain-fixture' });
    await require('./fixtures/tenant-insertion-grants').withTenant(admin, A, () => admin.query(`INSERT INTO ${ns}_entries.entries (tenant_id,id_kind,doc)
      SELECT $1, 'string', jsonb_build_object('_id','plan-' || i, 'date',$2::bigint-i*300000::bigint,'sgv',100,'type','sgv','device','explain-fixture')
      FROM generate_series(1,1500) i`, [A, at]));
    await admin.query(`ANALYZE ${ns}_entries.entries`);
    let captured;
    const query = connection.query;
    connection.query = async (sql, params) => { captured = { sql, params }; return query(sql, params); };
    try {
      const full = await scope.withTenant(A, () => read.findFiltered(filter, { sort: { date: 1 } }));
      assert.equal(full.length, 1500);
      await http('get', '/api/v1/entries/sgv?count=1').expect(200);
      const actual = captured;
      assert(actual.sql.startsWith('SELECT id_kind, doc,'), 'plan uses actual HTTP cache acquisition SQL');
      assert(!actual.sql.includes('OVER ()'), 'full read has row-local refusal guard');
      const marker = 'SELECT id_kind, doc'.length, end = actual.sql.indexOf(' AS unsortable');
      const guard = actual.sql.slice(marker + 2, end);
      const oldSql = actual.sql.slice(0, marker + 2) + 'bool_or(' + guard + ') OVER ()' + actual.sql.slice(end);
      const explain = async sql => scope.withTenant(A, async () => {
        const result = await query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql, actual.params);
        return result.rows[0]['QUERY PLAN'];
      });
      const oldPlan = await explain(oldSql), newPlan = await explain(actual.sql);
      assert(JSON.stringify(oldPlan).includes('WindowAgg'));
      assert(!JSON.stringify(newPlan).includes('WindowAgg'));
      const oldRows = await scope.withTenant(A, () => query(oldSql, actual.params));
      const newRows = await scope.withTenant(A, () => query(actual.sql, actual.params));
      assert.deepEqual(newRows.rows, oldRows.rows);
      const indexes = (await admin.query('SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename=$2', [ns + '_entries', 'entries'])).rows;
      console.log('REST_ENTRY_ACTUAL_EXPLAIN ' + JSON.stringify({ source: 'HTTP /api/v1/entries/sgv?count=1', sql: actual.sql, params: actual.params, indexes, oldPlan, newPlan }));
      for (const bad of [[2000], { value: 2000 }]) {
        await require('./fixtures/tenant-insertion-grants').withTenant(admin, A, () => admin.query(`INSERT INTO ${ns}_entries.entries (tenant_id,id_kind,doc) VALUES ($1,'string',$2)`,
          [A, { _id: 'plan-bad', date: bad, sgv: 100, device: 'explain-fixture' }]));
        for (const opts of [{ sort: { date: 1 } }, { sort: { date: 1 }, limit: 1 }, { sort: { date: 1 }, skip: 1, limit: 1 }]) {
          await assert.rejects(scope.withTenant(A, () => read.findFiltered(filter, opts)), /sort over an array or subdocument/);
          if (opts.limit) assert(captured.sql.includes('OVER ()'), 'page guards rows beyond the page');
        }
        await admin.query(`DELETE FROM ${ns}_entries.entries WHERE tenant_id=$1 AND doc->>'_id'='plan-bad'`, [A]);
      }
    } finally {
      connection.query = query;
      await admin.query(`DELETE FROM ${ns}_entries.entries WHERE doc->>'device'='explain-fixture'`);
    }
  });

  it('materializes the real HTTP entry read and current authority in the same physical transaction', async () => {
    witnesses = []; witnessing = true;
    try { await http('get', '/api/v1/entries/sgv?count=1').expect(200); }
    finally { witnessing = false; }
    assert.deepEqual(witnesses.map(x => x.phase), ['authority', 'entries']);
    assert(witnesses.every(x => Number.isSafeInteger(x.pid) && /^[1-9][0-9]*$/.test(x.txid)));
    assert.equal(witnesses[0].pid, witnesses[1].pid, 'NATIVE_AUTHORITY_ENTRIES_SAME_BACKEND');
    assert.equal(witnesses[0].txid, witnesses[1].txid, 'NATIVE_AUTHORITY_ENTRIES_SAME_TRANSACTION');
    console.log('REST_NATIVE_SHARED_READ_TRANSACTION ' + JSON.stringify(witnesses));
  });

  it('classifies denied native clinical reads as snapshot unavailability after current authority', async () => {
    const before = (await admin.query(`SELECT tenant_id,doc FROM ${ns}_entries.entries ORDER BY tenant_id`)).rows;
    await admin.query(`REVOKE SELECT ON ${ns}_entries.entries FROM ${role}`);
    try {
      for (const version of [1, 2]) {
        queries = [];
        const response = await http('get', '/api/v' + version + '/entries').expect(503);
        assert.deepEqual(response.body, { error: 'TENANT_SNAPSHOT_UNAVAILABLE' });
        const authorization = queries.findIndex(sql => sql.includes('s.subject_id, s.display_name'));
        const clinical = queries.findIndex(sql => sql.startsWith('SELECT id_kind, doc'));
        assert(authorization >= 0 && clinical > authorization, 'CURRENT_AUTHORITY_PRECEDES_FAILED_CLINICAL_READ');
      }
    } finally { await admin.query(`GRANT SELECT ON ${ns}_entries.entries TO ${role}`); }
    assert.deepEqual((await admin.query(`SELECT tenant_id,doc FROM ${ns}_entries.entries ORDER BY tenant_id`)).rows, before);
    await http('get', '/api/v1/entries').expect(200);
  });

  it('classifies a missing native clinical table as an internal snapshot failure', async () => {
    const before = (await admin.query(`SELECT tenant_id,doc FROM ${ns}_entries.entries ORDER BY tenant_id`)).rows;
    await admin.query(`ALTER TABLE ${ns}_entries.entries RENAME TO entries_fault_fixture`);
    try {
      for (const version of [1, 2]) {
        const response = await http('get', '/api/v' + version + '/entries').expect(500);
        assert.deepEqual(response.body, { error: 'TENANT_SNAPSHOT_INTERNAL' });
      }
    } finally { await admin.query(`ALTER TABLE ${ns}_entries.entries_fault_fixture RENAME TO entries`); }
    assert.deepEqual((await admin.query(`SELECT tenant_id,doc FROM ${ns}_entries.entries ORDER BY tenant_id`)).rows, before);
    await http('get', '/api/v2/entries').expect(200);
  });

  it('keeps native authority failures distinct and refuses before any clinical read', async () => {
    const before = (await admin.query(`SELECT tenant_id,doc FROM ${ns}_entries.entries ORDER BY tenant_id`)).rows;
    await admin.query(`REVOKE SELECT ON ${auth}.tenant_authorization_roles FROM ${role}`);
    try {
      for (const version of [1, 2]) {
        queries = [];
        const response = await http('get', '/api/v' + version + '/entries').expect(503);
        assert.deepEqual(response.body, { error: 'AUTHORITY_UNAVAILABLE' });
        assert(queries.some(sql => sql.includes('s.subject_id, s.display_name')), 'CURRENT_AUTHORITY_READ_ATTEMPTED');
        assert(!queries.some(sql => sql.includes(ns + '_entries')), 'FAILED_AUTHORITY_PREVENTS_CLINICAL_SQL');
      }
    } finally { await admin.query(`GRANT SELECT ON ${auth}.tenant_authorization_roles TO ${role}`); }
    assert.deepEqual((await admin.query(`SELECT tenant_id,doc FROM ${ns}_entries.entries ORDER BY tenant_id`)).rows, before);
    await http('get', '/api/v1/entries').expect(200);
  });

  it('retains current role/membership/foreign-token and restore admission refusals with no writes', async () => {
    // Explicit role named like an anonymous default: claims override, decisions union.
    await admin.query(`UPDATE ${auth}.tenant_authorization_config SET anonymous_roles=ARRAY['readable'] WHERE tenant_id=$1`, [A]);
    await admin.query(`INSERT INTO ${auth}.tenant_authorization_roles VALUES ($1,'readable',ARRAY[]::text[])`, [A]);
    await admin.query(`INSERT INTO ${auth}.tenant_authorization_subject_roles VALUES ($1,'subject','readable')`, [A]);
    await admin.query(`DELETE FROM ${auth}.tenant_authorization_subject_roles WHERE tenant_id=$1 AND role_name='writer'`, [A]);
    const current = await authority.subjectAuthorizationSnapshot({ tenant: A, principal: { kind: 'subject', subjectId: 'subject' } });
    assert.deepEqual(current.subject.permissionGroups, [[]]);
    assert.equal(current.allows('api:entries:read'), true);
    await http('get', '/api/v1/entries/sgv').expect(200);
    await admin.query(`UPDATE ${auth}.tenant_authorization_config SET anonymous_roles=ARRAY['denied'] WHERE tenant_id=$1`, [A]);
    await admin.query(`UPDATE ${auth}.tenant_authorization_subjects SET display_name='renamed' WHERE tenant_id=$1`, [A]);
    assert.equal((await authority.subjectSnapshot({ tenant: A, principal: { kind: 'subject', subjectId: 'subject' } })).sub, 'renamed');
    await http('get', '/api/v1/entries/sgv').expect(401);
    await admin.query(`DELETE FROM ${auth}.tenant_authorization_subject_roles WHERE tenant_id=$1 AND role_name='readable'`, [A]);
    await admin.query(`INSERT INTO ${auth}.tenant_authorization_subject_roles VALUES ($1,'subject','writer')`, [A]);
    const before = (await admin.query(`SELECT tenant_id,doc FROM ${ns}_entries.entries ORDER BY tenant_id`)).rows;
    await http('post', '/api/v1/entries', A, 'synthetic-b').send([{ type: 'sgv', sgv: 999, date: at }]).expect(401);
    await admin.query(`UPDATE ${auth}.tenant_authorization_roles SET permissions=ARRAY[]::text[] WHERE tenant_id=$1`, [A]);
    await http('get', '/api/v1/entries/sgv').expect(401);
    await http('get', '/api/v1/entries/sgv', B).expect(200);
    await admin.query(`UPDATE ${auth}.tenant_authorization_roles SET permissions=$2 WHERE tenant_id=$1`, [A, GRANTS]);
    await http('get', '/api/v1/entries/sgv').expect(200);
    await admin.query(`DELETE FROM ${auth}.tenant_authorization_subject_roles WHERE tenant_id=$1`, [A]);
    await admin.query(`DELETE FROM ${auth}.tenant_authorization_subjects WHERE tenant_id=$1`, [A]);
    await http('get', '/api/v1/entries/sgv').expect(401);
    suspended = true;
    const prior = checks;
    await http('post', '/api/v1/entries', B).send([{ type: 'sgv', sgv: 999, date: at }]).expect(503);
    assert.equal(checks, prior + 1, 'actual route crosses operation-window adapter'); suspended = false;
    assert.deepEqual((await admin.query(`SELECT tenant_id,doc FROM ${ns}_entries.entries ORDER BY tenant_id`)).rows, before);
    await connection.end(); closed = true;
    queries = [];
    const unavailable = await http('get', '/api/v1/entries/sgv', B).expect(503);
    assert.deepEqual(unavailable.body, { error: 'AUTHORITY_UNAVAILABLE' });
    assert(!queries.some(sql => sql.includes(ns + '_entries')), 'CLOSED_AUTHORITY_POOL_PREVENTS_CLINICAL_SQL');
  });
});
