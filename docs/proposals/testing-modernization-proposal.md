# Testing & Architecture Modernization Proposal

**Document Version:** 1.2
**Last Updated:** May 2026
**Status:** Tracks 1+2 substantially complete; Track 3 pending
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
- [x] All API tests pass with updated dependencies (jsdom@24, mocha 10, supertest 7, nyc 17)
- [x] hashauth tests pass with secure jsdom harness (`tests/hashauth.modern.test.js`)
- [x] `benv` package removed; single jsdom@24 dependency tree (Phase 4, 2026-05)
- [x] CI pipeline green on Node 22 / Node 24 (890 passing / 3 pending / 0 failing, ~44s)
- [x] Test execution under 5 minutes (44s wall-clock)
- [x] Remaining legacy bundle-driven tests modernized or formally retired:
  - `careportal.test.js` — still drives the bundle through the
    benv-shim, but pure logic now lives in `lib/client-core/careportal/`
    with 22 Node-only tests (Phase 5a, commit `f19a58b8`).
  - `profileeditor.test.js` — `it.skip` removed; replaced by
    `tests/profileeditor.records.test.js` plus 44 Node-only tests
    under `tests/client-core/profile-editor-*.test.js`
    (Phase 5b, commit `55968ff3`).
  - `reports.test.js` — `describe.skip` retained with a pointer to
    `tests/bundle.smoke.test.js` (wiring), per-plugin stats suites
    (math), and `docs/test-specs/manual-smoke-checklist.md` §3
    (rendering). See `docs/test-specs/coverage-gaps.md`.

### Track 2 (Logic/DOM Separation)
- [x] `lib/client-core/` established with extracted modules
  (`careportal/`, `profile-editor/`, `devicestatus/`)
- [x] Extracted pure logic covered by 181 Node-only tests
  (`npm run test:core`, ~70 ms)
- [x] Phase 5c: devicestatus pill math extracted to
  `lib/client-core/devicestatus/{uploader,loop,pump}.js`. Plugins
  `lib/plugins/{loop,pump}.js` delegate to the pure modules.
  **Phase 5f (May 2026)** completes the matrix: OpenAPS pill math
  extracted to `lib/client-core/devicestatus/openaps.js`
  (`selectOpenAPSState`); plugin `lib/plugins/openaps.js`
  delegates from `analyzeData()`. Captured-fixture goldens for
  all four sources (`aaps`, `loop`, `trio`, `phone-uploader`) are
  byte-identical pre/post extraction (verified via
  `node tools/captured-fixtures/generate-pill-goldens.js`).
- [x] Captured-fixture library at `tests/fixtures/captured/`
  (sanitized real Loop iOS data, regenerable via
  `tools/captured-fixtures/sanitize.js`); golden tests for
  profile migration and careportal normalization run against it.
- [x] No regressions in existing functionality (1101 passing on
  `npm run test:fast`)
- [x] Clear guidelines for new code placement
  (`lib/client-core/index.js` doc-comment: no `$`, `window`,
  `document`, or `ajax` allowed)
- [x] Bundle wiring smoke test (`tests/bundle.smoke.test.js`)
  asserts `window.Nightscout.{client,reportclient,profileclient,units}`
  shape; skips cleanly when bundle absent.

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

## Lessons Learned (Tracks 1+2 retro, May 2026)

These are empirical findings from executing Phases 0–5e that should inform
remaining work, related proposals, and any future modernization effort.

### L1. Captured-fixture library is the highest-leverage artifact

What started as a Phase-5c implementation detail (`tests/fixtures/captured/`)
has done more to harden the test suite than any single test or refactor.
Per-source slices for Loop iOS, Trio (oref1), AAPS-Android, and
xDrip4iOS phone-uploader, sanitized via `tools/captured-fixtures/sanitize.js`,
turn `classifyUploader` and `selectLoopState` from "exercises synthetic
input" into "exercises real-world payload from every controller class
the ecosystem ships". The pattern should be a first-class section, not
buried in success-criteria bullets.

**Implication for future work:** any new pure-logic module added to
`lib/client-core/` should land with at least one captured-fixture golden
test before being considered done. The sanitizer should grow per-label
device pre-filters whenever a new uploader class enters the cohort.

### L2. Domain-specific test corpora are non-negotiable for security libs

The `tests/sanitizer-differential.test.js` work (commits `c8d880d1`,
`61e2e582`) revealed that the popular `xss` library silently truncates
`"Hypo: BG < 70 needed sugar"` to `"Hypo: BG "` because `<` parses as a
tag start. Generic benchmarks would have rated `xss` as "smaller, faster,
no DOM" and missed this entirely. The 30-row diabetes-domain corpus
caught it on the first run.

**Implication:** before swapping any security-relevant library, run a
measurement test against a captured corpus drawn from real Nightscout
free-text fields. Promote `sanitizer-differential.test.js` as the
template.

### L3. Production tree is now jsdom-free

