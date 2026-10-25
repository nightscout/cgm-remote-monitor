# Statistics Summary (AGP) report

The AGP tab is available with every theme. Modern retains its existing page
header, navigation and light chart canvas. Classic report-page chrome is
unchanged. Opening Reports waits for an explicit **Show**; changing tabs can
render the selected report from the already loaded data.

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
- All 96 AGP / 48 Percentile Chart bins are retained. Missing bins contain null
  values, and D3 lines/areas break there. Hovering a missing percentile bin hides
  its tooltip rather than borrowing a distant value. Daily traces also break
  at missing sample intervals and backwards clock transitions. Daily axes
  include actual high values rather than silently clamping them to 300 mg/dL.
- Copy and Download start disabled. Each render removes the previous period's
  export handlers before preparing data. An empty result leaves both disabled.
  Delayed clipboard callbacks cannot resurrect an older period's status or
  perform a fallback copy after the report has changed.

## Regression coverage

`tests/agp-data.test.js` covers sampling cadence, coverage gaps, profile timezone,
invalid/duplicate readings, empty selected days, midnight jumps and 23/25-hour
calendar days. `tests/agp-report.test.js` renders the actual report with D3 and
checks plotted positions, gaps, units, statistics, export lifecycle and sort
independence. Both are registered in the unit/DOM CI tiers.

Real-browser report tests retain numeric, unit, DST, cached-data and reconnect
checks and verify missing percentile intervals and explicit Show loading.
Existing Loopalyzer regressions remain in the full suite.

## Bundle review

Loopalyzer still requires Flot core and its time axis. The obsolete pie and
fillbetween plugins are removed from the reports entry. Measurement after the
AGP fixes is recorded in `docs/audits/reports-agp-bundle-baseline.json`.
Reports decreased from 60,762 to 58,638 gzip bytes compared with the updated PR
before these fixes; all application entries decreased from 425,866 to 423,281.
The new report functionality has a reviewed 60,000-byte reports / 425,000-byte
total allowance, with all other per-page limits unchanged. This is an explicit
feature-budget adjustment; it does not claim to meet the older 55,000-byte
reports limit. Source-map checks continue to keep report code out of other
page entries and prevent unused D3 subsystems from returning.
