# Testing Modernization Proposal

**Date:** January 2026  
**Status:** Draft  
**Author:** Nightscout Development Team

## Executive Summary

The Nightscout test suite contains 78 test files spanning API/server tests and client/UI tests. While server-side tests using supertest remain functional, the client-side tests using benv/jsdom are built on unmaintained dependencies from 2018 and require modernization.

This proposal outlines a phased approach to update dependencies, migrate the client testing infrastructure, and establish a sustainable testing strategy.

---

## Current State Analysis

### Test Suite Composition

| Category | Count | Framework | Status |
|----------|-------|-----------|--------|
| API/Server Tests | ~60 | mocha + supertest | Functional, needs updates |
| Client/UI Tests | 7 | mocha + benv/jsdom | Broken/Fragile |
| Disabled Tests | 1 | - | `client.test.js.temporary_removed` |

### Server-Side Tests (Healthy)

Tests using `supertest` to validate Express routes:
- `tests/api.*.test.js` - REST API endpoints
- `tests/api3.*.test.js` - API v3 endpoints  
- `tests/security.test.js` - Authentication/authorization
- Plugin tests (`ar2`, `bgnow`, `basalprofileplugin`, etc.)

**These tests work but use outdated dependencies.**

### Client-Side Tests (Problematic)

Tests using `benv` to simulate browser environment:
- `tests/careportal.test.js`
- `tests/hashauth.test.js`
- `tests/profileeditor.test.js`
- `tests/pluginbase.test.js`
- `tests/admintools.test.js`
- `tests/reports.test.js`
- `tests/adminnotifies.test.js`

**These tests rely on:**
- `benv` (last updated 2018, unmaintained)
- `jsdom` pinned to v11.11.0 (2018)
- Custom `tests/fixtures/headless.js` harness
- Mocked jQuery, d3, socket.io, localStorage

---

## Dependency Analysis

### Critical Dependencies Requiring Updates

| Package | Current | Latest | Severity | Notes |
|---------|---------|--------|----------|-------|
| `jsdom` | =11.11.0 | 24.x | **Critical** | Pinned to 2018 version, security vulnerabilities |
| `benv` | 3.3.0 | 3.3.0 | **Critical** | Unmaintained since 2018, must replace |
| `supertest` | 3.4.2 | 7.x | High | Major API changes, needs testing |
| `mocha` | 8.4.0 | 10.x | Medium | Minor breaking changes |
| `nyc` | 14.1.1 | 17.x | Medium | Coverage tool, or migrate to c8 |
| `should` | 13.2.3 | 13.2.3 | Low | Stable, but consider modern alternatives |

### Related Production Dependencies

| Package | Current | Latest | Notes |
|---------|---------|--------|-------|
| `axios` | 0.21.1 | 1.7.x | High severity vulnerabilities, affects tests |
| `express` | 4.17.1 | 4.21.x | Security patches available |
| `mongodb` | 3.6.0 | 6.x | Major version, significant API changes |

---

## Recommended Strategy

### Phase 1: Server-Side Test Updates (Low Risk)

**Effort:** 2-4 hours  
**Risk:** Low  
**Dependencies Affected:** mocha, supertest, nyc, should

#### Tasks:
1. Update `mocha` from 8.4.0 to 10.x
2. Update `supertest` from 3.4.2 to 7.x
3. Update `nyc` from 14.1.1 to 17.x (or migrate to `c8`)
4. Run full test suite, fix any breaking changes
5. Verify CI pipeline passes

#### Breaking Changes to Address:
- Mocha 10.x: ESM support changes, `--exit` flag behavior
- Supertest 7.x: Promise-based API preferred over callbacks

---

### Phase 2: Client Test Migration (Medium Effort)

**Effort:** 8-16 hours  
**Risk:** Medium  
**Approach:** Migrate from benv/jsdom to Jest with jsdom environment

#### Why Jest?
1. Built-in jsdom environment (always current)
2. Snapshot testing for UI components
3. Better mocking utilities
4. Parallel test execution
5. Active maintenance and community

#### Migration Path:

##### Step 2.1: Install Jest
```bash
npm install --save-dev jest jest-environment-jsdom @types/jest
```

##### Step 2.2: Create Jest Configuration
```javascript
// jest.config.js
module.exports = {
  testEnvironment: 'jsdom',
  testMatch: ['**/tests/client/**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/jest.setup.js'],
  moduleNameMapper: {
    '\\.(css|less|scss)$': 'identity-obj-proxy'
  }
};
```

##### Step 2.3: Bundle Loading Strategy (Critical)

