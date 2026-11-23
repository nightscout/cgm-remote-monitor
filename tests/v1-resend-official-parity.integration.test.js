'use strict';

// INC-P2: v1 entries, device status and profile re-sends are outcome-identical
// to single-tenant official/dev (the sibling of
// tests/treatment-key-official-parity.integration.test.js, which covers v1
// treatments). One request corpus runs against
//   official  shipping single-tenant official/dev: `node lib/server/server.js`
//             from a scratch tree of that commit (NS_OFFICIAL_DEV_TREE), on a
//             disposable MongoDB (NS_PARITY_MONGO_URI, a database of its own),
//             every WRITE_* setting at its default (decision
//             multitenant-write-settings-at-defaults);
//   candidate the multitenant api role of this tree (the preview replica
//             fixture: owned PostgreSQL and Vault containers), in three arms:
//             late stamp off and keyed upsert off (the defaults); late stamp
//             on; late stamp and NS_TREATMENT_KEY_UPSERT on.
// Compared per step: reply status and body, stored rows of the three
// collections (count, which _ids, every stored field, in insertion order),
// srvCreated carry, and the v1 reads clients make.
//
// Normalisations, the same as the treatments differential's and only these:
//   N1 a server-generated _id (any 24-hex value the corpus did not send) is
//      replaced by a label given in order of first appearance: stored rows in
//      insertion order (MongoDB natural order of a fresh collection;
//      PostgreSQL insertion_ordinal), then the reply;
//   N2 srvCreated and srvModified are replaced by facts: srvCreated equal to
//      the value first stored for that row (carried), srvModified at or after
//      srvCreated, srvModified changed by this step;
//   N3 the reply's and the read's srvCreated/srvModified are removed, and an
//      API v3 reply's lastModified (the server clock at the write);
//   N4 a v1 read is compared as a multiset;
//   N5 a stored MongoDB ObjectId _id is compared as its 24-hex string;
//   N6 object keys are compared in sorted order.
//
// Shapes asserted (each was found by lane INC-P, read-derived):
//   PG-MERGE-AMBIGUOUS  a v1 entries re-send whose sysTime + type reaches two
//     live entries: official/dev's bulk updateOne ($set, upsert) updates the
//     first record MongoDB finds, which for records equal in the indexed
//     fields is insertion order (the earliest stored); the reply's _id is the
//     last of an unsorted read of the key (assignStoredEntryIds), the latest
//     stored. The candidate merged into every matched row and refused the
//     write (500 'ambiguous merge upsert filter'). Its control: a pick by
//     lowest _id differs in the scenario whose earlier entry carries the
//     higher _id; a pick of the latest stored differs in three scenarios.
//   PG-MERGE-SEED-NE  (found here) a v1 entries re-send whose sysTime + type
//     reaches only soft-deleted entries: on-deleted restricts the filter to
//     live records (softDeleted.visible, `isValid: {$ne: false}`), and the
//     upsert inserts. MongoDB seeds the new document from the equality
//     clauses only; the candidate refused the `$ne` (500 'upsert insertion
//     requires conjunctive equality filter').
//   device status and profile v1 (ports without insertion order): re-send by
//     identifier and by _id, a soft-deleted target, profile save. Neither
//     write reaches several rows by an unsorted filter (their targets are an
//     _id, or an identifier read with a sort); asserted, no shape found.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { MongoClient } = require('mongodb');
const { optInSuite } = require('./support/opt-in');

const TREE = process.env.NS_OFFICIAL_DEV_TREE;
const MONGO = process.env.NS_PARITY_MONGO_URI || process.env.CUSTOMCONNSTR_mongo;
const REPORT = process.env.NS_PARITY_REPORT;
const SUBJECT_NAME = 'Synthetic Viewer 0';
const LOGICALS = ['entries', 'devicestatus', 'profile'];
const sha1 = value => crypto.createHash('sha1').update(value).digest('hex');

