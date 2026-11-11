'use strict';

// BF-232: operator-supplied plugin extended settings reach a tenant's
// environment as they would a single site's, typed and per tenant. Synthetic
// tenants and readings only; the SQL connection is a recording double.
const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const evaluator = require('../lib/data/tenant-projection-evaluator');
const environment = require('../lib/server/tenant-app/environment');
const presentation = require('../lib/server/tenant-app/presentation-environment');
const config = require('../lib/server/serve/evaluator-config');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const source = { EVAL_PG: 'postgres://synthetic:synthetic@127.0.0.1/disposable_test' };

function document (tenants) {
  return { version: 1, postgres: { connectionEnv: 'EVAL_PG',
    namespaces: Object.fromEntries(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'clock', 'checkpoint']
      .map(k => [k, 'eval_' + k])) },
  consumer: 'evaluator-proof', pageSize: 1, maxRows: 10, maxBytes: 100000, maxTenants: 2,
  recoveryIntervalMs: 100, timeIntervalMs: 200, tenants };
}
// One synthetic value of the declared type for every carried setting.
function sample (types) {
  return types[0] === 'boolean' ? true : types[0] === 'number' ? 7 : '1 2';
}
const everyCarried = () => Object.fromEntries(Object.entries(environment.EXTENDED)
  .map(([plugin, keys]) => [plugin, Object.fromEntries(Object.entries(keys).map(([key, types]) => [key, sample(types)]))]));

async function evaluateStale (tenant, env, at) {
  // One reading 40 minutes old: past the shipped 30-minute urgent default.
  const reading = { _id: 'synthetic-' + tenant.slice(0, 4), type: 'sgv', sgv: 120, date: at - 40 * 60000,
    utcOffset: 0, srvModified: at - 40 * 60000 };
  const connection = { async query (text, values) {
    return { rows: JSON.parse(values.at(-1)).map(row => ({ ...row, unsortable: false })) };
  } };
  const replay = { async reconcile () { return { checkpoint: 1, rows: [{ domain: 'entries', document: reading }] }; } };
  const v = evaluator({ tenant, replay, connection, env, language: require('../lib/language')(),
    dbstats: async () => ({ dataSize: 0, indexSize: 0 }), maxRows: 10, maxBytes: 100000 });
  return scope.withTenant(tenant, () => v.evaluate({ at }));
}
const stale = result => result.emitted.filter(n => n.group === 'Time Ago');

