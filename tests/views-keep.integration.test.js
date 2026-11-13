'use strict';

// Evaluator cost lane, candidate B: a kept working set re-cut at a later
// instant must equal a fresh load at that instant.
//
// One synthetic projection whose documents cross every window the loader
// applies while the test runs: device status leaving the 24 h window and the
// cache's 24 h retention, treatments leaving 60 h, readings leaving 48 h, a
// profile switch dated in the future becoming "before now", and the newest
// device-change event leaving its 62-day bound. At each instant the kept view
// (opts.keep) and a fresh view (no keep) materialise from the same projection
// reads on actual PostgreSQL; the working sets must be deep-equal (undefined
// members, key order and NaN included) and so must the plugin outputs. The
// wall clock is pinned at the instant and, in a second pass, a few seconds
// after it, as when an evaluation runs late. Both reuse and reloads must have
// happened, or the comparison proves nothing.
const assert = require('node:assert/strict');
const util = require('node:util');
const createLab = require('./fixtures/tenant-projection-evaluator');
const evaluator = require('../lib/data/tenant-projection-evaluator');
const projectionRead = require('../lib/storage/postgres-projection-read');
const viewsFactory = require('../lib/data/views');
const scope = require('../lib/storage/tenant-scope');
const clock = require('./lib/views-replay/clock');
const { optInSuite } = require('./support/opt-in');

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const iso = ms => new Date(ms).toISOString();

function projection (t0) {
  const entries = [], treatments = [], devicestatus = [];
  // Readings every 5 min over 48 h, so one leaves the window every 5 min.
  for (let at = t0 - 2 * DAY + 20000; at <= t0; at += 5 * MIN) {
    entries.push({ _id: 'sgv-' + at, type: 'sgv', sgv: 100 + Math.round(40 * Math.sin(at / HOUR)), date: at, dateString: iso(at), direction: 'Flat' });
  }
  // Device status every 50 s near the 24 h edge, in four forms, and fresh ones.
  for (let k = 0; k < 40; k++) {
    const at = t0 - DAY + 5000 + k * 50000;
    const loop = { timestamp: iso(at), iob: { iob: 0.5, timestamp: iso(at) }, predicted: { startDate: iso(at), values: [110, 112] },
      enacted: { timestamp: iso(at), rate: 1, duration: 30, received: true } };
    const forms = [{ created_at: iso(at), loop }, { created_at: iso(at).replace('.000Z', 'Z'), uploader: { battery: 50 } },
      { created_at: iso(at).replace('Z', '+00:00'), pump: { clock: iso(at), reservoir: 50 } }, { created_at: iso(at), uploaderBattery: 40, mills: at }];
    devicestatus.push({ _id: 'ds-' + k, device: 'synthetic-' + (k % 2), ...forms[k % 4] });
  }
  for (let at = t0 - 30 * MIN; at <= t0; at += 5 * MIN) {
    devicestatus.push({ _id: 'ds-now-' + at, device: 'synthetic-0', created_at: iso(at), loop: { timestamp: iso(at), iob: { iob: 1, timestamp: iso(at) } },
      pump: { clock: iso(at), reservoir: 40, battery: { percent: 70 } }, uploader: { battery: 60 } });
  }
  // Treatments near the 60 h edge (some with durations), and recent ones.
  for (let k = 0; k < 12; k++) {
    const at = t0 - 60 * HOUR + 15000 + k * 37000;
    treatments.push({ _id: 'tr-' + k, created_at: iso(at), eventType: ['Meal Bolus', 'Temp Basal', 'Correction Bolus', 'Note'][k % 4],
      insulin: k % 4 === 1 ? undefined : 1, carbs: k % 4 === 0 ? 20 : undefined, duration: k % 4 === 1 ? 30 : undefined, absolute: k % 4 === 1 ? 0.5 : undefined });
  }
  treatments.push({ _id: 'tr-recent', created_at: iso(t0 - 40 * MIN), eventType: 'Meal Bolus', insulin: 3, carbs: 30 });
  // The newest Site Change, 62 days less a few minutes ago; an older one.
  treatments.push({ _id: 'site-edge', created_at: iso(t0 - 62 * DAY + 4 * MIN), eventType: 'Site Change' });
  treatments.push({ _id: 'site-old', created_at: iso(t0 - 70 * DAY), eventType: 'Site Change' });
  // A profile switch dated a few minutes ahead, which becomes "before now".
  treatments.push({ _id: 'switch', created_at: iso(t0 + 3 * MIN), eventType: 'Profile Switch', duration: 0, profile: 'Other' });
  const store = { dia: 3, carbratio: [{ time: '00:00', value: 10 }], sens: [{ time: '00:00', value: 50 }], basal: [{ time: '00:00', value: 1 }],
    target_low: [{ time: '00:00', value: 100 }], target_high: [{ time: '00:00', value: 120 }], timezone: 'UTC', units: 'mg/dl' };
  const profile = [{ _id: 'profile', defaultProfile: 'Default', startDate: iso(t0 - 10 * DAY), created_at: iso(t0 - 10 * DAY), units: 'mg/dl',
    store: { Default: store, Other: { ...store, dia: 4 } } }];
  const strip = doc => JSON.parse(JSON.stringify(doc));
  return { entries: entries.map(strip), treatments: treatments.map(strip), devicestatus: devicestatus.map(strip), profile };
}

