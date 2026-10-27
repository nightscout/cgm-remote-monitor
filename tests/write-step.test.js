'use strict';

const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const step = require('../lib/storage/write-step');
const validation = require('../lib/server/write-validation');

function fixture(mode = 'off', docs = []) {
  const calls = [], events = [];
  const bus = new EventEmitter();
  bus.on('storage-write-committed', event => events.push(event));
  const context = {name: 'treatments', source: 'socket', env: {writeValidation: mode}, bus};
  const raw = {
    find() { return {limit() { return this; }, toArray: async () => docs}; },
    insertOne: async (...args) => { calls.push(args); return {acknowledged: true, insertedId: 'id'}; },
    updateOne: async (...args) => { calls.push(args); return {acknowledged: true, matchedCount: 1, modifiedCount: 1}; },
    deleteMany: async (...args) => { calls.push(args); return {deletedCount: 2}; },
    bulkWrite: async (...args) => { calls.push(args); return {modifiedCount: 2}; }
  };
  return {raw, calls, events, context, col: step.collection(raw, context)};
}
const valid = () => ({eventType: 'Temporary Target', units: 'mmol/L', targetBottom: 5, targetTop: 6, duration: 30});

describe('Shared persistence boundary', function () {
  it('preserves driver arguments/results, receiver binding, and publishes once after commit', async function () {
    const f = fixture();
    let resolve;
    const result = {insertedId: 'stored', acknowledged: true};
    f.raw.insertOne = function (...args) {
      assert.equal(this, f.raw);
      f.calls.push(args);
      return new Promise(r => { resolve = r; });
    };
    const doc = {notes: 'sensitive'}, options = {ordered: false};
    const pending = f.col.insertOne(doc, options);
    await Promise.resolve();
    assert.equal(f.events.length, 0);
    resolve(result);
    assert.equal(await pending, result);
    assert.deepEqual(f.calls, [[doc, options]]);
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].counts.inserted, 1);
    assert(!JSON.stringify(f.events).includes('sensitive'));
    assert(!JSON.stringify(f.events).includes('stored'));
  });

  it('keeps reads and collection properties bound to the driver', async function () {
    const f = fixture();
    f.raw.collectionName = 'custom';
    f.raw.findOne = function () { assert.equal(this, f.raw); return {x: 1}; };
    assert.equal(f.col.collectionName, 'custom');
    assert.deepEqual(f.col.findOne({}), {x: 1});
    assert.equal(f.events.length, 0);
  });

  it('does not announce no-op or unacknowledged writes', async function () {
    const f = fixture();
    for (const result of [{matchedCount: 1, modifiedCount: 0}, {acknowledged: false, insertedId: 'id'}]) {
      f.raw.insertOne = async () => result;
      assert.equal(await f.col.insertOne({}), result);
    }
    assert.equal(f.events.length, 0);
  });

  it('retains the original partial-write error and reports only committed counts', async function () {
    const f = fixture();
    const err = Object.assign(new Error('duplicate'), {result: {insertedCount: 1}, insertedIds: {0: 'id'}});
    f.raw.insertOne = async () => { throw err; };
    await assert.rejects(f.col.insertOne({}), e => e === err);
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].partial, true);
    assert.equal(f.events[0].counts.inserted, 1);
    err.result = undefined;
    await assert.rejects(f.col.insertOne({}), e => e === err);
    assert.equal(f.events.length, 1);
  });

  it('cannot turn a committed write into a retry through a failing observer', async function () {
    const f = fixture();
    f.context.bus.on('storage-write-committed', () => { throw new Error('observer failed'); });
    assert.equal((await f.col.insertOne({})).insertedId, 'id');
    assert.equal(f.calls.length, 1);
  });

  it('rejects executable filters before any I/O, including a later bulk operation', async function () {
    const f = fixture();
    await assert.rejects(f.col.deleteMany({$where: 'true'}), /JavaScript/);
    await assert.rejects(f.col.bulkWrite([{insertOne: {document: {}}}, {deleteOne: {filter: {$expr: {$function: {}}}}}]), /JavaScript/);
    assert.equal(f.calls.length, 0);
    await f.col.deleteMany({notes: {$eq: {$where: 'literal value'}}});
    assert.equal(f.calls.length, 1);
  });

  for (const mode of ['off', 'log', 'reject']) {
    it('applies ' + mode + ' to socket inserts without changing the off/log document', async function () {
      const f = fixture(mode), doc = {...valid(), targetBottom: 12};
      const copy = JSON.stringify(doc);
      if (mode === 'reject') await assert.rejects(f.col.insertOne(doc), {name: 'WriteValidationError'});
      else await f.col.insertOne(doc);
      assert.equal(JSON.stringify(doc), copy);
      assert.equal(f.calls.length, mode === 'reject' ? 0 : 1);
    });
  }

  it('checks the merged update and unsets, while allowing unrelated legacy edits', async function () {
    const f = fixture('reject', [valid()]);
    await assert.rejects(f.col.updateOne({_id: 'id'}, {$set: {targetBottom: 9}}), /above targetTop/);
    await assert.rejects(f.col.updateOne({_id: 'id'}, {$unset: {targetTop: ''}}), /above zero/);
    await assert.rejects(f.col.updateOne({_id: 'id'}, {$set: {'targetTop.foo': 9}}), /above zero/);
    assert.equal(f.calls.length, 0);
    await f.col.updateOne({_id: 'id'}, {$set: {notes: 'edit'}});
    assert.equal(f.calls.length, 1);
  });

  it('preserves socket update payloads and the direct driver call in off/log modes', async function () {
    for (const mode of ['off', 'log']) {
      const f = fixture(mode, [{_id: 'id', ...valid(), mills: 1000, endmills: 1801000}]);
      const update = {$set: {duration: 0, targetBottom: 0, targetTop: 0}};
      const original = JSON.stringify(update);
      await f.col.updateOne({_id: 'id'}, update);
      assert.equal(JSON.stringify(update), original);
      assert.deepEqual(f.calls, [[{_id: 'id'}, update]]);
    }
  });

  it('bounds conditional retries and does not announce an uncommitted conflict', async function () {
    const stored = {_id: 'id', ...valid()}, f = fixture('reject', [stored]);
    let attempts = 0;
    f.raw.updateOne = async () => { attempts++; return {matchedCount: 0, modifiedCount: 0}; };
    f.raw.findOne = async () => stored;
    await assert.rejects(f.col.updateOne({_id: 'id'}, {$set: {targetTop: 7}}), {name: 'WriteConflictError', status: 409});
    assert.equal(attempts, 4);
    assert.equal(f.events.length, 0);
  });

  it('does not recreate a target deleted during a conditional write', async function () {
    const f = fixture('reject', [{_id: 'id', ...valid()}]);
    f.raw.updateOne = async () => ({matchedCount: 0, modifiedCount: 0});
    f.raw.findOne = async () => null;
    const result = await f.col.updateOne({_id: 'id'}, {$set: {targetTop: 7}});
    assert.equal(result.matchedCount, 0);
    assert.equal(f.events.length, 0);
  });

  it('refuses upsert and unacknowledged conditional updates before persistence', async function () {
    const f = fixture('reject', [{_id: 'id', ...valid()}]);
    for (const options of [{upsert: true}, {writeConcern: {w: 0}}]) {
      await assert.rejects(f.col.updateOne({_id: 'id'}, {$set: {targetTop: 7}}, options), {name: 'WriteValidationError'});
    }
    assert.equal(f.calls.length, 0);
  });

  it('normalizes each batch target against its own timestamps', async function () {
    const docs = [1000, 2000].map((mills, i) => ({_id: String(i), ...valid(), mills,
      endmills: mills + 1800000, durationInMilliseconds: 1800000}));
    const f = fixture('reject', docs);
    const update = {$set: {duration: 0, targetBottom: 0, targetTop: 0}};
    await f.col.updateMany({}, update);
    assert.deepEqual(f.calls.map(call => call[1].$set.endmills), [1000, 2000]);
    assert.deepEqual(update, {$set: {duration: 0, targetBottom: 0, targetTop: 0}});
  });

  it('reports committed counts if a later conditional batch item conflicts', async function () {
    const docs = [{_id: 'first', ...valid()}, {_id: 'second', ...valid()}];
    const f = fixture('reject', docs);
    let calls = 0;
    f.raw.updateOne = async () => ({matchedCount: ++calls === 1 ? 1 : 0, modifiedCount: calls === 1 ? 1 : 0});
    f.raw.findOne = async () => docs[1];
    await assert.rejects(f.col.updateMany({}, {$set: {targetTop: 7}}), {name: 'WriteConflictError'});
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].partial, true);
    assert.equal(f.events[0].counts.modified, 1);
  });

  it('keeps snapshot values literal and guards only the validation dependencies', function () {
    const {snapshotFilter} = require('../lib/storage/validated-update');
    const stored = {_id: 'id', eventType: 'Temporary Target', targetTop: {$gt: 1}, notes: 'private'};
    const filter = snapshotFilter({_id: 'id'}, stored);
    assert(filter.$and.some(check => check.$expr && JSON.stringify(check.$expr).includes('"$literal":{"$gt":1}')));
    assert(!JSON.stringify(filter).includes('private'));
    assert(filter.$and.some(check => check.targetBottom && check.targetBottom.$exists === false));
  });

  it('normalizes known spellings only in reject mode', async function () {
    for (const mode of ['off', 'log', 'reject']) {
      const f = fixture(mode), doc = valid();
      await f.col.insertOne(doc);
      assert.equal(doc.units, mode === 'reject' ? 'mmol' : 'mmol/L');
    }
  });

  it('builds an explicit refusal without a stored id or mutation of the input', function () {
    const doc = {_id: 'unwritten', ...valid(), targetTop: 1};
    const before = JSON.stringify(doc);
    const refused = validation.refusal(doc, validation.candidate(doc).problems);
    assert.equal(refused._id, undefined);
    assert.equal(refused.refused.status, 400);
    assert.equal(validation.isRefusal(refused), true);
    assert.equal(validation.isRefusal(doc), false);
    assert.equal(JSON.stringify(doc), before);
  });
});


