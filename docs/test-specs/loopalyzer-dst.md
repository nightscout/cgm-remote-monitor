# Loopalyzer daylight-saving clock slots

Loopalyzer overlays days on one 24-hour clock axis: 288 five-minute slots.
The viewer axis is anchored on an ordinary local calendar day, including when
the report is viewed during a 23- or 25-hour DST day.

Historical data is calculated on the selected profile day's real elapsed
timeline first. That means 276/300 slots for one-hour transitions and 282/294
for half-hour transitions. Calendar boundaries also account for zones that
skip midnight, such as America/Santiago; the first valid local time is kept
without resetting it to a nonexistent 00:00. Treatment selection includes this
first instant and excludes the next calendar boundary. Basal, temp basal,
calculated/uploaded IOB/COB, treatment gap handling and predictions retain
their actual timestamps and interpolation intervals. Only the resulting display values are projected to
clock slots. Glucose keeps chronological ordering and the existing 30-second
mark tolerance before the same projection.

- Skipped clock times have no samples and remain NaN gaps; interpolation must
  not manufacture values inside that missing hour.
- Repeated clock times keep the earliest available value per curve and clock
  slot. If the first occurrence has no value, the second can supply it. Repeated
  readings are not counted as two separate days or averaged together.
- The final local hour of a 25-hour day remains present. A fixed elapsed-array
  cap must not drop 23:00-23:59 or move morning data against treatment markers.
- Meal time-shifting uses clock minutes for the average meal and annotates the
  same synthetic axis as the curves. A shifted clock time can exist on that
  axis even if it was skipped on the original DST date. Treatment annotation
  projection preserves seconds/milliseconds and shifts each entry only once.

The existing report help describes the repeated/missing-hour policy. This
changes display slotting, not stored records or the underlying IOB/COB models.

## Regression coverage

`tests/loopalyzer-sgv.test.js` checks normal-day slots, jitter, real gaps,
neighbouring-day isolation, late-evening readings, repeated clock times and
Australia/Lord_Howe's half-hour changes.

`tests/loopalyzer-report.test.js` runs the actual report with real profile,
IOB and COB implementations and captures the computed plot data. It checks
exact 08:00/23:30 positions, the first valid time after a midnight jump,
and marker agreement for calculated and uploaded curves, prediction values,
skipped-hour gaps, elapsed-time interpolation, repeated-hour selection and meal shifts spanning a skipped clock time.

Run the focused cases with a patched supported Node runtime:

```sh
TZ=Europe/Berlin npx --no-install mocha --timeout 5000 --exit tests/loopalyzer-sgv.test.js tests/loopalyzer-report.test.js
```

Also run with TZ=UTC and TZ=America/New_York, and validate the production
report bundle plus browser report regressions. The full backend CI suite
includes both root test files; their existing unit/DOM tier entries remain.
