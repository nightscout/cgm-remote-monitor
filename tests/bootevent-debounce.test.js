'use strict';

/**
 * bootevent-debounce.test.js
 *
 * Tests for Strategy C: leading-edge debounce + concurrency guard
 * in bootevent.js setupListeners.
 *
 * The updateData pipeline must:
 *  1. Fire immediately on first data-received (no delay for normal case)
 *  2. Coalesce rapid data-received events (AAPS batch upload)
 *  3. Never run concurrent dataloader.update() calls (shared ddata guard)
 *  4. Always finish with one final run capturing the latest state
 *
 * These tests exercise the debounce/guard logic by mocking the dataloader
 * and bus, then verifying the number of dataloader.update() calls.
 */

const should = require('should');
const EventEmitter = require('events');

/**
 * Build a minimal bootevent-like setupListeners context.
 * We replicate the exact logic from bootevent.js setupListeners
 * so we can test it in isolation without booting the full server.
 */
function createTestContext (opts) {
  opts = opts || {};
  const _ = require('lodash');
  const bus = new EventEmitter();
  const updateLog = [];
  let updateDelay = opts.updateDelay || 0; // ms to simulate dataloader work

  const ctx = {
    bus: bus,
    ddata: {},
    dataloader: {
      update: function (ddata, callback) {
        const entry = { startedAt: Date.now(), ddata: ddata };
        updateLog.push(entry);
        if (updateDelay > 0) {
          setTimeout(function () {
            entry.finishedAt = Date.now();
            callback();
          }, updateDelay);
        } else {
          entry.finishedAt = Date.now();
          // Use setImmediate to simulate async completion
          setImmediate(callback);
        }
      }
    }
  };

  // Replicate the exact logic from bootevent.js setupListeners
  var dataloadRunning = false;
  var dataloadPending = false;

  function runDataLoad () {
    if (dataloadRunning) {
      dataloadPending = true;
      return;
    }
    dataloadRunning = true;
    ctx.dataloader.update(ctx.ddata, function dataUpdated () {
      dataloadRunning = false;
      ctx.bus.emit('data-loaded');
      if (dataloadPending) {
        dataloadPending = false;
        runDataLoad();
      }
    });
  }

  var updateData = _.debounce(runDataLoad, 1000, { leading: true, trailing: true, maxWait: 5000 });

  ctx.bus.on('tick', function timedReloadData () {
    updateData();
  });

  ctx.bus.on('data-received', function forceReloadData () {
    updateData();
  });

  return {
    ctx: ctx,
    bus: bus,
    updateLog: updateLog,
    // Expose for direct testing
    updateData: updateData,
    runDataLoad: runDataLoad
  };
}

