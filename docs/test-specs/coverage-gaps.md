# Test Coverage Gaps - Aggregated View

**Last Updated:** May 2026

This document aggregates coverage gaps from all test specifications to provide a prioritized view for planning test development work.

---

## Recently Closed (Phase 5c, May 2026)

- **Loop devicestatus pill math** — extracted to
  `lib/client-core/devicestatus/loop.js` and covered by
  `tests/client-core/devicestatus-loop.test.js` against captured
  Loop iOS fixtures (`tests/fixtures/captured/loop/devicestatus.json`).
- **Pump devicestatus latest-pick** — extracted to
  `lib/client-core/devicestatus/pump.js` and covered by
  `tests/client-core/devicestatus-pump.test.js`.
- **Uploader classification** — new pure helper at
  `lib/client-core/devicestatus/uploader.js` with full branch
  coverage (`tests/client-core/devicestatus-uploader.test.js`).

## Recently Closed (Phase 5d, May 2026)

- **Multi-controller captured fixture library.** Captured fixtures
  reorganized into per-source subdirectories
  (`tests/fixtures/captured/{loop,trio,phone-uploader}/`) and
  extended to cover Trio (oref1) and a phone-uploader-only source
  (xDrip4iOS). `classifyUploader` is now exercised against real
  Trio (`openaps` body) and phone-uploader (no algorithm body)
  records; `selectLoopState` is contract-tested against Trio data
  to verify it correctly returns the null-shape when no `loop`
  block is present. Sanitizer (`tools/captured-fixtures/sanitize.js`)
  gained per-label device pre-filters so that multi-controller
  patient dumps slice cleanly to a single source.

## Recently Closed (Phase 5f, May 2026)

- **OpenAPS pill math** extracted to
  `lib/client-core/devicestatus/openaps.js` (`selectOpenAPSState`)
  and covered by `tests/client-core/devicestatus-openaps.test.js`
  against the captured AAPS-Android, Trio (oref1), and Loop iOS
  (negative-control: no `openaps` body) fixtures. Plugin
  `lib/plugins/openaps.js` now delegates from `analyzeData()` to the
  pure module, mirroring the loop/pump/uploader pattern from Phase
  5c. Behaviour preserved exactly (legacy `tests/openaps.test.js`
  still green; `pills-golden.json` for all four captured sources
  unchanged). Closes the only "still open" devicestatus follow-up
  this PR's earlier phases had created.

## Recently Closed (Phase 5e, May 2026)

- **AAPS-Android captured fixture added** at
  `tests/fixtures/captured/aaps/`, sliced from a real
  `device='openaps://AndroidAPS'` export
  (`tools/ns2parquet/fixtures/odc_39819048_*.json` in the
  rag-nightscout-ecosystem-alignment workspace). Carries the
  full oref0 `openaps.{iob,suggested,enacted}` body and a
  representative SMB / Temp Basal / Meal Bolus / Temporary
  Target treatment mix. `classifyUploader` now exercised against
  real AAPS data (asserts `'openaps'` for every record).

## Still Open — devicestatus follow-ups

- **OpenAPS pill math** extracted in Phase 5f — see "Recently Closed"
  above. Earlier "still open" notes preserved below for traceability.
- **xDrip+ Android entries / pebble fields** are not represented
  in any captured fixture. xDrip4iOS treatments are present
  (`phone-uploader/`) but xDrip+ Android-specific shape (different
  uploader, different pebble structure) is a gap.
- **OpenAPS rig (`openaps://edison`)** — not captured.
- **Medtronic CareLink uploads** — not captured.

---

## High Priority Gaps

These gaps represent security-critical or data-critical functionality that should be addressed first.

| Area | Gap | Source Spec | Recommended Action |
|------|-----|-------------|-------------------|
| Authorization | WebSocket Auth (`/storage` subscription) | `authorization-tests.md` | Add socket.io-client tests for subscribe with/without token |
| Authorization | JWT Expiration rejection | `authorization-tests.md` | Create JWT with past exp, verify 401 |
| Authorization | Permission Wildcards (Shiro patterns) | `authorization-tests.md` | Test `api:*:read` vs `api:entries:read` |
| Authorization | API v3 Security model | `authorization-tests.md` | Create separate API v3 security spec |

