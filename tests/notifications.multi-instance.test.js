'use strict';
require('should');

describe('notifications multi-instance', function () {
  var instanceA, instanceB, sharedStorage;

  function makeSharedStorage () {
    var stored = {};
    return {
      _stored: stored,
      getSnooze: async function (level, group) {
        var key = level + '-' + (group || 'default');
        var doc = stored[key];
        if (doc && doc.expiresAt > new Date()) return doc;
        return null;
      },
      setSnooze: async function (level, group, lastAckTime, silenceTime) {
        var ng = group || 'default';
        var key = level + '-' + ng;
        var newExpiresAt = new Date(lastAckTime + silenceTime);
        var existing = stored[key];
        // Conditional upsert mirroring production aggregation pipeline behavior
        if (!existing || newExpiresAt > existing.expiresAt) {
          stored[key] = {
            _id: key, level: level, group: ng,
            lastAckTime: lastAckTime, silenceTime: silenceTime,
            expiresAt: newExpiresAt
          };
        }
        return null;
      }
    };
  }

  function makeInstance (storage) {
    delete require.cache[require.resolve('../lib/notifications')];
    var emits = [];
    var ctx = {
      ddata: { lastUpdated: Date.now() },
      bus: { emit: function (evt, data) { emits.push({ evt: evt, data: data }); } },
      levels: { URGENT: 2, WARN: 1, INFO: 0, toDisplay: function (l) { return 'L' + l; } },
      alarmStorage: storage
    };
    var n = require('../lib/notifications')({ testMode: true }, ctx);
    n.resetStateForTests();
    n.__ctx = ctx;
    n.__emits = emits;
    return n;
  }

  beforeEach(function () {
    sharedStorage = makeSharedStorage();
    instanceA = makeInstance(sharedStorage);
    instanceB = makeInstance(sharedStorage);
  });

  it('ack on instance A is honored by instance B for the snooze duration', function (done) {
    instanceA.ack(2, 'default', 60 * 60 * 1000);

    setImmediate(function () {
      setImmediate(function () {
        // Instance B receives an alarm condition
        instanceB.initRequests();
        instanceB.requestNotify({
          level: 2, group: 'default',
          title: 'High', message: 'High BG',
          plugin: { name: 'test' }
        });
        instanceB.process();

        // First call: refreshPending defers emission
        var firstNotify = instanceB.__emits.some(function (e) {
          return e.evt === 'notification' && !e.data.clear;
        });
        firstNotify.should.equal(false, 'first emit must be deferred while refresh pending');

        setImmediate(function () {
          setImmediate(function () {
            // Re-process: snooze loaded from shared storage, alarm honored
            instanceB.initRequests();
            instanceB.requestNotify({
              level: 2, group: 'default',
              title: 'High', message: 'High BG',
              plugin: { name: 'test' }
            });
            instanceB.process();

            var emittedNotify = instanceB.__emits.some(function (e) {
              return e.evt === 'notification' && !e.data.clear;
            });
            emittedNotify.should.equal(false,
              'Instance B emitted alarm despite instance A ack - regression on #8194');
            done();
          });
        });
      });
    });
  });

  it('URGENT ack on instance A persists both URGENT and WARN rows for instance B', function (done) {
    instanceA.ack(2, 'default', 30 * 60 * 1000);
    setImmediate(function () {
      setImmediate(function () {
        var urgent = sharedStorage._stored['2-default'];
        var warn = sharedStorage._stored['1-default'];
        urgent.should.be.an.Object();
        warn.should.be.an.Object();
        urgent.silenceTime.should.equal(30 * 60 * 1000);
        warn.silenceTime.should.equal(30 * 60 * 1000);
        done();
      });
    });
  });

  it('shorter snooze on instance B does not clobber longer snooze from instance A', function (done) {
    instanceA.ack(2, 'default', 60 * 60 * 1000); // 60 min on A
    setImmediate(function () {
      setImmediate(function () {
        // Attempt to apply 5-min snooze on B -- this would shorten the window
        // if the conditional pipeline were absent. The shared-storage mock mirrors
        // production by keeping the larger expiresAt.
        instanceB.ack(2, 'default', 5 * 60 * 1000);
        setImmediate(function () {
          setImmediate(function () {
            var doc = sharedStorage._stored['2-default'];
            doc.silenceTime.should.equal(60 * 60 * 1000,
              'Storage retained the longer 60-min snooze, not the shorter 5-min');
            done();
          });
        });
      });
    });
  });
});
