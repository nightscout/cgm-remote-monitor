'use strict';

/**
 * Controllable Flaky Test Suite
 * 
 * This test file provides tests with configurable, deterministic flakiness levels
 * for validating flakiness detection tools and processes.
 * 
 * USAGE:
 *   # Run with 20% flakiness (default is 0% - always pass)
 *   FLAKINESS_LEVEL=20 npm test -- --grep "flakiness-control"
 * 
 *   # Run with 50% flakiness
 *   FLAKINESS_LEVEL=50 npm test -- --grep "flakiness-control"
 * 
 *   # Run multiple times for statistical validation
 *   for i in {1..100}; do FLAKINESS_LEVEL=20 npm test -- --grep "flakiness-control" 2>/dev/null; done | grep -c "passing\|failing"
 * 
 * ENVIRONMENT VARIABLES:
 *   FLAKINESS_LEVEL      - Percentage chance of failure (0-100). Default: 0
 *   FLAKINESS_SEED       - Optional seed for reproducible randomness
 *   FLAKINESS_LOG        - Set to "true" to log each test decision
 *   FLAKINESS_TIMEOUT_MS - Delay for timeout tests when they fail (default: 300ms)
 * 
 * VALIDATION:
 *   If you run this test N times with FLAKINESS_LEVEL=X, the failure rate
 *   should converge to X% as N increases. For example:
 *   - 100 runs at 20% should yield ~20 failures (with some variance)
 *   - Use this to validate that your flakiness detection tools correctly
 *     identify and measure flakiness rates.
 * 
 * SUMMARY OUTPUT:
 *   The summary at the end reports statistics for flaky tests only (not stable tests).
 *   This allows direct comparison of actual vs expected failure rates.
 */

const should = require('should');

// Configuration from environment
const FLAKINESS_LEVEL = parseFloat(process.env.FLAKINESS_LEVEL) || 0;
const FLAKINESS_SEED = process.env.FLAKINESS_SEED ? parseInt(process.env.FLAKINESS_SEED, 10) : null;
const FLAKINESS_LOG = process.env.FLAKINESS_LOG === 'true';
const FLAKINESS_TIMEOUT_MS = parseInt(process.env.FLAKINESS_TIMEOUT_MS, 10) || 300;

// Simple seeded random for reproducibility
let seedState = FLAKINESS_SEED || Date.now();
function seededRandom() {
  seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
  return seedState / 0x7fffffff;
}

// Get random value (0-1) using seeded or Math.random
function getRandom() {
  return FLAKINESS_SEED !== null ? seededRandom() : Math.random();
}

// Determine if this test run should fail based on flakiness level
function shouldFail(testName) {
  const random = getRandom() * 100;
  const willFail = random < FLAKINESS_LEVEL;
  
  if (FLAKINESS_LOG) {
    console.log(`[FLAKINESS] Test: "${testName}" | Level: ${FLAKINESS_LEVEL}% | Random: ${random.toFixed(2)} | Will fail: ${willFail}`);
  }
  
  return willFail;
}

// Track run statistics for flaky tests only
let runStats = {
  total: 0,
  passed: 0,
  failed: 0
};

// Track pending timeouts that should be recorded as failures
let pendingTimeoutTests = new Set();

