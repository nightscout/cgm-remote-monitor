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

  it('reuses matching normalized rows while tracking writes, expiry and bounded recovery', async () => {
    await lab.reset();
    const [tenant, other] = lab.tenants;
    let at = Date.now();
    const anchor = at;
    const iso = millis => new Date(millis).toISOString();
    const treatment = (_id, eventType, age, fields = {}) =>
      ({ _id, eventType, created_at: iso(anchor - age), ...fields });
    const status = (_id, age, battery) =>
      ({ _id, created_at: iso(anchor - age), device: _id, uploader: { battery } });
    const stable = lab.sgv('stable', 120, at - 120000);
    await lab.writeDocs(tenant, 'entries', [stable, lab.sgv('edge', 110, at - 2 * DAY + 1000)]);
    await lab.writeDocs(other, 'entries', [lab.sgv('stable', 210, stable.date)]);
    await lab.writeDocs(tenant, 'treatments', [
      treatment('recent', 'Meal Bolus', 60 * HOUR - 1000, { carbs: 10 }),
      treatment('site', 'Site Change', 4 * DAY), treatment('older-site', 'Site Change', 20 * DAY),
      treatment('switch', 'Profile Switch', 100 * DAY, { duration: 0, profile: 'Default' }),
      treatment('older-switch', 'Profile Switch', 300 * DAY, { duration: 0, profile: 'Default' })
    ]);
    await lab.writeDocs(tenant, 'devicestatus', [status('one-day', DAY - 1000, 50), status('two-day', 36 * HOUR, 75)]);
    let env = lab.base.env;
    const component = (owner = tenant) => lab.base.evaluator(owner, { env, connection, replay, includeFrame: true });
    let resident = component();
    // Observe references without adding a measurement API to the product.
    const context = require('node:test').mock.method(require('../lib/data/private-acquisition'), 'createContext');
    let history;
    async function compare (operation = 'evaluate') {
      const cold = component();
      try {
        return await lab.base.at(at, async () => {
          context.mock.resetCalls();
          const actual = await resident[operation]({ at });
          history = context.mock.calls.map(call => call.arguments[1]).find(Boolean);
          const expected = await cold.evaluate({ at });
          const clinical = r => [r.frame, r.properties, r.emitted, r.requested, r.due, r.generation, r.checkpoint, r.signature];
          assert.equal(JSON.stringify(clinical(actual)), JSON.stringify(clinical(expected)), 'warm output and alarm timing equal a bounded rebuild');
          return actual.frame;
        });
      } finally { cold.close(); }
    }
    const ids = rows => rows.map(row => row._id);
    const stableRow = () => [...history.current.values()].find(row => row._id === 'stable');
    try {
      const first = await compare();
      assert.deepEqual(ids(first.sgvs), ['edge', 'stable']);
      assert.deepEqual(ids(first.devicestatus), ['one-day']);
      assert.deepEqual(ids(first.treatments), ['switch', 'site', 'recent']);
      const original = stableRow();
      assert.ok(original);
      const [source, normalized] = [...history.current].find(([doc]) => doc._id === 'one-day');
      assert.equal(normalized.uploader, source.uploader, 'the normalized row shares the immutable snapshot subtree');
      assert.ok(Object.isFrozen(source.uploader));
      assert.notEqual(first.devicestatus[0].uploader, source.uploader, 'the plugin frame owns its mutable document');

      const peer = component(other);
      try {
        const independent = await lab.base.at(at, () => peer.evaluate({ at }));
        assert.deepEqual(independent.frame.sgvs.map(x => x.mgdl), [210]);
      } finally { peer.close(); }
      await lab.writeDocs(tenant, 'entries', [lab.sgv('ordinary', 125, at - 30000), lab.sgv('late', 119, at - HOUR)]);
      let frame = await compare();
      assert.deepEqual(ids(frame.sgvs), ['edge', 'late', 'stable', 'ordinary']);
      assert.equal(stableRow(), original, 'an unchanged row is the same normalized object across acquisitions');

      await lab.writeDocs(tenant, 'entries', [{ ...stable, sgv: 175 }]);
      await lab.writeDocs(tenant, 'devicestatus', [status('one-day', DAY - 1000, 33)]);
      frame = await compare();
      assert.notEqual(stableRow(), original, 'editing the same ID requires a fresh normalization');
      assert.equal(frame.sgvs.find(r => r._id === 'stable').mgdl, 175);
      assert.equal(frame.devicestatus[0].uploader.battery, 33);
      frame.devicestatus[0].uploader.battery = 0;

      for (const id of ['site', 'switch']) await lab.hardDelete(tenant, 'treatments', id);
      await lab.hardDelete(tenant, 'entries', 'ordinary');
      frame = await compare();
      assert.deepEqual(ids(frame.treatments), ['older-switch', 'older-site', 'recent']);
      assert.equal(frame.sgvs.at(-1)._id, 'stable');
      assert.equal(frame.devicestatus[0].uploader.battery, 33);

      at += 1001;
      frame = await compare('evaluateTime');
      assert.deepEqual(ids(frame.sgvs), ['late', 'stable']);
      assert.deepEqual(ids(frame.treatments), ['older-switch', 'older-site']);
      assert.deepEqual(frame.devicestatus, []);

      env = require('../lib/server/tenant-app/environment')({ settings: lab.base.env.settings, extendedSettings: { devicestatus: { days: 2 } } });
      resident.reconfigure({ env });
      frame = await compare('evaluateTime');
      assert.deepEqual(ids(frame.devicestatus), ['two-day', 'one-day']);
      assert.ok(!history.previous, 'settings rebuild the configured window');
      resident.evict();
      await assert.rejects(resident.evaluateTime({ at }), /no successful retained input/);
      await compare();
      assert.ok(!history.previous, 'eviction drops the row history');
      const generation = await lab.restore(tenant, { removeEntriesAfter: anchor - HOUR });
      frame = await compare();
      assert.equal(resident.last().generation, generation);
      assert.deepEqual(ids(frame.sgvs), ['late']);
      assert.ok(!history.previous, 'a restore generation starts with a bounded rebuild');
      resident.close();
      resident = component();
      await compare();
      assert.ok(!history.previous, 'restart reads the database window');
    } finally { context.mock.restore(); resident.close(); }
  });
});
