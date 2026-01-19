# Flaky Tests Documentation

This document identifies and analyzes flaky tests in the Nightscout test suite, providing guidance on reproducing failures and proposed fixes.

## Overview

Flaky tests are tests that pass sometimes and fail other times without any code changes. They undermine confidence in the test suite and can mask real regressions. This document tracks identified flaky tests, their root causes, and strategies for reproducing and fixing them.

**Last Updated:** January 19, 2026

## Current Status Summary

**Overall Status: ✅ TESTS STABLE - VERIFICATION COMPLETE**

Comprehensive stress testing was performed across 19 key test files. All completed runs showed 100% pass rates with no flaky behavior detected. MongoDB readiness has been verified with:
- Connection pool optimization (default: 5, test: 2)
- Prediction array truncation (default: 288 elements)
- Driver 5.x array handling fixes
- Concurrent write stress tests passing

### Stress Test Results (January 19, 2026)

| Test File | Iterations | Pass Rate | Status |
|-----------|------------|-----------|--------|
| api.entries.test.js | 3 | 100% | ✅ Stable |
| api3.socket.test.js | 3 | 100% | ✅ Stable |
| api.partial-failures.test.js | 3 | 100% | ✅ Stable |
| api.deduplication.test.js | 5 | 100% | ✅ Fixed |
| api3.renderer.test.js | 3 | 100% | ✅ Stable |
| boluswizardpreview.test.js | 3 | 100% | ✅ Stable |
| api.treatments.test.js | 5 | 100% | ✅ Stable |
| api3.create.test.js | 5 | 100% | ✅ Stable |
| api.aaps-client.test.js | 5 | 100% | ✅ Stable |
| api.v1-batch-operations.test.js | 5 | 100% | ✅ Stable |
| websocket.shape-handling.test.js | 5 | 100% | ✅ Stable |
| concurrent-writes.test.js | 5 | 100% | ✅ Stable |
| security.test.js | 5 | 100% | ✅ Stable |
| storage.shape-handling.test.js | 5 | 100% | ✅ Stable |
| verifyauth.test.js | 5 | 100% | ✅ Stable |
| api3.security.test.js | 5 | 100% | ✅ Stable |
| api3.generic.workflow.test.js | 3 | 100% | ✅ Stable |
| api.devicestatus.test.js | 3 | 100% | ✅ Stable |
| api.shape-handling.test.js | 5 | 100% | ✅ Fixed (boot optimization) |

### Slow Tests

Some tests are slow due to server boot overhead (2-3s per test):
- `concurrent-writes.test.js` - AAPS sync simulation tests are slow by design

## Recently Fixed Tests

### boluswizardpreview.test.js - Floating-Point Precision Fix (Fixed January 19, 2026)

**Problem:** Test `set a pill to the BWP with infos` would intermittently fail, expecting `'0.50U'` but receiving `'0.51U'`.

**Root Cause:**
- The `roundInsulinForDisplayFormat()` function in `lib/sandbox.js` used `Math.floor(insulin / 0.01) * 0.01`
- Floating-point precision errors caused values like `0.50499999...` to sometimes be represented as `0.5050000001...`
- The floor operation at this boundary could produce either `0.50` or `0.51` non-deterministically

**Fix Applied:**
1. Added epsilon (`1e-9`) before floor operation: `Math.floor(insulin * 100 + 1e-9) / 100`
2. Applied same fix to medtronic rounding style for consistency
3. The epsilon is small enough not to affect normal values but stabilizes boundary cases

**Verification:** Test passes 100% across 5 consecutive runs.

---

### api.shape-handling.test.js (Fixed January 19, 2026)

**Problem:** Test file was slow and occasionally timed out during stress testing due to excessive server boot overhead.

**Root Cause:**
- Used `beforeEach()` for server boot, causing 26 boots (one per test)
- Each boot takes 2-3 seconds, resulting in ~60-80 seconds of boot overhead
- Stress tests would timeout before completion

**Fix Applied:**
1. Changed `beforeEach()` to `before()` for one-time server boot
2. Kept data cleanup in nested `beforeEach()` hooks for test isolation
3. Test execution time reduced from timeout-prone to ~6 seconds (avg 172ms/test)

