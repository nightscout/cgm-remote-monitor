var should = require('should');
var Stream = require('stream');

var levels = require('../lib/levels');

describe('notifications', function ( ) {

  var env = {testMode: true};

  var ctx = {
    bus: new Stream
    , ddata: {
      lastUpdated: Date.now()
    }
    , levels: levels
  };

  var notifications = require('../lib/notifications')(env, ctx);

  function examplePlugin () {}

  var exampleInfo = {
    title: 'test'
    , message: 'testing'
    , level: levels.INFO
    , plugin: examplePlugin
  };

  var exampleWarn = {
    title: 'test'
    , message: 'testing'
    , level: levels.WARN
    , plugin: examplePlugin
  };

  var exampleUrgent = {
    title: 'test'
    , message: 'testing'
    , level: levels.URGENT
    , plugin: examplePlugin
  };

  var exampleSnooze = {
    level: levels.WARN
    , title: 'exampleSnooze'
    , message: 'exampleSnooze message'
    , lengthMills: 10000
  };

  var exampleSnoozeNone = {
    level: levels.WARN
    , title: 'exampleSnoozeNone'
    , message: 'exampleSnoozeNone message'
    , lengthMills: 1
  };

  var exampleSnoozeUrgent = {
    level: levels.URGENT
    , title: 'exampleSnoozeUrgent'
    , message: 'exampleSnoozeUrgent message'
    , lengthMills: 10000
  };


  function expectNotification (check, done) {
    //start fresh to we don't pick up other notifications
    ctx.bus = new Stream;
    //if notification doesn't get called test will time out
    ctx.bus.on('notification', function callback (notify) {
      if (check(notify)) {
        done();
      }
    });
  }

  function clearToDone (done) {
    expectNotification(function expectClear (notify) {
      return notify.clear;
    }, done);
  }

  function notifyToDone (done) {
    expectNotification(function expectNotClear (notify) {
      return ! notify.clear;
    }, done);
  }

  it('initAndReInit', function (done) {
    notifications.initRequests();
    notifications.requestNotify(exampleWarn);
    notifications.findHighestAlarm().should.equal(exampleWarn);
    notifications.initRequests();
    should.not.exist(notifications.findHighestAlarm());
    done();
  });


  it('emitAWarning', function (done) {
    //start fresh to we don't pick up other notifications
    ctx.bus = new Stream;
    //if notification doesn't get called test will time out
    ctx.bus.on('notification', function callback ( ) {
      done();
    });

    notifications.resetStateForTests();
    notifications.initRequests();
    notifications.requestNotify(exampleWarn);
    notifications.findHighestAlarm().should.equal(exampleWarn);
    notifications.process();
  });

  it('emitAnInfo', function (done) {
    notifyToDone(done);

    notifications.resetStateForTests();
    notifications.initRequests();
    notifications.requestNotify(exampleInfo);
    should.not.exist(notifications.findHighestAlarm());

    notifications.process();
  });

  it('emitAllClear 1 time after alarm is auto acked', function (done) {
    clearToDone(done);

    notifications.resetStateForTests();
    notifications.initRequests();
    notifications.requestNotify(exampleWarn);
    notifications.findHighestAlarm().should.equal(exampleWarn);
    notifications.process();

    notifications.initRequests();
    //don't request a notify this time, and an auto ack should be sent
    should.not.exist(notifications.findHighestAlarm());
    notifications.process();

    var alarm = notifications.getAlarmForTests(levels.WARN);
    alarm.level.should.equal(levels.WARN);
    alarm.silenceTime.should.equal(1);
    alarm.lastAckTime.should.be.approximately(Date.now(), 2000);
    should.not.exist(alarm.lastEmitTime);

    //clear last emit time, even with that all clear shouldn't be sent again since there was no alarm cleared
    delete alarm.lastEmitTime;

    //process 1 more time to make sure all clear is only sent once
    notifications.initRequests();
    //don't request a notify this time, and an auto ack should be sent
    should.not.exist(notifications.findHighestAlarm());
    notifications.process();
  });

  it('Can be snoozed', function (done) {
    notifyToDone(done); //shouldn't get called

    notifications.resetStateForTests();
    notifications.initRequests();
    notifications.requestNotify(exampleWarn);
    notifications.requestSnooze(exampleSnooze);
    notifications.snoozedBy(exampleWarn).should.equal(exampleSnooze);
    notifications.process();

    done();
  });

  it('Can be snoozed by last snooze', function (done) {
    notifyToDone(done); //shouldn't get called

    notifications.resetStateForTests();
    notifications.initRequests();
    notifications.requestNotify(exampleWarn);
    notifications.requestSnooze(exampleSnoozeNone);
    notifications.requestSnooze(exampleSnooze);
    notifications.snoozedBy(exampleWarn).should.equal(exampleSnooze);
    notifications.process();

    done();
  });

  it('Urgent alarms can\'t be snoozed by warn', function (done) {
    clearToDone(done); //shouldn't get called

    notifications.resetStateForTests();
    notifications.initRequests();
    notifications.requestNotify(exampleUrgent);
    notifications.requestSnooze(exampleSnooze);
    should.not.exist(notifications.snoozedBy(exampleUrgent));
    notifications.process();

    done();
  });

  it('Warnings can be snoozed by urgent', function (done) {
    notifyToDone(done); //shouldn't get called

    notifications.resetStateForTests();
    notifications.initRequests();
    notifications.requestNotify(exampleWarn);
    notifications.requestSnooze(exampleSnoozeUrgent);
    notifications.snoozedBy(exampleWarn).should.equal(exampleSnoozeUrgent);
    notifications.process();

    done();
  });

});

