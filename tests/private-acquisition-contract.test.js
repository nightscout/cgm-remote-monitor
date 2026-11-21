'use strict';

// Exercise the shipping acquisition entrypoints with controlled callback stores.
// Real Mongo/PG semantics remain covered by the frame acquisition/concurrency labs.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const createData = require('../lib/data/ddata');
const createCache = require('../lib/server/cache');
const createViews = require('../lib/data/views');
const createSnapshot = require('../lib/server/tenant-app/snapshot');
const environment = require('../lib/server/tenant-app/environment');
const scope = require('../lib/storage/tenant-scope');

const TENANT = '11111111-1111-4111-8111-111111111111';

function fixture () {
  const now = Date.now();
  const pending = [];
  const env = environment({ settings: { enable: [] } });
  const language = require('../lib/language')();
  const ctx = { settings: env.settings, language,
    levels: { ...require('../lib/levels'), translate: language.translate },
    moment: require('moment-timezone'), bus: new EventEmitter(), ddata: createData() };
  ctx.cache = createCache(env, ctx);
  ctx.cache.insertDataRef('entries', [{ _id: 'resident-sentinel', type: 'sgv', date: now - 120000, sgv: 300 }]);
  ctx.entries = { list (query, callback) { pending.push(callback); } };
  for (const name of ['treatments', 'devicestatus', 'activity', 'food']) {
    ctx[name] = { list (...args) { args.at(-1)(null, []); } };
  }
  ctx.profile = { last (callback) { callback(null, []); } };
  ctx.store = { db: { stats: async () => ({ dataSize: 0, indexSize: 0 }) } };
  const ports = Object.fromEntries(['entries', 'treatments', 'devicestatus', 'activity', 'profile', 'food']
    .map(name => [name, { tenant: TENANT, store: ctx[name] }]));
  ports.stats = { tenant: TENANT, read: () => ctx.store.db.stats() };
  return { now, env, ctx, language, ports, pending,
    row (value) { return { _id: 'reading-' + value, type: 'sgv', date: now - 60000, sgv: value }; } };
}

function materialise (views, now) {
  return new Promise((resolve, reject) => views.materialise('properties', { now },
    (error, frame) => error ? reject(error) : resolve(frame)));
}

describe('private acquisition caller contracts', function () {
  let oldMode;
  before(function () { oldMode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  after(function () { scope.setTenancyMode(oldMode); });

  it('overlapping tenant snapshots retain separate targets, caches and buses when reads finish in reverse order', async function () {
    const lab = fixture();
    const service = createSnapshot({ tenant: TENANT, env: lab.env, ports: lab.ports, language: lab.language });
    const firstPending = service.load({ at: lab.now });
    const secondPending = service.load({ at: lab.now });
    assert.equal(lab.pending.length, 2);
    lab.pending[1](null, [lab.row(200)]);
    const second = await secondPending;
    lab.pending[0](null, [lab.row(100)]);
    const first = await firstPending;
    assert.notEqual(first.ddata, second.ddata);
    assert.notEqual(first.cache, second.cache);
    assert.notEqual(first.bus, second.bus);
    assert.deepEqual(first.ddata.sgvs.map(row => row.mgdl), [100]);
    assert.deepEqual(second.ddata.sgvs.map(row => row.mgdl), [200]);
    assert.deepEqual(first.cache.getDataRef('entries').map(row => row.sgv), [100]);
    assert.deepEqual(second.cache.getDataRef('entries').map(row => row.sgv), [200]);
    assert.deepEqual(lab.ctx.cache.getDataRef('entries').map(row => row._id), ['resident-sentinel']);
    assert.deepEqual(lab.ctx.ddata.sgvs, []);
  });

  it('overlapping computed views retain separate working sets and leave resident state untouched', async function () {
    const lab = fixture();
    const views = createViews(lab.env, lab.ctx);
    const firstPending = materialise(views, lab.now);
    const secondPending = materialise(views, lab.now);
    assert.equal(lab.pending.length, 2);
    lab.pending[1](null, [lab.row(200)]);
    const second = await secondPending;
    lab.pending[0](null, [lab.row(100)]);
    const first = await firstPending;
    assert.notEqual(first.ddata, second.ddata);
    assert.deepEqual(first.ddata.sgvs.map(row => row.mgdl), [100]);
    assert.deepEqual(second.ddata.sgvs.map(row => row.mgdl), [200]);
    assert.deepEqual(lab.ctx.cache.getDataRef('entries').map(row => row._id), ['resident-sentinel']);
    assert.deepEqual(lab.ctx.ddata.sgvs, []);
  });

  it('computed view read throws still escape synchronously without reporting completion', function () {
    const lab = fixture(), fault = new Error('synthetic view store throw');
    lab.ctx.entries.list = () => { throw fault; };
    const views = createViews(lab.env, lab.ctx);
    let completed = false;
    assert.throws(() => views.materialise('properties', { now: lab.now }, () => { completed = true; }),
      error => error === fault);
    assert.equal(completed, false);
  });

  it('tenant snapshot read throws still reject with the same failure', async function () {
    const lab = fixture(), fault = new Error('synthetic tenant store throw');
    lab.ctx.entries.list = () => { throw fault; };
    const service = createSnapshot({ tenant: TENANT, env: lab.env, ports: lab.ports, language: lab.language });
    await assert.rejects(service.load({ at: lab.now }), error => error === fault);
  });
});