const T0 = Date.UTC(2026, 10, 20);
const ms = k => T0 + k * 300000;
const at = k => new Date(ms(k)).toISOString();
const hex = n => n.toString(16).padStart(24, '0');
const CLIENT_HEX = new Set();
const sent = value => { CLIENT_HEX.add(value); return value; };

// Synthetic records.
const sgv = (k, value, extra = {}) => ({ type: 'sgv', sgv: value, date: ms(k), dateString: at(k), device: 'synthetic-cgm', direction: 'Flat', ...extra });
const v3sgv = (k, value, identifier) => ({ ...sgv(k, value), sysTime: at(k), utcOffset: 0, identifier, app: 'synthetic-uploader' });
const status = (k, extra = {}) => ({ device: 'synthetic-pump', created_at: at(k), pump: { reservoir: 100 - k }, uploaderBattery: 90 - k, ...extra });
const profile = (start, extra = {}) => ({ defaultProfile: 'Default', startDate: start, created_at: start, units: 'mg/dl',
  store: { Default: { dia: 4, carbratio: [{ time: '00:00', value: 10 }], sens: [{ time: '00:00', value: 50 }], timezone: 'UTC' } }, ...extra });

const v1 = (logical, method, body) => ({ v: 1, logical, method, path: '/api/v1/' + logical, body });
const v3post = (logical, body) => ({ v: 3, logical, method: 'POST', path: '/api/v3/' + logical, body });
const del = (logical, refStored) => ({ v: 3, logical, method: 'DELETE', refStored });
const reads = {
  entries: { v: 1, logical: 'entries', method: 'GET', path: '/api/v1/entries.json?count=100&find[date][$gte]=0', read: true },
  devicestatus: { v: 1, logical: 'devicestatus', method: 'GET', path: '/api/v1/devicestatus.json?count=100', read: true },
  profile: { v: 1, logical: 'profile', method: 'GET', path: '/api/v1/profile.json', read: true }
};