describe('Write-boundary gate controls', function () {
  const {check, ADAPTERS} = require('../scripts/check-write-boundary');
  const fs = require('node:fs'), path = require('node:path');
  it('checks every adapter and catches a removed boundary in each one', function () {
    for (const file of ADAPTERS) {
      const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
      assert.deepEqual(check(source), [], file);
      // Break-it control: replacing the wrapper with an arbitrary pass-through,
      // and an interface acquisition with the driver's, must fail for every
      // real adapter, not just a toy source string. (An adapter that acquires
      // only through the storage interface, such as the websocket, has no
      // wrapper of its own to remove.)
      const bypassed = source.replaceAll('writeStep.collection(', 'passthrough(')
        .replaceAll('reads.collection(', 'ctx.store.collection(');
      assert(check(bypassed).some(issue => issue.includes('raw collection')), file);
    }
  });

  it('counts a storage-interface acquisition and refuses a write around it', function () {
    const head = "const writeStep = require('../storage/write-step');\n"
      + "const reads = require('./storage-reads');\n";
    assert.deepEqual(check(head + 'function store () { return reads.collection(ctx, env, "x", "x"); }\n'
      + 'store().insertOne({});'), []);
    assert.deepEqual(check(head + 'function other () { return somewhere.collection(ctx, "x"); }'),
      ['adapter has no checked collection acquisition']);
    // A write on a write-step handle is behind the boundary but not the
    // interface: the v1 modules keep that handle for aggregate.js and tests.
    const handle = head + 'function api () { return writeStep.collection(ctx.store.collection("x"), {}); }\n';
    assert.deepEqual(check(handle + 'api().find({});'), []);
    for (const write of ['api().insertOne({})', 'api().bulkWrite([])',
      'var c = writeStep.collection(ctx.store.collection("y"), {}); c.deleteMany({})',
      'writeStep.collection(ctx.store.collection("y"), {}).updateOne({}, {})']) {
      assert.deepEqual(check(handle + write + ';').filter(issue => issue.startsWith('write bypasses')).length, 1, write);
    }
  });
});
