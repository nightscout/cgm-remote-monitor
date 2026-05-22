# Testing & Architecture Modernization Proposal

**Document Version:** 1.1  
**Last Updated:** January 2026  
**Status:** Draft (2026 Proposal - Revised)  
**Authors:** Nightscout Development Team

---

## Executive Summary

This proposal has been revised based on stakeholder interviews to align testing modernization with broader architectural goals. The original focus on migrating all client tests to Jest has been replaced with a leaner, three-track approach that:

1. **Gets tests running reliably** with updated dependencies
2. **Separates pure logic from DOM code** to enable faster, simpler testing
3. **Prepares for UI modernization** without wasting effort on tests for code that will be replaced

**Key insight:** The current webpack bundle conflates pure logic (hashauth, statistics, data transforms) with DOM manipulation (jQuery, d3 rendering). Separating these concerns unlocks both testability and maintainability.

---

## Interview Findings

The following context informed the revised strategy:

| Question | Finding |
|----------|---------|
| What's driving modernization? | Increase development velocity for new features; potentially removing old ones and consolidating UI libraries |
| Database requirements? | Tests need to run against a database; current deps are outdated |
| UI library plans? | jQuery UI, d3, and other libraries may be consolidated or replaced |
| Critical client tests? | `hashauth.test.js` must continue working (security-critical) |
| Other client tests? | May be deferred since underlying UI code could be rewritten |
| Future architecture? | Server-side statistics API, possibly narrator-driven interface for agentic insulin delivery |
| Test harness security? | jsdom/Playwright must have strict network isolation to prevent unintended requests |

---

## Current State Analysis

### Test Suite Composition

| Category | Count | Framework | Status |
|----------|-------|-----------|--------|
| API/Server Tests | ~60 | mocha + supertest | Functional, needs updates |
| Client/UI Tests | 7 | mocha + benv/jsdom | Fragile, uses unmaintained deps |
| Disabled Tests | 1 | - | `client.test.js.temporary_removed` |

### Client Test Disposition

| File | Decision | Rationale |
|------|----------|-----------|
| `hashauth.test.js` | **Migrate** | Security-critical, must keep working |
| `careportal.test.js` | Skip/Defer | UI code may be rewritten |
| `profileeditor.test.js` | Skip/Defer | Complex UI mocking, low ROI |
| `pluginbase.test.js` | Skip/Defer | Review after logic extraction |
| `admintools.test.js` | Skip/Defer | UI code may be rewritten |
| `reports.test.js` | Skip/Defer | Stats moving to server API |
| `adminnotifies.test.js` | Skip/Defer | Low priority |

### Architectural Problem: Bundle Conflation

The current `bundle.app.js` mixes:
- **Pure logic** (testable without DOM): hashauth crypto, statistics calculations, data transforms, unit conversions
- **DOM manipulation** (requires browser simulation): jQuery selectors, d3 rendering, event handlers, UI state

This conflation forces all client tests to load the entire bundle in a simulated browser, even when testing pure functions.

---

## Three-Track Modernization Plan

### Track 1: Testing Foundation
**Duration:** 2 weeks  
**Risk:** Low  
**Goal:** Get API tests green, migrate hashauth with secure harness

#### Tasks

1. Update mocha from 8.4.0 to 10.x
2. Update supertest from 3.4.2 to 7.x
3. Update nyc from 14.1.1 to 17.x
4. Formalize database test fixture bootstrap
5. Migrate `hashauth.test.js` to locked-down jsdom harness (see Network Isolation below)
6. Document and skip remaining client tests with rationale
7. Verify CI pipeline passes

#### Exit Criteria

- [ ] Green CI run covering all API suites
- [ ] hashauth tests passing with secure jsdom harness
- [ ] Catalog of skipped legacy UI tests with documented rationale
- [ ] Security posture for test harness documented

---

### Track 2: Logic/DOM Separation
**Duration:** 3 weeks (starts after T1 stabilizes)  
**Risk:** Medium  
**Goal:** Extract pure logic for fast, DOM-free testing

#### Proposed Structure

```
lib/
├── client/                 # Existing - DOM-coupled code
│   ├── index.js
│   ├── careportal.js
│   └── ...
├── client-core/            # NEW - Pure logic, no DOM deps
│   ├── hashauth.js         # Crypto/auth logic only
│   ├── statistics.js       # Report calculations
│   ├── transforms.js       # Data transformations
│   ├── units.js            # Unit conversions
│   └── index.js
└── server/                 # Existing server code
```

#### Tasks

