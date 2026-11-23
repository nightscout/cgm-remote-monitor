'use strict';

// INC-U2: the treatments fallback-key indexes (lib/storage/treatment-key-index.js)
// are outcome-identical to single-tenant official/dev. One request corpus runs
// against
//   official  shipping single-tenant official/dev: `node lib/server/server.js`
//             from a scratch tree of that commit (NS_OFFICIAL_DEV_TREE), on a
//             disposable MongoDB (NS_PARITY_MONGO_URI, a database of its own);
//   candidate the multitenant api role of this tree (the preview replica
//             fixture: owned PostgreSQL 16.15 and Vault containers), late stamp
//             on, in three arms: key indexes built and NS_TREATMENT_KEY_UPSERT
//             off; built and on; no index (the candidate as without INC-U).
// Compared per step: reply status and body, stored rows (count, which _ids,
// every stored field), srvCreated carry, and the v1 read clients make.
//
// Normalisations, and only these (each is storage-allocated, not chosen by a
// client):
//   N1 a server-generated _id (any 24-hex value the corpus did not send) is
//      replaced by a label given in order of first appearance: stored rows in
//      insertion order (MongoDB natural order of a fresh collection;
//      PostgreSQL insertion_ordinal), then the reply;
//   N2 srvCreated and srvModified are replaced by facts: srvCreated equal to
//      the value first stored for that row (carried), srvModified at or after
//      srvCreated, srvModified changed by this step;
//   N3 the reply's and the read's srvCreated/srvModified are removed (N2 checks
//      the stored values); reply objects keep every other key;
//   N4 the v1 read is compared as a multiset (rows with an equal created_at
//      have no defined order on either store);
//   N5 a stored MongoDB ObjectId _id is compared as its 24-hex string (as
//      PostgreSQL stores it, id_kind recorded separately);
//   N6 object keys are compared in sorted order (jsonb keeps its own key
//      order; JSON object member order carries no meaning for a client).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { MongoClient } = require('mongodb');
const keyIndex = require('../lib/storage/treatment-key-index');
const { optInSuite } = require('./support/opt-in');

const TREE = process.env.NS_OFFICIAL_DEV_TREE;
// NS_PARITY_MONGO_URI, else the corpus runner's disposable CUSTOMCONNSTR_mongo
// (scripts/test-multitenant.js); official/dev gets a database of its own.
const MONGO = process.env.NS_PARITY_MONGO_URI || process.env.CUSTOMCONNSTR_mongo;
const REPORT = process.env.NS_PARITY_REPORT;
// The candidate fixture's subject display name (modifiedBy on a v3 delete).
const SUBJECT_NAME = 'Synthetic Viewer 0';
const sha1 = value => crypto.createHash('sha1').update(value).digest('hex');

const T0 = Date.UTC(2026, 10, 20);
const at = k => new Date(T0 + k * 300000).toISOString();
const hex = n => n.toString(16).padStart(24, '0');
const CLIENT_HEX = new Set();
const sent = value => { CLIENT_HEX.add(value); return value; };

// The dedup handoff's client table, synthetic values.
const C = {
  loop: k => ({ eventType: 'Correction Bolus', insulin: 0.05 * (k + 1), created_at: at(k), syncIdentifier: 'loop-sync-' + k, enteredBy: 'synthetic-loop' }),
  loopOverride: k => ({ _id: '6f1f6c5e-1b7a-4d43-9c1e-00000000000' + k, eventType: 'Temporary Override', duration: 60, created_at: at(k), enteredBy: 'synthetic-loop' }),
  trio: k => ({ eventType: 'Meal Bolus', insulin: 0.1, carbs: 5 + k, created_at: at(k), id: 'trio-id-' + k, enteredBy: 'synthetic-trio' }),
  xdrip: k => ({ _id: sent(hex(0xd000 + k)), uuid: 'xdrip-uuid-' + k, eventType: 'Carb Correction', carbs: 10 + k, created_at: at(k), enteredBy: 'synthetic-xdrip' }),
  careportal: k => ({ eventType: 'Carb Correction', carbs: 15 + k, created_at: at(k), enteredBy: 'synthetic-careportal' }),
  nsclient: k => ({ eventType: 'Note', notes: 'n' + k, created_at: at(k), NSCLIENT_ID: 'nsc-' + k, enteredBy: 'synthetic-nsclient' })
};
const many = (client, from, count, change = {}) => Array.from({ length: count }, (_, i) => Object.assign(C[client](from + i), change));
const everyClass = () => [...many('loop', 0, 3), ...many('trio', 0, 3), ...many('xdrip', 0, 3), ...many('careportal', 0, 3),
  ...many('nsclient', 0, 3), C.loopOverride(1)];