PR #8517 (sanitize-html replaces dompurify+jsdom) eliminated jsdom from
`npm ls jsdom --omit=dev`. This was not on the original Track 1
checklist, but it is now achievable as a tightened exit criterion: jsdom
should appear only as a dev/test dependency. (The 2.1 MB browser polyfill
was being loaded on every text scrub for a use case — strip dangerous
markup from notes — that has no DOM dependency.)

### L4. Render path is already inert; sanitization is defense-in-depth

The same sanitizer work confirmed that Nightscout's actual render paths
(jQuery `.text()` and EJS `<%= %>`) are inert for raw input. Server-side
sanitization is therefore defense-in-depth, not the primary control.
This **lowers the bar for Track 3 framework choice** dramatically: any
modern framework with safe-by-default templating (React JSX, Svelte,
Vue) inherits the inert-by-default property automatically.

### L5. jsdom 11 → 24 produces silent semantic drift in bundled code

`docs/proposals/track1/phase1c-shim-parity.txt` documents the
profile-editor failure under `USE_BENV_SHIM=1`: jsdom 24 returns `null`
where jsdom 11 returned `""` for some absent attribute, surfacing as a
`Cannot read properties of null` deep inside the minified bundle's jQuery
click handler chain. The strategic decision to **retire bundle-coupled
tests rather than bisect** was vindicated. This is now lived experience
that backs the broader principle: **testing through a minified bundle
in a polyfilled DOM is brittle to silent host-environment drift**, and
that brittleness compounds with every dependency upgrade.

**Implication for the Playwright proposal:** real-browser E2E avoids the
polyfill-drift class entirely. The trade-off (slower, harder to debug)
is the right one for the small set of workflows where bundle-level
wiring matters and per-module pure tests cannot reach.

### L6. Three-legged-stool replaces bundle-driven integration tests

Phase 5c established a successful coverage shape for retired bundle tests
(`reports.test.js`, `profileeditor.test.js`):

1. **Pure logic** → Node-only `tests/client-core/*` suites (~70 ms).
2. **Bundle wiring** → `tests/bundle.smoke.test.js` (asserts
   `window.Nightscout.{client,reportclient,profileclient,units}`).
3. **End-to-end rendering** → `docs/test-specs/manual-smoke-checklist.md`.

The unautomated layer (3) is where a future Playwright suite belongs —
and only there. This bounding is the right way to size any browser-E2E
investment: a small enumerated workflow set, not a sprawling
"replace all UI tests" effort.

### L7. Bundler hygiene problems surface during modernization

Commit `fc9008c2` ("prevent prod↔dev .map asset collisions") found a
real cross-mode webpack bug while doing the modernization. Such hygiene
findings are cheap to fix in-flight; future modernization phases should
include an explicit "look for asset collisions / cross-mode bleed"
review item.

### L8. Boot-amortization is an under-used test-perf lever

`api.shape-handling.test.js` saved ~60–80s of wall time per run by
moving server boot from `beforeEach()` to `before()` (one boot, not
26). The same pattern almost certainly applies to other API suites.
This is a follow-up worth a sweep: any test file with N tests and a
~2–3s server boot should be inspected for the same anti-pattern.

### L9. Statistics API has become a precondition for Track 3

`reports.test.js` was retired with the explicit assumption "stats moving
to server API". This means the statistics-API design (currently a
proposal in `rag-nightscout-ecosystem-alignment/docs/sdqctl-proposals/
statistics-api-proposal.md`) is no longer optional — it is **blocking**
any new UI shell from re-implementing stats client-side, which would
re-import the legacy code path we just retired. Track 3 framework
discovery should not start until the stats-API contract exists.

---

## Revision History

| Date | Version | Changes |
|------|---------|---------|
| Jan 2026 | 1.0 | Initial draft |
| Jan 2026 | 2.0 | Revised based on stakeholder interviews; three-track approach; added Logic/DOM separation; added UI Discovery track; added network isolation requirements; added scope guardrails |
| May 2026 | 1.2 | Added Lessons Learned section (L1–L9) capturing empirical findings from Phases 0–5e: captured-fixture library leverage, domain corpus principle, jsdom-free production tree, render-path inertia, jsdom semantic drift, three-legged-stool pattern, bundler hygiene, boot-amortization, statistics-API as Track 3 precondition. |
| May 2026 | 1.3 | Phase 5f: extracted OpenAPS pill math to `lib/client-core/devicestatus/openaps.js`; closes the last devicestatus pure-logic gap. Pill-output goldens (aaps/loop/trio/phone-uploader) byte-identical pre/post — extraction verified end-to-end. |
| May 2026 | 1.4 | Phase 5g: Trio (oref1) captured-fixture coverage hardened. Sanitizer extended to time-shift inner `openaps.{enacted,suggested,iob,mmtune}` timestamps so the `recent` window stays meaningful against the time-anchored fixture; added `DS_KEY_BY_LABEL` diverse-slice for devicestatus. Trio fixtures regenerated from a Trio-only Nightscout source (every record carries `enacted.received=true`), exercising the previously-untested oref1 enacted-selection branches. Plugin-wiring tests added for `loop` and `pump` plugins (mirrors the existing `openaps` wiring test) — all four extracted modules now have explicit delegation contracts. |
