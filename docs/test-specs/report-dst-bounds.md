# Report calendar-day bounds

Daily report requests previously added 86,400,000 milliseconds to local
midnight. A spring-forward day therefore included the next day's first hour;
a fall-back day omitted the selected day's final hour. The same fixed duration
was used for the transparent chart endpoints.

Both bounds now use the profile timezone's next calendar midnight through
Moment's clone().add(1, 'day'). The request lower bound stays inclusive and the
upper bound exclusive. This changes which readings, treatments and device
statuses enter reports on DST transition days; ordinary 24-hour days retain
their bounds. It does not change stored data or statistics formulas.

The browser report pipeline tests use America/New_York on 2025-03-09 (23 hours)
and 2025-11-02 (25 hours), in mg/dL and mmol/L. They assert request duration,
transparent chart endpoints, retained reading counts, displayed quartiles and
cached re-render equivalence. An extra reading at the following midnight must
be excluded; the fall-back fixture retains two readings in the repeated hour
and one in the final hour. The unmodified loader failed all four duration
assertions. With this fix, all 16 pipeline/legacy browser cases pass locally in
Chromium. Full backend and hosted cross-browser validation remain required.

This regression was discovered while adding M26 quantile goldens. It is a
separate correctness fix from quantile batching and preserves the current
Moment timezone implementation rather than introducing a date-library change.