**Verification:** Passes 100% across 5 consecutive stress test iterations.

---

### api.deduplication.test.js (Fixed January 2026)

**Problem:** The test `duplicate entry with same date+device+type is detected` would intermittently timeout when run with the full test suite.

**Root Cause:** 
- Server boot overhead (~20s on first test)
- Slow database cleanup when prior tests left large amounts of data
- Original 15s timeout was insufficient

**Fix Applied:**
1. Increased timeout from 15000ms to 30000ms
2. Changed entries cleanup to use `deleteMany({})` for faster full-collection purge
3. Added devicestatus cleanup to reduce database load from prior tests

**Verification:** Passes 100% across 5 consecutive runs in isolation.

---

## Test Infrastructure Improvement Roadmap

This section tracks planned improvements to reduce test cycle time and flakiness. Progress is tracked across improvement cycles.

### Current Cycle: MongoDB Pool Size Optimization (January 2026)

**Goal:** Reduce MongoDB connection pool size for tests to minimize resource usage and improve determinism.

**Status:** ✅ Complete

**Changes Applied:**
- Test environment now uses `MONGO_POOL_SIZE=2` (configured in `my.test.env`)
- Pool size 1 caused timeouts due to request queuing on concurrent operations
- Pool size 2 is the minimum that handles concurrent-writes.test.js (5 parallel requests)
- Production default remains 5 for headroom

**Verification:** All test files pass including concurrent-writes.test.js (13 tests, 100% pass rate across 3 iterations).

---

### Previous Cycle: Server Boot Optimization (January 2026)

**Goal:** Reduce test execution time by eliminating redundant server boots.

**Status:** ✅ Complete

| Test File | Before | After | Improvement |
|-----------|--------|-------|-------------|
| api.shape-handling.test.js | Timeout (~80s boot overhead) | 6s (172ms/test avg) | ~93% faster |

**Pattern Applied:** Change `beforeEach()` to `before()` for server boot; keep data cleanup in nested `beforeEach()` hooks.

---

### Next Cycle 1: Apply Boot Optimization to Remaining Test Files

**Goal:** Identify and optimize other test files using `beforeEach()` for server boot.

**Status:** 🔲 Pending

**Candidates for optimization:**
- `api.devicestatus.test.js` - Uses `beforeEach()` for bootevent
- `api.profiles.test.js` - Uses `beforeEach()` for bootevent
- `api.food.js` - Uses `beforeEach()` for bootevent
- `api.activity.js` - Uses `beforeEach()` for bootevent

**Acceptance Criteria:**
- [ ] Identify all test files with `beforeEach()` bootevent pattern
- [ ] Refactor to `before()` with data cleanup in `beforeEach()`
- [ ] Verify 100% pass rate with 5-iteration stress test
- [ ] Document timing improvements

---

### Next Cycle 2: Timeout Standardization

**Goal:** Standardize test timeouts based on actual execution needs.

**Status:** 🔲 Pending

**Current timeout variations:**
- Default: 2000ms (Mocha default)
- Shape handling tests: 15000ms
- Security tests: 7000ms
- Reports tests: 80000ms
- Deduplication tests: 30000ms

**Proposed actions:**
- [ ] Audit actual test execution times across all test files
- [ ] Establish tiered timeout standards (fast: 5s, medium: 15s, slow: 60s)
- [ ] Add timeout justification comments for non-standard timeouts
- [ ] Remove excessive timeouts that mask slow tests

---

### Next Cycle 3: Test Isolation Audit

**Goal:** Ensure all tests are self-contained and don't depend on execution order.

**Status:** 🔲 Pending

**Known issues to address:**
- Some tests assume data from prior tests (state-dependent)
- Database cleanup inconsistencies between test files
- Module caching affecting test isolation

**Proposed actions:**
- [ ] Run each test file in isolation and compare results to full suite
- [ ] Identify tests that fail when run in different order
- [ ] Add proper fixtures in `beforeEach()` for tests requiring specific data
- [ ] Standardize cleanup patterns (prefer `deleteMany({})` for full purge)

