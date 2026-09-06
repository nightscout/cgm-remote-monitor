# Moment Timezone 0.6.3 candidate

Updates 0.5.48 / IANA 2025b to 0.6.3 / IANA 2026c. The upstream
[changelog](https://github.com/moment/moment-timezone/blob/develop/changelog.md)
identifies TypeScript definition corrections in 0.6.0 and timezone-data updates
in 0.6.1–0.6.3. Comparing runtime source from the two tags finds only version-label
changes in moment-timezone.js and moment-timezone-utils.js; index.js is unchanged.
This preserves the library API, but does not imply identical civil-time outputs.

`node tools/audits/timezone-data-diff.cjs /absolute/old/node_modules/moment-timezone`
compares separately installed old/new instances. It checks every interval formed
by the union of both versions' transitions between 1900 inclusive and 2100
exclusive, comparing offsets and abbreviations. It does not merely sample months.
[Summary](../audits/timezone-2026c-comparison.json) records 66,156 intervals and
13 changed zones/aliases, with no added or removed zone names. Run the tool for
all changed intervals; the committed summary includes first/last per zone.

Changes affect Casablanca/El Aaiun, Edmonton/Yellowknife/Canada Mountain,
Vancouver/Canada Pacific, Tijuana-related aliases, and Chisinau/Tiraspol. These
include future rule changes and historical corrections; they must be separately
checked against upstream data and actual profile/browser behavior.

Initial validation: the existing 17 timezone/profile/date characterization cases
pass on Node 22.23.2 and 24.20.0. This does not cover all changed rules. Targeted
transition regressions, actual clipped browser data, full backend/client-core
and browser CI, and upgrade documentation remain required before merge. Alias
metadata/country mappings and package/browser-size comparison remain unverified.
The existing spring-DST schedule-selection discrepancy is not fixed by this
library-data upgrade and must not be silently treated as corrected.