// Each scenario starts from empty collections.
const SCENARIOS = {
  'entries: a v1 re-send whose sysTime + type reaches two live entries': [
    // Two live entries on one sysTime + type: API v3 records carrying
    // different identifiers (v3 matches a fallback only on a record without
    // an identifier, so the second is a record of its own).
    v3post('entries', v3sgv(0, 100, 'v3-entry-a')),
    v3post('entries', v3sgv(0, 101, 'v3-entry-b')),
    v1('entries', 'POST', [sgv(0, 105)]),
    v1('entries', 'POST', [sgv(0, 106), sgv(1, 120)]),
    v1('entries', 'POST', [sgv(0, 106, { direction: 'FortyFiveUp' }), sgv(1, 121)]),
    reads.entries
  ],
  'entries: three live entries on one key, then the identifier of the latest': [
    v1('entries', 'POST', [sgv(2, 110, { identifier: 'entry-id-2' })]),
    v3post('entries', v3sgv(2, 111, 'v3-entry-c')),
    v3post('entries', v3sgv(2, 112, 'v3-entry-d')),
    v1('entries', 'POST', [sgv(2, 113)]),
    v1('entries', 'POST', [sgv(2, 114, { identifier: 'v3-entry-d' })]),
    v1('entries', 'POST', [sgv(2, 115)]),
    reads.entries
  ],
  // The earlier stored entry carries the higher _id (a client 24-hex _id), so
  // the earliest stored and the lowest _id are different records.
  'entries: the earlier of two entries on one key carries the higher _id': [
    v1('entries', 'POST', [sgv(6, 140, { _id: sent('f'.repeat(24)), identifier: 'entry-id-6' })]),
    v3post('entries', v3sgv(6, 141, 'v3-entry-e')),
    v1('entries', 'POST', [sgv(6, 142)]),
    v1('entries', 'POST', [sgv(6, 143), sgv(7, 150)]),
    reads.entries
  ],
  'entries: re-send after soft delete': [
    v1('entries', 'POST', [sgv(3, 130), sgv(4, 131), sgv(5, 132, { identifier: 'entry-id-5' })]),
    del('entries', 0),
    del('entries', 2),
    // sysTime + type of a deleted entry: stored beside it (live only); the
    // identifier of a deleted entry: acknowledged, stays deleted.
    v1('entries', 'POST', [sgv(3, 133), sgv(4, 134), sgv(5, 135, { identifier: 'entry-id-5' })]),
    del('entries', 3),
    v1('entries', 'POST', [sgv(3, 136)]),
    v1('entries', 'POST', [sgv(3, 137)]),
    reads.entries
  ],
  'device status: identifier, _id and soft-deleted re-sends': [
    v1('devicestatus', 'POST', [status(0, { identifier: 'ds-id-0' }), status(1), status(2, { _id: sent(hex(0xd5d2)) })]),
    v1('devicestatus', 'POST', [status(0, { identifier: 'ds-id-0', uploaderBattery: 50 }), status(1), status(2, { _id: sent(hex(0xd5d2)) })]),
    v1('devicestatus', 'POST', [status(3, { identifier: 'ds-id-3' }), status(3, { identifier: 'ds-id-3', uploaderBattery: 1 })]),
    del('devicestatus', 0),
    v1('devicestatus', 'POST', [status(0, { identifier: 'ds-id-0', uploaderBattery: 40 }), status(1)]),
    v1('devicestatus', 'POST', [status(4, { _id: sent(hex(0xd5d4)), identifier: 'ds-id-3' })]),
    reads.devicestatus
  ],
  'profile: _id and identifier re-sends, save, soft delete': [
    v1('profile', 'POST', [profile(at(0), { _id: sent(hex(0xf0f0)) })]),
    v1('profile', 'POST', [profile(at(0), { _id: sent(hex(0xf0f0)), units: 'mmol' })]),
    v1('profile', 'POST', [profile(at(1), { identifier: 'profile-id-a' })]),
    v1('profile', 'POST', [profile(at(1), { identifier: 'profile-id-a', defaultProfile: 'Other' })]),
    v1('profile', 'POST', [profile(at(2), { identifier: 'profile-id-a' })]),
    { v: 1, logical: 'profile', method: 'PUT', path: '/api/v1/profile', body: { ref: 0, change: { units: 'mg/dl', notes: 'saved' } } },
    del('profile', 0),
    v1('profile', 'POST', [profile(at(0), { _id: sent(hex(0xf0f0)), units: 'mmol' })]),
    { v: 1, logical: 'profile', method: 'PUT', path: '/api/v1/profile', body: { ref: 0, change: { notes: 'saved after delete' } } },
    del('profile', 1),
    v1('profile', 'POST', [profile(at(1), { identifier: 'profile-id-a', defaultProfile: 'Third' })]),
    reads.profile
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

// Shipping single tenant, from the scratch tree, WRITE_* at defaults.
function official () {
  const secret = 'synthetic-parity-secret-' + crypto.randomBytes(8).toString('hex');
  const db = 'parity_v1_official_' + crypto.randomBytes(6).toString('hex');
  const side = { name: 'official' };
  let child, mongo, port, token;
  side.open = async function () {
    port = await freePort();
    const uri = new URL(MONGO);
    uri.pathname = '/' + db;
    child = spawn(process.execPath, [path.join(TREE, 'lib/server/server.js')], { cwd: TREE, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'UTC', NODE_ENV: 'production', CUSTOMCONNSTR_mongo: uri.toString(),
        API_SECRET: secret, HOSTNAME: '127.0.0.1', PORT: String(port), INSECURE_USE_HTTP: 'true', AUTH_DEFAULT_ROLES: 'denied',
        ENABLE: 'careportal' } });
    let out = '';
    child.stdout.on('data', b => { out += b; });
    child.stderr.on('data', b => { out += b; });
    const deadline = Date.now() + 60000;
    while (!/Listening on port/.test(out)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('official did not start: ' + out.slice(-2000));
      await delay(200);
    }
    for (;;) {
      try { if ((await request(port, 'GET', '/api/v1/status.json')).status < 500) break; } catch { /* not listening yet */ }
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('official did not answer: ' + out.slice(-2000));
      await delay(200);
    }
    mongo = new MongoClient(uri.toString());
    await mongo.connect();
    const auth = { 'api-secret': sha1(secret) };
    const created = await request(port, 'POST', '/api/v2/authorization/subjects', { name: SUBJECT_NAME, roles: ['admin'] }, auth);
    assert.ok(created.status < 300, JSON.stringify(created));
    const subjects = await request(port, 'GET', '/api/v2/authorization/subjects', undefined, auth);
    const accessToken = subjects.body.find(s => s.name === SUBJECT_NAME).accessToken;
    token = (await request(port, 'GET', '/api/v2/authorization/request/' + accessToken)).body.token;
    assert.ok(token, 'official v3 token');
  };
  side.prepare = async () => { for (const logical of LOGICALS) await mongo.db().collection(logical).deleteMany({}); };
  side.call = (step, body) => request(port, step.method, step.path, body,
    step.v === 3 ? { Authorization: 'Bearer ' + token } : { 'api-secret': sha1(secret) });
  side.rows = async logical => (await mongo.db().collection(logical).find({}).toArray()).map(doc => {
    const kind = doc._id && doc._id._bsontype === 'ObjectId' ? 'objectid' : 'string';
    return { kind, doc: JSON.parse(JSON.stringify({ ...doc, _id: String(doc._id) })) };
  });
  side.close = async () => {
    if (mongo) { await mongo.db().dropDatabase().catch(() => {}); await mongo.close(); }
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  };
  return side;
}

// The candidate: this tree's multitenant api role on PostgreSQL.
function candidate (lab, { late, keyed }) {
  const side = { name: 'candidate/late-stamp-' + (late ? 'on' : 'off') + '/keyed-' + (keyed ? 'on' : 'off') };
  let worker, token;
  const tables = {}, ordered = {};
  side.open = async function () {
    const { layout } = require('../lib/server/serve/deployment-settings');
    const ns = layout({ NS_PG_PREFIX: lab.platform.prefix }).namespaces;
    for (const logical of LOGICALS) {
      tables[logical] = ns[logical] + '.' + logical;
      ordered[logical] = (await lab.admin.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2
        AND column_name = 'insertion_ordinal'`, [ns[logical], logical])).rowCount === 1;
    }
    side.ordered = { ...ordered };
  };
  async function start () {
    if (worker) await lab.stop(worker);
    const fresh = (await lab.operatorVault('auth/token/create', { policies: ['preview-api'], no_default_policy: true, ttl: '15m', renewable: false })).auth.client_token;
    worker = lab.start(undefined, { NS_VAULT_TOKEN: fresh, NS_CLOCK_LATE_STAMP: late ? '1' : '0', NS_TREATMENT_KEY_UPSERT: keyed ? '1' : '0' });
    await lab.ready(worker);
    token = (await lab.exchange(worker, lab.tenants[0])).body.token;
    assert.ok(token, 'candidate v3 token');
  }
  side.prepare = async function () {
    for (const logical of LOGICALS) await lab.admin.query(`DELETE FROM ${tables[logical]} WHERE tenant_id = $1`, [lab.tenants[0]]);
    await start();
  };
  side.call = async (step, body) => {
    const mark = worker.stdout.length + worker.stderr.length;
    const reply = await lab.http(worker, lab.tenants[0], step.method, step.path, step.v === 3 ? token : undefined, body,
      step.v === 3 ? {} : { 'api-secret': lab.rootCredential(lab.tenants[0]) });
    if (reply.status >= 500 && process.env.NS_PARITY_VERBOSE === '1') console.log('CANDIDATE_500 ' + side.name + ' ' + (worker.stdout + worker.stderr).slice(mark - 200).slice(-3000));
    return reply;
  };
  side.rows = async logical => (await lab.admin.query(`SELECT id_kind, doc FROM ${tables[logical]} WHERE tenant_id = $1 ORDER BY ${ordered[logical] ? 'insertion_ordinal' : 'id_kind, "_id"'}`,
    [lab.tenants[0]])).rows.map(row => ({ kind: row.id_kind, doc: row.doc }));
  side.close = async () => { if (worker) await lab.stop(worker); worker = null; };
  return side;
}

// One scenario on one side: the observation compared across sides.
async function run (side, scenario) {
  await side.prepare(scenario);
  const labels = new Map(), firstCreated = new Map(), lastModified = new Map();
  const label = id => {
    if (typeof id !== 'string' || CLIENT_HEX.has(id) || !/^[0-9a-f]{24}$/.test(id)) return id;
    if (!labels.has(id)) labels.set(id, 'server#' + labels.size);
    return labels.get(id);
  };
  const scrub = value => {
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).filter(([k]) => !['srvCreated', 'srvModified', 'lastModified'].includes(k)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([k, v]) => [k, scrub(v)]));
    }
    return label(value);
  };
  const logicals = [...new Set(scenario.map(step => step.logical))];
  const observed = [];
  for (const step of scenario) {
    let body = step.body;
    if (step.body && step.body.ref !== undefined) {
      // A PUT of a stored record (as its client holds it) with a change.
      const target = (await side.rows(step.logical))[step.body.ref].doc;
      body = { ...target, ...step.body.change };
      delete body.srvCreated; delete body.srvModified;
    }
    let resource = step.path;
    // A row missing on one side (an earlier step diverged) is deleted as
    // `missing` (a 404), recorded as a difference rather than thrown. API v3
    // addresses a record by its identifier, else its _id.
    if (step.method === 'DELETE') {
      const target = (await side.rows(step.logical))[step.refStored]?.doc;
      resource = '/api/v3/' + step.logical + '/' + (target ? target.identifier || target._id : 'missing');
    }
    const reply = await side.call({ ...step, path: resource }, body);
    const rows = {};
    for (const logical of logicals) {
      rows[logical] = await side.rows(logical);
      rows[logical].forEach(row => label(row.doc._id));
    }
    observed.push({
      step: step.method + ' ' + (step.v === 3 ? 'v3' : 'v1') + ' ' + step.logical,
      reply: { status: reply.status, body: step.read && Array.isArray(reply.body)
        ? scrub(reply.body).map(doc => JSON.stringify(doc)).sort() : scrub(reply.body) },
      rows: Object.fromEntries(logicals.map(logical => [logical, rows[logical].map(({ kind, doc }) => {
        const id = logical + ':' + String(doc._id);
        if (!firstCreated.has(id)) firstCreated.set(id, doc.srvCreated);
        const changed = lastModified.has(id) ? lastModified.get(id) !== doc.srvModified : 'new';
        lastModified.set(id, doc.srvModified);
        const { srvCreated, srvModified, ...rest } = doc;
        return { kind, doc: scrub(rest), carried: srvCreated === firstCreated.get(id),
          ordered: typeof srvModified === 'number' && typeof srvCreated === 'number' && srvModified >= srvCreated, changed };
      })]))
    });
  }
  return observed;
}

function differences (a, b, where = '', out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[key], b[key], where + '/' + key, out);
    return out;
  }
  out.push({ at: where, official: a, candidate: b });
  return out;
}

function divergence (diffs, observedOfficial, observedCandidate) {
  const step = Math.min(...diffs.map(d => Number(d.at.split('/')[1])));
  const o = observedOfficial[step], c = observedCandidate[step];
  const description = c && c.reply.body && c.reply.body.description;
  // The reply does not say which refusal; the worker log does (NS_PARITY_VERBOSE=1).
  const name = o && c && o.reply.status < 300 && c.reply.status === 500 && description && description.unsupported === true
    ? 'PG-UNSUPPORTED' : null;
  return { step, name };
}

optInSuite(process.env.NS_V1_RESEND_PARITY_TEST === '1' && !!TREE && !!MONGO,
  'NS_V1_RESEND_PARITY_TEST=1, NS_OFFICIAL_DEV_TREE (a scratch tree of official/dev) and NS_PARITY_MONGO_URI or CUSTOMCONNSTR_mongo (disposable MongoDB), Docker')(
  'v1 entries, device status and profile re-sends: outcome parity with official/dev (INC-P2)', function () {
    this.timeout(900000);
    const lab = require('./fixtures/multitenant-preview-replicas')();
    const report = { official: TREE && fs.existsSync(path.join(TREE, 'SOURCE_COMMIT')) ? fs.readFileSync(path.join(TREE, 'SOURCE_COMMIT'), 'utf8').trim() : null,
      scenarios: {} };
    const sides = {};
    const ARMS = ['candidateDefault', 'lateOn', 'lateKeyedOn'];
    before(async function () {
      await lab.setup();
      const { layout } = require('../lib/server/serve/deployment-settings');
      const ns = layout({ NS_PG_PREFIX: lab.platform.prefix }).namespaces;
      const permissions = LOGICALS.flatMap(logical => ['read', 'create', 'update', 'delete'].map(action => 'api:' + logical + ':' + action));
      await lab.admin.query(`UPDATE ${ns.authorization}.tenant_authorization_roles SET permissions=$1 WHERE tenant_id=$2 AND name='viewer'`,
        [permissions, lab.tenants[0]]);
      report.postgres = (await lab.admin.query('SHOW server_version')).rows[0].server_version;
      for (const [name, side] of Object.entries({
        official: official(),
        candidateDefault: candidate(lab, { late: false, keyed: false }),
        lateOn: candidate(lab, { late: true, keyed: false }),
        lateKeyedOn: candidate(lab, { late: true, keyed: true })
      })) { sides[name] = side; await side.open(); }
      report.insertionOrdered = sides.candidateDefault.ordered;
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

    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      it(name, async function () {
        const reference = await run(sides.official, scenario);
        const entry = report.scenarios[name] = { official: reference, arms: {} };
        // The corpus is exercised, not vacuous: every write official/dev
        // answers is answered below 300.
        const refused = reference.filter(o => o.reply.status >= 300).map(o => o.step + ' ' + o.reply.status);
        assert.deepEqual(refused, [], 'official/dev refused a corpus step: ' + JSON.stringify(reference.filter(o => o.reply.status >= 300).map(o => o.reply)));
        for (const arm of ARMS) {
          const observed = await run(sides[arm], scenario);
          const diffs = differences(reference, observed);
          entry.arms[arm] = { equal: !diffs.length, diverged: diffs.length ? divergence(diffs, reference, observed) : null,
            differences: diffs.length ? diffs.slice(0, 20) : undefined, observed: diffs.length ? observed : undefined };
        }
        console.log('PARITY ' + JSON.stringify({ name, arms: Object.fromEntries(Object.entries(entry.arms).map(([k, v]) =>
          [k, v.equal ? 'equal' : (v.diverged.name || 'differs') + ' from step ' + v.diverged.step])) }));
        for (const arm of ARMS) {
          const d = entry.arms[arm].diverged;
          assert.ok(entry.arms[arm].equal, arm + ' differs from official/dev' + (d ? ' (' + (d.name || 'first') + ' at step ' + d.step + ')' : '') +
            ': ' + JSON.stringify(entry.arms[arm].differences));
        }
      });
    }
  });