const data = ddata => Object.fromEntries(Object.keys(ddata).filter(key => typeof ddata[key] !== 'function').map(key => [key, ddata[key]]));
// Which values are the same object, by path: the loader shares treatments
// between ddata.treatments and the per-kind lists; a copy must too.
function aliases (ddata) {
  const first = new Map(), out = [];
  (function walk (value, path) {
    if (!value || typeof value !== 'object') return;
    if (first.has(value)) { out.push([path, first.get(value)]); return; }
    first.set(value, path);
    for (const key of Object.keys(value)) if (typeof value[key] !== 'function') walk(value[key], path + '.' + key);
  })(data(ddata), '$');
  return out;
}
const output = result => JSON.parse(JSON.stringify({ emitted: result.emitted, requested: result.requested, properties: result.properties }));

optInSuite(process.env.NS_TENANT_PROJECTION_EVALUATOR_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_TENANT_PROJECTION_EVALUATOR_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'evaluator cost lane B: a kept working set equals a fresh load at every instant', function () {
    this.timeout(180000);
    const lab = createLab();
    before(() => lab.open());
    after(() => lab.close());

    for (const skewMs of [0, 2500]) {
      it('EV_COST_B_WINDOW_CUT ' + (skewMs ? 'wall clock ' + skewMs + ' ms after the instant' : 'wall clock at the instant'), async function () {
        const t0 = Date.UTC(2026, 10, 6, 12);
        const docs = projection(t0);
        const env = require('../lib/server/tenant-app/environment')({ settings: { enable: ['bgnow', 'delta', 'direction', 'timeago',
          'iob', 'cob', 'basal', 'profile', 'pump', 'loop', 'upbat', 'cage', 'sage', 'treatmentnotify', 'simplealarms', 'ar2', 'devicestatus'] },
        extendedSettings: { cage: { enableAlerts: true, info: 44, warn: 48, urgent: 72 } } });
        const language = require('../lib/language')(); language.set('en');
        const stores = Object.fromEntries(evaluator.domains.map(logical => [logical, projectionRead({ tenant: lab.A, connection: lab.reader,
          logical, documents: docs[logical] || [], maxRows: 10000, maxBytes: 16 * 1024 * 1024, env })]));
        const make = () => viewsFactory(env, evaluator.createContext({ env, language, dbstats: lab.stats, storage: logical => stores[logical] }));
        const kept = make(), fresh = make();
        const token = {}, dbstats = { dataSize: 1, indexSize: 1 };
        const materialise = (views, now, keep) => new Promise((resolve, reject) =>
          views.materialise('properties', { now, dbstats, ...(keep ? { keep } : {}) }, (e, set) => e ? reject(e) : resolve(set)));
        let reused = 0, loaded = 0, instants = 0;
        clock.install();
        try {
          await scope.withTenant(lab.A, async () => {
            // Every 10 s for 12 minutes, then every second across the edges.
            const instants10 = Array.from({ length: 73 }, (_, i) => t0 + i * 10000);
            const instants1 = Array.from({ length: 120 }, (_, i) => t0 + 3 * MIN - 60000 + i * 1000);
            for (const now of [...instants10, ...instants1]) {
              clock.pin(now + skewMs);
              const a = await materialise(kept, now, token);
              const b = await materialise(fresh, now);
              if (a.kept) reused++; else loaded++;
              instants++;
              assert.ok(util.isDeepStrictEqual(data(a.ddata), data(b.ddata)), 'working set at ' + iso(now) + (a.kept ? ' (kept)' : ' (loaded)') +
                ': ' + JSON.stringify(Object.keys(data(a.ddata)).filter(k => !util.isDeepStrictEqual(a.ddata[k], b.ddata[k]))));
              assert.deepStrictEqual(Object.keys(a.ddata), Object.keys(b.ddata), 'key order at ' + iso(now));
              assert.deepStrictEqual(aliases(a.ddata), aliases(b.ddata), 'shared values at ' + iso(now));
              assert.deepStrictEqual(a.queries, b.queries, 'reads at ' + iso(now));
              assert.deepStrictEqual(output(kept.evaluateCycle(a)), output(fresh.evaluateCycle(b)), 'plugin output at ' + iso(now));
            }
          });
        } finally { clock.uninstall(); }
        process.stdout.write('      EV_COST_B_WINDOW_CUT skew=' + skewMs + ' instants=' + instants + ' reused=' + reused + ' loaded=' + loaded + '\n');
        // The projection crosses an edge every few seconds, so most instants
        // reload; both kinds must be well represented.
        assert.ok(reused >= 20, 'the kept working set was reused (' + reused + ')');
        assert.ok(loaded > 20, 'windows changed and the view reloaded (' + loaded + ')');
      });
    }
  });
