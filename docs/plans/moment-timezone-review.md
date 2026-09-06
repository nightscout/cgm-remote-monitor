# Moment and timezone review (M27)

Status: inventory complete; replacement decision and comparison measurements open.
The baseline is integration `87340f59`. No runtime code or dependency changes are
included in this inventory. Do not mark M27 complete from source counts alone.

## Current dependency and behavior boundaries

The reproducible lexical inventory in `../audits/moment-usage.json` finds 447
matching lines in 79 tracked JavaScript files, including 53 application files.
Run `python3 tools/inventory-moment-usage.py` from any directory to regenerate it.
It includes comments and explicit Moment/defaultMoment/tz references, and does
not resolve indirect aliases or claim to enumerate every executed call.

The lockfile contains Moment 2.30.1 and moment-timezone 0.5.48. These are observed
installed versions, not a claim that they are the latest available releases.

| Boundary | Actual integration points | Required preservation |
| --- | --- | --- |
| Shared time service | `lib/server/bootevent.js`, `bundle/bundle.source.js` | The server context and browser global expose Moment to consumers. Removing direct imports alone does not remove that contract. |
| Profile and therapy schedules | `lib/profilefunctions.js`, IOB/COB plugins and client-core devicestatus modules | Profile-zone conversion, fixed-offset profiles, local schedule selection, elapsed time and mutation semantics. |
| API/storage | Entries, treatments, activity, devicestatus, query builder, `lib/api3/shared/dateTools.js` | Input parsing, epoch units, offsets, invalid inputs, array fallback and response timestamps. |
| Reports and UI | Report plugins, browser utilities, profile/settings/careportal | Calendar day boundaries, labels, locales, saved input values and both glucose units. |
| Browser timezone payload | `webpack/webpack.config.js` | Data is already limited to 2015–2035 by the timezone plugin; no zone filter is configured. Server data is not clipped by this webpack step. |

API v3 dateTools returns Moment objects, accepts arrays with first valid fallback,
tries numeric input as milliseconds then seconds against MIN_TIMESTAMP, and
tries ISO 8601 then RFC 2822 while retaining the parsed offset. A direct Date.parse
substitution is not demonstrated equivalent. Profile helpers explicitly distinguish
fixed offsets such as GMT+5:30 from IANA zones and expose mutable Moment objects.

## Concrete remaining comparison work

1. Add a shared date/time characterization corpus using the actual profile,
   API parsing and report boundaries. Run it with the full server data and the
   actual browser bundle. Record results independently of any replacement.
2. Cover spring gaps and autumn overlaps, both occurrences of a repeated local
   hour, a non-hour DST change, local midnight, profile timezone changes, fixed
   half/quarter-hour offsets, pre-2015 history and the browser data-range edges.
   Preserve existing behavior as evidence; report historical discrepancies
   explicitly rather than silently blessing them as correct.
3. Include numeric epoch units, malformed input, leap dates, offset-bearing ISO,
   RFC 2822, array fallback, negative/long durations and translated report labels.
   Exercise report/therapy outputs in mg/dL and mmol/L. Existing profile offset,
   API date and report DST cases are useful but do not alone cover this matrix.
4. Prototype one isolated formatting boundary with cached Intl formatters. Keep
   parsing, timezone-to-instant conversion and therapy arithmetic separate.
   Compare byte/gzip size, cold and repeated CPU cost, allocations and browser
   output; do not infer a whole-server memory saving from package removal.
5. Compare retain/narrow/replace and a maintained alternative against the same
   corpus, including Chromium, Firefox and WebKit. Verify available releases and
   browser/runtime support at that point. No framework or date library is selected
   by this inventory, and Node's capabilities do not establish browser support.
6. Record the final decision, measured benefit, compatibility limits and a review
   trigger in the main plan. Only then mark M27 complete. Any migration must keep
   its own regression tests and rollback instructions.

The initial evidence favors evaluating formatting separately from therapy/date
parsing, because these consume different contracts. It does not yet justify
removing Moment or changing historical timezone behavior.
