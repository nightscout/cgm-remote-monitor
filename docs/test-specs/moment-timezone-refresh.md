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

## Targeted upstream-rule regressions

Expected boundaries come from [IANA 2026c NEWS](https://github.com/eggert/tz/blob/2026c/NEWS),
including the 2026a/2026b/2025c sections for Moldova, British Columbia and Baja
California. The fixture groups the aliases shipped by the package; it does not
independently establish legal timezone policy for each alias region.

The shared fixture covers instants before/at transitions and subsequent dates
for every changed zone/alias. Profile conversion runs twice for both glucose-unit
settings and checks object/instant identity as well as local fields and offsets.
All 43 cases pass on Node 22 and 24. Substituting the old timezone module preserves
the original 17 passes and makes all 26 new cases fail.

Nine real-browser cases pass on Chromium/Node 22 and WebKit/Node 24 using the
actual production bundle. They check every changed in-range alias twice. The
1953 Baja California correction remains server-only because browser data begins
in 2015. Client-core also passes all 283 cases on Node 24. Full backend and
current-head hosted CI, including Firefox, remain required before merge.

## Package, bundle and metadata comparison

`node tools/audits/timezone-package-comparison.cjs /absolute/old/built/worktree`
records country/link differences and package/bundle sizes and hashes. Both
compared production builds use Node 22.23.2 and the same webpack dependencies.
The old built app is the M27 prototype baseline (`6276c6ab`); its application
inputs differ from this candidate only in the unrelated server alarm-logging
fix and the timezone dependency. [Results](../audits/timezone-package-comparison.json)
show no country-zone mapping or packed-link changes. Installed package files
shrink by 33,124 bytes; app JS grows by 182 bytes / 21 gzip bytes. The other five
JS bundles are byte-identical. No server-memory saving is claimed.

Full local Node 22/MongoDB 6.0.27 backend validation passes 1,960 cases with one
existing pending case. The full Node 24 Chromium suite passes 547 cases on the pre-refresh tree. The
branch subsequently incorporated #8689; clean installation and focused browser
validation cover that refresh, with current-head hosted CI still required.

The gzip comparison above uses Node 22 on both artifacts. An initial exploratory
compression run used the default Node 25 executable and produced a 19-byte
delta; it is superseded by the recorded Node 22 result.
The refreshed tree passes a clean Node 22 install/production build and all 25
focused timezone/DOMPurify browser cases. Only the root Moment Timezone range
and its own lock record differ from the current modernization dependency graph.