const post = body => ({ v: 1, method: 'POST', path: '/api/v1/treatments', body });
const put = body => ({ v: 1, method: 'PUT', path: '/api/v1/treatments', body });
const read = { v: 1, method: 'GET', path: '/api/v1/treatments?count=1000&find[created_at][$gte]=2026-01-01', read: true };

// Each scenario starts from an empty table. `index: 'after-seed'` builds the
// key indexes (the migration, marking included) after the steps marked seed.
const SCENARIOS = {
  'client classes: first upload, re-send, edited re-send, PUT': [
    post(everyClass()),
    post(everyClass()),
    post([...many('careportal', 2, 3, { notes: 'edited' }), ...many('loop', 1, 4, { notes: 'edited' }),
      ...many('xdrip', 2, 2, { notes: 'edited' }), ...many('trio', 2, 2, { notes: 'edited' }), ...many('nsclient', 1, 3)]),
    post([Object.assign(C.careportal(0), { carbs: 99 }), C.loop(0)]),
    put(Object.assign(C.xdrip(1), { notes: 'xdrip PUT' })),
    put(Object.assign(C.xdrip(9), { notes: 'xdrip PUT of an unstored _id' })),
    read
  ],
  'case 1: a new client _id onto a stored key, then the fallback re-send': [
    post([C.careportal(0), C.loop(0), C.trio(0), C.nsclient(0)]),
    post([Object.assign(C.careportal(0), { _id: sent(hex(0xc0ffee)), notes: 'with id' }), C.careportal(5)]),
    post([Object.assign(C.loop(0), { _id: sent(hex(0xc0ffef)) }), Object.assign(C.trio(0), { _id: sent(hex(0xc0fff0)) }),
      Object.assign(C.nsclient(0), { _id: sent(hex(0xc0fff1)) })]),
    read,
    post([C.careportal(0)]),
    post([C.loop(0), C.trio(0), C.nsclient(0)]),
    read
  ],
  'case 2: a PUT edit onto another record\'s key, then the fallback re-send': [
    post([C.careportal(0), Object.assign(C.careportal(0), { carbs: 40 }), C.loop(1), Object.assign(C.loop(2), { syncIdentifier: 'other' })]),
    { v: 1, method: 'PUT', path: '/api/v1/treatments', body: { ref: 1, change: { carbs: C.careportal(0).carbs } } },
    { v: 1, method: 'PUT', path: '/api/v1/treatments', body: { ref: 3, change: { syncIdentifier: 'loop-sync-1', created_at: at(1), insulin: 0.1 } } },
    read,
    post([C.careportal(0), C.loop(1)]),
    read
  ],
  'case 3: equal keys stored before the index exists (the migration)': [
    { ...post([C.careportal(1), C.loop(1)]), seed: true },
    { ...post([Object.assign(C.careportal(1), { _id: sent(hex(0xbeef)) }), Object.assign(C.loop(1), { _id: sent(hex(0xbee0)) })]), seed: true },
    { build: true },
    read,
    post([C.careportal(8), C.loop(8)]),
    post([Object.assign(C.careportal(1), { _id: sent(hex(0xbeed)) })]),
    read,
    post([C.careportal(1), C.careportal(7)]),
    post([C.loop(1), C.loop(7)]),
    read
  ],
  'two client ids on one write': [
    post([C.loop(0)]),
    post([Object.assign(C.loop(0), { id: 'trio-id-x' })]),
    post([Object.assign(C.loop(0), { id: 'trio-id-x' })]),
    post([C.loop(0)]),
    read
  ],
  'API v3 records carrying a client id': [
    { v: 3, method: 'POST', path: '/api/v3/treatments', body: Object.assign(C.loop(4), { identifier: 'v3-identifier-a', date: T0 + 4 * 300000 }) },
    { v: 3, method: 'POST', path: '/api/v3/treatments', body: Object.assign(C.loop(4), { identifier: 'v3-identifier-b', date: T0 + 4 * 300000 }) },
    post([C.loop(4)]),
    post([C.loop(5)]),
    { v: 3, method: 'POST', path: '/api/v3/treatments', body: Object.assign(C.loop(5), { date: T0 + 5 * 300000 }) },
    read
  ],
  'array key parts': [
    post([Object.assign(C.nsclient(3), { eventType: ['Note'] }), Object.assign(C.loop(3), { syncIdentifier: ['loop-sync-3', 'x'] })]),
    post([C.nsclient(3), C.loop(3)]),
    read
  ],
  'resend after soft delete, one class each': [
    post([C.careportal(2)]),
    { v: 3, method: 'DELETE', ref: 0 },
    post([C.careportal(2)]),
    post([C.loop(3)]),
    // rows: the deleted careportal record, its re-send (a time key: a new
    // record), the Loop record; the Loop record is deleted.
    { v: 3, method: 'DELETE', refStored: 2 },
    post([C.loop(3)]),
    read
  ],
  // A single object (not an array): the single form, whose reply reads the
  // stored record its target names (write-intent 'stored-id').
  'single-object re-send': [
    post(C.careportal(4)),
    post(C.careportal(4)),
    post(C.loop(4)),
    post(C.loop(4)),
    post(Object.assign(C.careportal(4), { _id: sent(hex(0xc0f0)) })),
    post(C.careportal(4)),
    read
  ],
  'resend after soft delete': [
    post([C.careportal(2), C.loop(2), C.trio(2)]),
    { v: 3, method: 'DELETE', ref: 0 },
    { v: 3, method: 'DELETE', ref: 1 },
    post([C.careportal(2), C.loop(2), C.trio(2)]),
    post([C.careportal(2), C.loop(2), C.trio(2)]),
    read
  ]
};