describe('flakiness-control', function() {
  this.timeout(5000);

  before(function() {
    console.log('\n=== Flakiness Control Test Suite ===');
    console.log(`Configuration:`);
    console.log(`  FLAKINESS_LEVEL: ${FLAKINESS_LEVEL}%`);
    console.log(`  FLAKINESS_SEED: ${FLAKINESS_SEED !== null ? FLAKINESS_SEED : 'random (not set)'}`);
    console.log(`  FLAKINESS_LOG: ${FLAKINESS_LOG}`);
    console.log(`  FLAKINESS_TIMEOUT_MS: ${FLAKINESS_TIMEOUT_MS}ms`);
    console.log('=====================================\n');
  });

  after(function() {
    // Count any pending timeout tests as failures
    pendingTimeoutTests.forEach(function() {
      runStats.failed++;
    });
    
    const totalFlaky = runStats.total;
    const failRate = totalFlaky > 0 ? ((runStats.failed / totalFlaky) * 100).toFixed(1) : '0.0';
    
    console.log('\n=== Flakiness Control Summary (Flaky Tests Only) ===');
    console.log(`  Total flaky tests: ${totalFlaky}`);
    console.log(`  Passed: ${runStats.passed}`);
    console.log(`  Failed: ${runStats.failed}`);
    console.log(`  Actual failure rate: ${failRate}%`);
    console.log(`  Expected failure rate: ${FLAKINESS_LEVEL}%`);
    console.log('====================================================\n');
  });

  describe('Basic Controllable Flakiness', function() {
    
    it('flaky-basic: should pass or fail based on FLAKINESS_LEVEL', function(done) {
      runStats.total++;
      const testName = 'flaky-basic';
      
      if (shouldFail(testName)) {
        runStats.failed++;
        done(new Error(`Intentional flaky failure at ${FLAKINESS_LEVEL}% level`));
      } else {
        runStats.passed++;
        true.should.be.true();
        done();
      }
    });

    it('flaky-assertion: should have flaky assertion based on FLAKINESS_LEVEL', function(done) {
      runStats.total++;
      const testName = 'flaky-assertion';
      
      const value = shouldFail(testName) ? 'wrong' : 'correct';
      
      try {
        value.should.equal('correct');
        runStats.passed++;
        done();
      } catch (e) {
        runStats.failed++;
        done(e);
      }
    });

    it('flaky-numeric: should have flaky numeric comparison', function(done) {
      runStats.total++;
      const testName = 'flaky-numeric';
      
      const expected = 42;
      const actual = shouldFail(testName) ? 41 : 42;
      
      try {
        actual.should.equal(expected);
        runStats.passed++;
        done();
      } catch (e) {
        runStats.failed++;
        done(e);
      }
    });
  });

  describe('Timing-Based Flakiness', function() {

    it('flaky-timeout: may timeout based on FLAKINESS_LEVEL', function(done) {
      const testTimeout = 200;
      this.timeout(testTimeout);
      runStats.total++;
      const testName = 'flaky-timeout';
      const willFail = shouldFail(testName);
      
      // Use FLAKINESS_TIMEOUT_MS to determine delay when failing
      const delay = willFail ? FLAKINESS_TIMEOUT_MS : 10;
      
      if (willFail) {
        // Mark this test as pending timeout failure
        pendingTimeoutTests.add(testName);
      }
      
      let completed = false;
      setTimeout(function() {
        if (!completed) {
          completed = true;
          pendingTimeoutTests.delete(testName);
          if (!willFail) {
            runStats.passed++;
          }
          done();
        }
      }, delay);
    });

    it('flaky-async: async operation may fail', function(done) {
      runStats.total++;
      const testName = 'flaky-async';
      
      setImmediate(function() {
        if (shouldFail(testName)) {
          runStats.failed++;
          done(new Error('Async operation failed (flaky)'));
        } else {
          runStats.passed++;
          done();
        }
      });
    });

    it('flaky-promise: promise-based test with controllable outcome', function() {
      runStats.total++;
      const testName = 'flaky-promise';
      
      return new Promise(function(resolve, reject) {
        setTimeout(function() {
          if (shouldFail(testName)) {
            runStats.failed++;
            reject(new Error('Promise rejected (flaky)'));
          } else {
            runStats.passed++;
            resolve();
          }
        }, 10);
      });
    });
  });

  describe('Edge Case Flakiness', function() {

    it('flaky-exception: may throw unexpected exception', function(done) {
      runStats.total++;
      const testName = 'flaky-exception';
      
      try {
        if (shouldFail(testName)) {
          throw new Error('Unexpected exception (flaky)');
        }
        runStats.passed++;
        done();
      } catch (e) {
        runStats.failed++;
        done(e);
      }
    });

    it('flaky-null-check: may encounter null unexpectedly', function(done) {
      runStats.total++;
      const testName = 'flaky-null-check';
      
      const data = shouldFail(testName) ? null : { value: 'exists' };
      
      try {
        should.exist(data);
        data.value.should.equal('exists');
        runStats.passed++;
        done();
      } catch (e) {
        runStats.failed++;
        done(e);
      }
    });

    it('flaky-array-length: array may have wrong length', function(done) {
      runStats.total++;
      const testName = 'flaky-array-length';
      
      const items = shouldFail(testName) ? [1, 2] : [1, 2, 3];
      
      try {
        items.should.have.length(3);
        runStats.passed++;
        done();
      } catch (e) {
        runStats.failed++;
        done(e);
      }
    });
  });

  describe('Stable Reference Tests (not included in flaky stats)', function() {

    it('stable-always-passes: reference test that always passes', function(done) {
      true.should.be.true();
      done();
    });

    it('stable-math: stable math operation', function(done) {
      const result = 2 + 2;
      result.should.equal(4);
      done();
    });

    it('stable-string: stable string comparison', function(done) {
      const str = 'hello';
      str.should.equal('hello');
      done();
    });
  });
});

// Export configuration for external tools to query
module.exports = {
  getFlakinessConfig: function() {
    return {
      level: FLAKINESS_LEVEL,
      seed: FLAKINESS_SEED,
      logging: FLAKINESS_LOG,
      timeoutMs: FLAKINESS_TIMEOUT_MS
    };
  }
};