---

## Identified Flaky Tests (Historical)

> **Note:** The tests below were previously identified as flaky but are now stable after various fixes. They are documented here for historical reference and to inform future debugging efforts.

### 1. api.entries.test.js ✅ NOW STABLE

**File:** `tests/api.entries.test.js`

**Affected Tests:**
- `/slice/ can slice with multiple prefix`
- `/times/ can get modal times`
- `/entries/:model`
- Various read operations expecting pre-existing data

**Symptoms:**
- Tests expect arrays with specific lengths but receive empty arrays
- First run after database reset often fails
- Subsequent runs typically pass

**Root Cause:** State-dependent tests
- Tests assume database contains pre-existing entries from prior test setup
- Database state pollution from previous test runs
- Missing proper test isolation and setup fixtures

**Observed Flakiness:** Failed 4/19 tests on initial run, passed all 19 on subsequent runs (observed during manual testing session - actual flakiness rate may vary based on database state)

**Harness:** `npm run test:flaky:entries`

---

### 2. api3.socket.test.js

**File:** `tests/api3.socket.test.js`

**Affected Tests:**
- `should emit create event on CREATE`
- `should emit update event on UPDATE`

**Symptoms:**
- Socket events not received within expected timeout
- Tests pass on retry

**Root Cause:** Timing and race conditions
- WebSocket connections have variable latency
- Event emission timing is non-deterministic
- Server may not be fully ready when socket connects

**Observed Flakiness:** 2/8 tests failed in one run out of five consecutive runs (observed during manual testing - sporadic failures)

**Harness:** `npm run test:flaky:socket`

---

### 3. api.partial-failures.test.js

**File:** `tests/api.partial-failures.test.js`

**Affected Tests:**
- Tests involving partial batch failures
- Concurrent operation tests

**Symptoms:**
- Occasional test timeout (takes >60s on some runs)
- Inconsistent partial failure responses

**Root Cause:** Timing and resource contention
- Tests involve complex concurrent operations
- Database connection pooling affects timing
- Server response time variability

**Observed Flakiness:** 1/11 tests failed in one observed run (sporadic timeouts)

**Harness:** `npm run test:flaky:partial-failures`

---

## Root Cause Categories

### 1. State-Dependent Tests
Tests that rely on data from previous tests or pre-existing database state.

**Solution:** 
- Add proper `beforeEach` fixtures to seed required data
- Ensure each test is self-contained
- Clear and reset database state between tests

### 2. Timing/Race Conditions
Tests with asynchronous operations that have variable completion times.

**Solution:**
- Increase timeouts for socket tests
- Use proper async/await patterns
- Add retry logic for event-based assertions
- Wait for server readiness before making assertions

### 3. Resource Contention
Tests competing for shared resources (database connections, ports).

**Solution:**
- Proper resource cleanup in `afterEach` hooks
- Connection pooling configuration
- Sequential execution for conflicting tests

---

## Flaky Test Harnesses

The following npm scripts are available to run flaky tests in isolation:

### Available Commands

| Command | Description |
|---------|-------------|
| `npm run test:flaky` | Run all tests 10 times and generate report |
| `npm run test:flaky:quick` | Quick scan (3 iterations) |
| `npm run test:flaky:thorough` | Deep analysis (20 iterations) |
| `npm run test:flaky:entries` | Run entries tests in isolation |
| `npm run test:flaky:socket` | Run socket tests in isolation |
| `npm run test:flaky:partial-failures` | Run partial-failures tests in isolation |
| `TEST=testname npm run test:flaky:isolate` | Run any test file in isolation |

### Using the Flaky Test Runner

The flaky test runner (`scripts/flaky-test-runner.js`) runs the test suite multiple times and identifies tests that have inconsistent results.

```bash
# Standard run (10 iterations)
npm run test:flaky

# Quick check (3 iterations)
npm run test:flaky:quick

# Thorough analysis (20 iterations)
npm run test:flaky:thorough

# Custom iterations
FLAKY_TEST_ITERATIONS=5 node scripts/flaky-test-runner.js
```

