# Luxon comparison for M27

Luxon 3.7.2 was the latest npm release checked on 2026-09-06. It is installed
only in a disposable comparison directory, not Nightscout's manifest or lock.
The [Moment migration guide](https://github.com/moment/luxon/blob/master/docs/moment.md)
documents immutable objects, different format tokens and separate parsing APIs;
its [timezone guide](https://github.com/moment/luxon/blob/master/docs/zones.md)
explains reliance on native Intl timezone data. This review measures those
contracts rather than assuming source-level compatibility.

## Reproduction and scope

After installing Nightscout's locked dependencies, install `luxon@3.7.2` with
`npm install --prefix /absolute/disposable/directory --ignore-scripts --no-audit --no-fund luxon@3.7.2`.
Run `node tools/audits/luxon-contract-probe.cjs /absolute/disposable/directory/node_modules/luxon`.
The probe rejects a different Luxon version. [Results](../audits/luxon-contract-comparison.json)
include package integrity, source hash, runtime/data versions, formatting mismatch
examples, every parsing observation and all alternating benchmark rounds.

The shared server corpus contains 325 zone/instant/locale combinations. Luxon
matches 260; all 65 Arabic cases differ in numeral output. As the actual browser
bundle currently exposes only English Moment locale data, this alone does not
establish a browser regression. Locale-aware editor behavior remains separate.

## Ambiguous local times require an explicit rule

With Luxon's current-time clock set to January, parsing New York's repeated
`2024-11-03T01:30:00` selects 06:30Z; Moment selects 05:30Z. With the clock set to
July, parsing Lord Howe's repeated `2024-04-07T01:45:00` selects 15:15Z; Moment
selects 14:45Z. Both libraries agree on the tested spring gaps. The test resets
Luxon's caches for each simulated season so previous offset guesses cannot
hide the default-selection dependency.

Choosing the minimum instant from `getPossibleOffsets()` matches Moment for all
eight zone/local-time/season cases. That is a possible compatibility adapter,
not proof of equivalence for all zones, historical changes or invalid dates.
A migration must specify this choice explicitly rather than inherit a default
that depends on the current season. Existing profile mutation is another
incompatibility: Moment addition returns the same changed object, while Luxon
returns a new object. Nightscout's mutable profile/API contracts need migration
or an adapter; a require/import substitution is insufficient.

## Formatting cost and provisional decision

Median milliseconds per 5,000 date/time pairs, five alternating rounds:

| Runtime | Moment | Luxon |
| --- | ---: | ---: |
| Node 22.23.2 | 6.89 | 21.76 |
| Node 24.20.0 | 7.48 | 18.46 |

Both paths start from parsed instants, perform zone conversion and format both
editor fields. This bounded result is not a general throughput benchmark.
No production bundle, allocation, retained-heap or RSS reduction is demonstrated;
adding Luxon alongside still-required Moment would remove no dependency.

Do not replace Moment with Luxon on this evidence alone. The explicit ambiguity
adapter is promising for further characterization, but fixed-offset profiles,
API parsing/fallback, duration arithmetic, actual browser/report/therapy outputs,
locale behavior and matched package/bundle/memory measurements remain open.
M27 is not complete, and production code is unchanged.
