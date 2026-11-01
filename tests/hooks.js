'use strict;'

// NS_TEST_BACKEND: validated here, so an unknown name stops the run before any
// test file loads (tests/support/backends.js).
require('./support/backends').install();

require('./lib/supertest-loopback');

var testHelpers = require('./lib/test-helpers');
var productionSafety = require('./lib/production-safety');

// GAP-SYNC-046: Pre-flight safety check (no DB required)
productionSafety.preflightCheck();

var slowTestThreshold = parseInt(process.env.SLOW_TEST_THRESHOLD, 10) || 2000;
var enableTimingWarnings = process.env.ENABLE_TIMING_WARNINGS === 'true';
var enableRequireCacheClear = process.env.CLEAR_REQUIRE_CACHE === 'true';
var restoreSetTimeout = null;
var testTimings = [];

function clearRequireCache () {
  Object.keys(require.cache).forEach(function(key) {
    delete require.cache[key];
  });
}

exports.mochaHooks = {
  beforeAll(done) {
    if (enableTimingWarnings) {
      console.log('[TIMING INSTRUMENTATION] Enabled - will warn on setTimeout anti-patterns');
      restoreSetTimeout = testHelpers.enableSetTimeoutWarnings({
        warnOnLongDelays: true,
        longDelayThreshold: 100
      });
    }
    if (enableRequireCacheClear) {
      console.log('[CACHE CLEAR] Enabled - will clear require cache after each test (slower but more isolated)');
    }
    done();
  },

  beforeEach(done) {
    this.testStartTime = Date.now();
    done();
  },

  afterEach(done) {
    if (this.testStartTime) {
      var elapsed = Date.now() - this.testStartTime;
      var testTitle = this.currentTest ? this.currentTest.fullTitle() : 'unknown';
      
      testTimings.push({
        title: testTitle,
        duration: elapsed,
        slow: elapsed > slowTestThreshold
      });
      
      if (elapsed > slowTestThreshold) {
        console.warn('[SLOW TEST] "' + testTitle + '" took ' + elapsed + 'ms (threshold: ' + slowTestThreshold + 'ms)');
      }
    }
    
    if (enableRequireCacheClear) {
      clearRequireCache();
    }
    done();
  },

  afterAll(done) {
    if (restoreSetTimeout) {
      var setTimeoutCallCount = restoreSetTimeout();
      console.log('[TIMING INSTRUMENTATION] Disabled - detected ' + setTimeoutCallCount + ' setTimeout calls');
    }
    
    if (testTimings.length > 0) {
      var slowTests = testTimings.filter(function(t) { return t.slow; });
      if (slowTests.length > 0) {
        console.log('\n[SLOW TEST SUMMARY] ' + slowTests.length + ' slow test(s) detected:');
        slowTests.forEach(function(t, i) {
          console.log('  ' + (i + 1) + '. ' + t.title + ' (' + t.duration + 'ms)');
        });
      }
      
      var totalTime = testTimings.reduce(function(sum, t) { return sum + t.duration; }, 0);
      var avgTime = Math.round(totalTime / testTimings.length);
      console.log('\n[TIMING STATS] Total: ' + testTimings.length + ' tests, Avg: ' + avgTime + 'ms, Slow: ' + slowTests.length);
    }
    
    // Under NS_TEST_BACKEND other than mongodb, a file outside the census that
    // tried to reach MongoDB fails the run (tests/support/backends.js).
    var reached = require('./support/backends').unclassifiedReached();
    if (reached.length) {
      return done(new Error('Test files reached MongoDB under NS_TEST_BACKEND=' + process.env.NS_TEST_BACKEND
        + ' but are not in tests/support/backend-census.json: ' + reached.join(', ')));
    }
    done();
  }
};