describe('notifications snooze state externalization (#8194)', function () {
  var notifications, fakeStorage, captures, ctx;

  function makeStorage () {
    var stored = {};
    captures = { setSnooze: [], getSnooze: [] };
    return {
      _stored: stored,
      getSnooze: async function (level, group) {
        captures.getSnooze.push([level, group]);
        var key = level + '-' + (group || 'default');
        var doc = stored[key];
        if (doc && doc.expiresAt > new Date()) return doc;
        return null;
      },
      setSnooze: async function (level, group, lastAckTime, silenceTime) {
        captures.setSnooze.push([level, group, lastAckTime, silenceTime]);
        var ng = group || 'default';
        var newExpiresAt = new Date(lastAckTime + silenceTime);
        var key = level + '-' + ng;
        var existing = stored[key];
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

  beforeEach(function () {
    fakeStorage = makeStorage();
    ctx = {
      ddata: { lastUpdated: 0 },
      bus: { emit: function () {}, once: function () {} },
      levels: { URGENT: 2, WARN: 1, INFO: 0, toDisplay: function (l) { return 'L' + l; } },
      alarmStorage: fakeStorage
    };
    delete require.cache[require.resolve('../lib/notifications')];
    notifications = require('../lib/notifications')({ testMode: true }, ctx);
    notifications.resetStateForTests();
  });

  afterEach(function () {
    delete process.env.ALARM_REFRESH_TIMEOUT_MS;
    delete process.env.ALARM_REFRESH_STALE_MS;
  });

  it('ack writes through to alarmStorage.setSnooze for URGENT and cascaded WARN', function (done) {
    notifications.ack(2, 'default', 60000);
    setImmediate(function () {
      captures.setSnooze.length.should.equal(2);
      captures.setSnooze[0][0].should.equal(2);
      captures.setSnooze[0][3].should.equal(60000);
      captures.setSnooze[1][0].should.equal(1);
      captures.setSnooze[1][3].should.equal(60000);
      done();
    });
  });

  it('ack normalizes undefined group to default in storage write', function (done) {
    notifications.ack(2, undefined, 60000);
    setImmediate(function () {
      captures.setSnooze[0][1].should.equal('default');
      done();
    });
  });

  it('ack does not persist malformed snooze lengths, levels or groups', function (done) {
    notifications.ack(2, 'default', 25 * 60 * 60 * 1000);
    notifications.ack(2, 'default', '1800000');
    notifications.ack(2, 'default', -5);
    notifications.ack(NaN, 'default', 60000);
    notifications.ack(2, { $ne: 1 }, 60000);
    notifications.ack(2, new Array(70).join('x'), 60000);
    notifications.ack(0, 'default', 60000);
    setImmediate(function () {
      captures.setSnooze.length.should.equal(0);
      done();
    });
  });

  it('ack does not throw when setSnooze rejects without an error object', function (done) {
    fakeStorage.setSnooze = function () { return Promise.reject(undefined); };
    notifications.ack(2, 'default', 60000);
    setImmediate(function () {
      setImmediate(done);
    });
  });

  it('announcements never wait for the snooze refresh and are not shared', function (done) {
    var emitted = [];
    ctx.bus.emit = function (evt, data) { if (evt === 'notification' && !data.clear) emitted.push(data); };
    ctx.ddata.lastUpdated = Date.now();
    notifications.initRequests();
    notifications.requestNotify({
      level: 2, group: 'Announcement', title: 'Note', message: 'msg',
      plugin: { name: 'test' }, isAnnouncement: true
    });
    notifications.process();
    emitted.length.should.be.above(0);
    captures.getSnooze.length.should.equal(0);
    notifications.ack(2, 'Announcement', 60000);
    setImmediate(function () {
      captures.setSnooze.length.should.equal(0);
      done();
    });
  });

  it('ignores a stored snooze longer than the allowed maximum', function (done) {
    fakeStorage.getSnooze = async function () {
      return { lastAckTime: Date.now(), silenceTime: 25 * 60 * 60 * 1000 };
    };
    notifications.resetStateForTests();
    var emitted = 0;
    ctx.bus.emit = function (evt, data) { if (evt === 'notification' && !data.clear) emitted++; };
    ctx.ddata.lastUpdated = Date.now() + 1000;
    notifications.initRequests();
    notifications.requestNotify({
      level: 2, group: 'default', title: 'Test', message: 'msg', plugin: { name: 'test' }
    });
    notifications.process();
    setImmediate(function () {
      setImmediate(function () {
        emitted.should.equal(1);
        done();
      });
    });
  });

  it('ack does not throw when ctx.alarmStorage is missing (single-instance fallback)', function () {
    ctx.alarmStorage = undefined;
    notifications.ack(2, 'default', 60000);
  });

  it('emitNotification defers first emit while refresh is pending', function (done) {
    // Pre-populate storage as if instance A had ack'd
    fakeStorage.setSnooze(2, 'default', Date.now(), 30 * 60 * 1000).then(function () {
      // Simulate fresh process on instance B by resetting alarms map
      notifications.resetStateForTests();

      var emitCount = 0;
      ctx.bus.emit = function (evt, data) {
        if (evt === 'notification' && !data.clear) emitCount++;
      };
      ctx.ddata.lastUpdated = Date.now();

      notifications.initRequests();
      notifications.requestNotify({
        level: 2, group: 'default', title: 'Test', message: 'msg', plugin: { name: 'test' }
      });
      notifications.process();

      // Synchronously: emit blocked by refreshPending
      emitCount.should.equal(0);

      // After storage callback resolves
      setImmediate(function () {
        setImmediate(function () {
          // Snooze loaded from storage; alarm still snoozed
          notifications.initRequests();
          notifications.requestNotify({
            level: 2, group: 'default', title: 'Test', message: 'msg', plugin: { name: 'test' }
          });
          notifications.process();
          emitCount.should.equal(0);
          done();
        });
      });
    });
  });

  it('first emit blocked while refreshPending, then retried immediately once storage shows no snooze', function (done) {
    ctx.ddata.lastUpdated = Date.now();
    var emitCount = 0;
    ctx.bus.emit = function (evt, data) {
      if (evt === 'notification' && !data.clear) emitCount++;
    };

    notifications.initRequests();
    notifications.requestNotify({
      level: 2, group: 'default', title: 'Test', message: 'msg', plugin: { name: 'test' }
    });
    notifications.process();
    emitCount.should.equal(0, 'emit blocked synchronously while refreshPending');

    setImmediate(function () {
      // Promise microtask resolved before setImmediate: pending notify already retried
      emitCount.should.equal(1, 'pending notify retried immediately once storage resolves');
      setImmediate(function () {
        notifications.initRequests();
        notifications.requestNotify({
          level: 2, group: 'default', title: 'Test', message: 'msg', plugin: { name: 'test' }
        });
        notifications.process();
        emitCount.should.equal(2, 'subsequent process() cycle emits again for ongoing alarm condition');
        done();
      });
    });
  });

  it('pending notify fires even when getSnooze rejects (fail-open for storage error)', function (done) {
    ctx.alarmStorage = {
      getSnooze: function () { return Promise.reject(new Error('mongo down')); },
      setSnooze: function () { return Promise.resolve(); }
    };
    delete require.cache[require.resolve('../lib/notifications')];
    var notifs = require('../lib/notifications')({ testMode: true }, ctx);
    notifs.resetStateForTests();

    ctx.ddata.lastUpdated = Date.now();
    var emitCount = 0;
    var warnMessages = [];
    var origWarn = console.warn;
    console.warn = function () { warnMessages.push(Array.prototype.slice.call(arguments).join(' ')); origWarn.apply(console, arguments); };

    ctx.bus.emit = function (evt, data) {
      if (evt === 'notification' && !data.clear) emitCount++;
    };

    notifs.initRequests();
    notifs.requestNotify({
      level: 2, group: 'default', title: 'Test', message: 'msg', plugin: { name: 'test' }
    });
    notifs.process();
    emitCount.should.equal(0, 'emit blocked synchronously while refreshPending');

    setImmediate(function () {
      // Promise rejection resolves as microtask before setImmediate:
      // catch handler fires, pending notify retried (fail-open)
      emitCount.should.equal(1, 'pending notify fires after storage rejection (fail-open)');
      warnMessages.some(function (m) { return m.indexOf('getSnooze failed') !== -1; })
        .should.be.true('storage error must be logged so operators can detect storage failures');
      console.warn = origWarn;
      done();
    });
  });

  it('invalid stored snooze data is ignored and alarm delivery fails open', function (done) {
    ctx.alarmStorage = {
      getSnooze: function () {
        return Promise.resolve({ lastAckTime: 8640000000000001, silenceTime: 1 });
      },
      setSnooze: function () { return Promise.resolve(); }
    };
    delete require.cache[require.resolve('../lib/notifications')];
    var notifs = require('../lib/notifications')({ testMode: true }, ctx);
    notifs.resetStateForTests();

    ctx.ddata.lastUpdated = Date.now();
    var emitCount = 0;
    ctx.bus.emit = function (evt, data) {
      if (evt === 'notification' && !data.clear) emitCount++;
    };

    notifs.initRequests();
    notifs.requestNotify({
      level: 2, group: 'default', title: 'Test', message: 'msg', plugin: { name: 'test' }
    });
    notifs.process();

    setImmediate(function () {
      emitCount.should.equal(1, 'invalid stored snooze must not suppress the alarm');
      done();
    });
  });

  it('does not gate INFO alarms on storage refresh', function (done) {
    ctx.ddata.lastUpdated = Date.now();
    var emitCount = 0;
    ctx.bus.emit = function (evt, data) {
      if (evt === 'notification' && !data.clear) emitCount++;
    };

    notifications.initRequests();
    notifications.requestNotify({
      level: 0, group: 'default', title: 'INFO', message: 'msg', plugin: { name: 'test' }
    });
    notifications.process();
    // INFO must emit immediately (no refresh gating). autoAckAlarms separately
    // probes WARN+URGENT, which DO arm refresh - that is correct.
    emitCount.should.equal(1, 'INFO must emit synchronously, not be deferred');
    var infoRefreshAttempts = captures.getSnooze.filter(function (call) {
      return call[0] === 0;
    });
    infoRefreshAttempts.length.should.equal(0,
      'INFO must not trigger getSnooze since INFO is not snoozeable');
    done();
  });

  it('refresh timeout emits pending alarm without waiting for another process cycle', function (done) {
    // Replace storage with one that hangs; configure a tight timeout via env
    ctx.alarmStorage = {
      getSnooze: function () { return new Promise(function () {}); },
      setSnooze: function () { return Promise.resolve(); }
    };
    process.env.ALARM_REFRESH_TIMEOUT_MS = '50';
    delete require.cache[require.resolve('../lib/notifications')];
    notifications = require('../lib/notifications')({ testMode: true }, ctx);
    notifications.resetStateForTests();

    ctx.ddata.lastUpdated = Date.now();
    var emitCount = 0;
    ctx.bus.emit = function (evt, data) {
      if (evt === 'notification' && !data.clear) emitCount++;
    };

    notifications.initRequests();
    notifications.requestNotify({
      level: 2, group: 'default', title: 'Test', message: 'msg', plugin: { name: 'test' }
    });
    notifications.process();
    emitCount.should.equal(0);

    setTimeout(function () {
      emitCount.should.equal(1, 'timeout must fail open and emit the pending alarm');
      delete process.env.ALARM_REFRESH_TIMEOUT_MS;
      done();
    }, 100);
  });

  it('rejects timeout values above the Node timer limit', function () {
    process.env.ALARM_REFRESH_TIMEOUT_MS = '2147483648';
    delete require.cache[require.resolve('../lib/notifications')];
    var notifs = require('../lib/notifications')({ testMode: true }, ctx);
    notifs.resetStateForTests();

    var alarm = notifs.getAlarmForTests(2, 'default');
    (alarm.refreshDeadline - alarm.lastRefreshTime).should.equal(5000);
    notifs.resetStateForTests();
  });

  it('refreshes when the wall clock moves behind lastRefreshTime', function (done) {
    var readCount = 0;
    ctx.alarmStorage = {
      getSnooze: function () {
        readCount++;
        return Promise.resolve(null);
      },
      setSnooze: function () { return Promise.resolve(); }
    };
    delete require.cache[require.resolve('../lib/notifications')];
    var notifs = require('../lib/notifications')({ testMode: true }, ctx);
    notifs.resetStateForTests();

    var alarm = notifs.getAlarmForTests(2, 'default');
    setImmediate(function () {
      alarm.lastRefreshTime = Date.now() + 60000;
      ctx.ddata.lastUpdated = Date.now();
      notifs.initRequests();
      notifs.requestNotify({
        level: 2, group: 'default', title: 'Test', message: 'msg', plugin: { name: 'test' }
      });
      notifs.process();
      readCount.should.equal(2, 'clock rollback must trigger a new storage read');
      setImmediate(function () {
        notifs.resetStateForTests();
        done();
      });
    });
  });

  it('explicit ack cancels a pending refresh timeout', function (done) {
    ctx.alarmStorage = {
      getSnooze: function () { return new Promise(function () {}); },
      setSnooze: function () { return Promise.resolve(); }
    };
    process.env.ALARM_REFRESH_TIMEOUT_MS = '30';
    delete require.cache[require.resolve('../lib/notifications')];
    var notifs = require('../lib/notifications')({ testMode: true }, ctx);
    notifs.resetStateForTests();

    ctx.ddata.lastUpdated = Date.now();
    var emitCount = 0;
    ctx.bus.emit = function (evt, data) {
      if (evt === 'notification' && !data.clear) emitCount++;
    };

    notifs.initRequests();
    notifs.requestNotify({
      level: 2, group: 'default', title: 'Test', message: 'msg', plugin: { name: 'test' }
    });
    notifs.process();
    notifs.ack(2, 'default', 60000);

    setTimeout(function () {
      emitCount.should.equal(0, 'ack must prevent the pending timeout from emitting');
      delete process.env.ALARM_REFRESH_TIMEOUT_MS;
      done();
    }, 60);
  });

  it('cleared condition cancels its refresh and recurrence starts a fresh read', function (done) {
    var resolvers = [];
    ctx.alarmStorage = {
      getSnooze: function () {
        return new Promise(function (resolve) { resolvers.push(resolve); });
      },
      setSnooze: function () { return Promise.resolve(); }
    };
    delete require.cache[require.resolve('../lib/notifications')];
    var notifs = require('../lib/notifications')({ testMode: true }, ctx);
    notifs.resetStateForTests();

    ctx.ddata.lastUpdated = Date.now();
    var emitCount = 0;
    ctx.bus.emit = function (evt, data) {
      if (evt === 'notification' && !data.clear) emitCount++;
    };

    notifs.initRequests();
    notifs.requestNotify({
      level: 2, group: 'default', title: 'Test', message: 'msg', plugin: { name: 'test' }
    });
    notifs.process();

    notifs.initRequests();
    notifs.process();
    resolvers.length.should.equal(2, 'clear cycle probes both snoozeable alarm levels');

    notifs.initRequests();
    notifs.requestNotify({
      level: 2, group: 'default', title: 'Test', message: 'returned', plugin: { name: 'test' }
    });
    notifs.process();
    resolvers.length.should.equal(3, 'returning condition must start a fresh storage read');

    resolvers[0](null);
    resolvers[1](null);

    setImmediate(function () {
      emitCount.should.equal(0, 'old reads must not settle the returning condition');
      resolvers[2]({ lastAckTime: Date.now(), silenceTime: 60000 });
      setImmediate(function () {
        emitCount.should.equal(0, 'fresh stored snooze must suppress the returning condition');
        done();
      });
    });
  });

  it('coalesces refresh reads and emits only the latest pending notification', function (done) {
    var resolveRead;
    var readCount = 0;
    ctx.alarmStorage = {
      getSnooze: function () {
        readCount++;
        return new Promise(function (resolve) { resolveRead = resolve; });
      },
      setSnooze: function () { return Promise.resolve(); }
    };
    delete require.cache[require.resolve('../lib/notifications')];
    var notifs = require('../lib/notifications')({ testMode: true }, ctx);
    notifs.resetStateForTests();

    ctx.ddata.lastUpdated = Date.now();
    var emittedMessages = [];
    ctx.bus.emit = function (evt, data) {
      if (evt === 'notification' && !data.clear) emittedMessages.push(data.message);
    };

    notifs.initRequests();
    notifs.requestNotify({
      level: 2, group: 'default', title: 'Test', message: 'first', plugin: { name: 'test' }
    });
    notifs.process();
    notifs.initRequests();
    notifs.requestNotify({
      level: 2, group: 'default', title: 'Test', message: 'latest', plugin: { name: 'test' }
    });
    notifs.process();

    readCount.should.equal(1, 'rapid calls should share one in-flight storage read');
    resolveRead(null);
    setImmediate(function () {
      emittedMessages.should.deepEqual(['latest']);
      done();
    });
  });

  it('uses the later snooze expiry when storage has an older, longer ack', function (done) {
    var storedDoc = { lastAckTime: 1000, silenceTime: 60000 };
    ctx.alarmStorage = {
      getSnooze: function () { return Promise.resolve(storedDoc); },
      setSnooze: function () { return Promise.resolve(); }
    };
    delete require.cache[require.resolve('../lib/notifications')];
    var notifs = require('../lib/notifications')({ testMode: true }, ctx);
    notifs.resetStateForTests();

    var alarm = notifs.getAlarmForTests(2, 'default');
    alarm.lastAckTime = 2000;
    alarm.silenceTime = 1000;
    ctx.ddata.lastUpdated = 50000;
    var emitCount = 0;
    ctx.bus.emit = function (evt, data) {
      if (evt === 'notification' && !data.clear) emitCount++;
    };

    notifs.initRequests();
    notifs.requestNotify({
      level: 2, group: 'default', title: 'Test', message: 'msg', plugin: { name: 'test' }
    });
    notifs.process();

    setImmediate(function () {
      alarm.lastAckTime.should.equal(1000);
      alarm.silenceTime.should.equal(60000);
      emitCount.should.equal(0, 'persisted later expiry must keep the alarm silenced');
      done();
    });
  });

  it('resetStateForTests cancels pending refresh timers', function (done) {
    ctx.alarmStorage = {
      getSnooze: function () { return new Promise(function () {}); },
      setSnooze: function () { return Promise.resolve(); }
    };
    process.env.ALARM_REFRESH_TIMEOUT_MS = '20';
    delete require.cache[require.resolve('../lib/notifications')];
    var notifs = require('../lib/notifications')({ testMode: true }, ctx);
    notifs.resetStateForTests();

    ctx.ddata.lastUpdated = Date.now();
    var emitCount = 0;
    ctx.bus.emit = function (evt, data) {
      if (evt === 'notification' && !data.clear) emitCount++;
    };

    notifs.initRequests();
    notifs.requestNotify({
      level: 2, group: 'default', title: 'Test', message: 'msg', plugin: { name: 'test' }
    });
    notifs.process();
    notifs.resetStateForTests();

    setTimeout(function () {
      emitCount.should.equal(0, 'reset must prevent orphaned timer emission');
      done();
    }, 50);
  });
});
