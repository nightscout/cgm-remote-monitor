# Batched report quantiles (M26, first slice)

The installed simple-statistics 0.7.0 API accepts a probability array and sorts
one copy of the input. Use that API in percentile, daily statistics, hourly
statistics and success reports instead of repeating scalar quantile calls.
Hourly statistics also reuse one extracted readings array for deviation,
minimum, maximum and quantiles. Glucose distribution requests only a median
and does not need batching.

This retains the library and its quantile/population-deviation definitions.
Empty percentile/hourly bins retain null quantiles, and source reading arrays
are not sorted in place. Numeric tests cover empty, single, even, odd, repeated,
unsorted and decimal inputs, boundary probabilities, q25([1,2,3,4]) = 1.5 and
population deviation sqrt(1.25). Browser pipeline assertions check displayed
quartiles in mg/dL and mmol/L.

Per populated bin, quantile sort counts drop from five to one for percentile
and hourly reports, three to one for daily statistics, and two to one for
success. `tools/measure-report-quantiles.js` records seven alternating paired
runs against the same installed library. The checked-in raw samples in
`docs/audits/report-quantile-baseline.json` use 48 bins of 180 readings, repeated
100 times: median scalar 191.016 ms versus batched 38.820 ms on Node 22.23.2.
The checksums match. This measures quantile computation only, not full report
rendering, server RSS or retained browser memory. No package is removed.

Eight numeric cases pass on Node 22 and 24. The earlier full backend run
passed 1,642 cases with one existing pending. Validation of the combined
integration head and hosted CI remain required; this slice does not complete
the broader M26 statistics assessment.

The browser pipeline now also renders the real percentile and hourly plugins.
Goldens cover all five percentile bands, empty half-hour bins, hourly candle
quartiles/deviation, displayed hourly statistics, real canvases and cached
second renders in both glucose units. All 12 pipeline cases pass against the
unchanged scalar-quantile parent in Chromium, against batching in Chromium on
Node 22.23.2, and against batching in WebKit on Node 24.20.0. This retains
existing hourly display rounding, including its floored mean. The separate
DST day-boundary fix #8645 is now merged and included. All 18 combined
pipeline/legacy cases pass in Chromium/Node 22 and WebKit/Node 24. The four DST
cases also render the real percentile and hourly plugins: repeated fall-back
readings share the correct local bin, the final hour is retained, spring-forward
bins match local time, and cached chart/table outputs are stable. All 16 pipeline
cases pass against the corrected-DST scalar parent as well. No output formula,
rounding or test assertion was relaxed for batching.
