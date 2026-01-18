# Flaky Tests Documentation

This document identifies and analyzes flaky tests in the Nightscout test suite, providing guidance on reproducing failures and proposed fixes.

## Overview

Flaky tests are tests that pass sometimes and fail other times without any code changes. They undermine confidence in the test suite and can mask real regressions. This document tracks identified flaky tests, their root causes, and strategies for reproducing and fixing them.

**Last Updated:** January 2026

## Identified Flaky Tests

### 1. api.entries.test.js

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

The `waitForConditionWithWarning` helper is available in `tests/websocket.shape-handling.test.js` and can be extracted into a shared test utility if needed.

**Benefits:**
- Tests complete in ~50ms when operations are fast (vs. fixed 500ms delay)
- Warnings help identify operations that are becoming slower over time
- Hard timeout prevents infinite hangs
- No arbitrary timing assumptions

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
- Existing test specs: `docs/test-specs/`
