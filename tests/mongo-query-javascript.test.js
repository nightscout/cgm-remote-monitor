'use strict';

const assert = require('node:assert/strict');
const guard = require('../lib/storage/assert-no-query-javascript');
const query = require('../lib/server/query');
const find = require('../lib/api3/storage/mongoCollection/find');
const modify = require('../lib/api3/storage/mongoCollection/modify');
const {ObjectId} = require('mongodb');

function rejected(error) {
  assert.equal(error.name, 'MongoQueryValidationError');
  assert.equal(error.statusCode, 400);
  assert(!error.message.includes('owned-expression'));
  return true;
}

describe('MongoDB query JavaScript boundary', function () {
  const dangerous = [
    {$where:'owned-expression'},
    {$and:[{date:{$gt:0}}, {$or:[{$where:'owned-expression'}]}]},
    {$expr:{$function:{body:'owned-expression', args:[], lang:'js'}}},
    {$expr:{$eq:[{$function:{body:'owned-expression', args:[], lang:'js'}}, true]}},
    {items:{$all:[{$elemMatch:{$where:'owned-expression'}}]}},
    {$expr:{$accumulator:{init:'owned-expression', accumulate:'owned-expression', lang:'js'}}}
  ];
  dangerous.forEach((filter, index) => {
    it('rejects executable filter shape ' + index + ' before query conversion', function () {
      assert.throws(() => query({find:filter}), rejected);
    });
  });

  it('preserves normal filters and explicit literal data without mutation', function () {
    const objectId = new ObjectId();
    const filter = {_id:objectId, $and:[{sgv:{$gte:80, $lt:200}}, {type:{$in:['sgv','mbg']}}],
      notes:{$regex:'literal \\$where and function', $options:'i'},
      obj:{$eq:{$where:'literal document field'}},
      schema:{$jsonSchema:{properties:{$where:{bsonType:'string'}}}},
      $expr:{$eq:[{$literal:{$function:'literal document field'}}, '$payload']}};
    const snapshot = JSON.stringify(filter);
    assert.equal(guard(filter), filter);
    assert.equal(filter._id, objectId);
    assert.equal(JSON.stringify(filter), snapshot);
  });

  it('preserves literal values inside nested aggregation match stages', function () {
    const pipeline = {$expr:{$facet:{rows:[{$match:{payload:{$eq:{$where:'literal'}}}}]}}};
    assert.equal(guard(pipeline), pipeline);
    pipeline.$expr.$facet.rows.push({$match:{$where:'owned-expression'}});
    assert.throws(() => guard(pipeline), rejected);
  });

  it('checks cyclic objects in both query and expression contexts', function () {
    const shared = {$eq:{$function:{body:'owned-expression'}}};
    const root = {literal:shared, $expr:shared};
    root.self = root;
    assert.throws(() => guard(root), rejected);
    const benign = {sgv:100};
    benign.self = benign;
    assert.equal(guard(benign), benign);
  });

  it('rejects API v3 filters, projections and delete filters before database I/O', async function () {
    const col = {find:() => assert.fail('find must not run'), deleteMany:() => assert.fail('delete must not run')};
    for (const filter of dangerous) {
      await assert.rejects(find.findMany(col, {filter}), rejected);
      await assert.rejects(find.findOneFilter(col, filter, {}), rejected);
      await assert.rejects(modify.deleteManyOr(col, filter), rejected);
    }
    const projection = {computed:{$function:{body:'owned-expression', args:[], lang:'js'}}};
    await assert.rejects(find.findMany(col, {projection}), rejected);
    await assert.rejects(find.findOneFilter(col, {}, projection), rejected);
    await assert.rejects(find.findOne(col, new ObjectId().toHexString(), projection), rejected);
  });

  it('reports aggregate rejection through its callback once', async function () {
    const aggregate = require('../lib/server/aggregate')({}, () => ({aggregate:() => assert.fail('aggregate must not run')}));
    let calls = 0;
    await new Promise((resolve, reject) => {
      aggregate({pipeline:[{$match:{$where:'owned-expression'}}]}, error => {
        try {calls++; rejected(error); resolve();} catch (failure) {reject(failure);}
      });
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
  });

  it('rejects aggregate JavaScript before calling MongoDB', async function () {
    const aggregate = require('../lib/server/aggregate')({}, () => ({aggregate:() => assert.fail('aggregate must not run')}));
    for (const stage of [{$match:{$where:'owned-expression'}},
      {$project:{value:{$function:{body:'owned-expression', args:[], lang:'js'}}}},
      {$group:{_id:null, value:{$accumulator:{init:'owned-expression', lang:'js'}}}}]) {
      await assert.rejects(aggregate({pipeline:[stage]}), rejected);
    }
  });
});