The current `headless.js` loads the compiled Nightscout bundle from:
```
node_modules/.cache/_ns_cache/public/js/bundle.app.js
```

This bundle exposes `window.Nightscout` which client tests depend on. There are two approaches:

**Option A: Load Pre-Built Bundle (Recommended for initial migration)**

Require the built bundle in Jest setup, similar to current benv approach:

```javascript
// tests/jest.setup.js (CommonJS - do NOT use ESM import syntax)
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
  runScripts: 'dangerously'
});

global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;

// Mock dependencies BEFORE loading bundle
global.$ = global.jQuery = require('jquery');
global.d3 = require('d3');
global.io = {
  connect: jest.fn(() => ({
    on: jest.fn(),
    emit: jest.fn()
  }))
};

// Expose mocks to window for bundle compatibility
dom.window.$ = global.$;
dom.window.jQuery = global.jQuery;
dom.window.d3 = global.d3;
dom.window.io = global.io;

// Load the Nightscout bundle (must be built first: npm run bundle)
const bundlePath = path.join(__dirname, '../node_modules/.cache/_ns_cache/public/js/bundle.app.js');
if (fs.existsSync(bundlePath)) {
  const bundleCode = fs.readFileSync(bundlePath, 'utf8');
  dom.window.eval(bundleCode);
  global.Nightscout = dom.window.Nightscout;
} else {
  console.warn('Warning: Bundle not found. Run "npm run bundle" before tests.');
}
```

**Option B: Direct Module Imports (Longer-term refactor)**

Refactor client code to be importable as ES modules, eliminating bundle dependency:

```javascript
// Future approach - import client modules directly
const client = require('../lib/client');
const careportal = require('../lib/client/careportal');
```

This requires refactoring client code to not depend on global `window.Nightscout`.

**Recommendation:** Start with Option A to validate the Jest migration works, then incrementally move to Option B as client code is modularized.

##### Step 2.4: Pre-test Build Requirement

Add a pre-test script to ensure bundle exists:

```json
{
  "scripts": {
    "pretest:client": "npm run bundle",
    "test:client": "jest --config jest.config.js"
  }
}
```

##### Step 2.5: Migrate Tests Incrementally
For each benv-based test:

1. Create new file in `tests/client/` directory
2. Convert `describe`/`it` syntax (mostly compatible)
3. Replace benv setup with Jest globals
4. Update assertions from `should` to `expect`
5. Run and verify

##### Step 2.5: Remove Legacy Dependencies
```bash
npm uninstall benv jsdom
```

---

### Phase 3: Enhanced Testing (Optional)

**Effort:** 16-24 hours  
**Risk:** Low (additive)  

#### Option A: Playwright for E2E Testing
For true browser testing of complex UI flows:

```javascript
// tests/e2e/careportal.spec.js
const { test, expect } = require('@playwright/test');

test('careportal treatment entry', async ({ page }) => {
  await page.goto('/');
  await page.click('#careportal-btn');
  await page.fill('#carbsGiven', '10');
  await page.fill('#insulinGiven', '0.60');
  await page.click('#submit-treatment');
  await expect(page.locator('.treatment-success')).toBeVisible();
});
```

#### Option B: Component Testing with Testing Library
For isolated component testing:

```javascript
import { render, screen, fireEvent } from '@testing-library/dom';
import careportal from '../lib/client/careportal';

test('shows carb input when snack bolus selected', () => {
  // render component
  // interact and assert
});
```

---

## Recommended Test Directory Structure

```
tests/
├── api/                    # API endpoint tests (supertest)
│   ├── entries.test.js
│   ├── treatments.test.js
│   └── ...
├── client/                 # Client-side tests (Jest)
│   ├── careportal.test.js
│   ├── hashauth.test.js
│   └── ...
├── e2e/                    # End-to-end tests (Playwright, optional)
│   └── smoke.spec.js
├── plugins/                # Plugin unit tests
│   ├── ar2.test.js
│   └── ...
├── fixtures/               # Shared test data and utilities
│   ├── load.js
│   └── default-server-settings.js
└── jest.setup.js           # Jest global setup
```

---

## Migration Checklist

### Phase 1 Checklist
- [ ] Update mocha to 10.x
- [ ] Update supertest to 7.x  
- [ ] Update nyc to 17.x
- [ ] Fix any callback → Promise migrations
- [ ] Verify all API tests pass
- [ ] Update CI configuration if needed