1. Inventory client bundle modules: classify as "pure logic" vs "DOM layer"
2. Extract pure logic to `lib/client-core/` with no DOM dependencies
3. Add Mocha unit tests for extracted logic (no jsdom needed)
4. Create thin adapter wrappers for DOM code that calls into client-core
5. Update webpack config to expose client-core separately if needed
6. Document dependency map showing remaining DOM-coupled modules

#### Exit Criteria

- [ ] `lib/client-core/` contains extracted pure logic
- [ ] 80% of extracted logic covered by Node-based tests
- [ ] Documented dependency map of remaining DOM-coupled modules
- [ ] Guidelines published for new code placement

#### Example: hashauth Separation

**Before (DOM-coupled):**
```javascript
// lib/client/hashauth.js
var hashauth = {
  init: function(client, $) {
    // Mixes auth logic with jQuery DOM manipulation
    $('#login-btn').click(function() {
      var token = hashauth.computeToken(password);
      // ...
    });
  },
  computeToken: function(password) {
    // Pure crypto logic
  }
};
```

**After (separated):**
```javascript
// lib/client-core/hashauth.js - Pure logic, testable without DOM
module.exports = {
  computeToken: function(password, salt) { /* ... */ },
  verifyToken: function(token, expected) { /* ... */ },
  generateSalt: function() { /* ... */ }
};

// lib/client/hashauth-ui.js - Thin DOM wrapper
var core = require('../client-core/hashauth');
module.exports = {
  init: function(client, $) {
    $('#login-btn').click(function() {
      var token = core.computeToken(password, salt);
      // ...
    });
  }
};
```

---

### Track 3: UI Modernization Discovery
**Duration:** 4 weeks (starts mid-T2)  
**Risk:** Medium  
**Goal:** Technology decision and migration roadmap

#### Deliverables

1. **Persona-Driven UX Goals**
   - Define user personas (patient, caregiver, clinician)
   - Document key workflows and pain points
   - Establish accessibility requirements

2. **Technology Decision Matrix**
   
   | Criteria | jQuery (retain) | React | Svelte | Vue |
   |----------|-----------------|-------|--------|-----|
   | Bundle size | ? | ? | ? | ? |
   | Team familiarity | ? | ? | ? | ? |
   | Accessibility tooling | ? | ? | ? | ? |
   | Mobile support | ? | ? | ? | ? |
   | Migration effort | ? | ? | ? | ? |

3. **Server-Side Statistics API Contracts**
   - Define endpoints for report statistics
   - Specify response formats
   - Document caching strategy

4. **Narrator/Agent Interface Requirements**
   - Define interaction patterns for voice/agentic control
   - Specify accessibility requirements
   - Document state management needs

5. **Incremental Migration Roadmap**
   - Feature flag strategy for coexisting UI shells
   - Prioritized list of components to migrate
   - Rollback procedures

#### Exit Criteria

- [ ] Technology decision made and documented
- [ ] API contracts for server-side statistics defined
- [ ] Migration roadmap approved by stakeholders
- [ ] Definition of "done" for UI modernization established

---

## Network Isolation Requirements

The test harness must prevent unintended network requests. This is critical for security-related tests like hashauth.

### Locked-Down jsdom Harness

```javascript
// tests/fixtures/secure-jsdom.js
const { JSDOM, ResourceLoader } = require('jsdom');

class NoNetworkLoader extends ResourceLoader {
  fetch(url) {
    console.error(`BLOCKED: Attempted network request to ${url}`);
    return Promise.reject(new Error(`Network requests disabled: ${url}`));
  }
}

function createSecureDOM(html, options = {}) {
  const dom = new JSDOM(html || '<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost',
    resources: new NoNetworkLoader(),
    runScripts: options.runScripts || 'outside-only',
    pretendToBeVisual: true,
    ...options
  });

  // Block fetch API
  dom.window.fetch = () => {
    throw new Error('fetch() is disabled in tests');
  };

  // Block XMLHttpRequest
  dom.window.XMLHttpRequest = class {
    open() {}
    send() { throw new Error('XMLHttpRequest is disabled in tests'); }
  };

  return dom;
}

module.exports = { createSecureDOM, NoNetworkLoader };
```

### Usage in hashauth Test

```javascript
const { createSecureDOM } = require('./fixtures/secure-jsdom');

describe('hashauth', function() {
  let dom;

  before(function() {
    dom = createSecureDOM();
    global.window = dom.window;
    global.document = dom.window.document;
  });

  after(function() {
    dom.window.close();
  });

  it('computes token correctly', function() {
    // Test pure logic without network concerns
  });
});
```

---

## Scope Control Guardrails

### Governance Structure

1. **Milestone Exit Reviews**
   - Each track requires stakeholder sign-off before proceeding
   - Exit criteria must be met, not just "good enough"

