'use strict';

// covers: lib/server/tenant-app/environment.js, lib/server/devicestatus.js

// PREDICTIONS_MAX_SIZE parity. A single site caps each OpenAPS prediction
// curve (openaps.suggested/enacted.predBGs IOB, COB, UAM, ZT) at
// env.predictionsMaxSize when API v1 writes a status (lib/server/env.js,
// default 288; lib/server/devicestatus.js truncatePredictions). A tenant's
// API v1 write runs the same module with the tenant environment
// (lib/server/tenant-app/environment.js), so that environment must carry the
// same cap, or the tenant stores every curve uncapped. Other curves (aCOB,
// Loop's predicted.values) and the API v3 and socket writes are uncapped in
// both modes.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ObjectId } = require('mongodb');
const environment = require('../lib/server/tenant-app/environment');
const createDeviceStatus = require('../lib/server/devicestatus');

const LONG = 400;
const curve = start => Array.from({ length: LONG }, (_, k) => 39 + ((start + k) % 360));
const predBGs = () => ({ IOB: curve(100), COB: curve(120), UAM: curve(140), ZT: curve(90), aCOB: curve(110) });
const status = () => ({ device: 'openaps://synthetic', created_at: '2026-11-24T00:00:00.000Z',
  openaps: { suggested: { predBGs: predBGs() }, enacted: { predBGs: predBGs() } },
  loop: { predicted: { startDate: '2026-11-24T00:00:00.000Z', values: curve(130) } } });

function lengths (doc) {
  const out = {};
  for (const part of ['suggested', 'enacted']) {
    for (const [name, values] of Object.entries(doc.openaps[part].predBGs)) out[part + '.' + name] = values.length;
  }
  out['loop.predicted.values'] = doc.loop.predicted.values.length;
  return out;
}

// A driver collection holding nothing, recording the documents inserted.
function store (inserted) {
  const empty = { sort: () => empty, skip: () => empty, limit: () => empty, project: () => empty,
    batchSize: () => empty, toArray: () => Promise.resolve([]) };
  const col = { collectionName: 'devicestatus', find: () => empty, countDocuments: () => Promise.resolve(0) };
  col.insertMany = docs => {
    const insertedIds = {};
    docs.forEach((doc, i) => { doc._id = doc._id || new ObjectId(); insertedIds[i] = doc._id; inserted.push(JSON.parse(JSON.stringify(doc))); });
    return Promise.resolve({ acknowledged: true, insertedCount: docs.length, insertedIds });
  };
  for (const name of ['insertOne', 'bulkWrite', 'replaceOne', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany']) {
    col[name] = () => Promise.reject(new Error('unexpected ' + name));
  }
  return { collection: () => col, ensureIndexes: () => {} };
}

async function writeV1 (env) {
  const inserted = [];
  const ctx = { bus: new EventEmitter(), store: store(inserted), purifier: { purifyObject: () => {} },
    ddata: { processRawDataForRuntime: x => JSON.parse(JSON.stringify(x)) } };
  const api = createDeviceStatus(Object.assign({ devicestatus_collection: 'devicestatus' }, env), ctx);
  await new Promise((resolve, reject) => api.create([status()], err => err ? reject(err) : resolve()));
  assert.equal(inserted.length, 1);
  return lengths(inserted[0]);
}

const CAPPED = cap => ({
  'suggested.IOB': cap, 'suggested.COB': cap, 'suggested.UAM': cap, 'suggested.ZT': cap, 'suggested.aCOB': LONG,
  'enacted.IOB': cap, 'enacted.COB': cap, 'enacted.UAM': cap, 'enacted.ZT': cap, 'enacted.aCOB': LONG,
  'loop.predicted.values': LONG
});

describe('PREDICTIONS_MAX_SIZE: a tenant caps OpenAPS prediction curves as a single site does', function () {
  let saved;
  before(function () { saved = process.env.PREDICTIONS_MAX_SIZE; delete process.env.PREDICTIONS_MAX_SIZE; });
  after(function () { if (saved !== undefined) process.env.PREDICTIONS_MAX_SIZE = saved; });

  it('the tenant environment carries the single-site default cap', function () {
    const single = require('../lib/server/env')();
    assert.equal(single.predictionsMaxSize, 288, 'single-site default (lib/server/env.js)');
    assert.equal(environment({}).predictionsMaxSize, single.predictionsMaxSize);
  });

  it('a tenant API v1 status stores the same curve lengths as a single site', async function () {
    const single = await writeV1(require('../lib/server/env')());
    assert.deepEqual(single, CAPPED(288));
    assert.deepEqual(await writeV1(environment({})), single);
  });

  it('control: the module stores every curve uncapped without the cap', async function () {
    assert.deepEqual(await writeV1({}), CAPPED(LONG));
  });
});