---

## Medium Priority Gaps

These gaps represent functional coverage that should be addressed after high priority items.

| Area | Gap | Source Spec | Recommended Action |
|------|-----|-------------|-------------------|
| Shape Handling | Response order matches input order | `shape-handling-tests.md` | Add order verification tests |
| Shape Handling | WebSocket + API concurrent writes | `shape-handling-tests.md` | Complex test setup needed |
| Shape Handling | Duplicate identifier handling under load | `shape-handling-tests.md` | Stress test harness needed |
| Shape Handling | Cross-API consistency (v1 vs v3 storage) | `shape-handling-tests.md` | Cross-read verification tests |
| Authorization | Subject CRUD operations | `authorization-tests.md` | Add API tests for admin endpoints |
| Authorization | Role Management | `authorization-tests.md` | Test role creation and permission assignment |

---

## Low Priority Gaps

These gaps are edge cases or lower-risk functionality.

| Area | Gap | Source Spec | Recommended Action |
|------|-----|-------------|-------------------|
| Shape Handling | Null/undefined in array handling | `shape-handling-tests.md` | Define expected behavior, add tests |
| Authorization | Audit Events | `authorization-tests.md` | Mock bus, verify admin-notify event |
| Authorization | Delay Cleanup | `authorization-tests.md` | Fast-forward time, verify cleanup |

---

## Areas Not Yet Documented

These areas from system audits have not yet been converted to formal requirements/test specifications:

| Area | Source Audit | Priority | Blocking Issue |
|------|--------------|----------|----------------|
| API v3 Security | `security-audit.md` | High | Distinct auth model from v1/v2 |
| Core Calculations (IOB/COB) | `plugin-architecture-audit.md` | High | Complex algorithms, domain expertise needed |
| Real-time Event Bus | `realtime-systems-audit.md` | Medium | Need to trace event flows |
| Plugin System | `plugin-architecture-audit.md` | Medium | Large surface area |
| Notification/Messaging | `messaging-subsystem-audit.md` | Medium | Multiple providers |
| Dashboard UI | `dashboard-ui-audit.md` | Low | May be rewritten |

---

## Gap Resolution Process

When addressing a gap:

1. **Review the source spec** - Understand the context and related requirements
2. **Write the test first** - Follow Test ID conventions from the source spec
3. **Update the source spec** - Mark the gap as covered, add test details
4. **Update this file** - Remove the gap from this aggregated view
5. **Update the Progress section** - Note the date and any discoveries

---

## Track 1 / Phase 4 — `reports.test.js` skipped (Phase 4, 2026-05)

**File:** `tests/reports.test.js`
**State:** `describe.skip(...)` — entire suite skipped, never runs.

**What it covered (legacy benv harness):**
- "should produce some html" — exercises `Nightscout.reportclient` end-to-end
  by feeding 7 days of synthetic SGV/treatment data through the client-side
  report rendering pipeline (jQuery + Flot) inside a benv/jsdom-11 sandbox.
- "should produce week to week report" — same scaffolding, week-to-week view.

**Why it can't be ported to modern jsdom today:**
1. Both tests `benv.require()` the full webpack `bundle.app.js` against a
   *new* jsdom window in their `beforeEach`. The bundle's entry module
   (38211) recompiles on each `require()` (cache-busted), but its
   side-effect writes to the new `window` (e.g. `window.Nightscout = ...`)
   are not observable on the second invocation under modern Node — the
   exact mechanism is unclear, but the legacy `benv`+`rewire` path side-
   stepped it via `vm.runInThisContext` semantics that we cannot
   faithfully reproduce. (Re-introducing `rewire` was attempted; it hangs
   on jQuery DOM-ready timing under modern jQuery+jsdom@24.)
2. Even if we worked around that, the rendering surface (Flot, charts as
   raw HTML) is the wrong assertion target. The right surface is the
   server-side statistics API once it lands (see
   `docs/proposals/testing-modernization-proposal.md` Track 3 / Future).

