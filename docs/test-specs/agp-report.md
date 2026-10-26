# Statistics Summary (AGP) report

The AGP tab is available with every theme. Modern retains its existing page
header, navigation and light chart canvas. Classic report-page chrome is
unchanged. Opening Reports loads the most recent seven profile-calendar days automatically
once the profile is ready. Editing filters or pressing **Show** takes priority
over a pending initial load. Reconnects preserve the selected report and range;
changing tabs can render from the already loaded data.

## Data and display rules

- Use the profile timezone for both calendar dates and clock-time bins,
  independently of the viewer's timezone. Sort calendar dates explicitly so
  report ordering cannot change the selected latest 28 daily profiles.
- Reject invalid dates, nonfinite glucose values and sensor-error values;
  deduplicate actual timestamps and restrict records to the selected days.
  Original records are not modified.
- CGM coverage is an estimate of elapsed time with sensor readings, not the
  number of readings divided by 288. Nearby intervals estimate one-, two- or
  five-minute sampling, capped at five minutes per reading and clipped to the
  selected day's end. Long gaps contribute at most one reading interval.
  Selected empty days remain in the denominator. Calendar-day duration includes
  23/25-hour and midnight DST transitions.
- Glucose statistics, GMI and range percentages retain the report's original
  reading-based definitions; coverage estimation does not interpolate glucose
  values or change stored readings.
- Statistics Summary uses the same 70–180 mg/dL consensus range for its TIR
  classification, AGP shading/reference lines and daily mini-chart shading,
  converted to display units before plotting. Configured report targets do not
  change these summary bands; other reports retain their configurable targets.
- All 96 AGP / 48 Percentile Chart bins are retained. Missing bins contain null
  values, and D3 lines/areas break there. Hovering a missing percentile bin hides
  its tooltip rather than borrowing a distant value. Daily traces also break
  at missing sample intervals and backwards clock transitions. Daily axes
  include actual high values rather than silently clamping them to 300 mg/dL.

## Regression coverage

`tests/agp-data.test.js` covers sampling cadence, coverage gaps, profile timezone,
invalid/duplicate readings, empty selected days, midnight jumps and 23/25-hour
calendar days. `tests/agp-report.test.js` renders the actual report with D3 and
checks plotted positions, gaps, units, statistics, empty-result cleanup and sort
independence. Both are registered in the unit/DOM CI tiers.

Real-browser report tests retain numeric, unit, DST, cached-data and reconnect
checks and verify missing percentile intervals, automatic initial-week loading,
profile readiness, reconnect stability and manual range overrides.
Day-to-day chart checks cover smooth, gap-aware sensor traces and nearest-reading
tooltips throughout the plot area, with exact measured values in both glucose
units. Modern daily charts place basal rates on a separate U/h axis, preserve
meal and bolus quantities in compact markers, and retain the same daily totals.
Raw, fingerstick and predicted samples retain their own point tooltips.
Existing Loopalyzer regressions remain in the full suite.

## Bundle review

Loopalyzer still requires Flot core and its time axis. The obsolete pie and
fillbetween plugins are removed from the reports entry. Measurement after the
AGP fixes is recorded in `docs/audits/reports-agp-bundle-baseline.json`.
Reports decreased from 60,762 to 58,638 gzip bytes compared with the updated PR
before these fixes; all application entries decreased from 425,866 to 423,281.
The initial AGP correctness update used a reviewed 60,000-byte reports /
425,000-byte total allowance. The final refinement measurements and limits are
recorded below. These are explicit feature-budget adjustments; they do not claim
to meet the older 55,000-byte reports limit. Source-map checks continue to keep report code out of other
page entries and prevent unused D3 subsystems from returning.

Static AGP, daily and weekly presentation styles live in `static/css/report.css`
rather than JavaScript strings. Modern refinements remain in `modern-reports.css`.

The final Modern chart, combined hover and compact treatment-table refinements
measure 61,032 reports / 425,675 total JavaScript gzip bytes after extracting
static CSS. Their bounded allowance is 61,500 / 426,000 bytes, with other
per-page limits unchanged.
Hover includes basal U/h and all treatments within ±5 minutes, with actual
event times, amounts and escaped notes; suspended basal remains zero.
CGM HTTP requests bypass stale historical-response caches while in-page
report reuse remains unchanged.

The combined tooltip stays at a stable vertical anchor while tracking the
pointer horizontally, independent of tooltip content height. Basal and
treatments follow the cursor time; glucose retains its measured sample time.
Empty-CGM days still show basal and treatment information explicitly.

Daily tooltip presentation uses a fixed 280px width (capped on smaller screens),
a single time/date header, aligned glucose/basal metrics with reserved metadata
rows, and compact treatment amounts with event times. Zero basal remains visible;
notes follow the Notes toggle, and redundant zero bolus/carbs/duration fields are
omitted. Treatment durations of one minute or more use one decimal place.

Modern daily cards use a more compact chart, basal track and side-by-side insulin
ring/legend. Recorded carbohydrates remain visible as a compact total; secondary
macro totals and selected-day comparisons expand under Details. Calculations
and the classic chart geometry remain unchanged.

Modern treatment reports use Design A: a compact striped table, event badges,
explicit glucose/insulin/basal units, sticky column headings, native action menus
and keyboard-operable row details. Secondary nutrition, profile, timing, reason
and full note fields render on demand; stored text remains text. Filtering and
the existing edit/delete confirmation handlers are preserved. Classic treatment
layout remains available, with its original PNG icons served as static assets.
The measured Design A allowance is 61,500 reports gzip bytes, with the total
JavaScript allowance unchanged at 426,000 bytes. See the `modernReportRefinements` entry in
the bundle audit for the current measured sizes and source hashes.

The summary daily-profile labels use `ddd L` (for example, Wed 10/21/2026).
The profile timezone determines calendar days; Moment locale determines the
numeric date ordering. Copy/Download summary controls are removed, with the
clinical labels and metrics retained in the report itself.
