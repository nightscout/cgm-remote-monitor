# Test Suite Optimization Guide

This document describes optimizations made to the Nightscout test suite and recommendations for further improvements, especially in GitHub Actions CI/CD pipelines.

## Optimizations Implemented

### 1. Converted beforeEach to before for App Initialization

**Files Modified:**
- `tests/api.partial-failures.test.js`
- `tests/api.deduplication.test.js`
- `tests/api.aaps-client.test.js`
- `tests/api.v1-batch-operations.test.js`
- `tests/websocket.shape-handling.test.js`
- `tests/storage.shape-handling.test.js`
- `tests/api.treatments.test.js`
- `tests/api.profiles.test.js`
- `tests/api.devicestatus.test.js`
- `tests/api.food.js`
- `tests/api.activity.js`
- `tests/XX_clean.test.js`

**Impact:** Each file now boots the app once per test file instead of once per test. For files with 10+ tests, this saves significant time.

### 2. Made clearRequireCache Optional

**File Modified:** `tests/hooks.js`

**Change:** The `clearRequireCache()` function now only runs when `CLEAR_REQUIRE_CACHE=true` is set. By default, the require cache is preserved between tests.

**Rationale:** Clearing the require cache after every test forces complete re-initialization of all modules, which is expensive. Most tests don't need full isolation.

**Usage:**
```bash
# Default (faster) - cache is preserved
npm test

# Full isolation mode (slower but more isolated)
CLEAR_REQUIRE_CACHE=true npm test
```

### 3. Added Parallel Test Scripts

**File Modified:** `package.json`

**New Scripts:**
```json
{
  "test:fast": "env-cmd -f ./my.test.env mocha --timeout 5000 --require ./tests/hooks.js --exit --reporter min ./tests/*.test.js",
  "test:parallel": "env-cmd -f ./my.test.env mocha --timeout 10000 --require ./tests/hooks.js --exit --parallel --jobs 4 ./tests/*.test.js",
  "test:parallel:ci": "env-cmd -f ./tests/ci.test.env nyc --reporter=lcov --reporter=text-summary mocha --timeout 10000 --require ./tests/hooks.js --exit --parallel --jobs 4 ./tests/*.test.js"
}
```

## GitHub Actions Recommendations

### Option 1: Sequential Testing with Optimizations (Recommended for CI Stability)

The safest option for CI is to continue running tests sequentially but benefit from the `beforeEach→before` optimizations:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '16'
          cache: 'npm'
      - name: Start MongoDB
        uses: supercharge/mongodb-github-action@1.10.0
      - run: npm ci
      - run: npm run test-ci
```

### Option 2: Parallel Testing (Experimental)

**Warning:** Parallel testing shares the same MongoDB instance across workers. This can cause flaky tests if tests modify global state or use the same document IDs. The `test:parallel:ci` script enables `CLEAR_REQUIRE_CACHE=true` for isolation and limits to 2 jobs to reduce contention.

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '16'
          cache: 'npm'
      - name: Start MongoDB
        uses: supercharge/mongodb-github-action@1.10.0
      - run: npm ci
      - run: npm run test:parallel:ci
```

For true parallel isolation, use the matrix sharding approach below which runs each shard in a separate job with its own MongoDB instance.

### Option 3: Test Sharding with Matrix Strategy

Split tests across multiple runners for maximum parallelization:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '16'
          cache: 'npm'
      - name: Start MongoDB
        uses: supercharge/mongodb-github-action@1.10.0
      - run: npm ci
      - name: Run Tests (Shard ${{ matrix.shard }})
        run: |
          # Get list of test files and run only this shard's portion
          files=(tests/*.test.js)
          total=${#files[@]}
          per_shard=$(( (total + 3) / 4 ))
          start=$(( (matrix.shard - 1) * per_shard ))
          shard_files="${files[@]:$start:$per_shard}"
          env-cmd -f ./tests/ci.test.env mocha --timeout 10000 --require ./tests/hooks.js --exit $shard_files
```

### Option 3: Dependency Caching

Ensure npm dependencies are cached:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: '16'
    cache: 'npm'
```

### Option 4: Conditional Test Execution

Only run tests affected by changes:

```yaml
- name: Get changed files
  id: changed
  uses: tj-actions/changed-files@v40
  with:
    files: |
      lib/**
      tests/**

- name: Run tests
  if: steps.changed.outputs.any_changed == 'true'
  run: npm run test:parallel:ci
```

## Performance Comparison

| Mode | Estimated Time | Use Case |
|------|---------------|----------|
| `npm test` | Baseline | Local development |
| `npm run test:fast` | ~20% faster | Quick feedback, minimal output |
| `npm run test:parallel` | ~50-70% faster | Local with multiple cores |
| Matrix sharding (4 runners) | ~75% faster | CI/CD pipelines |

## Monitoring Test Performance

Use the built-in timing instrumentation:

```bash
# Show slow test warnings
npm run test:timing

# Lower threshold for more aggressive detection
SLOW_TEST_THRESHOLD=500 npm run test:timing
```

## Best Practices for New Tests

1. **Use `before()` for app setup** - Not `beforeEach()` unless you specifically need fresh state
2. **Only clean data in `beforeEach()`** - Database cleanup should happen before tests, not app initialization
3. **Avoid `setTimeout` in tests** - Use polling patterns with `waitForConditionWithWarning()` from `tests/lib/test-helpers.js`
4. **Keep tests independent** - Each test should clean its own data before running