async function freePort () {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function request (port, method, resource, body, headers = {}) {
  const response = await fetch('http://127.0.0.1:' + port + resource, { method,
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

// Shipping single tenant, from the scratch tree.
function official ({ resend } = {}) {
  const secret = 'synthetic-parity-secret-' + crypto.randomBytes(8).toString('hex');
  const db = 'parity_official_' + crypto.randomBytes(6).toString('hex');
  const side = { name: 'official' + (resend ? '/' + resend : '') };
  let child, mongo, collection, port, token;
  side.open = async function () {
    port = await freePort();
    const uri = new URL(MONGO);
    uri.pathname = '/' + db;
    child = spawn(process.execPath, [path.join(TREE, 'lib/server/server.js')], { cwd: TREE, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'UTC', NODE_ENV: 'production', CUSTOMCONNSTR_mongo: uri.toString(),
        API_SECRET: secret, HOSTNAME: '127.0.0.1', PORT: String(port), INSECURE_USE_HTTP: 'true', AUTH_DEFAULT_ROLES: 'denied',
        ENABLE: 'careportal', ...(resend ? { WRITE_DELETED_RESEND: resend } : {}) } });
    let out = '';
    child.stdout.on('data', b => { out += b; });
    child.stderr.on('data', b => { out += b; });
    const deadline = Date.now() + 60000;
    while (!/Listening on port/.test(out)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('official did not start: ' + out.slice(-2000));
      await delay(200);
    }
    side.log = () => out;
    for (;;) {
      try { if ((await request(port, 'GET', '/api/v1/status.json')).status < 500) break; } catch { /* not listening yet */ }
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('official did not answer: ' + out.slice(-2000));
      await delay(200);
    }
    mongo = new MongoClient(uri.toString());
    await mongo.connect();
    collection = mongo.db().collection('treatments');
    // A v3 subject (official/dev authorization: subjects and roles over v2).
    const auth = { 'api-secret': sha1(secret) };
    const created = await request(port, 'POST', '/api/v2/authorization/subjects', { name: SUBJECT_NAME, roles: ['admin'] }, auth);
    assert.ok(created.status < 300, JSON.stringify(created));
    const subjects = await request(port, 'GET', '/api/v2/authorization/subjects', undefined, auth);
    const accessToken = subjects.body.find(s => s.name === SUBJECT_NAME).accessToken;
    token = (await request(port, 'GET', '/api/v2/authorization/request/' + accessToken)).body.token;
    assert.ok(token, 'official v3 token');
  };
  side.prepare = async () => { await collection.deleteMany({}); };
  side.call = (step, body) => request(port, step.method, step.path, body,
    step.v === 3 ? { Authorization: 'Bearer ' + token } : { 'api-secret': sha1(secret) });
  side.rows = async () => (await collection.find({}).toArray()).map(doc => {
    const kind = doc._id && doc._id._bsontype === 'ObjectId' ? 'objectid' : 'string';
    return { kind, doc: JSON.parse(JSON.stringify({ ...doc, _id: String(doc._id) })) };
  });
  side.build = async () => {};
  side.close = async () => {
    if (mongo) { await mongo.db().dropDatabase().catch(() => {}); await mongo.close(); }
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  };
  return side;
}

// The candidate: this tree's multitenant api role on PostgreSQL.
function candidate (lab, { index, keyed, resend, late = true }) {
  const side = { name: 'candidate/' + (index ? 'index' : 'no-index') + '/keyed-' + (keyed ? 'on' : 'off') + (late ? '' : '/late-stamp-off') + (resend ? '/' + resend : '') };
  let worker, token, table, ordinal;
  const { layout } = require('../lib/server/serve/deployment-settings');
  side.open = async function () {
    table = layout({ NS_PG_PREFIX: lab.platform.prefix }).namespaces.treatments + '.treatments';
    side.table = table;
  };
  async function start () {
    if (worker) await lab.stop(worker);
    const fresh = (await lab.operatorVault('auth/token/create', { policies: ['preview-api'], no_default_policy: true, ttl: '15m', renewable: false })).auth.client_token;
    worker = lab.start(undefined, { NS_VAULT_TOKEN: fresh, NS_CLOCK_LATE_STAMP: late ? '1' : '0', NS_TREATMENT_KEY_UPSERT: keyed ? '1' : '0',
      ...(resend ? { WRITE_DELETED_RESEND: resend } : {}) });
    await lab.ready(worker);
    token = (await lab.exchange(worker, lab.tenants[0])).body.token;
    assert.ok(token, 'candidate v3 token');
  }
  // Every scenario: an empty table, the index state of the arm, a fresh api
  // process (its index presence cache is the process's).
  side.prepare = async function (scenario) {
    await lab.admin.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [lab.tenants[0]]);
    await keyIndex.drop(lab.admin, table);
    if (index && !scenario.some(step => step.build)) await keyIndex.ensure(lab.admin, table, 'require', { log: { warn () {} } });
    ordinal = (await keyIndex.columnState(lab.admin, table)).ordinal;
    await start();
  };
  side.build = async function () {
    if (!index) return;
    const status = await keyIndex.ensure(lab.admin, table, 'require', { log: { warn () {} } });
    assert.deepEqual(status.errors, []);
    side.built = status;
    await start();
  };
  side.call = async (step, body) => {
    const mark = worker.stdout.length + worker.stderr.length;
    const reply = await lab.http(worker, lab.tenants[0], step.method, step.path, step.v === 3 ? token : undefined, body,
      step.v === 3 ? {} : { 'api-secret': lab.rootCredential(lab.tenants[0]) });
    if (reply.status >= 500 && process.env.NS_PARITY_VERBOSE === '1') console.log('CANDIDATE_500 ' + side.name + ' ' + (worker.stdout + worker.stderr).slice(mark - 200).slice(-3000));
    return reply;
  };
  side.rows = async () => (await lab.admin.query(`SELECT id_kind, doc FROM ${table} WHERE tenant_id = $1 ORDER BY ${ordinal ? 'insertion_ordinal' : 'id_kind, "_id"'}`,
    [lab.tenants[0]])).rows.map(row => ({ kind: row.id_kind, doc: row.doc }));
  side.exempt = async () => (await keyIndex.columnState(lab.admin, table)).exempt
    ? (await lab.admin.query(`SELECT doc->>'_id' AS id FROM ${table} WHERE tenant_id = $1 AND key_exempt`, [lab.tenants[0]])).rows.map(r => r.id) : [];
  side.close = async () => { if (worker) await lab.stop(worker); worker = null; };
  return side;
}

// One scenario on one side: the observation compared across sides.
async function run (side, scenario) {
  await side.prepare(scenario);
  const labels = new Map(), firstCreated = new Map(), lastModified = new Map(), sentIds = [];
  const label = id => {
    if (typeof id !== 'string' || CLIENT_HEX.has(id) || !/^[0-9a-f]{24}$/.test(id)) return id;
    if (!labels.has(id)) labels.set(id, 'server#' + labels.size);
    return labels.get(id);
  };
  const scrub = value => {
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'srvCreated' && k !== 'srvModified').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([k, v]) => [k, scrub(v)]));
    }
    return label(value);
  };
  const observed = [];
  for (const step of scenario) {
    if (step.build) { await side.build(); observed.push({ build: true }); continue; }
    let body = step.body;
    if (step.body && step.body.ref !== undefined) {
      // A PUT of a stored record (as its client holds it) with a change.
      const target = (await side.rows())[step.body.ref].doc;
      body = { ...target, ...step.body.change };
      delete body.srvCreated; delete body.srvModified;
    }
    let resource = step.path;
    // A row missing on one side (an earlier step diverged) is deleted as
    // `missing` (a 404), recorded as a difference rather than thrown.
    if (step.method === 'DELETE') resource = '/api/v3/treatments/' + (step.refStored !== undefined ? ((await side.rows())[step.refStored]?.doc._id ?? 'missing') : sentIds[step.ref]);
    const reply = step.concurrent
      ? await Promise.all([side.call({ ...step, path: resource }, body), side.call({ ...step, path: resource }, body)])
      : await side.call({ ...step, path: resource }, body);
    const rows = await side.rows();
    rows.forEach(row => label(row.doc._id));
    if (!sentIds.length && Array.isArray(reply.body)) reply.body.forEach(doc => sentIds.push(doc && doc._id));
    const shown = r => ({ status: r.status, body: step.read && Array.isArray(r.body)
      ? scrub(r.body).map(doc => JSON.stringify(doc)).sort() : scrub(r.body) });
    observed.push({
      step: step.method + ' ' + (step.v === 3 ? 'v3' : 'v1') + (step.seed ? ' seed' : ''),
      reply: Array.isArray(reply) ? reply.map(shown) : shown(reply),
      rows: rows.map(({ kind, doc }) => {
        const id = String(doc._id);
        if (!firstCreated.has(id)) firstCreated.set(id, doc.srvCreated);
        const changed = lastModified.has(id) ? lastModified.get(id) !== doc.srvModified : 'new';
        lastModified.set(id, doc.srvModified);
        const { srvCreated, srvModified, ...rest } = doc;
        return { kind, doc: scrub(rest), carried: srvCreated === firstCreated.get(id),
          ordered: typeof srvModified === 'number' && typeof srvCreated === 'number' && srvModified >= srvCreated, changed };
      })
    });
  }
  return observed;
}