2. **Out-of-Scope Log**
   - Maintain explicit list of deferred items per milestone
   - Review and reprioritize at each exit review

3. **Change Control**
   - New UI feature ideas defer until Discovery completes
   - No new UI module without corresponding test strategy
   - Breaking changes require explicit approval

### Scope Boundaries

| In Scope | Out of Scope (for now) |
|----------|------------------------|
| API test updates | MongoDB driver upgrade |
| hashauth test migration | Full client test migration |
| Logic/DOM separation | Complete UI rewrite |
| UI Discovery process | UI implementation |
| Statistics API contracts | Statistics API implementation |

### Dependency Alignment

```
Track 1 (Testing Foundation)
    │
    └──► Track 2 (Logic/DOM Separation) ──► Enables fast pure-logic tests
            │
            └──► Track 3 (UI Discovery) ──► Informs technology choice
                    │
                    └──► Future: UI Implementation (separate proposal)
```

---

## Updated Dependency Strategy

### Phase 1: Minimal Updates (Track 1)

```json
{
  "devDependencies": {
    "mocha": "^10.7.0",
    "supertest": "^7.0.0",
    "nyc": "^17.1.0"
  }
}
```

### Phase 2: jsdom Update (Track 1)

```json
{
  "dependencies": {
    "jsdom": "^24.0.0"
  }
}
```

Note: `benv` removed; direct jsdom usage with secure harness.

### Deferred

- Jest migration (not needed with unified Mocha approach)
- Playwright (revisit after UI stabilizes)

---

## Package.json Script Updates

```json
{
  "scripts": {
    "test": "npm run test:api",
    "test:api": "env-cmd -f ./my.test.env mocha --timeout 5000 --exit ./tests/*.test.js",
    "test:core": "mocha --timeout 5000 ./tests/client-core/**/*.test.js",
    "test:ci": "env-cmd -f ./tests/ci.test.env nyc --reporter=lcov mocha --timeout 5000 --exit ./tests/*.test.js",
    "test:all": "npm run test:api && npm run test:core"
  }
}
```

---

## Risk Assessment

| Track | Risk | Mitigation |
|-------|------|------------|
| T1 | Dependency updates break tests | Run incrementally, fix as needed |
| T1 | jsdom network isolation incomplete | Use NoNetworkLoader + override fetch/XHR |
| T2 | Difficult to separate logic from DOM | Start with clear wins (hashauth, statistics) |
| T2 | Breaks existing functionality | Maintain adapters, run existing tests |
| T3 | Scope creep during discovery | Strict exit criteria, out-of-scope log |
| T3 | Technology decision paralysis | Time-boxed evaluation, decision deadline |

---

## Success Criteria

### Track 1 (Testing Foundation)
- [ ] All API tests pass with updated dependencies
- [ ] hashauth tests pass with secure jsdom harness
- [ ] CI pipeline green
- [ ] Test execution under 5 minutes

### Track 2 (Logic/DOM Separation)
- [ ] `lib/client-core/` established with extracted modules
- [ ] 80% coverage on extracted pure logic
- [ ] No regressions in existing functionality
- [ ] Clear guidelines for new code placement

### Track 3 (UI Discovery)
- [ ] Technology decision documented
- [ ] Statistics API contracts defined
- [ ] Migration roadmap approved
- [ ] Stakeholder buy-in achieved

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

---

## Appendix B: Client Module Inventory Template

Use this template during Track 2 to classify modules:

| Module | Type | DOM Dependencies | Extraction Complexity | Priority |
|--------|------|------------------|----------------------|----------|
| hashauth.js | Mixed | jQuery, localStorage | Low | High |
| statistics.js | Pure | None | Low | High |
| careportal.js | DOM-heavy | jQuery, d3 | High | Low |
| ... | | | | |

---

## Appendix C: UI Technology Evaluation Criteria

For Track 3 Discovery phase:

1. **Performance**
   - Initial bundle size
   - Runtime performance
   - Mobile device support

2. **Developer Experience**
   - Learning curve for team
   - Tooling quality
   - Documentation

3. **Accessibility**
   - ARIA support
   - Screen reader compatibility
   - Keyboard navigation

4. **Migration Path**
   - Incremental adoption possible?
   - jQuery interop
   - Estimated effort

5. **Long-term Viability**
   - Community size
   - Corporate backing
   - Release cadence

---

## Revision History

| Date | Version | Changes |
|------|---------|---------|
| Jan 2026 | 1.0 | Initial draft |
| Jan 2026 | 2.0 | Revised based on stakeholder interviews; three-track approach; added Logic/DOM separation; added UI Discovery track; added network isolation requirements; added scope guardrails |
