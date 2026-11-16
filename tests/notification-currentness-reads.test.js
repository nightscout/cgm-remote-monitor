'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const scope = require('../lib/storage/tenant-scope');
const fixture = require('./fixtures/tenant-notifications');
const producer = require('../lib/tenant-notifications/producer');
const component = require('../lib/tenant-notifications/component');
function changed (name, transform) {
  const file = require.resolve('../lib/tenant-notifications/' + name), module = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + transform(fs.readFileSync(file, 'utf8')) + '\n})', { filename: file })(createRequire(file), module, module.exports);
  return module.exports;
}

describe('notification operation currentness ownership', function () {
  let prior;
  beforeEach(() => { prior = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(prior));

  async function producerCriterion (start = producer, stale = false) {
    const f = fixture(); f.setCycle([fixture.notification()]); let reads = 0, checks = 0, identity = f.current().identity;
    const source = { ...f.current(), result: { ...f.current().result, requested: [] } };
    source.contentDigest = require('../lib/server/serve/evaluator-runtime').contentDigest(source.result);
    const currentConfig = async () => { reads++; return { tenant: f.A, identity }; };
    const p = start({ store: f.store, reader: { async read () { if (stale) identity += '-changed'; return []; } },
      current: () => source, currentConfig,
      isCurrent: async (tenant, expected) => { checks++; const fresh = await currentConfig(); return fresh.tenant === tenant && fresh.identity === expected; },
      consumer: 'synthetic', now: f.now, maxRows: 10, maxBytes: 65536, maxPayloadBytes: 10000 });
    try {
      if (stale) {
        await assert.rejects(p.select(f.A), /NOTIFICATION_PRODUCER_(CONFIG_UNAVAILABLE|STALE)/);
        assert.equal(f.snapshot().requests.length, 0, 'CHANGED_AUTHORITY_MUST_NOT_COMMIT_INTENT');
      } else {
        await p.select(f.A);
        assert.equal(checks, 3, 'AUTHORITY_CHECKS_REMAIN_AT_SELECTION_TRANSFORM_AND_COMMIT');
        assert.equal(reads, checks + 1, 'CONFIG_READ_MUST_HAVE_ONE_OWNER_AT_EACH_BOUNDARY');
      }
    } finally { p.close(); }
  }
  it('one configuration owner at each selection boundary; silent authority change still refuses intent', async () => {
    await producerCriterion(); await producerCriterion(producer, true);
  });
  it('control: restoring duplicate configuration lookup increases reads; restored source keeps the boundary checks', async () => {
    const broken = changed('producer', text => {
      const needle = 'if (!await isCurrent(tenant, config.identity)) return false;';
      assert(text.includes(needle)); return text.replace(needle, 'await currentConfig(tenant); ' + needle);
    });
    await assert.rejects(producerCriterion(broken), /CONFIG_READ_MUST_HAVE_ONE_OWNER_AT_EACH_BOUNDARY/);
    await producerCriterion();
  });

  async function attemptCriterion (start = component) {
    const f = fixture(); f.setCycle([fixture.notification()]); let allows = 0;
    const n = start({ ...f.hooks, allows: async () => { allows++; return true; } });
    try {
      await n.run(f.A);
      assert.equal(f.effects.length, 1, 'SUPPORTED_ALARM_STILL_DISPATCHES');
      assert.equal(allows, 2, 'NO_SECOND_ELIGIBILITY_READ_WITHOUT_AN_INTERVENING_AWAIT');
    } finally { await n.close(); }
  }
  it('normal dispatch does not repeat eligibility without an intervening asynchronous operation', () => attemptCriterion());
  it('control: restoring duplicate eligibility rereads suppression; restored dispatch has one check per boundary', async () => {
    const broken = changed('component', text => {
      const needle = '      const dispatchedAt = c.instant(now());'; assert(text.includes(needle));
      return text.replace(needle, "      await eligible(tenant, identity, pending.payload, pending.origin);\n" + needle);
    });
    await assert.rejects(attemptCriterion(broken), /NO_SECOND_ELIGIBILITY_READ_WITHOUT_AN_INTERVENING_AWAIT/);
    await attemptCriterion();
  });
  it('retains the fresh check after a receipt await and refuses an authority change before clear dispatch', async () => {
    const f = fixture(); f.setCycle([{ clear: true, title: 'All Clear', message: 'Synthetic clear' }]);
    let receipts = 0;
    const n = component({ ...f.hooks, store: { ...f.store, async receipts (args) {
      const rows = await f.store.receipts(args); receipts++; f.configCurrent(false); return rows;
    } } });
    try { await n.run(f.A); assert.equal(receipts, 1); assert.equal(f.effects.length, 0, 'RECEIPT_AWAIT_MUST_RECHECK_AUTHORITY'); }
    finally { await n.close(); }
  });
  it('refuses authority changed across the suppression await before ordinary dispatch', async () => {
    const f = fixture(); f.setCycle([fixture.notification()]);
    const n = component({ ...f.hooks, allows: async () => { await Promise.resolve(); f.configCurrent(false); return true; } });
    try { await n.run(f.A); assert.equal(f.effects.length, 0, 'SUPPRESSION_AWAIT_MUST_RECHECK_AUTHORITY'); }
    finally { await n.close(); }
  });
});
