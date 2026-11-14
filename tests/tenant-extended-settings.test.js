'use strict';

// BF-232 pure-domain behavior: supplied plugin settings reach a tenant's
// environment typed and per tenant. Maintained registry input is separate. Synthetic
// tenants and readings only; the SQL connection is a recording double.
const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const evaluator = require('../lib/data/tenant-projection-evaluator');
const environment = require('../lib/server/tenant-app/environment');
const presentation = require('../lib/server/tenant-app/presentation-environment');
const config = require('../lib/server/serve/evaluator-config');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
// Pure domain environment and committed-settings projection. This does not
// claim that maintained registry configuration has an operator plugin input.
function domainEntry (tenant) {
  return config.applySettings({ ...config.registryEntry(tenant.id), env: environment(tenant) },
    { version: 1, policyGeneration: 1, readAt: 0, effective: {} });
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

describe('tenant plugin domain environments and committed projection (BF-232)', function () {
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));

  const builders = {
    domainEnvironment: tenants => new Map(tenants.map(t => [t.id, environment({ settings: t.settings, extendedSettings: t.extendedSettings })])),
    committedProjection: tenants => new Map(tenants.map(tenant => [tenant.id, domainEntry(tenant).env]))
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

  it('changes effective evaluator identity with committed owner settings while preserving plugin input', function () {
    const one = domainEntry({ id: A, settings: {}, extendedSettings: { timeago: { enableAlerts: true } } });
    const two = config.applySettings(one, { version: 2, policyGeneration: 1, readAt: 1, effective: { DISPLAY_UNITS: { value: 'mmol' } } });
    assert.notEqual(one.identity, two.identity);assert.equal(two.env.settings.units, 'mmol');
    assert.deepEqual(two.env.extendedSettings, one.env.extendedSettings);assert.notEqual(two.env.extendedSettings, one.env.extendedSettings);
  });

  it('round-trips every carried setting through domain environment, committed projection and status', function () {
    const input = everyCarried();
    input.devicestatus.days = 2;
    const env = environment({ extendedSettings: input });
    assert.deepEqual(env.extendedSettings, input, 'EXT_ROUNDTRIP every catalogued setting is carried');
    assert.notEqual(env.extendedSettings.timeago, input.timeago, 'carried by value, not by reference');
    assert.deepEqual(env.settings.filteredSettings(env.extendedSettings), input, 'the status route shows the same values');
    const projected = domainEntry({ id: A, settings: {}, extendedSettings: input });
    assert.deepEqual(projected.env.extendedSettings, input);
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
    const projected = domainEntry({ id: A, settings: {}, extendedSettings: { devicestatus: { advanced: false } } });
    assert.deepEqual(projected.env.extendedSettings, { devicestatus: { advanced: false } });
  });

  it('does not carry credentials, the dbsize settings, or settings outside the catalogue', function () {
    const excluded = { pushover: { apiToken: 'synthetic', userKey: 'synthetic' }, maker: { key: 'synthetic' },
      loop: { apnsKey: 'synthetic', apnsKeyId: 'synthetic', developerTeamId: 'synthetic' },
      connect: { source: 'nightscout', sourceApiSecret: 'synthetic' }, bridge: { userName: 'synthetic' },
      dbsize: { enableAlerts: true, max: 100 }, cors: { allowOrigin: 'https://synthetic.invalid' } };
    assert.deepEqual(environment({ extendedSettings: excluded }).extendedSettings, {}, 'EXT_EXCLUDED');
    for (const [plugin, values] of Object.entries(excluded)) {
      assert.deepEqual(domainEntry({ id: A, settings: {}, extendedSettings: { [plugin]: values } }).env.extendedSettings, {}, plugin + ' is excluded from the domain environment');
    }
  });

  it('filters unknown and mistyped plugin values in domain projection without carrying credentials', function () {
    const cases = [
      [{ timeago: { enableAlerts: true, madeUp: 1 } }, { timeago: { enableAlerts: true } }],
      [{ timeago: { enableAlerts: 'true' } }, {}],
      [{ timeago: { enableAlerts: true }, notAPlugin: { enableAlerts: true } }, { timeago: { enableAlerts: true } }],
      [{ pump: { warnRes: Infinity } }, {}], [{ pump: { fields: 'x'.repeat(257) } }, {}], [{ timeago: [] }, {}],
      [{ sage: { warn: '160' } }, {}], [{ devicestatus: { advanced: 'true' } }, {}], [{ devicestatus: { days: 3 } }, {}]
    ];
    for (const [extendedSettings, expected] of cases) assert.deepEqual(domainEntry({ id: A, settings: {}, extendedSettings }).env.extendedSettings, expected);
    assert.equal(environment({ settings: { timeago: { enableAlerts: true } } }).settings.timeago, undefined);
  });

  it('keeps supplied domain plugin settings when committed display settings change', async function () {
    const selected = domainEntry({ id: A, settings: {}, extendedSettings: { timeago: { enableAlerts: true } } });
    const changed = config.applySettings(selected, { version: 2, effective: { DISPLAY_UNITS: { value: 'mmol' } } });
    assert.equal(changed.env.settings.units, 'mmol');
    assert.deepEqual(changed.env.extendedSettings, { timeago: { enableAlerts: true } });
    const local = await presentation.forRequest({ reader: { read: async () => ({ effective: {} }) }, tenant: A,
      env: selected.env, request: { method: 'GET', path: '/status.json' }, domains: [] });
    assert.deepEqual(local.settings.filteredSettings(local.extendedSettings),
      { devicestatus: { advanced: true, days: 1 }, timeago: { enableAlerts: true } },
      'the per-request display environment shows the operator setting');
    assert.deepEqual(local.extendedSettings, { timeago: { enableAlerts: true } }, 'the reported default is not copied into the environment');
  });
  it('the stale-data clinical oracle fails when the domain plugin input is omitted and passes when restored', async function () {
    const tenant = { id: A, settings: {}, extendedSettings: { timeago: { enableAlerts: true } } }, at = Date.now();
    assert.equal(stale(await evaluateStale(A, domainEntry(tenant).env, at)).length, 1);
    const broken = domainEntry({ ...tenant, extendedSettings: {} });
    const brokenResult = await evaluateStale(A, broken.env, at);assert.equal(stale(brokenResult).length, 0);
    assert.throws(() => assert.equal(stale(brokenResult).length, 1), { code: 'ERR_ASSERTION' });
    assert.equal(stale(await evaluateStale(A, domainEntry(tenant).env, at)).length, 1);
  });
  it('maintained registry configuration keeps default plugin state and refuses the retired static tenant transport', async function () {
    const plans = require('./fixtures/multitenant-plan'), layout = plans.layout('extended_registry');
    const docs = plans.documents({ layout, urls: plans.syntheticUrls(layout) });
    const parsed = config.parse(docs.configs.evaluator, docs.environments.evaluator);
    assert.equal(parsed.tenants.size, 0);
    const selected = config.registryEntry(A);assert.deepEqual(selected.env.extendedSettings, {});
    const projected = await config.withSettings(parsed, selected, A, { matches: () => true, read: async () => ({ version: 2, policyGeneration: 1, readAt: 0, effective: { DISPLAY_UNITS: { value: 'mmol' } } }) });
    assert.equal(projected.env.settings.units, 'mmol');assert.deepEqual(projected.env.extendedSettings, {});
    assert.throws(() => config.parse({ ...docs.configs.evaluator, tenants: [{ id: A, revision: 'legacy', settings: {}, extendedSettings: { timeago: { enableAlerts: true } } }] }, docs.environments.evaluator), error => error instanceof require('../lib/server/serve/preview-config').PreviewConfigError && error.message === require('../lib/server/serve/registry-config').REFUSAL);
  });

});
