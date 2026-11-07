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
    var teardownHandlers = [];
    var ctx = {
      ddata: { lastUpdated: Date.now() },
      bus: {
        emit: function (evt, data) { emits.push({ evt: evt, data: data }); },
        once: function (evt, fn) { if (evt === 'teardown') teardownHandlers.push(fn); }
      },
      levels: { URGENT: 2, WARN: 1, INFO: 0, toDisplay: function (l) { return 'L' + l; } },
      alarmStorage: storage
    };
    var n = require('../lib/notifications')({ testMode: true }, ctx);
    n.resetStateForTests();
    n.__ctx = ctx;
    n.__emits = emits;
    n.__teardown = function () { teardownHandlers.forEach(function (fn) { fn(); }); };
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

  it('warm instance refreshes stale snooze state before re-emitting', function (done) {
    instanceB.initRequests();
    instanceB.requestNotify({
      level: 2, group: 'default',
      title: 'High', message: 'High BG',
      plugin: { name: 'test' }
    });
    instanceB.process();

    setImmediate(function () {
      setImmediate(function () {
        var firstNotify = instanceB.__emits.some(function (e) {
          return e.evt === 'notification' && !e.data.clear;
        });
        firstNotify.should.equal(true, 'warm-up alarm should emit when storage has no snooze');

        instanceA.ack(2, 'default', 60 * 60 * 1000);

        setImmediate(function () {
          setImmediate(function () {
            instanceB.__emits.length = 0;
            var warmAlarm = instanceB.getAlarmForTests(2, 'default');
            warmAlarm.lastRefreshTime = Date.now() - 30001;

            instanceB.__ctx.ddata.lastUpdated = Date.now();
            instanceB.initRequests();
            instanceB.requestNotify({
              level: 2, group: 'default',
              title: 'High', message: 'High BG',
              plugin: { name: 'test' }
            });
            instanceB.process();

            var synchronousNotify = instanceB.__emits.some(function (e) {
              return e.evt === 'notification' && !e.data.clear;
            });
            synchronousNotify.should.equal(false,
              'stale warm instance must defer while reloading shared snooze state');

            setImmediate(function () {
              setImmediate(function () {
                var emittedNotify = instanceB.__emits.some(function (e) {
                  return e.evt === 'notification' && !e.data.clear;
                });
                emittedNotify.should.equal(false,
                  'warm instance emitted despite a newer ack in shared storage');
                done();
              });
            });
          });
        });
      });
    });
  });

  it('a refresh read resolving after a local auto-ack does not resurrect the pre-clear snooze', function (done) {
    // Deferred storage: getSnooze() for a given key doesn't resolve until we
    // call its resolver explicitly, so we can interleave a local auto-ack
    // while the read from an earlier refresh generation is still in flight.
    var resolvers = {};
    var deferredStorage = {
      getSnooze: function (level, group) {
        var key = level + '-' + (group || 'default');
        return new Promise(function (resolve) { resolvers[key] = resolve; });
      },
      setSnooze: async function () { return null; }
    };
    var inst = makeInstance(deferredStorage);

    // Cold path: creates the alarm, kicks off a refresh (generation 1), read
    // pending. First emit defers while that read is outstanding.
    inst.initRequests();
    inst.requestNotify({
      level: 2, group: 'default',
      title: 'High', message: 'High BG',
      plugin: { name: 'test' }
    });
    inst.process();

    var alarm = inst.getAlarmForTests(2, 'default');
    alarm.lastEmitTime = Date.now(); // actively alerting, unacked

    // Condition clears before the generation-1 read resolves. autoAckAlarms
    // invalidates the in-flight refresh (generation -> 2+) and auto-acks to
    // a ~0 silence window so the alarm can re-fire immediately if the
    // condition returns.
    inst.initRequests();
    inst.process();

    var expiryAfterAutoAck = alarm.lastAckTime + alarm.silenceTime;

    // The generation-1 read now resolves, carrying another instance's still-
    // valid 60-minute snooze from 5 minutes ago -- data that predates the
    // local auto-ack but arrives after it.
    resolvers['2-default']({
      lastAckTime: Date.now() - 5 * 60 * 1000,
      silenceTime: 60 * 60 * 1000
    });

    setImmediate(function () {
      setImmediate(function () {
        (alarm.lastAckTime + alarm.silenceTime).should.equal(expiryAfterAutoAck,
          'stale refresh resurrected a pre-auto-ack snooze -- regression on the generation gate');
        done();
      });
    });
  });

  it('teardown cancels a pending snooze refresh so nothing is emitted afterwards', function (done) {
    var resolvers = {};
    var deferredStorage = {
      getSnooze: function (level, group) {
        var key = level + '-' + (group || 'default');
        return new Promise(function (resolve) { resolvers[key] = resolve; });
      },
      setSnooze: async function () { return null; }
    };
    var inst = makeInstance(deferredStorage);

    // Cold path: the first emit is deferred while the storage read is pending.
    inst.initRequests();
    inst.requestNotify({
      level: 2, group: 'default',
      title: 'High', message: 'High BG',
      plugin: { name: 'test' }
    });
    inst.process();

    var alarm = inst.getAlarmForTests(2, 'default');
    alarm.refreshPending.should.equal(true, 'refresh must be pending before teardown');

    inst.__teardown();
    (alarm.refreshTimer === null).should.equal(true, 'teardown must clear the refresh timer');

    // The in-flight read resolves after teardown.
    resolvers['2-default'](null);

    setImmediate(function () {
      setImmediate(function () {
        var emitted = inst.__emits.some(function (e) {
          return e.evt === 'notification' && !e.data.clear;
        });
        emitted.should.equal(false, 'notification emitted after teardown');
        done();
      });
    });
  });
});
