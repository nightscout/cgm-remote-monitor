'use strict';

var should = require('should');
var ObjectId = require('mongodb').ObjectId;
var storageFactories = {
  activity: require('../lib/server/activity'),
  devicestatus: require('../lib/server/devicestatus'),
  entries: require('../lib/server/entries'),
  food: require('../lib/server/food'),
  profile: require('../lib/server/profile'),
  treatments: require('../lib/server/treatments')
};

function noopPurifier () {
  return {
    purifyObject: function (document) {
      return document;
    }
  };
}

function fakeContext (collection, includePurifier) {
  var writes = 0;
  var ctx = {
    store: {
      collection: function () {
        writes += 1;
        return collection;
      }
    },
    bus: {emit: function () {}},
    ddata: {
      processRawDataForRuntime: function (documents) {
        return documents;
      }
    }
  };

  if (includePurifier !== false) ctx.purifier = noopPurifier();
  ctx.collectionAccesses = function () { return writes; };
  return ctx;
}

function storageFor (name, collection, includePurifier, envOverrides) {
  var ctx = fakeContext(collection, includePurifier);
  var env = Object.assign({
    activity_collection: 'activity',
    devicestatus_collection: 'devicestatus',
    entries_collection: 'entries',
    food_collection: 'food',
    treatments_collection: 'treatments',
    uuidHandling: false
  }, envOverrides);
  var storage;

  if (name === 'profile') {
    storage = storageFactories.profile('profile', ctx);
  } else {
    storage = storageFactories[name](env, ctx);
  }

  return {api: storage, ctx: ctx};
}

async function expectRejectedPromise (work, messagePattern) {
  var promise;
  var synchronousError;

  try {
    promise = work();
  } catch (err) {
    synchronousError = err;
  }

  should.not.exist(synchronousError);
  should.exist(promise);
  (typeof promise.then).should.equal('function');

  var rejection;
  try {
    await promise;
  } catch (err) {
    rejection = err;
  }

  should.exist(rejection);
  String(rejection.message || rejection).should.match(messagePattern);
}

function assertGeneratedIdFilter (filter, document) {
  Object.keys(filter).should.deepEqual(['_id']);
  Object.keys(filter._id).should.deepEqual(['$eq']);
  filter._id.$eq.should.equal(document._id);
  document._id.should.be.instanceof(ObjectId);
}

