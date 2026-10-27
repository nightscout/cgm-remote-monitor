'use strict';

// BF-195: the profile store announced a write (`data-received`, which makes
// the server reload its data and push it to every client) when the write
// started, not when it finished. After a profile re-sent with its own _id,
// the reload could read the profile from before the merge, and the socket's
// dataUpdate carried the old profile. The same order held for a PUT (save)
// and a DELETE (remove).
//
// The collection here is a stub whose write does not finish until the test
// lets it, so the order is checked without depending on timing.

require('should');
var EventEmitter = require('events');
var ObjectID = require('mongodb').ObjectId;

describe('profile store announces a write after it finishes (BF-195)', function () {

  function harness (stored) {
    var log = [];
    var release;
    var gate = new Promise(function (resolve) { release = resolve; });
    var bus = new EventEmitter();
    bus.on('data-received', function () { log.push('data-received'); });

    function held (name, result) {
      return async function () {
        log.push(name + ' started');
        await gate;
        log.push(name + ' finished');
        return result;
      };
    }

    var collection = {
      // A cursor with the methods the storage interface's reads call.
      find: function () {
        var cursor = { toArray: async function () { return stored.slice(); } };
        cursor.sort = cursor.skip = cursor.limit = cursor.project = function () { return cursor; };
        return cursor;
      }
      , findOne: async function () { return null; }
      , insertMany: held('insertMany', { insertedIds: {} })
      , updateOne: held('updateOne', { matchedCount: 1, modifiedCount: 1 })
      , replaceOne: held('replaceOne', { matchedCount: 1 })
      , deleteMany: held('deleteMany', { deletedCount: 1 })
    };
    var ctx = {
      bus: bus
      , purifier: { purifyObject: function () { } }
      , store: { collection: function () { return collection; } }
    };
    var profile = require('../lib/server/profile')('profile', ctx);
    return { log: log, release: release, profile: profile };
  }

  // Let every pending promise step run, so the store reaches its held write.
  function settle () {
    return new Promise(function (resolve) { setImmediate(resolve); });
  }

  function profileDoc (extra) {
    // Synthetic values only.
    return Object.assign({
      defaultProfile: 'Default'
      , store: { Default: { dia: 3, units: 'mg/dl' } }
      , startDate: '2021-03-05T00:00:00.000Z'
      , created_at: '2021-03-05T00:00:00.000Z'
      , units: 'mg/dl'
    }, extra || {});
  }

  it('a re-send announces after its merge is written', async function () {
    var id = new ObjectID();
    var h = harness([profileDoc({ _id: id, q1bMark: 'v0' })]);
    var done = h.profile.create([profileDoc({ _id: String(id), q1bMark: 'v1' })]);
    await settle();
    h.log.should.eql(['updateOne started']);
    h.release();
    await done;
    h.log.should.eql(['updateOne started', 'updateOne finished', 'data-received']);
  });

  it('a new profile announces after it is inserted', async function () {
    var h = harness([]);
    var done = h.profile.create([profileDoc()]);
    await settle();
    h.log.should.eql(['insertMany started']);
    h.release();
    await done;
    h.log.should.eql(['insertMany started', 'insertMany finished', 'data-received']);
  });

  it('a PUT announces after its replacement is written', async function () {
    var h = harness([]);
    var done = h.profile.save(profileDoc({ _id: String(new ObjectID()) }));
    await settle();
    h.log.should.eql(['replaceOne started']);
    h.release();
    await done;
    h.log.indexOf('data-received').should.be.above(h.log.indexOf('replaceOne finished'));
    h.log.indexOf('data-received').should.be.above(h.log.lastIndexOf('deleteMany finished'));
  });

  it('a delete announces after the profile is removed', async function () {
    var h = harness([]);
    var done = h.profile.remove(String(new ObjectID()));
    await settle();
    h.log.should.eql(['deleteMany started']);
    h.release();
    await done;
    h.log.should.eql(['deleteMany started', 'deleteMany finished', 'data-received']);
  });

  it('the callback is answered after the announcement, with the result', async function () {
    var h = harness([]);
    var answered = new Promise(function (resolve) {
      h.profile.create([profileDoc()], function (err, result) {
        h.log.push('callback');
        resolve([err, result]);
      });
    });
    await settle();
    h.release();
    var reply = await answered;
    (reply[0] === null).should.equal(true);
    reply[1].length.should.equal(1);
    h.log.slice(-2).should.eql(['data-received', 'callback']);
  });
});