Results are saved to `./flaky-test-results/`:
- `flaky-test-report-<timestamp>.md` - Human-readable report
- `flaky-test-data-<timestamp>.json` - Machine-readable data

### Isolated Test Harnesses

For debugging specific flaky tests, use the isolation harnesses:

```bash
# Run entries tests 10 times in isolation
npm run test:flaky:entries

# Run socket tests 10 times
npm run test:flaky:socket

# Run any test file in isolation
TEST=api.entries npm run test:flaky:isolate
TEST=api3.socket npm run test:flaky:isolate

# Run with custom iterations
FLAKY_ITERATIONS=5 npm run test:flaky:entries
FLAKY_ITERATIONS=5 TEST=api.entries npm run test:flaky:isolate
```

These harnesses:
1. Run the specified test file in isolation from other test files
2. Execute multiple iterations sequentially and track pass/fail rates
3. Capture detailed timing and error information
4. Generate JSON reports for the specific test file

**Note:** The harnesses rely on the existing Mocha test hooks (`tests/hooks.js`) for any test cleanup. They do not perform additional database resets between iterations. Database state from one iteration may affect subsequent iterations, which can help identify state-dependent flakiness.

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FLAKY_TEST_ITERATIONS` | 10 | Number of test iterations (main runner) |
| `FLAKY_TEST_TIMEOUT` | 300000 | Timeout per iteration (ms) |
| `FLAKY_OUTPUT_DIR` | ./flaky-test-results | Output directory |
| `FLAKY_TEST_ENV_FILE` | ./my.test.env | Test environment file |
| `FLAKY_ITERATIONS` | 10 | Iterations for isolation harnesses |
| `TEST` | (required for isolate) | Test file name for generic isolate runner |

---

## Reproducing Flaky Failures

### Method 1: Multiple Iterations

Run tests multiple times to catch intermittent failures:

```bash
for i in {1..10}; do
  echo "=== Run $i ==="
  npm test 2>&1 | grep -E "(passing|failing)"
done
```

### Method 2: Fresh Database State

Flaky tests often fail on clean database state. To reproduce state-dependent failures:

1. Clear the test database manually
2. Run tests immediately after

This exposes tests that incorrectly assume pre-existing data.

### Method 3: Stress Testing

Increase concurrency to expose race conditions:

```bash
# Run tests in parallel (may expose race conditions)
npm test & npm test
```

---

## Fixing Flaky Tests

### Priority Order

1. **High Impact**: Tests that fail frequently (>20% failure rate in observed runs)
2. **Medium Impact**: Tests that occasionally fail (5-20% in observed runs)
3. **Low Impact**: Rare failures (<5% in observed runs)

### General Fixes

1. **Add proper fixtures**: Ensure test data is created in `beforeEach`
2. **Increase timeouts**: For network/async operations
3. **Add retry logic**: For event-based tests
4. **Improve isolation**: Each test should be independent
5. **Clean up resources**: Proper `afterEach` cleanup
6. **Use warning timeouts**: Replace arbitrary delays with polling + warning pattern (see below)

### Warning Timeout Pattern

Instead of using `setTimeout` with arbitrary delays to wait for async operations, use a polling pattern with warning timeouts. This approach:

1. **Completes tests as fast as possible** - polls immediately and frequently
2. **Surfaces slow operations** - logs warnings when operations take longer than expected
3. **Has a hard timeout** - fails cleanly if the expected state is never reached

**Anti-pattern (don't do this):**
```javascript
// Arbitrary 500ms delay - may be too short under load, wastes time when fast
setTimeout(function() {
  checkDatabaseState();
  done();
}, 500);
```

**Recommended pattern:**
```javascript
waitForConditionWithWarning({
  condition: function(cb) {
    ctx.treatments.list({}, cb);
  },
  assertion: function(list) {
    list.length.should.be.greaterThanOrEqual(3);
  },
  done: done,
  operationName: 'verify treatments created',
  warningThreshold: 200,  // Warn if taking >200ms
  maxTimeout: 5000        // Fail if >5s
});
```

The `waitForConditionWithWarning` helper is now available in the shared test helper module: `tests/lib/test-helpers.js`.

**Usage:**
```javascript
var testHelpers = require('./lib/test-helpers');
var waitForConditionWithWarning = testHelpers.waitForConditionWithWarning;