function differences (a, b, at = '', out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[key], b[key], at + '/' + key, out);
    return out;
  }
  out.push({ at, official: a, candidate: b });
  return out;
}

// Formerly named exceptions, now asserted parity (INC-P). Each was a step at
// which official/dev answers 200 and the candidate 500; a failure names the
// shape it returns to, for the reader of the report:
//   PG-FALLBACK-AMBIGUOUS  a v1 fallback-key re-send whose filter reaches two
//     live rows: official/dev's replaceOne replaces the first MongoDB finds,
//     which for equal index keys is insertion order (the earliest stored); the
//     candidate's replace takes the row of lowest insertion_ordinal
//     (postgres-entries-write.js replace, `natural`);
//   PG-DELETED-REACHED-UNSORTED  a v1 re-send whose filter reaches a
//     soft-deleted record: write-intent deletedReached reads findOne (a limit
//     without a sort); the candidate's v1 treatments port reads it in
//     insertion order (postgres-collection-intent.js, naturalOrder).
// E4 MT-WRITE-SETTINGS-UNREAD: the multitenant api's tenant environment
// (lib/server/tenant-app/environment.js) carries no `write` member, so
// WRITE_DELETED_RESEND (like every WRITE_* setting lib/server/env.js parses
// into env.write) is at its default there: a revive arm runs `stay`. The
// revive arms are therefore compared with official/dev under `stay`, and
// official/dev under `revive` is recorded beside them (report:
// officialRevive). Should the setting reach the api, these arms go red.
// E3 (official/dev storing duplicates for concurrent identical batches) is
// official/dev's behaviour and stays outside the comparison (the last test).
function classify (body) {
  const description = body && body.description;
  if (!description || description.unsupported !== true) return null;
  return description.name === 'UnsupportedQueryError' ? 'PG-DELETED-REACHED-UNSORTED' : 'PG-FALLBACK-AMBIGUOUS';
}
function divergence (diffs, observedOfficial, observedCandidate) {
  const step = Math.min(...diffs.map(d => Number(d.at.split('/')[1])));
  const o = observedOfficial[step], c = observedCandidate[step];
  const name = o && c && o.reply.status === 200 && c.reply.status === 500 ? classify(c.reply.body) : null;
  return { step, name };
}