describe('tenant plugin extended settings (BF-232)', function () {
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));

  // The serving process builds each tenant environment directly from the
  // operator's preview configuration (preview-config.js); the evaluator
  // process parses and validates its own operator configuration.
  const builders = {
    serving: tenants => new Map(tenants.map(t => [t.id, environment({ settings: t.settings, extendedSettings: t.extendedSettings })])),
    evaluator: tenants => new Map([...config.parse(document(tenants), source).tenants].map(([id, t]) => [id, t.env]))
  };
  for (const [path, build] of Object.entries(builders)) {
    it('fires the stale-data alarm for the tenant whose operator enabled it, and not for the other (' + path + ')', async function () {
      const envs = build([{ id: A, revision: 'a1', settings: {}, extendedSettings: { timeago: { enableAlerts: true } } },
        { id: B, revision: 'b1', settings: {} }]);
      const at = Date.now();
      const fired = stale(await evaluateStale(A, envs.get(A), at));
      assert.equal(fired.length, 1, 'EXT_TIMEAGO_A tenant A has stale data and timeago.enableAlerts');
      assert.equal(fired[0].level, 2, 'past the 30-minute default the stale-data alarm is urgent');
      assert.equal(fired[0].title, 'Stale data, check rig?');
      assert.deepEqual(stale(await evaluateStale(B, envs.get(B), at)), [], 'EXT_TIMEAGO_B tenant B left it unset');
    });

    it('keeps each tenant\'s extended settings separate (' + path + ')', function () {
      const envs = build([
        { id: A, revision: 'a1', settings: {}, extendedSettings: { timeago: { enableAlerts: true }, pump: { warnRes: 20 } } },
        { id: B, revision: 'b1', settings: {}, extendedSettings: { pump: { warnRes: 5 } } }]);
      const a = envs.get(A), b = envs.get(B);
      assert.deepEqual(b.extendedSettings, { pump: { warnRes: 5 } }, 'EXT_ISOLATION B carries only its own settings');
      assert.notEqual(a.extendedSettings, b.extendedSettings);
      assert.notEqual(a.extendedSettings.pump, b.extendedSettings.pump);
      a.extendedSettings.pump.warnRes = 99;
      assert.equal(b.extendedSettings.pump.warnRes, 5, 'a change to one tenant\'s object never reaches another');
    });
  }

  it('changes the evaluator configuration identity with the extended settings', function () {
    const one = config.parse(document([{ id: A, revision: 'a1', settings: {}, extendedSettings: { timeago: { enableAlerts: true } } }]), source);
    const two = config.parse(document([{ id: A, revision: 'a1', settings: {} }]), source);
    assert.notEqual(one.tenants.get(A).identity, two.tenants.get(A).identity);
  });

  it('round-trips every carried setting into the environment, the evaluator config and the status projection', function () {
    const input = everyCarried();
    input.devicestatus.days = 2;
    const env = environment({ extendedSettings: input });
    assert.deepEqual(env.extendedSettings, input, 'EXT_ROUNDTRIP every catalogued setting is carried');
    assert.notEqual(env.extendedSettings.timeago, input.timeago, 'carried by value, not by reference');
    assert.deepEqual(env.settings.filteredSettings(env.extendedSettings), input, 'the status route shows the same values');
    const parsed = config.parse(document([{ id: A, revision: 'a1', settings: {}, extendedSettings: input }]), source);
    assert.deepEqual(parsed.tenants.get(A).env.extendedSettings, input);
    // errorcodes takes the space-separated string a single site documents, or
    // the number a single site's environment parser makes of one code.
    assert.deepEqual(environment({ extendedSettings: { errorcodes: { urgent: 9 } } }).extendedSettings, { errorcodes: { urgent: 9 } });
  });

  // Maintainer decision 2026-11-10: a tenant reports devicestatus as a single
  // site does (lib/server/env.js findExtendedSettings). Display parity only:
  // tenant realtime frames are full (RT_ACTUAL_FULL_RESET in realtime-preview).
  it('reports the single-site devicestatus defaults and honours an operator override', function () {
    const unset = environment({});
    assert.deepEqual(unset.settings.filteredSettings(unset.extendedSettings), { devicestatus: { advanced: true, days: 1 } },
      'EXT_DEVICESTATUS_DEFAULT the status view shows advanced:true, days:1 when unset');
    assert.deepEqual(unset.extendedSettings, {}, 'the environment itself carries only operator values; days unset still loads one day');
    const other = environment({ extendedSettings: { timeago: { enableAlerts: true } } });
    assert.deepEqual(other.settings.filteredSettings(other.extendedSettings),
      { devicestatus: { advanced: true, days: 1 }, timeago: { enableAlerts: true } });
    for (const [given, shown] of [[{ advanced: false }, { advanced: false, days: 1 }], [{ days: 2 }, { advanced: true, days: 2 }],
      [{ advanced: false, days: 2 }, { advanced: false, days: 2 }], [{ advanced: 'false', days: 7 }, { advanced: true, days: 1 }]]) {
      const env = environment({ extendedSettings: { devicestatus: given } });
      assert.deepEqual(env.settings.filteredSettings(env.extendedSettings), { devicestatus: shown },
        'EXT_DEVICESTATUS_OVERRIDE ' + JSON.stringify(given));
    }
    const parsed = config.parse(document([{ id: A, revision: 'a1', settings: {}, extendedSettings: { devicestatus: { advanced: false } } }]), source);
    assert.deepEqual(parsed.tenants.get(A).env.extendedSettings, { devicestatus: { advanced: false } }, 'the evaluator configuration accepts it');
  });

  it('does not carry credentials, the dbsize settings, or settings outside the catalogue', function () {
    const excluded = { pushover: { apiToken: 'synthetic', userKey: 'synthetic' }, maker: { key: 'synthetic' },
      loop: { apnsKey: 'synthetic', apnsKeyId: 'synthetic', developerTeamId: 'synthetic' },
      connect: { source: 'nightscout', sourceApiSecret: 'synthetic' }, bridge: { userName: 'synthetic' },
      dbsize: { enableAlerts: true, max: 100 }, cors: { allowOrigin: 'https://synthetic.invalid' } };
    assert.deepEqual(environment({ extendedSettings: excluded }).extendedSettings, {}, 'EXT_EXCLUDED');
    for (const [plugin, values] of Object.entries(excluded)) {
      assert.throws(() => config.parse(document([{ id: A, revision: 'a1', settings: {},
        extendedSettings: { [plugin]: values } }]), source), /explicit evaluator/, plugin + ' refuses in operator config');
    }
  });

  it('refuses an unknown or mistyped extended setting in the operator configuration', function () {
    for (const extendedSettings of [{ timeago: { enableAlerts: true, madeUp: 1 } }, { timeago: { enableAlerts: 'true' } },
      { timeago: { enableAlerts: true }, notAPlugin: { enableAlerts: true } }, { pump: { warnRes: Infinity } },
      { pump: { fields: 'x'.repeat(257) } }, { timeago: [] }, { sage: { warn: '160' } },
      { devicestatus: { advanced: 'true' } }, { devicestatus: { days: 3 } }]) {
      assert.throws(() => config.parse(document([{ id: A, revision: 'a1', settings: {}, extendedSettings }]), source),
        /explicit evaluator/, 'EXT_UNKNOWN_REFUSED ' + JSON.stringify(extendedSettings).slice(0, 60));
    }
    assert.throws(() => config.parse(document([{ id: A, revision: 'a1', settings: { timeago: { enableAlerts: true } } }]), source),
      /explicit evaluator/, 'plugin settings in the display settings object still refuse');
  });

  it('keeps operator extended settings when an owner display setting changes', async function () {
    const parsed = config.parse(document([{ id: A, revision: 'a1', settings: {},
      extendedSettings: { timeago: { enableAlerts: true } } }]), source);
    const changed = config.applySettings(parsed.tenants.get(A), { version: 2, effective: { DISPLAY_UNITS: { value: 'mmol' } } });
    assert.equal(changed.env.settings.units, 'mmol');
    assert.deepEqual(changed.env.extendedSettings, { timeago: { enableAlerts: true } });
    const local = await presentation.forRequest({ reader: { read: async () => ({ effective: {} }) }, tenant: A,
      env: parsed.tenants.get(A).env, request: { method: 'GET', path: '/status.json' }, domains: [] });
    assert.deepEqual(local.settings.filteredSettings(local.extendedSettings),
      { devicestatus: { advanced: true, days: 1 }, timeago: { enableAlerts: true } },
      'the per-request display environment shows the operator setting');
    assert.deepEqual(local.extendedSettings, { timeago: { enableAlerts: true } }, 'the reported default is not copied into the environment');
  });
});
