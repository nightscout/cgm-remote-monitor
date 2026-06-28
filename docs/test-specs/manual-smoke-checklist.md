# Manual smoke checklist (Nightscout UI)

This checklist replaces the end-to-end coverage that the bundle-driven
`tests/reports.test.js` and `tests/profileeditor.test.js` used to provide
through jsdom + jQuery + the minified webpack bundle. Both legacy tests
were retired in Track 2 of the testing-modernization effort because:

1. They booted the entire 2.1 MB `bundle.app.js` to assert on jQuery
   selectors. Real failures (e.g. a stats-math regression) were already
   covered by per-plugin Node tests; what the bundle tests uniquely
   exercised was the wiring between modules.
2. Wiring is now covered structurally by `tests/bundle.smoke.test.js`,
   which boots the bundle in jsdom and asserts the public globals
   exist (`Nightscout.client`, `.reportclient`, `.profileclient`,
   `.units`).
3. Pure logic (record/profile/range CRUD, treatment normalization,
   confirm-text generation) is now covered by Node-only suites under
   `tests/client-core/`.

What is not covered automatically: a real human eyeballing the chart,
clicking around the profile editor, and submitting a report. Run this
checklist before tagging a release or merging a UI-touching PR.

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

If a step fails, the regression is in adapter glue (jQuery, ajax,
`bundle.app.js` wiring), not in the pure core. Check:

- `tests/bundle.smoke.test.js` — does the bundle still expose the
  expected globals?
- `tests/client-core/careportal-*.test.js` — do the pure transforms
  still produce the expected output? (If they do, the bug is in
  `lib/client/careportal.js` or `lib/profile/profileeditor.js`.)
- Browser DevTools network tab — is the page hitting `/api/v1/...`
  with the right payloads?

See `docs/proposals/testing-modernization-proposal.md` for the full
test pyramid layout and Track 2 rationale.
