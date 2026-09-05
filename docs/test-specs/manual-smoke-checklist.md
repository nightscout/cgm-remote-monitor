# Manual smoke checklist (Nightscout UI)

This checklist covers browser behavior that automated tests do not currently
exercise end-to-end. Current automated coverage includes:

1. `tests/bundle.smoke.test.js`, a structural check that the built bundle
   executes and exposes `Nightscout.client`, `.reportclient`, `.profileclient`,
   and `.units`.
2. `tests/reportstorage.test.js`, which covers persisted report preferences,
   plus selected output-safety checks in `tests/stored-output-sinks.test.js`
   and `tests/profile-sinks.test.js`.
3. `tests/uniqsgv.test.js`, which covers the report's one-minute SGV filter,
   including cascading rejection, millisecond boundaries, dense series with
   timing jitter, duplicates and input preservation.
4. `tests/report-sgv-pipeline.test.js`, which drives the report's Show action
   with newest-first API fixtures and checks retained chart data, Daily Stats
   reading counts, range percentages and estimated A1c in mg/dL and mmol/L.
   Multi-day fixtures cover separate daily averages, empty days and repeated
   rendering from cached data. These tests use the real loading, filtering,
   unit conversion and table renderer; network responses and canvas drawing
   are mocked, so they do not replace browser smoke checks.
5. Node-only suites under `tests/client-core/`, which cover already-extracted
   business logic.

The legacy full-bundle report suite remains intentionally skipped, and the
profile-editor suite remains retired, because their jsdom-based assertions
were brittle and did not faithfully represent a real browser. Report
calculations are not yet comprehensively covered by deterministic DOM-free
tests. Run this checklist before tagging a release or merging a UI- or
report-related change.

## Setup

```sh
git switch <branch-under-test>
npm ci                 # postinstall builds bundle.app.js
node lib/server/server.js
# Browse to http://localhost:1337 (or whatever PORT is set)
```

If you do not have a Mongo instance, run `make run-mongo-localdev` (or
your equivalent) before `node lib/server/server.js`.

## 1. Boot + main chart

- [ ] Page loads with no red entries in the browser console.
- [ ] Current SGV reads with the correct units (mg/dL or mmol/L per
      `DISPLAY_UNITS`).
- [ ] BG chart renders with axis ticks and at least one data point.
- [ ] hashauth login (PIN icon, top-right) accepts a valid PIN and the
      "Authentication Status" indicator turns green.

## 2. Profile editor (`/profile`)

- [ ] Profile records dropdown (`#pe_databaserecords`) shows existing
      records or "Default values used." on first run.
- [ ] Click **+** next to records → a new "Default" record appears
      (option count grows by 1).
- [ ] Click **−** → record is removed (option count drops by 1; refuses
      to delete the only record).
- [ ] Click clone → a sibling record appears with a fresh start date.
- [ ] In the named-profile dropdown (`#pe_profiles`), repeat add /
      remove / clone — same behavior on the inner profile list.
- [ ] In the **I:C** table, click the row-add icon — a new row appears
      at index 0 with `value=0`.
- [ ] Click the row-delete icon on the new row — original `value=30`
      row is restored at index 0.
- [ ] In the **target BG** table, click row-add then row-delete — both
      `target_low` and `target_high` rows stay in lockstep.
- [ ] **Save profile** — confirm dialog text is sane, page reloads with
      saved values intact.

## 3. Reports (`/report`)

- [ ] Default 7-day window loads without console errors.
- [ ] At least one of the report plugins renders (e.g. Day to Day,
      Hourly Stats, Distribution).
- [ ] Date range picker can be changed and the reports re-render.
- [ ] Per-plugin spot check: open Distribution / TIR — the percentages
      add to ~100% and BG bands look right for the selected window.

### Closely spaced SGV readings (#8588)

Use synthetic readings on a dedicated day in a local test instance. The offsets
below are relative to a timestamp within that day, not the Unix epoch. Select
that day in Reports and enable its weekday. Reload the report page after changing
fixtures so cached historical data is loaded again.

- [ ] Load readings at offsets **0s / 58s / 116s**, with values **100 / 50 / 200
      mg/dL** respectively. With target thresholds **80–180 mg/dL**, Day to Day
      shows the readings at 0s and 116s. Daily Stats shows **2 readings**, **0%
      Low**, **50% Normal** and **50% High**; its pie chart agrees with the table.
- [ ] Repeat in mmol/L using the equivalent target thresholds (4.4–10 mmol/L).
      Retained timestamps, reading count and range percentages agree with mg/dL.
- [ ] Check equal-value readings at **0s / 0s / 60s**: the true duplicate is
      removed and **2 readings** remain. At **0s / 60s / 120s**, all **3 readings**
      remain, confirming the cutoff includes exactly one minute.
- [ ] With readings at **0s / 300s / 600s**, all **3 readings** remain and the
      chart, reading count and range percentages match the same five-minute
      fixture before the filtering fix.

These checks validate filtering and the resulting sample-based percentages;
they do not change the target-band rules or introduce time-weighted statistics.

### Daily Stats estimated A1c

Use the same local test instance and select a day containing only the synthetic
readings. Reload Reports after changing fixtures or display units.

- [ ] With a single **150 mg/dL** reading, Daily Stats shows an average of
      **150.0 mg/dL**, estimated A1c **6.9% DCCT** and **51 mmol/mol IFCC**.
- [ ] Switch to mmol/L display. The average shows **8.3 mmol/L**, while the A1c
      estimates remain **6.9%** and **51**. They are calculated from the original
      mg/dL reading, before glucose is rounded for display.
- [ ] Repeat with **100 and 200 mg/dL** readings five minutes apart. Both unit
      modes show **2 readings** and the same **6.9% / 51** A1c estimates, using
      the mean glucose rather than averaging rounded A1c values per reading.

## 4. Care portal (treatment entry)

- [ ] Open Care Portal, choose **Snack Bolus** as the event type.
- [ ] Enter carbs=20, insulin=2, default time. Confirm dialog text
      includes `Carbs: 20`, `Insulin: 2`, and resolved event name
      `Snack Bolus`.
- [ ] Submit → entry appears in the treatments stream with the same
      values.
- [ ] Repeat with **Combo Bolus**, splitting 50/50 over 30 min — the
      confirm dialog should reflect the split.
- [ ] Repeat with **Temp Basal** absolute=0 for 30 min — verify the
      confirmation includes `Absolute basal: 0` (not stripped).
- [ ] In mmol mode (`DISPLAY_UNITS=mmol`), set `Target top` and
      `Target bottom` for a Temporary Target — the confirm-text shows
      mmol values, not mg/dL.

## When this checklist fails

A failure may be in data loading, report calculations, bundle wiring, or
browser rendering. Record the selected date range and inspect:

- Browser DevTools console and network tabs.
- `tests/bundle.smoke.test.js` for bundle entry-point failures.
- `tests/reportstorage.test.js` for preference persistence.
- `tests/uniqsgv.test.js` for SGV filtering and
  `tests/report-sgv-pipeline.test.js` for loading-to-statistics regressions.
- Relevant `tests/client-core/` suites for already-extracted logic.

Because report calculations are not yet comprehensively covered outside the
legacy client bundle, add a focused unit or contract test when affected logic
is extracted.

See `docs/proposals/testing-modernization-proposal.md` for the full
test pyramid layout and Track 2 rationale.