**Coverage replacement plan:**
- **Short-term (Phase 5c, Track 2):** structural wiring is now covered
  by `tests/bundle.smoke.test.js` (boots `bundle.app.js` in jsdom and
  asserts `Nightscout.client/.reportclient/.profileclient/.units` are
  exposed). Per-plugin stats math is exercised by dedicated suites:
  `basalprofileplugin.test.js`, `daytodayplugin.test.js`,
  `foodstatsplugin.test.js`, `glucosedistributionplugin.test.js`,
  `hourlystatsplugin.test.js`, `loopalyzerplugin.test.js`,
  `profileplugin.test.js`, `reportstorage.test.js`. End-to-end
  rendering checks moved to a manual checklist:
  `docs/test-specs/manual-smoke-checklist.md` §3.
- **Medium-term:** when the server-side statistics API ships, port the
  per-bucket calculations (TIR, average, std-dev) as Node-only unit tests.
- **Long-term:** delete `tests/reports.test.js` and the supporting
  `static/js/reportinit.js` once the server-side path replaces client
  rendering.

**Tracking:** opening a follow-up issue at PR-merge time to surface this
gap and tie it to the stats API work.

---

## Cross-repo classifier — single-source-of-truth question (May 2026)

`classifyUploader` in `lib/client-core/devicestatus/uploader.js` and
`_detect_controller` in
`rag-nightscout-ecosystem-alignment/tools/ns2parquet/normalize.py`
independently classify the same wire signal (uploader/device strings).
Both have to test `aaps`/`androidaps` *before* `openaps` substring or
AAPS-Android exports get mis-classified as legacy OpenAPS rigs. The
captured-fixture library (`tests/fixtures/captured/aaps/`) now exercises
the cgm-remote-monitor side; the rag-repo's parquet pipeline has its own
test coverage. **There is no shared specification** — a fix in one repo
cannot mechanically propagate to the other.

**Action item (not blocking, but worth a decision):** publish the
classification rule set as a small JSON spec under
`rag-nightscout-ecosystem-alignment/mapping/cross-project/` and have
both implementations consume it (or at minimum, both unit-test
themselves against the same fixture). Decide before adding the next
uploader class.

---

## Pill-output goldens against captured fixtures (May 2026)

**Status:** ✅ landed at `tests/client-core/pill-goldens.test.js`.

For each captured-fixture source under `tests/fixtures/captured/<source>/`,
the harness instantiates every pill-emitting plugin in `lib/plugins/`
(rawbg, iob, cob, direction, upbat, basal, delta, cage, iage, sage,
bage, bwp, loop, openaps, override, pump, timeago, dbsize, …),
drives it through `sandbox.clientInit → setProperties → updateVisualisation`,
and asserts the captured `pluginBase.updatePillText` call sequence
matches `tests/fixtures/captured/<source>/pills-golden.json`.

**Why it matters:**

- Locks the *user-visible* output of the entire plugin chain (sandbox
  → property pipeline → plugin formatting → unit conversion → language
  selection) against four real-world payload shapes (Loop, Trio, AAPS,
  phone-uploader) without a browser, jsdom, or any new runtime
  dependency.
- Provides the safety net contemplated in **L4** (jsdom semantic drift)
  and **L1** (captured-fixture leverage) of the testing-modernization
  proposal.
- Gives us a regression net **before** the statistics-API extraction
  (proposed in `rag-nightscout-ecosystem-alignment/docs/sdqctl-proposals/statistics-api-proposal.md`),
  which is the next refactor that will touch the data pipeline these
  pills depend on.

**To intentionally update goldens after a behavior change:**

```bash
node tools/captured-fixtures/generate-pill-goldens.js --write
git diff tests/fixtures/captured/    # review every difference
```

**Determinism:** `time` is pinned to the newest mills across
sgvs ∪ treatments ∪ devicestatus, not wall-clock. Plugins that derive
"x weeks ago" output from old fixture timestamps will look stale —
that's expected and visible in the golden, and any drift away from
that staleness is what we want to detect.

**Known caveat:** the COB plugin emits a benign console warning
("treatment profile" missing) for fixtures that lack `profile.json`
(currently `aaps`, `phone-uploader`, `trio`); the warning does not
affect the captured pill output.

---

## Cross-References

- [Shape Handling Tests](shape-handling-tests.md)
- [Authorization Tests](authorization-tests.md)
- [Documentation Progress](../meta/DOCUMENTATION-PROGRESS.md)