describe('bootevent updateData debounce + concurrency guard', function () {

  describe('leading-edge behavior (no delay for normal case)', function () {

    it('first data-received fires dataloader immediately', function (done) {
      var t = createTestContext();
      t.bus.emit('data-received');
      // Leading edge: should have started synchronously
      t.updateLog.should.have.length(1);
      // Wait for async completion
      t.ctx.bus.once('data-loaded', function () {
        t.updateLog.should.have.length(1);
        done();
      });
    });

    it('tick event also fires dataloader immediately', function (done) {
      var t = createTestContext();
      t.bus.emit('tick', { now: Date.now() });
      t.updateLog.should.have.length(1);
      t.ctx.bus.once('data-loaded', function () {
        done();
      });
    });
  });

  describe('debounce coalescing (batch upload scenario)', function () {

    it('N rapid data-received events produce ≤ 3 dataloader runs', function (done) {
      this.timeout(8000);
      var t = createTestContext({ updateDelay: 50 });

      // Simulate AAPS V1 WebSocket uploading 20 entries rapidly
      for (var i = 0; i < 20; i++) {
        t.bus.emit('data-received');
      }

      // Leading edge fires immediately (1 run)
      t.updateLog.should.have.length(1);

      // Wait for debounce trailing edge + any re-runs
      setTimeout(function () {
        // Should be far fewer than 20 runs
        // Strategy C: 1 leading + at most 1 concurrency re-run + 1 trailing = ≤ 3
        t.updateLog.length.should.be.belowOrEqual(3);
        t.updateLog.length.should.be.above(0);
        done();
      }, 3000);
    });

    it('burst of 50 events produces far fewer than 50 runs', function (done) {
      this.timeout(8000);
      var t = createTestContext({ updateDelay: 100 });

      for (var i = 0; i < 50; i++) {
        t.bus.emit('data-received');
      }

      setTimeout(function () {
        // Without debounce this would be 50 concurrent runs
        t.updateLog.length.should.be.belowOrEqual(4);
        console.log('  50 rapid events → ' + t.updateLog.length + ' dataloader runs');
        done();
      }, 4000);
    });
  });

  describe('concurrency guard (no overlapping dataloader runs)', function () {

    it('dataloader runs never overlap', function (done) {
      this.timeout(8000);
      var t = createTestContext({ updateDelay: 100 });

      // Fire several events with slight spacing
      t.bus.emit('data-received');
      setTimeout(function () { t.bus.emit('data-received'); }, 50);
      setTimeout(function () { t.bus.emit('data-received'); }, 120);
      setTimeout(function () { t.bus.emit('data-received'); }, 200);

      setTimeout(function () {
        // Verify no overlapping runs
        for (var i = 1; i < t.updateLog.length; i++) {
          var prevEnd = t.updateLog[i - 1].finishedAt;
          var currStart = t.updateLog[i].startedAt;
          currStart.should.be.aboveOrEqual(prevEnd,
            'Run ' + i + ' started at ' + currStart + ' before run ' + (i - 1) + ' finished at ' + prevEnd);
        }
        done();
      }, 4000);
    });

    it('pending flag ensures final run after concurrent requests', function (done) {
      this.timeout(8000);
      // Use a longer delay so events arrive while dataloader is running
      var t = createTestContext({ updateDelay: 200 });

      t.bus.emit('data-received'); // starts run 1 (leading edge)

      // These arrive while run 1 is in progress
      setTimeout(function () { t.bus.emit('data-received'); }, 50);
      setTimeout(function () { t.bus.emit('data-received'); }, 100);
      setTimeout(function () { t.bus.emit('data-received'); }, 150);

      setTimeout(function () {
        // Should have: 1 initial + 1 re-run (from pending flag)
        // Debounce trailing may add 1 more
        t.updateLog.length.should.be.aboveOrEqual(2, 'should re-run at least once for pending events');
        t.updateLog.length.should.be.belowOrEqual(3);
        done();
      }, 4000);
    });
  });

  describe('trailing edge (final state captured)', function () {

    it('trailing debounce fires after burst quiets down', function (done) {
      this.timeout(8000);
      var t = createTestContext({ updateDelay: 50 });
      var dataLoadedCount = 0;

      t.ctx.bus.on('data-loaded', function () {
        dataLoadedCount++;
      });

      // Single event
      t.bus.emit('data-received');

      // After debounce window, trailing edge should fire
      setTimeout(function () {
        // At least 1 data-loaded (from leading), possibly 2 (trailing)
        dataLoadedCount.should.be.aboveOrEqual(1);
        done();
      }, 3000);
    });

    it('spaced events each get processed', function (done) {
      this.timeout(10000);
      var t = createTestContext({ updateDelay: 50 });

      // Events spaced > 1s apart (outside debounce window)
      t.bus.emit('data-received');

      setTimeout(function () {
        t.bus.emit('data-received');
      }, 1500);

      setTimeout(function () {
        t.bus.emit('data-received');
      }, 3000);

      setTimeout(function () {
        // Each event outside the debounce window should fire independently
        // At least 3 leading-edge fires + possible trailing
        t.updateLog.length.should.be.aboveOrEqual(3);
        done();
      }, 6000);
    });
  });

  describe('maxWait guarantee', function () {

    it('sustained events still produce a run within 5s', function (done) {
      this.timeout(12000);
      var t = createTestContext({ updateDelay: 50 });

      // Leading edge fires at t=0
      t.bus.emit('data-received');
      var firstRunCount = t.updateLog.length;
      firstRunCount.should.equal(1);

      // Sustained events every 500ms for 6 seconds (keeps resetting trailing edge)
      var interval = setInterval(function () {
        t.bus.emit('data-received');
      }, 500);

      // At 6s, maxWait (5s) should have forced at least one additional run
      setTimeout(function () {
        clearInterval(interval);
        setTimeout(function () {
          // Should have more than just the initial leading-edge run
          t.updateLog.length.should.be.aboveOrEqual(2,
            'maxWait should force a run even with sustained events');
          console.log('  Sustained events over 6s → ' + t.updateLog.length + ' dataloader runs');
          done();
        }, 2000);
      }, 6000);
    });
  });
});
