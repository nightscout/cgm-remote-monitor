'use strict';

// Spike S1b: the level window read returns exactly the rows single-tenant
// Nightscout's MongoDB queries return for the same window. The reference is
// built from the dataloader's own query objects (rawQuery, profileSwitchQuery,
// latestSingleQuery, each behind softDeleted.visible, as the single-tenant
// list() functions apply it) and evaluated by an independent matcher with
// MongoDB's rules: type-bracketed comparison (a numeric bound matches only
// numbers, a string bound only strings, bytewise), any array element matches,
// $ne is the negation of $eq. The window includes every row the find matches;
// single tenant's count: 1 reads are then a subset of it.
// Synthetic data only, on a disposable database (NS_S1_LEVEL_TEST=1).
const assert = require('node:assert/strict');
const createLab = require('./fixtures/s1-level-lab');
const { optInSuite } = require('./support/opt-in');
const loader = require('../lib/data/dataloader');
const softDeleted = require('../lib/server/soft-deleted');
const durableReplay = require('../lib/storage/postgres-durable-replay');
const policyOf = require('../lib/storage/clinical-working-set-policy');
const connect = require('../lib/storage/postgres-connection');
const scope = require('../lib/storage/tenant-scope');

const DAY = 86400000, HOUR = 3600000;
const EVENTS = ['Sensor Start', 'Sensor Change', 'Sensor Stop', 'Site Change', 'Insulin Change', 'Pump Battery Change'];

// ---- independent MongoDB-semantics reference (no postgres-filter code)
function bracket (a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  return null;
}
function leaf (value, op, bound) {
  const one = v => { const c = bracket(v, bound); return c !== null && (op === '$gte' ? c >= 0 : op === '$lte' ? c <= 0 : c === 0); };
  return Array.isArray(value) ? value.some(one) : value !== undefined && one(value);
}
function matches (doc, find) {
  return Object.entries(find).every(([field, cond]) => {
    if (field === '$and') return cond.every(part => matches(doc, part));
    const ops = cond && typeof cond === 'object' && !Array.isArray(cond) ? cond : { $eq: cond };
    return Object.entries(ops).every(([op, bound]) => op === '$ne' ? !leaf(doc[field], '$eq', bound) : leaf(doc[field], op, bound));
  });
}
function singleTenantFinds (at, env) {
  const ctx = { cache: { isEmpty: () => true } }, last = { lastUpdated: at };
  const list = find => softDeleted.visible(find);
  return {
    entries: [list(loader.rawQuery('entries', last, ctx, env).find)],
    devicestatus: [list(loader.rawQuery('devicestatus', last, ctx, env).find)],
    treatments: [list(loader.rawQuery('treatments', last, ctx, env).find), list(loader.profileSwitchQuery(at).find),
      ...EVENTS.map(event => list(loader.latestSingleQuery(at, event).find))]
  };
}