describe('legacy storage selector hardening', function () {
  it('does not reuse activity or food documents as fallback selectors', async function () {
    for (const name of ['activity', 'food']) {
      var capturedOperations;
      var collection = {
        bulkWrite: async function (operations) {
          capturedOperations = operations;
          return {upsertedIds: {}};
        }
      };
      var storage = storageFor(name, collection).api;
      var document = {
        created_at: '2026-01-01T00:00:00.000Z',
        nested: {$ne: null}
      };

      await storage.create([document]);

      capturedOperations.length.should.equal(1);
      assertGeneratedIdFilter(capturedOperations[0].replaceOne.filter, document);
    }
  });

  it('uses literal entry dedup values and an id-only fallback selector', async function () {
    var capturedOperations;
    var collection = {
      bulkWrite: async function (operations) {
        capturedOperations = operations;
        return {upsertedIds: {}};
      }
    };
    var storage = storageFor('entries', collection).api;
    var timestamp = Date.parse('2026-01-01T00:00:00.000Z');
    var typed = {type: 'sgv', date: timestamp};
    var untyped = {date: timestamp + 1000, nested: {$ne: null}};

    await storage.create([typed, untyped]);

    capturedOperations[0].updateOne.filter.should.deepEqual({
      sysTime: {$eq: typed.sysTime},
      type: {$eq: 'sgv'}
    });
    assertGeneratedIdFilter(capturedOperations[1].updateOne.filter, untyped);
  });

  it('rejects object-valued entry and treatment selector fields before storage', async function () {
    var collection = {
      bulkWrite: async function () {
        throw new Error('storage must not be reached');
      }
    };
    var entries = storageFor('entries', collection).api;
    var treatments = storageFor('treatments', collection).api;

    await expectRejectedPromise(function () {
      return entries.create([{type: {$ne: null}, date: Date.now()}]);
    }, /Entry type must be a string/);
    await expectRejectedPromise(function () {
      return treatments.create([{identifier: {$ne: null}, eventType: 'Note'}]);
    }, /Treatment identifier must be a string/);
    await expectRejectedPromise(function () {
      return treatments.create([{identifier: 'safe', eventType: {$ne: null}}]);
    }, /Treatment eventType must be a string/);
  });

  it('wraps treatment identifiers and fallback fields in literal equality', async function () {
    var capturedOperations;
    var collection = {
      bulkWrite: async function (operations) {
        capturedOperations = operations;
        return {upsertedIds: {}};
      },
      find: function () {
        return {toArray: async function () { return []; }};
      }
    };
    var storage = storageFor('treatments', collection).api;
    var identified = {
      identifier: '__proto__',
      eventType: 'Note',
      created_at: '2026-01-01T00:00:00.000Z'
    };
    var fallback = {
      eventType: 'Note',
      created_at: '2026-01-01T00:01:00.000Z'
    };

    await storage.create([identified, fallback]);

    capturedOperations[0].replaceOne.filter.should.deepEqual({
      identifier: {$eq: '__proto__'}
    });
    capturedOperations[1].replaceOne.filter.should.deepEqual({
      created_at: {$eq: fallback.created_at},
      eventType: {$eq: 'Note'}
    });
  });

  it('uses a Map when restoring treatment ids for prototype-like identifiers', async function () {
    var existingId = new ObjectId();
    var collection = {
      bulkWrite: async function () {
        return {upsertedIds: {}};
      },
      find: function () {
        return {
          toArray: async function () {
            return [{identifier: '__proto__', _id: existingId}];
          }
        };
      }
    };
    var storage = storageFor('treatments', collection).api;
    var document = {
      identifier: '__proto__',
      eventType: 'Note',
      created_at: '2026-01-01T00:00:00.000Z'
    };

    await storage.create([document]);

    document._id.should.equal(existingId);
  });

  it('keeps legacy profile boundary values literal in prune selectors', async function () {
    var boundary = {startDate: {$ne: null}, _id: new ObjectId()};
    var capturedFilter;
    var cursor = {
      sort: function () { return this; },
      skip: function () { return this; },
      limit: function () { return this; },
      toArray: async function () { return [boundary]; }
    };
    var collection = {
      find: function () { return cursor; },
      deleteMany: async function (filter) {
        capturedFilter = filter;
        return {deletedCount: 1};
      }
    };
    var storage = storageFor('profile', collection).api;

    await storage.prune(10);

    capturedFilter.$or[1].startDate.should.deepEqual({$eq: boundary.startDate});
    capturedFilter.$or[2].startDate.should.deepEqual({$eq: null});
  });

  it('rejects new object-valued profile start dates before insertion', async function () {
    var insertCalls = 0;
    var collection = {
      insertMany: async function () {
        insertCalls += 1;
        return {insertedIds: {}};
      }
    };
    var storage = storageFor('profile', collection).api;

    await expectRejectedPromise(function () {
      return storage.create({startDate: {$ne: null}});
    }, /Profile startDate must be/);

    insertCalls.should.equal(0);
  });

  it('returns rejected Promises when the storage purifier is unavailable', async function () {
    var unreachableCollection = {};
    var cases = [
      {name: 'activity', invoke: function (api) { return api.create([{}]); }},
      {name: 'activity', invoke: function (api) { return api.save({}); }},
      {name: 'devicestatus', invoke: function (api) { return api.create({}); }},
      {name: 'entries', invoke: function (api) { return api.create([{}]); }},
      {name: 'food', invoke: function (api) { return api.create({}); }},
      {name: 'food', invoke: function (api) { return api.save({}); }},
      {name: 'profile', invoke: function (api) { return api.create({}); }},
      {name: 'profile', invoke: function (api) { return api.save({}); }},
      {name: 'treatments', invoke: function (api) { return api.create({}); }},
      {name: 'treatments', invoke: function (api) { return api.save({}); }}
    ];

    for (const testCase of cases) {
      var result = storageFor(testCase.name, unreachableCollection, false);

      await expectRejectedPromise(function () {
        return testCase.invoke(result.api);
      }, /Storage write purifier is not configured/);
      result.ctx.collectionAccesses().should.equal(0);
    }
  });
});