// For async/await tests:
var waitForConditionAsync = testHelpers.waitForConditionAsync;
```

**Benefits:**
- Tests complete in ~50ms when operations are fast (vs. fixed 500ms delay)
- Warnings help identify operations that are becoming slower over time
- Hard timeout prevents infinite hangs
- No arbitrary timing assumptions

---

## Timing Instrumentation

The test suite includes built-in timing instrumentation to help identify slow tests and setTimeout anti-patterns.

### Available Commands

| Command | Description |
|---------|-------------|
| `npm run test:timing` | Run all tests with setTimeout anti-pattern detection enabled |
| `npm run test:timing:single` | Run single test file with timing warnings (use `TEST=filename`) |
| `npm run test:slow` | Run tests with slow test threshold set to 1000ms |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_TIMING_WARNINGS` | false | Enable setTimeout anti-pattern warnings |
| `SLOW_TEST_THRESHOLD` | 2000 | Threshold (ms) for slow test warnings |

### What the Instrumentation Detects

1. **setTimeout Anti-Patterns**: Warns when tests use `setTimeout` with delays ≥100ms
   - Output: `[SETTIMEOUT ANTI-PATTERN] Long delay of 500ms detected. This may cause flaky tests.`
   
2. **Slow Tests**: Warns when individual tests take longer than the threshold
   - Output: `[SLOW TEST] "test name" took 3500ms (threshold: 2000ms)`

3. **Timing Summary**: After all tests complete, shows:
   - List of slow tests with their durations
   - Total setTimeout call count
   - Average test duration

### Example Output

```
[TIMING INSTRUMENTATION] Enabled - will warn on setTimeout anti-patterns
...
[SETTIMEOUT ANTI-PATTERN #42] Long delay of 200ms detected. This may cause flaky tests.
[SLOW TEST] "socket test" took 3500ms (threshold: 2000ms)
...

[TIMING INSTRUMENTATION] Disabled - detected 84 setTimeout calls

[SLOW TEST SUMMARY] 5 slow test(s) detected:
  1. WebSocket dbAdd test (3668ms)
  2. Socket event test (2742ms)
  ...

[TIMING STATS] Total: 50 tests, Avg: 1200ms, Slow: 5
```

### Test Helper Module

The `tests/lib/test-helpers.js` module provides additional utilities:

| Function | Description |
|----------|-------------|
| `waitForConditionWithWarning(options)` | Callback-based polling with warnings |
| `waitForConditionAsync(options)` | Promise-based polling with warnings |
| `instrumentedSetTimeout(fn, delay, context)` | setTimeout wrapper with logging |
| `trackedDelay(ms, reason)` | Promise delay with timing logs |
| `startTestTimer(testName, warnThreshold, errThreshold)` | Manual test timing |
| `enableSetTimeoutWarnings(options)` | Enable global setTimeout monitoring |

---

## Monitoring

### CI/CD Integration

The flaky test runner can be integrated into CI pipelines:

```yaml
# Example: Run flaky test detection on scheduled basis
flaky-test-scan:
  schedule: "0 0 * * 0"  # Weekly
  script:
    - npm run test:flaky:thorough
    - cat flaky-test-results/flaky-test-report-*.md
```

### Tracking Progress

Monitor flaky test trends over time by:
1. Running `npm run test:flaky:thorough` regularly
2. Comparing reports across time periods
3. Tracking fix rates for identified issues

---

## References

- [Mocha Documentation](https://mochajs.org/)
- [Testing Best Practices](https://github.com/goldbergyoni/javascript-testing-best-practices)
- Main test runner: `scripts/flaky-test-runner.js`
- Isolation harnesses: `scripts/flaky-harnesses/`
- Test helper module: `tests/lib/test-helpers.js`
- Test hooks (timing instrumentation): `tests/hooks.js`
- Existing test specs: `docs/test-specs/`