optInSuite(process.env.NS_TREATMENT_KEY_PARITY_TEST === '1' && !!TREE && !!MONGO,
  'NS_TREATMENT_KEY_PARITY_TEST=1, NS_OFFICIAL_DEV_TREE (a scratch tree of official/dev) and NS_PARITY_MONGO_URI or CUSTOMCONNSTR_mongo (disposable MongoDB), Docker')(
  'treatments fallback-key indexes: outcome parity with official/dev (INC-U2)', function () {
    this.timeout(900000);
    const lab = require('./fixtures/multitenant-preview-replicas')();
    const report = { official: TREE && fs.existsSync(path.join(TREE, 'SOURCE_COMMIT')) ? fs.readFileSync(path.join(TREE, 'SOURCE_COMMIT'), 'utf8').trim() : null,
      scenarios: {} };
    const sides = {};
    before(async function () {
      await lab.setup();
      const { layout } = require('../lib/server/serve/deployment-settings');
      const ns = layout({ NS_PG_PREFIX: lab.platform.prefix }).namespaces;
      const permissions = ['read', 'create', 'update', 'delete'].map(action => 'api:treatments:' + action);
      await lab.admin.query(`UPDATE ${ns.authorization}.tenant_authorization_roles SET permissions=$1 WHERE tenant_id=$2 AND name='viewer'`,
        [permissions, lab.tenants[0]]);
      report.postgres = (await lab.admin.query('SHOW server_version')).rows[0].server_version;
      for (const [name, side] of Object.entries({
        official: official(), officialRevive: official({ resend: 'revive' }),
        indexOff: candidate(lab, { index: true, keyed: false }), indexOn: candidate(lab, { index: true, keyed: true }),
        noIndex: candidate(lab, { index: false, keyed: true }), candidateDefault: candidate(lab, { index: false, keyed: false, late: false }),
        indexOnRevive: candidate(lab, { index: true, keyed: true, resend: 'revive' }),
        noIndexRevive: candidate(lab, { index: false, keyed: true, resend: 'revive' }),
        defaultRevive: candidate(lab, { index: false, keyed: false, late: false, resend: 'revive' })
      })) { sides[name] = side; await side.open(); }
      const probe = new MongoClient(MONGO);
      await probe.connect();
      report.mongodb = (await probe.db().admin().serverInfo()).version;
      await probe.close();
    });
    after(async function () {
      for (const side of Object.values(sides)) await side.close().catch(() => {});
      await lab.cleanup();
      if (REPORT) fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
    });

    const arms = (revive) => revive ? ['indexOnRevive', 'noIndexRevive', 'defaultRevive'] : ['indexOff', 'indexOn', 'noIndex', 'candidateDefault'];
    for (const [title, scenario] of Object.entries(SCENARIOS)) {
      for (const revive of title.startsWith('resend after soft delete') ? [false, true] : [false]) {
        const name = title + (revive ? ' (WRITE_DELETED_RESEND=revive)' : '');
        it(name, async function () {
          const reference = await run(sides.official, scenario);
          const entry = report.scenarios[name] = { official: reference, arms: {} };
          if (revive) {
            const officialRevive = await run(sides.officialRevive, scenario);
            entry.officialRevive = { sameAsStay: !differences(reference, officialRevive).length, observed: officialRevive };
          }
          const observedBy = {};
          for (const arm of arms(revive)) {
            const observed = observedBy[arm] = await run(sides[arm], scenario);
            const diffs = differences(reference, observed);
            const diverged = diffs.length ? divergence(diffs, reference, observed) : null;
            entry.arms[arm] = { equal: !diffs.length, diverged, differences: diffs.length ? diffs.slice(0, 20) : undefined,
              exempt: await sides[arm].exempt(), built: sides[arm].built, observed: diffs.length ? observed : undefined };
            sides[arm].built = undefined;
          }
          const control = revive ? 'noIndexRevive' : 'noIndex';
          for (const arm of arms(revive)) entry.arms[arm].sameAsNoIndex = JSON.stringify(observedBy[arm]) === JSON.stringify(observedBy[control]);
          console.log('PARITY ' + JSON.stringify({ name, ...(revive ? { officialReviveSameAsStay: entry.officialRevive.sameAsStay } : {}), arms: Object.fromEntries(Object.entries(entry.arms).map(([k, v]) =>
            [k, { official: v.equal ? 'equal' : (v.diverged.name || 'differs') + ' from step ' + v.diverged.step,
              sameAsNoIndex: v.sameAsNoIndex, exempt: v.exempt.length }])) }));
          for (const arm of arms(revive)) {
            const d = entry.arms[arm].diverged;
            assert.ok(entry.arms[arm].equal, arm + ' differs from official/dev' + (d ? ' (' + (d.name || 'first') + ' at step ' + d.step + ')' : '') +
              ': ' + JSON.stringify(entry.arms[arm].differences));
            if (arm.startsWith('index')) assert.ok(entry.arms[arm].sameAsNoIndex, arm + ' differs from the candidate without the index');
          }
        });
      }
    }

    it('concurrent identical re-send batches (repeated)', async function () {
      const scenario = [post([C.careportal(0)]),
        { ...post([...many('careportal', 0, 10), ...many('loop', 0, 10)]), concurrent: true }];
      const outcome = {};
      for (const name of ['official', 'indexOff', 'indexOn', 'noIndex']) {
        outcome[name] = [];
        for (let i = 0; i < 5; i++) {
          const observed = await run(sides[name], scenario);
          outcome[name].push({ rows: observed[1].rows.length, statuses: observed[1].reply.map(r => r.status) });
        }
      }
      report.concurrent = outcome;
      console.log('PARITY_CONCURRENT ' + JSON.stringify(outcome));
      for (const name of ['indexOff', 'indexOn', 'noIndex']) {
        assert.deepEqual(outcome[name], outcome.noIndex, name + ' differs from the candidate without the index');
        assert.ok(outcome[name].every(o => o.rows === 20 && o.statuses.every(s => s === 200)), name + ': one row per key');
      }
    });
  });