// ---- adversarial synthetic rows around every bound
function rows (at) {
  const iso = ms => new Date(ms).toISOString(), noMillis = ms => iso(ms).replace(/\.\d{3}Z$/, 'Z');
  const e = at - 2 * DAY, d = at - DAY, t = at - 60 * HOUR, age = at - 62 * DAY, sw = at - 372 * DAY;
  return {
    entries: {
      in: { date: at - HOUR }, atBound: { date: e }, below: { date: e - 1 }, fracBelow: { date: e - 0.5 }, fracAbove: { date: e + 0.5 },
      huge: { date: 1e300 }, negHuge: { date: -1e300 }, stringDate: { date: iso(at) }, arrayNew: { date: [e - DAY, at] }, arrayOld: { date: [e - DAY] },
      arrayStrings: { date: [iso(at)] }, missing: {}, nullDate: { date: null }, deleted: { date: at, isValid: false },
      deletedArray: { date: at, isValid: [false, true] }, validString: { date: at, isValid: 'false' }, validTrue: { date: at, isValid: true }
    },
    devicestatus: {
      in: { created_at: iso(at - HOUR) }, atBound: { created_at: iso(d) }, below: { created_at: iso(d - 1) },
      // String order, not time order: '...SSZ' sorts after '...SS.mmmZ' in the same second.
      sameSecondNoMillis: { created_at: noMillis(d) }, previousSecondNoMillis: { created_at: noMillis(d - 1000) },
      offset: { created_at: iso(d).replace('Z', '+01:00') }, lexical: { created_at: 'z' }, numeric: { created_at: at },
      arrayNew: { created_at: [iso(d - DAY), iso(at)] }, arrayOld: { created_at: [iso(d - DAY)] }, missing: {}, deleted: { created_at: iso(at), isValid: false }
    },
    treatments: {
      recent: { eventType: 'Meal Bolus', created_at: iso(at - HOUR) }, recentNoType: { created_at: iso(t) }, oldBolus: { eventType: 'Meal Bolus', created_at: iso(t - 1) },
      siteIn: { eventType: 'Site Change', created_at: iso(age + HOUR) }, siteOut: { eventType: 'Site Change', created_at: iso(age - HOUR) },
      sensorIn: { eventType: 'Sensor Start', created_at: iso(age) }, batteryNoMillis: { eventType: 'Pump Battery Change', created_at: noMillis(age) },
      switchIn: { eventType: 'Profile Switch', duration: 0, created_at: iso(sw + DAY) }, switchDuration: { eventType: 'Profile Switch', duration: 30, created_at: iso(sw + DAY) },
      switchStringDuration: { eventType: 'Profile Switch', duration: '0', created_at: iso(sw + DAY) }, switchOut: { eventType: 'Profile Switch', duration: 0, created_at: iso(sw - DAY) },
      typeArray: { eventType: ['Note', 'Site Change'], created_at: iso(age + DAY) }, typeArrayOut: { eventType: ['Note'], created_at: iso(age + DAY) },
      createdArray: { eventType: 'Insulin Change', created_at: [iso(sw), iso(age + DAY)] }, missingType: { created_at: iso(age + DAY) },
      deletedSite: { eventType: 'Site Change', created_at: iso(at - DAY), isValid: false }
    }
  };
}

optInSuite(process.env.NS_S1_LEVEL_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI, 'NS_S1_LEVEL_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')('spike S1b: window rows equal single-tenant MongoDB rows', function () {
  this.timeout(120000);
  let lab, connection, replay;
  before(async () => {
    lab = createLab({ tenants: 2 }); await lab.open();
    connection = await connect({ connectionString: lab.evaluatorURI, max: 2, statement_timeout: 10000 });
    replay = durableReplay({ connection, checkpointTable: lab.base.replayNamespace + '.tenant_consumer_checkpoint',
      clockTable: lab.base.namespaces.clock + '.tenant_write_clock', domains: lab.base.tables, consumer: 'clinical-level',
      projectionVersion: 'clinical-current-rows-v1', pageSize: 100, maxRows: 10000, level: { lifecycleTable: lab.lifecycleTable.replace(/"/g, '') } });
  });
  after(async () => { await connection?.close?.(); await lab?.close(); });

  it('reads every windowed table by its stored time column only, bounded by an index', () => {
    const policy = policyOf.create(lab.base.env, Date.now());
    for (const domain of ['entries', 'devicestatus', 'treatments']) assert.equal(policyOf.bounded(domain, policy), true, domain);
  });

  it('returns exactly the single-tenant MongoDB rows, and nothing of another tenant', async () => {
    const at = Date.now(), [tenant, other] = lab.tenants, data = rows(at);
    for (const [owner, prefix] of [[tenant, ''], [other, 'other-']]) {
      await lab.admin.query('BEGIN');
      await lab.admin.query("SELECT set_config('app.current_tenant_id',$1,true)", [owner]);
      for (const [domain, docs] of Object.entries(data)) {
        for (const [id, doc] of Object.entries(docs)) {
          await lab.admin.query(`INSERT INTO "${lab.base.namespaces[domain]}"."${domain}"(tenant_id,id_kind,doc) VALUES ($1,'string',$2::jsonb)`,
            [owner, JSON.stringify({ _id: prefix + id, ...doc })]);
        }
      }
      await lab.admin.query('COMMIT');
    }
    const policy = policyOf.create(lab.base.env, at);
    const read = await scope.withTenant(tenant, () => replay.window({ maxRows: 10000, maxBytes: 8388608, policy }));
    const finds = singleTenantFinds(at, lab.base.env), actual = {}, expected = {};
    for (const domain of Object.keys(data)) {
      expected[domain] = Object.entries(data[domain]).filter(([id, doc]) => finds[domain].some(find => matches({ _id: id, ...doc }, find))).map(([id]) => id).sort();
      actual[domain] = read.rows.filter(row => row.domain === domain).map(row => row.document._id).sort();
      assert.ok(expected[domain].length > 2, domain + ' reference is not vacuous');
    }
    assert.deepEqual(actual, expected);
  });
});