### Phase 2 Checklist
- [ ] Install Jest and jest-environment-jsdom
- [ ] Create jest.config.js
- [ ] Create tests/jest.setup.js with mocks (use CommonJS, NOT ESM)
- [ ] Implement bundle loading strategy (load pre-built bundle via eval)
- [ ] Add pretest:client script to build bundle before tests
- [ ] Verify window.Nightscout is available in Jest environment
- [ ] Migrate careportal.test.js
- [ ] Migrate hashauth.test.js
- [ ] Migrate profileeditor.test.js
- [ ] Migrate pluginbase.test.js
- [ ] Migrate admintools.test.js
- [ ] Migrate reports.test.js
- [ ] Migrate adminnotifies.test.js
- [ ] Review and potentially restore client.test.js
- [ ] Remove benv dependency
- [ ] Update jsdom to use Jest's version
- [ ] Update package.json scripts

### Phase 3 Checklist (Optional)
- [ ] Evaluate need for E2E tests
- [ ] Install Playwright if needed
- [ ] Create critical path E2E tests
- [ ] Set up CI for E2E tests

---

## Package.json Script Updates

```json
{
  "scripts": {
    "test": "npm run test:api && npm run test:client",
    "test:api": "env-cmd -f ./my.test.env mocha --timeout 5000 --exit ./tests/api/**/*.test.js ./tests/plugins/**/*.test.js",
    "test:client": "jest --config jest.config.js",
    "test:e2e": "playwright test",
    "test:ci": "npm run test:api -- --reporter mocha-junit-reporter && npm run test:client -- --ci",
    "test:coverage": "nyc npm run test:api && jest --coverage"
  }
}
```

---

## Risk Assessment

| Phase | Risk | Mitigation |
|-------|------|------------|
| Phase 1 | Test failures from API changes | Run tests incrementally, fix as needed |
| Phase 2 | Incomplete mocking in Jest | Document all mocked globals, test thoroughly |
| Phase 2 | Bundle loading in Jest fails | Use Option A (load pre-built bundle via eval), ensure `npm run bundle` runs before tests |
| Phase 2 | `window.Nightscout` undefined | Verify bundle exposes globals correctly, add fallback error messages |
| Phase 2 | ESM/CommonJS mismatch | Use CommonJS syntax in jest.setup.js (require, not import) |
| Phase 3 | CI time increase | Run E2E only on main branch |

---

## Success Criteria

1. **All existing server tests pass** with updated dependencies
2. **All client tests migrated** to Jest and passing
3. **No unmaintained dependencies** in test infrastructure
4. **CI/CD pipeline updated** and green
5. **Test execution time** remains under 5 minutes
6. **Code coverage** maintained or improved

---

## Appendix A: Current Test Dependencies

```json
{
  "devDependencies": {
    "@types/tough-cookie": "^4.0.0",
    "axios": "^0.21.1",
    "babel-eslint": "^10.1.0",
    "benv": "^3.3.0",
    "csv-parse": "^4.12.0",
    "env-cmd": "^10.1.0",
    "eslint": "^7.19.0",
    "eslint-plugin-security": "^1.4.0",
    "eslint-webpack-plugin": "^2.7.0",
    "mocha": "^8.4.0",
    "nodemon": "^2.0.19",
    "nyc": "^14.1.1",
    "should": "^13.2.3",
    "supertest": "^3.4.2",
    "webpack-bundle-analyzer": "^4.5.0",
    "webpack-dev-middleware": "^4.3.0",
    "webpack-hot-middleware": "^2.25.2",
    "xml2js": "^0.4.23"
  },
  "dependencies": {
    "jsdom": "=11.11.0"
  }
}
```

## Appendix B: Proposed Updated Dependencies

```json
{
  "devDependencies": {
    "jest": "^29.7.0",
    "jest-environment-jsdom": "^29.7.0",
    "mocha": "^10.7.0",
    "supertest": "^7.0.0",
    "nyc": "^17.1.0",
    "@playwright/test": "^1.48.0"
  }
}
```

Note: `benv` removed, `jsdom` managed by jest-environment-jsdom

---

## Appendix C: Files Requiring Migration

| File | Priority | Complexity | Notes |
|------|----------|------------|-------|
| `careportal.test.js` | High | Medium | Core functionality |
| `hashauth.test.js` | High | Low | Security critical |
| `profileeditor.test.js` | Medium | High | Complex UI mocking |
| `pluginbase.test.js` | Medium | Low | Plugin infrastructure |
| `admintools.test.js` | Medium | Medium | Admin features |
| `reports.test.js` | Low | High | Complex rendering |
| `adminnotifies.test.js` | Low | Low | Notifications |
| `client.test.js` | High | High | Currently disabled, needs review |
